// Playwright 三重验收 Pipeline — 搜源 / 快速筛 / 完整验 / Merge / Commit
// CI 独立运行：不需要 aging-test.js，内嵌 selectAll/pickOne 简化版
//
// 三重验收标准：
//   L1 搜索：浏览器搜起点/番茄 TOP 书，至少 1 本有真实搜索结果（非表头/反爬假数据）
//   L2 目录：详情页能抓到章节列表，≥10 章
//   L3 正文：第一章正文纯文本 ≥500 字 + 不含人机验证/登录关键词
//
// 金标准书单（起点月票榜 + 番茄畅销榜 TOP 混合）：
//   斗罗大陆、凡人修仙传、诡秘之主、全职高手、遮天、仙逆、玄鉴仙族、全球高武、
//   夜无疆、斗破苍穹、星辰变、吞噬星空

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ====== 配置 ======
const GOLDEN_BOOKS = [
    '斗罗大陆', '凡人修仙传', '诡秘之主', '全职高手', '遮天', '仙逆',
    '玄鉴仙族', '全球高武', '夜无疆', '斗破苍穹', '星辰变', '吞噬星空'
];
const L1_MIN_HITS = 1;
const L2_MIN_CHAPTERS = 10;
const L3_MIN_TEXT = 500;
const L3_BLOCK = /(人机验证|滑块|captcha|Cloudflare|请登录|需要登录|访问验证|反爬虫|验证中心|秒验|安全检查|acw_sc__v2)/i;

// 上游候选源仓库（curated/filter 版，按 stars + 最近更新排）
// 全部走 GitHub raw 直链 + fallback CDN
const UPSTREAM_SOURCES = [
    // XU2 精选（12k stars，昨天更新）— 主文件 shuyuan 是 Legado JSON
    { name: 'XU2/Yuedu-shuyuan', url: 'https://raw.githubusercontent.com/XIU2/Yuedu/master/shuyuan' },
    // jiwangyihao/source-j-legado（pushed 今天）
    { name: 'jiwangyihao/source-j-legado', url: 'https://raw.githubusercontent.com/jiwangyihao/source-j-legado/main/zaimanhua.json' },
    // aoaostar 实时 CDN
    { name: 'aoaostar-CDN', url: 'https://legado.aoaostar.com/sources/71e56d4f.json' },
];

const BLOCK_TAGS = /(人机验证|搜索暂不可用|登录|需登录|验证|梯子|被封|反爬|滑块|Cloudflare)/i;

// ====== JSONPath 简化解析（$.data, $.data[*].name, $.data.books[*].url）======
function walkJson(obj, path) {
    if (!path.startsWith('$')) return null;
    const parts = path.slice(1).split(/[.\[\]]+/).filter(Boolean);
    let nodes = [obj];
    for (const p of parts) {
        if (p === '*') {
            nodes = nodes.flatMap(n => Array.isArray(n) ? n : Object.values(n || {}));
        } else if (/^\d+$/.test(p)) {
            const idx = parseInt(p);
            nodes = nodes.map(n => Array.isArray(n) ? n[idx] : undefined).filter(v => v !== undefined);
        } else {
            nodes = nodes.map(n => n?.[p]).filter(v => v !== undefined);
        }
        if (nodes.length === 0) return null;
    }
    return nodes;
}

// ====== selector 解析（Legado 完整兼容：JSONPath + class/id/tag + @提取 + ||备选 + ##净化）======
function selectAll(html, rule) {
    if (!rule || !html) return null;
    rule = String(rule).trim();
    const selPart = rule.split('##')[0].trim();
    if (!selPart) return null;
    const alts = selPart.split('||').map(x => x.trim()).filter(Boolean);

    for (const alt of alts) {
        // ---- JSONPath 分支 ----
        if (alt.startsWith('$')) {
            let json = null;
            const trimmed = html.trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                try { json = JSON.parse(trimmed); } catch { json = null; }
            } else {
                // 可能包在 <pre> 或 <script> 里
                const m = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i) || html.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
                if (m) { try { json = JSON.parse(m[1].trim()); } catch {} }
            }
            if (!json) continue;
            let items = walkJson(json, alt);
            if (items && items.length > 0) {
                // walkJson 可能返回嵌套数组（如 $.data 返回 API 的数组被包了一层）
                items = items.flatMap(n => Array.isArray(n) ? n : [n]);
                if (items.length === 0) continue;
                return { items, isText: false };
            }
            continue;
        }

        // ---- HTML selector 分支 ----
        // 解析：每个 alt 是 [选择器表达式]@[提取方式]
        // 如 "class.book-item@text" → 选择器=class.book-item, 提取方式=text
        // 如 "class.book-item" → 选择器=class.book-item, 提取方式默认=innerHtml
        const atIdx = alt.lastIndexOf('@');
        let selExpr, extract = null;
        if (atIdx > 0) { selExpr = alt.slice(0, atIdx).trim(); extract = alt.slice(atIdx + 1).trim(); }
        else selExpr = alt.trim();

        let frags = [html];
        let ok = true;

        // selExpr 可能是链式：class.a tag.b → 先找 class.a 的元素列表，再从每个元素里找 tag.b
        const steps = selExpr.split(/\s+/).filter(Boolean);
        for (const step of steps) {
            const m = /^(class|id|tag)\.([\w\u4e00-\u9fff\-$]+)(?:[.:](\d+))?$/.exec(step);
            if (!m) { ok = false; break; }
            const [, kind, name, idx] = m;

            let arr = [];
            if (kind === 'tag') {
                const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'gi');
                for (const f of frags) { let x; while ((x = re.exec(f)) !== null) arr.push(x[1]); }
            } else if (kind === 'class') {
                const re = new RegExp(`<\\w+[^>]*class=["'][^"']*\\b${name}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[\\w]+>`, 'gi');
                for (const f of frags) { let x; while ((x = re.exec(f)) !== null) arr.push(x[1]); }
            } else if (kind === 'id') {
                const re = new RegExp(`<\\w+[^>]*id=["']${name}["'][^>]*>([\\s\\S]*?)<\\/[\\w]+>`, 'i');
                for (const f of frags) { const m2 = re.exec(f); if (m2) arr.push(m2[1]); }
            }

            if (arr.length === 0) { ok = false; break; }
            frags = idx !== undefined ? [arr[parseInt(idx)]] : arr;
        }

        if (!ok || frags.length === 0) continue;

        // 最后应用 @ 提取方式
        let result = frags;
        let isText = false;
        if (extract === 'text' || extract === 'textnodes') {
            result = frags.map(f => f.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
            isText = true;
        } else if (extract === 'href' || extract === 'src' || extract === 'content' || extract === 'property' || extract === 'name') {
            // 属性提取：先找到开标签，再取属性值
            const attrMap = frags.map(f => {
                const openTag = f.match(/<(\w+)[^>]*>/);
                if (!openTag) return null;
                const attrRe = new RegExp(`\\b${extract}=["']([^"']*)["']`, 'i');
                const a = attrRe.exec(openTag[0]);
                return a ? a[1] : null;
            }).filter(Boolean);
            result = attrMap;
            isText = true;
        } else if (extract === 'html' || extract === 'all') {
            // 保持原样（默认就是 innerHTML，已经是 frags 的值）
        } else if (extract === 'text') {
            result = frags.map(f => f.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
            isText = true;
        }
        // extract 为 null（没有 @）→ 默认就是 innerHTML，保持 frags

        if (result.length > 0) return { items: result, isText };
    }
    return null;
}

function pickOne(item, rule) {
    // rule 是 JSONPath 且 item 是对象：直接在对象上 walkJson
    if (rule && typeof rule === 'string' && rule.startsWith('$')) {
        if (item && typeof item === 'object') {
            const v = walkJson(item, rule);
            if (v?.length) return String(v[0]);
        }
    }
    if (!rule || typeof rule !== 'string') {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
            return item.bookUrl || item.book_id || item.bookId || item.url || item._id || null;
        }
        return null;
    }
    const r = selectAll(typeof item === 'string' ? item : JSON.stringify(item), rule);
    if (r?.items?.length) return String(r.items[0]).trim();
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
        return item.bookUrl || item.book_id || item.bookId || item.url || item._id || null;
    }
    return null;
}

// ====== 工具 ======
async function downloadJson(url) {
    const headers = { 'Accept': 'application/json' };
    const ghToken = process.env.GITHUB_TOKEN;
    if (ghToken) headers['Authorization'] = `Bearer ${ghToken}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return JSON.parse(await resp.text());
}

async function launchBrowser() {
    try { return await chromium.launch({ headless: true }); }
    catch { try { return await chromium.launch({ headless: true, channel: 'chrome' }); }
    catch { throw new Error('Playwright Chromium + system Chrome 都不可用'); } }
}

async function fetchHotBooks(page) {
    const HOT_URLS = [
        { label: '起点畅销榜',  url: 'https://www.qidian.com/rank/hotsales/',  sels: ['h2 a', '.rank-book-name', '.bookname a', 'a[href*="/book/"]'] },
        { label: '起点阅读榜',  url: 'https://www.qidian.com/rank/readIndex/', sels: ['h2 a', '.rank-book-name', '.bookname a', 'a[href*="/book/"]'] },
        { label: '起点新书榜',  url: 'https://www.qidian.com/rank/newbook/',   sels: ['h2 a', '.rank-book-name', '.bookname a', 'a[href*="/book/"]'] },
        { label: '起点月票榜',  url: 'https://www.qidian.com/rank/tickets/',    sels: ['h2 a', '.rank-book-name', '.bookname a', 'a[href*="/book/"]'] },
        { label: '番茄男频热榜', url: 'https://fanqienovel.com/rank/hot_male', sels: ['a[href*="/page/"]', '.book-name', 'h3', 'h4'] },
    ];
    const books = new Set();

    for (const src of HOT_URLS) {
        try {
            await page.goto(src.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForTimeout(3000);

            // 先检测是否被反爬（Safety check / 验证 等）
            const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
            if (/safety|验证|人机|Cloudflare|Just a moment/i.test(bodyText)) {
                console.log(`  ${src.label}: 反爬拦截`);
                continue;
            }

            // 多 selector 遍历取并集
            const found = new Set();
            for (const sel of src.sels) {
                const names = await page.evaluate((s) => {
                    const out = [];
                    // 乱码检测：排除私人区（iconfont 替换常用）+ 控制字符 + 不可见字符
                    const isClean = (t) => {
                        if (/[\uE000-\uF8FF\uFFF0-\uFFFF]/.test(t)) return false;
                        if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(t)) return false;
                        const han = (t.match(/[\u4e00-\u9fff]/g) || []).length;
                        return han / t.length >= 0.6;
                    };
                    document.querySelectorAll(s).forEach(el => {
                        const t = (el.textContent || el.getAttribute('title') || '').trim();
                        if (t && t.length >= 2 && t.length <= 20
                            && !/^\d+$/.test(t)
                            && !/排行榜|分类|首页|书库|完本|连载/.test(t)
                            && isClean(t)) out.push(t);
                    });
                    return [...new Set(out)];
                }, sel);
                names.forEach(n => found.add(n));
            }

            let added = 0;
            found.forEach(n => { if (!books.has(n)) { books.add(n); added++; } });
            console.log(`  ${src.label}: +${added} 本`);
        } catch (e) {
            console.log(`  ${src.label}: 抓取失败 (${String(e.message || e).slice(0, 60)})`);
        }
    }

    // 确定性顺序（按抓到的先后顺序 + GOLDEN_BOOKS 固定顺序），不再 shuffle。
    // 同一输入得到相同审计顺序，便于回归验证。
    const arr = [...books];

    // 热榜 ≥ 3 本 → 直接用前 3
    if (arr.length >= 3) {
        console.log(`  📚 多源合并: ${arr.length} 本（去重后）`);
        return arr.slice(0, 3);
    }

    // Fallback: 经典完本按固定顺序补齐
    console.log(`  ⚠ 热榜只抓到 ${arr.length} 本（反爬/乱码），fallback 经典完本书`);
    return [...arr, ...GOLDEN_BOOKS.slice(0, 3 - arr.length)];
}

async function pwGet(page, url) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1200);
        return await page.content();
    } catch { return null; }
}

function buildSearchUrl(source, keyword) {
    const raw = source.searchUrl || '';
    let urlPart = raw;
    const c = raw.indexOf(',{');
    if (c >= 0) urlPart = raw.slice(0, c).trim();
    urlPart = urlPart.replace(/\{\{key\}\}/g, encodeURIComponent(keyword)).replace(/\{\{page\}\}/g, '1');
    if (!urlPart.startsWith('http')) urlPart = source.bookSourceUrl.replace(/\/+$/, '') + '/' + urlPart.replace(/^\/+/, '');
    return urlPart;
}

function absUrl(source, u) {
    if (!u || typeof u !== 'string') return null;
    return u.startsWith('http') ? u : source.bookSourceUrl.replace(/\/+$/, '') + '/' + u.replace(/^\/+/, '');
}

function isRealSearchItem(raw) {
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw || '');
    const clean = s.replace(/<[^>]+>/g, '').trim();
    return clean.length > 5 && !/文章名称|最新章节|作者|th>|<th/i.test(clean);
}

// ====== URL 模板渲染：{{$.field}} → 对象字段值 ======
function renderTemplate(obj, template) {
    if (!template || !obj || typeof obj !== 'object') return template;
    return String(template).replace(/\{\{\s*(\$\.[^}]+)\s*\}\}/g, (m, path) => {
        const v = walkJson(obj, path);
        return v?.length ? String(v[0]) : '';
    });
}

// ====== Debug 开关 ======
const DEBUG = process.env.DEBUG_PHASE === '1';

// ====== 阶段 ======
async function phaseA(page, source, tests) {
    for (const kw of tests) {
        const url = buildSearchUrl(source, kw);
        if (DEBUG) console.log(`    [debug] 搜 "${kw}" → ${url.slice(0, 100)}`);
        const html = await pwGet(page, url);
        if (!html) { if (DEBUG) console.log('    [debug] HTML 空'); continue; }
        if (DEBUG) console.log(`    [debug] HTML 长度=${html.length}, 前200字: ${html.slice(0, 200).replace(/\s+/g, ' ')}`);
        const items = selectAll(html, source.ruleSearch?.bookList)?.items;
        if (DEBUG) console.log(`    [debug] ruleSearch.bookList="${source.ruleSearch?.bookList}", items=${items?.length || 0}`);
        if (!items?.length) continue;
        if (DEBUG) console.log(`    [debug] 第一个 item: ${String(items[0]).slice(0, 150)}`);
        const realItem = items.find(isRealSearchItem);
        if (!realItem) { if (DEBUG) console.log('    [debug] 全是假数据'); continue; }

        // 构造 detailUrl：ruleSearch.bookUrl 可能是模板 "/xxx/{{$.book_id}}"
        let detailUrl;
        const bookUrlRule = source.ruleSearch?.bookUrl;
        if (bookUrlRule && typeof bookUrlRule === 'string') {
            if (bookUrlRule.includes('{{') && realItem && typeof realItem === 'object') {
                detailUrl = renderTemplate(realItem, bookUrlRule);
            } else if (bookUrlRule.startsWith('$')) {
                const v = walkJson(realItem, bookUrlRule);
                detailUrl = v?.length ? String(v[0]) : null;
            } else if (typeof realItem === 'string') {
                detailUrl = realItem;
            } else {
                detailUrl = pickOne(realItem, bookUrlRule);
            }
        } else {
            detailUrl = typeof realItem === 'string' ? realItem : (realItem?.bookUrl || realItem?.url || null);
        }
        detailUrl = absUrl(source, detailUrl);
        if (DEBUG) console.log(`    [debug] detailUrl=${detailUrl}`);
        if (detailUrl) return { pass: true, firstHit: { kw, detailUrl, searchItem: realItem } };
    }
    return { pass: false };
}

async function phaseB(page, source, firstHit) {
    // L2 目录：先确定目录 URL
    let tocUrl = firstHit.detailUrl;

    // 情况 1：ruleBookInfo.tocUrl 存在（API 源，目录从详情 JSON 拼）
    const tocRule = source.ruleBookInfo?.tocUrl;
    if (tocRule && typeof tocRule === 'string' && tocRule.includes('{{')) {
        // 先抓详情 JSON
        const detailHtml = await pwGet(page, firstHit.detailUrl);
        if (!detailHtml) return { pass: false, reason: 'L2 详情页空' };
        // parse detail JSON → 从 firstHit.searchItem + detail JSON 合并取字段
        let detailObj = firstHit.searchItem && typeof firstHit.searchItem === 'object'
            ? firstHit.searchItem
            : null;
        try { detailObj = { ...(detailObj || {}), ...JSON.parse(detailHtml) }; } catch(e) { /* not JSON */ }
        tocUrl = renderTemplate(detailObj, tocRule);
        tocUrl = absUrl(source, tocUrl);
        if (DEBUG) console.log(`    [debug] ruleBookInfo.tocUrl → ${tocUrl}`);
        if (!tocUrl) return { pass: false, reason: 'L2 目录 URL 拼不出' };
    } else if (tocRule && tocRule.startsWith('$')) {
        // ruleBookInfo.tocUrl 是 JSONPath（少见）
        const detailHtml = await pwGet(page, firstHit.detailUrl);
        let detailObj = firstHit.searchItem;
        try { detailObj = { ...(detailObj||{}), ...JSON.parse(detailHtml) }; } catch(e){}
        const v = walkJson(detailObj, tocRule);
        tocUrl = absUrl(source, v?.length ? String(v[0]) : null);
    }

    // 情况 2：ruleSearch.bookUrl 是模板但没有 ruleBookInfo.tocUrl — detailUrl 已经是目录 API

    const tocHtml = await pwGet(page, tocUrl);
    if (!tocHtml) return { pass: false, reason: 'L2 目录页空' };
    if (DEBUG) console.log(`    [debug] tocHtml 长度=${tocHtml.length}, 前200字: ${tocHtml.slice(0, 200).replace(/\s+/g, ' ')}`);

    const chapItems = selectAll(tocHtml, source.ruleToc?.chapterList)?.items;
    if (DEBUG) console.log(`    [debug] ruleToc.chapterList="${source.ruleToc?.chapterList}", chapItems=${chapItems?.length || 0}`);
    if (!chapItems?.length) return { pass: false, reason: 'L2 目录抓不到' };
    if (chapItems.length < L2_MIN_CHAPTERS) return { pass: false, reason: `L2 目录只有 ${chapItems.length} 章` };

    // 构造章节 URL：ruleToc.chapterUrl 可能是模板
    let chapUrl;
    const chapUrlRule = source.ruleToc?.chapterUrl;
    if (chapUrlRule && typeof chapUrlRule === 'string') {
        const firstChap = chapItems[0];
        if (chapUrlRule.includes('{{') && firstChap && typeof firstChap === 'object') {
            // 从目录 JSON 拼（也可能需要详情 JSON 的字段如 book_id）
            const mergedObj = { ...(firstHit.searchItem || {}), ...firstChap };
            chapUrl = renderTemplate(mergedObj, chapUrlRule);
        } else if (chapUrlRule.startsWith('$')) {
            const v = walkJson(firstChap, chapUrlRule);
            chapUrl = v?.length ? String(v[0]) : null;
        } else {
            chapUrl = pickOne(firstChap, chapUrlRule);
        }
    } else {
        chapUrl = typeof chapItems[0] === 'string' ? chapItems[0] : (chapItems[0]?.chapterUrl || chapItems[0]?.url);
    }
    chapUrl = absUrl(source, chapUrl);
    if (DEBUG) console.log(`    [debug] chapUrl=${chapUrl}`);
    if (!chapUrl) return { pass: false, reason: 'L2 章节 URL 拿不到' };

    // L3 正文
    const chapHtml = await pwGet(page, chapUrl);
    if (!chapHtml) return { pass: false, reason: 'L3 正文页空' };
    const cr = selectAll(chapHtml, source.ruleContent?.content);
    let text = cr?.isText ? (cr.items || []).join('') : (cr?.items || []).join('').replace(/<[^>]+>/g, '').trim();
    if (!text || text.length < L3_MIN_TEXT) return { pass: false, reason: `L3 正文只有 ${text?.length || 0} 字` };
    if (L3_BLOCK.test(text)) return { pass: false, reason: 'L3 命中验证关键词' };

    return { pass: true, chapters: chapItems.length, textLen: text.length };
}

// ====== 主 ======
async function main() {
    console.log('========================================');
    console.log('Playwright 三重验收 Pipeline');
    console.log('Phase A: 实时热榜抽 3 本（fallback:', GOLDEN_BOOKS.slice(0,3).join('/') + ')');
    console.log('========================================\n');

    // 1. 下载上游候选源
    console.log('[1/6] 下载上游候选源...');
    const candidates = [];
    for (const src of UPSTREAM_SOURCES) {
        try {
            const arr = await downloadJson(src.url);
            for (const s of arr) candidates.push({ ...s, _upstream: src.name });
            console.log(`  ${src.name}: +${arr.length} → 累计 ${candidates.length}`);
        } catch (e) { console.log(`  ${src.name}: 跳过 (${e.message.slice(0, 40)})`); }
    }
    console.log(`\n上游合并: ${candidates.length} 条\n`);

    // 2. 与现有 legado.json 去重
    const legado = JSON.parse(fs.readFileSync(path.join(REPO, 'legado.json'), 'utf8'));
    const existHosts = new Set(legado.map(s => { try { return new URL(s.bookSourceUrl).hostname; } catch { return s.bookSourceUrl; } }));

    const filtered = candidates.filter(s => {
        try { if (existHosts.has(new URL(s.bookSourceUrl).hostname)) return false; } catch { return false; }
        const tag = (s.bookSourceGroup || '') + ' ' + (s.bookSourceComment || '');
        if (BLOCK_TAGS.test(tag)) return false;
        if (!s.searchUrl || !s.ruleToc?.chapterList || !s.ruleContent?.content) return false;
        return true;
    });
    console.log('[2/6] 去重+预筛:', candidates.length, '→', filtered.length, '候选\n');

    // ====== 先写审计报告骨架，保证任何 exit 都有完整报告 ======
    const summary = {
        runAt: new Date().toISOString(),
        upstreamCandidates: candidates.length,
        filteredCandidates: filtered.length,
        phaseAFallback: GOLDEN_BOOKS.slice(0,3),
        phaseATests: [],
        phaseA: { candidates: filtered.length, survivors: 0 },
        phaseB: { survivors: 0, passed: 0, failed: 0 },
        passed: [],
        failed: [],
        note: ''
    };

    const writeReport = () => {
        fs.mkdirSync(path.join(REPO, 'reports'), { recursive: true });
        fs.writeFileSync(path.join(REPO, 'reports/source-audit.json'), JSON.stringify(summary, null, 2), 'utf8');
    };

    if (filtered.length === 0) {
        summary.note = '没有新候选源，已完整写报告后退出';
        writeReport();
        console.log('没有新候选，退出（已写报告）。');
        process.exit(0);
    }

    // 3. Playwright Phase A — 先抓实时热榜抽 3 本
    console.log('[3/6] Phase A: L1 快速筛（实时热榜抽 3 本）\n');
    const browser = await launchBrowser();
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    const phaseATests = await fetchHotBooks(page);
    console.log(`  📌 本轮测试热书: ${phaseATests.join(' / ')}\n`);

    const survivors = [];
    for (let i = 0; i < filtered.length; i++) {
        const src = filtered[i];
        process.stdout.write(`  A [${i + 1}/${filtered.length}] ${src.bookSourceName.padEnd(18, ' ')} `);
        const r = await phaseA(page, src, phaseATests);
        if (r.pass) { survivors.push({ source: src, firstHit: r.firstHit }); process.stdout.write(`✅ (${r.firstHit.kw})\n`); }
        else process.stdout.write('❌\n');
        await page.waitForTimeout(200);
    }
    console.log(`\nPhase A: ${survivors.length}/${filtered.length} 活\n`);

    // 4. Playwright Phase B
    console.log('[4/6] Phase B: 完整 L2 目录 + L3 正文\n');
    const PASS = [], FAIL = [];
    for (let i = 0; i < survivors.length; i++) {
        const { source: src, firstHit } = survivors[i];
        process.stdout.write(`  B [${i + 1}/${survivors.length}] ${src.bookSourceName.padEnd(18, ' ')} `);
        try {
            const r = await phaseB(page, src, firstHit);
            if (r.pass) { PASS.push({ source: src, ...r }); process.stdout.write(`✅ L2=${r.chapters} L3=${r.textLen}字 样书="${firstHit.kw}"\n`); }
            else { FAIL.push({ name: src.bookSourceName, reason: r.reason }); process.stdout.write(`❌ ${r.reason}\n`); }
        } catch (e) { FAIL.push({ name: src.bookSourceName, reason: String(e.message).slice(0, 30) }); process.stdout.write(`❌ ERR: ${String(e.message).slice(0, 30)}\n`); }
        await page.waitForTimeout(200);
    }
    await browser.close();
    console.log(`\nPhase B: ✅ ${PASS.length}/${survivors.length} 三重全过\n`);

    // 5. 纯审计收尾（D2 / Round3 补测 2026-10-20）：
    //    本脚本只写 reports/source-audit.json，不再修改 legado.json、不再跑 rank-legado.js。
    //    活源入库统一走 update.yml 的 filter 扩容闸门（探活+实测+保险丝+签名，证据同轮齐套）。
    summary.phaseATests = phaseATests;
    summary.phaseA = { candidates: filtered.length, survivors: survivors.length };
    summary.phaseB = { survivors: survivors.length, passed: PASS.length, failed: FAIL.length };
    summary.passed = PASS.map(p => ({ name: p.source.bookSourceName, url: p.source.bookSourceUrl, chapters: p.chapters, textLen: p.textLen }));
    summary.failed = FAIL;
    if (PASS.length === 0) {
        summary.note = '没有新源通过三重验收（纯审计：不修改任何成品，无成品发布动作）';
        writeReport();
        console.log('没有新源通过（纯审计，已写报告，不碰成品）。');
        process.exit(0);
    }
    console.log('\n[5/5] 汇总审计报告（纯审计，不写 legado.json）');
    summary.note = `三重验收通过 ${PASS.length} 个活源，仅记录于本报告；按单一发布入口原则不修改任何成品，入库统一走 update.yml（filter 扩容闸门→health→score→fuse→签名）。`;
    writeReport();

    // 控制台汇总（供 workflow Step 日志显示）
    const report = PASS.map((p, i) => `  ${i + 1}. ${p.source.bookSourceName} | L2=${p.chapters}章 | L3=${p.textLen}字 | ${p.source.bookSourceUrl}`).join('\n');
    console.log('\n========================================');
    console.log(`✅ 三重验收完成！${PASS.length} 个活源通过（纯审计：仅写报告，不发布任何成品；入库走 update.yml）`);
    console.log('========================================');
    console.log(report);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

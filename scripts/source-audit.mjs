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
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ====== 配置 ======
const GOLDEN_BOOKS = [
    '斗罗大陆', '凡人修仙传', '诡秘之主', '全职高手', '遮天', '仙逆',
    '玄鉴仙族', '全球高武', '夜无疆', '斗破苍穹', '星辰变', '吞噬星空'
];
const PHASE_A_TESTS = GOLDEN_BOOKS.slice(0, 3); // 快速筛用前 3 本
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

// ====== selector 解析（简化版）======
function selectAll(html, rule) {
    if (!rule || !html) return null;
    rule = String(rule).trim();
    const alts = rule.split('||').map(x => x.trim()).filter(Boolean);
    for (const alt of alts) {
        let sel = alt, clean = '';
        const ci = sel.indexOf('##');
        if (ci >= 0) { clean = sel.slice(ci + 2); sel = sel.slice(0, ci).trim(); }
        const toks = sel.split('@').flatMap(p => p.trim().split(/\s+/)).filter(Boolean);
        if (!toks.length) continue;
        let frags = [html];
        let ok = true;
        for (const tk of toks) {
            if (tk === 'html' || tk === 'all') return { items: frags, isText: true };
            if (tk === 'text' || tk === 'textnodes') {
                const items = frags.map(f => f.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
                return { items, isText: true };
            }
            const m = /^(class|id|tag)\.([\w\u4e00-\u9fff\-$]+)(?:[.:](\d+))?$/.exec(tk);
            if (!m) { ok = false; break; }
            const [, kind, name, idx] = m;
            if (kind === 'tag') {
                const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'gi');
                const arr = []; let x;
                for (const f of frags) { while ((x = re.exec(f)) !== null) arr.push(x[1]); }
                if (arr.length === 0) { ok = false; break; }
                frags = idx !== undefined ? [arr[parseInt(idx)]] : arr;
            } else if (kind === 'class') {
                const re = new RegExp(`<\\w+[^>]*class=["'][^"']*\\b${name}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[\\w]+>`, 'gi');
                const arr = []; let x;
                for (const f of frags) { while ((x = re.exec(f)) !== null) arr.push(x[1]); }
                if (arr.length === 0) { ok = false; break; }
                frags = idx !== undefined ? [arr[parseInt(idx)]] : arr;
            } else if (kind === 'id') {
                const re = new RegExp(`<\\w+[^>]*id=["']${name}["'][^>]*>([\\s\\S]*?)<\\/[\\w]+>`, 'i');
                const arr = [];
                for (const f of frags) { const m2 = re.exec(f); if (m2) arr.push(m2[1]); }
                if (arr.length === 0) { ok = false; break; }
                frags = idx !== undefined ? [arr[parseInt(idx)]] : arr;
            }
        }
        if (ok && frags.length > 0) return { items: frags, isText: false };
    }
    return null;
}

function pickOne(item, rule) {
    if (!rule || typeof rule !== 'string') return typeof item === 'string' ? item : (item?.bookUrl || item?.url || null);
    const r = selectAll(typeof item === 'string' ? item : JSON.stringify(item), rule);
    if (r?.items?.length) return String(r.items[0]).trim();
    return typeof item === 'string' ? item : (item?.bookUrl || item?.url || null);
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

// ====== 阶段 ======
async function phaseA(page, source) {
    for (const kw of PHASE_A_TESTS) {
        const html = await pwGet(page, buildSearchUrl(source, kw));
        if (!html) continue;
        const items = selectAll(html, source.ruleSearch?.bookList)?.items;
        if (!items?.length) continue;
        const realItem = items.find(isRealSearchItem);
        if (!realItem) continue;
        let detailUrl = source.ruleSearch?.bookUrl
            ? pickOne(realItem, source.ruleSearch.bookUrl)
            : (typeof realItem === 'string' ? realItem : (realItem.bookUrl || realItem.url));
        detailUrl = absUrl(source, detailUrl);
        if (detailUrl) return { pass: true, firstHit: { kw, detailUrl } };
    }
    return { pass: false };
}

async function phaseB(page, source, firstHit) {
    const tocHtml = await pwGet(page, firstHit.detailUrl);
    if (!tocHtml) return { pass: false, reason: 'L2 目录页空' };
    const chapItems = selectAll(tocHtml, source.ruleToc?.chapterList)?.items;
    if (!chapItems?.length) return { pass: false, reason: 'L2 目录抓不到' };
    if (chapItems.length < L2_MIN_CHAPTERS) return { pass: false, reason: `L2 目录只有 ${chapItems.length} 章` };
    let chapUrl = source.ruleToc?.chapterUrl
        ? pickOne(chapItems[0], source.ruleToc.chapterUrl)
        : (typeof chapItems[0] === 'string' ? chapItems[0] : (chapItems[0].chapterUrl || chapItems[0].url));
    chapUrl = absUrl(source, chapUrl);
    if (!chapUrl) return { pass: false, reason: 'L2 章节 URL 拿不到' };

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
    console.log('金标准:', GOLDEN_BOOKS.join('/'));
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

    if (filtered.length === 0) { console.log('没有新候选，退出。'); process.exit(0); }

    // 3. Playwright Phase A
    console.log('[3/6] Phase A: L1 快速筛（前 3 本）\n');
    const browser = await launchBrowser();
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    const survivors = [];
    for (let i = 0; i < filtered.length; i++) {
        const src = filtered[i];
        process.stdout.write(`  A [${i + 1}/${filtered.length}] ${src.bookSourceName.padEnd(18, ' ')} `);
        const r = await phaseA(page, src);
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

    // 5. Merge + rank-legado.js
    if (PASS.length === 0) { console.log('没有新源通过，跳过 merge。'); process.exit(0); }
    console.log('[5/6] Merge + rank-legado.js\n');
    const toAdd = PASS.map(p => {
        const s = JSON.parse(JSON.stringify(p.source));
        delete s._upstream; delete s._diagnosis;
        s.weight = 900; s.enabled = true; s.lastUpdateTime = Date.now();
        return s;
    });

    const merged = [...legado, ...toAdd];
    fs.writeFileSync(path.join(REPO, 'legado.json'), JSON.stringify(merged, null, 2), 'utf8');
    console.log(`  legado.json: ${legado.length} → ${merged.length}`);

    try {
        execSync('node rank-legado.js', { cwd: REPO, timeout: 60000, encoding: 'utf8', stdio: 'pipe' });
        const ranked = JSON.parse(fs.readFileSync(path.join(REPO, 'ranked-legado.json'), 'utf8'));
        const clean = ranked.map(s => { const c = { ...s }; delete c._diagnosis; return c; });
        fs.writeFileSync(path.join(REPO, 'legado.json'), JSON.stringify(clean, null, 2), 'utf8');
        console.log(`  rank-legado.js OK → ${clean.length} 源`);
    } catch (e) { console.error('  rank-legado.js 失败:', String(e.message || e)); process.exit(1); }

    // 6. Commit + push
    console.log('\n[6/6] Commit + push');
    const report = PASS.map((p, i) => `  ${i + 1}. ${p.source.bookSourceName} | L2=${p.chapters}章 | L3=${p.textLen}字 | ${p.source.bookSourceUrl}`).join('\n');
    const shortMsg = `feat: 三重验收引入 ${PASS.length} 个活源\n\n` +
        `Playwright 浏览器验收\n上游: tickmao/Novel + aoaostar/XIU2精品\n` +
        `Phase A ${filtered.length}→${survivors.length} | Phase B ${survivors.length}→${PASS.length}\n\n通过:\n${report}`;

    try {
        execSync('git config user.name "github-actions[bot]"', { cwd: REPO, stdio: 'pipe' });
        execSync('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"', { cwd: REPO, stdio: 'pipe' });
        execSync('git add legado.json legado.json.sig replaceRule.json replaceRule.json.sig', { cwd: REPO, stdio: 'pipe' });
        execSync('git add reports/ health/', { cwd: REPO, stdio: 'pipe' });
        execSync(`git commit -m "${shortMsg.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { cwd: REPO, stdio: 'pipe' });
        execSync('git pull --rebase origin main 2>&1 || true', { cwd: REPO, stdio: 'pipe' });
        execSync('git push origin HEAD', { cwd: REPO, stdio: 'pipe' });
        console.log('  ✅ push 成功');
    } catch (e) { console.error('  ❌ commit/push 失败:', String(e.message || e).slice(0, 120)); process.exit(1); }

    // 7. 写审计报告
    const summary = {
        runAt: new Date().toISOString(),
        goldenBooks: GOLDEN_BOOKS,
        phaseA: { candidates: filtered.length, survivors: survivors.length },
        phaseB: { survivors: survivors.length, passed: PASS.length, failed: FAIL.length },
        passed: PASS.map(p => ({ name: p.source.bookSourceName, url: p.source.bookSourceUrl, chapters: p.chapters, textLen: p.textLen })),
        failed: FAIL
    };
    fs.mkdirSync(path.join(REPO, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(REPO, 'reports/source-audit.json'), JSON.stringify(summary, null, 2), 'utf8');

    console.log('\n========================================');
    console.log(`✅ 完成！引入 ${PASS.length} 个活源`);
    console.log('========================================');
    console.log(report);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

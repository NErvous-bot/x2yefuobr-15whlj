// aging-test.js — 老化书源「先实测再删」实测模块
// 对老化名单（>365天未更新）的书源做三关真实实测：
//   ① 搜索"都市"能出书  ② 目录 ≥1 章  ③ 第一章正文 ≥200 字
// 三关全过 → usable=true（豁免保留）；任一关"确定坏" → usable=false（剔除）；
// 规则不可测（js/XPath/$./{{}}）或网络级失败 → usable='skip'（豁免不误删，探活层兜底真死源）。
// 仅支持 legado 静态选择器子集：class./id./tag./.x/#x/@text/@textNodes/@html/@href/@all、
// 数字索引(.N/:N)、||备选、##清理。GBK 请求体无法编码 → 视为不可测豁免。
// 零依赖，Node 20 直接运行
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const UAS = [
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
];
const pickUA = () => UAS[Math.floor(Math.random() * UAS.length)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 解码：GBK 头部探测（Node 20 全 ICU 支持 gbk 解码；请求侧无法编码 gbk，故 gbk 请求直接豁免）
function decode(buf) {
    const head = buf.slice(0, 2048).toString('latin1').toLowerCase();
    if (/charset=["']?(gb2312|gbk)/.test(head)) { try { return new TextDecoder('gbk').decode(buf); } catch (e) {} }
    return buf.toString('utf8');
}

// 抓取（跟随重定向、gzip 自动解压、带 1 次网络级重试）；网络失败返回 null
async function fetchPage(url, opt) {
    opt = opt || {};
    for (let i = 0; i < 2; i++) {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), opt.ms || 15000);
        try {
            const h = { 'User-Agent': pickUA(), 'Accept': 'text/html,*/*' };
            if (opt.ref) h['Referer'] = opt.ref;
            const r = await fetch(url, {
                method: opt.method || 'GET', headers: h,
                body: opt.method === 'POST' ? (opt.body || '') : undefined,
                signal: c.signal, redirect: 'follow'
            });
            clearTimeout(t);
            return { status: r.status, text: decode(Buffer.from(await r.arrayBuffer())) };
        } catch (e) { clearTimeout(t); if (i === 0) await sleep(2000); }
    }
    return null;
}

function originOf(u) { try { return new URL(String(u).split('#')[0]).origin; } catch (e) { return null; } }
function norm(u) {
    try { const x = new URL(String(u).split('#')[0]); return x.origin + x.pathname.replace(/\/$/, ''); }
    catch (e) { return null; }
}
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 反爬验证页识别（百度安全验证/Cloudflare/通用验证码）：CI 环境 IP 触发 ≠ 源坏了 → 不可测豁免
// 仅在"本该判死"时兜底检查，避免误伤正常页
function isChallenge(t) {
    const head = String(t).slice(0, 3000);
    return /百度安全验证|安全验证|人机验证|滑动验证|完成验证|<title>[^<]*(验证|安全防护)[^<]*<\/title>|just a moment|cf-browser-verification|challenge-platform|checking your browser|captcha/i.test(head);
}

/* ---------- mini 静态选择器解析子集 ---------- */
const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'area', 'source']);

// 按 class/id/tag 名提取完整元素（含开标签，便于取自身 <a href>），标签平衡
function innerAll(html, type, name) {
    const hits = [];
    if (type === 'tag') {
        const re = new RegExp('<' + name + '\\b[^>]*>', 'gi');
        let m; while ((m = re.exec(html))) hits.push([m.index, m[0]]);
    } else {
        const nameRe = new RegExp('(?<![\\w-])' + esc(name) + '(?![\\w-])');
        const attrRe = new RegExp('(?<![-\\w])' + (type === 'class' ? 'class' : 'id') + '\\s*=\\s*(["\'])([^"\']*)\\1', 'i');
        const re = /<(\w+)([^>]*)>/g;
        let m;
        while ((m = re.exec(html))) {
            if (VOID.has(m[1].toLowerCase())) continue;
            const am = attrRe.exec(m[2]);
            if (am && nameRe.test(am[2])) hits.push([m.index, m[0]]);
        }
    }
    const els = [];
    for (const [idx, open] of hits) {
        const tag = /^<(\w+)/.exec(open)[1].toLowerCase();
        let j = idx + open.length, inner;
        const re2 = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
        re2.lastIndex = j; let depth = 1, m2;
        while ((m2 = re2.exec(html))) {
            depth += m2[1] === '/' ? -1 : 1;
            if (depth === 0) { inner = html.slice(j, m2.index); break; }
        }
        if (inner === undefined) inner = html.slice(j, j + 80000);
        els.push(open + inner);
    }
    return els;
}

function toText(t) {
    t = String(t).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
    t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|section|li|tr)>/gi, '\n').replace(/<[^>]+>/g, '');
    return t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#\d+;/g, '').replace(/&amp;/g, '&');
}

function firstHref(frag) {
    const m = /<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/i.exec(frag);
    return m ? m[1].trim() : '';
}

function applyClean(items, clean) {
    if (!clean) return items;
    return items.map(t => {
        let s = String(t);
        for (const p of clean.split('&&')) {
            if (!p) continue;
            const sep = p.indexOf('##');
            try {
                s = sep >= 0 ? s.replace(new RegExp(p.slice(0, sep), 'g'), p.slice(sep + 2))
                             : s.replace(new RegExp(p, 'g'), '');
            } catch (e) {}
        }
        return s;
    });
}

const DYN = /<js>|@js:|\$\./i; // 动态规则（js/JSONPath）不可测
// 常见 HTML 标签白名单：裸标签 token（如 h4@a@href 里的 h4/a）必须命中，否则整条规则视为不可测
const TAGS = new Set(('a abbr article aside b bdi blockquote body br button caption center cite code col dd del details dfn div dl dt em fieldset figcaption figure font footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input ins kbd label legend li main mark nav ol optgroup option p pre q rt ruby s section select small source span strong style sub summary sup table tbody td textarea tfoot th thead time tr track tt u ul video wbr').split(' '));

// 解析选择器，返回 {items, isText}；不可测返回 null
// 支持：class./id./tag./裸标签/.x/#x、@链、空格后代链、数字索引(.N/:N)、||备选、##清理
function selectAll(html, rule) {
    rule = String(rule || '').trim();
    if (!rule) return null;
    for (const alt of rule.split('||')) {
        let sel = alt.trim();
        if (!sel || DYN.test(sel)) continue;
        let clean = '';
        const ci = sel.indexOf('##');
        if (ci >= 0) { clean = sel.slice(ci + 2); sel = sel.slice(0, ci); }
        // token 序列：@ 分段，段内再按空格拆后代链
        const toks = sel.split('@').flatMap(p => p.trim().split(/\s+/)).filter(Boolean);
        if (!toks.length) continue;
        let frags = [html], ok = true;
        for (const tk of toks) {
            if (/^(text|textnodes|html|href|all)$/i.test(tk)) {
                const kind = tk.toLowerCase();
                const items = applyClean(frags.map(f => kind === 'href' ? firstHref(f) : (kind === 'html' || kind === 'all') ? f : toText(f)), clean);
                return { items, isText: true };
            }
            let type, name, idx = null, m;
            if ((m = /^(class|id|tag)\.([\w\u4e00-\u9fff\-$]+)(?:[.:](\d+))?$/.exec(tk))) {
                type = m[1]; name = m[2]; if (m[3]) idx = parseInt(m[3], 10);
            } else if ((m = /^\.([\w\u4e00-\u9fff\-$]+)(?::(\d+))?$/.exec(tk))) {
                type = 'class'; name = m[1]; if (m[2]) idx = parseInt(m[2], 10);
            } else if ((m = /^#([\w\u4e00-\u9fff\-$]+)(?::(\d+))?$/.exec(tk))) {
                type = 'id'; name = m[1]; if (m[2]) idx = parseInt(m[2], 10);
            } else if ((m = /^tag\.([\w\u4e00-\u9fff\-$]+)(?::(\d+))?$/.exec(tk))) {
                type = 'tag'; name = m[1]; if (m[2]) idx = parseInt(m[2], 10);
            } else if ((m = /^([a-z][a-z0-9]*)(?:[.:](\d+))?$/i.exec(tk)) && TAGS.has(m[1].toLowerCase())) {
                type = 'tag'; name = m[1].toLowerCase(); if (m[2]) idx = parseInt(m[2], 10);
            } else { ok = false; break; }
            let next = [];
            for (const f of frags) next = next.concat(innerAll(f, type, type === 'tag' ? name.toLowerCase() : name));
            if (idx != null) next = next[idx] ? [next[idx]] : [];
            frags = next;
            if (!frags.length) break;
        }
        if (ok) return { items: frags, isText: false };
    }
    return null;
}

// 解析 searchUrl：支持 "path" / "path,{json选项}" / "path,charset=gbk"
// 返回 {opt} 或 {skip:原因}
function parseSearch(su, base) {
    su = String(su || '').trim();
    if (!su || DYN.test(su)) return { skip: '无搜索URL或含js' };
    const cut = su.indexOf(',');
    let path = (cut === -1 ? su : su.slice(0, cut)).trim();
    const tail = cut === -1 ? '' : su.slice(cut + 1).trim();
    let method = 'GET', body = null, charset = '';
    if (tail.startsWith('{')) {
        let o;
        try { o = JSON.parse(tail); } catch (e) { return { skip: 'searchUrl选项无法解析' }; }
        method = String(o.method || 'GET').toUpperCase();
        body = o.body != null ? String(o.body) : null;
        charset = String(o.charset || '');
    } else {
        const cm = /charset=([\w-]+)/i.exec(tail);
        if (cm) charset = cm[1];
    }
    if (/gb2312|gbk/i.test(charset)) return { skip: 'GBK请求无法编码' }; // Node 无 gbk 编码器
    const hasKey = u => /\{\{key\}\}|\{key\}/.test(u);
    if (!hasKey(path) && !(body && hasKey(body))) return { skip: '搜索无{{key}}槽位' };
    const K = encodeURIComponent('都市');
    path = path.replace(/\{\{page\}\}|\{page\}/g, '1');
    if (body != null) body = body.replace(/\{\{page\}\}|\{page\}/g, '1');
    if (DYN.test(path.replace(/K|都市/g, '')) || (body && DYN.test(body.replace(/\{\{key\}\}|\{key\}/g, 'K')))) return { skip: '搜索URL/body含动态语法' };
    let url;
    try { url = new URL(hasKey(path) ? path.replace(/\{\{key\}\}|\{key\}/g, K) : path, base).href; }
    catch (e) { return { skip: '搜索URL无效' }; }
    if (method === 'POST' && body != null) body = body.replace(/\{\{key\}\}|\{key\}/g, K);
    return { opt: { url, method, body: method === 'POST' ? body : undefined } };
}

// 活性参考（仅日志，不影响去留）：书页+目录页最新日期 ≤45天 = 活跃
function activityOf(hay) {
    let newest = 0, m;
    const dm = /20\d{2}[-/.年]\s*\d{1,2}[-/.月]\s*\d{1,2}/g;
    while ((m = dm.exec(hay))) {
        const p = m[0].split(/[-/.年月]+/).map(x => parseInt(x, 10));
        if (p.length >= 3 && p[0] > 2000) {
            const t = new Date(p[0], p[1] - 1, p[2]).getTime();
            if (t > newest && t < Date.now() + 864e5) newest = t;
        }
    }
    if (/今天|刚刚|昨天|\d+\s*(?:分钟|小时)前/.test(hay)) newest = Math.max(newest, Date.now());
    const dq = /(\d+)\s*天前/.exec(hay);
    if (dq) newest = Math.max(newest, Date.now() - parseInt(dq[1], 10) * 864e5);
    return newest ? (Date.now() - newest <= 45 * 864e5 ? '活跃' : '停滞') : '未知';
}

/* ---------- 三关实测主流程 ---------- */
async function checkSource(s) {
    const res = { usable: false, reason: '', chapters: 0, contentLen: 0, activity: '未知' };
    try {
        const base = originOf(s.bookSourceUrl);
        if (!base) { res.usable = 'skip'; res.reason = '无效URL'; return res; }
        const rs = s.ruleSearch || {}, rb = s.ruleBookInfo || {}, rt = s.ruleToc || {}, rc = s.ruleContent || {};

        // 第①关：搜索"都市"出书
        const ps = parseSearch(s.searchUrl, base);
        if (ps.skip) { res.usable = 'skip'; res.reason = ps.skip; return res; }
        const sp = await fetchPage(ps.opt.url, { method: ps.opt.method, body: ps.opt.body, ref: base });
        if (!sp) { res.usable = 'skip'; res.reason = '搜索请求失败'; return res; }
        if (sp.status === 404 || sp.status === 410) { res.reason = '搜索接口' + sp.status; return res; }
        if (sp.status >= 400) { res.usable = 'skip'; res.reason = '搜索HTTP ' + sp.status; return res; }
        const bl = selectAll(sp.text, rs.bookList);
        if (!bl) { res.usable = 'skip'; res.reason = 'bookList规则不可测'; return res; }
        if (!bl.items.length) {
            if (isChallenge(sp.text)) { res.usable = 'skip'; res.reason = '搜索触发反爬验证'; }
            else res.reason = '搜索无结果';
            return res;
        }
        let bookUrl = '';
        const buRule = String(rs.bookUrl || '');
        for (const f of bl.items) {
            let u = '';
            if (buRule && !DYN.test(buRule)) {
                const r = selectAll(f, buRule);
                if (r && r.items.length) u = String(r.items[0]).trim();
            }
            if (!u) u = firstHref(f);
            if (u) { try { bookUrl = new URL(u, base).href; break; } catch (e) {} }
        }
        if (!bookUrl) { res.reason = '搜索结果无书籍链接'; return res; }

        // 第②关：目录 ≥1 章
        const bp = await fetchPage(bookUrl, { ref: base });
        if (!bp) { res.usable = 'skip'; res.reason = '书籍页请求失败'; return res; }
        if (bp.status === 404 || bp.status === 410) { res.reason = '书籍页' + bp.status; return res; }
        if (bp.status >= 400) { res.usable = 'skip'; res.reason = '书籍页HTTP ' + bp.status; return res; }
        let tocUrl = bookUrl;
        const tuRule = String(rb.tocUrl || '').trim();
        if (tuRule && !DYN.test(tuRule)) {
            const tu = selectAll(bp.text, tuRule);
            if (tu && tu.items.length && String(tu.items[0]).trim()) {
                try { tocUrl = new URL(String(tu.items[0]).trim(), bookUrl).href; } catch (e) {}
            }
        }
        const tp = tocUrl === bookUrl ? bp : await fetchPage(tocUrl, { ref: bookUrl });
        if (!tp) { res.usable = 'skip'; res.reason = '目录页请求失败'; return res; }
        if (tp.status === 404 || tp.status === 410) { res.reason = '目录页' + tp.status; return res; }
        if (tp.status >= 400) { res.usable = 'skip'; res.reason = '目录页HTTP ' + tp.status; return res; }
        const cl = selectAll(tp.text, rt.chapterList || '');
        if (!cl) { res.usable = 'skip'; res.reason = 'chapterList规则不可测'; return res; }
        if (!cl.items.length) {
            if (isChallenge(tp.text)) { res.usable = 'skip'; res.reason = '目录触发反爬验证'; }
            else res.reason = '目录为空';
            return res;
        }
        res.chapters = cl.items.length;
        let chUrl = '';
        for (const f of cl.items) {
            const u = firstHref(f);
            if (u) { try { chUrl = new URL(u, tocUrl).href; break; } catch (e) {} }
        }
        if (!chUrl) { res.reason = '目录无章节链接'; return res; }

        // 第③关：第一章正文 ≥200 字
        const cp = await fetchPage(chUrl, { ref: tocUrl });
        if (!cp) { res.usable = 'skip'; res.reason = '正文页请求失败'; return res; }
        if (cp.status === 404 || cp.status === 410) { res.reason = '正文页' + cp.status; return res; }
        if (cp.status >= 400) { res.usable = 'skip'; res.reason = '正文页HTTP ' + cp.status; return res; }
        const con = selectAll(cp.text, rc.content || '');
        if (!con) { res.usable = 'skip'; res.reason = 'content规则不可测'; return res; }
        const txt = con.items.join('\n').trim();
        if (txt.length < 200) {
            if (isChallenge(cp.text)) { res.usable = 'skip'; res.reason = '正文触发反爬验证'; }
            else res.reason = '正文不足200字（实得' + txt.length + '）';
            return res;
        }
        res.contentLen = txt.length;
        res.usable = true;
        res.reason = '三关全过';
        res.activity = activityOf(toText(bp.text) + '\n' + toText(tp.text));
        return res;
    } catch (e) {
        res.usable = 'skip';
        res.reason = '实测异常:' + String(e.message || e).slice(0, 40);
        return res;
    }
}

module.exports = { checkSource };

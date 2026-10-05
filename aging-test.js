// aging-test.js — 老化书源「先实测再删」实测模块
// 对老化名单（>365天未更新）的书源做三关真实实测：
//   ① 搜索"都市"能出书  ② 目录 ≥1 章  ③ 第一章正文 ≥200 字
// 三关全过 → usable=true（豁免保留）；任一关"确定坏" → usable=false（剔除）；
// 规则不可测或网络级失败 → usable='skip'（豁免不误删，探活层兜底真死源）。
// 支持的规则类型（P0 扩展后）：
//   - GET/POST 搜索（含 {"method/body/headers/charset"} 选项，含单引号伪 JSON 宽松解析）
//   - GBK/GB2312 请求编码（TextDecoder 反向编码表）与响应解码
//   - HTML 静态选择器子集：class./id./tag./.x/#x/@text/@textNodes/@html/@href/@all、
//     数字索引(.N/:N)、||备选、##清理
//   - JSON 响应 + JSONPath 常用子集：$.a.b、$.a[0]、$.a[*]、$[*]、$.a['b']、$.*
// 不支持（→不可测豁免，绝不判死）：<js>/@js: 动态规则、JSONPath 高级语法（$../?()过滤）等
// 零依赖，Node 20 直接运行
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const UAS = [
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
];
const pickUA = () => UAS[Math.floor(Math.random() * UAS.length)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- GBK 编码表：Node 只有 gbk 解码器没有编码器，用解码器反向建表 ---------- */
// 启动时枚举全部 GBK 双字节组合（首字节 0x81-0xFE × 次字节 0x40-0xFE 去 0x7F），
// 解码得 char→bytes 映射；表外字符（生僻字）→ 编码失败 → 该源视为不可测豁免
const GBK = (() => {
    const fail = { has: false, encode: () => null, pct: () => null };
    try {
        const dec = new TextDecoder('gbk');
        const map = new Map();
        const b2 = Buffer.alloc(2);
        for (let hi = 0x81; hi <= 0xFE; hi++) {
            for (let lo = 0x40; lo <= 0xFE; lo++) {
                if (lo === 0x7F) continue;
                b2[0] = hi; b2[1] = lo;
                const s = dec.decode(b2);
                if (s.length === 1 && s !== '\uFFFD' && !map.has(s)) map.set(s, (hi << 8) | lo);
            }
        }
        if (map.size < 10000) return fail;
        return {
            has: true,
            encode(str) {
                const out = [];
                for (const ch of String(str)) {
                    const c = ch.codePointAt(0);
                    if (c < 0x80) { out.push(c); continue; }
                    const v = map.get(ch);
                    if (v === undefined) return null;
                    out.push(v >> 8, v & 0xFF);
                }
                return Buffer.from(out);
            },
            pct(str) {
                const b = this.encode(str);
                return b ? Array.from(b).map(x => '%' + x.toString(16).padStart(2, '0').toUpperCase()).join('') : null;
            }
        };
    } catch (e) { return fail; }
})();

// 解码：优先显式声明的 GBK → 响应头 Content-Type 的 GBK → 页面头部 meta 探测 → 默认 UTF-8
function decode(buf, forceGbk) {
    if (forceGbk) { try { return new TextDecoder('gbk').decode(buf); } catch (e) {} }
    const head = buf.slice(0, 2048).toString('latin1').toLowerCase();
    if (/charset=["']?(gb2312|gbk)/.test(head)) { try { return new TextDecoder('gbk').decode(buf); } catch (e) {} }
    return buf.toString('utf8');
}

// 抓取（跟随重定向、gzip 自动解压、带 1 次网络级重试）；网络失败返回 null
// opt: {method, body(Buffer|string), headers(对象), charset('gbk'), ref, ms}
async function fetchPage(url, opt) {
    opt = opt || {};
    for (let i = 0; i < 2; i++) {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), opt.ms || 15000);
        try {
            const h = { 'User-Agent': pickUA(), 'Accept': 'text/html,application/json,*/*' };
            if (opt.ref) h['Referer'] = opt.ref;
            if (opt.headers) for (const [k, v] of Object.entries(opt.headers)) {
                if (k && v != null && String(v).trim() && !/^content-length$/i.test(k)) h[k] = String(v);
            }
            const r = await fetch(url, {
                method: opt.method || 'GET',
                headers: h,
                body: opt.method === 'POST' ? (opt.body != null ? opt.body : '') : undefined,
                signal: c.signal, redirect: 'follow'
            });
            clearTimeout(t);
            const buf = Buffer.from(await r.arrayBuffer());
            const ct = (r.headers.get('content-type') || '').toLowerCase();
            const text = (opt.charset && /gb/i.test(opt.charset)) || /charset=gb/i.test(ct)
                ? decode(buf, true) : decode(buf, false);
            return { status: r.status, text };
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

/* ---------- JSON 解析与 JSONPath 常用子集 ---------- */
// 宽松 JSON 解析：直接 parse → 失败则剥离 JSONP 包头/前缀垃圾再试；返回 undefined = 不是 JSON
function parseJson(t) {
    if (t == null) return undefined;
    const s = String(t).trim();
    if (!s) return undefined;
    try { return JSON.parse(s); } catch (e) {}
    const i = s.search(/[{[]/);
    if (i > 0) { try { return JSON.parse(s.slice(i)); } catch (e) {} }
    return undefined;
}

// JSONPath 常用子集求值：$.a.b / $.a[0] / $.a[*] / $[*] / $.a['b'] / $.*
// 返回匹配值数组；路径含不支持语法（$..递归、?()过滤、脚本断言）返回 null → 不可测
function jpQuery(root, path) {
    let s = String(path).trim();
    if (s !== '$' && !s.startsWith('$.')) return null;
    s = s.slice(1);
    const re = /\.(\*|[\w\u4e00-\u9fff\-]+)|\[\s*(\*|\d+)\s*\]|\[\s*'([^']*)'\s*\]/g;
    // 语法预检在前：整条路径必须被支持语法完全覆盖，否则一律不可测。
    // （若先遍历，首段查空会提前 return [] 绕过末尾校验，把"规则超纲"误判成"搜索无结果"）
    const toks = [];
    let m;
    while ((m = re.exec(s))) toks.push(m);
    if (toks.reduce((a, t) => a + t[0].length, 0) !== s.length) return null;
    let cur = [root];
    for (const mm of toks) {
        const key = mm[1] !== undefined ? mm[1] : mm[3];
        const idx = mm[2];
        const next = [];
        for (const o of cur) {
            if (o == null || typeof o !== 'object') continue;
            if (idx !== undefined) {
                if (!Array.isArray(o)) continue;
                if (idx === '*') next.push(...o);
                else if (o[+idx] !== undefined) next.push(o[+idx]);
            } else if (Array.isArray(o)) {
                if (key === '*') next.push(...o);
                else for (const e of o) { if (e != null && typeof e === 'object' && e[key] !== undefined) next.push(e[key]); }
            } else if (key === '*') next.push(...Object.values(o));
            else if (o[key] !== undefined) next.push(o[key]);
        }
        cur = next;
        if (!cur.length) return [];
    }
    const out = cur.slice();
    // legado 语义：列表规则最后落在单数组上时展开为元素列表
    if (out.length === 1 && Array.isArray(out[0])) return out[0].slice();
    return out;
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

const DYN = /<js>|@js:|\$\./i; // 动态规则（js/JSONPath）不进 HTML 选择器分支
// 常见 HTML 标签白名单：裸标签 token（如 h4@a@href 里的 h4/a）必须命中，否则整条规则视为不可测
const TAGS = new Set(('a abbr article aside b bdi blockquote body br button caption center cite code col dd del details dfn div dl dt em fieldset figcaption figure font footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input ins kbd label legend li main mark nav ol optgroup option p pre q rt ruby s section select small source span strong style sub summary sup table tbody td textarea tfoot th thead time tr track tt u ul video wbr').split(' '));

// 解析选择器，返回 {items, isText}；不可测返回 null
// items 元素可为字符串（HTML片段/提取值）或对象（JSONPath 结果）
function selectAll(html, rule) {
    rule = String(rule || '').trim();
    if (!rule) return null;
    const alts = rule.split('||').map(x => x.trim()).filter(Boolean);
    if (!alts.length) return null;
    // JSONPath 分支：任一备选以 $ 开头即走 JSON 通道（响应需可解析为 JSON）
    if (alts.some(a => a === '$' || a.startsWith('$.'))) {
        const j = (html != null && typeof html === 'object') ? html : parseJson(html);
        if (j === undefined) return null; // 规则要 JSON 但响应不是 → 不可测
        for (const alt of alts) {
            let r = alt, clean = '';
            const ci = r.indexOf('##');
            if (ci >= 0) { clean = r.slice(ci + 2); r = r.slice(0, ci).trim(); }
            if (!(r === '$' || r.startsWith('$.'))) continue;
            const v = jpQuery(j, r);
            if (v === null) continue; // 高级语法 → 试下一备选
            const items = v.map(x => (x != null && typeof x === 'object') ? x : applyClean([String(x)], clean)[0]);
            return { items, isText: true };
        }
        return null; // 所有备选都是不支持的高级语法 → 不可测
    }
    // HTML 静态选择器分支
    for (const alt of alts) {
        let sel = alt;
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

// 从单条结果取值：对象（JSON item）走 JSONPath + 常见字段兜底；字符串（HTML片段）走选择器
function pickOne(item, rule) {
    rule = String(rule || '').trim();
    if (!rule || /<js>|@js:/i.test(rule)) {
        rule = ''; // 动态规则不解析，直接走兜底
    }
    if (rule) {
        const r = selectAll(item, rule);
        if (r && r.items.length && r.items[0] != null) {
            const v = r.items[0];
            if (typeof v !== 'object') { const t = String(v).trim(); if (t) return t; }
        }
    }
    if (item != null && typeof item === 'object') {
        for (const k of ['url', 'book_url', 'bookUrl', 'chapter_url', 'chapterUrl', 'href', 'link']) {
            if (item[k] != null && String(item[k]).trim()) return String(item[k]).trim();
        }
    }
    return '';
}

// 伪 JSON 宽松解析：legado 允许 {'k':'v'} / {k:"v"} 这类非严格 JSON 选项
function lenientJson(t) {
    try { return JSON.parse(t); } catch (e) {}
    const s = String(t).trim();
    if (/^\{[\s\S]*\}$/.test(s)) {
        try { const o = new Function('return (' + s + ')')(); if (o && typeof o === 'object') return o; } catch (e) {}
    }
    return null;
}

// searchUrl 选项里的 headers：对象 {"K":"V"} 或字符串 "K: V\nK2: V2" 都支持
function normHeaders(h) {
    const out = {};
    if (!h) return out;
    if (typeof h === 'string') {
        for (const line of h.split(/\n+/)) {
            const i = line.indexOf(':');
            if (i > 0) { const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim(); if (k) out[k] = v; }
        }
    } else if (typeof h === 'object') {
        for (const [k, v] of Object.entries(h)) if (k) out[k] = String(v);
    }
    return out;
}
const hasCT = h => Object.keys(h).some(k => /^content-type$/i.test(k));

// 解析 searchUrl：支持 "path" / "path,{json选项}" / "path,charset=gbk"
// 选项支持 method/body/headers/charset（含伪 JSON）；POST/GBK 均可实测
// kw：测试用搜索关键词（双关键词防误判需要参数化）
// 返回 {opt} 或 {skip:原因}；POST 表单额外带 altBody（关键词原文备胎，防转义误杀）
function parseSearch(su, base, kw) {
    kw = kw || '都市';
    su = String(su || '').trim();
    if (!su || /<js>|@js:/i.test(su)) return { skip: '无搜索URL或含js' };
    const cut = su.indexOf(',');
    let path = (cut === -1 ? su : su.slice(0, cut)).trim();
    const tail = cut === -1 ? '' : su.slice(cut + 1).trim();
    let method = 'GET', body = null, charset = '', headers = {};
    if (tail.startsWith('{')) {
        const o = lenientJson(tail);
        if (!o || typeof o !== 'object') return { skip: 'searchUrl选项无法解析' };
        method = String(o.method || 'GET').toUpperCase();
        body = o.body == null ? null : (typeof o.body === 'object' ? JSON.stringify(o.body) : String(o.body));
        charset = String(o.charset || '');
        headers = normHeaders(o.headers);
    } else {
        const cm = /charset=([\w-]+)/i.exec(tail);
        if (cm) charset = cm[1];
    }
    const isGbk = /gb2312|gbk/i.test(charset);
    if (isGbk && !GBK.has) return { skip: 'GBK编码表初始化失败' };
    const hasKey = u => /\{\{key\}\}|\{key\}/.test(u);
    if (!hasKey(path) && !(body && hasKey(body))) return { skip: '搜索无{{key}}槽位' };
    // 关键词编码：GBK 站按站点编码做百分号转义，UTF-8 站用标准 encodeURIComponent
    const K = isGbk ? GBK.pct(kw) : encodeURIComponent(kw);
    if (!K) return { skip: 'GBK表缺字' };
    path = path.replace(/\{\{page\}\}|\{page\}/g, '1');
    if (body != null) body = body.replace(/\{\{page\}\}|\{page\}/g, '1');
    const dynFree = x => !/<js>|@js:|\$\./i.test(String(x).replace(/\{\{[^}]*\}\}|\{[^}]*\}/g, ''));
    if (!dynFree(path) || (body != null && !dynFree(body))) return { skip: '搜索URL/body含动态语法' };
    let url;
    try { url = new URL(hasKey(path) ? path.replace(/\{\{key\}\}|\{key\}/g, K) : path, base).href; }
    catch (e) { return { skip: '搜索URL无效' }; }
    const opt = { url, method, headers, charset: isGbk ? 'gbk' : '' };
    if (method === 'POST' && body != null) {
        if (/^\s*\{/.test(body)) {
            // JSON body：{{key}} 填原文（JSON 里不做表单转义）
            if (!hasCT(headers)) headers['Content-Type'] = 'application/json';
            const b = body.replace(/\{\{key\}\}|\{key\}/g, kw);
            opt.body = isGbk ? GBK.encode(b) : Buffer.from(b, 'utf8');
        } else {
            if (!hasCT(headers)) headers['Content-Type'] = 'application/x-www-form-urlencoded';
            const enc = body.replace(/\{\{key\}\}|\{key\}/g, K);
            opt.body = isGbk ? GBK.encode(enc) : Buffer.from(enc, 'utf8');
            const raw = body.replace(/\{\{key\}\}|\{key\}/g, kw);
            const rb = isGbk ? GBK.encode(raw) : Buffer.from(raw, 'utf8');
            if (rb && Buffer.compare(rb, opt.body) !== 0) opt.altBody = rb;
        }
        if (!opt.body) return { skip: 'GBK表缺字(body)' };
    }
    return { opt };
}

// 单次搜索（含 POST 备胎编码重试）：返回 {sp, bl} / {skip} / {dead}
async function doSearch(s, base, rs, kw) {
    const ps = parseSearch(s.searchUrl, base, kw);
    if (ps.skip) return { skip: ps.skip };
    const sopt = { method: ps.opt.method, body: ps.opt.body, headers: ps.opt.headers, charset: ps.opt.charset, ref: base };
    let sp = await fetchPage(ps.opt.url, sopt);
    if (!sp) return { skip: '搜索请求失败' };
    if (sp.status === 404 || sp.status === 410) return { dead: '搜索接口' + sp.status };
    if (sp.status >= 400) return { skip: '搜索HTTP ' + sp.status };
    let bl = selectAll(sp.text, rs.bookList);
    if (!bl) return { skip: 'bookList规则不可测' };
    if (!bl.items.length && ps.opt.altBody) {
        // POST 表单双编码兜底：转义关键词无结果时，用原文关键词重试一次（部分站点不认 %XX）
        const sp2 = await fetchPage(ps.opt.url, Object.assign({}, sopt, { body: ps.opt.altBody }));
        if (sp2 && sp2.status < 400) {
            const bl2 = selectAll(sp2.text, rs.bookList);
            if (bl2 && bl2.items.length) { bl = bl2; sp = sp2; }
        }
    }
    return { sp, bl };
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

        // 第①关：搜索出书（双关键词 + 隔1.5s二次复核，防"站点无此关键词"和瞬时抖动误判死）
        let r1 = await doSearch(s, base, rs, '都市');
        if (r1.skip) { res.usable = 'skip'; res.reason = r1.skip; return res; }
        if (r1.dead) { res.reason = r1.dead; return res; }
        if (!r1.bl.items.length) {
            r1 = await doSearch(s, base, rs, '重生');
            if (r1.skip) { res.usable = 'skip'; res.reason = r1.skip; return res; }
            if (r1.dead) { res.reason = r1.dead; return res; }
            if (!r1.bl.items.length) {
                await sleep(1500);
                r1 = await doSearch(s, base, rs, '都市');
                if (r1.skip) { res.usable = 'skip'; res.reason = r1.skip; return res; }
                if (r1.dead) { res.reason = r1.dead; return res; }
                if (!r1.bl.items.length) {
                    if (isChallenge(r1.sp.text)) { res.usable = 'skip'; res.reason = '搜索触发反爬验证'; }
                    else res.reason = '搜索无结果';
                    return res;
                }
            }
        }
        let bookUrl = '';
        const buRule = String(rs.bookUrl || '');
        const pat = String(s.bookUrlPattern || '').trim();
        for (const f of r1.bl.items) {
            let u = pickOne(f, buRule);
            if (!u && typeof f !== 'object') u = firstHref(f);
            if (!u) continue;
            // 纯短 ID（无 / 和 .）且源声明了 bookUrlPattern 模板拼接 → 测试器无法构造真实 URL → 豁免
            if (pat && !/^https?:\/\//i.test(u) && !/[./]/.test(u)) {
                res.usable = 'skip'; res.reason = 'bookUrl需模板拼接'; return res;
            }
            try { bookUrl = new URL(u, base).href; break; } catch (e) {}
        }
        if (!bookUrl) {
            // bookList 有结果但提取不出书籍链接：可能是 bookUrl 规则动态/字段超纲（测试器不会提取 ≠ 源坏）→ 豁免
            res.usable = 'skip'; res.reason = 'bookUrl无法提取'; return res;
        }

        // 第②关：目录 ≥1 章
        const bp = await fetchPage(bookUrl, { ref: base });
        if (!bp) { res.usable = 'skip'; res.reason = '书籍页请求失败'; return res; }
        if (bp.status === 404 || bp.status === 410) { res.reason = '书籍页' + bp.status; return res; }
        if (bp.status >= 400) { res.usable = 'skip'; res.reason = '书籍页HTTP ' + bp.status; return res; }
        let tocUrl = bookUrl;
        const tuRule = String(rb.tocUrl || '').trim();
        if (tuRule && !/<js>|@js:/i.test(tuRule)) {
            const tu = selectAll(bp.text, tuRule);
            if (tu && tu.items.length && tu.items[0] != null && String(tu.items[0]).trim()) {
                try { tocUrl = new URL(String(tu.items[0]).trim(), bookUrl).href; } catch (e) {}
            }
        }
        const tp = tocUrl === bookUrl ? bp : await fetchPage(tocUrl, { ref: bookUrl });
        if (!tp) { res.usable = 'skip'; res.reason = '目录页请求失败'; return res; }
        if (tp.status === 404 || tp.status === 410) { res.reason = '目录页' + tp.status; return res; }
        if (tp.status >= 400) { res.usable = 'skip'; res.reason = '目录页HTTP ' + tp.status; return res; }
        let cl = selectAll(tp.text, rt.chapterList || '');
        if (!cl) { res.usable = 'skip'; res.reason = 'chapterList规则不可测'; return res; }
        if (!cl.items.length) {
            // 站点抖动复核：隔1.5s 重抓目录页再解析一次
            await sleep(1500);
            const tpR = tocUrl === bookUrl ? await fetchPage(bookUrl, { ref: base }) : await fetchPage(tocUrl, { ref: bookUrl });
            let clR = null;
            if (tpR && tpR.status < 400) clR = selectAll(tpR.text, rt.chapterList || '');
            if (clR && clR.items.length) {
                cl = clR; // 复核有结果 → 抖动，继续
            } else {
                if (isChallenge(tp.text)) { res.usable = 'skip'; res.reason = '目录触发反爬验证'; }
                else res.reason = '目录为空';
                return res;
            }
        }
        res.chapters = cl.items.length;
        let chUrl = '';
        const cuRule = String(rt.chapterUrl || '');
        for (const f of cl.items) {
            let u = pickOne(f, cuRule);
            if (!u && typeof f !== 'object') u = firstHref(f);
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
        let txt = con.items.filter(x => x != null && typeof x !== 'object').join('\n').trim();
        if (txt.length < 200) {
            // 规则声明 webView 渲染 → 测试器无渲染引擎拿不到正文 → 不可测豁免（手机端 WebView 可正常阅读）
            if (/webView|webview/i.test(JSON.stringify([s.searchUrl, s.ruleToc, s.ruleContent]))) {
                res.usable = 'skip'; res.reason = '正文需WebView渲染不可测'; return res;
            }
            // 站点抖动复核：隔1.5s 重抓正文页再解析一次
            await sleep(1500);
            const cpR = await fetchPage(chUrl, { ref: tocUrl });
            if (cpR && cpR.status < 400) {
                const conR = selectAll(cpR.text, rc.content || '');
                if (conR) {
                    const t2 = conR.items.filter(x => x != null && typeof x !== 'object').join('\n').trim();
                    if (t2.length > txt.length) txt = t2;
                }
            }
        }
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

// aging-test.js — 老化书源「先实测再删」实测模块
// 对老化名单（>365天未更新）的书源做三关真实实测：
//   ① 搜索"都市"能出书  ② 目录 ≥1 章  ③ 第一章正文 ≥200 字
// 三关全过 → usable=true（豁免保留）；任一关"确定坏" → usable=false（剔除）；
// 规则不可测或网络级失败 → usable='skip'（豁免不误删，探活层兜底真死源）。
// 支持的规则类型（P0 扩展后）：
//   - GET/POST 搜索（含 {"method/body/headers/charset"} 选项，含单引号伪 JSON 宽松解析）
//   - GBK/GB2312 请求编码（TextDecoder 反向编码表）与响应解码
//   - 搜索URL槽位：{{key}}/{{page}}/{{java.encodeURI(key[,"gbk"])}}、
//     {{cookie.removeCookie(...)}}（求值为空）、{{page-1}}/{{(page-1)*N}}（固定第1页）；
//     其余未知 {{...}} 脚本 → 判不可测（不拼假地址）
//   - HTML 静态选择器子集：class./id./tag./.x/#x/裸 tag.class、/@text/@textNodes/@html/@href/@all、
//     数字索引(.N/:N)、排除后缀 !N/!-N、||备选、##清理、表内隐式 tbody
//   - JSON 响应 + JSONPath 常用子集：$.a.b、$.a[0]、$.a[*]、$[*]、$.a['b']、$.*
// 不支持（→不可测豁免，绝不判死）：<js>/@js: 动态规则、JSONPath 高级语法（$../?()过滤）等
// 零依赖，Node 20 直接运行
const https = require('https');
const { evaluateSearchJs } = require('./src/legado-js');

/**
 * 是否允许在本进程内执行书源 <js>/@js: 脚本。
 *
 * 默认禁止（fail-closed）。只有显式设置 HEALTH_JS_SCOPE=1 的环境才允许 ——
 * 那对应 js-eval.yml 那个 contents:read、零 Secrets、persist-credentials:false
 * 的独立低权限 job。持有 contents:write 与签名私钥的生产 job 永远不该执行
 * 外部代码，因此它们不设这个变量。
 *
 * @returns {boolean}
 */
function jsEvalAllowed() {
    return String(process.env.HEALTH_JS_SCOPE || '').trim() === '1';
}

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

const { norm, originOf } = require('./src/source-id');
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
    // 浏览器/Jsoup 会为 <table><tr> 自动补 <tbody>；朴素标签提取不会补，
    // 于是 "tbody@tr!0" 这类规则在真实阅读器里能命中、在这里却 0 条，
    // 被误判成"搜索无结果"→ 进而误判源已死。这里按 HTML5 口径补出隐式 tbody。
    if (type === 'tag' && name === 'tbody' && !/<tbody\b/i.test(html)) {
        const rows = [];
        const trRe = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
        let tm;
        while ((tm = trRe.exec(html))) rows.push(tm[0]);
        if (rows.length) return ['<tbody>' + rows.join('') + '</tbody>'];
    }
    if (type === 'tag') {
        const re = new RegExp('<' + name + '\\b[^>]*>', 'gi');
        let m; while ((m = re.exec(html))) hits.push([m.index, m[0]]);
    } else if (type === 'idclass') {
        // CSS 的 tag#id.class（如 div#content.showtxt）：先按 id 取，再用标签与 class 过滤
        const [tag, idn, cls] = name;
        const clsRe = new RegExp('(?<![\w-])' + esc(cls) + '(?![\w-])');
        return innerAll(html, 'id', idn)
            .filter(el => new RegExp('^<' + tag + '\\b', 'i').test(el))
            .filter(el => {
                const gt = el.indexOf('>');
                const cm = /class\s*=\s*(["'"])([^"']*)\1/i.exec(gt > 0 ? el.slice(0, gt + 1) : el);
                return !!(cm && clsRe.test(cm[2]));
            });
    } else if (type === 'tagclass') {
        // CSS 的 tag.class（如 div.bk）：先按标签取元素，再用开标签里的 class 过滤
        const nameRe = new RegExp('(?<![\\w-])' + esc(name[1]) + '(?![\\w-])');
        return innerAll(html, 'tag', name[0]).filter(el => {
            const gt = el.indexOf('>');
            const cm = /class\s*=\s*(["'])([^"']*)\1/i.exec(gt > 0 ? el.slice(0, gt + 1) : el);
            return !!(cm && nameRe.test(cm[2]));
        });
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

        // ── 2026-10-28 扩能：对齐 legado 支持但此前被判「规则不可测」的几种写法 ──
        //  ① @css: 前缀（与 legado 的 .class/#id/tag.class 语义一致，去掉前缀走同一套引擎）
        //  ② > 子代选择器（我们按后代处理；盗版站绝大多数是直接子代，差异可忽略）
        //  ③ 裸类名（token 不是已知标签时按 class 处理，legado 同口径）
        //  ④ class.a b 多词类名（legado 允许 class 里带空格，如 class.pt-card pt-card-2）
        //  ⑤ [class="x"] / [id="x"] 属性选择器
        //  ⑥ .class.N / .class.-N 点索引
        // 安全阀：只要用了上述新写法且最终取不到元素，就按「不可测」返回 null，
        // 而不是返回空数组——空数组会被上游当成「搜索无结果」判死源，那是误杀。
        let usedNew = false;
        if (/^@css:/i.test(sel.trim())) { usedNew = true; sel = sel.trim().slice(5); }
        // 用了 > 子代写法也算新语法：取不到就判不可测，避免把「解析没命中」误判成「源已死」
        if (sel.includes('>')) usedNew = true;

        // 先按 legado 的 @ 分段，段内再按空格 / > 拆后代链
        const toks = [];
        for (const seg of sel.split('@')) {
            const parts = seg.split(/\s*(?:>|\s)\s*/).filter(Boolean);
            for (const p of parts) toks.push(p);
        }
        if (!toks.length) continue;

        // ④ 多词类名合并：class.xxx 后面紧跟的裸词若既不是已知标签也不是选择器写法，并入类名
        const merged = [];
        for (let i = 0; i < toks.length; i++) {
            const tk = toks[i];
            if (/^class\./i.test(tk) && i + 1 < toks.length) {
                const nx = toks[i + 1];
                const looksSelector = /^(class|id|tag)\./i.test(nx) || /^[.#]/.test(nx) || nx.startsWith('[')
                    || /^(text|textnodes|html|href|all)$/i.test(nx) || TAGS.has(nx.toLowerCase());
                if (!looksSelector) { merged.push(tk + ' ' + nx); usedNew = true; i++; continue; }
            }
            merged.push(tk);
        }

        let frags = [html], ok = true;
        for (let tk of merged) {
            if (/^(text|textnodes|html|href|all)$/i.test(tk)) {
                if (usedNew && !frags.length) { ok = false; break; }
                const kind = tk.toLowerCase();
                const items = applyClean(frags.map(f => kind === 'href' ? firstHref(f) : (kind === 'html' || kind === 'all') ? f : toText(f)), clean);
                return { items, isText: true };
            }
            // 前导 - 表示该步结果反转
            let rev = false;
            if (tk.length > 1 && tk[0] === '-') { rev = true; tk = tk.slice(1); usedNew = true; }

            // ⑤ 属性选择器 [class="x"] / [id="x"]
            let am;
            if ((am = /^\[(class|id)\s*=\s*["']([^"']+)["']\]$/i.exec(tk))) {
                usedNew = true;
                let acc = [];
                for (const f of frags) acc = acc.concat(innerAll(f, am[1].toLowerCase(), am[2]));
                frags = acc;
                if (!frags.length) break;
                continue;
            }

            // 排除后缀 !N / !-N / !0:1:2
            let exclList = null;
            const em = /^(.+?)!(-?\d+(?::-?\d+)*)$/.exec(tk);
            if (em) { tk = em[1]; exclList = em[2].split(':').map(Number); }

            let type, name, idx = null, m;
            if ((m = /^class\.([\w\u4e00-\u9fff\-\$ ]+?)(?:[.:](-?\d+))?$/.exec(tk))) {
                // class 允许带空格（legado 的 class.pt-card pt-card-2 = class 属性里同时含两个词）
                type = 'class'; name = m[1].trim(); if (m[2]) { idx = parseInt(m[2], 10); usedNew = true; }
            } else if ((m = /^(id|tag)\.([\w\u4e00-\u9fff\-\$]+?)(?:[.:](-?\d+))?$/.exec(tk))) {
                type = m[1]; name = m[2]; if (m[3]) { idx = parseInt(m[3], 10); usedNew = true; }
            } else if ((m = /^\.([\w\u4e00-\u9fff\-\$]+?)(?:[.:](-?\d+))?$/.exec(tk))) {
                type = 'class'; name = m[1]; if (m[2]) { idx = parseInt(m[2], 10); usedNew = true; }
            } else if ((m = /^#([\w\u4e00-\u9fff\-\$]+?)(?:[.:](-?\d+))?$/.exec(tk))) {
                type = 'id'; name = m[1]; if (m[2]) { idx = parseInt(m[2], 10); usedNew = true; }
            } else if ((m = /^([a-z][a-z0-9]*)#([\w\u4e00-\u9fff\-\$]+)\.([\w\u4e00-\u9fff\-\$]+)(?:[.:](-?\d+))?$/i.exec(tk)) && TAGS.has(m[1].toLowerCase())) {
                type = 'idclass'; name = [m[1].toLowerCase(), m[2], m[3]]; if (m[4]) idx = parseInt(m[4], 10);
                usedNew = true;
            } else if ((m = /^([a-z][a-z0-9]*)(?:[.:](-?\d+))?$/i.exec(tk)) && TAGS.has(m[1].toLowerCase())) {
                type = 'tag'; name = m[1].toLowerCase(); if (m[2]) idx = parseInt(m[2], 10);
            } else if ((m = /^([a-z][a-z0-9]*)\.([\w\u4e00-\u9fff\-\$]+?)(?:[.:](-?\d+))?$/i.exec(tk)) && TAGS.has(m[1].toLowerCase())) {
                // 裸 tag.class（如 div.bk）
                type = 'tagclass'; name = [m[1].toLowerCase(), m[2]]; if (m[3]) idx = parseInt(m[3], 10);
            } else if (/^[\w\u4e00-\u9fff\-\$]+$/.test(tk)) {
                // ③ 裸类名（不是已知标签）：legado 按 class 处理
                type = 'class'; name = tk; usedNew = true;
            } else { ok = false; break; }

            let next = [];
            for (const f of frags) next = next.concat(innerAll(f, type, type === 'tag' ? name.toLowerCase() : name));
            if (idx != null) next = idx < 0 ? (next.length + idx >= 0 ? [next[next.length + idx]] : []) : (next[idx] ? [next[idx]] : []);
            if (exclList) {
                const drop = new Set(exclList.map(n => (n < 0 ? next.length + n : n)));
                next = next.filter((_, i) => !drop.has(i));
            }
            if (rev) next.reverse();
            frags = next;
            if (!frags.length) break;
        }
        if (ok) {
            // 新写法取不到任何元素 → 宁可判「不可测」也不要让上游当成「源已死」
            if (usedNew && frags.length === 0) continue;
            return { items: frags, isText: false };
        }
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
//
// JS 形态（<js>...</js> / @js:...）：先用 src/legado-js.js 离线求值，得到真正的 URL
// 再走同一套解析。求值器只实现「纯本地」那一层（java.put/get、JSON、md5/base64/encode
// 等），需要联网（java.ajax/post）或 Android WebView 的会返回分层 skip 原因，
// 而不是笼统的「含js」。实测 100 个 JS searchUrl 里 42 个能靠这层救回来。
function parseSearch(su, base, kw) {
    kw = kw || '都市';
    su = String(su || '').trim();
    if (!su) return { skip: '无搜索URL' };
    let fromJs = false;

    if (/<js>|@js:/i.test(su)) {
        // ── 安全开关：是否允许在本进程里执行书源 JS ──────────────────────────
        // node:vm 不是安全沙箱，执行不可信代码本身就是风险面。因此执行权限
        // 由环境变量显式授予，默认**禁止**：
        //   · update.yml（contents:write + ED25519_KEY）不设该变量 → 不执行，判不可测
        //   · js-eval.yml（contents:read + 零 Secrets + 独立工作区）设 HEALTH_JS_SCOPE=1
        //     → 在这里执行，结果以纯 JSON 交回生产 job
        // 这样「执行外部代码」与「持有写权限/签名私钥」永远不会落在同一个工作区。
        if (!jsEvalAllowed()) {
            return { skip: 'JS求值已禁用(该 job 无执行权限)' };
        }
        const ev = evaluateSearchJs({ su, base, key: kw, page: 1 });
        if (!ev.ok) return { skip: ev.skip };
        // 求值成功：用产出的 URL 继续走下面的静态解析（可能带 JSON 选项尾巴）
        su = String(ev.url).trim();
        if (!su) return { skip: 'JS求值后URL为空' };
        fromJs = true;
    }
    // 逗号切分：选项体以 ",{" 开头。逗号可能落在 {{...}} 里（如 java.encodeURI(key,"gbk")），
    // 也可能只是 URL 参数里的普通逗号，不能直接取第一个逗号——否则会把槽位切断，
    // 误判成"搜索无{{key}}槽位"。先找 ",{"，找不到再退回旧的"第一个逗号"口径。
    const commaIdx = (s, jsonTailOnly) => {
        let depth = 0;
        for (let i = 0; i < s.length; i++) {
            if (s[i] === '{' && s[i + 1] === '{') { depth++; i++; continue; }
            if (s[i] === '}' && s[i + 1] === '}' && depth > 0) { depth--; i++; continue; }
            if (s[i] === ',' && depth === 0 && (!jsonTailOnly || /^\s*\{/.test(s.slice(i + 1)))) return i;
        }
        return -1;
    };
    let cut = commaIdx(su, true);
    if (cut === -1) cut = commaIdx(su, false);
    let path = (cut === -1 ? su : su.slice(0, cut)).trim();
    const tail = cut === -1 ? '' : su.slice(cut + 1).trim();
    // 无逗号却带 JSON 选项残片（如 url{"method":...}）：不猜，按选项无法解析处理
    if (cut === -1 && /\{"/.test(path)) return { skip: 'searchUrl选项无法解析' };
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
    // 严格白名单：先去掉测试器真正支持的槽位，若 URL/body 里仍残留动态语法 → 不可测。
    // 旧口径只看切出来的 path，包在 {{...}} 里的脚本（如 {{String(java.connect(...))}}）
    // 会被当成静态串拼进 URL，得到一个必然失败的假地址（假死比不可测更危险）。
    // 只查 URL 段与 body：选项体里的 "js" 钩子属既有行为（旧测试器同样忽略它），不因此降级。
    const SUPPORTED_KEY = /\{\{key\}\}|\{key\}|\{\{page\}\}|\{page\}|\{\{java\.encodeURI(?:Component)?\(\s*key\s*(?:,\s*['"][^'"]*['"]\s*)?\)\}\}/g;
    const strictRaw = (cut === -1 ? su : su.slice(0, cut)) + (body ? '\n' + body : '');
    if (/<js>|@js:|\$\.|java\./i.test(strictRaw.replace(SUPPORTED_KEY, ''))) return { skip: '搜索URL/body含动态语法' };

    // 其余 {{...}} 槽位：只求值语义明确、无副作用的两类，剩下的一律判不可测。
    // 关键动机：把未支持的脚本原样拼进 URL 会得到一个必然 404 的假地址 → 假死（比不可测危险）。
    //   ① cookie.removeCookie(...)（含 url=source.getKey(); 前缀写法）→ 空串
    //   ② page 简单算术 {{page-1}} / {{(page-1)*10}}（本轮固定请求第 1 页）
    const PAGE_NO = 1;
    const NOOP_SLOT = /^(?:[A-Za-z_$][\w$]*\s*=\s*[\w$.()\[\]'"\s]+;\s*)*cookie\.removeCookie\([^;{}]*\)$/;
    const evalMustache = s => {
        let bad = '';
        const out = String(s).replace(/\{\{([^{}]*)\}\}/g, (m, inner) => {
            const t = String(inner).trim();
            if (/^(?:key|page)$/i.test(t)) return m;
            if (/^java\.encodeURI(?:Component)?\(\s*key(?:\s*,\s*['"][^'"]*['"]\s*)?\)$/i.test(t)) return m;
            if (NOOP_SLOT.test(t)) return '';
            let am = /^\(\s*page\s*([-+])\s*(\d+)\s*\)\s*\*\s*(\d+)$/i.exec(t);
            if (am) return String((PAGE_NO + (am[1] === '-' ? -1 : 1) * parseInt(am[2], 10)) * parseInt(am[3], 10));
            am = /^page\s*([-+])\s*(\d+)$/i.exec(t);
            if (am) return String(PAGE_NO + (am[1] === '-' ? -1 : 1) * parseInt(am[2], 10));
            bad = t.slice(0, 30);
            return m;
        });
        return { out, bad };
    };
    const pe = evalMustache(path);
    if (pe.bad) return { skip: '搜索URL/body含未支持动态语法' };
    path = pe.out;
    if (body != null) {
        const be = evalMustache(body);
        if (be.bad) return { skip: '搜索URL/body含未支持动态语法' };
        body = be.out;
    }

    // java.encodeURI(key[, "gbk"])：把关键词预先编码进 URL/body 的常见写法。
    // 旧实现只认裸 {{key}}，这类源会被判成"搜索无{{key}}槽位"而永久不可测。
    const JAVA_URI = /\{\{java\.encodeURI(?:Component)?\(\s*key\s*(?:,\s*['"]([^'"]*)['"]\s*)?\)\}\}/g;
    let javaKey = false, javaGbk = false, javaFail = '';
    const injectJavaKey = s => s.replace(JAVA_URI, (m, cs) => {
        javaKey = true;
        if (cs && /gb2312|gbk/i.test(cs)) {
            javaGbk = true;
            if (!GBK.has) { javaFail = 'GBK编码表初始化失败'; return ''; }
            const e = GBK.pct(kw);
            if (!e) { javaFail = 'GBK表缺字'; return ''; }
            return e;
        }
        return encodeURIComponent(kw);
    });
    path = injectJavaKey(path);
    if (body != null) body = injectJavaKey(body);
    if (javaFail) return { skip: javaFail };
    if (javaGbk && !charset) charset = 'gbk';   // 关键词已按 GBK 编码，响应也按 GBK 解

    const isGbk = /gb2312|gbk/i.test(charset);
    if (isGbk && !GBK.has) return { skip: 'GBK编码表初始化失败' };
    const hasKey = u => /\{\{key\}\}|\{key\}/.test(u);
    // fromJs 标记：这一段 searchUrl 是 JS 求值后的产物，关键词可能已经被脚本
    // 内联进 URL（例如脚本自己拼了 `?wd=` + key），此时不该再要求 {{key}} 槽位 ——
    // 否则求值成功的 25 个源会被这一条检查全部退回「无槽位」。
    // 但「假地址」防护不能丢：对 JS 产物只要求 URL 里要么带槽位、
    // 要么已经含本次测试关键词的编码形态之一。
    if (!fromJs && !javaKey && !hasKey(path) && !(body && hasKey(body))) return { skip: '搜索无{{key}}槽位' };
    // JS 产物必须能证明关键词真的进去了：要么仍有槽位待替换，要么已经包含
    // 本次关键词的 UTF-8 或 GBK 百分号编码形态。两者都不满足说明脚本把 key
    // 丢了（例如只 java.put('key',key) 却没拼进 URL），那会是一个假地址，判不可测。
    if (fromJs && !hasKey(path)) {
        const utf8 = encodeURIComponent(kw);
        const gbkPct = GBK.has ? GBK.pct(kw) : '';
        const bodyHasKey = body && (hasKey(body) || body.includes(kw) || body.includes(utf8));
        const pathHasKey = path.includes(kw) || path.includes(utf8) || (gbkPct && path.includes(gbkPct));
        if (!pathHasKey && !bodyHasKey) return { skip: 'JS求值后URL未含关键词' };
    }
    // 关键词编码：GBK 站按站点编码做百分号转义，UTF-8 站用标准 encodeURIComponent
    const K = isGbk ? GBK.pct(kw) : encodeURIComponent(kw);
    if (!K) return { skip: 'GBK表缺字' };
    path = path.replace(/\{\{page\}\}|\{page\}/g, '1');
    if (body != null) body = body.replace(/\{\{page\}\}|\{page\}/g, '1');
    // java.* 脚本调用（除已替换的 java.encodeURI）同样是动态规则：不能当静态 URL 去请求，
    // 否则会把脚本源码拼进 URL，得到一个必然失败的假地址（假死比不可测更危险）
    const dynFree = x => !/<js>|@js:|\$\.|java\./i.test(String(x).replace(/\{\{[^}]*\}\}|\{[^}]*\}/g, ''));
    if (!dynFree(path) || (body != null && !dynFree(body))) return { skip: '搜索URL/body含动态语法' };
    let url;
    try { url = new URL(hasKey(path) || javaKey ? path.replace(/\{\{key\}\}|\{key\}/g, K) : path, base).href; }
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

/* ---------- 官方校验关键字（对齐 LegadoTeam/legado BookSource.getCheckKeyword） ---------- */
// 官方 SearchRule 里有个 checkKeyWord 字段（注释就是「校验关键字」），
// 很多源在里面写了专门用来搜书的词（书名/作者），比硬编码「都市」命中率高得多。
// 官方的采纳条件（BookSource.kt:216）：
//   ruleSearch.checkKeyWord 非空，且不含 "http" / "::" / "++" / "--"
// 不满足就用全局默认值（官方默认是「我的」，我们沿用历史默认「都市」）。
function checkKeyWordOf(s) {
    const kw = s && s.ruleSearch && s.ruleSearch.checkKeyWord;
    if (!kw) return null;
    const t = String(kw).trim();
    if (!t) return null;
    if (t.includes('http') || t.includes('::') || t.includes('++') || t.includes('--')) return null;
    return t;
}

/* ---------- 发现页入口解析（对齐官方 exploreKinds） ---------- */
// 官方 BookSourceExtensions.exploreKinds() 的三种形态：
//   ① "@js:..." / "<js>...</js>"  → 脚本生成，静态解析不了 → 返回 []
//   ② 以 [ 开头                    → JSON 数组，取每项 url（type 不是 url 的是按钮/开关，跳过）
//   ③ 其它                         → 文本格式：分类名::url模板，行间用 \n 或 &&
// 实测：绝大多数源用的是 ③，如果只按 JSON 解析，会拿整段文本当 URL，探测结果全是 404。
function exploreKinds(url) {
    const raw = String(url || '').trim();
    if (!raw) return [];
    if (/^@js:|^<js>/i.test(raw)) return [];
    if (raw.startsWith('[')) {
        try {
            const j = JSON.parse(raw);
            const arr = Array.isArray(j) ? j : [j];
            return arr
                .filter((x) => x && (!x.type || x.type === 'url') && (x.url || x.href))
                .map((x) => String(x.url || x.href).trim())
                .filter(Boolean);
        } catch (e) { /* 解析失败就按文本格式再试一次 */ }
    }
    return raw.split(/(?:&&|\n)+/)
        .map((line) => line.split('::'))
        .filter((parts) => parts.length >= 2 && String(parts[1] || '').trim())
        .map((parts) => String(parts[1]).trim());
}

/* ---------- 第④关：发现页（官方默认开，本仓库此前完全没测） ---------- */
// 只做「能力探测」，不参与 usable 判定：发现页挂了不代表搜索/正文坏了，
// 所以这里返回独立的 ok/reason，由 health.js 记到 explore 字段、score.js 打 CI 分组。
async function checkExplore(s) {
    const base = originOf(s.bookSourceUrl);
    if (!base) return { ok: false, reason: '无效URL' };
    const kinds = exploreKinds(s.exploreUrl);
    if (!kinds.length) {
        const raw = String(s.exploreUrl || '');
        return { ok: false, reason: /^@js:|^<js>/i.test(raw.trim()) ? '发现页是js生成' : '无发现入口' };
    }
    const rule = s.ruleExplore && s.ruleExplore.bookList;
    if (!rule) return { ok: false, reason: 'exploreRule为空' };
    // {{page}} 取第 1 页（官方点进发现页时默认也是第 1 页）
    const tpl = kinds[0].replace(/\{\{page\}\}/gi, '1');
    let u;
    try { u = new URL(tpl, base).href; } catch (e) { return { ok: false, reason: '发现URL非法' }; }
    const pg = await fetchPage(u, { ref: base });
    if (!pg) return { ok: false, reason: '发现页请求失败' };
    if (pg.status === 404 || pg.status === 410) return { ok: false, reason: '发现页' + pg.status };
    if (pg.status >= 400) return { ok: false, reason: '发现页HTTP ' + pg.status };
    const bl = selectAll(pg.text, rule);
    if (!bl) return { ok: false, reason: 'bookList规则不可测' };
    if (!bl.items.length) return { ok: false, reason: '发现页无书' };
    return { ok: true, count: bl.items.length };
}

/* ---------- 三关实测主流程 ---------- */
async function checkSource(s, opts = {}) {
    const res = { usable: false, reason: '', chapters: 0, contentLen: 0, activity: '未知' };
    try {
        const base = originOf(s.bookSourceUrl);
        if (!base) { res.usable = 'skip'; res.reason = '无效URL'; return res; }
        const rs = s.ruleSearch || {}, rb = s.ruleBookInfo || {}, rt = s.ruleToc || {}, rc = s.ruleContent || {};

        // 书名候选：正常流程走搜索；若上层指定了 bookUrl（换书重试），直接用它，省掉一次搜索
        const bookCandidates = [];
        if (opts.bookUrl) {
            bookCandidates.push(opts.bookUrl);
        } else {
            // 第①关：搜索出书（双关键词 + 隔1.5s二次复核，防"站点无此关键词"和瞬时抖动误判死）
            // 关键词顺序：源自带的 checkKeyWord（官方字段，16.5% 的源有）→ 都市 → 重生
            const KW1 = checkKeyWordOf(s) || '都市';
            const KW2 = KW1 === '都市' ? '重生' : '都市';
            let r1 = await doSearch(s, base, rs, KW1);
            if (r1.skip) { res.usable = 'skip'; res.reason = r1.skip; return res; }
            if (r1.dead) { res.reason = r1.dead; return res; }
            if (!r1.bl.items.length) {
                r1 = await doSearch(s, base, rs, KW2);
                if (r1.skip) { res.usable = 'skip'; res.reason = r1.skip; return res; }
                if (r1.dead) { res.reason = r1.dead; return res; }
                if (!r1.bl.items.length) {
                    await sleep(1500);
                    r1 = await doSearch(s, base, rs, KW1);
                    if (r1.skip) { res.usable = 'skip'; res.reason = r1.skip; return res; }
                    if (r1.dead) { res.reason = r1.dead; return res; }
                    if (!r1.bl.items.length) {
                        if (isChallenge(r1.sp.text)) { res.usable = 'skip'; res.reason = '搜索触发反爬验证'; }
                        else res.reason = '搜索无结果';
                        return res;
                    }
                }
            }
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
                try {
                    const abs = new URL(u, base).href;
                    if (!bookCandidates.includes(abs)) bookCandidates.push(abs);
                } catch (e) {}
                if (bookCandidates.length >= 3) break;
            }
            if (!bookCandidates.length) {
                // bookList 有结果但提取不出书籍链接：可能是 bookUrl 规则动态/字段超纲（测试器不会提取 ≠ 源坏）→ 豁免
                res.usable = 'skip'; res.reason = 'bookUrl无法提取'; return res;
            }
        }
        const bookUrl = bookCandidates[0];

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

        // 第②关补充：分页链接轻量验证
        // 只抓一次 nextTocUrl（如果规则有），不遍历全部分页——预算不允许。
        // 目的不是证明完整目录，而是证明"分页不是死链"。
        // 分页挂了 → skip（不是 dead，因为第一页正常；说明源可能只有单页，或者分页逻辑有问题）
        const nuRule = String(rt.nextTocUrl || '').trim();
        if (nuRule && !/<js>|@js:/i.test(nuRule) && cl.items.length >= 5) {
            // 先从目录页里找分页链接
            const nxt = selectAll(tp.text, nuRule);
            if (nxt && nxt.items.length) {
                let nextUrl = null;
                const f0 = nxt.items[0];
                if (typeof f0 === 'string' && f0.trim()) nextUrl = f0.trim();
                else if (typeof f0 === 'object' && f0.href) nextUrl = String(f0.href).trim();
                if (nextUrl) {
                    try { nextUrl = new URL(nextUrl, tocUrl).href; } catch (e) { nextUrl = null; }
                }
                if (nextUrl) {
                    try {
                        const np = await fetchPage(nextUrl, { ref: tocUrl });
                        if (np && np.status < 400) {
                            // 分页链接有效，不影响结论
                        } else if (np && (np.status === 404 || np.status === 410)) {
                            res.usable = 'skip'; res.reason = '分页链接404/410（目录第一页正常但后续页挂了）'; return res;
                        }
                        // 其他 HTTP 错误（超时、5xx）：保持 skip 但说明原因
                        else if (!np || np.status >= 500) {
                            res.usable = 'skip'; res.reason = '分页链接请求失败（' + (np ? np.status : 'timeout') + '）'; return res;
                        }
                    } catch (e) { /* fetchPage 内部会处理异常 */ }
                }
            }
            // 规则有 nextTocUrl 但解析不到链接 → 可能是单页目录，保持 pass 不跳过
        }

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
            if (isChallenge(cp.text)) { res.usable = 'skip'; res.reason = '正文触发反爬验证'; return res; }
            // 换书重试：单本书被站点删书/门禁/正文失效，不代表整个源坏了。
            // 搜索阶段已收集最多 3 个候选，这里依次换书实测，任一可用即判源可用；
            // 递归调用时 bookCandidates 只含被指定的那一本，天然不会再次发散。
            const tried = [];
            for (const alt of bookCandidates.slice(1)) {
                const r2 = await checkSource(s, { bookUrl: alt });
                if (r2.usable === true) {
                    r2.reason = '三关全过（第1本正文为空，换书后通过）';
                    return r2;
                }
                tried.push(r2.reason);
            }
            res.reason = '正文不足200字（实得' + txt.length + '）' + (tried.length ? '；另换 ' + tried.length + ' 本仍失败' : '');
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

module.exports = { checkSource, checkExplore, exploreKinds, checkKeyWordOf, doSearch, fetchPage, selectAll, pickOne, firstHref, originOf, norm, isChallenge, sleep, parseSearch };

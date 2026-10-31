// src/legado-js.js —— 书源 searchUrl 的 JS 求值器（离线、纯函数、无副作用）
//
// ══ 安全定位（必读）══════════════════════════════════════════════════════════
// node:vm 不是安全沙箱 —— Node 官方文档明确这么说。本模块**不承担**「防止恶意
// 代码越界」的最终职责。真正的边界在 CI：JS 求值跑在一个 contents:read、
// 零 Secrets、persist-credentials:false 的独立 job 里，生产 job 只消费纯 JSON。
//
// 但本模块仍修掉了一个被实测证实的低成本逃逸路径：
//
//   旧写法把宿主闭包函数（java.put / console.log / md5Encode …）直接塞进 vm 上下文。
//   脚本可以经由这些函数的 constructor 回到宿主：
//       java.put.constructor('return process')().version  →  "v24.14.1"
//       java.put.constructor('return process')().env      →  69 个环境变量
//
//   新写法把**所有** java.* / source.* / cookie.* / 工具函数都改成「在沙箱内部
//   由 bootstrap 代码创建」，宿主注入的只有纯 JSON 常量（字符串/数字）。
//   脚本的 constructor 链只能到达沙箱自己的 Function，`return process` 得到 undefined。
//   实测：
//       java.put.constructor('return process')().version  →  Throws: process is not defined
//
// 纯计算工具（md5/base64/hmac/des/gbk）的做法：宿主在**注入前**扫描脚本里的
// 这些调用，用已知的 key 预先算好结果，做成 {调用签名: 结果字符串} 常量表。
// 沙箱内的同名函数只做查表；查不到就抛错，绝不回落到宿主函数。
//
// ══ 能力分层（对成品 100 个 JS 源实测）══════════════════════════════════════
//   · 纯本地可求值（java.put/get + 字符串拼装 + 预计算工具）
//   · 需要联网（java.ajax/post/get/connect）→ 交上层用 fetchPage 实现
//   · 需要 Android（java.webView/androidId）→ 永久不可测
//
// ══ 输出契约 ════════════════════════════════════════════════════════════════
//   成功 → { ok:true, url }
//   失败 → { ok:false, skip }  ← 绝不返回半成品 URL（假死比不可测更危险）
// ═════════════════════════════════════════════════════════════════════════════

'use strict';

const vm = require('node:vm');
const crypto = require('node:crypto');

const EVAL_TIMEOUT_MS = 1000;

function isJsSearchUrl(su) {
    return /<js>|@js:/i.test(String(su || ''));
}

/** JS 之前的静态前缀（legado 的 result 语义）。 */
function extractStaticPrefix(su) {
    const s = String(su || '');
    const open = s.search(/<js>/i);
    if (open >= 0) return s.slice(0, open).trim();
    const at = s.search(/@js:/i);
    if (at >= 0) return s.slice(0, at).trim();
    return '';
}

/** 抽出脚本正文与 </js> 之后的静态后缀。 */
function extractJs(su) {
    const s = String(su || '');
    const open = s.search(/<js>/i);
    if (open >= 0) {
        const start = open + 4;
        const close = s.indexOf('</js>', start);
        if (close < 0) return { code: s.slice(start), suffix: '' };
        return { code: s.slice(start, close), suffix: s.slice(close + 5) };
    }
    const at = s.search(/@js:/i);
    if (at >= 0) return { code: s.slice(at + 4), suffix: '' };
    return { code: '', suffix: '' };
}

// ── 宿主侧纯计算（只在「注入前预计算」阶段使用，永不进入沙箱）─────────────

const md5Hex = (s, up) => {
    const h = crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
    return up ? h.toUpperCase() : h;
};
const sha256Hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const hmacSha256Hex = (s, k) =>
    crypto.createHmac('sha256', String(k)).update(String(s), 'utf8').digest('hex');
const base64Encode = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const base64Decode = (s) => Buffer.from(String(s), 'base64').toString('utf8');
function desEncodeToBase64(d, k) {
    const cipher = crypto.createCipheriv('des-ecb', Buffer.from(String(k), 'utf8').subarray(0, 8), null);
    return cipher.update(String(d), 'utf8', 'base64') + cipher.final('base64');
}

/**
 * 扫描脚本里的工具调用，用「已知的 key」预先算好结果，产出纯常量表。
 * 表键是「函数名|参数1|参数2」的字面签名；沙箱内查表未命中就抛错。
 * @param {string} code
 * @param {string} key
 * @param {function} gbkEncode
 * @returns {Object<string,string>}
 */
function precomputeToolResults(code, key, gbkEncode) {
    const table = Object.create(null);
    const callRe =
        /java\.(\w+)\s*\(\s*(?:['"]([^'"]*)['"]|([A-Za-z_$][\w$]*))\s*(?:,\s*(?:['"]([^'"]*)['"]|([A-Za-z_$][\w$]*))\s*)?\)/g;
    let m;
    while ((m = callRe.exec(code)) !== null) {
        const [, fn, lit1, var1, lit2, var2] = m;
        const arg1 = lit1 !== undefined ? lit1 : var1 === 'key' ? key : undefined;
        const arg2 = lit2 !== undefined ? lit2 : var2 === 'key' ? key : undefined;
        if (arg1 === undefined) continue;
        const sig = fn + '|' + arg1 + '|' + (arg2 === undefined ? '' : arg2);
        if (table[sig] !== undefined) continue;
        try {
            switch (fn) {
                case 'md5Encode': table[sig] = md5Hex(arg1, false); break;
                case 'md5Encode16': table[sig] = md5Hex(arg1, false).slice(8, 24); break;
                case 'sha256Encode': table[sig] = sha256Hex(arg1); break;
                case 'base64Encode': table[sig] = base64Encode(arg1); break;
                case 'base64Decode': table[sig] = base64Decode(arg1); break;
                case 'HMacHex':
                    if (arg2 !== undefined) table[sig] = hmacSha256Hex(arg1, arg2);
                    break;
                case 'desEncodeToBase64String':
                    if (arg2 !== undefined) table[sig] = desEncodeToBase64(arg1, arg2);
                    break;
                case 'encodeURI':
                case 'encodeURIComponent':
                    table[sig] = gbkEncode(arg1);
                    break;
                default:
                    break;
            }
        } catch {
            /* 预计算失败：不进表，沙箱内调用时抛错 */
        }
    }
    return table;
}

/**
 * 扫描并**预取**脚本里所有 java.ajax/post/get/connect 调用的结果（2026-10-31）。
 *
 * 为什么是「预取」而不是「沙箱内真调网络」：
 *   java.ajax 在 legado 里是同步函数，而 vm.runInContext 也同步 —— 没法在 vm 里
 *   放一个真网络对象还能同步返回。唯一可行路径是：宿主先同步跑完这些请求，
 *   把「URL(+方法+body) → 响应文本」做成表，沙箱内只做**纯查表**。
 *   这样 vm 里依旧没有任何网络/文件/进程能力，隔离边界一点没松。
 *
 * 提取能力受限于正则：只认字面量参数（'url'、"url"、key、page 这几种），
 * 动态拼出来的 URL（字符串相加、变量二次赋值）拿不到 → 那些仍走 skip。
 * 这是刻意的取舍：宁可少救一些源，也不在解析不确定的情况下发出请求。
 */
function precomputeNetworkResults(code, opts) {
    const table = Object.create(null);
    const net = require('./legado-js-net');
    const sourceOrigin = net.originOfSource(opts.base);
    if (!sourceOrigin) return { table, fetched: 0, blocked: 0 };

    // 支持两种常见形态（2026-10-31 扩展）：
    //   ① 纯字面量：        java.ajax('https://x/y')
    //   ② 字面量 + key 拼接：java.get('https://x/?q='+key+'&p=1')
    //      —— 实测 8 个 java.get 源里多数是这种，之前完全提不到。
    // 仍不支持：变量二次赋值（url1=...; java.ajax(url1+json(post)）—— 那类在 vm 里
    // 只能靠运行时求值，宿主预取拿不到，继续降级为 skip（不误判）。
    const callRe = new RegExp(
        'java\\.(ajax|post|get|connect)\\s*\\(\\s*' +
        "'([^']*)'\\s*(?:\\+\\s*(?:key|globalThis\\.key)\\s*\\+\\s*'([^']*)'\\s*)?" +   // 单引号 + key 拼接
        '(?:,\\s*([\'"])([^\'"]*)\\4\\s*)?\\)?',
        'g'
    );
    let m;
    let fetched = 0;
    let blocked = 0;
    while ((m = callRe.exec(code)) !== null) {
        const fn = m[1];
        const head = m[2];
        const tail = m[3];       // '+' key '+' 之后的尾巴（可能 undefined）
        const bodyLit = m[5];
        // 拼接：head + key + tail
        const joined = tail === undefined
            ? String(head)
            : String(head) + String(opts.key || '') + String(tail);
        const url = joined
            .replace(/\{\{key\}\}|\{key\}/g, opts.key || '')
            .replace(/\{\{page\}\}|\{page\}/g, String(opts.page === undefined ? 1 : opts.page));

        // ⚠️ sig 必须与沙箱内运行时**完全一致**（2026-10-31 实测踩坑）：
        //   预取时这里算出的 url 已经是拼接好的完整地址，
        //   而沙箱内 java.get(...) 收到的也是同一个完整地址 ——
        //   所以 sig 就该用**拼接后的 url**，不能把占位符留在里面。
        //   （之前一版把 key 烘进 sig、沙箱侧又传了拼接后的串，两边对不上。）
        const sig = fn + '|' + url + '|' + (bodyLit === undefined ? '' : bodyLit);
        if (table[sig] !== undefined) continue;

        // connect 是 socket，不支持
        if (fn === 'connect') { blocked++; continue; }

        let abs = url;
        if (!/^https?:/i.test(abs)) {
            try { abs = new URL(abs, opts.base).href; } catch (e) { blocked++; continue; }
        }
        const method = fn === 'post' ? 'POST' : 'GET';
        const r = net.syncFetch({
            url: abs,
            method,
            headers: fn === 'post' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
            body: bodyLit,
            sourceOrigin,
        });
        if (r.ok) {
            table[sig] = r.text;
            // 同时记下响应头：脚本会写 java.get(url).header("location") 拿重定向后的地址
            table[sig + '|HDR'] = r.headers || {};
            fetched++;
        } else { blocked++; }
    }
    return { table, fetched, blocked };
}


function bootstrapSource(pure) {
    return `
(function () {
  const P = ${JSON.stringify(pure)};
  const TABLE = P.toolTable;
  const NET = P.netTable || Object.create(null);

  function unimplemented(name) { throw new Error('UNIMPLEMENTED_JAVA:' + name); }
  function needsNetwork(name) { throw new Error('NEEDS_NETWORK:' + name); }
  function lookup(name, a, b) {
    const sig = name + '|' + a + '|' + (b === undefined ? '' : b);
    if (Object.prototype.hasOwnProperty.call(TABLE, sig)) return TABLE[sig];
    throw new Error('TOOL_NOT_PRECOMPUTED:' + name);
  }
  // 查预取网络表；查不到就是「这个调用的 URL 我们没法在宿主侧确定」→ 降级为 skip
  //
  // 返回形态：legado 的 java.get/post 返回的是「响应对象」，脚本常直接用它写
  //   .header / .body() / .toString() / .string()
  // 实测八叉书库就是 new_url.header —— 只返回字符串会在这一步炸。
  // 这里包一层，既保留字符串语义（String(r) / typeof 判断），又提供常用成员。
  // ⚠️ 本段在模板字符串里：注释内不许出现反引号，否则会提前终止字符串。
  function netLookup(fn, u, b) {
    const sig = fn + '|' + String(u) + '|' + (b === undefined ? '' : String(b));
    if (Object.prototype.hasOwnProperty.call(NET, sig)) {
      const text = String(NET[sig]);
      const hdrs = NET[sig + '|HDR'] || {};
      const obj = {
        body: function () { return text; },
        string: function () { return text; },
        toString: function () { return text; },
        // legado 的 header 是函数：header("location") 取响应头
        header: function (name) {
          if (name === undefined) return '';
          const k = String(name).toLowerCase();
          return Object.prototype.hasOwnProperty.call(hdrs, k) ? String(hdrs[k]) : '';
        },
        headers: function (name) { return obj.header(name); },
        statusCode: 200,
        url: String(u),
        valueOf: function () { return text; },
      };
      obj[Symbol.toPrimitive] = function () { return text; };
      return obj;
    }
    needsNetwork(fn);
  }

  globalThis.__vars = Object.create(null);
  globalThis.__logs = [];

  globalThis.java = {
    put: function (k, v) { __vars[String(k)] = v; },
    get: function (k) { return __vars[String(k)]; },
    log: function (m) { __logs.push(String(m)); },
    toast: function () {},
    longToast: function () {},
    sleep: function () {},
    md5Encode: function (s) { return lookup('md5Encode', String(s)); },
    md5Encode16: function (s) { return lookup('md5Encode16', String(s)); },
    sha256Encode: function (s) { return lookup('sha256Encode', String(s)); },
    encodeURI: function (s) { return lookup('encodeURI', String(s)); },
    encodeURIComponent: function (s) { return lookup('encodeURIComponent', String(s)); },
    base64Encode: function (s) { return lookup('base64Encode', String(s)); },
    base64Decode: function (s) { return lookup('base64Decode', String(s)); },
    HMacHex: function (s, k) { return lookup('HMacHex', String(s), String(k)); },
    desEncodeToBase64String: function (d, k) { return lookup('desEncodeToBase64String', String(d), String(k)); },
    randomUUID: function () { return P.uuid; },
    // ── 受限网络（2026-10-31）──────────────────────────────────────────────
    // 宿主已把这些调用的响应预取进 NET 表（见 precomputeNetworkResults）。
    // 沙箱内只查表，**没有任何真实网络能力** —— 隔离边界没有放松。
    // 查不到（URL 由拼串动态生成、跨站、或请求失败）→ 仍走 NEEDS_NETWORK 降级为 skip。
    ajax: function (u) { return netLookup('ajax', u); },
    ajaxAll: function (u) { return netLookup('ajax', u); },
    post: function (u, b) { return netLookup('post', u, b); },
    // ⚠️ java.get 在 legado 里是**双语义**，实测两类源都在用：
    //   ① java.get('key')        → 读 java.put 存进 __vars 的变量（大量源靠这个传参）
    //   ② java.get('https://…')  → 发 GET 请求，返回响应对象
    // 这里必须同时支持，否则会打破 ①（早期版本就因为同名覆盖挂了 18 个用例）。
    // 分派依据：首字符是 http(s) / 双斜杠 / 单斜杠，就当 URL，其余当变量名。
    // ⚠️ 本段在模板字符串里：正则里不能写 \/ 这类会破坏字符串的转义。
    //     改用 String.charAt 判断前几个字符，绕开转义问题。
    get: function (u, b) {
      const s = String(u);
      const isUrl = ((s.charCodeAt(0) === 104 && s.charCodeAt(1) === 116)     // 'ht'  (http)
                  || (s.charCodeAt(0) === 47 && s.charCodeAt(1) === 47)        // '//'
                  || s.charCodeAt(0) === 47);                                  // '/'
      if (isUrl || arguments.length > 1) return netLookup('get', s, b);
      return __vars[s];
    },
    connect: function () { needsNetwork('connect'); },
    net: function () { needsNetwork('net'); },
    webView: function () { unimplemented('webView'); },
    getWebViewUA: function () { unimplemented('getWebViewUA'); },
    androidId: function () { unimplemented('androidId'); },
  };

  globalThis.source = {
    key: P.base,
    getKey: function () { return P.base; },
    header: P.header,
    getVariable: function () { return ''; },
    setVariable: function () {},
    loginUrl: P.loginUrl,
  };

  globalThis.cookie = {
    removeCookie: function () {},
    getCookie: function () { return ''; },
    setCookie: function () {},
    getKey: function () { return P.base; },
  };

  globalThis.key = P.key;
  globalThis.page = P.page;
  globalThis.result = P.result;
  globalThis.baseUrl = P.base;
  globalThis.baseUri = P.base;
  globalThis.url = P.base;
  globalThis.md5Encode = function (s) { return lookup('md5Encode', String(s)); };
  globalThis.base64Encode = function (s) { return lookup('base64Encode', String(s)); };
})();
`;
}

/**
 * 求值一次 searchUrl 的 JS 部分。
 * @returns {{ok:true,url:string} | {ok:false,skip:string}}
 */
function evaluateSearchJs(opts) {
    const su = String(opts.su || '');
    const base = String(opts.base || '');
    const key = String(opts.key || '');
    const page = opts.page === undefined ? 1 : opts.page;
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const gbkEncode =
        typeof opts.gbkEncode === 'function' ? opts.gbkEncode : (s) => encodeURIComponent(String(s));

    const { code, suffix } = extractJs(su);
    if (!code.trim()) return { ok: false, skip: 'JS脚本为空' };

    const staticPrefix = extractStaticPrefix(su);
    const fillStatic = (tpl) =>
        String(tpl)
            .replace(/\{\{key\}\}|\{key\}/g, key)
            .replace(/\{\{page\}\}|\{page\}/g, String(page));

    // 预取受限网络的响应（只允许同源、只 GET/POST、有超时与体积上限）
    const netRes = precomputeNetworkResults(code, { base, key, page });
    if (netRes.fetched || netRes.blocked) {
        log('[net] 预取 ' + netRes.fetched + ' 个 / 拒绝或失败 ' + netRes.blocked + ' 个');
    }

    // 纯 JSON 常量：字符串、数字、对象 —— 没有任何宿主函数
    const pure = {
        key,
        page,
        base,
        header: opts.header === undefined ? '' : String(opts.header),
        loginUrl: opts.loginUrl === undefined ? '' : String(opts.loginUrl),
        result: fillStatic(staticPrefix === '' ? suffix : staticPrefix + suffix),
        uuid: crypto.randomUUID(),
        toolTable: precomputeToolResults(code, key, gbkEncode),
        netTable: netRes.table,
    };

    let ctx;
    let out;
    try {
        ctx = vm.createContext(Object.create(null), {
            codeGeneration: { strings: true, wasm: false },
        });
        vm.runInContext(bootstrapSource(pure), ctx, { timeout: EVAL_TIMEOUT_MS, filename: 'legado-bootstrap.js' });
        out = vm.runInContext(code, ctx, { timeout: EVAL_TIMEOUT_MS, filename: 'legado-search.js' });
        try {
            const logs = vm.runInContext('JSON.stringify(__logs)', ctx, { timeout: 200 });
            for (const line of JSON.parse(logs)) log(line);
        } catch { /* 日志收集失败不影响求值 */ }
    } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e);
        if (/timed out|Script execution timed out/i.test(msg)) return { ok: false, skip: 'JS求值超时' };
        if (/NEEDS_NETWORK:/.test(msg)) {
            const api = msg.split('NEEDS_NETWORK:')[1] || '';
            return { ok: false, skip: 'JS需要联网(java.' + api.replace(/[^a-zA-Z]/g, '') + ')' };
        }
        const unim = /UNIMPLEMENTED_JAVA:(\w+)/.exec(msg);
        if (unim) return { ok: false, skip: '未实现的 java.' + unim[1] };
        const notPre = /TOOL_NOT_PRECOMPUTED:(\w+)/.exec(msg);
        if (notPre) return { ok: false, skip: 'JS工具调用无法预计算(' + notPre[1] + ')' };
        if (/process is not defined|require is not defined|Buffer is not defined|global is not defined/i.test(msg)) {
            return { ok: false, skip: 'JS越界被拒(沙箱无宿主对象)' };
        }
        return { ok: false, skip: 'JS求值失败: ' + msg.slice(0, 60) };
    }

    // 结果优先级（对齐 legado）：java.put('url') > 返回值 > 静态后缀
    let vars = {};
    try {
        vars = JSON.parse(vm.runInContext('JSON.stringify(__vars)', ctx, { timeout: 200 }));
    } catch { vars = {}; }

    const putUrl = vars.url;
    const filled = (t) =>
        String(t)
            .replace(/\{\{key\}\}|\{key\}/g, vars.key === undefined ? key : String(vars.key))
            .replace(/\{\{page\}\}|\{page\}/g, vars.page === undefined ? String(page) : String(vars.page));

    if (typeof putUrl === 'string' && putUrl.trim() !== '') {
        return { ok: true, url: filled(putUrl.trim() + suffix) };
    }
    if (out === undefined || out === null) {
        if (!suffix) return { ok: false, skip: 'JS无返回值且无静态后缀' };
        return { ok: true, url: filled(suffix) };
    }
    const text = String(out).trim();
    if (!text) return { ok: false, skip: 'JS返回空字符串' };
    return { ok: true, url: suffix ? text + suffix : text };
}

module.exports = {
    isJsSearchUrl,
    extractJs,
    extractStaticPrefix,
    precomputeToolResults,
    evaluateSearchJs,
    EVAL_TIMEOUT_MS,
};

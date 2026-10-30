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
 * 生成沙箱 bootstrap 代码。所有对象与函数都在沙箱内部创建；
 * `__PURE` 只来自 JSON.stringify，宿主函数/闭包/原型一律进不来。
 */
function bootstrapSource(pure) {
    return `
(function () {
  const P = ${JSON.stringify(pure)};
  const TABLE = P.toolTable;

  function unimplemented(name) { throw new Error('UNIMPLEMENTED_JAVA:' + name); }
  function needsNetwork(name) { throw new Error('NEEDS_NETWORK:' + name); }
  function lookup(name, a, b) {
    const sig = name + '|' + a + '|' + (b === undefined ? '' : b);
    if (Object.prototype.hasOwnProperty.call(TABLE, sig)) return TABLE[sig];
    throw new Error('TOOL_NOT_PRECOMPUTED:' + name);
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
    ajax: function () { needsNetwork('ajax'); },
    ajaxAll: function () { needsNetwork('ajaxAll'); },
    post: function () { needsNetwork('post'); },
    get: function () { needsNetwork('get'); },
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

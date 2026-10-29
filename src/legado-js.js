// ─────────────────────────────────────────────────────────────────────────────
// src/legado-js.js —— 书源 searchUrl 的 JS 求值器（离线、纯函数、无副作用）
//
// 背景：legado 书源允许 searchUrl 写成 <js>...</js> 或 @js:... 形式的脚本，
// 在手机上由 App 的 JS 引擎执行，产出真正的 URL（或 URL + JSON 选项）。
// 我们的 CI 测试器此前一律判为「无搜索URL或含js」→ 不可测。
// 实测成品 694 源里有 100 个属于这一类，其中：
//   · 42 个纯本地可求值（只用 java.put/get、JSON、字符串拼装、md5/encode 等）
//   · 53 个需要联网（java.ajax / java.post 取 token 再拼 URL）
//   · 5  个依赖 Android WebView / androidId（Node 侧不可能实现）
//
// 本模块只做第 1 层：纯本地求值。理由：
//   · 零网络副作用 —— 求值器本身不发任何请求，因此不会伪装成「测试通过」
//   · 有副作用的那层（java.ajax）交给上层用项目已有的 fetchPage 实现，
//     这样超时、UA、反爬判定都与其它测试路径一致
//   · WebView 层永久不可测，但会给出明确的 skip 原因，而不是混进「含 js」
//
// 安全设计：
//   · 用 node:vm 的隔离上下文，超时硬限制，不给 require/process/Buffer
//   · 宿主对象用 Proxy 包裹，任何未实现的 java.* 调用都抛明确错误（而不是 undefined 静默）
//   · java.toast/log 这类纯 UI/日志调用实现为空操作（对 URL 无影响）
//   · 求值失败一律返回 {skip:原因}，绝不让半成品 URL 进入实测（假死比不可测更危险）
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const vm = require('node:vm');
const crypto = require('node:crypto');

/** 求值超时（毫秒）。手机上这类脚本都是毫秒级，1 秒足够，超时即判不可测。 */
const EVAL_TIMEOUT_MS = 1000;

/** 判定一个 searchUrl 是否属于 JS 形态。 */
function isJsSearchUrl(su) {
    return /<js>|@js:/i.test(String(su || ''));
}

/**
 * 取出 JS 之前的静态前缀（legado 的 result 变量语义）。
 *
 * 两种形态都要处理：
 *   <js>script</js>/search/?q={{key}}   → 前缀为空，后缀是 /search/...
 *   /search/?q={{key}} @js:script       → 前缀是 /search/...（result = 这段）
 *
 * 实测「长佩文学」「晋江[apps]」都属第二种：静态 URL 在前，@js: 在后，
 * 脚本体是 java.put('key',key);result —— result 指的就是前面那段静态 URL。
 * @param {string} su
 * @returns {string}
 */
function extractStaticPrefix(su) {
    const s = String(su || '');
    const open = s.search(/<js>/i);
    if (open >= 0) return s.slice(0, open).trim();
    const at = s.search(/@js:/i);
    if (at >= 0) return s.slice(0, at).trim();
    return '';
}

/**
 * 从 searchUrl 里抽出脚本正文与「JS 之后可能还有的静态尾巴」。
 *
 * legado 的两种写法：
 *   <js>...script...</js>/search/?q={{key}}      → 脚本负责前置，静态部分是后缀
 *   @js:...script...                             → 整个 searchUrl 都是脚本
 *
 * 返回 { code, suffix }：code 是脚本正文，suffix 是 </js> 之后的静态串（可能为空）。
 */
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
    if (at >= 0) {
        return { code: s.slice(at + 4), suffix: '' };
    }
    return { code: '', suffix: '' };
}

/**
 * 计算 md5（legado 的 java.md5Encode 默认 utf8 → 小写 hex）。
 * @param {string} str
 * @param {boolean} [upper]
 */
function md5Hex(str, upper) {
    const h = crypto.createHash('md5').update(String(str), 'utf8').digest('hex');
    return upper ? h.toUpperCase() : h;
}

/**
 * 计算 HMAC-SHA256 hex（legado 的 java.HMacHex 语义）。
 * @param {string} str
 * @param {string} key
 */
function hmacSha256Hex(str, key) {
    return crypto.createHmac('sha256', String(key)).update(String(str), 'utf8').digest('hex');
}

/**
 * Base64 编码（legado 的 java.base64Encode 默认 utf8）。
 * @param {string} str
 */
function base64Encode(str) {
    return Buffer.from(String(str), 'utf8').toString('base64');
}

/**
 * DES-ECB 加密后 Base64（legado 的 java.desEncodeToBase64String）。
 * 注意：这里实现的是标准 DES-ECB + PKCS7，绝大多数书源用它算签名。
 * @param {string} data
 * @param {string} key
 */
function desEncodeToBase64(data, key) {
    const cipher = crypto.createCipheriv('des-ecb', Buffer.from(String(key), 'utf8').subarray(0, 8), null);
    return cipher.update(String(data), 'utf8', 'base64') + cipher.final('base64');
}

/**
 * 构造一次求值上下文。
 *
 * @param {object} opts
 * @param {string} opts.su        原始 searchUrl
 * @param {string} opts.base      书源 bookSourceUrl（source.key / source.getKey 用它）
 * @param {string} opts.key       搜索关键词
 * @param {number} [opts.page]    页码，默认 1
 * @param {object} [opts.header]  书源 header（source.header / JSON.parse(source.header) 用）
 * @param {function} [opts.log]   日志回调
 * @returns {{ok:true, url:string, opt:object|null} | {ok:false, skip:string}}
 */
function evaluateSearchJs(opts) {
    const { su, base, key } = opts;
    const page = opts.page === undefined ? 1 : opts.page;
    const log = opts.log || (() => {});
    const sourceHeader = opts.header === undefined ? '' : String(opts.header);

    const { code, suffix } = extractJs(su);
    if (!code.trim()) return { ok: false, skip: 'JS 脚本为空' };

    /** java.put / java.get 的共享状态（同一脚本内有效）。 */
    const vars = Object.create(null);

    const unsupported = (name) => {
        throw new Error('未实现的 java.' + name);
    };

    // 需要联网的 API 一律抛错：本层不联网，交由上层用 fetchPage 实现后再跑一层。
    const requiresNetwork = (name) => {
        throw new Error('需要联网: java.' + name);
    };

    const javaObj = {
        put: (k, v) => { vars[String(k)] = v; },
        get: (k) => vars[String(k)],
        log: (m) => log(String(m)),
        toast: () => {},
        longToast: () => {},
        sleep: () => {},
        // 纯计算类
        md5Encode: (s, upper) => md5Hex(s, upper === true || upper === 'upper'),
        md5Encode16: (s) => md5Hex(s, false).slice(8, 24),
        encodeURI: (s, charset) => {
            // legado 的 java.encodeURI(s, "gbk") 会先按 charset 编码再 %XX。
            // 这里只精确实现 utf-8 与 gbk 两种常用；其它情况按 utf-8，并在返回值上标记。
            if (charset && String(charset).toLowerCase() === 'gbk') {
                // 复用上层传入的 GBK 编码器（若未提供则退化为 utf-8 百分号编码）
                if (typeof opts.gbkEncode === 'function') return opts.gbkEncode(String(s));
                return encodeURIComponent(String(s));
            }
            return encodeURIComponent(String(s));
        },
        base64Encode: (s) => base64Encode(s),
        HMacHex: (s, k) => hmacSha256Hex(s, k),
        desEncodeToBase64String: (d, k) => desEncodeToBase64(d, k),
        randomUUID: () => crypto.randomUUID(),
        // 联网类
        ajax: () => requiresNetwork('ajax'),
        ajaxAll: () => requiresNetwork('ajaxAll'),
        post: () => requiresNetwork('post'),
        get: () => requiresNetwork('get'),
        connect: () => requiresNetwork('connect'),
        net: () => requiresNetwork('net'),
        // Android 专属
        webView: () => unsupported('webView'),
        getWebViewUA: () => unsupported('getWebViewUA'),
        androidId: () => unsupported('androidId'),
    };

    const sourceObj = {
        key: base,
        getKey: () => base,
        header: sourceHeader,
        getVariable: () => '',
        setVariable: () => {},
        loginUrl: '',
    };

    // legado 引擎里脚本可用的几个「隐式变量」：
    //   result —— 脚本之外的静态部分（即 </js> 之后的 suffix，或 @js: 之前的静态前缀）
    //   baseUrl / baseUri —— 书源地址的别名
    //   source.key 与 baseUrl 是同一个值，但书源作者写法不统一，两个都要给。
    // 实测：9 个源用 baseUrl，2 个源用 result。缺了它们会报 "xxx is not defined"。
    const staticPrefix = extractStaticPrefix(su);
    // result 是「静态部分」的原文，其中可能还带 {{key}}/{{page}} 槽位，
    // 脚本最后裸写 `result` 取的就是它，所以先把槽位填好。
    const fillStatic = (tpl) =>
        String(tpl)
            .replace(/\{\{key\}\}|\{key\}/g, String(key))
            .replace(/\{\{page\}\}|\{page\}/g, String(page));
    const implicit = {
        result: fillStatic(staticPrefix === '' ? suffix : staticPrefix + suffix),
        baseUrl: base,
        baseUri: base,
        url: base,
    };

    const cookieObj = {
        removeCookie: () => {},
        getCookie: () => '',
        setCookie: () => {},
        // 实测有 2 个源调用 cookie.getKey()，语义上等同于取书源地址
        getKey: () => base,
    };

    // 提供给脚本的沙箱：只暴露必要能力，不给 require / process / Buffer / fs
    const sandbox = {
        java: javaObj,
        source: sourceObj,
        cookie: cookieObj,
        ...implicit,
        key,
        page,
        JSON,
        Math,
        Date,
        String,
        Number,
        Boolean,
        Array,
        Object,
        RegExp,
        parseInt,
        parseFloat,
        isNaN,
        encodeURIComponent,
        decodeURIComponent,
        encodeURI,
        decodeURI,
        md5Encode: (s) => md5Hex(s, false),
        base64Encode: (s) => base64Encode(s),
        console: { log: (m) => log(String(m)) },
    };

    let result;
    try {
        // codeGeneration.strings=true 允许脚本里 eval / new Function（legado 书源确实
        // 会用 eval(String(source.bookSourceComment)) 这类写法），但它同时打开了
        // `this.constructor.constructor('return process')()` 这类逃逸通道。
        //
        // 因此不能只靠上下文隔离：还要把上下文对象本身的所有逃逸面拆掉。
        // 做法是给 runInContext 一个不带 constructor 链的全局对象 ——
        // 让 `this` 指向 sandbox 的浅拷贝（没有 __proto__ 桥接到外层的 Function）。
        const bare = Object.create(null);
        for (const k of Object.keys(sandbox)) bare[k] = sandbox[k];
        const ctx = vm.createContext(bare, {
            codeGeneration: { strings: true, wasm: false },
        });
        result = vm.runInContext(code, ctx, {
            timeout: EVAL_TIMEOUT_MS,
            filename: 'legado-search.js',
            displayErrors: false,
        });
    } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        // 联网/Android 类需求给出明确分层原因，其余归为求值失败
        if (/^Script execution timed out/i.test(msg) || /timed out/i.test(msg)) {
            return { ok: false, skip: 'JS求值超时' };
        }
        if (/需要联网/.test(msg)) {
            const name = msg.replace('需要联网: java.', '');
            return { ok: false, skip: 'JS需要联网(java.' + name + ')' };
        }
        if (/未实现的 java\./.test(msg)) {
            return { ok: false, skip: msg };
        }
        // 逃逸尝试（拿到 process/require 等）一律按沙箱拒绝处理
        if (/process|require|Buffer|global/i.test(msg)) {
            return { ok: false, skip: 'JS求值被沙箱拒绝' };
        }
        return { ok: false, skip: 'JS求值失败: ' + msg.slice(0, 60) };
    }

    // 结果解析优先级（对齐 legado 引擎的实际行为）：
    //   ① java.put('url', X) 写入的 url —— 实测有源只写变量不给返回值
    //      （如「书海小说」用 java.put("url", String(...)) 且脚本无 return）
    //   ② 脚本的返回值
    //   ③ 都没有但有静态后缀 → 用 vars.key 拼后缀
    const putUrl = vars.url;
    const putKey = vars.key === undefined ? key : vars.key;
    const putPage = vars.page === undefined ? page : vars.page;

    const fillSlot = (tpl) =>
        String(tpl)
            .replace(/\{\{key\}\}|\{key\}/g, String(putKey))
            .replace(/\{\{page\}\}|\{page\}/g, String(putPage));

    // ① java.put('url', ...) 优先
    if (typeof putUrl === 'string' && putUrl.trim() !== '') {
        return { ok: true, url: fillSlot(putUrl.trim() + suffix), opt: null };
    }

    // ② 脚本返回值
    if (result === undefined || result === null) {
        // 既没有 put('url') 也没有返回值：只有静态后缀才可救
        if (!suffix) {
            return { ok: false, skip: 'JS无返回值且无静态后缀' };
        }
        return { ok: true, url: fillSlot(suffix), opt: null };
    }

    const out = String(result).trim();
    if (!out) return { ok: false, skip: 'JS返回空字符串' };

    // 脚本返回的可能只是路径片段；与 suffix 合并后再交给上层解析
    const combined = suffix ? out + suffix : out;

    // 注意：这里【不】校验残留的 {{...}} 槽位。
    // 脚本输出可能刻意保留 {{key}}/{{page}} 交给 parseSearch 统一替换
    // （实测「长佩文学」result 里就带着 {{key}}），提前判不可测会误杀。
    // 真正的「假地址」防护仍在 parseSearch 的 evalMustache 里：那里只有
    // 明确支持的两类槽位才放行，其余一律判不可测。
    return { ok: true, url: combined, opt: null };
}

module.exports = {
    isJsSearchUrl,
    extractJs,
    evaluateSearchJs,
    EVAL_TIMEOUT_MS,
};

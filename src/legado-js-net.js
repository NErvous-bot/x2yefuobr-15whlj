// src/legado-js-net.js —— 给 JS 求值器挂「受限同步网络」
//
// 为什么需要
//   书源里的 <js>/@js: 脚本经常用 java.ajax / java.post / java.get 去拿接口数据，
//   再拼成 searchUrl。当前求值器遇到这类一律返回 skip（JS需要联网）。
//   实测这两类占了「测不了」的大头：
//     · JS需要联网(java.ajax) 23 个
//     · bookList规则不可测 里大量是内联 <js> 先 ajax 再生成列表
//
// 为什么必须「同步」
//   legado 的 java.ajax 是同步函数（返回值直接参与字符串拼接/JSON.parse）。
//   node 的 vm.runInContext 也是同步执行 —— 在 vm 里放 async fetch 会得到 Promise，
//   与书源脚本的期望完全不符（src.searchUrl = String(java.ajax(...))）。
//   所以只能用**子进程同步调用**：execFileSync 一个 curl（或 node 的 http 小脚本），
//   把响应体同步拿回来。这是唯一既保持同步语义、又不把网络能力直接塞进 vm 的做法。
//
// 安全边界（这是本模块存在的全部意义）
//   1. 域名白名单：只允许访问**书源自己 bookSourceUrl 的 origin**。
//      防止脚本借 CI 的出口 IP 去打任意主机（SSRF / 打靶 / 扫描）。
//   2. 方法白名单：仅 GET / POST。
//   3. 超时硬上限：单请求 8s，总预算由调用方控制。
//   4. 响应体积上限：256 KB（书源的 ajax 都是拿小 JSON/页面片段，不是下大文件）。
//   5. 不开重定向到站外：最多跟随 3 跳，且每跳都重新校验 origin。
//   6. 不传任何本机凭据：不带 cookie jar、不带 proxy、不带 Authorization。
//   7. 失败一律降级为 skip，绝不抛到上层把源判死。
//
// 关掉的办法：环境变量 LEGADO_JS_NET=0（CI 里想彻底禁网时设它）。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENABLED = process.env.LEGADO_JS_NET !== '0';
const PER_REQ_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;

/** 只允许 http(s)，且必须与书源同一 origin */
function sameOriginAllowed(targetUrl, sourceOrigin) {
    let u;
    try { u = new URL(String(targetUrl)); } catch (e) { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;   // 不允许 URL 内嵌凭据
    return u.origin === sourceOrigin;
}

/** 用 curl 做一次同步请求（Windows 自带 curl，Linux CI 也有） */
function syncFetch({ url, method, headers, body, sourceOrigin }) {
    if (!ENABLED) return { ok: false, reason: 'net-disabled' };
    if (!sameOriginAllowed(url, sourceOrigin)) return { ok: false, reason: 'cross-origin-blocked' };
    const m = String(method || 'GET').toUpperCase();
    if (m !== 'GET' && m !== 'POST') return { ok: false, reason: 'method-blocked' };

    const args = [
        '-sS',                                  // 静默但保留错误
        // ⚠️ 不跟重定向（2026-10-31 实测决定）：
        //   站点常返回 302 到「相对路径」（如 Location: result/?searchid=1）。
        //   本机若装了 Clash TUN，curl -L 会把相对路径解析到 TUN 的虚拟地址
        //   （实测 0.0.0.3:80），随后 exit 7 —— 响应体虽然拿到了但文件写入失败。
        //   而且 legado 里脚本本来就会读 header("location") 自己决定下一步，
        //   替它自动跟跳反而破坏语义。所以：**只取第一跳**，把 location 交给脚本。
        '-X', m,
        '-H', 'User-Agent: Mozilla/5.0',
        // 关键：不给 curl 任何本机状态
        '--noproxy', '*',
    ];
    // 只透传少量无害 header，其余一律忽略（防止脚本塞 Host/Cookie/Auth）
    const PASS = new Set(['content-type', 'accept', 'referer', 'x-requested-with', 'accept-language']);
    if (headers && typeof headers === 'object') {
        for (const [k, v] of Object.entries(headers)) {
            if (!PASS.has(String(k).toLowerCase())) continue;
            args.push('-H', String(k) + ': ' + String(v).replace(/[\r\n]/g, ' '));
        }
    }
    if (m === 'POST') {
        const b = String(body == null ? '' : body);
        if (b.length > MAX_BODY_BYTES) return { ok: false, reason: 'body-too-large' };
        args.push('--data-binary', b);
    }

    // 把 body 写进临时文件、header 单独抓，避免 -o - 与 -D 混流
    let tmpBody = null;
    let tmpHdr = null;
    try {
        // ⚠️ 必须用 os.tmpdir()：Linux CI 下 /tmp 可用，但 Windows 本地
        //   （Git Bash 环境）传 "/tmp/x" 会被 curl 拒绝（Failed to open）。
        //   os.tmpdir() 两边都对。
        const tag = 'ljn-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
        tmpBody = path.join(os.tmpdir(), tag + '.body');
        tmpHdr = path.join(os.tmpdir(), tag + '.hdr');
        args.push('-o', tmpBody, '-D', tmpHdr);
        // ⚠️ --path-as-is 与 --globoff：
        //   · --globoff       关掉 curl 的 {} / [] 通配（书源 URL 里常有 JSON 片段）
        //   · --path-as-is    不要重排路径
        //   实测不加 globoff 时，带 %2C 的查询串会被 curl 改写/丢弃导致空响应。
        args.push('--globoff', '--path-as-is');
        args.push(url);

        // ⚠️ curl 的退出码不能当唯一判据（2026-10-31 实测）：
        //   站点 302 重定向时，若本机装了系统代理/TUN，curl 会对某一跳报
        //   exit 7（Failed to connect to 0.0.0.3:80），**但已经拿到的 body 是完整的**。
        //   之前用 execFileSync 抛异常就丢弃结果 → 大量正常响应被误判成 curl-failed。
        //   改为：spawnSync 不抛异常，只看「临时文件是否写到了内容」。
        const { spawnSync } = require('node:child_process');
        const proc = spawnSync('curl', args, {
            timeout: PER_REQ_TIMEOUT_MS + 1000,
            maxBuffer: 4096,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
            windowsHide: true,
            // 清掉所有代理环境变量：书源测试器只该直连站点，不借用户代理
            env: Object.assign({}, process.env, {
                http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '',
                all_proxy: '', ALL_PROXY: '', no_proxy: '*', NO_PROXY: '*',
            }),
        });

        const exists = fs.existsSync(tmpBody);
        const size = exists ? fs.statSync(tmpBody).size : 0;

        // ⚠️ 302/301 的空 body 是**正常成功**，不是失败（2026-10-31 实测）：
        //   书源脚本常写 java.get(url).header("location") 去拿重定向目标，
        //   这类响应 body 本来就是 0 字节。之前用「size===0 → 失败」把整批都误判了。
        //   判据改为：只要拿到了 HTTP 响应行（header 文件里有 "HTTP/1.x …"），就算成功。
        let hdrRaw = '';
        try { hdrRaw = fs.existsSync(tmpHdr) ? fs.readFileSync(tmpHdr, 'utf8') : ''; } catch (e) {}
        const gotHttp = /HTTP\/\d(\.\d)?\s+\d{3}/.test(hdrRaw);
        if (!gotHttp) {
            return { ok: false, reason: 'curl-failed(exit ' + (proc.status === null ? 'timeout' : proc.status) + ')' };
        }
        if (size > MAX_BODY_BYTES) return { ok: false, reason: 'body-too-large' };

        const text = exists ? fs.readFileSync(tmpBody, 'utf8') : '';
        // 多跳重定向会产生多段 header，取最后一段（最终响应）
        const blocks = hdrRaw.split(/\r?\n\r?\n/).filter((s) => s.trim());
        const last = blocks.length ? blocks[blocks.length - 1] : '';
        const head = Object.create(null);
        for (const line of last.split(/\r?\n/)) {
            const i = line.indexOf(':');
            if (i > 0) {
                const k = line.slice(0, i).trim().toLowerCase();
                const v = line.slice(i + 1).trim();
                if (k && k !== 'set-cookie') head[k] = v;
            }
        }
        return { ok: true, text: String(text), headers: head, finalUrl: url };
    } catch (e) {
        return { ok: false, reason: 'curl-failed' };
    } finally {
        try { if (tmpBody) fs.unlinkSync(tmpBody); } catch (e) {}
        try { if (tmpHdr) fs.unlinkSync(tmpHdr); } catch (e) {}
    }
}

/** 从书源 origin 推导出唯一允许的 origin */
function originOfSource(bookSourceUrl) {
    try { return new URL(String(bookSourceUrl)).origin; } catch (e) { return null; }
}

module.exports = { ENABLED, syncFetch, sameOriginAllowed, originOfSource, PER_REQ_TIMEOUT_MS, MAX_BODY_BYTES };

// src/search-probe.js —— 搜索参数/路径过时的自动探测（单一实现，供 CI 与本地使用）
//
// 背景（2026-10-31）：
//   站点改版时最常见的「源坏了」其实是搜索接口的参数名变了
//   （searchkey → keyword、key → q、searchValue → q ……），
//   规则本身完全正确，只是提交的参数对不上。这类源不该被判死。
//
//   实测：⭕️PO文学(po18to.com) 5/5「搜索无结果」，
//   但把 body 的 searchkey 换成 keyword 就能出 15 条结果、三关全过。
//
// 本模块只做**探测与建议**，不改成品：
//   · 输入：一个源 + 一组候选参数名
//   · 输出：{ param, count } 或 null（没有任何候选能出书）
//   是否采纳由维护流程决定（人工核对 / 后续可加自动化门禁）。
//
// 为什么不能全局替换 searchkey → keyword：
//   本仓库 689 个源里 169 个用 searchkey，其中绝大多数仍然有效 ——
//   全局替换会把好的改坏。只有「已经失败」的源才进入探测。

const KW_PARAMS = ['searchkey', 'keyword', 'key', 'q', 'wd', 'kw', 's', 'search', 'name', 'words'];

/** 把 searchUrl 拆成 { path, opt }；opt 容忍伪 JSON（单引号） */
function parseSearchUrl(su) {
    const t = String(su || '').trim();
    const cut = t.search(/,\s*[{']/);
    let path = (cut === -1 ? t : t.slice(0, cut)).trim();
    let opt = {};
    if (cut !== -1) {
        const raw = t.slice(cut + 1).trim();
        try { opt = new Function('return (' + raw.replace(/\n/g, ' ') + ')')() || {}; } catch (e) { opt = {}; }
    }
    return { path, opt };
}

/** 找出 URL/body 里当前使用的关键词参数名 */
function currentParamName(path, opt) {
    const isPost = String(opt.method || 'GET').toUpperCase() === 'POST';
    const hay = isPost ? String(opt.body || '') : String(path || '');
    const m = hay.match(/([A-Za-z_][A-Za-z0-9_]*)={{key}}/);
    return m ? m[1] : null;
}

/**
 * 探测某个源能否靠换参数名救活。
 * @param deps { fetchPage, selectAll, sleep, originOf } —— 由调用方注入（避免循环依赖）
 * @returns { param, count } | null
 */
async function probeKeywordParams(src, deps) {
    const { fetchPage, selectAll, sleep, originOf } = deps;
    const base = originOf(src.bookSourceUrl);
    if (!base) return null;
    const { path, opt } = parseSearchUrl(src.searchUrl);
    if (!path) return null;
    const isPost = String(opt.method || 'GET').toUpperCase() === 'POST';
    const charset = opt.charset || '';
    const rule = (src.ruleSearch || {}).bookList;
    if (!rule) return null;

    const kwEnc = encodeURIComponent('都市');
    const cur = currentParamName(path, opt);
    const cands = KW_PARAMS.filter((p) => p !== cur);

    for (const p of cands) {
        let url, body;
        if (isPost) {
            url = new URL(path, base).href;
            body = String(opt.body || '')
                .replace(new RegExp('([A-Za-z_][A-Za-z0-9_]*)=\\{\\{key\\}\\}'), p + '={{key}}')
                .replace('{{key}}', kwEnc);
        } else {
            const p2 = path.replace(new RegExp('([A-Za-z_][A-Za-z0-9_]*)={{key}}'), p + '={{key}}');
            url = new URL(p2.replace('{{key}}', kwEnc), base).href;
            body = undefined;
        }
        const r = await fetchPage(url, {
            method: isPost ? 'POST' : 'GET',
            body,
            headers: isPost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
            charset, ref: base,
        });
        if (r && r.status === 200) {
            const bl = selectAll(r.text, rule);
            if (bl && bl.items.length > 0) return { param: p, count: bl.items.length };
        }
        await sleep(400);
    }
    return null;
}

/** 把 searchUrl 里的关键词参数名换成新名字（不动其它选项） */
function rewriteParam(searchUrl, newParam) {
    const t = String(searchUrl || '');
    return t.replace(/([A-Za-z_][A-Za-z0-9_]*)={{key}}/g, newParam + '={{key}}');
}

module.exports = { KW_PARAMS, parseSearchUrl, currentParamName, probeKeywordParams, rewriteParam };

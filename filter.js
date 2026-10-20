// legado 书源自动维护流水线
// 流程：上游更新合并 → 域名探测 → 域名变体修复 → 阈值保护(失败保留旧版) → 写回提交
// 无任何依赖，GitHub Actions 的 Node 20 可直接运行
const fs = require('fs');
const { execSync } = require('child_process');
const { checkSource } = require('./aging-test');
// 多 UA 池：随机选，绕过部分站点的反爬 UA 黑名单（参考 tickmao AUTO_SUPPLEMENT 思路）
const UAS = [
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    'Legado/3.26 (Android 14)'
];
const pickUA = () => UAS[Math.floor(Math.random() * UAS.length)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 上游源清单（按优先级：主→备，自动降级，任一失败不影响其他）
// 1) tickmao/Novel：MIT 协议，196 源 / 98.5% 验证有效，天天维护（推荐主上游）
// 2) jiwangyihao/source-j-legado：MIT，655 stars，轻小说/二次元专项，每个网站一个 JSON
//    （注：fqweb.json 是自建服务器模板，不可直接用，故未加入）
// 3) shidahuilang/shuyuan-bak：GPL-3.0，3373 源大体量，含番茄镜像（备上游，体量补充）
const UPSTREAMS = [
    'https://cdn.jsdelivr.net/gh/tickmao/Novel@master/sources/legado/full.json',
    // jiwangyihao 源集（轻小说/二次元专项）
    'https://cdn.jsdelivr.net/gh/jiwangyihao/source-j-legado@master/bilinovel.json',
    'https://cdn.jsdelivr.net/gh/jiwangyihao/source-j-legado@master/bilinovel-like.json',
    'https://cdn.jsdelivr.net/gh/jiwangyihao/source-j-legado@master/esjzone.json',
    'https://cdn.jsdelivr.net/gh/jiwangyihao/source-j-legado@master/fishhawk.json',
    'https://cdn.jsdelivr.net/gh/jiwangyihao/source-j-legado@master/lk-lightnovel-us.json',
    'https://cdn.jsdelivr.net/gh/jiwangyihao/source-j-legado@master/masiro.json',
    'https://cdn.jsdelivr.net/gh/jiwangyihao/source-j-legado@master/rezero.json',
    'https://cdn.jsdelivr.net/gh/jiwangyihao/source-j-legado@master/wenku.json',
    'https://cdn.jsdelivr.net/gh/jiwangyihao/source-j-legado@master/zaimanhua.json',  // 漫画→被BAD过滤
    'https://raw.githubusercontent.com/shidahuilang/shuyuan-bak/main/good.json',
    // 4) aoaostar/legado：AGPL-3.0 社区共享书源站（6612星，每日更新，3900源/20MB全量）
    //    与本地重叠约104个，主要价值=给扩容池补 ~3600 个候选长尾源（仍按扩容闸门实测筛选）
    'https://raw.githubusercontent.com/aoaostar/legado/master/sources/b778fe6b.json'
];

function norm(u) {
    try { const x = new URL(String(u).split('#')[0]); return x.origin + x.pathname.replace(/\/$/, ''); }
    catch (e) { return null; }
}
function originOf(u) {
    try { return new URL(String(u).split('#')[0]).origin; } catch (e) { return null; }
}

// ── D3（Round3 补测 2026-10-20）URL 规范化：只做两类静态可确认等价的收敛 ──
// 收紧原则：宁可保留也不制造新书源故障。
//  1) 纯根路径重复斜杠（pathname 全为斜杠且 ≥2 个，如 https://x//）→ 收敛为单斜杠；
//     非根路径中的 //（/a//b）一律原样保留，仅记录到报告
//  2) query 仅由"已验证可忽略参数白名单"中的参数构成时才去除；含任何未知参数一律保留
//  #fragment 永远原样保留（同源不同规则的变体源靠它区分，是既有身份语义）
// 同规则副本另见 verify-product.js（硬断言），改动需两处同步
const CANON_TRACKING_PARAMS = {
    // 腾讯系分发渠道标记：取数走独立 searchUrl，baseUrl 上的该参数不参与请求；
    // 且全链路身份函数 norm（filter/health/score/fuse/recheck）本就忽略 query
    g_f: '腾讯分发渠道标记；搜索走独立searchUrl，全链路norm本就忽略query'
};
function canonicalizeUrl(raw) {
    const s0 = String(raw || '');
    const hi = s0.indexOf('#');
    let head = hi >= 0 ? s0.slice(0, hi) : s0;
    const frag = hi >= 0 ? s0.slice(hi) : '';
    const notes = [];
    let u;
    try { u = new URL(head); } catch (e) { return { url: s0, changed: false, notes: ['invalid-url-kept'] }; }
    if (/^\/\/+$/.test(u.pathname)) {
        head = head.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)\/{2,}/i, '$1/');
        notes.push('root-multislash-collapsed');
    } else if (/\/\//.test(u.pathname)) {
        notes.push('non-root-double-slash-kept');
    }
    if (u.search) {
        const keys = [...u.searchParams.keys()];
        if (keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(CANON_TRACKING_PARAMS, k))) {
            head = head.replace(/\?[^#]*$/, '');
            notes.push('dropped-verified-tracking:' + keys.join(','));
        } else {
            notes.push('query-has-unverified-param-kept');
        }
    }
    const url = head + frag;
    return { url, changed: url !== s0, notes };
}

async function get(u, ms, fixedUA) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms || 12000);
    try {
        const r = await fetch(u, { headers: { 'User-Agent': fixedUA || pickUA() }, signal: c.signal, redirect: 'follow' });
        clearTimeout(t); return r;
    } catch (e) { clearTimeout(t); return null; }
}

// 探活：超时/403 自动换 UA 重试 1 次（参考 tickmao 错误分类重试思路）
async function alive(o) {
    let r = await get(o, 12000);
    // 超时：换 UA 重试（部分站点首次握手慢或 UA 黑名单）
    if (!r) { await sleep(2000); r = await get(o, 12000); }
    if (!r) return false;
    // 5xx：服务器问题，放弃
    if (r.status >= 500) return false;
    // 404/410：死链，放弃
    if (r.status === 404 || r.status === 410) return false;
    // 403：可能反爬 UA 黑名单，换 UA 重试 1 次
    if (r.status === 403) {
        await sleep(3000);
        r = await get(o, 12000);
        if (!r || r.status >= 500 || r.status === 404 || r.status === 410) return false;
    }
    return true;
}

// 真实搜索实测：域名活着 ≠ 规则能用（盗版站常见首页正常、搜索接口已废）。
// 返回三态：true=明确可用 / false=明确不可用 / 'skip'=无法判断（POST/无{{key}}/URL异常/请求异常）。
// 扩容池只收 true，skip 进入隔离候选不误删但也不批量引入。
async function usable(s) {
    try {
        const su = String(s.searchUrl || '');
        if (/POST/i.test(su) || (su.indexOf('{{key}}') === -1 && su.indexOf('{key}') === -1)) return 'skip';
        const cut = su.indexOf(',');
        const path = (cut === -1 ? su : su.slice(0, cut))
            .replace(/\{\{key\}\}|\{key\}/g, encodeURIComponent('都市'))
            .replace(/\{\{page\}\}|\{page\}/g, '1');
        const base = originOf(s.bookSourceUrl);
        if (!base) return 'skip';
        const r = await get(new URL(path, base).href, 15000);
        if (!r || !r.ok) return false;
        const t = await r.text();
        return t.length > 500;
    } catch (e) {
        return 'skip'; // 实测器自身异常 → 无法判断，交给域名探活层
    }
}

async function pool(items, n, fn) {
    const ret = []; let i = 0;
    async function w() { while (i < items.length) { const k = i++; ret[k] = await fn(items[k], k); } }
    await Promise.all(Array.from({ length: n }, w));
    return ret;
}

async function upstreamMap() {
    const merged = new Map();
    let success = 0;
    for (const url of UPSTREAMS) {
        try {
            const tag = url.includes('tickmao') ? '[主]' : '[备]';
            console.log('拉取上游 ' + tag + ': ' + url.slice(0, 65) + '...');
            const r = await get(url, 60000);
            if (!r || !r.ok) throw new Error('HTTP ' + (r ? r.status : 'fail'));
            const arr = JSON.parse(await r.text());
            let added = 0;
            for (const s of arr) {
                const k = norm(s.bookSourceUrl);
                if (k && !merged.has(k)) { merged.set(k, s); added++; }
            }
            console.log('  → 原始 ' + arr.length + ' / 合并新增 ' + added);
            success++;
        } catch (e) {
            console.log('  ✗ 上游失败（不影响其他）: ' + e.message);
        }
    }
    if (success === 0) {
        console.log('⚠️ 所有上游均失败（不影响本次保活）');
        return null;
    }
    console.log('合并上游共 ' + merged.size + ' 个源');
    return merged;
}

// 死域名的变体：换协议(http/https)、加/去 www —— 盗版站最常见的"搬家"方式
// https 源只迁 https（禁止降级到明文），http 源优先迁 https（借机升级协议）
function variants(o) {
    const u = new URL(o);
    const h = u.hostname.replace(/^www\./, '');
    const protos = u.protocol === 'https:' ? ['https:'] : ['https:', 'http:'];
    const out = [];
    for (const p of protos) for (const n of [h, 'www.' + h]) {
        const v = p + '//' + n;
        if (v !== o) out.push(v);
    }
    return out;
}

(async () => {
    const file = 'legado.json';
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    let merged = 0, repaired = 0;

    // Phase B-1 基线：读 HEAD legado.json 做 diff，供删除清单和 fuse.js 裁决使用
    let oldLegado = [], oldKeys = new Set();
    try {
        oldLegado = JSON.parse(execSync('git show HEAD:legado.json', { maxBuffer: 64e6 }).toString());
        oldKeys = new Set(oldLegado.map(s => norm(s.bookSourceUrl)).filter(Boolean));
    } catch (_) { /* 首次运行无基线，保持空 */ }
    const deletionManifest = {};  // key=norm(url), value={name, reason, evidence}

    // 1) 上游合并：同名源取 lastUpdateTime 更新的版本（作者修复的规则自动进来）
    //    自研源（如番茄镜像）跳过合并，防止自定义 weight/规则被上游覆盖
    const isOwn = s => /taijiwang/.test(s.bookSourceUrl || '');
    const up = await upstreamMap();
    if (up) {
        for (const s of list) {
            if (isOwn(s)) continue;
            const u = up.get(norm(s.bookSourceUrl));
            if (u && (u.lastUpdateTime || 0) > (s.lastUpdateTime || 0)) { delete s.lastUsableCheck; Object.assign(s, u); merged++; }
        }
        console.log('上游合并更新 ' + merged + ' 个源');
    }

    // 2) 域名探测
    const origins = [...new Set(list.map(s => originOf(s.bookSourceUrl)).filter(Boolean))];
    console.log('探测 ' + origins.length + ' 个域名...');
    const dead = new Set(
        (await pool(origins, 12, o => alive(o).then(a => [o, a]))).filter(x => !x[1]).map(x => x[0])
    );

    // 3) 修复尝试：死域名逐个试变体，任何一个活着就整体迁移过去
    for (const d of [...dead]) {
        for (const v of variants(d)) {
            if (await alive(v)) {
                for (const s of list) {
                    if (originOf(s.bookSourceUrl) === d) {
                        s.bookSourceUrl = String(s.bookSourceUrl).split(d).join(v);
                        if (s.searchUrl) s.searchUrl = String(s.searchUrl).split(d).join(v);
                        s.lastUpdateTime = Date.now();
                    }
                }
                dead.delete(d); repaired++;
                console.log('修复: ' + d + ' → ' + v);
                break;
            }
        }
    }

    // Phase B-1: 记录域名探活剔除（probe-dead）
    for (const s of list) {
        if (dead.has(originOf(s.bookSourceUrl))) {
            const k = norm(s.bookSourceUrl);
            if (k) deletionManifest[k] = { name: s.bookSourceName || '', reason: 'probe-dead', evidence: 'domain dead: ' + originOf(s.bookSourceUrl) };
        }
    }
    let out = list.filter(s => !dead.has(originOf(s.bookSourceUrl)));
    const removed = list.length - out.length;
    console.log('存活 ' + out.length + ' / ' + list.length + '，剔除 ' + removed + ' 个');
    if (dead.size) console.log('最终死域名:\n' + [...dead].join('\n'));

    // 3.1) 老化剔除·先实测再删：>365天未更新 ≈ 作者弃坑（盗版站规则寿命普遍不到半年）。
    //      名单内最老 8% 且 90 天未实测的源，先做三关真实实测：
    //      ①搜索"都市"出书 ②目录≥1章 ③第一章正文≥200字。
    //      全过 → 豁免保留（90天免复测）；任一关确定坏 → 剔除；
    //      规则不可测（js/XPath等）或网络失败 → 豁免不误删，由域名探活层兜底真死源。
    //      活跃度（≤45天有更新）仅记日志，不影响去留。上游合并刷新过的源清掉复测标记。
    //      30% 阈值闸门只管探活死（防网络抖动误判），老化剔除单独限额不占闸门。
    const NOW = Date.now();
    const AGED = 365 * 864e5, AGED_CAP = 0.08, RETEST = 90 * 864e5;
    const agedList = out.filter(s => NOW - (s.lastUpdateTime || 0) > AGED)
                        .sort((a, b) => (a.lastUpdateTime || 0) - (b.lastUpdateTime || 0));
    const agedCand = agedList.filter(s => NOW - (s.lastUsableCheck || 0) > RETEST)
                             .slice(0, Math.floor(out.length * AGED_CAP));
    let agedRemoved = 0, agedExempt = 0, actCnt = 0, staleCnt = 0, skipCnt = 0;
    if (agedCand.length) {
        console.log('老化复测 ' + agedCand.length + ' 个（>365天未更新，先实测再删：搜索→目录→正文）');
        const results = await pool(agedCand, 8, s => checkSource(s).then(r => [s, r]));
        const kill = new Set();
        for (const [s, r] of results) {
            const nm = ((s.bookSourceName || '') + ' ' + s.bookSourceUrl).slice(0, 60);
            s.lastUsableCheck = NOW;
            if (r.usable === true) {
                agedExempt++;
                if (r.activity === '活跃') actCnt++; else if (r.activity === '停滞') staleCnt++;
                console.log('  ✓ 豁免[' + r.activity + '·' + r.chapters + '章·正文' + r.contentLen + '字] ' + nm);
            } else if (r.usable === 'skip') {
                agedExempt++; skipCnt++;
                console.log('  - 不可测豁免[' + r.reason + '] ' + nm);
            } else {
                const k = norm(s.bookSourceUrl);
                kill.add(k); agedRemoved++;
                deletionManifest[k] = { name: s.bookSourceName || '', reason: 'aging-failed', evidence: r.reason || '三关实测失败' };
                console.log('  ✗ 实测剔除[' + r.reason + '] ' + nm);
            }
        }
        if (agedRemoved) out = out.filter(s => !kill.has(norm(s.bookSourceUrl)));
        console.log('老化复测: 豁免 ' + agedExempt + '（活跃 ' + actCnt + ' / 停滞 ' + staleCnt + ' / 未知 ' + (agedExempt - actCnt - staleCnt - skipCnt) + ' / 不可测 ' + skipCnt + '）剔除 ' + agedRemoved + '（名单余 ' + (agedList.length - agedRemoved) + ' 个后续轮次继续）');
    }

    // 3.5) 自动扩容：从上游实时筛一小批新源（硬过滤 → 探活 → 每轮最多15个，宁缺毋滥）
    let added = 0;
    // 3.6) 广撒网筛番茄镜像：从所有上游专挑番茄相关源，单独探活（最多10个）
    let fanqieAdded = 0;
    if (up) {
        const BAD = /manhua|comic|漫画|有声|听书|audio|qidian\.com|起点|sex|nsfw|成人|18plus/i;
        const FANQIE_HINT = /fanqie|番茄|fanqienovel|taohua|39xs|tomato|fq\.|fq-/i;
        const have = new Set(out.map(s => norm(s.bookSourceUrl)));

        // 通用扩容池
        const cand = [];
        const fanqieCand = [];
        for (const s of up.values()) {
            const k = norm(s.bookSourceUrl);
            if (!k || have.has(k) || !s.searchUrl) continue;
            const tag = (s.bookSourceName || '') + ' ' + (s.bookSourceUrl || '') + ' ' + (s.bookSourceGroup || '');
            if (BAD.test(tag)) continue;
            if (FANQIE_HINT.test(tag)) {
                // 番茄相关源只走探活过 + 至少有个像样的 searchUrl
                fanqieCand.push(s);
            } else {
                cand.push(s);
            }
        }

        // 通用：优先上游最近更新的，探活+搜索实测各一道，前 60 个候选
        cand.sort((a, b) => (b.lastUpdateTime || 0) - (a.lastUpdateTime || 0));
        const ok = (await pool(cand.slice(0, 60), 10,
            s => alive(originOf(s.bookSourceUrl)).then(a => a && usable(s).then(u => u === true ? s : null)).catch(() => null))).filter(Boolean);
        for (const s of ok.slice(0, 15)) { out.push(s); added++; }
        console.log('扩容: 候选 ' + cand.length + ' / 探活+实测明确可用 ' + ok.length + ' / 新增 ' + added);

        // 番茄专项：广撒网，每个候选单独探活（不批量并发避免触反爬）
        // 优先级：_validation_status === 'valid' > 最近更新 > 默认
        fanqieCand.sort((a, b) => {
            const va = (a._validation_status === 'valid') ? 1 : 0;
            const vb = (b._validation_status === 'valid') ? 1 : 0;
            if (va !== vb) return vb - va;
            return (b.lastUpdateTime || 0) - (a.lastUpdateTime || 0);
        });
        let fanqieProbed = 0;
        for (const s of fanqieCand.slice(0, 30)) {
            if (!await alive(originOf(s.bookSourceUrl))) continue;
            if (await usable(s) !== true) continue;
            // 已存在的跳过
            if (out.some(x => norm(x.bookSourceUrl) === norm(s.bookSourceUrl))) continue;
            out.push(s); fanqieAdded++; fanqieProbed++;
            if (fanqieAdded >= 10) break; // 番茄兜底每轮最多新增 10 个
        }
        console.log('番茄广撒网: 候选 ' + fanqieCand.length + ' / 新增 ' + fanqieAdded);
    }

    // 3.8) URL 规范化 + 安全去重（D3，Round3 补测）
    //      仅合并"规范化后完整 URL 相同"的条目；规范后仍不同（www 变体/#fragment 变体等）
    //      一律保留并写报告。确定性保留规则（不可随机、不可静默）：
    //      ① 健康历史连续：规范化前 norm 已等于规范键的一方优先（避免实测历史断档）
    //      ② lastUpdateTime 较新者 ③ 规则字段更完整者 ④ 先出现者
    //      所有规范化/合并/保留冲突逐日落 reports/canonical-merge.json
    const canonLog = {
        generatedAt: Date.now(),
        rules: { rootMultislash: 'collapse-root-only', nonRootDoubleSlash: 'keep-and-report', fragment: 'always-preserved', query: { dropOnlyWhenAllParamsVerified: true, verifiedTrackingParams: CANON_TRACKING_PARAMS } },
        normalized: [], merged: [], advisories: []
    };
    let canonChanged = 0, canonMerged = 0;
    const ruleSize = s => ['ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent'].reduce((n, f) => n + JSON.stringify(s[f] || {}).length, 0);
    const canonSeen = new Map();   // 规范完整URL → 在 canonOut 中的下标
    const canonOrig = [];          // 与 canonOut 平行：规范前原始 URL
    const canonOut = [];
    for (const s of out) {
        const origUrl = s.bookSourceUrl;
        const c = canonicalizeUrl(origUrl);
        if (c.changed) {
            canonChanged++;
            s.bookSourceUrl = c.url;
            canonLog.normalized.push({ name: s.bookSourceName, from: origUrl, to: c.url, rules: c.notes });
        }
        if (c.notes.some(x => x.endsWith('-kept'))) canonLog.advisories.push({ type: c.notes.join(','), name: s.bookSourceName, url: c.url });
        if (canonSeen.has(c.url)) {
            const idx = canonSeen.get(c.url);
            const keeper = canonOut[idx], newOne = s;
            const ck = norm(c.url);
            const contKeeper = norm(canonOrig[idx]) === ck ? 1 : 0;
            const contNew = norm(origUrl) === ck ? 1 : 0;
            let takeNew = false, basis;
            if (contNew !== contKeeper) { takeNew = contNew > contKeeper; basis = 'health-history-continuity'; }
            else if ((newOne.lastUpdateTime || 0) !== (keeper.lastUpdateTime || 0)) { takeNew = (newOne.lastUpdateTime || 0) > (keeper.lastUpdateTime || 0); basis = 'lastUpdateTime'; }
            else if (ruleSize(newOne) !== ruleSize(keeper)) { takeNew = ruleSize(newOne) > ruleSize(keeper); basis = 'rule-completeness'; }
            else { basis = 'first-occurrence'; }
            const dropped = takeNew ? keeper : newOne;
            const kept = takeNew ? newOne : keeper;
            // 必须在 canonOrig[idx] 被覆盖前取双方原始 URL
            const keptOrig = takeNew ? origUrl : canonOrig[idx];
            const droppedOrig = takeNew ? canonOrig[idx] : origUrl;
            if (takeNew) { canonOut[idx] = s; canonOrig[idx] = origUrl; }
            canonMerged++;
            canonLog.merged.push({
                canonicalUrl: c.url, basis,
                kept: { name: kept.bookSourceName, origUrl: keptOrig, healthKey: norm(keptOrig) },
                dropped: { name: dropped.bookSourceName, origUrl: droppedOrig, healthKey: norm(droppedOrig) },
                healthKeyMoved: norm(keptOrig) !== norm(droppedOrig)
            });
            // Phase B-1: URL规范化合并丢弃
            const dk = norm(droppedOrig);
            if (dk) deletionManifest[dk] = { name: dropped.bookSourceName || '', reason: 'canon-merged', evidence: 'merged into ' + c.url + ' basis=' + basis };
        } else {
            canonSeen.set(c.url, canonOut.length);
            canonOrig.push(origUrl);
            canonOut.push(s);
        }
    }
    // 保留型冲突报告：去 www 后同主机的兄弟源（未做存活等价验证，不自动合并）
    const hostGroups = {};
    for (const s of canonOut) {
        try { const h = new URL(String(s.bookSourceUrl).split('#')[0]).hostname.replace(/^www\./, ''); (hostGroups[h] = hostGroups[h] || new Set()).add(s.bookSourceUrl); } catch (e) {}
    }
    for (const [h, set] of Object.entries(hostGroups)) {
        if (set.size > 1) canonLog.advisories.push({ type: 'www-or-host-variant-kept', host: h, urls: [...set] });
    }
    out = canonOut;
    // 仅在确有改写/合并时落报告，避免纯时间戳 churn 把"无变化"轮变成提交轮；
    // advisory（保留型冲突）在首轮随报告一并落库，新变体通常伴随新一轮改写/合并出现
    if (canonChanged > 0 || canonMerged > 0) {
        fs.mkdirSync('reports', { recursive: true });
        fs.writeFileSync('reports/canonical-merge.json', JSON.stringify(canonLog, null, 1));
        console.log('URL规范化: 改写 ' + canonChanged + ' 个 / 安全合并 ' + canonMerged + ' 个 / 保留型冲突 ' + canonLog.advisories.length + ' 个（明细见 reports/canonical-merge.json）');
    } else {
        console.log('URL规范化: 无改写无合并（保留型冲突 ' + canonLog.advisories.length + ' 个不产生提交）');
    }

    // 4) 阈值保护：单次剔除超 30% 视为 Actions 网络抖动，放弃写入（旧版本保留）
    if (list.length > 0 && removed > list.length * 0.3) {
        console.log('⚠️ 本次剔除超过 30%，疑似运行环境网络抖动，放弃写入，旧版本保留。');
        return;
    }
    if (merged === 0 && repaired === 0 && removed === 0 && agedRemoved === 0 && added === 0 && fanqieAdded === 0 && canonChanged === 0 && canonMerged === 0) {
        console.log('无变化，不提交');
        return;
    }
    fs.writeFileSync(file, JSON.stringify(out));
    console.log('legado.json 已更新（合并 ' + merged + ' / 修复 ' + repaired + ' / 剔除 ' + removed + '+' + agedRemoved + '（探活+老化）/ 新增 ' + added + ' / 番茄+' + fanqieAdded + ' / URL规范化改写 ' + canonChanged + ' 合并 ' + canonMerged + '）');

    // Phase B-1: 对比 HEAD legado.json 补 upstream-removed + 落盘删除清单
    const newKeys = new Set(out.map(s => norm(s.bookSourceUrl)).filter(Boolean));
    const missing = [...oldKeys].filter(k => !newKeys.has(k) && !deletionManifest[k]);
    // missing 里的源在上一轮存在但本轮消失，且 filter 层无主动记录 → 上游不再提供
    for (const k of missing) deletionManifest[k] = { name: '', reason: 'upstream-removed', evidence: 'upstream no longer provides this source' };
    // 为所有 deletionManifest 条目补 name（如果之前没记录）
    for (const [k, v] of Object.entries(deletionManifest)) {
        if (!v.name) {
            const inOld = oldLegado.find(s => norm(s.bookSourceUrl) === k);
            if (inOld) v.name = inOld.bookSourceName || '';
        }
    }
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync('reports/deletion-manifest.json', JSON.stringify(deletionManifest, null, 1));
    const nTotal = Object.keys(deletionManifest).length;
    if (nTotal) console.log('删除清单: ' + nTotal + ' 个（probe-dead/aging-failed/canon-merged/upstream-removed 明细见 reports/deletion-manifest.json）');
})();

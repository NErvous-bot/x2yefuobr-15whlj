// legado 书源自动维护流水线
// 流程：上游更新合并 → 域名探测 → 域名变体修复 → 阈值保护(失败保留旧版) → 写回提交
// 无任何依赖，GitHub Actions 的 Node 20 可直接运行
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
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
    'https://raw.githubusercontent.com/shidahuilang/shuyuan-bak/main/good.json'
];

function norm(u) {
    try { const x = new URL(String(u).split('#')[0]); return x.origin + x.pathname.replace(/\/$/, ''); }
    catch (e) { return null; }
}
function originOf(u) {
    try { return new URL(String(u).split('#')[0]).origin; } catch (e) { return null; }
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
// 只测 GET 型且带 {{key}} 槽位的规则（POST/特殊规则跳过实测，避免误杀）；
// 返回页 >500 字节视为有实质内容。仅用于扩容候选（每轮≤60个），控制成本。
async function usable(s) {
    try {
        const su = String(s.searchUrl || '');
        if (/POST/i.test(su) || (su.indexOf('{{key}}') === -1 && su.indexOf('{key}') === -1)) return true;
        const cut = su.indexOf(',');
        const path = (cut === -1 ? su : su.slice(0, cut))
            .replace(/\{\{key\}\}|\{key\}/g, encodeURIComponent('都市'))
            .replace(/\{\{page\}\}|\{page\}/g, '1');
        const base = originOf(s.bookSourceUrl);
        if (!base) return true;
        const r = await get(new URL(path, base).href, 15000);
        if (!r || !r.ok) return false;
        const t = await r.text();
        return t.length > 500;
    } catch (e) {
        return true; // 实测自身异常不拦候选，交给域名探活结果
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
                kill.add(norm(s.bookSourceUrl)); agedRemoved++;
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
            s => alive(originOf(s.bookSourceUrl)).then(a => a && usable(s) ? s : null))).filter(Boolean);
        for (const s of ok.slice(0, 15)) { out.push(s); added++; }
        console.log('扩容: 候选 ' + cand.length + ' / 探活+实测通过 ' + ok.length + ' / 新增 ' + added);

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
            if (!await usable(s)) continue;
            // 已存在的跳过
            if (out.some(x => norm(x.bookSourceUrl) === norm(s.bookSourceUrl))) continue;
            out.push(s); fanqieAdded++; fanqieProbed++;
            if (fanqieAdded >= 10) break; // 番茄兜底每轮最多新增 10 个
        }
        console.log('番茄广撒网: 候选 ' + fanqieCand.length + ' / 新增 ' + fanqieAdded);
    }

    // 4) 阈值保护：单次剔除超 30% 视为 Actions 网络抖动，放弃写入（旧版本保留）
    if (list.length > 0 && removed > list.length * 0.3) {
        console.log('⚠️ 本次剔除超过 30%，疑似运行环境网络抖动，放弃写入，旧版本保留。');
        return;
    }
    if (merged === 0 && repaired === 0 && removed === 0 && agedRemoved === 0 && added === 0 && fanqieAdded === 0) {
        console.log('无变化，不提交');
        return;
    }
    fs.writeFileSync(file, JSON.stringify(out));
    console.log('legado.json 已更新（合并 ' + merged + ' / 修复 ' + repaired + ' / 剔除 ' + removed + '+' + agedRemoved + '（探活+老化）/ 新增 ' + added + ' / 番茄+' + fanqieAdded + '）');
})();

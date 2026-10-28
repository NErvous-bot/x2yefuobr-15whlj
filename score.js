// score.js — V3 源评分分层+自动排序（体验优化层，不改变检测/删除/保险丝逻辑）
// 读取 health/source_health.json 的实测结果 → 计算健康分 → 核心/稳定/备用/观察分层
// → 覆写每源 weight 并按权重降序重排 legado.json，手机端搜索结果优质源自动排前
// 评分（100分）：搜索20 + 目录25 + 正文25 + 稳定性20 + 最近连续成功10
//   稳定性：recent≥2个样本时按窗口成功率×20，否则中性12；连续失败1次-5、2次-15、≥3次强制观察层
// 分层：≥90核心(weight500~700) / 75~89稳定(300~468) / 60~74备用(150~276) / <60观察(50)
//       连续失败≥3→观察(30) / 不可测保护池(曾经实测通过120,从未验证90 — "测不了"不判死，但必须排在备用层150之后) / 确认坏(5 → 由 quarantine.js 移出成品)
// 历史记录复用 health.json 的 recent 数组（最近5次有结论实测），不另建文件避免状态漂移
const fs = require('fs');
const { norm } = require('./src/source-id');

// ── 官方 BookSource 字段白名单 ────────────────────────────────────────────────
// 来源：LegadoTeam/legado@master  app/src/main/java/io/legado/app/data/entities/BookSource.kt
// 共 33 个字段（含 BaseSource 的 override：jsLib / enabledCookieJar / concurrentRate /
// header / loginUrl / loginUi）。
//
// 上游（shidahuilang / tickmao / aoaostar）会在源对象里塞自己的元数据：
//   _validation_status、_response_time、_domain、normalizedName、originalName、
//   selectionScore、searchRule、tocRule、bookInfoRule、contentRule、exploreRule、
//   loginJs、enabledReview、key、tag、score ...
// Gson 解析未知字段时会忽略，不会崩，但会白白撑大 legado.json；更麻烦的是这些名字
// 和官方字段长得很像（searchRule vs ruleSearch、tocRule vs ruleToc），排查问题时极易看错。
// 所以写成品前统一裁掉，只下发白名单内的字段。
//
// 契约测试：.github/workflows/test.yml 的「官方契约检查」用 tests/official-contract.test.js
// 拉官方 BookSource.kt 逐字段比对，官方删字段/加字段都会被抓住。
const OFFICIAL_FIELDS = [
    'bookSourceUrl', 'bookSourceName', 'bookSourceGroup', 'bookSourceType', 'bookUrlPattern',
    'customOrder', 'enabled', 'enabledExplore',
    'jsLib', 'enabledCookieJar', 'concurrentRate', 'header', 'loginUrl', 'loginUi',
    'loginCheckJs', 'coverDecodeJs', 'bookSourceComment', 'variableComment',
    'lastUpdateTime', 'respondTime', 'weight',
    'exploreUrl', 'exploreScreen', 'ruleExplore',
    'searchUrl', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleReview',
    'mainJs', 'eventListener', 'customButton',
];

// 本仓库自用、官方不认识、但链路内部依赖的字段：
//   lastUsableCheck —— filter.js 的老化复测用它算「距上次实测多少天」，
//   裁掉会让所有源被当成「从没测过」而反复复测，所以必须留。
const REPO_FIELDS = ['lastUsableCheck'];

const KEEP_FIELDS = new Set([...OFFICIAL_FIELDS, ...REPO_FIELDS]);

// 只保留白名单字段。官方字段为 null/undefined 时**不补默认值**——
// 官方 Gson 侧本来就有默认值，补上反而多出字节，还可能把 null 语义改成空串。
function sanitizeSource(s) {
    const out = {};
    for (const k of Object.keys(s || {})) if (KEEP_FIELDS.has(k)) out[k] = s[k];
    return out;
}

// 最近 N 次结果 → 末尾连续 pass / fail 计数
const consOf = (recent, tag) => { let n = 0; for (let i = recent.length - 1; i >= 0 && recent[i] === tag; i--) n++; return n; };

function grade(v) {
    // v: health.json 源条目 → { score, layer, weight }
    if (!v || v.health === null || v.health === undefined) {
        // 不可测保护池：曾经实测通过(recent有pass)→120，从未验证→90。
        // 必须低于备用层下界 150：旧值 440/380 高于 stable 下界 300，会让「从没验证过
        // 的源」排在「已验证稳定」的源前面，与「不判死但也不置顶」的设计意图相反。
        const verified = Array.isArray(v && v.recent) && v.recent.includes('pass');
        return { score: null, layer: 'untestable', weight: verified ? 120 : 90 };
    }
    const recent = Array.isArray(v.recent) ? v.recent : [];
    const consFail = consOf(recent, 'fail');
    // 稳定死亡：连续失败≥3 或最近全 fail 且本轮 content=false；才打入 dead 层
    // 单次 content=false（如网站临时抖动）→ 不提前返回，让正常评分流程处理（base 少 25 分 + consFail 惩罚）
    if (v.content === false && (consFail >= 3 || (consFail > 0 && consFail === recent.length && recent.length >= 2)))
        return { score: v.health, layer: 'dead', weight: 5 };
    const base = (v.search ? 20 : 0) + (v.toc ? 25 : 0) + (v.content ? 25 : 0);
    let stab = recent.length < 2 ? 12 : Math.round(recent.filter(x => x === 'pass').length / recent.length * 20);
    if (consFail === 1) stab -= 5; else if (consFail === 2) stab -= 15;
    const consPass = consOf(recent, 'pass');
    const streak = consPass >= 3 ? 10 : consPass === 2 ? 7 : consPass === 1 ? 4 : 0;
    const score = Math.max(0, Math.min(100, base + stab + streak));
    if (consFail >= 3) return { score, layer: 'watch', weight: 30 };
    if (score >= 90) return { score, layer: 'core', weight: Math.round(500 + (score - 90) * 20) };
    if (score >= 75) return { score, layer: 'stable', weight: Math.round(300 + (score - 75) * 12) };
    if (score >= 60) return { score, layer: 'backup', weight: Math.round(150 + (score - 60) * 9) };
    return { score, layer: 'watch', weight: 50 };
}

// 主流程：只有直接 node score.js 才执行评分+改写 legado.json
if (require.main === module) {
try {
    const list = JSON.parse(fs.readFileSync('legado.json', 'utf8'));
    const H = JSON.parse(fs.readFileSync('health/source_health.json', 'utf8')).sources || {};

    const layers = { core: [], stable: [], backup: [], watch: [], untestable: [], dead: [] };
    for (const s of list) {
        const k = norm(s.bookSourceUrl);
        const g = grade(H[k]);
        s.weight = g.weight;
        (layers[g.layer] || layers.watch).push({ name: String(s.bookSourceName || '').slice(0, 16), score: g.score, layer: g.layer, weight: g.weight, url: k });
    }

    // 按权重降序重排（验证过的高分源在前，保护池居中，确认坏沉底）
    list.sort((a, b) => (b.weight || 0) - (a.weight || 0));

    // 字段白名单裁剪：只留官方 BookSource 认识的字段 + 本仓库自用字段
    const beforeBytes = Buffer.byteLength(JSON.stringify(list));
    const kept = list.map(sanitizeSource);
    const afterBytes = Buffer.byteLength(JSON.stringify(kept));
    fs.writeFileSync('legado.json', JSON.stringify(kept));
    if (afterBytes < beforeBytes) {
        console.log('字段白名单: ' + (beforeBytes / 1048576).toFixed(2) + ' MB → ' +
            (afterBytes / 1048576).toFixed(2) + ' MB（裁掉 ' +
            (100 - afterBytes / beforeBytes * 100).toFixed(1) + '% 的上游元数据字段）');
    }

    // 评分明细留档
    const flat = Object.values(layers).flat();
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync('reports/source_scores.json', JSON.stringify({ generatedAt: Date.now(), layers: { core: layers.core, stable: layers.stable, backup: layers.backup, watch: layers.watch, untestable: layers.untestable, dead: layers.dead }, total: flat.length }, null, 1));

    // 中文摘要表
    const L = [];
    L.push('━━━━━━━━━━━━━━━━━━━━ 源评分分层 ━━━━━━━━━━━━━━━━━━━━');
    L.push('核心源  ' + layers.core.length + ' 个（≥90分）');
    for (const x of layers.core.slice(0, 10).sort((a, b) => b.weight - a.weight))
        L.push('  ' + String(x.weight).padStart(5) + '  ' + x.name + (x.score !== null && x.score !== undefined ? '  ' + x.score + '分' : ''));
    if (layers.core.length > 10) L.push('  ...等 ' + layers.core.length + ' 个');
    L.push('稳定源  ' + layers.stable.length + ' 个（75~89分，weight 300~468）');
    L.push('备用源  ' + layers.backup.length + ' 个（60~74分，weight 150~276）');
    L.push('观察    ' + layers.watch.length + ' 个（<60分或连续失败，weight 30~50）');
    const uv = layers.untestable.filter(x => x.weight === 120).length;
    L.push('不可测保护池  ' + layers.untestable.length + ' 个（曾实测通过 ' + uv + ' 个weight120 / 从未验证 ' + (layers.untestable.length - uv) + ' 个weight90，不判死但排在备用层之后）');
    L.push('确认坏  ' + layers.dead.length + ' 个（weight 5，由 quarantine.js 移出成品，不进手机）');
    L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(L.join('\n'));
    process.exit(0);
} catch (e) {
    console.error('× 源评分异常，拒绝发布（防止旧报告残留）: ' + e.message);
    process.exit(1);
}
} // end require.main === module

// 测试用导出（grade/consOf 不依赖文件 IO，require 时只加载函数不执行主流程）
module.exports = { grade, consOf, sanitizeSource, OFFICIAL_FIELDS, REPO_FIELDS, KEEP_FIELDS };

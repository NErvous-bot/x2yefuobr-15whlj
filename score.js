// score.js — V3 源评分分层+自动排序（体验优化层，不改变检测/删除/保险丝逻辑）
// 读取 health/source_health.json 的实测结果 → 计算健康分 → 核心/稳定/备用/观察分层
// → 覆写每源 weight 并按权重降序重排 legado.json
//
// ⚠️ weight 到底影响什么（2026-10-28 拿 LegadoTeam/legado@master 源码核对过，别再想当然）：
//   全库搜索 `.weight` 只命中两处，都是**书源管理界面**的排序：
//     ui/book/source/manage/BookSourceActivity.kt:437,457
//     ui/book/source/manage/BookSourceViewModel.kt:225,244
//   阅读 App 的搜索并**不**按 weight 排序：
//     · 参与搜索的源集合来自 allEnabledPart（只看 enabled）
//     · 搜索范围列表按 customOrder 排（ui/book/search/SearchScope.kt:141 `list.sortedBy { it.customOrder }`）
//     · 换源列表按 SourceConfig.getSourceScore(origin) 排 —— 那是 App 端按用户实际使用行为
//       存在 SharedPreferences 的运行时评分，和 JSON 里的 weight 无关
//   所以：weight 是「书源管理界面的排序权重」，不是「搜索优先级的开关」。
//   真正改变阅读体验的杠杆是 enabled（本地健康层控制）与 quarantine（把死源移出成品）。
//   这里保留 weight 赋值与重排（对「打开书源管理时谁排前面」确实有效，成本为零），
//   但不要再对外宣称「搜索结果会自动优质源优先」——那不是这个字段干的事。
//
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

// ── CI 判定标签（对齐官方 CheckSourceService 的 addGroup 做法）────────────────
// 官方校验失败时会往书源分组里打「搜索失效 / 目录失效 / 正文失效 / 域名失效 / 校验超时」，
// 用户就能在 App 里按分组筛。我们此前所有判定只活在 reports/ 里，手机上只有一个 weight 数字，
// 所以用户还得自己回手机上再点一遍「校验书源」。
// 这里把 CI 的结论同样写进 bookSourceGroup：前缀统一 CI-，每轮先剥旧标签再加，
// 保证幂等、不会越积越多；用户自己建的分组原样保留。
const CI_PREFIX = 'CI-';

// 上游脏分组名：从上游合并进来的书源有时带着无意义的分组名（实测成品里
// 173 个源的分组是 "6666666666666666"，还有 "0206" / "0905校验" 这类批次编号）。
// 这些名字来自上游某次批量导出的中间产物，对用户没有任何筛选价值：
// 在阅读 App 的「分组」里它们只表现为一坨同名条目，等于分组功能失效。
//
// 判定用保守的形态规则，不做白名单（避免误伤用户自定义的正常分组名）：
//   · 纯数字且长度 >= 6（"0206" 4 位保留，它像年份/批次，可能是用户有意的）
//   · 单个字符重复 >= 8 次（"6666666666666666" 命中）
// 只有命中这两条才丢弃，其它一律原样保留。
function isJunkGroupName(name) {
    const s = String(name || '').trim();
    if (!s) return false;
    if (/^\d{6,}$/.test(s)) return true;
    if (s.length >= 8 && new RegExp('^' + s[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '+$').test(s)) return true;
    return false;
}

function stripCIGroups(group) {
    return String(group || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith(CI_PREFIX) && !isJunkGroupName(s))
        .join(',');
}

function ciTagsOf(v) {
    const tags = [];
    if (!v) return tags;
    // 只在「有结论」的实测上打标。
    // health===null 表示这一轮压根测不了（js 规则 / 反爬 / 超时），它的 content 也是 false，
    // 但那是「不知道」不是「坏了」。若把这类也算进去，578 个不可测源会集体被打成
    // CI-校验失败，分组就废了（实测过一次：696 个源里 579 个被打标，其中 339 个是冤枉的）。
    const hasVerdict = v.health !== null && v.health !== undefined;
    if (hasVerdict && v.content === false) {
        const n = String(v.note || '');
        if (/^(搜索|书籍页)/.test(n)) tags.push('CI-搜索失效');
        else if (/^目录/.test(n)) tags.push('CI-目录失效');
        else if (/^正文/.test(n)) tags.push('CI-正文失效');
        else tags.push('CI-校验失败');
    }
    // 第④关：发现页不通（源本身可用，只是发现页刷不出来）
    if (v.explore === false) tags.push('CI-发现失效');
    return tags;
}

function grade(v) {
    // v: health.json 源条目 → { score, layer, weight }
    if (!v || v.health === null || v.health === undefined) {
        // 不可测保护池：曾经实测通过(recent有pass)→120，从未验证→90。
        // 必须低于备用层下界 150：旧值 440/380 高于 stable 下界 300，会让「从没验证过
        // 的源」排在「已验证稳定」的源前面，与「不判死但也不置顶」的设计意图相反。
        //
        // ── IP受限单独成档（2026-10-31）──────────────────────────────────────
        // ipBlocked = CI 的 IP 被站点拉黑（401/403/429/503），与源质量无关：
        // 用户手机 IP 不在黑名单里，源多半是好的。
        // 实测本仓库 94 个源卡在这（当时全被压成 90，排在「已验证备用」的 150 之后）。
        // 分档后：曾经通过过的 160（略高于备用层下界，承认它历史上是活源）；
        //         从未验证过的 130（排在备用层之后，但不与「规则超纲」的 90 同档）。
        // 上限刻意压在 stable 下界（300）之下：CI 看不见的东西，不该排到已验证源前面。
        const verified = Array.isArray(v && v.recent) && v.recent.includes('pass');
        if (v && v.ipBlocked === true) {
            return { score: null, layer: 'untestable', weight: verified ? 160 : 130, ipBlocked: true };
        }
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

    // ── 可信度闸门（2026-11-01，评审 P1）──────────────────────────────────────
    //
    // 问题：eval job 执行的是**不可信书源脚本**，它产出的 health 报告只是
    // 「未经独立验证的数据」。而此前 score.js 里，一个源只要连续 2 次 pass
    // 就能拿到 score=97 → 直接进**核心层**、权重 500~700。
    // 也就是说：**两轮可能被污染的判定，就能把一个源顶到最前排**。
    // （实测 156 个 available 源里已有 4 个只连续 2 次 pass，正好卡在这个口径上。）
    //
    // 生产侧的完整性校验（key 集 / 去重 / URL 归属 / 时间 / broken 比例）
    // 全是**结构与一致性**检查，没有一条在验证「这个判定是真的」。
    //
    // 处置：按累计实测轮数分权，**只降不判死**。
    //   · 5 次及以上（满窗口）：行为完全不变（实测 152/156 属这一档）
    //   · 3~4 次：不给核心层，上限 stable（460）
    //   · 1~2 次：只到备用层（276）
    // 与 fuse.js 的「三振判死」同向：结论需要多轮才能升降，
    // 不允许单轮/双轮把源推到核心层。判死仍维持「连续失败≥3」不变。
    {
        const rounds = recent.length;
        let g;
        if (score >= 90) g = { score, layer: 'core', weight: Math.round(500 + (score - 90) * 20) };
        else if (score >= 75) g = { score, layer: 'stable', weight: Math.round(300 + (score - 75) * 12) };
        else if (score >= 60) g = { score, layer: 'backup', weight: Math.round(150 + (score - 60) * 9) };
        else g = { score, layer: 'watch', weight: 50 };
        if (rounds < 5 && g.layer === 'core') {
            return { score, layer: 'stable', weight: 460, cappedBy: 'rounds-' + rounds };
        }
        if (rounds < 3 && g.layer === 'stable') {
            return { score, layer: 'backup', weight: 276, cappedBy: 'rounds-' + rounds };
        }
        // 满窗口或未触发降权 → 继续走下面的既有分支（deepLimited 等）
    }

    // 后段受限（试读墙 / 深页收费）：三关名义上过了，但用户读到后面会撞墙。
    // 不判死（手机上可能仍能读，App 有 nextContentUrl 续页能力），
    // 但降一档权重，让它排在「全文可读」的源后面 —— 实测占可用源的 ~10%。
    if (v.deepLimited === true) {
        const w = score >= 90 ? 460 : score >= 75 ? 280 : 140;
        return { score, layer: score >= 90 ? 'core' : score >= 75 ? 'stable' : 'backup', weight: w, deepLimited: true };
    }
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
    const tagCount = {};
    let tagged = 0;
    for (const s of list) {
        const k = norm(s.bookSourceUrl);
        const v = H[k];
        const g = grade(v);
        s.weight = g.weight;

        // CI 判定标签：先剥掉上一轮留下的 CI- 标签，再按本轮结论补上（幂等，不累积）
        const baseGroup = stripCIGroups(s.bookSourceGroup);
        const tags = ciTagsOf(v);
        const mergedGroup = [baseGroup].concat(tags).filter(Boolean).join(',');
        if (mergedGroup) s.bookSourceGroup = mergedGroup;
        else delete s.bookSourceGroup;
        if (tags.length) {
            tagged++;
            for (const t of tags) tagCount[t] = (tagCount[t] || 0) + 1;
        }

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
    const tagLine = Object.entries(tagCount).sort((a, b) => b[1] - a[1])
        .map(([t, n]) => t + ' ' + n + ' 个').join(' / ');
    L.push('CI 判定标签  ' + tagged + ' 个源被打标' + (tagLine ? '（' + tagLine + '）' : '') + '，手机端可按分组筛');
    L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(L.join('\n'));
    process.exit(0);
} catch (e) {
    console.error('× 源评分异常，拒绝发布（防止旧报告残留）: ' + e.message);
    process.exit(1);
}
} // end require.main === module

// 测试用导出（grade/consOf 不依赖文件 IO，require 时只加载函数不执行主流程）
module.exports = { grade, consOf, sanitizeSource, stripCIGroups, isJunkGroupName, ciTagsOf, OFFICIAL_FIELDS, REPO_FIELDS, KEEP_FIELDS };

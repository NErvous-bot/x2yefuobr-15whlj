// scripts/export-health-json.js —— 把本轮健康判定收口成一份纯 JSON
//
// 用途：js-eval.yml（低权限隔离 job）跑完 health.js 后，把结果导出成
// js-eval-result.json，供生产 job（update.yml）消费。
//
// 设计约束（安全边界的一部分）：
//   · 只输出 JSON 字符串/数字/布尔/数组，绝不输出函数、路径、堆栈
//   · 字段集合固定且**完整**，生产侧会再校验一次 keys，防止被注入额外字段
//   · url 字段做长度截断，避免异常长大对象撑爆产物
//   · 若 health 报告缺失或损坏，明确失败而不是输出空壳（fail-closed）
//
// ══ 字段契约（P0 修复，2026-10-30 晚）════════════════════════════════════════
// 上一版导出只保留 {url, state, health, note}，而 score.js 实际依赖：
//   L139  base = (v.search ? 20 : 0) + (v.toc ? 25 : 0) + (v.content ? 25 : 0)
//   L130  verified = v.recent.includes('pass')
//   L133  consFail / recent.length（连续失败三振判死）
// 结果：146 个可用源的平均基础分从 70 塌到 25（-64%），196 个源丢失
// recent 历史，696 个源丢失 flapping / responseTime —— 核心层被误降到观察层。
//
// 现在导出 health.js 产出的全部 14 个字段，一个不失。字段顺序固定，
// 靠结构校验与端到端测试锁住契约（见 tests/data-contract.test.mjs）。
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');

const HEALTH = 'health/source_health.json';
const OUT = 'js-eval-result.json';
const MAX_URL_LEN = 2048;
const MAX_ROWS = 2000;
const MAX_RECENT = 5;      // recent 只保留最近 5 次（与 score.js 的三振口径一致）
const MAX_NOTE_LEN = 200;

// 三态判定必须以 health 为准，不能看 content。
//
// 为什么：health.js 的 gatesOf() 里 content: ok（ok = usable===true），所以
// 一个「不可测」的源（usable==='skip'，health=null）拿到的 content 也是 false。
// 若这里优先判 content===false → broken，就会把「测不了」当成「坏了」：
//   · 这类源多为 JS 规则 / 反爬 / 网络失败，属于「不知道」而不是「确认失效」
//   · 判成 broken 后 score.js 会给它 dead 层权重，甚至推进 quarantine 隔离池
// 正确语义（与 health.js 自己的 untestable 计数、以及 README 的口径一致）：
//   health === null        → untestable（不知道）
//   health 有值且 content  → available
//   health 有值且 !content → broken（真坏）
function safeState(v) {
    if (v === null || v === undefined) return 'untestable';
    if (v.health === null || v.health === undefined) return 'untestable';
    if (v.content === true) return 'available';
    if (v.content === false) return 'broken';
    return 'untestable';
}

function safeString(x, max) {
    const s = typeof x === 'string' ? x : String(x === undefined ? '' : x);
    return s.length > max ? s.slice(0, max) : s;
}

const safeBool = (x) => (typeof x === 'boolean' ? x : null);
const safeNum = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** recent 是字符串数组；按 score.js 的口径只保留最近几次。 */
function safeRecent(x) {
    if (!Array.isArray(x)) return [];
    return x.slice(-MAX_RECENT).map((e) => safeString(e, 24));
}

// ── 按当前成品裁剪孤儿键（2026-10-31，run 41184777297 之后补）──────────────
//
// 背景：health 报告的 sources 键是 norm(bookSourceUrl)，而成品 legado.json 每个
// 轮次都会被 quarantine/filter 删掉一部分源。若报告是旧的（本地跑、或上一轮留下的），
// 里面就会残留「成品已剔除」的孤儿键。这些行导出去之后，update.yml 的对账会以
// 'result url not in product' 整轮拒收 —— 在 CI 里不会发生（health.js 每轮从
// legado.json 现读列表），但本地复跑会和 CI 行为不一致，属于必须消掉的隐性差异。
//
// 取舍：
//   · legado.json 不存在（例如只喂一份构造的 health 报告做单测）→ 不裁剪，保持旧行为
//   · legado.json 存在但解析不出任何身份键 → 同样不裁剪，并把原因打到 stderr
//     （宁可原样导出让下游对账明确失败，也不静默丢行）
//   · 裁剪结果为空 → 走已有的「sources 为空就拒绝产出」分支，fail-closed
function pruneToProduct(sources, keys) {
    const legadoPath = 'legado.json';
    if (!fs.existsSync(legadoPath)) {
        return { keys, pruned: 0, reason: 'legado.json 不存在，跳过裁剪' };
    }
    let lib;
    try {
        lib = JSON.parse(fs.readFileSync(legadoPath, 'utf8'));
    } catch (e) {
        return { keys, pruned: 0, reason: 'legado.json 解析失败，跳过裁剪: ' + e.message };
    }
    if (!Array.isArray(lib)) {
        return { keys, pruned: 0, reason: 'legado.json 不是数组，跳过裁剪' };
    }
    // 身份键定义必须与 health.js / update.yml 共用同一份（src/source-id.js）
    let norm;
    try {
        norm = require('../src/source-id').norm;
    } catch (e) {
        return { keys, pruned: 0, reason: 'src/source-id.js 不可用，跳过裁剪: ' + e.message };
    }
    const inLib = new Set();
    for (const s of lib) {
        if (!s || typeof s.bookSourceUrl !== 'string') continue;
        const k = norm(s.bookSourceUrl);
        if (k) inLib.add(k);
    }
    if (inLib.size === 0) {
        return { keys, pruned: 0, reason: 'legado.json 无可用 bookSourceUrl，跳过裁剪' };
    }
    const kept = keys.filter((k) => inLib.has(k));
    return { keys: kept, pruned: keys.length - kept.length, reason: '按 legado.json 身份键裁剪' };
}

function main() {
    if (!fs.existsSync(HEALTH)) {
        console.error('export: ' + HEALTH + ' 不存在，拒绝产出空壳结果');
        process.exit(1);
    }
    let report;
    try {
        report = JSON.parse(fs.readFileSync(HEALTH, 'utf8'));
    } catch (e) {
        console.error('export: ' + HEALTH + ' 解析失败: ' + e.message);
        process.exit(1);
    }
    const sources = report && report.sources ? report.sources : {};
    const rawKeys = Object.keys(sources);
    if (rawKeys.length === 0) {
        console.error('export: sources 为空，拒绝产出空壳结果');
        process.exit(1);
    }

    const pruned = pruneToProduct(sources, rawKeys);
    if (pruned.pruned > 0) {
        console.log('export: 裁掉 ' + pruned.pruned + ' 个成品已剔除的孤儿键（' + pruned.reason + '）');
    } else if (pruned.reason.indexOf('跳过') >= 0) {
        console.log('export: ' + pruned.reason);
    }
    const keys = pruned.keys;
    if (keys.length === 0) {
        console.error('export: 裁剪后 sources 为空（全部键都不在成品里），拒绝产出空壳结果');
        process.exit(1);
    }

    const rows = [];
    for (const k of keys.slice(0, MAX_ROWS)) {
        const v = sources[k] || {};
        rows.push({
            url: safeString(k, MAX_URL_LEN),
            state: safeState(v),
            // ── score.js 评分基础分三要素（缺一即降档）──
            search: safeBool(v.search),
            toc: safeBool(v.toc),
            content: safeBool(v.content),
            // ── 三振判死与稳定性奖励依赖的历史 ──
            recent: safeRecent(v.recent),
            // ── 抖动标记：fuse.js 用它区分「真死亡」与「时好时坏」──
            flapping: safeBool(v.flapping),
            // ── 其余诊断字段 ──
            health: safeNum(v.health),
            name: safeString(v.name === undefined ? '' : v.name, 60),
            chapters: safeNum(v.chapters),
            contentLen: safeNum(v.contentLen),
            responseTime: safeNum(v.responseTime),
            note: safeString(v.note === undefined ? '' : v.note, MAX_NOTE_LEN),
            checkedAt: safeNum(v.checkedAt),
            // explore 是三值（true/false/null），探索页判定
            explore: typeof v.explore === 'boolean' ? v.explore : null,
            exploreNote: safeString(v.exploreNote === undefined ? '' : v.exploreNote, 120),
            // ── 2026-10-31 新增的两个分档依据 ──────────────────────────────────
            // 教训（run 72 / 73 连着踩两次）：ipBlocked 在 eval job 里已经生成了 94 个，
            // 但导出器的字段集合是**固定白名单**，没加这两项 ⇒ 生产侧 ipBlocked 恒为 0，
            // score.js 的 160/130 两档完全没生效。新字段必须三处同步：
            //   aging-test 产出 → 这里导出 → update.yml 重建
            ipBlocked: v.ipBlocked === true,
            deepLimited: v.deepLimited === true,
            deepNote: safeString(v.deepNote === undefined ? '' : v.deepNote, 24),
        });
    }

    // 固定字段集合，不接受 report 里的其它内容透传
    const payload = {
        version: 2,   // v1 → v2：补齐 search/toc/recent/flapping 等评分必需字段
        generatedAt: typeof report.updatedAt === 'number' ? report.updatedAt : Date.now(),
        totalSources: keys.length,
        results: rows,
    };

    fs.writeFileSync(OUT, JSON.stringify(payload) + '\n');
    console.log('export: 写入 ' + OUT + '（' + rows.length + ' 行，14 字段完整）');
}

main();

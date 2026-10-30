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
    const keys = Object.keys(sources);
    if (keys.length === 0) {
        console.error('export: sources 为空，拒绝产出空壳结果');
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

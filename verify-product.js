// verify-product.js — D3（Round3 补测 2026-10-20）成品硬断言
// 运行点：score.js 之后、fuse.js 之前。
//   此时 legado.json 是本轮候选成品，与 reports/source_scores.json 同轮；
//   fuse 若 BLOCKED 会有意把成品回滚到 HEAD 基线（新 scores 仅作诊断件保留），
//   所以本断言必须置于回滚之前——回滚后的"基线成品+新诊断报告"是设计内状态，不是缺陷。
// 硬断言（任一失败 exit 1，CI 红灯，裁决不得继续）：
//   A. legado.json 每个 bookSourceUrl 已是规范形式（canonicalize 幂等），
//      且规范后完整 URL 全库无重复
//   B. legado.json 与 reports/source_scores.json 逐源 weight 100% 一致
//      （norm 键多重集比对，双向无悬挂；score.js 异常 exit 0 留旧成品时在此被兜住）
// 注意：canonicalizeUrl / CANON_TRACKING_PARAMS 是 filter.js 的同规则副本，
//       norm 与 health.js/score.js 同规则，任何一处改动必须多处同步。
'use strict';
const fs = require('fs');
const { norm } = require('./src/source-id');

// ── 与 filter.js 完全一致的规范化规则（副本，改动两处同步）──
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

const fail = msg => { console.error('× 成品硬断言失败: ' + msg); process.exit(1); };

let list, scores;
try { list = JSON.parse(fs.readFileSync('legado.json', 'utf8')); }
catch (e) { fail('legado.json 无法解析: ' + e.message); }
try { scores = JSON.parse(fs.readFileSync('reports/source_scores.json', 'utf8')); }
catch (e) { fail('reports/source_scores.json 缺失或无法解析: ' + e.message); }

// ── 额外: 评分报告不能是上一轮残留（score.js catch exit 0 时会留下旧文件）──
if (!scores.generatedAt) fail('reports/source_scores.json 缺少 generatedAt，可能是陈旧残留');
const stalenessMs = Date.now() - scores.generatedAt;
if (stalenessMs > 60 * 60 * 1000)  // 1 小时窗口（score.js 和 verify-product.js 同一步骤，正常几秒内完成）
    fail('reports/source_scores.json 过于陈旧: ' + Math.round(stalenessMs / 60000) + ' 分钟前生成，疑似 score.js 异常后残留的上一轮报告');
if (!Array.isArray(list) || list.length < 100)
    fail('legado.json 结构/数量异常: ' + (Array.isArray(list) ? list.length : typeof list));

// ── A. URL 规范化：幂等 + 规范后无重复 ──
const seen = new Map();
for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const raw = String(s.bookSourceUrl == null ? '' : s.bookSourceUrl);
    const name = String(s.bookSourceName || '?');
    if (!raw) fail('第 ' + i + ' 条 bookSourceUrl 为空（' + name + '）');
    const c = canonicalizeUrl(raw);
    if (c.changed || c.url !== raw)
        fail('成品 URL 未规范化: ' + raw + ' → ' + c.url + '（' + c.notes.join(',') + '），filter 的规范化未进入最终成品');
    if (seen.has(c.url))
        fail('规范化后重复 URL: ' + c.url + '（' + seen.get(c.url) + ' / ' + name + '）');
    seen.set(c.url, name);
}

// ── B. weight 逐源 100% 一致：norm 键多重集比对，双向无悬挂 ──
const flat = Object.values(scores.layers || {}).reduce((a, arr) => a.concat(arr || []), []);
if (!Array.isArray(flat) || flat.length !== list.length)
    fail('scores 条目数 ' + (Array.isArray(flat) ? flat.length : 'N/A') + ' 与 legado.json ' + list.length + ' 不一致');
const sig = x => String(x[0]) + '\t' + String(x[1]);
const sigL = list.map(s => {
    const w = Number(s.weight);
    if (!Number.isFinite(w)) fail('legado 源 weight 非法: ' + String(s.bookSourceName) + ' ' + String(s.weight));
    return sig([norm(s.bookSourceUrl), w]);
}).sort();
const sigS = flat.map(x => {
    const w = Number(x.weight);
    if (!Number.isFinite(w)) fail('scores 条目 weight 非法: ' + String(x.name) + ' ' + String(x.weight));
    return sig([x.url, w]);
}).sort();
const diffs = [];
for (let i = 0; i < sigL.length && diffs.length < 10; i++) {
    if (sigL[i] !== sigS[i]) diffs.push('  legado: ' + sigL[i] + '   ≠   scores: ' + sigS[i]);
}
if (diffs.length)
    fail('legado.json 与 source_scores.json 存在 weight 不一致或悬挂条目（前 ' + diffs.length + ' 条）:\n' + diffs.join('\n'));

console.log('√ 成品硬断言通过：' + list.length + ' 个源 URL 规范且无重复；legado.json 与 source_scores.json weight 逐源 ' + list.length + '/' + list.length + ' 一致');

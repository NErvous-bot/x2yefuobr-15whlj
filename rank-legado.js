#!/usr/bin/env node
/**
 * rank-legado.js — 跨书诊断驱动的 legado.json 重排器 v1.0
 *
 * 规则锁定（不得静默放宽）：
 *   R1. 评分 = Σ(每本书 diff 得分 × 参考章权重) / Σ(参考章权重)
 *       diff 得分：
 *         diff >= -5   → +3  (领先/匹配)
 *         diff >= -20  → +1  (轻微滞后)
 *         diff >= -200 → -2  (明显滞后)
 *         diff < -200  → -5  (严重滞后)
 *         unknown/未测  →  0  (中性，不加分也不减分)
 *       参考章权重：min(reference, 1000) — 长书占比更高但封顶
 *
 *   R2. 降级标记（不删除源）：
 *     - SUSPICIOUS_TRUNCATION: 多本书上 observed_chapters 都是 100 整数倍
 *       → 标记为 weight *= 0.6，保留但降权
 *     - SEVERE_LAGGING: 2+ 本书 diff < -200 且 confidence !== low
 *       → 标记为 weight *= 0.4，保留但强降权
 *     - ALMOST_EMPTY: observed_chapters <= 10（两本书以上）
 *       → 标记为 weight *= 0.2，保留但极弱权重
 *     - DORMANT_RULE: nextTocUrl 存在但在多数测试书上触发 NO_VALID_URL
 *       → 不影响 weight（可能短目录不触发长目录触发），仅记录
 *
 *   R3. 不删除任何源、不修改任何规则、保留原始顺序中的相对 proximity
 *       同一诊断分组内，保持 legado.json 原始顺序。
 *
 *   R4. 生产保护：
 *     - 原始 legado.json 保持不变
 *     - 输出 ranked-legado.json + rank-report.md
 *     - 运行前/运行后校验：源数量、ruleToc 保留率、URL 唯一率
 *     - 校验失败则 exit code !== 0 且不写 ranked 文件
 *
 *   R5. 可追溯性：输出 ranked 文件里每个源带 weight 和 _diagnosis 字段
 *       （运行后手动或 CI 审查决定是否覆盖）
 */

'use strict';
const fs = require('fs');
const path = require('path');

// ====== 输入路径 ======
const REPO = __dirname;
const LEGADO = path.join(REPO, 'legado.json');
const SUMMARY = path.join(REPO, 'reports', 'freshness-summary.json');
const OUT_RANKED = path.join(REPO, 'ranked-legado.json');
const OUT_REPORT = path.join(REPO, 'reports', 'rank-report.md');

// ====== 加载 ======
const legado = JSON.parse(fs.readFileSync(LEGADO, 'utf8'));
const summary = JSON.parse(fs.readFileSync(SUMMARY, 'utf8'));
const books = Object.values(summary.books);

// ====== R1v2: 跨书评分（置信度修正） ======
// diff → 单本得分
function diffScore(diff) {
    if (diff == null || isNaN(diff)) return 0;
    if (diff >= -5) return 3;
    if (diff >= -20) return 1;
    if (diff >= -200) return -2;
    return -5;
}
// 新增：positiveRatio = diff>=-5 的书/已测书 衡量一致性
// 规则：
//   HIGH_PERFORMER: positiveRatio >= 0.75 AND tested >= 3 (多本一致好)
//   GOOD:           positiveRatio >= 0.60 AND tested >= 2
//   GOOD_MINOR:     positiveRatio = 1.00 AND tested = 1 (但测试点太少，置信度不足)
//   UNDERPERFORMER: final_score < 0
//   NEUTRAL:        其余

const sourceScores = {}; // name → { score, weight, diffs, truncCount, lagCount, emptyCount, dormantCount, positiveCount }
const nameToIndex = {};

for (let i = 0; i < legado.length; i++) {
    const n = legado[i].bookSourceName;
    if (!nameToIndex[n]) nameToIndex[n] = [];
    nameToIndex[n].push(i);
    if (!sourceScores[n]) {
        sourceScores[n] = { score: 0, weight: 0, diffs: [], truncCount: 0, lagCount: 0, emptyCount: 0, dormantCount: 0, positiveCount: 0 };
    }
}

for (const book of books) {
    const ref = book.reference || 0;
    const w = Math.min(ref, 1000);
    for (const s of book.bySource || []) {
        const name = s.name;
        if (!sourceScores[name]) continue;
        const sc = diffScore(s.diff);
        sourceScores[name].score += sc * w;
        sourceScores[name].weight += w;
        sourceScores[name].diffs.push({ book: book.title, diff: s.diff, chapters: s.observed_chapters, conf: s.confidence });
        if (s.diff != null && s.diff >= -5) sourceScores[name].positiveCount++;
        if (s.suspicious_truncation) sourceScores[name].truncCount++;
        if (s.diff != null && s.diff < -200 && s.confidence !== 'low') sourceScores[name].lagCount++;
        if (s.observed_chapters <= 10) sourceScores[name].emptyCount++;
        if (s.pagination_rule_dormant) sourceScores[name].dormantCount++;
    }
}

// 归一化
for (const name of Object.keys(sourceScores)) {
    const s = sourceScores[name];
    s.final_score = s.weight > 0 ? s.score / s.weight : 0;
    s.tested = s.diffs.length;
    s.positiveRatio = s.tested > 0 ? s.positiveCount / s.tested : 0;
}

// ====== R2v2: 降级标记（置信度修正） ======
function classifySource(name, sc) {
    const tags = [];
    let mult = 1.0;

    if (sc.truncCount >= 2) { tags.push('SUSPICIOUS_TRUNCATION'); mult *= 0.6; }
    if (sc.lagCount >= 2) { tags.push('SEVERE_LAGGING'); mult *= 0.4; }
    if (sc.emptyCount >= 2) { tags.push('ALMOST_EMPTY'); mult *= 0.2; }
    if (sc.dormantCount >= 1) { tags.push('DORMANT_RULE'); /* 不影响 mult */ }

    // 置信度修正 HIGH/GOOD
    if (sc.positiveRatio >= 0.75 && sc.tested >= 3) {
        tags.push('HIGH_PERFORMER');
    } else if (sc.positiveRatio >= 0.60 && sc.tested >= 2) {
        tags.push('GOOD');
    } else if (sc.positiveRatio === 1.0 && sc.tested === 1) {
        tags.push('GOOD_MINOR'); // 单本好但置信度不足
    }
    // UNDERPERFORMER 只给没进 HIGH/GOOD/GOOD_MINOR 的源（避免标签矛盾）
    if (sc.final_score < 0 && !tags.some(t => ['HIGH_PERFORMER','GOOD','GOOD_MINOR'].includes(t))) {
        tags.push('UNDERPERFORMER');
    }

    return { tags, weightMult: mult };
}

// ====== 排序 ======
// HIGH_PERFORMER → GOOD → GOOD_MINOR → 中性 → UNDERPERFORMER → 降级组
function groupRank(name) {
    const sc = sourceScores[name];
    const { tags } = classifySource(name, sc);
    if (tags.includes('HIGH_PERFORMER')) return 0;
    if (tags.includes('GOOD')) return 1;
    if (tags.includes('GOOD_MINOR')) return 2;  // 注意：GOOD_MINOR 排中性前面（好源但置信度不足）
    if (tags.includes('ALMOST_EMPTY')) return 5;
    if (tags.includes('SEVERE_LAGGING')) return 4;
    if (tags.includes('SUSPICIOUS_TRUNCATION')) return 4;
    if (tags.includes('UNDERPERFORMER')) return 4;
    return 3; // 中性
}

// 每个源的所有副本一起移动（保持内部相对顺序）
const orderedNames = Object.keys(sourceScores).sort((a, b) => {
    const ga = groupRank(a), gb = groupRank(b);
    if (ga !== gb) return ga - gb;
    // 组内按 first appearance 顺序
    return nameToIndex[a][0] - nameToIndex[b][0];
});

// ====== 构建 ranked 文件 ======
const ranked = [];
for (const name of orderedNames) {
    const indices = nameToIndex[name];
    const sc = sourceScores[name];
    const { tags, weightMult } = classifySource(name, sc);

    for (const idx of indices) {
        const orig = legado[idx];
        // 深拷贝 + 附加 _diagnosis
        const copy = JSON.parse(JSON.stringify(orig));
        const origWeight = copy.weight != null ? copy.weight : 0;
        copy.weight = Math.round(origWeight * weightMult) + (tags.includes('HIGH_PERFORMER') ? 1000 : 0);
        copy._diagnosis = {
            score: Math.round(sc.final_score * 100) / 100,
            weight_mult: weightMult,
            tags,
            positive_ratio: Math.round(sc.positiveRatio * 100) / 100,
            total_books: books.length,
            tested_books: sc.diffs.length,
            trunc_books: sc.truncCount,
            lag_books: sc.lagCount,
            empty_books: sc.emptyCount,
            dormant_books: sc.dormantCount,
            diffs: sc.diffs,
        };
        ranked.push(copy);
    }
}

// ====== R4: 生产校验 ======
const errors = [];
if (ranked.length !== legado.length) errors.push(`源数量变化: ${legado.length} → ${ranked.length}`);
// ruleToc 保留率
const origToc = legado.filter(s => !!(s.ruleToc && s.ruleToc.nextTocUrl)).length;
const rankToc = ranked.filter(s => !!(s.ruleToc && s.ruleToc.nextTocUrl)).length;
if (origToc !== rankToc) errors.push(`nextTocUrl 规则丢失: ${origToc} → ${rankToc}`);
// URL 唯一率
const origUrls = new Set(legado.map(s => s.bookSourceUrl));
const rankUrls = new Set(ranked.map(s => s.bookSourceUrl));
if (origUrls.size !== rankUrls.size) errors.push(`URL 唯一率变化: ${origUrls.size} → ${rankUrls.size}`);
// 规则完整性：所有子字段保留（按 URL 匹配，位置不同没关系）
const origMap = {};
for (const s of legado) { origMap[s.bookSourceUrl] = JSON.stringify({ ruleToc: s.ruleToc, ruleSearch: s.ruleSearch, ruleContent: s.ruleContent, ruleBookInfo: s.ruleBookInfo }); }
for (const s of ranked) {
    const key = s.bookSourceUrl;
    if (!origMap[key]) { errors.push('ranked 中出现原 legado 没有的 URL: ' + key); continue; }
    const nr = JSON.stringify({ ruleToc: s.ruleToc, ruleSearch: s.ruleSearch, ruleContent: s.ruleContent, ruleBookInfo: s.ruleBookInfo });
    if (origMap[key] !== nr) { errors.push('URL=' + key + ' 的规则子字段有变化'); }
}

if (errors.length > 0) {
    console.error('❌ 校验失败:');
    errors.forEach(e => console.error('  - ' + e));
    process.exit(1);
}

// ====== 写输出 ======
fs.writeFileSync(OUT_RANKED, JSON.stringify(ranked, null, 2), 'utf8');

// 排名报告（Markdown）
let report = '# legado.json 排名报告\n\n';
report += `生成时间: ${new Date().toISOString()}\n`;
report += `测试书籍: ${books.length} 本 (${books.map(b => b.title + '(' + b.reference + ')').join(', ')})\n`;
report += `总源数: ${ranked.length}\n\n`;

report += '## 分组统计\n\n';
const groupNames = ['HIGH_PERFORMER', 'GOOD', 'GOOD_MINOR', 'NEUTRAL', 'UNDERPERFORMER+降级', 'ALMOST_EMPTY'];
const groups = [[], [], [], [], [], []];
for (const name of orderedNames) { groups[groupRank(name)].push(name); }
for (let g = 0; g < 6; g++) {
    report += `- **${groupNames[g]}**: ${groups[g].length} 源\n`;
}
report += '\n';

report += '## HIGH_PERFORMER（positiveRatio ≥ 0.75 且 tested ≥ 3，boost +1000 weight）\n\n';
for (const name of groups[0]) {
    const sc = sourceScores[name];
    report += `- **${name}** score=${sc.final_score.toFixed(2)} ratio=${sc.positiveRatio.toFixed(2)} tested=${sc.tested} | ${sc.diffs.map(d => d.diff).join('/')}\n`;
}
report += '\n';

report += '## GOOD（positiveRatio ≥ 0.60 且 tested ≥ 2）\n\n';
for (const name of groups[1]) {
    const sc = sourceScores[name];
    report += `- **${name}** score=${sc.final_score.toFixed(2)} ratio=${sc.positiveRatio.toFixed(2)} tested=${sc.tested} | ${sc.diffs.map(d => d.diff).join('/')}\n`;
}
report += '\n';

report += '## GOOD_MINOR（单本好但置信度不足 tested=1）\n\n';
for (const name of groups[2]) {
    const sc = sourceScores[name];
    report += `- **${name}** score=${sc.final_score.toFixed(2)} | ${sc.diffs.map(d => d.diff).join('/')}\n`;
}
report += '\n';

report += '## UNDERPERFORMER / 降级候选（保留但降权）\n\n';
report += '| 源 | score | ratio | tested | 标签 | weight× | 跨书表现 |\n|---|---|---|---|---|---|---|\n';
const under = new Set([...groups[4], ...groups[5]]);
for (const name of orderedNames) {
    if (!under.has(name)) continue;
    const sc = sourceScores[name];
    const { tags, weightMult } = classifySource(name, sc);
    const tagStr = tags.filter(t => ['SEVERE_LAGGING', 'SUSPICIOUS_TRUNCATION', 'ALMOST_EMPTY', 'DORMANT_RULE', 'UNDERPERFORMER'].includes(t)).join(',');
    const diffs = sc.diffs.map(d => `${d.book.slice(0,4)}=${d.diff}`).join(' ');
    report += `| ${name} | ${sc.final_score.toFixed(2)} | ${sc.positiveRatio.toFixed(2)} | ${sc.tested} | ${tagStr} | ×${weightMult} | ${diffs} |\n`;
}
report += '\n';

report += '## 校验\n\n';
report += `- 源数量一致: ✅ ${legado.length} → ${ranked.length}\n`;
report += `- nextTocUrl 规则保留: ✅ ${origToc} → ${rankToc}\n`;
report += `- URL 唯一率一致: ✅ ${origUrls.size} → ${rankUrls.size}\n`;
report += `- 规则子字段零变化: ✅\n`;
report += `- 原始 legado.json 未修改: ✅\n\n`;

report += '## 下一步\n\n';
report += '1. 审查排名报告，确认分组是否符合预期\n';
report += '2. 对比 ranked-legado.json 与原 legado.json 的 diff\n';
report += '3. 手动（或经 CI 审查后）替换生产源文件\n';
report += '4. 不自动替换——rank-legado.js 只产出候选文件\n';

fs.writeFileSync(OUT_REPORT, report, 'utf8');

// 控制台
console.log('✅ rank-legado.js 执行成功');
console.log('  源数量: ' + ranked.length);
console.log('  分组: HIGH=' + groups[0].length + ' GOOD=' + groups[1].length + ' GOOD_MINOR=' + groups[2].length + ' NEUTRAL=' + groups[3].length + ' UNDER=' + groups[4].length + ' ALMOST=' + groups[5].length);
console.log('  输出: ranked-legado.json + reports/rank-report.md');
console.log('  原始 legado.json: 未修改 ✅');
console.log('  校验: ' + (errors.length === 0 ? '全部通过 ✅' : '❌ 失败'));

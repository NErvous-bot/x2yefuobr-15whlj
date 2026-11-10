/**
 * 标定工具：为一本书在多个真实书源上实测「目录章节数」，取多源收敛值，
 * 用来校准 scripts/pick-books.js 里 CONST_REF 的 reference。
 *
 * 为什么必须多源收敛：单个源可能分页截断，报出的是「页面上限」而不是
 * 真实章节数。历史教训：
 *   《剑来》     初填 1100 → 实测 9 源收敛 1307-1309，1100 是截断值
 *   《斗罗大陆》 被判 400  → 那是 20 页 × 20 条的上限，真值 336
 * 单源取值会把「正确的源」判成「落后 25%」，进而误删好书源。
 *
 * 复用 freshness-audit.js 的 getToc（完整分页状态机），
 * 只在 terminal_reason=VERIFIED_END 或明确可信的源上取数。
 *
 * 用法：
 *   node scripts/calibrate-reference.js "斗罗大陆"
 *   node scripts/calibrate-reference.js "斗罗大陆" --sources 30
 *
 * 输出：逐源结果 + 众数/中位数 + 是否可信的结论。
 */
'use strict';
const fs = require('fs');
const { doSearch, originOf } = require('../aging-test');
const { getToc, pickBookForTitle } = require('../freshness-audit');

// 选「结构上可测」的源：跳过 JS 规则与无搜索入口（它们必然空转）
function pickSources(limit) {
  const list = JSON.parse(fs.readFileSync('legado.json', 'utf8'));
  const out = [];
  for (const s of list) {
    const su = String(s.searchUrl || '');
    const ru = (s.ruleSearch && s.ruleSearch.url) || '';
    if (/<js>|@js:|java\./i.test(su + ' ' + ru)) continue;
    if (!su.trim() && !ru.trim()) continue;
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function hostOf(s) {
  try {
    return new URL(s.bookSourceUrl).host;
  } catch (e) {
    return '?';
  }
}

async function probeOne(source, title) {
  const t0 = Date.now();
  const base = originOf(source.searchUrl) || source.bookSourceUrl;
  const rs = source.ruleSearch || {};

  let r1;
  try {
    r1 = await doSearch(source, base, rs, title);
  } catch (e) {
    return { ok: false, reason: '搜索异常 ' + e.message };
  }
  if (r1.skip) return { ok: false, reason: r1.skip };
  if (r1.dead) return { ok: false, reason: r1.dead };
  if (!r1.bl || !r1.bl.items.length) return { ok: false, reason: '搜索无结果' };

  const pick = pickBookForTitle(r1, source, base, title);
  if (!pick || !pick.url) return { ok: false, reason: (pick && pick.fail) || '无法构造书籍URL' };

  let toc;
  try {
    toc = await getToc(source, pick.url, { timeBudgetMs: 90000 });
  } catch (e) {
    return { ok: false, reason: '目录异常 ' + e.message };
  }
  if (toc.status !== 'ok' || !(toc.chapters > 0)) {
    return { ok: false, reason: '目录不可用(' + (toc.status || '?') + ')' };
  }

  // 只用「分页可信」的样本参与标定
  const trust = toc.pagination_trust || 'UNKNOWN';
  const term = toc.terminal_reason || '';
  const reliable = term === 'VERIFIED_END' || trust === 'HIGH' || trust === 'TRUSTED';

  return {
    ok: true,
    chapters: toc.chapters,
    terminal: term,
    trust,
    reliable,
    pages: toc.pages || 0,
    ms: Date.now() - t0,
    name: source.bookSourceName,
    host: hostOf(source),
  };
}

// 多源收敛：取众数；平票取较小值（宁可低估，不把正确源判落后）
function converge(values) {
  if (!values.length) return null;
  const cnt = new Map();
  for (const v of values) cnt.set(v, (cnt.get(v) || 0) + 1);
  let best = null;
  let bestN = 0;
  for (const [v, c] of cnt) {
    if (c > bestN || (c === bestN && v < best)) {
      best = v;
      bestN = c;
    }
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mode: best,
    modeCount: bestN,
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
    n: values.length,
  };
}

async function calibrate(title, sourceLimit) {
  console.log('\n━━━ 标定《' + title + '》━━━');
  const sources = pickSources(sourceLimit);
  console.log('参与标定源数：' + sources.length);

  const results = [];
  const CONC = 8;
  let i = 0;
  async function worker() {
    while (i < sources.length) {
      const s = sources[i++];
      const r = await probeOne(s, title);
      results.push(r);
      if (r.ok) {
        console.log(
          '  ✓ ' + r.name + ' [' + r.host + '] → ' + r.chapters +
          ' 章  ' + (r.reliable ? '可信' : '截断?' + r.terminal) +
          '  pages=' + r.pages + '  ' + r.ms + 'ms'
        );
      } else {
        console.log('  ✗ ' + s.bookSourceName + ' → ' + r.reason);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  const all = results.filter((r) => r.ok).map((r) => r.chapters);
  const onlyReliable = results.filter((r) => r.ok && r.reliable).map((r) => r.chapters);
  const pool = onlyReliable.length >= 3 ? onlyReliable : all;
  const basis = onlyReliable.length >= 3 ? '仅可信样本' : '全部样本(可信样本不足)';

  const conv = converge(pool);
  if (!conv) {
    console.log('  ⚠ 无可信样本，无法标定');
    return null;
  }
  console.log('\n  收敛（' + basis + '）：众数 ' + conv.mode +
    '（' + conv.modeCount + '/' + conv.n + ' 源一致）');
  console.log('    中位 ' + conv.median + '，范围 ' + conv.min + '~' + conv.max);

  return { title, reference: conv.mode, basis, ...conv };
}

(async () => {
  const args = process.argv.slice(2);
  const si = args.indexOf('--sources');
  const sourceLimit = si >= 0 ? Number(args[si + 1]) : 24;
  const title = args.find((a, k) => !a.startsWith('--') && (si < 0 || k !== si + 1));

  if (!title) {
    console.error('用法: node scripts/calibrate-reference.js "书名" [--sources 24]');
    process.exit(1);
  }
  const r = await calibrate(title, sourceLimit);
  if (r) {
    console.log('\n  ▶ 建议 reference = ' + r.reference);
  }
})();

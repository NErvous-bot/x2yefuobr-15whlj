'use strict';
/**
 * 静态比对：外来书源包 vs 仓库现有 legado.json
 * 只看身份与结构，不做网络请求。输出分类清单供下一步实测。
 */
const fs = require('fs');

const P = process.argv[2];
const raw = JSON.parse(fs.readFileSync(P, 'utf8'));
const incoming = Array.isArray(raw) ? raw : raw.bookSources;

const repo = JSON.parse(fs.readFileSync('legado.json', 'utf8'));

// 与仓库同口径的身份键：去掉 #fragment、去尾部斜杠
const norm = (u) =>
  String(u || '')
    .replace(/#.*$/, '')
    .replace(/\/+$/, '')
    .trim();

const repoByKey = new Map();
for (const s of repo) {
  const k = norm(s.bookSourceUrl);
  if (k) repoByKey.set(k, s);
}

// 主机名归并（同一站点不同路径/参数是常见的"同站多源"）
const hostOf = (u) => {
  try {
    return new URL(norm(u)).host.toLowerCase().replace(/^www\./, '');
  } catch (e) {
    return '';
  }
};
const repoHosts = new Map();
for (const s of repo) {
  const h = hostOf(s.bookSourceUrl);
  if (!h) continue;
  if (!repoHosts.has(h)) repoHosts.set(h, []);
  repoHosts.get(h).push(s);
}

const cats = {
  exact: [],       // URL 完全相同 → 仓库已有，跳过
  sameHost: [],    // 同站点不同 URL → 需人工判断是否同一源
  fresh: [],       // 全新
  invalid: [],     // URL 无效
};

const seenIncoming = new Map();
let skippedDup = 0;
for (const s of incoming) {
  const k = norm(s.bookSourceUrl);
  if (!k || !/^https?:\/\//i.test(k)) {
    cats.invalid.push(s);
    continue;
  }
  // 包内自身去重：按原始 URL 判重（norm 会把 #fragment 去掉，
  // 但 # 后缀在本仓库是「同站不同变体」的合法区分手段，不能合并）
  const rawKey = String(s.bookSourceUrl || '').trim();
  if (seenIncoming.has(rawKey)) {
    skippedDup++;
    continue;
  }
  seenIncoming.set(rawKey, s);

  if (repoByKey.has(k)) {
    cats.exact.push(s);
    continue;
  }
  const h = hostOf(k);
  if (h && repoHosts.has(h)) {
    cats.sameHost.push({ incoming: s, existing: repoHosts.get(h) });
    continue;
  }
  cats.fresh.push(s);
}

console.log('━━━━━━ 静态比对结果 ━━━━━━');
console.log('外来包条目      : ' + incoming.length);
console.log('包内去重后      : ' + seenIncoming.size + '（跳过重复 ' + skippedDup + '）');
console.log('');
console.log('  URL 完全相同（仓库已有）: ' + cats.exact.length);
console.log('  同站点但 URL 不同      : ' + cats.sameHost.length);
console.log('  全新源                 : ' + cats.fresh.length);
console.log('  无效 URL               : ' + cats.invalid.length);

// 全新源的结构画像：有多少能在 CI 里测（无 JS）
const isJs = (s) => {
  const f = [s.searchUrl, s.exploreUrl, s.header, s.jsLib, s.mainJs];
  for (const b of [s.ruleSearch, s.ruleToc, s.ruleContent, s.ruleBookInfo, s.ruleExplore]) {
    if (b && typeof b === 'object') for (const v of Object.values(b)) f.push(v);
  }
  return f.some((x) => typeof x === 'string' && /<js>|@js:|java\./i.test(x));
};
const freshJs = cats.fresh.filter(isJs).length;
const freshNoSearch = cats.fresh.filter((s) => {
  const su = String(s.searchUrl || '').trim();
  const ru = (s.ruleSearch && s.ruleSearch.url) || '';
  return !su && !String(ru).trim();
}).length;

console.log('');
console.log('全新源结构画像：');
console.log('  含 JS（CI 测不出）      : ' + freshJs);
console.log('  无搜索入口（根本测不了）: ' + freshNoSearch);
console.log('  结构上可测              : ' + (cats.fresh.length - freshJs - freshNoSearch));

// 同站点冲突明细（前 15 组）
console.log('\n━━━ 同站点冲突（前 15 组）━━━');
cats.sameHost.slice(0, 15).forEach(({ incoming: a, existing }) => {
  console.log('外来: ' + (a.bookSourceName || '?') + '  ' + a.bookSourceUrl);
  existing.slice(0, 2).forEach((b) =>
    console.log('  仓库已有: ' + b.bookSourceName + '  ' + b.bookSourceUrl)
  );
});

// 落盘供下一步实测
fs.mkdirSync('reports/import', { recursive: true });
fs.writeFileSync('reports/import/fresh.json', JSON.stringify(cats.fresh, null, 1));
fs.writeFileSync(
  'reports/import/summary.json',
  JSON.stringify(
    {
      incoming: incoming.length,
      deduped: seenIncoming.size,
      exact: cats.exact.length,
      sameHost: cats.sameHost.length,
      fresh: cats.fresh.length,
      invalid: cats.invalid.length,
      freshJs,
      freshNoSearch,
    },
    null,
    1
  )
);
console.log('\n已写 reports/import/fresh.json（' + cats.fresh.length + ' 条待实测）');

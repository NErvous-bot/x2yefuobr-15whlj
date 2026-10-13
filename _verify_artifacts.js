const fs = require('fs');
const path = require('path');

const REPO = __dirname;

// 1. legado.json 结构抽样
console.log('═══════════ 1. legado.json 结构 ═══════════');
const legado = JSON.parse(fs.readFileSync(path.join(REPO, 'legado.json'), 'utf8'));
console.log('总源数:', legado.length);
console.log('第一个源的所有字段:', Object.keys(legado[0]).sort().join(', '));
console.log('\n前 3 个源简化结构:');
for (let i = 0; i < Math.min(3, legado.length); i++) {
    const s = legado[i];
    console.log(`  [${i}] ${s.bookSourceName} | tocRule=${!!(s.ruleToc || s.rule?.toc)} | searchRule=${!!(s.ruleSearch || s.rule?.search)} | url=${String(s.bookSourceUrl || '').slice(0,40)}`);
}
// 统计有哪些字段
const allKeys = new Set();
for (const s of legado) {
    if (s.ruleToc) Object.keys(s.ruleToc).forEach(k => allKeys.add('toc.' + k));
    if (s.ruleSearch) Object.keys(s.ruleSearch).forEach(k => allKeys.add('search.' + k));
    if (s.ruleBookInfo) Object.keys(s.ruleBookInfo).forEach(k => allKeys.add('bookInfo.' + k));
    if (s.ruleContent) Object.keys(s.ruleContent).forEach(k => allKeys.add('content.' + k));
}
console.log('\nruleToc 子字段:', [...allKeys].filter(k => k.startsWith('toc.')).sort().join(', '));
console.log('ruleSearch 子字段:', [...allKeys].filter(k => k.startsWith('search.')).sort().join(', '));

// 2. freshness-summary.json 完整字段
console.log('\n═══════════ 2. freshness-summary.json 结构 ═══════════');
const summary = JSON.parse(fs.readFileSync(path.join(REPO, 'reports', 'freshness-summary.json'), 'utf8'));
console.log('顶层字段:', Object.keys(summary).join(', '));
const firstBook = Object.values(summary.books)[0];
console.log('\nbook 级字段:', Object.keys(firstBook).sort().join(', '));
const firstSource = firstBook.bySource[0];
console.log('bySource 条目字段:', Object.keys(firstSource).sort().join(', '));
console.log('\nbySource 示例:', JSON.stringify(firstSource, null, 2).slice(0, 400));

// 3. CSV 头 + 第一行
console.log('\n═══════════ 3. freshness-details.csv ═══════════');
const csv = fs.readFileSync(path.join(REPO, 'reports', 'freshness-details.csv'), 'utf8').split('\n');
console.log('CSV 行数:', csv.length - 1);
console.log('表头:', csv[0]);
console.log('第 1 行:', csv[1]?.slice(0, 200));
console.log('第 2 行:', csv[2]?.slice(0, 200));

// 4. books.json
console.log('\n═══════════ 4. books.json ═══════════');
const books = JSON.parse(fs.readFileSync(path.join(REPO, 'books.json'), 'utf8'));
for (const b of books) {
    console.log(`  ${b.title} (key=${b.key}) reference=${b.reference}`);
}

console.log('\n═══════════ 证据核对完成 ═══════════');

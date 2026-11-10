'use strict';
/**
 * 把 reports/import/fresh.json（1945 条全量源，11.8MB）精简成
 * 「供 CI 复现的候选清单」——只留实测必需的字段，体积降一个数量级。
 *
 * 为什么不全量提交：11.8MB 的中间产物进仓库会让 clone 变慢、
 * 而且它是可重建的（import-compare.js 从原包重新生成）。
 * 提交的应该是「可复现的最小输入」。
 */
const fs = require('fs');

const full = JSON.parse(fs.readFileSync('reports/import/fresh.json', 'utf8'));
const { isAdult } = require('./adult-filter');
const BLOCK_TAGS = /(人机验证|搜索暂不可用|需登录|梯子|被封|反爬|滑块|Cloudflare)/i;

// 实测必需字段：搜索/目录/正文三条规则 + 身份
const KEEP = [
  'bookSourceUrl',
  'bookSourceName',
  'bookSourceGroup',
  'bookSourceType',
  'bookUrlPattern',
  'header',
  'searchUrl',
  'ruleSearch',
  'ruleBookInfo',
  'ruleToc',
  'ruleContent',
  'exploreUrl',
  'ruleExplore',
  'enabledCookieJar',
  'concurrentRate',
  'bookSourceComment',
];

let adult = 0;
let block = 0;
let incomplete = 0;
const slim = [];
for (const s of full) {
  if (isAdult(s)) {
    adult++;
    continue;
  }
  if (BLOCK_TAGS.test((s.bookSourceGroup || '') + ' ' + (s.bookSourceComment || ''))) {
    block++;
    continue;
  }
  if (!s.searchUrl || !s.ruleToc?.chapterList || !s.ruleContent?.content) {
    incomplete++;
    continue;
  }
  const o = {};
  for (const k of KEEP) {
    if (s[k] !== undefined && s[k] !== null && s[k] !== '') o[k] = s[k];
  }
  slim.push(o);
}

fs.writeFileSync('reports/import/candidates.json', JSON.stringify(slim, null, 0));
console.log('原始 ' + full.length + ' 条');
console.log('  排除成人向: ' + adult);
console.log('  排除屏蔽词: ' + block);
console.log('  排除结构不全: ' + incomplete);
console.log('精简后: ' + slim.length + ' 条');
const before = fs.statSync('reports/import/fresh.json').size;
const after = fs.statSync('reports/import/candidates.json').size;
console.log('体积: ' + (before / 1048576).toFixed(1) + 'MB → ' + (after / 1048576).toFixed(1) + 'MB');

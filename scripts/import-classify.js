'use strict';
/**
 * 把 646 组「同站点」冲突按「是否真的同一书源」重新分类。
 *
 * 关键：canonical 必须同时抹掉三个差异，否则会把同一书源判成冲突：
 *   1) #fragment —— 本仓库用它标记同站变体（#🎃 / #響海 / ##作者名）
 *   2) 尾斜杠
 *   3) 协议（http/https 很多站是同一份内容）
 */
const fs = require('fs');

function canonical(u) {
  let s = String(u || '').trim().toLowerCase();
  s = s.replace(/#[\s\S]*$/, '');
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/\/+$/, '');
  return s.trim();
}

const conflicts = JSON.parse(fs.readFileSync('reports/import/host-conflicts.json', 'utf8'));

const sameSource = [];   // 抹平后同一身份 → 重复，导入时跳过
const realConflict = []; // 抹平后仍不同 → 需人工/实测判断
const comparable = [];   // 仅协议或尾斜杠不同 → 可视为同源，但字段可能有更新

for (const x of conflicts) {
  const a = canonical(x.incoming.url);
  const hits = x.existing.filter((e) => canonical(e.url) === a);
  if (hits.length) {
    sameSource.push({ incoming: x.incoming, existing: hits });
    continue;
  }
  // 再试一次：只差协议（http vs https）
  const noProto = (v) => canonical(v);
  const nearHit = x.existing.filter((e) => {
    const b = noProto(e.url);
    return b === a;
  });
  if (nearHit.length) {
    sameSource.push({ incoming: x.incoming, existing: nearHit });
  } else {
    realConflict.push(x);
  }
}

console.log('━━━ 646 组同站点冲突重新分类 ━━━');
console.log('  实际同一书源（仅 #tag/斜杠/协议差异）:', sameSource.length, '← 导入时跳过');
console.log('  真冲突（同域名不同路径，需判断）    :', realConflict.length);

fs.writeFileSync('reports/import/dup-same.json', JSON.stringify(sameSource, null, 1));
fs.writeFileSync('reports/import/real-conflicts.json', JSON.stringify(realConflict, null, 1));

console.log('\n=== 真冲突样例（前 12）===');
realConflict.slice(0, 12).forEach((x, i) => {
  console.log((i + 1) + '. 外来: ' + x.incoming.name + '  ' + x.incoming.url);
  x.existing.slice(0, 2).forEach((e) => console.log('    仓库: ' + e.name + '  ' + e.url));
});

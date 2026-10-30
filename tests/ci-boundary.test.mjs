import fs from 'node:fs';
import path from 'node:path';

// CI 权限边界回归测试 —— 锁死「执行外部书源 JS」与「持有写权限 + 签名私钥」
// 这两件事永远不落在同一个 workflow 里。
//
// 说明：本仓库坚持零第三方依赖，因此这里不引入 yaml 解析库，
// 用精简的文本断言检查 YAML 里的关键字段。断言都是「必须出现 / 不得出现」
// 的强条件，不依赖缩进推断，避免误判。

const WF = '.github/workflows';
let pass = 0;
let fail = 0;

const ok = (n) => { pass++; console.log('  ✅ ' + n); };
const bad = (n, m) => { fail++; console.log('  ❌ ' + n + '  ->  ' + m); };

function read(file) {
  return fs.readFileSync(path.join(WF, file), 'utf8');
}

/** 抓顶层 permissions 块的 contents 值（只看文件里第一个 permissions:） */
function topContents(text) {
  const m = /^permissions:\s*\n(?:[ \t]+\S.*\n)*?[ \t]+contents:\s*(\w+)/m.exec(text);
  return m ? m[1] : null;
}

/** 是否存在任意 job 级 permissions.contents: write */
function hasJobWrite(text) {
  return /jobs:[\s\S]*?[ \t]+contents:\s*write/.test(text);
}

console.log('=== CI 权限边界回归 ===\n');

// ① js-eval.yml 必须是低权限隔离环境
if (fs.existsSync(path.join(WF, 'js-eval.yml'))) {
  const t = read('js-eval.yml');
  const tc = topContents(t);
  if (tc === 'read') ok('js-eval.yml 顶层 contents: read'); else bad('js-eval.yml contents', '应为 read，实际 ' + tc);
  if (/persist-credentials:\s*false/.test(t)) ok('js-eval.yml 关闭了凭据持久化'); else bad('js-eval.yml persist-credentials', '应设 false');
  if (/HEALTH_JS_SCOPE:\s*['"]?1['"]?/.test(t)) ok('js-eval.yml 显式授权 JS 求值'); else bad('js-eval.yml HEALTH_JS_SCOPE', '应设 1');
  if (!/secrets\./.test(t)) ok('js-eval.yml 不引用任何 secrets'); else bad('js-eval.yml secrets', '不得引用 secrets');
} else {
  bad('js-eval.yml', '文件不存在');
}

// ② update.yml 不得授权 JS 求值
if (fs.existsSync(path.join(WF, 'update.yml'))) {
  const t = read('update.yml');
  if (!/HEALTH_JS_SCOPE/.test(t)) ok('update.yml 未授权 JS 求值（写权限 job 不执行外部代码）');
  else bad('update.yml HEALTH_JS_SCOPE', '写权限 job 不得设置该变量');
} else {
  bad('update.yml', '文件不存在');
}

// ③ 所有有写权限的 workflow 必须关闭凭据持久化
for (const f of fs.readdirSync(WF).filter((x) => x.endsWith('.yml'))) {
  const t = read(f);
  const write = topContents(t) === 'write' || hasJobWrite(t);
  if (!write) continue;
  if (/persist-credentials:\s*false/.test(t)) ok(f + ' 写权限 + 关闭凭据持久化');
  else bad(f + ' persist-credentials', '有写权限时必须设 false');
}

// ④ 写权限 + 执行 health/filter 时，必须没有授权 JS 求值
for (const f of fs.readdirSync(WF).filter((x) => x.endsWith('.yml'))) {
  const t = read(f);
  const write = topContents(t) === 'write' || hasJobWrite(t);
  const runsEval = /node health\.js|node filter\.js/.test(t);
  if (!(write && runsEval)) continue;
  if (!/HEALTH_JS_SCOPE/.test(t)) ok(f + ' 有写权限但未授权 JS 求值（闸门生效）');
  else bad(f + ' 危险组合', '有写权限 + 授权 JS 求值');
}

// ⑤ 产物出口脚本存在
if (fs.existsSync('scripts/export-health-json.js')) ok('scripts/export-health-json.js 存在');
else bad('export-health-json.js', '缺失');

console.log(`\n===== 汇总: ${pass + fail} 项 =====`);
console.log('✅ 通过: ' + pass);
console.log('❌ 失败: ' + fail);
process.exit(fail === 0 ? 0 : 1);

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

// ⑥ 三态语义回归：不可测（health=null）不得被判成 broken
//
// 背景：health.js 的 gatesOf() 里 content: ok（ok=usable===true），所以一个
// 「不可测」的源拿到的 content 也是 false。导出器若优先判 content===false→broken，
// 就会把「测不了」当成「坏了」，导致 score.js 把它降到 dead 层、甚至推进隔离池。
// 实测一轮里这类源有 104 个（JS需要联网/动态语法等），属于会静默误伤的口径 bug。
// 这里把导出器的判定函数单独拉出来跑真实用例，锁死三态。
{
  // 导出脚本以 CLI 形式运行（main() 在导入时即执行），不能直接 import 内部函数，
  // 因此这里对判定函数的源码做顺序断言：必须先用 health 判 untestable，再判 content。
  const src = fs.readFileSync('scripts/export-health-json.js', 'utf8');
  const fn = /function safeState\(v\)\s*\{([\s\S]*?)\n\}/.exec(src);
  if (!fn) {
    bad('safeState 判定函数', '未能解析');
  } else {
    const body = fn[1];
    const healthFirst = body.indexOf('v.health === null') >= 0 || body.indexOf('v.health === undefined') >= 0;
    const beforeContent = healthFirst &&
      body.indexOf('v.health') < body.indexOf('v.content === false');
    if (healthFirst && beforeContent) {
      ok('safeState 先判 health=null → untestable（不可测不误判成坏了）');
    } else {
      bad('safeState 三态顺序', '必须先用 health===null 判 untestable，再判 content');
    }
    if (/untestable/.test(body)) ok('safeState 保留 untestable 态'); else bad('safeState', '缺少 untestable 分支');
  }
}

// ⑦ 生产侧导入时必须接受 untestable（否则隔离 job 产出的三态会被拒收）
{
  const upd = read('update.yml');
  if (/untestable/.test(upd)) ok('update.yml 导入侧接受 untestable 态');
  else bad('update.yml 三态', '导入校验必须允许 untestable');
}

// ⑦b 对账必须用 norm() 身份键，不能用裸 bookSourceUrl
//
// 背景（同一个 run 41184777297 暴露的第二处不兼容）：
//   health.js 写 health/source_health.json 的 sources 键是 norm(bookSourceUrl)
//   （src/source-id.js：去 #fragment、去 pathname 尾斜杠）。本仓库 694 个成品源里
//   有 370 个 URL 带 # 或尾斜杠，于是 update.yml 用裸串 known.has(r.url) 比对时
//   会把 372 行判成 'result url not in product' —— 即便上游 key-set 修好，这一关
//   照样整轮失败。两处必须共用同一个身份键定义。
{
  const upd = read('update.yml');
  if (/require\(['"]\.\/src\/source-id['"]\)/.test(upd) && /norm\(/.test(upd)) {
    ok('update.yml 用 norm() 构造身份键（不是裸 bookSourceUrl）');
  } else {
    bad('update.yml 对账键空间', '必须 require src/source-id 并用 norm() 比对');
  }
  if (/known\.add\(String\(s\.bookSourceUrl\)\)/.test(upd)) {
    bad('update.yml 仍用裸 URL 建 known 集合', '已知会把带 # / 尾斜杠的源全部拒收');
  } else {
    ok('update.yml 不再用裸 URL 建 known 集合');
  }
}

// ⑦c eval 与 update 不是同一时刻的快照：对账必须是「交集」，不能要求全命中
//
// 背景（run 41193341145，修好 ⑦b 之后暴露的第三处缺陷）：
//   eval job 在 filter.js **之前** checkout 并测源（694 个）；
//   update job 随后跑 filter.js（上游合并 / 死域名剔除 / 老化复测 / 隔离池过滤），
//   成品会变：实测该轮 filter 删掉了 https://newsmiss.lofter.com 等源。
//   若对账写成「每一行都必须在成品里」，这些**本该被删**的源会把整轮发布阻断 ——
//   run 41193341145 就是这样在 'result url not in product: https://newsmiss.lofter.com' 处崩掉。
//   正确语义：命不中的行丢弃（它们本轮已不在成品），但必须有命中行，
//   否则判定产物与成品脱节（快照过旧 / 认错仓库 / 产物污染），仍然 fail-closed。
{
  const upd = read('update.yml');
  if (/result url not in product/.test(upd) && /throw new Error\('result url not in product'/.test(upd)) {
    bad('update.yml 仍要求每行都命中成品', 'eval 快照早于 filter，被删源会整轮阻断');
  } else {
    ok('update.yml 不再要求结果每一行都命中成品');
  }
  if (/dropped\+\+/.test(upd) && /no result row matched the current product/.test(upd)) {
    ok('update.yml 丢弃未命中行，并在零命中时 fail-closed');
  } else {
    bad('update.yml 交集语义', '应有 dropped++ 计数与零命中时的明确失败');
  }
  // broken 占比的分母必须是「真正落库的行数」，不是产物总行数
  if (/const total=Object\.keys\(sources\)\.length/.test(upd)) {
    ok('broken 占比分母用落库行数（不含被丢弃行）');
  } else {
    bad('broken 占比分母', '应为 Object.keys(sources).length');
  }
}

// ⑧ 产物顶层字段契约：两侧必须用**同一份** expectedTop
//
// 背景（run 41184777297 / #68，2026-10-31 真实的整轮失败）：
//   scripts/export-health-json.js 的 payload 输出了 4 个顶层键
//   （version / generatedAt / totalSources / results），
//   update.yml 侧的 expectedTop 也已是这 4 个键，
//   但 js-eval.yml 的自检仍写着旧的三键 'generatedAt,results,version'。
//   于是「产物完全合规」却在隔离 job 的边界校验处抛
//   unexpected keys: generatedAt,results,totalSources,version，
//   后续 upload-artifact 被跳过、update job 直接 skipped，整轮更新作废。
//
// 教训与修法：字段集合是**跨 job 的单一契约**，不能在两处各写一份字面量。
// 这里的断言就是那个单一真源 —— 任何一侧改了键集而没同步，CI 立刻红。
{
  const upd = read('update.yml');
  const jeval = read('js-eval.yml');

  /** 从某文件里抓 expectedTop 的字面量（单引号或双引号） */
  const grab = (t, label) => {
    const m = /expectedTop\s*=\s*(['"])([^'"]*)\1/.exec(t);
    if (!m) return null;
    return { label, value: m[2] };
  };

  const a = grab(upd, 'update.yml');
  const b = grab(jeval, 'js-eval.yml');

  if (!a) bad('update.yml expectedTop', '未找到 expectedTop 字面量');
  else ok('update.yml 定义了 expectedTop = ' + a.value);

  if (!b) bad('js-eval.yml expectedTop', '未找到 expectedTop（边界校验必须与生产侧同口径）');
  else ok('js-eval.yml 定义了 expectedTop = ' + b.value);

  if (a && b) {
    if (a.value === b.value) ok('两侧 expectedTop 完全一致');
    else bad('expectedTop 两侧不一致', 'js-eval=' + b.value + ' / update=' + a.value);
  }

  // 导出脚本实际产出的顶层键必须就是这个集合
  const src = fs.readFileSync('scripts/export-health-json.js', 'utf8');
  const payload = /const payload = \{([\s\S]*?)\n\s*\};/.exec(src);
  if (!payload) {
    bad('export-health-json payload', '未能解析 payload 字面量');
  } else {
    const keys = [...payload[1].matchAll(/\n\s*([A-Za-z0-9_]+)\s*:/g)].map((m) => m[1]);
    const actual = keys.slice().sort().join(',');
    if (a && actual === a.value) ok('导出脚本产出的键集与 expectedTop 一致');
    else bad('导出/校验键集不一致', '导出=' + actual + ' / expected=' + (a ? a.value : '?'));
  }
}

// ⑨ 跨权限边界字段的三处同步（run 72/73 连踩两次的真实事故）
//
// 数据要穿过两道白名单才到生产侧：
//   health.js 产出 → scripts/export-health-json.js 白名单 → update.yml 重建白名单
// 任何一处没加新字段，下游拿到就是 undefined/0/''，且**不报错**。
// 实测后果：ipBlocked 在 eval 侧生成了 94 个，但导出器白名单没加这一项，
// 生产侧 ipBlocked 恒为 0，score.js 的 160/130 分档完全没生效，白跑两轮。
//
// 这里从 health.js 实际写入 sources 的键出发，逐个检查是否同时出现在两处白名单里。
{
  const healthSrc = fs.readFileSync('health.js', 'utf8');
  const exportSrc = fs.readFileSync('scripts/export-health-json.js', 'utf8');
  const updSrc = read('update.yml');

  const block = /sources\[k\] = \{([\s\S]*?)\n        \};/.exec(healthSrc);
  if (!block) {
    bad('health.js sources 结构', '未能解析写入字段');
  } else {
    const written = [...block[1].matchAll(/\n\s+([A-Za-z0-9_]+)\s*:/g)].map((m) => m[1]);
    const uniq = [...new Set(written)];
    const missingExport = uniq.filter((k) => !new RegExp('\\n\\s+' + k + ':\\s').test(exportSrc));
    const missingRebuild = uniq.filter((k) => !new RegExp('\\n\\s+' + k + ':\\s').test(updSrc));

    if (missingExport.length) bad('导出器字段白名单缺项', 'health.js 写了但 export 没导出：' + missingExport.join(', '));
    else ok('导出器覆盖 health.js 写入的全部 ' + uniq.length + ' 个字段');

    if (missingRebuild.length) bad('update.yml 重建白名单缺项', 'health.js 写了但生产侧没重建：' + missingRebuild.join(', '));
    else ok('update.yml 重建覆盖 health.js 写入的全部字段');
  }
}

console.log(`\n===== 汇总: ${pass + fail} 项 =====`);
console.log('✅ 通过: ' + pass);
console.log('❌ 失败: ' + fail);
process.exit(fail === 0 ? 0 : 1);

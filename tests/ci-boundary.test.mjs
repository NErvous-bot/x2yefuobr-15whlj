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

// ============================================================
// ⑨ 跨轮次账本必须真的能跨轮 —— 两个断链都要锁死
// ------------------------------------------------------------
// 实证后果（2026-11-10）：
//   a) 账本文件没进 `git add` → 每个 CI run 从空账本起步，rounds 永远 1，
//      last_valid_round / 连续失败 / 未测优先全部失效，四层账本白做。
//   b) freshness-audit.js 在主循环之后才读账本 → 只能「记录」不能
//      「影响抽样」，「长期未测源优先」从未生效。
//   两条都必须有断言，否则以后改回去没人发现。
{
  const src = fs.readFileSync('freshness-audit.js', 'utf8');
  const yml = read('source-audit.yml');

  // a) 账本入库
  if (/git add[^\n]*freshness-ledger\.json/.test(yml)) ok('source-audit.yml 提交 freshness-ledger.json（账本可跨轮）');
  else bad('账本未入库', 'git add 缺 freshness-ledger.json → rounds 每轮归 1，账本失效');

  // b) 账本在主循环之前加载
  const loopIdx = src.search(/for \(const \[bi, book\] of books\.entries\(\)\)/);
  const loadIdx = src.search(/LEDGER_PATH\s*=\s*outDir \+ '\/freshness-ledger\.json'/);
  if (loopIdx < 0) bad('未找到主循环', 'freshness-audit.js 结构变了，需重校本条断言');
  else if (loadIdx < 0) bad('未找到账本加载点', '账本路径构造缺失');
  else if (loadIdx < loopIdx) ok('账本在主循环之前加载（可影响抽样，不只是记录）');
  else bad('账本加载位置错误', '加载在第 ' + loadIdx + ' 字符、主循环在第 ' + loopIdx + ' 字符 → 只记录不影响抽样');

  // c) 只加载一次：主循环之后不得再读文件，否则 rounds 会多算一轮
  const afterLoop = src.slice(loopIdx);
  const reloads = (afterLoop.match(/readFileSync\(LEDGER_PATH/g) || []).length;
  if (reloads === 0) ok('主循环之后不再重复读账本（rounds 不重复自增）');
  else bad('账本被重复读取 ' + reloads + ' 次', '主循环后重复 load 会把上一轮刚写的内容当成上上轮');

  // d) 失败计数只统计真实请求：未请求的源不得计失败
  if (/if \(p\.touched\) \{\s*s\.consecutive_failures/.test(src)) ok('consecutive_failures 只对 touched 的源累加（未测≠失败）');
  else bad('失败计数口径错误', '未请求的源被计入 consecutive_failures → 「连续失败」指标失真');

  // e) 排序键必须是「上次请求轮次」而不是「上次有效轮次」
  if (/rec\.last_touched_round \|\| 0/.test(src)) ok('抽样优先级用 last_touched_round（有效轮次对多数源恒为 0，无法轮换）');
  else bad('抽样排序键错误', '用 last_valid_round 排序时多数源恒为 0，每轮砍同一批源，覆盖不扩张');
}

// ============================================================
// ⑩ 选书必须精确同名 + 题库必须被源库覆盖
// ------------------------------------------------------------
// 实证后果（2026-11-10，本地实跑）：
//   a) 「前 6 字包含」当命中 → 快眼看书对《中奖10个亿的老师躺平生活》
//      返回 100 条、精确同名 0 条，首条是《中奖10个亿的护士躺平生活》
//      （前 6 字完全一致的另一本书）。拿它的 653 章比 185 章参考值，
//      再被「超出 20%」降成 unknown，valid 恒为 0。
//   b) 题库来自番茄实时热榜「正在连载的新书」，盗版源基本不收录：
//      实测 6 本番茄新书在 25 源里精确命中 0；而经典书目 5-10/10。
//      题库不被源库覆盖 → 整轮 parsed=0，报告看上去像「源全坏了」。
{
  const src = fs.readFileSync('freshness-audit.js', 'utf8');
  const pick = fs.readFileSync('scripts/pick-books.js', 'utf8');

  // a1) 选书必须是精确同名，不能是模糊包含兜底
  if (/name === main/.test(src)) ok('选书用精确同名（name === main）');
  else bad('选书判据', '未使用精确同名 → 近似书名会把外书章节数当成源的数据');

  // a2) 不许再有「兜底取第一个能构造 URL 的」
  if (!/兜底：第一个能构造 URL/.test(src)) ok('已移除「取第一个能构造 URL」的兜底');
  else bad('仍有兜底选书', '书名不匹配时会拿任意一本书的数据当测量结果');

  // a3) 书名必须用该源的 name 规则取（items 常是 HTML 字符串，不是对象）
  if (/pickOne\(f, rs\.name\)/.test(src)) ok('书名用源自身的 ruleSearch.name 取（兼容 HTML 片段）');
  else bad('书名取法', '只判 typeof===object 会对 HTML 片段一律取空');

  // b1) 题库必须有覆盖率验收
  if (/coverageHit/.test(pick) && /不入题库/.test(pick)) ok('pick-books 有覆盖率验收（搜不到的书不入题库）');
  else bad('题库无覆盖率验收', '番茄新书盗版站不收录，会整轮 valid=0');

  // b2) 必须有高覆盖经典书优先池
  if (/CONST_REF/.test(pick) && /雪中悍刀行/.test(pick)) ok('pick-books 有高覆盖经典书优先池');
  else bad('缺优先池', '只靠番茄热榜取书，题库长期不可测');
}

// ============================================================
// ⑪ 截断值与超短目录不得污染测量
// ------------------------------------------------------------
// 实证后果（2026-11-10，本地实跑三轮标定）：
//   · 《斗罗大陆》参考 336，零点看书/入殓师/何以笙箫都报 400，
//     状态是「翻页截断（MAX_PAGES）」—— 400 只是 20 页上限，
//     不是章节数。原代码照它算 diff，判定成"领先"。
//   · 《剑来》参考 1307，新欲望社被截到 385 → 判"严重落后"，同样错。
//   · 《斗罗大陆》第一版主报 2 章、露露书报 1 章（根本没这本书），
//     这两条进了 valid 后把中位数拉到 2，整本书判定全废。
{
  const src = fs.readFileSync('freshness-audit.js', 'utf8');

  if (/truncated && toc\.chapters < book\.reference/.test(src))
    ok('截断值（MAX_PAGES/TIME_BUDGET）在低于参考时判 unknown，不当"落后"');
  else bad('截断语义', '截断得到的章节数只是下限，不能直接算 diff');

  if (/truncated_lower_bound/.test(src))
    ok('截断样本打 truncated_lower_bound 标记（下游可复核）');
  else bad('截断标记', '截断样本与真实测量无法区分');

  if (/toc\.chapters < 20 && toc\.chapters < book\.reference \* 0\.05/.test(src))
    ok('超短目录（<20 章且<5%）判 unknown，不污染中位数');
  else bad('超短目录', '1-2 章的假目录会计入 valid，把中位数拉到个位数');
}

// ============================================================
// ⑫ 管道退出码闸门：`cmd | tee` 必须配 pipefail
// ------------------------------------------------------------
// 2026-11-10 发现的实际漏洞：GHA 的 run 是 `bash -e`（errexit），
// 但 `cmd | tee file` 的退出状态只看管道最后一个命令 tee。
// 于是：
//   · node tests/official-contract.test.js 返回 1（官方删路由）→ tee exit 0
//   · gradle assembleDebug 编译失败 → tee exit 0
// 两条都判成功。第二条更致命：所谓「硬门槛」从上线起就没拦过任何一次编译失败。
// build-sync.yml 里本来就有 set -o pipefail，说明作者知道这件事，
// 只是 test.yml 漏了 —— 所以必须用断言锁住，不能靠记性。
{
  const files = ['test.yml', 'build-sync.yml', 'update.yml', 'source-audit.yml', 'js-eval.yml'];
  let violations = [];
  for (const f of files) {
    let t;
    try { t = read(f); } catch (e) { continue; }
    const lines = t.split('\n');
    // 逐条 run 块检查：块内出现 | tee 就必须在该行之前出现 set -o pipefail
    let pipefailAt = -1;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (/^\s*run:\s*\|\s*$/.test(ln)) pipefailAt = -1;          // 新的 run 块，重置
      if (/set -o pipefail/.test(ln)) pipefailAt = i;
      // 跳过纯注释行，避免把说明文字当成真实命令
      if (/^\s*#/.test(ln)) continue;
      if (/\|\s*tee\b/.test(ln)) {
        if (pipefailAt < 0 || pipefailAt > i) violations.push(f + ':' + (i + 1) + ' ' + ln.trim());
      }
    }
  }
  if (violations.length === 0) ok('所有 `| tee` 管道都配了 set -o pipefail（退出码不被吞）');
  else bad('管道退出码漏洞 ' + violations.length + ' 处', violations.join(' | '));
}

// ============================================================
// ⑬ 评分不得在满分端饱和（实际可用性扣分）
// ------------------------------------------------------------
// 2026-11-10 实测：base 上限 70 + stab 上限 20 + streak 上限 10 = 恰好 100。
// 于是「三关全过 + 连续 5 次 pass」的源必然 score=100 ——
// 实测 155 个 core 源**全部同分 100**，排序只能靠原始顺序，等于没有区分度。
//
// 更糟的是它盖住了真问题：161 个「三关全过」里，
// 🎃第一版主🎃#10 chapters=1、🎃吾爱文学🎃 chapters=9、琦书网 chapters=5
// —— 目录个位数章节的源，和 7000 章的源拿一样的 100 分、一样进 core。
// 用户手机上一打开只搜到一两个条目，这就是「用着不踏实」的来源。
{
  const src = fs.readFileSync('score.js', 'utf8');

  if (/usableWhy/.test(src) && /chaptersSeen/.test(src))
    ok('评分含实际可用性扣分（chaptersSeen/contentLenSeen）');
  else bad('评分饱和', 'base+stab+streak 恰好封顶 100，所有三关全过的源同分');

  if (/目录仅/.test(src) && /正文仅/.test(src))
    ok('扣分带可追溯原因（目录仅N章 / 正文仅N字符）');
  else bad('扣分无依据', '降级了但看不出为什么，无法追责');

  // 反向验证：扣分必须真的参与 score 计算，不是只算不扣
  if (/const score = Math\.max\(0, Math\.min\(100, base \+ stab \+ streak \+ usable\)\)/.test(src))
    ok('usable 确实参与 score 计算（不是算了不用）');
  else bad('usable 未生效', '扣分变量没有进入 score 表达式');
}

// ============================================================
// ⑭ 发布验签关必须真正跑起来（不是写着好看）
// ------------------------------------------------------------
// 2026-11-10 实测：update.yml 用 secrets.GITHUB_TOKEN 推 main，而 GitHub
// 规定 GITHUB_TOKEN 触发的 push 不再引起后续 workflow 运行。直接后果是
// verify-signature.yml 从 2026-10-27 起只运行过 1 次（run #1），此后每一次
// auto update 推上去的成品都没被独立验签关看过 —— 那道关实际上已经死了。
//
// 处置：把 node verify-sign.js 内联进 update.yml 的 sign 之后、commit 之前。
// 下面三条断言锁死它不被顺手删掉或挪到 commit 之后（挪后面就等于没验）。
{
  const upd = read('update.yml');
  const lines = upd.split(/\r?\n/);

  const signIdx = lines.findIndex((l) => /run:\s*node sign\.js\s*$/.test(l));
  const verIdx = lines.findIndex((l) => /run:\s*node verify-sign\.js\s*$/.test(l));
  const commitIdx = lines.findIndex((l) => /^\s*- name:\s*commit\s*$/.test(l));

  if (verIdx >= 0) ok('update.yml 内联了成品验签（verify-sign.js）');
  else bad('缺内联验签', 'GITHUB_TOKEN 推送不触发后续 workflow，独立验签关收不到货');

  if (signIdx >= 0 && verIdx >= 0 && verIdx > signIdx)
    ok('验签在签名之后执行（验的是本轮新生成的签名）');
  else bad('验签顺序错', '必须先 sign.js 再 verify-sign.js，否则验的是旧签名');

  if (verIdx >= 0 && commitIdx >= 0 && verIdx < commitIdx)
    ok('验签在 commit 之前执行（坏签名不会被推上 main）');
  else bad('验签晚于提交', '先 commit 再验签，等于把坏签名先发出去');
}

// ============================================================
// ⑮ 同步线路不得含已知死线（实测驱动）
// ------------------------------------------------------------
// 2026-11-10 逐条实测（Android UA，取 legado.json）：
//   raw.githubusercontent.com   ~1.6s  200  679 源
//   testingcf.jsdelivr.net      ~1.3s  200  679 源
//   fastly.jsdelivr.net         ~2.6s  200  679 源
//   gcore.jsdelivr.net          ~3.1s  200  679 源
//   ghproxy.net                 ~3.3s  200  679 源
//   gh-proxy.com               ~17.0s  200  679 源  ← 能通但极慢，只配末位
//   ghfast.top                 DEAD (10.5s 超时)
// 死线路挂在 urls.txt / defaultLines 里的代价是用户每次同步白等 10 秒。
{
  const urls = fs.existsSync('urls.txt') ? fs.readFileSync('urls.txt', 'utf8') : '';
  const sync = fs.readFileSync('SourceAutoSync/app/src/main/java/io/nervous/sourcesync/SyncWorker.java', 'utf8');
  // 取 SyncWorker 里 defaultLines 那一段，避免注释里提到域名造成误判
  const dlMatch = sync.match(/private static String\[\] defaultLines[\s\S]*?\n    \}/);
  const dl = dlMatch ? dlMatch[0] : '';

  const deadHosts = ['ghfast.top'];
  const violations = [];
  for (const d of deadHosts) {
    // urls.txt 里只能出现在注释行
    for (const ln of urls.split('\n')) {
      if (ln.trim().startsWith('#')) continue;
      if (ln.includes(d)) violations.push('urls.txt 非注释行含 ' + d);
    }
    if (dl.includes(d)) violations.push('SyncWorker.defaultLines 含 ' + d);
  }
  if (violations.length === 0) ok('同步线路不含已知死线（ghfast.top 已移除）');
  else bad('死线路残留', violations.join(' | '));

  // 直连 raw 必须在 urls.txt 里且排在前面（实测最快）
  const active = urls.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  if (active.length && active[0].includes('raw.githubusercontent.com'))
    ok('urls.txt 首选线路是直连 raw（实测最快 ~1.6s）');
  else bad('首选线路', '实测直连最快，应排第一；当前首条：' + (active[0] || '(空)'));

  if (active.length >= 4) ok('urls.txt 保留 ' + active.length + ' 条线路（多路兜底）');
  else bad('线路过少', '仅 ' + active.length + ' 条，单点故障风险');
}

// ============================================================
// ⑯ 追更题库必须以「完结老书」为主，且判定基准不依赖人工绝对值
// ------------------------------------------------------------
// 2026-11-10 实测教训（这是本仓库最贵的一课）：
//   旧题库全部来自番茄实时热榜，20 本独家新书 × 679 源 = 13580 样本，
//   parsed 0 / valid 0，整轮端到端 0%。
//   换完结老书后同条件：Candidate 229 → Parsed 19 → Valid 16（7%）。
//   差别不在源，而在「问的问题」：番茄独家书第三方站根本不收录。
//
// 另外人工填的 reference 也不可靠：《斗罗大陆》在不同站点分别报
// 236 / 336 / 711 章，全都对（分卷/通行/拆章三种口径）。所以判定基准
// 必须由 freshness-audit 用本轮实测共识自校准，不能只信人工值。
{
  const pick = fs.existsSync('scripts/pick-books.js')
    ? fs.readFileSync('scripts/pick-books.js', 'utf8')
    : '';
  const audit = fs.readFileSync('freshness-audit.js', 'utf8');

  // 默认模式必须是 classic（完结老书）
  if (/const MODE = arg\('mode',\s*'classic'\)/.test(pick))
    ok("pick-books.js 默认 mode=classic（完结老书，不依赖番茄热榜）");
  else bad('题库默认模式', "默认应为 classic；热榜独家书在第三方站搜不到");

  // 番茄接口必须只在 fanqie/mixed 下才拉
  if (/const wantFanqie = MODE === 'fanqie' \|\| MODE === 'mixed'/.test(pick))
    ok('番茄接口仅在 fanqie/mixed 模式下拉取（classic 不碰）');
  else bad('番茄接口未隔离', 'classic 模式仍会请求番茄，属回归');

  // 判定基准必须用实测共识重判，而不只是算个比值
  if (/reclassifiedByConsensus/.test(audit))
    ok('按实测共识重判领先/滞后等级（不只是算比值）');
  else bad('未按共识重判', '只改 ratio 不改 result 会出现 ratio≈1 却判 far_behind');

  // 口径不可比必须显式剔除，不能污染滞后统计
  if (/incomparableDropped/.test(audit))
    ok('口径不可比样本显式剔除（拆章/合章不污染判定）');
  else bad('未剔除不可比样本', '3 倍以上的章数差应降 unknown');

  // reference 漂移必须留痕，不能静默
  if (/referenceDrift/.test(audit))
    ok('人工先验与实测共识偏差 >20% 时留痕（referenceDrift）');
  else bad('漂移不留痕', '先验错了却不报告，等于继续误判');

  // 题库不得再出现番茄独家书
  if (fs.existsSync('books.json')) {
    const books = JSON.parse(fs.readFileSync('books.json', 'utf8'));
    const fq = books.filter((b) => /^fq_/.test(b.key) || /番茄/.test(b.source || '')).length;
    if (fq === 0) ok('books.json 无番茄独家书（' + books.length + ' 本全部为完结老书）');
    else bad('题库含番茄书', fq + ' 本来自番茄热榜，会拉低整轮覆盖率');
  }
}

console.log(`\n===== 汇总: ${pass + fail} 项 =====`);
console.log('✅ 通过: ' + pass);
console.log('❌ 失败: ' + fail);
process.exit(fail === 0 ? 0 : 1);

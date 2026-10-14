# 工程防线加固审计报告 — 2026-10-14

> 本次修复以"工程评审硬问题"为锚，不扩功能，只补防线。
> 分支 `audit/fix-pipeline-ranking-2026-10-14`

## 一、修复清单

| # | 修复项 | 文件 | 变更内容 |
|---|---|---|---|
| 1 | **撤销 source-audit.mjs 内部发布权** | `scripts/source-audit.mjs` | 删 `execSync('git add/commit/push/pull')` 代码块；删 `import execSync`；两处早退出（无候选/无通过）改为"先写完整审计报告再退出"；删掉随机打乱候选书源的 shuffle 逻辑，改为确定性顺序 |
| 2 | **workflow 禁止丢弃生成结果** | `.github/workflows/source-audit.yml` | 删 `git checkout -- . 2>/dev/null \|\| true`；收紧 commit 只暂存 `legado.json + .sig + version.txt + reports/source-audit.json` 等明确输出；加 `git diff --cached --quiet` 无变更跳过 |
| 3 | **排名按 URL 识别书源** | `rank-legado.js` | 新增 `normUrl()`（与 health.js 一致的规范化）；聚合键从 `name → normUrl`；name 回退仅在某个名称在 legado 中唯一时才启用（`uniqueNameToUrl`）；同名不同 URL 的书源不再串用健康数据 |
| 4 | **权重限制在 0–1000** | `rank-legado.js` | 安全计算：先 clamp 原权重到 `[0,1000]`，乘倍率，加 HIGH_PERFORMER 的 1000 bonus，最终再 clamp 到 `[0,1000]`；原 800×1+1000=1800 → 输出 1000；原 -5 → 0 |
| 5 | **健康检查致命异常不伪装成功** | `health.js` | `.catch` 里的 `process.exit(0)` → `process.exit(1)`；错误日志从 `console.log` 改 `console.error`；区分"单个源不可用（正常探测结果）"和"health.js 程序崩溃（致命失败）" |
| 6 | **Android 并发与超时回退** | `SyncWorker.java` | `HashMap → ConcurrentHashMap`（多线程并发 put 安全）；捕获 `latch.await()` 返回值；超时后保留历史 `oldH.localAvailable`，不把已禁用源重新启用；`InterruptedException` 恢复 `Thread.currentThread().interrupt()`；记录超时源数量 |
| 7 | **三个 workflow 统一并发锁** | 三个 `.yml` | concurrency group 统一为 `repo-main-writer`，避免并发写入覆盖；`build-sync.yml` 的 `git push --force-with-lease` 改为普通 `git push` |
| 8 | **smoke-p0.js 真实断言** | `smoke-p0.js` | 删未使用的 `gbkBuf` 函数；加 `assert.ok` 对 POST content-type / body kw / GBK GET 方法做真实断言（检查 mock 服务器捕获的请求）；快照 GBK GET 状态避免后续 POST 测试覆盖变量；加 `assert` import |
| 9 | **自动化测试** | `tests/repo-regression.test.js` + `.github/workflows/test.yml` | 14 项测试（URL 主键、权重 clamp×3、生产保护、source-audit 不含 git 命令、health exit(1)、SyncWorker ConcurrentHashMap + latch await + interrupt、smoke-p0）；test.yml 在 push/PR 时自动跑语法检查 + 回归 + smoke + Android debug 构建 |

## 二、本地实测结果（全部 pass）

### smoke-p0.js（离线 mock）
```
JSON+POST 三关全过: true
GBK-GET 三关全过: true
HTML-GET 三关全过: true
畸形规则 usable=false: true
POST content-type 含 x-www-form-urlencoded: true
POST body 含 kw: true
GBK 源用 GET（快照）: true
✅ SMOKE-PASS（所有断言通过）
EXIT=0
```

### repo-regression.test.js（14 项）
```
✅ node --check rank-legado.js / health.js / smoke-p0.js / source-audit.mjs
✅ 同名不同 URL 各自独立的诊断数据
✅ 原权重 800 + HIGH_PERFORMER → 1000 而非 1800
✅ 原权重 1500 → clamp 到 1000
✅ 原权重 -5 → clamp 到 0
✅ 源数量和 URL 不变
✅ source-audit.mjs 不含 git commit/push/pull/add
✅ health.js catch 是 exit(1) 不是 exit(0)
✅ SyncWorker.java 使用 ConcurrentHashMap
✅ 检查 latch.await 返回值 + 超时保留历史状态
✅ smoke-p0.js exit 0
🎉 全部回归测试通过！
```

## 三、生产数据保护

本次修改 **未触碰任何生产数据文件**（`legado.json` / `*.sig` / `version.txt` / `sync-app.apk`）：

```
 git diff --stat（不含生产数据）
 .github/workflows/build-sync.yml                   |   9 +-
 .github/workflows/source-audit.yml                 |  19 +--
 .github/workflows/update.yml                       |   5 +-
 SourceAutoSync/.../SyncWorker.java                 |  41 ++++++-
 health.js                                          |   2 +-
 rank-legado.js                                     | 129 +++++++++++++--------
 scripts/source-audit.mjs                           |  99 ++++++++--------
 smoke-p0.js                                        |  87 ++++++++++----
 tests/repo-regression.test.js                      | 新增 14 个测试
 .github/workflows/test.yml                         | 新增（push/PR 自动验收）
```

## 四、已知边界（不在本次修复范围）

| 项目 | 状态 | 说明 |
|---|---|---|
| vivo 设备 ReaderProvider 探针不响应 | **独立风险** | 代码层 ConcurrentHashMap + latch await 已修，但真机深链导入仍是独立问题，需要单独验收 |
| `ACTION_VIEW` 深链导入成功确认 | **独立风险** | `startActivity` 不抛异常 ≠ 阅读 App 已成功导入——本次不修改此逻辑 |
| 本地缓存/指纹更新 ≠ 导入完成 | **独立风险** | 不把"已启动 Activity"改名成"已成功导入"——边界保留 |
| 真实上游可用性验证 | **由 health.js + Playwright 三重验收负责** | smoke-p0.js 明确是离线 mock，不代表真实上游 |
| Android APK 签名构建 | **build-sync.yml 独立负责** | test.yml 只构建 debug APK 验证 Java 能编译 |

## 五、合并门槛（未全部满足前不合并）

- [x] 提交安全：source-audit.mjs 不再自行 commit/push
- [x] 发布顺序：所有闸门先于提交（source-audit.yml commit 步骤在 filter/health/score/fuse/sign 之后）
- [x] 排名正确性：按 URL 区分，权重 clamp 0–1000（回归测试覆盖）
- [x] 错误处理：health.js 致命异常 exit 1
- [x] 工作流可靠性：删 `git checkout -- .`；统一 concurrency；删 force push
- [x] Android 并发：ConcurrentHashMap + latch await + interrupt
- [x] 回归测试：14/14 通过
- [x] Android 能编译：test.yml 含 assembleDebug 步骤
- [x] 生产数据保护：git diff 不含生产文件
- [ ] 真机验收（vivo）：**下一轮单独做**

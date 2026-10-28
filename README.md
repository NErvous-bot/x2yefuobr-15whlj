# my-book-sources

个人自用的「阅读」(legado) 书源自动维护仓库。

## 仓库组件

- `legado.json`：精选书源合集（按健康评分自动分层排序：核心/稳定/备用/观察，不可测源入保护池，确认坏沉底）
- `replaceRule.json`：全局替换净化规则（去引导语/引流/求票/乱码，对所有书源生效）
- `*.sig`：上述 JSON 的 ECDSA P-256 签名文件，App 端内置公钥逐字节验签，防公共镜像线路篡改/投毒
- `filter.js` + GitHub Actions：每 3 天自动探测域名存活、剔除死源、尝试域名搬家修复、失败保留旧版本，并对成品重新签名
- `aging-test.js`：老化源实测模块（三关实测：搜索出书 → 目录≥1章 → 正文≥200字；支持 GET/POST 搜索（含 headers/charset 选项与伪 JSON 宽松解析）、GBK 编解码、JSON 响应 JSONPath 常用子集、HTML 静态选择器子集；规则不可测/网络失败/反爬验证一律豁免不误删）
- `rules.js`：净化规则自维护流水线（每 3 天随更新自动运行：抓真实正文巡检漏网广告 → 模板法生成候选规则 → 干净语料 0 误伤 + 净化率提升双重校验通过后自动追加，单轮 ≤10 条，异常/效果不佳自动跳过不写入）
- `health.js` + `health/source_health.json`：源级健康检查（每轮对书源做搜索/目录/正文三关实测并按响应速度评分，带时间预算轮测全库；结果 JSON 可随时查看哪些源真正可用）
- `score.js` + `reports/source_scores.json`：源评分分层（读健康报告计算源级分数，按核心/稳定/备用/观察分层覆写 weight，按权重降序重排 legado.json，让已验证的优质源优先）
- `fuse.js` + `reports/fuse-summary.txt`：发布保险丝（旧可用→新坏须经多轮实测定生死，仅"稳定死亡"才拦截发布；总源数/可用数骤降熔断；BLOCKED 时自动回滚成品文件，手机端书源逐字节不变，仅提交诊断报告）
- `recheck-regression.js`：回归复查裁决器（对状态异常的源做多轮实测裁决，输出新旧状态迁移矩阵，只读不改正式书源）
- `sign.js`：ECDSA 签名脚本（node 内置 crypto，签名后自验签，坏签名直接让 CI 失败，杜绝 0 字节签名被静默提交）
- `probe.js` + `urls.txt` + `candidates.txt`：下载线路自动探活剔除、候选池自动扩容
- `preflight.js`：升级预演工具，上传新 filter.js 前可本地跑一遍看预期效果
- `SourceAutoSync/`：手机端自动同步 App 源码（GPL-3.0）。每天 5:00 自动检查：先拉 `version.txt` 指纹（内容没变当天不下载）→ 多镜像轮询下载 + 逐字节 ECDSA 验签 → 通过阅读App的 ContentProvider 批量写入（写前按手机可达性禁用断网源），写入回查通过后按上次同步清单删除仓库已剔除的旧源（按 `bookSourceUrl` 精确匹配，不会动用户自建源）；接口不可用或写入失败时自动改走官方在线导入深链（`legado://import`）；同步结束通过系统通知栏告知结果（成功/失败/无变化）
- `sync-app.apk`：上述源码的 CI 自动构建产物（release 固定签名，可覆盖安装升级；源码变更会自动触发重新构建）
- `dead-sources.json`：人工确认死亡名单（`url` + 原因 + 确认日期）。列进去的源会被 filter.js 无条件剔除并写入删除清单 `manual-confirmed`；用于站点改版导致正文永久失效、测试器每轮都判坏又无法自动删除的情况，否则 fuse 会一直 BLOCKED
- `rssSources.json`（**已移出本仓库**）：18+ 成人向 RSS 订阅源，因内容合规原因不随公开仓库分发，改保存在本地 `rssSources.local.json`，需要时用阅读App 的「本地导入」自行导入；本仓库不再提供该文件及其下载链接

## 升级流程（开发者）

```bash
# 1. 改完 filter.js 后，本地预演（不真写 legado.json）
node preflight.js

# 2. 确认预演效果（剔除率 < 30%）后，再上传到 GitHub
# 3. GitHub Actions → "更新书源" → "Run workflow" 手动触发
```

## 来源与致谢

书源数据整理自以下开源仓库，感谢原作者的持续维护：

- [LegadoTeam/legado](https://github.com/LegadoTeam/legado) （阅读App 本体，GPL-3.0）— 本仓库的书源与净化规则均服务于该阅读软件。注：原上游 `gedoor/legado` 仓库已因版权方投诉被清空，本仓库**不包含**该 App 的任何源码，只通过其公开导入接口传递配置文件
- [shidahuilang/shuyuan-bak](https://github.com/shidahuilang/shuyuan-bak) （大灰狼订阅源，GPL-3.0）— 体量最大的中文小说书源合集
- [tickmao/Novel](https://github.com/tickmao/Novel) （**仓库内无 LICENSE 文件** — 仅作个人使用引用，不主张任何授权）— 精品 legado 源
- [jiwangyihao/source-j-legado](https://github.com/jiwangyihao/source-j-legado) （**MPL-2.0**）— 轻小说/二次元专项源集
- [aoaostar/legado](https://github.com/aoaostar/legado) （**仓库内无 LICENSE 文件** — README 标注 AGPL-3.0 但未附许可证，仅作个人使用引用）— 社区共享书源聚合站

> 许可证以各仓库**实际存在的 LICENSE 文件**为准（GitHub API 的 `license` 字段）。
> 「无 LICENSE 文件」在著作权法上默认是**保留所有权利**，不等于 MIT。
> 完整声明见 [NOTICE](NOTICE)。本项目为个人自用配置备份，不对外分发上游数据。

## 许可与免责声明

- 本仓库自有代码（`filter.js`、`aging-test.js`、`probe.js`、`preflight.js`、SourceAutoSync App）以 GPL-3.0 协议发布，见 [LICENSE](LICENSE)。
- 书源数据沿用各上游仓库的原许可证（GPL-3.0 / MIT / AGPL-3.0），完整许可证文本与版权声明见各上游仓库。
- 本仓库仅包含书源规则配置，不存储、不分发任何小说正文内容，也不提供任何下载或在线播放服务。
- `sync-app.apk` 由 GitHub Actions 从本仓库 `SourceAutoSync/` 源码自动构建（构建日志公开可查），对应完整源码即本仓库，满足 GPL-3.0 的源码提供要求。
- 本 App 不包含、不修改「阅读」(legado) 的任何代码，仅通过其官方公开的导入接口传递配置文件。
- 书源指向的第三方网站内容，版权归原网站及原作者所有；请支持正版，仅作个人学习研究用途。**免责声明不能使未经授权的内容分发变为合法**，使用者需自行承担所在地区的合规责任。
- 成人向 RSS 订阅源已移出本仓库（本地 `rssSources.local.json`），不随仓库分发；仅供成年人在本地自行使用，请遵守所在地法律，勿传播、勿用于商业用途。
- 本仓库为个人自用配置备份，未主动公开推广；不构成对任何第三方内容的授权、认可或担保。
- 版权方或权利代理人可通过 Issue 提出下架请求（请注明具体源或规则条目），确认后会第一时间删除相关内容。

## 实现说明

- 签名使用 node 内置 crypto（sign.js）而非 openssl：2026-10-04 起 runner 镜像的 openssl 签名报 unsupported，旧管道写法会把 0 字节签名静默提交，现改为签名后自验签、失败即 CI 失败。
- HTTPS 安全：2026-10-14 起移除全局 NODE_TLS_REJECT_UNAUTHORIZED=0（8 个脚本），上游 jsdelivr/GitHub raw 证书链完整，正常强校验无问题。
- 审计脚本：smoke-p0.js（上游拉取+实测 smoke）、test-p0.js（P0 回归）、freshness-audit.js（分页完整性）、rank-legado.js（跨书排序）独立运行。
- 书源按「>365天未更新」进入老化名单，删除前先真实实测三关（搜索出书→目录≥1章→正文≥200字）：全过豁免保留（90天免复测）、确定坏才剔除（每轮上限8%）；规则不可测（js动态语法、JSONPath高级语法、bookUrl模板拼接）、网络失败、反爬验证一律豁免不误删，由域名探活层兜底真死源；探活死源剔除仍受单次30%阈值保护。

## 隔离池（quarantine.js）

`score.js` 判定的 dead 层（连续 3 次 `content=false`，`weight=5`）以前只是降权，仍然会随 `legado.json` 下发到手机：用户搜一次书要并发打几百个死站。`quarantine.js` 在 `fuse.js` 之后、签名之前把这一层移出成品并写入 `quarantine.json`；`filter.js` 每轮读取该名单做过滤，防止上游合并 / `extra-sources.json` 策展 / 扩容池 / upstream 复活把它们重新带回成品（实测 264 个被隔离源中有 196 个同时存在于 `extra-sources.json`，不拦就会隔天全部复活）。健康报告证明已复活（`content=true`）的源会自动解除隔离并回到成品。

同轮把「不可测保护池」的权重由 440/380 下调为 120/90 —— 旧值高于 stable 层下界 300，会让从未验证过的源排在已验证稳定的源之前，与"不判死但也不置顶"的注释相反。

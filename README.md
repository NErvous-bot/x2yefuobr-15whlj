# my-book-sources

个人自用的「阅读」(legado) 书源自动维护仓库。

## 仓库组件

- `legado.json`：精选书源合集（番茄官方 Cookie 源置顶）
- `replaceRule.json`：全局替换净化规则（去引导语/引流/求票/乱码，对所有书源生效）
- `*.sig`：上述 JSON 的 ECDSA P-256 签名文件，App 端内置公钥逐字节验签，防公共镜像线路篡改/投毒
- `filter.js` + GitHub Actions：每 3 天自动探测域名存活、剔除死源、尝试域名搬家修复、失败保留旧版本，并对成品重新签名
- `aging-test.js`：老化源实测模块（三关实测：搜索出书 → 目录≥1章 → 正文≥200字；规则不可测/网络失败/反爬验证一律豁免不误删）
- `rules.js`：净化规则自维护流水线（每 3 天随更新自动运行：抓真实正文巡检漏网广告 → 模板法生成候选规则 → 干净语料 0 误伤 + 净化率提升双重校验通过后自动追加，单轮 ≤10 条，异常/效果不佳自动跳过不写入）
- `sign.js`：ECDSA 签名脚本（node 内置 crypto，签名后自验签，坏签名直接让 CI 失败，杜绝 0 字节签名被静默提交）
- `probe.js` + `urls.txt` + `candidates.txt`：下载线路自动探活剔除、候选池自动扩容
- `preflight.js`：升级预演工具，上传新 filter.js 前可本地跑一遍看预期效果
- `SourceAutoSync/`：手机端自动同步 App 源码（GPL-3.0）。每周一凌晨窗口自动同步：多镜像轮询下载 → 逐字节 ECDSA 验签 → 唤起阅读App官方在线导入（legado://import）自动写入，无需手动操作；同步结束通过系统通知栏告知结果（成功/失败/无变化）
- `sync-app.apk`：上述源码的 CI 自动构建产物（release 固定签名，可覆盖安装升级）

## 升级流程（开发者）

```bash
# 1. 改完 filter.js 后，本地预演（不真写 legado.json）
node preflight.js

# 2. 确认预演效果（剔除率 < 30%）后，再上传到 GitHub
# 3. GitHub Actions → "更新书源" → "Run workflow" 手动触发
```

## 来源与致谢

书源数据整理自以下开源仓库，感谢原作者的持续维护：

- [LegadoTeam/legado](https://github.com/LegadoTeam/legado) （阅读App 本体，GPL-3.0）— 本仓库的书源与净化规则均服务于该阅读软件
- [shidahuilang/shuyuan-bak](https://github.com/shidahuilang/shuyuan-bak) （大灰狼订阅源，GPL-3.0）— 体量最大的中文小说书源合集
- [tickmao/Novel](https://github.com/tickmao/Novel) （MIT）— 精而稳的 legado 源，每日验证维护
- [jiwangyihao/source-j-legado](https://github.com/jiwangyihao/source-j-legado) （MIT）— 轻小说/二次元专项源集

## 许可与免责声明

- 本仓库自有代码（`filter.js`、`aging-test.js`、`probe.js`、`preflight.js`、SourceAutoSync App）以 GPL-3.0 协议发布，见 [LICENSE](LICENSE)。
- 书源数据沿用各上游仓库的原许可证（GPL-3.0 / MIT），完整许可证文本与版权声明见各上游仓库。
- 本仓库仅包含书源规则配置，不存储、不分发任何小说正文内容。
- `sync-app.apk` 由 GitHub Actions 从本仓库 `SourceAutoSync/` 源码自动构建（构建日志公开可查），对应完整源码即本仓库，满足 GPL-3.0 的源码提供要求。
- 本 App 不包含、不修改「阅读」(legado) 的任何代码，仅通过其官方公开的导入接口传递配置文件。
- 书源指向的第三方网站内容，版权归原网站及原作者所有；请支持正版，仅作个人学习研究用途。
- 如有侵权，请提 Issue 联系，确认后会第一时间删除相关内容。

## 实现说明

- filter.js 有意设置 NODE_TLS_REJECT_UNAUTHORIZED=0（全局关闭 Node TLS 校验）：上游源与书源站普遍存在自签或过期证书，强校验会误杀可用源。该设置仅在 GitHub Actions 受控环境内运行。
- 签名使用 node 内置 crypto（sign.js）而非 openssl：2026-10-04 起 runner 镜像的 openssl 签名报 unsupported，旧管道写法会把 0 字节签名静默提交，现改为签名后自验签、失败即 CI 失败。
- 书源按「>365天未更新」进入老化名单，删除前先真实实测三关（搜索出书→目录≥1章→正文≥200字）：全过豁免保留（90天免复测）、确定坏才剔除（每轮上限8%）；规则不可测（js/XPath）、网络失败、反爬验证一律豁免不误删，由域名探活层兜底真死源；探活死源剔除仍受单次30%阈值保护。

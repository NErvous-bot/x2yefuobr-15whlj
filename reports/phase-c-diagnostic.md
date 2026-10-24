# Phase C 诊断报告：健康分 vs 追更分 对照

生成时间: 2026-10-20
基线 SHA: 323e721（fix: 补删除清单 + fuse.js 封堵删除盲区）
**只读诊断，不修改任何 weight / score.js / legado.json**

---

## 一、数据现状

| 指标 | 数值 | 来源 |
|---|---|---|
| 总源数 | 364 | health/source_health.json |
| 健康可用 | 62 | health.content=true |
| 健康确认坏 | 73 | health.content=false, health≠null |
| 不可测 | 229 | health=null |
| score.js core 层 | 61 | reports/source_scores.json |
| score.js stable 层 | 1 | reports/source_scores.json |
| score.js dead 层 | 73 | reports/source_scores.json |
| score.js untestable 层 | 229 | reports/source_scores.json |

**关键发现：健康分和分层完全一致。** health.available(62) = core(61) + stable(1)；broken(73) = dead(73)。score.js 的分层确实基于 health.js 的三关实测结果——它是健康分的直接投影，不包含追更维度。

---

## 二、追更诊断数据可用性

| 指标 | 状态 | 说明 |
|---|---|---|
| reports/freshness-summary.json | **bySource=[] 空** | 追更诊断只在 source-audit.yml（Playwright 三重验收）跑，update.yml 不跑 |
| reports/rank-report.md | 最后生成 2026-10-13 | 5 本书测试，HIGH_PERFORMER 3 源 |
| 覆盖率 (health ∩ freshness) | **0/364 = 0%** | update.yml 生产链路不产追更诊断 |

**核心问题：update.yml 生产链路不包含追更诊断。** 也就是说，每 3 天自动跑的 update.yml 只做"搜索→目录→正文"三关实测，追更诊断是每周日 Playwright source-audit.yml 才做的事。

---

## 三、评分对真实阅读的影响

当前 score.js 做了：
1. 健康分 → 分层（core/stable/backup/watch/untestable/dead）
2. 覆写 weight
3. 按 weight 重排 legado.json

**已证实：** 这些数据确实被正确计算、写入 legado.json、且与签名/version.txt 一致。
**未证实：** Legado App 实际搜索/换源路径是否按 legado.json 里的 weight 排序。

---

## 四、结论

### 评分系统的实际价值定位

| 能力 | 当前状态 | 评估 |
|---|---|---|
| 云端治理：识别死源 | ✅ 已证实（健康分与分层一致） | 有价值，保留 |
| 分层：untestable 保护池 | ✅ 已证实（229 源不因不可测被删） | 有价值，保留 |
| 按 weight 排序 legado.json | ✅ 已证实写入正确 | 有效，但消费路径未验证 |
| 自动追更质量保证 | ❌ 无生产链路覆盖 | 只在 source-audit.yml 每周一次 |
| Legado App 自动选源 | ❌ 未验证 Legado 实际消费 weight | 外部依赖，非本仓库可控 |

### 评审建议的执行

- **冻结 score.js 公式**：已做（Phase A 后不再改评分公式）
- **追更诊断独立报告**：本轮产出本文件，不改 weight
- **证明 Legado 消费路径**：需要 Android 侧对照测试（不在本仓库范围）
- **评分收益判定**：等 Legado 真实消费路径明确后再决定是否继续投入

---

## 五、本轮 Phase B 修复

| 修复 | 目的 | 状态 |
|---|---|---|
| filter.js 产出 reports/deletion-manifest.json | 每轮删除有机器可读理由 | ✅ push @ 323e721 |
| fuse.js 闸门①-b | 旧可用源消失必须有合法理由，否则 BLOCKED | ✅ push @ 323e721 |
| 合法理由白名单 | probe-dead / aging-failed / canon-merged / upstream-removed | ✅ |
| CI test.yml | commit 323e721 success / 43s | ✅ |

### update.yml Run #44 正在验证

手动触发于 2026-10-20 04:30 UTC，commit 323e721，验证 Phase B 修复是否在完整生产链路中工作。

---

*本报告只读，不修改任何生产文件或权重。*

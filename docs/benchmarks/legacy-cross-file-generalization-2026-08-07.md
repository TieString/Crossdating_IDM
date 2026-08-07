# Legacy 跨文件泛化验证（2026-08-07）

## 状态

修复后 co612 基线已经重新冻结并通过完整 reproduction gate，外部全量待恢复。本轮从此处起只运行评估，不根据结果修改 Legacy 生产诊断、阈值、窗口、排序、事件或编辑规则。

## 冻结标识

- 生产基线提交：`5fd3f4a93f91484d84e86706afa2df02b9499163`
- config SHA-256：`fd72c2cfb8835d50d89ea452a4b4c14f345c061bdf39ea031b4d9a8696893e54`
- manifest SHA-256：`9e90353c8988c2383f8448372739c80223b5f19687db83bdb4861e9a100b3dd6`
- injection config SHA-256：`7e8ad6e22f6580e114ce3ff4279bb7b857e4a05a041a7a4eaab291f7cfe2af8f`
- COFECHA SHA-256：`3b898012c417ed06b3a1d88c0a4f86a677e276eadfe30a04fd5798542c63372b`
- co612 输入 SHA-256：`5bedc4dba8dbfd5cf2ef7d1764dab8a3e9fdf6211c52a2f649e5fadb0c4f4549`

co612 reproduction 已改为冻结 2026-08-07 的 post-partial-evidence 完整运行。核心轨迹文件的 SHA-256 写入 config，并在运行 gate 前逐一校验，避免外部冻结目录被静默替换。

冻结目录：`D:\软件测试\co612-review-window-results\review-bootstrap-post-partial-evidence-v1-2026-08-07`

- observations：`972f4738c302a47e8c675c6a6a5e2482b1a25de676b5c8134cebe601bf84b361`
- applications：`bd607bf8834a9a5747f4f641e30210dc710fe9a6da07e7de760e0e5d404aecc5`
- rounds：`499dcd2699f50ae44e529600fd47bfca9795dec1bc0ce8e585bd2b5ce1c17693`
- run summary：`5e9ec9f50521c6a4c26f3638d5497c5db6dbaa8f2074df784bfffe079d43fb74`
- clean targets：`f378eec3f84d483f382d96d18a33d061f696ddad1055c2ea5cf9ddfae119a235`

### 修复后 co612 完整审计

- clean strict 提示：18/55；strict 层继续保留审计证据。
- clean review 提示：3/55；未把 18/55 冻结为新 review 基线。
- confirmed：329/358；与旧基线相同。
- ever correct window：330/358；与旧基线相同。
- confirmed 事件集合：329 个完全相同。
- FIFO 应用顺序：95 个事件改变位置，首个变化发生在第 207 次应用；最终确认集合不变。
- first response：335/358，旧基线为 334/358。
- first-window coverage：286/358，旧基线为 285/358。
- first-response operation correct：332/335，旧基线为 333/334。
- confirmed Top1：248/358，旧基线为 245/358。
- 窗口 median/P90：9/13 年；与旧基线相同。
- 新增首轮 partialMove 误判：`mon061:1778`、`mon142:1763`。它们不会被真值模拟器确认，但作为修复代价和后续适用边界保留在冻结报告中。
- 最早审计差异：第 1782 条 observation 的 `reviewDecisionReason` 从 `operation_type_conflict` 变为 `partial_move_evidence_insufficient`，符合新增独立证据门槛的语义。

冻结 manifest 包含 24 个外部 ITRDB 文件、48 条目标序列，其中 3 个文件用于技术 pilot。文件、样芯、场景、注入年份和质量分箱均由固定 seed 在查看正式外部结果前确定；24 个文件均标记为 `developmentExposure=unknown`，不称为 untouched holdout。

## 准备门禁

综合 quick smoke：`D:\软件测试\legacy-generalization-prep-smoke\prep-all-v1`

### co612 reproduction

- clean strict 提示：18/55（保留审计层）
- clean review 提示：3/55
- 第 1 轮：`mon022:1977`
- 第 2 轮：`mon021:1977`
- `trajectoryDifference=null`
- `cleanBaselineDifference=null`
- `metricDifference=null`
- 完整 400 轮 gate：通过。
- `frozenBaselineHashMismatches=[]`
- 修复失败检查点后，`--resume` 只重算第 330 轮终止扫描；不会绕过 `passed=false` 的 gate。

### 外部 pilot 技术门

- 独立文件：3
- 目标序列：6
- single worker 输出：3
- serial worker 输出：3
- `sourceMutationCount=0`
- `saveReopenDifferentialCount=0`
- `errors=0`
- `baselineProductionDifferential=0`
- 输出 checksum：18/18 通过

pilot 的准确率仅用于确认统计链路可运行，不作为正式泛化结论，也未用于调参。

### 定向回归

- MCP17A：2/2 通过；保存前后均保留唯一 `partialMove -9`。
- ZSL141：7/9 通过。
- ZSL141 失败 1：切换到旧动态参考后，1975 年 `partialMove -6` 被 2008 年 `missingRing` 阶梯证据抢占。
- ZSL141 失败 2：真实保存循环中的 `partialMove -11` 被 2008 年 `missingRing` 阶梯证据抢占。

这两项作为已观察到的适用边界进入最终报告，不在本轮修改算法处理。

## 待运行阶段

1. 完整 co612 400 轮 reproduction gate。
2. 24 文件 external single。
3. 24 文件 external serial。
4. negative controls、文件聚类 10,000 次 bootstrap 和分层汇总。
5. 输出哈希复核与最终 A/B/C/D 泛化结论。

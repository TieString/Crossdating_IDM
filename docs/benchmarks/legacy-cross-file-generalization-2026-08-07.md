# Legacy 跨文件泛化验证（2026-08-07）

## 状态

当前处于冻结准备完成、外部全量尚未运行阶段。本轮从此处起只运行评估，不根据结果修改 Legacy 生产诊断、阈值、窗口、排序、事件或编辑规则。

## 冻结标识

- 生产基线提交：`5fd3f4a93f91484d84e86706afa2df02b9499163`
- config SHA-256：`f08df2844c4b57d14b52faf96841ca4b29f4dc6e050cbc0c452b3367602b3bbe`
- manifest SHA-256：`9b10d917ab66a3f682a3da48bc789929514e9924e0588e332dd9f13be4f7b282`
- injection config SHA-256：`7e8ad6e22f6580e114ce3ff4279bb7b857e4a05a041a7a4eaab291f7cfe2af8f`
- COFECHA SHA-256：`3b898012c417ed06b3a1d88c0a4f86a677e276eadfe30a04fd5798542c63372b`
- co612 输入 SHA-256：`5bedc4dba8dbfd5cf2ef7d1764dab8a3e9fdf6211c52a2f649e5fadb0c4f4549`

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

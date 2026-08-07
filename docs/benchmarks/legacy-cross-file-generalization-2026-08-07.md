# Legacy 跨文件泛化验证（2026-08-07）

## 状态

修复后 co612 基线已精确复现，24 个外部文件的 single、serial、negative control 和 10,000 次文件聚类 bootstrap 均已完成。最终结论为 **D. 泛化失败**。本轮只运行评估，没有根据结果修改 Legacy 生产诊断、阈值、窗口、排序、事件或编辑规则。

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

## 正式外部运行

结果目录：`D:\软件测试\legacy-cross-file-generalization-results\legacy-full-2026-08-07-v1`

- 状态：`COMPLETED`，exit code 0。
- runner 提交：`3482f45a38abab2f82365f61c70269662057dc07`。
- 24 个独立 ITRDB 文件，48 条目标序列，528 个场景。
- exact-injected：1,152 个事件。
- natural-confirmed：0；weak-natural：0；两者没有混入主统计。
- negative-clean：48 个案例。
- 24 个文件的 `developmentExposure` 均为 `unknown`，因此本轮是外部扩展验证，不称为 untouched final holdout。
- worker 输出 48 份，运行错误 0，源文件变化 0，保存重开差异 0。

### 单次诊断

| 指标 | 结果 |
| --- | ---: |
| response | 420/1,152 = 36.46% |
| type accuracy（全事件） | 289/1,152 = 25.09% |
| type accuracy（已回答） | 289/420 = 68.81% |
| shift accuracy（全事件） | 308/1,152 = 26.74% |
| shift accuracy（已回答） | 308/420 = 73.33% |
| operation accuracy（全事件） | 287/1,152 = 24.91% |
| operation accuracy（已回答） | 287/420 = 68.33% |
| first-window coverage | 167/1,056 = 15.81% |
| conditional window coverage | 167/287 = 58.19% |
| Top1 | 35/1,056 = 3.31% |
| breakpoint absolute error | median 5 年；P90 130 年；P95 158 年 |
| breakpoint signed bias | +25.52 年，明显偏向较新年份 |
| window width | median 13 年；P90 13 年 |
| save/reopen stable | 1,200/1,200 = 100% |

`first-window` 和 Top1 的分母排除了 96 个没有断点年份的 whole-series 事件。conditional 指标只在类型、shift 和操作语义均正确且真值唯一匹配时计算。

这里的 420/1,152 是协议要求的**事件级** response，不等于有 63.54% 的场景完全拒答。480 个含事件场景中，420 个实际输出了一个 review 主事件，场景级 response 为 420/480 = 87.50%。由于产品每个场景最多输出一个主事件，多事件场景的事件级 response 理论上最多为 480/1,152 = 41.67%。因此 36.46% 不能单独作为“proposal 不足”的证据；真正的损失要看输出操作是否正确、窗口是否覆盖，以及修正后能否继续暴露下一前沿。

### 串行人工确认工作流

串行测试覆盖 144 个 series-scenario、768 个真值事件：

| 指标 | 结果 |
| --- | ---: |
| confirmed | 179/768 = 23.31% |
| ever correct window | 180/768 = 23.44% |
| first response | 296/768 = 38.54% |
| first-response operation accuracy（已回答） | 290/296 = 97.97% |
| first-response window coverage | 176/768 = 22.92% |
| first-response window coverage（已回答） | 176/296 = 59.46% |
| first-response Top1 | 32/768 = 4.17% |
| confirmed Top1 | 34/768 = 4.43% |
| Top1 among confirmed | 34/179 = 18.99% |
| 完全恢复 series-scenario | 11/144 = 7.64% |
| 至少恢复一个事件 | 63/144 = 43.75% |
| 当前前沿直接失败 | 133/768 = 17.32% |
| 被前序失败阻塞 | 456/768 = 59.38% |
| FIFO 等待轮数 | median 0；P90 1 |
| window width | median 13 年；P90 13 年 |

这里的 97.97% 只表示“串行首轮已经回答的 296 个前沿”中操作多数正确，不能替代 23.31% 的端到端恢复率。72 个文件级串行场景中，69 个因 `no_new_correct_review_window_after_full_sweep` 自然停止，仅 3 个恢复了全部注入事件；终局 COFECHA flagged 数 median 10、P90 25，只有 9/72 为 0。

## 分层结果

### 事件类型

| 类型 | 事件数 | response | 已回答 operation accuracy | first-window | conditional window |
| --- | ---: | ---: | ---: | ---: | ---: |
| missingRing | 816 | 259/816 = 32% | 252/259 = 97% | 142/816 = 17% | 142/252 = 56% |
| falseRing | 96 | 45/96 = 47% | 19/45 = 42% | 10/96 = 10% | 10/19 = 53% |
| partialMove | 144 | 75/144 = 52% | 16/75 = 21% | 15/144 = 10% | 15/16 = 94% |
| wholeSeriesMove | 96 | 41/96 = 43% | 0/41 = 0% | 不适用 | 不适用 |

partialMove 的 94% 条件窗口覆盖只适用于已经选对类型和 shift 的少量案例；其已回答 operation accuracy 仅 21%，不能据此定义可用边界。wholeSeriesMove 没有一次形成完整正确操作。

### 事件复杂度

| 复杂度 | 事件数 | response | 已回答 operation accuracy | first-window | conditional window |
| --- | ---: | ---: | ---: | ---: | ---: |
| single | 144 | 121/144 = 84% | 66/121 = 55% | 39/144 = 27% | 39/66 = 59% |
| single contiguous block | 48 | 37/48 = 77% | 6/37 = 16% | 6/48 = 12% | 6/6 = 100% |
| multi-discrete 2 | 96 | 43/96 = 45% | 42/43 = 98% | 27/96 = 28% | 27/42 = 64% |
| multi-discrete 4 | 192 | 42/192 = 22% | 42/42 = 100% | 35/192 = 18% | 35/42 = 83% |
| multi-discrete 8 | 384 | 45/384 = 12% | 42/45 = 93% | 28/384 = 7% | 28/42 = 67% |
| composite global + local | 192 | 45/192 = 23% | 44/45 = 98% | 0/144 = 0% | 0/44 = 0% |
| endpoint cropped | 48 | 46/48 = 96% | 45/46 = 98% | 32/48 = 67% | 32/45 = 71% |

多离散场景的场景级 response 实际分别为 43/48、42/48 和 45/48。表中的 45%、22% 和 12% 使用事件分母，主要反映“每个场景只输出一个主事件”，不能解释成随事件数增加而大量拒答。真正的问题发生在首个前沿之后：一旦下一前沿窗口错误，FIFO 就不能模拟确认，剩余更老事件全部被阻塞。复合事件即使操作标签匹配，也没有一个断点窗口覆盖真值，说明 event fusion 和概率模式选择失败。

## 为什么 co612 明显更好

co612 不只是“相关性较高”，还具有当前算法特别受益的强重复年份结构：

- 358 个自然 0 中，343 个（95.81%）与至少另一条序列共享同一日历年；323 个（90.22%）在至少 3 条序列中共享，单年最高支持 35 条序列。
- 外部冻结注入的 816 个 missingRing 中，只有 32 个（3.92%）在同一文件、同一场景的两条目标序列间共享年份，最高支持仅 2。
- co612 的首次大簇包括 1778 年 35 条、1773 年 26 条，以及 1977、1902、1861 年各 23 条。用户确认并恢复其中一条后，该显式 0 会成为其他序列的强年份标记，产生连续自举优势。
- 外部注入年份按冻结规则独立选择，不按强信号年或跨芯共同年份挑选，因此通常没有这种级联提示。

这与实现一致：sequential missing 恢复只在 COFECHA 标记目标后启动，并可把已有检测替换成一个 missingRing 前沿；窗口又会优先使用已确认目标 0、共享显式 0 或候选共识。该机制对 co612 的共享年份簇非常有效，但不是任意缺轮年份的通用定位器。

### 数据质量与端点

- 高相关组 `r=0.55..1` 仍只有 270/696 = 39% response、190/270 = 70% 已回答 operation accuracy、123/638 = 19% first-window 和 123/190 = 65% conditional window。
- 高 segment stability `0.8..1` 仍只有 342/912 = 38% response、236/342 = 69% 已回答 operation accuracy、149/836 = 18% first-window 和 149/236 = 63% conditional window。
- reference depth `30+` 仍只有 119/288 = 41% response、81/119 = 68% 已回答 operation accuracy、51/264 = 19% first-window 和 51/81 = 63% conditional window。
- 新端 0-14 年 response 为 46/48 = 96%、operation accuracy 为 45/46 = 98%，但 conditional window 只有 32/45 = 71%，仍低于 94% 门槛。
- 新端 29-59 年 conditional window 为 22/28 = 79%；距端点 59 年以上降到 113/214 = 53%，断点 P90 误差为 146 年。

没有任何预先冻结的数据质量层同时满足 response、operation、conditional window 和阴性安全要求，因此不能给出可执行的“B. 条件泛化”适用边界。

## 阴性安全性

- clean strict false positive：18/48 = 37.50%。
- clean review false positive：17/48 = 35.42%，涉及 11/24 个文件。
- review 误报类型：13 个 missingRing、2 个 falseRing、2 个 wholeSeriesMove；本轮没有 partialMove 阴性误报。
- co612 修复后 clean review 参考为 3/55 = 5.45%。

外部阴性误报比 co612 参考高约 6.5 倍。由于 response 本身已经很低，继续单纯降低 review 门槛会扩大误报，不能解决端到端覆盖问题。

## 文件层与区间

- file-level macro：response 36.46%，已回答 operation accuracy 69.74%，first-window 15.81%，conditional window 53.63%，serial confirmed 23.31%。
- event-level micro 与 file-level macro 接近，结论不是少数大文件贡献。
- 文件 serial confirmed 的 P10：`itrdb-13-93eeb0586c`，4.55%。
- 最差文件：`itrdb-08-e1f6c0b64c`，0%。
- 文件间 serial confirmed IQR：11.36 个百分点；最佳文件也只有 56%。

10,000 次 file-cluster bootstrap：

| 指标 | 点估计 | 95% CI |
| --- | ---: | ---: |
| single response | 36.46% | 32.38%-39.50% |
| single operation accuracy（已回答） | 68.33% | 65.13%-71.43% |
| single first-window | 15.81% | 12.59%-18.94% |
| single conditional window | 58.19% | 50.00%-65.69% |
| serial confirmed | 23.31% | 17.06%-29.56% |
| serial ever correct | 23.44% | 17.32%-29.56% |
| serial first response | 38.54% | 32.03%-44.79% |
| serial first-response window | 22.92% | 16.80%-28.91% |

所有关键区间的上界仍远低于冻结目标，文件聚类后结论不变。

## 失败层定位

1. **proposal 不是主要损失**：场景级 response 为 420/480 = 87.50%；事件级 36.46% 主要受“每场景只输出一个主事件”约束。不能靠单纯降低显示门槛解决。
2. **operation selection**：单缺轮已回答操作正确 37/39，但单伪轮仅 19/44、单局部移动仅 10/38、整体移动 0/41。当前 unit、partial 和 whole 的优先选择及 sequential missing 替换会把全局或多年 lag 压成单位事件。
3. **candidate ranking 与 window**：在操作正确后 conditional window 仍只有 58.19%，断点 P90 误差 130 年且向新端偏 25.52 年，说明经常选中远距离错误模式，而非只差一两年。即使最简单的单缺轮，窗口也只有 20/37 = 54.05% 的条件覆盖。
4. **event fusion**：composite first-window 和 conditional window 均为 0%；wholeSeriesMove operation accuracy 为 0%。
5. **review gate**：场景响应并不低，但 clean review 误报达到 35.42%，说明当前分数没有形成可通过单阈值分离的区域。
6. **serial blocking**：456/768 事件被前序失败阻塞，是 serial confirmed 从 co612 91.90% 降到 23.31% 的直接放大器。missingRing-only 串行 confirmed 在 4 事件场景为 93/192 = 48.44%，在 8 事件场景为 86/384 = 22.40%；复合场景为 0/192。

## 定向回归与适用边界

- MCP17A：2/2 通过，连续自然缺块在保存前后均保持 `partialMove -9`。
- ZSL141：7/9 通过；动态参考 `-6` 和真实保存循环 `-11` 仍会被 2008 年 missingRing 阶梯证据替换。
- ZSL141 两个失败是冻结前已知指纹，本轮没有修改夹具、测试期望或生产算法。

## 完整性审计

- 26 个外部/定向 RWL 输入重新计算 SHA-256，0 个不匹配。
- co612、COFECHA、prior manifest 和 5 个 co612 冻结轨迹文件重新计算 SHA-256，8/8 匹配。
- config 与 manifest SHA-256 分别为 `fd72c2cf...e54` 和 `9e90353c...dd6`，与运行记录一致。
- 18 个正式结果文件重新计算 SHA-256，18/18 匹配；完整值见 `checksums.sha256.json`。
- `sourceMutationCount=0`，`saveReopenDifferentialCount=0`，`baselineProductionDifferential=0`，`errors=0`。
- evaluator Vitest：6/6 通过；Legacy typecheck 通过；`npm run build` 通过。构建仅保留既有 chunk size/dynamic import 警告。

## 最终结论

**D. 泛化失败。**

co612 的 329/358（91.90%）serial confirmed 是单文件/同站点优势，不能视为当前 Legacy 的普遍能力。外部 24 文件上，serial confirmed 为 179/768（23.31%），已回答 operation accuracy 为 68.33%，conditional window 为 58.19%，clean review 误报为 17/48（35.42%）；高相关、高 reference depth 和高 segment stability 分层仍明显退化，多数文件不能复现 co612 工作流能力。

本轮到此停止，不继续修改 Legacy 算法。下一轮若重建设计，应优先处理完整概率模式的 proposal、事件类型/shift 联合选择、远距离伪峰抑制、复合事件状态路径和 FIFO 阻塞传播；不能只扩窗或降低 review 门槛。

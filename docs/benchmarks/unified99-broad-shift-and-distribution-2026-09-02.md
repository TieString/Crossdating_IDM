# Unified99 全整数位移与宽分布实验

> 2026-09-03输入链审计发现：早期部分评估把999终止符当成观测，且近似标准化与入选相关性使用的cofecha-js报告链不一致。本报告作为历史失败审计保留，不能用来推断信息论上限或最终泛化能力。后续更正见 `unified99-engine-evidence-repair-2026-09-03.md`。

## 结论

本轮修正了测试生成器的分布硬限制，但**没有把全整数位移头接入生产**。原因不是实现困难，而是完整文件隔离的 calibration 没有同时达到可部署门槛：

- `whole -1…-100`：单事件均衡宽位移头达到 `476/500 = 95.20%`，但直接用于原多事件分布时仅 `661/1056 = 62.59%`，其中 D 类 `361/756 = 47.75%`。
- 将原多事件与宽位移 development 合并训练后，原分布恢复到 `1009/1056 = 95.55%`，D 类为 `709/756 = 93.78%`，但宽位移 calibration 降到 `462/500 = 92.40%`；合并为 `1471/1556 = 94.54%`。
- 宽位移 development 权重提高到 2.5 后，宽位移为 `468/500 = 93.60%`，原分布为 `1002/1056 = 94.89%`，合并为 `1470/1556 = 94.47%`，仍未通过。
- `partial -2…-100`：候选 oracle Top-2 只有 `115/198 = 58.08%`；统一排序头 development 文件分组 OOF 为 `338/495 = 68.28%`，calibration 为 `319/495 = 64.44%`。候选层已低于可行门槛，按停止规则未部署。

因此应用仍冻结在已验证的 `unified99-runtime-v3`，模型 SHA-256 恢复为 `4ba085da6e27b9b27c6944abaa0107b932d50c02a0af3ddb2359f55d6eb1a6d8`。实验模型和失败报告全部保留，但不影响用户手动测试。

## 宽分布生成器

新协议为 `itrdb-broad-runtime-v1` / generator v7，运行时目标选择仍要求干净状态 `masterCorrelation > 0.60`，文件档位仍按干净 RWL 文件级内部相关性划分。

| 分区 | 文件 | 目标序列 | 案例 | 真实事件 |
|---|---:|---:|---:|---:|
| development | 220 | 3,000 | 30,000 | 63,820 |
| calibration | 204 | 3,000 | 30,000 | 63,669 |

每个分区均含 Clean 3,000、A 18,000、B/C/D 各 3,000。A 增加为每目标六个互不相同的单事件：missing、false、两个 partial 和两个 whole；这样不再令 A-whole 全部等于 `-50`。

- whole 精确覆盖 `-1…-100`，每个位移在每个分区约 68–69 例。
- partial 精确覆盖 `-2…-100`，development 每个位移 136–167 例，calibration 132–174 例。
- 多事件数覆盖 `2/3/4/5/6/8/10/12`；最大 12，不再限于 2–4。
- 近距间隔覆盖每个 `1…13`；远距覆盖 `14…60`，不再固定 30。
- development 有 7,223 个不规则多事件案例，calibration 有 7,297 个。
- development/calibration 完整 RWL 文件交集为 0。

这 60,000 个案例已完成确定性生成和分布审计；本轮没有把它们冒充已运行的完整 A/B/C/D 准确率。底层反事实证据只完成了用于候选可辨识与位移头训练的冻结 pilot。

## Whole 实验

| 模型 | Development | Calibration | 宽位移 cal | 原多事件 cal | 原 D 类 |
|---|---:|---:|---:|---:|---:|
| 单事件 whole v2 | 96.80% OOF | 95.20% | 95.20% | 62.59% | 47.75% |
| 混合 whole v3 | 95.37% OOF | 94.54% | 92.40% | 95.55% | 93.78% |
| 混合加权 whole v4 | 94.99% OOF | 94.47% | 93.60% | 94.89% | 92.86% |

混合 v3 的 calibration 分层：文件级 `r=0.60–0.70` 为 92.95%，`0.70–0.80` 为 94.54%，`>=0.80` 为 96.11%；近端为 92.05%，中部为 95.82%。最弱位移量段是 `2–10`，仅 89.67%。这说明精确 whole 位移尚不能依赖一个全局排序头直接发布。

## Partial 实验

完整整数候选对每个位移执行真实的局部反事实路径扫描，并联合四组连续路径证据。结果仍明显失败：

| 指标 | 结果 |
|---|---:|
| 物理候选最佳单视图 Top-1 | 66.67% |
| 候选 oracle Top-2 | 58.08% |
| 排序头 development OOF Top-1 | 68.28% |
| 排序头 calibration Top-1 | 64.44% |
| 排序头 calibration Top-2 | 69.70% |

这不是调阈值或类别重采样可以解决的问题。当前路径把“断点位置”和“跳变量”一起最大化，多个局部 lag 阶梯会产生大量近等价组合。下一步应先从完整路径中估计每一段的绝对 lag，再把相邻稳定平台的差定义为 partial 精确位移；不能继续把 `-2…-100` 当作 99 个互斥类别硬排。

## A/B/C/D 当前可用基线

由于新的 60,000 案例只完成分布生成、尚未完成全量在线证据运行，当前可引用的 A/B/C/D 准确率仍是冻结 v3 calibration：

| 类别 | 逐事件机会 | 覆盖率 | 主准确率 | 操作准确率 | 窗口准确率 |
|---|---:|---:|---:|---:|---:|
| A | 1,200 | 98.33% | 95.75% | 98.00% | 96.78% |
| B | 3,588 | 98.69% | 93.90% | 97.52% | 95.43% |
| C | 3,588 | 97.69% | 91.14% | 96.99% | 93.48% |
| D | 3,048 | 94.65% | 89.80% | 92.68% | 94.55% |

这些数字来自旧的窄位移分布，不能证明对任意 whole/partial 位移、5个以上事件或任意间隔的泛化。新 v7 完整 A/B/C/D 验证必须等新的统一平台差位移模型通过 calibration 后再执行。

## Material Passport

- 目标：移除位移与场景生成硬限制，并验证全整数反事实位移头是否可部署。
- 生产状态：`unified99-runtime-v3`；全整数 whole/partial 头均未部署。
- development manifest SHA-256：`5827354057a6ffdd17279b7993b33642fa80aaa0ed4bdd3bdbe91df9001c04ac`。
- calibration manifest SHA-256：`affcc9ca3ad2d4958a59260c23b46b15afd8b1e9974148cd4411a1c1900a3863`。
- development cases SHA-256：`57fc97b342016352d3476a688b60499914150df50f9d04703af9610e31d575ac`。
- calibration cases SHA-256：`f686d174192db685c1ac025bf74ae4e87b904f96af1ac3562afd050fdb1b27c8`。
- 全整数 whole v2 模型 SHA-256：`fe35f21e63c78ea1ce9a2c10b3b31b1b5be40405c90139a504c580b41a40b805`，仅实验保留。
- 失败记录：`unified99-full-integer-whole-ranker-v2-original-calibration.json`、`unified99-full-integer-whole-ranker-v3-mixed.json`、`unified99-full-integer-whole-ranker-v4-mixed-weighted.json` 和 `unified99-full-integer-shift-rankers-v1.json` 永久保留。
- 异常运行：一次误把旧 `run_stratified_pipeline.mjs` 当作支持 `--help` 的命令，生成根目录两个 `stratified-development-20-*` 文件；它们未进入 v7 数据、训练或报告。
- final：未运行。所有实验止于 development/calibration，不把失败 calibration 调成“通过”。
- 软件验证：TypeScript 严格检查通过；场景生成、冻结模型、交互指标和建议面板专项测试 `34/34` 通过；`npm run build` 通过；`public/models` 与 `dist/models` 的冻结模型 SHA-256 均为 `4ba085da6e27b9b27c6944abaa0107b932d50c02a0af3ddb2359f55d6eb1a6d8`。

## 下一步唯一主线

1. 用统一 piecewise lag path 输出稳定平台序列，而不是直接给每个 shift 分类。
2. whole 取全序列共同基线；partial 取相邻平台差，并由断点后树芯侧反事实复核。
3. development 同时覆盖 v7 全整数与原多事件状态，calibration 必须在两套分布分别达到门槛。
4. 通过后才导出 TypeScript 头，并运行完整 60,000 案例 A/B/C/D；最后才启用新的完整文件 final。

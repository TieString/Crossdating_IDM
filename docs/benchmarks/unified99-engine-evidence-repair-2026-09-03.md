# 定年证据链修复与原始宽分布复验（2026-09-03）

## Material Passport

- 状态：**整体目标未通过，持续优化中；未切换生产模型，未运行 final**。
- 后续审计又发现：旧顺序生成器使用干净数据重新注入，既不等同于实际逐步编辑，也可能恢复已丢失宽度；旧ABCD评分还保留复制partial窗口作为missing的逻辑。本文第4节及其扩大量结果均只能作条件组件实验，不能作真实交互验收。修复记录见 `unified99-real-frontier-protocol-repair-2026-09-03.md`。
- 目标保持原范围：中部及近树皮、密集/不规则多事件、A/B/C/D、文件级相关性三档、目标干净 `masterCorrelation > 0.60`；最终操作与精确位移正确且唯一9–13年窗口覆盖当前前沿才算正确。
- 本阶段使用 `academic-research-suite` 的实验执行/可重复性流程：失败结果保留，输入链修复与模型改进分开记录。
- 工作区仅 `D:\Code\Crossdating_Tauri-experiment`；`D:\Code\Crossdating_Tauri` 保持未修改。
- 当前生产模型仍为 `unified99-runtime-v3`，SHA-256 `4ba085da6e27b9b27c6944abaa0107b932d50c02a0af3ddb2359f55d6eb1a6d8`。

## 1. 实际发现的两个证据链缺陷

### 1.1 RWL终止符误作年轮

`scripts/legacy-generalization/evaluator.ts` 的 `loadRwl` 和 `observedSite` 只排除 `-9999`。当输入文件使用 `999` 终止符时，测试源序列会把该数值保留为一个观测年；`preferFormat` 分支又绕过默认精度设置。

修复后，评估加载器从每份输入检测精度，显式传给解析器；源序列与工作状态都排除对应终止符。格式化/重开根据该文件保存的精度执行，不依赖另一个文件留下的全局值。显式0年仍保留。

### 1.2 近似标准化不是COFECHA报告预处理链

旧 `buildUnified99Sample` 使用默认 `cofechaStyleStandardize`（discrete-penalty/current-aic/double）并先删除0年。目标入选相关性却来自 `runCofecha` 的真实报告链（Cook–Holmes spline、variance stabilization、legacy AR/log/testingValues）。两者不是同一证据。

在完全相同的前500个development及500个calibration目标上：

| 输入链 | 相关性>0.60的目标 | 相关性<0.50的目标 |
|---|---:|---:|
| 原运行时近似链 | 694/1000 | 226/1000 |
| 仅正确设置文件精度 | 875/1000 | 55/1000 |
| cofecha-js报告 `testingValues`，严格目标排除 | 999/1000 | 0/1000 |

最后一行是报告整体相关性口径；再排除目标的显式0年后为997/1000。原有“目标信息不足”的推断因此不能直接成立：相当一部分信号是被错误输入链破坏的。

## 2. 修复内容

- 锁定依赖 `cofecha-js@0.2.0`，同步 `yarn.lock` 和第三方许可说明。
- 新增 `cofechaEngineEvidence.ts`：直接调用包的 `prepareCofecha606SeriesForReport`，使用 `testingValues`；0年经过完整预处理后才从定位似然和参考均值中屏蔽；目标芯全部分段都从参考中排除，不允许目标回填。
- 每芯预处理用精确内容缓存，文件精度作为缓存身份的一部分。
- 顺序生成器增加显式 `--evidence-engine cofecha-js`；新证据状态SHA-256只依赖源文件内容、目标ID与当前数值/年份状态，不包含truth、类别或剩余事件标签。证据版本另行进入evidence key。
- 旧生产v3默认证据入口未被静默替换，因为事件门、family和风险头必须在新输入链上重训/重新校准。

## 3. 全部6000个入选目标信号审计

| 分区 | 目标数 | 报告整体相关性>0.60 | 排除目标0年后>0.60 | 多分段目标 |
|---|---:|---:|---:|---:|
| development | 3000 | 2998 | 2983 | 17 |
| calibration | 3000 | 2999 | 2989 | 4 |

报告链没有目标低于0.50。应用解析状态进入新证据模块后的正值口径分别为2983和2988个>0.60；其余边界目标及少量解析/分段差异保留在逐目标JSON，不静默排除，也不以这些目标替代文件级r分档。

完整清单见 `unified99-engine-signal-audit-{development,calibration}-full.json` 及 `unified99-runtime-engine-signal-{development,calibration}-full.json`。

## 4. 原始v8宽分布的partial阶段复验

**没有使用v9的45年相邻断点限制。** 重用原v8的1–60年不规则间隔，包含剩余5+事件。当前仅是whole已被用户正确解决后的partial条件分支；不代表完整A/B/C/D事件门或family成绩。

样本：development 668机会/203文件，calibration 668机会/190文件，完整文件分区交集0。每个机会都重建当前前沿状态，目标/参考只由当前RWL提供。

位置模型为简洁的右删失最终转移：旧侧动态路径解释更老事件，当前候选partial从精确lag进入最新侧0平台；输出固定13年后验质量最大的窗口。

在development选定 `beta=0.7, change=6, jump=0` 后：

| 指标 | development | calibration |
|---|---:|---:|
| 给定正确位移时的13年窗口覆盖 | 96.11% | 95.06% |

这只是条件位置上限，**不能当作最终准确率**。

26个连续特征的整数位移ranker（完整候选 `-2…-100`、文件分组5折）得到：

| 指标 | development OOF | calibration |
|---|---:|---:|
| 唯一精确partial位移正确率 | 91.17% | 92.96% |
| 内部Top-2召回（仅审计） | 96.56% | 96.71% |
| 位移正确且唯一13年窗覆盖 | 88.17% | 89.07% |

calibration按来源类别拆分的partial机会：

| 来源类别 | 机会数 | 精确位移正确率 | 位移+窗口联合正确率 |
|---|---:|---:|---:|
| A | 351 | 98.29% | 94.87% |
| B | 156 | 92.95% | 89.10% |
| D | 161 | 81.37% | 76.40% |

C在该生成设计中只含missing/false，没有partial机会；**C类完整准确率本轮未测**。

补入逐参考芯断点处20/40年稳健统计的42特征头未稳定改善：calibration精确位移92.81%、联合窗口88.92%。保留为失败实验，不按calibration反向调参宣称通过。

## 5. 缓存、完整性与软件验证

- 首轮development：668个证据cache miss；芯预处理24537 hit / 9823 miss。
- 相同状态重放：证据668 hit / 0 miss；芯预处理0次；逐事件索引SHA-256完全不变。
- development索引SHA-256：`6fdc7f72d4f6602b2c4cc5d87ba48c62f1ac69fd5134ece0723fc4681692d10a`。
- calibration索引SHA-256：`835b60409e1006188c630e7a3548b667548d95250c696a2c5a0a9e201f86999a`。
- 位移ranker报告SHA-256：`eb1ca67a72f1fe6a3d47388947e6aa6730e01fa3d8973a6fc0df34a345aa2287`。
- TypeScript严格检查通过；终止符、分段精度、目标排除、缓存失效、冻结模型和交互专项测试41/41通过。
- 本次证据链专用 `tsconfig.engine-evidence.json` 严格检查通过；`npm run build`通过。旧研究总配置另有历史导出器的类型错误，不将该配置记为通过；直接依赖的两处类型/不可达分支问题已修复。
- 四分片变点CNN上一轮会话中断后进程不存在，模型和最终报告均未生成：状态为中断/未完成，不计入成绩。

## 6. 未完成事项与下一步

1. 精确partial位移仍受相邻混合事件吞并影响，尤其D类；需要在正确engine证据上扩大完整文件训练并审计累计位移错误。
2. whole完整整数头、missing/false family、Clean事件门、风险/覆盖工作点均需要在正确输入链上统一验证。
3. 近树皮1–14年压力样本需纳入统一新证据矩阵；当前v8本分片近端覆盖15–34年，不代表已完成1–34年验收。
4. v9仅作为长平台可辨识对照，不能替代密集分布，也不能用其95%组件结果宣称功能整体通过。
5. 未运行新的final；生产入口、co612完整716机会及新文件A/B/C/D最终验收尚未完成。

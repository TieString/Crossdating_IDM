# 仓库指南

这是一个用于树轮交叉定年的 Tauri + React + TypeScript 应用。这个文件是智能体或人工阅读代码时的第一入口，用来快速建立项目结构和数据流认知。

## 从这里开始

- [src/pages/Home.tsx](src/pages/Home.tsx)：主界面和整体流程编排入口
- [src/features/rwl/index.ts](src/features/rwl/index.ts)：RWL 格式识别与解析入口
- [src/features/crossdating/reference.ts](src/features/crossdating/reference.ts)：手动参考序列、COFECHA-pass 动态参考序列、PART 6 分类、COFECHA-style 标准化与 sample depth 入口
- [src/features/crossdating/diagnosis.ts](src/features/crossdating/diagnosis.ts)：内部轻量诊断、分段相关、lag search 与候选检查项入口
- [src/features/crossdating/diagnosis/eventEnsemble.ts](src/features/crossdating/diagnosis/eventEnsemble.ts)：窄事件窗口 ensemble、候选支持、局部移动多视图与混合事件补充入口
- [src/features/crossdating/diagnosis/eventOperationRecovery.ts](src/features/crossdating/diagnosis/eventOperationRecovery.ts)：事件操作恢复、单主窗口快速验证与窗口内多证据年份共识入口
- [src/features/crossdating/diagnosis/endpointResidualWindow.ts](src/features/crossdating/diagnosis/endpointResidualWindow.ts)：单缺轮/伪轮的多参考残差后验窄窗入口
- [src/features/crossdating/diagnosis/eventPath.ts](src/features/crossdating/diagnosis/eventPath.ts)：受约束 piecewise lag path 与事件边界定位入口
- [docs/js-internal-diagnosis-events-report.md](docs/js-internal-diagnosis-events-report.md)：JS 内部诊断的指标定义、数据拆分、冻结保留集和广域 ITRDB 准确度
- [src/services/fs/io.ts](src/services/fs/io.ts)：文件读写辅助与解析桥接
- [src/services/cofecha/runner.ts](src/services/cofecha/runner.ts)：COFECHA 执行与 OUT 文件处理
- [src/services/currentEventRanker/client.ts](src/services/currentEventRanker/client.ts)：Current-event V1 协议请求与 Tauri command 桥接
- [src/pages/home/useCurrentEventRanker.ts](src/pages/home/useCurrentEventRanker.ts)：模型会话、latest-wins 请求队列、stale/取消与连续确认
- [src-tauri/src/lib.rs](src-tauri/src/lib.rs)：Tauri 命令注册入口
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs)：前端可调用的 Rust 命令
- [src-tauri/src/current_event_ranker.rs](src-tauri/src/current_event_ranker.rs)：多模型目录、长驻 Python/PyInstaller JSONL sidecar 生命周期与切换校验

## 核心流程

1. 用户在 [src/pages/Home.tsx](src/pages/Home.tsx) 中打开 `.rwl` 文件。
2. [src/services/fs/io.ts](src/services/fs/io.ts) 读取文件，并把文本交给 RWL 解析器。
3. [src/features/rwl/index.ts](src/features/rwl/index.ts) 自动识别格式、推导 stop marker，并分派到具体解析器。
4. 解析后的数据通过 RWL 编辑器工具渲染并支持修改。
5. 用户可在折线图中进入“参考”模式，多选可靠序列；[src/features/crossdating/reference.ts](src/features/crossdating/reference.ts) 会按年份对齐生成 derived reference series，配置按文件路径持久化。
6. [src/features/crossdating/diagnosis.ts](src/features/crossdating/diagnosis.ts) 会基于 working series 和 reference config 计算内部轻量诊断，不运行外部 COFECHA，不自动修改数据。
7. 保存时会触发 [src/services/cofecha/runner.ts](src/services/cofecha/runner.ts)，它会把输入写入 COFECHA 工作目录，运行 sidecar，并读取 `VERYCOF.OUT`。
8. COFECHA 汇总结果的解析在 [src/features/cofecha/formatter.ts](src/features/cofecha/formatter.ts) 中完成，并由 [src/pages/home/useHomeWorkspace.ts](src/pages/home/useHomeWorkspace.ts) 按文件路径持久化最近一次 OUT/result 与 `RUN_COFECHA` 日志。
9. Rust 命令 [write_out_next_to_rwl](src-tauri/src/commands.rs) 会在可能的情况下把 OUT 文件镜像保存到源 `.rwl` 文件旁边。
10. [src/pages/home/useCurrentEventRanker.ts](src/pages/home/useCurrentEventRanker.ts) 管理 diagnostic-only Current-event V1；当前由 [src/shared/featureFlags.ts](src/shared/featureFlags.ts) 暂时关闭 Python 模型 UI、目录查询和 sidecar 调用，模型代码与资源仍保留。

## 文件格式说明

- Tucson RWL 是主要输入格式，支持短格式（8 列编号）和长格式（7 列编号）。
- 解析器依赖可从源文本推导出的 stop marker。
- **格式透明性**：打开什么格式的 RWL，保存后仍保持同样格式。详见 [RWL_FORMAT_SPEC.md](RWL_FORMAT_SPEC.md)。
- COFECHA 工作区文件保存在应用数据目录下的 `cofecha-work` 中。
- `VERYCOF.OUT` 是前端消费的关键输出文件。

## 已知问题与设计决策

### 格式透明性（已解决，2026-04-02）

**问题**：读取 Tucson 格式时自动判断 8 列或 7 列编号，但保存时固定用 6 列，导致：
- 长编号（7-8 字符）被截断
- 原始格式不保留，用户 RWL 文件被无声改变

**解决方案**（[RWL_FORMAT_SPEC.md](RWL_FORMAT_SPEC.md#格式透明性原则)）：
- [src/features/rwl/types.ts](src/features/rwl/types.ts)：`RwlReadResult` 新增 `readOptions` 字段记录格式参数
- [src/features/rwl/parsers/tucson.ts](src/features/rwl/parsers/tucson.ts)：自动检测 long/short 格式，结果保存到 readOptions
- [src/features/rwl/edit.ts](src/features/rwl/edit.ts)：RwlEditor 记录格式信息，formateRwlFromMapToString 支持格式参数
- [src/pages/Home.tsx](src/pages/Home.tsx)：打开/保存时透传格式信息

**验证**：打开 8 列编号 RWL → 编辑 → 保存 → 再打开 → 确认仍为 8 列；7 列格式同理

### 统一格式处理器框架（已实现，2026-04-10）

**模式**：每个格式的 parse 和 format 函数必须在同一文件，并通过 [src/features/rwl/index.ts](src/features/rwl/index.ts) 的 formatHandlers 注册表统一管理。
- 新增格式时，在格式文件中同时实现 parse/format 函数
- 在注册表中注册一次，自动被 RwlEditor 和读取入口使用
- 详见 [src/features/rwl/index.ts](src/features/rwl/index.ts) 的注释和 [src/features/rwl/parsers/tucson.ts](src/features/rwl/parsers/tucson.ts) 的参考实现

### 参考序列与工作区窗口（进行中，2026-06-12）

**当前实现**：
- [src/components/Chart/TreeChartManager.tsx](src/components/Chart/TreeChartManager.tsx)：维护参考选择模式，并把 reference config 上抛给 Home/workspace state。
- [src/components/Chart/MultiLineChart.tsx](src/components/Chart/MultiLineChart.tsx)：以加粗虚线绘制 reference series，并在 tooltip 中显示 sample depth；会把当前可见序列的 flagged/problem segments 作为淡色背景带显示。
- [src/pages/home/useHomeWorkspace.ts](src/pages/home/useHomeWorkspace.ts)：按文件路径持久化 reference config 和参考辅助日志。
- [src/pages/home/workspaceWindowBridge.ts](src/pages/home/workspaceWindowBridge.ts)：独立折线图窗口会同步 reference config，并把参考变更命令发回主窗口。
- [src/features/crossdating/diagnosis.ts](src/features/crossdating/diagnosis.ts)：自动生成内部 problem segment count、A-like/B-like segment、propagation pattern、三类候选编辑与 before/after evidence；用户确认后可一次应用一个候选。
- 内部诊断输出 `DiagnosisEvent` 人工复核窗口：每个独立事件只保留一个主窗口，不向 UI 暴露操作备选或位置备选。局部移动在内部联合扫描 `shiftYears=-2..-100`，最终只保留一个通过门槛的 `firstFixedYear + shiftYears`；`-1` 仍由缺轮表达，正向位移不得成为自动局部移动。事件保留 lag before/after、移动方向和证据来源，用户二次确认后才转换为受约束编辑。
- [src/features/crossdating/diagnosis/partialMoveSemantics.ts](src/features/crossdating/diagnosis/partialMoveSemantics.ts)：统一局部缺失上限、动态负向位移生成和 `firstFixedYear ↔ lastMovedYear` 转换。默认最大缺失块为 100 年，并继续受 lag 容量、序列长度和两侧最小上下文限制。
- [src/features/crossdating/diagnosis/perReferenceCounterfactualEvidence.ts](src/features/crossdating/diagnosis/perReferenceCounterfactualEvidence.ts)：对已经选定的操作逐参考芯执行线性时间反事实扫描，稳健合并差分/预白化证据，并降低高度相关参考芯的重复权重。
- [src/features/crossdating/diagnosis/unitEventWindowRanker.ts](src/features/crossdating/diagnosis/unitEventWindowRanker.ts)：缺轮和伪轮使用文件分组、任意日历位置案例离线训练的静态 JS 树，在完整可用区间枚举全部 13 年模式，并以独立宽度风险层输出唯一 9 或 13 年窗口。模型推理不调用 Python，局部移动不进入该模型。
- [src/features/crossdating/diagnosis/calibratedEventWindow.ts](src/features/crossdating/diagnosis/calibratedEventWindow.ts)：保留局部移动和短序列回退所需的确定性窗口校准；缺轮和伪轮在新模型可用时不再经过旧的相邻年份缩窗规则。
- [src/features/crossdating/diagnosis/eventReviewWindow.ts](src/features/crossdating/diagnosis/eventReviewWindow.ts)：保留给离线实验的展示层扩窗工具；正式内部诊断传入 `0`，主窗口不做默认扩展。
- [src/features/crossdating/diagnosis/eventWindowRefinement.ts](src/features/crossdating/diagnosis/eventWindowRefinement.ts)：逐年反事实扫描只允许固定宽度窗口保守平移；普通边缘证据最多平移 1 年，只有扫描峰与 raw path/候选峰在同侧且相距不超过 2 年时才允许最多平移 3 年。促成移动的边缘年份仅在“整体移动 + 单位事件”对齐分支中可作为排序锚点。
- [src/features/crossdating/diagnosis/eventEnsemble.ts](src/features/crossdating/diagnosis/eventEnsemble.ts)：整体移动与单缺轮/伪轮共存时，先按 path newest lag 对齐 diagnosis、event 与 raw-event 日历，在对齐坐标中执行窗口细化和参考投票，再映回显示日历；缺轮 Top1 的 1 年校正必须由参考投票或近距离扫描歧义触发，禁止整类年份硬偏移。事件合并和去重完成后，最终出口才做强证据窗口收窄；伪轮只有在 19 类年份证据形成严格方向共识时才允许把唯一窗口同宽平移 1 年。
- [src/features/crossdating/diagnosis/eventReferenceVoting.ts](src/features/crossdating/diagnosis/eventReferenceVoting.ts)：相邻缺轮+伪轮的局部参考配对必须通过短 lag 脉冲、参考数、同向改善比例、相关增益和远端 margin 门；弱全局但强局部的补充门只接受不超过 12 年的脉冲。逐参考芯 baseline 每对只计算一次，低一致性配对不能进入生产事件。
- [src/features/crossdating/diagnosis/jointEventRefinement.ts](src/features/crossdating/diagnosis/jointEventRefinement.ts)：对 2 至 3 个 lag 链一致的局部事件联合枚举反事实年份组合；搜索可越过既有窗口边缘 1 年，但输出保持原窗宽，且局部移动只作为条件、不覆盖其专用断点排序。
- [src/features/crossdating/diagnosis/partialBreakpointRefinement.ts](src/features/crossdating/diagnosis/partialBreakpointRefinement.ts)：负向且绝对位移大于 1 年的局部移动断点允许扫描到目标序列两端 15 年处，诊断和事件去重阶段仍保留 9 年窗口；只有至少三种断点视图在同一局部簇达成一致、且该簇距离原路径窗不超过 3 年时，才允许整体重定位。相邻 Top1 排序仍要求 raw 与多尺度视图同时同意。
- [src/components/Chart/MultiLineChart.tsx](src/components/Chart/MultiLineChart.tsx)：在折线图上绘制未失效事件窗口背景带；缺轮、伪轮、局部移动使用不同颜色，高亮折线时只显示对应序列。
- [src/components/Chart/TreeChartManager.tsx](src/components/Chart/TreeChartManager.tsx)：点击诊断窗口内折线时，只预览最终自动事件，不列出内部 `-2..-100` 假设或备选位移。局部移动直接使用事件的唯一 `firstFixedYear + shiftYears`；预览与应用共享精确范围，临时整序列视觉偏移必须换算回源年份。
- [src/components/DiagnosisCandidates/DiagnosisEventPanel.tsx](src/components/DiagnosisCandidates/DiagnosisEventPanel.tsx)：只展示最新 JS 事件级复核窗口；局部移动只显示首选断点和唯一位移量，不把窗口内年份或内部位移假设渲染为候选组。应用前仍须展示精确操作预览并再次确认。
- [src/features/crossdating/diagnosis/eventApply.ts](src/features/crossdating/diagnosis/eventApply.ts)：把用户复核事件转换为既有编辑语义；局部移动的公开年份是 `firstFixedYear`，应用范围严格结束于 `firstFixedYear - 1`，且自动位移必须小于 -1。
- 主窗口诊断 worker 在 40 ms 防抖后只诊断当前选中序列，整站其它序列仍全部参与参考 chronology；选择“全部”时不启动诊断。成功 worker 会保留复用，未变化的 site/reference/COFECHA/target 直接复用诊断结果。`targetTrees` 限定不改变目标序列结果，并避免大站点对每条不可见序列重复运行完整事件管线。
- 一次目标诊断内部会缓存 series preprocess 和 lag path 证据；局部反事实编辑复用固定 reference master，整条移动仍重建 master。Pearson 段相关不创建 pair 数组，piecewise 的零 lag 新旧段基线在候选 lag 间复用。正式单主窗口模式后台验证前三个高分操作假设，但跳过最终不会显示的位置/操作备选及其补充验证，出口仍只保留一个主操作和一个主窗口。
- 缺轮和伪轮的完整区间定位器仍保留约 25 年粗搜索证据，但最终模式选择会比较完整可用区间内的全部连续 13 年窗口；UI 只接收该模式内部唯一的 9 或 13 年主窗口。5/7 年实验若降低覆盖率不得上线，校准不通过时回退 13 年。正式入口不调用旧 `adaptiveWindowRisk` 的 17 年或粗区间回退。
- 自动交叉定年主管线第一版已经完成；当前算法层在同一入口中显式包含 Baillie & Pilcher-style global sliding match、Holmes/COFECHA-like segmented diagnosis、Van Deusen/Wenk-style local edit alignment，以及 Hassan-style MVP relative-confidence ranking。
- 折线图候选生成由“生成候选”按钮触发；本轮不使用 hover 触发自动分析。
- COFECHA-pass 动态参考序列已接入：每次 COFECHA 完成后复用 PART 6 `[A] Segment` 判断，把无 A flag 样芯作为 `anchor_pass` 参考锚定组，有 A flag 样芯作为 `candidate_flagged` 待检查组，并用标准化后的 anchor 序列生成 `COFECHA-pass 参考序列`。用户手动生成参考后会切到 manual 模式；折线图提供“恢复动态”回到最新 COFECHA-pass 参考。
- [src/features/crossdating/reference.ts](src/features/crossdating/reference.ts)：动态参考生成按 COFECHA master dating series 流程执行：每条样芯先做 32 年 50% response cubic smoothing spline 去趋势，计算 `raw / spline` 的 dimensionless index，再用 AR(p) 预白化、默认 log transform、可选 first difference；随后按年份 accumulator/counter 算术平均，并把最终 master 标准化为 mean=0、sd=1。0 值 absent ring 默认不进入 reference。Spline 线性系统使用带宽 2 的 Cholesky O(n) 求解，保留共轭梯度作为数值异常回退。

**约束**：
- reference series 是 derived series，不进入 RWL 数据本体，不允许作为普通序列编辑。
- 手动 reference 计算按年份对齐并直接 arithmetic mean；COFECHA-pass 动态 reference 只能平均转换后的 residual index，最终输出 mean=0、sd=1 的 residual chronology，低于最小 replication 的年份不绘制。
- 参考变更写入操作日志，但不参与 RwlEditor 的撤销/恢复栈。
- 内部诊断是 COFECHA-like 快速提示，不替代外部 COFECHA 最终验证；候选项必须由用户确认后才能通过 edit.ts 操作落地。
- 窗口覆盖率、精确 Top1、Top1±1、操作准确率、事件精确率、拒答率和干净误报必须分开报告，而且正式统计只能使用每种类型证据分数最高的主事件及其唯一主窗口。不得用历史 `locationAlternatives` 或 `operationAlternatives` 补足准确率。正式目标芯只按长度/跨度/稳定顺序选择，参考芯只按日历重叠选择；单事件年份只能使用与宽度/相关性无关的五位置分层采样，混合事件锚点同样只能读取日历范围和稳定 seed。`pickExploratoryStrongSignalYear` 只允许用于明确标注的探索性上限实验。offset 0–12 的当前单主窗口结果为：缺轮/伪轮/局部移动响应 92.0%/92.0%/94.8%，主窗口覆盖 72.6%/74.2%/77.8%，全 case 精确 Top1 23.7%/26.5%/51.1%，Top1±1 48.0%/47.4%/62.8%，平均窗宽 7.03/6.68/7.75 年，中位窗宽 7/7/8 年，P90 窗宽 7/7/9 年，干净误报 12.6%。局部移动位移量在全部 case/已响应 case 中为 90.2%/95.1%，位移量与窗口联合命中 77.8%。混合训练/独立站点全场景事件召回为 83.3%/89.4%，精度为 82.7%/94.4%；多类型场景召回为 83.3%/87.0%，精度为 82.2%/93.1%；相邻缺轮+伪轮召回为 50.0%/66.7%。offset 13–24 均已消费，不得再作为独立留出。
- 2026-07-31 缺轮/伪轮窗口层复验：在 100 个任意日历位置案例中，严格限定为构造前无诊断事件的 50 个序列，缺轮/伪轮响应率均为 100%，操作准确率均为 100%，完整正确率分别为 90%/94%，唯一主窗口中位宽度均为 9 年、P90 均为 13 年，未构造事件的同一批干净序列误报率为 0。窗口内精确 Top1 仍只有 28%/34%，5/7 年缩窗和学习式逐年排序实验均因留出集不能稳定改善而未接入；后续排序优化不得改动已冻结的窗口。
- COFECHA-pass reference 与 COFECHA run/rwlHash 绑定；RWL 编辑后动态 reference 标记为 stale，直到重新运行 COFECHA。`anchor_pass` 不进入后续整体 offset 检查目标，预留检查入口只使用 `candidate_flagged`。
- 自动候选仍只允许落到三类可执行编辑：`insertMissingYear`、`deleteFalseYear`、`batchMoveYears`（包含 `wholeSeriesMove` 与 `partialRangeMove`）。`wholeSeriesMove` 必须来自整条序列移动证据，`partialRangeMove` 必须保留 selectedRange/missingRange evidence，不能退化成插入一串 0。
- 候选 evidence 需要保留 algorithmSource、before/after metrics、relative confidence（rank/probabilityLike/confidenceLevel），其中 probabilityLike 只表示内部候选相对置信度，不是严格贝叶斯后验概率。
- 应用诊断候选时必须复用 [src/features/rwl/edit.ts](src/features/rwl/edit.ts) 的编辑路径，并以 `auto-suggested` 来源写入既有操作记录，保留 reason、候选年份、side/shift、selectedRange/missingRange 与 before/after metrics。
- 每次接受候选后仍然只应用一个候选，随后必须基于当前 working series 重新诊断；旧候选必须 stale。不要恢复 hover 分析，不要新增持久化操作日志/恢复机制，不要把无约束 DTW 作为主算法。
- 自动建议预览只在命中诊断主窗口时出现，不得把内部位移网格转成按钮、菜单或手工选项。独立手工片段移动工具可继续存在，但不能反向参与或覆盖自动事件选择。所有写入仍需二次确认、进入撤销栈/操作日志并立即使旧事件诊断 stale。
- Current-event V1 采用独立协议和会话：Top5 的 `rankingScore` 不是概率；用户在 ±1 范围内确认精确年份后只进入 `confirmedInsertions` 并计算下一轮，点击“应用到当前 RWL 工作区”后才复用 `insertMissingYearAtSide(..., "right")`。保存后清空会话确认，避免磁盘数据与 confirmed insertion 双重应用。
- Current-event V1 保存触发绑定实际写盘快照；文件写入按发起顺序串行，保存期间继续编辑不会把未写盘数据误标为已保存，旧文件/旧序列的迟到保存也不会重新激活模型。Rust 的冷启动、握手、预测和一次重试共用 60 秒异常保护上限；它不是固定等待时间，长驻后的请求通常更快。
- 加载文件期间使用同步 loading guard 和 workspace epoch，只有解析成功才提交新路径；保存触发的 COFECHA 完整运行串行，避免共享 `cofecha-work` 的并发清理/OUT 覆盖。
- Current-event V1 是 diagnostic-only；完整数据重训没有新的无偏测试指标，不能称为 production model。它不使用 final_blind、event union、未知 `zero_count` 或 `remaining_event_count` 标签。
- Current-event 模型资源按 `src-tauri/resources/current_event_ranker/models/<model-id>/bundle` 并列保留，但当前 Python 模型 UI、目录查询和 sidecar 调用由 feature flag 关闭。若以后重新启用，切换模型必须清空未应用确认并使旧建议 stale；v1.3 adaptive-range 的 `advice`/`range_advice`/`evidence_insufficient` 协议和服务端 Top5 顺序约束仍需保留。
- `current-event-missing-rrf-v1` 是独立的缺轮专家路线，固定 `existingZeroPolicy=remove`、`topK=5`、`rangeRadius=3`、最多6个确认，且保存不得自动触发。它只支持 `insert_missing`；每条建议展示中心年、±3核查范围、path/none rank 与本轮可靠性。拒答不得补位或解释为修复完成。最终应用必须先移除目标序列全部既有 0，再从新到旧原子重建会话确认，并复用 RwlEditor 撤销栈/操作日志。
- [src/features/rwl/edit.ts](src/features/rwl/edit.ts)：`RwlEditor` 保留首次加载的 raw baseline，并在 history snapshot 中持久化 raw/working 数据、删除标记与 operation log；操作日志窗口的“回到原始”会走 `resetToRawData()`，不会依赖逐条反向猜测。
- [src/pages/home/useHomeWorkspace.ts](src/pages/home/useHomeWorkspace.ts)：打开文件时若恢复了 working series，后续 COFECHA 运行使用 editor 当前导出的 working RWL；`Save As` 会切换当前文件路径，并把保存后的当前数据作为新文件的 raw baseline。
- [src/components/WidthContainer/WidthContainer.tsx](src/components/WidthContainer/WidthContainer.tsx)：宽度网格顶部显示最近操作记录摘要，条目来自统一 workspace operation log；可定位到真实 series/year 的条目会复用主窗口跳转高亮逻辑。
- [src/pages/home/WorkspacePages.tsx](src/pages/home/WorkspacePages.tsx)：独立操作日志窗口支持按文本、来源和状态筛选记录；批次摘要只展示当前筛选范围内的可审计批次。
- [src/pages/home/workspaceWindowBridge.ts](src/pages/home/workspaceWindowBridge.ts)：独立窗口 request/closed 事件携带窗口 label，主窗口只接受匹配 label 的生命周期事件，避免旧窗口或重复关闭事件误改同步状态。

## 编辑规则

- 解析器、运行器和桥接层优先写模块级说明。
- 行内注释要短，重点说明假设、边界条件和文件格式约束。
- 当项目入口、数据流或文件格式变化时，及时更新这个指南。
- 如果新增了解析器或命令，要把新路径写到这里。

## 常用命令

- `npm run dev`
- `npm run build`
- `npm run validate` — 聚合运行样例解析/窗口 smoke/自动交叉定年算法验证
- `npm run validate:samples` — 用仓库样例跑 RWL 解析、内部诊断和验证摘要链路
- `npm run validate:samples:strict` — crossdated 样例仍有内部问题段时返回非零并列出序列
- `npm run validate:cofecha:samples` — 直接调用本地 COFECHA sidecar 验证 crossdated 样例的 A/problem
- `npm run validate:workspace-windows` — SSR smoke 验证独立操作日志/COFECHA 窗口关键渲染与桥接常量
- `npm run validate:auto-crossdating` — synthetic demo 验证 global sliding、segmented diagnosis、local edit alignment、partial range move、candidate ranking、三类候选、应用后重新诊断与 stale 标记
- `npm run validate:cofecha-reference` — synthetic demo 验证 PART 6 A flag 分类、COFECHA-pass reference 生成、最终 master mean=0/sd=1 与 offset target set
- `npm run validate:current-event-ranker` — 校验三套完整 bundle、RRF deployment/exe 哈希、251/70/10/109 特征协议、参考预测、双门控/RRF 状态、Tauri resource/externalBin 与禁止资源
- `npm run trial:auto-crossdating` — 在临时目录对 RAW 样例应用自动诊断候选并跑 COFECHA 对比；每轮每条序列只应用一个候选，不修改源文件
- `node scripts/profile-js-diagnosis.mjs <file.rwl> --target=<series>` — 测量单目标 JS 事件诊断解析与计算耗时
- `npm run tauri`

## 建议阅读顺序

1. [README.md](README.md)
2. [AGENTS.md](AGENTS.md)
3. [RWL_FORMAT_SPEC.md](RWL_FORMAT_SPEC.md) — 若要理解 RWL 格式设计
4. [src/pages/Home.tsx](src/pages/Home.tsx)
5. [src/features/rwl/index.ts](src/features/rwl/index.ts) — 格式处理器注册表
6. [src/features/crossdating/reference.ts](src/features/crossdating/reference.ts)
7. [src/features/crossdating/diagnosis.ts](src/features/crossdating/diagnosis.ts)
8. [src/services/cofecha/runner.ts](src/services/cofecha/runner.ts)
9. [src-tauri/src/lib.rs](src-tauri/src/lib.rs)

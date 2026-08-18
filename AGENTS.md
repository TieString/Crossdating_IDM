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
- [src/features/crossdating/diagnosis/eventAdjudicator.ts](src/features/crossdating/diagnosis/eventAdjudicator.ts)：定位提案字段契约、证据优势判断与弱定位回退入口
- [src/features/crossdating/diagnosis/evidenceLedger.ts](src/features/crossdating/diagnosis/evidenceLedger.ts)：事件存在、操作/lag、位置和参考支持的类型化只追加证据边界；旧 notes 仅在此兼容转换
- [src/features/crossdating/diagnosis/jointEventAdjudicator.ts](src/features/crossdating/diagnosis/jointEventAdjudicator.ts)：将完整阶段事件聚合为不可变的“操作 × 位移 × 位置”假设，先按操作证据、再按位置模式统一选择；切换生产前通过 `jointEventDecisions` shadow 审计
- [docs/js-internal-diagnosis-events-report.md](docs/js-internal-diagnosis-events-report.md)：JS 内部诊断的指标定义、数据拆分、冻结保留集和广域 ITRDB 准确度
- [src/services/fs/io.ts](src/services/fs/io.ts)：文件读写辅助与解析桥接
- [src/services/cofecha/runner.ts](src/services/cofecha/runner.ts)：COFECHA 执行与 OUT 文件处理
- [src-tauri/src/lib.rs](src-tauri/src/lib.rs)：Tauri 命令注册入口
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs)：前端可调用的 Rust 命令

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
- 图表进入参考选择模式后提供“可靠序列”，复用最新 COFECHA PART 6 分类的 `anchorPassIds` 填充参考草稿，再由用户确认生成手动参考；无分类结果时该操作禁用。
- 折线图普通序列多选由 Home 统一持有，并通过 [src/pages/home/workspaceWindowBridge.ts](src/pages/home/workspaceWindowBridge.ts) 同步到独立折线图窗口；折线高亮只属于图表本地交互，不会直接切换宽度模块。选中折线后可在右键菜单按鼠标所在年份执行“在宽度模块中定位”；若尚未选中折线，在折线附近直接右键会先命中并高亮最近折线再打开菜单。序列按钮会显示 COFECHA PART 6 `[A]` 状态。
- [src/components/Chart/MultiLineChart.tsx](src/components/Chart/MultiLineChart.tsx)：以加粗红色实线绘制手动 reference series，以绿色虚线绘制 COFECHA-pass 动态参考，并显式保留空缺年份断点、在 tooltip 中显示 sample depth；普通序列调色板不使用红色，当前可见序列的 flagged/problem segments 作为淡色背景带显示。
- [src/components/WidthContainer/WidthGridContextMenu.tsx](src/components/WidthContainer/WidthGridContextMenu.tsx)：宽度元素右键“在图表中定位”会选中对应折线，以固定 50 年窗口定位到目标年份，并复用图表单击标记线显示该年份；标记状态保存日历年而非数组索引，独立折线图窗口复用同一跳转目标。
- [src/components/WidthContainer/treeRingArtwork.ts](src/components/WidthContainer/treeRingArtwork.ts)：按 RWL 宽度值 `÷1000` 转为毫米，复现早材白底、六层晚材点纹和 0.18 mm 年轮边界；文件载入后按空闲时间分片预热各序列，并以宽度签名和有界 Blob URL 缓存一份完整物理截面，径向预览与完整悬浮窗复用该 SVG。每个 `series-header` 中间的窗口占满标题统计项以外的剩余宽度；预览以 10 mm 为基准，再按 SVG 实际像素比例动态扩展或收窄垂直物理视窗，使树心到树皮始终完整、四边填满且不发生横纵独立拉伸。动态 `viewBox` 提供 1–32 倍滚轮缩放与横向拖动，不需要逐帧重绘 Canvas；年轮上的滚轮由非被动捕获监听消费，不允许继续滚动工作区。悬停年份提示显示在按钮上方，单击会选择对应宽度格并在图中标出该轮，已缩放时同步将其移入视窗；双击才打开唯一完整圆形截面。完整悬浮窗的标题栏负责移动窗口，图片区域支持鼠标锚点滚轮缩放和放大后二维平移，双击图片恢复全图，右下角手柄可调窗口大小且始终限制在可视区域。中间缺失年份以不虚构物理宽度的分隔标记显示，显式 0 宽缺轮单独标记；编辑后的当前序列使用新宽度签名自动更新。宽度模块不再显示贝叶斯定年按钮，旧算法实现文件暂予保留。
- [src/features/treeRingScans](src/features/treeRingScans)：扫描影像文件夹只按不区分大小写的同名文件建立索引，不在载入文件夹时批量读取影像。双击绘制版进入完整视图后才能切换扫描版并依次标注锚点：首点是序列最新年份之前最近的整十年，随后每点递减 10 年；整 50 年显示两个竖排点，整百年显示三个。至少两个锚点后才允许在 `series-header` 显示扫描图 1 cm 近似窗口。锚点保留校准时的原始年份身份，之后通过已应用的 RWL 操作日志重放为当前年份；悬停显示“原年份 / 现年份”，单击按当前年份定位宽度格，替换整段数据等无法可靠追踪身份的操作会要求重新校准。
- [src/components/WidthContainer/useTreeRingScanImage.ts](src/components/WidthContainer/useTreeRingScanImage.ts) 与 Tauri `prepare_tree_ring_scan_image` 命令：外部扫描图按需复制到 app cache；大型 TIFF 使用分块读取生成总览，用户自由选框后按原始像素提取样本截面，不静默降采样。完整扫描窗口使用按 `devicePixelRatio` 配置的高 DPI Canvas，缩放、平移或旋转时直接从原始裁切图重绘当前视口，禁止放大低分辨率 SVG 中间层。前端 Blob URL 缓存有数量和字节上限，Rust 缓存按 2 GiB 上限清理旧文件。支持 SVG、PNG、JPEG、WebP、BMP、GIF 和 TIFF。扫描图选择、截面选框、90° 旋转、锚点、校准基线与显示模式按 RWL 文件路径持久化，重启后恢复。
- [scripts/export-tree-ring-scan-fixtures.ts](scripts/export-tree-ring-scan-fixtures.ts)：把 RWL 中全部序列导出为与序列 ID 同名的完整绘制版 SVG，可直接作为扫描影像工作流的文件夹测试夹具。
- 宽度网格与折线图复用同一右键菜单：插入、删除、删除序列、文本编辑和可用时的 COFECHA PART 6 定位保持一致；宽度网格额外提供“在图表中定位”，折线图对应提供“在宽度模块中定位”。独立折线图通过窗口桥接把文本编辑和 COFECHA 定位命令交回主窗口执行。
- [src/pages/home/useHomeWorkspace.ts](src/pages/home/useHomeWorkspace.ts)：按文件路径持久化 reference config 和参考辅助日志。
- [src/pages/home/workspacePersistence.ts](src/pages/home/workspacePersistence.ts)：COFECHA、reference 与 RWL history 等大工作区状态保存到应用数据目录 `workspace-state-v1`；启动时安全迁移旧 localStorage 项，localStorage 只保留小型界面设置。
- [src/pages/home/workspaceWindowBridge.ts](src/pages/home/workspaceWindowBridge.ts)：独立折线图窗口会同步 reference config，并把参考变更命令发回主窗口。
- [src/features/crossdating/diagnosis.ts](src/features/crossdating/diagnosis.ts)：自动生成内部 problem segment count、A-like/B-like segment、propagation pattern、三类候选编辑与 before/after evidence；用户确认后可一次应用一个候选。
- 内部诊断输出 `DiagnosisEvent` 人工复核窗口：每个独立事件只保留一个主窗口，不向 UI 暴露操作备选或位置备选。局部移动在内部联合扫描 `shiftYears=-2..-100`，最终只保留一个通过门槛的 `firstFixedYear + shiftYears`；`-1` 仍由缺轮表达，正向位移不得成为自动局部移动。事件保留 lag before/after、移动方向和证据来源，用户二次确认后才转换为受约束编辑。
- [src/features/crossdating/diagnosis/partialMoveSemantics.ts](src/features/crossdating/diagnosis/partialMoveSemantics.ts)：统一局部缺失上限、动态负向位移生成和 `firstFixedYear ↔ lastMovedYear` 转换。默认最大缺失块为 100 年，并继续受 lag 容量、序列长度和两侧最小上下文限制。
- [src/features/crossdating/diagnosis/pathFixedSideWholeBaseline.ts](src/features/crossdating/diagnosis/pathFixedSideWholeBaseline.ts)：从局部 lag 路径终态与最近端 20--23 年嵌套窗口分别估计较新固定侧 whole baseline，并在原始 diagnosis/COFECHA-core 双视图中仲裁。路径由 partial 转移锚定时优先保留路径基线；单位阶梯与短尾的差值可解释为合法负向 partial 时保留短尾整体基线。所有候选必须通过普通或联合内存反事实，并按证据族优先级而非不可比的原始 score 排序；通过的候选由 supplemental sink 返回引擎，保证 UI 显示的 whole 事件具有可实际应用的 candidate ID。
- [src/features/crossdating/diagnosis/perReferenceCounterfactualEvidence.ts](src/features/crossdating/diagnosis/perReferenceCounterfactualEvidence.ts)：对已经选定的操作逐参考芯执行线性时间反事实扫描，稳健合并差分/预白化证据，并降低高度相关参考芯的重复权重。
- [src/features/crossdating/diagnosis/unitReferenceConsensusRecovery.ts](src/features/crossdating/diagnosis/unitReferenceConsensusRecovery.ts)：仅在完整正式融合仍拒答后，以 master 预筛和逐参考芯反事实共识选择性恢复一个伪轮事件；不会覆盖既有回答、生成备选或处理局部移动。
- [src/features/crossdating/diagnosis/unitEventWindowRanker.ts](src/features/crossdating/diagnosis/unitEventWindowRanker.ts)：缺轮和伪轮先从完整可用区间的质量、峰值、change-point、逐参考芯、操作锚点和粗区间证据中提出高召回 13 年物理模式；再在约 25 年粗区间内逐年执行虚拟插年/删年，用冻结的 grouped LambdaRank 与重叠后验选择唯一 13 年模式。缺轮使用逐参考芯预测 Huber 证据，伪轮使用 master/逐参考芯 Huber 证据；困难伪轮 13 年模式还会在四条完整虚拟删年曲线一致时做一次受门控的同宽重定位。模型推理全部在 TypeScript 中完成，不调用 Python，局部移动不进入该模型。
- [src/features/crossdating/diagnosis/unitEventPhysicalProfileModeRecovery.ts](src/features/crossdating/diagnosis/unitEventPhysicalProfileModeRecovery.ts)：只复核仍为 13 年的困难单位事件模式。缺轮要求完整差分剖面和逐参考芯投票剖面同时改善；伪轮联合累计 lag、参考投票 CUSUM 和 pair-peak 剖面，并由当前模式来源及独立锚点门控。该层只替换唯一 13 年模式的位置，不增加备选、不改变响应判定，也不处理局部移动。
- [src/features/crossdating/diagnosis/falseRingFamilyModeSelector.ts](src/features/crossdating/diagnosis/falseRingFamilyModeSelector.ts)：把累计 lag、变化点、成对残差和逐参考芯删年证据分成四个家族，家族内平均、家族间取中位数；当前锚点修正至少需要两家族支持，远距离和有界二次修正需要四家族一致。内部只改变唯一 13 年模式，不输出备选窗口。
- [src/features/crossdating/diagnosis/unitEventShortWindowSelector.ts](src/features/crossdating/diagnosis/unitEventShortWindowSelector.ts)：学习定位器先锁定唯一 9/13 年模式，独立物理定位窗可在安全门通过时缩到 7/5 年；最终再在同一 13 年模式内汇总完整反事实、变化点、差分、预白化、pair 和逐参考芯剖面的最佳 9 年偏移。缺轮取 13 条剖面的中位偏移并保护强单侧锚点；伪轮只对 family 模式做 14 条剖面中位裁决，证据冲突时保留 13 年。最终仍只输出一个 5/7/9/13 年主窗口。
- [src/features/crossdating/diagnosis/unitEventPointWindowSelector.ts](src/features/crossdating/diagnosis/unitEventPointWindowSelector.ts)：缺轮在粗区间内把四条冻结虚拟插年曲线与既有 lag/change-point 证据合并为逐年分数和概率质量，先选择一个 13 年物理模式，再由独立宽度安全门决定唯一主窗口使用 9 年或回退 13 年。内部年份和宽度备选不向 UI 暴露；伪轮点定位器尚未通过留出验证，正式路径不调用它。
- [src/features/crossdating/diagnosis/unitEventLocalCorrectionRanking.ts](src/features/crossdating/diagnosis/unitEventLocalCorrectionRanking.ts)：主窗口冻结后才对窗内年份执行轻量虚拟纠正。正式路径只把缺轮的预白化 master Huber 相似度用于精排；伪轮局部删年项因跨分区不稳定已停用。该模块不得改变操作、响应、唯一主窗口或窗口宽度。
- [src/features/crossdating/diagnosis/calibratedEventWindow.ts](src/features/crossdating/diagnosis/calibratedEventWindow.ts)：保留局部移动和短序列回退所需的确定性窗口校准；缺轮和伪轮在新模型可用时不再经过旧的相邻年份缩窗规则。局部移动会合并逐参考芯 fixed-lag 阶跃剖面；位移量的远距离优势不足时保留 13 年窗，不得仅凭平坦物理峰过早收窄为 9 年。
- [src/features/crossdating/diagnosis/eventReviewWindow.ts](src/features/crossdating/diagnosis/eventReviewWindow.ts)：保留给离线实验的展示层扩窗工具；正式内部诊断传入 `0`，主窗口不做默认扩展。
- [src/features/crossdating/diagnosis/eventWindowRefinement.ts](src/features/crossdating/diagnosis/eventWindowRefinement.ts)：逐年反事实扫描只允许固定宽度窗口保守平移；普通边缘证据最多平移 1 年，只有扫描峰与 raw path/候选峰在同侧且相距不超过 2 年时才允许最多平移 3 年。促成移动的边缘年份仅在“整体移动 + 单位事件”对齐分支中可作为排序锚点。
- [src/features/crossdating/diagnosis/eventEnsemble.ts](src/features/crossdating/diagnosis/eventEnsemble.ts)：整体移动与单缺轮/伪轮共存时，先按 path newest lag 对齐 diagnosis、event 与 raw-event 日历，在对齐坐标中执行窗口细化和参考投票，再映回显示日历。最终操作融合以局部单位事件较新侧的 `lagAfter` 为固定侧基线，不能按 lag=0 反转缺轮/伪轮方向；一个整体基线与一个明确的 ±1 lag 阶跃共存时保留联合状态窗口，不再用单事件定位器二次覆盖。融合后若局部移动的 `shiftYears` 与整体 lag 完全相同，且 lag 状态恰好由该值跃迁到 0，则整体移动只是局部事件别名，应删除；固定侧仍有非零 lag 时必须保留真实的整体移动与局部移动共存。缺轮 Top1 的 1 年校正必须由参考投票或近距离扫描歧义触发，禁止整类年份硬偏移。事件合并和去重完成后，最终出口才做强证据窗口收窄，并删除 `reviewCoreRange`、位置备选和操作备选；伪轮只有在 19 类年份证据形成严格方向共识时才允许把唯一窗口同宽平移 1 年。locator 前的完整事件是操作身份检查点，后续定位只能提交窗口方案，不得改写 `eventType`、`shiftYears`、`shiftSide`、lag 状态或 candidateIds。
- [src/features/crossdating/diagnosis/eventAdjudicator.ts](src/features/crossdating/diagnosis/eventAdjudicator.ts)：集中裁决 locator 提案与降低门槛的单位事件假设。相交模式可接受；远距离模式必须由校准定位通道或多个独立位置证据家族共同胜出，否则保留 locator 前最后一个完整事件。review 假设只能从 eventEnsemble 提供的完整事件检查点中选择，禁止从审计快照重建操作、窗口、Top1 或执行关联。
- [src/features/crossdating/diagnosis/evidenceRefreshAdjudicator.ts](src/features/crossdating/diagnosis/evidenceRefreshAdjudicator.ts)：保存不改变 working RWL，却会刷新 COFECHA master、PART 6 分类和 `[A]` 段证据。当前选中序列会保留同一数据签名下的上一诊断视图，并在 fresh COFECHA 返回后比较两边完整假设链；只有跨视图支持或操作特有的决定性证据才允许换类型或跳到远距离窗口，否则上一完整事件仅作为 `reviewOnly` 复核结果保留。手动参考变化、数据编辑和后台广度扫描不走该跨保存裁决。
- [src/features/crossdating/diagnosis/reviewWindowDisplay.ts](src/features/crossdating/diagnosis/reviewWindowDisplay.ts)：复核显示层优先保留严格层单位事件，其次保留严格局部移动，最后允许单独的严格整体移动；不得因操作类型不同而隐藏已确认的严格局部事件。降低门槛的拒答恢复仍只处理单位缺轮/伪轮，不生成低置信局部移动。该层只能标记 `strict / review / refused` 并追加 `reviewOnly` 安全元数据；不得从 `DiagnosisEventAuditSnapshot` 合成事件、居中扩窗、清空 candidateIds 或重排年份。
- [src/features/crossdating/diagnosis/eventReferenceVoting.ts](src/features/crossdating/diagnosis/eventReferenceVoting.ts)：相邻缺轮+伪轮的局部参考配对必须通过短 lag 脉冲、参考数、同向改善比例、相关增益和远端 margin 门；弱全局但强局部的补充门只接受不超过 12 年的脉冲。逐参考芯 baseline 每对只计算一次，低一致性配对不能进入生产事件。
- [src/features/crossdating/diagnosis/jointEventRefinement.ts](src/features/crossdating/diagnosis/jointEventRefinement.ts)：对 2 至 3 个 lag 链一致的局部事件联合枚举反事实年份组合；搜索可越过既有窗口边缘 1 年，但输出保持原窗宽，且局部移动只作为条件、不覆盖其专用断点排序。
- [src/features/crossdating/diagnosis/partialBreakpointRefinement.ts](src/features/crossdating/diagnosis/partialBreakpointRefinement.ts)：负向且绝对位移大于 1 年的局部移动断点允许扫描到目标序列两端 15 年处，诊断和事件去重阶段仍保留 9 年窗口；只有至少三种断点视图在同一局部簇达成一致、且该簇距离原路径窗不超过 3 年时，才允许整体重定位。相邻 Top1 排序仍要求 raw 与多尺度视图同时同意。
- [src/components/Chart/MultiLineChart.tsx](src/components/Chart/MultiLineChart.tsx)：在折线图上绘制未失效事件窗口背景带；缺轮、伪轮、局部移动使用不同颜色，高亮折线时只显示对应序列。
- [src/components/Chart/TreeChartManager.tsx](src/components/Chart/TreeChartManager.tsx)：点击诊断窗口内折线时按实际点中的源年份预览最终自动事件，不列出内部 `-2..-100` 假设或备选位移；复核面板、主/独立折线图和宽度网格共享事件 ID 与复核年份，任一侧点选窗口内年份都会同步其余入口。局部移动直接使用事件的唯一 `shiftYears`；预览与应用共享精确范围，临时整序列视觉偏移必须换算回源年份。
- [src/features/crossdating/pairwiseMismatch.ts](src/features/crossdating/pairwiseMismatch.ts) 与 [src/components/Chart/pairwiseChartAnalysis.ts](src/components/Chart/pairwiseChartAnalysis.ts)：图表恰好显示两条有效折线时可由用户点击“双线分析”启动显式相对错配检查，手动参考序列在视觉计数中算一条。样芯+参考时样芯自动为 target；两条普通样芯时当前高亮线为 target。分析只使用这两条线，不得回退到站点其它序列；手动参考若含 target，必须按 leave-one-out 重建。稳定的 `older lag != 0 → newer lag 0` 边界会转换为现有 `DiagnosisEvent`，复用相同建议卡片、图表窗口、定位、预览和编辑路径；整段恒定非零 lag 只报告整体相对偏移，不虚构开始年份。单样芯比较证据最高为中等，派生参考仍保留其实际 sample depth。
- [src/components/DiagnosisCandidates/DiagnosisEventPanel.tsx](src/components/DiagnosisCandidates/DiagnosisEventPanel.tsx)：只展示最新 JS 事件级复核窗口；窗口内年份选择使用共享状态，不会暴露内部位移假设。模块关闭按钮只暂停当前数据版本、当前序列的建议，下一次编辑恢复；[src/features/settings/settings.ts](src/features/settings/settings.ts) 的持久化总开关则会停止并隐藏自动定年建议。应用前仍须展示精确操作预览并再次确认。
- [src/features/crossdating/diagnosis/eventApply.ts](src/features/crossdating/diagnosis/eventApply.ts)：把用户复核事件转换为既有编辑语义；局部移动的公开年份是 `firstFixedYear`，应用范围严格结束于 `firstFixedYear - 1`，且自动位移必须小于 -1。
- 主窗口诊断 worker 在 40 ms 防抖后只诊断当前选中序列，选择“全部”时不启动诊断。Tauri 生产入口必须先获得带有非空 chronology points 的 dynamic reference；COFECHA 自动参考尚未生成时保持无建议，不得静默用全站其它序列构造 leave-one-out master。成功 worker 会保留复用，未变化的 site/reference/COFECHA/target 直接复用诊断结果。`targetTrees` 限定不改变目标序列结果，并避免大站点对每条不可见序列重复运行完整事件管线。
- [src/pages/home/BreadthDiagnosisNavigator.tsx](src/pages/home/BreadthDiagnosisNavigator.tsx) 与 [src/pages/home/breadthDiagnosis.ts](src/pages/home/breadthDiagnosis.ts)：主窗口右上角是全文件广度复核导航器。当前选中序列仍由高优先级深度诊断负责；只有用户点击导航器中的扫描按钮后，后台 worker 才逐条扫描其他序列，只收集通过 review 显示门槛的唯一窗口，COFECHA 标记序列优先计算，展示顺序按窗口首次进入队列的 FIFO 时间。编辑、保存、参考或 COFECHA 状态变化只会终止旧扫描并令结果失效，不会自动启动新扫描；当前诊断、保存、载入和 COFECHA 运行期间已启动的后台扫描暂停。
- 一次目标诊断内部会缓存 series preprocess 和 lag path 证据；局部反事实编辑复用固定 reference master，整条移动仍重建 master。Pearson 段相关不创建 pair 数组，piecewise 的零 lag 新旧段基线在候选 lag 间复用。正式单主窗口模式后台验证前三个高分操作假设，但跳过最终不会显示的位置/操作备选及其补充验证，出口仍只保留一个主操作和一个主窗口。
- 缺轮和伪轮的完整区间定位器保留约 25 年粗搜索证据；逐年虚拟纠正只计算四条冻结定位曲线，预处理、参考拟合和纠正结果均按诊断实例缓存。UI 只接收一个主窗口，不接收内部模式或逐年候选。学习定位器先输出 9/13 年窗，随后独立物理定位器只能在当前 9 年窗内部提出 7/5 年窗：7 年要求完整嵌套，缺轮 5 年还要求 operation remote margin ≥0.13，伪轮 5 年要求 margin ≥0.09 且 side-step 锚点距当前主年份 ≤4 年。13 年窗不直接收窄，旧 `adaptiveWindowRisk` 的 17 年或粗区间回退不进入正式入口。
- 自动交叉定年主管线第一版已经完成；当前算法层在同一入口中显式包含 Baillie & Pilcher-style global sliding match、Holmes/COFECHA-like segmented diagnosis、Van Deusen/Wenk-style local edit alignment，以及 Hassan-style MVP relative-confidence ranking。
- 折线图候选生成由“生成候选”按钮触发；本轮不使用 hover 触发自动分析。
- COFECHA-pass 动态参考序列已接入：每次 COFECHA 完成后复用 PART 6 `[A] Segment` 判断，把无 A flag 样芯作为 `anchor_pass` 参考锚定组，有 A flag 样芯作为 `candidate_flagged` 待检查组，并用标准化后的 anchor 序列生成 `COFECHA-pass 参考序列`。参考数值供内部诊断使用，折线图不再显示其状态模块或曲线；PART 6 分类仍用于可靠序列快捷选择和 A 标记提示。
- [src/features/crossdating/reference.ts](src/features/crossdating/reference.ts)：动态参考生成按 COFECHA master dating series 流程执行：每条样芯先做 32 年 50% response cubic smoothing spline 去趋势，计算 `raw / spline` 的 dimensionless index，再用 AR(p) 预白化、默认 log transform、可选 first difference；随后按年份 accumulator/counter 算术平均，并把最终 master 标准化为 mean=0、sd=1。0 值 absent ring 默认不进入 reference。Spline 线性系统使用带宽 2 的 Cholesky O(n) 求解，保留共轭梯度作为数值异常回退。

**约束**：
- reference series 是 derived series，不进入 RWL 数据本体，不允许作为普通序列编辑。
- 手工 reference 默认只用于图表叠加和人工对照，不得进入后台自动定年建议；唯一例外是用户在恰好两条可见折线时显式点击“双线分析”，该路径只比较当前 target 与当前视觉参考，并在需要时 leave-one-out。自动诊断仍只使用带有有效 chronology points 的机器 dynamic reference；缺少可用 dynamic reference 时等待 COFECHA，不得自动退回 leave-one-out；pairwise-bootstrap 仍可作为 COFECHA 全标记冷启动时生成的 dynamic reference。
- 手动 reference 计算按年份对齐并直接 arithmetic mean；COFECHA-pass 动态 reference 只能平均转换后的 residual index，最终输出 mean=0、sd=1 的 residual chronology，低于最小 replication 的年份不绘制。
- 参考变更写入操作日志，但不参与 RwlEditor 的撤销/恢复栈。
- 内部诊断是 COFECHA-like 快速提示，不替代外部 COFECHA 最终验证；候选项必须由用户确认后才能通过 edit.ts 操作落地。
- 窗口覆盖率、精确 Top1、Top1±1、操作准确率、事件精确率、拒答率和干净误报必须分开报告，而且正式统计只能使用每种类型证据分数最高的主事件及其唯一主窗口。不得用历史 `locationAlternatives` 或 `operationAlternatives` 补足准确率。正式目标芯只按长度/跨度/稳定顺序选择，参考芯只按日历重叠选择；单事件年份只能使用与宽度/相关性无关的五位置分层采样，混合事件锚点同样只能读取日历范围和稳定 seed。`pickExploratoryStrongSignalYear` 只允许用于明确标注的探索性上限实验。offset 0–12 的历史单主窗口结果为：缺轮/伪轮/局部移动响应 92.0%/92.0%/94.8%，主窗口覆盖 72.6%/74.2%/77.8%，全 case 精确 Top1 23.7%/26.5%/51.1%，Top1±1 48.0%/47.4%/62.8%，平均窗宽 7.03/6.68/7.75 年，中位窗宽 7/7/8 年，P90 窗宽 7/7/9 年，干净误报 12.6%。局部移动位移量在全部 case/已响应 case 中为 90.2%/95.1%，位移量与窗口联合命中 77.8%。旧混合训练/独立站点结果不得视为当前工作树指标；2026-08-02 当前严格训练实验整体事件召回/精度为 57.6%/73.8%，缺轮为 64.6%/81.6%，伪轮为 61.1%/81.5%，相邻缺轮+伪轮为 50.0%/75.0%。offset 13–24 均已消费，不得再作为独立留出。
- 2026-08-01 缺轮/伪轮窗口层复验：缺轮算法在 offset 25/26/27 三个独立 clean 分桶共 130 例上的响应率为 97.69%，已回答操作准确率为 100%，完整正确率为 117/130=90.00%，唯一主窗口中位宽度 9 年、P90 13 年，Top1 精确 26.92%、Top1±1 59.23%，干净误报率 0；其中最新 offset 27 单分桶只有 41/47=87.23%，必须保留该波动。加入局部边界形状的伪轮 selector 在未参与训练的 offset 27 clean 47 例上响应率 95.74%，已回答操作准确率 100%，完整正确率 43/47=91.49%，中位宽度/P90 均为 13 年，Top1 精确 29.79%、Top1±1 48.94%，干净误报率 0。offset 25–27 均已消费，不得再作为独立留出；5/7 年缩窗、粗区间逐年枚举和缺轮边界特征实验均因跨分区不能稳定改善而未接入。
- 2026-08-01 缺轮/伪轮精确年份复验：缺轮在原三证据均值上加入 2% 操作锚点距离先验和 2% 窗内虚拟插年证据；伪轮在 `differenceFull` 上加入 1% 窗内虚拟删年证据。跨训练/校准/开发分区的覆盖案例 Top1 分别稳定提高约 0.6–2.5 个百分点，但未达到原定 +15 个百分点，不能宣称精确年份问题已解决。已知困难 validation offset 5 的缺轮窗口覆盖/响应保持 81%/98%，Top1 保持 19%；伪轮窗口覆盖/响应保持 85%/99%，Top1 从 27% 提至 29%，但 Top1±1 从 48% 降至 46%。该精排权重不得依据最终 untouched 分区继续调参。
- 2026-08-01 最终 untouched validation offset 28（任意日历位置、各 100 例、只输出唯一主窗口）：缺轮响应率 95%，完整正确率/主窗口覆盖率 79%，已回答操作准确率 100%，中位宽度 9 年，Top1 26%，Top1±1 56%；伪轮响应率 94%，完整正确率/主窗口覆盖率 85%，已回答操作准确率 100%，中位宽度 13 年，Top1 22%，Top1±1 42%。因此当前实现没有在最终分区达到每类 90% 窗口覆盖目标，尤其缺轮仍存在明显分区波动；不得用早先分区平均掩盖该结果。offset 28 已消费，禁止再用于调参或作为 untouched 结果复跑。
- untouched 失败后的只读审计表明，9 年窗统一扩大到 13 年通常每分区只能救回 0–2 例，主要误差是 13 年物理模式中心选错。补入 mixed 案例的线性模型和仅相关性的 grouped LambdaRank 未稳定达到 90%；随后加入逐年虚拟纠正曲线，缺轮在既有五分区 434/475=91.37%，伪轮五分区 TypeScript 重放 440/478=92.05%。但全新 validation offset 6 的已审计正确操作案例仅为缺轮 83/94=88.30%、伪轮 85/94=90.43%；对全部 100 个注入案例，响应率为 95%/96%，完整正确率仅 84%/86%，中位宽度均为 13 年，Top1 为 27%/31%，Top1±1 为 48%/46%。因此新层只算小幅改进，仍未达到每类全案例 90% 目标；offset 6 已消费，不得再用于调参或称为 untouched。
- 2026-08-01 文件级严格隔离后的 validation 分区（每类 76 例）最终复验：缺轮响应 73/76=96.05%，唯一主窗口覆盖 68/76=89.47%，已回答窗口覆盖 68/73=93.15%，Top1 21/76=27.63%，Top1±1 45/76=59.21%；24 个已回答案例输出 9 年窗，其中 23 个命中，另 49 个输出 13 年窗，其中 45 个命中。与同一分区旧 13 年定位 A/B 相比覆盖一得一失、净值持平，Top1 净增 1，24 例窗口缩窄。伪轮保持旧 13 年路径，响应 74/76=97.37%，唯一主窗口覆盖 68/76=89.47%，已回答窗口覆盖 68/74=91.89%，Top1 24/76=31.58%，Top1±1 40/76=52.63%。干净误报 10/76=13.16%。两类全案例覆盖均还差 1 例才超过 90%，不得宣称已经达标，也不得再用该 validation 分区调参。随后尝试的窗内插年/删年操作方向分类器在文件隔离校准集仅约 83% 准确，而正式路径为 120/121；没有任何零错误净改进门槛，因此未接入。
- 2026-08-02 基线干净的文件级 validation 复验：每类原抽样 76 例中排除 10 个注入前已有内部事件的样芯，正式分母为 66；这些排除项仍保留在 `allSampledAudit`，不得混入注入准确率。缺轮响应 64/66=96.97%，唯一主窗口覆盖 60/66=90.91%，已回答覆盖 60/64=93.75%，窗口为 33 个 9 年和 31 个 13 年，中位/P90 为 9/13 年；Top1 16/66=24.24%，Top1±1 39/66=59.09%，Top3 33/66=50.00%，覆盖案例真值中位排名 3，MRR(all)=0.417。伪轮响应 65/66=98.48%，覆盖 62/66=93.94%，已回答覆盖 62/65=95.38%，窗口为 36 个 9 年和 29 个 13 年，中位/P90 为 9/13 年；Top1 23/66=34.85%，Top1±1 36/66=54.55%，Top3 41/66=62.12%，覆盖案例真值中位排名 2，MRR(all)=0.526。干净误报 0/66。缺轮/伪轮窗口目标已在该冻结分区达到，但 Top1 提升 15 个百分点的目标未达到；本轮 `ITRDB_UNIT_EVENTS_ONLY=1`，局部移动未参与，也不得从该结果外推。
- 2026-08-02 固定 validation 尾部回归（`ITRDB_UNIT_EVENTS_ONLY=1`）：缺轮/伪轮正式分母均为 89，响应为 87/86，唯一主窗口覆盖为 81/89=91.01% 和 83/89=93.26%，中位/P90 均为 9/13 年；窗口直方图为缺轮 `5:4 / 7:7 / 9:35 / 13:41`、伪轮 `5:7 / 7:8 / 9:34 / 13:37`。逐参考芯拒答恢复只新增 1 个伪轮回答且命中，不改变原有回答或干净误报；26 个 9 年窗缩到 5/7 年后 26/26 保持覆盖，Top1/Top3、响应和操作准确率不变。Top1 为 24.72%/35.96%，Top1±1 为 50.56%/62.92%，仍未达到精确年份目标。全 100 个单年事件采样位置的干净误报仍为相同的 11 个 `groupId`。该 validation 块已用于失败审计和规则开发，只能作为固定回归，不得再称为 untouched；局部移动本轮未修改或验收。
- 2026-08-02 已消费的 18 文件留出生产复查：排除 1 个注入前已异常样芯后，缺轮响应 15/17=88.24%、完整正确率/唯一主窗口覆盖 14/17=82.35%、已回答覆盖 93.33%；伪轮响应与覆盖均为 15/17=88.24%、已回答覆盖 100%。6 个窗口从 9 年缩到 5/7 年后 6/6 保持覆盖，响应、Top1、Top3 和误报不变；正式干净误报 0/17。该留出已重复消费，不得再基于这 17 例调参或称其为 untouched。
- 2026-08-03 单位事件最终冻结回归（`ITRDB_UNIT_EVENTS_ONLY=1`，局部移动 case 为 0）：validation 86 例/类型的缺轮和伪轮唯一主窗口覆盖均为 78/86=90.70%，响应率 97.67%/95.35%，干净误报 0/86；reserved 43 例/类型均为 39/43=90.70%，响应率均为 95.35%，干净误报 0/43；holdout-v3 100 例/类型均为 90/100=90.00%，响应率 98%/93%，干净误报 0/100。三组窗口仅使用 5/7/9/13 年且每个事件只输出一个主窗口；Top1 仍仅为 18.60%–38.00%，不得把窗口覆盖解释为精确年份准确率。三组均已用于规则检查，后续必须创建新的文件或站点互斥分片；局部移动继续暂缓到单位事件阶段结束后处理。
- 2026-08-03 物理剖面模式恢复的已消费生产复查（`ITRDB_UNIT_EVENTS_ONLY=1`）：holdout-v5 基线干净 113 例/类型中，缺轮和伪轮完整覆盖均为 102/113=90.27%，响应为 110/113 和 111/113；holdout-v6 基线干净 98 例/类型中，两类完整覆盖均为 89/98=90.82%，响应为 97/98 和 95/98。两批的主窗口中位/P90 均为 9/13 年，正式干净误报均为 0；两批都已用于规则检查，不得再视为独立留出。
- 2026-08-03 唯一一次 untouched holdout-v8 最终生产审计（615 个文件，120 个任意日历位置，`ITRDB_UNIT_EVENTS_ONLY=1`）：排除 8 个注入前已有内部标记的样本后，正式分母为 112。缺轮响应 111/112=99.11%，唯一主窗口覆盖 102/112=91.07%，已回答精度 102/111=91.89%，窗口直方图 `7:1 / 9:65 / 13:45`；伪轮响应 110/112=98.21%，覆盖 101/112=90.18%，已回答精度 101/110=91.82%，窗口直方图 `7:8 / 9:66 / 13:36`。两类中位/P90 均为 9/13 年，正式干净误报 0/112。缺轮 Top1/Top1±1/Top3 为 28.57%/58.93%/67.86%，伪轮为 33.93%/54.46%/64.29%，覆盖案例真值中位排名均为 2；Top1 仍不是精确事件年保证。包含 8 个基线异常样本的全采样压力口径中，缺轮/伪轮覆盖为 89.17%/87.50%，干净误报为 8/120=6.67%，必须与正式基线干净指标分开。v8 已消费且规则冻结，禁止据此调参或重跑；局部移动 case 为 0，仍未修改或验收。
- COFECHA-pass reference 与 COFECHA run/rwlHash 绑定；RWL 编辑后动态 reference 标记为 stale，直到重新运行 COFECHA。`anchor_pass` 不进入后续整体 offset 检查目标，预留检查入口只使用 `candidate_flagged`。
- 自动候选仍只允许落到三类可执行编辑：`insertMissingYear`、`deleteFalseYear`、`batchMoveYears`（包含 `wholeSeriesMove` 与 `partialRangeMove`）。`wholeSeriesMove` 必须来自整条序列移动证据，`partialRangeMove` 必须保留 selectedRange/missingRange evidence，不能退化成插入一串 0。
- 定位器只能在保持操作类型、位移量和 lag 契约时提出位置修改；扩大窗口或改变 Top1 属于精度退化风险，必须由 [src/features/crossdating/diagnosis/eventAdjudicator.ts](src/features/crossdating/diagnosis/eventAdjudicator.ts) 依据类型化 `locationEvidence` 和独立证据优势统一裁决。`locationEvidence.source` 只用于溯源，不得按来源名称直接授予覆盖权。
- 候选 evidence 需要保留 algorithmSource、before/after metrics、relative confidence（rank/probabilityLike/confidenceLevel），其中 probabilityLike 只表示内部候选相对置信度，不是严格贝叶斯后验概率。
- 应用诊断候选时必须复用 [src/features/rwl/edit.ts](src/features/rwl/edit.ts) 的编辑路径，并以 `auto-suggested` 来源写入既有操作记录，保留 reason、候选年份、side/shift、selectedRange/missingRange 与 before/after metrics。
- 每次接受候选后仍然只应用一个候选，随后必须基于当前 working series 重新诊断；旧候选必须 stale。不要恢复 hover 分析，不要新增持久化操作日志/恢复机制，不要把无约束 DTW 作为主算法。
- 多缺轮与连续缺段只有在两个完整事件族都独立通过复核门槛、累计负 lag 一致、位置同区、参考芯分票接近且不存在独立整体移动基线时，才可附带一个受约束的解释切换。界面始终只显示当前解释的一个操作和一个窗口；切换不编辑数据，应用后必须重新诊断。
- 自动建议预览只在命中诊断主窗口时出现，不得把内部位移网格转成按钮、菜单或手工选项。独立手工片段移动工具可继续存在，但不能反向参与或覆盖自动事件选择。所有写入仍需二次确认、进入撤销栈/操作日志并立即使旧事件诊断 stale。
- 加载文件期间使用同步 loading guard 和 workspace epoch，只有解析成功才提交新路径；保存触发的 COFECHA 完整运行串行，避免共享 `cofecha-work` 的并发清理/OUT 覆盖。
- Python Current-event V1 运行时、模型 bundle、PyInstaller sidecar、Tauri 命令和隐藏 UI 已移除；产品定年建议只走 TypeScript/JavaScript 诊断。离线研究/训练脚本可以保留，但不得加入 Tauri `resources` 或 `externalBin`。
- [src/features/rwl/edit.ts](src/features/rwl/edit.ts)：`RwlEditor` 保留首次加载的 raw baseline，并在 history snapshot 中持久化 raw/working 数据、删除标记与 operation log；操作日志窗口的“回到原始”会走 `resetToRawData()`，不会依赖逐条反向猜测。
- [src/pages/home/useHomeWorkspace.ts](src/pages/home/useHomeWorkspace.ts)：打开文件时若恢复了 working series，后续 COFECHA 运行使用 editor 当前导出的 working RWL；`Save As` 会切换当前文件路径，并把保存后的当前数据作为新文件的 raw baseline。
- [src/components/WidthContainer/WidthContainer.tsx](src/components/WidthContainer/WidthContainer.tsx)：宽度网格顶部显示最近操作记录摘要，条目来自统一 workspace operation log；可定位到真实 series/year 的条目会复用主窗口跳转高亮逻辑。
- 宽度模块的当前序列与折线图显示集合彼此独立；在宽度模块选择序列不会自动加入折线图，只有折线选择器或“在图表中定位”等显式操作会改变折线图显示集合。
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
- `npm run benchmark:itrdb-natural-zero-serial` — 对冻结的高质量 ITRDB 文件集删除全部自然 0，复用 co612 FIFO 复核窗口流程做逐轮串行恢复；支持 `--resume`
- `npm run analyze:unit-window-stability -- <audit.json> [...]` — 汇总单位事件的响应、粗区间、13 年模式和最终单窗口分层覆盖；输入需由 `ITRDB_COUNTERFACTUAL_LOCATOR_AUDIT=1` 生成
- `npm run benchmark:co612-review-bootstrap -- --input <source-copy.rwl> --max-rounds 400 --workers 16 --run-id <id>` — 同时删除 co612 全部自然 0，以最早待复核窗口优先逐轮恢复一个经用户模拟确认的事件；隐藏真值不得进入诊断或参考
- `npm run analyze:co612-review-bootstrap -- --run-dir <result-dir>` — 输出四组复核门槛/重试对照、逐案状态路径、拒答恢复、终局前沿、响应曲线与分层指标
- `npm run validate:co612-recovery-regression` — 独立于冻结 production differential，在固定 co612 358 事件输入上要求首轮至少 22/45 个正确复核窗
- `npm run prepare:legacy-generalization` — 按冻结 seed、文件和样芯选择规则生成 Legacy 跨文件 config 对应的只读 manifest
- `npm run validate:legacy-generalization -- --phase <co612|pilot|single|serial|all> [--quick]` — 执行 co612 复现门禁、外部单次/串行泛化、文件级 bootstrap、checkpoint 与产物校验
- `npm run typecheck:legacy-generalization` — 独立类型检查 Legacy manifest、worker、runner、汇总和评估器脚本
- `npm run trial:auto-crossdating` — 在临时目录对 RAW 样例应用自动诊断候选并跑 COFECHA 对比；每轮每条序列只应用一个候选，不修改源文件
- `npm run export:tree-ring-scan-fixtures -- <input.rwl> <output-folder>` — 为每条序列导出同名完整年轮 SVG 与测试清单，供扫描影像文件夹流程验收
- `npm run validate:tree-ring-scan-pair -- <input.rwl> <scan-image>` — 只读校验扫描影像文件名能否匹配 RWL 中的同名序列，并输出该序列年份范围
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

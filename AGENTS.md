# 仓库指南

这是一个用于树轮交叉定年的 Tauri + React + TypeScript 应用。这个文件是智能体或人工阅读代码时的第一入口，用来快速建立项目结构和数据流认知。

## 从这里开始

- [src/pages/Home.tsx](src/pages/Home.tsx)：主界面和整体流程编排入口
- [src/features/rwl/index.ts](src/features/rwl/index.ts)：RWL 格式识别与解析入口
- [src/features/crossdating/reference.ts](src/features/crossdating/reference.ts)：参考序列配置、按年份对齐计算与 sample depth 入口
- [src/features/crossdating/diagnosis.ts](src/features/crossdating/diagnosis.ts)：内部轻量诊断、分段相关、lag search 与候选检查项入口
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
- [src/components/Chart/MultiLineChart.tsx](src/components/Chart/MultiLineChart.tsx)：以加粗虚线绘制 reference series，并在 tooltip 中显示 sample depth；会把当前可见序列的 flagged/problem segments 作为淡色背景带显示。
- [src/pages/home/useHomeWorkspace.ts](src/pages/home/useHomeWorkspace.ts)：按文件路径持久化 reference config 和参考辅助日志。
- [src/pages/home/workspaceWindowBridge.ts](src/pages/home/workspaceWindowBridge.ts)：独立折线图窗口会同步 reference config，并把参考变更命令发回主窗口。
- [src/features/crossdating/diagnosis.ts](src/features/crossdating/diagnosis.ts)：自动生成内部 problem segment count、A-like/B-like segment、propagation pattern、三类候选编辑与 before/after evidence；用户确认后可一次应用一个候选。
- 折线图候选生成由“生成候选”按钮触发；本轮不使用 hover 触发自动分析。

**约束**：
- reference series 是 derived series，不进入 RWL 数据本体，不允许作为普通序列编辑。
- reference 计算按年份对齐，默认 arithmetic mean，低于最小 sample depth 的年份不绘制。
- 参考变更写入操作日志，但不参与 RwlEditor 的撤销/恢复栈。
- 内部诊断是 COFECHA-like 快速提示，不替代外部 COFECHA 最终验证；候选项必须由用户确认后才能通过 edit.ts 操作落地。
- 应用诊断候选时必须复用 [src/features/rwl/edit.ts](src/features/rwl/edit.ts) 的编辑路径，并以 `auto-suggested` 来源写入既有操作记录，保留 reason、候选年份、side/shift、selectedRange/missingRange 与 before/after metrics。
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
- `npm run validate:samples` — 用仓库样例跑 RWL 解析、内部诊断和验证摘要链路
- `npm run validate:samples:strict` — crossdated 样例仍有内部问题段时返回非零并列出序列
- `npm run validate:cofecha:samples` — 直接调用本地 COFECHA sidecar 验证 crossdated 样例的 A/problem
- `npm run validate:workspace-windows` — SSR smoke 验证独立操作日志/COFECHA 窗口关键渲染与桥接常量
- `npm run validate:auto-crossdating` — synthetic demo 验证自动交叉定年主线、三类候选、应用后重新诊断与 stale 标记
- `npm run trial:auto-crossdating` — 在临时目录对 RAW 样例应用自动诊断候选并跑 COFECHA 对比；每轮每条序列只应用一个候选，不修改源文件
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

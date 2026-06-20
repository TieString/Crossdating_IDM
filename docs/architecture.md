# 架构说明

## 文档信息

- 读者：开发者、维护者
- 最后更新：2026-06-19
- 维护人：项目维护者
- 适用版本：1.0.0

## 技术栈

- 桌面壳：Tauri 2，Rust 命令在 `src-tauri/src`。
- 前端：React 18、TypeScript、Vite 6。
- 图表：Chart.js、react-chartjs-2、chartjs-plugin-crosshair、chartjs-plugin-zoom。
- 编辑器：CodeMirror 6 用于 raw text editor。
- 动画：Motion for React，加上少量 Web Animations API。

## 顶层目录

- `src/app`：React 应用入口和全局样式。
- `src/pages`：页面级编排，主工作区在 `Home.tsx` 和 `pages/home`。
- `src/components`：可复用界面组件，包括图表、宽度网格、菜单、滚动条、查找替换。
- `src/features`：领域逻辑，包括 RWL、crossdating、COFECHA 结果格式化和设置。
- `src/services`：文件系统、COFECHA runner、工作区服务。
- `src/shared`：跨模块常量。
- `scripts`：样例验证、窗口 smoke、自动交叉定年验证脚本。
- `src-tauri`：Tauri 配置、命令注册和 Rust 命令实现。

## 主工作区数据流

1. `Home.tsx` 提供主界面布局、标题栏事件、左右面板和工作区视图。
2. `useHomeWorkspace.ts` 持有当前文件路径、解析结果、`RwlEditor`、COFECHA 结果、reference config、诊断结果和历史状态。
3. 打开文件时，`services/fs/io.ts` 读取文本并调用 `readRwlString()`。
4. `features/rwl/index.ts` 根据检测结果从格式处理器注册表选择解析器。
5. 解析结果进入 `RwlEditor`，编辑器保留 raw baseline 和 working data。
6. `WidthContainer` 从 working data 渲染宽度网格，并通过回调调用 `RwlEditor` 的编辑路径。
7. `TreeChartManager` 和 `MultiLineChart` 渲染折线图、reference series、sample depth 和内部诊断背景带。
8. 保存、另存和 COFECHA 运行由 `useHomeWorkspace.ts` 编排，避免展示组件直接访问文件系统。

## RWL 格式层

`features/rwl/index.ts` 是公开入口。它导出类型、检测函数和 `readRwlString()`，并维护 `formatHandlers` 注册表。当前代码中有 Tucson、Compact、CSV、Heidelberg、TRiDaS 解析器；只有实现了 `format` 的格式可通过统一框架导出。

Tucson 读写的格式透明性由 `RwlReadResult.readOptions` 和 formatter 共同保证。打开文件时记录格式参数，保存时沿用这些参数。

## 编辑与历史

`features/rwl/edit.ts` 的 `RwlEditor` 是编辑核心。它维护：

- raw baseline
- working data
- history snapshots
- deletion markers
- operation log
- raw/working 序列化和恢复能力

网格组件不直接修改外部状态，而是触发已有编辑回调。自动候选应用也必须复用编辑路径，并以既有操作日志格式记录。

## 参考序列与诊断

`features/crossdating/reference.ts` 根据 reference config 按年份对齐生成 derived reference series。reference series 不进入 RWL 数据本体。

`features/crossdating/diagnosis.ts` 提供内部快速诊断和候选生成。它不运行外部 COFECHA，也不自动修改数据；候选必须由用户确认后通过 `RwlEditor` 路径落地。

## COFECHA 集成

`services/cofecha/runner.ts` 负责：

- 准备 COFECHA 工作目录。
- 写入输入 RWL。
- 运行 sidecar。
- 读取 `VERYCOF.OUT`。
- 把 OUT 文本交给前端解析和展示。

`features/cofecha/formatter.ts` 解析 COFECHA 输出摘要。`useHomeWorkspace.ts` 按文件路径持久化最近一次 OUT/result 与 `RUN_COFECHA` 日志。Rust 命令 `write_out_next_to_rwl` 会在可行时把 OUT 文件镜像保存到源 `.rwl` 文件旁。

## 窗口与桥接

`pages/home/workspaceWindowBridge.ts` 处理独立工作区窗口同步。窗口 request/closed 事件带窗口 label，主窗口只接受匹配 label 的生命周期事件，避免旧窗口事件影响当前状态。

## 设置系统

`features/settings/settings.ts` 定义动画设置、默认值、localStorage key 和读写函数。`SettingsProvider` 读取并保存设置，同时监听其他窗口的 storage 事件。依赖设置的组件应位于 `SettingsProvider` 内部。

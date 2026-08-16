# Crossdating IDM

## 文档信息

- 读者：开发者、维护者、需要理解数据流的使用者
- 最后更新：2026-07-25
- 维护人：项目维护者
- 适用版本：1.0.0

Crossdating IDM 是一个 Tauri + React + TypeScript 桌面应用，用于读取、编辑和辅助诊断树轮 RWL 数据。前端负责文件工作区、宽度网格、折线图、参考序列、内部诊断和 COFECHA 结果展示；Tauri 后端提供文件系统、sidecar 执行和 OUT 文件镜像保存能力。

## 快速开始

```bash
npm install
npm run dev
```

桌面开发：

```bash
npm run tauri
```

生产构建：

```bash
npm run build
```

文档与组件预览：

```bash
npm run docs:api
npm run storybook
npm run build-storybook
```

## 项目入口

- `src/app/App.tsx`：React 应用根节点，注入 `SettingsProvider`。
- `src/pages/Home.tsx`：主界面和工作流编排入口。
- `src/pages/home/useHomeWorkspace.ts`：工作区状态、文件读写、保存、COFECHA、诊断和持久化。
- `src/features/rwl/index.ts`：RWL 格式识别、解析和格式处理器注册表。
- `src/features/rwl/edit.ts`：RWL 编辑器、历史状态和操作日志。
- `src/features/crossdating/reference.ts`：手动参考序列、COFECHA-pass 动态参考序列、PART 6 分类和 COFECHA-style 标准化。
- `src/features/crossdating/diagnosis.ts`：最新 JS 事件级诊断入口。
- `src/components/DiagnosisCandidates/DiagnosisEventPanel.tsx`：操作、窄位置窗口和精确年份选择，以及应用前预览与确认。
- `src/services/cofecha/runner.ts`：COFECHA sidecar 执行和 OUT 文件读取。
- `src-tauri/src/commands.rs`：前端可调用的 Tauri 命令。

## 核心流程

1. 用户在主界面打开 `.rwl` 文件。
2. `src/services/fs/io.ts` 读取文本并调用 RWL 解析入口。
3. `src/features/rwl/index.ts` 自动识别格式，分派到 Tucson、Compact、CSV、Heidelberg 或 TRiDaS 解析器。
4. `RwlEditor` 管理 raw baseline、working data、历史快照、删除标记和操作日志。
5. `WidthContainer` 渲染可编辑宽度网格，并在每条序列标题中显示按实际宽度生成、以 1 cm 为基准且自动匹配容器比例的树轮径向窗口；树心到树皮始终完整、图像填满容器且不会变形，并支持不带动工作区的滚轮缩放和横向拖动。悬停年份显示在按钮上方，单击选择对应宽度格，双击打开唯一完整截面图；完整截面支持鼠标锚点缩放、图内平移、窗口移动和右下角尺寸调节。中间缺失年份和显式 0 宽缺轮也会保留标记。年轮区域右键还可索引一整个同名样本扫描影像文件夹；打开扫描图后先在总览上自由框选磨平的长方形样芯截面，可按 90° 旋转，TIFF 选区会按原始像素提取。随后依次标注至少两个十年锚点才进入标题预览，并会把编辑前的原年份映射到当前宽度格年份。`TreeChartManager` 渲染折线图和参考序列相关交互。
6. `reference.ts` 支持两类 derived reference series：用户手动选择序列时按年份直接均值；COFECHA 运行后默认用 PART 6 无 A flag 样芯生成 COFECHA-pass 动态参考序列。
7. 用户触发诊断后，JS 事件级管线只诊断当前序列，并输出缺轮、伪轮、局部移动或整体移动的窄复核窗口；同站其它序列仍参与参考序列。
8. 每个独立事件只显示一个 5/7/9/11/13 年主窗口，不显示操作或位置备选。定位器先在高召回粗区间内选择唯一 13 年模式，再用逐参考芯反事实、lag 转移和局部边界证据决定是否收窄；不会用 17 年窗连接远峰。局部移动在内部联合搜索 `-2..-100`，UI 只显示最终 `firstFixedYear + shiftYears`；点击诊断窗口内折线会直接预览这一建议，不显示内部假设列表。应用复用 `RwlEditor` 的撤销栈和操作日志，随后旧建议失效并重新诊断。
9. 保存和 COFECHA 运行会通过 `services/cofecha/runner.ts` 写入工作目录、运行 sidecar 并读取 `VERYCOF.OUT`。
10. COFECHA 结果由 `src/features/cofecha/formatter.ts` 解析，再由工作区按文件路径持久化最近结果。

## COFECHA-pass 动态参考序列

每次 COFECHA 完成后，系统会复用 PART 6 中 `[A] Segment` 的既有判断逻辑，把样芯分为：

- `anchor_pass`：PART 6 中没有 A flag 的样芯，用作参考锚定组。
- `candidate_flagged`：PART 6 中有 A flag 的样芯，保留给后续整体 offset 检查。

动态参考序列按 COFECHA master dating series 的默认转换流程生成：每条 anchor 样芯先做 32 年、50% frequency response 的 cubic smoothing spline 去趋势，计算 `raw / spline` 的 dimensionless index，再进行 AR(p) 预白化、默认 log transform、可选 first difference。所有转换后的样芯值按年份 accumulator/counter 算术平均，最终 master 标准化为 `mean = 0`、`sd = 1`，并保存每年的 replication、sd、se 和 weight。0 值 absent ring 默认不参与 reference。

用户仍可在折线图里生成并查看 manual reference。COFECHA-pass reference 的数值供内部诊断使用，折线图不再展示其状态模块或曲线；PART 6 分类仍用于可靠序列快捷选择和 A 标记提示。RWL 编辑后动态 reference 标记为 stale，直到重新运行 COFECHA。宽度模块不再显示贝叶斯定年按钮。

## 文档

- [项目介绍](docs/project-introduction.md) — 主要功能、实现方式与核心数据流
- [Technical Note 稿件](docs/technical-note-manuscript.md) — 英文 Technical Note 初稿及投稿前待补项
- [架构说明](docs/architecture.md)
- [开发指南](docs/development.md)
- [核心组件文档](docs/components.md)
- [COFECHA-pass 参考序列](docs/cofecha-reference.md)
- [JS 内部诊断事件窗口基准](docs/js-internal-diagnosis-events-report.md) — 信号无关采样、开发/盲测、混合事件、已有零值与性能
- [Current-event V1 多模型切换与桌面端接入](docs/current-event-ranker-integration.md)
- [文档维护规则](docs/maintenance.md)
- API 文档输出目录：`docs/api`，通过 `npm run docs:api` 生成。

## 常用验证

```bash
npm run validate
npm run validate:samples
npm run validate:workspace-windows
npm run validate:auto-crossdating
npm run validate:cofecha-reference
npm run validate:current-event-ranker
npm run smoke:current-event-ranker
npm run test:current-event-ranker
npm run export:tree-ring-scan-fixtures -- <input.rwl> <output-folder>
npm run validate:tree-ring-scan-pair -- <input.rwl> <scan-image>
```

`validate` 是样例解析、工作区窗口 smoke、自动交叉定年算法验证、COFECHA-pass reference
和 Current-event V1 资源/协议验证的聚合入口。当前定年建议 UI 只显示最新 JS 事件级诊断；三个 Python
模型的代码、发布资源和开发验证命令仍保留，但模型 UI、目录查询和 sidecar 调用由 feature flag 暂时关闭。
`test:current-event-ranker` 仅用于维护被隐藏模块的协议、资源和 sidecar 回归，不代表它参与当前 JS 诊断。

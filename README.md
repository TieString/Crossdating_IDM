# Crossdating IDM

## 文档信息

- 读者：开发者、维护者、需要理解数据流的使用者
- 最后更新：2026-06-19
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
- `src/features/crossdating/diagnosis.ts`：内部诊断和候选生成。
- `src/services/cofecha/runner.ts`：COFECHA sidecar 执行和 OUT 文件读取。
- `src-tauri/src/commands.rs`：前端可调用的 Tauri 命令。

## 核心流程

1. 用户在主界面打开 `.rwl` 文件。
2. `src/services/fs/io.ts` 读取文本并调用 RWL 解析入口。
3. `src/features/rwl/index.ts` 自动识别格式，分派到 Tucson、Compact、CSV、Heidelberg 或 TRiDaS 解析器。
4. `RwlEditor` 管理 raw baseline、working data、历史快照、删除标记和操作日志。
5. `WidthContainer` 渲染可编辑宽度网格，`TreeChartManager` 渲染折线图和参考序列相关交互。
6. `reference.ts` 支持两类 derived reference series：用户手动选择序列时按年份直接均值；COFECHA 运行后默认用 PART 6 无 A flag 样芯生成 COFECHA-pass 动态参考序列。
7. 保存和 COFECHA 运行会通过 `services/cofecha/runner.ts` 写入工作目录、运行 sidecar 并读取 `VERYCOF.OUT`。
8. COFECHA 结果由 `src/features/cofecha/formatter.ts` 解析，再由工作区按文件路径持久化最近结果。

## COFECHA-pass 动态参考序列

每次 COFECHA 完成后，系统会复用 PART 6 中 `[A] Segment` 的既有判断逻辑，把样芯分为：

- `anchor_pass`：PART 6 中没有 A flag 的样芯，用作参考锚定组。
- `candidate_flagged`：PART 6 中有 A flag 的样芯，保留给后续整体 offset 检查。

动态参考序列按 COFECHA master dating series 的默认转换流程生成：每条 anchor 样芯先做 32 年、50% frequency response 的 cubic smoothing spline 去趋势，计算 `raw / spline` 的 dimensionless index，再进行 AR(p) 预白化、默认 log transform、可选 first difference。所有转换后的样芯值按年份 accumulator/counter 算术平均，最终 master 标准化为 `mean = 0`、`sd = 1`，并保存每年的 replication、sd、se 和 weight。0 值 absent ring 默认不参与 reference。

用户在折线图里手动生成参考后会切换到 manual 模式；“恢复动态”会回到最新 COFECHA-pass reference。RWL 编辑后动态 reference 标记为 stale，直到重新运行 COFECHA。

## 文档

- [项目介绍](docs/project-introduction.md) — 主要功能、实现方式与核心数据流
- [Technical Note 稿件](docs/technical-note-manuscript.md) — 英文 Technical Note 初稿及投稿前待补项
- [架构说明](docs/architecture.md)
- [开发指南](docs/development.md)
- [核心组件文档](docs/components.md)
- [COFECHA-pass 参考序列](docs/cofecha-reference.md)
- [文档维护规则](docs/maintenance.md)
- API 文档输出目录：`docs/api`，通过 `npm run docs:api` 生成。

## 常用验证

```bash
npm run validate
npm run validate:samples
npm run validate:workspace-windows
npm run validate:auto-crossdating
npm run validate:cofecha-reference
```

`validate` 是样例解析、工作区窗口 smoke、自动交叉定年算法验证和 COFECHA-pass reference 验证的聚合入口。

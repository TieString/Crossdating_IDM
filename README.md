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
- `src/features/crossdating/reference.ts`：参考序列计算。
- `src/features/crossdating/diagnosis.ts`：内部诊断和候选生成。
- `src/services/cofecha/runner.ts`：COFECHA sidecar 执行和 OUT 文件读取。
- `src-tauri/src/commands.rs`：前端可调用的 Tauri 命令。

## 核心流程

1. 用户在主界面打开 `.rwl` 文件。
2. `src/services/fs/io.ts` 读取文本并调用 RWL 解析入口。
3. `src/features/rwl/index.ts` 自动识别格式，分派到 Tucson、Compact、CSV、Heidelberg 或 TRiDaS 解析器。
4. `RwlEditor` 管理 raw baseline、working data、历史快照、删除标记和操作日志。
5. `WidthContainer` 渲染可编辑宽度网格，`TreeChartManager` 渲染折线图和参考序列相关交互。
6. `reference.ts` 按年份对齐生成 derived reference series；`diagnosis.ts` 基于 working series 和 reference config 生成内部提示。
7. 保存和 COFECHA 运行会通过 `services/cofecha/runner.ts` 写入工作目录、运行 sidecar 并读取 `VERYCOF.OUT`。
8. COFECHA 结果由 `src/features/cofecha/formatter.ts` 解析，再由工作区按文件路径持久化最近结果。

## 文档

- [架构说明](docs/architecture.md)
- [开发指南](docs/development.md)
- [核心组件文档](docs/components.md)
- [文档维护规则](docs/maintenance.md)
- API 文档输出目录：`docs/api`，通过 `npm run docs:api` 生成。

## 常用验证

```bash
npm run validate
npm run validate:samples
npm run validate:workspace-windows
npm run validate:auto-crossdating
```

`validate` 是样例解析、工作区窗口 smoke 和自动交叉定年算法验证的聚合入口。

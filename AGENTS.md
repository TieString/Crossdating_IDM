# 仓库指南

这是一个用于树轮交叉定年的 Tauri + React + TypeScript 应用。这个文件是智能体或人工阅读代码时的第一入口，用来快速建立项目结构和数据流认知。

## 从这里开始

- [src/pages/Home.tsx](src/pages/Home.tsx)：主界面和整体流程编排入口
- [src/features/rwl/index.ts](src/features/rwl/index.ts)：RWL 格式识别与解析入口
- [src/services/fs/io.ts](src/services/fs/io.ts)：文件读写辅助与解析桥接
- [src/services/cofecha/runner.ts](src/services/cofecha/runner.ts)：COFECHA 执行与 OUT 文件处理
- [src-tauri/src/lib.rs](src-tauri/src/lib.rs)：Tauri 命令注册入口
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs)：前端可调用的 Rust 命令

## 核心流程

1. 用户在 [src/pages/Home.tsx](src/pages/Home.tsx) 中打开 `.rwl` 文件。
2. [src/services/fs/io.ts](src/services/fs/io.ts) 读取文件，并把文本交给 RWL 解析器。
3. [src/features/rwl/index.ts](src/features/rwl/index.ts) 自动识别格式、推导 stop marker，并分派到具体解析器。
4. 解析后的数据通过 RWL 编辑器工具渲染并支持修改。
5. 保存时会触发 [src/services/cofecha/runner.ts](src/services/cofecha/runner.ts)，它会把输入写入 COFECHA 工作目录，运行 sidecar，并读取 `VERYCOF.OUT`。
6. COFECHA 汇总结果的解析在 [src/features/cofecha/formatter.ts](src/features/cofecha/formatter.ts) 中完成。
7. Rust 命令 [write_out_next_to_rwl](src-tauri/src/commands.rs) 会在可能的情况下把 OUT 文件镜像保存到源 `.rwl` 文件旁边。

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

## 编辑规则

- 解析器、运行器和桥接层优先写模块级说明。
- 行内注释要短，重点说明假设、边界条件和文件格式约束。
- 当项目入口、数据流或文件格式变化时，及时更新这个指南。
- 如果新增了解析器或命令，要把新路径写到这里。

## 常用命令

- `npm run dev`
- `npm run build`
- `npm run tauri`

## 建议阅读顺序

1. [README.md](README.md)
2. [AGENTS.md](AGENTS.md)
3. [RWL_FORMAT_SPEC.md](RWL_FORMAT_SPEC.md) — 若要理解 RWL 格式设计
4. [src/pages/Home.tsx](src/pages/Home.tsx)
5. [src/features/rwl/index.ts](src/features/rwl/index.ts) — 格式处理器注册表
6. [src/services/cofecha/runner.ts](src/services/cofecha/runner.ts)
7. [src-tauri/src/lib.rs](src-tauri/src/lib.rs)

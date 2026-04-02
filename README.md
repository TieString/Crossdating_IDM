# 🌳 Crossdating IDM - 树轮交叉定年交互式工具

这是一个用于树轮交叉定年的 Tauri + React + TypeScript 应用。
前端负责读取、编辑和保存 RWL 数据，Rust/Tauri 负责文件桥接与 COFECHA 输出写回。

> **Crossdating IDM** = Interactive Data Management (交互式数据管理)
> 用于处理树轮年代学研究中的年轮宽度数据（RWL 格式），与 COFECHA 交叉定年软件无缝集成。

---

## 🎯 核心功能

### ✅ RWL 数据读写
- **多格式支持**：Tucson、Compact/DPLR、Heidelberg、CSV、TRiDaS
- **智能检测**：自动识别 RWL 格式和编号列数（8 列或 7 列）
- **格式保留**：打开什么格式保存什么格式，不改变用户原始数据结构
- **大文件处理**：支持数千行年轮宽度数据

### ✏️ 交互式编辑
- **直观界面**：以表格形式显示样点名称、年份和宽度值
- **快速修改**：双击修改年轮宽度、插入年份、删除年份
- **撤销重做**：Ctrl+Z / Ctrl+Y，支持完整的编辑历史
- **多树种支持**：在样点下拉菜单中选择不同的树木编号

### 🔗 COFECHA 集成
- **自动运行**：保存数据后自动执行 COFECHA 交叉定年
- **结果解析**：自动提取 COFECHA 输出并展示主要统计结果
- **问题诊断**：高亮显示可能存在的年轮错误段落
- **文件输出**：将 OUT 文件与原 RWL 文件保存在一起

### 📊 数据可视化
- **树轮曲线**：动态绘制年轮宽度曲线，直观展示数据分布
- **交互提示**：悬浮显示年份和具体宽度值
- **结果汇总**：展示 COFECHA 的主序列拟合度、绝对日期等关键指标

---

## 🚀 快速开始

### 1. 安装与启动

```bash
# 安装依赖
npm install

# 启动开发环境（推荐）
npm run dev

# 或构建生产版本
npm run build

# 或启动 Tauri 应用
npm run tauri
```

### 2. 打开 RWL 文件

1. 点击菜单 **"打开"** 选择一个 `.rwl` 文件
2. 应用会自动识别格式（Tucson、CSV 等）
3. 数据显示在表格和图表中

### 3. 编辑数据

- **修改宽度值**：双击单元格，输入新值，回车确认
- **插入年份**：选择年份右键选择"插入年份"
- **删除年份**：选择年份右键选择"删除年份"
- **点击树种下拉菜单**：查看不同树木的数据

### 4. 保存与 COFECHA 执行

1. 按 **Ctrl+S** 或点击菜单 **"保存"** 
2. 应用自动将数据保存到原文件
3. 自动执行 COFECHA 并展示结果
4. `.OUT` 文件保存到原 RWL 文件的同一目录

---

## 📋 支持的 RWL 格式

| 格式名称 | 特点 | 示例 |
|---------|------|------|
| **Tucson (ITRDB)** ⭐ | 标准树轮库格式，固定宽列 | 8 列编号 + 4 列年份 + 11×6 列宽度 |
| **Compact (DPLR)** | 3 列紧凑格式 | series year value |
| **Heidelberg (FH)** | Tucson 变体，含 HEADER: | 与 Tucson 相同，但有头部标记 |
| **CSV** | 灵活的表格格式 | 自动检测分隔符和列结构 |
| **TRiDaS** | XML 树轮标准 | 国际通用格式 |

> ⚠️ **格式透明性**：打开文件时自动检测编号列数（8 或 7 列），保存时保持原格式不变，您的数据不会被默认修改。详见 [RWL_FORMAT_SPEC.md](RWL_FORMAT_SPEC.md)。

---

## ⚙️ 工作原理

### 主流程
```
打开 .rwl 文件
    ↓ 自动检测格式（Tucson、CSV 等）
编辑年轮宽度
    ↓ 撤销重做、插年删年等
保存文件
    ↓ 原格式输出
自动运行 COFECHA
    ↓ 交叉定年计算
展示结果
    ↓ 主序列、统计指标、问题诊断
```

### 数据结构

内部表示为：
```typescript
Map<样点编号, Map<年份, 宽度值>>

示例：
{
  "TREE001": { 1950: 725, 1951: 685, 1952: 653, ... },
  "TREE002": { 1950: 812, 1951: 825, 1952: 734, ... }
}
```

无论输入格式如何，都会被转换为这个通用结构，保存时按照原格式重新序列化。

---

## 🔍 常见问题

### Q1: 打开文件后没有显示数据？
**A:** 
- 检查文件是否为有效的 RWL 格式（必须有样点编号和年轮宽度值）
- 查看"控制台"是否有错误信息
- 尝试使用 [RWL_FORMAT_SPEC.md](RWL_FORMAT_SPEC.md) 中的示例测试文件

### Q2: 保存后文件格式改变了？
**A:** 
- **不应该发生**。应用采用"格式透明性"设计，保存时会保持原格式
- 若仍有问题，请检查 `readOptions` 字段（开发者文档）
- 报告 Issue 时请附上原始 RWL 文件

### Q3: COFECHA 没有输出？
**A:**
- 确保系统中已安装 COFECHA （sidecar 在应用包内）
- 检查数据是否包含足够的有效年轮值（通常需要 >= 20 年）
- 查看应用数据目录 `cofecha-work` 中的临时文件

### Q4: 能否处理包含多种树种的混合文件？
**A:** 
- **可以**。在样点编号下拉菜单中选择"全部"可查看所有树木
- 编辑时可在下拉菜单中切换不同树木
- 保存时会保留所有树木的数据

### Q5: 如何恢复意外删除的年份？
**A:** 
- 使用 **Ctrl+Z** 撤销操作
- 重新打开文件（未保存的修改会丢失）

---

## 💡 使用建议

### 最佳实践

1. **定期保存**
   - 编辑过程中每 5-10 分钟按 Ctrl+S 保存一次
   - 自动运行 COFECHA 可以实时反馈数据质量

2. **检查 COFECHA 结果**
   - 查看"可能的问题"部分，定位有错误的年份
   - 参考主序列拟合度（R 值越高越好）
   - 重新编辑有问题的段落并重新保存

3. **备份原始文件**
   - 在编辑前保留原始 `.rwl` 文件的备份
   - 应用会在原文件目录生成 `.OUT` 文件，保留此文件用于后续分析

4. **格式选择**
   - 如果与其他团队协作，推荐使用标准 Tucson 格式（ITRDB 兼容）
   - 若需要灵活编辑，可使用 CSV 格式

### 数据质量检查清单

- ✅ 年份序列连续（无大的间隔）
- ✅ 年轮宽度值在合理范围内（通常 100-1000）
- ✅ COFECHA 主序列 R 值 >= 0.6
- ✅ 没有可疑的峰值或谷值（用图表直观检查）
- ✅ 样点编号格式统一

---

## 📂 项目定位说明

**开发者文档** → [AGENTS.md](AGENTS.md) 和 [AI_READING_GUIDE.md](AI_READING_GUIDE.md)

如果您是开发者或想理解应用内部架构，请参考：

- [AGENTS.md](AGENTS.md) — 项目概览和核心模块
- [AI_READING_GUIDE.md](AI_READING_GUIDE.md) — 详细的代码模块导航
- [RWL_FORMAT_SPEC.md](RWL_FORMAT_SPEC.md) — RWL 格式规范和透明性设计

---

## 🛠️ 运行方式（开发）

### 运行方式

- `npm run dev`: 启动前端开发环境
- `npm run build`: 执行 TypeScript 检查并构建前端
- `npm run tauri`: 调用 Tauri CLI

### 项目总览

这个项目的主流程是：打开 `.rwl` 文件 -> 解析成结构化数据 -> 编辑年轮宽度 -> 保存回写 -> 运行 COFECHA -> 解析 `VERYCOF.OUT` -> 在界面上展示结果。

核心模块如下：

- [src/pages/Home.tsx](src/pages/Home.tsx)：主工作流入口，负责编排打开、保存、编辑、运行 COFECHA 和结果刷新
- [src/features/rwl/index.ts](src/features/rwl/index.ts)：RWL 解析总入口，负责格式识别、stop marker 推导和解析器回退
- [src/features/rwl/edit.ts](src/features/rwl/edit.ts)：RWL 数据编辑逻辑，包含插年、删年、改值和撤销重做
- [src/features/cofecha/formatter.ts](src/features/cofecha/formatter.ts)：解析 COFECHA 输出并提取摘要、主序列和问题段落
- [src/services/fs/io.ts](src/services/fs/io.ts)：文件读取与写入的桥接层
- [src/services/cofecha/runner.ts](src/services/cofecha/runner.ts)：调用 COFECHA sidecar，读取 `VERYCOF.OUT`，并在需要时回写到原始文件旁边
- [src/services/fs/workspace.ts](src/services/fs/workspace.ts)：管理 COFECHA 工作目录
- [src-tauri/src/lib.rs](src-tauri/src/lib.rs)：Rust 侧命令注册入口
- [src-tauri/src/commands.rs](src-tauri/src/commands.rs)：前端可调用的 Rust 命令

### 数据流

1. 用户在 [src/pages/Home.tsx](src/pages/Home.tsx) 中选择 `.rwl` 文件。
2. [src/services/fs/io.ts](src/services/fs/io.ts) 读取文本并交给 RWL 解析器。
3. [src/features/rwl/index.ts](src/features/rwl/index.ts) 自动识别格式，必要时按多个解析器顺序回退。
4. 解析后的数据进入编辑器模型，前端基于这些数据渲染树种、年份和宽度。
5. 保存时，当前数据会被重新格式化为 RWL 文本并写回原文件。
6. [src/services/cofecha/runner.ts](src/services/cofecha/runner.ts) 把输入写入 COFECHA 工作目录，启动 sidecar，并读取 `VERYCOF.OUT`。
7. [src/features/cofecha/formatter.ts](src/features/cofecha/formatter.ts) 解析输出文本，生成摘要信息和问题片段。
8. Rust 命令 [src-tauri/src/commands.rs](src-tauri/src/commands.rs) 负责把 OUT 内容镜像保存到源 `.rwl` 文件旁边。

### 文件格式说明

（用户已在上方详细了解，此处仅供开发参考）

- Tucson RWL 是当前最主要的输入格式，支持短格式（8 列编号）和长格式（7 列编号），项目自动检测并保持原格式。详见 [RWL_FORMAT_SPEC.md](RWL_FORMAT_SPEC.md)。
- 解析器依赖 stop marker，项目会尝试从源文本中自动推导。
- COFECHA 工作文件统一放在应用数据目录下的 `cofecha-work` 中。
- `VERYCOF.OUT` 是前端消费的关键输出文件。

### 目录建议

- `src/features/rwl/`：所有 RWL 相关解析、类型和编辑逻辑
- `src/features/cofecha/`：COFECHA 输出解析逻辑
- `src/services/fs/`：文件系统和工作目录桥接
- `src/services/cofecha/`：COFECHA 运行和输出收集
- `src-tauri/src/`：Rust 命令、模型和文件操作

### 给智能体/开发者的阅读顺序

如果你要快速理解项目，建议先读：

1. [AGENTS.md](AGENTS.md)
2. [RWL_FORMAT_SPEC.md](RWL_FORMAT_SPEC.md) — 了解 RWL 格式和透明性设计
3. [src/pages/Home.tsx](src/pages/Home.tsx)
4. [src/features/rwl/index.ts](src/features/rwl/index.ts)
5. [src/features/rwl/edit.ts](src/features/rwl/edit.ts)
6. [src/services/cofecha/runner.ts](src/services/cofecha/runner.ts)
7. [src/features/cofecha/formatter.ts](src/features/cofecha/formatter.ts)
8. [src-tauri/src/lib.rs](src-tauri/src/lib.rs)

### 推荐编辑器

- VS Code
- Tauri
- rust-analyzer

---

## 📞 支持与反馈

- 发现 Bug？报告 Issue
- 有功能建议？欢迎贡献
- 需要帮助？查看上方"常见问题"或查阅开发者文档

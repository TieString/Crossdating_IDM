# 🤖 智能体项目阅读快速指南

本文档为智能代理（如 Copilot、Claude 等）提供**最优阅读路径**和**快速导航**，帮助快速理解项目结构、数据流和核心概念。

---

## 📍 图例说明

| 符号 | 含义 |
|------|------|
| ⚡ | 关键入口，必读 |
| 🔧 | 工具函数或桥接层 |
| 📊 | 数据结构或类型 |
| 🎨 | UI/前端组件 |
| 🛠️ | Rust/系统命令 |

---

## 📚 快速阅读（5分钟熟悉项目）

**按以下顺序读文件：**

1. **⚡ [AGENTS.md](AGENTS.md)** - 项目概览
2. **⚡ [README.md](README.md)** - 完整数据流和目录说明
3. **⚡ [src/pages/Home.tsx](src/pages/Home.tsx)** - 主工作流编排
4. **📊 [src/features/rwl/types.ts](src/features/rwl/types.ts)** - RWL 数据结构

---

## 🏗️ 核心模块导航表

### 前端层

| 文件路径 | 职责 | 优先级 | 依赖关系 |
|---------|------|--------|---------|
| ⚡ [src/pages/Home.tsx](src/pages/Home.tsx) | 主业务流（打开→解析→编辑→保存→COFECHA→展示） | P0 | 所有模块 |
| 🎨 [src/components/Chart/](src/components/Chart/) | 图表展示（树轮宽度、交叉定年结果） | P1 | Chart.js, 数据格式化 |
| 🎨 [src/components/Menu/](src/components/Menu/) | 菜单导航 | P2 | 无关键依赖 |

### RWL 解析层

| 文件路径 | 职责 | 优先级 | 需要掌握 |
|---------|------|--------|---------|
| ⚡ **[src/features/rwl/index.ts](src/features/rwl/index.ts)** | RWL 总入口：格式自动识别 + stop marker 推导 + 解析器回退 | P0 | 格式检测流程、多解析器工作原理 |
| 📊 [src/features/rwl/types.ts](src/features/rwl/types.ts) | RWL 数据类型定义及解析参数（Year, Width, RwlReadResult等） | P0 | 数据结构、readOptions 格式参数、格式透明性元信息 |
| 🔧 [src/features/rwl/detect.ts](src/features/rwl/detect.ts) | 格式检测（正则匹配 DPLR, Tucson, TRIDAS, CSV 等） | P1 | 每种格式特征 |
| 🔧 [src/features/rwl/normalize.ts](src/features/rwl/normalize.ts) | 文本预处理（BOM 去除，行分割，空白规范化） | P1 | 输入清理逻辑 |
| 🔧 [src/features/rwl/parsers/tucson.ts](src/features/rwl/parsers/tucson.ts) | Tucson/ITRDB 格式解析（支持 8 列和 7 列编号自动检测） | P1 | 固定宽读法、long/short 自动检测、readOptions 返回值 |
| 🔧 [src/features/rwl/parsers/compact.ts](src/features/rwl/parsers/compact.ts) | DPLR Compact 格式解析 | P2 | 3 列表结构 |
| 🔧 [src/features/rwl/parsers/csv.ts](src/features/rwl/parsers/csv.ts) | CSV 长表/宽表解析 | P2 | CSV 方言检测 |
| 🔧 [src/features/rwl/parsers/heidelberg.ts](src/features/rwl/parsers/heidelberg.ts) | FH/Heidelberg 格式 | P2 | HEADER: 标记、FH 语法 |
| 🔧 [src/features/rwl/parsers/tridas.ts](src/features/rwl/parsers/tridas.ts) | TRiDaS XML 格式 | P2 | XML 解析、schema |
| 🔧 [src/features/rwl/edit.ts](src/features/rwl/edit.ts) | RWL 编辑操作及格式化（插年、删年、改值、撤销重做、格式保留） | P1 | 编辑命令、不可变数据、RwlEditor 格式元信息记录、formateRwlFromMapToString 格式参数 |
| 🔧 [src/features/rwl/errors.ts](src/features/rwl/errors.ts) | RWL 解析错误定义 | P1 | 错误分类 |

### COFECHA 生命周期

| 文件路径 | 职责 | 优先级 | 关键点 |
|---------|------|--------|--------|
| ⚡ **[src/services/cofecha/runner.ts](src/services/cofecha/runner.ts)** | COFECHA 执行流：文件写入→Sidecar 启动→OUT 读取 | P0 | 非 ASCII 名处理、清空工作目录、结果缓存 |
| 🔧 [src/features/cofecha/formatter.ts](src/features/cofecha/formatter.ts) | 解析 VERYCOF.OUT（PART 1,3,6 提取） | P1 | OUT 格式、摘要提取 |
| 📊 [src/features/cofecha/types.ts](src/features/cofecha/types.ts) | COFECHA 结果数据结构 | P0 | 字段映射关系 |
| 🔧 [src/services/fs/workspace.ts](src/services/fs/workspace.ts) | 工作目录管理（清空、获取路径） | P1 | 应用数据目录约定 |

### 文件系统与 Tauri 桥接

| 文件路径 | 职责 | 优先级 | 特点 |
|---------|------|--------|------|
| 🔧 **[src/services/fs/io.ts](src/services/fs/io.ts)** | 文件读写高层 API（readRwlFile, saveFile） | P0 | 编码处理、错误包装 |
| 🔧 [src/services/fs/index.ts](src/services/fs/index.ts) | 文件服务导出入口 | P0 | 公开接口 |
| 🛠️ **[src-tauri/src/lib.rs](src-tauri/src/lib.rs)** | Rust 命令注册中心 | P0 | 模块初始化 |
| 🛠️ **[src-tauri/src/commands.rs](src-tauri/src/commands.rs)** | Tauri 命令实现（write_out_next_to_rwl, list_files, etc） | P0 | 前端调用接口 |
| 🛠️ [src-tauri/src/models.rs](src-tauri/src/models.rs) | Rust 数据模型（序列化/反序列化） | P1 | Serde 结构 |
| 🛠️ [src-tauri/src/file_ops.rs](src-tauri/src/file_ops.rs) | Rust 文件操作基础函数 | P1 | 递归遍历、错误处理 |

---

## 🔄 数据流（从代理视角）

```
用户打开 .rwl 文件
    ↓
[Home.tsx] 调用 readRwlFile()
    ↓
[io.ts] Tauri 读取文件 + 编码转换
    ↓
[rwl/index.ts] 格式自动检测 (detectRwlFormat)
    ↓
[rwl/detect.ts] 正则匹配识别格式特征
    ↓
[parsing fallback loop]
    - 尝试选中格式解析器
    - 失败则尝试下一个（tucson → compact → heidelberg → csv → tridas）
    ↓
[parsers/*.ts] 解析成 RwlSiteData (Map<species, Map<Year, Width>>)
    ↓
[Home.tsx] 渲染 UI，用户编辑数据
    ↓
[rwl/edit.ts] 处理编辑操作（insertYear, deleteYear, editValue）
    ↓
用户保存
    ↓
[Home.tsx] 调用 runCofecha()
    ↓
[cofecha/runner.ts] 
    - 清空 cofecha-work 目录
    - 写入 RWL 文本 → INPUT.RWL
    - 启动 COFECHA sidecar (bin/cofecha)
    - 读取 VERYCOF.OUT
    ↓
[cofecha/formatter.ts] 解析 OUT → summary + details
    ↓
[Home.tsx] 展示结果图表
    ↓
[commands.rs] write_out_next_to_rwl → 镜像保存 .OUT 文件
```

---

## 📋 常见任务速查

### 我需要添加新的 RWL 解析器

1. 在 [src/features/rwl/detect.ts](src/features/rwl/detect.ts) 中添加格式检测正则
2. 在 [src/features/rwl/types.ts](src/features/rwl/types.ts) 中注册新 `RwlFormat` 类型
3. 在 [src/features/rwl/parsers/](src/features/rwl/parsers/) 中创建 `parse*.ts` 文件
4. 在 [src/features/rwl/index.ts](src/features/rwl/index.ts) 的 `tryParseInOrder` 中添加分支

**参考：** [src/features/rwl/parsers/tucson.ts](src/features/rwl/parsers/tucson.ts)

### 我需要修复 COFECHA 输出解析

1. 理解 VERYCOF.OUT 结构 → 查看 [src/features/cofecha/formatter.ts](src/features/cofecha/formatter.ts)
2. 查看具体的 PART 提取函数（如 `extractMasterSeriesYear`）
3. 参考 [src/features/cofecha/types.ts](src/features/cofecha/types.ts) 中的数据字段

**参考：** [src/features/cofecha/formatter.ts](src/features/cofecha/formatter.ts#L40-L80)

### 我需要添加新的 Tauri 命令

1. 在 [src-tauri/src/commands.rs](src-tauri/src/commands.rs) 中实现新函数，加 `#[command]` 宏
2. 在 [src-tauri/src/lib.rs](src-tauri/src/lib.rs) 中注册命令
3. 在前端 TypeScript 中用 `invoke` 调用

**参考：** 

```rust
// commands.rs
#[command]
pub fn my_new_command(param: &str) -> Result<String, String> { ... }
```

```typescript
// Home.tsx
import { invoke } from "@tauri-apps/api/core";
const result = await invoke<string>("my_new_command", { param: "value" });
```

### 我需要修改 RWL 读写格式

1. 理解当前的格式透明性设计 → 查看 [RWL_FORMAT_SPEC.md](RWL_FORMAT_SPEC.md#格式透明性原则)
2. 检查 [src/features/rwl/types.ts](src/features/rwl/types.ts) 中的 `readOptions` 字段
3. 在 [src/features/rwl/parsers/tucson.ts](src/features/rwl/parsers/tucson.ts) 中更新检测逻辑或列宽
4. 在 [src/features/rwl/edit.ts](src/features/rwl/edit.ts) 中同步更新导出参数
5. 在 [src/pages/Home.tsx](src/pages/Home.tsx) 中确认格式信息流向正确
6. **更新文档** — [RWL_FORMAT_SPEC.md](RWL_FORMAT_SPEC.md#修改指南)、本文件表格、AGENTS.md

**参考：** [RWL_FORMAT_SPEC.md#修改指南](RWL_FORMAT_SPEC.md#修改指南) 和最近的提交记录

### 我需要理解年轮数据如何存储

**核心数据结构：**

```typescript
// Map<物种名, Map<年份, 宽度值>>
RwlSiteData = Map<string, RwlTreeData>
RwlTreeData = Map<Year, Width>

// 例：
{
  "样品1": { 1950: 2.5, 1951: null, 1952: 3.2 },
  "样品2": { 1950: 1.8, 1951: 2.0 }
}
```

**参考：** [src/features/rwl/types.ts](src/features/rwl/types.ts)

---

## 🐛 调试技巧

### 日志查看

- **前端日志：** VS Code 中启动 `npm run dev`，打开浏览器控制台 (F12)
- **Tauri 日志：** `npm run tauri dev` 会输出 Rust 和前端日志
- **工作目录文件：** macOS/Linux: `~/.local/share/crossdating-tauri`, Windows: `%APPDATA%\crossdating-tauri`

### 常见问题

| 问题 | 排查步骤 |
|------|---------|
| RWL 解析失败 | 检查 [detect.ts](src/features/rwl/detect.ts) 的正则是否匹配；查看错误消息中的解析器列表 |
| COFECHA 找不到 sidecar | 确认 `bin/cofecha` 存在于 src-tauri 目录；检查 [runner.ts](src/services/cofecha/runner.ts) 中的路径 |
| 文件编码问题 | 检查 [io.ts](src/services/fs/io.ts) 中的编码转换逻辑 |

---

## 🔍 文档快速查询

| 查询内容 | 查看文件 |
|---------|---------|
| 支持的 RWL 格式 | [types.ts](src/features/rwl/types.ts#L10-L17) |
| COFECHA 命令行交互 | [runner.ts](src/services/cofecha/runner.ts#L40-L50) |
| 错误类型定义 | [shared/errors.ts](src/shared/errors.ts) |
| TypeScript 配置 | [tsconfig.json](tsconfig.json) |
| Tauri 配置 | [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) |

---

## 💡 对智能代理的建议

1. **优先读本文件** - 快速获得项目地图
2. **然后按优先级顺序读核心文件** - P0 文件必读，P1 文件按需查阅
3. **查看 AGENTS.md** - 了解高层流程
4. **运行代码前先理解数据流** - 用上面的流程图作为心智模型
5. **遇到特定格式问题** - 查阅"常见任务速查"表
6. **修改前查看相关注释** - 特别是 module-level 和 function-level 注释

---

**最后更新：** 2026-04-02  
**语言：** 中文  
**目标受众：** 智能代理（Copilot, Claude 等）

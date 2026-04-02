# 🎯 项目速查卡（AI 代理版）

**场景：** 你是代理，需要快速定位信息或执行操作。这份卡片提供**< 30 秒的查询时间**。

---

## 🚀 最快启动（30 秒）

1. **我是新代理，从哪开始？**  
   → 读 [AI_READING_GUIDE.md](AI_READING_GUIDE.md) 的"快速阅读（5分钟）"部分

2. **我需要了解项目全貌**  
   → 按顺序读：[AGENTS.md](AGENTS.md) → [README.md](README.md) → [AI_READING_GUIDE.md](AI_READING_GUIDE.md)

3. **指导我如何改进文档**  
   → 查看 [DOC_IMPROVEMENT_PLAN.md](DOC_IMPROVEMENT_PLAN.md)

---

## 📍 模块速查（< 10 秒）

| 我要... | 查看文件 |
|--------|---------|
| 打开/保存 RWL 文件 | [src/services/fs/io.ts](src/services/fs/io.ts) |
| 添加 RWL 格式支持 | [src/features/rwl/parsers/](src/features/rwl/parsers/) + [detect.ts](src/features/rwl/detect.ts) |
| 理解年轮数据结构 | [src/features/rwl/types.ts](src/features/rwl/types.ts) |
| 编辑年轮数据（插年/删年/改值） | [src/features/rwl/edit.ts](src/features/rwl/edit.ts) |
| 运行 COFECHA 分析 | [src/services/cofecha/runner.ts](src/services/cofecha/runner.ts) |
| 解析 COFECHA 输出 | [src/features/cofecha/formatter.ts](src/features/cofecha/formatter.ts) |
| 理解 COFECHA 结果类型 | [src/features/cofecha/types.ts](src/features/cofecha/types.ts) |
| 添加新 Tauri 命令 | [src-tauri/src/commands.rs](src-tauri/src/commands.rs) + [lib.rs](src-tauri/src/lib.rs) |
| 主业务流程 | [src/pages/Home.tsx](src/pages/Home.tsx) |
| 图表展示与交互 | [src/components/Chart/](src/components/Chart/) |

---

## 🔍 问题排查（< 30 秒）

| 症状 | 可能原因 | 检查位置 |
|------|---------|---------|
| RWL 无法解析 | 格式不被识别 | [detect.ts](src/features/rwl/detect.ts) 中的正则 |
| | 所有解析器都失败 | 查看完整错误消息中的解析器列表 |
| COFECHA 找不到 sidecar | 二进制文件丢失或路径错误 | [runner.ts](src/services/cofecha/runner.ts#L9) + src-tauri/bin/ |
| 文件读取乱码 | 编码处理错误 | [io.ts](src/services/fs/io.ts) 中的编码逻辑 |
| 非 ASCII 文件名失败 | 被 COFECHA 降级为 ASCII | [runner.ts](src/services/cofecha/runner.ts#L30) 中的注释 |
| OUT 文件未保存到源目录 | write_out_next_to_rwl 失败 | [commands.rs](src-tauri/src/commands.rs) + 检查权限 |

---

## 💻 代码片段速查

### 如何从前端调用 RWL 解析？

```typescript
// src/pages/Home.tsx 的模式

import { readRwlFile } from "@/services/fs";

const data = await readRwlFile(filePath, {
  preferFormat: "tucson",
  stopMarker: -9999,
});
```

### 如何运行 COFECHA？

```typescript
// src/pages/Home.tsx 的模式

import { runCofecha } from "@/services/cofecha/runner";

const outText = await runCofecha(rwlText, "input.rwl", sourceRwlPath);
```

### 如何调用 Tauri 命令？

```typescript
// 任何前端 .tsx 文件中

import { invoke } from "@tauri-apps/api/core";

const result = await invoke<string>("write_out_next_to_rwl", {
  sourceRwlPath: "/path/to/file.rwl",
  outText: "content",
});
```

### 如何编辑年轮数据？

```typescript
// src/features/rwl/edit.ts 中的接口

import { insertYear, deleteYear, editValue } from "@/features/rwl/edit";

const updated = insertYear(data, speciesId, year, width);
const updated = deleteYear(data, speciesId, year);
const updated = editValue(data, speciesId, year, newWidth);
```

---

## 🗂️ 项目目录导航

```
Crossdating_Tauri/
├── 📄 AGENTS.md                    ← 项目概览（✓ 必读）
├── 📄 README.md                    ← 完整指南（✓ 必读）  
├── 📄 AI_READING_GUIDE.md          ← 代理快速指南（✓ 代理必读）
├── 📄 DOC_IMPROVEMENT_PLAN.md      ← 文档改进计划
├── 📄 QUICK_REFERENCE.md           ← 本文件
│
├── src/                            ← 前端 TypeScript
│   ├── pages/
│   │   └── Home.tsx                ← 主工作流入口
│   ├── features/
│   │   ├── rwl/                    ← RWL 解析与编辑
│   │   │   ├── index.ts            ← RWL 总入口
│   │   │   ├── types.ts            ← 数据类型
│   │   │   ├── detect.ts           ← 格式检测
│   │   │   ├── edit.ts             ← 编辑操作
│   │   │   └── parsers/            ← 各格式解析器
│   │   └── cofecha/                ← COFECHA 输出处理
│   │       ├── formatter.ts        ← OUT 解析
│   │       └── types.ts            ← 结果类型
│   ├── services/
│   │   ├── fs/                     ← 文件系统服务
│   │   │   ├── io.ts               ← 读写接口
│   │   │   └── workspace.ts        ← 工作目录
│   │   └── cofecha/
│   │       └── runner.ts           ← COFECHA 执行
│   └── components/
│       └── Chart/                  ← 图表展示
│
└── src-tauri/                      ← Rust 后端
    └── src/
        ├── lib.rs                  ← 命令注册
        ├── commands.rs             ← 命令实现
        ├── models.rs               ← 数据模型
        └── file_ops.rs             ← 文件操作
```

---

## 🎓 学习路径

### 路径 A：我想理解整个系统（60 分钟）
1. [AGENTS.md](AGENTS.md) (5 min)
2. [README.md](README.md) 中的"数据流"章节 (10 min)
3. [src/pages/Home.tsx](src/pages/Home.tsx) (15 min)
4. [src/features/rwl/index.ts](src/features/rwl/index.ts) + [types.ts](src/features/rwl/types.ts) (15 min)
5. [src/services/cofecha/runner.ts](src/services/cofecha/runner.ts) (10 min)
6. [src-tauri/src/lib.rs](src-tauri/src/lib.rs) + [commands.rs](src-tauri/src/commands.rs) (5 min)

### 路径 B：我想快速修复 RWL 解析（30 分钟）
1. [src/features/rwl/types.ts](src/features/rwl/types.ts) (5 min)
2. [src/features/rwl/detect.ts](src/features/rwl/detect.ts) (5 min)
3. 相关解析器文件如 [parsers/tucson.ts](src/features/rwl/parsers/tucson.ts) (15 min)
4. 运行测试，检查错误信息 (5 min)

### 路径 C：我想添加新功能（90 分钟）
1. 理解系统架构（路径 A） (60 min)
2. 确定新功能所在模块 (10 min)
3. 查阅相关的类型和函数 (10 min)
4. 编写并测试 (10 min)

---

## 📞 还有问题？

| 问题类型 | 查找位置 |
|---------|---------|
| "这个函数做什么？" | 查看函数上方的注释或文件顶部的模块说明 |
| "RWL 数据怎么存储？" | [src/features/rwl/types.ts](src/features/rwl/types.ts) |
| "COFECHA 输出怎么解析？" | [src/features/cofecha/formatter.ts](src/features/cofecha/formatter.ts) |
| "怎么和 Rust 通信？" | [src-tauri/src/commands.rs](src-tauri/src/commands.rs) |
| "怎么添加新解析器？" | [DOC_IMPROVEMENT_PLAN.md](DOC_IMPROVEMENT_PLAN.md) 中的"常见任务速查" |
| "系统架构是什么？" | [ARCHITECTURE.md](ARCHITECTURE.md)（待创建） 或 [README.md](README.md) |

---

**最后更新：** 2026-04-02  
**用途：** 代理快速参考卡  
**保管：** 项目根目录

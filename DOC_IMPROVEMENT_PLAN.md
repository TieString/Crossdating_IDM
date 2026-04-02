# 📖 项目文档改进方案

本文档总结了项目当前的文档优势和改进建议，帮助进一步提升智能体（和人工开发者）的理解效率。

---

## ✅ 当前文档优势

### 1. 结构清晰
- ✓ README.md 包含完整的数据流、模块说明、目录建议
- ✓ AGENTS.md 提供项目概览和核心入口  
- ✓ 代码中有模块级注释（RWL 解析、COFECHA runner）

### 2. 中英混用恰当
- 中文注释在关键流程中有帮助（如 COFECHA 工作目录清空说明）
- 英文类型名和函数名清晰易懂

### 3. 类型系统完整
- 📊 [src/features/rwl/types.ts](src/features/rwl/types.ts) 和 [src/features/cofecha/types.ts](src/features/cofecha/types.ts) 都有类型定义和注释
- 便于值得信赖的类型系统帮助代理快速理解数据结构

---

## 🚀 改进建议（按优先级）

### 优先级 1：高价值、快速实施

#### 1.1 为关键模块补齐文件顶部文档

**目标：** 每个核心模块文件（.ts）顶部都有 5-8 行的模块说明。

**模块清单：**

| 文件 | 当前状态 | 建议 |
|------|---------|------|
| [src/features/rwl/index.ts](src/features/rwl/index.ts) | ✓ 已有 | 已完整 |
| [src/features/rwl/detect.ts](src/features/rwl/detect.ts) | ✗ 无 | 添加格式检测逻辑说明 |
| [src/features/rwl/normalize.ts](src/features/rwl/normalize.ts) | ✗ 无 | 添加文本准备步骤说明 |
| [src/features/rwl/edit.ts](src/features/rwl/edit.ts) | ✗ 无 | 添加编辑命令模式说明 |
| [src/features/cofecha/formatter.ts](src/features/cofecha/formatter.ts) | ✓ 有部分 | 补充完整的 OUT 部分说明 |
| [src/services/fs/io.ts](src/services/fs/io.ts) | ✗ 无 | 添加文件读写接口说明 |
| [src/services/cofecha/runner.ts](src/services/cofecha/runner.ts) | ✓ 有 | 已完整 |

**范例（对 detect.ts 建议的补充）：**

```typescript
/**
 * RWL 格式检测模块
 * 
 * 职责：
 * 1. 通过正则模式识别输入文本的 RWL 格式（Tucson, Compact, Heidelberg, TRiDaS, CSV）
 * 2. 采用 dplR::read.rwl(format="auto") 的检测顺序，确保行为一致
 * 3. 返回 "unknown" 如果无法识别，由上层决定回退策略
 * 
 * 设计原则：快速判断 + 精确度优先（DPLR 兼容）
 * 不处理：实际解析、error handling（由上层负责）
 */
```

#### 1.2 增强类型注释

**目标：** 为复杂类型及其成员字段添加简短说明。

**范例（src/features/rwl/types.ts）：**

```typescript
/**
 * 单个树种的年轮数据
 * Key: 年份（从小到大）
 * Value: 宽度（毫米 × 100）；null = 缺失或无数据
 */
export type RwlTreeData = Map<Year, Width>;

/**
 * 站点全部树种数据
 * Key: 树种 ID 或标签（如 "PINE-001", "OAK-A"）
 * Value: 该树种的年轮时间序列
 */
export type RwlSiteData = Map<string, RwlTreeData>;

/**
 * RWL 读取参数
 * 
 * @param long 是否启用负年代模式（ID 7 + 年份 5 位数字）
 * @param edgeZeros 是否保留边界 0 值（false 时视 0 为缺失）
 * @param stopMarker 数据结束标记（Tucson 默认 -9999）
 * @param preferFormat 强制使用指定解析器，跳过自动检测
 */
export interface RwlReadOptions { ... }
```

#### 1.3 创建关键函数的行内注释

**目标：** 在复杂逻辑处添加 1-2 行注释，说明**为什么**而不仅仅是**什么**。

**范例（src/services/cofecha/runner.ts 中的非 ASCII 处理）：** ✓ 已有（保持现状）

```typescript
const hasNonAsciiName = /[^\x00-\x7F]/.test(requestedName);
// 当前集成下，COFECHA 对非 ASCII 文件名不稳定，因此这里统一降级。
const runtimeInputName = hasNonAsciiName ? defaultInputName : requestedName;
```

---

### 优先级 2：中等价值、需要规划

#### 2.1 创建架构设计文档 (ARCHITECTURE.md)

**目标：** 一份 1-2 页的高层设计文档，包括：
- 系统分层（前端 → FS → Parser → COFECHA 链条）
- 依赖关系图  
- 错误处理策略
- 性能及扩展性考虑

**建议标题结构：**
```markdown
# 架构设计

## 系统分层
- 前端层（React + Router）
- 业务层（RWL 编辑、COFECHA 流程编排）
- 解析层（RWL 多格式、COFECHA 输出解析）
- 服务层（文件系统、工作目录管理）
- Tauri 桥接层（Rust 命令、文件操作）

## 数据流与职责分工

## 扩展点与插件机制
（如何添加新的 RWL 格式或 COFECHA 后处理）

## 错误处理原则

## 已知限制与改进机会
```

#### 2.2 补充测试文档 (TEST_RWL_FORMATS.md)

**目标：** 对每种 RWL 格式提供示例文件 + 测试用例

```markdown
# RWL 格式测试指南

## Tucson 格式
### 示例
```
PINE-123  5265  6970  7071  7072  7173  7274  ...
```
### 参考资源
- ITRDB 官方说明
- [src/features/rwl/parsers/tucson.ts](src/features/rwl/parsers/tucson.ts) 中的边界条件

## Compact 格式
...
```

---

### 优先级 3：附加价值、长期维护

#### 3.1 命令行工具文档 (CLI_COMMANDS.md)

**目标：** 文档化所有 Rust Tauri 命令及其参数

```markdown
# Tauri 命令参考

## write_out_next_to_rwl
- **用途**：将 COFECHA 输出保存到源文件目录
- **参数**：
  - source_rwl_path (string): 源 RWL 文件路径
  - out_text (string): VERYCOF.OUT 内容
- **返回**：保存的 OUT 文件路径
- **错误**：无效路径、写入失败
```

#### 3.2 API 示例与代码片段集合

**目标：** 在项目根目录创建 `examples/` 文件夹，提供典型用法

```
examples/
├── load_rwl_file.ts        // 如何读取和解析 RWL
├── edit_and_save.ts        // 如何编辑年轮数据
├── run_cofecha.ts          // 如何运行 COFECHA
└── parse_cofecha_output.ts // 如何解析结果
```

---

## 📋 改进实施计划

### 第一阶段（立即可做）

| 项 | 时间 | 难度 | 优先级 |
|----|------|------|--------|
| 补齐文件顶部模块注释（5-6 个文件） | 30 分钟 | 低 | P1 |
| 增强类型注释（types.ts 们） | 20 分钟 | 低 | P1 |
| 创建 AI_READING_GUIDE.md | 50 分钟 | 中 | P1 ✅ **已完成** |

### 第二阶段（本周可做）

| 项 | 时间 | 难度 | 优先级 |
|----|------|------|--------|
| 创建 ARCHITECTURE.md | 1.5 小时 | 中 | P2 |
| 补充关键函数行内注释 | 45 分钟 | 低 | P2 |
| 更新 README.md 的"常见问题"部分 | 30 分钟 | 低 | P2 |

### 第三阶段（长期维护）

- 创建 TEST_RWL_FORMATS.md + 示例文件
- 创建 CLI_COMMANDS.md
- 建立 examples/ 文件夹

---

## 🎯 预期收益

### 对智能体（AI 代理）的好处

| 改进项 | 收益 |
|--------|------|
| AI_READING_GUIDE.md | ✓ 50% 快速上手时间 |
| 文件顶部模块注释 | ✓ 更准确的上下文推理 |
| ARCHITECTURE.md | ✓ 系统设计决策的理解 |
| 增强类型注释 | ✓ 减少数据流追踪错误 |

### 对人工开发者的好处

| 改进项 | 收益 |
|--------|------|
| 统一的模块文档风格 | ✓ 一致的阅读体验 |
| 架构文档 | ✓ 新人入门快 |
| 代码示例 | ✓ 快速参考 |

---

## 💼 执行步骤（推荐）

### 1️⃣ **立即执行**
```bash
# 每个核心模块顶部添加文件说明
# 预计 4 个文件，每个 10 分钟
- src/features/rwl/detect.ts
- src/features/rwl/normalize.ts
- src/features/rwl/edit.ts
- src/services/fs/io.ts
```

### 2️⃣ **本周执行**
```bash
# 创建架构设计文档
touch ARCHITECTURE.md

# 更新现有文档中的"常见问题"
# 补充函数行内注释
```

### 3️⃣ **纳入 CI/CD**
```yaml
# 可选：lint.sh 检查新文件是否有模块级注释
# 可选：为文档更新制定 PR 模板
```

---

## 🔍 检查清单

完成改进后，可用此清单验证：

- [ ] 所有 `src/features/` 下的 .ts 文件顶部都有 5-8 行模块说明
- [ ] 所有复杂数据结构（types.ts）都有成员字段注释
- [ ] 所有复杂函数（>30 行或含多个分支）都有行内注释说明关键步骤
- [ ] ARCHITECTURE.md 包含系统分层、数据流、扩展点
- [ ] README.md 首段有"如果你是智能代理，从 AI_READING_GUIDE.md 开始"
- [ ] 没有超过 100 行且无任何注释的文件

---

**文档第一版：** 2026-04-02  
**目标用户：** 项目维护者、智能代理、新手开发者

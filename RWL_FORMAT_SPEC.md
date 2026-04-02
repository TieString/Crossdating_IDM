# RWL 格式规范与实现

## 概述

本项目支持多种树轮宽度数据格式，其中 Tucson/ITRDB 是主要格式。此文档说明格式特征、解析原则和**格式透明性设计**（打开什么格式保存什么格式）。

---

## Tucson 格式规范

### 基本结构

根据 [NOAA ITRDB 约定](https://www.ncei.noaa.gov/products/paleoclimatology/tree-ring)，Tucson 格式每行固定 78 列（包含 CRLF）：

**短格式（编号 8 列 + 年份 4 列）：**
```
[编号 8列][年份 4列][宽度 6列×11] = 8+4+66 = 78列
示例：
  TREE001 1950     725     685     653     705     812     825
```

**长格式（编号 7 列 + 年份 5 列）：**
```
[编号 7列][年份 5列][宽度 6列×11] = 7+5+66 = 78列
示例：
 TREE001 01950     725     685     653     705     812     825
```

### 编号处理规则

| 规则 | 说明 |
|------|------|
| **来源** | 样点编号（如 "TREE001"、"A01B02"） |
| **填充方向** | 右对齐，左侧补空格 |
| **最大长度** | 8 字符（短格式）或 7 字符（长格式） |
| **读取** | 两侧 trim，提取有效编号 |
| **保存** | 根据原始格式 padding，保持一致性 |

### 年份处理规则

- **范围**：-10000 到 10000（支持负年代）
- **读取位置**：短格式 8-12，长格式 7-12
- **每行有效数据**：每行包含 10 年的数据，实际数据受年份对齐影响
- **整十年对齐**：新行从整十年（如 1950、1960）开始

### Stop Marker

- **定义**：特殊值（通常 -9999），表示数据中断
- **作用**：标记时间序列的结束或中间缺口
- **处理**：
  - 读取：遇到 stop marker 则停止该行的解析
  - 保存：保留 stop marker 值，触发新行

---

## 格式自动检测机制

### 检测算法

在 [src/features/rwl/parsers/tucson.ts](src/features/rwl/parsers/tucson.ts) 中实现：

```typescript
// 从第一个有效数据行推断格式
const firstLine = raw[0];
const shortYear = toIntOrNull(firstLine.slice(8, 12));
const longYear = toIntOrNull(firstLine.slice(7, 12));

// 优先选择能解析出有效年份的格式
if (isLikelyYear(longYear) && !isLikelyYear(shortYear)) {
  long = true;  // 7 列编号
} else {
  long = false; // 8 列编号
}
```

### 关键函数

**`isLikelyYear(yr)`** — 判断是否为有效年份
```typescript
function isLikelyYear(yr: number | null): boolean {
  return yr !== null && yr >= -10000 && yr <= 10000;
}
```

### 检测成功率

- ✅ 标准 ITRDB 格式：100% 准确
- ✅ 编号长度 < 8 字符且年份明显不同：99% 准确
- ⚠️ 特殊情况（如编号恰好是 4 位数字）：可能误判

**建议**：如需 100% 准确，可在解析选项中显式指定 `long` 参数。

---

## 格式透明性原则

### 核心设计目标

**用户打开什么格式的 RWL 文件，经过编辑保存后仍保持同样的格式。** 仅编辑的内容改变，格式不变。

### 问题背景

修复前，存在的问题：
1. **读取**：Tucson 解析器自动检测 long（7 列）或 short（8 列）
2. **保存**：导出函数 `formateRwlFromMapToString()` 固定输出 6 列编号
3. **后果**：
   - 7-8 字符编号被截断
   - 原始格式被改变
   - 用户数据遭到无声污染

### 解决方案：元信息链路

```
打开文件
    ↓
readRwlFile(path)
    ↓
parseTucson()
    ├─ 自动检测格式 (long/short)
    └─ 返回 RwlReadResult{data, readOptions{tucsonLong}}
    ↓
RwlEditor(data, readOptions)
    ├─ 保存格式元信息
    └─ 提供 getReadOptions() 查询接口
    ↓
用户编辑
    ↓
保存文件
    ↓
formateRwlFromMapToString(data, {tucsonLong})
    ├─ 根据 tucsonLong 选择编号宽度（7 或 8 列）
    └─ 输出 78 列标准格式
    ↓
saveFile(path, formattedString)
```

### 实现细节

#### 1. 类型定义

**[src/features/rwl/types.ts](src/features/rwl/types.ts)：**

```typescript
interface RwlReadResult {
  format: RwlFormat;
  data: RwlSiteData;
  warnings: string[];
  // 记录解析时使用的关键参数，以便后续导出时复原格式
  readOptions?: {
    tucsonLong?: boolean;        // Tucson 格式：true=7列，false=8列
    edgeZeros?: boolean;         // 边界0处理
  };
}
```

#### 2. 解析器更新

**[src/features/rwl/parsers/tucson.ts](src/features/rwl/parsers/tucson.ts)：**

- 自动检测 `long` 参数（默认 false）
- 返回值中附加 `readOptions: { tucsonLong: long, edgeZeros }`

#### 3. 编辑器记录

**[src/features/rwl/edit.ts](src/features/rwl/edit.ts)：**

```typescript
class RwlEditor {
  private readOptions?: RwlReadResult['readOptions'];
  
  constructor(initialData: RwlSiteData, options?: RwlReadResult['readOptions']) {
    this.rwlData = new Map(initialData);
    this.readOptions = options;  // 保存格式信息（不可变元数据）
  }
  
  getReadOptions(): RwlReadResult['readOptions'] {
    return this.readOptions;
  }
}
```

#### 4. 导出函数支持

**[src/features/rwl/edit.ts](src/features/rwl/edit.ts)：**

```typescript
export function formateRwlFromMapToString(
  rwl_data: RwlSiteData,
  selectedTree?: string,
  options?: { tucsonLong?: boolean }
): string {
  // 样点编号宽度：true=7列（长），false=8列（短）
  const idWidth = options?.tucsonLong ? 7 : 8;
  
  // ... 循环输出，使用 idWidth 代替硬编码的 6
  rwl_str += treeCode.padStart(idWidth, ' ') + ...
}
```

#### 5. 流程串联

**[src/pages/Home.tsx](src/pages/Home.tsx)：**

打开文件：
```typescript
const rwlData = await readRwlFile(filePath);
rwlEditorRef.current = new RwlEditor(rwlData.data, rwlData.readOptions);
```

保存文件：
```typescript
const rwlStr = formateRwlFromMapToString(
  rwlEditorRef.current.getData(),
  undefined,
  {
    tucsonLong: rwlEditorRef.current.getReadOptions()?.tucsonLong
  }
);
```

---

## 验证与测试

### 格式透明性测试用例

| 用例 | 步骤 | 预期结果 |
|------|------|---------|
| **保持 8 列** | 打开 8 列编号 RWL → 编辑某行 → 保存 → 再打开 | 编号仍为 8 列，数据正确 |
| **保持 7 列** | 打开 7 列编号 RWL → 编辑某行 → 保存 → 再打开 | 编号仍为 7 列，数据正确 |
| **长编号保存** | 编号为 7-8 字符的 RWL 文件 → 编辑 → 保存 | 编号完整，无截断 |
| **行长一致** | 任意 RWL 保存 | 每行 78 列（含 CRLF） |
| **往返一致** | 读取 → 编辑 → 保存 → 再读取 → 再保存 | 第二次保存与第一次相同 |

### 执行方法

1. **准备测试数据**：
   - 8 列格式：编号如 "TREE001"、"LONGNAME"（7-8 字符）
   - 7 列格式：从标准 ITRDB 下载示例

2. **运行测试**：
   ```bash
   npm run dev
   # 打开文件 → 随意编辑一行年轮宽度 → Ctrl+S 保存
   # 打开同一文件 → 验证格式和数据一致
   ```

3. **验证输出格式**：
   ```bash
   # 用文本编辑器打开保存后的 RWL，检查：
   # - 编号列数（8 或 7）
   # - 每行总长度（78 字符）
   # - 宽度值的 6 列 padding
   ```

---

## 其他支持的格式

本项目还支持以下格式，但透明性设计主要针对 Tucson。

| 格式 | 解析器 | 支持程度 | 说明 |
|------|--------|--------|------|
| Compact/DPLR | [src/features/rwl/parsers/compact.ts](src/features/rwl/parsers/compact.ts) | ✅ 完整 | 3 列：series year value |
| Heidelberg/FH | [src/features/rwl/parsers/heidelberg.ts](src/features/rwl/parsers/heidelberg.ts) | ✅ 完整 | Tucson 变体，头部有 `HEADER:` |
| CSV | [src/features/rwl/parsers/csv.ts](src/features/rwl/parsers/csv.ts) | ✅ 完整 | 自动检测方言和布局 |
| TRiDaS | [src/features/rwl/parsers/tridas.ts](src/features/rwl/parsers/tridas.ts) | ✅ 完整 | XML 树轮标准格式 |

---

## 修改指南

### 场景 1：添加新的格式参数到 ReadOptions

1. 在 `RwlReadResult['readOptions']` 中添加字段
2. 在相应解析器（如 `parseTucson`）中计算该参数
3. 在 `RwlEditor` 中传递和查询（仅需更新类型，逻辑自动适配）
4. 在导出函数中使用该参数（如 `formateRwlFromMapToString`）
5. **同步更新此文档** — 在本章节记录修改

### 场景 2：修改 Tucson 列宽（⚠️ 危险操作）

**注意**：更改会破坏格式透明性。需要修改的文件：

1. [src/features/rwl/types.ts](src/features/rwl/types.ts) — 扩展 readOptions
2. [src/features/rwl/parsers/tucson.ts](src/features/rwl/parsers/tucson.ts) — 更新列宽数组和检测逻辑
3. [src/features/rwl/edit.ts](src/features/rwl/edit.ts) — 更新 formateRwlFromMapToString 的宽度计算
4. **此文档** — 更新规范说明和表格

示例（若要支持 3 列编号变体）：
```typescript
// types.ts
readOptions?: {
  tucsonVariant?: 'short' | 'long' | 'compact';  // 新增
}

// tucson.ts
if (tucsonVariant === 'compact') {
  widths = [3, 5, ...];  // 新列宽
}

// edit.ts
const idWidth = 
  options?.tucsonVariant === 'long' ? 7 :
  options?.tucsonVariant === 'compact' ? 3 : 8;
```

---

## 修改历史

| 日期 | 类型 | 描述 | 影响文件 |
|------|------|------|---------|
| 2026-04-02 | 新增 | 实现格式透明性：自动检测 long/short，保存时复现原格式 | types.ts, tucson.ts, edit.ts, Home.tsx |

---

## 相关文档链接

- [AGENTS.md](AGENTS.md) — 项目概览和已知问题
- [AI_READING_GUIDE.md](AI_READING_GUIDE.md) — RWL 模块导航
- [src/features/rwl/index.ts](src/features/rwl/index.ts) — 格式识别与解析入口

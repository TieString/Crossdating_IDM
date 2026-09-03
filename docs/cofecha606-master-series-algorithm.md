# COFECHA 6.06 Master Series 计算方法与完全一致性验证

日期：2026-08-29
实现分支：`experiment`
当前验证提交：`7adc66ce`
核心实现提交：`04bfb415`

## 1. 结论与“完全一致”的定义

当前纯 TypeScript/JavaScript 实现 `buildCofecha606MasterSeries` 已经能够复现 COFECHA 6.06P 保存的 Master Series。

本文所称“完全一致”是指 COFECHA 对外保存、用户实际能够读取的 MAS 内容全部一致：

1. 年份集合完全一致；
2. 每年 Part 3 sample depth 完全一致；
3. 每年 Master 值按 COFECHA MAS 的四位小数保存精度完全一致；
4. MAS 每一行的年份、符号、四位小数和负零规范化完全一致；
5. 对换行符进行平台归一化后，完整 MAS 文本一致。

这不是“相关系数接近 1”意义上的近似。验收脚本要求每个年份逐项相等；任意一个年份、深度或四位小数不一致，整个文件即判定失败。

COFECHA 内部未保存的扩展精度临时变量不属于可观察的 MAS 契约。JS 内部浮点值允许与旧 x87 临时值存在小于半个末位小数的差异，但最终保存的四位小数必须与 COFECHA 完全相同。

## 2. 实现入口

主要代码：

- `src/features/crossdating/reference.ts`
  - `splitCofecha606SeriesSegments`
  - `solveCofecha606SplineTrend`
  - `cofecha606DivideSeries`
  - `cofecha606StabilizeFilteredSeries`
  - `cofecha606LogTransform`
  - `cofecha606StandardizeValues`
  - `cofecha606AutoregressiveResidual`
  - `buildCofecha606MasterSeries`
  - `formatCofecha606MasterSeries`
- `src/features/crossdating/cofecha606F63.ts`
  - Microsoft FORTRAN `F6.2` / `F6.3` 到 `REAL*4` 的兼容转换
- `scripts/validate-cofecha606-master-parity.mjs`
  - 跨文件逐年验收

API：

```ts
const master = buildCofecha606MasterSeries(siteData, options);

master.data;        // Map<year, unrounded JS master value>
master.sampleDepth; // Map<year, COFECHA Part 3 No>

const masText = formatCofecha606MasterSeries(master);
```

该实现运行时不调用 COFECHA、不调用 Python，也不需要 COFECHA 可执行文件。COFECHA 仅在开发验证阶段用于生成金标准。

## 3. 总体流程

```text
RWL 原始整数测量值
  -> 按记录段识别 F6.2 / F6.3 精度
  -> Microsoft FORTRAN REAL*4 兼容转换
  -> 每个连续样芯段独立处理
  -> 32 年、50% response Cook-Holmes spline
  -> DIVSER 去趋势
  -> 二次 variance stabilization
  -> 可选 COFECHA log transform
  -> 每芯 population z-score
  -> 按日历年累计
  -> 非正原始值从年度均值排除，但保留在 sample depth
  -> 无有效值的全站缺轮年写入年度原始均值 0
  -> 选择最长连续 Master 区间
  -> 年度 Master population z-score
  -> COFECHA MAS 四位小数格式化
```

所有标记为 `REAL*4` 的边界均使用 `Math.fround` 复现单精度存储。

## 4. RWL 记录段与精度

### 4.1 连续记录段

同一序列名可以在一个 RWL 文件中出现多个记录段，例如：

```text
trg211 ...
trg211 1700 ... -9999
trg211 1810 ...
```

COFECHA 将这些段视为独立的 dated series，分别去趋势和标准化。不能先合并为一条跨空洞序列再滤波。

`splitCofecha606SeriesSegments` 按以下条件切段：

- 日历年不连续；
- 遇到 `null`；
- 遇到 `999` 或 `-9999` 终止符；
- 同一 ID 在终止符后重新出现。

每段拥有独立的：

- `seriesId`；
- `segmentIndex`；
- `stopMarkerValue`；
- 连续年份和值 Map。

### 4.2 每段独立精度

不能只在文件级判断精度。实际 ITRDB 文件可能混用：

- `999` 终止：测量整数按 `F6.2`，单位为 `0.01 mm`；
- `-9999` 终止：测量整数按 `F6.3`，单位为 `0.001 mm`。

例如 `ut529.rwl` 在同一文件内同时存在两类终止符。实现按段识别，不能用文件中是否出现 `-9999` 作为全局精度。

### 4.3 Microsoft FORTRAN F6.2 / F6.3 舍入

旧 Microsoft FORTRAN 格式化输入并不总等于：

```ts
Math.fround(integer / 1000)
```

部分值会相差一个 float32 ULP。为复现旧读取器，开发时构造了完整整数网格：

- F6.2：`0..998`；
- F6.3：`0..9998`，排除终止语义冲突值。

对每个整数记录旧 COFECHA 读取后的 float32 与正确舍入结果的 ULP 差。差值仅为 `-1 / 0 / +1 ULP`，压缩为两张 1-bit 位图。运行时步骤为：

1. 计算普通 float32 基准；
2. 查询负向/正向 ULP 位图；
3. 对 float32 位型加减 1；
4. 负测量值按正值转换后恢复符号。

这套表属于数值解析语义，不包含文件名、序列名或年份特例。

## 5. Cook-Holmes cubic smoothing spline

默认参数：

- stiffness / wavelength：`32` 年；
- frequency response：`0.5`。

### 5.1 惩罚系数

令：

```text
v = stiffness
r = frequency response
c = cos(2*pi/v)
```

则：

```text
p = ((1/(1-r) - 1) * 6 * (c - 1)^2) / (c + 2)
```

COFECHA 6.06P 默认 `32 / 0.5` 的实际 double 位型对应：

```text
p = 0.00074317083812062144
```

使用该值避免 JavaScript `Math.cos` 与旧 x87 数学库在最低位产生差异。

### 5.2 带状方程

对长度为 `n` 的输入 `y`，内部未知量长度为 `n - 2`。

系数：

```text
C1 = [1, -4, 6]
C2 = [0, 1/3, 4/3]
```

主对角及两个次对角按：

```text
A(i,j) = C1(j) + p*C2(j)
```

右侧二阶差分：

```text
b(i) = y(i) - 2*y(i+1) + y(i+2)
```

边界带元素按原 COFECHA 例程置零。

### 5.3 LUDAPB / LUELPB

实现没有改用通用矩阵库，而是保留 COFECHA 的带状布局、循环顺序和：

- `LUDAPB` 分解；
- `LUELPB` 前代/回代；
- 1-based 逻辑到 JS 数组的显式映射；
- 原对角元素存储 `1/sqrt(pivot)` 的语义。

使用数学等价的普通 Cholesky 虽然相关很高，但不能稳定获得相同的四位小数。

### 5.4 趋势重建

解得带状系数后，用二阶差分转置重建 correction：

```text
correction(1) = a(1)
correction(2) = -2*a(1) + a(2)
correction(i) = a(i-2) - 2*a(i-1) + a(i)
...
trend(i) = y(i) - correction(i)
```

输出趋势在 COFECHA 的 `REAL*4` 边界写回 float32。

## 6. DIVSER 去趋势

COFECHA 并非始终执行 `raw / trend`。

### 6.1 正值分支

若：

```text
min(raw) >= 0
min(trend) > 0
```

则：

```text
index(i) = float32(raw(i) / trend(i))
```

### 6.2 residual-plus-one 分支

若原序列存在负值，或 spline trend 出现非正值：

```text
d(i) = float32(raw(i) - trend(i) + 1)
```

先计算 `d` 的均值和最小值。若 `min(d) < 0`：

```text
d(i) = float32(d(i) - min(d))
```

然后重新计算均值。最终：

```text
index(i) = float32(d(i) / mean(d))
```

这一分支对少数高动态序列是必要的。若机械使用 ratio，会造成整条样芯 Master-core 发散。

## 7. 二次 variance stabilization

第一次 DIVSER 后，COFECHA 还会执行第二次 spline 稳定化。

设第一次去趋势结果为 `x`。

### 7.1 原尺度统计

按 float32 累加计算 population 统计：

```text
mu = mean(x)
sd = sqrt(sum((x-mu)^2) / n)
z(i) = float32((x(i)-mu)/sd)
```

所有求和、平方和、均值和标准差都遵守旧 `REAL*4` 存储边界。

### 7.2 绝对值 spline

记录 `z(i)` 的符号，然后：

```text
q(i) = abs(z(i))
qTrend = spline(q)
qIndex = DIVSER(q, qTrend)
```

### 7.3 恢复符号和尺度

```text
signed(i) = sign(z(i)) * qIndex(i)
stabilized(i) = float32(mu + sd*signed(i))
```

这一步解释了为什么只实现一次 spline 时，相关性可以达到 0.996 以上，但仍无法逐年复制 COFECHA Master。

## 8. COFECHA log transform

log 变换发生在 variance stabilization 之后、最终每芯标准化之前。

设输入为 `x`：

```text
minimum = min(0, min(x))
shifted(i) = float32(x(i) - minimum)
```

旧 COFECHA 使用的常数不是精确 `1/6`，而是 float32：

```text
factor = 0.16670000553131104
offset = float32(factor * sum(shifted) / n)
```

若：

```text
offset < 0.00009999999747378752
```

则令 `offset = 1`。

输出：

```text
logOffset = float32(log(offset))
logged(i) = float32(log(shifted(i) + offset) - logOffset)
```

减去 `logOffset` 是加性平移，随后 z-score 会进一步消除均值，但仍必须保留旧 float32 运算顺序，才能稳定命中四位小数。

## 9. AR 与保存 Master 的关系

实现包含 COFECHA 风格 Burg AR：

- 最大阶数 10；
- 每阶计算 reflection coefficient；
- `AIC(p) = n*ln(errorVariance) + 2*(p+1)`；
- AIC 首次变差时停止，选择上一阶；
- 前 `p` 年保持 centered 值，后续年份计算 AR residual。

但对本次验证使用的 COFECHA 6.06P 可执行文件，保存的 MAS 使用 AR 之前的 chronology。证据：

```text
ARRAWCOF.MAS == PLAINCOF.MAS
FULLCOF.MAS  == LOGONCOF.MAS
```

因此：

- AR 仍用于检查、分段相关和 Part 7；
- `buildCofecha606MasterSeries` 故意不把 AR residual 写入保存 Master；
- log 开关会改变 Master，AR 开关不会改变已保存 MAS。

这一区分必须保留，否则单芯 AR 看似正确，最终 Master 却会严重偏离。

## 10. 每芯最终标准化

variance stabilization 和可选 log 后，每个连续段独立执行 population z-score：

```text
coreMean = float32(sum(x)/n)
coreVariance = abs((sum(x^2)-n*coreMean^2)/n)
coreSd = float32(sqrt(coreVariance))
coreZ(i) = float32((x(i)-coreMean)/coreSd)
```

不能使用 sample SD，也不能把同名但断开的多个段合并后再标准化。

## 11. 年度聚合

### 11.1 sample depth

COFECHA Part 3 的 `No` 是该年份被多少连续样芯段覆盖。

depth 包含：

- 正测量值；
- 显式 0 absent ring；
- 被保留参与滤波的负缺测码。

因此 sample depth 与年度平均值的实际分母不是同一个计数。

### 11.2 Master 平均值分母

默认 `Absent rings omitted = Y` 时：

- 原始值 `> 0`：其 `coreZ` 进入年度平均；
- 原始值 `== 0`：不进入平均，但 depth 加 1；
- 原始值 `< 0`：参与该芯滤波，但不进入年度平均，depth 加 1。

按文件/段顺序使用 float32 accumulator：

```text
sum(year) = float32(sum(year) + coreZ(year))
rawMaster(year) = float32(sum(year) / validCount(year))
```

### 11.3 全站共同缺轮年

若某年有样芯覆盖，但所有原始值都为非正值：

```text
rawMaster(year) = 0
```

该年份不能从 Master 年份域删除。最终 z-score 后，它会显示为一个相同的非零标准化值。

## 12. 保存的连续年份区间

COFECHA MAS 不一定保存文件中所有分散的年份区间。

实现先从所有有样芯覆盖的年份形成连续区段，然后选择：

1. 年数最长的连续区段；
2. 若长度相同，选择较新的区段。

例如一个早期孤立样芯与主要站点 chronology 之间存在空洞时，早期孤立区段不进入 MAS，但仍可在 COFECHA Part 1 的完整 Master time span 中出现。

## 13. Master 最终标准化

对选中的连续年度 `rawMaster` 执行 population z-score：

```text
masterMean = float32(sum(rawMaster)/N)
masterVariance = abs((sum(rawMaster^2)-N*masterMean^2)/N)
masterSd = float32(sqrt(masterVariance))
master(year) = float32((rawMaster(year)-masterMean)/masterSd)
```

年份顺序严格为升序。

## 14. MAS 文本格式

每行：

```text
I6 + F10.4
```

示例：

```text
  1613     .3306
  1614    -.1344
```

规则：

- 年份宽度 6；
- 值宽度 10、四位小数；
- 小于 1 的数省略小数点前的 0；
- 四位舍入得到 `-0.0000` 时规范为 `.0000`；
- Windows/Unix 换行差异在验证时归一化。

## 15. 特殊输入语义

当前实现已经统一处理：

| 情况 | 处理 |
| --- | --- |
| `999` 文件 | 每段 F6.2 |
| `-9999` 文件 | 每段 F6.3 |
| 同文件混合两种终止符 | 每段独立识别 |
| 同一 ID 多个断续段 | 每段独立滤波和标准化 |
| 显式 0 | 保留滤波位置、从 Master 均值排除、计入 depth |
| 负测量/缺测码 | 保留滤波位置、从 Master 均值排除、计入 depth |
| spline trend 非正 | 第一或第二 DIVSER 使用 residual 分支 |
| 全站共同缺轮年 | raw Master 写 0，不删年 |
| 早期孤立时间段 | 最终 MAS 选择最长连续区段 |
| 数字序列名 | JS 支持；旧 COFECHA 可能不生成 MAS |

## 16. 验证协议

### 16.1 每文件验收条件

```text
expectedYears == actualYears
overlapYears == expectedYears
exactFourDecimals == expectedYears
formattedTextExact == true
expectedDepthYears == actualDepthYears
depthMismatches.length == 0
```

### 16.2 本次全新复核

本次请求后重新运行，没有只读取旧结果。

结果目录：

```text
D:\软件测试\cofecha-js-parity-probe\exact-master-34-files-reverification-2026-08-29
```

结果：

| 指标 | 结果 |
| --- | ---: |
| 文件 | 34/34 |
| 年份集合 | 30,692/30,692 |
| 四位小数值 | 30,692/30,692 |
| sample depth mismatch | 0 |
| MAS 文本一致 | 34/34 |

34 文件：

```text
az086, ca612, ca646, ca660, co021, co583, co589, co593,
co604, co605, co612, co616, co617, co624, co629, co631,
co632, co647, co649, co650, co651, co658, co699, mt001,
nm025, nm026, nm560, nm565, nm572, nm580, or093, paki033,
ut529, ut530
```

### 16.3 独立冻结留出复核

实现完成后，使用预先存在的 `finalHoldout` 文件列表，不根据结果修改算法。

结果目录：

```text
D:\软件测试\cofecha-js-parity-probe\exact-master-independent-reverification-2026-08-29
```

结果：

| 指标 | 结果 |
| --- | ---: |
| 预冻结文件 | 17 |
| COFECHA 可生成 MAS | 14 |
| 可评估文件通过 | 14/14 |
| 年份集合 | 5,945/5,945 |
| 四位小数值 | 5,945/5,945 |
| sample depth mismatch | 0 |
| MAS 文本一致 | 14/14 |

`russ027x`、`russ094x`、`russ170w` 使用纯数字序列 ID。旧 COFECHA 只生成报告标题而没有输出 MAS，因此记为不可评估，不记为 JS mismatch。

### 16.4 测试与构建

本次重新运行：

```text
cofecha606Master.test.ts                 3/3
cofecha606F63.test.ts                    2/2
referenceLtrrSpline.test.ts              3/3
tucsonNegativeMeasurements.test.ts       2/2
合计                                    10/10
npm run build                            passed
```

构建仅有既有 Vite chunk-size / mixed import 警告，没有 TypeScript 或打包错误。

## 17. 可复现命令

34 文件复核：

```powershell
node scripts/validate-cofecha606-master-parity.mjs -- `
  --measurements-root "D:\软件测试\数据\ITRDB\itrdb_download\measurements" `
  --cofecha-exe "D:\软件测试\cofecha-x86_64-pc-windows-msvc.exe" `
  --output-dir "D:\软件测试\cofecha-js-parity-probe\exact-master-34-files-reverification-2026-08-29" `
  --ids "az086,ca612,ca646,ca660,co021,co583,co589,co593,co604,co605,co612,co616,co617,co624,co629,co631,co632,co647,co649,co650,co651,co658,co699,mt001,nm025,nm026,nm560,nm565,nm572,nm580,or093,paki033,ut529,ut530"
```

单元测试：

```powershell
npx vitest run `
  src/features/crossdating/__tests__/cofecha606Master.test.ts `
  src/features/crossdating/__tests__/cofecha606F63.test.ts `
  src/features/crossdating/__tests__/referenceLtrrSpline.test.ts `
  src/features/rwl/__tests__/tucsonNegativeMeasurements.test.ts
```

## 18. 当前使用状态

该实现已经具备完全替代 COFECHA **Master Series 计算**的数值能力，但当前仍作为 shadow API：

- 不自动替换生产诊断参考；
- 不改变现有 COFECHA 报告显示；
- 可在后台同时计算 JS Master，与外部 COFECHA Master 做持续一致性审计。

完整 COFECHA Part 1–7 报告复刻是后续独立工作，不应与本文已经完成的 Master Series 一致性混为一谈。

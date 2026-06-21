按 COFECHA 的参考序列生成方法，核心是：

```text
每条样芯先单独转换成高频 residual index
然后按年份做算术平均
得到 master dating series / reference chronology
```

COFECHA 不是直接平均原始宽度，也不是简单 z-score 平均。它的 master dating series 来自已经转换后的序列。手册明确写到：每条序列先经过 spline fitting、autoregressive modeling、log transformation 等转换，转换后的值逐年加入 accumulated series，同时记录该年样芯数，最后 accumulated series 除以 counter，得到所有转换后已定年序列的算术平均函数。

## COFECHA 参考序列生成方法

### 0. 输入序列集合

在标准 COFECHA 中，输入的是 dated measurement series。

在你的程序中，输入改为：

```text
anchor_pass = COFECHA PART 6 中没有 A flag 的样芯
```

也就是只用无 A 样芯生成参考序列。

---

## 1. 对每条样芯单独去趋势

对每条样芯 (i)，原始宽度序列为：

[
w_i(t)
]

COFECHA 默认使用 **32 年 spline rigidity**，并且在 32 年波长处保留 50% 频率响应。手册说明，默认 32 年 spline 通常最适合发现交叉定年错误；过短 spline 会去掉过多共同环境信号，过长 spline 会保留过多低频趋势。

拟合得到趋势曲线：

[
\hat{w}_i(t)
]

然后计算无量纲指数：

[
r_i(t)=\frac{w_i(t)}{\hat{w}_i(t)}
]

手册对应说法是：某年的实际年轮宽度除以该年 spline 预测值，得到 dimensionless annual index。

---

## 2. AR 预白化

对去趋势后的指数序列 (r_i(t)) 做 autoregressive modeling，去掉残留的自相关。

COFECHA 默认启用 AR modeling。手册解释，树轮序列高度自相关，前一年生长会影响后一年，气候因子本身也具有持续性；AR modeling 用于去除 spline 去趋势后仍残留的 persistence，以强化交叉定年需要的年际高频变化。

得到 AR residual：

[
e_i(t)
]

这一步的目标是让序列更接近：

```text
共同高频信号 + 随机误差
```

而不是保留长期趋势或连续多年缓慢变化。

---

## 3. log transformation

COFECHA 默认还会对转换后的序列做 logarithm transformation，除非用户关闭。手册说明，log transformation 的目的，是让年轮测量中的比例差异得到更均衡的权重；为避免局部缺失环导致 (\log(0))，会先加入一个常数，该常数为序列均值的 (1/6)。

可写成：

[
x_i(t)=\log(e_i(t)+c_i)
]

其中：

[
c_i=\frac{1}{6}\bar{e_i}
]

实现时要注意：如果你的 AR residual 有负值，不能直接套这个公式。严格复现 COFECHA 时，应以 COFECHA 原始 Fortran 的处理顺序为准。工程实现中更稳的方式是保留一个 `cofechaTransform()` 模块，后续直接移植或对齐 COFECHA 的 Fortran 行为。

---

## 4. first difference 是可选项，不是默认必须项

COFECHA 还有 first differencing 选项：

[
d_i(t)=x_i(t)-x_i(t-1)
]

但它是用户可选项，不是默认参考序列生成的必选步骤。手册说明 first differencing 用于进一步减少低频方差变化，但会引入额外自相关风险。

你的第一版不要默认启用 first difference。

---

## 5. 按年份累加转换后的序列

对每一年 (t)，收集所有 anchor_pass 样芯的转换值：

[
X_t={x_i(t)\mid i\in anchor_pass,\ x_i(t)\ exists}
]

COFECHA 的做法是维护两个序列：

```text
accumulator[t] = 该年份所有转换值之和
counter[t] = 该年份参与计算的序列数
```

即：

[
A(t)=\sum_{i=1}^{n_t}x_i(t)
]

[
N(t)=n_t
]

---

## 6. 逐年算术平均得到 master dating series

参考序列值为：

[
M(t)=\frac{A(t)}{N(t)}
]

也就是：

[
M(t)=\frac{1}{n_t}\sum_{i=1}^{n_t}x_i(t)
]

COFECHA 手册明确说，所有序列转换后，accumulated series 除以 counter series，得到基于所有 transformed dated series 的 arithmetic mean value function。

所以 COFECHA 的 master dating series 是：

```text
转换后序列的逐年算术平均
```

不是：

```text
原始宽度平均
```

也不是：

```text
robust biweight mean
```

---

## 7. 最终 master 标准化为 mean = 0, sd = 1

COFECHA Part 3 输出的 master dating series 是 residual time series，并且已经标准化为：

[
\mu=0
]

[
\sigma=1
]

手册说明，Part 3 中的 master dating series 是用于相关分析的 residual time series，标准化为均值 0、标准差 1；负值表示窄轮，正值表示宽轮，(-2) 或 (+2) 附近代表强 marker rings。

因此最终输出：

[
R(t)=\frac{M(t)-\bar{M}}{sd(M)}
]

这就是 COFECHA 风格的参考序列。

---

## 8. 样本深度同时保存

每一年还要保存：

[
N(t)
]

即 sample depth / replication。

COFECHA Part 3 会在 master value 右侧列出该年份参与计算的序列数。

你的程序应保存：

```ts
type CofechaReferencePoint = {
  year: number;
  value: number;        // R(t)
  replication: number;  // N(t)
};
```

可以额外保存：

```ts
sd: number;
se: number;
weight: number;
```

这些是你后续贝叶斯或图形显示需要的扩展信息，不是 COFECHA 输出的核心必需项。

---

## 9. 缺失环 / 0 值处理

COFECHA 默认不把 absent rings 纳入 master dating series 的计算，因为 absent ring 的放置本身有主观性；如果用户确信缺失环位置正确，可以选择把 missing rings 纳入 master 计算。

因此第一版建议遵循默认：

```text
0 值 absent ring 不参与 reference 平均
```

即：

```text
if width == 0:
    omit from accumulator
```

不要把 0 当成真实宽度直接参与 spline 和平均。

---

# 完整流程伪代码

```text
input:
    anchor_pass series from rwl

for each series i in anchor_pass:
    1. read raw widths w_i(t)
    2. omit absent rings by default
    3. fit 32-year cubic smoothing spline:
           fitted_i(t)
    4. compute dimensionless index:
           r_i(t) = w_i(t) / fitted_i(t)
    5. apply autoregressive modeling:
           e_i(t) = AR residual of r_i(t)
    6. apply log transformation if COFECHA default option is enabled:
           x_i(t) = log(transformed value + constant)
    7. optional first difference only if user selected it
    8. store transformed series x_i(t)

for each year t:
    vals = all x_i(t) available in anchor_pass
    if vals is not empty:
        master_raw(t) = mean(vals)
        replication(t) = vals.length

standardize master_raw:
    R(t) = (master_raw(t) - mean(master_raw)) / sd(master_raw)

output:
    COFECHA-pass reference chronology:
        year
        R(t)
        replication(t)
```

---

# 公式版

对每条样芯：

[
r_i(t)=\frac{w_i(t)}{\hat{w}_i(t)}
]

其中 (\hat{w}_i(t)) 来自 32 年 cubic smoothing spline。

AR 预白化后：

[
x_i(t)=ARResidual(r_i(t))
]

逐年平均：

[
M(t)=\frac{1}{N(t)}\sum_{i=1}^{N(t)}x_i(t)
]

最终标准化：

[
R(t)=\frac{M(t)-\bar{M}}{sd(M)}
]

得到：

```text
R(t) = COFECHA-style master dating series / reference chronology
```

---

# 你的程序中应采用的版本

你的功能可以定义为：

```text
每次 COFECHA 运行后，系统读取 PART 6 的 A flag 判断结果，将无 A 样芯作为 anchor_pass 参考锚定组。系统仅使用 anchor_pass 样芯，按照 COFECHA 的 master dating series 构建方法生成参考序列：对每条样芯进行 32 年 spline 去趋势、AR 预白化和默认 log transformation，得到 residual index 后按年份算术平均，并将最终 master 标准化为均值 0、标准差 1，同时保存每年的 replication。该参考序列用于后续有 A 样芯的整体 offset 检查。
```

数据结构：

```ts
type CofechaPassReference = {
  source: "cofecha_pass_anchor";
  includedSeriesIds: string[];
  years: number[];
  values: number[];        // mean 0, sd 1 residual master
  replication: number[];   // sample depth
};
```

核心函数：

```ts
function buildCofechaPassReference(
  anchorPassSeries: RingSeries[],
  options: {
    splineRigidityYears: 32;
    splineFrequencyResponse: 0.5;
    useAutoregressiveModel: true;
    useLogTransform: true;
    useFirstDifference: false;
    omitAbsentRingsFromMaster: true;
  }
): CofechaPassReference
```

## 当前代码实现（2026-06）

实现位置：`src/features/crossdating/reference.ts`。

当前版本已经按 COFECHA master dating series 的默认转换链路实现，不再使用移动平均近似趋势：

1. `classifyCofechaPart6Series()` 接收 RWL 中的全部序列 ID 和 PART 6 中带 `[A] Segment` 的序列 ID，生成：
   - `anchorPassIds = allSeriesIds - flaggedAIds`
   - `candidateFlaggedIds = flaggedAIds`
2. `cofechaStyleStandardize()` 对每条 `anchor_pass` 样芯单独转换：
   - 过滤 stop marker，并默认让 `0` absent ring 不参与 master。
   - 用离散二阶差分 roughness penalty 求解 cubic smoothing spline trend。
   - 根据 `splineRigidityYears=32` 和 `splineFrequencyResponse=0.5` 换算 spline 惩罚强度，使 32 年波长保留 50% 响应。
   - 计算 `rawWidth / fittedTrend`，得到 dimensionless index。
   - 使用 Yule-Walker 方程拟合 AR(p)，并在 1..5 阶中用 AIC 选阶，生成预白化 residual index。
   - 默认执行 log transform，常数为转换序列均值的 `1/6`；若 AR residual 局部为非正，则只加最小必要 shift 来保证 `log()` 有定义。
   - `useFirstDifference` 保留为可选项，默认 `false`。
3. `buildCofechaPassReference()` 对转换后的 anchor 样芯做 COFECHA accumulator/counter：
   - 每年收集所有可用转换值。
   - `replication >= minReplication` 的年份进入 reference。
   - 逐年算术平均得到 raw master。
   - 最终把 raw master 标准化为 `mean=0`、`sd=1` 的 residual chronology。
   - 每个点保存 `year`、标准化后的 `value`、`replication`、同尺度下的 `sd`、`se` 和 `weight`。
4. `getOffsetCheckTargetSet()` 只返回 `candidateFlaggedIds`，确保 `anchor_pass` 不进入后续整体 offset 检查。
5. `hashRwlSiteData()` 与 `cofechaRunId` 一起用于 stale 判断：RWL 编辑后动态 reference 标记为过期，直到重新运行 COFECHA。

验证入口：

```bash
npm run validate:cofecha-reference
```

该验证覆盖 PART 6 A flag 分类、anchor/candidate 集合、COFECHA-pass reference 生成、最终 master `mean=0/sd=1`，以及 offset target set 只包含 `candidate_flagged`。

关键约束：

```text
不能直接平均 raw width
不能只做简单 z-score 就声称“完全按照 COFECHA”
不能用有 A 样芯参与 reference
不能把 absent ring 默认当成普通 0 宽度参与 master
最终 master 要标准化到 mean = 0, sd = 1
```

当前实现对齐 COFECHA 的公开算法流程和默认参数，但仍不是 bit-level identical 的 Fortran 复刻：spline 使用离散二阶差分 smoothing spline，AR 模型使用 Yule-Walker + AIC 选阶，log transform 对非正 residual 做最小必要 shift。若未来需要与 COFECHA 输出逐点一致，应继续移植或对照 Holmes/COFECHA Fortran 的具体数值细节。

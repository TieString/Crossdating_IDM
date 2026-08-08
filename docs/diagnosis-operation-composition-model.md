# JS 定年操作组合模型与验证日志

日期：2026-08-08  
工作树：`D:\Code\Crossdating_Tauri_js-diagnosis-events-v1`  
状态：Round 5J，已完成当前组合覆盖审计；下一轮从 B6 两个缺轮的同向阶梯开始

## 目的

本文档定义 JS 事件级诊断如何区分缺轮、伪轮、局部移动和整体移动，以及这些
操作共存时应出现的 lag 状态路径、输出顺序、可辨识边界和验收指标。后续每一轮
只处理一种组合，必须在本文追加案例、修改、回归影响和提交号。

这项工作的目标不是让每个案例都强制得到一个类型，而是：

1. 可辨识案例输出正确的主操作、位移和唯一窗口。
2. 整体移动与局部事件共存时，内部联合推断，向用户优先输出整体移动。
3. 应用整体移动并重新诊断后，仍能恢复原来的局部事件。
4. 统计上不可辨识的组合明确拒答，不用错误类型换取响应率。
5. 在 co612 上逐类开发后，必须用其它 RWL 文件验证泛化。

## 统一状态语义

### 变量

- `g`：整条样芯相对参考序列需要应用的整体位移，单位为年。`g=0` 表示没有
  整体移动。
- `b`：局部事件的 `firstFixedYear`。`b` 年及以后保持在当前局部状态，`b-1`
  及以前包含该事件产生的累积偏移。
- `c`：局部事件施加到较老侧的 correction lag。
- `L(y)`：年份 `y` 处相对参考序列的正确 correction lag。

若局部事件按日历从老到新排列为 `e1...en`，事件 correction 分别为 `c1...cn`，
则：

```text
L(y) = g + sum(ci), for every event ei whose firstFixedYear is newer than y
```

从较老端向较新端跨过一个事件时，该事件的 `ci` 从累积和中移除。整体移动 `g`
是所有局部事件之后的较新端终态，不是全序列出现次数最多的 lag。

### 单事件映射

| 操作 | correction `c` | 老侧状态 | 新侧状态 | 老到新的状态变化 | 自动编辑 |
| --- | ---: | ---: | ---: | ---: | --- |
| 无事件 | 0 | `g` | `g` | 0 | 无 |
| 缺轮 `missingRing` | -1 | `g-1` | `g` | +1 | 插入一年 |
| 伪轮 `falseRing` | +1 | `g+1` | `g` | -1 | 删除一年 |
| 局部移动 `partialMove -q` | `-q`, `q>=2` | `g-q` | `g` | `+q` | 只移动较老侧 |
| 整体移动 `wholeSeriesMove` | 不适用 | `g` | `g` | 0 | 移动整条序列 `g` 年 |

`partialMove -1` 不存在，始终由 `missingRing` 表达。自动 `partialMove` 不允许正向
位移。多个整体移动在观测上只能识别为净位移 `g`，不能分解成多次历史编辑。

## 为什么整体移动会被局部事件拖偏

朴素的整序列相关会倾向占据年份最多的状态，而不一定是终态 `g`：

| 局部事件位置 | 最长区段 | 朴素整体 lag 容易偏向 |
| --- | --- | --- |
| 缺轮靠近较新端 | 老侧很长 | `g-1`，比真实整体位移更老 1 年 |
| 伪轮靠近较新端 | 老侧很长 | `g+1`，比真实整体位移更新 1 年 |
| `partialMove -q` 靠近较新端 | 老侧很长 | `g-q`，可能被误报为大整体移动 |
| 任一局部事件靠近较老端 | 新侧很长 | 通常仍为 `g` |

因此不能先用一次全局最大相关独立确定 `g`，再在残差里找局部事件。正确顺序是：

1. 内部同时比较 `g` 和局部状态转移路径。
2. 用较新端终态、多参考芯一致性和分段持续性确定 `g`。
3. 判断每个转移相对 `g` 的方向和幅度。
4. 若 `g!=0`，UI 首先只显示整体移动。
5. 用户应用整体移动后重新运行 COFECHA 和诊断，再显示局部事件。

这里的“整体移动优先”是输出和应用顺序，不是一个会被局部事件拖偏的贪心估计器。

## 必须覆盖的情况

### A. 单一类型

| ID | 真值 | 状态路径（老到新） | 预期首个主操作 |
| --- | --- | --- | --- |
| A0 | 干净 | `0` | 拒答 |
| A1 | 单缺轮 | `-1 -> 0` | missingRing |
| A2 | 单伪轮 | `+1 -> 0` | falseRing |
| A3 | 单局部缺块 | `-q -> 0` | partialMove `-q` |
| A4 | 单整体移动 | `g` | wholeSeriesMove `g` |
| A5 | 多个分离缺轮 | `-n -> ... -> -1 -> 0` | 最新侧 missingRing |
| A6 | 多个分离伪轮 | `+n -> ... -> +1 -> 0` | 最新侧 falseRing |
| A7 | 多个局部缺块 | 累积负 lag 的多级路径 | 最新可辨识 partialMove |

### B. 两类或同类重复

局部事件 `e1` 比 `e2` 更老时，完整路径为
`g+c1+c2 -> g+c2 -> g`。必须测试两种日历顺序，因为中间状态不同。

| ID | 组合 | 典型状态路径（老到新） | 关键风险 |
| --- | --- | --- | --- |
| B1 | whole + missing | `g-1 -> g` | missing 把整体 lag 拖成 `g-1` |
| B2 | whole + false | `g+1 -> g` | false 把整体 lag 拖成 `g+1` |
| B3 | whole + partial | `g-q -> g` | 整体与大局部移动互相冒充 |
| B4 | missing 后接 false | `g -> g+1 -> g` | 两端抵消，只剩正向短脉冲 |
| B5 | false 后接 missing | `g -> g-1 -> g` | 两端抵消，只剩负向短脉冲 |
| B6 | missing + missing | `g-2 -> g-1 -> g` | 相邻时与 partialMove -2 混淆 |
| B7 | false + false | `g+2 -> g+1 -> g` | 不得压成自动正向 partialMove |
| B8 | missing + partial | `g-q-1 -> g-q -> g` 或 `g-q-1 -> g-1 -> g` | 单缺轮被大缺块吞并 |
| B9 | false + partial | `g-q+1 -> g-q -> g` 或 `g-q+1 -> g+1 -> g` | 伪轮方向被局部负移覆盖 |
| B10 | partial + partial | `g-q1-q2 -> g-q2 -> g` | 位移量相加或断点合并 |

每个 B1-B3 场景还必须交换局部事件位于较老端、中部和较新端，专门测量整体位移
是否被最长局部状态拖偏。B4-B10 必须交换事件顺序。

### C. 三类共存

| ID | 组合 | 必测内容 |
| --- | --- | --- |
| C1 | whole + missing + false | 两个单位事件顺序、抵消区段、整体 `g` 是否保持 |
| C2 | whole + missing + partial | 整体优先，应用后缺轮与局部缺块均可继续发现 |
| C3 | whole + false + partial | 整体优先，伪轮不被 partial 或 missing 改写 |
| C4 | missing + false + partial | 三个局部事件的 6 种日历顺序 |
| C5 | whole + 两个同向单位事件 | 整体与累积 `+/-2` 的区分 |
| C6 | whole + 两个局部缺块 | 整体终态和两个负向阶跃的区分 |

### D. 四类共存

| ID | 组合 | 必测内容 |
| --- | --- | --- |
| D1 | whole + missing + false + partial | 三个局部事件的 6 种顺序 |
| D2 | D1 + 重复缺轮 | 累积 lag 不得被压成一个大 partialMove |
| D3 | D1 + 重复伪轮 | 正向阶梯不得变成自动正向 partialMove |
| D4 | D1 + 两个 partialMove | 整体终态、单位脉冲和多个负向阶跃均需保留 |

## 可辨识边界

以下情况不能仅靠“扩大窗口”解决：

1. 两个缺轮相邻且中间没有可用观测时，`-2 -> 0` 与一个
   `partialMove -2` 数值上可能完全相同。
2. 缺轮和伪轮紧邻时，两端状态相同；若中间区段不足以计算可靠相关，只能看到
   一个很短的 lag 脉冲。
3. 局部事件位于最新端，导致 `g` 终态没有足够样本时，整体移动和局部移动可能
   无法分离。
4. 所有可靠参考芯具有同一整体偏移或同一年共同缺失时，绝对年份不可辨识。
5. 两个局部事件的断点过近时，只能可靠识别净位移，不能虚构两个精确事件。

这些案例应标记为 `operation-unidentifiable` 或 `absolute-unidentifiable`，单独报告，
不计入可辨识案例的操作准确率，也不得强制给出可执行建议。若仍有稳定异常区段，可
显示“需要复核”的唯一窄窗口，但不能伪装成已经确定的操作类型。

## co612 逐轮开发矩阵

### 数据隔离

- 永不修改 `D:\软件测试\co612.rwl`，运行前后校验 SHA-256。
- 注入真值只用于生成副本和离线评分，不进入 reference、COFECHA、候选或窗口。
- 注入年份由固定位置分层选择，不使用相关峰、诊断分数或已知失败年份。
- 每次模拟应用后重新生成 RWL、运行 COFECHA、构建动态参考并重新诊断。
- 错误建议永不由基准自动应用；串行测试只真值应用已经判定正确的前沿事件。

### 固定维度

| 维度 | 取值 |
| --- | --- |
| 整体位移 `g` | `-12, -5, +5, +12`，另保留 `g=0` 对照 |
| 局部位置 | 可用区间的 20%、50%、80%，另测新旧端上下文边界 |
| partialMove | `-2, -6, -20`；长序列补测 `-50` |
| 两事件间距 | 相邻、2-4 年、5-13 年、至少 14 年 |
| 事件顺序 | 所有不同局部类型的日历排列 |
| 参考状态 | fresh COFECHA 动态参考；静态参考只作消融，不作产品结论 |
| 样芯分层 | 长度、参考深度、原始自然 0 数量、基线是否已有建议 |

### 每轮顺序

1. Round 1：B2 `whole + false`，直接验证用户提出的整体移动方向偏置。
2. Round 2：B1 `whole + missing`，与 Round 1 做方向对照。
3. Round 3：B3 `whole + partial`，验证大局部移动与整体移动分解。
4. Round 4：B4-B7，单位事件抵消、重复和不可辨识边界。
5. Round 5：B8-B10，单位事件与局部移动共存。
6. Round 6：C1-C6，三类共存。
7. Round 7：D1-D4，四类共存和重复事件压力测试。

每轮完成后必须提交一次，报告目标场景修复前后、所有已完成场景回归、单事件回归、
干净误报和构建结果。若某项修改改善当前场景但破坏前一轮，该轮不得视为完成。

## 指标与验收

### 整体优先指标

- `wholeFirstResponse`：存在 `g!=0` 时是否首先输出 wholeSeriesMove。
- `wholeShiftExact`：整体位移是否精确等于 `g`，不接受 `g+1/g-1` 近似。
- `wholeToPartialConfusion`：整体真值被报为 partialMove 的比例。
- `localToWholeConfusion`：局部真值被报为 wholeSeriesMove 的比例。
- `terminalLagExact`：推断的较新端终态是否等于 `g`。

### 应用后指标

- 应用正确整体移动后，局部主操作类型和 shift 是否正确。
- 单位事件主窗口是否覆盖真年份，partialMove 主窗口是否覆盖 `firstFixedYear`。
- 串行恢复过程中事件是否被错误合并、拆分、反向或永久拒答。
- 最终 lag 状态路径是否回到 0，且干净状态不再输出建议。

### 干扰指标

- 相对同一案例的单事件对照，组合事件造成的响应率、操作准确率和窗口覆盖变化。
- 已完成各轮的回归差异必须逐场景列出，不只报告总体平均。
- co612 干净 review 误报不得高于当前 `2/55`；strict 层单独审计。
- 自动 partialMove 必须始终 `< -1`，不得产生正向 partialMove。
- 窗口仍只能为 5、7、9 或 13 年，不能靠扩窗掩盖类型或断点错误。

co612 是开发集而不是泛化证据。每一轮在 co612 达到稳定改进后，至少在一个未用于
该轮规则选择的外部 RWL 集合上运行相同场景。全部规则冻结后，再运行按完整文件隔离
的 ITRDB calibration/final 清单。已经查看过结果的 Legacy 24 文件只能作为回归集，
不能重新称为 untouched holdout。

## 过程日志

### Round 0：语义与情况清单

- 基线提交：`ecbdf8bf4f8a807d929e3db3b5638204f2b67069`
- 已知通过：ZSL 6 个纯整体移动在动态/隔离参考下均 6/6；ZSL212 应用整体 `-9`
  后能恢复局部 `-4`；ZSL141 的 `-6/-11/-16/-20/-30` 保存回归通过；MCP17A
  连续 9 年缺块保存前后通过。
- 已知不足：历史 Legacy 跨文件报告中的 wholeSeriesMove 与 composite 指标很低；该
  报告早于当前修复，只能作为风险提示，必须重新运行组合基准。
- 本轮只建立语义和测试矩阵，没有修改生产算法。

### Round 1 基线：whole + falseRing

- 基准提交：`1db7e3cd906f8bcd832fc0d7ec32512c301d6c85`
- 结果目录：
  `D:\软件测试\co612-operation-composition-results\whole-false-round1-baseline-2026-08-08`
- co612 SHA-256：
  `36e6c6a9d0cbc16d1870a1662da553a7b40d5578ea9ede25ff790c556c34667d`；
  运行前后相同。
- 目标：10 条零值为零、长度至少 180 年的样芯，按编号选择，没有读取相关或诊断
  信号。整体位移为 `-5/-1/+1/+5`，伪轮位于可用区间 20%/50%/80%。
- 唯一诊断状态 200 个，whole+false 组合 120 个；错误 0，保存重开稳定 200/200，
  正确应用整体位移后的组合状态与纯伪轮对照逐值相同 120/120。

控制组：

| 指标 | 结果 |
| --- | ---: |
| 干净 review 误报 | 1/10 |
| 纯整体位移精确 | 11/40 = 27.50% |
| 纯伪轮操作正确 | 26/30 = 86.67% |
| 纯伪轮窗口覆盖 | 25/30 = 83.33% |

组合结果：

| 指标 | 结果 |
| --- | ---: |
| 响应 | 111/120 = 92.50% |
| review 整体位移精确 | 4/120 = 3.33% |
| strict 整体位移精确 | 9/120 = 7.50% |
| 内部 final events 含精确整体位移 | 12/120 = 10.00% |
| 内部已有精确 whole、但 review 降级 | 8/120 = 6.67% |
| whole 被判成单位事件 | 104/120 = 86.67% |
| whole 被判成 partialMove | 0/120 |
| 正确先整体、再恢复伪轮 | 4/120 = 3.33% |

按整体位移分层：

| `g` | 纯 whole 精确 | 组合 whole 精确 | 组合内部含精确 whole | 主要输出 |
| ---: | ---: | ---: | ---: | --- |
| -5 | 9/10 | 0/30 | 0/30 | 27 missing、2 false、1 拒答 |
| -1 | 0/10 | 0/30 | 0/30 | 23 missing、2 false、5 拒答 |
| +1 | 0/10 | 0/30 | 7/30 | 29 false、1 missing |
| +5 | 2/10 | 4/30 | 5/30 | 20 missing、7 whole、3 拒答 |

位置效应存在但不是主损失：较新端有 3 例 whole 输出为 `g+1`，符合老侧
`g+1` 状态占多数的预期；然而三层位置的 review whole 精确率分别只有 5%、5%、0%。
最强的组合干扰发生在 `g=-5`：纯 whole 9/10 正确，但加入一个伪轮后 0/30 正确；
在纯 whole 和纯 false 均正确且伪轮窗口覆盖的 22 个可比组合中，22/22 失败。

结论：Round 1 不能只修 `g+1` 的一年龄偏差。需要分别处理：

1. `|g|=1` 的纯常量 lag 被错误解释为单位事件，没有断点也未保留 whole。
2. 精确 whole 已进入 final events 时，review 仍优先选择单位事件。
3. `g=-5` 与 falseRing 共存时，内部路径被后置 missing/false 恢复整体覆盖，精确
   whole 在进入显示层之前已经消失。
4. `g=+5` 仍有明显方向不对称，不能用只适配负向 whole 的规则解决。

本节只冻结修复前基线，没有修改生产算法。

### Round 1A：分离整体操作位移与观测 lag

- 结果目录：
  `D:\软件测试\co612-operation-composition-results\whole-false-round1-operation-semantics-clean55-2026-08-08-rerun`
- co612 源文件仍为
  `36e6c6a9d0cbc16d1870a1662da553a7b40d5578ea9ede25ff790c556c34667d`，
  运行前后相同。
- 组合目标和 120 个组合与 Round 1 基线完全相同；新增全部 55 条原始样芯作为
  clean 对照，总诊断状态从 200 增至 245。错误 0，保存重开一致 245/245，组合
  应用后与纯伪轮对照逐值相同 120/120。

本轮发现 whole 事件把两种不同量混在了 `evidence.lagBefore`：候选真正执行的
`deltaYears`，以及受局部事件影响的观测 dominant lag。中部 `whole -5 + false`
案例中，候选实际执行 `-5`，但观测 dominant lag 为 `-4`；旧基准、剪枝和状态连接
都把它错误记成 `-4`。修复后：

1. whole 事件显式保存可执行 `shiftYears`，观测 lag 继续留在 evidence；公共语义函数
   对旧事件提供兼容回退。
2. whole/partial alias、whole/unit alias、状态连通和 operation fusion 全部读取可执行
   位移，不再拿 dominant lag 代替操作。
3. 连续缺轮恢复不能用一个 missingRing 无条件覆盖独立 whole；只有 whole 是阶梯的
   旧侧状态时才允许替换，独立 whole 必须具有与局部路径相连的固定侧状态。
4. 最终同时保留独立 whole 和局部事件时，复核层先显示 whole；应用后重新诊断局部
   事件，仍只向用户显示一个当前操作。

| 指标 | Round 1 基线 | Round 1A |
| --- | ---: | ---: |
| clean review 误报 | 基线仅抽样 1/10 | **2/55** |
| 纯 whole 精确 | 11/40 (27.50%) | **13/40 (32.50%)** |
| 组合响应 | 111/120 (92.50%) | **115/120 (95.83%)** |
| review whole 精确 | 4/120 (3.33%) | **14/120 (11.67%)** |
| strict whole 精确 | 9/120 (7.50%) | **12/120 (10.00%)** |
| internal final 含精确 whole | 12/120 (10.00%) | **14/120 (11.67%)** |
| whole 被判成单位事件 | 104/120 (86.67%) | **80/120 (66.67%)** |
| review 降级已存在的精确 whole | 8/120 | **0/120** |
| 正确先 whole、再恢复 false | 4/120 (3.33%) | **11/120 (9.17%)** |

位置分层的精确 whole 从旧/中/新端 `2/40、2/40、0/40` 变为
`8/40、6/40、0/40`。因此本轮是有效的语义修复，但 Round 1 尚未完成：较新端仍有
17 例选择旧侧 `g+1` 状态，精确率仍为 0；`g=-5` 仍有 24/30 被连续缺轮恢复抢占，
`g=-1` 仍未形成可靠 whole。下一步必须联合选择终端 baseline，而不是继续提高显示
优先级。

干扰检查：

- co612 clean review：2/55；没有高于修复前最好水平。
- mon052/mtr841 多离散缺轮、真实连续缺块 `-2…-100`：10 项通过。
- ZSL141 `-6/-11/-16/-20/-30`、MCP17A 保存前后、事件应用语义：29 项通过。
- 当前 ZSL RAW/crossdated 真值回归：11 项通过。当前文件中 ZSL211、ZSL213 已完全
  对齐，不再属于 pure whole；真实 pure whole 清单为 ZSL091/092/111/112。ZSL212
  当前只含 `firstFixedYear=1870, shift=-4`，旧测试额外注入的 `-9` 已删除。
- 相关 unit/review/fusion 测试 78 项通过；`yarn build` 通过。

### Round 1B：约束连续缺轮阶梯覆盖整体基线

- 结果目录：
  `D:\软件测试\co612-operation-composition-results\whole-false-round1-staircase-depth-final-2026-08-08`
- 输入、案例和 clean 对照与 Round 1A 相同；245 个状态错误 0，保存重开一致
  245/245，组合应用后与纯伪轮对照逐值相同 120/120，源文件 SHA-256 未改变。

Round 1A 剩余的 `g=-5` 失败中，连续缺轮恢复会把一个 20 多级的弱 lag 阶梯和附近
`partialMove -5` 候选视为相互验证，从而用一个 missingRing 覆盖已经通过 hard gate 的
整体 `-5`。这两份证据的累计深度并不相容。本轮将权限拆成两层：

1. 所有局部移动候选仍可参与阶梯头部年份定位，避免 COFECHA 分段只看到累计阶梯一部分
   时丢失真实年份。
2. 局部移动候选只有在位移深度与阶梯 transition count 相差不超过 1，或至少解释 40%
   且阶梯头部稳定不少于 3 年时，才足以证明“整体/局部候选其实是离散缺轮阶梯”。
3. 因而 `partial -5` 不再证明 24 级弱阶梯；`mon052` 中位于真断点附近的 `partial -3`
   仍可支持 7 级、3 年稳定的真实离散缺轮阶梯。

| 指标 | Round 1A | Round 1B |
| --- | ---: | ---: |
| clean review 误报 | 2/55 | **2/55** |
| 纯 whole 精确 | 13/40 | **13/40** |
| 组合响应 | 115/120 | **115/120** |
| review whole 精确 | 14/120 | **24/120** |
| strict whole 精确 | 12/120 | **22/120** |
| internal final 含精确 whole | 14/120 | **24/120** |
| whole 被判成单位事件 | 80/120 | **66/120** |
| whole 被判成 partialMove | 0/120 | 4/120 |
| 正确先 whole、再恢复 false | 11/120 | **18/120** |

`g=-5` 的组合 whole 精确率由 3/30 提升到 13/30，旧端位置由 8/40 提升到
15/40；中部为 9/40，较新端仍为 0/40。新增的 4 个 partialMove 输出都集中在
`g=-5` 中部：这些案例没有生成精确 `-5` whole 候选，只生成 `-4` 全局候选，随后被
`-4 -> 0` 局部状态解释。它们与较新端的共同根因是候选层没有把局部状态路径的终端
baseline 生成为可执行 whole 候选，不能在结果层改标签解决。

回归检查：

- `eventEnsembleUnit` 与离散阶梯单元测试通过。
- co612 `mon052` 九个自然缺轮逐轮恢复、`mtr841`、分离两步缺轮和连续缺块
  `-2…-100` 共 10 项通过；真实连续缺块没有被拆成 missingRing。
- 本轮下一步只处理候选层终端 baseline；不得通过放宽 review 优先级或伪造与 candidate
  id 不一致的 whole shift 来修较新端。

### Round 1C：COFECHA 终端 lag 与联合残差恢复整体基线

- 最终结果目录：
  `D:\软件测试\co612-operation-composition-results\whole-false-round1-terminal-baseline-frozen-2026-08-08`
- 输入、目标、事件顺序和 clean 对照与 Round 1A/1B 相同。245 个唯一诊断状态错误 0，
  保存重开一致 245/245，组合应用 whole 后与对应纯伪轮状态逐值相同 120/120；源文件
  SHA-256 运行前后均为
  `36e6c6a9d0cbc16d1870a1662da553a7b40d5578ea9ede25ff790c556c34667d`。

Round 1B 仍使用出现次数最多的全区间 lag 生成 whole。加入局部单位事件后，较老侧状态
往往是 `g+1`，而真实 whole 基线 `g` 只在较新端出现，因此多数状态不是可执行整体位移。
本轮改为显式比较状态路径的终态：

1. 从 COFECHA `[A]` 分段中提取持续到样芯较新端的稳定非零 lag；局部事件的旧侧状态在
   断点处结束，不能冒充终端 baseline。终端最多允许 12 年未覆盖尾部，并记录分段数、
   一致性和未覆盖年数。
2. 对终端 lag 仍生成完整反事实 whole 候选并执行原有 hard gate，不绕过相关、问题段和
   新异常检查。仅一个终端分段时要求相关至少 0.55，并交给后续联合门槛验证。
3. 当全区间多数 lag 与终端 lag 相差恰好 `+1/-1` 时，应用 whole 后必须留下同方向的
   单位 residual lag，才能把它解释为 `whole + false/missing`。这样允许整体操作单独应用时
   暂时不改善总相关，但禁止无残差支持的弱终端峰。
4. 终端 whole 是独立基线，不再被局部单位 alias、连续阶梯投影或新端单位事件排序删除。
   UI 始终先显示并应用 whole；保存重诊断后再显示剩余局部事件，仍只有一个当前操作。

| 指标 | Round 1B | Round 1C |
| --- | ---: | ---: |
| clean review 误报 | 2/55 | **2/55** |
| 纯 whole 精确 | 13/40 | **40/40** |
| 组合响应 | 115/120 | **120/120** |
| review whole 精确 | 24/120 | **120/120** |
| strict 首事件 whole 精确 | 22/120 | **115/120** |
| internal final 含精确 whole | 24/120 | **120/120** |
| 选择旧侧伪轮状态 | 未清零 | **0/120** |
| whole 被判成单位事件 | 66/120 | **0/120** |
| whole 被判成 partialMove | 4/120 | **0/120** |
| 正确先 whole、再恢复 false | 18/120 | **100/120** |

四个整体位移 `-5/-1/+1/+5` 的 review 精确率均为 30/30；旧/中/新三个伪轮位置均为
40/40。串行第二步的 100/120 与纯伪轮控制的窗口与操作上限一致：纯伪轮自身正确
25/30，跨四个 whole 位移后即为 100/120，因此本轮没有新增组合损失。

仍有 5 个 `whole -1 + false` 案例在 strict 候选层先列 missingRing，但复核/UI 层均正确
先列 whole；它们集中在旧端和中部。该层级差异将在 whole + missing 场景继续处理，不计作
本轮已完全解决。安全回归包括 co612 多离散缺轮与 `-2…-100` 连续缺块、ZSL
whole/partial/false/missing 真值、ZSL141 保存循环和 MCP17A 连续缺块；均保持通过。

### Round 2 基线：whole + missingRing

- 生产算法提交：`82c4c5baff4a3b7762d459b97cb39adcd52a195d`（Round 1C，不含本轮修复）。
- 结果目录：
  `D:\软件测试\co612-operation-composition-results\whole-missing-round2-baseline-after-round1c-2026-08-08`
- 组合基准器已参数化为 `--unit-event missingRing|falseRing`，两种方向使用完全相同的
  10 条样芯、`-5/-1/+1/+5` whole、20%/50%/80% 位置、先应用 whole 再重新诊断的
  事件顺序和隐藏真值协议。schema v2 使用中性的 `unitEventType/finalUnitYear` 字段，
  不再把缺轮结果误记为 falseRing。
- 245 个唯一状态错误 0，保存重开一致 245/245，组合应用 whole 后与纯 missing 控制
  逐值相同 120/120；co612 SHA-256 运行前后不变。

| 指标 | Round 2 基线 |
| --- | ---: |
| clean review 误报 | 2/55 |
| 纯 whole 精确 | 40/40 |
| 纯 missing 操作正确 | 30/30 |
| 纯 missing 窗口覆盖 | 28/30 |
| 组合响应 | 120/120 |
| review whole 精确 | 116/120 = 96.67% |
| strict 首事件 whole 精确 | 110/120 = 91.67% |
| internal final 含精确 whole | 116/120 = 96.67% |
| whole 被判成 partialMove | 0/120 |
| whole 被判成 missingRing | 4/120 = 3.33% |
| 正确先 whole、再恢复 missing | 108/120 = 90.00% |

旧端和中部均为 40/40；4 个失败全部在较新端，较新端为 36/40。失败只来自：

- `mon261 whole +1/+5 + newer missing`
- `mtr831 whole -1/-5 + newer missing`

四例都没有生成正确的 terminal whole 候选。COFECHA 已包含真终态，但现有草案生成器把
每个 endpoint 段统一要求为 `r>=0.55`：`mon261` 的单终端段为 0.54；`mtr831` 有两条
方向一致的终端段，分别约为 0.49/0.52 和 0.47/0.50，也被单段阈值一起拒绝。随后旧侧
多数状态 `g-1` 被当作 whole 或连续缺轮阶梯，最终输出 missingRing。

下一步不是普遍降低阈值，而是区分证据结构：两条以上一致 endpoint 段使用重复性门槛；
只有一条时要求它相对 lag 0 有明确优势，并继续通过应用 whole 后恰好留下 `-1` 的联合
反事实门槛。Round 2 本节只冻结基线，不修改生产算法。通用基准器以 falseRing 模式对
`mon151` 74 个状态反向 smoke，组合 whole 仍为 12/12，clean 仍为 2/55。

### Round 2A：重复终端证据与相对状态方向一致性

- missing 最终目录：
  `D:\软件测试\co612-operation-composition-results\whole-missing-round2-direction-consistency-final-2026-08-08`
- false 反向目录：
  `D:\软件测试\co612-operation-composition-results\whole-false-round1-direction-consistency-final-2026-08-08`
- 两套运行均为 245 个唯一状态、错误 0、残余映射 120/120、保存重开 245/245，源文件
  SHA-256 未改变。

固定 `r>=0.55` 同时忽略了两类有效证据：多条方向一致但单条相关中等的终端段，以及仅一条
但相对 lag 0 有很大优势的终端段。本轮改为：

1. 先要求至少两条可靠 endpoint 段在同一非零 lag 上一致；重复性本身作为证据，不再要求
   每条都超过 0.55。
2. 没有重复段时才允许单段回退，并同时要求 `starredR>=0.45` 且相对 lag 0 的增益至少
   0.20；候选仍必须通过普通 hard gate 或应用 whole 后留下唯一单位 residual 的联合门槛。
3. 第一次实现使 whole+missing 达到 120/120，但误把 `mon052` 的九个离散缺轮显示为
   `whole -1`。原因是三个重叠 endpoint 窗都跨过最新缺轮，重复段不等于固定侧终态。
4. 因此增加相对状态方向检查。对每个传播模式计算
   `pattern.dominantLag - terminalLag`，按受影响段数与置信度加权。若候选声称的单位 residual
   方向与局部状态变化相反，且 opposing support 大于 matching support，则拒绝该 terminal
   whole 草案。`mon052` 反例为 residual `+1`，matching 0、opposing 8.24；真实组合的局部
   状态与 residual 同向。
5. 终端 evidence mode、段数、一致性、residual 和正反传播支持写入事件 notes，便于后续
   跨文件审计。

| 指标 | Round 2 基线 | Round 2A |
| --- | ---: | ---: |
| clean review 误报 | 2/55 | **2/55** |
| 纯 whole 精确 | 40/40 | **40/40** |
| 纯 missing 操作正确 | 30/30 | **30/30** |
| 纯 missing 窗口覆盖 | 28/30 | **28/30** |
| review whole 精确 | 116/120 | **120/120** |
| strict 首事件 whole 精确 | 110/120 | **114/120** |
| internal final 含精确 whole | 116/120 | **120/120** |
| whole 被判成 missing/partial | 4/120 | **0/120** |
| 正确先 whole、再恢复 missing | 108/120 | **112/120** |

串行 112/120 正好等于纯 missing 窗口控制 28/30 跨四种 whole 位移后的上限，不再有组合
损失。四个位移各 30/30，旧/中/新位置各 40/40。full false 反向基准保持 review
120/120、strict 115/120、串行 100/120、clean 2/55，说明方向检查没有偏向 missing。

安全回归最终通过 50/50：`mon052` 九个自然缺轮逐轮恢复、`mtr841`、分离缺轮、真实连续
缺块 `-2…-100`、ZSL whole/partial/unit、ZSL141 保存循环、MCP17A 和编辑语义。第一次
出现的 `mon052` 回退已保留在过程记录中，不将中间 120/120 误称为可发布结果。

### Round 3 基线：whole + partialMove -6

- 生产算法提交：`7df94538caab19b48562147429deb77dfd463e13`（Round 2A，不含本轮修复）。
- 冻结结果目录：
  `D:\软件测试\co612-operation-composition-results\whole-partial-6-round3-baseline-frozen-2026-08-08`
- 组合基准器升级到 schema v3，使用中性的 `localEventType/localShiftYears/finalLocalYear`
  字段，并支持 `missingRing`、`falseRing` 和精确负向 `partialMove`。partialMove 真值年份
  统一为 `firstFixedYear`，位移必须精确相等，不能把 `-6` 近似为较小位移。
- 仍使用相同 10 条目标样芯、`-5/-1/+1/+5` whole 和 20%/50%/80% 三个断点位置；
  245 个唯一状态错误 0，组合应用 whole 后与纯 partial 控制逐值相同 120/120，保存重开
  一致 245/245。源文件 SHA-256 运行前后均为
  `36e6c6a9d0cbc16d1870a1662da553a7b40d5578ea9ede25ff790c556c34667d`。

保存稳定性原先有 13 个假失败：操作、位移、窗口和 Top1 均相同，仅分数在
`2e-15` 量级不同。schema v3 改为结构字段精确比较、浮点分数使用 `1e-9` 容差；没有
隐藏任何真实的操作或窗口变化。

| 指标 | Round 3 基线 |
| --- | ---: |
| clean review 误报 | 2/55 |
| 纯 whole 精确 | 40/40 |
| 纯 partial `-6` 操作精确 | 24/30 = 80.00% |
| 纯 partial `-6` 窗口覆盖 | 22/30 = 73.33% |
| 组合响应 | 120/120 |
| review 首事件 whole 精确 | 107/120 = 89.17% |
| strict 首事件 whole 精确 | 103/120 = 85.83% |
| internal final 含精确 whole | 107/120 = 89.17% |
| whole 被判成 missingRing | 12/120 = 10.00% |
| whole 被判成 partialMove | 0/120 |
| 正确先 whole、再恢复 partial | 76/120 = 63.33% |

失败并非随机分布。`whole=-5/-1/+1` 均为 30/30，只有 `whole=+5` 降到 17/30：
12 例输出 missingRing `-1`，另 1 例输出 whole `-1`。较老位置为 40/40，中部 37/40，
较新位置 30/40。

原因是两个 lag 状态发生精确抵消。设较新固定侧的整体基线为 `g`，局部缺失量为
`p< -1`，则较老侧状态为 `g+p`。本轮失败组合为：

```text
newer baseline g = +5
partial shift  p = -6
older state  g+p = -1
```

COFECHA 并未丢失信息。例如 `mon152` 较新断点案例的旧侧 14 条连续分段均为 `lag=-1`，
新侧 3 条分段均为 `lag=+5`，真实路径清楚地表现为 `-1 -> +5`。终端 whole 草案也能
得到 `+5`，但现有 `jointCompositionGatePassed` 只允许应用 whole 后留下绝对值为 1 的
residual，因此 residual `-6` 的草案被 evaluation 丢弃，旧侧多数状态随后被单位事件
定位器解释成 missingRing。

Round 3 修复必须把较新固定侧状态作为 whole baseline，并把
`olderLag - newerLag` 作为局部位移联合验证。只允许符合自动 partialMove 物理语义的
负向 residual（`<= -2`）、应用 whole 后仍保留同一 residual、且存在局部状态转移支持；
不得把联合门槛无条件放宽到任意大 lag。修复前先冻结本节，生产改动另行提交。

### Round 3A：物理 partial residual 与 terminal whole 保留席位

- 最终结果目录：
  `D:\软件测试\co612-operation-composition-results\whole-partial-6-round3-terminal-baseline-final-2026-08-08`
- missing 反向目录：
  `D:\软件测试\co612-operation-composition-results\whole-missing-round3-reverse-regression-2026-08-08`
- false 反向目录：
  `D:\软件测试\co612-operation-composition-results\whole-false-round3-reverse-regression-2026-08-08`

修复分为两个独立层次：

1. `jointCompositionGatePassed` 保留原有 `+/-1` residual 规则；绝对值更大的 residual 只在
   `isAutomaticPartialShift` 接受的负向范围内放行，并要求应用 whole 后 global lag 精确保留、
   同向局部传播支持不少于 0.5 且严格强于反向支持。正向大位移、超过动态上限、无局部路径
   或应用后 residual 改变均拒绝。
2. 通过上述门槛的 terminal whole 仍可能被每序列 Top 5 候选预算截掉。本轮为已经是
   strong 且通过 ordinary hard gate 或 joint gate 的 terminal whole 保留一个席位，替换最低
   的普通候选但不增加候选总数。弱 terminal 不享受保留，也不能绕过评估门槛。

加入 `scripts/inspect-terminal-composition.ts` 作为只读审计器，可对任意隔离的
`state.rwl + VERYCOF.OUT + target` 输出 global lag、传播模式、terminal 草案 tags、评估分数
和 hard/joint gate。`mon152` 失败例由此确认：terminal `+5`、residual `-6`、matching
support `12.464308`、opposing `0`，候选满足普通 hard gate 6/7；真正丢失点是进入事件层
前的 Top 5 截断，而不是 COFECHA 或 evaluation 没有识别。

| 指标 | Round 3 基线 | Round 3A |
| --- | ---: | ---: |
| clean review 误报 | 2/55 | **2/55** |
| 纯 whole 精确 | 40/40 | **40/40** |
| 纯 partial `-6` 操作精确 | 24/30 | **24/30** |
| 纯 partial `-6` 窗口覆盖 | 22/30 | **22/30** |
| review 首事件 whole 精确 | 107/120 | **120/120** |
| strict 首事件 whole 精确 | 103/120 | **116/120** |
| internal final 含精确 whole | 107/120 | **120/120** |
| whole 被判成 missingRing | 12/120 | **0/120** |
| whole 被判成 partialMove | 0/120 | **0/120** |
| 正确先 whole、再恢复 partial | 76/120 | **88/120** |

四个 whole 位移各 30/30，旧/中/新位置各 40/40。串行 88/120 正好等于纯 partial
窗口 22/30 跨四个位移后的上限，说明应用 whole 后没有新增类型或窗口损失；本轮没有把
纯 partial 原有 6 个操作错误和 2 个额外窗口错误误称为已解决。

反向完整基准保持：

- whole + missing：review 120/120、strict 114/120、串行 112/120、clean 2/55。
- whole + false：review 120/120、strict 115/120、串行 100/120、clean 2/55。
- 两套均为 245 个唯一状态、错误 0、残余映射 120/120、保存重开 245/245，源文件
  SHA-256 不变。

安全回归通过：terminal/COFECHA 19 项；mon052、mtr841、物理缺块 `-2...-100`、ZSL141、
MCP17A 和编辑应用 46 项；显式使用最新 `D:\软件测试\ZSL` 的 RAW/crossdated/OUT 后，
ZSL 整体/局部/伪轮操作类型 11 项通过。下一步分别验证 partial `-2` 与 `-20`，再处理纯
partial 的位移量和窗口上限，不能用本轮已解决的“先 whole”指标替代局部事件准确率。

### Round 3B：partial 位移幅度分层冻结

- `-2` 结果目录：
  `D:\软件测试\co612-operation-composition-results\whole-partial-2-round3-amplitude-validation-2026-08-08`
- `-20` 结果目录：
  `D:\软件测试\co612-operation-composition-results\whole-partial-20-round3-amplitude-validation-2026-08-08`
- 两套均基于生产提交 `27627fe7d00fcc1e810588c503e3c2a287dc98f7`，各 245 个唯一
  状态、错误 0、残余映射 120/120、保存重开 245/245，co612 SHA-256 未改变；clean
  review 均为 2/55。

| 指标 | partial -2 | partial -6 | partial -20 |
| --- | ---: | ---: | ---: |
| 纯 partial 响应 | 27/30 | 30/30 | 28/30 |
| 精确操作与位移 | 14/30 | 24/30 | 17/30 |
| 唯一主窗口覆盖 | 13/30 | 22/30 | 15/30 |
| 组合首步 whole review | **120/120** | **120/120** | **120/120** |
| 组合首步 whole strict | 116/120 | 116/120 | 115/120 |
| whole -> partial 串行正确 | 52/120 | 88/120 | 60/120 |
| whole 被判成 partial/unit | 0/120 | 0/120 | 0/120 |

Round 3A 的 whole baseline 分离已经跨位移量泛化：`-2/-6/-20` 三档的四种 whole 位移
和三个断点位置均为 review 120/120，没有再把整体移动压成局部或单位事件。剩余损失完全
来自应用 whole 后的纯 partial 层，不能再修改 whole 门槛来掩盖。

纯 partial 失败结构：

- `-2`：10 次输出 missingRing、2 次 whole `-2`、1 次 falseRing、3 次拒答；14 次精确
  partial 中另有 1 次主窗口未覆盖。较新位置操作仅 3/10、窗口 2/10。
- `-20`：5 次输出 missingRing、4 次 falseRing、2 次 whole `-20`、2 次拒答；17 次精确
  partial 中另有 2 次主窗口未覆盖。较老位置操作和窗口均为 0/10，中部操作 9/10、窗口
  8/10，较新位置操作 8/10、窗口 7/10。

下一步按事件投影链逐案审计：先检查精确 partial 草案/候选是否已经存在但被 Top 5、单位
事件或 whole alias 覆盖；只有候选层确实没有形成精确位移时，才进入动态位移量评分和断点
定位器。操作恢复与窗口恢复分开验收，不用扩大窗口修位移量错误。

后续每轮在这里追加：输入 SHA、案例数、分层、修复前指标、失败类型、算法改动、
修复后指标、干扰检查、外部回归、提交号和未解决边界。

### Round 3C：精确 partial 阶跃不可被单位假设静默降级

- `-2` 结果目录：
  `D:\软件测试\co612-operation-composition-results\whole-partial-2-round4b-unopposed-exact-preservation-2026-08-08`
- `-20` 结果目录：
  `D:\软件测试\co612-operation-composition-results\whole-partial-20-round4b-unopposed-exact-preservation-2026-08-08`
- missing 反向目录：
  `D:\软件测试\co612-operation-composition-results\whole-missing-round4b-unopposed-partial-reverse-regression-2026-08-08`
- false 反向目录：
  `D:\软件测试\co612-operation-composition-results\whole-false-round4-unopposed-partial-reverse-regression-2026-08-08`
- 两套仍使用相同 10 条无 0 目标、三个断点位置和四种 whole 位移；各 245 个唯一状态，
  错误 0、残余映射 120/120、保存重开 245/245。输入 SHA-256 仍为
  `36e6c6a9d0cbc16d1870a1662da553a7b40d5578ea9ede25ff790c556c34667d`，clean review
  仍为 2/55。

逐案审计发现 partial 被改成 missingRing 有三条重复路径：初次动态 operation fusion、
顺序缺轮 head recovery，以及 counterfactual locator 后的 compressed staircase projection。
例如 `mon252 partial -20 older` 在融合前已经给出精确 `-20 -> 0`，但旧规则只因单位分数
接近就改成 `-1 -> 0`；`mon251 partial -2 newer` 在初次融合后仍为精确 `-2 -> 0`，随后
被两个自由断点的阶梯模型改成 missingRing。

本轮统一使用状态差不变量：

```text
partial shift = older lag - newer lag
```

纯 partial 的 newer lag 为 0；whole + partial 中 newer lag 为 whole baseline，因此同一公式
同时覆盖 `-20 -> 0` 和 `-1 -> +5` 这类组合。动态单位选择器不得仅凭接近分数把满足该式
的负向 partial 改成单位事件；不满足该式的夸张 partial 仍可按原门槛纠正。对于 `-2`，
分离的两个 missingRing 在代数上也可形成 `-2 -> 0`，因此没有一律保护：只有 COFECHA
候选与 lag path 都支持直接 partial，且没有独立 missing 候选或邻近共享 0 锚点时，才禁止
高自由度阶梯模型覆盖直接解释。真实 mtr841、mon121、mon162 离散缺轮仍通过原恢复路径。

第一版曾保护事件集合中的任意 exact partial。missing 反向基准立即发现 `mon151/mon152`
旧侧各有一个远距离伪 `-2 -> 0` 与正确高分 missing 同时存在，导致正确单位窗口被伪 partial
拖走：窗口由 28/30 降为 26/30，串行由 112/120 降为 104/120。最终规则收紧为只保护
**唯一、无竞争**的 exact partial；一旦事件集合已有独立 missing/false，单位事件仍可参与并
赢得融合。修正版 missing 恢复为操作 30/30、窗口 28/30、串行 112/120；false 与前轮逐项
相同：操作 26/30、窗口 25/30、串行 100/120。两者 whole review 均为 120/120，clean
均为 2/55。

| 指标 | `-2` Round 3B | `-2` Round 3C | `-20` Round 3B | `-20` Round 3C |
| --- | ---: | ---: | ---: | ---: |
| 纯 partial 精确操作 | 14/30 | **16/30** | 17/30 | **21/30** |
| 唯一主窗口覆盖 | 13/30 | **15/30** | 15/30 | **19/30** |
| whole 首步 review 精确 | 120/120 | **120/120** | 120/120 | **120/120** |
| whole 被判成 partial/unit | 0/120 | **0/120** | 0/120 | **0/120** |
| whole -> partial 串行正确 | 52/120 | **60/120** | 60/120 | **76/120** |

`-20` 较老位置由操作/窗口 0/10 提升到 3/10，中部操作由 9/10 到 10/10；`-2` 的
操作和窗口各追回 2/30。完整 COFECHA 回归 11/11 通过：mon052 九缺轮、mtr841 四步恢复、
分离两缺轮、`-2...-100` 多断点物理缺块以及新增的 `mon251 -2`、`mon252 -20`。
ZSL RAW/crossdated 11 项操作回归全部通过。49 条初始前沿审计与修复前逐条零变化：RAW
动态参考仍为响应 12/14、操作正确 11/14、clean 误报 3/35；隔离 crossdated 参考仍为
11/14、8/14、4/35。四个真实 whole 均保持 whole，没有新增 whole -> partial 或
partial -> missing。该初始前沿审计尚不等于“先应用 whole 后逐事件”的 ZSL 串行回放，
后者仍需单独实现，不能由 11 项定点回归替代。
这轮只修复“已有精确 partial 被降级”；候选层没有形成精确位移、whole alias 抢占以及
窗口中心偏移仍留给下一轮，不能把当前 50%/63.33% 覆盖率误称为最终结果。

### Round 3D：ZSL RAW -> crossdated 串行真值回放基线

- 首轮结果目录：
  `D:\软件测试\ZSL\window-coverage-results\zsl-serial-operation-baseline-round2-all-truth-2026-08-08`
- 输入 SHA-256：RAW
  `63072b6d72c565f2e3da06d32b95d1734599860c0a32c47492654224967744b3`，crossdated
  `a836e8a09030ebdc09135f24f44215ca1ab0c6590fdae6827661ed7d9c64f358`；运行前后均未改变。
- 生产基线提交：`eb3b544116538a69eb6573d6cfad93bf5746832c`。

新增共享的 LCS 观测对齐真值层和串行回放器。它不会把 crossdated 真值放入诊断输入：
真值只用于判断当轮应修复的前沿事件。每一步都先记录建议，再应用一个已确认真值，按源
格式保存并重开，重新运行 COFECHA、重建 leave-one-out 动态参考，再诊断下一事件。这样可
区分三件容易混在一起的事：相同状态保存前后是否漂移、修复后是否暴露了另一真实事件、
以及重新生成 COFECHA 后是否发生操作类型误判。

49 条共有序列中，42 条可由纯定年编辑严格重建。主指标使用其中 9 条带事件序列、12 个
操作；另将 5 条含端点截除、999 或其他非定年人工处理的序列共 8 个操作作为补充真值，
不混入严格重建指标。两种状态分别运行：整文件保持 RAW，以及仅目标保持 RAW、其余序列
使用 crossdated。两种模式各产生 34 个保存/重开诊断对，68/68 的序列化数据和建议语义
均稳定；因此当前观察到的类型变化不是“保存没有应用”。

| 严格重建指标 | 全文件 RAW | 隔离 crossdated 参考 |
| --- | ---: | ---: |
| 真值操作 | 12 | 12 |
| 响应 | 10/12 | 11/12 |
| 操作正确 | 10/12 | 10/12 |
| 局部窗口覆盖 | 7/9 | 7/9 |
| whole 精确 | 3/3 | 3/3 |
| partial 精确 | 0/1（拒答） | 0/1（误判 falseRing） |
| missing 精确 | 5/6 | 5/6 |
| false 精确 | 2/2 | 2/2 |
| 终态仍有 review 误报 | 3/9 | 3/9 |
| 定年 lag 路径最终清零 | 9/9 | 9/9 |

补充真值中的第四个 whole（ZSL092 `-6`）在两种模式均正确，因此本批自然 ZSL 前沿没有
复现 whole -> partial。两个真实 partial 均未被正确处理：ZSL192 `-4` 在两种模式都拒答；
ZSL212 `-4` 在全 RAW 拒答，在隔离参考下被远距离 falseRing `+1` 抢占。它们也没有直接
变成 missingRing，说明不能把用户观察统一归因于同一条 demotion 分支，下一轮要审计的是
“精确 partial 候选是否形成/为何输给另一概率模式”。

相邻混合事件 ZSL202 的路径为 missingRing 1886 后接 falseRing 1884：首步 missing 拒答，
在真值修复后第二步 false 能正确输出且窗口覆盖。这里第二次建议类型改变是另一个真实事件
被暴露，不是同一事件保存后变质。相反，ZSL101 和 ZSL182 的单位 missing 被错误解释成
whole `-2/-1`，表明 terminal baseline 与局部单位前沿仍需联合判别。

本基准先冻结测量方式和逐案 CSV/JSON，不在同一提交修改生产门槛。下一轮使用 ZSL212、
ZSL192 和 missing -> whole 失败案检查候选形成、全局 terminal 证据与事件路径竞争；随后
在 crossdated 干净序列上系统注入 whole/partial/unit 组合，补足自然文件中只有四个 whole、
两个 partial 所造成的样本量不足。

### Round 3E：候选支持的真实 partial 不再被单位路径吞掉

- 修复提交：`8e3ca4347c707d7c865fb6cd5851b090efdd169a`。
- 提交后冻结结果：
  `D:\软件测试\ZSL\window-coverage-results\zsl-serial-operation-candidate-partial-round3-committed-2026-08-08`。
- RAW 与 crossdated SHA-256 与 Round 3D 相同，运行前后均未改变；结果内记录的生产提交与
  当前提交一致。

fresh COFECHA 审计表明，ZSL212 和 ZSL192 都已经形成可执行的精确 `partialMove -4`
候选，但 regularized lag path 没有发射该转移。旧管线随后从自由度更高的单位路径或远距离
候选中重选，分别表现为拒答或 false/missing 型建议。这里不是保存没有应用，也不是
partial 的物理位移上限不足，而是候选证据没有进入最终事件状态竞争。

新规则只恢复两种可审计情形：

1. COFECHA 候选与独立 segmented candidate 对同一负向位移幅度达成一致；
2. COFECHA 候选的幅度与观测 lag 一致，且其余候选的幅度与该 lag 明显不一致。

恢复后统一表达为 `shift -> 0` 的局部状态。只有候选或共享/已确认零值直接锚定的单位事件
才能与之竞争；单纯由 partial 条件化产生的单位别名不能覆盖精确局部移动。该 fallback 仅
接管 `-4` 及更大的缺块，`-2/-3` 继续经过显式 missing-staircase 竞争，避免把两个离散缺轮
重新压成一个 partial。

| 精确重建指标 | Round 3D 全 RAW | Round 3E 全 RAW | Round 3D 隔离参考 | Round 3E 隔离参考 |
| --- | ---: | ---: | ---: | ---: |
| 响应 | 10/12 | **11/12** | 11/12 | **11/12** |
| 操作正确 | 10/12 | **11/12** | 10/12 | **11/12** |
| 局部窗口覆盖 | 7/9 | **7/9** | 7/9 | **8/9** |
| whole 精确 | 3/3 | **3/3** | 3/3 | **3/3** |
| partial 精确 | 0/1 | **1/1** | 0/1 | **1/1** |
| whole -> partial | 0 | **0** | 0 | **0** |
| partial -> missing | 0 | **0** | 0 | **0** |
| 终态 review 误报 | 3/9 | **3/9** | 3/9 | **3/9** |

补充非严格真值中的 ZSL192 也在两种模式都输出 `partialMove -4` 且窗口覆盖 1888；保存重开
34/34、序列化状态 34/34 稳定。ZSL212 在隔离参考下覆盖断点 1870，在整文件 RAW 背景下
窗口为 1857-1869，只差 1 年，因此本轮只声明**操作类型已修复**，不把窗口问题算作成功。

反向回归包括 event ensemble/review 40 项、operation recovery 与 co612 多缺轮 86 项、ZSL
操作类型 11 项和 production build。mon052 九个缺轮、mtr841 四步缺轮、分离两缺轮以及
物理缺块 `-2...-100` 均保持通过。下一轮分别处理 ZSL212 的模式内定位，以及 ZSL202
缺轮拒答和补充真值中的 missing -> whole；不得通过削弱 whole 证据来换取单位事件召回。

### Round 3F：用较新侧固定证据区分端点单位事件与整体移动

- 修复提交：`d38fc4c76b1f0aebb9ed68efef786015b42f8aaf`。
- ZSL 提交后冻结结果：
  `D:\软件测试\ZSL\window-coverage-results\zsl-serial-operation-endpoint-contrast-round4-committed-2026-08-08`。
- co612 missing 反向结果：
  `D:\软件测试\co612-operation-composition-results\endpoint-whole-unit-contrast-reverse-round2-committed-2026-08-08`。
- co612 false 反向结果：
  `D:\软件测试\co612-operation-composition-results\endpoint-whole-unit-contrast-false-reverse-round2-committed-2026-08-08`。

ZSL182 的真实缺轮位于较新端。旧逻辑看到大多数 50 年 COFECHA 分段都落在事件较老侧，
因而把同方向的终端 `lag=-1` 解释为整条序列移动。新判别器不按端点距离直接改类型，而在
单位事件唯一窗口内枚举断点，单独检查断点较新侧是否保持正确日历：比较该侧在 `lag=0`
和整体 `lag=+/-1` 下的原始相关与一阶差分相关，并分别计算 master、逐参考芯和同树配对芯
优势。只有 master、参考芯中位数、下四分位及正向支持比例共同形成稳健共识时，单位事件
才允许压过终端 whole；否则仍保持“先应用整体移动、再重新诊断局部事件”的顺序。

ZSL182 的较新侧由 45 条可用参考芯支持，`91.11%` 的逐芯证据偏向 `lag=0`；修复后在整文件
RAW 和隔离 crossdated 参考两种模式都输出 missingRing，唯一窗口覆盖 2015，保存重开后不再
变回 whole。ZSL 完整串行回放的严格重建指标保持 Round 3E 水平：whole 3/3、partial 1/1，
whole -> partial 与 partial -> missing 均为 0；补充真值操作则由全 RAW 6/8 提升到 7/8、隔离
参考由 7/8 提升到 8/8。两种模式各 34/34 保存重开稳定，输入 SHA-256 与 Round 3D 相同且
运行前后未改变。

| co612 反向指标 | missing / whole -1 | false / whole +1 |
| --- | ---: | ---: |
| 唯一诊断状态 | 125 | 125 |
| 错误 / 残余映射不一致 | 0 / 0 | 0 / 0 |
| clean review 误报 | 2/55 | 2/55 |
| 真实 whole 精确 | 10/10 | 10/10 |
| 纯局部操作正确 | 30/30 | 26/30 |
| 纯局部窗口覆盖 | 28/30 | 25/30 |
| whole + 局部首步 whole 精确 | 30/30 | 30/30 |
| whole 被判成 unit / partial | 0/30 | 0/30 |
| 应用 whole 后局部复诊正确 | 28/30 | 25/30 |
| 保存重开稳定 | 125/125 | 125/125 |

串行复诊结果分别精确等于纯 missing/false 对照自身的窗口上限，说明组合状态没有产生额外
损失。两批 co612 的源 SHA-256 都保持
`36e6c6a9d0cbc16d1870a1662da553a7b40d5578ea9ede25ff790c556c34667d`。因此这轮可以明确
冻结为：端点单位事件可在强逐参考芯证据下纠正 terminal whole，但不能凭“靠近新端”改写
真实整体移动。

ZSL202 的相邻 false 1884 + missing 1886 仍在第一步拒答。补充实验将短脉冲范围扩到 2--7
年并运行单位联合路径后，未提示真值时的最强峰落在 1917--1919；即使只在真值邻域计算，
纠正收益仍为负且仅 1/8 参考支持。由于当前内部参考没有可辨识证据，本轮没有通过降低门槛
强制回答，也没有把失败隐藏在扩大窗口中。下一步先修复 ZSL212 只差一年的模式内窗口，再
继续审计多事件条件下的拒答与参考竞争。

### Round 3G：保持已验证 partial 的 COFECHA 锚定模式

- 修复提交：`993a9855782c42c9080fca2e91e36d1d96fe24b4`。
- ZSL 提交后冻结结果：
  `D:\软件测试\ZSL\window-coverage-results\zsl-serial-operation-cofecha-anchor-mode-round5-committed-2026-08-08`。
- co612 `partialMove -4` 提交后冻结结果：
  `D:\软件测试\co612-operation-composition-results\whole-partial-4-round5f-cofecha-anchor-mode-committed-2026-08-08`。

ZSL212 的操作融合已经正确恢复 `partialMove -4`，融合前的 13 年窗口也覆盖真实
`firstFixedYear=1870`；但反事实精定位器随后只使用 difference 与逐参考芯 fixed-lag
profile 重新选模式，将整文件 RAW 窗口拉到 1857--1869。这属于已经选对操作、却在下游
丢失候选来源和断点模式的定位错误，不应通过统一扩窗修复。

事件融合现在单独记录来自 `cofecha_segment_lag` 的 partial 断点锚点。定位器只对已经通过
候选共识恢复的 partial，将该锚点与当前接受中心的中点作为模式先验；校准器仅在没有满足
5/7/9 年集中证据、仍会输出 `calibrated_default_13` 时使用它。重新选择的 13 年窗必须与
原模式至少重叠 7 年，因此不能跳到远距离候选峰；已有 5/7/9 年窄窗完全不受影响。空锚点
不写入 evidence，解析端也拒绝空 token，避免把空字符串转换成年份 0。

| ZSL 严格重建指标 | Round 3F 全 RAW | Round 3G 全 RAW | Round 3F 隔离参考 | Round 3G 隔离参考 |
| --- | ---: | ---: | ---: | ---: |
| 响应 | 11/12 | 11/12 | 11/12 | 11/12 |
| 操作正确 | 11/12 | 11/12 | 11/12 | 11/12 |
| 局部窗口覆盖 | 7/9 | **8/9** | 8/9 | 8/9 |
| whole 精确 | 3/3 | 3/3 | 3/3 | 3/3 |
| partial 精确 | 1/1 | 1/1 | 1/1 | 1/1 |
| whole -> partial | 0 | 0 | 0 | 0 |
| partial -> missing | 0 | 0 | 0 | 0 |
| 保存重开稳定 | 34/34 | 34/34 | 34/34 | 34/34 |

ZSL212 全 RAW 窗口由 1857--1869 改为 1863--1875，隔离参考窗口为 1864--1876；两者都
保持 `partialMove -4` 并覆盖 1870。RAW 与 crossdated SHA-256 分别仍为
`63072b6d72c565f2e3da06d32b95d1734599860c0a32c47492654224967744b3` 和
`a836e8a09030ebdc09135f24f44215ca1ab0c6590fdae6827661ed7d9c64f358`，运行前后未改变。

co612 对照包含 245 个唯一状态，错误 0、残余映射不一致 0、保存重开 245/245。clean
review 误报保持 2/55；whole 为 40/40，whole + partial 首步 whole 为 120/120，
whole -> partial/unit 均为 0。纯 `partialMove -4` 操作仍为 22/30、窗口 21/30，应用 whole
后串行复诊为 84/120。与 Round 3F 后的冻结基线逐案比较，只有
`mtr831:partial-4:middle` 的 13 年窗口从 1891--1903 平移到 1892--1904，仍覆盖真断点
1899；没有窗口变宽、覆盖退化或操作类型变化。

验证包括 event window、event ensemble、review display 和 ZSL 操作回归 89 项，operation
recovery 与 co612 多缺轮连续恢复 62 项，以及 production build。ZSL 严格真值仍有 1 个
单位事件拒答和 1 个局部窗口未覆盖；co612 的纯 partial 操作与窗口召回也仍分别只有
73.33% 和 70%。因此本轮只冻结“候选 partial 模式不再被下游定位器丢弃”这一项改进，
后续仍需扩展不同 partial 幅度、重复同类事件和三至四事件组合，并在外部 ITRDB 文件上
检验泛化。

### Round 4A：冻结缺轮与伪轮抵消脉冲的串行基准

- 基准提交：`eb92b2877f7d4564d872ede0c847f9513e406c2a`。
- 冻结基线：
  `D:\软件测试\co612-operation-composition-results\unit-pulse-round4-baseline-committed-2026-08-08`。
- co612 输入 SHA-256：
  `36e6c6a9d0cbc16d1870a1662da553a7b40d5578ea9ede25ff790c556c34667d`；运行前后未改变。

新增 `benchmark:co612:unit-pulse`。它在 10 条固定选出的零值无关长序列上，按老/中/新三个
固定比例位置、2/9/21 年三种间距和两个方向构造 missing+false 抵消脉冲，共 180 个双事件
场景；另有 360 个同位置单事件对照和 55 条 clean 序列。位置选择不读取信号强度，隐藏真值
只用于评估。每次只应用操作正确且窗口覆盖的当前事件，随后按源格式保存、重开、重新运行
COFECHA 并诊断第二事件。两个应用顺序都必须回到 clean 非零日历映射，Tucson `-9999`
终止标记不计作年轮值。

基线的单事件操作正确为 324/360、窗口覆盖 299/360，说明主要损失来自两个方向相反事件
共存后的交互，而不是单事件定位本身。双事件首轮响应 73/180、窗口 45/180、Top1 16/180，
完整串行仅 37/180；clean review 为 2/55，保存重开 100%，错误 0。2 年中间状态太短，
窗口和串行都只有 2/60；9 年为窗口 32/60、串行 26/60；21 年为窗口 11/60、串行 9/60。

审计发现 `locateReferenceVerifiedPulse` 原本只在先前事件组装完全为空时作为兜底。mon151
等案例先形成远处、无 candidate/COFECHA/反事实锚点的 `partialMove -2`，于是严格的
missing+false 参考芯成对证据没有参与竞争；随后该 partial 又被 review 门槛拒绝，最终表现
为错误局部移动或无建议。这解释了为什么保存后累积 lag 改变时，建议还可能继续变成单缺轮：
旧管线把有限 `0 -> +/-1 -> 0` 脉冲压成了通向序列端点的单边状态。

### Round 4B：严格成对脉冲可以压过无锚定 partial 别名

- 修复提交：`779db791dda53e009b8db3ae817d6ae5ea630c04`。
- 提交后 gap=9 结果：
  `D:\软件测试\co612-operation-composition-results\unit-pulse-round4-pair-over-partial-committed-gap9-2026-08-08`。

新竞争规则只接管一个非常窄的状态：没有 whole、没有既有单位事件、唯一 partial 恰为 `-2`，
且该 partial 没有候选、COFECHA、反事实、局部纠正或重复块边界锚点；与此同时，missing 与
false 两端都必须通过 `reference_core_pair_voting` 和 bounded/localized pulse 证据。任何
候选支持的 partial、`-4` 及更大连续缺块、已有单位事件和 whole 都保持原优先级，未降低
原有显示门槛。

gap=9 的首轮响应由 37/60 到 41/60，唯一窗口由 32/60 到 36/60，Top1 由 15/60 到
19/60，完整串行由 26/60 到 30/60。新增四例都来自 mon151，但 120 个单事件对照逐案
不变；`partialMove -2` 的 245 状态反向基准也逐案不变，clean 仍为 2/55。ZSL 两种参考
模式的响应、操作、窗口和保存重开与 Round 3G 完全一致，whole -> partial 与
partial -> missing 都为 0。

### Round 4C：用路径提示和多参考芯共识恢复 15--70 年有限脉冲

- 修复提交：`8578ccaa4a7a3160aa7d0e188315cd988e7bca71`。
- 提交后全量冻结结果：
  `D:\软件测试\co612-operation-composition-results\unit-pulse-round4-long-consensus-committed-all-2026-08-08`。
- 输入 SHA-256 与 Round 4A 相同，运行前后未改变；manifest 记录
  `truthRoundTripVerified=true`、700 个唯一诊断状态、错误 0。

无提示成对扫描仍严格保持 8--14 年，不把正式管线扩成昂贵的“所有年份 x 所有间距”。
第二级长脉冲先由 lag 状态路径给出方向和两个近似边界，再只在两端误差范围内联合搜索
15--70 年间距。长脉冲必须同时满足全局成对反事实增益与远峰分离，并在至少 7 条参考芯上
达到近乎全票的局部一阶差分改善、正的下四分位增益和联合必要性。通过的事件写入结构化
`long_pulse_consensus` 来源；通用边缘移窗规则不得再把该强锚定年份推出唯一窗口。

| 间距 | 基线响应 | 当前响应 | 基线窗口 | 当前窗口 | 基线 Top1 | 当前 Top1 | 基线串行 | 当前串行 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 年 | 8/60 | 8/60 | 2/60 | 2/60 | 0/60 | 0/60 | 2/60 | 2/60 |
| 9 年 | 37/60 | **42/60** | 32/60 | **37/60** | 15/60 | **20/60** | 26/60 | **30/60** |
| 21 年 | 28/60 | **35/60** | 11/60 | **18/60** | 1/60 | **5/60** | 9/60 | **16/60** |
| 合计 | 73/180 | **85/180** | 45/180 | **57/180** | 16/180 | **25/180** | 37/180 | **48/180** |

21 年新增 7 个窗口和 7 个完整串行成功，旧成功零退步；9 年在 Round 4B 后再新增 1 个
正确首窗，串行不变；2 年逐案零变化。360 个单事件对照仍为操作 324/360、窗口 299/360，
clean review 仍为 2/55，所有 review partial/whole/单位方向误判均为 0。错误 56 年远峰虽然
lag 路径分数较高，但逐参考芯支持只有 62.5% 且下四分位增益为负，因此继续拒答。

反向验证中，`partialMove -2` 的 245 个状态与 Round 3C 后冻结基线逐案相同：whole 40/40、
whole+partial 首步 whole 120/120、纯 partial 操作 16/30、窗口 15/30、串行 60/120，
没有 whole -> unit/partial。ZSL 两种模式仍为严格 whole 3/3、partial 1/1，类型混淆均为 0，
保存重开 68/68。相关 Vitest 9 个文件 171 项及 production build 通过，其中包括 mon052
九个离散缺轮、mtr841 连续保存和物理连续缺块 `-2...-100`。

本轮解决的是“有限单位脉冲被单边 partial 别名遮挡”的一部分可辨识案例，并非完成混合
事件问题。2 年中间状态通常缺少足够上下文，当前保留拒答；21 年窗口仍只有 30%，其余失败
主要是路径未形成正确双边模式或形成后窗口偏移。下一轮应扩大序列与外部 ITRDB 文件覆盖，
再决定是否增加候选引导的长脉冲定位，不能继续靠降低共识门槛提高响应。

### Round 5：同一 Legacy 24 文件上的当前类型边界复测

- 运行提交：`9bff4606016ddd5516e2bddfde27167f5416f191`；最新生产逻辑提交为
  `8578ccaa4a7a3160aa7d0e188315cd988e7bca71`。
- 结果目录：
  `D:\软件测试\legacy-cross-file-generalization-results\legacy-long-pulse-recheck-2026-08-08-v1`。
- 派生 config SHA-256：
  `adeb201bfe22848e135e6d86b0b68b89265cec980d2156a3a7b86226eda7c4c1`；
  manifest SHA-256：
  `fe23bcdc8632cde79ac94d7af94295817e402ddc05c762a6c6684a68735dcd3e`。

本轮复用 2026-08-07 已冻结的相同 24 个文件、48 条目标序列、场景、注入年份、事件顺序和
隐藏真值，只把 production protection 基线切换到当前提交。没有重新挑选文件或容易年份。
single 与 serial 共 48 个 worker 输出，源文件修改 0、保存重开差异 0、运行错误 0；ZSL141
9 项和 MCP17A 2 项定向回归均通过。

| single 指标 | 旧 Legacy | 当前 |
| --- | ---: | ---: |
| response | 420/1152（36.46%） | **428/1152（37.15%）** |
| operation accuracy / 全事件 | 287/1152（24.91%） | **315/1152（27.34%）** |
| operation accuracy / 已回答 | 287/420（68.33%） | **315/428（73.60%）** |
| 唯一主窗口覆盖 | 167/1056（15.81%） | **170/1056（16.10%）** |
| 条件窗口覆盖 | 167/287（58.19%） | **170/249（68.27%）** |
| Top1 | 35/1056（3.31%） | **40/1056（3.79%）** |
| 断点绝对误差 median / P90 | 5 / 130 年 | **3 / 34 年** |
| 断点有符号偏差 | +25.52 年 | **+8.92 年** |
| clean review 误报 | 17/48（35.42%） | **16/48（33.33%）** |

当前 single 汇总中的全事件窗口宽度 P90 为 295 年，是统计器把 whole-series 的整条
`selectedRange` 混入窗口宽度所致，不表示局部主窗口扩宽；局部事件仍只输出 5/7/9/13 年。
serial 的局部窗口 median/P90 仍为 13/13 年。

| 真值类型 | 旧：正确操作 | 当前：正确操作 | 关键类型变化 |
| --- | ---: | ---: | --- |
| missingRing | 252/816 | **184/816** | missing -> whole 从 4 增至 34 |
| falseRing | 19/96 | **38/96** | false -> missing 从 24 降至 3 |
| partialMove | 16/144 | **27/144** | partial -> missing 从 40 降至 25；partial -> whole 从 2 增至 13 |
| wholeSeriesMove | 0/96 | **66/96** | whole -> partial 从 21 降至 7 |

因此当前修改已经解决了用户观察到的两条主要错误方向的一部分：whole 不再普遍被压成
partial，partial 也较少被压成 missing；但 whole 恢复发生了过度补偿，开始吞掉真实
missing 和 partial，尚不能视为完成。

证据审计进一步把 whole 候选分成两层。66 个正确 whole 中有 56 个来自通过 before/after
门且由重复 COFECHA 终端 lag 锚定的 whole baseline；错误 whole 中只有 15 个有该锚定。
其余弱 whole 仅来自 global sliding 或 propagation pattern：正确 10 个、错误 37 个；13 个
partial -> whole 全部属于这一弱层。当前 `keepWholeSeriesEvent` 对“没有同时形成局部事件”的
弱 whole 直接保留，而通用 candidate hard gate 只要求七项改善中满足若干项，并不证明 lag
在整条序列两端和多数分段上均匀存在。这就是过度补偿的具体入口。

| serial 指标 | 旧 Legacy | 当前 |
| --- | ---: | ---: |
| confirmed | 179/768（23.31%） | **191/768（24.87%）** |
| ever correct window | 180/768（23.44%） | **195/768（25.39%）** |
| first response | 296/768（38.54%） | **310/768（40.36%）** |
| 首次回答操作准确率 | **290/296（97.97%）** | 276/310（89.03%） |
| 首次窗口覆盖 | 176/768（22.92%） | **189/768（24.61%）** |
| 完全恢复 series-scenario | **11/144（7.64%）** | 10/144（6.94%） |
| 至少恢复一个事件 | 63/144（43.75%） | **87/144（60.42%）** |
| 前序失败阻塞 | 456/768 | **443/768** |

下一轮不是降低 whole 总门槛或简单恢复旧优先级，而是为**无 COFECHA 终端锚定的 whole**
增加全区间状态一致性验证：候选 shift 必须得到较老端、较新端和足够多独立分段共同支持，
且不能被一个有边界的局部状态路径解释。终端锚定 whole、whole+local 复合顺序和已验证的
partial 均须单独保留回归，避免修掉过度补偿时重新回到 whole -> partial。

### Round 5B：用新端与全段状态共识过滤弱 whole

- 状态证据提交：`b2939d29fc9e72d498636c06dd1e14513cdcd9ee`。
- 正式门禁提交：`0958ab0facdf7c65562d2f8e655cccab58ab953e`。
- 冻结结果：
  `D:\软件测试\legacy-cross-file-generalization-results\legacy-whole-state-gate-2026-08-08-v1`。

非终端 whole 不再因为局部事件暂未形成就自动保留。候选 shift 必须得到最新两个可靠分段
共同支持，或同时得到 global best lag、按样本数加权的分段多数和按置信度加权的分段多数
支持；由重复 COFECHA 终端 lag 验证的 whole 保留独立通道。该门禁使 single 已回答操作准确率
由 315/428（73.60%）提高到 324/418（77.51%），clean review 从 16/48 降到 14/48；
missing -> whole 从 34 降到 14，partial -> whole 从 13 降到 0，false -> whole 从 5 降到 1。
真实 whole 的精确操作由 66/96 小幅降到 64/96，说明仍有两个弱 whole 缺少当前状态锚点。

门禁同时暴露了一个此前被错误 whole 偶然遮挡的下游问题。serial confirmed 从 191/768 降到
183/768；17 个丢失成功全部是 `multiDiscreteMissing4/8` 中的 missingRing。以
`russ046e/895112` 为例，恢复 1918 后会形成一个删除 1858 的候选：整体相关从
0.20552 降到 0.19844，dominant lag 从 -2 恶化为 -3，但它仍靠通用 hard-gate 的其他条件
通过，最终被定位器拉到 1739。旧弱 whole `+61` 并不正确，只是先把该伪轮候选当作不相连
补充项删掉，随后才由串行 missing 恢复接管。因此不能恢复弱 whole；必须修复自我恶化的
候选伪轮。一个保留 rejected-whole 方向信息的实验没有改变任何冻结案例，已由
`433d6d2e` 完整移除，没有留在生产管线。

### Round 5C：拒绝无路径支撑且令负 lag 自我恶化的候选伪轮

- 修复提交：`2be20485946931d6951a7e8425ac08ac3cb9ec75`。
- 冻结结果：
  `D:\软件测试\legacy-cross-file-generalization-results\legacy-self-worsening-false-gate-2026-08-08-v2`。
- 派生 config SHA-256：
  `e74bca573b019945425c6356e0e0a7ef552fe4c11a4ccf7f53d3abcbf60e6a1e`；
  manifest SHA-256：
  `f7534ee1dab1f73eaf5a2b75fbc9d27546e40d6eb18021beceaf2841a87faac3`。

门禁位于 candidate 与 lag path 汇合处，只过滤同时满足以下条件的 falseRing：没有独立
falseRing 路径支持、反事实整体相关不升、纠正前 lag 已小于 0，且删除后恰好从 `-n` 变成
`-(n+1)`。这表示删除操作让负向缺轮阶梯再恶化一年，与伪轮纠正方向矛盾。不能把
`wholeSeriesRDelta <= 0` 单独当门禁，因为冻结集中有四个真实 falseRing 也会轻微降低整体
相关；路径支持的案例和正常 `+1 -> 0` 纠正因此明确保留。

single 仍响应 418/1152，clean review 仍为 14/48，保存重开 1200/1200，说明收益不是靠
增加拒答或误报获得。操作正确由 324 增到 325，主窗口覆盖由 174 增到 175。逐案只有
`nh001/297072` 的 `multiDiscreteMissing2` 改变：从错误 falseRing 变为正确 missingRing，
且窗口覆盖 1877。真实 falseRing、whole 和 partial 的 single 输出逐案不变。

| serial 指标 | Round 5B | Round 5C |
| --- | ---: | ---: |
| confirmed | 183/768 | **187/768** |
| ever correct window | 185/768 | **189/768** |
| first response | 293/768 | **297/768** |
| first response operation correct | 262 | **268** |
| first response window covered | 177 | **181** |
| completely recovered series-scenario | 10/144 | 10/144 |
| series-scenario with any recovery | 86/144 | **87/144** |
| blocked by prior event | 451 | **447** |
| local window median / P90 | 13 / 13 | 13 / 13 |

四个新增 confirmed 没有对应损失：`russ046e/895112` 恢复 1875、1833，
`nh001/297072` 恢复 1903、1864。两条更旧缺轮从 `blocked_by_prior_event` 变成可回答但
窗口未覆盖，继续按失败统计。源文件修改 0、保存重开差异 0、错误 0；ZSL141 9 项、
MCP17A 2 项和本轮相关 Vitest/build 均通过。

本轮只修复 weak-whole 门禁暴露的 falseRing 回退，不代表类型建模已经完成。在相同冻结
single 中仍有 9 个 `wholeSeriesMove -> partialMove`、3 个 `wholeSeriesMove -> missingRing`、
25 个 `partialMove -> missingRing` 和 18 个 `partialMove -> falseRing`。下一步应回到 ZSL
RAW/crossdated 的真实编辑链，先从全序列 baseline 与有断点局部状态的生成语义区分入手，
再验证 whole 与 partial 共存时的操作顺序；不得靠降低 partial 或 missing 的统一门槛修补。

### Round 5D：用较新固定侧证据仲裁 whole 与 partial 的同状态别名

- 修复结果：
  `D:\软件测试\legacy-cross-file-generalization-results\whole-partial-arbitration-comparable-single-final-2026-08-08`。
- 对照结果：
  `D:\软件测试\legacy-cross-file-generalization-results\legacy-self-worsening-false-gate-2026-08-08-v2`。
- 严格复用对照目录保存的 config/manifest，SHA-256 分别为 `e74bca573b019945425c6356e0e0a7ef552fe4c11a4ccf7f53d3abcbf60e6a1e`
  和 `f7534ee1dab1f73eaf5a2b75fbc9d27546e40d6eb18021beceaf2841a87faac3`。

whole 与 partial 可能给出相同的负 lag 和位移量，但生成语义不同。whole 表示整条序列都处于
同一非零基线；partial 表示老侧处于该 lag，经过一个可定位断点后，较新固定侧回到原状态。
因此不再用候选总分直接决定二者，而按以下顺序仲裁：

1. 重复 COFECHA 终端 lag 已验证的 whole baseline 优先于没有独立边界锚点的 partial 别名。
2. candidate、COFECHA 分段、局部反事实、piecewise path 或重复块边界明确锚定的 partial
   保持优先，不能被弱 whole 吞掉。
3. 对其余 joint-grid partial，读取同一位移量的单侧反事实。若所谓“较新固定侧”仍明显偏向
   whole lag，`sideNewerAdvantage <= -0.1`，则该断点不成立，保留 whole；接近 0 或为正时
   仍由 partial 解释 whole 的全局 lag 别名。
4. 仲裁按 whole-partial 关系逐对执行。同一轮可以同时删除一个 whole 别名并删除另一个
   partial 别名，不再假设两类结果互斥。

另外，非终端 whole 的状态门禁增加严格分段多数通道：至少 8 个可靠分段、其中至少 5 个
支持同一 shift、支持比例大于 0.5、置信度加权比例大于 0.55。冻结证据中该条件恢复 7 个
弱但正确的 whole，错误 weak whole 的最高普通支持比例只有 0.5；平票继续拒绝。

| single 指标 | Round 5C | Round 5D |
| --- | ---: | ---: |
| response | 418/1152 | 418/1152 |
| type correct | 327/1152 | **338/1152** |
| operation correct | 325/1152 | **336/1152** |
| 唯一主窗口覆盖 | 175/1056 | 175/1056 |
| 条件窗口覆盖 | 175/261 | 175/261 |
| Top1 | 41/1056 | 41/1056 |
| clean strict / review | 15/48 / 14/48 | 15/48 / 14/48 |
| 保存重开一致 | 1200/1200 | 1200/1200 |

逐案只有 11 个操作变化，全部由错误类型变为精确 whole `-4`，没有损失：9 个
`whole -> partial` 和 2 个 `whole -> missing` 被修复。whole 的最终混淆为正确 76/96、
拒答 19/96、误判 missing 1/96；`whole -> partial` 已为 0。partial 的逐案输出完全不变：
正确 30/144、拒答 71/144、误判 missing 25/144、误判 false 18/144，没有新增
`partial -> whole`。响应率、窗口、clean 对照和所有保存重开结果均未变化，源文件修改 0、
运行错误 0。

MCP17A 连续 9 年缺块保存前后仍输出 `partialMove -9`；ZSL141 的 `-6/-11/-16/-20/-30`
保存回归、`whole + partial -4` 共存、co612 多个离散缺轮串行恢复和物理缺块 `-2...-100`
均通过。相关单元测试 43 项、真实文件回归 34 项通过。

本轮已经关闭 frozen single 中的 whole -> partial 混淆，但没有处理 partial -> missing/false。
下一轮应比较“单个连续缺块的一个大状态跃迁”和“多个单位缺轮/伪轮形成的阶梯或脉冲”：
先确认 partial 候选是否形成，再区分它是在 operation recovery 中丢失，还是形成后被单位事件
优先级覆盖。不能通过统一压低 missing/false 或扩大 partial 门槛来交换错误。

### Round 5E：区分一次连续缺块与多个离散缺轮形成的 lag 阶梯

- single 候选结果：
  `D:\软件测试\legacy-cross-file-generalization-results\legacy-partial-staircase-complexity-gate-single-2026-08-08`。
- serial 最终结果：
  `D:\软件测试\legacy-cross-file-generalization-results\legacy-partial-staircase-distinct-mode-workers-2026-08-08\serial`。
- PRB07A 隔离审计：
  `D:\软件测试\legacy-cross-file-generalization-results\partial-staircase-serial-prb07a-distinct-mode-2026-08-08`。

逐阶段审计表明，12 个 physical partial 被报成 missing 的主要路径不是 partial 没有形成，
而是 `recoverSequentialMissingHeadEvent` 在融合、端点门禁和显示层之后又用一个高自由度
单位 lag 路径替换了已经成立的 direct partial。对每个额外状态转移计算
`gainOverDirect / max(1, transitionCount - 1)` 后，错误 physical partial 的最高值为 0.762，
头部 `-1` 状态最长 28 年。因此，同一个断点模式内，阶梯只有满足以下任一条件才可覆盖
direct partial：

1. 每个额外转移的收益至少为 0.8；
2. 最后一个 `-1` 单位状态连续稳定至少 30 年。

这不是偏爱小位移。direct partial 的 `-4/-10` 位移量仍完整保留；门禁惩罚的是用很多自由
断点解释一个本来可由一次状态跃迁解释的连续缺块。single 中 6 个错误 missing 因而恢复为
精确 partial，另 1 个错误 missing 改为拒答，没有旧正确案例损失。最终 single 为：响应
417/1152、类型正确 344/1152、操作正确 342/1152、唯一主窗口覆盖 181/1056、条件覆盖
181/267、Top1 41/1056；clean strict/review 仍为 15/48、14/48。partial 混淆变为正确
36/144、拒答 72/144、missing 18/144、false 18/144。

单纯使用复杂度门禁会在 serial 中损失 `cana212/PRB07A` 的 1866 缺轮。前三个较新缺轮
1922、1904、1885 已确认后，当前融合层选择的 partial 模式中心为 1851；但阶梯头 1863
另有一个精确候选，13 年主窗 1857-1869 覆盖真值。二者相距 12 年，不是同一个断点模式。
因此新增一个严格的“已确认历史下的独立前沿”通道，必须同时满足：

1. 阶梯头与当前 selected partial 模式中心相距至少 9 年；
2. 阶梯头的新侧已有至少 2 个目标序列显式 0，表示用户先前确认的缺轮历史；
3. 距阶梯头不超过 2 年存在位移深度与 transition count 一致的候选。

三个条件只读取当前 working series、候选和 lag 路径，不读取注入真值。它也不会把一组
隐藏真值作为自动操作列表暴露给 UI。若 partial 与阶梯解释同一断点，仍必须通过前述复杂度
门禁；若只有确认历史而没有独立模式或深度一致候选，也不能拆分 partial。

该通道使 serial confirmed 从 186 恢复到 187、首次正确窗口从 180 恢复到 181、首次操作
正确从 265 增到 267，没有 confirmed 损失。PRB07A 1866 在第 4 轮恢复，随后 1848 首次
变为可回答但窗口未覆盖，仍按失败统计。相对 Round 5C，confirmed 187 和首次正确窗口 181
已完全恢复；唯一剩余轨迹差异是 `or052/JCT11A` 1922 原先有一个操作类型正确但窗口不覆盖、
最终也不能确认的响应，现在改为拒答。24 文件 single 的 1200 个 before-save case 在加入独立
前沿通道前后逐案变化为 0，说明 serial 历史条件没有泄漏到干净 single。

基准 worker 增加可选 `--audit-output`，并让 `--scenario-kind` 可限制 serial 场景；
`--series-id` 在 serial 中只限制审计记录，不从全文件 active series 中删除其他样芯。这样可在
不改变 FIFO 队列、参考构建和 COFECHA 输入的前提下保存每轮 candidate、fusion、endpoint、
display 和 locator 全链路快照。

本轮关闭的是 `partial -> missing` 的最终阶梯覆盖路径。冻结 single 仍有 18 个
`partial -> falseRing`，其失败发生得更早：精确 `-4/-10` partial 已在
`candidateProjectedEvents` 中形成，但 operation fusion 选择了一个删除后仍保持负 lag 的
falseRing。下一轮必须修复 fusion 的操作方向与状态路径解释，不能复用本轮 serial 历史门禁。

### Round 5F：同断点单位近似不得覆盖决定性的局部阶跃

- 生产 baseline 审计：
  `D:\软件测试\legacy-cross-file-generalization-results\partial-false-operation-grid-production-baseline-2026-08-08`。
- 24 文件 single：
  `D:\软件测试\legacy-cross-file-generalization-results\legacy-partial-unit-colocated-gate-single-2026-08-08`。
- 24 文件 serial：
  `D:\软件测试\legacy-cross-file-generalization-results\legacy-partial-unit-colocated-gate-serial-2026-08-08`。
- ZSL RAW -> crossdated 串行回放：
  `D:\软件测试\ZSL\window-coverage-results\zsl-serial-operation-partial-unit-colocated-gate-2026-08-08`。

Round 5E 剩余的 18 个 `partial -> false` 不是同一种失败。以 `az101/413021` 的 `-4`
局部移动为例，完整 `year x operation` 网格已经把 `partialMove -4 @ 1851` 选为稳定全局
赢家，动态分数 0.205、相对单位族 margin 0.168、相邻位移 margin 0.085；但是旧的
`dynamic_unit_fallback` 允许分数仅 0.037 的 `falseRing +1 @ 1851` 覆盖它。一个单位编辑
确实能近似多年份移动的第一年，因此“单位操作自由度更低”不能单独作为最终优先级。

融合层现在先识别**决定性的同断点局部阶跃**。只有同时满足以下条件，单位回退才不得覆盖
局部移动：

1. 较新固定侧 baseline lag 为 0；
2. 动态网格的主操作为 `partialMove`，总分通过现有 presence 门槛；
3. 该位移相对其他 98 个负向位移稳定，shift margin 至少 0.035；
4. partial 相对最强单位操作的 family margin 至少 0.075；
5. partial 与单位近似的最佳断点相距不超过 2 年。

该规则不按位移绝对值惩罚，也不偏爱 `-4/-10`。`-50/-100` 只要满足相同证据即可保留；
非零整体 baseline、远距离模式竞争、位移不稳定以及已有独立单位路径仍走原仲裁。基准审计
新增可选 operation grid，并严格复用生产融合的 baseline 语义；保存重开只计算一次昂贵网格，
不会改变诊断输入或普通 benchmark 性能。

| single 指标 | Round 5E | Round 5F |
| --- | ---: | ---: |
| response | 417/1152 | 417/1152 |
| type correct | 344/1152 | **346/1152** |
| operation correct | 342/1152 | **344/1152** |
| 唯一主窗口覆盖 | 181/1056 | **183/1056** |
| 条件窗口覆盖 | 181/267 | **183/269** |
| Top1 | 41/1056 | **42/1056** |
| clean strict / review | 15/48 / 14/48 | 15/48 / 14/48 |
| 保存重开一致 | 1200/1200 | 1200/1200 |

1200 个 before-save 状态逐案只有两个变化，均为完整修复，没有旧成功损失：

- `az101/413021`：`falseRing +1 @ 1851` 改为精确 `partialMove -4 @ 1851`，窗口
  1844--1856 覆盖真断点，Top1 正确。
- `cana212/PRB07A` 连续缺块：`falseRing +1 @ 1848` 改为精确
  `partialMove -10 @ 1861`，窗口 1850--1862 覆盖真断点 1860。

partial 的混淆由正确 36/144、拒答 72、missing 18、false 18 改为正确 **38/144**、
拒答 72、missing 18、false **16**。whole 仍为正确 75/96、拒答 19、missing 1，
`whole -> partial` 保持 0。24 个 single worker 的运行错误、源文件修改和保存重开差异均为 0。

serial 的 768 个事件状态相对 Round 5E 逐案零变化：confirmed 187、ever correct window 189、
首次回答 296、首次操作正确 267、首次窗口覆盖 181、blocked by prior event 447。说明新门禁
没有把多个离散缺轮重新压成连续缺块。

ZSL 两种参考模式各完成 34/34 保存重开；严格 exact-reconstruction 真值在两种模式下均为
whole 3/3、partial 1/1、missing 5/6、false 2/2，whole -> partial 与 partial -> missing 均为
0。RAW 与 crossdated SHA-256 运行前后不变。相关 operation fusion、ZSL、ZSL141、MCP17A、
co612 和 `-2...-100` 物理缺块共 140 项通过，Legacy evaluator 6 项、Legacy typecheck 和
production build 通过。

这一步只关闭“同一断点的单位近似覆盖决定性 partial”这一条路径。剩余 16 个
`partial -> false` 中，一部分已经选对位移但断点与单位峰属于远距离模式，一部分在 fusion
前已形成 false，还有一部分连动态位移族都选错。下一轮应把 candidate/COFECHA 边界锚点与
同区域 operation family 联合起来，先选唯一位置模式，再在该模式内比较 `+1/-1/-2...-100`；
不能继续单纯放宽本轮 family margin 或断点距离。

### Round 5G：用候选、完整操作网格与逐参考芯边界共识恢复剩余局部缺块

- 全量校准审计：
  `D:\软件测试\legacy-cross-file-generalization-results\candidate-grid-per-reference-full-calibration-2026-08-08`。
- 24 文件 single：
  `D:\软件测试\legacy-cross-file-generalization-results\legacy-candidate-grid-reference-partial-single-workers-2026-08-08`。
- 24 文件 serial：
  `D:\软件测试\legacy-cross-file-generalization-results\legacy-candidate-grid-reference-partial-serial-workers-2026-08-08`。
- ZSL RAW -> crossdated 串行回放：
  `D:\软件测试\ZSL\window-coverage-results\zsl-serial-candidate-grid-reference-partial-2026-08-08`。
- co612 whole/local 组合：
  `D:\软件测试\co612-operation-composition-results\candidate-grid-reference-partial-local6-2026-08-08`、
  `candidate-grid-reference-partial-missing-2026-08-08`、
  `candidate-grid-reference-partial-false-2026-08-08`。

Round 5F 后仍有一些精确 partial 候选在融合前已经形成，但只靠候选不能决定它是否应覆盖
lag path 的单位解释。反过来，完整 master 网格与逐参考芯网格也可能共同追随同一个远端伪峰。
因此新增的恢复层要求三个职责不同的证据同时成立：

1. **可执行候选**：所有已投影候选都属于负向 `partialMove`，至少一个候选通过既有 hard
   gate、相关增益至少 0.04，并与动态网格选择相同位移；候选断点与网格断点相距不超过 6 年。
2. **完整操作网格**：在 `missingRing -1`、`falseRing +1` 和 `partialMove -2...-100`
   的同尺度比较中，partial 动态分数至少 0.08，相对单位族 margin 至少 0.05，相邻位移
   margin 至少 0.01。位移量保持原值，不按绝对值偏爱小缺块。
3. **逐参考芯边界**：只在前两层已经命中后计算每条可靠参考芯的反事实边界，动态断点处
   至少有 6 条参考，5 年峰核集中度至少为 1/3。该二级计算复用缓存，不对所有普通诊断
   无条件扫描。

任何 whole 候选都会阻止该恢复层。已有局部事件若有可执行候选 ID 或 hard-gate 锚点也不会
被覆盖；只有纯 lag-path/reference 的无锚解释才可由三层共识替换。这样既能把错误的单位
阶梯或 `-96` 参考峰改回一次物理缺块，也不会删除已经独立确认的混合事件。恢复出的唯一主窗
以最近的可执行候选锚点生成 13 年搜索窗，再由正式 counterfactual locator 精定位；窗口内
Top1 仍由逐年证据排序。显示层复核相同的 score、family margin、shift margin、参考数和
5 年核，并要求最终窗口覆盖 operation 模式。候选锚点允许在精定位后落到窗口外，但候选与
operation 之间仍必须保持不超过 6 年的一致关系。

完整校准的 1,200 个保存前状态中，动态网格共有 390 个 partial 赢家。候选/网格基础共识
只命中 24 个，24/24 真值均为 partial，clean、missing、false、whole 命中均为 0；加上
逐参考芯 5 年核后命中 17 个。生产全链路相对 Round 5F 只有以下 7 个状态变化，全部修复：

| 序列与场景 | Round 5F | Round 5G | 真断点 / 新窗口 |
| --- | --- | --- | --- |
| `mt148/012` 连续缺块 | 拒答 | `partial -10` | 1718 / 1707--1719 |
| `mt148/014` 连续缺块 | `missing -1` | `partial -10` | 1743 / 1741--1745 |
| `az101/413022` 连续缺块 | `missing -1` | `partial -10` | 1840 / 1839--1851 |
| `co066/472212` 连续缺块 | `missing -1` | `partial -10` | 1732 / 1722--1734 |
| `cana212/PRB04A` 单次局部移动 | `false +1` | `partial -4` | 1856 / 1847--1859 |
| `cana212/PRB07A` 单次局部移动 | `false +1` | `partial -4` | 1870 / 1862--1874 |
| `az581/PRM07A` 连续缺块 | `missing -1` | `partial -10` | 1892 / 1888--1900 |

| single 指标 | Round 5F | Round 5G |
| --- | ---: | ---: |
| response | 417/1152 | **418/1152** |
| type correct | 346/1152 | **353/1152** |
| operation correct | 344/1152 | **351/1152** |
| 唯一主窗口覆盖 | 183/1056 | **190/1056** |
| 条件窗口覆盖 | 183/269 | **190/276** |
| Top1 | 42/1056 | **43/1056** |
| clean strict / review | 15/48 / 14/48 | 15/48 / 14/48 |
| 保存重开一致 | 1200/1200 | 1200/1200 |

partial 混淆由正确 38/144、拒答 72、missing 18、false 16 改为正确 **45/144**、
拒答 **71**、missing **14**、false **14**。whole 保持正确 76/96、拒答 19、missing 1，
`whole -> partial` 仍为 0。24 个 worker 的错误、源文件修改和保存重开差异均为 0；累计
生产运行时间没有增加。serial 的 768/768 个事件状态与 Round 5F 逐字段相同：confirmed
187、首次响应 296、首次操作正确 267、首次窗口覆盖 181、最终阻塞 447。

ZSL 两种模式均为 whole -> partial 0、partial -> missing 0，34/34 保存重开稳定，源 SHA
不变。co612 的 `whole + partial -6`、`whole + missing`、`whole + false` 各 120 个组合均
先输出精确 whole，whole -> partial 与 whole -> unit 均为 0，交互失败 0；应用 whole 后的
局部窗口成功率分别为 83.33%、93.33%、83.33%，与各自 pure-local 控制完全一致。

本轮关闭的是“候选已给出真实连续缺块，但弱 path/reference 模式仍让最终结果拒答或变成
单位事件”这一类失败。剩余 partial 错误主要是候选、master 网格和参考芯共同选错远距离模式，
不能再靠放宽本恢复层解决；下一步应研究位置模式的独立反证或直接进入不同操作共存的联合
状态路径验证。

### Round 5H：从局部状态路径恢复较新固定侧的整体基线

- 阶段审计提交：`a38051fc`。
- 固定输入：EBD、EBM、RDM、RDU、EBU、ZSD 六个站点，每站 3 条按值无关规则选择的
  样芯；整体位移固定为 `+2`，分别与 partial、missing、missing+partial 共存，共 54 例。
- 全矩阵继续使用同一 18 条样芯的 10 种场景，共 180 case、396 个事件真值；clean 对照
  18 条。所有真值仅用于构造和评分，不进入参考、候选、门槛或窗口。

阶段审计确认，失败并不是一个正确 whole 候选在后处理被删除。基线 54 例中只有 26 例
产生精确整体位移，错误位移为 0，另外 28 例根本没有 whole 候选；其中 20 例最终只剩
partial，18 例同时或单独剩下单位事件。典型状态为：

```text
truth: whole +2 + partial -2
path:  older lag 0 -> newer fixed-side lag +2
old interpretation: partial -2 only
new interpretation: whole +2 baseline, plus partial -2 local transition
```

不能使用 `newestLagDiagnosis` 或最末分段直接补候选。端点缺测时该汇总在 EBD011 给出
`newestLag=8`、分段边缘甚至 `-42`，而局部路径转移稳定地给出 `0 -> +2`。本轮使用以下
统一推断：

1. 只读取 `piecewise_lag_path` 中操作语义精确一致的转移：missing 必须为 `-1 -> 0`
   的相对形式，false 为 `+1 -> 0` 的相对形式，partial 必须满足
   `shiftYears = lagBefore - lagAfter <= -2`。
2. 取最新可靠转移的 `lagAfter` 作为较新固定侧 baseline；它必须非零、位于 whole lag
   范围内、至少有 18 年较新侧上下文，并达到既有路径分数和样本对数门槛。
3. 该 baseline 只生成一个内部 whole 草案，不直接生成事件。先尝试现有单操作
   `evaluateDraft` hard gate。
4. whole 单独应用可能仍留下真实局部异常，因而不能要求它独自解决全部问题。若普通 hard
   gate 不通过，则沿连通状态链从新到老应用所有局部纠正，再应用 whole；只有最终全局
   best lag 精确回到 0、问题段不增加，且整体相关、平均分段相关或问题段数量有实质改善，
   才允许通过 joint composition gate。
5. 联合验证只赋予候选资格，最终 whole 仍是完整 before/after 证据支持的可执行候选；
   ordinary whole、COFECHA terminal whole 和局部事件的既有门槛均未降低。
6. 事件编排中新恢复的候选通过显式 supplemental sink 返回 `diagnosis.candidates`。whole
   事件引用的 candidate ID 因而始终可在 UI 执行列表中找到，避免出现“能显示但应用失败”。

54 个整体共存案例结果：

| 指标 | 修复前 | Round 5H |
| --- | ---: | ---: |
| 精确 whole shift | 26/54 | **54/54** |
| 错误 whole shift | 0/54 | **0/54** |
| 完全没有 whole | 28/54 | **0/54** |
| whole 缺失且只/同时报 partial | 20/54 | **0/54** |
| whole 缺失且只/同时报单位事件 | 18/54 | **0/54** |
| partial + whole | 未全覆盖 | **18/18** |
| missing + whole | 未全覆盖 | **18/18** |
| missing + partial + whole | 未全覆盖 | **18/18** |

完整 180 case 矩阵中，修复不仅补回 28 个 whole，也使 whole baseline 下的局部状态不再
被错误融合：

| 指标 | 修复前 | Round 5H |
| --- | ---: | ---: |
| 响应率 | 174/180 = 96.67% | **174/180 = 96.67%** |
| 事件召回 | 243/396 = 61.36% | **283/396 = 71.46%** |
| 事件精确率 | 243/316 = 76.90% | **283/342 = 82.75%** |
| 完整案例成功 | 69/180 = 38.33% | **87/180 = 48.33%** |
| missing 匹配 | 85/144 | **94/144** |
| false 匹配 | 71/108 | **71/108** |
| partial 匹配 | 61/90 | **64/90** |
| whole 匹配 | 26/54 | **54/54** |
| clean false positive | 3/18 | **3/18** |

clean 的 3 个提示仍是原有的 EBM131 false、RDM022 missing 和 RDU012 missing，没有新增
wholeSeriesMove。窗口中位数仍为 9 年；whole 的全序列范围不计作局部复核窗口宽度。

回归结果：路径组合门槛与 EBD011 确定性回归 3 项、事件融合与 COFECHA 67 项、ZSL
RAW/crossdated 真实操作 13 项、co612 多离散缺轮/mtr841/连续缺块 `-2...-100` 11 项通过。
ZSL091/092/111/112 继续保持真实 whole，ZSL212 保持 partial `-4`，ZSL152 保持 false；
mon052 的九级离散缺轮没有被重新压成 partial 或 whole。

本轮解决的是“已有可靠局部状态链，但无 COFECHA terminal/global candidate 时 whole baseline
完全缺失”的表示问题。当前 54 例尚未包含 false+whole、false+partial+whole、负向 whole
和不同 whole 幅度；下一轮必须扩展这些方向、位置与幅度，不能把本轮 `+2` 的 54/54 当作
所有组合已经完成。

### Round 5I：用双视图固定侧证据消除整体与局部基线混淆

Round 5H 扩展到 false、双单位事件、正负方向和不同幅度后，剩余失败不再是 whole 缺失，
而是局部状态被错误当作 whole baseline。典型失败有两类：

```text
truth: whole -2 + partial -3 + unit events
wrong: whole -5                # 把 older residual state 当成整体基线

truth: whole -2 + missing + false
wrong: whole -1                # 把单位阶梯中间状态当成整体基线
```

正确的 `-2` 在这些案例中已经存在于较新固定侧，但不同候选族的原始 score 没有共同标尺，
最后选择器仍会让局部路径候选获胜。本轮统一了生成、仲裁和最终选择：

1. 在目标序列最近端分别使用 20、21、22、23 年嵌套窗口估计 lag。该恢复扫描只使用
   `±10` 的短范围以控制端点噪声，不改变正式 whole 与 partial 的 `±100/-2...-100`
   搜索范围；至少 3 个窗口同意且无同强度竞争模式才形成草案。
2. 局部事件继续使用 COFECHA-core 路径，whole fixed side 同时在原始 diagnosis 路径中
   估计。两种视图都只产生假设，必须经过完整 before/after 或联合事件链反事实。
3. 若路径由真实 `partialMove` 转移锚定，它比孤立短尾峰更可靠。例如 RDM141 的真值
   `whole +5 + partial -4` 保留路径 `+5`，不会被短尾伪峰 `-9` 覆盖。
4. 若 COFECHA 路径只由 missing/false 单位阶梯锚定，而 `pathLag - tailLag` 是
   `-2...-maxPartialGapYears` 的合法负向 residual partial，则整体基线取 tailLag，局部差值
   留给 partial。禁止把这个负向 residual 吸收到 whole。
5. 4/4 一致、无竞争且中位相关至少 0.70 的短尾可压过单位路径基线；短尾与全序列 lag
   同时一致时，中位相关门槛为 0.45。较新侧独立分段 lag 为 0 时，普通 path-fixed whole
   仍被拒绝，防止干净序列和纯局部移动产生虚假整体移动。
6. 所有通过门槛的 whole 候选使用统一证据族优先级：COFECHA terminal、tail+global、
   tail+residual partial、tail+path terminal、partial 锚定路径、tail 联合链、单位锚定路径、
   普通 hard gate。只有同一证据族内才比较原始 score。
7. supplemental sink 不再只按 candidate ID 去重。同一位移假设用更强证据替换，位移不同
   的假设允许同时进入内部选择；UI 仍只显示最终唯一 whole 操作。

泛化矩阵固定使用 EBD、EBM、RDM、RDU、EBU、ZSD 六个站点，每站 3 条按值无关规则选择的
样芯。每个位移分别构造 missing+whole、false+whole、partial+whole、missing+false+whole、
false+partial+whole、missing+false+partial+whole 六种场景，共 108 例：

| whole shift | 精确位移 | 错误位移 | 缺失 whole | clean false positive |
| ---: | ---: | ---: | ---: | ---: |
| `-5` | **108/108** | 0 | 0 | 3/18 |
| `-2` | **108/108** | 0 | 0 | 3/18 |
| `+2` | **108/108** | 0 | 0 | 3/18 |
| `+5` | **108/108** | 0 | 0 | 3/18 |
| 合计 | **432/432** | **0** | **0** | 未高于既有 3/18 |

真实数据回归保持：ZSL RAW/crossdated 13/13，ZSL091 `whole -9`、ZSL092 `whole -6`、
ZSL212 `partial -4`、ZSL152 false 均未改变；co612 11/11，mon052 九个离散缺轮和 mtr841
连续恢复没有被压成 partial，多个断点的物理缺块 `-2...-100` 也没有转成 missing。

当前代码另以 co612 原文件直接运行一轮自举扫描，源 SHA-256
`36e6c6a9d0cbc16d1870a1662da553a7b40d5578ea9ede25ff790c556c34667d` 前后不变；clean
strict 为 16/55，review 为 **2/55**，均未高于冻结基线的 18/55 和 3/55。第一轮仍正确
选择 `mon022:1977`。该检查只用于 current-code clean 与首轮响应，不声称当前代码逐字段复现
旧提交的 400 轮冻结轨迹。

本轮证明 fixed-side baseline 可以在整体移动与多个局部事件混杂时稳定恢复，但 432/432
只表示整体位移量正确，不代表同一批案例的所有局部事件和窗口都已达到同等召回。局部窗口
仍按各自定位器单独评估，不能用 whole 的全序列范围计入 5--13 年窗口指标。

### Round 5J：当前组合覆盖审计与后续顺序冻结

本轮没有修改生产算法。依据当前测试代码、co612 结果目录、ZSL 真值回放和 Round 0--5I
日志，逐项检查 A0--D4。状态含义如下：

- **系统覆盖**：已有 co612 多样芯、位置/位移分层和前序回归；关键结论有确定性测试。
- **部分覆盖**：至少有真实或跨文件案例，但未覆盖全部顺序、间距、位置，或只证明 whole
  shift 而未证明应用后的局部事件。
- **空白**：没有与该 ID 语义一致的系统基准，不得用相邻场景结果代替。
- **不可辨识边界待标注**：已有数值混淆风险，但基准尚未把可辨识与不可辨识样本分开。

| ID | 当前状态 | 已有证据 | 缺口 / 下一步 |
| --- | --- | --- | --- |
| A0 | 系统覆盖 | co612 clean current-code review 2/55 | 继续作为每轮误报门禁 |
| A1--A5 | 系统覆盖 | 单事件、ZSL、mon052/mtr841 串行与整体单操作 | 保持回归 |
| A6 | 部分覆盖 | 跨文件 `multiple-false-far` | 缺 co612 多伪轮串行与相邻压力 |
| A7 | 部分覆盖 | 多个真实/合成 partial 单案例 | 缺两个独立 partial 的系统矩阵 |
| B1--B3 | 系统覆盖 | co612 各 10 样芯 x 4 whole shift x 3 位置；Round 5I 外部矩阵 | 保持 whole-first 与应用后局部回归 |
| B4--B5 | 系统覆盖 | co612 两种顺序 x 3 间距 x 3 位置，含串行保存 | 将短脉冲不可辨识状态继续单列 |
| B6 | 部分覆盖 | mon052/mtr841 自然多缺轮、跨文件远距双缺轮 | 缺同一冻结矩阵中的相邻/2--4/5--13/>=14 年分层 |
| B7 | 部分覆盖 | 跨文件远距双伪轮 | 缺 co612 系统矩阵和“不得生成正向 partial”门禁 |
| B8--B9 | 部分覆盖 | 跨文件各一个固定顺序、固定位置组合 | 两种日历顺序和间距分层均未完成 |
| B10 | 空白 | 无系统性双 partial 基准 | 建立位移量、断点间距与可分辨性矩阵 |
| C1--C3 | 部分覆盖 | Round 5I 的 whole shift 432/432 包含固定顺序 | 缺局部顺序交换及应用 whole 后串行恢复 |
| C4 | 部分覆盖 | `missing-false-partial-far` 一个顺序 | 缺 6 种日历顺序 |
| C5 | 空白 | 无 whole + 两个同向单位事件矩阵 | 在 B6/B7 完成后加入 whole 基线 |
| C6 | 空白 | 无 whole + 两个 partial 矩阵 | 在 B10 完成后加入 whole 基线 |
| D1 | 部分覆盖 | Round 5I 固定 missing -> false -> partial，whole 432/432 中占 72 例 | 缺其余 5 种顺序和应用后局部恢复 |
| D2--D4 | 空白 | 无与定义一致的系统基准 | 最后建立重复缺轮、重复伪轮、双 partial 压力矩阵 |

审计同时确认现有 `eventMixed.experiment.test.ts` 的大矩阵主要是并行诊断评估；它不能代替
“先应用 whole、重新运行 COFECHA、再恢复局部事件”的串行证据。后续每个组合必须分别报告：

1. 首次主操作与 whole shift（若有 whole）。
2. 每次只应用一个正确前沿事件后的下一主操作、位移和窗口。
3. 与对应单事件控制相比的响应、操作、窗口损失。
4. save/reopen 稳定性、clean 2/55 门禁和已完成场景差异。
5. 相邻或上下文不足时是否正确标为不可辨识，而不是强制输出 partial 或单位事件。

后续顺序冻结为：B6 missing+missing -> B7 false+false -> B8/B9 单位+partial 两种顺序 ->
B10 partial+partial -> C1--C6 -> D1--D4。每轮只允许针对当前失败族修改算法；若破坏前一轮，
该轮不得提交为改进。全部 co612 规则冻结后，再运行同一完整矩阵的跨文件 ITRDB 验证。

### Round 5K 基准：B6 同向双缺轮阶梯

`benchmark:co612:unit-pulse` 扩展为显式 `--orientations`，新增
`missingThenMissing` 与 `falseThenFalse`，默认值仍是原有的
`missingThenFalse,falseThenMissing`，因此旧 B4/B5 命令语义不变。真值 round-trip 不再假定
固定 1 个零值，而按缺轮数量验证；间距允许 1 年，并将该层标记为
`operation-unidentifiable`，不强迫它输出两个 missingRing。

B6 首个 truth-blind smoke 使用 co612 的 `mon151`、3 年间距和老/中/新三个位置。源 SHA
前后不变，66 个保存重开状态全部稳定，clean review 为 2/55。结果为：

| 指标 | 结果 |
| --- | ---: |
| 单缺轮控制操作正确 | 6/6 |
| 单缺轮控制窗口覆盖 | 5/6 |
| 双缺轮首次响应/窗口覆盖 | 1/3 |
| 两个控制均覆盖的组合 | 2/3 |
| 其中组合交互失败 | 1/2 |
| 完整串行恢复 | 1/3 |
| partial / whole / 反向单位误判 | 0 / 0 / 0 |

当前失败首先表现为拒答，不是把双缺轮压成 partial。该 1 条样芯结果只验证基准链路，不用于
修改门槛；下一步运行 10 条样芯、间距 1/3/9/21 和三个位置的冻结生产基线，再按候选形成、
严格层、review 层与参考支持分类拒答。

### Round 5L：用逐参考芯反事实竞争拆分同向双缺轮

完整生产基线冻结在
`D:\软件测试\co612-operation-composition-results\b6-missing-pair-full-baseline-a496ac93-2026-08-09`，
修复后的同配置结果在
`D:\软件测试\co612-operation-composition-results\b6-missing-pair-full-isolated-fallback-final-dev-2026-08-09`。
两次都使用同一个 co612 SHA-256
`36e6c6a9d0cbc16d1870a1662da553a7b40d5578ea9ede25ff790c556c34667d`，包含 10 条样芯、
老/中/新三个位置和 1/3/9/21 年间距；源文件运行前后不变，错误 0，保存重开 100%，clean
review 都是 2/55。240 个单缺轮控制保持操作 240/240、窗口 210/240，因而组合变化没有依靠
放宽单事件显示门槛。

基线的主要问题不是候选不存在，而是两个同向 `-1` lag 阶梯经常被压缩成一个
`partialMove -2`。在 gap=9/21 的 60 个案例中，6 个被报为 partial；其中 mtr712 和 mtr832
的两个单事件控制都正确，但组合后仍被连续缺块模式抢占，属于干净的组合交互失败。旧的显式
竞争只用平均 master 选择年份对，而且发生在旧顺序恢复分支之后；相邻参考芯对年份平台的偏移
被平均后，正确模式即使得到大多数单芯支持也无法进入最终仲裁。

本轮只在主管线已经形成精确 `partialMove -2`，且原有恢复器最终拒绝拆分时增加第二层竞争：

1. 保留用户逐轮确认使用的“较新到较老”年份坐标语义；旧窄窗/master 竞争完全不变，继续负责
   mon121、mon162 和 mtr841 等已经验证的自然逐轮恢复。
2. direct partial 仍限制在当前事件窗内；双阶梯仅在事件窗较老侧最多 17 年、较新侧最多 4 年
   的有限区域枚举，且必须受 lag path 的近似头部约束，不进行全序列无界两两搜索。
3. 每个年份对分别与每条参考芯评分。对同一参考芯，双阶梯必须击败该参考芯自己的最佳 direct
   partial，而不是只与平均 master 选出的一个 direct 年份比较。
4. 唯一模式按参考芯 margin 的中位数、下四分位、支持数和 master 分数依次选择。自动拆分还
   要求至少 8 条参考芯、支持率不低于 80%、中位增益不低于 0.02、下四分位增益不低于
   0.005，并同时通过局部 lag 阶梯增益与中间状态优势。
5. 原有 head recovery、窄窗显式竞争和 candidate/marker 安全门全部先运行；只有它们最终要
   保留 partial 或拒答，且当前没有既有单位事件和 whole 时，高共识分支才作为 fallback 运行。
   因此新增分支只填补旧空白，不重排旧成功窗口。

| B6 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 全 120 例响应 | 114/120 | 114/120 |
| 全 120 例操作正确 | 63/120 | **70/120** |
| 全 120 例主窗口覆盖 | 57/120 | **62/120** |
| 全 120 例 partial 误判 | 50/120 | **43/120** |
| 全 120 例完整串行恢复 | 56/120 | **58/120** |
| gap=9 操作 / 窗口 / partial | 26/30 / 24/30 / 4/30 | **29/30 / 27/30 / 1/30** |
| gap=21 操作 / 窗口 / partial | 28/30 / 25/30 / 2/30 | **29/30 / 25/30 / 1/30** |

gap=9/21 合并后，操作正确由 54/60 提高到 58/60，窗口由 49/60 提高到 52/60，partial
误判由 6/60 降为 2/60，完整串行由 48/60 提高到 50/60。逐案差分只有 mon261 gap=9/21
newer、mtr712 gap=9 middle 和 mtr832 gap=9 middle 四条发生变化，全部由 partial 改为
missingRing，旧操作、窗口或串行成功退步为 0。两个剩余 partial 都是 mon261 的 gap=9 older
和 gap=21 middle，且单事件控制并非都正确；两个控制都正确的 gap=9/21 案例已无 partial
误判。mtr712 和 mtr832 的首窗覆盖较新真值，应用后第二窗也覆盖较老真值。

1 年间距在数值上与一个连续两年缺块等价，继续标为 `operation-unidentifiable`，不计入必须拆成
两个 missingRing 的准确率；本轮操作/窗口为 3/30。3 年间距只留下极短中间 lag 状态，当前
操作为 9/30、窗口 7/30，仍是下一轮需要单独研究的低上下文层，不能用 gap=9/21 的结果代替。

反向门禁包括多个日历位置的真实连续缺块 `-2/-3/-4/-6/-10/-30/-50/-100`，全部保持
partialMove；B4/B5 的 missing+false 两种方向、180 个组合也保持首轮响应、操作、窗口和 Top1
与 Round 4C 一致，partial/whole/反向单位误判均为 0，完整串行 49/180、保存重开 100%、
clean review 2/55。该 B4/B5 运行跨越了中间生产提交，只作为无退步门禁，不把多出的 1 个
串行成功归因于本轮修改。

完整 co612 批处理在本机由约 333.7 秒变为 349.7 秒，约增加 4.8%；该时间含 415 个状态的
COFECHA sidecar、参考重建和保存重开，不是纯定位器 microbenchmark。新增逐参考竞争只在旧
恢复失败的无 whole `partialMove -2` 上运行，普通事件路径不付出该枚举成本。跨站点混合矩阵
保持 84/84 whole 位移精确、错误 whole 位移 0；ZSL RAW/crossdated 13 项、co612 12 项、
ZSL141、MCP17A 和物理 partial `-2...-100` 回归均通过。

### Round 6A：修正 B7 双伪轮冻结基准的日历端点

B7 第一次建立 manifest 时被 truth round-trip 主动终止，尚未进入生产诊断。失败案例为
`mon151`：源序列有 416 个有效值，双伪轮注入后按真值删除两次只剩 415 个值，起点也由
1585 错成 1587。根因在混合 fixture，而不是 falseRing 应用逻辑：fixture 使用
`target[y] = correct[y + lag(y)]` 生成同一日历坐标，却固定只遍历原始 `startYear...endYear`。
双伪轮老侧的累积 lag 为 `+2`，显示区间本应向老端延长 2 年；固定起点会在生成时先截掉
两条真实年轮，后续任何删除顺序都不可能还原源序列。

生成区间现统一由端点状态推导：

- `displayedStartYear = sourceStartYear - (wholeSeriesLag + sum(local shifts))`；
- `displayedEndYear = sourceEndYear - wholeSeriesLag`。

这与四类操作的固定侧语义一致：缺轮或负向 partial 缩短老端，伪轮延长老端，whole 同时移动
两端。基准加载器还统一从 `RwlSeries` 排除 Tucson `-9999` stop marker，使合成真值与原本已经
过滤终止标记的诊断 `siteData` 使用完全相同的 observed 年份集合；终止标记不再参与序列端点、
长度、取样位置或反事实值。新增确定性测试验证双伪轮按老到新删除，以及先删除新侧后把老侧
真值坐标 `+1`，两种确认顺序都逐年逐值还原源序列。修改只位于基准加载器、合成 fixture 和
测试，不改变生产诊断。修改后
`rdmFixtureFalseRing` 6/6、co612 多缺轮 12/12、跨站点混合事件 3/3 通过，其中 whole 与局部
事件共存仍为 84/84 精确位移。

修正后的 1 条样芯链路 smoke 生成 92 个诊断状态，源 SHA 前后不变、保存重开 100%、错误 0、
clean review 2/55。该 smoke 不作为准确率结论，但确认 B7 存在真实且很强的操作竞争：`mon151`
的 12 个双伪轮案例首轮仅 1 个 falseRing，5 个被反向报为 missingRing、4 个被报为
wholeSeriesMove、2 个拒答。下一步必须用 10 条样芯冻结完整分布后再判断通用修复方向。

### Round 6B 基准：B7 同向双伪轮阶梯

完整冻结结果位于
`D:\软件测试\co612-operation-composition-results\b7-false-pair-full-baseline-d30c09ae-2026-08-09`，
绑定提交 `d30c09ae` 和 co612 SHA-256
`36e6c6a9d0cbc16d1870a1662da553a7b40d5578ea9ede25ff790c556c34667d`。共运行 10 条样芯、
老/中/新三个位置和 1/3/9/21 年间距，包含 55 条 clean、240 个单伪轮控制、120 个双伪轮
场景及串行状态，共 415 个工作项。源文件前后不变、错误 0、保存重开 100%、clean review
2/55。

单伪轮控制的操作正确为 199/240、窗口覆盖 188/240、Top1 59/240。双伪轮结果不是由单事件
本身的全部弱例造成：77 个场景的两个对应控制都操作正确，但其中首轮只有 6 个输出 falseRing；
46 个反向输出 missingRing、14 个输出 wholeSeriesMove、7 个输出 partialMove、4 个拒答。

| B7 首轮指标 | 结果 |
| --- | ---: |
| 响应 | 114/120 |
| 操作正确 | 14/120 |
| 主窗口覆盖 | 11/120 |
| Top1 | 5/120 |
| missingRing 反向误判 | 73/120 |
| wholeSeriesMove 误判 | 18/120 |
| partialMove 误判 | 9/120 |
| 完整串行恢复 | 6/120 |

| 分层 | false | missing | partial | whole | 拒答 | 操作 / 窗口 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| gap=1（操作不可辨识） | 0 | 25 | 1 | 3 | 1 | 0 / 0 |
| gap=3 | 1 | 24 | 2 | 2 | 1 | 1 / 1 |
| gap=9 | 2 | 16 | 5 | 6 | 1 | 2 / 1 |
| gap=21 | 11 | 8 | 1 | 7 | 3 | 11 / 9 |
| 老侧位置 | 4 | 31 | 3 | 0 | 2 | 4 / 3 |
| 中部位置 | 10 | 22 | 4 | 0 | 4 | 10 / 8 |
| 新侧位置 | 0 | 20 | 2 | 18 | 0 | 0 / 0 |

逐案 decision audit 显示两个系统性原因：

1. 新侧案例的老侧多数分段处于 `lag=+2`，最年轻固定侧仍为 `lag=0`。18 个 whole 误判把
   “局部 `+2 -> 0`”当成全序列基线；典型 notes 同时写出 shift support 75%、older edge
   support 100%、newer edge support 0%。这证明旧 whole 门禁允许单侧多数票替代两端同态，
   与 whole 的定义矛盾。
2. 73 个 missing 误判全部由 `sequential_missing_staircase_head` 产生，其中 49 个又被
   `shared_explicit_zero_marker` 加固。恢复器看见压缩阶梯后没有先保留原始有符号方向，其他样芯
   在错误年份附近的自然 0 就能把真实 `+1,+1` 伪轮阶梯反向改写为缺轮。
3. 另有 9 个自动负向 partial，但真值需要两次删除并让老侧逐步向新年份收紧；它们不能用自动
   partial 近似。相邻 gap=1 继续单列为操作不可辨识，不用它推动拆分门槛。

因此 B7 修复不能只是提高 falseRing 分数。下一步需先让 whole 候选证明新旧两端为同一非零
lag；若固定新侧仍为 0，则保留为局部状态路径。随后在同一有符号路径上识别两个 `+1` 阶跃，
用逐参考芯删除反事实与直接 whole/partial 竞争；missing 阶梯恢复也必须证明方向为负，不能仅靠
共享 0 标记翻转操作类型。最终仍只输出当前最前沿的一个 falseRing 和一个唯一窗口。

### Round 6C：whole 双端同态安全门禁

先单独修复 B7 中危险性最高的 whole 误判，不把它与 falseRing 恢复混成一次阈值调整。
`supportsNonTerminalWholeSeriesCandidate` 新增稳定固定新侧否决条件：最新分段 lag 为 0、最新两段
均不支持 proposed whole shift，且至少两段明确支持 0 时，说明新侧日期仍正确；即使老侧占全局
多数、global lag 也等于 proposed shift，也不得输出 whole。只出现一个噪声端段仍可由原 broad
consensus 接受，terminal、path-fixed-side 与 recent-tail 已验证基线继续使用各自专用门禁。

同配置 `mon151` 12 例 smoke 中，whole 误判由 4 降到 0；clean review 仍为 2/55，24 个单伪轮
控制的操作、窗口和 Top1 完全不变，保存重开 100%、错误 0。被拒绝的 4 个 whole 中，2 个转为
missing、2 个拒答，所以首轮操作正确仍为 1/12。本轮只证明“固定新侧不能被整体移动”，不把
错误类型转移称为准确率提升。保护门禁包括 whole state 单元测试 9/9、ZSL RAW/crossdated
操作类型 13/13，以及 whole shift `-5/-2/+2/+5` 与七类局部组合的 28/28 精确恢复。

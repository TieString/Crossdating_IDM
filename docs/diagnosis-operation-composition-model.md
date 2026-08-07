# JS 定年操作组合模型与验证日志

日期：2026-08-08  
工作树：`D:\Code\Crossdating_Tauri_js-diagnosis-events-v1`  
状态：Round 0，已冻结操作语义和待测情况；组合基准尚未运行

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

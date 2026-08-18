# ITRDB 人工解阻全事件评估协议 v2

## 目的

v2 保留 v1 的人工解阻流程，并把用户在界面中实际可执行的事件解释切换纳入工作流等价判定。
生产诊断仍只输出一个主建议；解释链只用于离线评估该建议经过实体证据复核后能否落到正确操作。

## 两套并行指标

原有无救援指标保持不变：

- `workflowSuggestionAccuracy`：首次人工介入前，正确完整建议数 / 实际前沿诊断次数。
- `serialRecoveryRate`：首次人工介入前，算法正确恢复事件数 / 全部真值事件数。
- 原有响应率、操作准确率、窗口覆盖率、Top1、误判率、保存稳定率和窗口宽度继续报告。

新增人工解阻指标：

- `humanAssistedFullEventSuggestionAccuracy`：人工解阻流程中正确建议数 / 全部真值事件数。
- `humanAssistedOpportunityCoverage`：实际获得诊断机会的事件数 / 全部真值事件数。
- `humanAssistedResponseRate`：全部事件机会中的非拒答比例。
- `humanRescueCount`、`humanRescueRate`：人工解决的阻塞事件数及其比例。
- `humanAssistedCompleteCaseRate`：所有真值事件均获得一次诊断机会的案例比例。
- `medianHumanRescuesPerCase`、`p90HumanRescuesPerCase`：每案例救援次数分布。

## 人工解除阻塞

每次失败只把当前前沿事件记为失败：

1. 从仍未解决的隐藏事件构造当前 RWL。
2. 重新运行 COFECHA、生成参考并执行生产诊断。
3. 建议正确时由算法解决当前事件。
4. 拒答、错误操作、错误位移、窗口错误或提示后期事件时，该事件记为失败。
5. 评估器使用隐藏真值模拟用户只解决当前阻塞事件，记录 `resolutionMode=human_rescue`。
6. 其他事件保持未解决，重新构建 RWL、master、COFECHA 和诊断。
7. 直到每个真值事件恰好获得一次前沿诊断机会。

隐藏真值只用于选择和移除当前人工救援事件，不进入诊断输入、参考、COFECHA、候选排序或窗口选择。

## 传递式工作流等价

评估器按用户可见的受约束解释入口展开一条操作链：

```text
wholeSeriesMove -> missingRing | falseRing | partialMove
partialMove -> missingRing
wholeSeriesMove -> partialMove -> missingRing
```

成功必须同时满足：

- 最终事件类型与当前真值一致。
- `missingRing=-1`、`falseRing=+1`，partial/whole 位移量必须精确一致。
- 局部事件的唯一窗口覆盖真值年份。
- whole 真值仍只接受精确负向 `wholeSeriesMove`；替代 whole 不能反向冒充整体真值。
- 正向自动 whole 始终失败。

例如主建议为 whole，局部复核解释为 `partialMove -3`，当前真值为缺轮。用户排除 whole，
再依据样芯完整性把 partial 按缺轮逐轮复核；若最终 missingRing 语义成立且同一窗口覆盖真年份，
则记为工作流等价成功。若操作链正确但窗口未覆盖，只记为窗口失败。

## 新增逐步审计字段

`steps.csv/json` 额外记录：

- `acceptedReviewPath`
- `acceptedReviewDepth`
- `transitiveWorkflowEquivalent`
- `diagnosedTruthId/Type/Year/ShiftYears`
- `resolutionMode`
- `humanRescueApplied`
- `humanRescuedTruthId`

`cases.csv/json` 额外记录：

- `transitiveAlternativeRecoveries`
- `humanAssistedCorrectSuggestions`
- `humanAssistedTruthOpportunities`
- `humanRescueCount`
- `firstHumanRescueStep`
- `humanAssistedComplete`

未设置 `--max-steps` 时必须满足：

```text
正确建议数 + 人工救援数 = 全部真值事件数
机会覆盖率 = 100%
```

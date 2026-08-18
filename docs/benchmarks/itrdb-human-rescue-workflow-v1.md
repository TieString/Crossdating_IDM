# ITRDB 人工解阻全事件评估协议 v1

## 目的

旧串行基准在当前前沿建议错误或拒答时立即停止，导致同一事件链的全部后续事件都没有诊断机会。
新协议保留该真实失败，但模拟用户回到样本上正确解决唯一的当前阻塞事件，重新构建数据和参考后继续诊断。

该协议只改变离线评估流程，不修改生产诊断算法，也不把隐藏真值提供给诊断器。

## 每一步流程

1. 从干净源 RWL 加入所有仍未解决的隐藏事件，构造当前工作数据。
2. 重新格式化 RWL、运行 COFECHA、生成 master/reference，并执行生产 review-event 诊断。
3. 若建议操作、位移和唯一窗口均正确，记录 `resolutionMode=algorithm`，只移除该事件。
4. 若拒答、操作错误、窗口错误或提示较老事件，该事件仍记为失败。
5. 从当前 `frontierTruths` 中选择唯一阻塞事件，记录 `resolutionMode=human_rescue`，只移除这一事件。
6. 其他事件继续保留为未解决的隐藏扰动；下一轮从源 RWL 重新构建，不复用本轮 master 或 COFECHA。
7. 重复直到每个真值事件都获得一次诊断机会，或显式 `--max-steps` 截断。

人工救援选择顺序为：与主建议操作一致的当前真值、与替代解释一致的当前真值、当前前沿中的第一个真值。
混合案例的 `currentFrontierTruths` 仍按既有语义先包含整体 baseline，再包含最靠树皮的局部事件。

## 指标

### 前沿可复核建议准确率

沿用 `workflowSuggestionAccuracy`。只统计首次人工救援前的实际前沿诊断，包括触发首次救援的失败步骤。

### 无人工救援串行恢复率

沿用 `serialRecoveryRate`：首次人工救援前由算法正确恢复的事件数除以全部真值事件数。

### 人工解阻后全事件建议准确率

字段：`humanAssistedFullEventSuggestionAccuracy`

```text
全部独立诊断机会中建议正确的事件数 / 全部真值事件数
```

失败事件由人工正确解决后仍只计失败；人工修复不进入正确建议分子。

### 配套指标

- `humanAssistedOpportunityCoverage`：获得独立诊断机会的事件数 / 全部真值事件数。
- `humanAssistedResponseRate`：全部事件机会中的非拒答比例。
- `humanRescueCount`：完成所有事件机会所需的人工救援次数。
- `humanRescueRate`：人工救援次数 / 全部真值事件数。
- `humanAssistedCompleteCaseRate`：全部事件都获得诊断机会的案例比例。
- `medianHumanRescuesPerCase`、`p90HumanRescuesPerCase`：每案例救援次数分布。

以上新指标同时进入按文件聚类 bootstrap；`humanAssistedFullEventSuggestionAccuracy` 使用与旧主指标相同的目标门槛。

## 逐步审计字段

`steps.csv/json` 新增：

- `unassistedPhase`
- `humanRescueCountBefore`
- `remainingTruthsAfter`
- `diagnosedTruthId/Type/Year/ShiftYears`
- `resolutionMode`
- `humanRescueApplied`
- `humanRescuedTruthId`

`cases.csv/json` 新增：

- `humanAssistedCorrectSuggestions`
- `humanAssistedTruthOpportunities`
- `humanRescueCount`
- `firstHumanRescueStep`
- `humanAssistedComplete`
- `humanAssistedAttemptedSteps`

运行时强制验证：

```text
正确建议数 + 人工救援数 = 已获得诊断机会的事件数
```

未设置截断步数时，还要求机会数严格等于真值事件总数。

## 示例

四个事件依次为：正确、正确、失败、人工解决后正确。

| 指标 | 结果 |
|---|---:|
| 无人工救援串行恢复率 | 2/4 = 50% |
| 前沿可复核建议准确率 | 2/3 = 66.7% |
| 人工解阻后全事件建议准确率 | 3/4 = 75% |
| 人工救援次数 | 1 |

真实冒烟案例 `ca646:B2748C:B-partial-n3-v5` 得到同样的关系结构：旧串行恢复 `1/3`，
旧前沿建议 `1/2`，人工解阻后全事件建议 `2/3`，人工救援 1 次，机会覆盖率 100%。


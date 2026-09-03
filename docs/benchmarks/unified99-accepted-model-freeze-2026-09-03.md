# Unified 自动定年：目标修订与模型冻结

2026-09-03，用户明确修改目标：“目前平均93%已经较好，可以算达标了”。研究准确率阶段按此验收，停止继续追求95%或99%。

## 冻结结果

采用单一 `joint-explicit-global-v5`：207个运行时证据特征、一个统一排序模型，沿用现有参数和事件门，不追加条件模型头。

| 主校准指标 | 冻结结果 |
|---|---:|
| 真实事件机会 | 9038 |
| 最终正确 | 8426/9038＝93.23% |
| 覆盖 | 9023/9038＝99.83% |
| 拒答 | 15 |
| Clean误报 | 29/2924＝0.99% |
| 局部主窗口 | 唯一13年 |

准确率分母是全部真实事件机会；正确要求操作、精确位移以及当前前沿真值的窗口覆盖同时满足。whole只检验操作与精确位移。首次正确8381次，partial→missing复核72次、恢复正确45次，最终8426次。

93.23%是主校准A/B/C/D合并结果，不是所有分区或所有分层单元均达93%。development文件分组OOF为8458/9242＝91.52%；完整分类、相关性和距离审计保留在原报告。既有弱项继续披露，不再触发追逐旧95%/99%目标的研究循环。

## 验收边界与剩余工作

研究模型按用户修订目标达标。覆盖率、Clean≤1%、唯一9–13年窗口、真实前沿逐事件解阻、唯一操作与定向partial→missing复核、完整文件隔离均保持不变。

后续仅推进应用接入和工程验证：同状态Python/TypeScript中间证据与最终输出比较、严格类型检查、交互专项测试、build、A/B/C/D与co612回归。任何新final仍须使用新的完整文件并冻结后一次运行；旧失败验证不改写。

当前默认应用仍为旧v3，尚未完成v5接入验收。本次只更新目标与冻结记录，没有重新训练模型、运行cofecha-js或更换应用模型，也未修改 `D:\Code\Crossdating_Tauri`。

## 冻结材料

- 模型：`.benchmark-results/unified99-joint-global-v5/model-v5.joblib`
- 输入清单：`.benchmark-results/unified99-joint-global-v5/full-manifest.json`
- 冻结分数：`.benchmark-results/unified99-joint-global-v5/frozen-scores-v5.npz`
- 原始结果：`docs/benchmarks/unified99-joint-global-v5.json`
- 分层审计：`docs/benchmarks/unified99-joint-global-v5-audit.json`
- 参数、门槛和SHA-256：相邻 `unified99-accepted-model-freeze-2026-09-03.json`

本记录核对既有结果并记录用户验收，不新增统计验证；原始结果及历史未通过结论保持原文件不变。

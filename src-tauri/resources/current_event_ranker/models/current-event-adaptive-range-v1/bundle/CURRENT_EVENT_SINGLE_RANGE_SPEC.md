# 当前最新缺轮事件单范围规范

## 目标

对当前 sequential recompute 状态只返回一个“最新尚未修复事件”的检查范围。15 年是最大宽度，不是固定宽度；证据集中时尽量缩窄，证据分散时保留最大包络。不返回多个互相独立的事件范围，也不自动修改 RWL。

这和精确年份 Top5 是两个阶段：

1. 先确定当前应检查的唯一事件范围。
2. 用户在曲线、样芯和参考序列中检查该范围。
3. 范围内证据只对精确年份排序提供软提升，不删除范围外候选。
4. 用户确认插年后，从新到旧插回并重新计算下一轮。

## 运行时前置条件

- 输入必须是当前轮重新计算的 selected top500 真实候选及冻结 251 项部署特征。
- 先由现有 deployment-safe LightGBM year ranker 为候选打分。
- 不允许使用 `zero_count`、`remaining_event_count`、真实缺轮年份、source_file 记忆特征或零填充伪造特征。
- 已确认插年按新到旧传入；候选范围中心必须早于上一已修复年份。
- 范围定位器评估 frozen year-ranker Top120 中心。中心选择使用 `[center-7, center+7]` 最大证据包络；最终边界根据包络内冻结年份分数自适应缩窄，永不超过 15 年。

## 当前诊断配置

- 34 项区间 score-profile 特征。
- frozen year ranker 重要性最高的 36 项部署可用中心特征。
- LightGBM LambdaRank，seed 17，固定参数与现有诊断脚本一致。
- learned interval score 按 round 标准化后占 75%，interval softmax mass 占 25%。
- 每轮只选择融合分数最高的一个范围。
- 自适应边界策略：局部 softmax 质量阈值 0.8、temperature 1.0、最小核心宽度 5、两侧 padding 2；只有局部单年峰值质量至少 0.2 才缩窄，否则回退最大包络。
- 现有 exact-year reliability selector 低于阈值时返回证据不足，不应展示可直接采纳的范围。
- 精确年份二阶段只把范围内年份提升 2 个原始名次；排序分数不是概率。

## 建议响应语义

```json
{
  "status": "advice",
  "roundIndex": 1,
  "eventRange": {
    "startYear": 1946,
    "endYear": 1954,
    "centerYear": 1950,
    "width": 9,
    "scope": "newest_unresolved_event",
    "adaptive": true,
    "shrunk": true,
    "maxEnvelopeStart": 1943,
    "maxEnvelopeEnd": 1957
  },
  "yearSuggestions": [1950, 1949, 1952, 1948, 1954],
  "automaticWriteback": false,
  "diagnosticOnly": true
}
```

证据不足时使用 `status=evidence_insufficient`，不要返回第二个范围作为替代。UI 可以保留内部诊断信息，但不得把 range score 或 reliability probability 描述为“真实年份概率”。

## 评估结果

最终输出目录：`artifacts/reports/current_event_single_range_w15_final_diagnostic/`。

- 开发 source-file 五折 OOF：1,249 rounds / 608 series / 356 source_file；范围覆盖 0.8311，source macro 0.7853，最差折 0.8080。
- 固定 confirmation3+4 回放：831 rounds / 423 series / 239 source_file；范围覆盖 0.8171，source macro 0.7772。
- 固定回放 accepted 598 rounds：范围覆盖 0.8963，source macro 0.8604。
- 固定回放第一轮范围覆盖 0.7707；accepted 第一轮 0.8824。第一轮全体仍是主要瓶颈。
- 相对 Top1-center，固定回放净增 71 rounds；source cluster bootstrap 95% CI 为 `[+0.0631,+0.1087]`。
- Top120 区间候选 ceiling 为 0.9904；只有 8/831 轮属于中心候选缺失，主要失败来自范围排序。
- 软年份提升后，固定精确 Top1 为 0.4970，Top5 为 0.7316；accepted Top5 为 0.8194。

confirmation3/4 已被消费，以上是固定诊断回放，不是新的 blind test。当前 artifact 仍是 diagnostic-only，不能替换 selected mainline 或 production artifact。

## 自适应宽度结果

- 开发 OOF：平均宽度 `14.88 -> 12.17`，76.5% 轮次缩窄；覆盖 `0.8311 -> 0.8223`。accepted 平均宽度 `14.91 -> 11.77`，覆盖 `0.9002 -> 0.8925`。
- 固定回放：平均宽度 `14.90 -> 12.33`，74.2% 轮次缩窄；覆盖 `0.8171 -> 0.8063`。accepted 平均宽度 `14.92 -> 12.02`，84.1% 轮次缩窄；覆盖 `0.8963 -> 0.8880`。
- 固定 accepted 精确 Top1/Top5 保持 `0.5920/0.8194`，没有因缩窄发生变化。
- 固定回放 source-cluster bootstrap：宽度减少 95% CI `[2.40,2.73]` 年；覆盖变化 95% CI `[-0.0182,-0.0047]`。缩窄收益稳定，但确有约 1 个百分点的覆盖代价。

## 接入现有旁路进程

未来接入 Tauri 时，范围层应放在 Python 长驻 sidecar 内，紧跟 frozen year ranker：

`raw RWL -> current target/master -> selected top500 -> frozen year scores -> one event range -> soft year Top5`

Tauri 仍只传 RWL 路径、目标序列和 `confirmedInsertions`，不负责生成 70 项范围特征。确认年份后，Tauri 将该年份加入 `confirmedInsertions` 并再次调用同一个 command；sidecar 必须重新构造 target、候选、年份分数和唯一范围。

已导出的自适应 Tauri 诊断 bundle 版本为 `current-event-adaptive-range-v1.2.0`，默认目录是：

`artifacts/exports/current_event_adaptive_range_tauri_bundle_v1_20260718/bundle/`

相对旧 bundle 新增的部署文件是：

- `current_event_range_localizer.joblib`
- `current_event_range_feature_schema.json`
- `current_event_range_manifest.json`
- `range_prediction_reference.json`
- `current_event_range_training_summary.json`
- `current_event_range_artifact_verification.json`

它们必须与冻结 year ranker、selector、candidate compression/binary models、运行配置和协议 schema 作为完整 bundle 配套，不能只复制范围 `joblib`。Tauri 发布时应使用同一工作树下更新后的 `scripts/current_event_ranker_sidecar.py` 重新构建可执行文件。

# 当前事件范围可靠性筛选器 V1.3

## 目标与边界

该筛选器只回答“当前唯一事件范围是否值得展示给用户重点检查”。它不预测真实缺轮年份，不自动修改 RWL，也不把 score 解释为真实概率。模型和 bundle 均为 diagnostic-only。

训练标签仅为 `current_true_year in [adaptive_start, adaptive_end]`。`current_true_year`、绝对年份、`source_file`、`series_id`、`zero_count`、`remaining_event_count` 和 group 标识均不进入特征。

## 冻结配置

- 模型：LightGBM binary classifier，训练时每个 source_file 总权重相等，并保留训练折内类别平衡。
- 特征：109 项 float64；39 项运行时汇总 + 当前选中范围的 70 项真实 profile/center 特征。
- 阈值：`0.33853178198144895`。
- 数据限制：`zero_count <= 6`。
- 选择：仅使用 1,249-round / 356-source_file 开发 source-file GroupKFold OOF；confirmation3+4 不参与特征、模型或阈值选择。

## 质量证据

开发 OOF：旧年份 gate 接受率 0.7222、accepted range coverage 0.8925；新范围 gate 接受率 0.8503、coverage 0.8795、source macro 0.8454、series macro 0.8654、最差折 0.8326。新增正确/错误接受 151/54，新拒绝旧 gate 正确/错误 22/23。

confirmation3+4 固定回放：831 rounds / 423 series / 239 source_file。旧 gate 接受率 0.7196、coverage 0.8880；新 gate 接受率 0.8556、coverage 0.8594、source macro 0.8360、series macro 0.8448。新增正确/错误接受 91/44，新拒绝旧 gate 正确/错误 11/11。该回放已消费，不是新 blind test。

双 gate 同时通过的 576 轮精确 Top1/Top5 为 0.5990/0.8264；135 轮只显示范围。range gate 拦下的 22 个旧 year-accepted 轮精确 Top1/Top5 仅 0.4091/0.6364。

## 双 gate 状态

1. `rangeReliability.accepted=true` 且 `yearReliability.accepted=true`：`status=advice`，显示唯一 `eventRange` 和精确年份 Top5。
2. 范围通过、年份不通过：`status=range_advice`，仍显示唯一 `eventRange`，`suggestions=[]`，提示精确年份证据不足。
3. 范围不通过：`status=evidence_insufficient`，`eventRange=null`，`suggestions=[]`，不返回替代范围。

`reliability` 保留为 `yearReliability` 的向后兼容别名。没有独立范围 selector 的 V1.2 bundle 由新 sidecar 按旧单 gate 语义加载。

## Bundle 契约

- bundleVersion：`current-event-adaptive-range-gate-v1.3.0`。
- 协议：`crossdating.current-event.v1`。
- 范围 selector：`current_event_range_reliability_selector.joblib`。
- schema：`current_event_range_reliability_feature_schema.json`。
- 必须整体分发 bundle，并在启动时验证 `bundle_manifest.json`；禁止只复制 joblib。

# Current-event 模型的 Tauri 接入规范

## 1. 组件边界

Tauri 不计算模型特征。Python 旁路进程负责完整流程：

`RWL -> 解析目标/参考序列 -> 当前轮 target -> leave-one-out master -> selected top500 -> 251 项部署特征 -> 年份 LambdaRank -> 70 项范围特征 -> 唯一最新事件范围 -> 109 项范围可靠性特征 -> 独立范围 gate + 独立年份 gate -> 范围或完整建议`

Tauri 只负责文件选择、序列选择、会话中的人工确认记录、进程生命周期和结果展示。模型不会自动改写 RWL。

## 2. 资源

模型目录：`artifacts/exports/current_event_adaptive_range_gate_tauri_bundle_v1_20260718/bundle/`

必须整体打包该目录，不要只复制 `joblib`：候选压缩模型、旧 binary 模型、模式、运行配置和哈希清单都是推理契约的一部分。

开发启动：

```powershell
python scripts/current_event_ranker_sidecar.py `
  --bundle artifacts/exports/current_event_adaptive_range_gate_tauri_bundle_v1_20260718/bundle
```

旁路进程使用 UTF-8 JSON Lines：stdin 每行一个请求，stdout 每行一个响应。日志只允许写 stderr。

## 3. 请求

```json
{"protocolVersion":"crossdating.current-event.v1","requestId":"rank-0001","method":"rank_current_event","params":{"rwlPath":"D:\\data\\site.rwl","targetSeriesId":"ABC01A","existingZeroPolicy":"preserve","confirmedInsertions":[],"topK":5,"rangeRadius":1}}
```

- `existingZeroPolicy=preserve`：桌面端普通使用的默认值，保留文件里已经存在的 0。
- `existingZeroPolicy=remove`：只用于 ITRDB 标注回放/基准测试，先删除原文件全部 0。
- `confirmedInsertions`：本次会话中用户已经人工确认、但尚未写回基础 RWL 的插年。服务会去重并按新到旧应用。
- `rangeRadius`：仅用于兼容旧请求，当前 bundle 会忽略它。范围定位器先建立中心 ±7 年的最大证据包络，再根据局部分数集中度缩窄；包含端点最多 15 年，并非固定 15 年。
- 不得传 `zero_count`、`remaining_event_count` 或真实年份标签；部署模型不需要它们。

用户接受第一轮建议后，Tauri 把该年份追加到 `confirmedInsertions`，再次调用同一方法。保存到磁盘后，应清空会话列表并重新读取文件，避免重复插入。

## 4. 响应语义

`status=advice` 时显示唯一 `eventRange` 和精确年份 Top5。`adaptive=true` 表示启用证据自适应策略，`shrunk` 表示本轮确实从最大包络缩窄。不得把内部 `diagnostics.events` 显示成多个并列事件建议。

`status=range_advice` 时仍显示唯一 `eventRange`，但 `suggestions=[]`；前端应显示“范围可供重点检查，但精确年份证据不足”，不能把隐藏的低置信年份包装成可采纳建议。

`suggestions` 是该唯一范围提供软证据后得到的精确年份 Top5。所有条目的 `rangeStart/rangeEnd` 都引用同一个 `eventRange`，不是 5 个独立范围；范围外年份不会被硬删除。

前端必须以 `rank` 和数组顺序为最终顺序，不要再按 `rankingScore` 排序。软提升可能让区间内候选排在原始分数更高的区间外候选之前；`baseRank` 保留原年份 ranker 次序，`rangePromoted` 表示范围证据是否参与该候选排序。

`status=evidence_insufficient` 时不得显示可采纳范围或年份，也不得请求第二个替代范围。常见原因包括参考序列不足、重叠不足、无候选或范围可靠性低于阈值。

`rankingScore` 和 `eventRange.localizerScore` 都只是同一轮候选之间的相对排序分数，不是概率。`rangeReliability.score` 判断范围是否值得展示，`yearReliability.score` 判断精确 Top5 是否值得展示，二者都不是真实概率。`reliability` 只是 `yearReliability` 的旧客户端兼容别名。

错误响应使用稳定代码：`INVALID_REQUEST`、`UNSUPPORTED_PROTOCOL`、`RWL_NOT_FOUND`、`RWL_PARSE_FAILED`、`SERIES_NOT_FOUND`、`INSUFFICIENT_REFERENCES`、`INSUFFICIENT_OVERLAP`、`NO_CANDIDATES`、`SCHEMA_MISMATCH`、`MODEL_HASH_MISMATCH`、`MODEL_LOAD_FAILED`、`INTERNAL_ERROR`。

## 5. Tauri 进程模式

1. 应用启动或首次使用时启动一个长驻旁路进程；不要每次点击都重新加载模型。
2. Rust 状态中保存 `ChildStdin`、逐行 `BufReader<ChildStdout>` 和互斥锁。
3. 每次请求生成唯一 `requestId`，写一行并 flush，读取一行后核对 `requestId`。
4. 单进程请求串行化。建议超时 30 秒；进程退出、管道断开或协议错误时重启一次。
5. 用户选择的 RWL 路径作为 JSON 字段传递，不拼接 shell 命令。
6. stdout 只解析协议；stderr 单独进入诊断日志。

Rust command 的核心形状：

```rust
#[tauri::command]
async fn rank_current_event_v1(
    state: tauri::State<'_, CurrentEventSidecar>,
    request: CurrentEventRequest,
) -> Result<CurrentEventResponse, SidecarError> {
    state.call(request, std::time::Duration::from_secs(30)).await
}
```

前端只调用一个 Tauri command：

```ts
const response = await invoke<CurrentEventResponse>("rank_current_event_v1", {
  request: {
    protocolVersion: "crossdating.current-event.v1",
    requestId: crypto.randomUUID(),
    method: "rank_current_event",
    params: {
      rwlPath,
      targetSeriesId,
      existingZeroPolicy: "preserve",
      confirmedInsertions,
      topK: 5,
      rangeRadius: 1, // 废弃兼容字段；服务使用证据自适应且最大宽度 15 的唯一范围
    },
  },
});
```

## 6. 打包建议

把旁路可执行文件放入 Tauri `externalBin`，把完整 bundle 放入 `resources/current_event_ranker/`。运行时用 `resource_dir()` 定位模型目录，并把绝对目录作为 `--bundle` 参数传给旁路进程。

发布前必须执行：模型包哈希校验、`health`、`describe`、251/70/109 三套模式顺序校验、年份/范围/range-gate 参考预测一致性、完整建议/仅范围/范围拒绝三种 raw RWL 状态、同一请求重复预测一致性、唯一范围宽度上限、JSONL 会话和结构化错误测试。

## 7. 当前质量边界

自适应窗口在固定 confirmation3+4 回放的 831 轮中总体覆盖 0.8063。独立范围 gate 接受 711 轮，接受率 0.8556，accepted range coverage 0.8594；旧年份 gate 只接受 598 轮，接受率 0.7196、coverage 0.8880。范围出现率提高 13.60 个百分点，代价是 accepted coverage 降低 2.86 个百分点。固定回放不是新的 blind test。

这是诊断建议性能，不是对任意文件的保证，也不是自动插年许可。完整数据重训本身没有新的无偏测试指标；质量估计来自未参与可靠性模型训练的 source_file 隔离确认集。

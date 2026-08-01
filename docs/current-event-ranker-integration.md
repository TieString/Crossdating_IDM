# Current-event V1 多模型桌面端接入

## 定位与模型目录

Current-event 始终是 diagnostic-only 旁路建议，不替换默认自动交叉定年主管线，不改变内部候选排序，也不会自动写回 RWL。软件打包三套可切换模型：

| modelId | 展示 | bundle | 行为 |
| --- | --- | --- | --- |
| `current-event-range-v1.0.0` | 年份 Top5 V1.0（默认） | 14 文件、251 年份特征 | 原始精确年份排序，每条建议带兼容检查范围 |
| `current-event-adaptive-range-v1` | 当前缺轮事件：双门控自适应范围 V1.3 | 36 文件、251 年份特征、70 范围特征、10 年份门特征、109 范围门特征 | 独立判断范围与精确年份；范围可信时优先显示唯一范围，年份门也通过时才显示 Top5 |
| `current-event-missing-rrf-v1` | 缺轮逐轮建议：双基准 RRF V1 | 完整14文件年份 bundle、冻结 RRF 路由、独立部署 manifest | 仅专家主动调用；固定 `remove/5/3`，融合 latest-path 与无归一化名次，冻结 selector 决定建议或拒答 |

升级后的 bundleVersion 是 `current-event-adaptive-range-gate-v1.3.0`。稳定 modelId 与 bundleVersion 有意分离，因此已有的 adaptive 模型选择无需迁移；modelId 只存在于 Tauri 可信注册表中，不进入 `crossdating.current-event.v1` JSONL 请求。旧 `current-event-single-range-v1.1.0` 仍不再打包，localStorage 中保存的旧选择会自动迁移到稳定 modelId。默认 modelId 仍是 `current-event-range-v1.0.0`。

## 架构与切换

```text
React 模型选择器 / 会话
  └─ invoke("rank_current_event_v1", { modelId, request })
       └─ Rust 单一 worker
            ├─ current-event-range-v1.0.0
            ├─ current-event-adaptive-range-v1
            └─ current-event-missing-rrf-v1
```

同一时刻只保留所选模型的一个长驻进程。切换 modelId 时终止旧进程，下一次请求启动对应 sidecar；`health` 和 `describe` 都必须返回注册表指定的 bundleVersion，防止旧进程或错误 bundle 被复用。启动、握手、预测、排队和一次传输重试共用 60 秒异常保护上限；它不是固定等待时间。v1.3 PyInstaller sidecar 实测冷握手约 10–13 秒，桌面 `preserve` 样例约 3.3 秒，长驻后的参考请求约 0.6–0.9 秒，无需再次加载模型。

自适应模型的 `describe.eventRange` 还必须满足：

- `count=1`、`adaptive=true`；
- `maxRadius=7`、`maxWidth=15`、`maxCenters=120`；
- `featureCount=70` 且包含 `adaptivePolicy`；
- `reliabilityGate.independentFromYearGate=true`、`featureCount=109`、`threshold=0.33853178198144895`；
- `diagnosticOnly=true`、`automaticWriteback=false`。

## 用户流程与响应语义

1. 用户选择序列和诊断模型。
2. 原年份和 adaptive 模型在保存完成后后台运行；保存不等待模型完成。RRF 没有验证任意 RWL 自动筛查，因此保存不会触发它，必须由专家点击“分析当前序列”。
3. 自适应模型先显示唯一 `eventRange`。15 年是上限，不是固定宽度；`shrunk=true` 表示本轮从最大证据包络缩窄。
4. 范围门与年份门都通过时，`status=advice`，`suggestions` 是精确年份 Top5，不是五个范围；所有 `rangeStart/rangeEnd` 引用同一个 eventRange。
5. 仅范围门通过时，`status=range_advice`：保留唯一 `eventRange`，`suggestions=[]`，界面明确提示“范围可供重点检查，但精确年份证据不足”，且不提供年份确认按钮。
6. 范围门拒绝时，`status=evidence_insufficient`：`eventRange=null`、`suggestions=[]`，即使独立年份门通过也不泄露年份建议。
7. 前端以服务端数组和连续 `rank` 为最终次序，禁止按 `rankingScore` 二次排序。`baseRank` 是原年份 ranker 次序，`rangePromoted` 表示范围证据是否参与软提升。
8. `diagnostics.events` 只用于内部诊断，不能展示成多个并列事件范围。
9. 用户确认年份后，将本会话全部年份传入 `confirmedInsertions`；服务去重并按新到旧应用，再完整重算下一轮。
10. 只有点击“应用到当前 RWL 工作区”才修改内存工作区；真正保存后清空会话确认并从新 RWL 重新分析。

`rankingScore`、`localizerScore`、`evidencePeak`、`evidenceMass`、`rangeReliability.score` 和 `yearReliability.score` 都是诊断或相对排序量，不是真实概率。`reliability` 仅是 `yearReliability` 的向后兼容别名。原年份与 adaptive 桌面请求固定使用 `existingZeroPolicy=preserve`；RRF 是经过独立验收的例外，固定使用 `existingZeroPolicy=remove`。

### 缺轮 RRF 专家流程

RRF 的稳定桌面 modelId 是 `current-event-missing-rrf-v1`，部署版本是 `current-event-rrf-deployment-candidate-v1`，路由版本是 `missing-current-event-rrf0-range3-v1`。它与原年份模型报告相同的基础 `bundleVersion=current-event-range-v1.0.0`，Rust 因此还会强制核对路由版本、`operationScope=insert_missing`、融合算法以及 `remove/5/3`，不能只凭 bundleVersion 接受 sidecar。

每轮严格保留服务端 Top5/rank 顺序；每条建议显示精确中心年、最多 ±3 的人工核查范围、`pathRank`、`noneRank` 与 inferred latest-path base。`rankingScore=1/pathRank+1/noneRank`，不是概率；`reliability.score` 是“本轮 Top5 是否可用”的冻结估计，也不是某个年份正确的概率。`evidence_insufficient` 必须保持空候选，并明确说明它不代表所有缺轮已经修复。

会话最多确认6年。sidecar 每轮从同一磁盘 RWL 删除全部既有 0，再从新到旧重建 `confirmedInsertions`；确认期间不会修改文件。专家点击“按确认结果重建当前序列”时，桌面端使用同一语义原子替换目标序列并写入既有撤销栈/操作日志：先移除全部既有 0，再从新到旧插入本会话确认项。之后仍需人工检查并显式保存。

该路由只支持 `insert_missing`。它不负责整体移动、局部移动、伪轮、统一四操作路由、任意文件自动诊断或最后一轮自动停止，不能称为 production model。

## Tauri 调用

```ts
const response = await invoke("rank_current_event_v1", {
  modelId: "current-event-adaptive-range-v1",
  request: {
    protocolVersion: "crossdating.current-event.v1",
    requestId: crypto.randomUUID(),
    method: "rank_current_event",
    params: {
      rwlPath: "D:\\data\\site.rwl",
      targetSeriesId: "ABC01A",
      existingZeroPolicy: "preserve",
      confirmedInsertions: [],
      topK: 5,
      rangeRadius: 1,
    },
  },
});
```

`rangeRadius` 仅为旧协议兼容字段，自适应服务会忽略它。Tauri 不生成、计算或零填充 251/70/10/109 项特征，也不向协议传入 modelId、`zero_count`、`remaining_event_count` 或真实标签。

RRF 请求由模型目录自动生成固定参数：

```ts
const response = await invoke("rank_current_event_v1", {
  modelId: "current-event-missing-rrf-v1",
  request: {
    protocolVersion: "crossdating.current-event.v1",
    requestId: crypto.randomUUID(),
    method: "rank_current_event",
    params: {
      rwlPath: "D:\\data\\site.rwl",
      targetSeriesId: "ABC01A",
      existingZeroPolicy: "remove",
      confirmedInsertions: [],
      topK: 5,
      rangeRadius: 3,
    },
  },
});
```

## 开发与发布路径

开发环境：

```text
Python: D:\Programming\Python\Python310\python.exe
V1.0 sidecar: D:\Code\Crossdating_py_rankdiag_tauri_deploy\scripts\current_event_ranker_sidecar.py
Adaptive sidecar: D:\Code\Crossdating_py_eventrange_gate\scripts\current_event_ranker_sidecar.py
RRF sidecar: D:\Code\Crossdating_py_false_ring\scripts\current_event_rrf_sidecar.py
```

资源目录：

```text
src-tauri/resources/current_event_ranker/models/
  current-event-range-v1.0.0/
    bundle/
    current_event_ranker_sidecar.py
  current-event-adaptive-range-v1/
    bundle/
    current_event_ranker_sidecar.py
  current-event-missing-rrf-v1/
    bundle/
    current_event_rrf_sidecar.py
    deployment_manifest.json
    current_event_rrf_request.schema.json
    current_event_rrf_response.schema.json
```

发布 sidecar：

```text
src-tauri/bin/current-event-ranker-sidecar-x86_64-pc-windows-msvc.exe
src-tauri/bin/current-event-adaptive-range-sidecar-x86_64-pc-windows-msvc.exe
src-tauri/bin/current-event-rrf-sidecar-x86_64-pc-windows-msvc.exe
```

release 只从 Tauri `resourceDir/current_event_ranker/models/<model-id>/bundle` 和 `externalBin` 定位资源，不引用 Python 训练工作树绝对路径。

Tauri CLI 不会自动删除 `target/release` 中已移除的旧 resource。`beforeBuildCommand` 会先运行 `scripts/clean-current-event-release-resources.mjs`，仅清理工作树内的 release current-event 资源目录和旧 V1.1 sidecar，避免旧 bundle 混入新的安装包。

## 升级 staging

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts\stage-current-event-ranker.ps1 `
  -ResearchRepo D:\Code\Crossdating_py_eventrange_gate `
  -SourceBundle D:\Code\Crossdating_py_eventrange_gate\artifacts\exports\current_event_adaptive_range_gate_tauri_bundle_v1_20260718\bundle `
  -SourceScript D:\Code\Crossdating_py_eventrange_gate\scripts\current_event_ranker_sidecar.py `
  -BuildScript D:\Code\Crossdating_py_eventrange_gate\scripts\build_current_event_sidecar.ps1 `
  -Python D:\Programming\Python\Python310\python.exe `
  -BuildExecutable
```

`-BuildExecutable` 是 Tauri staging 包装参数；底层 Python 构建脚本只接收 `-Python` 和 `-OutputDir`。staging 在 Tauri 临时目录构建，不写入 Python 工作树。新 bundle 的 manifest SHA-256 必须为 `09f3e4c37d7a4bc06586eca0012678788afd0c786701cd03821b2b4ca2077a78`，且必须精确包含 manifest 保护的 36 个文件。`-ReuseBuiltExecutable` 只用于一次构建已完成、后续 staging 检查失败后的安全恢复；它仍会重新执行 executable smoke。

脚本在替换前后分别验证 manifest、251 项 float64 年份 schema、70 项 float32 范围 schema、10 项年份门与 109 项 float64 范围门顺序、256 条年份参考、8 组范围参考、64 条范围门参考、7 年收窄与 15 年回退 raw parity，以及完整建议/仅范围/范围拒绝三种双门控状态。新可执行文件必须通过同进程 JSONL smoke；失败时恢复旧资源和可执行文件。

## 验证

```powershell
npm run test:current-event-ranker
npm run build

cargo test --manifest-path src-tauri\Cargo.toml
cargo check --release --manifest-path src-tauri\Cargo.toml

npx tauri build
```

验证门禁覆盖三套完整资源哈希、schema/joblib 顺序、年份/范围/范围门参考预测零误差、health/describe 握手、双门控三状态、自适应范围字段、RRF 接受/拒答回放、RRF 分数重复确定性、固定 `remove/5/3`、服务端 Top5 顺序、结构化错误、主管线回归，以及禁止打包训练 JSONL、读取 final_blind 或使用 event union。

## 准确率边界

完整数据训练使用 923 series、2217 rounds、327 source_file。full-data 重训本身没有新的无偏测试指标。

- confirmation3+4 固定回放共 831 轮，总体范围覆盖 0.8063。
- 独立范围门接受 711 轮（0.8556），接受集范围覆盖 0.8594；相比只随年份门显示范围，范围出现率增加 13.60 个百分点，覆盖下降 2.86 个百分点。
- 原年份门接受 598 轮（0.7196），接受集范围覆盖 0.8880；两门同时通过 576 轮，精确 Top1/Top5 为 0.5990/0.8264。
- 另有 135 轮属于 `range_advice`：显示范围但隐藏精确年份。

confirmation3/4 已被消费，不是新的 blind test。上述结果不能解释为任意 RWL 的准确率保证，也不能作为自动插年许可；该模型不能描述为 production model。

RRF 冻结路线另在两批互不重叠的新文件上评估80个 source_file / 179轮：全部轮次精确 Top1/Top5 为 0.5531/0.8436，Top5 ±3 为 0.9330；selector 接受率 0.8156，接受集精确 Top1/Top5 为 0.6233/0.8904，接受集 Top5 的 source-file cluster bootstrap 95% 区间为 `[0.8148, 0.9515]`。这些证据只支持缺轮逐轮建议，不支持其他操作或自动完成。

## 当前发布边界

- adaptive sidecar 为 289,037,873 字节（约 275.6 MiB），SHA-256 为 `BA060B56468AE8B46381CD3BF37F9AC43D525552B325BAED0133D4B189193A5D`；主要体积仍由上游构建脚本的 `--collect-all sklearn` 决定。
- RRF sidecar 为 77,243,967 字节（约 73.7 MiB），SHA-256 为 `F3C48133091F886EA5372235E0DB520682A5A939BB9CDB2C10B03FE7BE83A4A8`，与冻结 deployment manifest 完全一致。
- NSIS 1.4.0 安装包为 447,961,223 字节（约 427.2 MiB），SHA-256 为 `CFCDA734B2CA81968E77D951C83B081286023E43BD3B4F4A7C916D1676D06F6B`。
- 三套 sidecar 和安装包尚未进行 Windows 代码签名。
- 60 秒是冷启动保护上限，不是每次保存的固定等待；切换模型会重新产生一次冷启动。
- Vite 仍报告既有约 809 kB 主 chunk 警告，不影响本次模型协议或发布构建通过。

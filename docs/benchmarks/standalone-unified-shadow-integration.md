# 独立统一诊断模型 Shadow 接入方案

## 目标

在不改变现有生产建议、应用操作和 UI 的前提下，让冻结的独立统一模型旁路处理同一份不可变候选证据，持续记录两套裁决的差异、稳定性和用户最终确认结果。

## 数据流

```text
共享不可变候选证据表
├─ 生产裁决器 -> 当前唯一建议 -> UI
└─ Shadow 统一模型 -> ShadowDecisionAudit -> 本地审计日志
```

生产裁决器和 Shadow 统一模型必须接收同一个候选表版本。Shadow 不得重新运行 COFECHA、修改参考序列、生成额外候选或读取生产裁决器是否正确。

## 不可变输出包

Shadow 每次只形成一个完整包：

```ts
type ShadowDiagnosisPackage = {
  evidenceSchemaVersion: string;
  modelVersion: string;
  operationType: DiagnosisEventType;
  shiftYears: number;
  mainWindow: { startYear: number; endYear: number } | null;
  selectedYear: number | null;
  confidence: number;
  refusalReason: string | null;
  equivalentInterpretation: DiagnosisEventAlternative | null;
};
```

操作、位移、窗口和等价解释必须来自同一个不可变候选身份。位置头不能修改操作或位移，操作头不能移动窗口。

## 运行约束

- Shadow 在生产建议完成后以低优先级执行。
- 前台诊断、保存、COFECHA 或用户编辑进行时暂停 Shadow。
- Shadow 超时、异常或模型版本不匹配时只记录失败，不影响生产建议。
- Shadow 不显示在建议卡片、图表窗口或广度提示器中。
- 数据、参考或 COFECHA 状态改变后，旧 Shadow 结果按数据签名失效。
- 自动建议继续禁止正向 `wholeSeriesMove` 和正向 `partialMove`。

## 审计记录

每次诊断记录：

- 文件匿名哈希、序列匿名哈希和 working-data 签名。
- 候选证据 schema、模型版本和模型文件 SHA-256。
- 生产建议与 Shadow 建议的操作、位移、窗口、响应状态。
- 两者是否同一完整包，以及差异属于操作、位移、位置还是拒答。
- 保存重开后是否稳定。
- 用户最终应用、切换等价解释或放弃复核的结果。

审计日志不得记录隐藏基准真值。离线评估时再以完整 RWL 文件为单位连接冻结真值。

## 性能预算

- 复用已有候选表和逐年证据缓存，不重复执行反事实扫描。
- Shadow 只运行冻结的 TypeScript 推理模型。
- 单次推理目标 P95 小于 100 ms；超过预算则取消本次 Shadow。
- 模型加载一次后按版本缓存，文件关闭时释放候选级中间数组。

## 升级门禁

Shadow 转为生产候选前必须在新的完整文件留出集上同时满足：

- A、B、C、D 工作流准确率均不低于 95%。
- 各类按文件聚类的单侧 95% 下界均不低于 90%。
- 响应率不低于 99%。
- Clean 误报不高于 1/100。
- 相对当前生产正确建议的正确转错误为 0。
- 保存重开稳定率为 100%。
- 所有输出满足唯一操作、唯一位移和唯一 5/7/9/13 年窗口契约。

当前 v34 最终留出结果已经通过准确率、下界、响应率和 Clean 门禁，但仍有 4 次原产品正确建议被改错，因此只能进入 Shadow，不能替换生产裁决器。冻结 v41 operation-transition 头另有 2 次正确转错误，不进入 Shadow 有效模型。

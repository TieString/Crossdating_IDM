# 仓库指南

Tauri + React + TypeScript 树轮交叉定年工作站。GitHub `main` 以本工作树的高准确率自动建议功能为准；切换前的旧主线保存在 `archive/main-before-auto-suggestion-2026-09-04`。

## 当前生产基线

- 自动建议入口：`src/features/crossdating/diagnosis/unifiedV5Runtime.ts`
- Worker入口：`src/pages/home/diagnosisWorker.ts`
- 冻结模型：`public/models/unifiedV5Model.json`
- 模型SHA-256：`4a355af59c22a9cd53e20d233256d94b44b83aea222d7ace55e6cb7e9bbb5c1e`
- 运行版本：`joint-explicit-global-v5-sign-invariant-local-review-v3`
- 证据：207个统一运行时字段；模型权重、事件门和13年窗口已冻结
- 已消费文件隔离校准：8406/9038＝93.01%，覆盖9026/9038＝99.87%，Clean误报29/2924＝0.99%
- co612开发压力回归：687/716＝95.95%
- 正向whole镜像校准：624/688＝90.70%；远距离混合D仍为292/349，不能声称全部解决

完整口径、A/B/C/D、文件相关性与距离分层见：

- `docs/benchmarks/unified99-accepted-model-freeze-2026-09-03.md`
- `docs/benchmarks/unified-v5-integration-2026-09-03.md`
- `docs/benchmarks/signed-whole-save-fix-2026-09-04.md`
- `docs/benchmarks/cofecha-js-dual-engine-v5-integration-2026-09-04.md`

旧实验结果不是当前运行时指标。未运行新的完整文件final，不得把校准回归称为新final。

## 关键入口

- `src/pages/Home.tsx`：界面和流程编排
- `src/pages/home/useHomeWorkspace.ts`：文件、保存、COFECHA、诊断与缓存状态
- `src/features/rwl/index.ts`：RWL识别与解析
- `src/features/rwl/edit.ts`：全部可撤销编辑和操作日志
- `src/features/crossdating/reference.ts`：参考序列和COFECHA PART 6分类
- `src/features/crossdating/diagnosis/cofechaEngineEvidence.ts`：目标排除参考芯、cofecha-js预处理和内容缓存
- `src/features/crossdating/diagnosis/unifiedV5Evidence.ts`：统一候选证据
- `src/features/crossdating/diagnosis/unifiedV5Model.ts`：冻结树模型推理
- `src/features/crossdating/diagnosis/unifiedV5Runtime.ts`：唯一操作、精确位移和条件窗口输出
- `src/features/crossdating/diagnosis/eventApply.ts`：建议到编辑计划的边界
- `src/components/DiagnosisCandidates/DiagnosisEventPanel.tsx`：建议与partial定向复核UI
- `src/services/cofecha/index.ts`：cofecha-js/官方COFECHA双引擎统一OUT入口
- `src/services/cofecha/cofechaJs.worker.ts`：浏览器Worker中的cofecha-js报告生成
- `src/services/cofecha/runner.ts`：官方COFECHA执行与OUT读取
- `src-tauri/src/commands.rs`：前端可调用的Rust命令

## 自动建议不变量

1. 默认只输出模型真正选择的一种操作：`whole`、`partial`、`missing`或`false`。
2. 禁止恢复固定的`whole -> partial -> missing`解释链。
3. whole始终显示“以局部事件复核”，点击后在同一冻结证据中从partial、missing、false选择最高分唯一操作；只有选中partial时才继续显示“以缺轮形式复核”。复核不重跑family，但每一层都可恢复上一步解释；选择只绑定当前事件和当前RWL状态。
4. missing、false、partial必须输出唯一13年窗口；whole没有局部窗口。
5. whole必须保留精确整数位移和符号。模型内whole位移描述使用`-abs(h)`消除训练方向偏差，但物理G和输出位移不得改写。
6. whole应用规划器接受正负非零整数，排除终止符，并复用`RwlEditor`日志和撤销路径。
7. 参考构建始终排除当前目标芯；运行时不得读取真值类别、事件年、原始0位置或测试协议状态。
8. 局部操作不得改写已冻结的操作或位移；窗口只在选定操作内部定位。
9. 用户应用一个事件后必须重建RWL状态，再诊断下一个事件。

## 评价口径

- 有位置事件正确：操作类型和位移正确，唯一9–13年窗口覆盖当前最靠树皮真值事件。
- whole正确：操作为whole且整体位移完全正确。
- 每个真实事件在分母中出现一次；错误或拒答只计当前事件，随后模拟人工正确解决并继续。
- partial被用户排除断裂后，可定向切换为missing；首次操作和切换深度只作审计。
- 文件相关性分档固定为0.60–0.70、0.70–0.80、≥0.80；目标干净`masterCorrelation > 0.60`只用于目标入选。
- development、calibration、final按完整RWL内容哈希隔离。

## 保存与性能

- 校验身份包含序列化RWL、路径、报告引擎、官方EXE、cofecha-js版本、undated输入和PART 8排序；全部一致才可复用，真正编辑后仍须完整验证。
- 手动“重新验证”必须强制运行，不能命中保存复用。
- 同输入在途验证只运行一次。
- 编辑后立即令报告/动态参考过期，并在300ms防抖后用当前working RWL自动重算所选报告引擎；不要求先保存源文件。
- 诊断Worker保持预处理/模型缓存，只运行当前请求和最新待处理请求；过时响应不得进入UI。
- 撤销栈内部可共享不可变日志payload；公共日志和持久化快照必须继续深拷贝隔离。
- Vite必须忽略`src-tauri`、`.benchmark-results`和`__pycache__`，不得通过提高Node堆上限掩盖监听问题。

## RWL与数据保护

- Tucson短格式和长格式必须保持格式透明：打开什么格式，保存后仍是什么格式。
- `999`与`-9999`是文件级精度/终止符，不能混作普通缺轮；显式0保留为缺轮观测。
- 自动建议只通过`RwlEditor`执行，不直接改写源Map。
- COFECHA结果保存在工作区状态；OUT只通过显式导出写到用户选择的位置。
- cofecha-js 0.2.0是默认报告引擎并在Web Worker中运行；官方引擎需要用户提供EXE。两者均返回完整OUT，PART 8只修改查看副本。
- 测试和研究脚本不得改写输入RWL。

## 参考、图表和扫描图

- COFECHA-pass动态参考使用无A标记锚定芯；没有可用动态参考时不自动建议。
- 手工参考默认只用于图表，只有显式“双线分析”可进入两线比较。
- 图表、宽度表和独立窗口共享当前事件ID与复核年份，不共享隐式备选操作。
- 扫描图按需载入，原图缓存受大小上限约束；锚点年份通过已应用操作日志重放。

## 代码与提交规则

- 生产源代码放在`src/`和`src-tauri/`；一次性实验数据与模型训练缓存只放`.benchmark-results/`，不得提交。
- 只保留当前冻结模型、直接相关测试和精简验收报告；失败实验的完整原始输出留在本地忽略目录。
- 新模块写清输入、输出和边界；不增加A/B/C/D专用规则或序列名特例。
- 使用GPL-3.0-only；第三方源码、模型或二进制必须更新`THIRD_PARTY_NOTICES.md`。
- 官方COFECHA EXE不得在未确认再分发权时加入公开仓库或Release。

## 验证命令

```text
npm run build
npm run test:production
npm run test:legacy
npx vitest run src/features/crossdating/diagnosis/__tests__/unifiedV5.test.ts
npx vitest run src/features/crossdating/diagnosis/__tests__/signedWholeCandidates.test.ts
npx vitest run src/features/crossdating/diagnosis/__tests__/eventApply.test.ts
npx vitest run src/pages/home/latestRequestQueue.test.ts src/pages/home/validationReuse.test.ts
node scripts/validate-vite-dev-watch.mjs --seconds 150
```

完整legacy诊断测试包含已知失败审计，不能用它覆盖当前v5专项结果；也不能删除失败记录后宣称全量通过。

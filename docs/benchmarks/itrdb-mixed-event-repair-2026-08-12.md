# ITRDB 混合事件修复验证（2026-08-12）

## 范围

本轮只修复具有可复用双视图证据的 C 类混合事件，并保留已冻结的 D 类
`wholeSeriesMove + 局部事件` 仲裁。所有能力测试使用冻结的 34 个高质量 ITRDB
文件、每文件一个目标序列；未按文件编号或固定年份添加生产特例。

## 修复机制

1. `missingRing + partialMove` 共用一套生成与 review 证据契约，避免事件层已经
   通过而显示层用另一套阈值拒绝。
2. `falseRing + partialMove` 保留 COFECHA 候选的来源段，在远距离弱伪轮峰覆盖
   正确累计位移时，以来源段为内部定位锚点；仍要求逐参考芯方向和收益通过门槛。
3. 两个相距 5-13 年的负向 `partialMove` 使用完整纠正竞争。raw 与 COFECHA
   两个视图必须选中相同的位移幅度顺序，并同时胜过单次累计移动和其他幅度组合。
4. 对幅度至少 10 年、旧窗口没有结构化位置证据的 partial，允许 12 条以上配对
   参考支持的结构化反事实窗口替代旧远峰；已有结构化窗口不受此规则影响。

## C 类结果

冻结基线：
`D:\软件测试\itrdb-operation-capability\results\dev-CD-1perfile-v1`

| 场景 | 基线恢复事件 | 修复后恢复事件 | 完整案例 | 结果目录 |
| --- | ---: | ---: | ---: | --- |
| C3 partial + partial | 0/68 | 4/68 | 2/34 | `dev-C3-A3-pair-contract-v1b` |
| C6 missing + partial | 7/68 | 9/68 | 4/34 | `dev-C67-shared-contract-v3` |
| C7 partial + missing | 3/68 | 3/68 | 1/34 | `dev-C67-shared-contract-v3` |
| C8 false + partial | 0/68 | 2/68 | 1/34 | `dev-C8-A23-segment-contract-v1` |

- C3 新增完整恢复 `ca612:PMN02A` 与 `co589:at2062`；旧基线没有正确案例被覆盖。
- C6/C7 原有 10 个已恢复事件全部保留，新增 ca612 C6 的两个事件。
- A3 单局部移动逐案对照由 16/34 提升到 18/34；旧 16 个正确案例保持率 100%，
  `正确 -> 拒答`、`正确 -> 窗口偏移`、`正确 -> 错误操作` 均为 0。
- ca612 的 C3 与 C8 最终冒烟均为 2/2，唯一窗口覆盖真断点，保存重开稳定。
- C4/C5 的缺轮与伪轮抵消、C9 的伪轮与局部移动反向顺序没有足够一致的双视图
  证据，本轮保持安全拒答或原失败结果，没有通过放宽门槛强制恢复。

## D 类无回归

最终目录：
`D:\软件测试\itrdb-operation-capability\results\dev-D-final-C-contract-v1`

- 136 个案例、408 个真事件，恢复 182/408，完整案例 40/136。
- 与 `dev-D-whole-first-v3` 逐案例比较，136/136 状态完全相同。
- 已恢复事件损失 0，`正确 -> 错误操作` 0。
- 窗口中位宽度/P90 为 9/13 年，非法宽度 0，保存重开稳定率 100%。

## co612 门禁

- `validate:co612-recovery-regression`：首轮正确窗口 26，门槛 22；clean review
  2/55；操作不一致 0。
- 从冻结 351 检查点复制到
  `adaptive-351-C-mixed-contract-2026-08-12` 后独立续跑，恢复 358/358，
  `stopReason=all_events_recovered`，最终 zero-lag 100%、绝对 lag P90 为 0。
- 源文件 SHA-256 前后均为
  `b1d4756303eb1c8af9805e5f14a95b7e4e04c6ef18ada0a86aa9dedf715af048`。

## 自动验证

- 核心诊断 Vitest：6 个文件、181 项通过。
- ZSL141、ausl038 和 partial 固定侧/幅度语义：23 项通过。
- co612 冻结夹具的算法回归：18 项通过；另一个夹具身份断言仍写死旧版
  `mon052:1870`，当前冻结源实际为 `1879`，不属于诊断失败。
- `npm run build` 通过。

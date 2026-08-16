# JS 定年建议论文图组（v2 版式）

本目录包含基于 `js-diagnosis-events-v1` 工作树与现有跨文件测试结果生成的论文图组。全部图件由 `scripts/figures/generate-js-diagnosis-events-figures.py` 使用 Python / matplotlib 绘制，统一采用英文 Times New Roman，并提供可编辑矢量版本。

## 图件结构

1. `fig01_system_architecture`：竖版闭环架构，展示 RWL 状态、参考年表、lag 拓扑、编辑反事实、多芯证据、统一裁决和逐事件重诊断。
2. `fig02_performance_validation`：以家族恢复率、指标热图、单事件区间、跨文件散点和完整性指标展示现有测试性能。
3. `fig03_event_definition_table`：用四列明确定义事件与可执行编辑、lag 指纹、生态/样品含义和识别证据。
4. `fig04_complex_case_discrimination`：展示六类 lag 指纹、三组易混模式的区分线索、证据融合和逐事件更新流程。
5. `fig05_validation_design_and_failures`：展示文件级隔离协议、A–D 场景家族、能力覆盖矩阵及可复现更新路径；文件名为兼容旧引用而保留。

## 当前定量输入

- 数据：`docs/benchmarks/itrdb-current-generalization-result-v1.json`
- RWL 文件：23
- A/B 真值事件：644
- C/D 真值事件：690
- 文件聚类 bootstrap：10,000 次

后续结果完成后只需替换 JSON 并重跑同一脚本，版式、指标和源数据表会同步更新：

```powershell
python scripts/figures/generate-js-diagnosis-events-figures.py `
  --result-json <new-result.json> `
  --output-dir docs/figures/js-diagnosis-events-v2
```

## 图注要点

### Figure 1

JS crossdating event diagnosis workflow. Format-preserving RWL state and manual or COFECHA-pass reference chronologies feed constrained lag topology, executable edit counterfactuals and independent-core evidence. Joint adjudication resolves one operation, shift and focused review window; each confirmed edit is committed to the auditable RWL state before rediagnosis.

### Figure 2

Cross-file performance of the dating recommendation module. Family-level intervals use 10,000 file-cluster bootstrap replicates; single-event intervals are Wilson 95% confidence intervals. Complementary panels report strict recovery, response, operation, window localization, file-level generalization and execution integrity.

### Figure 3 / Table 1

Crossdating events and their recognition evidence. Negative whole-series movement is consistent with tree death, missing bark or sapwood, or bark-side breakage; localized movement is consistent with decay, fracture, segment loss or a within-core splice. Missing and false rings are resolved through signed unit transitions and matched insert/delete counterfactuals.

### Figure 4

Discrimination of complex crossdating patterns. Transition count, intermediate lag plateaus, fixed-side baseline, operation-specific counterfactuals and independent-core votes distinguish continuous gaps from event staircases, whole-plus-local events from pure partial shifts, and local cancellation from a flat long-window match.

### Figure 5

Cross-file benchmark design and capability coverage. The benchmark isolates RWL files, injects four frozen scenario families, executes the product-equivalent diagnostic path and scores one event at a time. The coverage matrix and reproducibility cards summarize the tested capabilities and direct JSON-to-publication update path.

## 文献设计依据

- Bunn, 2010, *Dendrochronologia*: moving/segment correlation and graphical crossdating diagnostics. <https://www.sciencedirect.com/science/article/pii/S1125786510000172>
- Reynolds et al., 2021, *Dendrochronologia*: graphical identification of missing and false rings. <https://www.sciencedirect.com/science/article/pii/S1125786520301363>
- Grissino-Mayer, 2001: COFECHA quality-control workflow. <https://sheppard.ltrr.arizona.edu/Raul/GrissinoCOFECHA.pdf>
- RWLApp: integrated and traceable tree-ring analysis workflow. <https://www.repository.cam.ac.uk/items/fa868902-6bad-405c-8d38-18332cd7d2ee>

## 输出

每张图提供 `SVG`、`PDF`、350 dpi `PNG` 和 600 dpi LZW `TIFF`。`source_data/` 保存定量面板与事件定义 CSV；`figure_manifest.json` 保存输入哈希和输出清单。运行 `python scripts/figures/qa-js-diagnosis-events-figures.py` 可检查字体、矢量文字、PDF 文本、分辨率、页数和源数据完整性。

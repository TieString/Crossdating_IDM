# Unified adjudicator v2 development report

## Status

The new-file protocol is active. The previous 25 files remain regression-only, and the 17-file final holdout has not been executed.

Development uses 18 previously unseen high-quality RWL files, 108 frozen targets, one baseline scenario seed, and two additional frozen development-only seeds. All OOF fitting and inner calibration exclude every scenario from the held-out RWL file.

## New-file baselines

| Dataset | Event opportunities | Product workflow accuracy | Strict candidate Oracle | Relaxed Oracle | Clean false positives |
| --- | ---: | ---: | ---: | ---: | ---: |
| Development baseline | 1,042 | 91.75% | 97.98% | 98.75% | 0/108 |
| Calibration v1 | 567 | 91.18% | 96.30% | 97.53% | 0/60 |

The development failures are primarily evidence projection (37) and joint selection (17). Sixty of 86 failures have a strict answer in the raw grid.

## Frozen safe improvement

The strongest zero-regression development result is `development-augmented-structured-oof-v4-pair-floor`:

| Metric | Product | Unified v2 OOF |
| --- | ---: | ---: |
| Correct / events | 956/1,042 | **968/1,042** |
| Workflow accuracy | 91.75% | **92.90%** |
| Corrected failures | - | 12 |
| Correct to incorrect | - | **0** |
| Response rate | 99.23% | **99.62%** |
| Clean false positives | 0/108 | **0/108** |

By family, the unified result is A 98.15%, B 90.21%, C 92.59%, and D 94.35%. A minimum pair-consistency floor of 0.001 removed the only development regression while retaining all useful overrides.

## Calibration result

Three models fitted on all development scenarios and gated on calibration v1 reached 526/567 = 92.77%, with nine corrections, zero correct-to-incorrect changes, 99.12% response, and 0/60 Clean false positives. This is safe but far below the requested 95.5% target. Calibration v1 is therefore considered consumed and must not be reused as an independent final evaluation.

## Architecture experiments

| Experiment | Result | Decision |
| --- | --- | --- |
| Single-seed structured heads | 92.03%, 4 helpful / 1 harmful | Reject |
| Direct pair operation selector | 91.84%, 3 helpful / 2 harmful | Reject |
| Three-seed structured heads | 92.71%, 11 helpful / 1 harmful | Superseded |
| Pair floor 0.001 | **92.90%, 12 helpful / 0 harmful** | Freeze as safe checkpoint |
| Stacked location head | 92.42%, 10 helpful / 3 harmful | Reject |
| Global candidate residual | 92.42%, 7 helpful / 0 harmful, 1 Clean FP | Do not replace structured heads |
| Candidate/pair/ranker OOF meta | Correct operation Top1 19/35 | Reject |
| Candidate-level LambdaRank | Correct operation Top1 17/35 | Reject |
| Product-package feature expansion | 92.61%, 11 helpful / 2 harmful | Reject |

## Hierarchical evidence findings

Separating operation identity from location changes the diagnosis ceiling materially:

- Operation/shift identity Top1: 44/54 recoverable failures (81.5%).
- Candidate-summary location within a correct identity: 18/44 complete windows.
- Cross-projected candidate-summary location: 21/44.
- Full yearly counterfactual rows: **31/43** complete 13-year windows (72.1%).

The full yearly result confirms that operation evidence and location evidence are both present but were compressed into incompatible summaries. The evaluation audit previously discarded the yearly `JointCounterfactualOperationScore.rows`; a read-only extractor now recomputes those rows only for the selected operation identity from existing `state.rwl` and `VERYCOF.OUT` files.

The remaining blocker is selective override. A package-error classifier reached AUC 0.83, but zero-harm selection safely released only 2-3 of 28 correct hierarchical proposals. An OOF benefit/harm meta-selector also released only two. Thus the 95.5% target cannot be claimed under the required zero-regression contract yet.

## Negative-result boundary

The experiments show that adding more generic downstream models is no longer useful. Further work should focus on calibrated package reliability and the direct yearly operation-location joint hypothesis, not on another candidate-list ranker. The final holdout remains sealed until a development model reaches the safety gate and the replacement calibration set is frozen.

## External artifacts

- Runs: `D:\软件测试\itrdb-unified-model-v2\runs`
- Models and OOF predictions: `D:\软件测试\itrdb-unified-model-v2\models`
- Safe checkpoint: `development-augmented-structured-oof-v4-pair-floor`
- Yearly evidence experiment: `development-yearly-location-oof-v12`
- Calibration shadow: `calibrated-shadow-v1`

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

The overall model one-sided 95% file-clustered lower bound is 91.43%. The gain over product has a one-sided 95% lower bound of +0.58 percentage points. Family lower bounds are A 96.30%, B 86.98%, C 89.81%, and D 92.15%.

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

Allowing the immutable product-package identities to participate in the operation table raised development operation Top1 to 65/81 recoverable failures. The corresponding full-year ranker produced 43 complete workflow-correct proposals. This is a raw proposal ceiling of 999/1,042 = 95.87% before selective safety gating; it is not a deployable accuracy claim.

The remaining blocker is selective override. A package-error classifier reached AUC 0.83, but zero-harm selection safely released only 2-3 of 28 correct hierarchical proposals. An OOF benefit/harm meta-selector also released only two. Thus the 95.5% target cannot be claimed under the required zero-regression contract yet.

## Replacement calibration v2

The first 10-file calibration was consumed by architecture diagnosis. All 12 untouched pre-frozen reserve files were therefore committed as replacement calibration v2 before running them.

- Product baseline: 618/686 = 90.09%.
- Strict/relaxed Oracle: 97.52% / 98.25%.
- Product Clean false positives: 1/72.
- All-identity operation Top1 after fixing run-tag namespace isolation: 44/65 recoverable failures.
- Global full-year location Top1: 28/44.
- Event-type-specific full-year location Top1: 30/44.
- Global/type-specific union: 30/44; probability-mass 13-year windows did not improve it.
- Even if all 30 correct complete proposals were applied with perfect safety, the ceiling would be 648/686 = 94.46%.

The replacement calibration ceiling is below the requested 95.5%. The final 17-file holdout was therefore not opened, and no production or shadow replacement threshold was approved.

## Direct operation x year and immutable-package experiments

The previous yearly experiment expanded only the operation head's Top1 identity. A
truth-blind batch extractor now expands a fixed set consisting of operation Top8,
the immutable product-package identities, and the best identity of each local
operation type. One diagnosis computes the complete counterfactual grid once; the
extractor only projects selected identities from that shared grid.

On development failures, the correct operation identity is in Top1 for 65/81
recoverable attempts, Top5 for 80/81, and Top10 for 81/81. On replacement
calibration the corresponding counts are 44/65, 64/65, and 64/65. Thus Top1
truncation loses real evidence, but merely exposing more identities is not enough.

The file-OOF direct operation-year ranker used 1,262,632 development rows and 77
truth-free features:

- Direct proposal corrected 43 product failures, giving a product/proposal Oracle
  union of 999/1,042 = 95.87%.
- A development-frozen blend of within-attempt yearly z-score and operation
  percentile (`joint_z + 0.75 * operation_percentile`) exposed 41 failures not
  already corrected by the safe structured checkpoint. Its safe-base/proposal
  Oracle union is 1,009/1,042 = 96.83%; this is a proposal ceiling, not a deployable
  result.
- A post-hoc package selector using both yearly and 261-dimensional package
  evidence achieved benefit/harm AUC 0.92 on discordant proposals. Requiring zero
  correct-to-incorrect changes and zero Clean false positives released only seven
  additions, for 975/1,042 = 93.57%.
- A single listwise immutable-package table reduced unconditional harmful choices
  from 135 to 13, but its zero-harm margin gate released only one correction.
  Asymmetric group weights and a direct package-pair classifier did not improve
  this boundary.

The same frozen development models were then applied once to replacement
calibration v2. No calibration outcome was used to alter features, weights, or the
development-frozen blend:

| Calibration proposal | Corrections | Product/proposal Oracle union |
| --- | ---: | ---: |
| Direct joint operation-year Top1 | 31/68 | **649/686 = 94.61%** |
| Development-frozen score blend | 30/68 | 648/686 = 94.46% |

For the direct joint model's 68 product failures, 48 selected the correct operation
identity and 31 also selected a covering window. The remaining failures split into
20 wrong operation identities and 17 correct-operation/wrong-window cases. The
independent perfect-selection ceiling therefore remains below 95.5% before any
safety gate is applied.

This rejects the hypothesis that one more downstream selector can reach the target.
The next useful experiment must improve the generated operation identities and
yearly location distributions themselves. The 17-file final holdout remains sealed,
and these models are not approved for shadow or production integration.

No production diagnosis module was changed in this experiment. The historical `validate-co612-recovery-regression.mjs` entry point is no longer present after the repository cleanup, so that removed command could not be rerun; Python model tests, Oracle tests, split tests, capability TypeScript compilation, and the production build all pass.

## Negative-result boundary

The experiments show that adding more generic downstream models is no longer useful. Further work should focus on calibrated package reliability and the direct yearly operation-location joint hypothesis, not on another candidate-list ranker. The final holdout remains sealed until a development model reaches the safety gate and the replacement calibration set is frozen.

Replacement calibration is now frozen and completed, but its 94.46% perfect-selection proposal ceiling still misses the target. Reaching 95.5% requires improving the operation identity and yearly location generators themselves on unseen files, not relaxing the zero-regression selector.

## External artifacts

- Runs: `D:\软件测试\itrdb-unified-model-v2\runs`
- Models and OOF predictions: `D:\软件测试\itrdb-unified-model-v2\models`
- Safe checkpoint: `development-augmented-structured-oof-v4-pair-floor`
- Yearly evidence experiment: `development-yearly-location-oof-v12`
- Calibration shadow: `calibrated-shadow-v1`
- Replacement calibration run: `reserve-calibration-v2`
- Replacement calibration operation model: `reserve-calibration-all-identity-operation-v3-fixed`
- Replacement calibration yearly models: `reserve-calibration-yearly-location-v1` and `reserve-calibration-yearly-location-by-type-v2`
- Development Top-K yearly rows: `development-joint-identity-rows-v21`
- Development direct joint OOF: `development-joint-operation-year-oof-v22-stride5`
- Development immutable-package experiments: `development-joint-package-selector-oof-v24-candidate-pairs`, `development-joint-blended-package-selector-oof-v26`, and `development-immutable-package-pair-oof-v30`
- Replacement calibration Top-K rows: `reserve-calibration-joint-identity-rows-v31`
- Replacement calibration direct joint result: `reserve-calibration-joint-operation-year-v32`

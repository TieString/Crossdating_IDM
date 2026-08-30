# Immutable bottom-evidence location experiment v3

## Scope

- Branch: `experiment`
- Production selector and its weights: unchanged
- Candidate generator, operation identity, shifts, and 5/7/9/13-year windows: frozen
- Validation: five-fold OOF grouped by complete RWL file over 50 files
- Event attempts: 4,118; Clean attempts: 500
- Residual proposals: 10,333 truth-blind candidates from the frozen listwise/pairwise shortlist

This experiment adds evidence only after virtually applying an immutable proposal:

- newer-side transition and lag-path residuals at offsets 1/5/9/13;
- before/after per-reference difference and pre-whitened agreement;
- within-diagnosis rank, z-score, winner margin, and relative improvement.

No file ID, series ID, family label, fixed calendar year, or truth field is a model feature.

## Selected OOF result

The selected feature set excludes the negative overlapping-score mode aggregation.

| Metric | Previous frozen location v1 | Selected v3 | Change |
| --- | ---: | ---: | ---: |
| Workflow correct | 3,688 / 4,118 | 3,699 / 4,118 | +11 |
| Workflow accuracy | 89.56% | 89.83% | +0.27 pp |
| File-cluster one-sided 95% lower | 88.01% | 88.36% | +0.35 pp |
| Response rate | 99.76% | 99.76% | 0 |
| Clean false positives | 0 / 500 | 0 / 500 | 0 |
| Window errors | 180 | 171 | -9 |
| Operation/shift errors | 118 | 117 | -1 |
| Frontier errors | 66 | 65 | -1 |
| Refusals | 8 | 8 | 0 |
| Candidate-Oracle misses | 58 | 58 | 0 |

Relative to v1, v3 repaired 24 attempts and regressed 13. It is therefore a useful shadow improvement, but it does not satisfy the zero correct-to-wrong production gate.

### By family

| Family | Correct | Accuracy | File-cluster one-sided 95% lower |
| --- | ---: | ---: | ---: |
| A | 471 / 500 | 94.20% | 92.40% |
| B | 1,116 / 1,206 | 92.54% | 90.71% |
| C | 1,071 / 1,206 | 88.81% | 86.92% |
| D | 1,041 / 1,206 | 86.32% | 83.71% |

## Predefined ablations

All rows use the same candidate proposals, file folds, learner parameters, and labels.

| Evidence configuration | Correct | Net vs frozen pairwise location | Repairs | Regressions |
| --- | ---: | ---: | ---: | ---: |
| Existing applied-residual v1 | 3,688 | +19 | 45 | 26 |
| v3 without overlapping-score mode aggregation | **3,699** | **+30** | 50 | 20 |
| v3 without per-reference evidence | 3,694 | +25 | 49 | 24 |
| v3 without multi-offset newer-side evidence | 3,688 | +19 | 45 | 26 |
| v3 with all features, including mode aggregation | 3,692 | +23 | 48 | 25 |

Per-reference and multi-offset residual evidence both contribute. Summing nearby listwise/pairwise scores into a physical-mode mass is negative: it reinforces broad plateaus and loses seven correct decisions relative to the selected configuration. That negative result is retained here and the feature is not kept in the selected implementation.

## Shortlist capacity audit

The complete candidate Oracle is 4,057 / 4,118 (98.52%), but expensive residual evaluation initially covered only the union of each identity's top two listwise and top two pairwise years. With the frozen operation head, that shortlist has an end-to-end ceiling of only 3,784 / 4,118 (91.89%).

| Per-head rank depth | Residual proposals | End-to-end Oracle ceiling |
| ---: | ---: | ---: |
| 2 | 10,464 | 91.89% |
| 4 | 19,180 | 93.30% |
| 8 | 35,816 | 94.32% |
| 12 | 52,519 | 95.02% |
| 16 | 69,617 | 95.29% |

Consequently, stronger evidence on only the first two modes cannot reach the 95% target. A later experiment must evaluate a wider set of already-frozen candidates; this does not add a locator rule or widen any output window.

## Status

- Shadow experiment only.
- Production adjudicator remains unchanged.
- Candidate Oracle and Clean behavior are unchanged.
- Next step: evaluate baseline-conditioned operation evidence, then decide whether the cost of rank-depth 12 residual evaluation is justified.

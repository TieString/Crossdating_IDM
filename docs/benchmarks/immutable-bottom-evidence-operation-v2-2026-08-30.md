# Immutable operation evidence v2 (2026-08-30)

## Scope

This shadow experiment keeps the 50-file external split, scenario rows,
candidate identities, operation shortlist, model parameters, and production
selector frozen. It changes only truth-blind evidence generated after applying
each of the preselected Top4 operation identities.

The evidence changes are:

- corrected `partialMove` fixed-side semantics (`firstFixedYear` is fixed);
- diagnosis-relative raw deltas plus within-attempt rank, z-score, and margin;
- whole-series/global and newest-side baseline resolution;
- full-series lag mode and local 1/3-segment boundary lag steps;
- multi-offset newer-side residual transition and path persistence;
- explicit newer-residual versus corrected-boundary margins.

Per-reference operation residuals were excluded before this run because the
frozen ablation showed that they belong in the location head, not the operation
head. No file ID, series ID, family label, calendar year, or truth field enters
the model.

Artifacts:

- proposals: `external50-applied-residual-operation-top4-v2/proposals.csv`;
- residual evidence: `external50-applied-residual-operation-top4-v6-baseline-frontier-boundary/residual`;
- selected OOF output: `external50-operation-residual-oof-v6-full`.

## File-OOF result

| Model | Correct | Workflow accuracy | File-cluster one-sided 95% lower | Exact operation | Response | Clean FP |
|---|---:|---:|---:|---:|---:|---:|
| Frozen operation head | 3917/4118 | 95.12% | 94.21% | 95.56% | 99.76% | 0/500 |
| Previous residual best | 3939/4118 | 95.65% | 94.80% | 96.04% | 99.78% | 1/500 |
| New baseline/frontier evidence | **3941/4118** | **95.70%** | **94.85%** | **96.09%** | **99.76%** | **1/500** |

Relative to the previous shadow result, the new evidence repairs 7 attempts and
regresses 5, for a net gain of 2. Relative to the frozen operation head it
repairs 40 and regresses 16, for a net gain of 24. Production remains on the
frozen head, so these shadow regressions do not affect application behavior.

## By family

| Family | Correct | Workflow accuracy | File-cluster one-sided 95% lower | Exact operation |
|---|---:|---:|---:|---:|
| A | 490/500 | 98.00% | 97.00% | 98.00% |
| B | 1177/1206 | 97.60% | 96.69% | 97.84% |
| C | 1177/1206 | 97.60% | 96.65% | 98.51% |
| D | 1097/1206 | 90.96% | 89.06% | 91.13% |

A/B/C exceed the point and lower-bound goals. D improves by 10 cases over the
frozen head but remains below both goals, so this model is not eligible for
production replacement.

## Frozen ablations

| Evidence | Correct | Accuracy | Repairs | Regressions | D correct | D lower |
|---|---:|---:|---:|---:|---:|---:|
| Full evidence | **3941** | **95.70%** | 40 | 16 | **1097** | **89.06%** |
| Without newer-frontier margins | 3939 | 95.65% | 40 | 18 | 1097 | 89.04% |
| Without operation/baseline evidence | 3929 | 95.41% | 33 | 21 | 1089 | 88.30% |

The newer-side frontier projection contributes a net 2 and removes two frozen
regressions. Baseline-conditioned operation evidence contributes a net 12 and
is especially important in D. The strongest new learned terms include whole
newest-lag resolution, post-correction newest-lag magnitude, and the candidate
distance to the local three-segment lag step.

## Remaining operation failures

The 177 wrong operation/shift outputs decompose before location selection as:

| Failure layer | Count |
|---|---:|
| No workflow-correct identity in the complete frozen candidate table | 59 |
| Correct identity exists globally but not in frozen Top4 | 22 |
| Correct identity is in Top4 but the operation head ranks another identity first | 96 |

The largest remaining shortlist confusions are false ring versus partial move,
partial move versus whole-series move, and exact partial/whole shift magnitude.
Ten event attempts return `noEvent` (A 1, B 3, C 3, D 3); the response rate is
unchanged from the frozen head.

## Error-layer accounting

- Operation/shift: 201 frozen failures become 177 in this operation-only view;
  compared with the previous shadow, 179 become 177.
- Frontier: the explicit newer-side evidence has a positive net ablation of 2,
  but final frontier classification is deferred to the same-identity location
  stage.
- Window: unchanged in this stage; no candidate year or window was added,
  moved, or widened.
- Refusal: unchanged at 10 event attempts.
- Candidate Oracle: unchanged; this experiment only reranks immutable Top4
  identities.

The next stage must generate the location shortlist from this operation head's
selected identity. Reusing the old identity-only location table would violate
the operation-head to same-identity-location-head contract.

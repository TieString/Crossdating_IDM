# ITRDB operation capability v4-1000 result

## Run identity

- Protocol: `itrdb-operation-capability-v4-1000`
- Dataset role: `expandedFrozenHoldoutReuse`
- Execution commit: `55167644a924ab1a07c7453e0f331ced96e96a53`
- Files: 25 frozen ITRDB files
- Targets: 1,000; the prior 500 targets were retained and 500 targets were added by a fixed, diagnosis-blind hash
- Cases: 5,000 (`Clean`, `A`, `B`, `C`, and `D`: 1,000 each)
- Truth events: 9,540
- Workers: 16
- Case errors: 0
- Source files unchanged: yes
- Result directory: `D:\软件测试\itrdb-operation-capability\results\paper-v4-1000-expanded-generalization-55167644-20260817`
- `summary.json` SHA-256: `abca37083ca3e2095eb095cc54281a0d20d7aad78322595f694afce3cb840a27`

This is an expanded reuse of the existing 25-file holdout, not a new untouched holdout. The scenario freeze was regenerated for the v4 protocol, so the older v3 result is useful context but is not a paired comparison.

## Primary results

`Workflow suggestion accuracy` uses correct recovered frontier suggestions divided by all frontier attempts. Refusals, wrong operations, wrong shifts, and missed windows are failures. The confidence bound is the file-clustered, one-sided 95% micro lower bound.

| Family | Cases | Correct / attempts | Accuracy | One-sided 95% lower | Serial recovery | Response | Conditional local-window coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 1,000 | 904 / 1,000 | 90.40% | 87.83% | 90.40% | 98.90% | 96.51% |
| B | 1,000 | 2,142 / 2,480 | 86.37% | 84.47% | 71.38% | 98.75% | 94.95% |
| C | 1,000 | 2,004 / 2,361 | 84.88% | 82.60% | 66.73% | 98.60% | 90.64% |
| D | 1,000 | 1,493 / 1,947 | 76.68% | 74.18% | 58.87% | 97.38% | 93.69% |

Observed A accuracy exceeded 90%, but its clustered lower bound did not. B, C, and D missed both the observed 90% target and the lower-bound target.

Across all event families, 6,543 of 7,788 frontier suggestions were fully correct (84.01%). Serial recovery was 6,543 of 9,540 truth events (68.58%). Clean false positives were 7/1,000 (0.70%).

## Safety and presentation checks

- Save/reopen stability: 100%
- Positive automatic whole-series moves: 0
- Illegal window widths: 0
- Median/P90 local window width: 13/13 years overall
- Overall refusal rate: 1.62%
- Overall conditional local-window coverage: 93.37%
- Partial-move misclassification rate: 5.72%
- Whole-series-move misclassification rate: 1.03%

The low aggregate result is therefore not primarily caused by refusal or invalid windows. Final stop reasons were 685 wrong operations, 330 window misses, 126 refusals, and 104 out-of-order frontiers.

## Main weak points

A subtypes separated sharply:

| A subtype | Workflow accuracy |
| --- | ---: |
| Single missing ring | 95.63% |
| Single false ring | 88.40% |
| Single partial move | 80.40% |
| Single negative whole-series move | 97.18% |

B failures were concentrated in repeated partial moves: `n=2` 78.97%, `n=3` 75.71%, and `n=4` 72.20%. Repeated missing rings remained 92.45%-95.26%; repeated false rings were 86.02%-87.75%.

C retained high workflow-equivalent operation accuracy (93.65%) but lost full suggestion accuracy through adjacent-event window/frontier ordering, especially four missing rings at five-year spacing (70.30%).

D was dominated by operation arbitration in mixed events. Its wrong-operation rate was 16.13%, while conditional window coverage after a correct operation remained 93.69%. The weakest frozen scenario was whole + missing + partial + false at 68.78% workflow accuracy.

Whole-shift-tagged cases (A and D combined) produced 75.88%-81.56% complete frontier accuracy across `-4`, `-11`, `-20`, and `-50`. Since isolated A whole moves reached 97.18%, the main loss is mixed-event arbitration rather than inability to estimate a large negative whole shift by itself.

## Retained versus added targets

Within the new v4 scenario freeze:

| Family | Prior 500 targets | Added 500 targets |
| --- | ---: | ---: |
| A | 91.60% | 89.20% |
| B | 87.28% | 85.46% |
| C | 83.66% | 86.05% |
| D | 76.35% | 77.02% |
| Clean false positive | 0.40% | 1.00% |

The added targets explain only a small part of the lower result. In particular, D is similarly weak in both halves. This points to a general mixed-event adjudication limitation rather than a handful of newly selected difficult series.

## Reproduction artifacts

- `summary.json`: aggregate, per-family, per-scenario, per-file, shift-stratified, and clustered-bootstrap metrics
- `cases.csv` / `cases.json`: all 5,000 case outcomes
- `steps.csv` / `steps.json`: all serial frontier decisions
- `run-plan.json` / `resolved-cases.json`: exact frozen execution plan

Pre-run protocol verification passed 17 Vitest assertions and `npm run typecheck:itrdb:capability`.

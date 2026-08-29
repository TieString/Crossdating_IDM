# ITRDB Frozen External Test v1

## Protocol

This was a prediction-only external test. No training, calibration, threshold
change, or case replacement was performed after the file list and scenarios
were frozen.

- 50 previously unused RWL files, 10 eligible target series per file.
- Clean/A/B/C/D: 500 scenarios per family.
- 4,118 truth events and 4,618 total diagnosis attempts including Clean.
- File and target COFECHA problem-segment counts were zero.
- All selected targets were at least 100 years long and contained no natural
  zero markers.
- Each scenario modified one target series; references and COFECHA outputs were
  regenerated from that scenario.
- Local proposals were evaluated as one 13-year window around the selected
  year. Whole-series moves required the exact negative shift.
- Runtime manifest verification: 103 files, zero hash mismatches.
- Source RWL files were unchanged; benchmark errors: zero.

Frozen identifiers:

- Evidence commit: `cfa2156dbb7b7686dcc5304b56577bc66d8f6284`
- Protocol commit: `e59203fccedbedef305f6b6b96cac73f49a8661f`
- Runtime manifest SHA-256: `e6a71f97e8404746708c99fb567e924f47c763866f8d0d963677d9777ea23ca8`
- Scenario generator SHA-256: `6655e16f3e2ad2724caa19e4078c993b5b7be6560256833dc97251f9986a83b3`
- File manifest SHA-256: `b1ecbe95bd59dc311226f09c0e50c4ce52c0ccf6cc3c60a23b9d6922e4b5d47b`
- Frozen package SHA-256: `743c184fb063ac7c770b27712d78c432788915707709930dbfe30c6e053313c2`

## Main Results

The workflow column is the all-event result after a failed frontier is counted
as failed, manually resolved in the simulation, and later events receive their
own diagnosis opportunity. Direct serial stops credit after the first blocking
failure.

| Family | Correct / events | Workflow | One-sided 95% lower | Macro by file | Strict | Response | Direct serial |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 455/500 | 91.00% | 88.60% | 91.00% | 86.20% | 99.80% | 91.00% |
| B | 1083/1206 | 89.80% | 87.85% | 90.13% | 87.56% | 99.75% | 82.01% |
| C | 1066/1206 | 88.39% | 86.17% | 89.13% | 74.46% | 99.75% | 76.37% |
| D | 960/1206 | 79.60% | 76.33% | 80.45% | 77.61% | 99.34% | 63.60% |
| Overall | 3564/4118 | 86.55% | 84.61% | 87.08% | 80.65% | 99.64% | 76.06% |

- Refusals: 15/4,118, or 0.36%.
- Clean false positives: 0/500.
- Complete direct-serial cases: 1,555/2,000, or 77.75%.
- Complete direct-serial case rates: A 91.0%, B 80.4%, C 77.0%, D 62.6%.
- Operation accuracy: 3,743/4,118, or 90.89%.
- Strict candidate Oracle: 4,051/4,118, or 98.37%.
- Workflow-equivalent candidate Oracle: 4,057/4,118, or 98.52%.

For comparison, the production selector on the same scenarios achieved
2,962/4,118 (71.93%) after manual unblocking and 2,280/4,118 (55.37%) in direct
serial recovery, with 3/500 Clean false positives. The standalone frozen model
made 683 previously wrong attempts correct, but changed 81 production-correct
attempts to wrong. Correct retention was therefore 97.27%, not the required
100% safety gate.

## Fixed Strata

| Dimension | Level | Correct / events | Workflow | One-sided 95% lower |
| --- | --- | ---: | ---: | ---: |
| File correlation | 0.50-0.60 | 120/143 | 83.92% | 80.82% |
| File correlation | 0.60-0.70 | 917/1123 | 81.66% | 78.88% |
| File correlation | 0.70-0.80 | 1663/1922 | 86.52% | 83.40% |
| File correlation | >=0.80 | 864/930 | 92.90% | 91.39% |
| Target/master correlation | 0.60-0.70 | 1122/1394 | 80.49% | 77.82% |
| Target/master correlation | 0.70-0.80 | 1460/1663 | 87.79% | 85.44% |
| Target/master correlation | >=0.80 | 982/1061 | 92.55% | 89.77% |
| Target length | 100-199 | 1556/1722 | 90.36% | 88.53% |
| Target length | 200-299 | 1200/1397 | 85.90% | 83.47% |
| Target length | >=300 | 808/999 | 80.88% | 77.52% |
| Frontier position | Bark-near 15-34 | 794/989 | 80.28% | 76.77% |
| Frontier position | Newer 35-69 | 1185/1346 | 88.04% | 85.55% |
| Frontier position | Middle >=70 | 1476/1658 | 89.02% | 87.12% |
| Event count | 1 | 455/500 | 91.00% | 88.40% |
| Event count | 2 | 1817/2022 | 89.86% | 88.36% |
| Event count | 3 | 890/1080 | 82.41% | 79.06% |
| Event count | 4 | 402/516 | 77.91% | 73.37% |
| Reference depth | 6-9 | 78/97 | 80.41% | 80.41% |
| Reference depth | 10-19 | 866/985 | 87.92% | 85.66% |
| Reference depth | 20-39 | 2066/2396 | 86.23% | 83.20% |
| Reference depth | >=40 | 554/640 | 86.56% | 83.05% |

Only two qualifying files existed in the 0.50-0.60 file-correlation stratum,
so that stratum cannot support a stable 13-file estimate. The frozen file
counts were 2/13/23/12. Eligible target lengths were 246/167/87 for
100-199/200-299/>=300 years; the quality gates were not relaxed to manufacture
balance. Full family-by-stratum rows are retained in `strata.csv` with the raw
external artifacts.

Candidate Oracle and mutually exclusive failure attribution by file and
target/master correlation are reported in
[`itrdb-frozen-external-v1-correlation-oracle-audit-2026-08-29.md`](itrdb-frozen-external-v1-correlation-oracle-audit-2026-08-29.md).

For multi-event families, the workflow accuracies by event count were:

| Family | 2 events | 3 events | 4 events |
| --- | ---: | ---: | ---: |
| B | 91.99% | 86.94% | 87.21% |
| C | 92.88% | 84.72% | 78.49% |
| D | 84.72% | 75.56% | 68.02% |

## Remaining Failures

Of 554 failed event opportunities:

- Operation or exact-shift error: 347.
- Window-location error: 149.
- Workflow-equivalent frontier error: 41.
- Refusal: 15.
- Final package-projection inconsistency: 2.

By processing stage, 495 failures had a workflow-correct immutable package but
lost it during final ranking/adjudication; 59 failures had no workflow-correct
immutable package. The latter includes two refusals. Two additional attempts
without a correct immutable package were corrected by the post-package whole
projection and are successes, not failures.

The exclusive operation errors were concentrated in D (183), followed by B
(75), C (60), and A (29). The most frequent exact transitions were missingRing
to falseRing (25), partialMove -20 to falseRing (24), falseRing to partialMove
-20 (24), partialMove -20 to wholeSeriesMove -20 (16), and falseRing to
missingRing (14). D also accounted for 40 of the 59 failed Candidate Oracle
misses.

Exact-year Top1 remained secondary to window coverage: ranker 860/3,705
(23.21%), pair 834/3,705 (22.51%), full-year 695/3,705 (18.76%), and final
fusion 894/3,705 (24.13%). Operation-correct exact Top1 was 877/3,705 (23.67%)
for the final fusion.

## Decision

The frozen standalone model substantially improves the production baseline and
passes the response and Clean false-positive gates. It does not meet 95%
workflow accuracy, the 90% file-clustered lower bound for every family, or zero
correct-to-wrong regressions. It therefore remains a shadow model and must not
replace the production adjudicator from this result.

Raw artifacts are under
`D:\软件测试\itrdb-unified-model-v2\external-v1\analysis\frozen-v34`.

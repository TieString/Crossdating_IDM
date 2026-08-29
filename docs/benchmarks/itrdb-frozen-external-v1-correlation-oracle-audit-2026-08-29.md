# Frozen External Correlation and Candidate Oracle Audit

## Scope

This is a read-only follow-up analysis of the frozen 50-file external test. No
model, threshold, calibration, file, or scenario was changed.

Candidate Oracle means that the immutable package contained at least one
workflow-correct package for the current diagnostic frontier. An adjudication
or ranking loss means Candidate Oracle was available but the final model did
not select it.

Frontier errors use the product's workflow semantics. A selected package counts
as a frontier error only when its main interpretation, explicit immutable
alternative, or `partialMove -> missingRing` review path covers another
unresolved truth instead of the current frontier.

## File Correlation

| Correlation | Files | Events | Workflow | Candidate Oracle | Oracle lower | Ranking loss | Oracle-miss failures | Operation/shift | Window | Frontier | Refusal |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.50-0.60 | 2 | 143 | 83.92% | 139/143 (97.20%) | 95.89% | 19 | 4 | 16 | 7 | 0 | 0 |
| 0.60-0.70 | 13 | 1,123 | 81.66% | 1,103/1,123 (98.22%) | 97.60% | 187 | 19 | 121 | 65 | 11 | 9 |
| 0.70-0.80 | 23 | 1,922 | 86.52% | 1,896/1,922 (98.65%) | 98.00% | 233 | 26 | 168 | 63 | 21 | 5 |
| >=0.80 | 12 | 930 | 92.90% | 919/930 (98.82%) | 98.03% | 56 | 10 | 42 | 14 | 9 | 1 |

Only two qualifying files existed in the 0.50-0.60 stratum, so its estimate is
not stable enough to compare directly with the other file-level strata.

Candidate Oracle by family:

| Correlation | A | B | C | D | Overall |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.50-0.60 | 100.00% | 100.00% | 100.00% | 90.24% | 97.20% |
| 0.60-0.70 | 99.23% | 97.89% | 98.79% | 97.58% | 98.22% |
| 0.70-0.80 | 99.13% | 100.00% | 99.29% | 96.45% | 98.65% |
| >=0.80 | 100.00% | 100.00% | 99.63% | 96.30% | 98.82% |

## Target/Master Correlation

| Correlation | Events | Workflow | Candidate Oracle | Oracle lower | Ranking loss | Oracle-miss failures | Operation/shift | Window | Frontier | Refusal |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.60-0.70 | 1,394 | 80.49% | 1,366/1,394 (97.99%) | 97.31% | 244 | 28 | 165 | 85 | 12 | 10 |
| 0.70-0.80 | 1,663 | 87.79% | 1,640/1,663 (98.62%) | 98.13% | 181 | 22 | 126 | 50 | 23 | 3 |
| >=0.80 | 1,061 | 92.55% | 1,051/1,061 (99.06%) | 98.35% | 70 | 9 | 56 | 14 | 6 | 2 |

Candidate Oracle by family:

| Correlation | A | B | C | D | Overall |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.60-0.70 | 98.78% | 98.29% | 98.78% | 96.59% | 97.99% |
| 0.70-0.80 | 99.50% | 100.00% | 99.38% | 96.10% | 98.62% |
| >=0.80 | 100.00% | 100.00% | 99.68% | 97.09% | 99.06% |

Workflow accuracy and Candidate Oracle together:

| Family | 0.60-0.70 workflow / Oracle | 0.70-0.80 workflow / Oracle | >=0.80 workflow / Oracle |
| --- | ---: | ---: | ---: |
| A | 88.41% / 98.78% | 91.09% / 99.50% | 94.03% / 100.00% |
| B | 80.98% / 98.29% | 92.81% / 100.00% | 96.76% / 100.00% |
| C | 83.17% / 98.78% | 88.71% / 99.38% | 94.82% / 99.68% |
| D | 74.15% / 96.59% | 80.49% / 96.10% | 85.44% / 97.09% |

The target/master strata show the correlation effect most clearly. Workflow
accuracy rises by 12.07 percentage points from the lowest to the highest bin,
while Candidate Oracle rises by only 1.07 points. The Oracle-to-final gap is
17.50, 10.82, and 6.50 points respectively. Correct evidence therefore remains
available in almost every bin; lower correlation primarily makes operation and
location adjudication harder.

D remains qualitatively different. Even at target/master correlation >=0.80,
its Candidate Oracle is 97.09% but workflow accuracy is 85.44%. Its remaining
limit is dominated by mixed-operation adjudication rather than missing
candidate evidence.

## Failure Decomposition

There are 554 failed event opportunities:

| Final symptom | Failures |
| --- | ---: |
| Operation or exact-shift error | 347 |
| Window-location error | 149 |
| Workflow-equivalent frontier error | 41 |
| Refusal | 15 |
| Final package-projection inconsistency | 2 |

The same failures by stage:

| Stage | Operation/shift | Window | Frontier | Refusal | Projection | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Oracle hit, final ranking/adjudication loss | 305 | 139 | 36 | 13 | 2 | 495 |
| Candidate Oracle miss | 42 | 10 | 5 | 2 | 0 | 59 |

The immutable package Oracle is 4,057/4,118 (98.52%). There are 61 attempts
without a workflow-correct immutable package, but two are subsequently
corrected by the frozen post-package whole projection. This leaves 59 failed
Oracle-miss attempts and 495 failures where the correct package was already
present.

The 41 workflow-equivalent frontier errors comprise B 7, C 21, and D 13; A has
none. These are not inferred merely from a nearby year. Each selected package
must cover a different unresolved truth under the same product review paths
available to the user.

## Interpretation

Correlation affects final accuracy much more strongly than it affects candidate
recall. The next model revision should therefore use correlation and evidence
quality to calibrate competition between already-present packages, especially
operation identity and year-mode ranking. Simply generating more candidate
windows has little headroom outside D's smaller evidence gap.

Raw outputs:

- `D:\软件测试\itrdb-unified-model-v2\external-v1\analysis\frozen-v34-correlation-oracle\correlation-oracle-errors.csv`
- `D:\软件测试\itrdb-unified-model-v2\external-v1\analysis\frozen-v34-correlation-oracle\frontier-errors.csv`
- `D:\软件测试\itrdb-unified-model-v2\external-v1\analysis\frozen-v34-correlation-oracle\summary.json`

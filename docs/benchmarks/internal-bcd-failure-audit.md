# Internal-reference B/C/D failure audit

## Scope

This audit uses the frozen fifteen-file second holdout only to explain the 125
failures of the COFECHA-free z-score master. It does not tune a production rule.
Every failed state was replayed with the full operation grid, joint hypotheses,
bounded lag paths, and event-stage audit enabled.

## Comparable accuracy

The earlier 94.74% unified-adjudicator result used 931 opportunities and retained
COFECHA-backed product candidate packages. The current 873-event replay is a
different, harder fifteen-file holdout with no COFECHA master or classification.
On this same replay protocol, the internal/production comparison is:

| Family | Production reference | Internal z-score reference | Difference |
| --- | ---: | ---: | ---: |
| A | 93.33% | 95.56% | +2.22 pp |
| B | 87.14% | 81.07% | -6.07 pp |
| C | 88.15% | 88.15% | 0.00 pp |
| D | 88.84% | 84.55% | -4.29 pp |

Master correlation is not the family-specific failure source. Mean JS/COFECHA
master correlation is 0.915 for A and B, 0.916 for C, and 0.918 for D.

## Failure decomposition

| Family | Failures | Operation/shift | Window | Refused |
| --- | ---: | ---: | ---: | ---: |
| B | 53 | 33 | 16 | 4 |
| C | 32 | 16 | 13 | 3 |
| D | 36 | 20 | 9 | 7 |

B is dominated by repeated partial transitions: 37 failures have `partialMove`
truth, including 29 operation/shift errors. C consists of nearby unit transitions;
their neighboring location modes form broad platforms. D must separate a whole
baseline from mixed local transitions and has both operation competition and more
refusals.

## Evidence oracle

Across all 125 failures:

- the counterfactual grid contains the correct operation identity in 122 cases, but
  ranks it first in only 23;
- a path view contains the correct identity in 112 and a complete correct window in
  81;
- some complete correct hypothesis exists in 90;
- `stableBoundedPathEvidence.recoveredFrontier` alone is complete-correct in 43:
  B 27, C 1, and D 15.

Thus B and D are mainly selection/projection failures, while C also needs a sharper
nearby-unit location generator. The stable recovered frontier is a candidate for a
unified B/D path head, but it cannot be promoted until file-isolated development and
calibration show that it preserves existing correct suggestions.

Artifacts:

`D:\软件测试\itrdb-unified-model-v2\second-holdout\models\internal-zscore-bcd-failure-grid-v15`

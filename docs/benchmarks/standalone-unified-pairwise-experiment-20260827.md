# Standalone unified pairwise adjudicator experiment (2026-08-27)

## Evaluation contract

The earlier 882/931 (94.74%) result is a safe product-error correction layer:
906 event decisions retained the product answer. It is not counted as a
standalone unified-model result.

This experiment instead makes every frontier decision through the same
file-held-out operation head and same-identity location head. The product result
is only one immutable candidate package. There is no truth-aware runtime switch,
legacy fallback, file/series/year feature, or A/B/C/D feature. Development seeds
derived from the same real RWL remain in the same OOF fold.

The 33 development files contain 3,957 event attempts and 414 Clean attempts.
The pre-frozen calibration and final holdout files remain unopened.

## Results

| Model | Overall | A | B | C | D | Correct -> wrong | Clean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct standalone meta v20 | 94.06% | 94.69% | 95.02% | 92.67% | 94.33% | - | 0/414 |
| Pairwise v21 (incorrect base replay) | 94.39% | 94.69% | 94.78% | 93.56% | 94.79% | 19 | 0/414 |
| Pairwise v22 (exact base replay) | **94.41%** | **94.93%** | **94.94%** | **93.56%** | **94.60%** | 12 | 0/414 |
| Operation-family pairwise v23 | 94.39% | 94.93% | 94.70% | 93.64% | 94.70% | 19 | 4/414 |

The corrected v22 experiment directly selected 3,736/3,957 events, responded to
100%, and had a file-clustered one-sided 95% lower bound of 92.37%. It corrected
26 v20 failures but changed 12 v20-correct attempts to errors, so it is retained
as a negative shadow experiment and cannot replace the standalone baseline.

The operation-family head used only truth-blind in-attempt percentiles and equal
family summaries. Its operation accuracy fell from 97.675% to 97.574%, while
Clean false positives rose from zero to four. Raw family balancing alone is not
an adequate operation-identity generator.

## Failure direction

The direct v20 model has 235 failures: 92 operation/shift errors and 143 location
errors. Fifty-six failures have no complete correct package, while 179 already
have a rankable correct package. The largest remaining surface is partialMove:
46 selected-operation errors and 62 same-identity location errors. C has 49
failed selected partialMove suggestions; 31 of those still contain a correct
same-identity window candidate.

The next experiment should therefore improve the physical per-year partial
breakpoint distribution and its cross-reference agreement before adding another
threshold or product-preservation gate.

## Artifacts

- Direct standalone v20: `D:\软件测试\itrdb-unified-model-v2\standalone-v3\protocol-v2-new\models\development-33file-standalone-meta-oof-v20`
- Pairwise v22: `D:\软件测试\itrdb-unified-model-v2\standalone-v3\protocol-v2-new\models\development-33file-standalone-pairwise-oof-v22`
- Operation-family v23: `D:\软件测试\itrdb-unified-model-v2\standalone-v3\protocol-v2-new\models\development-33file-operation-family-pairwise-oof-v23`

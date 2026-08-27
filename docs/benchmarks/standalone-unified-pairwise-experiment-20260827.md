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
| Transition-compatible full-year v24 | 93.25% | 94.93% | 94.78% | 90.34% | 94.23% | - | 0/414 |
| Three-proposal unified ranker v25 | **95.38%** | **95.65%** | **95.84%** | **95.01%** | **95.16%** | **1** | **0/414** |
| Three-seed ranker ensemble v26 | 95.35% | 95.65% | 95.84% | 94.93% | 95.16% | 1 | 0/414 |
| Equal-attempt probability head v29 | **95.40%** | **95.65%** | **95.84%** | **95.09%** | **95.16%** | **0** | **0/414** |

The corrected v22 experiment directly selected 3,736/3,957 events, responded to
100%, and had a file-clustered one-sided 95% lower bound of 92.37%. It corrected
26 v20 failures but changed 12 v20-correct attempts to errors, so it is retained
as a negative shadow experiment and cannot replace the standalone baseline.

The operation-family head used only truth-blind in-attempt percentiles and equal
family summaries. Its operation accuracy fell from 97.675% to 97.574%, while
Clean false positives rose from zero to four. Raw family balancing alone is not
an adequate operation-identity generator.

The v24 full-year head adds the physical invariant `olderLag - newerLag =
shiftYears` in raw/COFECHA and local/global views. Because an overall lag
baseline cancels in the subtraction, the feature remains valid when whole and
local events coexist. Used alone, this head regressed to 3,690/3,957 (93.25%),
mainly in C, so it is retained as a negative replacement experiment. It still
adds complementary evidence: the union oracle of v20, v22, and v24 reaches
3,776/3,957 (95.43%), with every A/B/C/D family above 95%.

The v25 ranker treats the v20 listwise, v22 pairwise, and v24 physical-profile
outputs as three ordinary proposals. A five-fold file-held-out ranker selects
every local-event location directly; it has no product default, truth-aware
switch, or legacy fallback. It selected 3,774/3,957 (95.38%), only two below the
three-proposal oracle. All four families exceed 95%, and their file-clustered
one-sided 95% lower bounds range from 92.77% to 93.61%. Response is 100% and
Clean remains 0/414. One v20-correct case changed to an error, so v25 meets the
accuracy target but not yet the zero-regression safety gate.

A three-seed ranker ensemble did not remove that regression and reduced C below
95%, so v26 is retained as a negative stability experiment. The v29 head instead
estimates the correctness probability of every proposal with equal total weight
per event attempt, then directly selects the highest probability in that event.
It reaches 3,775/3,957 (95.40%), keeps A/B/C/D above 95%, and raises the four
file-clustered one-sided 95% lower bounds to 92.83%--93.63%. It corrects 53 v20
failures with zero correct-to-wrong changes, 100% response, and 0/414 Clean false
positives. The model still has no privileged base proposal or truth-aware runtime
switch.

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
- Transition-compatible full-year v24: `D:\软件测试\itrdb-unified-model-v2\standalone-v3\protocol-v2-new\models\development-33file-transition-compatible-full-year-oof-v24`
- Three-proposal unified ranker v25: `D:\软件测试\itrdb-unified-model-v2\standalone-v3\protocol-v2-new\models\development-33file-proposal-fusion-oof-v25`
- Three-seed ranker ensemble v26: `D:\软件测试\itrdb-unified-model-v2\standalone-v3\protocol-v2-new\models\development-33file-proposal-fusion-ensemble3-oof-v26`
- Equal-attempt probability head v29: `D:\软件测试\itrdb-unified-model-v2\standalone-v3\protocol-v2-new\models\development-33file-proposal-fusion-classifier-weighted-oof-v29`

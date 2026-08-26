# Internal JS reference model experiment

## Scope

This experiment rebuilds the automatic diagnosis reference without passing a
COFECHA master, PART 6 classification, or report text into diagnosis. It remains a
shadow evaluator and does not replace the production reference path.

The model keeps two responsibilities separate:

1. a site chronology assembled from standardized source series;
2. target compatibility features computed against a target-excluded chronology.

The compatibility head may change only whether the target is a candidate. It cannot
change chronology values, operation type, shift, or event location.

## Master construction result

A weighted-Huber chronology was first evaluated on all 18 development files. It
reached 906/1042 (86.95%) with 7/108 Clean false positives, while the stored
production reference reached 956/1042. It corrected 31 production failures but
regressed 81 production-correct attempts. Robust per-year clipping was therefore
too aggressive for cumulative multi-event lag evidence.

The next model retained arithmetic accumulation and added per-core residual z-score
normalization after spline, AR, and log standardization. On a frozen six-file
development screen (`az514`, `nm582`, `az091`, `cana408`, `co648`, `az102`):

| Metric | Unnormalized mean | Per-core z-score mean |
| --- | ---: | ---: |
| Mean correlation with COFECHA master | 0.841 | **0.915** |
| Q10 correlation with COFECHA master | 0.539 | **0.880** |
| Median correlation with COFECHA master | 0.936 | **0.939** |
| Best lag equal to zero | 100% | 100% |
| Correct suggestions | 297/349 | **303/349** |
| Production-correct regressions | 29 | **21** |
| Clean false positives | 0/36 | 0/36 |

The z-score result improves both chronology similarity and downstream diagnosis,
without changing an event rule. It is retained for further file-isolated
calibration and holdout evaluation.

On the separate ten-file calibration partition, per-core z-score normalization
again improved JS/COFECHA master correlation: mean 0.884 to 0.910 and Q10 0.686
to 0.760. The resulting fully internal always-candidate diagnosis reached 489/567
(86.24%), compared with 517/567 for the stored production reference, and produced
4/60 Clean suggestions. On the untouched twelve-file reserve partition it reached
600/686 (87.46%), compared with 618/686 for production, with 3/72 Clean
suggestions. The internal master corrected 25 production failures on reserve while
regressing 43 production-correct attempts.

The public [LTRR Cook-Holmes spline band equations](https://www.ltrr.arizona.edu/pub/trees/doc/old_html/spline_8c-source.html)
were also ported behind an experiment-only switch under the compatible published
[TREES/CROSSDATE GPL terms](https://www.ltrr.arizona.edu/pub/trees/index.html) and
verified against an independent dense solve. They did
not improve master similarity over the existing discrete-penalty approximation
(0.91517 versus 0.91533 on the six-file development screen). Fixed AR orders 1--5
and disabling AR likewise had file-dependent effects; no truth-blind internal
consistency score selected the COFECHA-closest mode across files. The current AIC
path is therefore retained.

## Compatibility evidence

The target-excluded model emits full-series lag correlation, 50-year segment
stability, and per-reference voting features. On all development rows, Clean targets
had median zero-lag correlation 0.843 and median incompatible-segment fraction 0;
event targets had 0.394 and 0.529 respectively. A preliminary fixed risk score can
detect 1032/1042 event states while allowing one Clean state on the development
data, but its effect on downstream candidate/anchor selection still requires a
separate calibration result.

A file-OOF linear probability head reached AUC 0.99897 on development and 0.99956
on calibration. Direct candidate/anchor switching reduced reserve Clean suggestions
from 3/72 to 0/72, but regressed three correct local false-ring suggestions, so that
use is rejected. A stricter conformal gate was calibrated at the minimum probability
of 468 correct strict calibration events. Offline replay preserved every correct
suggestion on development, calibration, and reserve while changing Clean suggestions
from 2 to 0, 4 to 3, and 3 to 1 respectively. This qualified it for an actual
reserve replay and one frozen final-holdout check.

The actual twelve-file reserve replay matched the offline result: 600/686 correct
suggestions were unchanged, response remained 98.83%, and Clean suggestions fell
from 3/72 to 1/72. A semantic row diff found zero event response, operation, shift,
or window changes; only two Clean responses were suppressed. This passes the
zero-regression reserve gate but remains below the production reference's 618/686
accuracy, so it is not a production replacement.

## Frozen second holdout

The selected configuration was frozen before opening the fifteen-file second
holdout: arithmetic master, per-core residual z-score, current AIC AR path, target
included in the diagnosis master, and target-excluded compatibility features.

Final master comparison across all 963 frozen states:

| Master metric | Unnormalized JS | Per-core z-score JS |
| --- | ---: | ---: |
| Mean correlation with COFECHA master | 0.884 | **0.916** |
| Q10 correlation | 0.757 | **0.819** |
| Median correlation | 0.909 | **0.933** |
| Best lag equal to zero | 100% | 100% |

Final fixed-state suggestion comparison:

| Strategy | Correct / 873 | Accuracy | Response | Clean FP |
| --- | ---: | ---: | ---: | ---: |
| Production master + classification, no report text | 773 | **88.55%** | 99.43% | 1/90 |
| Internal z-score master, always candidate | 748 | 85.68% | 98.28% | 5/90 |
| Internal z-score master + safe-clean gate | 747 | 85.57% | 97.94% | 2/90 |
| Previous all-other internal flags | 743 | 85.11% | 97.48% | 8/90 |
| Previous stable-cluster internal flags | 741 | 84.88% | 96.91% | 7/90 |

The always-candidate internal result was A 86/90 (95.56%), B 227/280
(81.07%), C 238/270 (88.15%), and D 197/233 (84.55%). It corrected 34
production failures and regressed 59 production-correct attempts.

The safe-clean gate reduced three Clean false positives but suppressed one correct
missing-ring suggestion on the final holdout. It therefore fails the zero-regression
contract and is rejected despite passing development, calibration, and reserve.
Compatibility probability remains useful shadow metadata, but must not gate the
product suggestion.

Of the 125 remaining internal failures, 15 were refusals, 39 had the correct
operation/shift but missed the window, and 71 selected the wrong operation or shift.
Forty-four of those operation failures had a `partialMove` truth. The remaining
accuracy ceiling is therefore mostly in operation identity and location evidence,
not master chronology construction.

## Controlled COFECHA parity and dual-view reference

A differential probe now runs COFECHA with AR and log independently enabled,
saves the `V` master, parses PART 7 per-core statistics, and compares the result
against JS spline, AR, normalization, and aggregation variants. Synthetic fixtures
cover identical, varied, central-impulse, and near-end impulse series. The probe
rejected additive detrending and 2--4 decimal filtered-index quantization as
explanations for the remaining difference. The public Cook-Holmes spline and the
existing discrete penalty are close on ordinary series, but neither reproduces
COFECHA 6.06P at four-decimal precision.

The strongest general result was a second residual view that logs raw measurements,
fits the spline in log space, and uses an additive log residual. Per-core residuals
from the existing post-AR log view and this raw-log view are independently z-scored.
The raw-log view substantially improved JS/COFECHA master similarity on both
file-isolated screens:

| Partition | Existing mean r / Q10 | Raw-log mean r / Q10 |
| --- | ---: | ---: |
| Six-file development, 385 states | 0.9153 / 0.8799 | **0.9498 / 0.9215** |
| Ten-file calibration, 627 states | 0.9104 / 0.7600 | **0.9478 / 0.9066** |

Using raw-log alone did not improve event decisions. A fixed 1/16 blend improved
development from 303/349 to 307/349 with four corrections and zero regressions,
but calibration remained 489/567 with six corrections and six regressions. Fixed
blending is therefore rejected.

The retained shadow head applies the 1/16 blend only when the target-excluded
comparison provides directional evidence: either the raw-log view strengthens the
target anomaly without materially increasing per-reference conflict, or it reduces
per-reference conflict while raising median reference agreement. A low correlation
alone is not sufficient; that branch produced one whole-series regression on the
independent reserve and was removed before the final rerun.

| Partition | Existing JS | Adaptive dual-view | Corrected | Correct to wrong | Clean FP |
| --- | ---: | ---: | ---: | ---: | ---: |
| Six-file development | 303/349 | 305/349 paired projection | 2 | **0** | 0/36 |
| Ten-file calibration | 489/567 | 494/567 paired projection | 5 | **0** | 4/60 |
| Twelve-file independent reserve | 600/686 | **601/686** full replay | 1 | **0** | 3/72 |

The reserve response count stayed 678/686 and no reference was unavailable. This is
the first internal-reference change in this experiment to improve an independent
event replay while preserving every previously correct suggestion. It remains a
shadow result: the stored production reference is still 618/686 on the reserve, so
the JS reference has not yet reached replacement parity.

Artifacts:

`D:\软件测试\cofecha-js-parity-probe`

`D:\软件测试\itrdb-unified-model-v2\models\master-audit-prelog-residual-dev6-v1.json`

`D:\软件测试\itrdb-unified-model-v2\models\master-audit-prelog-cal10-v4.json`

`D:\软件测试\itrdb-unified-model-v2\models\internal-adaptive-blend-reserve12-v2`

## Multi-view reference package selector

The next shadow experiment keeps eight fixed JS reference views over three
orthogonal choices: post-AR versus raw-log residuals, AIC AR versus no AR/fixed
AR1, and target-included versus target-excluded accumulation. An unnormalized
view is retained as a scale-control channel. Each view still emits one immutable
operation/shift/window package; the UI never sees eight alternatives.

Across the twelve-file reserve, the union of those views contained a correct
package for 34 of the 86 baseline failures. A deterministic safe consensus first
selects only packages with at least two supporting views. An answered baseline is
protected unless the competing support margin is at least two or baseline support
is at most two; a refused baseline is recoverable only when internal incompatibility
is at least one. This changed the reserve from 600/686 to 610/686 with zero sampled
regressions and unchanged 3/72 Clean false positives.

A file-isolated standardized logistic selector then ranks the unresolved immutable
packages. Features contain only reference-view identity, support/margin, operation
and shift semantics, target-excluded compatibility, event score/margin, lag-state
convergence, counterfactual gain, location concentration/remote margin, reference
support, confidence, and algorithm-source tags. File IDs, series IDs, benchmark
families, absolute years, and truth fields are excluded. Development files train
the model; calibration, twelve-file reserve, and fifteen-file second holdout set a
cross-partition zero-regression deployment gate of probability >=0.80, probability
margin >=0.20, and at least two supporting views.

| Partition | Existing JS | Frozen multi-view selector | Corrections | Sampled regressions | Production reference |
| --- | ---: | ---: | ---: | ---: | ---: |
| Six-file development | 303/349 | 309/349 | 6 | **0** | 312/349 |
| Ten-file calibration | 489/567 | 497/567 | 8 | **0** | 517/567 |
| Twelve-file reserve | 600/686 | 616/686 | 16 | **0** | 618/686 |
| Fifteen-file second holdout | 748/873 | 767/873 | 19 | **0** | 773/873 |
| Eight-file final holdout | 403/458 | 414/458 | 11 | **0** | 419/458 |

The final holdout retained Clean 0/48 and no reference was unavailable. The model
is consistently within 0.2--1.1 percentage points of the stored production
reference, but it has not exceeded it. Correct-case safety uses a deterministic
file/family-stratified sample plus every Clean state, while every baseline failure
is included. Full correct-case replay is still required before production use.

The result therefore qualifies for a TypeScript shadow implementation, not a
production switch. It demonstrates that the COFECHA-free evidence is sufficient
to reach the same broad performance band once reference-view operation and location
evidence are adjudicated together.

Artifacts:

`D:\软件测试\itrdb-unified-model-v2\models\internal-reference-view-selector-v8-cross-calibrated`

`D:\软件测试\itrdb-unified-model-v2\models\internal-reference-view-selector-v9-third-holdout-final`

## Decision

- Retain per-core z-score master construction as the best COFECHA-free shadow
  reference candidate.
- Retain the direction-gated 1/16 raw-log blend as shadow reference metadata; it
  passes the independent zero-regression gate but is not yet a production replacement.
- Retain the compatibility classifier as audited metadata only.
- Reject direct candidate switching and the conformal safe-clean display gate.
- Do not replace the production reference path. The frozen internal result remains
  25 correct suggestions below production on 873 events.

A later, completely new eight-file holdout confirmed the boundary: the internal
z-score reference reached 403/458 (87.99%) versus 419/458 (91.48%) for the
production reference, with Clean 0/48 and no unavailable reference. This new result
does not change the decision above.

External artifacts:

`D:\软件测试\itrdb-unified-model-v2\models\internal-weighted-huber-dev-flagged-v1`

`D:\软件测试\itrdb-unified-model-v2\models\master-audit-raw-6files-v1.json`

`D:\软件测试\itrdb-unified-model-v2\models\master-audit-zscore-6files-v2.json`

`D:\软件测试\itrdb-unified-model-v2\models\internal-zscore-mean-dev6-flagged-v3`

`D:\软件测试\itrdb-unified-model-v2\models\master-audit-cal10-zscore-v2.json`

`D:\软件测试\itrdb-unified-model-v2\models\internal-zscore-mean-cal10-flagged-v9`

`D:\软件测试\itrdb-unified-model-v2\models\internal-zscore-mean-reserve12-flagged-v10`

`D:\软件测试\itrdb-unified-model-v2\models\internal-compatibility-dev18-cal10-v6.json`

`D:\软件测试\itrdb-unified-model-v2\models\internal-zscore-mean-reserve12-safe-clean-v12`

`D:\软件测试\itrdb-unified-model-v2\second-holdout\models\master-audit-final15-zscore-v2.json`

`D:\软件测试\itrdb-unified-model-v2\second-holdout\models\internal-zscore-flagged-final-v14`

`D:\软件测试\itrdb-unified-model-v2\second-holdout\models\internal-zscore-safe-clean-final-v13`

`D:\软件测试\itrdb-unified-model-v2\third-holdout\models\internal-zscore-third8-rich-grid-v21`

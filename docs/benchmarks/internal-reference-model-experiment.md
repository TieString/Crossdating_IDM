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

## Decision

- Retain per-core z-score master construction as the best COFECHA-free shadow
  reference candidate.
- Retain the compatibility classifier as audited metadata only.
- Reject direct candidate switching and the conformal safe-clean display gate.
- Do not replace the production reference path. The frozen internal result remains
  25 correct suggestions below production on 873 events.

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

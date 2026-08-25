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

## Compatibility evidence

The target-excluded model emits full-series lag correlation, 50-year segment
stability, and per-reference voting features. On all development rows, Clean targets
had median zero-lag correlation 0.843 and median incompatible-segment fraction 0;
event targets had 0.394 and 0.529 respectively. A preliminary fixed risk score can
detect 1032/1042 event states while allowing one Clean state on the development
data, but its effect on downstream candidate/anchor selection still requires a
separate calibration result.

External artifacts:

`D:\软件测试\itrdb-unified-model-v2\models\internal-weighted-huber-dev-flagged-v1`

`D:\软件测试\itrdb-unified-model-v2\models\master-audit-raw-6files-v1.json`

`D:\软件测试\itrdb-unified-model-v2\models\master-audit-zscore-6files-v2.json`

`D:\软件测试\itrdb-unified-model-v2\models\internal-zscore-mean-dev6-flagged-v3`

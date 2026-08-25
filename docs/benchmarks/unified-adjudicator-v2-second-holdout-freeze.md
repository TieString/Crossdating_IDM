# Unified adjudicator v2 second-holdout freeze

## Why a second holdout is required

The first 17-file holdout was opened under the operation-specific location policy.
It produced A 98/102, B 296/309, C 292/306, and D 246/259. D is 94.98%, one
event below the frozen 95% requirement. This failed result remains final for that
policy.

The development-frozen window classifier was also evaluated and produced A 98/102,
B 297/309, C 291/306, and D 247/259. Because choosing it after seeing the first
holdout would be post-hoc model selection, the 17 files are reclassified as a
second calibration set. They cannot be used as independent evidence for the new
policy.

## Newly frozen policy

- Operation identity generator: unchanged enriched operation classifier.
- Location generator for missingRing, falseRing, and partialMove: global/typed
  yearly window classifier with weights 0.5/0.5.
- Candidate centers: unchanged fixed stride 5 plus evidence-family peaks.
- Output: one 13-year review window.
- Workflow package: unchanged production main suggestion plus one user-invoked
  enriched review interpretation.
- Automatic main-suggestion replacement remains disabled.

No feature, weight, threshold, or output semantic may be changed after selecting
the new source files.

## New independent split

A new deterministic seed must select whole RWL files that occur in none of the
historical development, calibration, reserve calibration, or first holdout sets.
Clean qualification remains unchanged: file intercorrelation at least 0.80, zero
problem segments, and at least six target series of at least 200 years with master
correlation at least 0.80 and zero series problem segments.

The second holdout must contain at least 15 files and six frozen targets per file.
Acceptance remains, independently for A/B/C/D:

- workflow-package accuracy at least 95%;
- file-clustered one-sided 95% lower bound at least 90%.

Strict accuracy, response, refusal, Clean false positives, and the failed first
holdout result remain separately reported.

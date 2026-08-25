# Internal path-frontier selector

## Purpose

The COFECHA-free z-score reference audit found that B and D failures often already
contain a correct `stableBoundedPathEvidence.recoveredFrontier`. This experiment
adds a single constrained head that may choose that existing complete hypothesis
instead of the current product package. It does not generate a new operation,
shift, or window.

## Feature contract

The 49 numerical features describe only:

- stable path transition strength, margin, lag states, and support;
- agreement across bounded path variants and joint hypotheses;
- stable/product operation rank, score, identity, and window overlap;
- target/reference compatibility and global lag state.

File ID, series ID, benchmark family, truth year, and truth operation are excluded.
Training and OOF folds are split by complete RWL file.

## Development and calibration

On 18 development files, 263 stable overrides differed materially from the current
package: 57 were beneficial, 107 harmful, 66 correct under both interpretations,
and 33 wrong under both. The file-OOF zero-harm threshold selected seven overrides,
all beneficial.

The fitted development model was then applied to ten separate calibration files.
Among 137 eligible overrides, the frozen safety threshold selected twelve:

- 9 beneficial;
- 0 harmful;
- 1 correct under both;
- 2 wrong under both;
- 1 replacement of an existing Clean false positive;
- 0 new Clean false positives.

The final threshold is the stricter of the development-OOF and calibration harmful
probability bounds. No family label or final-holdout result affects it.

The selector remains shadow-only until it passes the twelve-file reserve set and a
new independent holdout without any correct-to-wrong regression.

Artifacts:

`D:\软件测试\itrdb-unified-model-v2\models\internal-zscore-dev18-rich-grid-v16`

`D:\软件测试\itrdb-unified-model-v2\models\internal-zscore-cal10-rich-grid-v17`

`D:\软件测试\itrdb-unified-model-v2\models\internal-path-frontier-dev18-cal10-v2.json`

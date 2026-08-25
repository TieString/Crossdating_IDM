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

After applying the product's existing `partialMove -> missingRing` workflow
equivalence, 263 development overrides differed materially from the current
package: 62 were beneficial, 85 harmful, 88 correct under both interpretations,
and 28 wrong under both. The final file-OOF selector chose eight overrides: five
beneficial and three correct under both, with no harmful or wrong-to-wrong choice.

The fitted development model was then applied to ten separate calibration files.
Among 137 eligible overrides, the frozen safety threshold selected twelve:

- 8 beneficial;
- 0 harmful;
- 3 correct under both;
- 1 wrong under both;
- 1 replacement of an existing Clean false positive;
- 0 new Clean false positives.

The twelve-file reserve set was subsequently promoted to a third safety-calibration
layer after its first frozen evaluation found one harmful selection. The stricter
threshold retained three beneficial overrides, one correct-under-both choice, and
two wrong-under-both choices with zero harmful selections.

One operation compatibility veto is applied: a current positive `falseRing` package
cannot be replaced by a negative `partialMove` path unless at least one joint
hypothesis supports that path. The pre-veto development, calibration, and reserve
selector had never selected this unsupported direction conflict; the veto blocks
the corresponding regression observed in the later fifteen-file audit.

No family label or file identity enters either the probability model or veto.

## Regression results

The direction-safe v5 selector produced:

| Set | Baseline correct | Beneficial | Harmful | Wrong -> wrong | Result |
| --- | ---: | ---: | ---: | ---: | ---: |
| Development file-OOF | 912/1042 | +5 | 0 | 0 | 917/1042 |
| Calibration | 489/567 | +8 | 0 | 1 | 497/567 |
| Reserve safety calibration | 600/686 | +3 | 0 | 2 | 603/686 |
| Fifteen-file second-holdout regression | 748/873 | +2 | 0 | 0 | 750/873 |
| Seventeen-file historical regression | 849/976 | +4 | 0 | 3 | 853/976 |

No set gained a new Clean false positive. The fifteen- and seventeen-file sets are
regression checks, not untouched final claims: their outcomes or failure audits had
already been inspected before the final direction veto was frozen.

A stricter experiment treated every wrong-to-wrong replacement as a hard calibration
failure. One high-confidence calibration outlier raised the threshold to 0.9917,
eliminating all development, reserve, and regression selections. That version is
rejected as non-responsive; v5 keeps wrong-to-wrong changes visible in shadow audit
but never promotes them as accuracy gains.

## Third independent holdout

A new eight-file holdout was selected from the deterministic structural pool after
explicitly excluding every development, calibration, reserve, seventeen-file, and
fifteen-file manifest. The frozen files are `co646`, `cana343`, `co036`, `ca514`,
`co613`, `nm574`, `az543`, and `nm578`; each contributes six targets. Selection
used only clean COFECHA quality gates and never inspected diagnosis output.

The holdout contains 458 event opportunities and 48 Clean controls. The internal
z-score reference baseline reached 403/458 (87.99%), response 99.56%, and Clean
0/48; the production-reference result was 419/458 (91.48%). By family the internal
baseline was A 44/48, B 123/145, C 132/144, and D 104/121.

The frozen direction-safe v5 selector chose two overrides:

- one B event was correct under both the product and stable packages;
- one D event changed a correct whole-series move into an incorrect
  `partialMove -50` without joint support;
- no event was corrected.

The resulting score fell to 402/458. This violates the zero-regression contract and
overrides every earlier positive regression result. The path-frontier selector is
therefore rejected and must not be connected even as a suggestion-changing shadow
head. Stable path probabilities may remain diagnostic telemetry only.

Artifacts:

`D:\软件测试\itrdb-unified-model-v2\models\internal-zscore-dev18-rich-grid-v16`

`D:\软件测试\itrdb-unified-model-v2\models\internal-zscore-cal10-rich-grid-v17`

`D:\软件测试\itrdb-unified-model-v2\models\internal-path-frontier-dev18-cal10-v2.json`

`D:\软件测试\itrdb-unified-model-v2\models\internal-path-frontier-direction-safe-v5.json`

`D:\软件测试\itrdb-unified-model-v2\models\internal-zscore-final17-rich-grid-v20`

`D:\软件测试\itrdb-unified-model-v2\third-holdout\protocol`

`D:\软件测试\itrdb-unified-model-v2\third-holdout\models\internal-zscore-third8-rich-grid-v21`

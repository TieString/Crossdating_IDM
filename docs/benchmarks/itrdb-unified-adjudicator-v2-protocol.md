# ITRDB unified adjudicator v2 protocol

## Purpose

This protocol creates genuinely new whole-file development, calibration, and final-holdout sets for the unified diagnosis adjudicator. The previous 25-file sample is retained only as a regression suite and is not used to choose this split.

## Historical exclusion

- 300 unique historical `fileId` values were collected from tracked historical configs/manifests/splits and external capability `steps.json`/`resolved-cases.json` artifacts.
- The ITRDB source tree contained 7,559 unique, non-`-noaa`, not-previously-used RWL basenames after exclusion.
- The 45 formal files have zero overlap with all 300 historical IDs.

## Truth-blind file selection

1. Files were ordered by a frozen SHA-256 seed.
2. Structural screening required at least six series of at least 200 years and a leave-one-out standardized chronology correlation approximation of at least 0.72.
3. The first 600 structurally eligible files were checked with the real user-supplied COFECHA executable.
4. A file qualified only when COFECHA intercorrelation was at least 0.80, file problem segments were zero, and at least six series independently had at least 200 years, master correlation at least 0.80, and zero PART 7 problem flags.
5. The target was 60 qualified files; 57 were available in the first 600 candidates. The frozen split uses 45 and keeps 12 as reserves.

No injected event, diagnosis output, model probability, target year, or benchmark result participated in file or target selection.

## Frozen split

| Role | Files | Targets | Cases per family | Status |
| --- | ---: | ---: | ---: | --- |
| Development | 18 | 108 | 108 | May be used for model fitting and OOF model selection |
| Calibration | 10 | 60 | 60 | May be used only after development architecture is fixed |
| Final holdout | 17 | 102 | 102 | Sealed until architecture and thresholds are frozen |

Calibration v1 was later consumed by architecture diagnosis and is not reused for final threshold claims. Before inspecting any reserve outcomes, all 12 pre-frozen reserve files were promoted together to `reserve-calibration-v2` (72 targets/cases per family). The original 17-file final holdout remains unchanged and sealed.

Every target is used once per Clean/A/B/C/D family. Scenario generator v5 retains negative whole-series shifts, 5/7/9/13-year windows, distant multi-event chains, and near same-direction unit chains.

## Quality range

- Development minimum intercorrelation: 0.802.
- Calibration minimum intercorrelation: 0.805.
- Final-holdout minimum intercorrelation: 0.801.
- File-level possible problem segments: zero for every file.
- Eligible targets per file: exactly six frozen targets selected by a separate deterministic seed.

## Leakage controls

- All fitting, OOF predictions, calibration, bootstrap resampling, and evaluation use complete RWL files as the grouping unit.
- Features must exclude file/series identifiers, benchmark family, fixed years, case index, and truth fields.
- The old 25 files can only fail a regression gate; they cannot select a new model or threshold.
- Final-holdout diagnosis results must not be opened until the development model and calibration procedure are committed.

The frozen artifacts are `itrdb-unified-adjudicator-v2-*-config.json`, corresponding manifests, and `itrdb-unified-adjudicator-v2-frozen-split.json` in this directory.

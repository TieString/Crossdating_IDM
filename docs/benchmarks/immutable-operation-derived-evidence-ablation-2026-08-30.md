# Immutable operation derived-evidence ablation (2026-08-30)

## Scope

This file-OOF shadow ablation keeps the external 50 files, Top4 immutable
operation identities, base scores, pairwise model parameters, and production
selector frozen. It evaluates two truth-blind evidence projections:

- robust baseline-first identity fit: local candidates must preserve the newer
  fixed side and remove the regional step; whole-series candidates must resolve
  the robust whole baseline;
- compact per-reference fit: shift agreement, post-correction step residual,
  support-weighted reduction, and newer-side residual.

All values are converted to within-diagnosis rank/z/margin. No file, series,
family, calendar-year, or truth feature enters training. These options remain
disabled by default.

## Results

| Variant | Correct | Accuracy | A | B | C | D | Clean FP | Frozen repairs/regressions |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Current operation residual best | 3941/4118 | 95.70% | 490 | 1177 | 1177 | 1097 | 1 | 40/16 |
| Full baseline identity fit | 3941/4118 | 95.70% | 490 | 1176 | 1176 | 1099 | 0 | 41/17 |
| Local-shift fit only | 3941/4118 | 95.70% | 490 | 1175 | 1176 | 1100 | 0 | 42/18 |
| Compact per-reference fit | 3941/4118 | 95.70% | 490 | 1175 | 1178 | 1098 | 1 | 39/15 |
| Baseline + compact per-reference | 3940/4118 | 95.68% | 490 | 1175 | 1176 | 1099 | 1 | 40/17 |

The strongest baseline term is the candidate shift distance to the robust local
lag step. It improves D by up to three cases and removes the sole Clean false
positive, but loses the same number across B/C. Compact per-reference evidence
reduces frozen regressions to 15 but also redistributes two B cases to C/D.

These are useful physical channels, but none is a net overall improvement, so
they are not eligible for production replacement or for changing the frozen
operation head. The result also confirms that raw per-reference traces should
not be added wholesale to operation selection; the ongoing location experiment
evaluates them only inside an already selected operation identity.

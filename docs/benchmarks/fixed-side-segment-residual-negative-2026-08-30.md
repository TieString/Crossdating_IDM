# Fixed-side segment residual negative result

Adding centered and fully fixed-side COFECHA segment summaries to the location
residual head did not improve the net external result.

| Metric | Transition/path residual | With segment residual |
| --- | ---: | ---: |
| Correct suggestions | 3,688 / 4,118 | 3,688 / 4,118 |
| Repairs | 45 | 46 |
| Regressions | 26 | 27 |
| Clean false positives | 0 / 500 | 0 / 500 |

Fourteen decisions were repaired and fourteen regressed relative to the first
residual head. The 50-year segment grid is too coarse to resolve adjacent-year
or frontier ordering by itself. This result is retained to avoid repeating the
same feature expansion; later experiments use buffered one-sided transition
profiles and reference-wise residuals instead.

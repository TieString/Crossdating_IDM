# Development terminal unit staircase recovery

Date: 2026-08-15

Dataset role: development only. The 25-file final holdout was not opened.

## Problem

For close same-direction false-ring chains, the complete bounded lag path often already contained
the correct bark-side suffix (`+N -> ... -> +1 -> 0`). The production decision could still select
an older negative path, a partial move, or a whole-series candidate because older contaminated
runs were allowed to determine the operation and location of the newest event.

## Contract

The new terminal staircase checkpoint is emitted only when:

- an independent cumulative candidate has an exact positive integer depth `N >= 2`;
- two bounded-path regularizations reproduce the complete terminal suffix;
- both paths terminate at lag zero with at least eight fixed-side years;
- the two terminal boundaries differ by no more than two years; and
- the path contains the matching `+1 -> 0` false-ring transition.

Only the newest unit event is projected. The UI still receives one operation, one Top1 year, and
one 9-year review window. Older events remain unresolved until the next serial diagnosis. A true
whole-series baseline cannot satisfy the zero-lag fixed-tail requirement.

## Development results

Runs:

- Before: `paper-v4-c-false-no-min-run-and-clean-2026-08-15`
- After: `paper-v4-c-false-terminal-staircase-2026-08-15`
- Clean gate: `paper-v4-clean-terminal-staircase-2026-08-15`

| Metric | Before | After |
| --- | ---: | ---: |
| C false-ring prompted strict window coverage | 71.19% | 91.76% |
| C false-ring strict operation accuracy | 76.27% | 96.47% |
| C false-ring serial recovery | 44.68% | 82.98% |
| C false-ring complete cases | 46.03% | 77.78% |
| C false-ring out-of-order rate | 0.85% | 0.00% |
| Median / P90 window width | not changed | 9 / 13 years |
| Clean false positives | 2 / 128 | 2 / 128 |

The after run contains 63 cases and 188 injected false-ring events across nine development files.
It recovered 156 events. Terminal stops were 49 complete, 8 window misses, 4 wrong operations,
and 2 refusals. Save/reopen stability was 100%.

## Regression gates

- `nearLagCluster`, `eventEnsembleUnit`, and `jointEventAdjudicator`: 242 tests passed.
- `npm run build`: passed.
- `npm run validate:co612-recovery-regression`: first sweep 24 correct windows (minimum 22),
  zero joint operation mismatches, clean review 2/55.

# ITRDB operation capability v3

This frozen benchmark uses the same product semantics for every case. Benchmark families
classify test data only; they never select a production event type, locator, review window, or UI.

## Product projection

- Emit one main operation, one Top1 year, and one 5/7/9/13-year window for a local event.
- Emit a full-series shift for `wholeSeriesMove`, without a synthetic local window.
- Evaluate only the newest unresolved local frontier. After one accepted event, rebuild the
  file state and diagnose again.
- A validated `partialMove -N` may expose its single-frontier missing-ring interpretation.
  This counts as workflow-equivalent success, while strict operation accuracy remains separate.
- Never treat cumulative lag `N` as permission to insert `N` zero values at once.

## Families

- `Clean`: no injected event; measures review false positives.
- `A`: one missing ring, false ring, partial move, or whole-series move.
- `B`: same-type missing, false, or partial chains with local spacing of at least 14 years.
- `C`: same-direction unit missing or false chains with spacing from 2 through 13 years.
  Adjacent one-year pairs are retained only as `optionalSuccess` regressions.
- `D`: all six two-type combinations, four representative three-type combinations, and one
  four-type combination. Local breakpoints remain at least 14 years apart; whole-series shift
  is a global baseline and is not counted as a breakpoint.

## Reports

Reports include response/refusal, strict and workflow-equivalent operation accuracy, main-window
coverage, Top1, serial recovery, stop reasons, partial/whole misclassification, save/reopen
stability, clean false positives, and window median/P90. A correct older event that skips the
newest unresolved local event is reported as `out_of_order_frontier`.

Use equals-style npm arguments on npm 11 so option names are not stripped:

```powershell
npm run benchmark:itrdb:capability -- --families=A,B --file-ids=co612 --workers=4
```

The wrapper refuses ambiguous multi-option positional forwarding instead of accidentally
starting the default full matrix.

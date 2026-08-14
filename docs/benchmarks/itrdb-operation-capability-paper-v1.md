# ITRDB operation capability paper protocol v1

## Scope

This protocol evaluates the production JS review-event pipeline on isolated target-series
corruptions. It does not evaluate the separate all-series-undated/reference-pollution workflow.
The frozen unit of data splitting and uncertainty estimation is the complete RWL file.

The 34 source files were used in earlier exploratory work. The development/holdout division is
therefore a prospective holdout frozen from this protocol onward, not a claim that the holdout
files were never observed anywhere in project history. No holdout outcomes may be used for tuning
after this split is committed.

## Frozen split

- Development: 9 complete RWL files and 128 frozen target series. `co612` is development-only.
- Final holdout: 25 disjoint complete RWL files and 500 frozen target series.
- Each final file contributes exactly 20 targets selected by a hash fixed before injection.
- Target eligibility uses only clean COFECHA metadata: at least 200 years, master correlation at
  least 0.80, and zero clean problem segments.
- File and target selection do not use injected signal strength or diagnosis output.

The exact files, source hashes, and roles are stored in
`itrdb-operation-capability-paper-v1-split.json`. Development and holdout manifests are bound to
their configuration SHA-256 values.

## Case construction

Every target contributes one case to each of Clean, A, B, C, and D. Operation subtypes, event
counts, shifts, positions, and representative D compositions are assigned cyclically with fixed
hash offsets so that all subtypes are represented without enumerating many dates on one series.

- Clean: unchanged target.
- A: one missing ring, false ring, partial move, or whole-series move.
- B: one distant same-type chain of two, three, or four local events; spacing is 30 years.
- C: one same-direction missing-ring or false-ring chain of two, three, or four events; spacing is
  frozen at 2, 5, 9, or 13 years. One-year adjacent cases remain in the v3 optional regression set
  and are not mixed into the primary paper estimate.
- D: one of all six two-operation combinations, four representative three-operation combinations,
  or the four-operation composition. Local breakpoints are 30 years apart; whole-series movement
  is a global baseline and has no breakpoint window.

Each case reloads the clean source RWL and modifies exactly one target series. Every serial step
reformats that isolated state, runs COFECHA again, rebuilds the production reference/master, and
diagnoses only from the current observable state. No injected case shares a polluted reference
with another case, and hidden truth is used only for evaluation and simulated confirmation.

## Product semantics

All families use the same sequential frontier semantics: one primary operation, one Top1, and one
5/7/9/13-year local window. Only the bark-side unresolved event may be accepted. After a correct
event is simulated as confirmed, the file is rebuilt and the next event is diagnosed. Whole-series
movement has no artificial local window.

A partial move with a valid one-step missing-ring review interpretation may count as workflow-
equivalent for a multiple-missing truth. Strict operation accuracy remains separate.

## Estimates

The report includes response/refusal, strict and workflow-equivalent operation accuracy, prompted
local-window coverage, all-truth serial local-window coverage, conditional coverage, Top1, serial
recovery, move misclassification, save/reopen stability, clean false positives, and window widths.
An unreached event after a failed frontier counts against serial recovery, but it is not silently
relabelled as a window miss for a prompt the product never displayed.

- Micro estimates pool numerators and denominators across all selected files.
- Macro estimates first calculate each file's rate and then average files equally.
- Confidence intervals resample complete files with replacement for 10,000 deterministic bootstrap
  replicates. Cases within one file are never treated as independent bootstrap units.
- Reports include two-sided 95% intervals and one-sided 95% lower bounds.
- The observed target is 0.90 for both strict and workflow-equivalent prompted local-window
  coverage in A/B/C/D. Clean has no local-window denominator and is evaluated by false positives.
- Serial local-window coverage and complete recovery remain separate, stricter workflow metrics.
  Passing the stronger inferential criterion requires both micro and macro one-sided lower bounds
  to be at least 0.90.

Development results may be used to improve common mechanisms. The final holdout is run once after
the implementation and acceptance rules are frozen; any later changes require a newly selected
file-level holdout rather than reusing this one as development data.

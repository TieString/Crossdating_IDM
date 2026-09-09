# Mixed Tucson terminators: BL1 regression

Fixed in the production main worktree. The archive worktree and the supplied input were not modified.

The original parser recognized only the file-wide stop marker. With one `-9999` segment in a file, the formatter treated other series' trailing `999` as a measurement and appended `-9999`. This introduced a phantom ring and also confused 0.01 mm and 0.001 mm units.

Parsing now identifies termination per segment, retaining a real 999 measurement when its row/segment continues. Working maps use a common precision (0.001 mm for mixed input), and `readOptions.tucsonOutputMarkers` retains each source series' export precision. Coarse measurements are multiplied by 10 on input and divided by 10 on export. If a new measurement is not exactly representable in the original coarse unit, that series exports in fine precision without rounding. Same-ID segments with differing source units export in common fine precision. Explicit whole-file precision replacements clear the old export preferences; ordinary renames remap them. Read options are independently copied in history snapshots.

Validation:

- BL1: 43 series, 42 coarse terminators and 1 fine terminator. All source measurement values, calendar years and terminal fields survive editor export/reopen exactly.
- Working BL1 maps equal independently parsed and physically normalized cofecha-js maps.
- Input SHA-256 unchanged: `7245ae51a0e4dca43411716ae86c98f77911ddbf426b9f1c0396160d21d2939b`.
- RWL/editor regression: 33 passed, including 6 bundled RWL round trips, real 999 measurements, unit-preserving edits and history isolation.
- Existing production regression: 108 passed. The new mixed-precision regression is now included in the production command.
- TypeScript and production build passed. Existing bundle-size/chunk warnings remain.
- The standalone `validate-samples.mjs` Vite helper exhausted Node memory; the same 6 bundled samples were instead validated directly in Vitest, avoiding its dev-server lifecycle.
- Frozen v5 model SHA-256 unchanged: `4a355af59c22a9cd53e20d233256d94b44b83aea222d7ace55e6cb7e9bbb5c1e`.

Run the local input regression by setting `CROSSDATING_MIXED_RWL` to the input path before running `src/features/rwl/__tests__/tucsonMixedPrecision.test.ts`. The user file is read only and is not committed as a fixture. Native GUI interaction was not exercised. On reopening an older cached draft, choose the disk version if the draft predates this fix; already-saved ambiguous `999 -9999` sequences cannot be repaired by indiscriminately deleting numeric 999 values.

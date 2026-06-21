# COFECHA-pass Reference Series

## Purpose

The project keeps two reference concepts separate:

- Manual visual reference: chosen by the user in the line chart. It is used for visual comparison only.
- COFECHA-pass dynamic reference: generated after each COFECHA run from series without PART 6 `A` flags. It is used by automatic crossdating and optional inspection only.

The two references must not overwrite each other. Running COFECHA updates the dynamic reference, but it does not replace the user's manual visual reference.

## Manual Visual Reference

Manual reference is intentionally simple. For every year, the chart takes the selected raw ring-width values and computes an arithmetic mean:

```text
manualReference(year) = mean(selectedRawWidthsAtYear)
```

Years below `minSampleDepth` are not drawn. The default `minSampleDepth` is `2`.

This line stays on the same Y axis as the raw series, so it is suitable for visual comparison when inserting or deleting years. It is not COFECHA's residual master chronology.

## Dynamic Algorithm Reference

After COFECHA finishes, the app parses PART 6:

```text
anchorPassIds = allSeriesIds - flaggedAIds
candidateFlaggedIds = flaggedAIds
```

Only `anchorPassIds` are used to build the dynamic reference. `candidateFlaggedIds` are kept as targets for later offset/correction checks.

The dynamic reference follows the COFECHA-style transform implemented in `src/features/crossdating/reference.ts`:

```text
raw width
-> 32-year 50%-response cubic smoothing spline detrending
-> ring-width index
-> autoregressive prewhitening
-> log transform
-> yearly accumulator/counter mean
-> final residual chronology standardization
```

Its stored values are residual chronology values, not raw ring widths. Therefore values can be negative and are not directly comparable to the raw width Y axis.

## Chart Behavior

The line chart receives both references separately:

- `referenceSeries`: manual visual reference, always shown when the user has selected one.
- `dynamicReferenceSeries`: COFECHA-pass algorithm reference, hidden by default and shown with a `COFECHA-pass` checkbox next to the sample-size checkbox.

The dynamic reference is drawn on a separate hidden Y axis. Turning it on lets maintainers inspect its shape, but it does not rescale or distort the raw width chart.

## Automatic Crossdating

The diagnosis worker receives `dynamicReferenceConfig`, not the manual visual reference. This keeps user-selected visual reference lines from changing automatic crossdating behavior.

When `dynamicReferenceConfig.cofechaPassReference` is available, automatic scoring uses its `points` directly as the master reference. It no longer degrades the dynamic reference into a plain average of selected anchor series.

## Persistence

Persisted reference state stores:

- `referenceConfig`: manual visual reference.
- `dynamicReferenceConfig`: latest COFECHA-pass dynamic reference.

Older caches that stored a dynamic reference in `referenceConfig` are migrated on load: the dynamic config is moved into `dynamicReferenceConfig`, and the visual reference is left empty.

## Validation

Run:

```bash
npm run validate:cofecha-reference
npm run build
```

`validate:cofecha-reference` checks PART 6 classification, dynamic reference generation, final residual standardization, and offset target selection.

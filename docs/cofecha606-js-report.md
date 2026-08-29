# COFECHA 6.06-compatible JS report

The experiment branch contains a pure TypeScript implementation of the
computational content of a COFECHA 6.06 report. It does not launch, bundle, or
redistribute the COFECHA executable.

## API

```ts
import {
    formatCofecha606JsReport,
    generateCofecha606JsReport,
} from "@/features/cofecha";

const report = generateCofecha606JsReport(siteData, {
    jobName: "FULL",
    inputFileName: "site.rwl",
    runAt: new Date(),
});

const outText = formatCofecha606JsReport(report);
const masText = report.savedMasterText;
```

The structured report retains Parts 1-7, the full 21-lag table for every
segment, all Part 6 A-E evidence, exact run metadata, and optional `.MAS` text.
The text formatter favors stable semantic content over COFECHA's pagination,
printer control codes, and byte layout.

## Supported settings

- Spline rigidity and 50% frequency response.
- Segment length and segment lag.
- AR modeling on or off.
- Log transform on or off.
- First-difference transform.
- No-transform mode selected by a negative spline rigidity.
- Pearson or Spearman correlation.
- Automatic 99% critical correlation or an explicit threshold.
- Include or omit absent rings from the master.
- Selected report parts, measurement listing, and master output.

## Validation

- 34 high-quality ITRDB files: Parts 1-7 passed for all 34 files.
- Independent frozen holdout: all 14 COFECHA-evaluable files passed Parts 1-7.
- Three additional numeric-Ident holdout files were excluded because COFECHA
  itself did not produce a report for them.
- `nm574` settings matrix passed for plain, log-only, AR-only, full,
  first-difference, no-transform, 50-year spline, 60/30 segmenting,
  Spearman, and include-absent modes.

Run one semantic comparison with:

```powershell
npm run validate:cofecha-js-report -- `
  --rwl D:\path\site.rwl `
  --out D:\path\FULLCOF.OUT `
  --output D:\path\validation.json
```

The implementation remains a shadow API in this branch. Production COFECHA
execution and the existing diagnosis reference path are unchanged.

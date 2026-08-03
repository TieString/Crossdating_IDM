import { readFile } from "node:fs/promises";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error(
    "Usage: npm run analyze:unit-window-stability -- <locator-audit.json> [...]",
  );
  process.exit(2);
}

const contains = (window, year) => (
  window
  && Number.isFinite(year)
  && window.startYear <= year
  && year <= window.endYear
);

const rate = (value, total) => (
  total > 0 ? `${(value / total * 100).toFixed(2)}%` : "-"
);

const widthOf = (window) => (
  window ? window.endYear - window.startYear + 1 : 0
);

const summarizeGroups = (rows, key) => Object.fromEntries(
  [...new Set(rows.map((row) => row[key] ?? "unknown"))]
    .sort()
    .map((name) => {
      const selected = rows.filter((row) => (row[key] ?? "unknown") === name);
      const hits = selected.filter((row) => (
        contains(row.finalWindow, row.truthYear)
      )).length;
      return [name, {
        cases: selected.length,
        hits,
        coverage: rate(hits, selected.length),
        widths: Object.fromEntries(
          [...new Set(selected.map((row) => widthOf(row.finalWindow)))]
            .sort((left, right) => left - right)
            .map((width) => [
              width,
              selected.filter((row) => widthOf(row.finalWindow) === width).length,
            ]),
        ),
      }];
    }),
);

const summarizeType = (payload, eventType) => {
  const allCases = (payload.formalEventCaseOutcomes ?? []).filter(
    (row) => row.eventType === eventType,
  );
  const productionAnswered = allCases.filter((row) => row.answered);
  const productionHits = allCases.filter((row) => row.primaryMatched).length;
  const rows = (payload.counterfactualLocatorCases ?? []).filter((row) => (
    row.eventType === eventType
    && row.context?.baselineFlagged === false
  ));
  const coarseHits = rows.filter((row) => (
    contains(row.coarseWindow, row.truthYear)
  )).length;
  const modeHits = rows.filter((row) => (
    contains(row.modeWindow, row.truthYear)
  )).length;
  const finalHits = rows.filter((row) => (
    contains(row.finalWindow, row.truthYear)
  )).length;
  const widths = Object.fromEntries(
    [...new Set(rows.map((row) => widthOf(row.finalWindow)))]
      .sort((left, right) => left - right)
      .map((width) => [
        width,
        rows.filter((row) => widthOf(row.finalWindow) === width).length,
      ]),
  );
  return {
    eventType,
    production: {
      cases: allCases.length,
      answered: productionAnswered.length,
      responseRate: rate(productionAnswered.length, allCases.length),
      primaryWindowHits: productionHits,
      primaryWindowCoverageAll: rate(productionHits, allCases.length),
      primaryWindowCoverageAnswered: rate(
        productionHits,
        productionAnswered.length,
      ),
      widths: payload.summary?.[eventType]?.widthHistogram ?? {},
    },
    locatorStages: {
      cases: rows.length,
      responseRateAgainstFormalCases: rate(rows.length, allCases.length),
      coarseHits,
      coarseCoverageAll: rate(coarseHits, allCases.length),
      coarseCoverageLocatorCases: rate(coarseHits, rows.length),
      modeHits,
      modeCoverageAll: rate(modeHits, allCases.length),
      modeCoverageLocatorCases: rate(modeHits, rows.length),
      locatorFinalHits: finalHits,
      locatorFinalCoverageAll: rate(finalHits, allCases.length),
      locatorFinalCoverageLocatorCases: rate(finalHits, rows.length),
      postLocatorAnsweredDelta: productionAnswered.length - rows.length,
      postLocatorHitDelta: productionHits - finalHits,
      coarseMisses: rows.length - coarseHits,
      coarseHitModeMisses: rows.filter((row) => (
        contains(row.coarseWindow, row.truthYear)
        && !contains(row.modeWindow, row.truthYear)
      )).length,
      modeHitNarrowingMisses: rows.filter((row) => (
        contains(row.modeWindow, row.truthYear)
        && !contains(row.finalWindow, row.truthYear)
      )).length,
      widths,
      byWindowCenteringRule: summarizeGroups(rows, "windowCenteringRule"),
      byWidthSelectionRule: summarizeGroups(rows, "widthSelectionRule"),
    },
  };
};

const reports = [];
for (const path of paths) {
  const payload = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(payload.counterfactualLocatorCases)) {
    throw new Error(
      `${path} has no counterfactualLocatorCases; rerun with ITRDB_COUNTERFACTUAL_LOCATOR_AUDIT=1`,
    );
  }
  reports.push({
    path,
    fileSplit: payload.fileSplit ?? null,
    fileSkip: payload.sampling?.fileSkip ?? null,
    offset: payload.offset ?? null,
    missingRing: summarizeType(payload, "missingRing"),
    falseRing: summarizeType(payload, "falseRing"),
  });
}

console.log(JSON.stringify({ reports }, null, 2));

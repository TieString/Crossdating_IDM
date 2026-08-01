import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  throw new Error("Usage: node scripts/analyze-itrdb-event-audits.mjs <audit.json> [...]");
}

const audits = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
const eventTypes = ["missingRing", "falseRing", "partialMove"];

const emptyCountMap = () => Object.create(null);
const increment = (counts, key, amount = 1) => {
  counts[key] = (counts[key] ?? 0) + amount;
};
const ratio = (numerator, denominator) => numerator / Math.max(1, denominator);
const distanceToRange = (year, range) => (
  year < range[0] ? range[0] - year : year > range[1] ? year - range[1] : 0
);

const metadataMatches = (failure, prediction) => (
  failure.eventType !== "partialMove"
  || (
    prediction.shiftYears === -failure.injectedShift
    && prediction.shiftSide === "older"
  )
);

const taxonomyByType = Object.fromEntries(eventTypes.map((eventType) => [eventType, {
  cases: 0,
  matched: 0,
  incomplete: 0,
  matchedWithExtras: 0,
  noPrediction: 0,
  noCorrectType: 0,
  metadataMismatch: 0,
  windowMiss: 0,
  windowMissDistances: [],
  predictedTypesWhenWrong: emptyCountMap(),
  failureSources: emptyCountMap(),
}]));
const clean = {
  cases: 0,
  falsePositiveCases: 0,
  predictionTypes: emptyCountMap(),
  sourceCombinations: emptyCountMap(),
  sources: emptyCountMap(),
};

for (const audit of audits) {
  for (const eventType of eventTypes) {
    const target = taxonomyByType[eventType];
    target.cases += audit.summary[eventType].cases;
    target.matched += Math.round(
      audit.summary[eventType].recall * audit.summary[eventType].cases,
    );
  }
  clean.cases += audit.summary.clean.cases;

  for (const failure of audit.failures) {
    if (failure.eventType === "clean") {
      clean.falsePositiveCases += 1;
      for (const prediction of failure.predictions) {
        increment(clean.predictionTypes, prediction.type);
        increment(clean.sourceCombinations, [...prediction.sources].sort().join("+"));
        for (const source of prediction.sources) increment(clean.sources, source);
      }
      continue;
    }
    if (!eventTypes.includes(failure.eventType)) continue;

    const target = taxonomyByType[failure.eventType];
    target.incomplete += 1;
    for (const prediction of failure.predictions) {
      for (const source of prediction.sources ?? []) increment(target.failureSources, source);
    }
    if (failure.predictions.length === 0) {
      target.noPrediction += 1;
      continue;
    }

    const typed = failure.predictions.filter((prediction) => (
      prediction.type === failure.eventType
    ));
    if (typed.length === 0) {
      target.noCorrectType += 1;
      for (const prediction of failure.predictions) {
        increment(target.predictedTypesWhenWrong, prediction.type);
      }
      continue;
    }

    const metadataCompatible = typed.filter((prediction) => metadataMatches(failure, prediction));
    if (metadataCompatible.length === 0) {
      target.metadataMismatch += 1;
      continue;
    }

    const matching = metadataCompatible.filter((prediction) => (
      distanceToRange(failure.truthYear, prediction.range) === 0
    ));
    if (matching.length > 0) {
      target.matchedWithExtras += 1;
      continue;
    }

    target.windowMiss += 1;
    target.windowMissDistances.push(Math.min(
      ...metadataCompatible.map((prediction) => (
        distanceToRange(failure.truthYear, prediction.range)
      )),
    ));
  }
}

const summarizeTaxonomy = (target) => ({
  cases: target.cases,
  matched: target.matched,
  recall: ratio(target.matched, target.cases),
  incomplete: target.incomplete,
  incompleteTaxonomy: {
    matchedWithExtras: target.matchedWithExtras,
    noPrediction: target.noPrediction,
    noCorrectType: target.noCorrectType,
    metadataMismatch: target.metadataMismatch,
    windowMiss: target.windowMiss,
  },
  windowMissDistanceHistogram: Object.fromEntries(
    Array.from(new Set(target.windowMissDistances))
      .sort((a, b) => a - b)
      .map((distance) => [
        distance,
        target.windowMissDistances.filter((value) => value === distance).length,
      ]),
  ),
  shiftedWindowUpperBounds: Object.fromEntries([1, 2, 3, 4, 5].map((distance) => {
    const recoverable = target.windowMissDistances.filter((value) => value <= distance).length;
    return [distance, {
      recoverable,
      recall: ratio(target.matched + recoverable, target.cases),
    }];
  })),
  predictedTypesWhenWrong: target.predictedTypesWhenWrong,
  topFailureSources: Object.fromEntries(
    Object.entries(target.failureSources).sort((a, b) => b[1] - a[1]).slice(0, 12),
  ),
});

const noteYearEntries = (notes) => notes.flatMap((note) => {
  const match = /^([A-Za-z0-9_]+)_year=(-?\d+)$/.exec(note);
  return match ? [{ key: match[1], year: Number(match[2]) }] : [];
});

const familyFor = (key) => {
  if (key === "profile_boundary") return "profile";
  if (key === "scan_top") return "scan";
  if (key === "raw_path_top") return "rawPath";
  if (key === "candidate_top") return "candidate";
  if (key === "paired_breakpoint") return "paired";
  if (key === "direct_transition") return "direct";
  if (key === "reference_vote") return "referenceVote";
  if (key === "nominal_boundary") return "nominal";
  if (key === "unit_local_raw_boundary") return "localRawRefinement";
  if (key.startsWith("unit_local_")) return "unitLocalConsensus";
  if (key.startsWith("unit_window_")) return "unitWindowConsensus";
  if (key.startsWith("partial_")) return "partial";
  return key;
};

const modeYear = (years, currentTop) => {
  const counts = new Map();
  for (const year of years) counts.set(year, (counts.get(year) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (
      b[1] - a[1]
      || Math.abs(a[0] - currentTop) - Math.abs(b[0] - currentTop)
      || b[0] - a[0]
    ))[0]?.[0] ?? currentTop;
};

const rankingRows = audits.flatMap((audit) => audit.rankingCases.map((rankCase) => {
  const currentTop = rankCase.rankedYears[0].year;
  const byFamily = new Map();
  for (const entry of noteYearEntries(rankCase.notes)) {
    if (entry.year < rankCase.range[0] || entry.year > rankCase.range[1]) continue;
    const family = familyFor(entry.key);
    const values = byFamily.get(family) ?? [];
    values.push(entry.year);
    byFamily.set(family, values);
  }
  return {
    ...rankCase,
    offset: audit.offset,
    currentTop,
    familyYears: Object.fromEntries(
      [...byFamily.entries()].map(([family, years]) => [
        family,
        modeYear(years, currentTop),
      ]),
    ),
  };
}));

const selectConsensus = (row, currentWeight) => {
  const votes = new Map([[row.currentTop, currentWeight]]);
  for (const year of Object.values(row.familyYears)) {
    votes.set(year, (votes.get(year) ?? 0) + 1);
  }
  const currentRanks = new Map(
    row.rankedYears.map((ranked, index) => [ranked.year, index]),
  );
  return [...votes.entries()].sort((a, b) => (
    b[1] - a[1]
    || (currentRanks.get(a[0]) ?? 999) - (currentRanks.get(b[0]) ?? 999)
    || Math.abs(a[0] - row.currentTop) - Math.abs(b[0] - row.currentTop)
  ))[0][0];
};

const scoreYears = (rows, selector) => {
  let exact = 0;
  let withinOne = 0;
  for (const row of rows) {
    const year = selector(row);
    exact += Number(year === row.truthYear);
    withinOne += Number(Math.abs(year - row.truthYear) <= 1);
  }
  return {
    cases: rows.length,
    exact,
    exactRate: ratio(exact, rows.length),
    withinOne,
    withinOneRate: ratio(withinOne, rows.length),
  };
};

const rankingByType = Object.fromEntries(eventTypes.map((eventType) => {
  const rows = rankingRows.filter((row) => row.eventType === eventType);
  const familyNames = Array.from(new Set(rows.flatMap((row) => (
    Object.keys(row.familyYears)
  ))));
  const familyReports = familyNames.map((family) => {
    const available = rows.filter((row) => row.familyYears[family] !== undefined);
    const report = scoreYears(available, (row) => row.familyYears[family]);
    const current = scoreYears(available, (row) => row.currentTop);
    return {
      family,
      available: available.length,
      exactRate: report.exactRate,
      withinOneRate: report.withinOneRate,
      currentExactRateOnSameCases: current.exactRate,
      currentWithinOneRateOnSameCases: current.withinOneRate,
      exactDelta: report.exact - current.exact,
      withinOneDelta: report.withinOne - current.withinOne,
    };
  }).filter((row) => row.available >= 10)
    .sort((a, b) => b.available - a.available || b.exactDelta - a.exactDelta);

  const oracle = scoreYears(rows, (row) => {
    const years = [row.currentTop, ...Object.values(row.familyYears)];
    return years.find((year) => year === row.truthYear)
      ?? years.find((year) => Math.abs(year - row.truthYear) <= 1)
      ?? row.currentTop;
  });
  return [eventType, {
    baseline: scoreYears(rows, (row) => row.currentTop),
    consensus: Object.fromEntries([0, 1, 2, 3, 4, 5].map((currentWeight) => [
      currentWeight,
      scoreYears(rows, (row) => selectConsensus(row, currentWeight)),
    ])),
    signalOracle: oracle,
    families: familyReports,
    byOffset: Object.fromEntries(audits.map((audit) => {
      const offsetRows = rows.filter((row) => row.offset === audit.offset);
      return [audit.offset, scoreYears(offsetRows, (row) => row.currentTop)];
    })),
  }];
}));

const report = {
  offsets: audits.map((audit) => audit.offset),
  summaries: Object.fromEntries(audits.map((audit) => [audit.offset, audit.summary])),
  failureTaxonomy: Object.fromEntries(eventTypes.map((eventType) => [
    eventType,
    summarizeTaxonomy(taxonomyByType[eventType]),
  ])),
  clean: {
    cases: clean.cases,
    falsePositiveCases: clean.falsePositiveCases,
    falsePositiveRate: ratio(clean.falsePositiveCases, clean.cases),
    predictionTypes: clean.predictionTypes,
    topSourceCombinations: Object.fromEntries(
      Object.entries(clean.sourceCombinations).sort((a, b) => b[1] - a[1]).slice(0, 15),
    ),
    topSources: Object.fromEntries(
      Object.entries(clean.sources).sort((a, b) => b[1] - a[1]).slice(0, 15),
    ),
  },
  ranking: rankingByType,
};

console.log(JSON.stringify(report, null, 2));

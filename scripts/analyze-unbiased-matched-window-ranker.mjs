import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length < 2) {
    throw new Error(
        "Usage: node scripts/analyze-unbiased-matched-window-ranker.mjs <offset-data.json> [...]",
    );
}

const auditPattern = process.env.MATCHED_WINDOW_AUDIT_PATTERN
    ?? ".tmp-final-perf-dev-audit-{offset}.json";
const eventTypes = ["missingRing", "falseRing", "partialMove"];
const metadataFeatures = new Set([
    "normalizedPosition",
    "olderContext",
    "newerContext",
    "candidateLag",
    "candidateLagAbs",
    "candidateLagDirection",
    "referenceCount",
    "hasCurrentEvent",
    "currentTopDistance",
    "currentTopSignedDistance",
    "insideCurrentWindow",
]);

const keyFor = (file, target, eventType) => `${file}\u0000${target}\u0000${eventType}`;
const cases = [];

for (const path of paths) {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    if (payload.sampling !== "calendar-position-stratified-signal-independent") {
        throw new Error(`${path} does not use signal-independent sampling.`);
    }
    if ([13, 14, 15, 16, 17, 18, 19, 20].includes(payload.offset)) {
        throw new Error("Offsets 13-20 are consumed blind evaluations.");
    }
    const auditPath = auditPattern.replace("{offset}", String(payload.offset));
    const audit = JSON.parse(readFileSync(auditPath, "utf8"));
    const rankingByKey = new Map(audit.rankingCases.map((rankCase) => [
        keyFor(rankCase.groupId, rankCase.seriesId, rankCase.eventType),
        rankCase,
    ]));
    payload.cases.forEach((rankCase) => {
        const ranking = rankingByKey.get(keyFor(
            rankCase.context.file,
            rankCase.context.target,
            rankCase.eventType,
        ));
        if (!ranking?.matchedLocationRange || !ranking.matchedLocationRankedYears?.length) return;
        if (rankCase.eventType === "partialMove"
            && rankCase.currentShiftYears !== rankCase.truthShiftYears) {
            return;
        }
        const [startYear, endYear] = ranking.matchedLocationRange;
        const shiftYears = rankCase.eventType === "partialMove"
            ? rankCase.truthShiftYears
            : undefined;
        const currentByYear = new Map(
            ranking.matchedLocationRankedYears.map((row) => [row.year, row]),
        );
        const rows = rankCase.rows
            .filter((row) => (
                row.year >= startYear
                && row.year <= endYear
                && (
                    rankCase.eventType !== "partialMove"
                    || row.shiftYears === shiftYears
                )
            ))
            .map((row) => ({
                ...row,
                features: {
                    ...row.features,
                    currentScore: currentByYear.get(row.year)?.score ?? Number.NEGATIVE_INFINITY,
                    currentRankStrength: currentByYear.has(row.year)
                        ? 1 / currentByYear.get(row.year).rank
                        : 0,
                    currentTopProximity: -Math.abs(
                        row.year - ranking.matchedLocationRankedYears[0].year,
                    ),
                },
            }));
        if (rows.length < 2) return;
        cases.push({
            ...rankCase,
            offset: payload.offset,
            matchedRange: [startYear, endYear],
            currentTopYear: ranking.matchedLocationRankedYears[0].year,
            rows,
        });
    });
}

const featureNames = Object.keys(cases[0]?.rows[0]?.features ?? {})
    .filter((name) => !metadataFeatures.has(name));

const percentileRanks = (values) => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const ranks = new Float64Array(values.length);
    let start = 0;
    while (start < ordered.length) {
        let end = start + 1;
        while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1;
        const rank = ordered.length <= 1
            ? 0.5
            : ((start + end - 1) / 2) / (ordered.length - 1);
        for (let index = start; index < end; index += 1) ranks[ordered[index].index] = rank;
        start = end;
    }
    return ranks;
};

cases.forEach((rankCase) => {
    rankCase.ranks = Object.fromEntries(featureNames.map((feature) => [
        feature,
        percentileRanks(rankCase.rows.map((row) => Number(row.features[feature] ?? 0))),
    ]));
});

const emptyMetrics = () => ({ cases: 0, exact: 0, withinOne: 0, absoluteError: 0 });
const add = (metrics, rankCase, year) => {
    const error = Math.abs(year - rankCase.truthYear);
    metrics.cases += 1;
    metrics.exact += Number(error === 0);
    metrics.withinOne += Number(error <= 1);
    metrics.absoluteError += error;
};
const rates = (metrics) => ({
    cases: metrics.cases,
    exact: metrics.exact / Math.max(1, metrics.cases),
    withinOne: metrics.withinOne / Math.max(1, metrics.cases),
    meanAbsoluteError: metrics.absoluteError / Math.max(1, metrics.cases),
});

const predict = (rankCase, config) => {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    rankCase.rows.forEach((row, index) => {
        const left = rankCase.ranks[config.left][index];
        const score = config.right
            ? left * config.leftWeight
                + rankCase.ranks[config.right][index] * (1 - config.leftWeight)
            : left;
        if (score > bestScore || (score === bestScore && row.year > rankCase.rows[bestIndex].year)) {
            bestIndex = index;
            bestScore = score;
        }
    });
    const [minimumYear, maximumYear] = rankCase.matchedRange;
    return Math.max(
        minimumYear,
        Math.min(maximumYear, rankCase.rows[bestIndex].year + config.yearCorrection),
    );
};

const evaluate = (evaluationCases, config) => {
    const metrics = emptyMetrics();
    evaluationCases.forEach((rankCase) => add(metrics, rankCase, predict(rankCase, config)));
    return rates(metrics);
};

const compare = (left, right) => (
    right.exact - left.exact
    || right.withinOne - left.withinOne
    || left.meanAbsoluteError - right.meanAbsoluteError
);

const configurations = (trainingCases) => {
    const singles = featureNames.flatMap((left) => (
        [-2, -1, 0, 1, 2].map((yearCorrection) => ({
            left,
            right: null,
            leftWeight: 1,
            yearCorrection,
        }))
    ));
    const rankedSingles = singles
        .map((config) => ({ config, metrics: evaluate(trainingCases, config) }))
        .sort((left, right) => compare(left.metrics, right.metrics));
    const topFeatures = [...new Set(
        rankedSingles.slice(0, 30).map((row) => row.config.left),
    )].slice(0, 12);
    const pairs = [];
    for (let leftIndex = 0; leftIndex < topFeatures.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < topFeatures.length; rightIndex += 1) {
            [0.25, 0.5, 0.75].forEach((leftWeight) => {
                [-1, 0, 1].forEach((yearCorrection) => pairs.push({
                    left: topFeatures[leftIndex],
                    right: topFeatures[rightIndex],
                    leftWeight,
                    yearCorrection,
                }));
            });
        }
    }
    return [...rankedSingles, ...pairs.map((config) => ({
        config,
        metrics: evaluate(trainingCases, config),
    }))].sort((left, right) => compare(left.metrics, right.metrics));
};

const summarize = (eventType) => {
    const typed = cases.filter((rankCase) => rankCase.eventType === eventType);
    const baselineMetrics = emptyMetrics();
    typed.forEach((rankCase) => add(baselineMetrics, rankCase, rankCase.currentTopYear));
    const offsets = [...new Set(typed.map((rankCase) => rankCase.offset))].sort();
    const crossValidated = emptyMetrics();
    const folds = offsets.map((heldOutOffset) => {
        const training = typed.filter((rankCase) => rankCase.offset !== heldOutOffset);
        const validation = typed.filter((rankCase) => rankCase.offset === heldOutOffset);
        const selected = configurations(training)[0];
        validation.forEach((rankCase) => add(
            crossValidated,
            rankCase,
            predict(rankCase, selected.config),
        ));
        return {
            heldOutOffset,
            selected: selected.config,
            training: selected.metrics,
            validation: evaluate(validation, selected.config),
        };
    });
    const fitted = configurations(typed)[0];
    return {
        cases: typed.length,
        baseline: rates(baselineMetrics),
        leaveOneOffsetOut: rates(crossValidated),
        folds,
        fitted: fitted.metrics,
        fittedConfig: fitted.config,
    };
};

process.stdout.write(`${JSON.stringify({
    sampling: "calendar-position-stratified-signal-independent",
    conditioning: "truth-covered selectable window and correct partial shift",
    featureCount: featureNames.length,
    offsets: [...new Set(cases.map((rankCase) => rankCase.offset))].sort(),
    matchedCases: cases.length,
    ...Object.fromEntries(eventTypes.map((eventType) => [
        eventType,
        summarize(eventType),
    ])),
}, null, 2)}\n`);

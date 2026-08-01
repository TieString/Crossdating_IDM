import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length < 2) {
    throw new Error(
        "Usage: node scripts/analyze-unbiased-location-options.mjs <offset-data.json> [...]",
    );
}

const auditPattern = process.env.LOCATION_OPTION_AUDIT_PATTERN
    ?? ".tmp-location-option-audits/offset-{offset}-cases-25.json";
const eventTypes = ["missingRing", "falseRing", "partialMove"];
const ignoredRowFeatures = new Set([
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
const rawCases = [];

for (const path of paths) {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    if (payload.sampling !== "calendar-position-stratified-signal-independent") {
        throw new Error(`${path} does not use signal-independent sampling.`);
    }
    if ([13, 14, 15, 16, 17, 18, 19, 20].includes(payload.offset)) {
        throw new Error("Offsets 13-20 are consumed blind evaluations.");
    }
    const audit = JSON.parse(readFileSync(
        auditPattern.replace("{offset}", String(payload.offset)),
        "utf8",
    ));
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
        if (!ranking?.locations?.length) return;
        rawCases.push({ ...rankCase, ranking, offset: payload.offset });
    });
}

const rowFeatureNames = Object.keys(rawCases[0]?.rows[0]?.features ?? {})
    .filter((name) => !ignoredRowFeatures.has(name));
const algorithmSources = [...new Set(rawCases.flatMap((rankCase) => (
    rankCase.ranking.locations.map((location) => location.algorithmSource)
)))].sort();

const mean = (values) => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

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

const preparedCases = rawCases.map((rankCase) => {
    const options = rankCase.ranking.locations.map((location) => {
        const rows = rankCase.rows.filter((row) => (
            row.year >= location.range[0]
            && row.year <= location.range[1]
            && (
                rankCase.eventType !== "partialMove"
                || row.shiftYears === location.shiftYears
            )
        ));
        const topRow = rows.find((row) => row.year === location.topYear) ?? null;
        const featureValues = {
            evidenceScore: location.evidenceScore,
            locationScoreMargin: location.locationScoreMargin,
            yearScoreMargin: location.yearScoreMargin,
            originalRankStrength: 1 / (location.rank + 1),
            inverseWidth: 1 / (location.range[1] - location.range[0] + 1),
        };
        rowFeatureNames.forEach((feature) => {
            const values = rows.map((row) => Number(row.features[feature] ?? 0));
            featureValues[`max:${feature}`] = values.length > 0
                ? Math.max(...values)
                : Number.NEGATIVE_INFINITY;
            featureValues[`mean:${feature}`] = values.length > 0
                ? mean(values)
                : Number.NEGATIVE_INFINITY;
            featureValues[`top:${feature}`] = topRow
                ? Number(topRow.features[feature] ?? 0)
                : Number.NEGATIVE_INFINITY;
        });
        algorithmSources.forEach((source) => {
            featureValues[`source:${source}`] = Number(location.algorithmSource === source);
        });
        return {
            ...location,
            hit: rankCase.truthYear >= location.range[0]
                && rankCase.truthYear <= location.range[1],
            featureValues,
        };
    });
    const featureNames = Object.keys(options[0]?.featureValues ?? {});
    const ranks = Object.fromEntries(featureNames.map((feature) => [
        feature,
        percentileRanks(options.map((option) => option.featureValues[feature])),
    ]));
    return {
        ...rankCase,
        featureNames,
        options: options.map((option, index) => ({
            ...option,
            featureRanks: Object.fromEntries(featureNames.map((feature) => [
                feature,
                ranks[feature][index],
            ])),
        })),
    };
});

const featureNames = preparedCases[0]?.featureNames ?? [];
const weights = [0.25, 0.5, 0.75, 1];
const gates = [0, 0.05, 0.1, 0.2, 0.35, 0.5];
const configurations = featureNames.flatMap((feature) => (
    weights.flatMap((featureWeight) => gates.map((minimumLead) => ({
        feature,
        featureWeight,
        minimumLead,
    })))
));

const scoreOption = (option, config) => (
    option.featureRanks[config.feature] * config.featureWeight
    + option.featureRanks.originalRankStrength * (1 - config.featureWeight)
);

const selectOption = (rankCase, config) => {
    const primary = rankCase.options.find((option) => option.rank === 0)
        ?? rankCase.options[0];
    const ordered = [...rankCase.options].sort((left, right) => (
        scoreOption(right, config) - scoreOption(left, config)
        || left.rank - right.rank
    ));
    const best = ordered[0] ?? primary;
    return best !== primary
        && scoreOption(best, config) - scoreOption(primary, config) >= config.minimumLead
        ? best
        : primary;
};

const emptyMetrics = () => ({
    cases: 0,
    hits: 0,
    switches: 0,
    alternativeHits: 0,
});
const addPrediction = (metrics, rankCase, selected) => {
    metrics.cases += 1;
    metrics.hits += Number(selected.hit);
    metrics.switches += Number(selected.rank > 0);
    metrics.alternativeHits += Number(selected.rank > 0 && selected.hit);
};
const rates = (metrics, totalCases) => ({
    selectableCases: metrics.cases,
    conditionalPrimaryCoverage: metrics.hits / Math.max(1, metrics.cases),
    allCasePrimaryRecall: metrics.hits / Math.max(1, totalCases),
    switchRate: metrics.switches / Math.max(1, metrics.cases),
    productiveSwitchRate: metrics.alternativeHits / Math.max(1, metrics.switches),
});
const evaluate = (evaluationCases, config, totalCases = evaluationCases.length) => {
    const metrics = emptyMetrics();
    evaluationCases.forEach((rankCase) => {
        addPrediction(metrics, rankCase, selectOption(rankCase, config));
    });
    return rates(metrics, totalCases);
};
const compare = (left, right) => (
    right.conditionalPrimaryCoverage - left.conditionalPrimaryCoverage
    || right.productiveSwitchRate - left.productiveSwitchRate
    || left.switchRate - right.switchRate
);

const summarize = (eventType) => {
    const typed = preparedCases.filter((rankCase) => rankCase.eventType === eventType);
    const offsets = [...new Set(typed.map((rankCase) => rankCase.offset))].sort();
    const totalCases = offsets.length * 25;
    const baseline = evaluate(typed, {
        feature: "originalRankStrength",
        featureWeight: 1,
        minimumLead: 0,
    }, totalCases);
    const aggregate = emptyMetrics();
    const folds = offsets.map((heldOutOffset) => {
        const training = typed.filter((rankCase) => rankCase.offset !== heldOutOffset);
        const validation = typed.filter((rankCase) => rankCase.offset === heldOutOffset);
        const selected = configurations
            .map((config) => ({ config, metrics: evaluate(training, config) }))
            .sort((left, right) => compare(left.metrics, right.metrics))[0];
        validation.forEach((rankCase) => {
            addPrediction(aggregate, rankCase, selectOption(rankCase, selected.config));
        });
        return {
            heldOutOffset,
            selected: selected.config,
            training: selected.metrics,
            validation: evaluate(validation, selected.config, 25),
        };
    });
    const fitted = configurations
        .map((config) => ({ config, metrics: evaluate(typed, config, totalCases) }))
        .sort((left, right) => compare(left.metrics, right.metrics))[0];
    return {
        totalCases,
        selectableCases: typed.length,
        meanOptions: mean(typed.map((rankCase) => rankCase.options.length)),
        baseline,
        leaveOneOffsetOut: rates(aggregate, totalCases),
        folds,
        fitted,
    };
};

process.stdout.write(`${JSON.stringify({
    sampling: "calendar-position-stratified-signal-independent",
    target: "rank existing narrow location options without changing their union",
    offsets: [...new Set(preparedCases.map((rankCase) => rankCase.offset))].sort(),
    featureCount: featureNames.length,
    algorithmSources,
    ...Object.fromEntries(eventTypes.map((eventType) => [
        eventType,
        summarize(eventType),
    ])),
}, null, 2)}\n`);

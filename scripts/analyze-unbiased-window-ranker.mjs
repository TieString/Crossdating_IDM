import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length === 0) {
    throw new Error(
        "Usage: node scripts/analyze-unbiased-window-ranker.mjs <offset-data.json> [...]",
    );
}

const scoreFeatures = [
    "rawFull",
    "differenceFull",
    "whitenedFull",
    "comboFull",
    "differenceGain21",
    "differenceGain31",
    "differenceGain41",
    "differenceGain61",
    "whitenedGain31",
    "whitenedGain61",
    "pairDifferenceMean",
    "pairDifferenceMedian",
    "pairDifferenceTrimmed",
    "pairDifferenceWeighted",
    "pairWhitenedMean",
    "pairWhitenedMedian",
    "pairDifferenceMeanGain",
    "pairDifferenceTrimmedGain",
    "pairWhitenedMeanGain",
    "piecewiseCombinedObjective",
    "piecewiseCombinedGain",
    "piecewiseCofechaObjective",
    "piecewiseWhitenedObjective",
    "piecewiseDifferenceObjective",
    "cumulativeCombined",
    "cumulativeContrast",
    "cumulativeLocal31",
    "cumulativeLocal61",
    "cumulativeRaw",
    "cumulativeRawContrast",
    "cumulativeDifference",
    "cumulativeDifferenceContrast",
    "cumulativeWhitened",
    "cumulativeWhitenedContrast",
    "cumulativeCofecha",
    "cumulativeCofechaContrast",
    "cumulativeReferenceMedian",
    "cumulativeReferenceMedianContrast",
    "cumulativeReferenceMean",
    "cumulativeReferenceMeanContrast",
    "cumulativeReferenceVote",
    "cumulativeReferenceVoteContrast",
];

const payloads = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
payloads.forEach((payload, index) => {
    if (payload.sampling !== "calendar-position-stratified-signal-independent") {
        throw new Error(`Input ${paths[index]} is not an unbiased window-ranker dataset.`);
    }
    if ([13, 14, 15, 16, 17, 18, 19, 20].includes(payload.offset)) {
        throw new Error("Offsets 13-20 are consumed blind evaluations.");
    }
});

const caseMap = new Map();
payloads.forEach((payload) => {
    payload.cases.forEach((rankCase) => {
        const key = [
            payload.offset,
            rankCase.context.file,
            rankCase.context.target,
            rankCase.eventType,
        ].join("\u0000");
        if (!caseMap.has(key)) caseMap.set(key, { ...rankCase, offset: payload.offset });
    });
});
const cases = [...caseMap.values()];

const toleranceFor = (eventType) => eventType === "partialMove" ? 4 : 3;
const percentileRanks = (values) => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const result = new Array(values.length).fill(0);
    let start = 0;
    while (start < ordered.length) {
        let end = start + 1;
        while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1;
        const rank = ordered.length <= 1
            ? 0.5
            : ((start + end - 1) / 2) / (ordered.length - 1);
        for (let index = start; index < end; index += 1) {
            result[ordered[index].index] = rank;
        }
        start = end;
    }
    return result;
};

const enrichedCases = cases.map((rankCase) => {
    const ranks = Object.fromEntries(scoreFeatures.map((feature) => [
        feature,
        percentileRanks(rankCase.rows.map((row) => Number(row.features[feature] ?? 0))),
    ]));
    return {
        ...rankCase,
        rows: rankCase.rows.map((row, index) => ({
            ...row,
            ranks: Object.fromEntries(scoreFeatures.map((feature) => [
                feature,
                ranks[feature][index],
            ])),
        })),
    };
});

const emptyMetrics = () => ({
    cases: 0,
    exact: 0,
    withinOne: 0,
    windowHit: 0,
    absoluteError: 0,
});
const addPrediction = (metrics, rankCase, predictedYear) => {
    const error = Math.abs(predictedYear - rankCase.truthYear);
    metrics.cases += 1;
    metrics.exact += Number(error === 0);
    metrics.withinOne += Number(error <= 1);
    metrics.windowHit += Number(error <= toleranceFor(rankCase.eventType));
    metrics.absoluteError += error;
};
const rates = (metrics) => ({
    cases: metrics.cases,
    exact: metrics.exact / Math.max(1, metrics.cases),
    withinOne: metrics.withinOne / Math.max(1, metrics.cases),
    windowHit: metrics.windowHit / Math.max(1, metrics.cases),
    meanAbsoluteError: metrics.absoluteError / Math.max(1, metrics.cases),
});
const bestRow = (rankCase, score) => rankCase.rows.reduce(
    (best, row) => {
        const value = score(row);
        return !best || value > best.score || (value === best.score && row.year > best.row.year)
            ? { row, score: value }
            : best;
    },
    null,
).row;

const evaluatePredictor = (evaluationCases, predictor) => {
    const metrics = emptyMetrics();
    evaluationCases.forEach((rankCase) => addPrediction(metrics, rankCase, predictor(rankCase)));
    return rates(metrics);
};

const currentRangeMetrics = (typedCases) => {
    const metrics = { cases: 0, answered: 0, covered: 0, width: 0 };
    typedCases.forEach((rankCase) => {
        metrics.cases += 1;
        if (!rankCase.currentRange) return;
        metrics.answered += 1;
        metrics.width += rankCase.currentRange[1] - rankCase.currentRange[0] + 1;
        metrics.covered += Number(
            rankCase.truthYear >= rankCase.currentRange[0]
            && rankCase.truthYear <= rankCase.currentRange[1],
        );
    });
    return {
        cases: metrics.cases,
        responseRate: metrics.answered / Math.max(1, metrics.cases),
        coverage: metrics.covered / Math.max(1, metrics.cases),
        precision: metrics.covered / Math.max(1, metrics.answered),
        meanWidth: metrics.width / Math.max(1, metrics.answered),
    };
};

const selectSeparatedPeaks = (rankCase, feature, count, separation) => {
    const ordered = [...rankCase.rows]
        .sort((left, right) => (
            right.ranks[feature] - left.ranks[feature]
            || right.year - left.year
        ));
    const selected = [];
    for (const row of ordered) {
        if (selected.every((other) => Math.abs(other.year - row.year) > separation)) {
            selected.push(row);
            if (selected.length >= count) break;
        }
    }
    return selected;
};

const bestSingleFeatureCrossValidation = (typedCases) => {
    const offsets = [...new Set(typedCases.map((rankCase) => rankCase.offset))]
        .sort((left, right) => left - right);
    const aggregate = emptyMetrics();
    const folds = [];
    offsets.forEach((heldOutOffset) => {
        const training = typedCases.filter((rankCase) => rankCase.offset !== heldOutOffset);
        const validation = typedCases.filter((rankCase) => rankCase.offset === heldOutOffset);
        const configurations = scoreFeatures.flatMap((feature) => (
            [-3, -2, -1, 0, 1, 2, 3].map((yearCorrection) => {
                const metrics = evaluatePredictor(training, (rankCase) => (
                    bestRow(rankCase, (row) => row.ranks[feature]).year + yearCorrection
                ));
                return { feature, yearCorrection, ...metrics };
            })
        ));
        configurations.sort((left, right) => (
            right.windowHit - left.windowHit
            || right.withinOne - left.withinOne
            || right.exact - left.exact
            || left.meanAbsoluteError - right.meanAbsoluteError
        ));
        const selected = configurations[0];
        validation.forEach((rankCase) => {
            const predictedYear = bestRow(
                rankCase,
                (row) => row.ranks[selected.feature],
            ).year + selected.yearCorrection;
            addPrediction(aggregate, rankCase, predictedYear);
        });
        folds.push({
            heldOutOffset,
            trainingCases: training.length,
            validationCases: validation.length,
            selected: {
                feature: selected.feature,
                yearCorrection: selected.yearCorrection,
            },
        });
    });
    return { metrics: rates(aggregate), folds };
};

const summarizeType = (eventType) => {
    const typedCases = enrichedCases.filter((rankCase) => rankCase.eventType === eventType);
    const currentTop = evaluatePredictor(
        typedCases.filter((rankCase) => rankCase.currentTopYear !== null),
        (rankCase) => rankCase.currentTopYear,
    );
    const features = scoreFeatures.map((feature) => ({
        feature,
        ...evaluatePredictor(typedCases, (rankCase) => (
            bestRow(rankCase, (row) => row.ranks[feature]).year
        )),
    })).sort((left, right) => (
        right.windowHit - left.windowHit
        || right.withinOne - left.withinOne
        || right.exact - left.exact
    ));
    const topKOracle = [1, 2, 3, 5].map((count) => {
        const byFeature = scoreFeatures.map((feature) => {
            let hits = 0;
            typedCases.forEach((rankCase) => {
                const tolerance = toleranceFor(rankCase.eventType);
                const peaks = selectSeparatedPeaks(
                    rankCase,
                    feature,
                    count,
                    tolerance * 2 + 1,
                );
                hits += Number(peaks.some((row) => (
                    Math.abs(row.year - rankCase.truthYear) <= tolerance
                )));
            });
            return { feature, hitRate: hits / Math.max(1, typedCases.length) };
        }).sort((left, right) => right.hitRate - left.hitRate);
        return { count, best: byFeature[0] };
    });
    return {
        cases: typedCases.length,
        currentRange: currentRangeMetrics(typedCases),
        currentTop,
        topFeatures: features.slice(0, 10),
        bestSingleFeatureCrossValidation: bestSingleFeatureCrossValidation(typedCases),
        topKOracle,
    };
};

const report = {
    sampling: "calendar-position-stratified-signal-independent",
    offsets: [...new Set(enrichedCases.map((rankCase) => rankCase.offset))].sort(),
    files: new Set(enrichedCases.map((rankCase) => rankCase.context.file)).size,
    targetCases: new Set(enrichedCases.map((rankCase) => (
        `${rankCase.offset}\u0000${rankCase.context.file}\u0000${rankCase.context.target}`
    ))).size,
    missingRing: summarizeType("missingRing"),
    falseRing: summarizeType("falseRing"),
    partialMove: summarizeType("partialMove"),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

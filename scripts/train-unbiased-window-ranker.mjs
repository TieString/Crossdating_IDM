import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length < 2) {
    throw new Error(
        "Usage: node scripts/train-unbiased-window-ranker.mjs <offset-data.json> [...]",
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
const shiftedFeatures = [
    "rawFull",
    "differenceFull",
    "whitenedFull",
    "comboFull",
    "differenceGain31",
    "differenceGain61",
    "whitenedGain31",
    "whitenedGain61",
    "pairDifferenceMean",
    "pairDifferenceTrimmed",
    "pairWhitenedMean",
    "pairDifferenceMeanGain",
    "pairWhitenedMeanGain",
    "piecewiseCombinedObjective",
    "piecewiseCofechaObjective",
    "piecewiseWhitenedObjective",
    "piecewiseDifferenceObjective",
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeWhitened",
    "cumulativeReferenceMedian",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
];
const anchorNames = [
    "currentTop",
    "profile",
    "scan",
    "rawPath",
    "candidate",
    "direct",
    "paired",
    "reference",
];
const families = {
    localized: [
        "rawFull",
        "differenceFull",
        "whitenedFull",
        "comboFull",
        "differenceGain31",
        "differenceGain61",
        "whitenedGain31",
        "whitenedGain61",
    ],
    pairwise: [
        "pairDifferenceMean",
        "pairDifferenceTrimmed",
        "pairDifferenceWeighted",
        "pairWhitenedMean",
        "pairDifferenceMeanGain",
        "pairWhitenedMeanGain",
    ],
    piecewise: [
        "piecewiseCombinedObjective",
        "piecewiseCombinedGain",
        "piecewiseCofechaObjective",
        "piecewiseWhitenedObjective",
        "piecewiseDifferenceObjective",
    ],
    cumulative: [
        "cumulativeCombined",
        "cumulativeDifference",
        "cumulativeWhitened",
        "cumulativeReferenceMedian",
        "cumulativeReferenceMean",
        "cumulativeReferenceVote",
    ],
};

const percentileRanks = (values) => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const result = new Float64Array(values.length);
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

const featureNames = [
    ...scoreFeatures.map((name) => `rank:${name}`),
    ...shiftedFeatures.flatMap((name) => (
        [-3, -2, -1, 1, 2, 3].map((delta) => `rank:${name}@${delta}`)
    )),
    ...anchorNames.flatMap((name) => [
        `anchor:${name}:near3`,
        `anchor:${name}:near8`,
        `anchor:${name}:left`,
        `anchor:${name}:right`,
    ]),
    "insideCurrentWindow",
    ...Object.keys(families).flatMap((name) => [
        `family:${name}:mean`,
        `family:${name}:max`,
        `family:${name}:top90`,
        `family:${name}:top97`,
    ]),
    "consensus:mean",
    "consensus:top90",
    "consensus:top97",
    ...shiftedFeatures.map((name) => `peak:${name}:local`),
];

const caseMap = new Map();
paths.forEach((path) => {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    if (payload.sampling !== "calendar-position-stratified-signal-independent") {
        throw new Error(`${path} was not collected with signal-independent sampling.`);
    }
    if ([13, 14, 15, 16, 17, 18, 19, 20].includes(payload.offset)) {
        throw new Error(
            "Offsets 13-20 are consumed blind evaluations.",
        );
    }
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

const mean = (values) => values.reduce((sum, value) => sum + value, 0)
    / Math.max(1, values.length);
const toleranceFor = (eventType) => eventType === "partialMove" ? 4 : 3;
const prepareCase = (rankCase) => {
    const rows = [...rankCase.rows].sort((left, right) => left.year - right.year);
    const indexByYear = new Map(rows.map((row, index) => [row.year, index]));
    const span = Math.max(1, rows[rows.length - 1].year - rows[0].year);
    const ranks = Object.fromEntries(scoreFeatures.map((name) => [
        name,
        percentileRanks(rows.map((row) => Number(row.features[name] ?? 0))),
    ]));
    const rowFeatures = rows.map((row, rowIndex) => {
        const values = [];
        scoreFeatures.forEach((name) => values.push(ranks[name][rowIndex]));
        shiftedFeatures.forEach((name) => {
            [-3, -2, -1, 1, 2, 3].forEach((delta) => {
                const otherIndex = indexByYear.get(row.year + delta);
                values.push(otherIndex === undefined ? 0.5 : ranks[name][otherIndex]);
            });
        });
        anchorNames.forEach((name) => {
            let available;
            let distance;
            let signedDistance;
            if (name === "currentTop") {
                available = rankCase.currentTopYear !== null;
                distance = available ? Math.abs(row.year - rankCase.currentTopYear) : Infinity;
                signedDistance = available ? row.year - rankCase.currentTopYear : 0;
            } else {
                available = Number(row.features[`${name}Available`] ?? 0) > 0;
                distance = available
                    ? Number(row.features[`${name}Distance`] ?? 1) * span
                    : Infinity;
                signedDistance = available
                    ? Number(row.features[`${name}SignedDistance`] ?? 0) * span
                    : 0;
            }
            values.push(available ? Math.exp(-distance / 3) : 0);
            values.push(available ? Math.exp(-distance / 8) : 0);
            values.push(available && signedDistance < 0 ? Math.exp(-distance / 8) : 0);
            values.push(available && signedDistance > 0 ? Math.exp(-distance / 8) : 0);
        });
        values.push(Number(row.features.insideCurrentWindow ?? 0));
        Object.values(families).forEach((family) => {
            const familyRanks = family.map((name) => ranks[name][rowIndex]);
            values.push(mean(familyRanks));
            values.push(Math.max(...familyRanks));
            values.push(familyRanks.filter((value) => value >= 0.9).length / familyRanks.length);
            values.push(familyRanks.filter((value) => value >= 0.97).length / familyRanks.length);
        });
        const allRanks = scoreFeatures.map((name) => ranks[name][rowIndex]);
        values.push(mean(allRanks));
        values.push(allRanks.filter((value) => value >= 0.9).length / allRanks.length);
        values.push(allRanks.filter((value) => value >= 0.97).length / allRanks.length);
        shiftedFeatures.forEach((name) => {
            const remote = [-3, -2, -1, 1, 2, 3]
                .map((delta) => indexByYear.get(row.year + delta))
                .filter((index) => index !== undefined)
                .map((index) => ranks[name][index]);
            values.push(ranks[name][rowIndex] - Math.max(0, ...remote));
        });
        return Float64Array.from(values);
    });
    if (rowFeatures[0]?.length !== featureNames.length) {
        throw new Error(`Feature count mismatch: ${rowFeatures[0]?.length} != ${featureNames.length}`);
    }
    const tolerance = toleranceFor(rankCase.eventType);
    const peakIndices = new Set();
    scoreFeatures.forEach((name) => {
        const selected = [];
        [...rows.keys()]
            .sort((left, right) => ranks[name][right] - ranks[name][left])
            .forEach((index) => {
                if (selected.length >= 3) return;
                if (selected.every((other) => (
                    Math.abs(rows[other].year - rows[index].year) > tolerance * 2 + 1
                ))) {
                    selected.push(index);
                    peakIndices.add(index);
                }
            });
    });
    if (rankCase.currentTopYear !== null && indexByYear.has(rankCase.currentTopYear)) {
        peakIndices.add(indexByYear.get(rankCase.currentTopYear));
    }
    if (rankCase.currentRange) {
        const center = Math.round((rankCase.currentRange[0] + rankCase.currentRange[1]) / 2);
        if (indexByYear.has(center)) peakIndices.add(indexByYear.get(center));
    }
    const candidateIndices = new Set();
    peakIndices.forEach((peakIndex) => {
        for (let delta = -tolerance; delta <= tolerance; delta += 1) {
            const index = indexByYear.get(rows[peakIndex].year + delta);
            if (index !== undefined) candidateIndices.add(index);
        }
    });
    return {
        ...rankCase,
        rows,
        rowFeatures,
        indexByYear,
        ranks,
        candidateIndices: [...candidateIndices],
    };
};
const cases = [...caseMap.values()].map(prepareCase);

const dot = (left, right) => {
    let result = 0;
    for (let index = 0; index < left.length; index += 1) result += left[index] * right[index];
    return result;
};
const randomFor = (seed) => {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
};
const hash = (value) => {
    let result = 2166136261;
    for (const character of value) {
        result ^= character.charCodeAt(0);
        result = Math.imul(result, 16777619);
    }
    return result >>> 0;
};
const nearestTruthIndex = (rankCase) => rankCase.rows.reduce(
    (bestIndex, row, index) => (
        Math.abs(row.year - rankCase.truthYear)
            < Math.abs(rankCase.rows[bestIndex].year - rankCase.truthYear)
            ? index
            : bestIndex
    ),
    0,
);

const hardNegativeIndices = (rankCase, seed) => {
    const tolerance = toleranceFor(rankCase.eventType);
    const selected = new Set();
    scoreFeatures.forEach((name) => {
        [...rankCase.rows.keys()]
            .sort((left, right) => rankCase.ranks[name][right] - rankCase.ranks[name][left])
            .slice(0, 4)
            .forEach((index) => selected.add(index));
    });
    const random = randomFor(seed);
    while (selected.size < Math.min(rankCase.candidateIndices.length, 120)) {
        selected.add(
            rankCase.candidateIndices[
                Math.floor(random() * rankCase.candidateIndices.length)
            ],
        );
    }
    const truthIndex = rankCase.indexByYear.get(rankCase.truthYear)
        ?? nearestTruthIndex(rankCase);
    const truthFeatures = rankCase.rowFeatures[truthIndex];
    return [...selected]
        .filter((index) => Math.abs(rankCase.rows[index].year - rankCase.truthYear) > tolerance)
        .map((index) => ({
            index,
            hardness: scoreFeatures.reduce(
                (best, name) => Math.max(best, rankCase.ranks[name][index]),
                0,
            ),
        }))
        .sort((left, right) => right.hardness - left.hardness)
        .slice(0, 64)
        .map(({ index }) => ({
            difference: Float64Array.from(
                truthFeatures,
                (value, featureIndex) => value - rankCase.rowFeatures[index][featureIndex],
            ),
            weight: 1,
        }));
};

const buildPairs = (trainingCases, seed) => trainingCases.map((rankCase, caseIndex) => {
    const pairs = hardNegativeIndices(rankCase, seed + caseIndex * 101);
    const truthIndex = rankCase.indexByYear.get(rankCase.truthYear)
        ?? nearestTruthIndex(rankCase);
    const truthFeatures = rankCase.rowFeatures[truthIndex];
    rankCase.rows.forEach((row, index) => {
        const distance = Math.abs(row.year - rankCase.truthYear);
        if (distance === 0 || distance > toleranceFor(rankCase.eventType)) return;
        pairs.push({
            difference: Float64Array.from(
                truthFeatures,
                (value, featureIndex) => value - rankCase.rowFeatures[index][featureIndex],
            ),
            weight: distance <= 1 ? 0.45 : 0.2,
        });
    });
    return pairs;
});

const fit = (trainingCases, config, seed) => {
    const weights = new Float64Array(featureNames.length);
    const firstMoment = new Float64Array(featureNames.length);
    const secondMoment = new Float64Array(featureNames.length);
    const pairsByCase = buildPairs(trainingCases, seed);
    const order = [...trainingCases.keys()];
    const random = randomFor(seed);
    let step = 0;
    for (let epoch = 0; epoch < config.epochs; epoch += 1) {
        for (let index = order.length - 1; index > 0; index -= 1) {
            const other = Math.floor(random() * (index + 1));
            [order[index], order[other]] = [order[other], order[index]];
        }
        for (const caseIndex of order) {
            const pairs = pairsByCase[caseIndex];
            for (const pair of pairs) {
                step += 1;
                const margin = Math.max(-30, Math.min(30, dot(weights, pair.difference)));
                const scale = pair.weight / (1 + Math.exp(margin));
                for (let featureIndex = 0; featureIndex < weights.length; featureIndex += 1) {
                    const gradient = -scale * pair.difference[featureIndex]
                        + config.regularization * weights[featureIndex];
                    firstMoment[featureIndex] = 0.9 * firstMoment[featureIndex] + 0.1 * gradient;
                    secondMoment[featureIndex] = 0.999 * secondMoment[featureIndex]
                        + 0.001 * gradient * gradient;
                    const correctedFirst = firstMoment[featureIndex] / (1 - (0.9 ** step));
                    const correctedSecond = secondMoment[featureIndex] / (1 - (0.999 ** step));
                    weights[featureIndex] -= config.learningRate
                        * correctedFirst
                        / (Math.sqrt(correctedSecond) + 1e-8);
                }
            }
        }
    }
    return weights;
};

const emptyMetrics = () => ({
    cases: 0,
    exact: 0,
    withinOne: 0,
    windowHit: 0,
    absoluteError: 0,
});
const addPrediction = (metrics, rankCase, year) => {
    const error = Math.abs(year - rankCase.truthYear);
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
const predict = (rankCase, weights) => {
    let bestIndex = rankCase.candidateIndices[0];
    let bestScore = -Infinity;
    rankCase.candidateIndices.forEach((index) => {
        const features = rankCase.rowFeatures[index];
        const score = dot(features, weights);
        if (score > bestScore || (score === bestScore && rankCase.rows[index].year > rankCase.rows[bestIndex].year)) {
            bestScore = score;
            bestIndex = index;
        }
    });
    return rankCase.rows[bestIndex].year;
};
const evaluate = (evaluationCases, weights) => {
    const metrics = emptyMetrics();
    evaluationCases.forEach((rankCase) => addPrediction(
        metrics,
        rankCase,
        predict(rankCase, weights),
    ));
    return rates(metrics);
};
const predictSingleFeature = (rankCase, featureIndex, direction) => {
    let bestIndex = rankCase.candidateIndices[0];
    let bestScore = -Infinity;
    rankCase.candidateIndices.forEach((index) => {
        const score = direction * rankCase.rowFeatures[index][featureIndex];
        if (score > bestScore || (score === bestScore && rankCase.rows[index].year > rankCase.rows[bestIndex].year)) {
            bestScore = score;
            bestIndex = index;
        }
    });
    return rankCase.rows[bestIndex].year;
};
const evaluateSingleFeature = (evaluationCases, featureIndex, direction) => {
    const metrics = emptyMetrics();
    evaluationCases.forEach((rankCase) => addPrediction(
        metrics,
        rankCase,
        predictSingleFeature(rankCase, featureIndex, direction),
    ));
    return rates(metrics);
};
const crossValidatedSingleFeature = (typed) => {
    const offsets = [...new Set(typed.map((rankCase) => rankCase.offset))]
        .sort((left, right) => left - right);
    const aggregate = emptyMetrics();
    const folds = [];
    offsets.forEach((heldOutOffset) => {
        const training = typed.filter((rankCase) => rankCase.offset !== heldOutOffset);
        const validation = typed.filter((rankCase) => rankCase.offset === heldOutOffset);
        const configurations = featureNames.flatMap((name, featureIndex) => (
            [-1, 1].map((direction) => ({
                name,
                featureIndex,
                direction,
                metrics: evaluateSingleFeature(training, featureIndex, direction),
            }))
        )).sort((left, right) => (
            right.metrics.windowHit - left.metrics.windowHit
            || right.metrics.withinOne - left.metrics.withinOne
            || right.metrics.exact - left.metrics.exact
            || left.metrics.meanAbsoluteError - right.metrics.meanAbsoluteError
        ));
        const selected = configurations[0];
        validation.forEach((rankCase) => addPrediction(
            aggregate,
            rankCase,
            predictSingleFeature(rankCase, selected.featureIndex, selected.direction),
        ));
        folds.push({
            heldOutOffset,
            feature: selected.name,
            direction: selected.direction,
            training: selected.metrics,
            validation: evaluateSingleFeature(
                validation,
                selected.featureIndex,
                selected.direction,
            ),
        });
    });
    return { metrics: rates(aggregate), folds };
};
const baseline = (evaluationCases) => {
    const metrics = emptyMetrics();
    evaluationCases.forEach((rankCase) => {
        const year = rankCase.currentTopYear
            ?? (rankCase.currentRange
                ? Math.round((rankCase.currentRange[0] + rankCase.currentRange[1]) / 2)
                : rankCase.rows[Math.floor(rankCase.rows.length / 2)].year);
        addPrediction(metrics, rankCase, year);
    });
    return rates(metrics);
};
const candidateOracle = (evaluationCases) => {
    const metrics = emptyMetrics();
    evaluationCases.forEach((rankCase) => {
        const closest = rankCase.candidateIndices
            .map((index) => rankCase.rows[index].year)
            .sort((left, right) => (
                Math.abs(left - rankCase.truthYear) - Math.abs(right - rankCase.truthYear)
            ))[0];
        addPrediction(metrics, rankCase, closest);
    });
    return rates(metrics);
};

const config = {
    epochs: Number(process.env.WINDOW_RANK_EPOCHS ?? 45),
    learningRate: Number(process.env.WINDOW_RANK_LEARNING_RATE ?? 0.003),
    regularization: Number(process.env.WINDOW_RANK_REGULARIZATION ?? 0.00002),
};
const runType = (eventType) => {
    const typed = cases.filter((rankCase) => rankCase.eventType === eventType);
    const offsets = [...new Set(typed.map((rankCase) => rankCase.offset))]
        .sort((left, right) => left - right);
    const crossValidated = emptyMetrics();
    const folds = [];
    offsets.forEach((heldOutOffset) => {
        const training = typed.filter((rankCase) => rankCase.offset !== heldOutOffset);
        const validation = typed.filter((rankCase) => rankCase.offset === heldOutOffset);
        const weights = fit(training, config, 1907 + heldOutOffset * 101);
        validation.forEach((rankCase) => addPrediction(
            crossValidated,
            rankCase,
            predict(rankCase, weights),
        ));
        folds.push({
            heldOutOffset,
            trainingCases: training.length,
            validation: evaluate(validation, weights),
        });
    });
    const finalWeights = fit(typed, config, 2909);
    const weightedFeatures = featureNames
        .map((name, index) => ({ name, weight: finalWeights[index] }))
        .sort((left, right) => Math.abs(right.weight) - Math.abs(left.weight));
    return {
        cases: typed.length,
        baseline: baseline(typed),
        candidateOracle: candidateOracle(typed),
        bestSingleFeature: crossValidatedSingleFeature(typed),
        leaveOneOffsetOut: rates(crossValidated),
        folds,
        fitted: evaluate(typed, finalWeights),
        topWeights: weightedFeatures.slice(0, 25),
    };
};

const report = {
    sampling: "calendar-position-stratified-signal-independent",
    config,
    featureCount: featureNames.length,
    offsets: [...new Set(cases.map((rankCase) => rankCase.offset))].sort(),
    files: new Set(cases.map((rankCase) => rankCase.context.file)).size,
    missingRing: runType("missingRing"),
    falseRing: runType("falseRing"),
    partialMove: runType("partialMove"),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

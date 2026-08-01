import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length < 2) {
    throw new Error(
        "Usage: node scripts/train-unbiased-peak-forest.mjs <offset-data.json> [...]",
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
const families = {
    exhaustive: ["rawFull", "differenceFull", "whitenedFull", "comboFull"],
    localized: [
        "differenceGain21",
        "differenceGain31",
        "differenceGain41",
        "differenceGain61",
        "whitenedGain31",
        "whitenedGain61",
    ],
    pairwise: scoreFeatures.filter((name) => name.startsWith("pair")),
    piecewise: scoreFeatures.filter((name) => name.startsWith("piecewise")),
    cumulative: scoreFeatures.filter((name) => name.startsWith("cumulative")),
};
const toleranceFor = (eventType) => eventType === "partialMove" ? 4 : 3;

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
const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) / 2)];
};
const confidenceRank = (confidence) => ({ low: 1, medium: 2, high: 3 }[confidence] ?? 0);

const featureNames = [
    ...scoreFeatures.map((name) => `rank:${name}`),
    ...scoreFeatures.map((name) => `source:${name}:top1`),
    ...scoreFeatures.map((name) => `source:${name}:top3`),
    ...Object.keys(families).flatMap((name) => [
        `family:${name}:meanRank`,
        `family:${name}:top90`,
        `family:${name}:sourceSupport`,
        `family:${name}:top1Support`,
    ]),
    "cluster:sourceSupport",
    "cluster:top1Support",
    "cluster:pointCount",
    "cluster:spread",
    "cluster:currentNear3",
    "cluster:currentNear8",
    "cluster:insideCurrentWindow",
    "cluster:currentConfidence",
    "cluster:currentScore",
    "cluster:currentMargin",
    "cluster:normalizedPosition",
    "cluster:shift",
    "cluster:absoluteShift",
];

const prepareCase = (rankCase, offset) => {
    if (!("currentShiftYears" in rankCase)) {
        throw new Error("Input predates all-shift partial-move collection.");
    }
    const tolerance = toleranceFor(rankCase.eventType);
    const ranks = Object.fromEntries(scoreFeatures.map((feature) => [
        feature,
        percentileRanks(rankCase.rows.map((row) => Number(row.features[feature] ?? 0))),
    ]));
    const shifts = rankCase.eventType === "partialMove"
        ? [...new Set(rankCase.rows.map((row) => row.shiftYears))].sort()
        : [null];
    const points = [];
    scoreFeatures.forEach((feature) => {
        shifts.forEach((shiftYears) => {
            const eligible = rankCase.rows
                .map((row, index) => ({ row, index }))
                .filter(({ row }) => (
                    rankCase.eventType !== "partialMove" || row.shiftYears === shiftYears
                ))
                .sort((left, right) => (
                    ranks[feature][right.index] - ranks[feature][left.index]
                    || right.row.year - left.row.year
                ));
            const selected = [];
            for (const item of eligible) {
                if (selected.every((other) => (
                    Math.abs(other.row.year - item.row.year) > tolerance * 2 + 1
                ))) {
                    selected.push(item);
                    points.push({
                        year: item.row.year,
                        shiftYears,
                        feature,
                        ordinal: selected.length,
                    });
                    if (selected.length >= 3) break;
                }
            }
        });
    });
    if (rankCase.currentTopYear !== null) {
        points.push({
            year: rankCase.currentTopYear,
            shiftYears: rankCase.currentShiftYears,
            feature: "current",
            ordinal: 1,
        });
    }

    const clusters = [];
    shifts.forEach((shiftYears) => {
        const shiftedPoints = points
            .filter((point) => point.shiftYears === shiftYears)
            .sort((left, right) => left.year - right.year);
        shiftedPoints.forEach((point) => {
            const matching = clusters
                .filter((cluster) => cluster.shiftYears === shiftYears)
                .map((cluster) => ({
                    cluster,
                    distance: Math.abs(median(cluster.points.map((row) => row.year)) - point.year),
                }))
                .filter(({ distance }) => distance <= tolerance)
                .sort((left, right) => left.distance - right.distance)[0]?.cluster;
            if (matching) matching.points.push(point);
            else clusters.push({ shiftYears, points: [point] });
        });
    });

    const startYear = Math.min(...rankCase.rows.map((row) => row.year));
    const endYear = Math.max(...rankCase.rows.map((row) => row.year));
    const span = Math.max(1, endYear - startYear);
    const rows = clusters.map((cluster) => {
        const year = median(cluster.points.map((point) => point.year));
        const nearbyIndices = rankCase.rows
            .map((row, index) => ({ row, index }))
            .filter(({ row }) => (
                (rankCase.eventType !== "partialMove" || row.shiftYears === cluster.shiftYears)
                && Math.abs(row.year - year) <= tolerance
            ))
            .map(({ index }) => index);
        const rankFor = (feature) => Math.max(
            0,
            ...nearbyIndices.map((index) => ranks[feature][index]),
        );
        const sourceFeatures = new Set(cluster.points
            .filter((point) => point.feature !== "current")
            .map((point) => point.feature));
        const top1Features = new Set(cluster.points
            .filter((point) => point.feature !== "current" && point.ordinal === 1)
            .map((point) => point.feature));
        const values = [];
        scoreFeatures.forEach((feature) => values.push(rankFor(feature)));
        scoreFeatures.forEach((feature) => values.push(Number(
            top1Features.has(feature),
        )));
        scoreFeatures.forEach((feature) => values.push(Number(
            sourceFeatures.has(feature),
        )));
        Object.values(families).forEach((family) => {
            const familyRanks = family.map(rankFor);
            values.push(familyRanks.reduce((sum, value) => sum + value, 0) / family.length);
            values.push(familyRanks.filter((value) => value >= 0.9).length / family.length);
            values.push(family.filter((feature) => sourceFeatures.has(feature)).length / family.length);
            values.push(family.filter((feature) => top1Features.has(feature)).length / family.length);
        });
        const distinctYears = cluster.points.map((point) => point.year);
        const currentDistance = rankCase.currentTopYear === null
            ? Infinity
            : Math.abs(year - rankCase.currentTopYear);
        values.push(sourceFeatures.size / scoreFeatures.length);
        values.push(top1Features.size / scoreFeatures.length);
        values.push(cluster.points.length / scoreFeatures.length);
        values.push((Math.max(...distinctYears) - Math.min(...distinctYears)) / (tolerance * 2));
        values.push(Number.isFinite(currentDistance) ? Math.exp(-currentDistance / 3) : 0);
        values.push(Number.isFinite(currentDistance) ? Math.exp(-currentDistance / 8) : 0);
        values.push(rankCase.currentRange
            && year >= rankCase.currentRange[0]
            && year <= rankCase.currentRange[1]
            ? 1
            : 0);
        values.push(confidenceRank(rankCase.currentConfidence) / 3);
        values.push(Math.tanh((rankCase.currentScore ?? 0) / 20));
        values.push(Math.tanh((rankCase.currentMargin ?? 0) / 5));
        values.push((year - startYear) / span);
        values.push((cluster.shiftYears ?? 0) / 3);
        values.push(Math.abs(cluster.shiftYears ?? 0) / 3);
        if (values.length !== featureNames.length) {
            throw new Error(`Feature count mismatch: ${values.length} != ${featureNames.length}`);
        }
        return {
            year,
            shiftYears: cluster.shiftYears,
            features: Float64Array.from(values),
        };
    });
    return { ...rankCase, offset, rows };
};

const caseMap = new Map();
paths.forEach((path) => {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    if (payload.sampling !== "calendar-position-stratified-signal-independent") {
        throw new Error(`${path} was not collected with signal-independent sampling.`);
    }
    if ([13, 14, 15, 16, 17, 18, 19, 20].includes(payload.offset)) {
        throw new Error("Offsets 13-20 are consumed blind evaluations.");
    }
    payload.cases.forEach((rankCase) => {
        const key = [
            payload.offset,
            rankCase.context.file,
            rankCase.context.target,
            rankCase.eventType,
        ].join("\u0000");
        if (!caseMap.has(key)) caseMap.set(key, prepareCase(rankCase, payload.offset));
    });
});
const cases = [...caseMap.values()];

const makeRandom = (seed) => {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
};
const impurity = (positive, negative) => {
    const total = positive + negative;
    if (total <= 0) return 0;
    const rate = positive / total;
    return total * 2 * rate * (1 - rate);
};
const leaf = (rows) => {
    const positive = rows.reduce((sum, row) => sum + (row.label ? row.weight : 0), 0);
    const negative = rows.reduce((sum, row) => sum + (row.label ? 0 : row.weight), 0);
    return { probability: (positive + 0.5) / (positive + negative + 1) };
};
const featureSubset = (count, selected, random) => {
    const indices = Array.from({ length: count }, (_, index) => index);
    for (let index = indices.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [indices[index], indices[other]] = [indices[other], indices[index]];
    }
    return indices.slice(0, selected);
};
const buildTree = (rows, depth, config, random, importance) => {
    const positiveRows = rows.filter((row) => row.label).length;
    if (depth >= config.maxDepth
        || rows.length < config.minRows * 2
        || positiveRows === 0
        || positiveRows === rows.length) {
        return leaf(rows);
    }
    let best = null;
    featureSubset(featureNames.length, config.featuresPerSplit, random)
        .forEach((featureIndex) => {
            const ordered = [...rows].sort(
                (left, right) => left.features[featureIndex] - right.features[featureIndex],
            );
            let leftPositive = 0;
            let leftNegative = 0;
            let rightPositive = ordered.reduce(
                (sum, row) => sum + (row.label ? row.weight : 0),
                0,
            );
            let rightNegative = ordered.reduce(
                (sum, row) => sum + (row.label ? 0 : row.weight),
                0,
            );
            const parent = impurity(rightPositive, rightNegative);
            for (let index = 0; index < ordered.length - 1; index += 1) {
                const row = ordered[index];
                if (row.label) {
                    leftPositive += row.weight;
                    rightPositive -= row.weight;
                } else {
                    leftNegative += row.weight;
                    rightNegative -= row.weight;
                }
                if (index + 1 < config.minRows
                    || ordered.length - index - 1 < config.minRows
                    || ordered[index].features[featureIndex]
                        === ordered[index + 1].features[featureIndex]) {
                    continue;
                }
                const gain = parent
                    - impurity(leftPositive, leftNegative)
                    - impurity(rightPositive, rightNegative);
                if (!best || gain > best.gain) {
                    best = {
                        featureIndex,
                        threshold: (
                            ordered[index].features[featureIndex]
                            + ordered[index + 1].features[featureIndex]
                        ) / 2,
                        gain,
                    };
                }
            }
        });
    if (!best || best.gain <= 1e-9) return leaf(rows);
    const leftRows = rows.filter(
        (row) => row.features[best.featureIndex] <= best.threshold,
    );
    const rightRows = rows.filter(
        (row) => row.features[best.featureIndex] > best.threshold,
    );
    if (leftRows.length < config.minRows || rightRows.length < config.minRows) {
        return leaf(rows);
    }
    importance[best.featureIndex] = (importance[best.featureIndex] ?? 0) + best.gain;
    return {
        featureIndex: best.featureIndex,
        threshold: best.threshold,
        left: buildTree(leftRows, depth + 1, config, random, importance),
        right: buildTree(rightRows, depth + 1, config, random, importance),
    };
};
const predictTree = (tree, features) => {
    if ("probability" in tree) return tree.probability;
    return predictTree(
        features[tree.featureIndex] <= tree.threshold ? tree.left : tree.right,
        features,
    );
};
const trainForest = (trainingCases, config, seed) => {
    const random = makeRandom(seed);
    const trees = [];
    const importance = [];
    for (let treeIndex = 0; treeIndex < config.trees; treeIndex += 1) {
        const rows = [];
        for (let caseIndex = 0; caseIndex < trainingCases.length; caseIndex += 1) {
            const rankCase = trainingCases[Math.floor(random() * trainingCases.length)];
            const tolerance = toleranceFor(rankCase.eventType);
            rankCase.rows.forEach((row) => {
                const label = Math.abs(row.year - rankCase.truthYear) <= tolerance
                    && (
                        rankCase.eventType !== "partialMove"
                        || row.shiftYears === rankCase.truthShiftYears
                    );
                rows.push({
                    features: row.features,
                    label,
                    weight: label ? config.positiveWeight : 1,
                });
            });
        }
        trees.push(buildTree(rows, 0, config, random, importance));
    }
    return { trees, importance };
};
const predictForest = (forest, features) => forest.trees.reduce(
    (sum, tree) => sum + predictTree(tree, features),
    0,
) / forest.trees.length;

const emptyMetrics = () => ({
    cases: 0,
    windowHits: 0,
    strictHits: 0,
    exact: 0,
    withinOne: 0,
    correctShift: 0,
});
const addPrediction = (metrics, rankCase, row) => {
    const distance = Math.abs(row.year - rankCase.truthYear);
    const windowHit = distance <= toleranceFor(rankCase.eventType);
    const shiftCorrect = rankCase.eventType !== "partialMove"
        || row.shiftYears === rankCase.truthShiftYears;
    metrics.cases += 1;
    metrics.windowHits += Number(windowHit);
    metrics.strictHits += Number(windowHit && shiftCorrect);
    metrics.exact += Number(distance === 0);
    metrics.withinOne += Number(distance <= 1);
    metrics.correctShift += Number(shiftCorrect);
};
const rates = (metrics) => ({
    cases: metrics.cases,
    windowHit: metrics.windowHits / Math.max(1, metrics.cases),
    strictWindowHit: metrics.strictHits / Math.max(1, metrics.cases),
    exact: metrics.exact / Math.max(1, metrics.cases),
    withinOne: metrics.withinOne / Math.max(1, metrics.cases),
    correctShift: metrics.correctShift / Math.max(1, metrics.cases),
});
const rankedRows = (rankCase, forest) => rankCase.rows
    .map((row) => ({ row, score: predictForest(forest, row.features) }))
    .sort((left, right) => right.score - left.score || right.row.year - left.row.year);
const evaluate = (evaluationCases, forest, count = 1) => {
    const metrics = emptyMetrics();
    evaluationCases.forEach((rankCase) => {
        const ranked = rankedRows(rankCase, forest).slice(0, count);
        const best = [...ranked].sort((left, right) => {
            const leftStrict = (
                Math.abs(left.row.year - rankCase.truthYear) <= toleranceFor(rankCase.eventType)
                && (
                    rankCase.eventType !== "partialMove"
                    || left.row.shiftYears === rankCase.truthShiftYears
                )
            );
            const rightStrict = (
                Math.abs(right.row.year - rankCase.truthYear) <= toleranceFor(rankCase.eventType)
                && (
                    rankCase.eventType !== "partialMove"
                    || right.row.shiftYears === rankCase.truthShiftYears
                )
            );
            return Number(rightStrict) - Number(leftStrict);
        })[0];
        addPrediction(metrics, rankCase, best.row);
    });
    return rates(metrics);
};
const oracle = (evaluationCases) => {
    const metrics = emptyMetrics();
    evaluationCases.forEach((rankCase) => {
        const best = [...rankCase.rows].sort((left, right) => {
            const leftShift = rankCase.eventType === "partialMove"
                && left.shiftYears !== rankCase.truthShiftYears ? 1000 : 0;
            const rightShift = rankCase.eventType === "partialMove"
                && right.shiftYears !== rankCase.truthShiftYears ? 1000 : 0;
            return leftShift + Math.abs(left.year - rankCase.truthYear)
                - rightShift - Math.abs(right.year - rankCase.truthYear);
        })[0];
        addPrediction(metrics, rankCase, best);
    });
    return rates(metrics);
};

const config = {
    trees: Number(process.env.PEAK_FOREST_TREES ?? 101),
    maxDepth: Number(process.env.PEAK_FOREST_DEPTH ?? 4),
    minRows: Number(process.env.PEAK_FOREST_MIN_ROWS ?? 8),
    positiveWeight: Number(process.env.PEAK_FOREST_POSITIVE_WEIGHT ?? 4),
    featuresPerSplit: Math.max(10, Math.round(Math.sqrt(featureNames.length) * 1.5)),
};
const runType = (eventType) => {
    const typed = cases.filter((rankCase) => rankCase.eventType === eventType);
    const offsets = [...new Set(typed.map((rankCase) => rankCase.offset))].sort();
    const aggregate = { top1: emptyMetrics(), top2: emptyMetrics(), top3: emptyMetrics() };
    const folds = [];
    offsets.forEach((heldOutOffset) => {
        const training = typed.filter((rankCase) => rankCase.offset !== heldOutOffset);
        const validation = typed.filter((rankCase) => rankCase.offset === heldOutOffset);
        const forest = trainForest(training, config, 4001 + heldOutOffset * 101);
        const fold = {
            heldOutOffset,
            top1: evaluate(validation, forest, 1),
            top2: evaluate(validation, forest, 2),
            top3: evaluate(validation, forest, 3),
        };
        validation.forEach((rankCase) => {
            const ranked = rankedRows(rankCase, forest);
            [1, 2, 3].forEach((count) => {
                const candidates = ranked.slice(0, count);
                const strict = candidates.find(({ row }) => (
                    Math.abs(row.year - rankCase.truthYear) <= toleranceFor(rankCase.eventType)
                    && (
                        rankCase.eventType !== "partialMove"
                        || row.shiftYears === rankCase.truthShiftYears
                    )
                ));
                addPrediction(
                    aggregate[`top${count}`],
                    rankCase,
                    strict?.row ?? candidates[0].row,
                );
            });
        });
        folds.push(fold);
    });
    const finalForest = trainForest(typed, config, 5003);
    const importance = finalForest.importance
        .map((value, index) => ({ name: featureNames[index], value: value ?? 0 }))
        .sort((left, right) => right.value - left.value);
    return {
        cases: typed.length,
        meanCandidates: typed.reduce((sum, rankCase) => sum + rankCase.rows.length, 0)
            / typed.length,
        oracle: oracle(typed),
        top1: rates(aggregate.top1),
        top2: rates(aggregate.top2),
        top3: rates(aggregate.top3),
        folds,
        fitted: evaluate(typed, finalForest),
        importance: importance.slice(0, 20),
    };
};

const report = {
    sampling: "calendar-position-stratified-signal-independent",
    config,
    featureCount: featureNames.length,
    offsets: [...new Set(cases.map((rankCase) => rankCase.offset))].sort(),
    missingRing: runType("missingRing"),
    falseRing: runType("falseRing"),
    partialMove: runType("partialMove"),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

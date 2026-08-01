import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length < 2) {
    throw new Error(
        "Usage: node scripts/train-unbiased-residual-forest.mjs <residual-data.json> [...]",
    );
}

const scanFeatures = [
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
        if (!rankCase.residualRows?.length) return;
        const key = [
            payload.offset,
            rankCase.context.file,
            rankCase.context.target,
            rankCase.eventType,
        ].join("\u0000");
        if (!caseMap.has(key)) caseMap.set(key, { ...rankCase, offset: payload.offset });
    });
});

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
const standardized = (values) => {
    const average = values.reduce((sum, value) => sum + value, 0)
        / Math.max(1, values.length);
    const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0)
        / Math.max(1, values.length);
    const scale = Math.sqrt(variance) || 1;
    return Float64Array.from(values, (value) => (
        Math.max(-4, Math.min(4, (value - average) / scale))
    ));
};

const firstCase = [...caseMap.values()][0];
if (!firstCase) throw new Error("No residual rank cases were found.");
const residualFeatures = Object.keys(firstCase.residualRows[0].features);
const featureNames = [
    ...residualFeatures.flatMap((name) => [`residual:${name}:rank`, `residual:${name}:z`]),
    ...scanFeatures.map((name) => `scan:${name}:rank`),
    "scan:meanRank",
    "scan:maxRank",
    "scan:top90",
    "scan:top97",
    "current:near3",
    "current:near8",
    "current:insideWindow",
    "candidate:normalizedPosition",
];

const prepareCase = (rankCase) => {
    const residualRanks = {};
    const residualZ = {};
    residualFeatures.forEach((name) => {
        const values = rankCase.residualRows.map((row) => Number(row.features[name] ?? 0));
        residualRanks[name] = percentileRanks(values);
        residualZ[name] = standardized(values);
    });
    const scanRanks = {};
    scanFeatures.forEach((name) => {
        scanRanks[name] = percentileRanks(
            rankCase.rows.map((row) => Number(row.features[name] ?? 0)),
        );
    });
    const scanIndexByYear = new Map(rankCase.rows.map((row, index) => [row.year, index]));
    const startYear = rankCase.rows[0].year;
    const endYear = rankCase.rows[rankCase.rows.length - 1].year;
    const span = Math.max(1, endYear - startYear);
    const rows = rankCase.residualRows.map((row, residualIndex) => {
        const scanIndex = scanIndexByYear.get(row.year)
            ?? rankCase.rows.reduce((best, scanRow, index) => (
                Math.abs(scanRow.year - row.year) < Math.abs(rankCase.rows[best].year - row.year)
                    ? index
                    : best
            ), 0);
        const values = [];
        residualFeatures.forEach((name) => {
            values.push(residualRanks[name][residualIndex]);
            values.push(residualZ[name][residualIndex]);
        });
        const rankedScan = scanFeatures.map((name) => scanRanks[name][scanIndex]);
        values.push(...rankedScan);
        values.push(rankedScan.reduce((sum, value) => sum + value, 0) / rankedScan.length);
        values.push(Math.max(...rankedScan));
        values.push(rankedScan.filter((value) => value >= 0.9).length / rankedScan.length);
        values.push(rankedScan.filter((value) => value >= 0.97).length / rankedScan.length);
        const currentDistance = rankCase.currentTopYear === null
            ? Infinity
            : Math.abs(row.year - rankCase.currentTopYear);
        values.push(Number.isFinite(currentDistance) ? Math.exp(-currentDistance / 3) : 0);
        values.push(Number.isFinite(currentDistance) ? Math.exp(-currentDistance / 8) : 0);
        values.push(rankCase.currentRange
            && row.year >= rankCase.currentRange[0]
            && row.year <= rankCase.currentRange[1]
            ? 1
            : 0);
        values.push((row.year - startYear) / span);
        return {
            year: row.year,
            features: Float64Array.from(values),
        };
    });
    if (rows[0].features.length !== featureNames.length) {
        throw new Error(`Feature count mismatch: ${rows[0].features.length} != ${featureNames.length}`);
    }
    return { ...rankCase, rows };
};
const cases = [...caseMap.values()].map(prepareCase);

const toleranceFor = (eventType) => eventType === "partialMove" ? 4 : 3;
const makeRandom = (seed) => {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 0x100000000;
    };
};
const weightedLeaf = (rows) => {
    const positive = rows.reduce((sum, row) => sum + (row.label ? row.weight : 0), 0);
    const negative = rows.reduce((sum, row) => sum + (row.label ? 0 : row.weight), 0);
    return { probability: (positive + 0.5) / (positive + negative + 1) };
};
const impurity = (positive, negative) => {
    const total = positive + negative;
    if (total <= 0) return 0;
    const rate = positive / total;
    return total * 2 * rate * (1 - rate);
};
const shuffledSubset = (count, selected, random) => {
    const indices = Array.from({ length: count }, (_, index) => index);
    for (let index = indices.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [indices[index], indices[other]] = [indices[other], indices[index]];
    }
    return indices.slice(0, selected);
};
const buildTree = (rows, depth, config, random, importance) => {
    const positives = rows.filter((row) => row.label).length;
    if (depth >= config.maxDepth
        || rows.length < config.minRows * 2
        || positives === 0
        || positives === rows.length) {
        return weightedLeaf(rows);
    }
    const featureIndices = shuffledSubset(
        featureNames.length,
        config.featuresPerSplit,
        random,
    );
    let best = null;
    featureIndices.forEach((featureIndex) => {
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
    if (!best || best.gain <= 1e-9) return weightedLeaf(rows);
    const leftRows = rows.filter(
        (row) => row.features[best.featureIndex] <= best.threshold,
    );
    const rightRows = rows.filter(
        (row) => row.features[best.featureIndex] > best.threshold,
    );
    if (leftRows.length < config.minRows || rightRows.length < config.minRows) {
        return weightedLeaf(rows);
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
        for (let index = 0; index < trainingCases.length; index += 1) {
            const rankCase = trainingCases[Math.floor(random() * trainingCases.length)];
            const tolerance = toleranceFor(rankCase.eventType);
            rankCase.rows.forEach((row) => {
                const label = Math.abs(row.year - rankCase.truthYear) <= tolerance;
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
    hits: 0,
    exact: 0,
    withinOne: 0,
    absoluteError: 0,
});
const addPrediction = (metrics, rankCase, year) => {
    const error = Math.abs(year - rankCase.truthYear);
    metrics.cases += 1;
    metrics.hits += Number(error <= toleranceFor(rankCase.eventType));
    metrics.exact += Number(error === 0);
    metrics.withinOne += Number(error <= 1);
    metrics.absoluteError += error;
};
const rates = (metrics) => ({
    cases: metrics.cases,
    windowHit: metrics.hits / Math.max(1, metrics.cases),
    exact: metrics.exact / Math.max(1, metrics.cases),
    withinOne: metrics.withinOne / Math.max(1, metrics.cases),
    meanAbsoluteError: metrics.absoluteError / Math.max(1, metrics.cases),
});
const evaluate = (evaluationCases, forest) => {
    const metrics = emptyMetrics();
    evaluationCases.forEach((rankCase) => {
        const best = [...rankCase.rows]
            .map((row) => ({ row, score: predictForest(forest, row.features) }))
            .sort((left, right) => right.score - left.score || right.row.year - left.row.year)[0];
        addPrediction(metrics, rankCase, best.row.year);
    });
    return rates(metrics);
};
const oracle = (evaluationCases) => {
    const metrics = emptyMetrics();
    evaluationCases.forEach((rankCase) => {
        const best = [...rankCase.rows].sort((left, right) => (
            Math.abs(left.year - rankCase.truthYear) - Math.abs(right.year - rankCase.truthYear)
        ))[0];
        addPrediction(metrics, rankCase, best.year);
    });
    return rates(metrics);
};

const config = {
    trees: Number(process.env.RESIDUAL_FOREST_TREES ?? 81),
    maxDepth: Number(process.env.RESIDUAL_FOREST_DEPTH ?? 4),
    minRows: Number(process.env.RESIDUAL_FOREST_MIN_ROWS ?? 12),
    positiveWeight: Number(process.env.RESIDUAL_FOREST_POSITIVE_WEIGHT ?? 3),
    featuresPerSplit: Math.max(8, Math.round(Math.sqrt(featureNames.length) * 1.5)),
};
const runType = (eventType) => {
    const typed = cases.filter((rankCase) => rankCase.eventType === eventType);
    const offsets = [...new Set(typed.map((rankCase) => rankCase.offset))].sort();
    const aggregate = emptyMetrics();
    const folds = [];
    offsets.forEach((heldOutOffset) => {
        const training = typed.filter((rankCase) => rankCase.offset !== heldOutOffset);
        const validation = typed.filter((rankCase) => rankCase.offset === heldOutOffset);
        const forest = trainForest(training, config, 2309 + heldOutOffset * 101);
        const metrics = evaluate(validation, forest);
        validation.forEach((rankCase) => {
            const best = [...rankCase.rows]
                .map((row) => ({ row, score: predictForest(forest, row.features) }))
                .sort((left, right) => right.score - left.score || right.row.year - left.row.year)[0];
            addPrediction(aggregate, rankCase, best.row.year);
        });
        folds.push({ heldOutOffset, ...metrics });
    });
    const finalForest = trainForest(typed, config, 3301);
    const importance = finalForest.importance
        .map((value, index) => ({ name: featureNames[index], value: value ?? 0 }))
        .sort((left, right) => right.value - left.value);
    return {
        cases: typed.length,
        oracle: oracle(typed),
        leaveOneOffsetOut: rates(aggregate),
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
    files: new Set(cases.map((rankCase) => rankCase.context.file)).size,
    missingRing: runType("missingRing"),
    falseRing: runType("falseRing"),
    partialMove: runType("partialMove"),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

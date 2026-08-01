import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length < 2) {
    throw new Error(
        "Usage: node scripts/train-unbiased-exact-year-forest.mjs <offset-data.json> [...]",
    );
}

const matchedWindowAuditPattern =
    process.env.EXACT_MATCHED_WINDOW_AUDIT_PATTERN ?? null;
const eventTypes = process.env.EXACT_EVENT_TYPE
    ? [process.env.EXACT_EVENT_TYPE]
    : ["missingRing", "falseRing", "partialMove"];
const validEventTypes = new Set(["missingRing", "falseRing", "partialMove"]);
eventTypes.forEach((eventType) => {
    if (!validEventTypes.has(eventType)) {
        throw new Error(`Unsupported EXACT_EVENT_TYPE: ${eventType}`);
    }
});

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

const neighborhoodFeatures = [
    "rawFull",
    "differenceFull",
    "whitenedFull",
    "comboFull",
    "pairDifferenceMean",
    "pairDifferenceTrimmed",
    "pairDifferenceWeighted",
    "piecewiseCombinedObjective",
    "piecewiseCofechaObjective",
    "piecewiseDifferenceObjective",
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeWhitened",
    "cumulativeReferenceMedian",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
];

const percentileRanks = (values) => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const result = new Float32Array(values.length);
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

const confidenceRank = (confidence) => ({ low: 1, medium: 2, high: 3 }[confidence] ?? 0);
const keyFor = (year, shiftYears) => `${year}:${shiftYears ?? 0}`;
const toleranceFor = (eventType) => eventType === "partialMove" ? 4 : 3;

const featureNames = [
    ...scoreFeatures.map((name) => `rank:${name}`),
    ...neighborhoodFeatures.flatMap((name) => [
        `neighbor:${name}:minus2`,
        `neighbor:${name}:minus1`,
        `neighbor:${name}:plus1`,
        `neighbor:${name}:plus2`,
        `shape:${name}:left`,
        `shape:${name}:right`,
        `shape:${name}:curvature`,
    ]),
    "support:rank99",
    "support:rank98",
    "support:rank95",
    "support:localMaximum",
    "support:topPeakExact",
    "support:topPeakNear1",
    "support:topPeakNear3",
    "current:available",
    "current:exact",
    "current:near1",
    "current:near3",
    "current:near8",
    "current:signedDistance",
    "current:insideWindow",
    "current:confidence",
    "current:score",
    "current:margin",
    "calendar:normalizedPosition",
    "calendar:edgeDistance",
    "shift:value",
    "shift:absolute",
];

const selectPeakRows = (rows, ranks, feature, shiftYears, count, exclusionYears) => {
    const ordered = rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => row.shiftYears === shiftYears)
        .sort((left, right) => (
            ranks[feature][right.index] - ranks[feature][left.index]
            || right.row.year - left.row.year
        ));
    const selected = [];
    for (const item of ordered) {
        if (selected.every((other) => Math.abs(other.row.year - item.row.year) > exclusionYears)) {
            selected.push(item);
            if (selected.length >= count) break;
        }
    }
    return selected;
};

const prepareCase = (rankCase, offset) => {
    if (!("currentShiftYears" in rankCase)) {
        throw new Error("Input predates all-shift partial-move collection.");
    }
    const rows = rankCase.rows.map((row) => ({
        ...row,
        shiftYears: row.shiftYears ?? 0,
    }));
    const ranks = Object.fromEntries(scoreFeatures.map((feature) => [
        feature,
        percentileRanks(rows.map((row) => Number(row.features[feature] ?? 0))),
    ]));
    const rowIndex = new Map(rows.map((row, index) => [
        keyFor(row.year, row.shiftYears),
        index,
    ]));
    const shifts = [...new Set(rows.map((row) => row.shiftYears))].sort((a, b) => a - b);
    const candidateKeys = new Set();
    const poolRadius = rankCase.eventType === "partialMove" ? 5 : 4;
    const addNeighborhood = (year, shiftYears, radius = poolRadius) => {
        for (let candidateYear = year - radius; candidateYear <= year + radius; candidateYear += 1) {
            const key = keyFor(candidateYear, shiftYears);
            if (rowIndex.has(key)) candidateKeys.add(key);
        }
    };

    scoreFeatures.forEach((feature) => {
        shifts.forEach((shiftYears) => {
            selectPeakRows(rows, ranks, feature, shiftYears, 4, poolRadius * 2 + 1)
                .forEach(({ row }) => addNeighborhood(row.year, shiftYears));
        });
    });
    if (rankCase.currentTopYear !== null) {
        addNeighborhood(
            rankCase.currentTopYear,
            rankCase.currentShiftYears ?? 0,
            poolRadius + 2,
        );
    }
    if (rankCase.currentRange) {
        const currentShift = rankCase.currentShiftYears ?? 0;
        for (
            let year = rankCase.currentRange[0] - 2;
            year <= rankCase.currentRange[1] + 2;
            year += 1
        ) {
            const key = keyFor(year, currentShift);
            if (rowIndex.has(key)) candidateKeys.add(key);
        }
    }

    const topPeaks = Object.fromEntries(scoreFeatures.map((feature) => [
        feature,
        Object.fromEntries(shifts.map((shiftYears) => [
            shiftYears,
            selectPeakRows(rows, ranks, feature, shiftYears, 3, poolRadius * 2 + 1)
                .map(({ row }) => row.year),
        ])),
    ]));
    const startYear = Math.min(...rows.map((row) => row.year));
    const endYear = Math.max(...rows.map((row) => row.year));
    const span = Math.max(1, endYear - startYear);

    const candidates = [...candidateKeys]
        .map((key) => rows[rowIndex.get(key)])
        .filter((row) => (
            !rankCase.restrictRange
            || (
                row.year >= rankCase.restrictRange[0]
                && row.year <= rankCase.restrictRange[1]
                && row.shiftYears === rankCase.restrictShiftYears
            )
        ))
        .map((row) => {
            const rankFor = (feature, deltaYears = 0) => {
                const neighborIndex = rowIndex.get(keyFor(
                    row.year + deltaYears,
                    row.shiftYears,
                ));
                return neighborIndex === undefined ? 0 : ranks[feature][neighborIndex];
            };
            const values = [];
            scoreFeatures.forEach((feature) => values.push(rankFor(feature)));
            neighborhoodFeatures.forEach((feature) => {
                const center = rankFor(feature);
                const minus2 = rankFor(feature, -2);
                const minus1 = rankFor(feature, -1);
                const plus1 = rankFor(feature, 1);
                const plus2 = rankFor(feature, 2);
                values.push(
                    minus2,
                    minus1,
                    plus1,
                    plus2,
                    center - minus1,
                    center - plus1,
                    center * 2 - minus1 - plus1,
                );
            });
            const centerRanks = scoreFeatures.map((feature) => rankFor(feature));
            values.push(
                centerRanks.filter((value) => value >= 0.99).length / scoreFeatures.length,
                centerRanks.filter((value) => value >= 0.98).length / scoreFeatures.length,
                centerRanks.filter((value) => value >= 0.95).length / scoreFeatures.length,
                neighborhoodFeatures.filter((feature) => (
                    rankFor(feature) >= rankFor(feature, -1)
                    && rankFor(feature) >= rankFor(feature, 1)
                )).length / neighborhoodFeatures.length,
            );
            const peakDistances = scoreFeatures.flatMap((feature) => (
                topPeaks[feature][row.shiftYears].map((year) => Math.abs(year - row.year))
            ));
            values.push(
                peakDistances.filter((distance) => distance === 0).length
                    / (scoreFeatures.length * 3),
                peakDistances.filter((distance) => distance <= 1).length
                    / (scoreFeatures.length * 3),
                peakDistances.filter((distance) => distance <= 3).length
                    / (scoreFeatures.length * 3),
            );
            const currentAvailable = rankCase.currentTopYear !== null
                && (rankCase.currentShiftYears ?? 0) === row.shiftYears;
            const currentDistance = currentAvailable
                ? row.year - rankCase.currentTopYear
                : 999;
            values.push(
                Number(currentAvailable),
                Number(currentDistance === 0),
                currentAvailable ? Math.exp(-Math.abs(currentDistance)) : 0,
                currentAvailable ? Math.exp(-Math.abs(currentDistance) / 3) : 0,
                currentAvailable ? Math.exp(-Math.abs(currentDistance) / 8) : 0,
                currentAvailable ? Math.tanh(currentDistance / 8) : 0,
                Number(currentAvailable
                    && rankCase.currentRange
                    && row.year >= rankCase.currentRange[0]
                    && row.year <= rankCase.currentRange[1]),
                confidenceRank(rankCase.currentConfidence) / 3,
                Math.tanh((rankCase.currentScore ?? 0) / 20),
                Math.tanh((rankCase.currentMargin ?? 0) / 5),
                (row.year - startYear) / span,
                Math.min(row.year - startYear, endYear - row.year) / span,
                row.shiftYears / 3,
                Math.abs(row.shiftYears) / 3,
            );
            if (values.length !== featureNames.length) {
                throw new Error(`Feature count mismatch: ${values.length} != ${featureNames.length}`);
            }
            const meanRank = centerRanks.reduce((sum, value) => sum + value, 0)
                / centerRanks.length;
            return {
                year: row.year,
                shiftYears: row.shiftYears,
                features: Float32Array.from(values),
                heuristic: meanRank
                    + (currentAvailable ? Math.exp(-Math.abs(currentDistance) / 4) * 0.2 : 0),
            };
        });

    return {
        groupId: rankCase.groupId,
        eventType: rankCase.eventType,
        truthYear: rankCase.truthYear,
        truthShiftYears: rankCase.truthShiftYears ?? 0,
        currentTopYear: rankCase.currentTopYear,
        currentShiftYears: rankCase.currentShiftYears ?? 0,
        context: rankCase.context,
        offset,
        candidates,
    };
};

const cases = [];
let excludedEmptyCandidateCases = 0;
const appendPreparedCase = (rankCase, offset) => {
    const prepared = prepareCase(rankCase, offset);
    if (prepared.candidates.length === 0) {
        excludedEmptyCandidateCases += 1;
        return;
    }
    cases.push(prepared);
};
paths.forEach((path) => {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    if (payload.sampling !== "calendar-position-stratified-signal-independent") {
        throw new Error(`${path} was not collected with signal-independent sampling.`);
    }
    if ([13, 14, 15, 16, 17, 18, 19, 20].includes(payload.offset)) {
        throw new Error("Offsets 13-20 are consumed blind evaluations.");
    }
    const matchedByKey = matchedWindowAuditPattern
        ? new Map(
            JSON.parse(readFileSync(
                matchedWindowAuditPattern.replace("{offset}", String(payload.offset)),
                "utf8",
            )).rankingCases.map((rankCase) => [[
                rankCase.groupId,
                rankCase.seriesId,
                rankCase.eventType,
            ].join("\u0000"), rankCase]),
        )
        : null;
    payload.cases
        .filter((rankCase) => eventTypes.includes(rankCase.eventType))
        .forEach((rankCase) => {
            if (!matchedByKey) {
                appendPreparedCase(rankCase, payload.offset);
                return;
            }
            const matched = matchedByKey.get([
                rankCase.context.file,
                rankCase.context.target,
                rankCase.eventType,
            ].join("\u0000"));
            if (!matched?.matchedLocationRange || !matched.matchedLocationRankedYears?.length) {
                return;
            }
            const restrictShiftYears = rankCase.eventType === "partialMove"
                ? rankCase.truthShiftYears
                : 0;
            appendPreparedCase({
                ...rankCase,
                currentRange: matched.matchedLocationRange,
                currentTopYear: matched.matchedLocationRankedYears[0].year,
                currentShiftYears: restrictShiftYears,
                restrictRange: matched.matchedLocationRange,
                restrictShiftYears,
            }, payload.offset);
        });
});

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

const candidateThresholds = (rows, featureIndex, count, random) => {
    const thresholds = new Set();
    for (let index = 0; index < count * 2 && thresholds.size < count; index += 1) {
        const left = rows[Math.floor(random() * rows.length)].features[featureIndex];
        const right = rows[Math.floor(random() * rows.length)].features[featureIndex];
        if (left !== right) thresholds.add((left + right) / 2);
    }
    return [...thresholds];
};

const buildTree = (rows, depth, config, random, importance) => {
    const positiveRows = rows.filter((row) => row.label).length;
    if (depth >= config.maxDepth
        || rows.length < config.minRows * 2
        || positiveRows === 0
        || positiveRows === rows.length) {
        return leaf(rows);
    }
    const parentPositive = rows.reduce(
        (sum, row) => sum + (row.label ? row.weight : 0),
        0,
    );
    const parentNegative = rows.reduce(
        (sum, row) => sum + (row.label ? 0 : row.weight),
        0,
    );
    const parent = impurity(parentPositive, parentNegative);
    let best = null;
    featureSubset(featureNames.length, config.featuresPerSplit, random)
        .forEach((featureIndex) => {
            candidateThresholds(rows, featureIndex, config.thresholdsPerFeature, random)
                .forEach((threshold) => {
                    let leftPositive = 0;
                    let leftNegative = 0;
                    let leftCount = 0;
                    rows.forEach((row) => {
                        if (row.features[featureIndex] > threshold) return;
                        leftCount += 1;
                        if (row.label) leftPositive += row.weight;
                        else leftNegative += row.weight;
                    });
                    const rightCount = rows.length - leftCount;
                    if (leftCount < config.minRows || rightCount < config.minRows) return;
                    const gain = parent
                        - impurity(leftPositive, leftNegative)
                        - impurity(
                            parentPositive - leftPositive,
                            parentNegative - leftNegative,
                        );
                    if (!best || gain > best.gain) {
                        best = { featureIndex, threshold, gain };
                    }
                });
        });
    if (!best || best.gain <= 1e-9) return leaf(rows);
    const leftRows = rows.filter(
        (row) => row.features[best.featureIndex] <= best.threshold,
    );
    const rightRows = rows.filter(
        (row) => row.features[best.featureIndex] > best.threshold,
    );
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

const sampledRowsForCase = (rankCase, config, random) => {
    const positive = rankCase.candidates.filter((candidate) => (
        candidate.year === rankCase.truthYear
        && (
            rankCase.eventType !== "partialMove"
            || candidate.shiftYears === rankCase.truthShiftYears
        )
    ));
    const negatives = rankCase.candidates.filter((candidate) => !positive.includes(candidate));
    const hard = [...negatives]
        .sort((left, right) => right.heuristic - left.heuristic)
        .slice(0, config.hardNegatives);
    const selected = new Set(hard);
    while (selected.size < Math.min(
        negatives.length,
        config.hardNegatives + config.randomNegatives,
    )) {
        selected.add(negatives[Math.floor(random() * negatives.length)]);
    }
    return [
        ...positive.map((candidate) => ({
            features: candidate.features,
            label: true,
            weight: config.positiveWeight,
        })),
        ...[...selected].map((candidate) => ({
            features: candidate.features,
            label: false,
            weight: 1,
        })),
    ];
};

const trainForest = (trainingCases, config, seed) => {
    const random = makeRandom(seed);
    const trees = [];
    const importance = [];
    for (let treeIndex = 0; treeIndex < config.trees; treeIndex += 1) {
        const rows = [];
        for (let caseIndex = 0; caseIndex < trainingCases.length; caseIndex += 1) {
            const rankCase = trainingCases[Math.floor(random() * trainingCases.length)];
            rows.push(...sampledRowsForCase(rankCase, config, random));
        }
        trees.push(buildTree(rows, 0, config, random, importance));
    }
    return { trees, importance };
};

const predictForest = (forest, features) => forest.trees.reduce(
    (sum, tree) => sum + predictTree(tree, features),
    0,
) / forest.trees.length;

const rankedCandidates = (rankCase, forest) => rankCase.candidates
    .map((candidate) => ({
        ...candidate,
        score: predictForest(forest, candidate.features),
    }))
    .sort((left, right) => (
        right.score - left.score
        || right.heuristic - left.heuristic
        || right.year - left.year
    ));

const emptyMetrics = () => ({
    cases: 0,
    exact: 0,
    withinOne: 0,
    windowHit: 0,
    correctShift: 0,
});

const addPrediction = (metrics, rankCase, candidate) => {
    const shiftCorrect = rankCase.eventType !== "partialMove"
        || candidate.shiftYears === rankCase.truthShiftYears;
    const distance = Math.abs(candidate.year - rankCase.truthYear);
    metrics.cases += 1;
    metrics.exact += Number(distance === 0 && shiftCorrect);
    metrics.withinOne += Number(distance <= 1 && shiftCorrect);
    metrics.windowHit += Number(distance <= toleranceFor(rankCase.eventType) && shiftCorrect);
    metrics.correctShift += Number(shiftCorrect);
};

const rates = (metrics) => ({
    cases: metrics.cases,
    exact: metrics.exact / Math.max(1, metrics.cases),
    withinOne: metrics.withinOne / Math.max(1, metrics.cases),
    windowHit: metrics.windowHit / Math.max(1, metrics.cases),
    correctShift: metrics.correctShift / Math.max(1, metrics.cases),
});

const evaluate = (evaluationCases, forest, count = 1) => {
    const metrics = emptyMetrics();
    evaluationCases.forEach((rankCase) => {
        const ranked = rankedCandidates(rankCase, forest).slice(0, count);
        const exact = ranked.find((candidate) => (
            candidate.year === rankCase.truthYear
            && (
                rankCase.eventType !== "partialMove"
                || candidate.shiftYears === rankCase.truthShiftYears
            )
        ));
        addPrediction(metrics, rankCase, exact ?? ranked[0]);
    });
    return rates(metrics);
};

const config = {
    trees: Number(process.env.EXACT_FOREST_TREES ?? 101),
    maxDepth: Number(process.env.EXACT_FOREST_DEPTH ?? 7),
    minRows: Number(process.env.EXACT_FOREST_MIN_ROWS ?? 10),
    positiveWeight: Number(process.env.EXACT_FOREST_POSITIVE_WEIGHT ?? 24),
    hardNegatives: Number(process.env.EXACT_FOREST_HARD_NEGATIVES ?? 36),
    randomNegatives: Number(process.env.EXACT_FOREST_RANDOM_NEGATIVES ?? 28),
    thresholdsPerFeature: Number(process.env.EXACT_FOREST_THRESHOLDS ?? 10),
    featuresPerSplit: Math.max(12, Math.round(Math.sqrt(featureNames.length) * 1.5)),
};

const runType = (eventType) => {
    const typed = cases.filter((rankCase) => rankCase.eventType === eventType);
    const baseline = emptyMetrics();
    typed.forEach((rankCase) => addPrediction(baseline, rankCase, {
        year: rankCase.currentTopYear,
        shiftYears: rankCase.currentShiftYears,
    }));
    const offsets = [...new Set(typed.map((rankCase) => rankCase.offset))].sort();
    const aggregate = {
        top1: emptyMetrics(),
        top2: emptyMetrics(),
        top3: emptyMetrics(),
    };
    const folds = [];
    const predictionAudit = [];
    offsets.forEach((heldOutOffset) => {
        const training = typed.filter((rankCase) => rankCase.offset !== heldOutOffset);
        const validation = typed.filter((rankCase) => rankCase.offset === heldOutOffset);
        const forest = trainForest(training, config, 7001 + heldOutOffset * 131);
        validation.forEach((rankCase) => {
            const ranked = rankedCandidates(rankCase, forest);
            [1, 2, 3].forEach((count) => {
                const selected = ranked.slice(0, count);
                const exact = selected.find((candidate) => (
                    candidate.year === rankCase.truthYear
                    && (
                        rankCase.eventType !== "partialMove"
                        || candidate.shiftYears === rankCase.truthShiftYears
                    )
                ));
                addPrediction(
                    aggregate[`top${count}`],
                    rankCase,
                    exact ?? selected[0],
                );
            });
            predictionAudit.push({
                heldOutOffset,
                file: rankCase.context.file,
                target: rankCase.context.target,
                truthYear: rankCase.truthYear,
                truthShiftYears: rankCase.truthShiftYears,
                positionStratum: rankCase.context.positionStratum,
                signalStrength: rankCase.context.signalStrength,
                candidateRecall: rankCase.candidates.some((candidate) => (
                    candidate.year === rankCase.truthYear
                    && (
                        rankCase.eventType !== "partialMove"
                        || candidate.shiftYears === rankCase.truthShiftYears
                    )
                )),
                predictions: ranked.slice(0, 3).map((candidate, index) => ({
                    rank: index + 1,
                    year: candidate.year,
                    shiftYears: candidate.shiftYears,
                    score: candidate.score,
                    margin: candidate.score - (ranked[index + 1]?.score ?? candidate.score),
                })),
            });
        });
        folds.push({
            heldOutOffset,
            top1: evaluate(validation, forest, 1),
            top2: evaluate(validation, forest, 2),
            top3: evaluate(validation, forest, 3),
        });
    });
    const finalForest = trainForest(typed, config, 9001);
    const importance = finalForest.importance
        .map((value, index) => ({ name: featureNames[index], value: value ?? 0 }))
        .sort((left, right) => right.value - left.value);
    const candidateRecall = typed.filter((rankCase) => rankCase.candidates.some((candidate) => (
        candidate.year === rankCase.truthYear
        && (
            rankCase.eventType !== "partialMove"
            || candidate.shiftYears === rankCase.truthShiftYears
        )
    ))).length / Math.max(1, typed.length);
    return {
        cases: typed.length,
        meanCandidates: typed.reduce(
            (sum, rankCase) => sum + rankCase.candidates.length,
            0,
        ) / Math.max(1, typed.length),
        candidateRecall,
        baseline: rates(baseline),
        top1: rates(aggregate.top1),
        top2: rates(aggregate.top2),
        top3: rates(aggregate.top3),
        folds,
        fitted: evaluate(typed, finalForest, 1),
        importance: importance.slice(0, 24),
        ...(process.env.EXACT_FOREST_INCLUDE_PREDICTIONS === "1"
            ? { predictionAudit }
            : {}),
    };
};

const report = {
    sampling: "calendar-position-stratified-signal-independent",
    target: "exact-edit-year-and-strict-partial-shift",
    conditioning: matchedWindowAuditPattern
        ? "truth-covered selectable narrow window"
        : "global candidate pool",
    config,
    featureCount: featureNames.length,
    excludedEmptyCandidateCases,
    offsets: [...new Set(cases.map((rankCase) => rankCase.offset))].sort(),
    ...Object.fromEntries(eventTypes.map((eventType) => [
        eventType,
        runType(eventType),
    ])),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

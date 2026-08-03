import { readFileSync, writeFileSync } from "node:fs";

const [trainingPath, ...calibrationPaths] = process.argv.slice(2);
const trainingPaths = (process.env.UNIT_YEAR_TRAINING_PATHS ?? trainingPath ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
const holdoutPaths = (process.env.UNIT_YEAR_HOLDOUT_PATHS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
if (trainingPaths.length === 0 || calibrationPaths.length === 0) {
    throw new Error(
        "Usage: node scripts/analyze-current-unit-year-ranker.mjs "
        + "<train-audit.json> <calibration-audit.json> [...]",
    );
}

const PROFILE_NAMES = [
    "differenceFull",
    "comboFull",
    "whitenedFull",
    "piecewiseCombinedObjective",
    "transitionSplitGain",
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeWhitenedCusum",
    "cumulativeReferenceMedian",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
    "pairDifferenceWeighted",
    "pairWhitenedMean",
    "reference:rankMedian",
    "reference:weightedRankMean",
];

const SHAPE_PROFILE_NAMES = [
    "differenceFull",
    "comboFull",
    "whitenedFull",
    "piecewiseCombinedObjective",
    "transitionSplitGain",
    "cumulativeDifference",
    "cumulativeReferenceVote",
    "pairDifferenceWeighted",
];

const FEATURE_NAMES = [
    "baselineScore",
    ...PROFILE_NAMES.map((name) => `value:${name}`),
    ...SHAPE_PROFILE_NAMES.flatMap((name) => [
        `leftDelta:${name}`,
        `rightDelta:${name}`,
        `slope:${name}`,
        `curvature:${name}`,
    ]),
    "profileMean",
    "profileMedian",
    "profileTop95Share",
    "profileLocalMaximumShare",
    ...["current", "operation", "sideStep"].flatMap((name) => [
        `anchorExact:${name}`,
        `anchorNear1:${name}`,
        `anchorNear3:${name}`,
        `anchorSignedDistance:${name}`,
    ]),
    "windowSignedPosition",
    "windowAbsolutePosition",
];

const keyFor = (file, target, eventType, truthYear) => [
    file,
    target,
    eventType,
    truthYear,
].join("\u0000");

const percentileRanks = (values) => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const result = new Float64Array(values.length);
    let start = 0;
    while (start < ordered.length) {
        let end = start + 1;
        while (end < ordered.length && ordered[end].value === ordered[start].value) {
            end += 1;
        }
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
    const ordered = [...values].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 0
        ? (ordered[middle - 1] + ordered[middle]) / 2
        : ordered[middle];
};

const extractCases = (path, source) => {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    if (payload.fileSplit !== source) {
        throw new Error(`${path} is ${payload.fileSplit ?? "unlabelled"}, expected ${source}`);
    }
    const auditsByKey = new Map();
    (payload.counterfactualLocatorCases ?? []).forEach((audit) => {
        const key = keyFor(
            audit.context.file ?? audit.context.groupId,
            audit.context.target,
            audit.eventType,
            audit.truthYear,
        );
        const rows = auditsByKey.get(key) ?? [];
        rows.push(audit);
        auditsByKey.set(key, rows);
    });
    return (payload.rankingCases ?? []).flatMap((rankingCase) => {
        if (
            rankingCase.eventType !== "missingRing"
            && rankingCase.eventType !== "falseRing"
        ) return [];
        const key = keyFor(
            rankingCase.groupId,
            rankingCase.seriesId,
            rankingCase.eventType,
            rankingCase.truthYear,
        );
        const audit = (auditsByKey.get(key) ?? [])
            .filter((candidate) => (
                candidate.finalWindow.startYear === rankingCase.range[0]
                && candidate.finalWindow.endYear === rankingCase.range[1]
            ))
            .at(-1);
        if (!audit) return [];
        if (audit.context?.baselineFlagged !== false) return [];
        if (
            rankingCase.truthYear < rankingCase.range[0]
            || rankingCase.truthYear > rankingCase.range[1]
        ) return [];
        const yearIndex = new Map(audit.years.map((year, index) => [year, index]));
        const baselineByYear = new Map(
            rankingCase.rankedYears.map((row) => [row.year, row.score]),
        );
        const years = Array.from(
            { length: rankingCase.range[1] - rankingCase.range[0] + 1 },
            (_, index) => rankingCase.range[0] + index,
        );
        if (years.some((year) => !yearIndex.has(year))) return [];
        const profileValue = (name, year) => {
            const index = yearIndex.get(year);
            return index === undefined ? 0 : Number(audit.ranks[name]?.[index] ?? 0);
        };
        const falseBaseline = rankingCase.eventType === "falseRing"
            ? new Map(years.map((year) => [
                    year,
                    profileValue("differenceFull", year),
                ]))
            : null;
        const anchors = [
            audit.currentPrimaryYear,
            audit.selectedOperation?.bestYear,
            audit.selectedOperation?.sideStepBestYear,
        ];
        const availableAnchors = anchors
            .filter((value) => value !== undefined && value !== null)
            .sort((left, right) => left - right);
        const anchorMedian = availableAnchors.length === 0
            ? null
            : median(availableAnchors);
        const anchorScale = Math.max(1, years.length - 1);
        const missingBaseline = new Map(years.map((year) => [
            year,
            (
                profileValue("cumulativeReferenceVote", year)
                + profileValue("comboFull", year)
                + profileValue("piecewiseCombinedObjective", year)
            ) / 3 + (anchorMedian === null
                ? 0
                : -Math.abs(year - anchorMedian) / anchorScale * 0.02),
        ]));
        const activeBaseline = falseBaseline ?? missingBaseline;
        const center = (rankingCase.range[0] + rankingCase.range[1]) / 2;
        const radius = Math.max(1, (rankingCase.range[1] - rankingCase.range[0]) / 2);
        const rows = years.map((year) => {
            const profileValues = PROFILE_NAMES.map((name) => profileValue(name, year));
            const localMaximumShare = SHAPE_PROFILE_NAMES.filter((name) => (
                profileValue(name, year) >= profileValue(name, year - 1)
                && profileValue(name, year) >= profileValue(name, year + 1)
            )).length / SHAPE_PROFILE_NAMES.length;
            const features = [
                activeBaseline.get(year) ?? 0,
                ...profileValues,
                ...SHAPE_PROFILE_NAMES.flatMap((name) => {
                    const value = profileValue(name, year);
                    const left = profileValue(name, year - 1);
                    const right = profileValue(name, year + 1);
                    return [
                        value - left,
                        value - right,
                        (right - left) / 2,
                        value * 2 - left - right,
                    ];
                }),
                profileValues.reduce((sum, value) => sum + value, 0)
                    / profileValues.length,
                median(profileValues),
                profileValues.filter((value) => value >= 0.95).length
                    / profileValues.length,
                localMaximumShare,
                ...anchors.flatMap((anchor) => {
                    if (anchor === undefined || anchor === null) return [0, 0, 0, 0];
                    const distance = year - anchor;
                    return [
                        Number(distance === 0),
                        Math.exp(-Math.abs(distance)),
                        Math.exp(-Math.abs(distance) / 3),
                        Math.tanh(distance / 4),
                    ];
                }),
                (year - center) / radius,
                Math.abs(year - center) / radius,
            ];
            if (features.length !== FEATURE_NAMES.length) {
                throw new Error(
                    `Feature mismatch: ${features.length} != ${FEATURE_NAMES.length}`,
                );
            }
            return {
                year,
                baselineScore: activeBaseline.get(year) ?? 0,
                features,
            };
        });
        return [{
            key,
            source,
            offset: payload.offset,
            groupId: rankingCase.groupId,
            eventType: rankingCase.eventType,
            truthYear: rankingCase.truthYear,
            rows,
        }];
    });
};

const trainingCases = trainingPaths.flatMap(
    (path) => extractCases(path, "train"),
);
const calibrationCases = calibrationPaths.flatMap(
    (path) => extractCases(path, "calibration"),
);
const holdoutCases = holdoutPaths.flatMap((path) => {
    const payload = JSON.parse(readFileSync(path, "utf8"));
    return extractCases(path, payload.fileSplit);
});

const hash = (value) => Array.from(value).reduce(
    (result, character) => ((result * 31) + character.charCodeAt(0)) | 0,
    0,
);
const foldFor = (rankCase) => Math.abs(hash(rankCase.groupId)) % 5;

const fitScaler = (cases) => {
    const count = cases.reduce((sum, rankCase) => sum + rankCase.rows.length, 0);
    const means = new Float64Array(FEATURE_NAMES.length);
    cases.forEach((rankCase) => rankCase.rows.forEach((row) => {
        row.features.forEach((value, index) => { means[index] += value / count; });
    }));
    const scales = new Float64Array(FEATURE_NAMES.length);
    cases.forEach((rankCase) => rankCase.rows.forEach((row) => {
        row.features.forEach((value, index) => {
            scales[index] += (value - means[index]) ** 2 / count;
        });
    }));
    for (let index = 0; index < scales.length; index += 1) {
        scales[index] = Math.max(1e-6, Math.sqrt(scales[index]));
    }
    return { means, scales };
};

const normalizedFeatures = (features, scaler) => features.map(
    (value, index) => (value - scaler.means[index]) / scaler.scales[index],
);
const dot = (left, right) => left.reduce(
    (sum, value, index) => sum + value * right[index],
    0,
);

const trainModel = (cases, config) => {
    const scaler = fitScaler(cases);
    const weights = new Float64Array(FEATURE_NAMES.length);
    const firstMoment = new Float64Array(FEATURE_NAMES.length);
    const secondMoment = new Float64Array(FEATURE_NAMES.length);
    let step = 0;
    for (let epoch = 0; epoch < config.epochs; epoch += 1) {
        const gradient = new Float64Array(FEATURE_NAMES.length);
        let comparisonCount = 0;
        cases.forEach((rankCase) => {
            const features = rankCase.rows.map((row) => (
                normalizedFeatures(row.features, scaler)
            ));
            const truthIndex = rankCase.rows.findIndex(
                (row) => row.year === rankCase.truthYear,
            );
            if (config.pairRadius) {
                features.forEach((row, rowIndex) => {
                    if (
                        rowIndex === truthIndex
                        || Math.abs(
                            rankCase.rows[rowIndex].year - rankCase.truthYear,
                        ) > config.pairRadius
                    ) return;
                    const difference = features[truthIndex].map(
                        (value, index) => value - row[index],
                    );
                    const margin = dot(difference, weights);
                    const factor = -1 / (1 + Math.exp(
                        Math.max(-30, Math.min(30, margin)),
                    ));
                    difference.forEach((value, featureIndex) => {
                        gradient[featureIndex] += factor * value;
                    });
                    comparisonCount += 1;
                });
                return;
            }
            const logits = features.map((row) => dot(row, weights));
            const maximum = Math.max(...logits);
            const exponentials = logits.map((value) => Math.exp(value - maximum));
            const total = exponentials.reduce((sum, value) => sum + value, 0);
            features.forEach((row, rowIndex) => {
                const error = exponentials[rowIndex] / total
                    - Number(rowIndex === truthIndex);
                row.forEach((value, featureIndex) => {
                    gradient[featureIndex] += error * value / cases.length;
                });
            });
        });
        if (config.pairRadius && comparisonCount > 0) {
            for (let index = 0; index < gradient.length; index += 1) {
                gradient[index] /= comparisonCount;
            }
        }
        weights.forEach((weight, index) => {
            gradient[index] += config.regularization * weight / cases.length;
        });
        step += 1;
        for (let index = 0; index < weights.length; index += 1) {
            firstMoment[index] = 0.9 * firstMoment[index] + 0.1 * gradient[index];
            secondMoment[index] = 0.999 * secondMoment[index]
                + 0.001 * gradient[index] ** 2;
            const correctedFirst = firstMoment[index] / (1 - 0.9 ** step);
            const correctedSecond = secondMoment[index] / (1 - 0.999 ** step);
            weights[index] -= config.learningRate * correctedFirst
                / (Math.sqrt(correctedSecond) + 1e-8);
        }
    }
    return { scaler, weights };
};

const modelScores = (rankCase, model) => rankCase.rows.map((row) => (
    dot(normalizedFeatures(row.features, model.scaler), model.weights)
));

const rankRows = (rankCase, model, selection) => {
    const logits = modelScores(rankCase, model);
    const modelRanks = percentileRanks(logits);
    const baselineRanks = percentileRanks(
        rankCase.rows.map((row) => row.baselineScore),
    );
    const modelOrdered = rankCase.rows
        .map((row, index) => ({ row, index, score: logits[index] }))
        .sort((left, right) => right.score - left.score || right.row.year - left.row.year);
    const modelMargin = modelOrdered[0].score
        - (modelOrdered[1]?.score ?? modelOrdered[0].score);
    const baselineTop = rankCase.rows
        .map((row, index) => ({ row, index }))
        .sort((left, right) => (
            right.row.baselineScore - left.row.baselineScore
            || right.row.year - left.row.year
        ))[0];
    const useModel = modelMargin >= selection.minimumModelMargin
        && Math.abs(modelOrdered[0].row.year - baselineTop.row.year)
            <= selection.maximumTopDistance;
    if (useModel && selection.promotionOnly) {
        const promotedYear = modelOrdered[0].row.year;
        return rankCase.rows
            .map((row, index) => ({
                year: row.year,
                score: baselineRanks[index]
                    + Number(row.year === promotedYear) * 2,
            }))
            .sort((left, right) => right.score - left.score || right.year - left.year);
    }
    return rankCase.rows
        .map((row, index) => ({
            year: row.year,
            score: useModel
                ? baselineRanks[index] * (1 - selection.blend)
                    + modelRanks[index] * selection.blend
                : baselineRanks[index],
        }))
        .sort((left, right) => right.score - left.score || right.year - left.year);
};

const emptyMetrics = () => ({
    cases: 0,
    top1: 0,
    withinOne: 0,
    top3: 0,
    reciprocalRank: 0,
    bias: 0,
    changed: 0,
});

const finalizeMetrics = (metrics) => ({
    cases: metrics.cases,
    top1: metrics.top1 / Math.max(1, metrics.cases),
    withinOne: metrics.withinOne / Math.max(1, metrics.cases),
    top3: metrics.top3 / Math.max(1, metrics.cases),
    mrr: metrics.reciprocalRank / Math.max(1, metrics.cases),
    bias: metrics.bias / Math.max(1, metrics.cases),
    changed: metrics.changed,
});

const evaluate = (cases, predict) => {
    const total = emptyMetrics();
    const byOffset = new Map();
    cases.forEach((rankCase) => {
        const ranked = predict(rankCase);
        const baselineTop = rankCase.rows
            .slice()
            .sort((left, right) => (
                right.baselineScore - left.baselineScore || right.year - left.year
            ))[0]?.year;
        const truthRank = ranked.findIndex((row) => row.year === rankCase.truthYear) + 1;
        const metrics = byOffset.get(rankCase.offset) ?? emptyMetrics();
        [total, metrics].forEach((target) => {
            target.cases += 1;
            target.top1 += Number(truthRank === 1);
            target.withinOne += Number(
                Math.abs(ranked[0].year - rankCase.truthYear) <= 1,
            );
            target.top3 += Number(truthRank > 0 && truthRank <= 3);
            target.reciprocalRank += truthRank > 0 ? 1 / truthRank : 0;
            target.bias += ranked[0].year - rankCase.truthYear;
            target.changed += Number(ranked[0].year !== baselineTop);
        });
        byOffset.set(rankCase.offset, metrics);
    });
    return {
        ...finalizeMetrics(total),
        byOffset: Object.fromEntries(
            [...byOffset.entries()].map(([offset, metrics]) => [
                offset,
                finalizeMetrics(metrics),
            ]),
        ),
    };
};

const baselinePrediction = (rankCase) => rankCase.rows
    .map((row) => ({ year: row.year, score: row.baselineScore }))
    .sort((left, right) => right.score - left.score || right.year - left.year);

const listwiseModelConfigs = [
    { regularization: 1, learningRate: 0.01, epochs: 250 },
    { regularization: 3, learningRate: 0.01, epochs: 250 },
    { regularization: 10, learningRate: 0.01, epochs: 250 },
    { regularization: 30, learningRate: 0.01, epochs: 250 },
];
const pairwiseModelConfigs = [1, 2].flatMap((pairRadius) => (
    [3, 10, 30].map((regularization) => ({
        regularization,
        learningRate: 0.01,
        epochs: 250,
        pairRadius,
    }))
));
const modelConfigs = process.env.UNIT_YEAR_PAIRWISE_ONLY === "1"
    ? pairwiseModelConfigs
    : [...listwiseModelConfigs, ...pairwiseModelConfigs];
const selections = [0.1, 0.2, 0.3, 0.4, 0.5].flatMap((blend) => (
    [1, 2, 3].flatMap((maximumTopDistance) => (
        [0, 0.05, 0.1, 0.2, 0.35].flatMap((minimumModelMargin) => ([
            {
                blend,
                maximumTopDistance,
                minimumModelMargin,
                promotionOnly: false,
            },
            ...(blend === 0.1 ? [{
                blend: 1,
                maximumTopDistance,
                minimumModelMargin,
                promotionOnly: true,
            }] : []),
        ]))
    ))
));

const report = {
    schemaVersion: 1,
    featureNames: FEATURE_NAMES,
    trainingPaths,
    calibrationPaths,
    holdoutPaths,
    eventTypes: {},
};

for (const eventType of ["missingRing", "falseRing"]) {
    const train = trainingCases.filter((rankCase) => rankCase.eventType === eventType);
    const calibration = calibrationCases.filter(
        (rankCase) => rankCase.eventType === eventType,
    );
    const baseline = {
        train: evaluate(train, baselinePrediction),
        calibration: evaluate(calibration, baselinePrediction),
    };
    const candidates = [];
    for (const config of modelConfigs) {
        const predictions = new Map();
        for (let fold = 0; fold < 5; fold += 1) {
            const fitting = train.filter((rankCase) => foldFor(rankCase) !== fold);
            const heldOut = train.filter((rankCase) => foldFor(rankCase) === fold);
            const model = trainModel(fitting, config);
            heldOut.forEach((rankCase) => predictions.set(rankCase.key, model));
        }
        for (const selection of selections) {
            const crossValidation = evaluate(
                train,
                (rankCase) => rankRows(
                    rankCase,
                    predictions.get(rankCase.key),
                    selection,
                ),
            );
            candidates.push({ config, selection, crossValidation });
        }
    }
    candidates.sort((left, right) => (
        right.crossValidation.top1 - left.crossValidation.top1
        || right.crossValidation.withinOne - left.crossValidation.withinOne
        || right.crossValidation.top3 - left.crossValidation.top3
        || right.crossValidation.mrr - left.crossValidation.mrr
        || left.crossValidation.changed - right.crossValidation.changed
    ));
    const finalists = candidates.slice(0, 20).map((candidate) => {
        const model = trainModel(train, candidate.config);
        return {
            ...candidate,
            calibration: evaluate(
                calibration,
                (rankCase) => rankRows(rankCase, model, candidate.selection),
            ),
            model: {
                means: [...model.scaler.means],
                scales: [...model.scaler.scales],
                weights: [...model.weights],
            },
        };
    }).sort((left, right) => (
        right.calibration.top1 - left.calibration.top1
        || right.calibration.withinOne - left.calibration.withinOne
        || right.calibration.top3 - left.calibration.top3
        || right.calibration.mrr - left.calibration.mrr
    ));
    report.eventTypes[eventType] = {
        trainingCases: train.length,
        calibrationCases: calibration.length,
        baseline,
        ...(holdoutCases.length > 0 ? {
            holdoutBaseline: evaluate(
                holdoutCases.filter(
                    (rankCase) => rankCase.eventType === eventType,
                ),
                baselinePrediction,
            ),
        } : {}),
        finalists: finalists.map((finalist) => ({
            ...finalist,
            ...(holdoutCases.length > 0 ? {
                holdout: evaluate(
                    holdoutCases.filter(
                        (rankCase) => rankCase.eventType === eventType,
                    ),
                    (rankCase) => rankRows(
                        rankCase,
                        {
                            scaler: {
                                means: finalist.model.means,
                                scales: finalist.model.scales,
                            },
                            weights: finalist.model.weights,
                        },
                        finalist.selection,
                    ),
                ),
            } : {}),
        })),
    };
}

const serializedReport = JSON.stringify(report, null, 2);
const reportPath = process.env.UNIT_YEAR_REPORT_PATH?.trim();
if (reportPath) {
    writeFileSync(reportPath, serializedReport, "utf8");
    console.log(`unit-year report written to ${reportPath}`);
} else {
    console.log(serializedReport);
}

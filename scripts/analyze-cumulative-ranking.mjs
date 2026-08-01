import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length < 2) {
    throw new Error(
        "Usage: node scripts/analyze-cumulative-ranking.mjs <offset-data.json> [...]",
    );
}

const cumulativeFeatures = [
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
        if (!caseMap.has(key)) caseMap.set(key, { ...rankCase, offset: payload.offset });
    });
});
const cases = [...caseMap.values()];

if (cases.some((rankCase) => !("currentShiftYears" in rankCase))) {
    throw new Error("Input predates all-shift partial-move collection.");
}
const partialShifts = new Set(cases
    .filter((rankCase) => rankCase.eventType === "partialMove")
    .flatMap((rankCase) => rankCase.rows.map((row) => row.shiftYears)));
if (partialShifts.size < 4) {
    throw new Error("Partial-move rows do not contain all competing shifts.");
}

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
cases.forEach((rankCase) => {
    const ranks = Object.fromEntries(cumulativeFeatures.map((feature) => [
        feature,
        percentileRanks(rankCase.rows.map((row) => Number(row.features[feature] ?? 0))),
    ]));
    rankCase.rows.forEach((row, index) => {
        row.cumulativeRanks = Object.fromEntries(cumulativeFeatures.map((feature) => [
            feature,
            ranks[feature][index],
        ]));
    });
});

const toleranceFor = (eventType) => eventType === "partialMove" ? 4 : 3;
const confidenceRank = (confidence) => ({
    low: 1,
    medium: 2,
    high: 3,
}[confidence] ?? 0);

const emptyMetrics = () => ({
    cases: 0,
    answered: 0,
    windowHits: 0,
    strictWindowHits: 0,
    exactYears: 0,
    withinOneYears: 0,
    correctShifts: 0,
    absoluteError: 0,
});
const addPrediction = (metrics, rankCase, prediction) => {
    metrics.cases += 1;
    if (!prediction) return;
    metrics.answered += 1;
    const error = prediction.range
        ? rankCase.truthYear < prediction.range[0]
            ? prediction.range[0] - rankCase.truthYear
            : rankCase.truthYear > prediction.range[1]
                ? rankCase.truthYear - prediction.range[1]
                : 0
        : Math.abs(prediction.year - rankCase.truthYear);
    const centerError = Math.abs(prediction.year - rankCase.truthYear);
    const windowHit = error === 0;
    const shiftCorrect = rankCase.eventType !== "partialMove"
        || prediction.shiftYears === rankCase.truthShiftYears;
    metrics.windowHits += Number(windowHit);
    metrics.strictWindowHits += Number(windowHit && shiftCorrect);
    metrics.exactYears += Number(centerError === 0);
    metrics.withinOneYears += Number(centerError <= 1);
    metrics.correctShifts += Number(shiftCorrect);
    metrics.absoluteError += centerError;
};
const rates = (metrics) => ({
    cases: metrics.cases,
    responseRate: metrics.answered / Math.max(1, metrics.cases),
    windowHit: metrics.windowHits / Math.max(1, metrics.cases),
    strictWindowHit: metrics.strictWindowHits / Math.max(1, metrics.cases),
    exactYear: metrics.exactYears / Math.max(1, metrics.cases),
    withinOneYear: metrics.withinOneYears / Math.max(1, metrics.cases),
    correctShift: metrics.correctShifts / Math.max(1, metrics.cases),
    meanAbsoluteError: metrics.absoluteError / Math.max(1, metrics.answered),
});
const currentPrediction = (rankCase) => {
    if (!rankCase.currentRange || rankCase.currentTopYear === null) return null;
    return {
        year: rankCase.currentTopYear,
        range: rankCase.currentRange,
        shiftYears: rankCase.currentShiftYears,
    };
};
const bestFeaturePrediction = (rankCase, feature, yearCorrection = 0) => {
    const best = rankCase.rows.reduce((selected, row) => {
        const score = Number(row.features[feature] ?? 0);
        const selectedScore = Number(selected.features[feature] ?? 0);
        return score > selectedScore || (score === selectedScore && row.year > selected.year)
            ? row
            : selected;
    });
    const year = best.year + yearCorrection;
    const tolerance = toleranceFor(rankCase.eventType);
    return {
        year,
        range: [year - tolerance, year + tolerance],
        shiftYears: best.shiftYears ?? null,
    };
};
const ensemblePrediction = (
    rankCase,
    primary,
    secondary,
    secondaryWeight,
    yearCorrection = 0,
) => {
    const cacheKey = `${primary}|${secondary}|${secondaryWeight}`;
    rankCase.ensemblePredictionCache ??= new Map();
    let best = rankCase.ensemblePredictionCache.get(cacheKey);
    if (!best) {
        best = rankCase.rows.reduce((selected, row) => {
            const score = row.cumulativeRanks[primary]
                + secondaryWeight * row.cumulativeRanks[secondary];
            const selectedScore = selected.cumulativeRanks[primary]
                + secondaryWeight * selected.cumulativeRanks[secondary];
            return score > selectedScore
                || (score === selectedScore && row.year > selected.year)
                ? row
                : selected;
        });
        rankCase.ensemblePredictionCache.set(cacheKey, best);
    }
    const year = best.year + yearCorrection;
    const tolerance = toleranceFor(rankCase.eventType);
    return {
        year,
        range: [year - tolerance, year + tolerance],
        shiftYears: best.shiftYears ?? null,
    };
};
const evaluate = (evaluationCases, predictor) => {
    const metrics = emptyMetrics();
    evaluationCases.forEach((rankCase) => addPrediction(
        metrics,
        rankCase,
        predictor(rankCase),
    ));
    return rates(metrics);
};
const objective = (metrics, eventType) => (
    eventType === "partialMove" ? metrics.strictWindowHit : metrics.windowHit
);

const gates = [
    { name: "candidate", useCurrent: () => false },
    { name: "current_if_answered", useCurrent: (rankCase) => Boolean(rankCase.currentRange) },
    ...[1, 2, 3].map((minimumConfidence) => ({
        name: `current_confidence_${minimumConfidence}`,
        useCurrent: (rankCase) => (
            Boolean(rankCase.currentRange)
            && confidenceRank(rankCase.currentConfidence) >= minimumConfidence
        ),
    })),
    ...[0, 0.25, 0.5, 1, 2, 4].map((minimumMargin) => ({
        name: `current_margin_${minimumMargin}`,
        useCurrent: (rankCase) => (
            Boolean(rankCase.currentRange)
            && (rankCase.currentMargin ?? -Infinity) >= minimumMargin
        ),
    })),
];

const crossValidatedSelector = (typedCases) => {
    const offsets = [...new Set(typedCases.map((rankCase) => rankCase.offset))].sort();
    const aggregate = emptyMetrics();
    const folds = [];
    offsets.forEach((heldOutOffset) => {
        const training = typedCases.filter((rankCase) => rankCase.offset !== heldOutOffset);
        const validation = typedCases.filter((rankCase) => rankCase.offset === heldOutOffset);
        const configurations = cumulativeFeatures.flatMap((feature) => (
            [-2, -1, 0, 1, 2].flatMap((yearCorrection) => gates.map((gate) => {
                const predictor = (rankCase) => (
                    gate.useCurrent(rankCase)
                        ? currentPrediction(rankCase)
                        : bestFeaturePrediction(rankCase, feature, yearCorrection)
                );
                return {
                    feature,
                    yearCorrection,
                    gate,
                    metrics: evaluate(training, predictor),
                };
            }))
        )).sort((left, right) => (
            objective(right.metrics, typedCases[0].eventType)
                - objective(left.metrics, typedCases[0].eventType)
            || right.metrics.windowHit - left.metrics.windowHit
            || right.metrics.withinOneYear - left.metrics.withinOneYear
            || right.metrics.exactYear - left.metrics.exactYear
            || right.metrics.responseRate - left.metrics.responseRate
        ));
        const selected = configurations[0];
        const predictor = (rankCase) => (
            selected.gate.useCurrent(rankCase)
                ? currentPrediction(rankCase)
                : bestFeaturePrediction(
                    rankCase,
                    selected.feature,
                    selected.yearCorrection,
                )
        );
        validation.forEach((rankCase) => addPrediction(
            aggregate,
            rankCase,
            predictor(rankCase),
        ));
        folds.push({
            heldOutOffset,
            selected: {
                feature: selected.feature,
                yearCorrection: selected.yearCorrection,
                gate: selected.gate.name,
            },
            training: selected.metrics,
            validation: evaluate(validation, predictor),
        });
    });
    return { metrics: rates(aggregate), folds };
};

const ensemblePrimaryFeatures = [
    "cumulativeCombined",
    "cumulativeDifference",
    "cumulativeWhitened",
    "cumulativeReferenceMedian",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
];
const ensembleSecondaryFeatures = [
    ...ensemblePrimaryFeatures,
    "cumulativeContrast",
    "cumulativeLocal31",
    "cumulativeLocal61",
    "cumulativeReferenceMedianContrast",
    "cumulativeReferenceMeanContrast",
    "cumulativeReferenceVoteContrast",
];
const crossValidatedEnsemble = (typedCases) => {
    const offsets = [...new Set(typedCases.map((rankCase) => rankCase.offset))].sort();
    const aggregate = emptyMetrics();
    const folds = [];
    offsets.forEach((heldOutOffset) => {
        const training = typedCases.filter((rankCase) => rankCase.offset !== heldOutOffset);
        const validation = typedCases.filter((rankCase) => rankCase.offset === heldOutOffset);
        const configurations = ensemblePrimaryFeatures.flatMap((primary) => (
            ensembleSecondaryFeatures.flatMap((secondary) => (
                [0.2, 0.4, 0.7, 1].flatMap((secondaryWeight) => (
                    [-1, 0, 1].map((yearCorrection) => {
                        const predictor = (rankCase) => ensemblePrediction(
                            rankCase,
                            primary,
                            secondary,
                            secondaryWeight,
                            yearCorrection,
                        );
                        return {
                            primary,
                            secondary,
                            secondaryWeight,
                            yearCorrection,
                            metrics: evaluate(training, predictor),
                        };
                    })
                ))
            ))
        )).sort((left, right) => (
            objective(right.metrics, typedCases[0].eventType)
                - objective(left.metrics, typedCases[0].eventType)
            || right.metrics.windowHit - left.metrics.windowHit
            || right.metrics.withinOneYear - left.metrics.withinOneYear
            || right.metrics.exactYear - left.metrics.exactYear
        ));
        const selected = configurations[0];
        const predictor = (rankCase) => ensemblePrediction(
            rankCase,
            selected.primary,
            selected.secondary,
            selected.secondaryWeight,
            selected.yearCorrection,
        );
        validation.forEach((rankCase) => addPrediction(
            aggregate,
            rankCase,
            predictor(rankCase),
        ));
        folds.push({
            heldOutOffset,
            selected: {
                primary: selected.primary,
                secondary: selected.secondary,
                secondaryWeight: selected.secondaryWeight,
                yearCorrection: selected.yearCorrection,
            },
            training: selected.metrics,
            validation: evaluate(validation, predictor),
        });
    });
    return { metrics: rates(aggregate), folds };
};

const topHypotheses = (rankCase, feature, count) => {
    const tolerance = toleranceFor(rankCase.eventType);
    const ordered = [...rankCase.rows].sort((left, right) => (
        Number(right.features[feature] ?? 0) - Number(left.features[feature] ?? 0)
        || right.year - left.year
    ));
    const selected = [];
    for (const row of ordered) {
        if (selected.every((other) => (
            row.shiftYears !== other.shiftYears
            || Math.abs(row.year - other.year) > tolerance * 2 + 1
        ))) {
            selected.push(row);
            if (selected.length >= count) break;
        }
    }
    return selected;
};
const topKFeatureCoverage = (typedCases) => [1, 2, 3, 5].map((count) => {
    const reports = cumulativeFeatures.map((feature) => {
        let windowHits = 0;
        let strictHits = 0;
        typedCases.forEach((rankCase) => {
            const tolerance = toleranceFor(rankCase.eventType);
            const hypotheses = topHypotheses(rankCase, feature, count);
            windowHits += Number(hypotheses.some((row) => (
                Math.abs(row.year - rankCase.truthYear) <= tolerance
            )));
            strictHits += Number(hypotheses.some((row) => (
                Math.abs(row.year - rankCase.truthYear) <= tolerance
                && (
                    rankCase.eventType !== "partialMove"
                    || row.shiftYears === rankCase.truthShiftYears
                )
            )));
        });
        return {
            feature,
            windowHit: windowHits / Math.max(1, typedCases.length),
            strictWindowHit: strictHits / Math.max(1, typedCases.length),
        };
    }).sort((left, right) => (
        (typedCases[0].eventType === "partialMove"
            ? right.strictWindowHit - left.strictWindowHit
            : right.windowHit - left.windowHit)
        || right.windowHit - left.windowHit
    ));
    return { count, best: reports[0] };
});

const summarizeType = (eventType) => {
    const typed = cases.filter((rankCase) => rankCase.eventType === eventType);
    const featureReports = cumulativeFeatures.map((feature) => ({
        feature,
        ...evaluate(typed, (rankCase) => bestFeaturePrediction(rankCase, feature)),
    })).sort((left, right) => (
        objective(right, eventType) - objective(left, eventType)
        || right.windowHit - left.windowHit
        || right.withinOneYear - left.withinOneYear
    ));
    return {
        cases: typed.length,
        current: evaluate(typed, currentPrediction),
        topFeatures: featureReports.slice(0, 10),
        selector: crossValidatedSelector(typed),
        ensemble: crossValidatedEnsemble(typed),
        topK: topKFeatureCoverage(typed),
    };
};

const report = {
    sampling: "calendar-position-stratified-signal-independent",
    offsets: [...new Set(cases.map((rankCase) => rankCase.offset))].sort(),
    files: new Set(cases.map((rankCase) => rankCase.context.file)).size,
    missingRing: summarizeType("missingRing"),
    falseRing: summarizeType("falseRing"),
    partialMove: summarizeType("partialMove"),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

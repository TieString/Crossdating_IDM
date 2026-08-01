import { readFileSync } from "node:fs";

const paths = process.argv.slice(2);
if (paths.length === 0) {
    throw new Error(
        "Usage: node scripts/analyze-unit-ranker-prototypes.mjs <offset-json> [...]",
    );
}

const unitFeatures = [
    "raw31",
    "difference31",
    "whitened31",
    "raw11",
    "difference11",
    "whitened11",
    "combo11",
    "combo21",
    "combo31",
    "combo41",
    "combo61",
    "multiScale",
    "rawHuber5",
    "rawHuber7",
    "rawHuber11",
    "rawHuber31",
    "differenceHuber5",
    "differenceHuber7",
    "differenceHuber11",
    "differenceHuber31",
    "whitenedHuber5",
    "whitenedHuber7",
    "whitenedHuber11",
    "whitenedHuber31",
    "huberCombo5",
    "huberCombo7",
    "huberCombo11",
    "huberCombo31",
    "huberMultiScale",
    "pairMean31",
    "pairMedian31",
    "pairTrimmed31",
    "pairWeighted31",
    "bestReference31",
    "pairedCore31",
    "currentTop",
    "distance",
    "signedDistance",
    "edge",
    "directProximity",
    "directSignedDistance",
    "pairedProximity",
    "pairedSignedDistance",
    "consensusProximity",
    "exactVoteCount",
    "withinOneVoteCount",
    "betweenIndependent",
];

const partialFeatures = [
    "raw31",
    "difference31",
    "whitened31",
    "combo31",
    "combo41",
    "combo61",
    "multiScale",
    "currentTop",
    "distance",
    "signedDistance",
    "edge",
];

const cases = paths.flatMap((path, offset) => (
    JSON.parse(readFileSync(path, "utf8")).map((rankCase) => ({
        ...rankCase,
        offset,
    }))
));

const empty = () => ({
    cases: 0,
    exact: 0,
    withinOne: 0,
    absoluteError: 0,
});

const add = (metrics, rankCase, year) => {
    const error = Math.abs(year - rankCase.truthYear);
    metrics.cases += 1;
    metrics.exact += Number(error === 0);
    metrics.withinOne += Number(error <= 1);
    metrics.absoluteError += error;
};

const summarize = (metrics) => ({
    cases: metrics.cases,
    exact: metrics.exact / Math.max(1, metrics.cases),
    withinOne: metrics.withinOne / Math.max(1, metrics.cases),
    meanAbsoluteError: metrics.absoluteError / Math.max(1, metrics.cases),
});

const evaluate = (rows, predictor) => {
    const metrics = empty();
    rows.forEach((rankCase) => add(metrics, rankCase, predictor(rankCase)));
    return summarize(metrics);
};

const bestFeatureYear = (rankCase, featureIndex, direction, correction) => {
    const selected = [...rankCase.rows].sort((left, right) => (
        direction * (right.features[featureIndex] - left.features[featureIndex])
        || right.year - left.year
    ))[0];
    return selected.year + correction;
};

const compare = (left, right) => (
    right.exact - left.exact
    || right.withinOne - left.withinOne
    || left.meanAbsoluteError - right.meanAbsoluteError
);

const analyzeType = (eventType) => {
    const typedCases = cases.filter((rankCase) => rankCase.eventType === eventType);
    const featureNames = eventType === "partialMove" ? partialFeatures : unitFeatures;
    const configurations = featureNames.flatMap((feature, featureIndex) => (
        [-1, 1].flatMap((direction) => (
            [-3, -2, -1, 0, 1, 2, 3].map((correction) => ({
                feature,
                featureIndex,
                direction,
                correction,
            }))
        ))
    ));
    const fixed = configurations.map((configuration) => ({
        ...configuration,
        ...evaluate(typedCases, (rankCase) => bestFeatureYear(
            rankCase,
            configuration.featureIndex,
            configuration.direction,
            configuration.correction,
        )),
    })).sort(compare);

    const offsets = [...new Set(typedCases.map((rankCase) => rankCase.offset))];
    const crossValidated = empty();
    const folds = offsets.map((heldOutOffset) => {
        const training = typedCases.filter((rankCase) => rankCase.offset !== heldOutOffset);
        const validation = typedCases.filter((rankCase) => rankCase.offset === heldOutOffset);
        const selected = configurations.map((configuration) => ({
            ...configuration,
            ...evaluate(training, (rankCase) => bestFeatureYear(
                rankCase,
                configuration.featureIndex,
                configuration.direction,
                configuration.correction,
            )),
        })).sort(compare)[0];
        validation.forEach((rankCase) => add(
            crossValidated,
            rankCase,
            bestFeatureYear(
                rankCase,
                selected.featureIndex,
                selected.direction,
                selected.correction,
            ),
        ));
        return {
            heldOutOffset,
            validationCases: validation.length,
            feature: selected.feature,
            direction: selected.direction,
            correction: selected.correction,
        };
    });

    return {
        cases: typedCases.length,
        current: evaluate(typedCases, (rankCase) => rankCase.currentTopYear),
        bestFixedConfigurations: fixed.slice(0, 15).map((row) => ({
            feature: row.feature,
            direction: row.direction,
            correction: row.correction,
            exact: row.exact,
            withinOne: row.withinOne,
            meanAbsoluteError: row.meanAbsoluteError,
        })),
        leaveOneOffsetOut: {
            ...summarize(crossValidated),
            folds,
        },
    };
};

const report = {
    sampling: "calendar-position-stratified-signal-independent",
    inputFiles: paths.length,
    totalCases: cases.length,
    missingRing: analyzeType("missingRing"),
    falseRing: analyzeType("falseRing"),
    partialMove: analyzeType("partialMove"),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

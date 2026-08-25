import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name, fallback = "") => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};

const rowPaths = valueFor("--rows").split(",").map((value) => resolve(value.trim()));
const calibrationPaths = valueFor("--calibration-rows").split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(value));
const outputPath = resolve(valueFor("--output"));
const minimumEventRecall = Number(valueFor("--minimum-event-recall", "0.995"));
const maximumCleanFalsePositiveRate = Number(valueFor("--maximum-clean-fp-rate", "0.01"));

const FEATURE_NAMES = [
    "zeroCorrelation",
    "bestCorrelation",
    "absoluteBestLag",
    "zeroLagDeficit",
    "segmentZeroCorrelationMedian",
    "segmentZeroCorrelationMinimum",
    "segmentIncompatibleFraction",
    "segmentNonzeroLagFraction",
    "perReferenceZeroCorrelationMedian",
    "perReferenceZeroCorrelationQ25",
    "perReferenceIncompatibleFraction",
    "perReferenceNonzeroLagFraction",
    "logReferenceCount",
    "meanReferenceWeight",
];

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const vectorFor = (row) => {
    const value = row.internalTargetCompatibility ?? {};
    return [
        finite(value.zeroCorrelation, -0.2),
        finite(value.bestCorrelation, -0.2),
        Math.abs(finite(value.bestLag, 10)),
        finite(value.zeroLagDeficit, 1),
        finite(value.segmentZeroCorrelationMedian, -0.2),
        finite(value.segmentZeroCorrelationMinimum, -0.5),
        finite(value.segmentIncompatibleFraction, 1),
        finite(value.segmentNonzeroLagFraction, 1),
        finite(value.perReferenceZeroCorrelationMedian, -0.2),
        finite(value.perReferenceZeroCorrelationQ25, -0.3),
        finite(value.perReferenceIncompatibleFraction, 1),
        finite(value.perReferenceNonzeroLagFraction, 1),
        Math.log1p(Math.max(0, finite(value.referenceCount, 0))),
        finite(value.meanReferenceWeight, 0),
    ];
};

const loadRows = (paths) => paths.flatMap((path) => (
    JSON.parse(readFileSync(path, "utf8"))
)).filter((row) => row.internalTargetCompatibility !== null);

const sigmoid = (value) => {
    if (value >= 0) return 1 / (1 + Math.exp(-value));
    const exponential = Math.exp(value);
    return exponential / (1 + exponential);
};

const fit = (rows) => {
    const vectors = rows.map(vectorFor);
    const means = FEATURE_NAMES.map((_, feature) => (
        vectors.reduce((sum, vector) => sum + vector[feature], 0) / vectors.length
    ));
    const scales = FEATURE_NAMES.map((_, feature) => {
        const variance = vectors.reduce((sum, vector) => (
            sum + (vector[feature] - means[feature]) ** 2
        ), 0) / Math.max(1, vectors.length - 1);
        return Math.sqrt(variance) || 1;
    });
    const normalized = vectors.map((vector) => vector.map((value, feature) => (
        (value - means[feature]) / scales[feature]
    )));
    const labels = rows.map((row) => row.truthId !== null ? 1 : 0);
    const positives = labels.filter(Boolean).length;
    const negatives = labels.length - positives;
    const sampleWeights = labels.map((label) => (
        label ? labels.length / Math.max(1, 2 * positives) : labels.length / Math.max(1, 2 * negatives)
    ));
    const coefficients = FEATURE_NAMES.map(() => 0);
    const firstMoment = FEATURE_NAMES.map(() => 0);
    const secondMoment = FEATURE_NAMES.map(() => 0);
    let intercept = 0;
    let interceptFirst = 0;
    let interceptSecond = 0;
    const learningRate = 0.025;
    const l2 = 0.01;
    for (let iteration = 1; iteration <= 2500; iteration += 1) {
        const gradient = FEATURE_NAMES.map(() => 0);
        let interceptGradient = 0;
        normalized.forEach((vector, rowIndex) => {
            const linear = intercept + vector.reduce((sum, value, feature) => (
                sum + value * coefficients[feature]
            ), 0);
            const error = (sigmoid(linear) - labels[rowIndex]) * sampleWeights[rowIndex];
            interceptGradient += error;
            vector.forEach((value, feature) => {
                gradient[feature] += error * value;
            });
        });
        interceptGradient /= rows.length;
        interceptFirst = 0.9 * interceptFirst + 0.1 * interceptGradient;
        interceptSecond = 0.999 * interceptSecond + 0.001 * interceptGradient ** 2;
        const firstCorrection = 1 - 0.9 ** iteration;
        const secondCorrection = 1 - 0.999 ** iteration;
        intercept -= learningRate * (interceptFirst / firstCorrection)
            / (Math.sqrt(interceptSecond / secondCorrection) + 1e-8);
        coefficients.forEach((coefficient, feature) => {
            const currentGradient = gradient[feature] / rows.length + l2 * coefficient;
            firstMoment[feature] = 0.9 * firstMoment[feature] + 0.1 * currentGradient;
            secondMoment[feature] = 0.999 * secondMoment[feature]
                + 0.001 * currentGradient ** 2;
            coefficients[feature] -= learningRate * (firstMoment[feature] / firstCorrection)
                / (Math.sqrt(secondMoment[feature] / secondCorrection) + 1e-8);
        });
    }
    return { means, scales, coefficients, intercept };
};

const predict = (model, row) => {
    const vector = vectorFor(row);
    return sigmoid(model.intercept + vector.reduce((sum, value, feature) => (
        sum + ((value - model.means[feature]) / model.scales[feature])
            * model.coefficients[feature]
    ), 0));
};

const chooseThreshold = (predictions, minimumRecall, maximumCleanRate) => {
    const thresholds = [1 + Number.EPSILON, ...new Set(
        predictions.map((row) => row.probability),
    ), 0].sort((left, right) => right - left);
    const events = predictions.filter((row) => row.label === 1);
    const clean = predictions.filter((row) => row.label === 0);
    let selected = thresholds[0];
    let selectedRecall = -1;
    for (const threshold of thresholds) {
        const recall = events.filter((row) => row.probability >= threshold).length
            / Math.max(1, events.length);
        const cleanRate = clean.filter((row) => row.probability >= threshold).length
            / Math.max(1, clean.length);
        if (cleanRate <= maximumCleanRate && recall > selectedRecall) {
            selected = threshold;
            selectedRecall = recall;
        }
    }
    return {
        threshold: selected,
        minimumRecallReached: selectedRecall >= minimumRecall,
    };
};

const summarize = (predictions, threshold) => {
    const events = predictions.filter((row) => row.label === 1);
    const clean = predictions.filter((row) => row.label === 0);
    const truePositive = events.filter((row) => row.probability >= threshold).length;
    const falsePositive = clean.filter((row) => row.probability >= threshold).length;
    const ranked = [...predictions].sort((left, right) => left.probability - right.probability);
    let negativeSeen = 0;
    let concordant = 0;
    ranked.forEach((row) => {
        if (row.label === 0) negativeSeen += 1;
        else concordant += negativeSeen;
    });
    return {
        attempts: predictions.length,
        events: events.length,
        clean: clean.length,
        threshold,
        eventRecall: truePositive / Math.max(1, events.length),
        cleanFalsePositives: falsePositive,
        cleanFalsePositiveRate: falsePositive / Math.max(1, clean.length),
        auc: concordant / Math.max(1, events.length * clean.length),
    };
};

const trainingRows = loadRows(rowPaths);
const files = [...new Set(trainingRows.map((row) => row.fileId))];
const oofPredictions = files.flatMap((heldOutFile) => {
    const train = trainingRows.filter((row) => row.fileId !== heldOutFile);
    const heldOut = trainingRows.filter((row) => row.fileId === heldOutFile);
    const model = fit(train);
    return heldOut.map((row) => ({
        fileId: row.fileId,
        attemptId: row.attemptId,
        label: row.truthId !== null ? 1 : 0,
        probability: predict(model, row),
    }));
});
const fittedModel = fit(trainingRows);
const calibrationRows = loadRows(calibrationPaths);
const thresholdRows = calibrationRows.length > 0
    ? calibrationRows.map((row) => ({
        fileId: row.fileId,
        attemptId: row.attemptId,
        label: row.truthId !== null ? 1 : 0,
        probability: predict(fittedModel, row),
    }))
    : oofPredictions;
const thresholdSelection = chooseThreshold(
    thresholdRows,
    minimumEventRecall,
    maximumCleanFalsePositiveRate,
);
const threshold = thresholdSelection.threshold;
const calibrationByAttempt = new Map(calibrationRows.map((row) => [row.attemptId, row]));
const protectedStrictProbabilities = thresholdRows.flatMap((prediction) => {
    const row = calibrationByAttempt.get(prediction.attemptId);
    return row?.truthId !== null && row?.workflowCorrect === true && row?.strictResponse === true
        ? [prediction.probability]
        : [];
});
const safeStrictSuppressionThreshold = protectedStrictProbabilities.length > 0
    ? Math.min(...protectedStrictProbabilities)
    : null;
const output = {
    schemaVersion: 1,
    featureNames: FEATURE_NAMES,
    label: "target_has_current_frontier_event",
    forbiddenFeatures: ["fileId", "targetId", "family", "truthYear", "truthType"],
    trainingFiles: files,
    calibrationFiles: [...new Set(calibrationRows.map((row) => row.fileId))],
    minimumEventRecall,
    maximumCleanFalsePositiveRate,
    minimumRecallReached: thresholdSelection.minimumRecallReached,
    model: fittedModel,
    recommendedThreshold: threshold,
    safeStrictSuppressionThreshold,
    protectedCalibrationStrictEvents: protectedStrictProbabilities.length,
    oof: summarize(oofPredictions, threshold),
    calibration: calibrationRows.length > 0 ? summarize(thresholdRows, threshold) : null,
    oofPredictions,
    calibrationPredictions: calibrationRows.length > 0 ? thresholdRows : null,
};
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`INTERNAL_COMPATIBILITY_MODEL_COMPLETE ${JSON.stringify({
    outputPath,
    recommendedThreshold: threshold,
    oof: output.oof,
    calibration: output.calibration,
})}`);

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name, fallback = "") => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const rowsPath = resolve(valueFor("--rows"));
const calibrationPath = valueFor("--calibration-rows");
const safetyPath = valueFor("--safety-rows");
const outputPath = resolve(valueFor("--output"));
const treatNeutralNeitherAsHarmful = valueFor(
    "--treat-neutral-neither-as-harmful",
    "false",
) === "true";
const source = JSON.parse(readFileSync(rowsPath, "utf8"));
const calibrationSource = calibrationPath
    ? JSON.parse(readFileSync(resolve(calibrationPath), "utf8"))
    : null;
const safetySource = safetyPath
    ? JSON.parse(readFileSync(resolve(safetyPath), "utf8"))
    : null;
const featureNames = source.featureNames;
const trainingRows = source.rows.filter((row) => row.eligibleOverride);
const calibrationRows = calibrationSource?.rows.filter((row) => row.eligibleOverride) ?? [];
const safetyRows = safetySource?.rows.filter((row) => row.eligibleOverride) ?? [];

const vectorFor = (row) => featureNames.map((name) => Number(row.features[name]) || 0);
const labelFor = (row) => row.beneficialOverride ? 1 : 0;
const sigmoid = (value) => {
    if (value >= 0) return 1 / (1 + Math.exp(-value));
    const exponential = Math.exp(value);
    return exponential / (1 + exponential);
};

const fit = (rows) => {
    const vectors = rows.map(vectorFor);
    const means = featureNames.map((_, feature) => (
        vectors.reduce((sum, vector) => sum + vector[feature], 0) / vectors.length
    ));
    const scales = featureNames.map((_, feature) => {
        const variance = vectors.reduce((sum, vector) => (
            sum + (vector[feature] - means[feature]) ** 2
        ), 0) / Math.max(1, vectors.length - 1);
        return Math.sqrt(variance) || 1;
    });
    const normalized = vectors.map((vector) => vector.map((value, feature) => (
        (value - means[feature]) / scales[feature]
    )));
    const labels = rows.map(labelFor);
    const positives = labels.filter(Boolean).length;
    const negatives = labels.length - positives;
    const weights = labels.map((label) => (
        label ? labels.length / Math.max(1, 2 * positives) : labels.length / Math.max(1, 2 * negatives)
    ));
    const coefficients = featureNames.map(() => 0);
    const firstMoment = featureNames.map(() => 0);
    const secondMoment = featureNames.map(() => 0);
    let intercept = 0;
    let interceptFirst = 0;
    let interceptSecond = 0;
    const learningRate = 0.02;
    const l2 = 0.02;
    for (let iteration = 1; iteration <= 3000; iteration += 1) {
        const gradient = featureNames.map(() => 0);
        let interceptGradient = 0;
        normalized.forEach((vector, rowIndex) => {
            const linear = intercept + vector.reduce((sum, value, feature) => (
                sum + value * coefficients[feature]
            ), 0);
            const error = (sigmoid(linear) - labels[rowIndex]) * weights[rowIndex];
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
            const current = gradient[feature] / rows.length + l2 * coefficient;
            firstMoment[feature] = 0.9 * firstMoment[feature] + 0.1 * current;
            secondMoment[feature] = 0.999 * secondMoment[feature] + 0.001 * current ** 2;
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

const classify = (rows, model) => rows.map((row) => ({
    attemptId: row.attemptId,
    fileId: row.fileId,
    probability: predict(model, row),
    vetoedByDirectionConflict: row.features.productTypeCode === 1
        && row.features.stableTypeCode === -2
        && row.features.stableJointSupport === 0,
    beneficial: row.beneficialOverride,
    harmful: row.harmfulOverride,
    neutralBoth: row.neutralBoth,
    neutralNeither: row.neutralNeither,
}));

const chooseZeroHarmThreshold = (predictions) => {
    const harmfulProbabilities = predictions
        .filter((row) => row.harmful
            || (treatNeutralNeitherAsHarmful && row.neutralNeither))
        .map((row) => row.probability);
    const maximumHarmful = harmfulProbabilities.length > 0
        ? Math.max(...harmfulProbabilities)
        : 0;
    return Math.min(1 + Number.EPSILON, maximumHarmful + Number.EPSILON * 8);
};

const summarize = (predictions, threshold) => {
    const selected = predictions.filter((row) => (
        row.probability >= threshold && !row.vetoedByDirectionConflict
    ));
    return {
        eligible: predictions.length,
        selected: selected.length,
        beneficialSelected: selected.filter((row) => row.beneficial).length,
        harmfulSelected: selected.filter((row) => row.harmful).length,
        neutralBothSelected: selected.filter((row) => row.neutralBoth).length,
        neutralNeitherSelected: selected.filter((row) => row.neutralNeither).length,
        threshold,
    };
};

const files = [...new Set(trainingRows.map((row) => row.fileId))];
const oofPredictions = files.flatMap((heldOutFile) => {
    const train = trainingRows.filter((row) => row.fileId !== heldOutFile);
    const heldOut = trainingRows.filter((row) => row.fileId === heldOutFile);
    return classify(heldOut, fit(train));
});
const fittedModel = fit(trainingRows);
const calibrationPredictions = calibrationRows.length > 0
    ? classify(calibrationRows, fittedModel)
    : [];
const safetyPredictions = safetyRows.length > 0
    ? classify(safetyRows, fittedModel)
    : [];
const oofThreshold = chooseZeroHarmThreshold(oofPredictions);
const calibrationThreshold = calibrationPredictions.length > 0
    ? chooseZeroHarmThreshold(calibrationPredictions)
    : 0;
const safetyThreshold = safetyPredictions.length > 0
    ? chooseZeroHarmThreshold(safetyPredictions)
    : 0;
const threshold = Math.max(oofThreshold, calibrationThreshold, safetyThreshold);
const output = {
    schemaVersion: 1,
    rowsPath,
    calibrationPath: calibrationPath ? resolve(calibrationPath) : null,
    safetyPath: safetyPath ? resolve(safetyPath) : null,
    featureNames,
    forbiddenFeatures: source.forbiddenFeatures,
    vetoPolicy: "reject_falseRing_to_negative_partial_without_joint_support",
    treatNeutralNeitherAsHarmful,
    model: fittedModel,
    threshold,
    oof: summarize(oofPredictions, threshold),
    calibration: calibrationPredictions.length > 0
        ? summarize(calibrationPredictions, threshold)
        : null,
    safety: safetyPredictions.length > 0
        ? summarize(safetyPredictions, threshold)
        : null,
    oofPredictions,
    calibrationPredictions: calibrationPredictions.length > 0
        ? calibrationPredictions
        : null,
    safetyPredictions: safetyPredictions.length > 0 ? safetyPredictions : null,
};
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`INTERNAL_PATH_FRONTIER_MODEL_COMPLETE ${JSON.stringify({
    outputPath,
    oof: output.oof,
    calibration: output.calibration,
    safety: output.safety,
})}`);

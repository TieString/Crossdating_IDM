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
const modelPath = resolve(valueFor("--model"));
const outputPath = resolve(valueFor("--output"));
const source = JSON.parse(readFileSync(rowsPath, "utf8"));
const artifact = JSON.parse(readFileSync(modelPath, "utf8"));

if (JSON.stringify(source.featureNames) !== JSON.stringify(artifact.featureNames)) {
    throw new Error("path frontier feature contract mismatch");
}

const sigmoid = (value) => {
    if (value >= 0) return 1 / (1 + Math.exp(-value));
    const exponential = Math.exp(value);
    return exponential / (1 + exponential);
};
const predict = (row) => {
    const vector = artifact.featureNames.map((name) => Number(row.features[name]) || 0);
    return sigmoid(artifact.model.intercept + vector.reduce((sum, value, feature) => (
        sum + ((value - artifact.model.means[feature]) / artifact.model.scales[feature])
            * artifact.model.coefficients[feature]
    ), 0));
};

const predictions = source.rows.filter((row) => row.eligibleOverride).map((row) => ({
    attemptId: row.attemptId,
    fileId: row.fileId,
    family: row.family,
    isClean: row.isClean,
    productResponse: row.productResponse,
    probability: predict(row),
    selected: false,
    beneficial: row.beneficialOverride,
    harmful: row.harmfulOverride,
    neutralBoth: row.neutralBoth,
    neutralNeither: row.neutralNeither,
}));
predictions.forEach((row) => {
    row.selected = row.probability >= artifact.threshold;
});

const summarize = (selectedRows, allRows) => {
    const selected = selectedRows.filter((row) => row.selected);
    const baselineCorrect = allRows.filter((row) => !row.isClean && row.productCorrect).length;
    const eventCount = allRows.filter((row) => !row.isClean).length;
    const beneficial = selected.filter((row) => row.beneficial).length;
    const harmful = selected.filter((row) => row.harmful).length;
    return {
        events: eventCount,
        baselineCorrect,
        selected: selected.length,
        beneficialSelected: beneficial,
        harmfulSelected: harmful,
        neutralBothSelected: selected.filter((row) => row.neutralBoth).length,
        neutralNeitherSelected: selected.filter((row) => row.neutralNeither).length,
        cleanSelected: selected.filter((row) => row.isClean).length,
        existingCleanResponseReplaced: selected.filter((row) => (
            row.isClean && row.productResponse
        )).length,
        newCleanFalsePositives: selected.filter((row) => (
            row.isClean && !row.productResponse
        )).length,
        resultingCorrect: baselineCorrect + beneficial - harmful,
        resultingAccuracy: eventCount > 0
            ? (baselineCorrect + beneficial - harmful) / eventCount
            : null,
    };
};

const output = {
    schemaVersion: 1,
    rowsPath,
    modelPath,
    threshold: artifact.threshold,
    overall: summarize(predictions, source.rows),
    byFamily: Object.fromEntries(["A", "B", "C", "D"].map((family) => [
        family,
        summarize(
            predictions.filter((row) => row.family === family),
            source.rows.filter((row) => row.family === family),
        ),
    ])),
    predictions,
};
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`INTERNAL_PATH_FRONTIER_EVALUATION_COMPLETE ${JSON.stringify({
    outputPath,
    overall: output.overall,
    byFamily: output.byFamily,
})}`);

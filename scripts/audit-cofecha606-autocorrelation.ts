import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stopMarker } from "@/shared/constants";
import { detectPrecision } from "@/features/rwl/detect";
import { prepareCofecha606SeriesForReport } from "@/features/cofecha/jsReportSeries";
import { loadRwl } from "./legacy-generalization/evaluator";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? "" : "";
};
const path = resolve(valueFor("--rwl"));
const sequence = Number(valueFor("--sequence"));
const stage = valueFor("--stage");
stopMarker.value = await detectPrecision(readFileSync(path, "utf8"));
const loaded = await loadRwl(path, "tucson-auto", {
    preserveNegativeMeasurements: true,
});
const prepared = prepareCofecha606SeriesForReport(loaded.siteData, {
    splineRigidityYears: 32,
    splineFrequencyResponse: 0.5,
    segmentLength: 50,
    segmentLag: 25,
    useAutoregressiveModel: true,
    useLogTransform: true,
    useFirstDifference: false,
    segmentGridStartYear: -10000,
    segmentGridEndYear: 10000,
    analysisStartYear: -10000,
    analysisEndYear: 10000,
})[sequence - 1];
const values = stage === "filtered" ? prepared.filteredValues : prepared.rawValues;
let leftSum = Math.fround(0);
let rightSum = Math.fround(0);
let leftSquares = Math.fround(0);
let rightSquares = Math.fround(0);
let crossSum = Math.fround(0);
for (let index = 0; index < values.length - 1; index += 1) {
    const left = Math.fround(values[index]);
    const right = Math.fround(values[index + 1]);
    leftSum = Math.fround(leftSum + left);
    rightSum = Math.fround(rightSum + right);
    leftSquares = Math.fround(leftSquares + left * left);
    rightSquares = Math.fround(rightSquares + right * right);
    crossSum = Math.fround(crossSum + left * right);
}
const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
let cross = 0;
let allVariance = 0;
let leftVariance = 0;
let rightVariance = 0;
for (let index = 0; index < values.length; index += 1) {
    const delta = values[index] - mean;
    allVariance += delta * delta;
    if (index > 0) {
        cross += delta * (values[index - 1] - mean);
        rightVariance += delta * delta;
    }
    if (index < values.length - 1) leftVariance += delta * delta;
}
console.log(JSON.stringify({
    sequence,
    seriesId: prepared.segment.seriesId,
    stage,
    arOrder: prepared.arOrder,
    arCoefficients: prepared.arCoefficients,
    shiftedPearson: prepared[
        stage === "filtered" ? "filteredStats" : "unfilteredStats"
    ].lagOneAutocorrelation,
    acfAllVariance: cross / allVariance,
    acfShiftedVariance: cross / Math.sqrt(leftVariance * rightVariance),
    floatSums: {
        leftSum,
        rightSum,
        leftSquares,
        rightSquares,
        cross: crossSum,
        reciprocal: Math.fround(1 / Math.fround(values.length - 1)),
    },
}));

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stopMarker } from "@/shared/constants";
import { detectPrecision } from "@/features/rwl/detect";
import { splitCofecha606SeriesSegments } from "@/features/crossdating/reference";
import { parseCofecha606TucsonWidth } from "@/features/crossdating/cofecha606F63";
import { loadRwl } from "./legacy-generalization/evaluator";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? "" : "";
};
const path = resolve(valueFor("--rwl"));
const sequence = Number(valueFor("--sequence"));
const expected = Number(valueFor("--expected"));
stopMarker.value = await detectPrecision(readFileSync(path, "utf8"));
const loaded = await loadRwl(path, "tucson-auto", {
    preserveNegativeMeasurements: true,
});
const segment = splitCofecha606SeriesSegments(loaded.siteData)[sequence - 1];
const values = [...segment.data.values()].map((value) => (
    parseCofecha606TucsonWidth(Number(value), segment.stopMarkerValue)
));
let allSum = 0;
let skippedSum = 0;
let skippedCount = 0;
let zeroAsZeroSum = 0;
for (let index = 1; index < values.length; index += 1) {
    const left = values[index - 1];
    const right = values[index];
    const denominator = (left + right) / 2;
    const sensitivity = denominator > 0 ? Math.abs(right - left) / denominator : 0;
    allSum += sensitivity;
    if (left > 0 && right > 0) {
        skippedSum += sensitivity;
        skippedCount += 1;
        zeroAsZeroSum += sensitivity;
    }
}
console.log(JSON.stringify({
    sequence,
    seriesId: segment.seriesId,
    years: values.length,
    zeros: values.filter((value) => value === 0).length,
    expected,
    includeZeroTransitions: allSum / (values.length - 1),
    skipZeroTransitions: skippedSum / skippedCount,
    zeroTransitionsAsZero: zeroAsZeroSum / (values.length - 1),
}));

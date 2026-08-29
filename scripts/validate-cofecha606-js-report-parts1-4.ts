import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { stopMarker } from "@/shared/constants";
import { detectPrecision } from "@/features/rwl/detect";
import {
    generateCofecha606JsReport,
    type Cofecha606YearSpan,
} from "@/features/cofecha/jsReport";
import { loadRwl } from "./legacy-generalization/evaluator";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const valueFor = (name: string) => {
    const inline = args.find((argument) => argument.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] ?? "" : "";
};
const rwlPath = resolve(valueFor("--rwl"));
const outPath = resolve(valueFor("--out"));
const outputPath = resolve(valueFor("--output"));
const runtimeStagesArgument = valueFor("--runtime-stages");
const sourceText = readFileSync(rwlPath, "utf8");
stopMarker.value = await detectPrecision(sourceText);
const loaded = await loadRwl(rwlPath, "tucson-auto", {
    preserveNegativeMeasurements: true,
});
const out = readFileSync(outPath, "utf8");
const jsReport = generateCofecha606JsReport(loaded.siteData, {
    jobName: out.match(/\bRun\s+(\S+)/)?.[1] ?? "FULL",
    inputFileName: basename(rwlPath),
    useAutoregressiveModel: /Autoregressive model applied/.test(out),
    useLogTransform: /Series transformed to logarithms/.test(out),
});

const integer = (pattern: RegExp) => Number(out.match(pattern)?.[1]);
const decimal = (pattern: RegExp) => Number(out.match(pattern)?.[1]);
const span = (pattern: RegExp): Cofecha606YearSpan | null => {
    const match = out.match(pattern);
    return match ? {
        startYear: Number(match[1]),
        endYear: Number(match[2]),
        years: Number(match[3]),
    } : null;
};

const actualPart1 = {
    masterTimeSpan: span(/Time span of Master dating series is\s+(-?\d+)\s+to\s+(-?\d+)\s+(\d+) years/),
    continuousTimeSpan: span(/Continuous time span is\s+(-?\d+)\s+to\s+(-?\d+)\s+(\d+) years/),
    twoOrMoreSeriesSpan: span(/Portion with two or more series is\s+(-?\d+)\s+to\s+(-?\d+)\s+(\d+) years/),
    datedSeriesCount: integer(/Number of dated series\s+(\d+)/),
    totalRings: integer(/Total rings in all series\s+(\d+)/),
    totalDatedRingsChecked: integer(/Total dated rings checked\s+(\d+)/),
    absentRingCount: integer(/^\s*(\d+) absent rings\s+[\d.]+%/m),
    absentRingPercent: decimal(/^\s*\d+ absent rings\s+([\d.]+)%/m),
    meanSeriesLength: decimal(/Mean length of series\s+([\d.]+)/),
};

const part2Heading = /PART 2:\s+TIME PLOT OF TREE-RING SERIES:/;
const part2Start = out.search(part2Heading);
const part2Text = part2Start >= 0
    ? out.slice(part2Start).split(/PART 3:/)[0] ?? ""
    : "";
const actualPart2 = new Map<number, {
    sequence: number;
    seriesId: string;
    startYear: number;
    endYear: number;
    years: number;
}>();
for (const match of part2Text.matchAll(
    /\s(\S+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s*$/gm,
)) {
    const sequence = Number(match[2]);
    const startYear = Number(match[3]);
    const endYear = Number(match[4]);
    const years = Number(match[5]);
    if (years !== endYear - startYear + 1) continue;
    actualPart2.set(sequence, {
        sequence,
        seriesId: match[1],
        startYear,
        endYear,
        years,
    });
}

const partSevenHeading = /PART 7:\s+DESCRIPTIVE STATISTICS:/;
const partSevenStart = out.search(partSevenHeading);
const partSevenText = partSevenStart >= 0 ? out.slice(partSevenStart) : "";
const actualPart7 = new Map<number, number[]>();
partSevenText.split(/\r?\n/).forEach((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 17 || !/^\d+$/.test(fields[0])) return;
    const numeric = fields.map((field, index) => index === 1 ? Number.NaN : Number(field));
    if (numeric.slice(2).some((value) => !Number.isFinite(value))) return;
    actualPart7.set(Number(fields[0]), numeric);
});

const partFiveHeading = /PART 5:\s+CORRELATION OF SERIES BY SEGMENTS:/;
const partFiveStart = out.search(partFiveHeading);
const partFiveText = partFiveStart >= 0
    ? out.slice(partFiveStart).split(/PART 6:/)[0] ?? ""
    : "";
const actualPart5 = new Map<number, Array<{
    correlation: number;
    flag: "A" | "B" | null;
}>>();
partFiveText.split(/\r?\n/).forEach((line) => {
    const row = line.match(/^\s*(\d+)\s+\S+\s+-?\d+\s+-?\d+\s+(.*)$/);
    if (!row) return;
    const values = [...row[2].matchAll(/([+-]?(?:\d*\.\d+))(A|B)?/g)].map((match) => ({
        correlation: Number(match[1]),
        flag: (match[2] as "A" | "B" | undefined) ?? null,
    }));
    if (values.length === 0) return;
    const sequence = Number(row[1]);
    actualPart5.set(sequence, [...actualPart5.get(sequence) ?? [], ...values]);
});

const rounded = (value: number, digits: number) => Number(value.toFixed(digits));
const part1Comparisons = {
    masterTimeSpan: JSON.stringify(jsReport.part1.masterTimeSpan)
        === JSON.stringify(actualPart1.masterTimeSpan),
    continuousTimeSpan: JSON.stringify(jsReport.part1.continuousTimeSpan)
        === JSON.stringify(actualPart1.continuousTimeSpan),
    twoOrMoreSeriesSpan: JSON.stringify(jsReport.part1.twoOrMoreSeriesSpan)
        === JSON.stringify(actualPart1.twoOrMoreSeriesSpan),
    datedSeriesCount: jsReport.part1.datedSeriesCount === actualPart1.datedSeriesCount,
    totalRings: jsReport.part1.totalRings === actualPart1.totalRings,
    totalDatedRingsChecked: jsReport.part1.totalDatedRingsChecked
        === actualPart1.totalDatedRingsChecked,
    absentRingCount: jsReport.part1.absentRingCount === actualPart1.absentRingCount,
    absentRingPercent: Number(jsReport.part1.absentRingPercent.toFixed(3))
        === actualPart1.absentRingPercent,
    meanSeriesLength: Number(jsReport.part1.meanSeriesLength.toFixed(1))
        === actualPart1.meanSeriesLength,
    averageMeanSensitivity: Number(jsReport.part1.averageMeanSensitivity?.toFixed(3))
        === Number(out.match(/Average mean sensitivity\s+([\d.]+)/)?.[1]),
    seriesIntercorrelation: rounded(jsReport.part1.seriesIntercorrelation ?? 0, 3)
        === Number(out.match(/Series intercorrelation\s+([\d.]+)/)?.[1]),
};
const part2Mismatches = jsReport.part2.series.flatMap((row) => {
    const actual = actualPart2.get(row.sequence);
    return actual
        && actual.seriesId.toUpperCase() === row.seriesId.toUpperCase()
        && actual.startYear === row.startYear
        && actual.endYear === row.endYear
        && actual.years === row.years
        ? []
        : [{ expected: actual ?? null, actual: row }];
});
const part7Mismatches = jsReport.part7.series.flatMap((row) => {
    const actual = actualPart7.get(row.sequence);
    const comparisons = actual ? {
        startYear: row.startYear === actual[2],
        endYear: row.endYear === actual[3],
        years: row.years === actual[4],
        segmentCount: row.segmentCount === actual[5],
        correlationWithMaster: rounded(row.correlationWithMaster ?? 0, 3) === actual[7],
        unfilteredMean: rounded(row.unfiltered.mean, 2) === actual[8],
        unfilteredMaximum: rounded(row.unfiltered.maximum, 2) === actual[9],
        unfilteredSd: rounded(row.unfiltered.standardDeviation, 3) === actual[10],
        unfilteredAc: rounded(row.unfiltered.lagOneAutocorrelation, 3) === actual[11],
        meanSensitivity: rounded(row.meanSensitivity, 3) === actual[12],
        filteredMaximum: rounded(row.filtered.maximum, 2) === actual[13],
        filteredSd: rounded(row.filtered.standardDeviation, 3) === actual[14],
        filteredAc: rounded(row.filtered.lagOneAutocorrelation, 3) === actual[15],
        arOrder: row.arOrder === actual[16],
    } : null;
    return comparisons && Object.values(comparisons).every(Boolean) ? [] : [{
        sequence: row.sequence,
        seriesId: row.seriesId,
        comparisons,
        expected: actual ?? null,
        actual: row,
    }];
});
const part5Mismatches = jsReport.part5.series.flatMap((row) => {
    const expected = actualPart5.get(row.sequence) ?? [];
    const correlationMismatches = row.segments.flatMap((segment, index) => (
        expected[index]
            && Math.abs(segment.correlation - expected[index].correlation) <= 0.00501
            && segment.flag === expected[index].flag
            ? []
            : [{ index, expected: expected[index] ?? null, actual: segment }]
    ));
    return expected.length === row.segments.length && correlationMismatches.length === 0
        ? []
        : [{
            sequence: row.sequence,
            seriesId: row.seriesId,
            expectedCount: expected.length,
            actualCount: row.segments.length,
            correlationMismatches,
        }];
});
const runtimeEvaluations = runtimeStagesArgument
    ? (JSON.parse(readFileSync(resolve(runtimeStagesArgument), "utf8")) as {
        records?: Array<{
            stage?: string;
            correlations?: number[];
            bestLagIndex?: number;
        }>;
    }).records?.filter((record) => record.stage === "segmentEvaluation") ?? []
    : [];
const jsSegments = jsReport.part5.series.flatMap((series) => series.segments);
const runtimeLagMismatches = runtimeEvaluations
    .slice(0, jsSegments.length)
    .flatMap((runtime, segmentIndex) => {
    const segment = jsSegments[segmentIndex];
    if (!segment || !runtime.correlations) return [{ segmentIndex, reason: "missing" }];
    const values = segment.lagCorrelations.map((row) => row.correlation ?? -9.99);
    const mismatchedLags = values.flatMap((value, lagIndex) => (
        Math.abs(value - (runtime.correlations?.[lagIndex] ?? Number.NaN)) <= 0.0001
            ? []
            : [{ lagYears: lagIndex - 10, expected: runtime.correlations?.[lagIndex], actual: value }]
    ));
    const expectedBestLag = (runtime.bestLagIndex ?? 11) - 11;
    return mismatchedLags.length === 0 && segment.bestLagYears === expectedBestLag
        ? []
        : [{ segmentIndex, expectedBestLag, actualBestLag: segment.bestLagYears, mismatchedLags }];
    });
if (runtimeEvaluations.length > 0 && runtimeEvaluations.length < jsSegments.length) {
    runtimeLagMismatches.push({
        segmentIndex: runtimeEvaluations.length,
        reason: "missing-runtime-evaluation",
    });
}
const output = {
    schemaVersion: 1,
    rwlPath,
    outPath,
    inputStats: {
        stopMarker: stopMarker.value,
        uniqueSeriesIds: loaded.siteData.size,
    },
    part1: {
        expected: actualPart1,
        actual: jsReport.part1,
        comparisons: part1Comparisons,
        deferred: {
            seriesIntercorrelation: true,
            possibleProblemSegments: true,
        },
        passed: Object.values(part1Comparisons).every(Boolean),
    },
    part2: {
        expectedRows: actualPart2.size,
        actualRows: jsReport.part2.series.length,
        mismatches: part2Mismatches,
        passed: actualPart2.size === jsReport.part2.series.length
            && part2Mismatches.length === 0,
    },
    part3: {
        years: jsReport.part3.years.length,
    },
    part5: {
        expectedRows: actualPart5.size,
        actualRows: jsReport.part5.series.length,
        overallComparedYears: jsReport.part5.series.reduce(
            (sum, series) => sum + series.comparedYears,
            0,
        ),
        overallSeries: jsReport.part5.series.map((series) => ({
            sequence: series.sequence,
            seriesId: series.seriesId,
            comparedYears: series.comparedYears,
            correlation: series.correlationWithMaster,
        })),
        mismatches: part5Mismatches,
        passed: actualPart5.size === jsReport.part5.series.length
            && part5Mismatches.length === 0
            && runtimeLagMismatches.length === 0,
        runtimeEvaluations: runtimeEvaluations.length,
        runtimeTrailingEvaluations: Math.max(0, runtimeEvaluations.length - jsSegments.length),
        runtimeLagMismatches,
    },
    part7: {
        expectedRows: actualPart7.size,
        actualRows: jsReport.part7.series.length,
        mismatches: part7Mismatches,
        passed: actualPart7.size === jsReport.part7.series.length
            && part7Mismatches.length === 0,
    },
};
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`COFECHA_JS_REPORT_PARTS_1_4 ${JSON.stringify({
    file: basename(rwlPath),
    part1: output.part1.passed,
    part2: output.part2.passed,
    part2Mismatches: part2Mismatches.length,
    part7: output.part7.passed,
    part7Mismatches: part7Mismatches.length,
    part5: output.part5.passed,
    part5Mismatches: part5Mismatches.length,
})}`);

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

const part1Comparisons = {
    masterTimeSpan: JSON.stringify(jsReport.part1.masterTimeSpan)
        === JSON.stringify(actualPart1.masterTimeSpan),
    continuousTimeSpan: JSON.stringify(jsReport.part1.continuousTimeSpan)
        === JSON.stringify(actualPart1.continuousTimeSpan),
    twoOrMoreSeriesSpan: JSON.stringify(jsReport.part1.twoOrMoreSeriesSpan)
        === JSON.stringify(actualPart1.twoOrMoreSeriesSpan),
    datedSeriesCount: jsReport.part1.datedSeriesCount === actualPart1.datedSeriesCount,
    totalRings: jsReport.part1.totalRings === actualPart1.totalRings,
    absentRingCount: jsReport.part1.absentRingCount === actualPart1.absentRingCount,
    absentRingPercent: Number(jsReport.part1.absentRingPercent.toFixed(3))
        === actualPart1.absentRingPercent,
    meanSeriesLength: Number(jsReport.part1.meanSeriesLength.toFixed(1))
        === actualPart1.meanSeriesLength,
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
            totalDatedRingsChecked: actualPart1.totalDatedRingsChecked,
            seriesIntercorrelation: true,
            averageMeanSensitivity: true,
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
};
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`COFECHA_JS_REPORT_PARTS_1_4 ${JSON.stringify({
    file: basename(rwlPath),
    part1: output.part1.passed,
    part2: output.part2.passed,
    part2Mismatches: part2Mismatches.length,
})}`);

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
    possibleProblemSegments: integer(/Segments, possible problems\s+(\d+)/),
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

type ParsedInfluencePoint = {
    year: number;
    effect: number;
    relation: "greater" | "lesser" | null;
};
const parseInfluenceLine = (line: string | undefined) => {
    const lowerText = line?.match(/Lower\s+(.*?)\s+Higher\s+(.*)$/)?.[1] ?? "";
    const higherText = line?.match(/Lower\s+(.*?)\s+Higher\s+(.*)$/)?.[2] ?? "";
    const parse = (text: string): ParsedInfluencePoint[] => [
        ...text.matchAll(/(-?\d+)([<>])?\s+([+-]?(?:\d*\.\d+))/g),
    ].map((match) => ({
        year: Number(match[1]),
        effect: Number(match[3]),
        relation: match[2] === ">"
            ? "greater"
            : match[2] === "<"
                ? "lesser"
                : null,
    }));
    return { lower: parse(lowerText), higher: parse(higherText) };
};
const partSixStart = out.lastIndexOf("PART 6:  POTENTIAL PROBLEMS:");
const partSixEnd = out.lastIndexOf("PART 7:");
const partSixText = partSixStart >= 0 && partSixEnd > partSixStart
    ? out.slice(partSixStart, partSixEnd)
    : "";
const actualPart6 = new Map<number, {
    overallCorrelation: number;
    lower: ParsedInfluencePoint[];
    higher: ParsedInfluencePoint[];
    segmentInfluences: Array<{
        startYear: number;
        endYear: number;
        lower: ParsedInfluencePoint[];
        higher: ParsedInfluencePoint[];
    }>;
    divergentChanges: Array<{
        fromYear: number;
        toYear: number;
        standardDeviations: number;
    }>;
    absentRings: Array<{
        year: number;
        masterValue: number;
        sampleDepth: number;
        absentCount: number;
        warningNotUsuallyNarrow: boolean;
    }>;
    outliers: Array<{ year: number; standardDeviations: number }>;
}>();
const partSixHeaders = [...partSixText.matchAll(
    /^\s*(\S+)\s+(-?\d+)\s+to\s+(-?\d+)\s+\d+\s+years\s+Series\s+(\d+)\s*$/gm,
)];
partSixHeaders.forEach((header, headerIndex) => {
    const blockStart = (header.index ?? 0) + header[0].length;
    const blockEnd = partSixHeaders[headerIndex + 1]?.index ?? partSixText.length;
    const block = partSixText.slice(blockStart, blockEnd);
    const overall = block.match(
        /\[B\] Entire series, effect on correlation \(\s*([+-]?(?:\d*\.\d+))\) is:\s*\r?\n([^\r\n]+)/,
    );
    const overallInfluence = parseInfluenceLine(overall?.[2]);
    const segmentInfluences = [...block.matchAll(
        /^\s*(-?\d+)\s+to\s+(-?\d+)\s+segment:\s*\r?\n([^\r\n]+)/gm,
    )].map((match) => ({
        startYear: Number(match[1]),
        endYear: Number(match[2]),
        ...parseInfluenceLine(match[3]),
    }));
    const divergentBlock = block.match(
        /\[C\] Year-to-year changes diverging by over\s+[\d.]+\s+std deviations:\s*([\s\S]*?)(?=\r?\n\s*\[[DE]\]|\r?\n\s*=)/,
    )?.[1] ?? "";
    const divergentChanges = [...divergentBlock.matchAll(
        /(-?\d+)\s+(-?\d+)\s+([+-]?(?:\d*\.\d+))\s+SD/g,
    )].map((match) => ({
        fromYear: Number(match[1]),
        toYear: Number(match[2]),
        standardDeviations: Number(match[3]),
    }));
    const absentBlock = block.match(
        /\[D\]\s+\d+\s+Absent rings:[^\r\n]*\r?\n([\s\S]*?)(?=\r?\n\s*\[[E]\]|\r?\n\s*=)/,
    )?.[1] ?? "";
    const absentRings = [...absentBlock.matchAll(
        /^\s*(-?\d+)\s+([+-]?(?:\d*\.\d+))\s+(\d+)\s+(\d+)(.*)$/gm,
    )].map((match) => ({
        year: Number(match[1]),
        masterValue: Number(match[2]),
        sampleDepth: Number(match[3]),
        absentCount: Number(match[4]),
        warningNotUsuallyNarrow: /WARNING/.test(match[5]),
    }));
    const outlierBlock = block.match(
        /\[E\] Outliers\s+\d+[^\r\n]*\r?\n([\s\S]*?)(?=\r?\n\s*=)/,
    )?.[1] ?? "";
    const outliers = [...outlierBlock.matchAll(
        /(-?\d+)\s*([+-](?:\d*\.\d+))\s+SD/g,
    )].map((match) => ({
        year: Number(match[1]),
        standardDeviations: Number(match[2]),
    }));
    actualPart6.set(Number(header[4]), {
        overallCorrelation: Number(overall?.[1]),
        ...overallInfluence,
        segmentInfluences,
        divergentChanges,
        absentRings,
        outliers,
    });
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
    possibleProblemSegments: jsReport.part1.possibleProblemSegments
        === actualPart1.possibleProblemSegments,
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
        flagCount: row.flagCount === actual[6],
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
const influenceMatches = (
    actual: readonly { year: number; effect: number; relation?: string | null }[],
    expected: readonly { year: number; effect: number; relation?: string | null }[],
    compareRelation: boolean,
) => {
    if (actual.length !== expected.length) return false;
    const unmatched = [...expected];
    return actual.every((point) => {
        const matchIndex = unmatched.findIndex((candidate) => (
            point.year === candidate.year
            && Math.abs(point.effect - candidate.effect) <= 0.00051
            && (!compareRelation || point.relation === candidate.relation)
        ));
        if (matchIndex < 0) return false;
        unmatched.splice(matchIndex, 1);
        return true;
    });
};
const part6Mismatches = jsReport.part6.series.flatMap((series) => {
    const expected = actualPart6.get(series.sequence);
    if (!expected) return [{ sequence: series.sequence, seriesId: series.seriesId, reason: "missing" }];
    const segmentInfluencesMatch = series.segmentInfluences.length
        === expected.segmentInfluences.length
        && series.segmentInfluences.every((segment, index) => {
            const expectedSegment = expected.segmentInfluences[index];
            return segment.startYear === expectedSegment?.startYear
                && segment.endYear === expectedSegment?.endYear
                && influenceMatches(
                    segment.influence.lower,
                    expectedSegment?.lower ?? [],
                    true,
                )
                && influenceMatches(
                    segment.influence.higher,
                    expectedSegment?.higher ?? [],
                    false,
                );
        });
    const divergentChangesMatch = series.divergentChanges.length
        === expected.divergentChanges.length
        && series.divergentChanges.every((event, index) => (
            event.fromYear === expected.divergentChanges[index]?.fromYear
            && event.toYear === expected.divergentChanges[index]?.toYear
            && Math.abs(event.standardDeviations
                - (expected.divergentChanges[index]?.standardDeviations ?? Number.NaN)) <= 0.051
        ));
    const absentRingsMatch = series.absentRings.length === expected.absentRings.length
        && series.absentRings.every((event, index) => (
            event.year === expected.absentRings[index]?.year
            && Math.abs(event.masterValue
                - (expected.absentRings[index]?.masterValue ?? Number.NaN)) <= 0.00051
            && event.sampleDepth === expected.absentRings[index]?.sampleDepth
            && event.absentCount === expected.absentRings[index]?.absentCount
            && event.warningNotUsuallyNarrow
                === expected.absentRings[index]?.warningNotUsuallyNarrow
        ));
    const outliersMatch = series.outliers.length === expected.outliers.length
        && series.outliers.every((event, index) => (
            event.year === expected.outliers[index]?.year
            && Math.abs(event.standardDeviations
                - (expected.outliers[index]?.standardDeviations ?? Number.NaN)) <= 0.051
        ));
    const comparisons = {
        overallCorrelation: Math.abs(series.overallInfluence.correlation
            - expected.overallCorrelation) <= 0.00051,
        lower: influenceMatches(series.overallInfluence.lower, expected.lower, true),
        higher: influenceMatches(series.overallInfluence.higher, expected.higher, false),
        segmentInfluences: segmentInfluencesMatch,
        divergentChanges: divergentChangesMatch,
        absentRings: absentRingsMatch,
        outliers: outliersMatch,
    };
    return Object.values(comparisons).every(Boolean) ? [] : [{
        sequence: series.sequence,
        seriesId: series.seriesId,
        comparisons,
        expected: {
            overallCorrelation: expected.overallCorrelation,
            lower: expected.lower,
            higher: expected.higher,
            segmentInfluences: expected.segmentInfluences,
            divergentChanges: expected.divergentChanges,
            absentRings: expected.absentRings,
            outliers: expected.outliers,
        },
        actual: {
            overallCorrelation: series.overallInfluence.correlation,
            lower: series.overallInfluence.lower,
            higher: series.overallInfluence.higher,
            segmentInfluences: series.segmentInfluences,
            divergentChanges: series.divergentChanges,
            absentRings: series.absentRings,
            outliers: series.outliers,
        },
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
    part6: {
        expectedRows: actualPart6.size,
        actualRows: jsReport.part6.series.length,
        outlierStandardDeviation: jsReport.part6.outlierStandardDeviation,
        mismatches: part6Mismatches,
        passed: actualPart6.size === jsReport.part6.series.length
            && part6Mismatches.length === 0,
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
    part6: output.part6.passed,
    part6Mismatches: part6Mismatches.length,
})}`);

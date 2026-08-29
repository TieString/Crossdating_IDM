import type { RwlSiteData } from "@/features/rwl/types";
import {
    COFECHA_REFERENCE_DEFAULT_OPTIONS,
    buildCofecha606MasterSeries,
    splitCofecha606SeriesSegments,
    type CofechaReferenceOptions,
} from "@/features/crossdating/reference";

export type Cofecha606ReportPart = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type Cofecha606JsReportOptions = {
    jobName: string;
    inputFileName: string;
    title?: string;
    runAt?: Date;
    splineRigidityYears?: number;
    splineFrequencyResponse?: number;
    segmentLength?: number;
    segmentLag?: number;
    useAutoregressiveModel?: boolean;
    useLogTransform?: boolean;
    correlationMethod?: "pearson";
    saveMaster?: boolean;
    listMeasurements?: boolean;
    includedParts?: readonly Cofecha606ReportPart[];
    omitAbsentRingsFromMaster?: boolean;
};

export type Cofecha606YearSpan = {
    startYear: number;
    endYear: number;
    years: number;
};

export type Cofecha606Part2Series = {
    sequence: number;
    seriesId: string;
    segmentIndex: number;
    startYear: number;
    endYear: number;
    years: number;
    absentYears: number[];
    negativeMeasurementYears: number[];
};

export type Cofecha606Part3Year = {
    year: number;
    value: number;
    sampleDepth: number;
    absentCount: number;
};

export type Cofecha606Part4Bar = {
    year: number;
    value: number;
    direction: "negative" | "zero" | "positive";
    magnitude: number;
};

export type Cofecha606JsReport = {
    schemaVersion: 1;
    engine: "cofecha-6.06-js";
    run: {
        jobName: string;
        inputFileName: string;
        title: string;
        runAtIso: string;
    };
    options: Required<Omit<Cofecha606JsReportOptions, "runAt" | "title">> & {
        title: string;
        runAt: Date;
    };
    completedParts: Cofecha606ReportPart[];
    pendingParts: Cofecha606ReportPart[];
    part1: {
        masterTimeSpan: Cofecha606YearSpan;
        continuousTimeSpan: Cofecha606YearSpan;
        twoOrMoreSeriesSpan: Cofecha606YearSpan | null;
        datedSeriesCount: number;
        uniqueSeriesIdCount: number;
        totalRings: number;
        totalDatedRingsChecked: number | null;
        absentRingCount: number;
        absentRingPercent: number;
        meanSeriesLength: number;
        seriesIntercorrelation: number | null;
        averageMeanSensitivity: number | null;
        possibleProblemSegments: number | null;
        absentRingsBySeries: Array<{
            sequence: number;
            seriesId: string;
            years: number[];
        }>;
    };
    part2: {
        series: Cofecha606Part2Series[];
    };
    part3: {
        years: Cofecha606Part3Year[];
    };
    part4: {
        bars: Cofecha606Part4Bar[];
    };
    part5: null;
    part6: null;
    part7: null;
};

const DEFAULT_PARTS: Cofecha606ReportPart[] = [1, 2, 3, 4, 5, 6, 7];

const normalizeOptions = (
    input: Cofecha606JsReportOptions,
): Cofecha606JsReport["options"] => ({
    jobName: input.jobName,
    inputFileName: input.inputFileName,
    title: input.title ?? "",
    runAt: input.runAt ?? new Date(),
    splineRigidityYears: input.splineRigidityYears ?? 32,
    splineFrequencyResponse: input.splineFrequencyResponse ?? 0.5,
    segmentLength: input.segmentLength ?? 50,
    segmentLag: input.segmentLag ?? 25,
    useAutoregressiveModel: input.useAutoregressiveModel ?? true,
    useLogTransform: input.useLogTransform ?? true,
    correlationMethod: input.correlationMethod ?? "pearson",
    saveMaster: input.saveMaster ?? true,
    listMeasurements: input.listMeasurements ?? false,
    includedParts: [...input.includedParts ?? DEFAULT_PARTS],
    omitAbsentRingsFromMaster: input.omitAbsentRingsFromMaster ?? true,
});

const spanOf = (years: readonly number[]): Cofecha606YearSpan => {
    const sorted = [...years].sort((left, right) => left - right);
    return {
        startYear: sorted[0],
        endYear: sorted[sorted.length - 1],
        years: sorted[sorted.length - 1] - sorted[0] + 1,
    };
};

const longestContinuousSpan = (
    years: readonly number[],
): Cofecha606YearSpan | null => {
    if (years.length === 0) return null;
    const sorted = [...new Set(years)].sort((left, right) => left - right);
    const spans: number[][] = [];
    sorted.forEach((year) => {
        const current = spans[spans.length - 1];
        if (!current || year !== current[current.length - 1] + 1) spans.push([year]);
        else current.push(year);
    });
    const selected = spans.sort((left, right) => (
        right.length - left.length
        || right[right.length - 1] - left[left.length - 1]
    ))[0];
    return spanOf(selected);
};

const toReferenceOptions = (
    options: Cofecha606JsReport["options"],
): CofechaReferenceOptions => ({
    ...COFECHA_REFERENCE_DEFAULT_OPTIONS,
    splineRigidityYears: options.splineRigidityYears,
    splineFrequencyResponse: options.splineFrequencyResponse,
    useAutoregressiveModel: options.useAutoregressiveModel,
    useLogTransform: options.useLogTransform,
    omitAbsentRingsFromMaster: options.omitAbsentRingsFromMaster,
});

export const generateCofecha606JsReport = (
    siteData: RwlSiteData,
    inputOptions: Cofecha606JsReportOptions,
): Cofecha606JsReport => {
    const options = normalizeOptions(inputOptions);
    const segments = splitCofecha606SeriesSegments(siteData);
    const master = buildCofecha606MasterSeries(siteData, toReferenceOptions(options));
    if (!master || master.data.size === 0) {
        throw new Error("COFECHA JS report requires at least one usable series segment");
    }

    const part2Series: Cofecha606Part2Series[] = segments.map((segment, index) => {
        const entries = [...segment.data.entries()].sort(([left], [right]) => left - right);
        const years = entries.map(([year]) => year);
        return {
            sequence: index + 1,
            seriesId: segment.seriesId,
            segmentIndex: segment.segmentIndex,
            startYear: years[0],
            endYear: years[years.length - 1],
            years: years.length,
            absentYears: entries.flatMap(([year, value]) => value === 0 ? [year] : []),
            negativeMeasurementYears: entries.flatMap(
                ([year, value]) => typeof value === "number" && value < 0 ? [year] : [],
            ),
        };
    });
    const allCoveredYears = part2Series.flatMap((series) => (
        Array.from(
            { length: series.endYear - series.startYear + 1 },
            (_, index) => series.startYear + index,
        )
    ));
    const masterYears = [...master.data.keys()].sort((left, right) => left - right);
    const absentCountByYear = new Map<number, number>();
    part2Series.forEach((series) => {
        series.absentYears.forEach((year) => {
            absentCountByYear.set(year, (absentCountByYear.get(year) ?? 0) + 1);
        });
    });
    const part3Years: Cofecha606Part3Year[] = masterYears.map((year) => ({
        year,
        value: master.data.get(year)!,
        sampleDepth: master.sampleDepth.get(year) ?? 0,
        absentCount: absentCountByYear.get(year) ?? 0,
    }));
    const totalRings = part2Series.reduce((sum, series) => sum + series.years, 0);
    const absentRingCount = part2Series.reduce(
        (sum, series) => sum + series.absentYears.length,
        0,
    );
    const twoOrMoreSeriesSpan = longestContinuousSpan(
        part3Years.filter((row) => row.sampleDepth >= 2).map((row) => row.year),
    );
    const masterTimeSpan = spanOf(allCoveredYears);
    const continuousTimeSpan = spanOf(masterYears);
    const reportedTwoOrMoreSeriesSpan = masterTimeSpan.startYear !== continuousTimeSpan.startYear
        || masterTimeSpan.endYear !== continuousTimeSpan.endYear
        ? continuousTimeSpan
        : twoOrMoreSeriesSpan;

    return {
        schemaVersion: 1,
        engine: "cofecha-6.06-js",
        run: {
            jobName: options.jobName,
            inputFileName: options.inputFileName,
            title: options.title,
            runAtIso: options.runAt.toISOString(),
        },
        options,
        completedParts: [2, 3, 4],
        pendingParts: [1, 5, 6, 7],
        part1: {
            masterTimeSpan,
            continuousTimeSpan,
            twoOrMoreSeriesSpan: reportedTwoOrMoreSeriesSpan,
            datedSeriesCount: part2Series.length,
            uniqueSeriesIdCount: siteData.size,
            totalRings,
            totalDatedRingsChecked: null,
            absentRingCount,
            absentRingPercent: totalRings > 0 ? absentRingCount / totalRings * 100 : 0,
            meanSeriesLength: part2Series.length > 0 ? totalRings / part2Series.length : 0,
            seriesIntercorrelation: null,
            averageMeanSensitivity: null,
            possibleProblemSegments: null,
            absentRingsBySeries: part2Series
                .filter((series) => series.absentYears.length > 0)
                .map((series) => ({
                    sequence: series.sequence,
                    seriesId: series.seriesId,
                    years: series.absentYears,
                })),
        },
        part2: { series: part2Series },
        part3: { years: part3Years },
        part4: {
            bars: part3Years.map((row) => ({
                year: row.year,
                value: row.value,
                direction: row.value > 0 ? "positive" : row.value < 0 ? "negative" : "zero",
                magnitude: Math.abs(row.value),
            })),
        },
        part5: null,
        part6: null,
        part7: null,
    };
};

const spanText = (span: Cofecha606YearSpan | null) => (
    span ? `${span.startYear} to ${span.endYear}  ${span.years} years` : "none"
);

const fixed = (value: number, digits: number) => {
    const text = value.toFixed(digits);
    return text === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : text;
};

export const formatCofecha606JsReport = (
    report: Cofecha606JsReport,
): string => {
    const lines: string[] = [];
    const push = (...rows: string[]) => lines.push(...rows);
    push(
        `Dendrochronology Program Library  Run ${report.run.jobName}`,
        `PROGRAM COFECHA 6.06-compatible JS  ${report.run.runAtIso}`,
        "",
        "QUALITY CONTROL AND DATING CHECK OF TREE-RING MEASUREMENTS",
        `File of DATED series: ${report.run.inputFileName}`,
        report.run.title ? `Title: ${report.run.title}` : "",
        "",
        "PART 1: OPTIONS AND SUMMARY",
        `Spline 50% wavelength cutoff: ${report.options.splineRigidityYears} years`,
        `Segments: ${report.options.segmentLength} years lagged by ${report.options.segmentLag} years`,
        `AR modeling: ${report.options.useAutoregressiveModel ? "Y" : "N"}`,
        `Log transformation: ${report.options.useLogTransform ? "Y" : "N"}`,
        `Correlation: ${report.options.correlationMethod}`,
        `Absent rings omitted from master: ${report.options.omitAbsentRingsFromMaster ? "Y" : "N"}`,
        `Time span of Master dating series: ${spanText(report.part1.masterTimeSpan)}`,
        `Continuous time span: ${spanText(report.part1.continuousTimeSpan)}`,
        `Portion with two or more series: ${spanText(report.part1.twoOrMoreSeriesSpan)}`,
        `Number of dated series: ${report.part1.datedSeriesCount}`,
        `Total rings: ${report.part1.totalRings}`,
        `Total dated rings checked: ${report.part1.totalDatedRingsChecked ?? "pending Part 7"}`,
        `Mean length of series: ${fixed(report.part1.meanSeriesLength, 1)}`,
        `Absent rings: ${report.part1.absentRingCount} (${fixed(report.part1.absentRingPercent, 3)}%)`,
        "",
    );
    report.part1.absentRingsBySeries.forEach((series) => {
        push(`${series.seriesId}  ${series.years.length} absent rings: ${series.years.join(" ")}`);
    });

    push("", "PART 2: TIME SPANS", "Seq Series Segment Start End Years");
    report.part2.series.forEach((series) => {
        push([
            String(series.sequence).padStart(4, " "),
            series.seriesId.padEnd(8, " "),
            String(series.segmentIndex).padStart(3, " "),
            String(series.startYear).padStart(6, " "),
            String(series.endYear).padStart(6, " "),
            String(series.years).padStart(6, " "),
        ].join(" "));
    });

    push("", "PART 3: MASTER DATING SERIES", "Year Value Depth Absent");
    report.part3.years.forEach((row) => {
        push([
            String(row.year).padStart(6, " "),
            fixed(row.value, 4).padStart(9, " "),
            String(row.sampleDepth).padStart(5, " "),
            String(row.absentCount).padStart(6, " "),
        ].join(" "));
    });

    push("", "PART 4: MASTER BAR DATA", "Year Value Direction Magnitude");
    report.part4.bars.forEach((row) => {
        push([
            String(row.year).padStart(6, " "),
            fixed(row.value, 4).padStart(9, " "),
            row.direction.padStart(8, " "),
            fixed(row.magnitude, 4).padStart(9, " "),
        ].join(" "));
    });

    return `${lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n")}\n`;
};

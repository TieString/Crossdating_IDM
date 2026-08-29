import type { RwlSiteData } from "@/features/rwl/types";
import {
    COFECHA_REFERENCE_DEFAULT_OPTIONS,
    buildCofecha606MasterSeries,
    cofecha606ExtendedMultiplyAdd,
    cofecha606StandardizeValues,
    splitCofecha606SeriesSegments,
    type CofechaReferenceOptions,
} from "@/features/crossdating/reference";
import {
    cofecha606Pearson,
    prepareCofecha606SeriesForReport,
    type Cofecha606DescriptiveStats,
} from "./jsReportSeries";

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

export type Cofecha606Part7Series = {
    sequence: number;
    seriesId: string;
    segmentIndex: number;
    startYear: number;
    endYear: number;
    years: number;
    segmentCount: number;
    flagCount: number | null;
    correlationWithMaster: number | null;
    unfiltered: Cofecha606DescriptiveStats;
    meanSensitivity: number;
    filtered: Cofecha606DescriptiveStats;
    arOrder: number;
};

export type Cofecha606Part5Segment = {
    startYear: number;
    endYear: number;
    analysisStartYear: number;
    analysisEndYear: number;
    correlation: number;
    comparedYears: number;
    flag: "A" | "B" | null;
    bestLagYears: number;
    bestCorrelation: number;
    lagCorrelations: Array<{
        lagYears: number;
        correlation: number | null;
        comparedYears: number;
    }>;
};

export type Cofecha606Part5Series = {
    sequence: number;
    seriesId: string;
    segmentIndex: number;
    startYear: number;
    endYear: number;
    correlationWithMaster: number;
    comparedYears: number;
    segments: Cofecha606Part5Segment[];
};

export type Cofecha606InfluencePoint = {
    year: number;
    effect: number;
    relation: "greater" | "lesser" | "equal";
};

export type Cofecha606InfluenceSummary = {
    correlation: number;
    lower: Cofecha606InfluencePoint[];
    higher: Cofecha606InfluencePoint[];
};

export type Cofecha606Part6Series = {
    sequence: number;
    seriesId: string;
    segmentIndex: number;
    startYear: number;
    endYear: number;
    uncheckedOlderSpan: Cofecha606YearSpan | null;
    uncheckedNewerSpan: Cofecha606YearSpan | null;
    firstRingAbsent: boolean;
    lastRingAbsent: boolean;
    flaggedSegments: Cofecha606Part5Segment[];
    overallInfluence: Cofecha606InfluenceSummary;
    segmentInfluences: Array<{
        startYear: number;
        endYear: number;
        influence: Cofecha606InfluenceSummary;
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
    outliers: Array<{
        year: number;
        standardDeviations: number;
    }>;
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
    part5: {
        criticalCorrelation: number;
        series: Cofecha606Part5Series[];
    };
    part6: {
        divergenceThreshold: number;
        highOutlierThreshold: number;
        lowOutlierThreshold: number;
        outlierStandardDeviation: number;
        series: Cofecha606Part6Series[];
    };
    part7: {
        series: Cofecha606Part7Series[];
        totals: {
            years: number;
            segmentCount: number;
            flagCount: number | null;
            correlationWithMaster: number | null;
            meanMeasurement: number;
            maximumMeasurement: number;
            meanMeasurementStandardDeviation: number;
            meanMeasurementAutocorrelation: number;
            meanSensitivity: number;
            maximumFilteredValue: number;
            meanFilteredStandardDeviation: number;
            meanFilteredAutocorrelation: number;
        };
    };
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

const average = (values: readonly number[]) => (
    values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
);

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
    const masterTimeSpan = spanOf(allCoveredYears);
    const continuousTimeSpan = spanOf(masterYears);
    const sortedStarts = part2Series.map((series) => series.startYear)
        .sort((left, right) => left - right);
    const sortedEnds = part2Series.map((series) => series.endYear)
        .sort((left, right) => right - left);
    const hasDisconnectedSpan = masterTimeSpan.startYear !== continuousTimeSpan.startYear
        || masterTimeSpan.endYear !== continuousTimeSpan.endYear;
    const reportedTwoOrMoreSeriesSpan = hasDisconnectedSpan
        ? continuousTimeSpan
        : part2Series.length >= 2
            ? spanOf([sortedStarts[1], sortedEnds[1]])
            : null;
    const segmentGridSpan = reportedTwoOrMoreSeriesSpan ?? continuousTimeSpan;
    const segmentGridStartYear = Math.floor(
        segmentGridSpan.startYear / options.segmentLag,
    ) * options.segmentLag;
    const segmentGridEndYear = Math.ceil(
        (segmentGridSpan.endYear + 1) / options.segmentLag,
    ) * options.segmentLag - options.segmentLength;
    const preparedSeries = prepareCofecha606SeriesForReport(siteData, {
        ...options,
        segmentGridStartYear,
        segmentGridEndYear,
        analysisStartYear: segmentGridSpan.startYear,
        analysisEndYear: segmentGridSpan.endYear,
    });
    const part7PreparedSeries = preparedSeries.filter((series) => {
        const startYear = series.years[0];
        const endYear = series.years[series.years.length - 1];
        return endYear >= continuousTimeSpan.startYear
            && startYear <= continuousTimeSpan.endYear;
    });
    type ReferenceValueKey = "testingValues" | "masterValues";
    type ReferenceContributor = {
        seriesIndex: number;
        value: number;
    };
    const testingContributorsByYear = new Map<number, ReferenceContributor[]>();
    const masterContributorsByYear = new Map<number, ReferenceContributor[]>();
    const coverageByYear = new Map<number, Set<number>>();
    preparedSeries.forEach((series, seriesIndex) => {
        series.years.forEach((year, index) => {
            const coverage = coverageByYear.get(year) ?? new Set<number>();
            coverage.add(seriesIndex);
            coverageByYear.set(year, coverage);
            const sourceValue = series.segment.data.get(year);
            if (typeof sourceValue === "number" && sourceValue <= 0) return;
            const testingContributors = testingContributorsByYear.get(year) ?? [];
            testingContributors.push({ seriesIndex, value: series.testingValues[index] });
            testingContributorsByYear.set(year, testingContributors);
            const masterContributors = masterContributorsByYear.get(year) ?? [];
            masterContributors.push({ seriesIndex, value: series.masterValues[index] });
            masterContributorsByYear.set(year, masterContributors);
        });
    });
    const leaveOneOutReference = (
        valueKey: ReferenceValueKey,
        omittedSeriesIndex: number,
        includeTargetWhenAlone = false,
        zeroWhenUnmatched = false,
    ) => new Map(
        [...coverageByYear].flatMap(([year, coverage]) => {
            const contributors = (valueKey === "testingValues"
                ? testingContributorsByYear
                : masterContributorsByYear).get(year) ?? [];
            const retained = contributors.filter((row) => row.seriesIndex !== omittedSeriesIndex);
            const insideSharedSpan = year >= segmentGridSpan.startYear
                && year <= segmentGridSpan.endYear;
            const hasOtherCoverage = [...coverage]
                .some((seriesIndex) => seriesIndex !== omittedSeriesIndex);
            const omittedSeries = preparedSeries[omittedSeriesIndex];
            const omittedYearIndex = omittedSeries?.years.indexOf(year) ?? -1;
            const omittedSourceValue = omittedSeries?.segment.data.get(year);
            if (omittedYearIndex >= 0
                && typeof omittedSourceValue === "number"
                && omittedSourceValue < 0
                && contributors.length > 1) {
                let sum = Math.fround(0);
                contributors.forEach((row) => {
                    sum = Math.fround(sum + Math.fround(row.value));
                });
                const adjustedSum = Math.fround(
                    sum - Math.fround(omittedSeries[valueKey][omittedYearIndex]),
                );
                return [[
                    year,
                    Math.fround(adjustedSum / Math.fround(contributors.length - 1)),
                ] as const];
            }
            if (retained.length === 0 && zeroWhenUnmatched) {
                return omittedYearIndex >= 0
                    ? [[year, Math.fround(
                        omittedSourceValue === 0
                            ? 0
                            : omittedSeries[valueKey][omittedYearIndex],
                    )] as const]
                    : [];
            }
            if (contributors.length === 0) {
                return insideSharedSpan
                    ? [[year, 0] as const]
                    : [];
            }
            const selected = retained.length > 0
                ? retained
                : hasOtherCoverage || includeTargetWhenAlone && insideSharedSpan
                    ? contributors
                    : [];
            if (selected.length === 0) return [];
            let sum = Math.fround(0);
            selected.forEach((row) => {
                sum = Math.fround(sum + Math.fround(row.value));
            });
            return [[year, Math.fround(sum / Math.fround(selected.length))] as const];
        }),
    );
    const correlate = (
        series: (typeof preparedSeries)[number],
        reference: ReadonlyMap<number, number>,
        startYear?: number,
        endYear?: number,
        omitAbsentTarget = false,
        referenceLagYears = 0,
    ) => {
        const targetValues: number[] = [];
        const referenceValues: number[] = [];
        series.years.forEach((year, index) => {
            if (startYear !== undefined && year < startYear) return;
            if (endYear !== undefined && year > endYear) return;
            if (omitAbsentTarget) {
                const sourceValue = series.segment.data.get(year);
                if (sourceValue === 0) return;
            }
            const referenceValue = reference.get(year + referenceLagYears);
            if (referenceValue === undefined) return;
            targetValues.push(series.testingValues[index]);
            referenceValues.push(referenceValue);
        });
        return {
            correlation: cofecha606Pearson(targetValues, referenceValues),
            comparedYears: targetValues.length,
        };
    };
    const correlateSegmentAtLag = (
        series: (typeof preparedSeries)[number],
        reference: ReadonlyMap<number, number>,
        startYear: number,
        endYear: number,
        lagYears: number,
    ) => {
        const targetValues: number[] = [];
        const referenceValues: number[] = [];
        let completeReference = true;
        series.years.forEach((year, index) => {
            if (year < startYear || year > endYear) return;
            const sourceValue = series.segment.data.get(year);
            if (sourceValue === 0) return;
            const referenceValue = reference.get(year + lagYears);
            if (referenceValue === undefined) {
                completeReference = false;
                return;
            }
            targetValues.push(series.testingValues[index]);
            referenceValues.push(referenceValue);
        });
        return completeReference && targetValues.length >= 2
            ? {
                correlation: cofecha606Pearson(referenceValues, targetValues),
                comparedYears: targetValues.length,
            }
            : {
                correlation: null,
                comparedYears: targetValues.length,
            };
    };
    const influenceSummary = (
        years: readonly number[],
        targetValues: readonly number[],
        referenceValues: readonly number[],
    ): Cofecha606InfluenceSummary => {
        const correlation = cofecha606Pearson(targetValues, referenceValues);
        const points = years.map((year, removedIndex) => {
            const retainedTarget = targetValues.filter((_, index) => index !== removedIndex);
            const retainedReference = referenceValues.filter((_, index) => index !== removedIndex);
            const withoutPoint = cofecha606Pearson(retainedTarget, retainedReference);
            const target = targetValues[removedIndex];
            const reference = referenceValues[removedIndex];
            return {
                year,
                effect: Math.fround(correlation - withoutPoint),
                relation: target > reference
                    ? "greater" as const
                    : target < reference
                        ? "lesser" as const
                        : "equal" as const,
            };
        });
        return {
            correlation,
            lower: points.filter((point) => point.effect < 0)
                .sort((left, right) => left.effect - right.effect || left.year - right.year)
                .slice(0, 6),
            higher: points.filter((point) => point.effect > 0)
                .sort((left, right) => right.effect - left.effect || left.year - right.year)
                .slice(0, 2),
        };
    };
    const pairedValues = (
        series: (typeof preparedSeries)[number],
        reference: ReadonlyMap<number, number>,
        valueKey: ReferenceValueKey,
        startYear?: number,
        endYear?: number,
        omitAbsentTarget = false,
        referenceLagYears = 0,
    ) => {
        const years: number[] = [];
        const targetValues: number[] = [];
        const referenceValues: number[] = [];
        series.years.forEach((year, index) => {
            if (startYear !== undefined && year < startYear) return;
            if (endYear !== undefined && year > endYear) return;
            if (omitAbsentTarget && series.segment.data.get(year) === 0) return;
            const referenceValue = reference.get(year + referenceLagYears);
            if (referenceValue === undefined) return;
            years.push(year);
            targetValues.push(series[valueKey][index]);
            referenceValues.push(referenceValue);
        });
        return { years, targetValues, referenceValues };
    };
    const part5Series: Cofecha606Part5Series[] = part7PreparedSeries.map((series, index) => {
        const sourceIndex = preparedSeries.indexOf(series);
        const reference = leaveOneOutReference("testingValues", sourceIndex, true);
        const segmentReference = leaveOneOutReference("testingValues", sourceIndex, true);
        const overall = correlate(series, reference);
        return {
            sequence: index + 1,
            seriesId: series.segment.seriesId,
            segmentIndex: series.segment.segmentIndex,
            startYear: series.years[0],
            endYear: series.years[series.years.length - 1],
            correlationWithMaster: overall.correlation,
            comparedYears: overall.comparedYears,
            segments: series.segmentWindows.map((window) => {
                const lagCorrelations = Array.from({ length: 21 }, (_, index) => {
                    const lagYears = index - 10;
                    return {
                        lagYears,
                        ...correlateSegmentAtLag(
                            series,
                            segmentReference,
                            window.analysisStartYear,
                            window.analysisEndYear,
                            lagYears,
                        ),
                    };
                });
                const asDated = lagCorrelations[10];
                const best = lagCorrelations.reduce((current, candidate) => (
                    candidate.correlation !== null
                        && (current.correlation === null
                            || candidate.correlation > current.correlation)
                        ? candidate
                        : current
                ), asDated);
                const flag = best.lagYears === 0
                    ? (asDated.correlation ?? 0) < 0.3281 ? "A" : null
                    : "B";
                return {
                    ...window,
                    correlation: asDated.correlation ?? 0,
                    comparedYears: asDated.comparedYears,
                    flag,
                    bestLagYears: best.lagYears,
                    bestCorrelation: best.correlation ?? 0,
                    lagCorrelations,
                };
            }),
        };
    });
    let outlierScaleSum = Math.fround(0);
    for (
        let year = masterTimeSpan.startYear;
        year <= masterTimeSpan.endYear;
        year += 1
    ) {
        const values = masterContributorsByYear.get(year) ?? [];
        if (values.length <= 1) continue;
        let sum = Math.fround(0);
        let sumOfSquares = Math.fround(0);
        values.forEach((row) => {
            const value = Math.fround(row.value);
            sum = Math.fround(sum + value);
            sumOfSquares = Math.fround(cofecha606ExtendedMultiplyAdd(
                value,
                value,
                sumOfSquares,
            ));
        });
        const mean = Math.fround(sum / Math.fround(values.length));
        const varianceNumerator = Math.abs(
            sumOfSquares - mean * mean * values.length,
        );
        const standardDeviation = Math.fround(Math.sqrt(
            varianceNumerator / (values.length - 1),
        ));
        outlierScaleSum = Math.fround(outlierScaleSum + standardDeviation);
    }
    const outlierStandardDeviation = Math.fround(
        outlierScaleSum / Math.fround(continuousTimeSpan.years),
    );
    const part6Series: Cofecha606Part6Series[] = part7PreparedSeries.map(
        (series, index) => {
            const sourceIndex = preparedSeries.indexOf(series);
            const testingReference = leaveOneOutReference(
                "testingValues",
                sourceIndex,
                true,
            );
            const masterReference = leaveOneOutReference(
                "masterValues",
                sourceIndex,
                true,
                true,
            );
            const strictChangeReference = leaveOneOutReference(
                "masterValues",
                sourceIndex,
            );
            const overallPairs = pairedValues(
                series,
                testingReference,
                "testingValues",
            );
            const flaggedSegments = part5Series[index].segments.filter(
                (segment) => segment.flag !== null,
            );
            const segmentInfluences = flaggedSegments.map((segment) => {
                const pairs = pairedValues(
                    series,
                    testingReference,
                    "testingValues",
                    segment.analysisStartYear,
                    segment.analysisEndYear,
                );
                return {
                    startYear: segment.analysisStartYear,
                    endYear: segment.analysisEndYear,
                    influence: influenceSummary(
                        pairs.years,
                        pairs.targetValues,
                        pairs.referenceValues,
                    ),
                };
            });
            const masterPairs = pairedValues(
                series,
                masterReference,
                "masterValues",
            );
            const strictChangePairs = pairedValues(
                series,
                strictChangeReference,
                "masterValues",
            );
            const changePairs = hasDisconnectedSpan
                && series.years[0] === continuousTimeSpan.startYear
                ? masterPairs
                : strictChangePairs;
            const targetDifferences: number[] = changePairs.years.length > 0 ? [0] : [];
            const referenceDifferences: number[] = changePairs.years.length > 0 ? [0] : [];
            for (let pairIndex = 1; pairIndex < changePairs.years.length; pairIndex += 1) {
                if (changePairs.years[pairIndex] !== changePairs.years[pairIndex - 1] + 1) {
                    targetDifferences.push(0);
                    referenceDifferences.push(0);
                    continue;
                }
                targetDifferences.push(Math.fround(
                    changePairs.targetValues[pairIndex]
                        - changePairs.targetValues[pairIndex - 1],
                ));
                referenceDifferences.push(Math.fround(
                    changePairs.referenceValues[pairIndex]
                        - changePairs.referenceValues[pairIndex - 1],
                ));
            }
            const standardizedTargetDifferences = cofecha606StandardizeValues(
                targetDifferences,
            );
            const standardizedReferenceDifferences = cofecha606StandardizeValues(
                referenceDifferences,
            );
            const divergentChanges = changePairs.years.flatMap((toYear, diffIndex) => {
                if (diffIndex === 0
                    || toYear !== changePairs.years[diffIndex - 1] + 1) return [];
                const standardDeviations = Math.fround(
                    standardizedTargetDifferences[diffIndex]
                        - standardizedReferenceDifferences[diffIndex],
                );
                return Math.abs(standardDeviations) >= 4
                    ? [{
                        fromYear: toYear - 1,
                        toYear,
                        standardDeviations,
                    }]
                    : [];
            });
            const outliers = masterPairs.years.flatMap((year, pairIndex) => {
                const standardDeviations = outlierStandardDeviation > 0
                    ? Math.fround(
                        (masterPairs.targetValues[pairIndex]
                            - masterPairs.referenceValues[pairIndex])
                                / outlierStandardDeviation,
                    )
                    : 0;
                return standardDeviations > 3 || standardDeviations < -4.5
                    ? [{ year, standardDeviations }]
                    : [];
            });
            const absentYears = [...series.segment.data.entries()]
                .flatMap(([year, value]) => value === 0 ? [year] : [])
                .sort((left, right) => left - right);
            const firstCheckedYear = overallPairs.years[0];
            const lastCheckedYear = overallPairs.years[overallPairs.years.length - 1];
            return {
                sequence: index + 1,
                seriesId: series.segment.seriesId,
                segmentIndex: series.segment.segmentIndex,
                startYear: series.years[0],
                endYear: series.years[series.years.length - 1],
                uncheckedOlderSpan: firstCheckedYear > series.years[0]
                    ? spanOf([series.years[0], firstCheckedYear - 1])
                    : null,
                uncheckedNewerSpan: lastCheckedYear < series.years[series.years.length - 1]
                    ? spanOf([lastCheckedYear + 1, series.years[series.years.length - 1]])
                    : null,
                firstRingAbsent: series.segment.data.get(series.years[0]) === 0,
                lastRingAbsent: series.segment.data.get(
                    series.years[series.years.length - 1],
                ) === 0,
                flaggedSegments,
                overallInfluence: influenceSummary(
                    overallPairs.years,
                    overallPairs.targetValues,
                    overallPairs.referenceValues,
                ),
                segmentInfluences,
                divergentChanges,
                absentRings: absentYears.map((year) => {
                    const masterValue = master.data.get(year) ?? 0;
                    return {
                        year,
                        masterValue,
                        sampleDepth: master.sampleDepth.get(year) ?? 0,
                        absentCount: absentCountByYear.get(year) ?? 0,
                        warningNotUsuallyNarrow: masterValue >= -0.4,
                    };
                }),
                outliers,
            };
        },
    );
    const flagCountBySequence = new Map(part6Series.map((series) => [
        series.sequence,
        series.flaggedSegments.length,
    ]));
    const correlationBySequence = new Map(part5Series.map((series) => [
        series.sequence,
        series.correlationWithMaster,
    ]));
    const part7Series: Cofecha606Part7Series[] = part7PreparedSeries.map((series, index) => ({
        sequence: index + 1,
        seriesId: series.segment.seriesId,
        segmentIndex: series.segment.segmentIndex,
        startYear: series.years[0],
        endYear: series.years[series.years.length - 1],
        years: series.years.length,
        segmentCount: series.segmentCount,
        flagCount: flagCountBySequence.get(index + 1) ?? 0,
        correlationWithMaster: correlationBySequence.get(index + 1) ?? null,
        unfiltered: series.unfilteredStats,
        meanSensitivity: series.meanSensitivity,
        filtered: series.filteredStats,
        arOrder: series.arOrder,
    }));
    const totalDatedRingsChecked = hasDisconnectedSpan
        ? totalRings
        : part2Series.reduce((sum, series) => {
            if (!reportedTwoOrMoreSeriesSpan) return sum;
            const overlap = Math.min(series.endYear, reportedTwoOrMoreSeriesSpan.endYear)
                - Math.max(series.startYear, reportedTwoOrMoreSeriesSpan.startYear)
                + 1;
            return sum + Math.max(0, overlap);
        }, 0);
    let sensitivitySum = Math.fround(0);
    let sensitivityPairCount = 0;
    preparedSeries.forEach((series) => {
        sensitivitySum = Math.fround(sensitivitySum + series.meanSensitivitySum);
        sensitivityPairCount += series.meanSensitivityPairCount;
    });
    const weightedMeanSensitivity = sensitivityPairCount > 0
        ? Math.fround(sensitivitySum / Math.fround(sensitivityPairCount))
        : 0;
    let intercorrelationSum = Math.fround(0);
    part5Series.forEach((series) => {
        intercorrelationSum = Math.fround(
            intercorrelationSum
                + Math.fround(series.correlationWithMaster * series.comparedYears),
        );
    });
    const seriesIntercorrelation = totalDatedRingsChecked > 0
        ? Math.fround(
            intercorrelationSum / Math.fround(totalDatedRingsChecked),
        )
        : 0;

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
        completedParts: [1, 2, 3, 4, 5, 6, 7],
        pendingParts: [],
        part1: {
            masterTimeSpan,
            continuousTimeSpan,
            twoOrMoreSeriesSpan: reportedTwoOrMoreSeriesSpan,
            datedSeriesCount: part2Series.length,
            uniqueSeriesIdCount: siteData.size,
            totalRings,
            totalDatedRingsChecked,
            absentRingCount,
            absentRingPercent: totalRings > 0 ? absentRingCount / totalRings * 100 : 0,
            meanSeriesLength: part2Series.length > 0 ? totalRings / part2Series.length : 0,
            seriesIntercorrelation,
            averageMeanSensitivity: weightedMeanSensitivity,
            possibleProblemSegments: part6Series.reduce(
                (sum, series) => sum + series.flaggedSegments.length,
                0,
            ),
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
        part5: {
            criticalCorrelation: 0.3281,
            series: part5Series,
        },
        part6: {
            divergenceThreshold: 4,
            highOutlierThreshold: 3,
            lowOutlierThreshold: -4.5,
            outlierStandardDeviation,
            series: part6Series,
        },
        part7: {
            series: part7Series,
            totals: {
                years: totalRings,
                segmentCount: part7Series.reduce(
                    (sum, series) => sum + series.segmentCount,
                    0,
                ),
                flagCount: part6Series.reduce(
                    (sum, series) => sum + series.flaggedSegments.length,
                    0,
                ),
                correlationWithMaster: seriesIntercorrelation,
                meanMeasurement: average(part7Series.map((series) => series.unfiltered.mean)),
                maximumMeasurement: Math.max(
                    ...part7Series.map((series) => series.unfiltered.maximum),
                ),
                meanMeasurementStandardDeviation: average(
                    part7Series.map((series) => series.unfiltered.standardDeviation),
                ),
                meanMeasurementAutocorrelation: average(
                    part7Series.map((series) => series.unfiltered.lagOneAutocorrelation),
                ),
                meanSensitivity: weightedMeanSensitivity,
                maximumFilteredValue: Math.max(
                    ...part7Series.map((series) => series.filtered.maximum),
                ),
                meanFilteredStandardDeviation: average(
                    part7Series.map((series) => series.filtered.standardDeviation),
                ),
                meanFilteredAutocorrelation: average(
                    part7Series.map((series) => series.filtered.lagOneAutocorrelation),
                ),
            },
        },
    };
};

const spanText = (span: Cofecha606YearSpan | null) => (
    span ? `${span.startYear} to ${span.endYear}  ${span.years} years` : "none"
);

const fixed = (value: number, digits: number) => {
    const text = value.toFixed(digits);
    return text === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : text;
};

const fixedCorrelation = (value: number, digits: number) => fixed(
    value === 0 ? 0 : value + Math.sign(value) * 0.000001,
    digits,
);

const signedFixed = (value: number, digits: number) => (
    `${value >= 0 ? "+" : ""}${fixed(value, digits)}`
);

const influenceText = (summary: Cofecha606InfluenceSummary) => {
    const lower = summary.lower.map((point) => (
        `${point.year}${point.relation === "greater" ? ">" : point.relation === "lesser" ? "<" : "="}`
        + ` ${signedFixed(point.effect, 3)}`
    )).join("  ");
    const higher = summary.higher.map((point) => (
        `${point.year} ${signedFixed(point.effect, 3)}`
    )).join("  ");
    return `Lower ${lower}  Higher ${higher}`;
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
        `Series intercorrelation: ${fixedCorrelation(report.part1.seriesIntercorrelation ?? 0, 3)}`,
        `Average mean sensitivity: ${fixed(report.part1.averageMeanSensitivity ?? 0, 3)}`,
        `Segments with possible problems: ${report.part1.possibleProblemSegments ?? "pending Part 6"}`,
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

    push(
        "",
        "PART 5: CORRELATION OF SERIES BY SEGMENTS",
        `Critical correlation: ${fixed(report.part5.criticalCorrelation, 4)}`,
        "Seq Series Time span Segment Correlation Flag Best lag Best correlation",
    );
    report.part5.series.forEach((series) => {
        series.segments.forEach((segment) => {
            push([
                String(series.sequence).padStart(4, " "),
                series.seriesId.padEnd(8, " "),
                `${series.startYear}-${series.endYear}`.padStart(13, " "),
                `${segment.startYear}-${segment.endYear}`.padStart(13, " "),
                fixedCorrelation(segment.correlation, 2).padStart(6, " "),
                (segment.flag ?? "").padStart(4, " "),
                String(segment.bestLagYears).padStart(8, " "),
                fixedCorrelation(segment.bestCorrelation, 2).padStart(16, " "),
            ].join(" "));
        });
    });

    push(
        "",
        "PART 6: POTENTIAL PROBLEMS",
        `[A] Flagged segment lag correlations; [B] point influence; [C] first-difference divergence; [D] absent rings; [E] outliers`,
    );
    report.part6.series.forEach((series) => {
        push(
            "",
            `${series.seriesId} ${series.startYear} to ${series.endYear}  Series ${series.sequence}`,
        );
        if (series.uncheckedOlderSpan) {
            push(`[*] Older part cannot be checked: ${spanText(series.uncheckedOlderSpan)}`);
        }
        if (series.uncheckedNewerSpan) {
            push(`[*] Newer part cannot be checked: ${spanText(series.uncheckedNewerSpan)}`);
        }
        series.flaggedSegments.forEach((segment) => {
            push(
                `[A] ${segment.analysisStartYear}-${segment.analysisEndYear}  as dated ${fixedCorrelation(segment.correlation, 2)}  best lag ${segment.bestLagYears >= 0 ? "+" : ""}${segment.bestLagYears} (${fixedCorrelation(segment.bestCorrelation, 2)})  ${segment.flag}`,
                `    ${segment.lagCorrelations.map((row) => (
                    `${row.lagYears >= 0 ? "+" : ""}${row.lagYears}:${row.correlation === null ? "NA" : fixedCorrelation(row.correlation, 2)}`
                )).join(" ")}`,
            );
        });
        push(
            `[B] Entire series, effect on correlation (${fixedCorrelation(series.overallInfluence.correlation, 3)}):`,
            `    ${influenceText(series.overallInfluence)}`,
        );
        series.segmentInfluences.forEach((segment) => {
            push(
                `[B] ${segment.startYear}-${segment.endYear} segment:`,
                `    ${influenceText(segment.influence)}`,
            );
        });
        if (series.divergentChanges.length > 0) {
            push(
                `[C] Year-to-year changes diverging by at least ${fixed(report.part6.divergenceThreshold, 1)} SD:`,
                `    ${series.divergentChanges.map((event) => (
                    `${event.fromYear}-${event.toYear} ${signedFixed(event.standardDeviations, 1)} SD`
                )).join("; ")}`,
            );
        }
        if (series.absentRings.length > 0) {
            push("[D] Absent rings: Year Master Depth Absent Warning");
            series.absentRings.forEach((event) => {
                push([
                    String(event.year).padStart(6, " "),
                    fixedCorrelation(event.masterValue, 3).padStart(7, " "),
                    String(event.sampleDepth).padStart(5, " "),
                    String(event.absentCount).padStart(6, " "),
                    event.warningNotUsuallyNarrow ? "not usually narrow" : "",
                ].join(" "));
            });
            if (series.firstRingAbsent) push("    WARNING: First ring in series is absent");
            if (series.lastRingAbsent) push("    WARNING: Last ring in series is absent");
        }
        if (series.outliers.length > 0) {
            push(
                `[E] Outliers (${fixed(report.part6.highOutlierThreshold, 1)} SD above or ${fixed(report.part6.lowOutlierThreshold, 1)} SD below):`,
                `    ${series.outliers.map((event) => (
                    `${event.year} ${signedFixed(event.standardDeviations, 1)} SD`
                )).join("; ")}`,
            );
        }
    });

    push(
        "",
        "PART 7: DESCRIPTIVE STATISTICS",
        "Seq Series Interval Years Segments Flags Master Mean Max SD Auto Sens FMax FSD FAuto AR",
    );
    report.part7.series.forEach((row) => {
        push([
            String(row.sequence).padStart(4, " "),
            row.seriesId.padEnd(8, " "),
            String(row.startYear).padStart(6, " "),
            String(row.endYear).padStart(6, " "),
            String(row.years).padStart(5, " "),
            String(row.segmentCount).padStart(4, " "),
            String(row.flagCount ?? "pending").padStart(7, " "),
            (row.correlationWithMaster === null
                ? "pending"
                : fixedCorrelation(row.correlationWithMaster, 3)).padStart(7, " "),
            fixed(row.unfiltered.mean, 2).padStart(6, " "),
            fixed(row.unfiltered.maximum, 2).padStart(6, " "),
            fixed(row.unfiltered.standardDeviation, 3).padStart(7, " "),
            fixed(row.unfiltered.lagOneAutocorrelation, 3).padStart(7, " "),
            fixed(row.meanSensitivity, 3).padStart(6, " "),
            fixed(row.filtered.maximum, 2).padStart(6, " "),
            fixed(row.filtered.standardDeviation, 3).padStart(7, " "),
            fixed(row.filtered.lagOneAutocorrelation, 3).padStart(7, " "),
            String(row.arOrder).padStart(3, " "),
        ].join(" "));
    });
    push([
        "Total or mean:".padEnd(27, " "),
        String(report.part7.totals.years).padStart(6, " "),
        String(report.part7.totals.segmentCount).padStart(6, " "),
        String(report.part7.totals.flagCount ?? 0).padStart(6, " "),
        fixedCorrelation(report.part7.totals.correlationWithMaster ?? 0, 3).padStart(8, " "),
        fixed(report.part7.totals.meanMeasurement, 2).padStart(6, " "),
        fixed(report.part7.totals.maximumMeasurement, 2).padStart(6, " "),
        fixed(report.part7.totals.meanMeasurementStandardDeviation, 3).padStart(7, " "),
        fixed(report.part7.totals.meanMeasurementAutocorrelation, 3).padStart(7, " "),
        fixed(report.part7.totals.meanSensitivity, 3).padStart(6, " "),
        fixed(report.part7.totals.maximumFilteredValue, 2).padStart(6, " "),
        fixed(report.part7.totals.meanFilteredStandardDeviation, 3).padStart(7, " "),
        fixed(report.part7.totals.meanFilteredAutocorrelation, 3).padStart(7, " "),
    ].join(" "));

    return `${lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n")}\n`;
};

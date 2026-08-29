import type { RwlSiteData } from "@/features/rwl/types";
import {
    COFECHA_REFERENCE_DEFAULT_OPTIONS,
    cofecha606AutoregressiveResidual,
    cofecha606ExtendedMultiplyAdd,
    cofecha606LogTransform,
    cofecha606StandardizeValues,
    cofechaStyleStandardize,
    splitCofecha606SeriesSegments,
    type Cofecha606SeriesSegment,
} from "@/features/crossdating/reference";
import { parseCofecha606TucsonWidth } from "@/features/crossdating/cofecha606F63";

export type Cofecha606SeriesAnalysisOptions = {
    splineRigidityYears: number;
    splineFrequencyResponse: number;
    segmentLength: number;
    segmentLag: number;
    useAutoregressiveModel: boolean;
    useLogTransform: boolean;
    segmentGridStartYear: number;
    segmentGridEndYear: number;
};

export type Cofecha606DescriptiveStats = {
    mean: number;
    maximum: number;
    standardDeviation: number;
    lagOneAutocorrelation: number;
};

export type Cofecha606PreparedSeries = {
    sequence: number;
    segment: Cofecha606SeriesSegment;
    years: number[];
    rawValues: number[];
    baseFilteredValues: number[];
    arOrder: number;
    arCoefficients: number[];
    arResidualValues: number[];
    filteredValues: number[];
    testingValues: number[];
    meanSensitivity: number;
    meanSensitivitySum: number;
    meanSensitivityPairCount: number;
    unfilteredStats: Cofecha606DescriptiveStats;
    filteredStats: Cofecha606DescriptiveStats;
    segmentCount: number;
    checkedYearCount: number;
};

const floatMeanAndSampleStandardDeviation = (values: readonly number[]) => {
    if (values.length === 0) return { mean: 0, standardDeviation: 0 };
    let sum = Math.fround(values[0]);
    let sumOfSquares = Math.fround(values[0] * values[0]);
    for (let index = 1; index < values.length; index += 1) {
        const value = Math.fround(values[index]);
        sum = Math.fround(sum + value);
        sumOfSquares = Math.fround(cofecha606ExtendedMultiplyAdd(
            value,
            value,
            sumOfSquares,
        ));
    }
    const average = Math.fround(sum / Math.fround(values.length));
    if (values.length < 2) return { mean: average, standardDeviation: 0 };
    const numerator = Math.abs(
        cofecha606ExtendedMultiplyAdd(-average, sum, sumOfSquares),
    );
    return {
        mean: average,
        standardDeviation: Math.fround(
            Math.sqrt(numerator / Math.fround(values.length - 1)),
        ),
    };
};

export const cofecha606Pearson = (
    leftValues: readonly number[],
    rightValues: readonly number[],
) => {
    const length = Math.min(leftValues.length, rightValues.length);
    if (length < 2) return 0;
    let leftSum = Math.fround(0);
    let rightSum = Math.fround(0);
    let leftSquares = Math.fround(0);
    let rightSquares = Math.fround(0);
    let cross = Math.fround(0);
    for (let index = 0; index < length; index += 1) {
        const left = Math.fround(leftValues[index]);
        const right = Math.fround(rightValues[index]);
        leftSum = Math.fround(leftSum + left);
        rightSum = Math.fround(rightSum + right);
        leftSquares = Math.fround(cofecha606ExtendedMultiplyAdd(
            left,
            left,
            leftSquares,
        ));
        rightSquares = Math.fround(cofecha606ExtendedMultiplyAdd(
            right,
            right,
            rightSquares,
        ));
        cross = Math.fround(cofecha606ExtendedMultiplyAdd(
            left,
            right,
            cross,
        ));
    }
    const reciprocal = Math.fround(1 / Math.fround(length));
    const scaledLeftSum = reciprocal * leftSum;
    const scaledRightSum = reciprocal * rightSum;
    const leftScale = Math.sqrt(Math.abs(cofecha606ExtendedMultiplyAdd(
        -scaledLeftSum,
        leftSum,
        leftSquares,
    )));
    const rightScale = Math.sqrt(Math.abs(cofecha606ExtendedMultiplyAdd(
        -scaledRightSum,
        rightSum,
        rightSquares,
    )));
    const denominator = Math.fround(leftScale * rightScale);
    if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) return 0;
    const correlation = Math.fround(
        cofecha606ExtendedMultiplyAdd(
            -scaledRightSum,
            leftSum,
            cross,
        ) / denominator,
    );
    return Math.max(-1, Math.min(1, correlation));
};

const lagOneAutocorrelation = (values: readonly number[]) => {
    if (values.length < 3) return 0;
    return cofecha606Pearson(values.slice(0, -1), values.slice(1));
};

const stats = (values: readonly number[]): Cofecha606DescriptiveStats => {
    const summary = floatMeanAndSampleStandardDeviation(values);
    return {
        mean: summary.mean,
        maximum: values.length > 0 ? Math.max(...values) : 0,
        standardDeviation: summary.standardDeviation,
        lagOneAutocorrelation: lagOneAutocorrelation(values),
    };
};

const meanSensitivity = (values: readonly number[]) => {
    if (values.length < 2) return { mean: 0, sum: 0, pairCount: 0 };
    let total = Math.fround(0);
    for (let index = 1; index < values.length; index += 1) {
        const denominator = Math.fround(
            Math.abs(values[index]) + Math.abs(values[index - 1]),
        );
        if (denominator !== 0) {
            const numerator = Math.abs(Math.fround(
                Math.fround(values[index] - values[index - 1]) * 2,
            ));
            total = Math.fround(total + Math.fround(numerator / denominator));
        }
    }
    const pairCount = values.length - 1;
    return {
        mean: Math.fround(total / Math.fround(pairCount)),
        sum: total,
        pairCount,
    };
};

const segmentWindows = (
    startYear: number,
    endYear: number,
    length: number,
    lag: number,
    gridStartYear: number,
    gridEndYear: number,
) => {
    const minimumOverlap = length / 2;
    const windows: Array<{ startYear: number; endYear: number }> = [];
    for (let windowStart = gridStartYear; windowStart <= gridEndYear; windowStart += lag) {
        const windowEnd = windowStart + length - 1;
        const overlap = Math.min(endYear, windowEnd) - Math.max(startYear, windowStart) + 1;
        if (overlap > minimumOverlap) windows.push({
            startYear: windowStart,
            endYear: windowEnd,
        });
    }
    if (endYear - startYear + 1 <= length && windows.length > 1) {
        const center = (startYear + endYear) / 2;
        windows.sort((left, right) => {
            const leftOverlap = Math.min(endYear, left.endYear)
                - Math.max(startYear, left.startYear) + 1;
            const rightOverlap = Math.min(endYear, right.endYear)
                - Math.max(startYear, right.startYear) + 1;
            return rightOverlap - leftOverlap
                || Math.abs((left.startYear + left.endYear) / 2 - center)
                    - Math.abs((right.startYear + right.endYear) / 2 - center)
                || left.startYear - right.startYear;
        });
        return [windows[0]];
    }
    return windows;
};

export const prepareCofecha606SeriesForReport = (
    siteData: RwlSiteData,
    options: Cofecha606SeriesAnalysisOptions,
): Cofecha606PreparedSeries[] => splitCofecha606SeriesSegments(siteData)
    .map((segment, index) => {
        const entries = [...segment.data.entries()]
            .filter((entry): entry is [number, number] => typeof entry[1] === "number")
            .sort(([left], [right]) => left - right);
        const years = entries.map(([year]) => year);
        const rawValues = entries.map(([, value]) => (
            parseCofecha606TucsonWidth(value, segment.stopMarkerValue)
        ));
        const baseFiltered = cofechaStyleStandardize(segment.data, {
            ...COFECHA_REFERENCE_DEFAULT_OPTIONS,
            splineRigidityYears: options.splineRigidityYears,
            splineFrequencyResponse: options.splineFrequencyResponse,
            useAutoregressiveModel: false,
            useLogTransform: false,
            omitAbsentRingsFromMaster: false,
        }, "ltrr-cook-holmes", "none", 1, "ratio", "post-ar", "legacy-float32", segment.stopMarkerValue);
        const baseFilteredValues = baseFiltered.map((point) => point.value);
        const arModel = options.useAutoregressiveModel
            ? cofecha606AutoregressiveResidual(baseFilteredValues)
            : {
                order: 0,
                coefficients: [] as number[],
                residuals: baseFilteredValues.slice(),
            };
        const filteredValues = options.useLogTransform
            ? cofecha606LogTransform(arModel.residuals)
            : arModel.residuals.slice();
        const sensitivity = meanSensitivity(rawValues);
        const windows = segmentWindows(
            years[0],
            years[years.length - 1],
            options.segmentLength,
            options.segmentLag,
            options.segmentGridStartYear,
            options.segmentGridEndYear,
        );
        const checkedYears = new Set<number>();
        windows.forEach((window) => {
            for (
                let year = Math.max(years[0], window.startYear);
                year <= Math.min(years[years.length - 1], window.endYear);
                year += 1
            ) {
                checkedYears.add(year);
            }
        });
        return {
            sequence: index + 1,
            segment,
            years,
            rawValues,
            baseFilteredValues,
            arOrder: arModel.order,
            arCoefficients: arModel.coefficients,
            arResidualValues: arModel.residuals,
            filteredValues,
            testingValues: cofecha606StandardizeValues(filteredValues),
            meanSensitivity: sensitivity.mean,
            meanSensitivitySum: sensitivity.sum,
            meanSensitivityPairCount: sensitivity.pairCount,
            unfilteredStats: stats(rawValues),
            filteredStats: stats(filteredValues),
            segmentCount: windows.length,
            checkedYearCount: checkedYears.size,
        };
    });

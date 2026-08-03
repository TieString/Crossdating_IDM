/**
 * Event-specific counterfactual evidence for ranking years inside an already frozen 5-13 year
 * unit-event window. Expensive preparation is shared across candidate years and cached per
 * diagnosis; this layer never changes event acceptance or window selection.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import {
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import type { NumericSeries, SeriesCoreDiagnosis } from "./types";

export type UnitEventExactYearEvidenceType = "missingRing" | "falseRing";

export type UnitEventExactYearEvidence = {
    scoreByYear: ReadonlyMap<number, number>;
    profileName:
        | "differencePredictiveMedianHuberOlder5"
        | "differenceMasterR61";
};

type PreparedReference = {
    difference: NumericSeries;
    correlation: number;
};

type ReferencePredictor = {
    reference: NumericSeries;
    intercept: number;
    slope: number;
    weight: number;
};

type ExactYearContext = {
    baselineRaw: NumericSeries;
    baselineDifference: NumericSeries;
    masterDifference: NumericSeries;
    references: PreparedReference[];
    correctedDifference: Map<string, NumericSeries>;
    predictorCache: Map<string, ReferencePredictor[]>;
};

const CONTEXT_CACHE = new WeakMap<SeriesCoreDiagnosis, ExactYearContext>();

const mean = (values: readonly number[]): number => values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : -1;

const median = (values: readonly number[]): number => {
    if (values.length === 0) return -1;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = [...series.entries()].sort((left, right) => left[0] - right[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) {
            result.set(year, value - previousValue);
        }
    }
    return preprocessSeries(result);
};

const buildContext = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
): ExactYearContext => {
    const cached = CONTEXT_CACHE.get(diagnosis);
    if (cached) return cached;
    const baselineRaw = preprocessSeries(diagnosis.rawTarget);
    const references = diagnosis.master.sourceTrees
        .map((tree) => {
            const source = toNumericSeries(siteData.get(tree));
            const raw = preprocessSeries(source);
            const correlation = [-3, -2, -1, 0, 1, 2, 3].reduce(
                (best, lag) => Math.max(
                    best,
                    correlationForSegment(
                        baselineRaw,
                        raw,
                        diagnosis.targetRange.startYear,
                        diagnosis.targetRange.endYear,
                        lag,
                        30,
                    ).correlation ?? -1,
                ),
                -1,
            );
            return {
                difference: firstDifferences(source),
                correlation,
            };
        })
        .filter((reference) => reference.correlation > -0.1)
        .sort((left, right) => right.correlation - left.correlation)
        .slice(0, 10);
    const context: ExactYearContext = {
        baselineRaw,
        baselineDifference: firstDifferences(diagnosis.rawTarget),
        masterDifference: firstDifferences(diagnosis.master.data),
        references,
        correctedDifference: new Map(),
        predictorCache: new Map(),
    };
    CONTEXT_CACHE.set(diagnosis, context);
    return context;
};

const simulateCorrection = (
    series: NumericSeries,
    eventType: UnitEventExactYearEvidenceType,
    year: number,
): NumericSeries => {
    const corrected = new Map<number, number>();
    series.forEach((value, sourceYear) => {
        if (eventType === "missingRing") {
            corrected.set(sourceYear <= year ? sourceYear - 1 : sourceYear, value);
        } else if (sourceYear !== year) {
            corrected.set(sourceYear < year ? sourceYear + 1 : sourceYear, value);
        }
    });
    return corrected;
};

const correctedDifference = (
    context: ExactYearContext,
    diagnosis: SeriesCoreDiagnosis,
    eventType: UnitEventExactYearEvidenceType,
    year: number,
): NumericSeries => {
    const key = `${eventType}:${year}`;
    const cached = context.correctedDifference.get(key);
    if (cached) return cached;
    const result = firstDifferences(simulateCorrection(
        diagnosis.rawTarget,
        eventType,
        year,
    ));
    context.correctedDifference.set(key, result);
    return result;
};

const fitReferencePredictor = (
    target: NumericSeries,
    reference: NumericSeries,
    startYear: number,
    endYear: number,
): ReferencePredictor | null => {
    const pairs: Array<[number, number]> = [];
    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const referenceValue = reference.get(year);
        if (targetValue !== undefined && referenceValue !== undefined) {
            pairs.push([referenceValue, targetValue]);
        }
    }
    if (pairs.length < 12) return null;
    const referenceMean = mean(pairs.map(([value]) => value));
    const targetMean = mean(pairs.map(([, value]) => value));
    let covariance = 0;
    let referenceVariance = 0;
    let targetVariance = 0;
    pairs.forEach(([referenceValue, targetValue]) => {
        const referenceDelta = referenceValue - referenceMean;
        const targetDelta = targetValue - targetMean;
        covariance += referenceDelta * targetDelta;
        referenceVariance += referenceDelta * referenceDelta;
        targetVariance += targetDelta * targetDelta;
    });
    if (referenceVariance <= 0 || targetVariance <= 0) return null;
    const slope = covariance / referenceVariance;
    const intercept = targetMean - slope * referenceMean;
    const correlation = covariance / Math.sqrt(referenceVariance * targetVariance);
    const residualMeanSquare = mean(pairs.map(([referenceValue, targetValue]) => (
        targetValue - (intercept + slope * referenceValue)
    ) ** 2));
    if (!Number.isFinite(correlation)
        || !Number.isFinite(residualMeanSquare)
        || correlation <= 0.05) {
        return null;
    }
    return {
        reference,
        intercept,
        slope,
        weight: Math.min(
            20,
            Math.max(0.01, correlation) ** 2
                / Math.max(0.1, residualMeanSquare),
        ),
    };
};

const newerSidePredictors = (
    context: ExactYearContext,
    diagnosis: SeriesCoreDiagnosis,
    window: { startYear: number; endYear: number },
): ReferencePredictor[] => {
    const key = `${window.startYear}:${window.endYear}`;
    const cached = context.predictorCache.get(key);
    if (cached) return cached;
    const startYear = window.endYear + 5;
    const endYear = Math.min(diagnosis.targetRange.endYear, startYear + 179);
    const result = context.references
        .map((reference) => fitReferencePredictor(
            context.baselineDifference,
            reference.difference,
            startYear,
            endYear,
        ))
        .filter((predictor): predictor is ReferencePredictor => predictor !== null)
        .sort((left, right) => right.weight - left.weight)
        .slice(0, 8);
    context.predictorCache.set(key, result);
    return result;
};

const huberLoss = (residual: number, transition = 1.5): number => {
    const absolute = Math.abs(residual);
    return absolute <= transition
        ? 0.5 * residual * residual
        : transition * (absolute - transition * 0.5);
};

const predictiveMedianHuber = (
    target: NumericSeries,
    predictors: readonly ReferencePredictor[],
    startYear: number,
    endYear: number,
): number => median(predictors.flatMap((predictor) => {
    let loss = 0;
    let pairs = 0;
    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const referenceValue = predictor.reference.get(year);
        if (targetValue === undefined || referenceValue === undefined) continue;
        const predicted = predictor.intercept + predictor.slope * referenceValue;
        loss += huberLoss(targetValue - predicted);
        pairs += 1;
    }
    return pairs >= 1 ? [-loss / pairs] : [];
}));

const boundedRange = (
    centerYear: number,
    width: number,
    diagnosis: SeriesCoreDiagnosis,
): { startYear: number; endYear: number } => {
    const half = Math.floor((width - 1) / 2);
    let startYear = centerYear - half;
    let endYear = startYear + width - 1;
    if (startYear < diagnosis.targetRange.startYear) {
        endYear += diagnosis.targetRange.startYear - startYear;
        startYear = diagnosis.targetRange.startYear;
    }
    if (endYear > diagnosis.targetRange.endYear) {
        startYear -= endYear - diagnosis.targetRange.endYear;
        endYear = diagnosis.targetRange.endYear;
    }
    return {
        startYear: Math.max(diagnosis.targetRange.startYear, startYear),
        endYear: Math.min(diagnosis.targetRange.endYear, endYear),
    };
};

export const scoreUnitEventExactYearEvidence = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    eventType: UnitEventExactYearEvidenceType,
    years: readonly number[],
): UnitEventExactYearEvidence | null => {
    if (years.length === 0) return null;
    const context = buildContext(diagnosis, siteData);
    if (eventType === "missingRing") {
        const window = { startYear: years[0], endYear: years[years.length - 1] };
        const predictors = newerSidePredictors(context, diagnosis, window);
        return {
            scoreByYear: new Map(years.map((year) => [
                year,
                predictiveMedianHuber(
                    correctedDifference(context, diagnosis, eventType, year),
                    predictors,
                    year - 2,
                    year - 1,
                ),
            ])),
            profileName: "differencePredictiveMedianHuberOlder5",
        };
    }
    const centerYear = Math.round((years[0] + years[years.length - 1]) / 2);
    const range = boundedRange(centerYear, 61, diagnosis);
    return {
        scoreByYear: new Map(years.map((year) => [
            year,
            correlationForSegment(
                correctedDifference(context, diagnosis, eventType, year),
                context.masterDifference,
                range.startYear,
                range.endYear,
                0,
                Math.max(6, Math.floor((range.endYear - range.startYear + 1) * 0.5)),
            ).correlation ?? -1,
        ])),
        profileName: "differenceMasterR61",
    };
};

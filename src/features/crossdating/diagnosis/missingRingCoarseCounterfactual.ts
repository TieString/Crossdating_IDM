/**
 * Coarse-window virtual insertion evidence for missing-ring localization.
 *
 * Each candidate year is corrected once, then compared with independently
 * fitted reference-core predictors. The locator consumes only four frozen
 * profiles; the full experimental feature table stays out of the runtime path.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import {
    ar1WhitenSeries,
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import type { NumericSeries, SeriesCoreDiagnosis } from "./types";

export const MISSING_RING_COUNTERFACTUAL_PROFILES = [
    "differencePredictiveWeightedHuber21",
    "differencePredictiveEnsembleHuber31",
    "differencePredictiveWeightedHuber61",
    "whitenedPredictiveEnsembleHuber21",
] as const;

export type MissingRingCounterfactualProfile = (
    typeof MISSING_RING_COUNTERFACTUAL_PROFILES[number]
);

export const MISSING_RING_LOCAL_RECENTER_PROFILES = [
    "whitenedPredictiveMedianHuberEdge3Gain",
    "whitenedOlderHuberBoundary7",
] as const;

export type MissingRingLocalRecenterProfile = (
    typeof MISSING_RING_LOCAL_RECENTER_PROFILES[number]
);

export type MissingRingCoarseCounterfactualRow = {
    year: number;
    profiles: Record<MissingRingCounterfactualProfile, number>
        & Partial<Record<MissingRingLocalRecenterProfile, number>>;
};

type PreparedViews = Record<"raw" | "difference" | "whitened", NumericSeries>;

type ReferencePredictor = {
    reference: NumericSeries;
    intercept: number;
    slope: number;
    weight: number;
};

type CoarseCounterfactualContext = {
    diagnosis: SeriesCoreDiagnosis;
    baseline: PreparedViews;
    master: PreparedViews;
    references: PreparedViews[];
    correctedCache: Map<number, PreparedViews>;
    scoreCache: Map<string, MissingRingCoarseCounterfactualRow[]>;
};

const CONTEXT_CACHE = new WeakMap<
    SeriesCoreDiagnosis,
    WeakMap<RwlSiteData, CoarseCounterfactualContext>
>();

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = [...series.entries()].sort((left, right) => left[0] - right[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return preprocessSeries(result);
};

const prepareViews = (series: NumericSeries): PreparedViews => ({
    raw: preprocessSeries(series),
    difference: firstDifferences(series),
    whitened: ar1WhitenSeries(series),
});

const mean = (values: readonly number[]): number => (
    values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : -1
);

const median = (values: readonly number[]): number => {
    if (values.length === 0) return -1;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : sorted[middle] ?? -1;
};

const weightedMean = (
    rows: readonly { value: number; weight: number }[],
): number => {
    const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
    return totalWeight > 0
        ? rows.reduce((sum, row) => sum + row.value * row.weight, 0)
            / totalWeight
        : mean(rows.map((row) => row.value));
};

const huberLoss = (residual: number, transition = 1.5): number => {
    const absolute = Math.abs(residual);
    return absolute <= transition
        ? 0.5 * residual * residual
        : transition * (absolute - transition * 0.5);
};

const localHuberSimilarity = (
    target: NumericSeries,
    reference: NumericSeries,
    startYear: number,
    endYear: number,
    minimumPairs = 2,
): number | null => {
    let loss = 0;
    let pairs = 0;
    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const referenceValue = reference.get(year);
        if (targetValue === undefined || referenceValue === undefined) continue;
        loss += huberLoss(targetValue - referenceValue);
        pairs += 1;
    }
    return pairs >= minimumPairs ? -loss / pairs : null;
};

const simulateMissingRingCorrection = (
    series: NumericSeries,
    year: number,
): NumericSeries => {
    const corrected = new Map<number, number>();
    series.forEach((value, sourceYear) => {
        corrected.set(sourceYear <= year ? sourceYear - 1 : sourceYear, value);
    });
    return corrected;
};

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

const fitReferencePredictor = (
    target: NumericSeries,
    reference: NumericSeries,
    trainingStartYear: number,
    trainingEndYear: number,
    excludedStartYear: number,
    excludedEndYear: number,
    minimumPairs = 30,
): ReferencePredictor | null => {
    const pairs: Array<[number, number]> = [];
    for (let year = trainingStartYear; year <= trainingEndYear; year += 1) {
        if (year >= excludedStartYear && year <= excludedEndYear) continue;
        const targetValue = target.get(year);
        const referenceValue = reference.get(year);
        if (targetValue !== undefined && referenceValue !== undefined) {
            pairs.push([referenceValue, targetValue]);
        }
    }
    if (pairs.length < minimumPairs) return null;
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
    const correlation = covariance
        / Math.sqrt(referenceVariance * targetVariance);
    const residualMeanSquare = mean(pairs.map(([referenceValue, targetValue]) => (
        targetValue - (intercept + slope * referenceValue)
    ) ** 2));
    if (
        !Number.isFinite(correlation)
        || !Number.isFinite(residualMeanSquare)
        || correlation <= 0.05
    ) {
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

const predictiveSimilarities = (
    target: NumericSeries,
    predictors: readonly ReferencePredictor[],
    startYear: number,
    endYear: number,
    minimumPairs?: number,
): { ensemble: number; median: number; weighted: number } => {
    let ensembleLoss = 0;
    let ensemblePairs = 0;
    const individual = predictors.flatMap((predictor) => {
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
        return pairs >= (
            minimumPairs
            ?? Math.max(6, Math.floor((endYear - startYear + 1) * 0.45))
        )
            ? [{ value: -loss / pairs, weight: predictor.weight }]
            : [];
    });
    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        if (targetValue === undefined) continue;
        const available = predictors.flatMap((predictor) => {
            const referenceValue = predictor.reference.get(year);
            return referenceValue === undefined ? [] : [{
                value: predictor.intercept + predictor.slope * referenceValue,
                weight: predictor.weight,
            }];
        });
        if (available.length === 0) continue;
        ensembleLoss += huberLoss(targetValue - weightedMean(available));
        ensemblePairs += 1;
    }
    const enoughPairs = ensemblePairs >= (
        minimumPairs
        ?? Math.max(6, Math.floor((endYear - startYear + 1) * 0.45))
    );
    return {
        ensemble: enoughPairs ? -ensembleLoss / ensemblePairs : -10,
        median: median(individual.map((row) => row.value)),
        weighted: individual.length > 0
            ? weightedMean(individual)
            : median([]),
    };
};

const getContext = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
): CoarseCounterfactualContext => {
    let bySite = CONTEXT_CACHE.get(diagnosis);
    if (!bySite) {
        bySite = new WeakMap();
        CONTEXT_CACHE.set(diagnosis, bySite);
    }
    const cached = bySite.get(siteData);
    if (cached) return cached;
    const baseline = prepareViews(diagnosis.rawTarget);
    const references = diagnosis.master.sourceTrees
        .map((tree) => {
            const views = prepareViews(toNumericSeries(siteData.get(tree)));
            const correlation = [-3, -2, -1, 0, 1, 2, 3].reduce(
                (best, lag) => Math.max(
                    best,
                    correlationForSegment(
                        baseline.raw,
                        views.raw,
                        diagnosis.targetRange.startYear,
                        diagnosis.targetRange.endYear,
                        lag,
                        30,
                    ).correlation ?? -1,
                ),
                -1,
            );
            return { views, correlation };
        })
        .filter((reference) => reference.correlation > -0.1)
        .sort((left, right) => right.correlation - left.correlation)
        .slice(0, 10)
        .map((reference) => reference.views);
    const context = {
        diagnosis,
        baseline,
        master: prepareViews(diagnosis.master.data),
        references,
        correctedCache: new Map<number, PreparedViews>(),
        scoreCache: new Map<string, MissingRingCoarseCounterfactualRow[]>(),
    };
    bySite.set(siteData, context);
    return context;
};

const fitPredictors = (
    context: CoarseCounterfactualContext,
    window: { startYear: number; endYear: number },
): Record<"difference" | "whitened", ReferencePredictor[]> => {
    const centerYear = Math.round((window.startYear + window.endYear) / 2);
    let nominal = context.correctedCache.get(centerYear);
    if (!nominal) {
        nominal = prepareViews(simulateMissingRingCorrection(
            context.diagnosis.rawTarget,
            centerYear,
        ));
        context.correctedCache.set(centerYear, nominal);
    }
    const trainingStartYear = Math.max(
        context.diagnosis.targetRange.startYear,
        centerYear - 140,
    );
    const trainingEndYear = Math.min(
        context.diagnosis.targetRange.endYear,
        centerYear + 140,
    );
    const excludedStartYear = window.startYear - 12;
    const excludedEndYear = window.endYear + 12;
    return Object.fromEntries(
        (["difference", "whitened"] as const).map((viewName) => [
            viewName,
            context.references
                .map((reference) => fitReferencePredictor(
                    nominal![viewName],
                    reference[viewName],
                    trainingStartYear,
                    trainingEndYear,
                    excludedStartYear,
                    excludedEndYear,
                ))
                .filter((predictor): predictor is ReferencePredictor => (
                    predictor !== null
                ))
                .sort((left, right) => right.weight - left.weight)
                .slice(0, 8),
        ]),
    ) as Record<"difference" | "whitened", ReferencePredictor[]>;
};

const fitNewerSideWhitenedPredictors = (
    context: CoarseCounterfactualContext,
    window: { startYear: number; endYear: number },
): ReferencePredictor[] => {
    const trainingStartYear = window.endYear + 5;
    const trainingEndYear = Math.min(
        context.diagnosis.targetRange.endYear,
        trainingStartYear + 179,
    );
    return context.references
        .map((reference) => fitReferencePredictor(
            context.baseline.whitened,
            reference.whitened,
            trainingStartYear,
            trainingEndYear,
            1,
            0,
            12,
        ))
        .filter((predictor): predictor is ReferencePredictor => (
            predictor !== null
        ))
        .sort((left, right) => right.weight - left.weight)
        .slice(0, 8);
};

export const scoreMissingRingCoarseCounterfactual = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    coarseWindow: { startYear: number; endYear: number },
): MissingRingCoarseCounterfactualRow[] => {
    const context = getContext(diagnosis, siteData);
    const cacheKey = `${coarseWindow.startYear}:${coarseWindow.endYear}`;
    const cached = context.scoreCache.get(cacheKey);
    if (cached) return cached;
    const centerYear = Math.round(
        (coarseWindow.startYear + coarseWindow.endYear) / 2,
    );
    const range21 = boundedRange(centerYear, 21, diagnosis);
    const range31 = boundedRange(centerYear, 31, diagnosis);
    const range61 = boundedRange(centerYear, 61, diagnosis);
    const predictors = fitPredictors(context, coarseWindow);
    const newerSideWhitenedPredictors = fitNewerSideWhitenedPredictors(
        context,
        coarseWindow,
    );
    const rows: MissingRingCoarseCounterfactualRow[] = [];
    for (
        let year = coarseWindow.startYear;
        year <= coarseWindow.endYear;
        year += 1
    ) {
        let corrected = context.correctedCache.get(year);
        if (!corrected) {
            corrected = prepareViews(simulateMissingRingCorrection(
                diagnosis.rawTarget,
                year,
            ));
            context.correctedCache.set(year, corrected);
        }
        const difference21 = predictiveSimilarities(
            corrected.difference,
            predictors.difference,
            range21.startYear,
            range21.endYear,
        );
        const difference31 = predictiveSimilarities(
            corrected.difference,
            predictors.difference,
            range31.startYear,
            range31.endYear,
        );
        const difference61 = predictiveSimilarities(
            corrected.difference,
            predictors.difference,
            range61.startYear,
            range61.endYear,
        );
        const whitened21 = predictiveSimilarities(
            corrected.whitened,
            predictors.whitened,
            range21.startYear,
            range21.endYear,
        );
        const whitenedEdgeAfter = predictiveSimilarities(
            corrected.whitened,
            newerSideWhitenedPredictors,
            year - 1,
            year + 1,
            2,
        );
        const whitenedEdgeBefore = predictiveSimilarities(
            context.baseline.whitened,
            newerSideWhitenedPredictors,
            year - 1,
            year + 1,
            2,
        );
        rows.push({
            year,
            profiles: {
                differencePredictiveWeightedHuber21: difference21.weighted,
                differencePredictiveEnsembleHuber31: difference31.ensemble,
                differencePredictiveWeightedHuber61: difference61.weighted,
                whitenedPredictiveEnsembleHuber21: whitened21.ensemble,
                whitenedPredictiveMedianHuberEdge3Gain:
                    whitenedEdgeAfter.median - whitenedEdgeBefore.median,
                whitenedOlderHuberBoundary7: localHuberSimilarity(
                    corrected.whitened,
                    context.master.whitened,
                    year - 3,
                    year - 1,
                ) ?? -10,
            },
        });
    }
    context.scoreCache.set(cacheKey, rows);
    return rows;
};

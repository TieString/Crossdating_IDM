import type { RwlSiteData } from "@/features/rwl/types";
import {
    ar1WhitenSeries,
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "../series";
import type { NumericSeries, SeriesCoreDiagnosis } from "../types";

export type FixedWindowCounterfactualEventType =
    | "missingRing"
    | "falseRing"
    | "partialMove";

export type FixedWindowCounterfactualScore = {
    year: number;
    features: Record<string, number>;
};

type ViewName = "raw" | "difference" | "whitened";

type PreparedViews = Record<ViewName, NumericSeries>;

type PreparedReference = {
    views: PreparedViews;
    weight: number;
};

type ReferencePredictor = {
    reference: NumericSeries;
    intercept: number;
    slope: number;
    weight: number;
};

type PredictiveViews = Record<ViewName, ReferencePredictor[]>;

type FixedWindowCounterfactualContext = {
    diagnosis: SeriesCoreDiagnosis;
    baseline: PreparedViews;
    master: PreparedViews;
    references: PreparedReference[];
    correctedCache: Map<string, PreparedViews>;
};

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

const mean = (values: number[]): number => (
    values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : -1
);

const median = (values: number[]): number => {
    if (values.length === 0) return -1;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

const trimmedMean = (values: number[]): number => {
    if (values.length === 0) return -1;
    const sorted = [...values].sort((left, right) => left - right);
    const trim = Math.floor(sorted.length * 0.2);
    return mean(sorted.slice(trim, Math.max(trim + 1, sorted.length - trim)));
};

const weightedMean = (
    rows: Array<{ value: number; weight: number }>,
): number => {
    const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
    return totalWeight > 0
        ? rows.reduce((sum, row) => sum + row.value * row.weight, 0) / totalWeight
        : mean(rows.map((row) => row.value));
};

const correlation = (
    target: NumericSeries,
    reference: NumericSeries,
    startYear: number,
    endYear: number,
): number | null => correlationForSegment(
    target,
    reference,
    startYear,
    endYear,
    0,
    Math.max(6, Math.floor((endYear - startYear + 1) * 0.5)),
).correlation;

const huberLoss = (residual: number, transition = 1.5): number => {
    const absolute = Math.abs(residual);
    return absolute <= transition
        ? 0.5 * residual * residual
        : transition * (absolute - transition * 0.5);
};

const huberSimilarity = (
    target: NumericSeries,
    reference: NumericSeries,
    startYear: number,
    endYear: number,
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
    return pairs >= Math.max(6, Math.floor((endYear - startYear + 1) * 0.45))
        ? -loss / pairs
        : null;
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

const signAgreement = (
    target: NumericSeries,
    reference: NumericSeries,
    startYear: number,
    endYear: number,
): number | null => {
    let agreements = 0;
    let pairs = 0;
    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const referenceValue = reference.get(year);
        if (targetValue === undefined || referenceValue === undefined) continue;
        const targetSign = Math.sign(targetValue);
        const referenceSign = Math.sign(referenceValue);
        if (targetSign === 0 || referenceSign === 0) continue;
        agreements += Number(targetSign === referenceSign);
        pairs += 1;
    }
    return pairs >= Math.max(6, Math.floor((endYear - startYear + 1) * 0.45))
        ? agreements / pairs
        : null;
};

const simulateCorrection = (
    series: NumericSeries,
    eventType: FixedWindowCounterfactualEventType,
    shiftYears: number,
    year: number,
): NumericSeries => {
    const corrected = new Map<number, number>();
    series.forEach((value, sourceYear) => {
        if (eventType === "missingRing") {
            corrected.set(sourceYear <= year ? sourceYear - 1 : sourceYear, value);
        } else if (eventType === "falseRing") {
            if (sourceYear !== year) {
                corrected.set(sourceYear < year ? sourceYear + 1 : sourceYear, value);
            }
        } else {
            corrected.set(sourceYear <= year ? sourceYear + shiftYears : sourceYear, value);
        }
    });
    return corrected;
};

export const buildFixedWindowCounterfactualContext = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
): FixedWindowCounterfactualContext => {
    const baseline = prepareViews(diagnosis.rawTarget);
    const references = diagnosis.master.sourceTrees
        .map((tree) => {
            const views = prepareViews(toNumericSeries(siteData.get(tree)));
            const bestCorrelation = [-3, -2, -1, 0, 1, 2, 3].reduce(
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
            return {
                views,
                correlation: bestCorrelation,
                weight: Math.max(0.05, bestCorrelation + 0.15),
            };
        })
        .filter((reference) => reference.correlation > -0.1)
        .sort((left, right) => right.correlation - left.correlation)
        .slice(0, 10)
        .map(({ views, weight }) => ({ views, weight }));
    return {
        diagnosis,
        baseline,
        master: prepareViews(diagnosis.master.data),
        references,
        correctedCache: new Map(),
    };
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
        if (targetValue === undefined || referenceValue === undefined) continue;
        pairs.push([referenceValue, targetValue]);
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
    const correlationValue = covariance
        / Math.sqrt(referenceVariance * targetVariance);
    const residualMeanSquare = mean(pairs.map(([referenceValue, targetValue]) => (
        targetValue - (intercept + slope * referenceValue)
    ) ** 2));
    if (!Number.isFinite(correlationValue)
        || !Number.isFinite(residualMeanSquare)
        || correlationValue <= 0.05) {
        return null;
    }
    return {
        reference,
        intercept,
        slope,
        weight: Math.min(
            20,
            Math.max(0.01, correlationValue) ** 2
                / Math.max(0.1, residualMeanSquare),
        ),
    };
};

const fixedNewerSidePredictiveViews = (
    context: FixedWindowCounterfactualContext,
    window: { startYear: number; endYear: number },
): PredictiveViews => {
    const trainingStartYear = window.endYear + 5;
    const trainingEndYear = Math.min(
        context.diagnosis.targetRange.endYear,
        trainingStartYear + 179,
    );
    return Object.fromEntries(
        (["raw", "difference", "whitened"] as const).map((viewName) => [
            viewName,
            context.references
                .map((reference) => fitReferencePredictor(
                    context.baseline[viewName],
                    reference.views[viewName],
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
                .slice(0, 8),
        ]),
    ) as PredictiveViews;
};

const predictiveViews = (
    context: FixedWindowCounterfactualContext,
    eventType: FixedWindowCounterfactualEventType,
    shiftYears: number,
    window: { startYear: number; endYear: number },
): PredictiveViews => {
    const centerYear = Math.round((window.startYear + window.endYear) / 2);
    const cacheKey = `${eventType}:${shiftYears}:${centerYear}`;
    let nominal = context.correctedCache.get(cacheKey);
    if (!nominal) {
        nominal = prepareViews(simulateCorrection(
            context.diagnosis.rawTarget,
            eventType,
            shiftYears,
            centerYear,
        ));
        context.correctedCache.set(cacheKey, nominal);
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
        (["raw", "difference", "whitened"] as const).map((viewName) => [
            viewName,
            context.references
                .map((reference) => fitReferencePredictor(
                    nominal[viewName],
                    reference.views[viewName],
                    trainingStartYear,
                    trainingEndYear,
                    excludedStartYear,
                    excludedEndYear,
                ))
                .filter((predictor): predictor is ReferencePredictor => predictor !== null)
                .sort((left, right) => right.weight - left.weight)
                .slice(0, 8),
        ]),
    ) as PredictiveViews;
};

const predictiveSimilarities = (
    target: NumericSeries,
    predictors: ReferencePredictor[],
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
        const predicted = weightedMean(available);
        ensembleLoss += huberLoss(targetValue - predicted);
        ensemblePairs += 1;
    }
    const enoughPairs = ensemblePairs >= (
        minimumPairs
        ?? Math.max(6, Math.floor((endYear - startYear + 1) * 0.45))
    );
    return {
        ensemble: enoughPairs ? -ensembleLoss / ensemblePairs : -10,
        median: median(individual.map((row) => row.value)),
        weighted: weightedMean(individual),
    };
};

const addPredictiveBoundaryFeatures = (
    features: Record<string, number>,
    corrected: PreparedViews,
    context: FixedWindowCounterfactualContext,
    predictors: PredictiveViews,
    candidateYear: number,
) => {
    ([1, 2, 3] as const).forEach((radius) => {
        const width = radius * 2 + 1;
        (["raw", "difference", "whitened"] as const).forEach((viewName) => {
            const addRange = (
                label: "Edge" | "Older" | "Newer",
                startYear: number,
                endYear: number,
                minimumPairs: number,
            ) => {
                const after = predictiveSimilarities(
                    corrected[viewName],
                    predictors[viewName],
                    startYear,
                    endYear,
                    minimumPairs,
                );
                const before = predictiveSimilarities(
                    context.baseline[viewName],
                    predictors[viewName],
                    startYear,
                    endYear,
                    minimumPairs,
                );
                (["ensemble", "median", "weighted"] as const).forEach((name) => {
                    const prefix = `${viewName}Predictive${
                        name[0].toUpperCase()
                    }${name.slice(1)}Huber${label}${width}`;
                    features[prefix] = after[name];
                    features[`${prefix}Gain`] = after[name] - before[name];
                });
                return after;
            };
            const edge = addRange(
                "Edge",
                candidateYear - radius,
                candidateYear + radius,
                Math.max(2, radius * 2),
            );
            const older = addRange(
                "Older",
                candidateYear - radius,
                candidateYear - 1,
                Math.max(1, radius - 1),
            );
            const newer = addRange(
                "Newer",
                candidateYear + 1,
                candidateYear + radius,
                Math.max(1, radius - 1),
            );
            (["ensemble", "median", "weighted"] as const).forEach((name) => {
                const prefix = `${viewName}Predictive${
                    name[0].toUpperCase()
                }${name.slice(1)}Huber`;
                features[`${prefix}SideMinimum${width}`] = Math.min(
                    older[name],
                    newer[name],
                );
                features[`${prefix}SideMean${width}`] = mean([
                    older[name],
                    newer[name],
                ]);
                features[`${prefix}EdgeVsSide${width}`] = edge[name] - mean([
                    older[name],
                    newer[name],
                ]);
            });
        });
    });
};

const addViewFeatures = (
    features: Record<string, number>,
    viewName: ViewName,
    corrected: NumericSeries,
    context: FixedWindowCounterfactualContext,
    startYear: number,
    endYear: number,
    suffix: string,
) => {
    const masterCorrelation = correlation(
        corrected,
        context.master[viewName],
        startYear,
        endYear,
    );
    const masterHuber = huberSimilarity(
        corrected,
        context.master[viewName],
        startYear,
        endYear,
    );
    const referenceRows = context.references.flatMap((reference) => {
        const value = correlation(
            corrected,
            reference.views[viewName],
            startYear,
            endYear,
        );
        return value === null ? [] : [{ value, weight: reference.weight }];
    });
    features[`${viewName}MasterR${suffix}`] = masterCorrelation ?? -1;
    features[`${viewName}MasterHuber${suffix}`] = masterHuber ?? -10;
    features[`${viewName}ReferenceMeanR${suffix}`] = mean(
        referenceRows.map((row) => row.value),
    );
    features[`${viewName}ReferenceMedianR${suffix}`] = median(
        referenceRows.map((row) => row.value),
    );
    features[`${viewName}ReferenceTrimmedR${suffix}`] = trimmedMean(
        referenceRows.map((row) => row.value),
    );
    features[`${viewName}ReferenceWeightedR${suffix}`] = weightedMean(referenceRows);
    if (viewName === "difference") {
        const referenceHuberRows = context.references.flatMap((reference) => {
            const value = huberSimilarity(
                corrected,
                reference.views[viewName],
                startYear,
                endYear,
            );
            return value === null ? [] : [{ value, weight: reference.weight }];
        });
        features[`${viewName}ReferenceMedianHuber${suffix}`] = median(
            referenceHuberRows.map((row) => row.value),
        );
        features[`${viewName}ReferenceWeightedHuber${suffix}`] = weightedMean(
            referenceHuberRows,
        );
    }
};

const addBoundaryLocalFeatures = (
    features: Record<string, number>,
    corrected: PreparedViews,
    context: FixedWindowCounterfactualContext,
    candidateYear: number,
    radius: number,
) => {
    const suffix = `Boundary${radius * 2 + 1}`;
    (["raw", "difference", "whitened"] as const).forEach((viewName) => {
        const baselineOlder = localHuberSimilarity(
            context.baseline[viewName],
            context.master[viewName],
            candidateYear - radius,
            candidateYear - 1,
        );
        const correctedOlder = localHuberSimilarity(
            corrected[viewName],
            context.master[viewName],
            candidateYear - radius,
            candidateYear - 1,
        );
        const baselineNewer = localHuberSimilarity(
            context.baseline[viewName],
            context.master[viewName],
            candidateYear + 1,
            candidateYear + radius,
        );
        const correctedNewer = localHuberSimilarity(
            corrected[viewName],
            context.master[viewName],
            candidateYear + 1,
            candidateYear + radius,
        );
        const olderGain = correctedOlder !== null && baselineOlder !== null
            ? correctedOlder - baselineOlder
            : -10;
        const newerGain = correctedNewer !== null && baselineNewer !== null
            ? correctedNewer - baselineNewer
            : -10;
        features[`${viewName}OlderHuber${suffix}`] = correctedOlder ?? -10;
        features[`${viewName}NewerHuber${suffix}`] = correctedNewer ?? -10;
        features[`${viewName}OlderHuberGain${suffix}`] = olderGain;
        features[`${viewName}NewerHuberGain${suffix}`] = newerGain;
        features[`${viewName}SideMinimumGain${suffix}`] = Math.min(
            olderGain,
            newerGain,
        );
        features[`${viewName}SideMeanGain${suffix}`] = mean([
            olderGain,
            newerGain,
        ]);
    });
};

export const scoreFixedWindowCounterfactual = (
    context: FixedWindowCounterfactualContext,
    eventType: FixedWindowCounterfactualEventType,
    shiftYears: number,
    window: { startYear: number; endYear: number },
    options: { includeBoundaryLocal?: boolean } = {},
): FixedWindowCounterfactualScore[] => {
    const centerYear = Math.round((window.startYear + window.endYear) / 2);
    const widths = [21, 31, 61];
    const ranges = widths.map((width) => ({
        width,
        ...boundedRange(centerYear, width, context.diagnosis),
    }));
    const predictors = predictiveViews(
        context,
        eventType,
        shiftYears,
        window,
    );
    const boundaryPredictors = options.includeBoundaryLocal
        ? fixedNewerSidePredictiveViews(context, window)
        : null;
    const rows: FixedWindowCounterfactualScore[] = [];
    for (let year = window.startYear; year <= window.endYear; year += 1) {
        const cacheKey = `${eventType}:${shiftYears}:${year}`;
        let corrected = context.correctedCache.get(cacheKey);
        if (!corrected) {
            corrected = prepareViews(simulateCorrection(
                context.diagnosis.rawTarget,
                eventType,
                shiftYears,
                year,
            ));
            context.correctedCache.set(cacheKey, corrected);
        }
        const features: Record<string, number> = {};
        ranges.forEach(({ width, startYear, endYear }) => {
            (["raw", "difference", "whitened"] as const).forEach((viewName) => {
                addViewFeatures(
                    features,
                    viewName,
                    corrected[viewName],
                    context,
                    startYear,
                    endYear,
                    String(width),
                );
            });
            features[`glkMaster${width}`] = signAgreement(
                corrected.difference,
                context.master.difference,
                startYear,
                endYear,
            ) ?? 0;
            const referenceGlk = context.references.flatMap((reference) => {
                const value = signAgreement(
                    corrected.difference,
                    reference.views.difference,
                    startYear,
                    endYear,
                );
                return value === null ? [] : [value];
            });
            features[`glkReferenceMedian${width}`] = median(referenceGlk);
            (["raw", "difference", "whitened"] as const).forEach((viewName) => {
                const predictive = predictiveSimilarities(
                    corrected[viewName],
                    predictors[viewName],
                    startYear,
                    endYear,
                );
                features[`${viewName}PredictiveEnsembleHuber${width}`] =
                    predictive.ensemble;
                features[`${viewName}PredictiveMedianHuber${width}`] =
                    predictive.median;
                features[`${viewName}PredictiveWeightedHuber${width}`] =
                    predictive.weighted;
            });
        });
        if (options.includeBoundaryLocal) [2, 3, 4, 6].forEach((radius) => {
            const localRange = boundedRange(
                year,
                radius * 2 + 1,
                context.diagnosis,
            );
            (["raw", "difference", "whitened"] as const).forEach((viewName) => {
                const after: Record<string, number> = {};
                const before: Record<string, number> = {};
                addViewFeatures(
                    after,
                    viewName,
                    corrected[viewName],
                    context,
                    localRange.startYear,
                    localRange.endYear,
                    "",
                );
                addViewFeatures(
                    before,
                    viewName,
                    context.baseline[viewName],
                    context,
                    localRange.startYear,
                    localRange.endYear,
                    "",
                );
                Object.entries(after).forEach(([name, value]) => {
                    const suffix = `Boundary${radius * 2 + 1}`;
                    features[`${name}${suffix}`] = value;
                    features[`${name}Gain${suffix}`] = value - (before[name] ?? value);
                });
            });
            addBoundaryLocalFeatures(
                features,
                corrected,
                context,
                year,
                radius,
            );
        });
        if (options.includeBoundaryLocal) {
            addPredictiveBoundaryFeatures(
                features,
                corrected,
                context,
                boundaryPredictors!,
                year,
            );
        }
        rows.push({ year, features });
    }
    return rows;
};

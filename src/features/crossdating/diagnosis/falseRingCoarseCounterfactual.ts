/** Coarse-window virtual deletion evidence for false-ring localization. */
import type { RwlSiteData } from "@/features/rwl/types";
import {
    ar1WhitenSeries,
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import type { NumericSeries, SeriesCoreDiagnosis } from "./types";

export const FALSE_RING_COUNTERFACTUAL_PROFILES = [
    "differenceMasterHuber31",
    "whitenedMasterHuber31",
    "differenceReferenceWeightedHuber31",
    "differenceMasterHuber21",
] as const;

export type FalseRingCounterfactualProfile = (
    typeof FALSE_RING_COUNTERFACTUAL_PROFILES[number]
);

export const FALSE_RING_REFERENCE_COUNTERFACTUAL_PROFILES = [
    "differenceReferenceRankMean31",
    "differenceReferenceRankMedian31",
    "differenceReferencePeakKernel5",
    "differenceReferencePeakKernel9",
    "differenceReferenceTopVote3",
] as const;

export type FalseRingReferenceCounterfactualProfile = (
    typeof FALSE_RING_REFERENCE_COUNTERFACTUAL_PROFILES[number]
);

export type FalseRingCoarseCounterfactualRow = {
    year: number;
    profiles: Record<FalseRingCounterfactualProfile, number>
        & Partial<Record<FalseRingReferenceCounterfactualProfile, number>>;
};

type PreparedViews = Record<"raw" | "difference" | "whitened", NumericSeries>;

type PreparedReference = {
    views: PreparedViews;
    weight: number;
};

type Context = {
    diagnosis: SeriesCoreDiagnosis;
    master: PreparedViews;
    references: PreparedReference[];
    correctedCache: Map<number, PreparedViews>;
    scoreCache: Map<string, FalseRingCoarseCounterfactualRow[]>;
};

const CONTEXT_CACHE = new WeakMap<
    SeriesCoreDiagnosis,
    WeakMap<RwlSiteData, Context>
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

const weightedMean = (
    rows: readonly { value: number; weight: number }[],
): number => {
    const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
    return totalWeight > 0
        ? rows.reduce((sum, row) => sum + row.value * row.weight, 0)
            / totalWeight
        : mean(rows.map((row) => row.value));
};

const median = (values: readonly number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : sorted[middle] ?? 0;
};

const percentileRanks = (values: readonly number[]): number[] => values.map(
    (selected) => (
        values.filter((value) => value < selected).length
        + values.filter((value) => value === selected).length * 0.5
    ) / Math.max(1, values.length),
);

const maximumIndex = (values: readonly number[]): number => {
    let selected = 0;
    for (let index = 1; index < values.length; index += 1) {
        if (values[index] > values[selected]) selected = index;
    }
    return selected;
};

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

const simulateFalseRingCorrection = (
    series: NumericSeries,
    year: number,
): NumericSeries => {
    const corrected = new Map<number, number>();
    series.forEach((value, sourceYear) => {
        if (sourceYear !== year) {
            corrected.set(sourceYear < year ? sourceYear + 1 : sourceYear, value);
        }
    });
    return corrected;
};

const getContext = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
): Context => {
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
            return {
                views,
                correlation,
                weight: Math.max(0.05, correlation + 0.15),
            };
        })
        .filter((reference) => reference.correlation > -0.1)
        .sort((left, right) => right.correlation - left.correlation)
        .slice(0, 10)
        .map(({ views, weight }) => ({ views, weight }));
    const context = {
        diagnosis,
        master: prepareViews(diagnosis.master.data),
        references,
        correctedCache: new Map<number, PreparedViews>(),
        scoreCache: new Map<string, FalseRingCoarseCounterfactualRow[]>(),
    };
    bySite.set(siteData, context);
    return context;
};

export const scoreFalseRingCoarseCounterfactual = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    coarseWindow: { startYear: number; endYear: number },
): FalseRingCoarseCounterfactualRow[] => {
    const context = getContext(diagnosis, siteData);
    const cacheKey = `${coarseWindow.startYear}:${coarseWindow.endYear}`;
    const cached = context.scoreCache.get(cacheKey);
    if (cached) return cached;
    const centerYear = Math.round(
        (coarseWindow.startYear + coarseWindow.endYear) / 2,
    );
    const range21 = boundedRange(centerYear, 21, diagnosis);
    const range31 = boundedRange(centerYear, 31, diagnosis);
    const rows: FalseRingCoarseCounterfactualRow[] = [];
    const referenceScoresByYear: Array<Array<number | null>> = [];
    for (
        let year = coarseWindow.startYear;
        year <= coarseWindow.endYear;
        year += 1
    ) {
        let corrected = context.correctedCache.get(year);
        if (!corrected) {
            corrected = prepareViews(simulateFalseRingCorrection(
                diagnosis.rawTarget,
                year,
            ));
            context.correctedCache.set(year, corrected);
        }
        const referenceScores = context.references.map((reference) => (
            huberSimilarity(
                corrected!.difference,
                reference.views.difference,
                range31.startYear,
                range31.endYear,
            )
        ));
        referenceScoresByYear.push(referenceScores);
        const referenceHuber31 = referenceScores.flatMap((value, index) => (
            value === null
                ? []
                : [{ value, weight: context.references[index]?.weight ?? 0 }]
        ));
        rows.push({
            year,
            profiles: {
                differenceMasterHuber31: huberSimilarity(
                    corrected.difference,
                    context.master.difference,
                    range31.startYear,
                    range31.endYear,
                ) ?? -10,
                whitenedMasterHuber31: huberSimilarity(
                    corrected.whitened,
                    context.master.whitened,
                    range31.startYear,
                    range31.endYear,
                ) ?? -10,
                differenceReferenceWeightedHuber31:
                    weightedMean(referenceHuber31),
                differenceMasterHuber21: huberSimilarity(
                    corrected.difference,
                    context.master.difference,
                    range21.startYear,
                    range21.endYear,
                ) ?? -10,
                differenceReferenceRankMean31: 0,
                differenceReferenceRankMedian31: 0,
                differenceReferencePeakKernel5: 0,
                differenceReferencePeakKernel9: 0,
                differenceReferenceTopVote3: 0,
            },
        });
    }

    const referenceRanks = context.references.map((_, referenceIndex) => (
        percentileRanks(referenceScoresByYear.map((scores) => (
            scores[referenceIndex] ?? -10
        )))
    ));
    const referencePeakIndexes = referenceRanks.map(maximumIndex);
    rows.forEach((row, rowIndex) => {
        const weightedRanks = context.references.map((reference, index) => ({
            value: referenceRanks[index]?.[rowIndex] ?? 0,
            weight: reference.weight,
        }));
        const weightedKernels = (radius: number) => context.references.map((
            reference,
            index,
        ) => ({
            value: Math.max(
                0,
                1 - Math.abs(rowIndex - (referencePeakIndexes[index] ?? rowIndex))
                    / (radius + 1),
            ),
            weight: reference.weight,
        }));
        row.profiles.differenceReferenceRankMean31 = weightedMean(weightedRanks);
        row.profiles.differenceReferenceRankMedian31 = median(
            referenceRanks.map((ranks) => ranks[rowIndex] ?? 0),
        );
        row.profiles.differenceReferencePeakKernel5 = weightedMean(
            weightedKernels(2),
        );
        row.profiles.differenceReferencePeakKernel9 = weightedMean(
            weightedKernels(4),
        );
        row.profiles.differenceReferenceTopVote3 = weightedMean(
            context.references.map((reference, index) => ({
                value: Math.abs(
                    rowIndex - (referencePeakIndexes[index] ?? rowIndex),
                ) <= 1 ? 1 : 0,
                weight: reference.weight,
            })),
        );
    });
    context.scoreCache.set(cacheKey, rows);
    return rows;
};

/**
 * Reference-wise full-interval evidence for one already selected correction.
 *
 * Every reference is aligned to its own baseline lag, then the shared prefix-statistics
 * scanner evaluates the correction at every breakpoint. This keeps the work linear in
 * years per reference and avoids cloning a target Map for each year.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import {
    scoreFullIntervalBaselineEvidence,
    scoreFullIntervalShiftEvidence,
} from "./fullIntervalUnitEditEvidence";
import {
    ar1WhitenSeries,
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import type { NumericSeries, SeriesCoreDiagnosis } from "./types";

export type PerReferenceCounterfactualRow = {
    year: number;
    referenceCount: number;
    differenceWeighted: number;
    differenceGainWeighted: number;
    whitenedMean: number;
    whitenedGainMean: number;
    positiveDifferenceGainFraction: number;
    positiveWhitenedGainFraction: number;
    positiveSideStepFraction: number;
    peakKernel5: number;
    peakKernel9: number;
    lagStepWeighted: number;
    lagStepMedian: number;
    lagStepPositiveFraction: number;
    lagStepPeakKernel5: number;
    lagStepPeakKernel9: number;
    fixedLagStepWeighted: number;
    fixedLagStepMedian: number;
    fixedLagStepPositiveFraction: number;
    fixedLagStepPeakKernel5: number;
    fixedLagStepPeakKernel9: number;
};

export type PerReferenceCounterfactualOptions = {
    edgeYears?: number;
    maximumReferences?: number;
    baselineLagRadius?: number;
    baselineLagCenter?: number;
};

export type PerReferenceCounterfactualSummary = {
    bestYear: number;
    referenceCount: number;
    bestCombinedGain: number;
    topThreeCombinedGain: number;
    bestDifferenceGain: number;
    topThreeDifferenceGain: number;
    bestWhitenedGain: number;
    topThreeWhitenedGain: number;
    positiveDifferenceGainFraction: number;
    positiveWhitenedGainFraction: number;
    peakKernel5: number;
    peakKernel9: number;
    remoteCombinedMargin: number;
};

type PreparedReference = {
    raw: NumericSeries;
    difference: NumericSeries;
    whitened: NumericSeries;
    baselineLag: number;
    baselineCorrelation: number;
    weight: number;
};

type ReferenceYearScore = {
    year: number;
    difference: number;
    differenceGain: number;
    whitened: number;
    whitenedGain: number;
    sideStep: number;
    lagStepScore: number;
    lagStepRank: number;
    fixedLagStepScore: number;
    fixedLagStepRank: number;
};

type ReferenceProfile = PreparedReference & {
    peakYear: number;
    lagStepPeakYear: number;
    fixedLagStepPeakYear: number;
    rows: ReferenceYearScore[];
};

type PreparedTarget = Pick<
    PreparedReference,
    "raw" | "difference" | "whitened"
>;

type MeanPrefix = {
    startYear: number;
    sums: number[];
    counts: number[];
};

const CACHE = new WeakMap<
    SeriesCoreDiagnosis,
    WeakMap<RwlSiteData, Map<string, PerReferenceCounterfactualRow[]>>
>();
const PREPARED_REFERENCE_CACHE = new WeakMap<
    SeriesCoreDiagnosis,
    WeakMap<RwlSiteData, Map<string, PreparedReference[]>>
>();
const WHITENED_DIAGNOSIS_CACHE = new WeakMap<
    SeriesCoreDiagnosis,
    SeriesCoreDiagnosis
>();

const mean = (values: number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const ordered = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 === 0
        ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
        : ordered[middle] ?? 0;
};

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = [...series.entries()].sort(
        (left, right) => left[0] - right[0],
    );
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index]!;
        const [previousYear, previousValue] = entries[index - 1]!;
        if (year === previousYear + 1) {
            result.set(year, value - previousValue);
        }
    }
    return preprocessSeries(result);
};

const percentileRanks = (values: readonly number[]): number[] => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const result = new Array(values.length).fill(0);
    for (let start = 0; start < ordered.length;) {
        let end = start + 1;
        while (
            end < ordered.length
            && ordered[end]?.value === ordered[start]?.value
        ) end += 1;
        const rank = (start + end - 1)
            / (2 * Math.max(1, ordered.length - 1));
        for (let index = start; index < end; index += 1) {
            result[ordered[index]!.index] = rank;
        }
        start = end;
    }
    return result;
};

const huberLoss = (residual: number, transition = 1.5): number => {
    const absolute = Math.abs(residual);
    return absolute <= transition
        ? 0.5 * residual * residual
        : transition * (absolute - transition * 0.5);
};

const buildMeanPrefix = (
    values: ReadonlyMap<number, number>,
    startYear: number,
    endYear: number,
): MeanPrefix => {
    const sums = [0];
    const counts = [0];
    for (let year = startYear; year <= endYear; year += 1) {
        const value = values.get(year);
        sums.push((sums[sums.length - 1] ?? 0) + (value ?? 0));
        counts.push((counts[counts.length - 1] ?? 0) + Number(
            value !== undefined,
        ));
    }
    return { startYear, sums, counts };
};

const prefixMean = (
    prefix: MeanPrefix,
    startYear: number,
    endYear: number,
): { mean: number; count: number } => {
    const maximumYear = prefix.startYear + prefix.sums.length - 2;
    const start = Math.max(prefix.startYear, startYear);
    const end = Math.min(maximumYear, endYear);
    if (end < start) return { mean: 0, count: 0 };
    const startIndex = start - prefix.startYear;
    const endIndex = end - prefix.startYear + 1;
    const sum = (prefix.sums[endIndex] ?? 0)
        - (prefix.sums[startIndex] ?? 0);
    const count = (prefix.counts[endIndex] ?? 0)
        - (prefix.counts[startIndex] ?? 0);
    return { mean: count > 0 ? sum / count : 0, count };
};

const combinedReferenceGain = (
    row: PerReferenceCounterfactualRow,
): number => (
    row.differenceGainWeighted * 0.6
    + row.whitenedGainMean * 0.4
);

export const summarizePerReferenceCounterfactualRows = (
    rows: readonly PerReferenceCounterfactualRow[],
): PerReferenceCounterfactualSummary | null => {
    if (rows.length === 0) return null;
    const combined = [...rows].sort((left, right) => (
        combinedReferenceGain(right) - combinedReferenceGain(left)
        || right.positiveDifferenceGainFraction
            - left.positiveDifferenceGainFraction
        || right.positiveWhitenedGainFraction
            - left.positiveWhitenedGainFraction
        || right.year - left.year
    ));
    const difference = [...rows].sort((left, right) => (
        right.differenceGainWeighted - left.differenceGainWeighted
        || right.year - left.year
    ));
    const whitened = [...rows].sort((left, right) => (
        right.whitenedGainMean - left.whitenedGainMean
        || right.year - left.year
    ));
    const best = combined[0];
    const remote = combined.find(
        (row) => Math.abs(row.year - best.year) > 17,
    );
    return {
        bestYear: best.year,
        referenceCount: best.referenceCount,
        bestCombinedGain: combinedReferenceGain(best),
        topThreeCombinedGain: mean(
            combined.slice(0, 3).map(combinedReferenceGain),
        ),
        bestDifferenceGain: difference[0].differenceGainWeighted,
        topThreeDifferenceGain: mean(
            difference.slice(0, 3).map(
                (row) => row.differenceGainWeighted,
            ),
        ),
        bestWhitenedGain: whitened[0].whitenedGainMean,
        topThreeWhitenedGain: mean(
            whitened.slice(0, 3).map((row) => row.whitenedGainMean),
        ),
        positiveDifferenceGainFraction:
            best.positiveDifferenceGainFraction,
        positiveWhitenedGainFraction:
            best.positiveWhitenedGainFraction,
        peakKernel5: best.peakKernel5,
        peakKernel9: best.peakKernel9,
        remoteCombinedMargin:
            combinedReferenceGain(best)
            - (remote ? combinedReferenceGain(remote) : combinedReferenceGain(best)),
    };
};

const bestBaselineLag = (
    diagnosis: SeriesCoreDiagnosis,
    reference: NumericSeries,
    center: number,
    radius: number,
): { lag: number; correlation: number } | null => {
    const fixedSideStart = Math.max(
        diagnosis.targetRange.startYear,
        diagnosis.targetRange.endYear - 47,
    );
    const result = Array.from(
        { length: radius * 2 + 1 },
        (_, index) => center + index - radius,
    ).map((lag) => ({
        lag,
        correlation: correlationForSegment(
            diagnosis.rawTarget,
            reference,
            fixedSideStart,
            diagnosis.targetRange.endYear,
            lag,
            20,
        ).correlation,
    })).filter(
        (row): row is { lag: number; correlation: number } => (
            row.correlation !== null
        ),
    ).sort((left, right) => (
        right.correlation - left.correlation
        || Math.abs(left.lag) - Math.abs(right.lag)
    ))[0];
    return result ?? null;
};

const prepareReferences = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    maximumReferences: number,
    baselineLagCenter: number,
    baselineLagRadius: number,
): PreparedReference[] => {
    const candidates = diagnosis.master.sourceTrees
        .map((tree) => toNumericSeries(siteData.get(tree)))
        .filter((reference) => reference.size >= 40)
        .flatMap((source): PreparedReference[] => {
            const raw = preprocessSeries(source);
            const baseline = bestBaselineLag(
                diagnosis,
                raw,
                baselineLagCenter,
                baselineLagRadius,
            );
            if (!baseline || baseline.correlation <= -0.1) return [];
            return [{
                raw,
                difference: firstDifferences(source),
                whitened: ar1WhitenSeries(source),
                baselineLag: baseline.lag,
                baselineCorrelation: baseline.correlation,
                weight: Math.max(0.05, baseline.correlation + 0.15),
            }];
        })
        .sort((left, right) => (
            right.baselineCorrelation - left.baselineCorrelation
        ))
        .slice(0, maximumReferences);
    return candidates.map((candidate) => {
        const redundancy = candidates.reduce((sum, other) => {
            if (other === candidate) return sum;
            const correlation = correlationForSegment(
                candidate.raw,
                other.raw,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
                0,
                30,
            ).correlation ?? 0;
            return sum + Math.max(0, (correlation - 0.75) / 0.25);
        }, 0);
        return {
            ...candidate,
            weight: candidate.weight / Math.sqrt(1 + redundancy),
        };
    });
};

const getPreparedReferences = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    maximumReferences: number,
    baselineLagCenter: number,
    baselineLagRadius: number,
): PreparedReference[] => {
    const bySite = PREPARED_REFERENCE_CACHE.get(diagnosis) ?? new WeakMap();
    const byKey = bySite.get(siteData) ?? new Map();
    const key = [
        maximumReferences,
        baselineLagCenter,
        baselineLagRadius,
    ].join(":");
    const cached = byKey.get(key);
    if (cached) return cached;
    const prepared = prepareReferences(
        diagnosis,
        siteData,
        maximumReferences,
        baselineLagCenter,
        baselineLagRadius,
    );
    byKey.set(key, prepared);
    bySite.set(siteData, byKey);
    PREPARED_REFERENCE_CACHE.set(diagnosis, bySite);
    return prepared;
};

const scoreReferenceLagStep = (
    diagnosis: SeriesCoreDiagnosis,
    target: PreparedTarget,
    reference: PreparedReference,
    shiftYears: number,
    edgeYears: number,
    baselineLag = reference.baselineLag,
): Map<number, number> => {
    const pointPreferences = new Map<number, number>();
    for (
        let year = diagnosis.targetRange.startYear;
        year <= diagnosis.targetRange.endYear;
        year += 1
    ) {
        const viewPreferences = ([
            ["raw", 0.25],
            ["difference", 0.45],
            ["whitened", 0.3],
        ] as const).flatMap(([view, weight]) => {
            const targetValue = target[view].get(year);
            const fixed = reference[view].get(
                year + baselineLag,
            );
            const shifted = reference[view].get(
                year + baselineLag + shiftYears,
            );
            if (
                targetValue === undefined
                || fixed === undefined
                || shifted === undefined
            ) return [];
            return [{
                value: huberLoss(targetValue - fixed)
                    - huberLoss(targetValue - shifted),
                weight,
            }];
        });
        const totalWeight = viewPreferences.reduce(
            (sum, row) => sum + row.weight,
            0,
        );
        if (totalWeight >= 0.5) {
            pointPreferences.set(
                year,
                viewPreferences.reduce(
                    (sum, row) => sum + row.value * row.weight,
                    0,
                ) / totalWeight,
            );
        }
    }
    const prefix = buildMeanPrefix(
        pointPreferences,
        diagnosis.targetRange.startYear,
        diagnosis.targetRange.endYear,
    );
    const result = new Map<number, number>();
    const localSideYears = 31;
    for (
        let year = diagnosis.targetRange.startYear + edgeYears;
        year <= diagnosis.targetRange.endYear - edgeYears;
        year += 1
    ) {
        const older = prefixMean(
            prefix,
            diagnosis.targetRange.startYear,
            year,
        );
        const newer = prefixMean(
            prefix,
            year + 1,
            diagnosis.targetRange.endYear,
        );
        const localOlder = prefixMean(
            prefix,
            year - localSideYears + 1,
            year,
        );
        const localNewer = prefixMean(
            prefix,
            year + 1,
            year + localSideYears,
        );
        if (
            older.count < 15
            || newer.count < 15
            || localOlder.count < 10
            || localNewer.count < 10
        ) continue;
        const olderAdvantage = older.mean;
        const newerAdvantage = -newer.mean;
        const localOlderAdvantage = localOlder.mean;
        const localNewerAdvantage = -localNewer.mean;
        const globalStep = Math.min(olderAdvantage, newerAdvantage)
            + (olderAdvantage + newerAdvantage) * 0.1;
        const localStep = Math.min(
            localOlderAdvantage,
            localNewerAdvantage,
        ) + (localOlderAdvantage + localNewerAdvantage) * 0.1;
        result.set(year, globalStep * 0.65 + localStep * 0.35);
    }
    return result;
};

const scoreReference = (
    diagnosis: SeriesCoreDiagnosis,
    whitenedDiagnosis: SeriesCoreDiagnosis,
    target: PreparedTarget,
    reference: PreparedReference,
    shiftYears: number,
    edgeYears: number,
    fixedBaselineLag: number,
): ReferenceProfile | null => {
    const lagStepByYear = scoreReferenceLagStep(
        diagnosis,
        target,
        reference,
        shiftYears,
        edgeYears,
    );
    const fixedLagStepByYear = scoreReferenceLagStep(
        diagnosis,
        target,
        reference,
        shiftYears,
        edgeYears,
        fixedBaselineLag,
    );
    const baseline = scoreFullIntervalBaselineEvidence(
        diagnosis,
        reference.raw,
        reference.baselineLag,
    );
    const whitenedBaseline = scoreFullIntervalBaselineEvidence(
        whitenedDiagnosis,
        reference.whitened,
        reference.baselineLag,
    );
    const whitenedByYear = new Map(scoreFullIntervalShiftEvidence(
        whitenedDiagnosis,
        shiftYears,
        edgeYears,
        reference.whitened,
        reference.baselineLag,
    ).map((row) => [row.year, row]));
    const rows = scoreFullIntervalShiftEvidence(
        diagnosis,
        shiftYears,
        edgeYears,
        reference.raw,
        reference.baselineLag,
    ).flatMap((row): ReferenceYearScore[] => {
        const whitened = whitenedByYear.get(row.year);
        if (
            !whitened
            || row.differencePairs < 30
            || whitened.samplePairs < 30
            || !Number.isFinite(row.sideStepScore)
        ) {
            return [];
        }
        return [{
            year: row.year,
            difference: row.differenceCorrelation,
            differenceGain:
                row.differenceCorrelation - baseline.differenceCorrelation,
            whitened: whitened.rawCorrelation,
            whitenedGain:
                whitened.rawCorrelation - whitenedBaseline.rawCorrelation,
            sideStep: row.sideStepScore,
            lagStepScore: lagStepByYear.get(row.year)
                ?? Number.NEGATIVE_INFINITY,
            lagStepRank: 0,
            fixedLagStepScore: fixedLagStepByYear.get(row.year)
                ?? Number.NEGATIVE_INFINITY,
            fixedLagStepRank: 0,
        }];
    });
    if (rows.length < 15) return null;
    const lagStepRanks = percentileRanks(rows.map((row) => row.lagStepScore));
    const fixedLagStepRanks = percentileRanks(
        rows.map((row) => row.fixedLagStepScore),
    );
    const rankedRows = rows.map((row, index) => ({
        ...row,
        lagStepRank: lagStepRanks[index] ?? 0,
        fixedLagStepRank: fixedLagStepRanks[index] ?? 0,
    }));
    const peak = rankedRows.reduce((best, row) => {
        const score = row.differenceGain * 0.65 + row.whitenedGain * 0.35;
        const bestScore =
            best.differenceGain * 0.65 + best.whitenedGain * 0.35;
        return score > bestScore ? row : best;
    }, rankedRows[0]!);
    const lagStepPeak = rankedRows.reduce((best, row) => (
        row.lagStepRank > best.lagStepRank
            || (
                row.lagStepRank === best.lagStepRank
                && row.lagStepScore > best.lagStepScore
            )
            ? row
            : best
    ), rankedRows[0]!);
    const fixedLagStepPeak = rankedRows.reduce((best, row) => (
        row.fixedLagStepRank > best.fixedLagStepRank
            || (
                row.fixedLagStepRank === best.fixedLagStepRank
                && row.fixedLagStepScore > best.fixedLagStepScore
            )
            ? row
            : best
    ), rankedRows[0]!);
    return {
        ...reference,
        peakYear: peak.year,
        lagStepPeakYear: lagStepPeak.year,
        fixedLagStepPeakYear: fixedLagStepPeak.year,
        rows: rankedRows,
    };
};

export const scorePerReferenceCounterfactualEvidence = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    shiftYears: number,
    options: PerReferenceCounterfactualOptions = {},
): PerReferenceCounterfactualRow[] => {
    const edgeYears = Math.max(8, Math.floor(options.edgeYears ?? 15));
    const maximumReferences = Math.max(
        3,
        Math.floor(options.maximumReferences ?? 16),
    );
    const baselineLagRadius = Math.max(
        0,
        Math.floor(options.baselineLagRadius ?? 3),
    );
    const baselineLagCenter = Math.round(options.baselineLagCenter ?? 0);
    const cacheKey = [
        shiftYears,
        edgeYears,
        maximumReferences,
        baselineLagCenter,
        baselineLagRadius,
    ].join(":");
    const bySite = CACHE.get(diagnosis) ?? new WeakMap();
    const byKey = bySite.get(siteData) ?? new Map();
    const cached = byKey.get(cacheKey);
    if (cached) return cached;

    const whitenedDiagnosis = WHITENED_DIAGNOSIS_CACHE.get(diagnosis) ?? {
        ...diagnosis,
        rawTarget: ar1WhitenSeries(diagnosis.rawTarget),
    };
    WHITENED_DIAGNOSIS_CACHE.set(diagnosis, whitenedDiagnosis);
    const target: PreparedTarget = {
        raw: preprocessSeries(diagnosis.rawTarget),
        difference: firstDifferences(diagnosis.rawTarget),
        whitened: whitenedDiagnosis.rawTarget,
    };
    const profiles = getPreparedReferences(
        diagnosis,
        siteData,
        maximumReferences,
        baselineLagCenter,
        baselineLagRadius,
    ).flatMap((reference): ReferenceProfile[] => {
        const profile = scoreReference(
            diagnosis,
            whitenedDiagnosis,
            target,
            reference,
            shiftYears,
            edgeYears,
            baselineLagCenter,
        );
        return profile ? [profile] : [];
    });
    if (profiles.length < 3) {
        byKey.set(cacheKey, []);
        bySite.set(siteData, byKey);
        CACHE.set(diagnosis, bySite);
        return [];
    }
    const rowsByReference = profiles.map((profile) => new Map(
        profile.rows.map((row) => [row.year, row]),
    ));
    const years = [...new Set(profiles.flatMap(
        (profile) => profile.rows.map((row) => row.year),
    ))].sort((left, right) => left - right);
    const result = years.flatMap((year): PerReferenceCounterfactualRow[] => {
        const available = profiles.flatMap((profile, index) => {
            const row = rowsByReference[index].get(year);
            return row ? [{ profile, row }] : [];
        });
        if (available.length < 3) return [];
        const totalWeight = available.reduce(
            (sum, item) => sum + item.profile.weight,
            0,
        );
        const kernel = (radius: number): number => mean(
            available.map((item) => Math.exp(
                -0.5 * ((year - item.profile.peakYear) / radius) ** 2,
            )),
        );
        const lagStepKernel = (radius: number): number => mean(
            available.map((item) => Math.exp(
                -0.5 * ((year - item.profile.lagStepPeakYear) / radius) ** 2,
            )),
        );
        const fixedLagStepKernel = (radius: number): number => mean(
            available.map((item) => Math.exp(
                -0.5
                    * ((year - item.profile.fixedLagStepPeakYear) / radius) ** 2,
            )),
        );
        return [{
            year,
            referenceCount: available.length,
            differenceWeighted: available.reduce(
                (sum, item) => (
                    sum + item.row.difference * item.profile.weight
                ),
                0,
            ) / totalWeight,
            differenceGainWeighted: available.reduce(
                (sum, item) => (
                    sum + item.row.differenceGain * item.profile.weight
                ),
                0,
            ) / totalWeight,
            whitenedMean: mean(
                available.map((item) => item.row.whitened),
            ),
            whitenedGainMean: mean(
                available.map((item) => item.row.whitenedGain),
            ),
            positiveDifferenceGainFraction: available.filter(
                (item) => item.row.differenceGain > 0,
            ).length / available.length,
            positiveWhitenedGainFraction: available.filter(
                (item) => item.row.whitenedGain > 0,
            ).length / available.length,
            positiveSideStepFraction: available.filter(
                (item) => item.row.sideStep > 0,
            ).length / available.length,
            peakKernel5: kernel(2.5),
            peakKernel9: kernel(4.5),
            lagStepWeighted: available.reduce(
                (sum, item) => (
                    sum + item.row.lagStepRank * item.profile.weight
                ),
                0,
            ) / totalWeight,
            lagStepMedian: median(
                available.map((item) => item.row.lagStepRank),
            ),
            lagStepPositiveFraction: available.filter(
                (item) => item.row.lagStepScore > 0,
            ).length / available.length,
            lagStepPeakKernel5: lagStepKernel(2.5),
            lagStepPeakKernel9: lagStepKernel(4.5),
            fixedLagStepWeighted: available.reduce(
                (sum, item) => (
                    sum + item.row.fixedLagStepRank * item.profile.weight
                ),
                0,
            ) / totalWeight,
            fixedLagStepMedian: median(
                available.map((item) => item.row.fixedLagStepRank),
            ),
            fixedLagStepPositiveFraction: available.filter(
                (item) => item.row.fixedLagStepScore > 0,
            ).length / available.length,
            fixedLagStepPeakKernel5: fixedLagStepKernel(2.5),
            fixedLagStepPeakKernel9: fixedLagStepKernel(4.5),
        }];
    });
    byKey.set(cacheKey, result);
    bySite.set(siteData, byKey);
    CACHE.set(diagnosis, bySite);
    return result;
};

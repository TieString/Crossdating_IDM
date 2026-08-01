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
    peakKernel5: number;
    peakKernel9: number;
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
};

type ReferenceProfile = PreparedReference & {
    peakYear: number;
    rows: ReferenceYearScore[];
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
        .flatMap((raw): PreparedReference[] => {
            const baseline = bestBaselineLag(
                diagnosis,
                raw,
                baselineLagCenter,
                baselineLagRadius,
            );
            if (!baseline || baseline.correlation <= -0.1) return [];
            return [{
                raw,
                whitened: ar1WhitenSeries(raw),
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

const scoreReference = (
    diagnosis: SeriesCoreDiagnosis,
    whitenedDiagnosis: SeriesCoreDiagnosis,
    reference: PreparedReference,
    shiftYears: number,
    edgeYears: number,
): ReferenceProfile | null => {
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
        }];
    });
    if (rows.length < 15) return null;
    const peak = rows.reduce((best, row) => {
        const score = row.differenceGain * 0.65 + row.whitenedGain * 0.35;
        const bestScore =
            best.differenceGain * 0.65 + best.whitenedGain * 0.35;
        return score > bestScore ? row : best;
    }, rows[0]);
    return {
        ...reference,
        peakYear: peak.year,
        rows,
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
            reference,
            shiftYears,
            edgeYears,
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
            peakKernel5: kernel(2.5),
            peakKernel9: kernel(4.5),
        }];
    });
    byKey.set(cacheKey, result);
    bySite.set(siteData, byKey);
    CACHE.set(diagnosis, bySite);
    return result;
};

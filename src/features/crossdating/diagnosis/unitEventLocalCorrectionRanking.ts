/**
 * Sharp local residual evidence for exact-year ranking inside a frozen unit-event window.
 *
 * Only the two cross-partition validated views are retained here. The virtual correction is
 * evaluated for at most 13 visible years, so this does not rescan the coarse search interval.
 */
import { ar1WhitenSeries } from "./series";
import type { NumericSeries, SeriesCoreDiagnosis } from "./types";

export type UnitEventLocalCorrectionType = "missingRing" | "falseRing";

export type UnitEventLocalCorrectionRanking = {
    rankByYear: ReadonlyMap<number, number>;
    profileName:
        | "whitenedMasterHuberBoundary13"
        | "whitenedOlderHuberBoundary5";
};

const MASTER_CACHE = new WeakMap<SeriesCoreDiagnosis, NumericSeries>();
const CORRECTED_CACHE = new WeakMap<
    SeriesCoreDiagnosis,
    Map<string, NumericSeries>
>();

const huberLoss = (residual: number, transition = 1.5): number => {
    const absolute = Math.abs(residual);
    return absolute <= transition
        ? 0.5 * residual * residual
        : transition * (absolute - transition * 0.5);
};

const huberSimilarity = (
    target: NumericSeries,
    master: NumericSeries,
    startYear: number,
    endYear: number,
    minimumPairs: number,
): number | null => {
    let loss = 0;
    let pairs = 0;
    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const masterValue = master.get(year);
        if (targetValue === undefined || masterValue === undefined) continue;
        loss += huberLoss(targetValue - masterValue);
        pairs += 1;
    }
    return pairs >= minimumPairs ? -loss / pairs : null;
};

const simulateCorrection = (
    series: NumericSeries,
    eventType: UnitEventLocalCorrectionType,
    year: number,
): NumericSeries => {
    const corrected = new Map<number, number>();
    series.forEach((value, sourceYear) => {
        if (eventType === "missingRing") {
            corrected.set(
                sourceYear <= year ? sourceYear - 1 : sourceYear,
                value,
            );
            return;
        }
        if (sourceYear !== year) {
            corrected.set(
                sourceYear < year ? sourceYear + 1 : sourceYear,
                value,
            );
        }
    });
    return corrected;
};

const correctedWhitened = (
    diagnosis: SeriesCoreDiagnosis,
    eventType: UnitEventLocalCorrectionType,
    year: number,
): NumericSeries => {
    const byKey = CORRECTED_CACHE.get(diagnosis) ?? new Map();
    const key = `${eventType}:${year}`;
    const cached = byKey.get(key);
    if (cached) return cached;
    const corrected = ar1WhitenSeries(simulateCorrection(
        diagnosis.rawTarget,
        eventType,
        year,
    ));
    byKey.set(key, corrected);
    CORRECTED_CACHE.set(diagnosis, byKey);
    return corrected;
};

const percentileRanks = (values: readonly number[]): number[] => values.map(
    (selected) => (
        values.filter((value) => value < selected).length
        + values.filter((value) => value === selected).length * 0.5
    ) / Math.max(1, values.length),
);

export const scoreUnitEventLocalCorrectionRanks = (
    diagnosis: SeriesCoreDiagnosis,
    eventType: UnitEventLocalCorrectionType,
    years: readonly number[],
): UnitEventLocalCorrectionRanking | null => {
    if (years.length === 0) return null;
    const master = MASTER_CACHE.get(diagnosis)
        ?? ar1WhitenSeries(diagnosis.master.data);
    MASTER_CACHE.set(diagnosis, master);
    const values = years.map((year) => {
        const corrected = correctedWhitened(diagnosis, eventType, year);
        if (eventType === "missingRing") {
            return huberSimilarity(
                corrected,
                master,
                year - 6,
                year + 6,
                6,
            ) ?? -10;
        }
        return huberSimilarity(
            corrected,
            master,
            year - 2,
            year - 1,
            2,
        ) ?? -10;
    });
    const ranks = percentileRanks(values);
    return {
        rankByYear: new Map(years.map((year, index) => [year, ranks[index]])),
        profileName: eventType === "missingRing"
            ? "whitenedMasterHuberBoundary13"
            : "whitenedOlderHuberBoundary5",
    };
};

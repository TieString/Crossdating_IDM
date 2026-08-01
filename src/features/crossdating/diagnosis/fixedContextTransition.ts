/**
 * Scores a persistent older-side lag that returns to zero at a calendar boundary.
 *
 * Both sides use fixed local contexts. This keeps a long natural correlation regime from
 * overpowering a short but genuine lag transition and makes the two-sided requirement explicit.
 */
import { cofechaStyleStandardize } from "../reference";
import { correlationForSegment } from "./series";
import type { NumericSeries, SeriesCoreDiagnosis } from "./types";

export type FixedContextTransitionConfig = {
    contextYears: number;
    minPairs: number;
    rawWeight: number;
    differenceWeight: number;
};

export type FixedContextTransitionScore = {
    year: number;
    olderLag: number;
    score: number;
    minimumSideAdvantage: number;
    olderAdvantage: number;
    newerAdvantage: number;
    rawContrast: number;
    differenceContrast: number;
    samplePairs: number;
};

export const DEFAULT_FIXED_CONTEXT_TRANSITION_CONFIG:
FixedContextTransitionConfig = {
    contextYears: 21,
    minPairs: 10,
    rawWeight: 0.3,
    differenceWeight: 0.7,
};

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const result = new Map<number, number>();
    const entries = [...series.entries()].sort((left, right) => left[0] - right[0]);
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return result;
};

const lagAdvantage = (
    target: NumericSeries,
    master: NumericSeries,
    startYear: number,
    endYear: number,
    preferredLag: number,
    alternativeLag: number,
    minPairs: number,
): { advantage: number | null; samplePairs: number } => {
    const preferred = correlationForSegment(
        target,
        master,
        startYear,
        endYear,
        preferredLag,
        minPairs,
    );
    const alternative = correlationForSegment(
        target,
        master,
        startYear,
        endYear,
        alternativeLag,
        minPairs,
    );
    return {
        advantage: preferred.correlation === null || alternative.correlation === null
            ? null
            : preferred.correlation - alternative.correlation,
        samplePairs: Math.min(preferred.samplePairs, alternative.samplePairs),
    };
};

type ViewScore = {
    older: number;
    newer: number;
    contrast: number;
    samplePairs: number;
};

const scoreView = (
    target: NumericSeries,
    master: NumericSeries,
    year: number,
    olderLag: number,
    config: FixedContextTransitionConfig,
): ViewScore | null => {
    // A false ring is an extra observation at the boundary and should support neither side.
    const olderEnd = olderLag === 1 ? year - 1 : year;
    const older = lagAdvantage(
        target,
        master,
        olderEnd - config.contextYears + 1,
        olderEnd,
        olderLag,
        0,
        config.minPairs,
    );
    const newer = lagAdvantage(
        target,
        master,
        year + 1,
        year + config.contextYears,
        0,
        olderLag,
        config.minPairs,
    );
    if (older.advantage === null || newer.advantage === null) return null;
    return {
        older: older.advantage,
        newer: newer.advantage,
        contrast: older.advantage + newer.advantage,
        samplePairs: older.samplePairs + newer.samplePairs,
    };
};

export const scoreFixedContextTransitions = (
    diagnosis: SeriesCoreDiagnosis,
    olderLag: number,
    overrides: Partial<FixedContextTransitionConfig> = {},
): FixedContextTransitionScore[] => {
    if (olderLag === 0) return [];
    const config = { ...DEFAULT_FIXED_CONTEXT_TRANSITION_CONFIG, ...overrides };
    const target = new Map(
        cofechaStyleStandardize(diagnosis.rawTarget).map((point) => [point.year, point.value]),
    );
    const master = diagnosis.master.data;
    const targetDifferences = firstDifferences(target);
    const masterDifferences = firstDifferences(master);
    const rows: FixedContextTransitionScore[] = [];
    for (
        let year = diagnosis.targetRange.startYear + config.contextYears;
        year <= diagnosis.targetRange.endYear - config.contextYears;
        year += 1
    ) {
        const raw = scoreView(target, master, year, olderLag, config);
        const difference = scoreView(
            targetDifferences,
            masterDifferences,
            year,
            olderLag,
            config,
        );
        if (!raw || !difference) continue;
        const olderAdvantage = raw.older * config.rawWeight
            + difference.older * config.differenceWeight;
        const newerAdvantage = raw.newer * config.rawWeight
            + difference.newer * config.differenceWeight;
        const minimumSideAdvantage = Math.min(olderAdvantage, newerAdvantage);
        const totalAdvantage = olderAdvantage + newerAdvantage;
        rows.push({
            year,
            olderLag,
            score: Math.abs(olderLag) === 1
                ? totalAdvantage
                : minimumSideAdvantage + totalAdvantage * 0.02,
            minimumSideAdvantage,
            olderAdvantage,
            newerAdvantage,
            rawContrast: raw.contrast,
            differenceContrast: difference.contrast,
            samplePairs: Math.min(raw.samplePairs, difference.samplePairs),
        });
    }
    return rows.sort((left, right) => (
        right.score - left.score
        || right.minimumSideAdvantage - left.minimumSideAdvantage
        || right.year - left.year
    ));
};

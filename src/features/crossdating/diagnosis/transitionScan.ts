/**
 * Direct changepoint scan for an older-side lag that returns to lag 0 on the newer side.
 *
 * Unlike the per-year Viterbi path, this scorer fits both sides of every possible boundary as
 * complete correlation intervals. It is intentionally constrained to one transition and is
 * therefore useful as a precise localizer and as independent support for a path event.
 */
import { cofechaStyleStandardize } from "../reference";
import type {
    DiagnosisConfidence,
    DiagnosisEvent,
    DiagnosisEventType,
    DiagnosisRankedYear,
    NumericSeries,
    SeriesCoreDiagnosis,
} from "./types";

export type TransitionScanConfig = {
    minLag: number;
    maxLag: number;
    minRunYears: number;
    missingFalseWindowWidth: number;
    partialWindowWidth: number;
    rawWeight: number;
    differenceWeight: number;
    minGain: number;
    mediumGain: number;
    highGain: number;
};

export const DEFAULT_TRANSITION_SCAN_CONFIG: TransitionScanConfig = {
    minLag: -5,
    maxLag: 5,
    minRunYears: 18,
    missingFalseWindowWidth: 7,
    partialWindowWidth: 9,
    rawWeight: 0.3,
    differenceWeight: 0.7,
    minGain: 3,
    mediumGain: 6,
    highGain: 10,
};

type PairPrefix = {
    count: Float64Array;
    sumX: Float64Array;
    sumY: Float64Array;
    sumXX: Float64Array;
    sumYY: Float64Array;
    sumXY: Float64Array;
};

type ProfileRow = {
    year: number;
    score: number;
    samplePairs: number;
};

type TransitionProfile = {
    olderLag: number;
    newerLag: number;
    gain: number;
    rows: ProfileRow[];
};

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const result = new Map<number, number>();
    const entries = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return result;
};

const buildPrefix = (
    years: number[],
    target: NumericSeries,
    master: NumericSeries,
    lag: number,
): PairPrefix => {
    const length = years.length + 1;
    const prefix: PairPrefix = {
        count: new Float64Array(length),
        sumX: new Float64Array(length),
        sumY: new Float64Array(length),
        sumXX: new Float64Array(length),
        sumYY: new Float64Array(length),
        sumXY: new Float64Array(length),
    };
    years.forEach((year, index) => {
        const next = index + 1;
        prefix.count[next] = prefix.count[index];
        prefix.sumX[next] = prefix.sumX[index];
        prefix.sumY[next] = prefix.sumY[index];
        prefix.sumXX[next] = prefix.sumXX[index];
        prefix.sumYY[next] = prefix.sumYY[index];
        prefix.sumXY[next] = prefix.sumXY[index];
        const x = target.get(year);
        const y = master.get(year + lag);
        if (x === undefined || y === undefined) return;
        prefix.count[next] += 1;
        prefix.sumX[next] += x;
        prefix.sumY[next] += y;
        prefix.sumXX[next] += x * x;
        prefix.sumYY[next] += y * y;
        prefix.sumXY[next] += x * y;
    });
    return prefix;
};

const range = (values: Float64Array, start: number, end: number): number => (
    values[end + 1] - values[start]
);

const intervalEvidence = (
    prefix: PairPrefix,
    start: number,
    end: number,
): { score: number; pairs: number } => {
    if (end < start) return { score: Number.NEGATIVE_INFINITY, pairs: 0 };
    const pairs = range(prefix.count, start, end);
    if (pairs < 8) return { score: Number.NEGATIVE_INFINITY, pairs };
    const sumX = range(prefix.sumX, start, end);
    const sumY = range(prefix.sumY, start, end);
    const sumXX = range(prefix.sumXX, start, end);
    const sumYY = range(prefix.sumYY, start, end);
    const sumXY = range(prefix.sumXY, start, end);
    const covariance = sumXY - sumX * sumY / pairs;
    const varianceX = sumXX - sumX * sumX / pairs;
    const varianceY = sumYY - sumY * sumY / pairs;
    const denominator = Math.sqrt(Math.max(0, varianceX * varianceY));
    if (!Number.isFinite(denominator) || denominator <= 0) {
        return { score: Number.NEGATIVE_INFINITY, pairs };
    }
    const correlation = Math.max(-0.97, Math.min(0.97, covariance / denominator));
    // Gaussian regression log-likelihood gain over an uncorrelated interval.
    const score = correlation > 0
        ? -0.5 * pairs * Math.log(Math.max(1e-6, 1 - correlation * correlation))
        : 0;
    return { score, pairs };
};

class Scorer {
    private readonly raw: Map<number, PairPrefix>;
    private readonly differences: Map<number, PairPrefix>;

    constructor(
        years: number[],
        target: NumericSeries,
        master: NumericSeries,
        lags: number[],
        private readonly config: TransitionScanConfig,
    ) {
        const targetDifferences = firstDifferences(target);
        const masterDifferences = firstDifferences(master);
        this.raw = new Map(lags.map((lag) => [lag, buildPrefix(years, target, master, lag)]));
        this.differences = new Map(lags.map((lag) => [
            lag,
            buildPrefix(years, targetDifferences, masterDifferences, lag),
        ]));
    }

    interval(lag: number, start: number, end: number): { score: number; pairs: number } {
        const raw = this.raw.get(lag);
        const differences = this.differences.get(lag);
        if (!raw || !differences) return { score: Number.NEGATIVE_INFINITY, pairs: 0 };
        const rawEvidence = intervalEvidence(raw, start, end);
        const differenceEvidence = intervalEvidence(differences, start, end);
        if (!Number.isFinite(rawEvidence.score) && !Number.isFinite(differenceEvidence.score)) {
            return { score: Number.NEGATIVE_INFINITY, pairs: 0 };
        }
        return {
            score: (Number.isFinite(rawEvidence.score) ? rawEvidence.score : 0) * this.config.rawWeight
                + (Number.isFinite(differenceEvidence.score) ? differenceEvidence.score : 0)
                    * this.config.differenceWeight,
            pairs: Math.max(rawEvidence.pairs, differenceEvidence.pairs),
        };
    }
}

const transitionType = (olderLag: number, newerLag: number): DiagnosisEventType => {
    const correction = olderLag - newerLag;
    if (correction === -1) return "missingRing";
    if (correction === 1) return "falseRing";
    return "partialMove";
};

const profileFor = (
    scorer: Scorer,
    years: number[],
    lags: number[],
    olderLag: number,
    newerLag: number,
    config: TransitionScanConfig,
): TransitionProfile | null => {
    const rows: ProfileRow[] = [];
    for (
        let boundary = config.minRunYears - 1;
        boundary <= years.length - config.minRunYears - 1;
        boundary += 1
    ) {
        // A false ring is an extra observation at the boundary. Its width is not expected to
        // align to either side, so compare transitions after omitting that one observation.
        const omitBoundary = olderLag - newerLag === 1;
        const olderEnd = omitBoundary ? boundary - 1 : boundary;
        const older = scorer.interval(olderLag, 0, olderEnd);
        const newer = scorer.interval(newerLag, boundary + 1, years.length - 1);
        if (!Number.isFinite(older.score) || !Number.isFinite(newer.score)) continue;
        let nullScore = Number.NEGATIVE_INFINITY;
        lags.forEach((lag) => {
            const nullOlder = scorer.interval(lag, 0, olderEnd);
            const nullNewer = scorer.interval(lag, boundary + 1, years.length - 1);
            if (Number.isFinite(nullOlder.score) && Number.isFinite(nullNewer.score)) {
                nullScore = Math.max(nullScore, nullOlder.score + nullNewer.score);
            }
        });
        if (!Number.isFinite(nullScore)) continue;
        rows.push({
            year: years[boundary],
            score: older.score + newer.score - nullScore,
            samplePairs: older.pairs + newer.pairs,
        });
    }
    rows.sort((a, b) => b.score - a.score || b.year - a.year);
    return rows[0] ? { olderLag, newerLag, gain: rows[0].score, rows } : null;
};

const boundedWindow = (
    center: number,
    width: number,
    minimum: number,
    maximum: number,
): { startYear: number; endYear: number } => {
    const actualWidth = Math.max(1, Math.min(width, maximum - minimum + 1));
    let startYear = center - Math.floor((actualWidth - 1) / 2);
    startYear = Math.max(minimum, Math.min(startYear, maximum - actualWidth + 1));
    return { startYear, endYear: startYear + actualWidth - 1 };
};

const confidenceFor = (gain: number, config: TransitionScanConfig): DiagnosisConfidence => (
    gain >= config.highGain ? "high" : gain >= config.mediumGain ? "medium" : "low"
);

const rankedYears = (
    rows: ProfileRow[],
    startYear: number,
    endYear: number,
): DiagnosisRankedYear[] => {
    const rowsByYear = new Map(rows.map((row) => [row.year, row]));
    return Array.from({ length: endYear - startYear + 1 }, (_, offset) => {
        const year = startYear + offset;
        return {
            year,
            score: rowsByYear.get(year)?.score ?? Number.NEGATIVE_INFINITY,
            evidenceTags: ["direct_transition_scan"],
        };
    })
        .sort((a, b) => b.score - a.score || b.year - a.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
};

/** Returns at most one return-to-zero transition for each event type. */
export const locateReturnToZeroEvents = (
    diagnosis: SeriesCoreDiagnosis,
    overrides: Partial<TransitionScanConfig> = {},
): DiagnosisEvent[] => {
    const config = { ...DEFAULT_TRANSITION_SCAN_CONFIG, ...overrides };
    const target = new Map(
        cofechaStyleStandardize(diagnosis.rawTarget).map((point) => [point.year, point.value]),
    );
    const master = diagnosis.master.data;
    const years: number[] = [];
    for (let year = diagnosis.targetRange.startYear; year <= diagnosis.targetRange.endYear; year += 1) {
        years.push(year);
    }
    if (years.length < config.minRunYears * 2) return [];
    const lags = Array.from(
        { length: config.maxLag - config.minLag + 1 },
        (_, index) => config.minLag + index,
    );
    const scorer = new Scorer(years, target, master, lags, config);
    const profiles = lags
        .filter((lag) => lag !== 0)
        .map((lag) => profileFor(scorer, years, lags, lag, 0, config))
        .filter((profile): profile is TransitionProfile => profile !== null);

    const bestByType = new Map<DiagnosisEventType, TransitionProfile>();
    profiles.forEach((profile) => {
        const type = transitionType(profile.olderLag, profile.newerLag);
        const current = bestByType.get(type);
        if (!current || profile.gain > current.gain) bestByType.set(type, profile);
    });

    return Array.from(bestByType.entries()).flatMap(([eventType, profile]) => {
        if (profile.gain < config.minGain) return [];
        const top = profile.rows[0];
        const width = eventType === "partialMove"
            ? config.partialWindowWidth
            : config.missingFalseWindowWidth;
        const window = boundedWindow(
            top.year,
            width,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
        );
        const correctionYears = profile.olderLag - profile.newerLag;
        return [{
            id: `diagnosis-event-${diagnosis.targetTree}-transition-${eventType}-${window.startYear}-${window.endYear}`,
            seriesId: diagnosis.targetTree,
            eventType,
            ...window,
            rankedYears: rankedYears(profile.rows, window.startYear, window.endYear),
            confidenceLevel: confidenceFor(profile.gain, config),
            evidence: {
                algorithmSources: ["direct_transition_scan"],
                score: profile.gain,
                scoreMargin: profile.gain - (profile.rows[1]?.score ?? profile.gain),
                baselineCorrelation: diagnosis.globalSlidingMatch.currentR,
                correctedCorrelation: diagnosis.globalSlidingMatch.bestGlobalR,
                correlationGain: diagnosis.globalSlidingMatch.bestGlobalR === null
                    ? null
                    : diagnosis.globalSlidingMatch.bestGlobalR
                        - (diagnosis.globalSlidingMatch.currentR ?? 0),
                lagBefore: profile.olderLag,
                lagAfter: profile.newerLag,
                samplePairs: top.samplePairs,
                candidateIds: [],
                notes: [
                    `direct lag transition ${profile.olderLag} -> ${profile.newerLag}`,
                    "score_is_relative_not_probability",
                ],
            },
            alternativeTypes: Math.abs(correctionYears) === 1 ? ["partialMove"] : [],
            ...(eventType === "partialMove" ? {
                shiftYears: correctionYears,
                shiftSide: "older" as const,
            } : {}),
        }];
    });
};

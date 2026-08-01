/**
 * Penalized piecewise-constant lag model for diagnosis events.
 *
 * Each run has one integer lag and at least `minRunYears` calendar years. Dynamic programming
 * chooses a small number of runs from interval correlation evidence; every lag transition pays
 * an explicit model-complexity penalty. This is constrained changepoint detection, not DTW.
 */
import { ar1WhitenSeries, preprocessSeries } from "./series";
import type {
    DiagnosisConfidence,
    DiagnosisEvent,
    DiagnosisEventType,
    DiagnosisRankedYear,
    NumericSeries,
    SeriesCoreDiagnosis,
} from "./types";

export type SegmentedEventPathConfig = {
    minLag: number;
    maxLag: number;
    relativeLagRadius: number;
    minRunYears: number;
    maxSegments: number;
    minPairs: number;
    minPairCoverage: number;
    rawWeight: number;
    whitenedWeight: number;
    transitionPenalty: number;
    largeTransitionPenalty: number;
    transitionPenaltyPerYear: number;
    localizationRadius: number;
    missingFalseWindowWidth: number;
    partialWindowWidth: number;
    missingBoundaryYearAdjustment: number;
    falseBoundaryYearAdjustment: number;
    partialBoundaryYearAdjustment: number;
    minLocalGain: number;
    mediumLocalGain: number;
    highLocalGain: number;
};

export const DEFAULT_SEGMENTED_EVENT_PATH_CONFIG: SegmentedEventPathConfig = {
    minLag: -10,
    maxLag: 10,
    relativeLagRadius: 6,
    minRunYears: 14,
    maxSegments: 5,
    minPairs: 10,
    minPairCoverage: 0.55,
    rawWeight: 0.35,
    whitenedWeight: 0.65,
    transitionPenalty: 7,
    largeTransitionPenalty: 8,
    transitionPenaltyPerYear: 0.75,
    localizationRadius: 12,
    missingFalseWindowWidth: 7,
    partialWindowWidth: 9,
    missingBoundaryYearAdjustment: 0,
    falseBoundaryYearAdjustment: 0,
    partialBoundaryYearAdjustment: 0,
    minLocalGain: 3,
    mediumLocalGain: 6,
    highLocalGain: 10,
};

type PairPrefix = {
    n: Float64Array;
    sx: Float64Array;
    sy: Float64Array;
    sxx: Float64Array;
    syy: Float64Array;
    sxy: Float64Array;
};

type Run = {
    stateIndex: number;
    startIndex: number;
    endIndex: number;
};

type BoundaryRow = {
    year: number;
    score: number;
    samplePairs: number;
};

const NEGATIVE_INFINITY = Number.NEGATIVE_INFINITY;

const buildStates = (
    globalLag: number,
    config: SegmentedEventPathConfig,
): number[] => {
    const states = new Set<number>([0, globalLag]);
    for (let lag = config.minLag; lag <= config.maxLag; lag += 1) states.add(lag);
    for (
        let lag = globalLag - config.relativeLagRadius;
        lag <= globalLag + config.relativeLagRadius;
        lag += 1
    ) states.add(lag);
    return Array.from(states).sort((a, b) => a - b);
};

const buildPairPrefix = (
    years: number[],
    target: NumericSeries,
    master: NumericSeries,
    lag: number,
): PairPrefix => {
    const length = years.length + 1;
    const result: PairPrefix = {
        n: new Float64Array(length),
        sx: new Float64Array(length),
        sy: new Float64Array(length),
        sxx: new Float64Array(length),
        syy: new Float64Array(length),
        sxy: new Float64Array(length),
    };
    years.forEach((year, index) => {
        const next = index + 1;
        result.n[next] = result.n[index];
        result.sx[next] = result.sx[index];
        result.sy[next] = result.sy[index];
        result.sxx[next] = result.sxx[index];
        result.syy[next] = result.syy[index];
        result.sxy[next] = result.sxy[index];
        const x = target.get(year);
        const y = master.get(year + lag);
        if (x === undefined || y === undefined) return;
        result.n[next] += 1;
        result.sx[next] += x;
        result.sy[next] += y;
        result.sxx[next] += x * x;
        result.syy[next] += y * y;
        result.sxy[next] += x * y;
    });
    return result;
};

const rangeValue = (values: Float64Array, startIndex: number, endIndex: number): number => (
    values[endIndex + 1] - values[startIndex]
);

const intervalCorrelation = (
    prefix: PairPrefix,
    startIndex: number,
    endIndex: number,
): { correlation: number | null; pairs: number } => {
    const pairs = rangeValue(prefix.n, startIndex, endIndex);
    if (pairs < 3) return { correlation: null, pairs };
    const sx = rangeValue(prefix.sx, startIndex, endIndex);
    const sy = rangeValue(prefix.sy, startIndex, endIndex);
    const sxx = rangeValue(prefix.sxx, startIndex, endIndex);
    const syy = rangeValue(prefix.syy, startIndex, endIndex);
    const sxy = rangeValue(prefix.sxy, startIndex, endIndex);
    const covariance = sxy - sx * sy / pairs;
    const varianceX = sxx - sx * sx / pairs;
    const varianceY = syy - sy * sy / pairs;
    const denominator = Math.sqrt(Math.max(0, varianceX * varianceY));
    if (!Number.isFinite(denominator) || denominator <= 0) return { correlation: null, pairs };
    return { correlation: covariance / denominator, pairs };
};

const regressionEvidence = (correlation: number | null, pairs: number): number => {
    if (correlation === null || correlation <= 0) return 0;
    const bounded = Math.min(0.97, correlation);
    return -0.5 * pairs * Math.log(Math.max(1e-6, 1 - bounded * bounded));
};

class IntervalScorer {
    private readonly rawPrefixes: PairPrefix[];
    private readonly whitenedPrefixes: PairPrefix[];
    private readonly scoreCache: Float64Array[];
    private readonly pairCache: Float64Array[];

    constructor(
        private readonly years: number[],
        states: number[],
        rawTarget: NumericSeries,
        rawMaster: NumericSeries,
        whitenedTarget: NumericSeries,
        whitenedMaster: NumericSeries,
        private readonly config: SegmentedEventPathConfig,
    ) {
        this.rawPrefixes = states.map((lag) => buildPairPrefix(years, rawTarget, rawMaster, lag));
        this.whitenedPrefixes = states.map((lag) => (
            buildPairPrefix(years, whitenedTarget, whitenedMaster, lag)
        ));
        const cacheSize = years.length * years.length;
        this.scoreCache = states.map(() => new Float64Array(cacheSize).fill(Number.NaN));
        this.pairCache = states.map(() => new Float64Array(cacheSize).fill(Number.NaN));
    }

    score(stateIndex: number, startIndex: number, endIndex: number): number {
        if (endIndex < startIndex) return NEGATIVE_INFINITY;
        const offset = startIndex * this.years.length + endIndex;
        const cached = this.scoreCache[stateIndex][offset];
        if (!Number.isNaN(cached)) return cached;
        const calendarLength = endIndex - startIndex + 1;
        const raw = intervalCorrelation(this.rawPrefixes[stateIndex], startIndex, endIndex);
        const whitened = intervalCorrelation(this.whitenedPrefixes[stateIndex], startIndex, endIndex);
        const pairs = Math.max(raw.pairs, whitened.pairs);
        const enoughPairs = pairs >= this.config.minPairs
            && pairs >= calendarLength * this.config.minPairCoverage;
        const score = enoughPairs
            ? this.config.rawWeight * regressionEvidence(raw.correlation, raw.pairs)
                + this.config.whitenedWeight * regressionEvidence(whitened.correlation, whitened.pairs)
            : NEGATIVE_INFINITY;
        this.scoreCache[stateIndex][offset] = score;
        this.pairCache[stateIndex][offset] = pairs;
        return score;
    }

    pairs(stateIndex: number, startIndex: number, endIndex: number): number {
        this.score(stateIndex, startIndex, endIndex);
        return this.pairCache[stateIndex][startIndex * this.years.length + endIndex];
    }
}

const transitionPenalty = (
    fromLag: number,
    toLag: number,
    config: SegmentedEventPathConfig,
): number => {
    const magnitude = Math.abs(toLag - fromLag);
    if (magnitude === 0) return Number.POSITIVE_INFINITY;
    if (magnitude === 1) return config.transitionPenalty;
    return config.largeTransitionPenalty
        + Math.max(0, magnitude - 2) * config.transitionPenaltyPerYear;
};

const fitRuns = (
    scorer: IntervalScorer,
    years: number[],
    states: number[],
    config: SegmentedEventPathConfig,
): Run[] => {
    const yearCount = years.length;
    const stateCount = states.length;
    const maxSegments = Math.min(config.maxSegments, Math.floor(yearCount / config.minRunYears));
    if (maxSegments < 1) return [];

    let previous = new Float64Array(yearCount * stateCount).fill(NEGATIVE_INFINITY);
    const backStarts: Int32Array[] = [];
    const backStates: Int32Array[] = [];
    const finalScores: Array<{ segmentCount: number; score: number; stateIndex: number }> = [];

    for (let endIndex = config.minRunYears - 1; endIndex < yearCount; endIndex += 1) {
        for (let stateIndex = 0; stateIndex < stateCount; stateIndex += 1) {
            previous[endIndex * stateCount + stateIndex] = scorer.score(stateIndex, 0, endIndex);
        }
    }
    backStarts.push(new Int32Array(yearCount * stateCount).fill(0));
    backStates.push(new Int32Array(yearCount * stateCount).fill(-1));

    const recordFinal = (segmentCount: number, scores: Float64Array) => {
        let bestScore = NEGATIVE_INFINITY;
        let bestState = -1;
        for (let stateIndex = 0; stateIndex < stateCount; stateIndex += 1) {
            const score = scores[(yearCount - 1) * stateCount + stateIndex];
            if (score > bestScore) {
                bestScore = score;
                bestState = stateIndex;
            }
        }
        if (bestState >= 0) finalScores.push({ segmentCount, score: bestScore, stateIndex: bestState });
    };
    recordFinal(1, previous);

    for (let segmentCount = 2; segmentCount <= maxSegments; segmentCount += 1) {
        const transitioned = new Float64Array(yearCount * stateCount).fill(NEGATIVE_INFINITY);
        const transitionedFrom = new Int32Array(yearCount * stateCount).fill(-1);
        for (let previousEnd = 0; previousEnd < yearCount; previousEnd += 1) {
            for (let toState = 0; toState < stateCount; toState += 1) {
                let best = NEGATIVE_INFINITY;
                let bestFrom = -1;
                for (let fromState = 0; fromState < stateCount; fromState += 1) {
                    const prior = previous[previousEnd * stateCount + fromState];
                    if (!Number.isFinite(prior)) continue;
                    const penalty = transitionPenalty(states[fromState], states[toState], config);
                    const score = prior - penalty;
                    if (score > best) {
                        best = score;
                        bestFrom = fromState;
                    }
                }
                transitioned[previousEnd * stateCount + toState] = best;
                transitionedFrom[previousEnd * stateCount + toState] = bestFrom;
            }
        }

        const current = new Float64Array(yearCount * stateCount).fill(NEGATIVE_INFINITY);
        const starts = new Int32Array(yearCount * stateCount).fill(-1);
        const fromStates = new Int32Array(yearCount * stateCount).fill(-1);
        const minimumStart = (segmentCount - 1) * config.minRunYears;
        for (let endIndex = segmentCount * config.minRunYears - 1; endIndex < yearCount; endIndex += 1) {
            const latestStart = endIndex - config.minRunYears + 1;
            for (let stateIndex = 0; stateIndex < stateCount; stateIndex += 1) {
                let best = NEGATIVE_INFINITY;
                let bestStart = -1;
                let bestFromState = -1;
                for (let startIndex = minimumStart; startIndex <= latestStart; startIndex += 1) {
                    const priorEnd = startIndex - 1;
                    const prior = transitioned[priorEnd * stateCount + stateIndex];
                    if (!Number.isFinite(prior)) continue;
                    const interval = scorer.score(stateIndex, startIndex, endIndex);
                    const score = prior + interval;
                    if (score > best) {
                        best = score;
                        bestStart = startIndex;
                        bestFromState = transitionedFrom[priorEnd * stateCount + stateIndex];
                    }
                }
                const offset = endIndex * stateCount + stateIndex;
                current[offset] = best;
                starts[offset] = bestStart;
                fromStates[offset] = bestFromState;
            }
        }
        previous = current;
        backStarts.push(starts);
        backStates.push(fromStates);
        recordFinal(segmentCount, previous);
    }

    // A calendar-length-valid series can still have no scoreable overlap with its master.
    // In that case every terminal state remains -Infinity, so there is no fitted path.
    if (finalScores.length === 0) return [];

    const best = finalScores.reduce((winner, candidate) => (
        candidate.score > winner.score ? candidate : winner
    ));
    const runs: Run[] = [];
    let endIndex = yearCount - 1;
    let stateIndex = best.stateIndex;
    for (let segmentIndex = best.segmentCount - 1; segmentIndex >= 0; segmentIndex -= 1) {
        const offset = endIndex * stateCount + stateIndex;
        const startIndex = segmentIndex === 0 ? 0 : backStarts[segmentIndex][offset];
        if (startIndex < 0) return [];
        runs.push({ stateIndex, startIndex, endIndex });
        if (segmentIndex > 0) {
            stateIndex = backStates[segmentIndex][offset];
            endIndex = startIndex - 1;
        }
    }
    return runs.reverse();
};

const eventTypeFor = (olderLag: number, newerLag: number): DiagnosisEventType => {
    const correction = olderLag - newerLag;
    if (correction === -1) return "missingRing";
    if (correction === 1) return "falseRing";
    return "partialMove";
};

const boundaryRows = (
    scorer: IntervalScorer,
    older: Run,
    newer: Run,
    years: number[],
    states: number[],
    config: SegmentedEventPathConfig,
): BoundaryRow[] => {
    const nominal = older.endIndex;
    const start = Math.max(
        older.startIndex + config.minRunYears - 1,
        nominal - config.localizationRadius,
    );
    const end = Math.min(
        newer.endIndex - config.minRunYears,
        nominal + config.localizationRadius,
    );
    const contextStart = older.startIndex;
    const contextEnd = newer.endIndex;
    let nullScore = NEGATIVE_INFINITY;
    for (let stateIndex = 0; stateIndex < states.length; stateIndex += 1) {
        nullScore = Math.max(nullScore, scorer.score(stateIndex, contextStart, contextEnd));
    }
    const rows: BoundaryRow[] = [];
    for (let boundary = start; boundary <= end; boundary += 1) {
        const olderScore = scorer.score(older.stateIndex, contextStart, boundary);
        const newerScore = scorer.score(newer.stateIndex, boundary + 1, contextEnd);
        if (!Number.isFinite(olderScore) || !Number.isFinite(newerScore)) continue;
        rows.push({
            year: years[boundary],
            score: olderScore + newerScore - nullScore,
            samplePairs: scorer.pairs(older.stateIndex, contextStart, boundary)
                + scorer.pairs(newer.stateIndex, boundary + 1, contextEnd),
        });
    }
    return rows.sort((a, b) => b.score - a.score || b.year - a.year);
};

const boundedWindow = (
    centerYear: number,
    width: number,
    minimumYear: number,
    maximumYear: number,
): { startYear: number; endYear: number } => {
    const actualWidth = Math.max(1, Math.min(width, maximumYear - minimumYear + 1));
    let startYear = centerYear - Math.floor((actualWidth - 1) / 2);
    startYear = Math.max(minimumYear, Math.min(startYear, maximumYear - actualWidth + 1));
    return { startYear, endYear: startYear + actualWidth - 1 };
};

const rankedYears = (
    rows: BoundaryRow[],
    startYear: number,
    endYear: number,
): DiagnosisRankedYear[] => {
    const byYear = new Map(rows.map((row) => [row.year, row]));
    return Array.from({ length: endYear - startYear + 1 }, (_, offset) => {
        const year = startYear + offset;
        return {
            year,
            score: byYear.get(year)?.score ?? NEGATIVE_INFINITY,
            evidenceTags: ["penalized_segmented_lag"],
        };
    })
        .sort((a, b) => b.score - a.score || b.year - a.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
};

const confidence = (
    gain: number,
    config: SegmentedEventPathConfig,
): DiagnosisConfidence => {
    if (gain >= config.highLocalGain) return "high";
    if (gain >= config.mediumLocalGain) return "medium";
    return "low";
};

export const locateSegmentedLagEvents = (
    diagnosis: SeriesCoreDiagnosis,
    overrides: Partial<SegmentedEventPathConfig> = {},
): DiagnosisEvent[] => {
    const config = { ...DEFAULT_SEGMENTED_EVENT_PATH_CONFIG, ...overrides };
    const years: number[] = [];
    for (
        let year = diagnosis.targetRange.startYear;
        year <= diagnosis.targetRange.endYear;
        year += 1
    ) years.push(year);
    if (years.length < config.minRunYears * 2) return [];

    const states = buildStates(diagnosis.globalSlidingMatch.bestGlobalLag, config);
    const rawTarget = preprocessSeries(diagnosis.rawTarget);
    const rawMaster = preprocessSeries(diagnosis.master.data);
    const scorer = new IntervalScorer(
        years,
        states,
        rawTarget,
        rawMaster,
        ar1WhitenSeries(diagnosis.rawTarget),
        ar1WhitenSeries(diagnosis.master.data),
        config,
    );
    const runs = fitRuns(scorer, years, states, config);
    const events: DiagnosisEvent[] = [];

    for (let index = 0; index < runs.length - 1; index += 1) {
        const older = runs[index];
        const newer = runs[index + 1];
        const rows = boundaryRows(scorer, older, newer, years, states, config);
        const top = rows[0];
        if (!top || top.score < config.minLocalGain) continue;
        const olderLag = states[older.stateIndex];
        const newerLag = states[newer.stateIndex];
        const correctionYears = olderLag - newerLag;
        const eventType = eventTypeFor(olderLag, newerLag);
        const width = eventType === "partialMove"
            ? config.partialWindowWidth
            : config.missingFalseWindowWidth;
        const boundaryYearAdjustment = eventType === "missingRing"
            ? config.missingBoundaryYearAdjustment
            : eventType === "falseRing"
                ? config.falseBoundaryYearAdjustment
                : config.partialBoundaryYearAdjustment;
        const window = boundedWindow(
            top.year + boundaryYearAdjustment,
            width,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
        );
        events.push({
            id: `diagnosis-event-${diagnosis.targetTree}-segmented-${eventType}-${window.startYear}-${window.endYear}`,
            seriesId: diagnosis.targetTree,
            eventType,
            ...window,
            rankedYears: rankedYears(rows, window.startYear, window.endYear),
            confidenceLevel: confidence(top.score, config),
            evidence: {
                algorithmSources: ["penalized_segmented_lag"],
                score: top.score,
                scoreMargin: top.score - (rows[1]?.score ?? top.score),
                baselineCorrelation: diagnosis.globalSlidingMatch.currentR,
                correctedCorrelation: diagnosis.globalSlidingMatch.bestGlobalR,
                correlationGain: diagnosis.globalSlidingMatch.bestGlobalR === null
                    ? null
                    : diagnosis.globalSlidingMatch.bestGlobalR
                        - (diagnosis.globalSlidingMatch.currentR ?? 0),
                lagBefore: olderLag,
                lagAfter: newerLag,
                samplePairs: top.samplePairs,
                candidateIds: [],
                notes: [
                    `penalized lag transition ${olderLag} -> ${newerLag}`,
                    "score_is_relative_not_probability",
                ],
            },
            alternativeTypes: Math.abs(correctionYears) === 1 ? ["partialMove"] : [],
            ...(eventType === "partialMove" ? {
                shiftYears: correctionYears,
                shiftSide: "older" as const,
            } : {}),
        });
    }
    return events.sort((a, b) => b.endYear - a.endYear);
};

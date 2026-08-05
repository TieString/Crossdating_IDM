/**
 * Constrained piecewise-lag event locator.
 *
 * A crossdating error changes the integer lag shared by all older rings. The Viterbi path below
 * fits long constant-lag runs with an explicit transition cost, then localizes each accepted
 * transition in a bounded window. This is a changepoint model, not unconstrained DTW.
 */
import { correlationForSegment, preprocessSeries, toNumericSeries } from "./series";
import { cofechaStyleStandardize } from "../reference";
import type { RwlSiteData } from "@/features/rwl/types";
import type {
    DiagnosisConfidence,
    DiagnosisEvent,
    DiagnosisEventType,
    DiagnosisRankedYear,
    NumericSeries,
    SeriesCoreDiagnosis,
} from "./types";
import {
    DEFAULT_MAX_PARTIAL_GAP_YEARS,
    firstFixedYearFromLastMovedYear,
    getAutomaticEventShiftCandidates,
    isAutomaticPartialShift,
} from "./partialMoveSemantics";

export type EventPathConfig = {
    relativeLagRadius: number;
    minLag: number;
    maxLag: number;
    maxPartialGapYears: number;
    transitionPenaltyUnit: number;
    transitionPenaltyBig: number;
    transitionPenaltyPerYear: number;
    minRunYears: number;
    localizationRadius: number;
    maxBoundaryRefinementYears: number;
    missingFalseWindowWidth: number;
    partialWindowWidth: number;
    missingBoundaryYearAdjustment: number;
    falseBoundaryYearAdjustment: number;
    partialBoundaryYearAdjustment: number;
    multiTransitionMissingBoundaryYearAdjustment: number | null;
    multiTransitionFalseBoundaryYearAdjustment: number | null;
    multiTransitionPartialBoundaryYearAdjustment: number | null;
    multiTransitionPartialRankYearAdjustment: number | null;
    adaptiveProfileWindowPlacement: boolean;
    profileWindowTemperature: number;
    profileWindowMaxShift: number;
    profileWindowShiftPenalty: number;
    excludeTransitionDifferenceFromLocalization: boolean;
    newestLagWindowYears: number;
    transitionScanMinSideYears: number;
    minTransitionGain: number;
    mediumTransitionGain: number;
    highTransitionGain: number;
    useCofechaStandardization: boolean;
    robustMasterWeight: number;
    individualMasterWeight: number;
    enablePulseScan: boolean;
    minPulseYears: number;
    maxPulseYears: number;
    pulseContextYears: number;
    minPulseGain: number;
    pulseMarkerWeight: number;
    minPulseCombinedScore: number;
    minPulseContextGain: number;
    maxPulseCount: number;
    pulseRequiresFlatOrPartialContext: boolean;
};

export const DEFAULT_EVENT_PATH_CONFIG: EventPathConfig = {
    relativeLagRadius: 6,
    minLag: -DEFAULT_MAX_PARTIAL_GAP_YEARS,
    maxLag: 10,
    maxPartialGapYears: DEFAULT_MAX_PARTIAL_GAP_YEARS,
    transitionPenaltyUnit: 7.5,
    transitionPenaltyBig: 9.5,
    transitionPenaltyPerYear: 1.5,
    minRunYears: 10,
    localizationRadius: 14,
    maxBoundaryRefinementYears: 14,
    missingFalseWindowWidth: 7,
    partialWindowWidth: 9,
    missingBoundaryYearAdjustment: 0,
    falseBoundaryYearAdjustment: 0,
    partialBoundaryYearAdjustment: 0,
    multiTransitionMissingBoundaryYearAdjustment: null,
    multiTransitionFalseBoundaryYearAdjustment: null,
    multiTransitionPartialBoundaryYearAdjustment: null,
    multiTransitionPartialRankYearAdjustment: null,
    adaptiveProfileWindowPlacement: false,
    profileWindowTemperature: 1,
    profileWindowMaxShift: 3,
    profileWindowShiftPenalty: 0,
    excludeTransitionDifferenceFromLocalization: false,
    newestLagWindowYears: 36,
    transitionScanMinSideYears: 8,
    minTransitionGain: 2.5,
    mediumTransitionGain: 4.5,
    highTransitionGain: 7.5,
    useCofechaStandardization: false,
    robustMasterWeight: 0,
    individualMasterWeight: 0,
    enablePulseScan: false,
    minPulseYears: 6,
    maxPulseYears: 70,
    pulseContextYears: 14,
    minPulseGain: 4,
    pulseMarkerWeight: 0,
    minPulseCombinedScore: Number.NEGATIVE_INFINITY,
    minPulseContextGain: 0.4,
    maxPulseCount: 1,
    pulseRequiresFlatOrPartialContext: true,
};

type LagEvidence = {
    years: number[];
    states: number[];
    emissions: number[][];
    differenceEmissions: number[][];
    differenceCounts: number[][];
    prefixScores: number[][];
    prefixCounts: number[][];
};

export type LagPathCache = {
    evidenceByDiagnosis: WeakMap<SeriesCoreDiagnosis, Map<string, LagEvidence>>;
};

export const createLagPathCache = (): LagPathCache => ({
    evidenceByDiagnosis: new WeakMap(),
});

type LagRun = {
    state: number;
    startIndex: number;
    endIndex: number;
};

type BoundaryProfileRow = { year: number; score: number; samplePairs: number };

type LagPulse = {
    baselineLag: number;
    pulseLag: number;
    startIndex: number;
    endIndex: number;
    score: number;
    pulseGain: number;
    leftContextGain: number;
    rightContextGain: number;
    markerStrength: number;
    samplePairs: number;
};

export type LagPathDiagnosis = {
    events: DiagnosisEvent[];
    newestLag: number;
    newestLagMargin: number;
    newestLagPairs: number;
};

export type SequentialMissingHead = {
    year: number;
    score: number;
    directScore: number;
    gainOverDirect: number;
    transitionCount: number;
    headRunYears: number;
    headMeanAdvantage: number;
    fixedTailMeanAdvantage: number;
    pathStartLag: number;
};

export type SharedExplicitZeroMarker = {
    year: number;
    support: number;
    distanceFromHead: number;
    weightedSupport: number;
};

/** Select a nearby absent-ring marker shared by other cores without consulting the target. */
export const selectSharedExplicitZeroMarker = (
    siteData: RwlSiteData,
    targetTree: string,
    headYear: number,
    radius = 6,
): SharedExplicitZeroMarker | null => {
    const maximumDistance = Math.max(0, Math.floor(radius));
    const rows: SharedExplicitZeroMarker[] = [];
    for (
        let year = headYear - maximumDistance;
        year <= headYear + maximumDistance;
        year += 1
    ) {
        let support = 0;
        siteData.forEach((treeData, tree) => {
            if (tree !== targetTree && treeData.get(year) === 0) support += 1;
        });
        if (support === 0) continue;
        const distanceFromHead = Math.abs(year - headYear);
        rows.push({
            year,
            support,
            distanceFromHead,
            weightedSupport: support / (1 + distanceFromHead),
        });
    }
    return rows.sort((left, right) => (
        right.weightedSupport - left.weightedSupport
        || left.distanceFromHead - right.distanceFromHead
        || right.support - left.support
        || right.year - left.year
    ))[0] ?? null;
};

export type LagTransitionScanRow = {
    year: number;
    olderLag: number;
    newerLag: number;
    localOlderLag: number;
    localNewerLag: number;
    correctionYears: number;
    splitGain: number;
    normalizedSplitGain: number;
    balancedAdvantage: number;
    olderMeanAdvantage: number;
    newerMeanAdvantage: number;
    localGain31: number;
    localBalancedAdvantage31: number;
    samplePairs: number;
};

export type LagTransitionScanHypothesis = {
    correctionYears: number;
    eventType: DiagnosisEventType;
    rows: LagTransitionScanRow[];
};

export type LagTransitionScanResult = {
    newestLag: number;
    newestLagMargin: number;
    newestLagPairs: number;
    hypotheses: LagTransitionScanHypothesis[];
};

const median = (values: number[]): number => {
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

const zScore = (series: NumericSeries): NumericSeries => {
    const values = Array.from(series.values());
    if (values.length === 0) return new Map();
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const sd = Math.sqrt(variance) || 1;
    return new Map(Array.from(series.entries()).map(([year, value]) => [year, (value - mean) / sd]));
};

const robustMedianMaster = (
    siteData: RwlSiteData,
    diagnosis: SeriesCoreDiagnosis,
    useCofechaStandardization: boolean,
): NumericSeries => {
    const valuesByYear = new Map<number, number[]>();
    diagnosis.master.sourceTrees.forEach((tree) => {
        const raw = toNumericSeries(siteData.get(tree));
        const standardized = useCofechaStandardization
            ? new Map(cofechaStyleStandardize(raw).map((point) => [point.year, point.value]))
            : preprocessSeries(raw);
        standardized.forEach((value, year) => {
            const values = valuesByYear.get(year) ?? [];
            values.push(value);
            valuesByYear.set(year, values);
        });
    });
    const result = new Map<number, number>();
    valuesByYear.forEach((values, year) => {
        if (values.length >= 3) result.set(year, median(values));
    });
    return result.size >= 30 ? zScore(result) : diagnosis.master.data;
};

const blendedMaster = (
    weighted: NumericSeries,
    robust: NumericSeries,
    robustWeight: number,
): NumericSeries => {
    const weight = Math.max(0, Math.min(1, robustWeight));
    if (weight <= 0) return weighted;
    if (weight >= 1) return robust;
    const result = new Map<number, number>();
    const years = new Set([...weighted.keys(), ...robust.keys()]);
    years.forEach((year) => {
        const a = weighted.get(year);
        const b = robust.get(year);
        if (a !== undefined && b !== undefined) result.set(year, a * (1 - weight) + b * weight);
        else if (a !== undefined) result.set(year, a);
        else if (b !== undefined) result.set(year, b);
    });
    return zScore(result);
};

const bestIndividualMaster = (
    siteData: RwlSiteData,
    diagnosis: SeriesCoreDiagnosis,
    target: NumericSeries,
    useCofechaStandardization: boolean,
): NumericSeries | null => diagnosis.master.sourceTrees
    .map((tree) => {
        const raw = toNumericSeries(siteData.get(tree));
        const data = useCofechaStandardization
            ? new Map(cofechaStyleStandardize(raw).map((point) => [point.year, point.value]))
            : preprocessSeries(raw);
        const match = correlationForSegment(
            target,
            data,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
            diagnosis.globalSlidingMatch.bestGlobalLag,
            30,
        );
        return { data, correlation: match.correlation ?? Number.NEGATIVE_INFINITY };
    })
    .sort((a, b) => b.correlation - a.correlation)[0]?.data ?? null;

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const sorted = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < sorted.length; index += 1) {
        const [year, value] = sorted[index];
        const [previousYear, previousValue] = sorted[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return zScore(result);
};

const huberLoss = (residual: number, transition = 1.5): number => {
    const absolute = Math.abs(residual);
    return absolute <= transition
        ? 0.5 * absolute * absolute
        : transition * (absolute - transition * 0.5);
};

const buildStates = (
    globalLag: number,
    config: EventPathConfig,
): number[] => {
    const states = new Set<number>();
    for (let lag = config.minLag; lag <= config.maxLag; lag += 1) states.add(lag);
    for (
        let lag = globalLag - config.relativeLagRadius;
        lag <= globalLag + config.relativeLagRadius;
        lag += 1
    ) states.add(lag);
    states.add(0);
    states.add(globalLag);
    return Array.from(states).sort((a, b) => a - b);
};

const emissionFor = (
    target: NumericSeries,
    targetDiff: NumericSeries,
    master: NumericSeries,
    masterDiff: NumericSeries,
    year: number,
    lag: number,
): { score: number; count: number; differenceScore: number; differenceCount: number } => {
    let score = 0;
    let count = 0;
    let differenceScore = 0;
    let differenceCount = 0;
    const targetDifference = targetDiff.get(year);
    const masterDifference = masterDiff.get(year + lag);
    if (targetDifference !== undefined && masterDifference !== undefined) {
        differenceScore = -0.72 * huberLoss(targetDifference - masterDifference);
        score += differenceScore;
        count += 1;
        differenceCount = 1;
    }
    const targetValue = target.get(year);
    const masterValue = master.get(year + lag);
    if (targetValue !== undefined && masterValue !== undefined) {
        score -= 0.28 * huberLoss(targetValue - masterValue);
        count += 1;
    }
    return count > 0
        ? { score, count, differenceScore, differenceCount }
        : { score: -0.8, count: 0, differenceScore: 0, differenceCount: 0 };
};

const buildLagEvidence = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    config: EventPathConfig,
): LagEvidence => {
    const target = config.useCofechaStandardization
        ? new Map(cofechaStyleStandardize(diagnosis.rawTarget).map((point) => [point.year, point.value]))
        : preprocessSeries(diagnosis.rawTarget);
    const robustMaster = !config.useCofechaStandardization || config.robustMasterWeight > 0
        ? robustMedianMaster(siteData, diagnosis, config.useCofechaStandardization)
        : diagnosis.master.data;
    const baseMaster = config.useCofechaStandardization
        ? blendedMaster(diagnosis.master.data, robustMaster, config.robustMasterWeight)
        : robustMaster;
    const individualMaster = config.individualMasterWeight > 0
        ? bestIndividualMaster(
            siteData,
            diagnosis,
            target,
            config.useCofechaStandardization,
        )
        : null;
    const master = individualMaster
        ? blendedMaster(baseMaster, individualMaster, config.individualMasterWeight)
        : baseMaster;
    const targetDiff = firstDifferences(target);
    const masterDiff = firstDifferences(master);
    const years: number[] = [];
    for (let year = diagnosis.targetRange.startYear + 1; year <= diagnosis.targetRange.endYear; year += 1) {
        years.push(year);
    }
    const states = buildStates(diagnosis.globalSlidingMatch.bestGlobalLag, config);
    const emissionRows = years.map((year) => states.map((lag) => (
        emissionFor(target, targetDiff, master, masterDiff, year, lag)
    )));
    const emissions = emissionRows.map((row) => row.map((emission) => emission.score));
    const differenceEmissions = emissionRows.map((row) => (
        row.map((emission) => emission.differenceScore)
    ));
    const differenceCounts = emissionRows.map((row) => (
        row.map((emission) => emission.differenceCount)
    ));
    const prefixScores = states.map(() => [0]);
    const prefixCounts = states.map(() => [0]);
    emissions.forEach((_, yearIndex) => {
        states.forEach((_, stateIndex) => {
            const emission = emissionRows[yearIndex][stateIndex];
            prefixScores[stateIndex].push(prefixScores[stateIndex][yearIndex] + emission.score);
            prefixCounts[stateIndex].push(prefixCounts[stateIndex][yearIndex] + emission.count);
        });
    });
    return {
        years,
        states,
        emissions,
        differenceEmissions,
        differenceCounts,
        prefixScores,
        prefixCounts,
    };
};

const evidenceCacheKey = (config: EventPathConfig): string => [
    Number(config.useCofechaStandardization),
    config.robustMasterWeight,
    config.individualMasterWeight,
    config.relativeLagRadius,
    config.minLag,
    config.maxLag,
].join("|");

const cachedLagEvidence = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    config: EventPathConfig,
    cache: LagPathCache | undefined,
): LagEvidence => {
    if (!cache) return buildLagEvidence(diagnosis, siteData, config);
    let byConfig = cache.evidenceByDiagnosis.get(diagnosis);
    if (!byConfig) {
        byConfig = new Map();
        cache.evidenceByDiagnosis.set(diagnosis, byConfig);
    }
    const key = evidenceCacheKey(config);
    const existing = byConfig.get(key);
    if (existing) return existing;
    const evidence = buildLagEvidence(diagnosis, siteData, config);
    byConfig.set(key, evidence);
    return evidence;
};

const bestTransitionScores = (
    previous: number[],
    states: number[],
    config: EventPathConfig,
): { scores: number[]; from: number[] } => {
    const count = states.length;
    const scores = new Array(count).fill(Number.NEGATIVE_INFINITY);
    const from = new Array(count).fill(0);
    const stateIndex = new Map(states.map((state, index) => [state, index]));
    const slope = config.transitionPenaltyPerYear;
    const bigIntercept = config.transitionPenaltyBig - 2 * slope;
    const leftScores = new Array(count).fill(Number.NEGATIVE_INFINITY);
    const leftFrom = new Array(count).fill(0);
    const rightScores = new Array(count).fill(Number.NEGATIVE_INFINITY);
    const rightFrom = new Array(count).fill(0);

    let cursor = 0;
    let runningScore = Number.NEGATIVE_INFINITY;
    let runningFrom = 0;
    for (let toIndex = 0; toIndex < count; toIndex += 1) {
        while (cursor < count && states[cursor] <= states[toIndex] - 2) {
            const candidate = previous[cursor] + slope * states[cursor];
            if (candidate > runningScore
                || (candidate === runningScore && cursor < runningFrom)) {
                runningScore = candidate;
                runningFrom = cursor;
            }
            cursor += 1;
        }
        leftScores[toIndex] = runningScore
            - slope * states[toIndex]
            - bigIntercept;
        leftFrom[toIndex] = runningFrom;
    }

    cursor = count - 1;
    runningScore = Number.NEGATIVE_INFINITY;
    runningFrom = count - 1;
    for (let toIndex = count - 1; toIndex >= 0; toIndex -= 1) {
        while (cursor >= 0 && states[cursor] >= states[toIndex] + 2) {
            const candidate = previous[cursor] - slope * states[cursor];
            if (candidate > runningScore
                || (candidate === runningScore && cursor < runningFrom)) {
                runningScore = candidate;
                runningFrom = cursor;
            }
            cursor -= 1;
        }
        rightScores[toIndex] = runningScore
            + slope * states[toIndex]
            - bigIntercept;
        rightFrom[toIndex] = runningFrom;
    }

    const consider = (
        toIndex: number,
        candidateScore: number,
        candidateFrom: number,
    ) => {
        if (candidateScore > scores[toIndex]
            || (candidateScore === scores[toIndex]
                && candidateFrom < from[toIndex])) {
            scores[toIndex] = candidateScore;
            from[toIndex] = candidateFrom;
        }
    };
    states.forEach((state, toIndex) => {
        consider(toIndex, previous[toIndex], toIndex);
        const lower = stateIndex.get(state - 1);
        const upper = stateIndex.get(state + 1);
        if (lower !== undefined) {
            consider(
                toIndex,
                previous[lower] - config.transitionPenaltyUnit,
                lower,
            );
        }
        if (upper !== undefined) {
            consider(
                toIndex,
                previous[upper] - config.transitionPenaltyUnit,
                upper,
            );
        }
        consider(toIndex, leftScores[toIndex], leftFrom[toIndex]);
        consider(toIndex, rightScores[toIndex], rightFrom[toIndex]);
    });
    return { scores, from };
};

const viterbiPath = (evidence: LagEvidence, config: EventPathConfig): number[] => {
    const stateCount = evidence.states.length;
    if (evidence.years.length === 0) return [];
    let previous = evidence.states.map((_, stateIndex) => evidence.emissions[0][stateIndex]);
    const backPointers: number[][] = [new Array(stateCount).fill(0)];
    for (let yearIndex = 1; yearIndex < evidence.years.length; yearIndex += 1) {
        const transition = bestTransitionScores(
            previous,
            evidence.states,
            config,
        );
        const current = new Array(stateCount).fill(Number.NEGATIVE_INFINITY);
        for (let toIndex = 0; toIndex < stateCount; toIndex += 1) {
            current[toIndex] = transition.scores[toIndex]
                + evidence.emissions[yearIndex][toIndex];
        }
        previous = current;
        backPointers.push(transition.from);
    }
    let stateIndex = previous.reduce((best, score, index, all) => score > all[best] ? index : best, 0);
    const path = new Array(evidence.years.length).fill(0);
    for (let yearIndex = evidence.years.length - 1; yearIndex >= 0; yearIndex -= 1) {
        path[yearIndex] = evidence.states[stateIndex];
        stateIndex = backPointers[yearIndex][stateIndex];
    }
    return path;
};

const runsForPath = (path: number[]): LagRun[] => {
    const runs: LagRun[] = [];
    path.forEach((state, index) => {
        const current = runs[runs.length - 1];
        if (current?.state === state) current.endIndex = index;
        else runs.push({ state, startIndex: index, endIndex: index });
    });
    return runs;
};

const segmentScore = (
    evidence: LagEvidence,
    state: number,
    startIndex: number,
    endIndex: number,
): { score: number; count: number } => {
    const stateIndex = evidence.states.indexOf(state);
    if (stateIndex < 0 || endIndex < startIndex) return { score: -Infinity, count: 0 };
    return {
        score: evidence.prefixScores[stateIndex][endIndex + 1] - evidence.prefixScores[stateIndex][startIndex],
        count: evidence.prefixCounts[stateIndex][endIndex + 1] - evidence.prefixCounts[stateIndex][startIndex],
    };
};

const newestLagDiagnosis = (
    evidence: LagEvidence,
    config: EventPathConfig,
): Omit<LagPathDiagnosis, "events"> => {
    if (evidence.years.length === 0) {
        return { newestLag: 0, newestLagMargin: 0, newestLagPairs: 0 };
    }
    const startIndex = Math.max(0, evidence.years.length - config.newestLagWindowYears);
    const endIndex = evidence.years.length - 1;
    const ranked = evidence.states
        .map((lag) => ({ lag, ...segmentScore(evidence, lag, startIndex, endIndex) }))
        .sort((a, b) => b.score - a.score || Math.abs(a.lag) - Math.abs(b.lag));
    const best = ranked[0];
    return {
        newestLag: best?.lag ?? 0,
        newestLagMargin: best ? best.score - (ranked[1]?.score ?? best.score) : 0,
        newestLagPairs: best?.count ?? 0,
    };
};

const meanScore = (value: { score: number; count: number }): number => (
    value.count > 0 ? value.score / value.count : Number.NEGATIVE_INFINITY
);

/**
 * Fits the physical lag path created by several discrete missing rings. From pith to bark the
 * state may stay unchanged or advance by exactly one year, so a real staircase can beat a
 * single abrupt partial-move breakpoint without exposing all intermediate events to the UI.
 */
export const locateSequentialMissingHead = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    overrides: Partial<EventPathConfig> = {},
    cache?: LagPathCache,
    transitionPenalty = 0.5,
): SequentialMissingHead | null => {
    const config = { ...DEFAULT_EVENT_PATH_CONFIG, ...overrides };
    const evidence = cachedLagEvidence(diagnosis, siteData, config, cache);
    if (evidence.years.length < 12) return null;
    const stateRows = evidence.states
        .map((state, evidenceIndex) => ({ state, evidenceIndex }))
        .filter(({ state }) => state <= 0 && state >= config.minLag)
        .sort((left, right) => left.state - right.state);
    const zeroIndex = stateRows.findIndex(({ state }) => state === 0);
    if (zeroIndex < 1) return null;

    const yearCount = evidence.years.length;
    const stateCount = stateRows.length;
    let previous = stateRows.map(({ evidenceIndex }) => (
        evidence.emissions[0][evidenceIndex]
    ));
    const backPointers: number[][] = [new Array(stateCount).fill(-1)];
    for (let yearIndex = 1; yearIndex < yearCount; yearIndex += 1) {
        const current = new Array(stateCount).fill(Number.NEGATIVE_INFINITY);
        const from = new Array(stateCount).fill(-1);
        stateRows.forEach(({ state, evidenceIndex }, stateIndex) => {
            let selectedScore = previous[stateIndex];
            let selectedFrom = stateIndex;
            const lower = stateRows[stateIndex - 1];
            if (lower?.state === state - 1) {
                const stepScore = previous[stateIndex - 1] - transitionPenalty;
                if (stepScore > selectedScore) {
                    selectedScore = stepScore;
                    selectedFrom = stateIndex - 1;
                }
            }
            current[stateIndex] = selectedScore
                + evidence.emissions[yearIndex][evidenceIndex];
            from[stateIndex] = selectedFrom;
        });
        previous = current;
        backPointers.push(from);
    }

    const score = previous[zeroIndex];
    if (!Number.isFinite(score)) return null;
    const path = new Array<number>(yearCount).fill(0);
    let stateIndex = zeroIndex;
    for (let yearIndex = yearCount - 1; yearIndex >= 0; yearIndex -= 1) {
        path[yearIndex] = stateRows[stateIndex]?.state ?? 0;
        if (yearIndex > 0) stateIndex = backPointers[yearIndex][stateIndex];
        if (stateIndex < 0 && yearIndex > 0) return null;
    }
    const runs = runsForPath(path);
    const zeroRun = runs[runs.length - 1];
    const headRun = runs[runs.length - 2];
    if (
        zeroRun?.state !== 0
        || headRun?.state !== -1
        || runs.length < 3
    ) return null;
    const transitionCount = runs.length - 1;

    let directScore = Math.max(...stateRows.map(({ state }) => (
        segmentScore(evidence, state, 0, yearCount - 1).score
    )));
    for (let boundaryIndex = 1; boundaryIndex < yearCount - 2; boundaryIndex += 1) {
        const fixed = segmentScore(evidence, 0, boundaryIndex + 1, yearCount - 1);
        stateRows.forEach(({ state }) => {
            if (state >= -1) return;
            directScore = Math.max(
                directScore,
                segmentScore(evidence, state, 0, boundaryIndex).score
                    + fixed.score
                    - transitionPenalty,
            );
        });
    }

    const head = segmentScore(
        evidence,
        -1,
        headRun.startIndex,
        headRun.endIndex,
    );
    const headAlternatives = [0, -2]
        .filter((state) => evidence.states.includes(state))
        .map((state) => segmentScore(
            evidence,
            state,
            headRun.startIndex,
            headRun.endIndex,
        ));
    const headMeanAdvantage = meanScore(head) - Math.max(
        ...headAlternatives.map(meanScore),
    );
    const fixed = segmentScore(
        evidence,
        0,
        zeroRun.startIndex,
        zeroRun.endIndex,
    );
    const shiftedFixed = segmentScore(
        evidence,
        -1,
        zeroRun.startIndex,
        zeroRun.endIndex,
    );
    return {
        year: evidence.years[headRun.endIndex],
        score,
        directScore,
        gainOverDirect: score - directScore,
        transitionCount,
        headRunYears: headRun.endIndex - headRun.startIndex + 1,
        headMeanAdvantage,
        fixedTailMeanAdvantage: meanScore(fixed) - meanScore(shiftedFixed),
        pathStartLag: path[0],
    };
};

export type TwoStepMissingStaircase = {
    olderBoundaryYear: number;
    newerBoundaryYear: number;
    staircaseScore: number;
    directScore: number;
    staircaseGain: number;
    middleMeanAdvantage: number;
    middleSamplePairs: number;
    referenceSupport: number;
    referenceCount: number;
    referenceMedianAdvantage: number;
};

/**
 * Tests whether a local -2 -> 0 jump contains a short, otherwise smoothed-away -1 run.
 * The fixed local context keeps older unresolved events from dominating this comparison.
 */
export const locateTwoStepMissingStaircase = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    event: DiagnosisEvent,
    overrides: Partial<EventPathConfig> = {},
    cache?: LagPathCache,
): TwoStepMissingStaircase | null => {
    if (
        event.eventType !== "partialMove"
        || event.evidence.lagBefore !== -2
        || event.evidence.lagAfter !== 0
    ) return null;
    const config = { ...DEFAULT_EVENT_PATH_CONFIG, ...overrides };
    const evidence = cachedLagEvidence(diagnosis, siteData, config, cache);
    if (![0, -1, -2].every((state) => evidence.states.includes(state))) return null;
    const firstYear = evidence.years[0];
    const lastYear = evidence.years[evidence.years.length - 1];
    if (firstYear === undefined || lastYear === undefined) return null;
    const indexForYear = (year: number): number => Math.max(
        0,
        Math.min(evidence.years.length - 1, year - firstYear),
    );
    const newerStart = Math.max(firstYear + 20, event.startYear - 3);
    const newerEnd = Math.min(lastYear - 20, event.endYear + 3);
    if (newerEnd < newerStart) return null;
    const maximumGapYears = 17;
    const contextStart = indexForYear(newerStart - maximumGapYears - 20);
    const contextEnd = indexForYear(newerEnd + 20);
    const scoreDirect = (boundaryYear: number): number => {
        const boundary = indexForYear(boundaryYear);
        return segmentScore(evidence, -2, contextStart, boundary).score
            + segmentScore(evidence, 0, boundary + 1, contextEnd).score;
    };
    let directScore = Number.NEGATIVE_INFINITY;
    for (let year = newerStart; year <= newerEnd; year += 1) {
        directScore = Math.max(directScore, scoreDirect(year));
    }

    let best: Pick<
        TwoStepMissingStaircase,
        | "olderBoundaryYear"
        | "newerBoundaryYear"
        | "staircaseScore"
        | "middleMeanAdvantage"
        | "middleSamplePairs"
    > | null = null;
    for (let newerYear = newerStart; newerYear <= newerEnd; newerYear += 1) {
        const newerIndex = indexForYear(newerYear);
        for (
            let olderYear = Math.max(firstYear + 20, newerYear - maximumGapYears);
            olderYear <= newerYear - 2;
            olderYear += 1
        ) {
            const olderIndex = indexForYear(olderYear);
            const older = segmentScore(evidence, -2, contextStart, olderIndex);
            const middle = segmentScore(evidence, -1, olderIndex + 1, newerIndex);
            const newer = segmentScore(evidence, 0, newerIndex + 1, contextEnd);
            if (middle.count < 4) continue;
            const staircaseScore = older.score + middle.score + newer.score;
            const middleAsOlder = segmentScore(evidence, -2, olderIndex + 1, newerIndex);
            const middleAsNewer = segmentScore(evidence, 0, olderIndex + 1, newerIndex);
            const middleMeanAdvantage = (
                middle.score - Math.max(middleAsOlder.score, middleAsNewer.score)
            ) / middle.count;
            if (
                !best
                || staircaseScore > best.staircaseScore
                || (
                    staircaseScore === best.staircaseScore
                    && middleMeanAdvantage > best.middleMeanAdvantage
                )
            ) {
                best = {
                    olderBoundaryYear: olderYear,
                    newerBoundaryYear: newerYear,
                    staircaseScore,
                    middleMeanAdvantage,
                    middleSamplePairs: middle.count,
                };
            }
        }
    }
    if (!best || !Number.isFinite(directScore)) return null;
    const target = config.useCofechaStandardization
        ? new Map(cofechaStyleStandardize(diagnosis.rawTarget).map((point) => [
            point.year,
            point.value,
        ]))
        : preprocessSeries(diagnosis.rawTarget);
    const targetDiff = firstDifferences(target);
    const referenceAdvantages = diagnosis.master.sourceTrees.flatMap((tree) => {
        const rawReference = toNumericSeries(siteData.get(tree));
        if (rawReference.size === 0) return [];
        const reference = config.useCofechaStandardization
            ? new Map(cofechaStyleStandardize(rawReference).map((point) => [
                point.year,
                point.value,
            ]))
            : preprocessSeries(rawReference);
        const referenceDiff = firstDifferences(reference);
        const totals = [-2, -1, 0].map((lag) => {
            let score = 0;
            let count = 0;
            for (
                let year = best.olderBoundaryYear + 1;
                year <= best.newerBoundaryYear;
                year += 1
            ) {
                const emission = emissionFor(
                    target,
                    targetDiff,
                    reference,
                    referenceDiff,
                    year,
                    lag,
                );
                score += emission.score;
                count += emission.count;
            }
            return { lag, score, count };
        });
        const middle = totals[1];
        if (middle.count < 4) return [];
        return [(
            middle.score - Math.max(totals[0].score, totals[2].score)
        ) / middle.count];
    }).sort((left, right) => left - right);
    const referenceSupport = referenceAdvantages.filter((value) => value > 0).length;
    const middleIndex = Math.floor(referenceAdvantages.length / 2);
    const referenceMedianAdvantage = referenceAdvantages.length % 2 === 0
        ? (
            (referenceAdvantages[middleIndex - 1] ?? 0)
            + (referenceAdvantages[middleIndex] ?? 0)
        ) / 2
        : referenceAdvantages[middleIndex] ?? 0;
    return {
        ...best,
        directScore,
        staircaseGain: best.staircaseScore - directScore,
        referenceSupport,
        referenceCount: referenceAdvantages.length,
        referenceMedianAdvantage,
    };
};

/**
 * Scores every usable calendar boundary for every bounded older-side lag transition.
 *
 * This scan is independent of existing diagnosis events and review windows. Prefix sums make
 * the complete year x operation table linear in the series length for each tested lag.
 */
export const scoreLagTransitionHypotheses = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    overrides: Partial<EventPathConfig> = {},
    cache?: LagPathCache,
): LagTransitionScanResult => {
    const config = { ...DEFAULT_EVENT_PATH_CONFIG, ...overrides };
    const evidence = cachedLagEvidence(diagnosis, siteData, config, cache);
    const newest = newestLagDiagnosis(evidence, config);
    const minimumSide = Math.max(
        4,
        Math.floor(config.transitionScanMinSideYears),
    );
    const lastIndex = evidence.years.length - 1;
    const hypotheses: LagTransitionScanHypothesis[] = [];
    const globalNullScore = Math.max(
        ...evidence.states.map((lag) => segmentScore(evidence, lag, 0, lastIndex).score),
    );
    getAutomaticEventShiftCandidates({
        maxPartialGapYears: config.maxPartialGapYears,
        lagMin: config.minLag,
        seriesLength: evidence.years.length,
        minimumSideYears: minimumSide,
    }).forEach((correctionYears) => {
        const lagPairs = evidence.states
            .filter((newerLag) => newerLag >= config.minLag && newerLag <= config.maxLag)
            .map((newerLag) => ({
                newerLag,
                olderLag: newerLag + correctionYears,
            }))
            .filter(({ olderLag }) => (
                olderLag >= config.minLag
                && olderLag <= config.maxLag
                && evidence.states.includes(olderLag)
            ));
        if (lagPairs.length === 0 || lastIndex < minimumSide * 2) return;
        const rows: LagTransitionScanRow[] = [];
        for (
            let boundaryIndex = minimumSide - 1;
            boundaryIndex <= lastIndex - minimumSide;
            boundaryIndex += 1
        ) {
            const rankedGlobalPairs = lagPairs
                .map(({ olderLag, newerLag }) => {
                    const older = segmentScore(evidence, olderLag, 0, boundaryIndex);
                    const newer = segmentScore(
                        evidence,
                        newerLag,
                        boundaryIndex + 1,
                        lastIndex,
                    );
                    return {
                        olderLag,
                        newerLag,
                        older,
                        newer,
                        score: older.score + newer.score,
                    };
                })
                .sort((a, b) => b.score - a.score);
            const bestGlobal = rankedGlobalPairs[0];
            if (!bestGlobal) continue;
            const { olderLag, newerLag, older, newer } = bestGlobal;
            const olderAsNewer = segmentScore(evidence, newerLag, 0, boundaryIndex);
            const newerAsOlder = segmentScore(
                evidence,
                olderLag,
                boundaryIndex + 1,
                lastIndex,
            );
            const splitGain = older.score + newer.score - globalNullScore;
            const olderMeanAdvantage = meanScore(older) - meanScore(olderAsNewer);
            const newerMeanAdvantage = meanScore(newer) - meanScore(newerAsOlder);
            const localStart = Math.max(0, boundaryIndex - 14);
            const localEnd = Math.min(lastIndex, boundaryIndex + 15);
            const localNull = Math.max(...evidence.states.map(
                (lag) => segmentScore(evidence, lag, localStart, localEnd).score,
            ));
            const rankedLocalPairs = lagPairs
                .map(({ olderLag: localOlderLag, newerLag: localNewerLag }) => {
                    const localOlder = segmentScore(
                        evidence,
                        localOlderLag,
                        localStart,
                        boundaryIndex,
                    );
                    const localNewer = segmentScore(
                        evidence,
                        localNewerLag,
                        boundaryIndex + 1,
                        localEnd,
                    );
                    return {
                        localOlderLag,
                        localNewerLag,
                        localOlder,
                        localNewer,
                        score: localOlder.score + localNewer.score,
                    };
                })
                .sort((a, b) => b.score - a.score);
            const bestLocal = rankedLocalPairs[0];
            if (!bestLocal) continue;
            const localOlderAsNewer = segmentScore(
                evidence,
                bestLocal.localNewerLag,
                localStart,
                boundaryIndex,
            );
            const localNewerAsOlder = segmentScore(
                evidence,
                bestLocal.localOlderLag,
                boundaryIndex + 1,
                localEnd,
            );
            const samplePairs = older.count + newer.count;
            rows.push({
                year: evidence.years[boundaryIndex],
                olderLag,
                newerLag,
                localOlderLag: bestLocal.localOlderLag,
                localNewerLag: bestLocal.localNewerLag,
                correctionYears,
                splitGain,
                normalizedSplitGain: splitGain / Math.sqrt(Math.max(1, samplePairs)),
                balancedAdvantage: Math.min(
                    olderMeanAdvantage,
                    newerMeanAdvantage,
                ),
                olderMeanAdvantage,
                newerMeanAdvantage,
                localGain31: bestLocal.score - localNull,
                localBalancedAdvantage31: Math.min(
                    meanScore(bestLocal.localOlder) - meanScore(localOlderAsNewer),
                    meanScore(bestLocal.localNewer) - meanScore(localNewerAsOlder),
                ),
                samplePairs,
            });
        }
        hypotheses.push({
            correctionYears,
            eventType: Math.abs(correctionYears) > 1
                ? "partialMove"
                : correctionYears < 0
                    ? "missingRing"
                    : "falseRing",
            rows,
        });
    });
    return { ...newest, hypotheses };
};

const mergeShortRuns = (
    evidence: LagEvidence,
    path: number[],
    minRunYears: number,
): number[] => {
    const smoothed = [...path];
    for (let pass = 0; pass < 8; pass += 1) {
        const runs = runsForPath(smoothed);
        const shortIndex = runs.findIndex((run) => run.endIndex - run.startIndex + 1 < minRunYears);
        if (shortIndex < 0 || runs.length === 1) break;
        const run = runs[shortIndex];
        const left = runs[shortIndex - 1];
        const right = runs[shortIndex + 1];
        let replacement = left?.state ?? right?.state ?? run.state;
        if (left && right) {
            const leftScore = segmentScore(evidence, left.state, run.startIndex, run.endIndex).score;
            const rightScore = segmentScore(evidence, right.state, run.startIndex, run.endIndex).score;
            replacement = rightScore > leftScore ? right.state : left.state;
        }
        for (let index = run.startIndex; index <= run.endIndex; index += 1) smoothed[index] = replacement;
    }
    return smoothed;
};

const boundaryProfile = (
    evidence: LagEvidence,
    olderRun: LagRun,
    newerRun: LagRun,
    config: EventPathConfig,
): BoundaryProfileRow[] => {
    const nominalIndex = olderRun.endIndex;
    const startIndex = Math.max(olderRun.startIndex, nominalIndex - config.localizationRadius);
    const endIndex = Math.min(newerRun.endIndex - 1, nominalIndex + config.localizationRadius);
    const contextStart = Math.max(0, nominalIndex - Math.max(config.localizationRadius, config.minRunYears));
    const contextEnd = Math.min(evidence.years.length - 1, nominalIndex + Math.max(config.localizationRadius, config.minRunYears));
    const nullOlder = segmentScore(evidence, olderRun.state, contextStart, contextEnd).score;
    const nullNewer = segmentScore(evidence, newerRun.state, contextStart, contextEnd).score;
    const nullScore = Math.max(nullOlder, nullNewer);
    const rows: BoundaryProfileRow[] = [];
    for (let boundaryIndex = startIndex; boundaryIndex <= endIndex; boundaryIndex += 1) {
        const older = segmentScore(evidence, olderRun.state, contextStart, boundaryIndex);
        const newer = segmentScore(evidence, newerRun.state, boundaryIndex + 1, contextEnd);
        const newerStateIndex = evidence.states.indexOf(newerRun.state);
        const excludeTransitionDifference = config.excludeTransitionDifferenceFromLocalization
            && Math.abs(newerRun.state - olderRun.state) > 1;
        const excludedDifference = excludeTransitionDifference
            && boundaryIndex + 1 < evidence.years.length
            && newerStateIndex >= 0
            ? evidence.differenceEmissions[boundaryIndex + 1][newerStateIndex]
            : 0;
        const excludedCount = excludeTransitionDifference
            && boundaryIndex + 1 < evidence.years.length
            && newerStateIndex >= 0
            ? evidence.differenceCounts[boundaryIndex + 1][newerStateIndex]
            : 0;
        rows.push({
            year: evidence.years[boundaryIndex],
            score: older.score + newer.score - excludedDifference - nullScore,
            samplePairs: older.count + newer.count - excludedCount,
        });
    }
    return rows.sort((a, b) => b.score - a.score || b.year - a.year);
};

const boundedWindow = (
    centerYear: number,
    width: number,
    minYear: number,
    maxYear: number,
): { startYear: number; endYear: number } => {
    const actualWidth = Math.max(1, Math.min(width, maxYear - minYear + 1));
    let startYear = centerYear - Math.floor((actualWidth - 1) / 2);
    startYear = Math.max(minYear, Math.min(startYear, maxYear - actualWidth + 1));
    return { startYear, endYear: startYear + actualWidth - 1 };
};

const profileMassWindow = (
    profile: BoundaryProfileRow[],
    centerYear: number,
    yearAdjustment: number,
    width: number,
    minYear: number,
    maxYear: number,
    config: EventPathConfig,
): { startYear: number; endYear: number } => {
    const baseline = boundedWindow(centerYear, width, minYear, maxYear);
    if (!config.adaptiveProfileWindowPlacement || profile.length === 0) return baseline;
    const temperature = Math.max(0.05, config.profileWindowTemperature);
    const bestProfileScore = profile[0].score;
    const weights = profile.map((row) => ({
        year: row.year + yearAdjustment,
        weight: Math.exp(Math.max(-20, (row.score - bestProfileScore) / temperature)),
    }));
    const maxShift = Math.max(0, Math.floor(config.profileWindowMaxShift));
    const candidates = Array.from({ length: maxShift * 2 + 1 }, (_, index) => {
        const requestedShift = index - maxShift;
        const window = boundedWindow(
            centerYear + requestedShift,
            width,
            minYear,
            maxYear,
        );
        const actualShift = window.startYear - baseline.startYear;
        const mass = weights.reduce((sum, row) => (
            row.year >= window.startYear && row.year <= window.endYear
                ? sum + row.weight
                : sum
        ), 0);
        return {
            window,
            actualShift,
            score: mass - Math.abs(actualShift) * config.profileWindowShiftPenalty,
        };
    });
    return candidates.sort((a, b) => (
        b.score - a.score
        || Math.abs(a.actualShift) - Math.abs(b.actualShift)
        || b.actualShift - a.actualShift
    ))[0]?.window ?? baseline;
};

const eventTypeForTransition = (
    olderLag: number,
    newerLag: number,
    config: EventPathConfig,
): DiagnosisEventType | null => {
    const correctionYears = olderLag - newerLag;
    if (correctionYears === -1) return "missingRing";
    if (correctionYears === 1) return "falseRing";
    return isAutomaticPartialShift(correctionYears, {
        maxPartialGapYears: config.maxPartialGapYears,
        lagMin: config.minLag,
    })
        ? "partialMove"
        : null;
};

const confidenceForGain = (gain: number, config: EventPathConfig): DiagnosisConfidence => {
    if (gain >= config.highTransitionGain) return "high";
    if (gain >= config.mediumTransitionGain) return "medium";
    return "low";
};

const rankedYearsForWindow = (
    profile: BoundaryProfileRow[],
    startYear: number,
    endYear: number,
    yearAdjustment = 0,
): DiagnosisRankedYear[] => {
    const rowByYear = new Map(profile.map((row) => [row.year + yearAdjustment, row]));
    return Array.from({ length: endYear - startYear + 1 }, (_, index) => {
        const year = startYear + index;
        const row = rowByYear.get(year);
        return { year, score: row?.score ?? -Infinity, evidenceTags: ["piecewise_lag_path"] };
    })
        .sort((a, b) => b.score - a.score || b.year - a.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
};

const overlapYears = (a: DiagnosisEvent, b: DiagnosisEvent): number => (
    Math.max(0, Math.min(a.endYear, b.endYear) - Math.max(a.startYear, b.startYear) + 1)
);

const boundedPulseGroup = (event: DiagnosisEvent): string | null => {
    if (!event.evidence.algorithmSources.includes("bounded_lag_pulse")) return null;
    return event.id.match(/^(.*-pulse-\d+)-(?:older|newer)-/)?.[1] ?? null;
};

export const removeOverlappingEvents = (events: DiagnosisEvent[]): DiagnosisEvent[] => {
    const selected: DiagnosisEvent[] = [];
    [...events]
        .sort((a, b) => b.evidence.score - a.evidence.score || b.endYear - a.endYear)
        .forEach((event) => {
            const pulseGroup = boundedPulseGroup(event);
            const overlapping = selected.find((other) => (
                overlapYears(event, other) > 0
                && (
                    pulseGroup === null
                    || pulseGroup !== boundedPulseGroup(other)
                )
            ));
            if (!overlapping) {
                selected.push(event);
                return;
            }
            if (overlapping.eventType !== event.eventType) {
                overlapping.alternativeTypes = Array.from(new Set([
                    ...overlapping.alternativeTypes,
                    event.eventType,
                ]));
            }
        });
    return selected.sort((a, b) => b.endYear - a.endYear);
};

const pulseBoundaryRankedYears = (
    boundaryYear: number,
    startYear: number,
    endYear: number,
    score: number,
): DiagnosisRankedYear[] => (
    Array.from({ length: endYear - startYear + 1 }, (_, offset) => {
        const year = startYear + offset;
        return {
            year,
            score: score - Math.abs(year - boundaryYear) * 0.25,
            evidenceTags: ["bounded_lag_pulse"],
        };
    })
        .sort((a, b) => b.score - a.score || b.year - a.year)
        .map((row, index) => ({ ...row, rank: index + 1 }))
);

const scanLagPulses = (
    evidence: LagEvidence,
    path: number[],
    diagnosis: SeriesCoreDiagnosis,
    config: EventPathConfig,
): DiagnosisEvent[] => {
    if (!config.enablePulseScan || evidence.years.length === 0) return [];
    const stableStates = new Set(
        runsForPath(path)
            .filter((run) => run.endIndex - run.startIndex + 1 >= config.minRunYears)
            .map((run) => run.state),
    );
    if (stableStates.size === 0) stableStates.add(diagnosis.globalSlidingMatch.bestGlobalLag);
    const pulses: LagPulse[] = [];
    stableStates.forEach((baselineLag) => {
        ([-1, 1] as const).forEach((step) => {
            const pulseLag = baselineLag + step;
            if (!evidence.states.includes(pulseLag)) return;
            const maximumLength = Math.min(config.maxPulseYears, evidence.years.length);
            for (
                let startIndex = config.pulseContextYears;
                startIndex <= evidence.years.length - config.pulseContextYears - config.minPulseYears;
                startIndex += 1
            ) {
                const maximumEnd = Math.min(
                    evidence.years.length - config.pulseContextYears - 1,
                    startIndex + maximumLength - 1,
                );
                for (
                    let endIndex = startIndex + config.minPulseYears - 1;
                    endIndex <= maximumEnd;
                    endIndex += 1
                ) {
                    // Scan only inside a run that the conservative path flattened to one state.
                    // This prevents a pulse candidate from spanning or replacing an already
                    // accepted ordinary/partial transition.
                    let pathIsFlat = true;
                    for (
                        let index = startIndex - config.pulseContextYears;
                        index <= endIndex + config.pulseContextYears;
                        index += 1
                    ) {
                        if (path[index] !== baselineLag) {
                            pathIsFlat = false;
                            break;
                        }
                    }
                    if (!pathIsFlat) continue;
                    const pulse = segmentScore(evidence, pulseLag, startIndex, endIndex);
                    const baseline = segmentScore(evidence, baselineLag, startIndex, endIndex);
                    const leftBaseline = segmentScore(
                        evidence,
                        baselineLag,
                        startIndex - config.pulseContextYears,
                        startIndex - 1,
                    );
                    const leftPulse = segmentScore(
                        evidence,
                        pulseLag,
                        startIndex - config.pulseContextYears,
                        startIndex - 1,
                    );
                    const rightBaseline = segmentScore(
                        evidence,
                        baselineLag,
                        endIndex + 1,
                        endIndex + config.pulseContextYears,
                    );
                    const rightPulse = segmentScore(
                        evidence,
                        pulseLag,
                        endIndex + 1,
                        endIndex + config.pulseContextYears,
                    );
                    const pulseGain = pulse.score - baseline.score;
                    const leftContextGain = leftBaseline.score - leftPulse.score;
                    const rightContextGain = rightBaseline.score - rightPulse.score;
                    const missingBoundaryYear = step > 0
                        ? evidence.years[startIndex - 1]
                        : evidence.years[endIndex];
                    const markerStrength = Math.abs(
                        diagnosis.master.data.get(missingBoundaryYear) ?? 0,
                    );
                    const combinedScore = pulseGain
                        + Math.min(leftContextGain, rightContextGain) * 0.5
                        + markerStrength * config.pulseMarkerWeight;
                    if (pulseGain < config.minPulseGain
                        || leftContextGain < config.minPulseContextGain
                        || rightContextGain < config.minPulseContextGain
                        || combinedScore < config.minPulseCombinedScore) continue;
                    pulses.push({
                        baselineLag,
                        pulseLag,
                        startIndex,
                        endIndex,
                        score: combinedScore,
                        pulseGain,
                        leftContextGain,
                        rightContextGain,
                        markerStrength,
                        samplePairs: pulse.count + leftBaseline.count + rightBaseline.count,
                    });
                }
            }
        });
    });

    const selected: LagPulse[] = [];
    pulses
        .sort((a, b) => b.score - a.score
            || (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))
        .forEach((pulse) => {
            if (selected.length >= config.maxPulseCount) return;
            const overlaps = selected.some((other) => (
                Math.max(pulse.startIndex, other.startIndex)
                    <= Math.min(pulse.endIndex, other.endIndex)
            ));
            if (!overlaps) selected.push(pulse);
        });

    return selected.flatMap((pulse, pulseIndex) => {
        const boundaries = [
            {
                olderLag: pulse.baselineLag,
                newerLag: pulse.pulseLag,
                year: evidence.years[pulse.startIndex - 1],
                suffix: "older",
            },
            {
                olderLag: pulse.pulseLag,
                newerLag: pulse.baselineLag,
                year: evidence.years[pulse.endIndex],
                suffix: "newer",
            },
        ];
        return boundaries.flatMap((boundary): DiagnosisEvent[] => {
            const eventType = eventTypeForTransition(
                boundary.olderLag,
                boundary.newerLag,
                config,
            );
            if (eventType === null) return [];
            const correctionYears = boundary.olderLag - boundary.newerLag;
            const outputBoundaryYear = eventType === "partialMove"
                ? firstFixedYearFromLastMovedYear(boundary.year)
                : boundary.year;
            const width = eventType === "partialMove"
                ? config.partialWindowWidth
                : config.missingFalseWindowWidth;
            const window = boundedWindow(
                outputBoundaryYear,
                width,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
            );
            return [{
                id: `diagnosis-event-${diagnosis.targetTree}-pulse-${pulseIndex}-${boundary.suffix}-${eventType}-${boundary.year}`,
                seriesId: diagnosis.targetTree,
                eventType,
                ...window,
                rankedYears: pulseBoundaryRankedYears(
                    outputBoundaryYear,
                    window.startYear,
                    window.endYear,
                    pulse.score,
                ),
                confidenceLevel: confidenceForGain(pulse.score, config),
                evidence: {
                    algorithmSources: ["bounded_lag_pulse"],
                    score: pulse.score,
                    scoreMargin: pulse.score,
                    baselineCorrelation: diagnosis.globalSlidingMatch.currentR,
                    correctedCorrelation: diagnosis.globalSlidingMatch.bestGlobalR,
                    correlationGain: diagnosis.globalSlidingMatch.bestGlobalR === null
                        ? null
                        : diagnosis.globalSlidingMatch.bestGlobalR
                            - (diagnosis.globalSlidingMatch.currentR ?? 0),
                    lagBefore: boundary.olderLag,
                    lagAfter: boundary.newerLag,
                    samplePairs: pulse.samplePairs,
                    candidateIds: [],
                    notes: [
                        `bounded lag pulse ${pulse.baselineLag} -> ${pulse.pulseLag} -> ${pulse.baselineLag}`,
                        ...(eventType === "partialMove"
                            ? [
                                `last_moved_year=${boundary.year}`,
                                `first_fixed_year=${outputBoundaryYear}`,
                            ]
                            : []),
                        `pulse_duration_years=${pulse.endIndex - pulse.startIndex + 1}`,
                        `pulse_start_year=${evidence.years[pulse.startIndex]}`,
                        `pulse_end_year=${evidence.years[pulse.endIndex]}`,
                        `pulse_gain=${pulse.pulseGain.toFixed(4)}`,
                        `pulse_left_context_gain=${pulse.leftContextGain.toFixed(4)}`,
                        `pulse_right_context_gain=${pulse.rightContextGain.toFixed(4)}`,
                        `pulse_missing_marker_strength=${pulse.markerStrength.toFixed(4)}`,
                        "score_is_relative_not_probability",
                    ],
                },
                alternativeTypes: [],
                ...(eventType === "partialMove" ? {
                    shiftYears: correctionYears,
                    shiftSide: "older" as const,
                } : {}),
            } satisfies DiagnosisEvent];
        });
    });
};

export const diagnoseLagPath = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    overrides: Partial<EventPathConfig> = {},
    cache?: LagPathCache,
): LagPathDiagnosis => {
    const config = { ...DEFAULT_EVENT_PATH_CONFIG, ...overrides };
    const evidence = cachedLagEvidence(diagnosis, siteData, config, cache);
    const newest = newestLagDiagnosis(evidence, config);
    if (evidence.years.length < config.minRunYears * 2) {
        return { events: [], ...newest };
    }
    const rawPath = viterbiPath(evidence, config);
    const path = mergeShortRuns(evidence, rawPath, config.minRunYears);
    const runs = runsForPath(path);
    const hasMultipleTransitions = runs.length >= 3;
    const events: DiagnosisEvent[] = [];
    for (let index = 0; index < runs.length - 1; index += 1) {
        const olderRun = runs[index];
        const newerRun = runs[index + 1];
        if (olderRun.state === newerRun.state) continue;
        const profile = boundaryProfile(evidence, olderRun, newerRun, config);
        const top = profile[0];
        if (!top || top.score < config.minTransitionGain) continue;
        const nominalYear = evidence.years[olderRun.endIndex];
        const refinedYear = Math.max(
            nominalYear - config.maxBoundaryRefinementYears,
            Math.min(top.year, nominalYear + config.maxBoundaryRefinementYears),
        );
        const eventType = eventTypeForTransition(
            olderRun.state,
            newerRun.state,
            config,
        );
        if (eventType === null) continue;
        const width = eventType === "partialMove"
            ? config.partialWindowWidth
            : config.missingFalseWindowWidth;
        const singleBoundaryYearAdjustment = eventType === "missingRing"
            ? config.missingBoundaryYearAdjustment
            : eventType === "falseRing"
                ? config.falseBoundaryYearAdjustment
                : config.partialBoundaryYearAdjustment;
        const multiBoundaryYearAdjustment = eventType === "missingRing"
            ? config.multiTransitionMissingBoundaryYearAdjustment
            : eventType === "falseRing"
                ? config.multiTransitionFalseBoundaryYearAdjustment
                : config.multiTransitionPartialBoundaryYearAdjustment;
        const boundaryYearAdjustment = hasMultipleTransitions
            && multiBoundaryYearAdjustment !== null
            ? multiBoundaryYearAdjustment
            : singleBoundaryYearAdjustment;
        const multiRankYearAdjustment = eventType === "partialMove"
            ? config.multiTransitionPartialRankYearAdjustment
            : multiBoundaryYearAdjustment;
        const rankingYearAdjustment = hasMultipleTransitions
            && multiRankYearAdjustment !== null
            ? multiRankYearAdjustment
            : 0;
        const breakpointSemanticAdjustment = eventType === "partialMove" ? 1 : 0;
        const window = profileMassWindow(
            profile,
            refinedYear + boundaryYearAdjustment + breakpointSemanticAdjustment,
            boundaryYearAdjustment + breakpointSemanticAdjustment,
            width,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
            config,
        );
        const secondScore = profile[1]?.score ?? top.score;
        const correctionYears = olderRun.state - newerRun.state;
        events.push({
            id: `diagnosis-event-${diagnosis.targetTree}-path-${eventType}-${window.startYear}-${window.endYear}`,
            seriesId: diagnosis.targetTree,
            eventType,
            ...window,
            rankedYears: rankedYearsForWindow(
                profile,
                window.startYear,
                window.endYear,
                rankingYearAdjustment + breakpointSemanticAdjustment,
            ),
            confidenceLevel: confidenceForGain(top.score, config),
            evidence: {
                algorithmSources: ["piecewise_lag_path"],
                score: top.score,
                scoreMargin: top.score - secondScore,
                baselineCorrelation: diagnosis.globalSlidingMatch.currentR,
                correctedCorrelation: diagnosis.globalSlidingMatch.bestGlobalR,
                correlationGain: diagnosis.globalSlidingMatch.bestGlobalR === null
                    ? null
                    : diagnosis.globalSlidingMatch.bestGlobalR - (diagnosis.globalSlidingMatch.currentR ?? 0),
                lagBefore: olderRun.state,
                lagAfter: newerRun.state,
                samplePairs: top.samplePairs,
                candidateIds: [],
                notes: [
                    `lag transition ${olderRun.state} -> ${newerRun.state}`,
                    `nominal_boundary_year=${nominalYear}`,
                    `profile_boundary_year=${top.year}`,
                    ...(eventType === "partialMove"
                        ? [
                            `last_moved_year=${top.year}`,
                            `first_fixed_year=${firstFixedYearFromLastMovedYear(top.year)}`,
                        ]
                        : []),
                    "scores_are_relative_not_probabilities",
                ],
            },
            alternativeTypes: [],
            ...(eventType === "partialMove" ? {
                shiftYears: correctionYears,
                shiftSide: "older" as const,
            } : {}),
        });
    }
    const pulseContextAllowed = !config.pulseRequiresFlatOrPartialContext
        || events.length === 0
        || events.some((event) => event.eventType === "partialMove");
    const pulseEvents = pulseContextAllowed
        ? scanLagPulses(evidence, path, diagnosis, config)
        : [];
    return {
        events: removeOverlappingEvents([...events, ...pulseEvents]),
        ...newest,
    };
};

export const locateLagPathEvents = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    overrides: Partial<EventPathConfig> = {},
): DiagnosisEvent[] => diagnoseLagPath(diagnosis, siteData, overrides).events;

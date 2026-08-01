/**
 * Dense local-lag profile experiment.
 *
 * Overlapping correlation windows estimate a local integer lag every few years. A constrained
 * path turns persistent lag plateaus into changepoints, and each changepoint must be supported
 * independently on both sides. This is deliberately bounded and is not a DTW alignment.
 */
import { cofechaStyleStandardize } from "../reference";
import { correlationForSegment } from "./series";
import type {
    DiagnosisConfidence,
    DiagnosisEvent,
    DiagnosisEventType,
    DiagnosisRankedYear,
    NumericSeries,
    SeriesCoreDiagnosis,
} from "./types";

export type DenseLagProfileConfig = {
    minLag: number;
    maxLag: number;
    windowYears: number;
    stepYears: number;
    minPairs: number;
    rawWeight: number;
    differenceWeight: number;
    transitionPenaltyUnit: number;
    transitionPenaltyBig: number;
    transitionPenaltyPerYear: number;
    minRunYears: number;
    minSideMeanAdvantage: number;
    localizationRadius: number;
    boundaryContextYears: number;
    minBoundaryGain: number;
    missingFalseWindowWidth: number;
    partialWindowWidth: number;
};

export const DEFAULT_DENSE_LAG_PROFILE_CONFIG: DenseLagProfileConfig = {
    minLag: -10,
    maxLag: 10,
    windowYears: 21,
    stepYears: 2,
    minPairs: 10,
    rawWeight: 0.25,
    differenceWeight: 0.75,
    transitionPenaltyUnit: 1.4,
    transitionPenaltyBig: 1.8,
    transitionPenaltyPerYear: 0.25,
    minRunYears: 10,
    minSideMeanAdvantage: 0.04,
    localizationRadius: 10,
    boundaryContextYears: 16,
    minBoundaryGain: 0.08,
    missingFalseWindowWidth: 7,
    partialWindowWidth: 9,
};

type ProfileRow = {
    year: number;
    scores: number[];
};

type LagRun = {
    stateIndex: number;
    startIndex: number;
    endIndex: number;
};

type BoundaryRow = {
    year: number;
    score: number;
    samplePairs: number;
};

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const result = new Map<number, number>();
    const entries = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previous] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previous);
    }
    return result;
};

const weightedCorrelation = (
    target: NumericSeries,
    targetDifference: NumericSeries,
    master: NumericSeries,
    masterDifference: NumericSeries,
    startYear: number,
    endYear: number,
    lag: number,
    config: DenseLagProfileConfig,
): { score: number; pairs: number } => {
    const raw = correlationForSegment(
        target,
        master,
        startYear,
        endYear,
        lag,
        config.minPairs,
    );
    const difference = correlationForSegment(
        targetDifference,
        masterDifference,
        startYear,
        endYear,
        lag,
        config.minPairs,
    );
    if (raw.correlation === null && difference.correlation === null) {
        return { score: -1, pairs: Math.max(raw.samplePairs, difference.samplePairs) };
    }
    return {
        score: config.rawWeight * (raw.correlation ?? -0.5)
            + config.differenceWeight * (difference.correlation ?? -0.5),
        pairs: Math.max(raw.samplePairs, difference.samplePairs),
    };
};

const transitionPenalty = (
    fromLag: number,
    toLag: number,
    config: DenseLagProfileConfig,
): number => {
    const magnitude = Math.abs(toLag - fromLag);
    if (magnitude === 0) return 0;
    if (magnitude === 1) return config.transitionPenaltyUnit;
    return config.transitionPenaltyBig
        + Math.max(0, magnitude - 2) * config.transitionPenaltyPerYear;
};

const viterbi = (
    rows: ProfileRow[],
    states: number[],
    config: DenseLagProfileConfig,
): number[] => {
    if (rows.length === 0) return [];
    let previous = [...rows[0].scores];
    const backPointers: number[][] = [states.map((_, index) => index)];
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const current = states.map(() => Number.NEGATIVE_INFINITY);
        const back = states.map(() => 0);
        states.forEach((toLag, toIndex) => {
            states.forEach((fromLag, fromIndex) => {
                const candidate = previous[fromIndex]
                    - transitionPenalty(fromLag, toLag, config)
                    + rows[rowIndex].scores[toIndex];
                if (candidate > current[toIndex]) {
                    current[toIndex] = candidate;
                    back[toIndex] = fromIndex;
                }
            });
        });
        previous = current;
        backPointers.push(back);
    }
    let stateIndex = previous.reduce((best, value, index, values) => (
        value > values[best] ? index : best
    ), 0);
    const path = rows.map(() => 0);
    for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
        path[rowIndex] = stateIndex;
        stateIndex = backPointers[rowIndex][stateIndex];
    }
    return path;
};

const runsFor = (path: number[]): LagRun[] => {
    const runs: LagRun[] = [];
    path.forEach((stateIndex, index) => {
        const current = runs[runs.length - 1];
        if (current?.stateIndex === stateIndex) current.endIndex = index;
        else runs.push({ stateIndex, startIndex: index, endIndex: index });
    });
    return runs;
};

const mergeShortRuns = (
    rows: ProfileRow[],
    path: number[],
    config: DenseLagProfileConfig,
): number[] => {
    const result = [...path];
    const minimumRows = Math.max(2, Math.ceil(config.minRunYears / config.stepYears));
    for (let pass = 0; pass < 8; pass += 1) {
        const runs = runsFor(result);
        const shortIndex = runs.findIndex((run) => run.endIndex - run.startIndex + 1 < minimumRows);
        if (shortIndex < 0 || runs.length === 1) break;
        const run = runs[shortIndex];
        const neighbors = [runs[shortIndex - 1], runs[shortIndex + 1]].filter(
            (neighbor): neighbor is LagRun => Boolean(neighbor),
        );
        const replacement = neighbors
            .map((neighbor) => ({
                stateIndex: neighbor.stateIndex,
                score: rows.slice(run.startIndex, run.endIndex + 1)
                    .reduce((sum, row) => sum + row.scores[neighbor.stateIndex], 0),
            }))
            .sort((a, b) => b.score - a.score)[0]?.stateIndex;
        if (replacement === undefined) break;
        for (let index = run.startIndex; index <= run.endIndex; index += 1) {
            result[index] = replacement;
        }
    }
    return result;
};

const meanAdvantage = (
    rows: ProfileRow[],
    run: LagRun,
    ownState: number,
    alternativeState: number,
): number => {
    const selected = rows.slice(run.startIndex, run.endIndex + 1);
    return selected.reduce((sum, row) => (
        sum + row.scores[ownState] - row.scores[alternativeState]
    ), 0) / Math.max(1, selected.length);
};

const boundaryProfile = (
    target: NumericSeries,
    targetDifference: NumericSeries,
    master: NumericSeries,
    masterDifference: NumericSeries,
    nominalYear: number,
    olderLag: number,
    newerLag: number,
    diagnosis: SeriesCoreDiagnosis,
    config: DenseLagProfileConfig,
): BoundaryRow[] => {
    const rows: BoundaryRow[] = [];
    const minimum = Math.max(
        diagnosis.targetRange.startYear + config.boundaryContextYears,
        nominalYear - config.localizationRadius,
    );
    const maximum = Math.min(
        diagnosis.targetRange.endYear - config.boundaryContextYears,
        nominalYear + config.localizationRadius,
    );
    for (let year = minimum; year <= maximum; year += 1) {
        const older = weightedCorrelation(
            target,
            targetDifference,
            master,
            masterDifference,
            year - config.boundaryContextYears + 1,
            year,
            olderLag,
            config,
        );
        const newer = weightedCorrelation(
            target,
            targetDifference,
            master,
            masterDifference,
            year + 1,
            year + config.boundaryContextYears,
            newerLag,
            config,
        );
        const allOlder = weightedCorrelation(
            target,
            targetDifference,
            master,
            masterDifference,
            year - config.boundaryContextYears + 1,
            year + config.boundaryContextYears,
            olderLag,
            config,
        );
        const allNewer = weightedCorrelation(
            target,
            targetDifference,
            master,
            masterDifference,
            year - config.boundaryContextYears + 1,
            year + config.boundaryContextYears,
            newerLag,
            config,
        );
        rows.push({
            year,
            score: older.score + newer.score - Math.max(allOlder.score, allNewer.score),
            samplePairs: older.pairs + newer.pairs,
        });
    }
    return rows.sort((a, b) => b.score - a.score || b.year - a.year);
};

const eventTypeFor = (olderLag: number, newerLag: number): DiagnosisEventType => {
    const delta = newerLag - olderLag;
    if (delta === 1) return "missingRing";
    if (delta === -1) return "falseRing";
    return "partialMove";
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
    profile: BoundaryRow[],
    startYear: number,
    endYear: number,
): DiagnosisRankedYear[] => {
    const byYear = new Map(profile.map((row) => [row.year, row]));
    return Array.from({ length: endYear - startYear + 1 }, (_, offset) => {
        const year = startYear + offset;
        return {
            year,
            score: byYear.get(year)?.score ?? Number.NEGATIVE_INFINITY,
            evidenceTags: ["dense_lag_profile"],
        };
    })
        .sort((a, b) => b.score - a.score || b.year - a.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
};

const confidenceFor = (score: number): DiagnosisConfidence => (
    score >= 0.5 ? "high" : score >= 0.25 ? "medium" : "low"
);

export const locateDenseLagProfileEvents = (
    diagnosis: SeriesCoreDiagnosis,
    overrides: Partial<DenseLagProfileConfig> = {},
): DiagnosisEvent[] => {
    const config = { ...DEFAULT_DENSE_LAG_PROFILE_CONFIG, ...overrides };
    const target = new Map(
        cofechaStyleStandardize(diagnosis.rawTarget).map((point) => [point.year, point.value]),
    );
    const master = diagnosis.master.data;
    const targetDifference = firstDifferences(target);
    const masterDifference = firstDifferences(master);
    const states = Array.from(
        { length: config.maxLag - config.minLag + 1 },
        (_, index) => config.minLag + index,
    );
    const halfWindow = Math.floor(config.windowYears / 2);
    const rows: ProfileRow[] = [];
    for (
        let year = diagnosis.targetRange.startYear + halfWindow;
        year <= diagnosis.targetRange.endYear - halfWindow;
        year += config.stepYears
    ) {
        rows.push({
            year,
            scores: states.map((lag) => weightedCorrelation(
                target,
                targetDifference,
                master,
                masterDifference,
                year - halfWindow,
                year + halfWindow,
                lag,
                config,
            ).score),
        });
    }
    if (rows.length < 4) return [];
    const path = mergeShortRuns(rows, viterbi(rows, states, config), config);
    const runs = runsFor(path);
    const events: DiagnosisEvent[] = [];
    for (let index = 0; index < runs.length - 1; index += 1) {
        const older = runs[index];
        const newer = runs[index + 1];
        const olderLag = states[older.stateIndex];
        const newerLag = states[newer.stateIndex];
        const olderAdvantage = meanAdvantage(rows, older, older.stateIndex, newer.stateIndex);
        const newerAdvantage = meanAdvantage(rows, newer, newer.stateIndex, older.stateIndex);
        if (olderAdvantage < config.minSideMeanAdvantage
            || newerAdvantage < config.minSideMeanAdvantage) continue;
        const nominalYear = Math.round((rows[older.endIndex].year + rows[newer.startIndex].year) / 2);
        const profile = boundaryProfile(
            target,
            targetDifference,
            master,
            masterDifference,
            nominalYear,
            olderLag,
            newerLag,
            diagnosis,
            config,
        );
        const top = profile[0];
        if (!top || top.score < config.minBoundaryGain) continue;
        const eventType = eventTypeFor(olderLag, newerLag);
        const width = eventType === "partialMove"
            ? config.partialWindowWidth
            : config.missingFalseWindowWidth;
        const window = boundedWindow(
            top.year,
            width,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
        );
        const correctionYears = olderLag - newerLag;
        events.push({
            id: `diagnosis-event-${diagnosis.targetTree}-dense-${eventType}-${window.startYear}-${window.endYear}`,
            seriesId: diagnosis.targetTree,
            eventType,
            ...window,
            rankedYears: rankedYears(profile, window.startYear, window.endYear),
            confidenceLevel: confidenceFor(top.score),
            evidence: {
                algorithmSources: ["dense_lag_profile"],
                score: top.score,
                scoreMargin: Math.min(olderAdvantage, newerAdvantage),
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
                    `dense lag transition ${olderLag} -> ${newerLag}`,
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
    const selected: DiagnosisEvent[] = [];
    events
        .sort((a, b) => b.evidence.score - a.evidence.score)
        .forEach((event) => {
            if (!selected.some((other) => (
                Math.max(event.startYear, other.startYear)
                    <= Math.min(event.endYear, other.endYear)
            ))) selected.push(event);
        });
    return selected.sort((a, b) => b.endYear - a.endYear);
};

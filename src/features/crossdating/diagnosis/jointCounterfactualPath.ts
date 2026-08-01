/**
 * Bounded one/two-event counterfactual path search.
 *
 * Single-edit profiles provide separated breakpoint hypotheses. The path search then applies
 * pairs in one immutable calendar frame, so an existing local shift and a newly introduced event
 * can be recovered as two transitions instead of being collapsed into their net lag.
 */
import {
    scoreJointCounterfactualOperations,
    type JointCounterfactualOperationScore,
} from "./jointCounterfactualOperation";
import type {
    DiagnosisEventType,
    NumericSeries,
    SeriesCoreDiagnosis,
} from "./types";

type RecoverableEventType = Exclude<DiagnosisEventType, "wholeSeriesMove">;

export type JointCounterfactualPathEvent = {
    eventType: RecoverableEventType;
    shiftYears: number;
    year: number;
    singleDifferenceGain: number;
};

export type JointCounterfactualPathModel = {
    events: JointCounterfactualPathEvent[];
    rawCorrelation: number;
    differenceCorrelation: number;
    combinedCorrelation: number;
    rawGain: number;
    differenceGain: number;
    combinedGain: number;
};

export type JointCounterfactualPathResult = {
    baseline: {
        rawCorrelation: number;
        differenceCorrelation: number;
        combinedCorrelation: number;
    };
    candidateCount: number;
    bestSingle: JointCounterfactualPathModel | null;
    bestPair: JointCounterfactualPathModel | null;
    topSingles: JointCounterfactualPathModel[];
    topPairs: JointCounterfactualPathModel[];
};

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = [...series.entries()].sort((left, right) => left[0] - right[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return result;
};

const correlation = (
    target: NumericSeries,
    reference: NumericSeries,
    minimumPairs = 30,
): number => {
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    target.forEach((x, year) => {
        const y = reference.get(year);
        if (y === undefined) return;
        count += 1;
        sumX += x;
        sumY += y;
        sumXX += x * x;
        sumYY += y * y;
        sumXY += x * y;
    });
    if (count < minimumPairs) return -1;
    const numerator = sumXY - sumX * sumY / count;
    const varianceX = sumXX - sumX * sumX / count;
    const varianceY = sumYY - sumY * sumY / count;
    const denominator = Math.sqrt(Math.max(0, varianceX) * Math.max(0, varianceY));
    return denominator > 0 ? numerator / denominator : -1;
};

const scoreSeries = (
    target: NumericSeries,
    reference: NumericSeries,
): {
    rawCorrelation: number;
    differenceCorrelation: number;
    combinedCorrelation: number;
} => {
    const rawCorrelation = correlation(target, reference);
    const differenceCorrelation = correlation(
        firstDifferences(target),
        firstDifferences(reference),
    );
    return {
        rawCorrelation,
        differenceCorrelation,
        combinedCorrelation: rawCorrelation * 0.25 + differenceCorrelation * 0.75,
    };
};

/**
 * Apply all corrections in the original displayed calendar. Newer source values win collisions,
 * matching the editor rule that the untouched newer side remains authoritative.
 */
export const applyCounterfactualPath = (
    target: NumericSeries,
    events: JointCounterfactualPathEvent[],
): NumericSeries => {
    const orderedEvents = [...events].sort((left, right) => right.year - left.year);
    const result = new Map<number, number>();
    [...target.entries()]
        .sort((left, right) => right[0] - left[0])
        .forEach(([sourceYear, value]) => {
            const active = orderedEvents.filter((event) => (
                event.eventType === "partialMove"
                    ? sourceYear < event.year
                    : sourceYear <= event.year
            ));
            if (active.some((event) => (
                event.shiftYears === 1 && sourceYear === event.year
            ))) return;
            const destinationYear = sourceYear + active.reduce(
                (sum, event) => sum + event.shiftYears,
                0,
            );
            if (!result.has(destinationYear)) result.set(destinationYear, value);
        });
    return result;
};

const separatedCandidates = (
    operation: JointCounterfactualOperationScore,
    maximumCandidates: number,
    separationYears: number,
): JointCounterfactualPathEvent[] => {
    const selected: JointCounterfactualPathEvent[] = [];
    [...operation.rows]
        .sort((left, right) => (
            right.differenceGain - left.differenceGain
            || right.combinedGain - left.combinedGain
            || right.year - left.year
        ))
        .forEach((row) => {
            if (selected.length >= maximumCandidates) return;
            if (selected.some((candidate) => (
                Math.abs(candidate.year - row.year) < separationYears
            ))) return;
            selected.push({
                eventType: operation.eventType,
                shiftYears: operation.shiftYears,
                year: row.year,
                singleDifferenceGain: row.differenceGain,
            });
        });
    return selected;
};

const withGains = (
    events: JointCounterfactualPathEvent[],
    target: NumericSeries,
    reference: NumericSeries,
    baseline: JointCounterfactualPathResult["baseline"],
): JointCounterfactualPathModel => {
    const score = scoreSeries(applyCounterfactualPath(target, events), reference);
    return {
        events,
        ...score,
        rawGain: score.rawCorrelation - baseline.rawCorrelation,
        differenceGain: score.differenceCorrelation - baseline.differenceCorrelation,
        combinedGain: score.combinedCorrelation - baseline.combinedCorrelation,
    };
};

const compareModels = (
    left: JointCounterfactualPathModel,
    right: JointCounterfactualPathModel,
): number => (
    right.combinedGain - left.combinedGain
    || right.differenceGain - left.differenceGain
    || right.rawGain - left.rawGain
);

export const scoreJointCounterfactualPath = (
    diagnosis: SeriesCoreDiagnosis,
    operations = scoreJointCounterfactualOperations(diagnosis),
    options: {
        candidatesPerOperation?: number;
        candidateSeparationYears?: number;
        minimumPairSeparationYears?: number;
        maximumPairSeparationYears?: number;
    } = {},
): JointCounterfactualPathResult => {
    const candidatesPerOperation = options.candidatesPerOperation ?? 5;
    const candidateSeparationYears = options.candidateSeparationYears ?? 7;
    const minimumPairSeparationYears = options.minimumPairSeparationYears ?? 2;
    const maximumPairSeparationYears = options.maximumPairSeparationYears ?? 100;
    const target = diagnosis.rawTarget;
    const reference = diagnosis.master.data;
    const baseline = scoreSeries(target, reference);
    const candidates = operations.flatMap((operation) => (
        separatedCandidates(
            operation,
            candidatesPerOperation,
            candidateSeparationYears,
        )
    ));
    const singles = candidates.map((candidate) => (
        withGains([candidate], target, reference, baseline)
    ));
    const pairs: JointCounterfactualPathModel[] = [];
    for (let left = 0; left < candidates.length; left += 1) {
        for (let right = left + 1; right < candidates.length; right += 1) {
            const distance = Math.abs(candidates[left].year - candidates[right].year);
            if (
                distance < minimumPairSeparationYears
                || distance > maximumPairSeparationYears
            ) continue;
            pairs.push(withGains(
                [candidates[left], candidates[right]].sort(
                    (older, newer) => older.year - newer.year,
                ),
                target,
                reference,
                baseline,
            ));
        }
    }
    singles.sort(compareModels);
    pairs.sort(compareModels);
    return {
        baseline,
        candidateCount: candidates.length,
        bestSingle: singles[0] ?? null,
        bestPair: pairs[0] ?? null,
        topSingles: singles.slice(0, 12),
        topPairs: pairs.slice(0, 60),
    };
};

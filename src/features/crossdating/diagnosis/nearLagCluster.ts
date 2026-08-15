import type { BoundedLagStateEventSet } from "./eventPath";
import type { DiagnosisEvent, DiagnosisEventType } from "./types";

export type StableNearLagCluster = {
    representative: DiagnosisEvent;
    eventCount: number;
    evidenceYears: number[];
    operationTypes: DiagnosisEventType[];
    aggregateShiftYears: number;
    locallyComplete: boolean;
    maximumYearDrift: number;
};

export type StableTerminalUnitStaircaseFrontier = {
    representative: DiagnosisEvent;
    eventCount: number;
    aggregateShiftYears: number;
    boundaryYear: number;
    maximumYearDrift: number;
    strongerTransitionGain: number;
    weakerTransitionGain: number;
};

type LocalTransition = {
    event: DiagnosisEvent;
    eventType: DiagnosisEventType;
    shiftYears: number;
    year: number;
};

type TransitionGroup = {
    transitions: LocalTransition[];
    overlapsPreferred: boolean;
};

const topYear = (event: DiagnosisEvent): number | null => (
    [...event.rankedYears].sort((left, right) => (
        left.rank - right.rank || right.score - left.score || right.year - left.year
    ))[0]?.year ?? null
);

const transitionShift = (event: DiagnosisEvent): number | null => {
    const before = event.evidence.lagBefore;
    const after = event.evidence.lagAfter;
    if (before === null || after === null) return null;
    const shift = before - after;
    if (event.eventType === "missingRing") return shift === -1 ? shift : null;
    if (event.eventType === "falseRing") return shift === 1 ? shift : null;
    return event.eventType === "partialMove"
        && event.shiftSide === "older"
        && event.shiftYears === shift
        && shift < -1
        ? shift
        : null;
};

const localTransitions = (path: BoundedLagStateEventSet): LocalTransition[] => (
    path.events.flatMap((event) => {
        const shiftYears = transitionShift(event);
        const year = topYear(event);
        return shiftYears === null || year === null
            ? []
            : [{ event, eventType: event.eventType, shiftYears, year }];
    }).sort((left, right) => left.year - right.year)
);

type TerminalUnitStaircase = {
    representative: DiagnosisEvent;
    boundaryYear: number;
};

const terminalUnitStaircase = (
    path: BoundedLagStateEventSet,
    aggregateShiftYears: number,
    terminalLag: number,
    minimumFixedTailYears: number,
): TerminalUnitStaircase | null => {
    if (!Number.isInteger(aggregateShiftYears) || aggregateShiftYears === 0) return null;
    const direction = Math.sign(aggregateShiftYears);
    const eventCount = Math.abs(aggregateShiftYears);
    const runs = path.path.runs;
    const terminalRun = runs[runs.length - 1];
    if (
        !terminalRun
        || terminalRun.lag !== terminalLag
        || terminalRun.endYear - terminalRun.startYear + 1 < minimumFixedTailYears
        || runs.length < eventCount + 1
    ) return null;
    for (let offset = 0; offset <= eventCount; offset += 1) {
        const run = runs[runs.length - 1 - offset];
        if (!run || run.lag !== terminalLag + direction * offset) return null;
    }
    const precedingRun = runs[runs.length - eventCount - 2];
    if (precedingRun?.lag === terminalLag + direction * (eventCount + 1)) return null;
    const transitionLag = terminalLag + direction;
    const expectedType: DiagnosisEventType = direction > 0 ? "falseRing" : "missingRing";
    const representative = path.events.find((event) => (
        event.eventType === expectedType
        && event.evidence.lagBefore === transitionLag
        && event.evidence.lagAfter === terminalLag
    ));
    return representative
        ? { representative, boundaryYear: terminalRun.startYear }
        : null;
};

/**
 * Finds the newest unit event in a cumulative staircase without requiring the older, already
 * contaminated part of the path to be globally coherent. Both regularizations must reproduce
 * the complete terminal suffix, while the caller supplies an independently estimated depth.
 */
export const selectStableTerminalUnitStaircaseFrontier = (
    strongerPenaltyPath: BoundedLagStateEventSet | null,
    weakerPenaltyPath: BoundedLagStateEventSet | null,
    aggregateShiftYears: number,
    terminalLag = 0,
    maximumYearDrift = 2,
    minimumFixedTailYears = 8,
): StableTerminalUnitStaircaseFrontier | null => {
    if (!strongerPenaltyPath || !weakerPenaltyPath) return null;
    const stronger = terminalUnitStaircase(
        strongerPenaltyPath,
        aggregateShiftYears,
        terminalLag,
        minimumFixedTailYears,
    );
    const weaker = terminalUnitStaircase(
        weakerPenaltyPath,
        aggregateShiftYears,
        terminalLag,
        minimumFixedTailYears,
    );
    if (
        !stronger
        || !weaker
        || Math.abs(stronger.boundaryYear - weaker.boundaryYear) > maximumYearDrift
    ) return null;
    return {
        representative: stronger.representative,
        eventCount: Math.abs(aggregateShiftYears),
        aggregateShiftYears,
        boundaryYear: Math.round((stronger.boundaryYear + weaker.boundaryYear) / 2),
        maximumYearDrift,
        strongerTransitionGain: strongerPenaltyPath.path.transitionGain,
        weakerTransitionGain: weakerPenaltyPath.path.transitionGain,
    };
};

const overlapsEvent = (
    transitions: readonly LocalTransition[],
    preferred: readonly DiagnosisEvent[],
): boolean => {
    const startYear = transitions[0]?.year;
    const endYear = transitions[transitions.length - 1]?.year;
    if (startYear === undefined || endYear === undefined) return false;
    return preferred.some((event) => (
        Math.max(startYear, event.startYear) <= Math.min(endYear, event.endYear)
        || event.rankedYears.some((row) => (
            row.year >= startYear && row.year <= endYear
        ))
    ));
};

const transitionGroups = (
    transitions: readonly LocalTransition[],
    preferred: readonly DiagnosisEvent[],
    maximumSpanYears: number,
    maximumEvents: number,
): TransitionGroup[] => {
    const groups: TransitionGroup[] = [];
    for (let start = 0; start < transitions.length; start += 1) {
        for (
            let end = start + 1;
            end < transitions.length && end - start + 1 <= maximumEvents;
            end += 1
        ) {
            const selected = transitions.slice(start, end + 1);
            if (selected[selected.length - 1].year - selected[0].year + 1
                > maximumSpanYears) break;
            if (selected.some((transition, index) => {
                const next = selected[index + 1];
                return next !== undefined
                    && transition.event.evidence.lagAfter
                        !== next.event.evidence.lagBefore;
            })) continue;
            groups.push({
                transitions: selected,
                overlapsPreferred: overlapsEvent(selected, preferred),
            });
        }
    }
    return groups;
};

export const hasNearLagClusterCandidate = (
    path: BoundedLagStateEventSet | null,
    preferredEvents: readonly DiagnosisEvent[],
    maximumSpanYears = 13,
    maximumEvents = 5,
): boolean => path !== null && transitionGroups(
    localTransitions(path),
    preferredEvents,
    maximumSpanYears,
    maximumEvents,
).some((group) => group.overlapsPreferred);

const groupsMatch = (
    left: TransitionGroup,
    right: TransitionGroup,
    maximumYearDrift: number,
): boolean => left.transitions.length === right.transitions.length
    && left.transitions.every((transition, index) => {
        const other = right.transitions[index];
        return other !== undefined
            && transition.eventType === other.eventType
            && transition.shiftYears === other.shiftYears
            && Math.abs(transition.year - other.year) <= maximumYearDrift;
    });

const groupIsLocallyComplete = (
    group: TransitionGroup,
    transitions: readonly LocalTransition[],
    maximumSpanYears: number,
): boolean => !transitions.some((candidate) => {
    if (group.transitions.includes(candidate)) return false;
    const combined = [...group.transitions, candidate]
        .sort((left, right) => left.year - right.year);
    if (combined[combined.length - 1].year - combined[0].year + 1
        > maximumSpanYears) return false;
    return combined.every((transition, index) => {
        const next = combined[index + 1];
        return next === undefined
            || transition.event.evidence.lagAfter
                === next.event.evidence.lagBefore;
    });
});

/**
 * Selects a short multi-transition mode only when two regularizations reproduce the same path.
 * A cluster must overlap an independently produced event mode; agreement between two
 * short-run fits alone is not enough to replace a clear single-event decision.
 */
export const selectStableNearLagCluster = (
    strongerPenaltyPath: BoundedLagStateEventSet | null,
    weakerPenaltyPath: BoundedLagStateEventSet | null,
    preferredEvents: readonly DiagnosisEvent[],
    maximumSpanYears = 13,
    maximumYearDrift = 2,
    maximumEvents = 5,
): StableNearLagCluster | null => {
    if (!strongerPenaltyPath || !weakerPenaltyPath) return null;
    const strongerTransitions = localTransitions(strongerPenaltyPath);
    const weakerTransitions = localTransitions(weakerPenaltyPath);
    if (strongerTransitions.length < 2 || weakerTransitions.length < 2) return null;
    const strongerGroups = transitionGroups(
        strongerTransitions,
        preferredEvents,
        maximumSpanYears,
        maximumEvents,
    );
    const weakerGroups = transitionGroups(
        weakerTransitions,
        preferredEvents,
        maximumSpanYears,
        maximumEvents,
    );
    const matches = strongerGroups.flatMap((stronger) => weakerGroups
        .filter((weaker) => groupsMatch(stronger, weaker, maximumYearDrift))
        .map((weaker) => ({ stronger, weaker })))
        .filter(({ stronger, weaker }) => (
            stronger.overlapsPreferred && weaker.overlapsPreferred
        ))
        .sort((left, right) => {
            const leftOverlap = left.stronger.overlapsPreferred
                && left.weaker.overlapsPreferred;
            const rightOverlap = right.stronger.overlapsPreferred
                && right.weaker.overlapsPreferred;
            if (leftOverlap !== rightOverlap) return Number(rightOverlap) - Number(leftOverlap);
            const countDifference = right.stronger.transitions.length
                - left.stronger.transitions.length;
            if (countDifference !== 0) return countDifference;
            const leftEnd = left.stronger.transitions[
                left.stronger.transitions.length - 1
            ].year;
            const rightEnd = right.stronger.transitions[
                right.stronger.transitions.length - 1
            ].year;
            if (leftOverlap && leftEnd !== rightEnd) return leftEnd - rightEnd;
            return rightEnd - leftEnd;
        });
    const selected = matches[0];
    if (!selected) return null;
    const evidenceYears = selected.stronger.transitions.map((transition, index) => (
        Math.round((transition.year + selected.weaker.transitions[index].year) / 2)
    ));
    if (evidenceYears[evidenceYears.length - 1] - evidenceYears[0] + 1
        > maximumSpanYears) return null;
    const representative = selected.stronger.transitions[
        selected.stronger.transitions.length - 1
    ].event;
    return {
        representative,
        eventCount: selected.stronger.transitions.length,
        evidenceYears,
        operationTypes: [...new Set(selected.stronger.transitions.map(
            ({ eventType }) => eventType,
        ))].sort(),
        aggregateShiftYears: selected.stronger.transitions.reduce(
            (sum, transition) => sum + transition.shiftYears,
            0,
        ),
        locallyComplete: groupIsLocallyComplete(
            selected.stronger,
            strongerTransitions,
            maximumSpanYears,
        ) && groupIsLocallyComplete(
            selected.weaker,
            weakerTransitions,
            maximumSpanYears,
        ),
        maximumYearDrift,
    };
};

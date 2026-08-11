/**
 * Owns final evidence-gated translations of an already selected unit-event window.
 * It resolves adjacent-year plateaus and a narrow sequential endpoint ambiguity.
 */
import type { DiagnosisEvent, DiagnosisRankedYear } from "./types";

const BOUNDARY_EVIDENCE_PREFIXES = [
    "scan_top_year=",
    "candidate_top_year=",
    "paired_breakpoint_year=",
    "direct_transition_year=",
    "reference_vote_year=",
    "endpoint_residual_previous_top_year=",
    "endpoint_residual_posterior_top_year=",
    "false_direct_consensus_candidate_year=",
] as const;

const noteYear = (event: DiagnosisEvent, prefix: string): number | null => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const year = Number(note?.slice(prefix.length));
    return Number.isInteger(year) ? year : null;
};

const noteNumber = (event: DiagnosisEvent, prefix: string): number | null => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const value = Number(note?.slice(prefix.length));
    return Number.isFinite(value) ? value : null;
};

export type SequentialMissingEndpointBridge = {
    startYear: number;
    endYear: number;
    endpointYear: number;
    shiftYears: 1 | 2;
    fixedTailAdvantage: number;
};

const REVIEW_WINDOW_WIDTHS = new Set([5, 7, 9, 13]);

export const selectSequentialMissingEndpointBridge = (
    event: DiagnosisEvent,
): SequentialMissingEndpointBridge | null => {
    if (
        event.eventType !== "missingRing"
        || !event.seriesRange
        || !event.evidence.algorithmSources.includes(
            "sequential_missing_staircase_head",
        )
        || !event.evidence.algorithmSources.includes(
            "sequential_missing_exhausts_whole_baseline",
        )
    ) return null;
    const width = event.endYear - event.startYear + 1;
    const endpointYear = event.seriesRange.endYear;
    const shiftYears = endpointYear - event.endYear;
    const fixedTailAdvantage = noteNumber(
        event,
        "sequential_missing_fixed_tail_advantage=",
    );
    const primaryYear = [...event.rankedYears].sort((left, right) => (
        left.rank - right.rank || right.score - left.score || right.year - left.year
    ))[0]?.year;
    if (
        !REVIEW_WINDOW_WIDTHS.has(width)
        || (shiftYears !== 1 && shiftYears !== 2)
        || fixedTailAdvantage === null
        || fixedTailAdvantage >= 0
        || primaryYear === undefined
        || primaryYear > endpointYear
        || endpointYear - primaryYear >= width
    ) return null;
    return {
        startYear: endpointYear - width + 1,
        endYear: endpointYear,
        endpointYear,
        shiftYears,
        fixedTailAdvantage,
    };
};

export type AdjacentBoundaryShift = {
    shiftYears: -1 | 1;
    enteringYear: number;
    olderSupport: number;
    newerSupport: number;
    rule: "adjacent_consensus" | "false_ring_direct_edge_consensus";
};

export const selectAdjacentBoundaryShift = (
    event: DiagnosisEvent,
): AdjacentBoundaryShift | null => {
    if (event.eventType !== "missingRing" && event.eventType !== "falseRing") {
        return null;
    }
    const evidenceYears = BOUNDARY_EVIDENCE_PREFIXES
        .map((prefix) => noteYear(event, prefix))
        .filter((year): year is number => year !== null);
    const olderYear = event.startYear - 1;
    const newerYear = event.endYear + 1;
    const olderSupport = evidenceYears.filter(
        (year) => Math.abs(year - olderYear) <= 1,
    ).length;
    const newerSupport = evidenceYears.filter(
        (year) => Math.abs(year - newerYear) <= 1,
    ).length;
    const posteriorYear = noteYear(
        event,
        "endpoint_residual_posterior_top_year=",
    );
    const directFalseRingYear = noteYear(
        event,
        "false_direct_consensus_candidate_year=",
    );
    const falseRingDirectShift = event.eventType === "falseRing"
        ? posteriorYear === newerYear && directFalseRingYear === newerYear + 1
            ? 1
            : posteriorYear === olderYear && directFalseRingYear === olderYear - 1
                ? -1
                : null
        : null;
    const shiftYears = falseRingDirectShift
        ?? (olderSupport > newerSupport
            ? -1
            : newerSupport > olderSupport ? 1 : null);
    if (shiftYears === null) return null;

    const support = Math.max(olderSupport, newerSupport);
    const endpointWindow = event.evidence.algorithmSources.includes(
        "series_endpoint_review_window",
    );
    const width = event.endYear - event.startYear + 1;
    const removedYear = shiftYears < 0 ? event.endYear : event.startYear;
    const protectedBridgeYears = [
        noteYear(event, "missing_direct_transition_bridge_primary_year="),
        noteYear(event, "missing_direct_transition_bridge_year="),
    ].filter((year): year is number => year !== null);
    const standardConsensus = support >= 3
        && posteriorYear !== removedYear
        && !protectedBridgeYears.includes(removedYear)
        && (
            endpointWindow
            || (
                (width >= 13 || support >= 4)
                && (shiftYears < 0 || support >= 4)
            )
        );
    if (!standardConsensus && falseRingDirectShift === null) return null;

    const enteringYear = shiftYears < 0 ? olderYear : newerYear;
    if (
        event.seriesRange
        && (
            enteringYear < event.seriesRange.startYear
            || enteringYear > event.seriesRange.endYear
        )
    ) return null;
    return {
        shiftYears,
        enteringYear,
        olderSupport,
        newerSupport,
        rule: falseRingDirectShift === null
            ? "adjacent_consensus"
            : "false_ring_direct_edge_consensus",
    };
};

const shiftRankedYears = (
    event: DiagnosisEvent,
    shift: AdjacentBoundaryShift,
): DiagnosisRankedYear[] => {
    const startYear = event.startYear + shift.shiftYears;
    const endYear = event.endYear + shift.shiftYears;
    const retained = event.rankedYears
        .filter((row) => row.year >= startYear && row.year <= endYear)
        .sort((left, right) => left.rank - right.rank);
    const maximumScore = retained.reduce(
        (maximum, row) => Math.max(maximum, row.score),
        0,
    );
    return [
        {
            year: shift.enteringYear,
            rank: 0,
            score: maximumScore + 1e-6,
            evidenceTags: [shift.rule],
        },
        ...retained,
    ].map((row, index) => ({ ...row, rank: index + 1 }));
};

export const refineEventWithAdjacentBoundaryConsensus = (
    event: DiagnosisEvent,
): DiagnosisEvent => {
    const shift = selectAdjacentBoundaryShift(event);
    if (!shift) return event;
    const startYear = event.startYear + shift.shiftYears;
    const endYear = event.endYear + shift.shiftYears;
    const reviewCoreRange = event.reviewCoreRange
        ? {
            startYear: Math.max(startYear, event.reviewCoreRange.startYear),
            endYear: Math.min(endYear, event.reviewCoreRange.endYear),
        }
        : null;
    return {
        ...event,
        id: `${event.id}-adjacent-boundary-${shift.shiftYears}`,
        startYear,
        endYear,
        rankedYears: shiftRankedYears(event, shift),
        reviewCoreRange: reviewCoreRange
            && reviewCoreRange.startYear <= reviewCoreRange.endYear
            ? reviewCoreRange
            : undefined,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "adjacent_boundary_consensus",
                ...(shift.rule === "false_ring_direct_edge_consensus"
                    ? ["false_ring_direct_edge_consensus"]
                    : []),
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                `adjacent_boundary_shift_years=${shift.shiftYears}`,
                `adjacent_boundary_entering_year=${shift.enteringYear}`,
                `adjacent_boundary_older_support=${shift.olderSupport}`,
                `adjacent_boundary_newer_support=${shift.newerSupport}`,
                `adjacent_boundary_rule=${shift.rule}`,
            ],
        },
    };
};

const refineEventWithSequentialEndpointBridge = (
    event: DiagnosisEvent,
    bridge: SequentialMissingEndpointBridge,
): DiagnosisEvent => {
    const retained = event.rankedYears
        .filter((row) => (
            row.year >= bridge.startYear && row.year <= bridge.endYear
        ))
        .sort((left, right) => left.rank - right.rank);
    const maximumScore = retained.reduce(
        (maximum, row) => Math.max(maximum, row.score),
        0,
    );
    const entering = Array.from(
        { length: bridge.shiftYears },
        (_, index) => bridge.endpointYear - index,
    ).map((year, index) => ({
        year,
        rank: 0,
        score: maximumScore + (bridge.shiftYears - index) * 1e-6,
        evidenceTags: ["sequential_missing_endpoint_bridge"],
    }));
    const reviewCoreRange = event.reviewCoreRange
        ? {
            startYear: Math.max(
                bridge.startYear,
                event.reviewCoreRange.startYear,
            ),
            endYear: Math.min(
                bridge.endYear,
                event.reviewCoreRange.endYear,
            ),
        }
        : null;
    return {
        ...event,
        id: `${event.id}-sequential-endpoint-${bridge.shiftYears}`,
        startYear: bridge.startYear,
        endYear: bridge.endYear,
        rankedYears: [...entering, ...retained].map((row, index) => ({
            ...row,
            rank: index + 1,
        })),
        reviewCoreRange: reviewCoreRange
            && reviewCoreRange.startYear <= reviewCoreRange.endYear
            ? reviewCoreRange
            : undefined,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "sequential_missing_endpoint_bridge",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                `sequential_endpoint_bridge_previous_window=${
                    event.startYear
                }-${event.endYear}`,
                `sequential_endpoint_bridge_year=${bridge.endpointYear}`,
                `sequential_endpoint_bridge_shift_years=${bridge.shiftYears}`,
                `sequential_endpoint_bridge_fixed_tail_advantage=${
                    bridge.fixedTailAdvantage.toFixed(6)
                }`,
            ],
        },
    };
};

export const refineEventWithBoundaryConsensus = (
    event: DiagnosisEvent,
): DiagnosisEvent => {
    const endpointBridge = selectSequentialMissingEndpointBridge(event);
    return endpointBridge
        ? refineEventWithSequentialEndpointBridge(event, endpointBridge)
        : refineEventWithAdjacentBoundaryConsensus(event);
};

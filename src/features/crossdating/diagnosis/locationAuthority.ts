/**
 * Shared contract for location-only refinements.
 *
 * A concentrated, remote-separated complete lag path is a direct change-point mode. Later
 * local scorers may sharpen its ranking, but they must not replace it with a window that no
 * longer contains that mode. Detached alternatives remain internal evidence for a later pass.
 */
import { locationEvidenceFor, withEvidenceLedger } from "./evidenceLedger";
import type {
    DiagnosisEvent,
    DiagnosisEventLocationEvidence,
    DiagnosisEventType,
} from "./types";

const MINIMUM_STRONG_PATH_REFERENCE_COUNT = 3;
const MINIMUM_STRONG_PATH_CONCENTRATION = 0.45;
const MINIMUM_STRONG_PATH_REMOTE_MARGIN = 0.1;
const MAXIMUM_INDEPENDENT_UNIT_LOCATION_DRIFT_YEARS = 4;
const MINIMUM_DYNAMIC_UNIT_LOCATION_SCORE = 0.08;
const MINIMUM_DYNAMIC_UNIT_LOCATION_MARGIN = 0.04;
const ALLOWED_LOCAL_WINDOW_WIDTHS = [5, 7, 9, 13] as const;
const MAXIMUM_SINGLE_WINDOW_MODE_SPAN_YEARS = 12;
const DIRECT_FRONTIER_NOTE_PREFIXES = [
    "distant_sequential_frontier_year=",
    "sequential_missing_head_year=",
    "sequential_false_head_year=",
    "shared_zero_marker_year=",
    "nominal_boundary_year=",
    "profile_boundary_year=",
] as const;

export type IndependentUnitOperationLocation = {
    eventType: DiagnosisEventType;
    bestYear: number;
    score: number;
    scoreMargin: number;
};

const rankedYear = (event: DiagnosisEvent): number | null => (
    event.rankedYears[0]?.year ?? null
);

const directFrontierYear = (event: DiagnosisEvent): number | null => {
    for (const prefix of DIRECT_FRONTIER_NOTE_PREFIXES) {
        const note = [...event.evidence.notes].reverse().find((value) => (
            value.startsWith(prefix)
        ));
        const year = Number(note?.slice(prefix.length));
        if (Number.isInteger(year)) return year;
    }
    return null;
};

export type CrossPenaltyLocationProbe = {
    transitionGain: number;
    runnerUpMargin: number;
    events: readonly DiagnosisEvent[];
};

const isUnitEvent = (event: DiagnosisEvent): boolean => (
    event.eventType === "missingRing" || event.eventType === "falseRing"
);

const clampWindowToRange = (
    startYear: number,
    width: number,
    targetRange: { startYear: number; endYear: number },
): { startYear: number; endYear: number } => {
    const maximumStart = targetRange.endYear - width + 1;
    const boundedStart = Math.max(
        targetRange.startYear,
        Math.min(startYear, maximumStart),
    );
    return {
        startYear: boundedStart,
        endYear: boundedStart + width - 1,
    };
};

const supportingWindow = (
    candidate: DiagnosisEvent,
    supportYears: readonly number[],
    targetRange: { startYear: number; endYear: number },
): { startYear: number; endYear: number } => {
    const minimumYear = Math.min(...supportYears);
    const maximumYear = Math.max(...supportYears);
    const candidateWidth = candidate.endYear - candidate.startYear + 1;
    const requiredWidth = Math.max(7, candidateWidth, maximumYear - minimumYear + 1);
    const width = ALLOWED_LOCAL_WINDOW_WIDTHS.find((value) => value >= requiredWidth) ?? 13;
    let startYear = candidate.startYear;
    if (candidateWidth !== width) {
        startYear = rankedYear(candidate)! - Math.floor(width / 2);
    }
    startYear = Math.min(startYear, minimumYear);
    startYear = Math.max(startYear, maximumYear - width + 1);
    return clampWindowToRange(startYear, width, targetRange);
};

const normalizeSelectedUnitWindow = (
    event: DiagnosisEvent,
    targetRange: { startYear: number; endYear: number },
): DiagnosisEvent => {
    const currentWidth = event.endYear - event.startYear + 1;
    if (ALLOWED_LOCAL_WINDOW_WIDTHS.includes(
        currentWidth as (typeof ALLOWED_LOCAL_WINDOW_WIDTHS)[number],
    )) return event;
    const width = ALLOWED_LOCAL_WINDOW_WIDTHS.find((value) => value >= currentWidth);
    if (width === undefined) return event;
    const window = clampWindowToRange(event.startYear, width, targetRange);
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const minimumScore = Math.min(0, ...event.rankedYears.map(({ score }) => score));
    const rankedYears = Array.from(
        { length: width },
        (_, index) => window.startYear + index,
    ).map((year) => prior.get(year) ?? {
        year,
        rank: 0,
        score: minimumScore - 1,
        evidenceTags: ["selected_unit_window_width_normalization"],
    }).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    return withEvidenceLedger({
        ...event,
        id: `${event.id}-normalized-${width}`,
        ...window,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "selected_unit_window_width_normalization",
            ])).sort(),
            notes: Array.from(new Set([
                ...event.evidence.notes,
                `selected_unit_window_previous=${event.startYear}-${event.endYear}`,
                `selected_unit_window_normalized=${window.startYear}-${window.endYear}`,
            ])),
        },
    });
};

export const terminalFalseRingOlderPadding = (
    event: DiagnosisEvent,
): number | null => {
    if (event.eventType !== "falseRing"
        || !event.evidence.algorithmSources.includes(
            "stable_terminal_unit_staircase_frontier",
        )) return null;
    const transitionYears = event.evidence.notes
        .find((note) => note.startsWith("terminal_unit_staircase_transition_years="))
        ?.split("=")[1]
        ?.split(",")
        .map(Number)
        .filter(Number.isInteger) ?? [];
    const maximumGap = Number(event.evidence.notes
        .find((note) => note.startsWith(
            "terminal_unit_staircase_max_adjacent_gap_years=",
        ))?.split("=")[1]);
    return transitionYears.length >= 2 && Number.isFinite(maximumGap)
        ? Math.min(10, Math.max(6, Math.round(maximumGap)))
        : null;
};

export const terminalMissingRingNewerPadding = (
    event: DiagnosisEvent,
): number | null => {
    if (event.eventType !== "missingRing"
        || !event.evidence.algorithmSources.includes(
            "stable_terminal_unit_staircase_frontier",
        )) return null;
    const transitionYears = event.evidence.notes
        .find((note) => note.startsWith("terminal_unit_staircase_transition_years="))
        ?.split("=")[1]
        ?.split(",")
        .map(Number)
        .filter(Number.isInteger) ?? [];
    const maximumGap = Number(event.evidence.notes
        .find((note) => note.startsWith(
            "terminal_unit_staircase_max_adjacent_gap_years=",
        ))?.split("=")[1]);
    return transitionYears.length >= 3 && Number.isFinite(maximumGap)
        ? Math.min(10, Math.max(6, Math.round(maximumGap)))
        : null;
};

/**
 * Reconciles one already-selected operation with a compact multi-event location mode. The
 * operation contract is immutable here; only its single 13-year review window may change.
 */
export const projectMultiEventLocationConsensus = (
    event: DiagnosisEvent,
    evidenceYears: readonly number[],
    targetRange: { startYear: number; endYear: number },
    forceMultiEventWindow = false,
    maximumModeSpanYears = 16,
    frontierAnchorYear: number | null = null,
): DiagnosisEvent => {
    if (event.eventType === "wholeSeriesMove") return event;
    const currentYear = rankedYear(event);
    if (currentYear === null) return event;
    const currentCalibratedLocation = locationEvidenceFor(event).some((entry) => (
        entry.calibrated
        && entry.startYear === event.startYear
        && entry.endYear === event.endYear
    ));
    if (currentCalibratedLocation) return event;
    const years = [...new Set([currentYear, ...evidenceYears])]
        .filter((year) => Number.isInteger(year)
            && year >= targetRange.startYear
            && year <= targetRange.endYear)
        .sort((left, right) => left - right);
    const clusters: number[][] = [];
    for (let start = 0; start < years.length; start += 1) {
        for (let end = start; end < years.length; end += 1) {
            const selected = years.slice(start, end + 1);
            const span = selected[selected.length - 1] - selected[0];
            if (span > maximumModeSpanYears) break;
            const hasEnoughWideModeSupport = span <= MAXIMUM_SINGLE_WINDOW_MODE_SPAN_YEARS
                || selected.length >= 3;
            if (selected.length >= 2
                && selected.includes(currentYear)
                && hasEnoughWideModeSupport) clusters.push(selected);
        }
    }
    const selectedYears = clusters.sort((left, right) => (
        right[right.length - 1] - left[left.length - 1]
        || right.length - left.length
        || right[0] - left[0]
    ))[0] ?? (
        forceMultiEventWindow
        && event.evidence.algorithmSources.includes(
            "stable_terminal_unit_staircase_frontier",
        )
            ? [currentYear]
            : null
    );
    if (!selectedYears) return event;
    const ownFrontierYear = directFrontierYear(event);
    const anchoredFrontierYear = ownFrontierYear !== null
        && selectedYears.includes(ownFrontierYear)
        ? ownFrontierYear
        : frontierAnchorYear !== null
        && selectedYears.includes(frontierAnchorYear)
        ? frontierAnchorYear
        : null;
    const centerYear = anchoredFrontierYear ?? Math.round(selectedYears.reduce(
        (sum, year) => sum + year,
        0,
    ) / selectedYears.length);
    let window = clampWindowToRange(centerYear - 6, 13, targetRange);
    const terminalBoundaryNote = [...event.evidence.notes].reverse().find((note) => (
        note.startsWith("terminal_unit_staircase_boundary_year=")
    ));
    const terminalBoundaryYear = Number(terminalBoundaryNote?.split("=")[1]);
    const rawTerminalBoundaryNote = [...event.evidence.notes].reverse().find((note) => (
        note.startsWith("terminal_unit_staircase_raw_boundary_year=")
    ));
    const rawTerminalBoundaryYear = Number(rawTerminalBoundaryNote?.split("=")[1]);
    const guardedByTerminalBoundary = event.evidence.algorithmSources.includes(
        "stable_terminal_unit_staircase_frontier",
    ) && Number.isInteger(terminalBoundaryYear)
        && (terminalBoundaryYear < window.startYear || terminalBoundaryYear > window.endYear);
    if (guardedByTerminalBoundary) {
        window = terminalBoundaryYear < window.startYear
            ? clampWindowToRange(terminalBoundaryYear, 13, targetRange)
            : clampWindowToRange(terminalBoundaryYear - 12, 13, targetRange);
    }
    const falseRingOlderPadding = Number.isInteger(terminalBoundaryYear)
        ? terminalFalseRingOlderPadding(event)
        : null;
    const missingRingNewerPadding = Number.isInteger(terminalBoundaryYear)
        ? terminalMissingRingNewerPadding(event)
        : null;
    if (falseRingOlderPadding !== null) {
        window = clampWindowToRange(
            terminalBoundaryYear - falseRingOlderPadding,
            13,
            targetRange,
        );
    } else if (missingRingNewerPadding !== null) {
        window = clampWindowToRange(
            terminalBoundaryYear - (12 - missingRingNewerPadding),
            13,
            targetRange,
        );
    }
    const guardsRawCadenceBoundary = Number.isInteger(rawTerminalBoundaryYear)
        && rawTerminalBoundaryYear !== terminalBoundaryYear
        && (rawTerminalBoundaryYear < window.startYear
            || rawTerminalBoundaryYear > window.endYear);
    if (guardsRawCadenceBoundary) {
        // Cadence extrapolation is useful for ranking a plateau, but it must not discard the
        // complete-path boundary that justified the staircase in the first place.
        window = rawTerminalBoundaryYear < window.startYear
            ? clampWindowToRange(rawTerminalBoundaryYear, 13, targetRange)
            : clampWindowToRange(rawTerminalBoundaryYear - 12, 13, targetRange);
    }
    const sequentialFalseHeadYear = Number([...event.evidence.notes].reverse()
        .find((note) => note.startsWith("sequential_false_head_year="))
        ?.split("=")[1]);
    const sequentialFalseCandidateYear = Number([...event.evidence.notes].reverse()
        .find((note) => note.startsWith("sequential_false_candidate_frontier_year="))
        ?.split("=")[1]);
    const sequentialHeadWindow = Number.isInteger(sequentialFalseHeadYear)
        ? clampWindowToRange(sequentialFalseHeadYear - 6, 13, targetRange)
        : null;
    const hasNewerSequentialFalseFrontier = event.eventType === "falseRing"
        && event.evidence.algorithmSources.includes("sequential_false_staircase_head")
        && !event.evidence.algorithmSources.includes(
            "stable_terminal_unit_staircase_frontier",
        )
        && Number.isInteger(sequentialFalseCandidateYear)
        && Math.max(sequentialFalseHeadYear, sequentialFalseCandidateYear) > window.endYear
        && sequentialFalseHeadYear >= window.startYear
        && sequentialFalseHeadYear <= window.endYear + 7
        && sequentialHeadWindow !== null
        && sequentialHeadWindow.startYear > window.startYear;
    if (hasNewerSequentialFalseFrontier) {
        // A false-ring chain is reviewed from the bark side. A compact newer head may move the
        // mode forward, but an older or detached head must not pull a correct window backwards.
        window = sequentialHeadWindow;
    }
    if (event.startYear === window.startYear && event.endYear === window.endYear) return event;

    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const maximumScore = Math.max(0, ...event.rankedYears.map(({ score }) => score));
    const minimumScore = Math.min(0, ...event.rankedYears.map(({ score }) => score));
    const preferredYear = selectedYears
        .filter((year) => year >= window.startYear && year <= window.endYear)
        .sort((left, right) => (
            Math.abs(left - centerYear) - Math.abs(right - centerYear)
            || right - left
        ))[0] ?? centerYear;
    const rankedYears = Array.from(
        { length: 13 },
        (_, index) => window.startYear + index,
    ).map((year) => {
        const existing = prior.get(year);
        return {
            year,
            rank: 0,
            score: year === preferredYear
                ? maximumScore + Math.max(1e-9, Math.abs(maximumScore) * 1e-12)
                : existing?.score ?? minimumScore - 1,
            evidenceTags: Array.from(new Set([
                ...(existing?.evidenceTags ?? []),
                "multi_event_frontier_location_consensus",
            ])).sort(),
        };
    }).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    const reviewCoreRange = event.reviewCoreRange ? {
        startYear: Math.max(window.startYear, event.reviewCoreRange.startYear),
        endYear: Math.min(window.endYear, event.reviewCoreRange.endYear),
    } : null;
    const referenceCount = Math.max(
        0,
        ...locationEvidenceFor(event).map((entry) => entry.referenceCount),
    );
    return withEvidenceLedger({
        ...event,
        id: `${event.id}-multi-frontier-${window.startYear}-${window.endYear}`,
        ...window,
        rankedYears,
        reviewCoreRange: reviewCoreRange
            && reviewCoreRange.startYear <= reviewCoreRange.endYear
            ? reviewCoreRange
            : undefined,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "multi_event_frontier_location_consensus",
                ...(falseRingOlderPadding === null
                    ? []
                    : ["terminal_false_ring_asymmetric_window"]),
                ...(missingRingNewerPadding === null
                    ? []
                    : ["terminal_missing_ring_asymmetric_window"]),
            ])).sort(),
            locationEvidence: [
                ...(event.evidence.locationEvidence ?? []),
                {
                    source: "multi_event_frontier_location_consensus",
                    ...window,
                    topYear: preferredYear,
                    referenceCount,
                    concentration: selectedYears.length <= 1
                        ? null
                        : Math.max(
                            0,
                            1 - (selectedYears[selectedYears.length - 1]
                                - selectedYears[0]) / 17,
                        ),
                    remoteMargin: null,
                    calibrated: false,
                },
            ],
            notes: Array.from(new Set([
                ...event.evidence.notes,
                `multi_frontier_previous_window=${event.startYear}-${event.endYear}`,
                `multi_frontier_evidence_years=${selectedYears.join(",")}`,
                `multi_frontier_center_year=${centerYear}`,
                `multi_frontier_consensus_window=${window.startYear}-${window.endYear}`,
                ...(anchoredFrontierYear === null ? [] : [
                    `multi_frontier_validated_unit_anchor=${anchoredFrontierYear}`,
                ]),
                ...(guardedByTerminalBoundary ? [
                    `multi_frontier_terminal_boundary_guard=${terminalBoundaryYear}`,
                ] : []),
                ...(falseRingOlderPadding === null ? [] : [
                    `terminal_false_ring_older_padding=${
                        falseRingOlderPadding
                    }`,
                    `terminal_false_ring_newer_padding=${
                        12 - falseRingOlderPadding
                    }`,
                ]),
                ...(missingRingNewerPadding === null ? [] : [
                    `terminal_missing_ring_older_padding=${
                        12 - missingRingNewerPadding
                    }`,
                    `terminal_missing_ring_newer_padding=${
                        missingRingNewerPadding
                    }`,
                ]),
                ...(guardsRawCadenceBoundary ? [
                    `terminal_cadence_raw_boundary_guard=${rawTerminalBoundaryYear}`,
                ] : []),
                ...(hasNewerSequentialFalseFrontier ? [
                    `sequential_false_newer_frontier_guard=${sequentialFalseHeadYear}`,
                ] : []),
            ])),
        },
    });
};

const isNegativeLocalEvent = (event: DiagnosisEvent): boolean => (
    event.eventType === "missingRing"
    || (event.eventType === "partialMove" && (event.shiftYears ?? 0) < -1)
);

/**
 * Shares location authority between the two physically equivalent negative-event encodings.
 * Operation and shift stay immutable; only a detached window can move.
 */
export const projectNegativeEventToCrossPenaltyEquivalentFrontier = (
    event: DiagnosisEvent,
    stronger: CrossPenaltyLocationProbe | null,
    regularized: CrossPenaltyLocationProbe | null,
    targetRange: { startYear: number; endYear: number },
    maximumYearDrift = 2,
): DiagnosisEvent => {
    if (!stronger
        || !regularized
        || !isNegativeLocalEvent(event)
        || event.evidence.lagAfter === null
        || event.evidence.lagAfter === undefined
        || stronger.transitionGain < 20
        || regularized.transitionGain < 20
        || stronger.runnerUpMargin < 0.05
        || regularized.runnerUpMargin < 0.05) return event;
    const oppositeType = event.eventType === "partialMove"
        ? "missingRing"
        : "partialMove";
    const matches = stronger.events.flatMap((candidate) => {
        const candidateYear = rankedYear(candidate);
        if (candidate.eventType !== oppositeType
            || !isNegativeLocalEvent(candidate)
            || candidateYear === null
            || candidate.evidence.lagAfter !== event.evidence.lagAfter
            || candidate.evidence.samplePairs < 30) return [];
        const concentration = Number(candidate.evidence.notes.find((note) => (
            note.startsWith("bounded_path_location_concentration=")
        ))?.split("=")[1]);
        if (!Number.isFinite(concentration) || concentration < 0.7) return [];
        const corroborating = regularized.events.find((other) => {
            const otherYear = rankedYear(other);
            return other.eventType === candidate.eventType
                && other.shiftYears === candidate.shiftYears
                && other.evidence.lagBefore === candidate.evidence.lagBefore
                && other.evidence.lagAfter === candidate.evidence.lagAfter
                && otherYear !== null
                && Math.abs(otherYear - candidateYear) <= maximumYearDrift;
        });
        const corroboratingYear = corroborating ? rankedYear(corroborating) : null;
        return corroboratingYear === null ? [] : [{
            candidate,
            centerYear: Math.round((candidateYear + corroboratingYear) / 2),
            concentration,
        }];
    }).sort((left, right) => right.centerYear - left.centerYear);
    const selected = matches[0];
    if (!selected) return event;
    const outsideDistance = selected.centerYear < event.startYear
        ? event.startYear - selected.centerYear
        : selected.centerYear > event.endYear
            ? selected.centerYear - event.endYear
            : 0;
    if (outsideDistance < 2) return event;

    const semanticYear = event.eventType === "partialMove"
        ? selected.centerYear + 1
        : selected.centerYear - 1;
    const currentWidth = event.endYear - event.startYear + 1;
    const width = ALLOWED_LOCAL_WINDOW_WIDTHS.includes(
        currentWidth as (typeof ALLOWED_LOCAL_WINDOW_WIDTHS)[number],
    ) ? currentWidth : 13;
    const window = clampWindowToRange(
        semanticYear - Math.floor((width - 1) / 2),
        width,
        targetRange,
    );
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const maximumScore = Math.max(0, ...event.rankedYears.map(({ score }) => score));
    const minimumScore = Math.min(0, ...event.rankedYears.map(({ score }) => score));
    const rankedYears = Array.from(
        { length: width },
        (_, index) => window.startYear + index,
    ).map((year) => ({
        year,
        rank: 0,
        score: year === semanticYear
            ? maximumScore + Math.max(1e-9, Math.abs(maximumScore) * 1e-12)
            : prior.get(year)?.score ?? minimumScore - 1,
        evidenceTags: Array.from(new Set([
            ...(prior.get(year)?.evidenceTags ?? []),
            "cross_penalty_equivalent_frontier_location",
        ])).sort(),
    })).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    const referenceCount = Math.max(
        0,
        ...locationEvidenceFor(selected.candidate).map((entry) => entry.referenceCount),
    );
    return withEvidenceLedger({
        ...event,
        id: `${event.id}-cross-penalty-equivalent-${semanticYear}`,
        ...window,
        rankedYears,
        reviewCoreRange: undefined,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "cross_penalty_equivalent_frontier_location",
            ])).sort(),
            locationEvidence: [
                ...(event.evidence.locationEvidence ?? []),
                {
                    source: "cross_penalty_equivalent_frontier_location",
                    ...window,
                    topYear: semanticYear,
                    referenceCount,
                    concentration: selected.concentration,
                    remoteMargin: Math.min(
                        stronger.runnerUpMargin,
                        regularized.runnerUpMargin,
                    ),
                    calibrated: true,
                },
            ],
            notes: Array.from(new Set([
                ...event.evidence.notes,
                `cross_penalty_equivalent_previous_window=${
                    event.startYear
                }-${event.endYear}`,
                `cross_penalty_equivalent_path_type=${selected.candidate.eventType}`,
                `cross_penalty_equivalent_path_year=${selected.centerYear}`,
                `cross_penalty_equivalent_semantic_year=${semanticYear}`,
                `cross_penalty_equivalent_window=${window.startYear}-${window.endYear}`,
            ])),
        },
    });
};

const noteRange = (
    event: DiagnosisEvent,
    prefix: string,
): { startYear: number; endYear: number } | null => {
    const note = [...event.evidence.notes].reverse().find((value) => (
        value.startsWith(prefix)
    ));
    const match = note?.slice(prefix.length).match(/^(-?\d+)-(-?\d+)$/);
    if (!match) return null;
    const startYear = Number(match[1]);
    const endYear = Number(match[2]);
    return Number.isFinite(startYear) && Number.isFinite(endYear)
        ? { startYear, endYear }
        : null;
};

const supportsCandidateAgainstWeakDetachedResidual = (
    event: DiagnosisEvent,
    candidateYear: number,
): boolean => {
    if (!event.evidence.notes.includes(
        "locator_adjudication=fallback_detached_locator_mode",
    )) return false;
    const previousRange = noteRange(event, "endpoint_residual_previous_range=");
    const coreRange = noteRange(event, "endpoint_residual_core_range=");
    const bestReferenceMargin = noteNumber(
        event,
        "unit_window_bestReference31_margin=",
    ) ?? 0;
    const endpointReferenceCount = noteNumber(
        event,
        "endpoint_residual_reference_count=",
    ) ?? Number.POSITIVE_INFINITY;
    const localYears = event.evidence.notes.flatMap((note) => {
        const match = note.match(/^unit_local_[A-Za-z0-9]+_year=(-?\d+)$/);
        return match ? [Number(match[1])] : [];
    });
    return candidateYear < event.startYear || candidateYear > event.endYear
        ? previousRange !== null
            && candidateYear >= previousRange.startYear
            && candidateYear <= previousRange.endYear
            && coreRange !== null
            && coreRange.startYear >= event.startYear
            && coreRange.endYear <= event.endYear
            && bestReferenceMargin >= 0.04
            && endpointReferenceCount <= 8
            && localYears.filter((year) => (
                Math.abs(year - candidateYear) <= 4
            )).length >= 5
        : false;
};

/**
 * Reconciles location only after operation selection. A hard-gated candidate must agree with
 * either the unstandardized lag path or a high-margin full-interval unit operation. This keeps a
 * remote COFECHA/local-correlation mode from replacing two independent year-level signals.
 */
export const projectUnitLocationFromIndependentConsensus = (
    event: DiagnosisEvent,
    candidateEvents: readonly DiagnosisEvent[],
    rawPathEvents: readonly DiagnosisEvent[],
    operationLocation: IndependentUnitOperationLocation | null,
    targetRange: { startYear: number; endYear: number },
): DiagnosisEvent => {
    if (!isUnitEvent(event)) return event;
    const candidates = candidateEvents.filter((candidate) => (
        candidate.eventType === event.eventType
        && candidate.evidence.notes.includes("candidate_hard_gate_passed")
        && rankedYear(candidate) !== null
    )).sort((left, right) => (
        right.evidence.score - left.evidence.score
        || (rankedYear(right) ?? -Infinity) - (rankedYear(left) ?? -Infinity)
    ));
    const candidate = candidates[0];
    const candidateYear = candidate ? rankedYear(candidate) : null;
    if (!candidate || candidateYear === null) return event;

    // This projector resolves detached modes; it is not another within-mode ranker. Once the
    // selected review window already contains the independently supported candidate year, keep
    // the calibrated 5/7/9/13-year window chosen upstream. Re-centering an overlapping mode made
    // dense unit-event chains lose an older edge by one or two years.
    if (candidate.startYear <= event.endYear && candidate.endYear >= event.startYear) return event;

    const rawPath = rawPathEvents.filter((path) => (
        path.eventType === event.eventType
        && rankedYear(path) !== null
        && Math.abs(rankedYear(path)! - candidateYear)
            <= MAXIMUM_INDEPENDENT_UNIT_LOCATION_DRIFT_YEARS
    )).sort((left, right) => (
        Math.abs(rankedYear(left)! - candidateYear)
            - Math.abs(rankedYear(right)! - candidateYear)
        || right.evidence.score - left.evidence.score
    ))[0] ?? null;
    const dynamicLocation = operationLocation
        && operationLocation.eventType === event.eventType
        && operationLocation.score >= MINIMUM_DYNAMIC_UNIT_LOCATION_SCORE
        && operationLocation.scoreMargin >= MINIMUM_DYNAMIC_UNIT_LOCATION_MARGIN
        && Math.abs(operationLocation.bestYear - candidateYear)
            <= MAXIMUM_INDEPENDENT_UNIT_LOCATION_DRIFT_YEARS
        ? operationLocation
        : null;
    const currentStrongPath = strongBoundedPathLocation(event);
    const eventHasIndependentDynamicOperation = event.evidence.algorithmSources.includes(
        "joint_year_operation_evidence",
    ) && event.evidence.algorithmSources.includes("full_interval_counterfactual_scan");
    const candidateReclaimsWeakDetachedResidual = supportsCandidateAgainstWeakDetachedResidual(
        event,
        candidateYear,
    );
    if (!rawPath && (
        (!dynamicLocation && !candidateReclaimsWeakDetachedResidual)
        || currentStrongPath !== null
        || (
            candidate.confidenceLevel === "low"
            && !eventHasIndependentDynamicOperation
            && !candidateReclaimsWeakDetachedResidual
        )
    )) return normalizeSelectedUnitWindow(event, targetRange);

    const nearbyStrongPathYear = currentStrongPath?.topYear ?? null;
    const supportYears = [
        candidateYear,
        ...(rawPath && rankedYear(rawPath) !== null ? [rankedYear(rawPath)!] : []),
        ...(dynamicLocation ? [dynamicLocation.bestYear] : []),
        ...(nearbyStrongPathYear !== null
            && Math.abs(nearbyStrongPathYear - candidateYear) <= 13
            ? [nearbyStrongPathYear]
            : []),
    ];
    const window = supportingWindow(candidate, supportYears, targetRange);
    const prior = new Map(candidate.rankedYears.map((row) => [row.year, row]));
    const minimumScore = Math.min(0, ...candidate.rankedYears.map((row) => row.score));
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => window.startYear + index,
    ).map((year) => {
        const existing = prior.get(year);
        const support = supportYears.reduce(
            (sum, supportYear) => sum + 1 / (1 + Math.abs(year - supportYear)),
            0,
        );
        return {
            year,
            rank: 0,
            score: (existing?.score ?? minimumScore - 1) + support,
            evidenceTags: Array.from(new Set([
                ...(existing?.evidenceTags ?? []),
                "independent_unit_location_consensus",
            ])).sort(),
        };
    }).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    const referenceCount = Math.max(
        0,
        ...[event, candidate, ...(rawPath ? [rawPath] : [])]
            .flatMap(locationEvidenceFor)
            .map((entry) => entry.referenceCount),
    );
    return withEvidenceLedger({
        ...event,
        id: `${event.id}-independent-unit-location-${candidateYear}`,
        ...window,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "independent_unit_location_consensus",
            ])).sort(),
            candidateIds: Array.from(new Set([
                ...event.evidence.candidateIds,
                ...candidate.evidence.candidateIds,
            ])),
            locationEvidence: [
                ...(event.evidence.locationEvidence ?? []),
                {
                    source: "independent_unit_location_consensus",
                    ...window,
                    topYear: rankedYears[0]?.year ?? candidateYear,
                    referenceCount,
                    concentration: Math.max(
                        0,
                        1 - (Math.max(...supportYears) - Math.min(...supportYears)) / 13,
                    ),
                    remoteMargin: dynamicLocation?.scoreMargin ?? null,
                    calibrated: false,
                },
            ],
            notes: Array.from(new Set([
                ...event.evidence.notes,
                `independent_unit_candidate_year=${candidateYear}`,
                ...(rawPath && rankedYear(rawPath) !== null
                    ? [`independent_unit_raw_path_year=${rankedYear(rawPath)}`]
                    : []),
                ...(dynamicLocation
                    ? [`independent_unit_operation_year=${dynamicLocation.bestYear}`]
                    : []),
                ...(nearbyStrongPathYear !== null
                    && Math.abs(nearbyStrongPathYear - candidateYear) <= 13
                    ? [`independent_unit_nearby_strong_path_year=${nearbyStrongPathYear}`]
                    : []),
                `independent_unit_previous_window=${event.startYear}-${event.endYear}`,
                `independent_unit_consensus_window=${window.startYear}-${window.endYear}`,
            ])),
        },
    });
};

export const strongBoundedPathLocation = (
    event: DiagnosisEvent,
): DiagnosisEventLocationEvidence | null => locationEvidenceFor(event)
    .filter((entry) => (
        entry.source === "bounded_complete_lag_path"
        && entry.topYear !== null
        && entry.referenceCount >= MINIMUM_STRONG_PATH_REFERENCE_COUNT
        && (entry.concentration ?? 0) >= MINIMUM_STRONG_PATH_CONCENTRATION
        && (entry.remoteMargin ?? 0) >= MINIMUM_STRONG_PATH_REMOTE_MARGIN
    ))
    .sort((left, right) => (
        (right.concentration ?? 0) - (left.concentration ?? 0)
        || (right.remoteMargin ?? 0) - (left.remoteMargin ?? 0)
        || right.referenceCount - left.referenceCount
    ))[0] ?? null;

export const preservesStrongBoundedPathMode = (
    event: DiagnosisEvent,
    proposedStartYear: number,
    proposedEndYear: number,
): boolean => {
    const path = strongBoundedPathLocation(event);
    return !path || path.topYear === null || (
        path.topYear >= proposedStartYear && path.topYear <= proposedEndYear
    );
};

const noteNumber = (event: DiagnosisEvent, prefix: string): number | null => {
    const note = [...event.evidence.notes].reverse().find((value) => (
        value.startsWith(prefix)
    ));
    const parsed = Number(note?.slice(prefix.length));
    return Number.isFinite(parsed) ? parsed : null;
};

const independentlySupportedUnitFrontierYears = (
    event: DiagnosisEvent,
): number[] => event.evidence.notes.flatMap((note) => {
    const match = note.match(
        /^(?:scan_top|unit_local_(?:raw31|difference31|whitened31|multiScale|pairMean31|pairMedian31|pairTrimmed31|pairWeighted31|bestReference31|pairedCore31))_year=(-?\d+)$/,
    );
    return match ? [Number(match[1])] : [];
});

const validatedNewerMissingFrontier = (
    partial: DiagnosisEvent,
    hypotheses: readonly DiagnosisEvent[],
): { event: DiagnosisEvent; year: number; supportCount: number } | null => {
    const partialTransitionCount = noteNumber(
        partial,
        "stable_bounded_path_transition_count=",
    ) ?? 0;
    if (partial.eventType !== "partialMove"
        || partial.shiftSide !== "older"
        || (partial.shiftYears ?? 0) >= -1
        || partial.evidence.lagAfter !== 0
        || partialTransitionCount < 2
        || !partial.evidence.notes.includes(
            "stable_bounded_path_all_transitions_partial=false",
        )) return null;

    return hypotheses.flatMap((candidate) => {
        if (candidate.eventType !== "missingRing"
            || candidate.evidence.lagBefore !== -1
            || candidate.evidence.lagAfter !== 0) return [];
        const year = rankedYear(candidate);
        const nominalYear = noteNumber(candidate, "nominal_boundary_year=");
        const profileYear = noteNumber(candidate, "profile_boundary_year=");
        const sources = new Set(candidate.evidence.algorithmSources);
        const supportCount = independentlySupportedUnitFrontierYears(candidate)
            .filter((supportYear) => Math.abs(supportYear - (year ?? supportYear)) <= 2)
            .length;
        const independentlyLocalized = year !== null
            && year > partial.endYear + 2
            && year + 1 <= (partial.seriesRange?.endYear ?? Number.POSITIVE_INFINITY)
            && nominalYear === year
            && profileYear === year
            && sources.has("collapsed_missing_staircase_head")
            && sources.has("piecewise_lag_path")
            && sources.has("counterfactual_window_refinement")
            && sources.has("local_counterfactual_raw_year")
            && candidate.evidence.scoreMargin >= 0.1
            && (candidate.evidence.correlationGain ?? Number.NEGATIVE_INFINITY) >= 0.05
            && candidate.evidence.samplePairs >= 30
            && supportCount >= 6;
        return independentlyLocalized ? [{ event: candidate, year, supportCount }] : [];
    }).sort((left, right) => (
        right.year - left.year
        || right.supportCount - left.supportCount
        || right.event.evidence.scoreMargin - left.event.evidence.scoreMargin
    ))[0] ?? null;
};

/**
 * Keeps a selected cumulative partial operation, but locates it at a newer independently
 * verified unit frontier. The partial Top1 remains firstFixedYear; its missing interpretation
 * therefore points to the preceding calendar year without an ad-hoc +/-1 conversion.
 */
export const projectCumulativePartialToValidatedUnitFrontier = (
    partial: DiagnosisEvent,
    hypotheses: readonly DiagnosisEvent[],
    targetRange: { startYear: number; endYear: number },
    hasIndependentWholeBaseline = false,
): DiagnosisEvent => {
    if (hasIndependentWholeBaseline) return partial;
    const frontier = validatedNewerMissingFrontier(partial, hypotheses);
    if (!frontier) return partial;

    const missingYear = frontier.year;
    const firstFixedYear = missingYear + 1;
    const currentWidth = partial.endYear - partial.startYear + 1;
    const width = ALLOWED_LOCAL_WINDOW_WIDTHS.includes(
        currentWidth as (typeof ALLOWED_LOCAL_WINDOW_WIDTHS)[number],
    ) ? currentWidth : 13;
    const window = clampWindowToRange(
        missingYear - Math.floor((width - 1) / 2),
        width,
        targetRange,
    );
    if (firstFixedYear < window.startYear || firstFixedYear > window.endYear) return partial;

    const prior = new Map(partial.rankedYears.map((row) => [row.year, row]));
    const maximumScore = Math.max(0, ...partial.rankedYears.map(({ score }) => score));
    const minimumScore = Math.min(0, ...partial.rankedYears.map(({ score }) => score));
    const rankedYears = Array.from(
        { length: width },
        (_, index) => window.startYear + index,
    ).map((year) => ({
        year,
        rank: 0,
        score: year === firstFixedYear
            ? maximumScore + Math.max(1e-9, Math.abs(maximumScore) * 1e-12)
            : prior.get(year)?.score ?? minimumScore - 1,
        evidenceTags: Array.from(new Set([
            ...(prior.get(year)?.evidenceTags ?? []),
            "validated_newer_unit_frontier_location",
        ])).sort(),
    })).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    const referenceCount = Math.max(
        0,
        ...locationEvidenceFor(frontier.event).map((entry) => entry.referenceCount),
    );

    return withEvidenceLedger({
        ...partial,
        id: `${partial.id}-validated-unit-frontier-${missingYear}`,
        ...window,
        rankedYears,
        reviewCoreRange: undefined,
        evidence: {
            ...partial.evidence,
            algorithmSources: Array.from(new Set([
                ...partial.evidence.algorithmSources,
                "validated_newer_unit_frontier_location",
            ])).sort(),
            locationEvidence: [
                ...(partial.evidence.locationEvidence ?? []),
                {
                    source: "validated_newer_unit_frontier_location",
                    ...window,
                    topYear: firstFixedYear,
                    referenceCount,
                    concentration: Math.min(1, frontier.supportCount / 10),
                    remoteMargin: frontier.event.evidence.scoreMargin,
                    calibrated: true,
                },
            ],
            notes: Array.from(new Set([
                ...partial.evidence.notes,
                `validated_unit_frontier_previous_window=${
                    partial.startYear
                }-${partial.endYear}`,
                `validated_unit_frontier_missing_year=${missingYear}`,
                `validated_unit_frontier_first_fixed_year=${firstFixedYear}`,
                `validated_unit_frontier_support_count=${frontier.supportCount}`,
                `validated_unit_frontier_window=${window.startYear}-${window.endYear}`,
            ])),
        },
    });
};

const hasCurrentLocationAuthority = (event: DiagnosisEvent): boolean => {
    if (locationEvidenceFor(event).some((entry) => (
        entry.startYear === event.startYear && entry.endYear === event.endYear
    ))) return true;
    if (locationEvidenceFor(event).some((entry) => (
        entry.source === "independent_unit_location_consensus"
        && entry.topYear !== null
        && entry.startYear >= event.startYear
        && entry.endYear <= event.endYear
        && entry.topYear >= event.startYear
        && entry.topYear <= event.endYear
    ))) return true;
    if (event.evidence.algorithmSources.includes("stable_partial_rank_edge_guard")
        || (
            event.evidence.algorithmSources.includes("stable_unit_local_consensus")
            && (noteNumber(event, "stable_unit_local_consensus_votes=") ?? 0) >= 3
        )
        || event.evidence.algorithmSources.includes(
            "compressed_missing_staircase_projection",
        )
        || event.evidence.algorithmSources.includes(
            "stable_terminal_unit_staircase_frontier",
        )
        || event.evidence.algorithmSources.includes(
            "sequential_false_staircase_head",
        )
        || (
            event.evidence.algorithmSources.includes(
                "stable_multiscale_bounded_path_frontier",
            )
            && event.evidence.notes.some((note) => (
                note.startsWith("stable_bounded_path_operation_year=")
            ))
        )) return true;
    return (noteNumber(event, "bounded_operation_location_remote_margin=") ?? 0) >= 0.04;
};

/** Restores the strongest source window when a downstream rewrite has no matching evidence. */
export const projectUnsupportedLocationToStrongBoundedPath = (
    event: DiagnosisEvent,
): DiagnosisEvent => {
    const path = strongBoundedPathLocation(event);
    if (!path || path.topYear === null || hasCurrentLocationAuthority(event)) return event;
    if (Math.abs(path.startYear - event.startYear) < 2
        && Math.abs(path.endYear - event.endYear) < 2) return event;
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const maximumScore = Math.max(0, ...event.rankedYears.map(({ score }) => score));
    const minimumScore = Math.min(0, ...event.rankedYears.map(({ score }) => score));
    const rankedYears = Array.from(
        { length: path.endYear - path.startYear + 1 },
        (_, index) => path.startYear + index,
    ).map((year) => {
        const existing = prior.get(year);
        return {
            year,
            rank: 0,
            score: year === path.topYear
                ? maximumScore + Math.max(1e-9, Math.abs(maximumScore) * 1e-12)
                : existing?.score ?? minimumScore - 1,
            evidenceTags: Array.from(new Set([
                ...(existing?.evidenceTags ?? []),
                "strong_bounded_path_location_projection",
            ])).sort(),
        };
    }).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    return withEvidenceLedger({
        ...event,
        id: `${event.id}-strong-bounded-location-${path.topYear}`,
        startYear: path.startYear,
        endYear: path.endYear,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "strong_bounded_path_location_projection",
            ])).sort(),
            notes: Array.from(new Set([
                ...event.evidence.notes,
                `strong_bounded_path_previous_window=${event.startYear}-${event.endYear}`,
                `strong_bounded_path_projected_window=${path.startYear}-${path.endYear}`,
            ])),
        },
    });
};

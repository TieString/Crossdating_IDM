/**
 * Single immutable event-hypothesis adjudicator. Evidence extractors submit complete events;
 * this module selects one operation x shift x location hypothesis without rebuilding fields.
 */
import {
    evidenceClaimsFor,
    locationEvidenceFor,
    withEvidenceLedger,
} from "./evidenceLedger";
import {
    attachEndpointWholeMissingInterpretation,
    makeEndpointMissingReviewFromWhole,
} from "./endpointWholeMissingInterpretation";
import {
    projectUnsupportedLocationToStrongBoundedPath,
    preservesStrongBoundedPathMode,
    strongBoundedPathLocation,
} from "./locationAuthority";
import { addStablePartialRankEdgeGuard } from "./stablePartialLocationConsensus";
import { synchronizePreservedMissingPartialWindow } from "./missingPartialInterpretation";
import {
    isAllowedAutomaticDiagnosisEvent,
    wholeSeriesMoveShiftYears,
} from "./wholeSeriesMoveSemantics";
import type {
    DiagnosisEvidenceClaim,
    DiagnosisEvent,
    DiagnosisJointEventDecision,
    DiagnosisJointHypothesisSummary,
    DiagnosisJointProductionAgreement,
    DiagnosisReviewEventCheckpoint,
    DiagnosisReviewSourceStage,
} from "./types";

type HypothesisCluster = {
    checkpoints: DiagnosisReviewEventCheckpoint[];
};

type OperationGroup = {
    clusters: HypothesisCluster[];
};

export type JointEventAdjudicationConfig = {
    minimumOperationMargin: number;
    minimumRemoteModeMargin: number;
    remoteModeDistanceYears: number;
};

export const DEFAULT_JOINT_EVENT_ADJUDICATION_CONFIG: JointEventAdjudicationConfig = {
    minimumOperationMargin: 0.04,
    minimumRemoteModeMargin: 0.04,
    remoteModeDistanceYears: 13,
};

const stagePriority: Record<DiagnosisReviewSourceStage, number> = {
    candidate: 1,
    detected: 2,
    fused: 3,
    retained: 4,
    displayed: 5,
    final: 6,
};

const topYear = (event: DiagnosisEvent): number | null => (
    [...event.rankedYears].sort((left, right) => (
        left.rank - right.rank || right.score - left.score || right.year - left.year
    ))[0]?.year ?? null
);

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

const noteRange = (
    event: DiagnosisEvent,
    prefix: string,
): { startYear: number; endYear: number } | null => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const match = note?.slice(prefix.length).match(/^(-?\d+)-(-?\d+)$/);
    if (!match) return null;
    const startYear = Number(match[1]);
    const endYear = Number(match[2]);
    return Number.isInteger(startYear) && Number.isInteger(endYear)
        ? { startYear, endYear }
        : null;
};

const sameOperation = (left: DiagnosisEvent, right: DiagnosisEvent): boolean => (
    left.eventType === right.eventType
    && (
        left.eventType === "missingRing"
        || left.eventType === "falseRing"
        || (left.shiftYears ?? null) === (right.shiftYears ?? null)
    )
);

const windowsOverlap = (left: DiagnosisEvent, right: DiagnosisEvent): boolean => (
    Math.max(left.startYear, right.startYear)
        <= Math.min(left.endYear, right.endYear)
);

const windowsTouchOrOverlap = (left: DiagnosisEvent, right: DiagnosisEvent): boolean => (
    Math.max(left.startYear, right.startYear)
        <= Math.min(left.endYear, right.endYear) + 1
);

const MAXIMUM_TERMINAL_LOCATION_SUPPORT_TOP_DRIFT = 8;

const sameTerminalLocationMode = (
    left: DiagnosisEvent,
    right: DiagnosisEvent,
): boolean => {
    const leftTop = topYear(left);
    const rightTop = topYear(right);
    return windowsTouchOrOverlap(left, right)
        && leftTop !== null
        && rightTop !== null
        && Math.abs(leftTop - rightTop)
            <= MAXIMUM_TERMINAL_LOCATION_SUPPORT_TOP_DRIFT;
};

const sameLocationMode = (left: DiagnosisEvent, right: DiagnosisEvent): boolean => {
    if (left.eventType === "wholeSeriesMove"
        || right.eventType === "wholeSeriesMove") {
        return left.eventType === right.eventType;
    }
    if (windowsOverlap(left, right)) return true;
    const leftTop = topYear(left);
    const rightTop = topYear(right);
    return leftTop !== null && rightTop !== null
        && Math.abs(leftTop - rightTop) <= 4;
};

const confidenceScore = (event: DiagnosisEvent): number => (
    event.confidenceLevel === "high" ? 1 : event.confidenceLevel === "medium" ? 0.6 : 0.2
);

const matchingLocationEvidence = (event: DiagnosisEvent) => locationEvidenceFor(event)
    .filter((entry) => (
        entry.startYear === event.startYear && entry.endYear === event.endYear
    ));

const boundedQuality = (value: number | null, scale: number): number => (
    value === null || !Number.isFinite(value)
        ? 0
        : Math.max(0, Math.min(1, value / scale))
);

const locationEntryQuality = (
    entry: ReturnType<typeof locationEvidenceFor>[number],
): number => (
    0.35 * boundedQuality(entry.concentration, 0.7)
    + 0.3 * boundedQuality(entry.remoteMargin, 0.1)
    + 0.25 * boundedQuality(entry.referenceCount, 8)
    + (entry.calibrated ? 0.1 : 0)
);

const eventLocationQuality = (event: DiagnosisEvent): number => {
    const entries = matchingLocationEvidence(event);
    if (entries.length === 0) return 0;
    return Math.max(...entries.map(locationEntryQuality));
};

const isCandidateAnchoredDistantMissingEvent = (
    event: DiagnosisEvent,
): boolean => {
    const eventTop = topYear(event);
    const predecessorYear = noteYear(event, "distant_sequential_predecessor_year=");
    const wholeAdvantage = noteNumber(
        event,
        "distant_candidate_whole_correlation_advantage=",
    );
    return event.eventType === "missingRing"
        && event.evidence.lagBefore === -1
        && event.evidence.lagAfter === 0
        && eventTop !== null
        && predecessorYear !== null
        && eventTop - predecessorYear >= 14
        && wholeAdvantage !== null
        && wholeAdvantage >= 0.01
        && event.evidence.algorithmSources.includes(
            "candidate_anchored_distant_missing_frontier",
        )
        && event.evidence.algorithmSources.includes("candidate_ranking")
        && event.evidence.algorithmSources.includes("local_edit_alignment")
        && event.evidence.algorithmSources.includes(
            "cumulative_sequential_missing_staircase",
        );
};

const eventHasIndependentLocationAuthority = (event: DiagnosisEvent): boolean => {
    const claims = evidenceClaimsFor(event);
    const multiEventYears = event.evidence.notes.find((note) => (
        note.startsWith("multi_frontier_evidence_years=")
    ))?.split("=")[1]?.split(",").filter(Boolean) ?? [];
    if (claims.has("independent_reference_staircase")
        || claims.has("fixed_side_resolution")
        || claims.has("endpoint_unit_resolution")
        || (
            event.evidence.algorithmSources.includes(
                "stable_unit_local_consensus",
            )
            && (noteNumber(event, "stable_unit_local_consensus_votes=") ?? 0) >= 3
        )
        || event.evidence.algorithmSources.includes(
            "sequential_missing_checkpoint_location",
        )
        || isCandidateAnchoredDistantMissingEvent(event)
        || (
            event.evidence.algorithmSources.includes(
                "multi_event_frontier_location_consensus",
            )
            && new Set(multiEventYears).size >= 2
        )
        || (
            claims.has("continuous_gap_consensus")
            && event.evidence.algorithmSources.includes(
                "negative_partial_multiview_consensus",
            )
        )) {
        return true;
    }
    return matchingLocationEvidence(event).some((entry) => (
        entry.calibrated
        || (
            entry.referenceCount >= 3
            && (entry.concentration ?? 0) >= 0.2
            && (entry.remoteMargin ?? 0) >= 0.04
        )
    ));
};

const acceptedStrongLocatorEvidence = (
    event: DiagnosisEvent,
): ReturnType<typeof matchingLocationEvidence>[number] | null => {
    if (!event.evidence.notes.includes(
        "locator_adjudication=accepted_overlapping_strong_mode",
    )) return null;
    const proposedWindow = noteRange(event, "locator_proposed_window=");
    if (proposedWindow?.startYear !== event.startYear
        || proposedWindow.endYear !== event.endYear) return null;
    return matchingLocationEvidence(event).find((entry) => (
        entry.source === "full_interval_counterfactual_locator"
        && entry.referenceCount >= 3
        && (
            entry.calibrated
            || (
                (entry.concentration ?? 0) >= 0.2
                && (entry.remoteMargin ?? 0) >= 0.04
            )
        )
    )) ?? null;
};

const claimWeight: Record<DiagnosisEvidenceClaim, number> = {
    explicit_missing_staircase: 1,
    whole_baseline_exhausted_by_missing_staircase: 1,
    independent_reference_staircase: 0.9,
    fixed_side_resolution: 1,
    endpoint_unit_resolution: 1,
    joint_operation: 0.8,
    continuous_gap_consensus: 0.9,
    whole_global_lag: 0.6,
    whole_terminal_baseline: 0.9,
    whole_path_fixed_baseline: 0.9,
    bounded_lag_state_path: 1.2,
};

const claimStrength = (events: readonly DiagnosisEvent[]): number => Math.max(
    0,
    ...events.flatMap((event) => [...evidenceClaimsFor(event)].map((claim) => (
        claimWeight[claim]
    ))),
);

const samePersistedLocation = (left: DiagnosisEvent, right: DiagnosisEvent): boolean => {
    if (!sameOperation(left, right)) return false;
    if (left.eventType === "wholeSeriesMove") return true;
    const leftTop = topYear(left);
    const rightTop = topYear(right);
    return windowsOverlap(left, right)
        && leftTop !== null
        && rightTop !== null
        && Math.abs(leftTop - rightTop) <= 2;
};

const persistedStageCount = (
    cluster: HypothesisCluster,
    checkpoint: DiagnosisReviewEventCheckpoint,
): number => new Set(cluster.checkpoints.filter((candidate) => (
    samePersistedLocation(checkpoint.event, candidate.event)
)).map(({ stage }) => stage)).size;

const representativeQuality = (
    cluster: HypothesisCluster,
    checkpoint: DiagnosisReviewEventCheckpoint,
): number => (
    stagePriority[checkpoint.stage] / 6 * 0.4
    + persistedStageCount(cluster, checkpoint) / 6 * 0.3
    + confidenceScore(checkpoint.event) * 0.1
    + eventLocationQuality(checkpoint.event) * 0.2
);

const eventWidth = (event: DiagnosisEvent): number => (
    event.endYear - event.startYear + 1
);

const preferredSequentialSupport = (
    cluster: HypothesisCluster,
    selected: DiagnosisReviewEventCheckpoint,
): DiagnosisReviewEventCheckpoint | null => {
    const event = selected.event;
    if (selected.stage !== "final"
        || (event.eventType !== "missingRing" && event.eventType !== "falseRing")
        || eventWidth(event) !== 5
        || !event.evidence.algorithmSources.includes("sequential_missing_staircase_head")
        || eventHasIndependentLocationAuthority(event)) return null;
    return cluster.checkpoints.filter((checkpoint) => {
        const support = checkpoint.event;
        const width = eventWidth(support);
        const supportTop = topYear(support);
        const selectedTop = topYear(event);
        return stagePriority[checkpoint.stage] >= stagePriority.detected
            && checkpoint.stage !== "final"
            && sameOperation(support, event)
            && width > 5
            && width <= 9
            && support.startYear <= event.startYear
            && support.endYear >= event.endYear
            && supportTop !== null
            && selectedTop !== null
            && Math.abs(supportTop - selectedTop) <= 2;
    }).sort((left, right) => (
        eventWidth(left.event) - eventWidth(right.event)
        || stagePriority[right.stage] - stagePriority[left.stage]
    ))[0] ?? null;
};

const preferredEndpointCandidate = (
    cluster: HypothesisCluster,
    selected: DiagnosisReviewEventCheckpoint,
): DiagnosisReviewEventCheckpoint | null => {
    const event = selected.event;
    if (selected.stage !== "final"
        || event.eventType !== "missingRing"
        || !event.evidence.algorithmSources.includes(
            "newer_endpoint_unit_alias_of_global_lag",
        )) return null;
    return cluster.checkpoints.filter((checkpoint) => {
        const candidate = checkpoint.event;
        const candidateTop = topYear(candidate);
        const selectedTop = topYear(event);
        return checkpoint.stage === "candidate"
            && candidate.eventType === "missingRing"
            && candidate.evidence.notes.includes("candidate_hard_gate_passed")
            && candidate.evidence.algorithmSources.includes("candidate_ranking")
            && candidate.endYear > event.endYear
            && windowsOverlap(candidate, event)
            && candidateTop !== null
            && selectedTop !== null
            && candidateTop > selectedTop
            && candidateTop - selectedTop <= 4;
    }).sort((left, right) => (
        (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
        || right.event.endYear - left.event.endYear
    ))[0] ?? null;
};

const preferredAcceptedFinalLocation = (
    cluster: HypothesisCluster,
): DiagnosisReviewEventCheckpoint | null => cluster.checkpoints
    .filter((checkpoint) => {
        const event = checkpoint.event;
        const location = matchingLocationEvidence(event).find((entry) => (
            entry.source === "full_interval_counterfactual_locator"
        ));
        return checkpoint.stage === "final"
            && checkpoint.authority !== "supplemental"
            && event.eventType !== "wholeSeriesMove"
            && event.evidence.algorithmSources.includes(
                "full_interval_counterfactual_locator",
            )
            && event.evidence.notes.some((note) => (
                note === "locator_adjudication=accepted_overlapping_mode"
                || note === "locator_adjudication=accepted_overlapping_strong_mode"
            ))
            && (
                acceptedStrongLocatorEvidence(event) !== null
                || (
                    location?.calibrated === true
                    && (
                        (location.remoteMargin ?? 0) >= 0.04
                        || (
                            event.evidence.candidateIds.length > 0
                            && event.evidence.algorithmSources.includes(
                                "candidate_ranking",
                            )
                            && event.evidence.algorithmSources.includes(
                                "local_edit_alignment",
                            )
                        )
                    )
                )
            );
    })
    .sort((left, right) => (
        eventLocationQuality(right.event) - eventLocationQuality(left.event)
        || (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
    ))[0] ?? null;

const hasAcceptedStrongSelectedLocator = (
    cluster: HypothesisCluster,
): boolean => cluster.checkpoints.some((checkpoint) => {
    const event = checkpoint.event;
    if (checkpoint.stage !== "final"
        || checkpoint.authority === "supplemental"
        || event.eventType === "wholeSeriesMove"
        || !event.evidence.algorithmSources.includes(
            "full_interval_counterfactual_locator",
        )
        || !event.evidence.notes.some((note) => (
            note === "locator_adjudication=accepted_overlapping_mode"
            || note === "locator_adjudication=accepted_overlapping_strong_mode"
        ))) return false;
    if (acceptedStrongLocatorEvidence(event)) return true;
    return matchingLocationEvidence(event).some((entry) => (
        entry.source === "full_interval_counterfactual_locator"
        && entry.referenceCount >= 3
        && (entry.concentration ?? 0) >= 0.2
        && (entry.remoteMargin ?? 0) >= 0.04
    ));
});

const isValidatedSelectedSequentialFalseCheckpoint = (
    checkpoint: DiagnosisReviewEventCheckpoint,
): boolean => {
    const event = checkpoint.event;
    const pathStartLag = noteNumber(event, "sequential_false_path_start_lag=");
    const transitionCount = noteNumber(event, "sequential_false_transition_count=");
    const candidateDepth = noteNumber(event, "sequential_false_candidate_depth=");
    return checkpoint.stage === "final"
        && checkpoint.authority !== "supplemental"
        && event.eventType === "falseRing"
        && event.evidence.algorithmSources.includes(
            "candidate_anchored_positive_staircase",
        )
        && event.evidence.algorithmSources.includes(
            "positive_unit_staircase_direction",
        )
        && pathStartLag !== null
        && pathStartLag >= 2
        && transitionCount === pathStartLag
        && candidateDepth === pathStartLag
        && (noteNumber(event, "sequential_false_gain_over_direct=") ?? 0) > 0
        && (noteNumber(event, "sequential_false_direction_master_margin=") ?? 0) > 0;
};

const isValidatedSelectedTerminalUnitStaircaseCheckpoint = (
    checkpoint: DiagnosisReviewEventCheckpoint,
): boolean => {
    const event = checkpoint.event;
    const depth = noteNumber(event, "terminal_unit_staircase_depth=");
    const aggregateShift = noteNumber(event, "terminal_unit_staircase_aggregate_shift=");
    return checkpoint.stage === "final"
        && checkpoint.authority !== "supplemental"
        && (event.eventType === "falseRing" || event.eventType === "missingRing")
        && event.evidence.algorithmSources.includes(
            "stable_terminal_unit_staircase_frontier",
        )
        && event.evidence.algorithmSources.includes(
            event.eventType === "falseRing"
                ? "candidate_anchored_positive_staircase"
                : "candidate_anchored_negative_staircase",
        )
        && depth !== null
        && depth >= 2
        && aggregateShift === (event.eventType === "falseRing" ? depth : -depth)
        && (noteNumber(event, "terminal_unit_staircase_stronger_gain=") ?? 0) > 0
        && (noteNumber(event, "terminal_unit_staircase_weaker_gain=") ?? 0) > 0
        && (noteNumber(event, "terminal_unit_staircase_maximum_year_drift=") ?? Infinity) <= 2;
};

const isValidatedSelectedCandidateAnchoredDistantMissingCheckpoint = (
    checkpoint: DiagnosisReviewEventCheckpoint,
): boolean => checkpoint.stage === "final"
    && checkpoint.authority !== "supplemental"
    && isCandidateAnchoredDistantMissingEvent(checkpoint.event);

const isValidatedSelectedSequentialUnit = (
    checkpoint: DiagnosisReviewEventCheckpoint,
): boolean => isValidatedSelectedSequentialFalseCheckpoint(checkpoint)
    || isValidatedSelectedTerminalUnitStaircaseCheckpoint(checkpoint)
    || isValidatedSelectedCandidateAnchoredDistantMissingCheckpoint(checkpoint);

const preferredStrongBoundedLocation = (
    cluster: HypothesisCluster,
): DiagnosisReviewEventCheckpoint | null => {
    if (cluster.checkpoints.some(isValidatedSelectedSequentialUnit)) return null;
    const selectedFinals = cluster.checkpoints.filter((checkpoint) => (
        checkpoint.stage === "final" && checkpoint.authority !== "supplemental"
    ));
    const selectedQuality = Math.max(
        0,
        ...selectedFinals.map(({ event }) => eventLocationQuality(event)),
    );
    const boundedLocationQuality = (
        checkpoint: DiagnosisReviewEventCheckpoint,
    ): number => Math.max(0, ...locationEvidenceFor(checkpoint.event).filter((entry) => {
        const eventTop = topYear(checkpoint.event);
        return entry.source === "bounded_complete_lag_path"
            && Math.max(entry.startYear, checkpoint.event.startYear)
                <= Math.min(entry.endYear, checkpoint.event.endYear)
            && eventTop !== null
            && entry.topYear !== null
            && Math.abs(entry.topYear - eventTop) <= 2
            && entry.referenceCount >= 3
            && (entry.concentration ?? 0) >= 0.2
            && (entry.remoteMargin ?? 0) >= 0.04;
    }).map(locationEntryQuality));
    const strongest = cluster.checkpoints.filter((checkpoint) => {
        const event = checkpoint.event;
        return checkpoint.stage === "final"
            && checkpoint.authority === "supplemental"
            && evidenceClaimsFor(event).has("bounded_lag_state_path")
            && boundedLocationQuality(checkpoint) > 0;
    }).sort((left, right) => (
        boundedLocationQuality(right) - boundedLocationQuality(left)
        || (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
    ))[0] ?? null;
    if (!strongest) return null;
    return boundedLocationQuality(strongest) >= selectedQuality + 0.15
        ? strongest
        : null;
};

const preferredStrongSelectedBoundedLocation = (
    cluster: HypothesisCluster,
): DiagnosisReviewEventCheckpoint | null => cluster.checkpoints
    .filter((checkpoint) => (
        checkpoint.stage === "final"
        && checkpoint.authority !== "supplemental"
        && strongBoundedPathLocation(checkpoint.event) !== null
    ))
    .sort((left, right) => (
        eventLocationQuality(right.event) - eventLocationQuality(left.event)
        || (strongBoundedPathLocation(right.event)?.concentration ?? 0)
            - (strongBoundedPathLocation(left.event)?.concentration ?? 0)
        || (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
    ))[0] ?? null;

const isSelectedCompletedCompositionCheckpoint = (
    checkpoint: DiagnosisReviewEventCheckpoint,
): boolean => checkpoint.stage === "final"
    && checkpoint.authority !== "supplemental"
    && (
        checkpoint.event.eventType === "partialMove"
        || checkpoint.event.evidence.algorithmSources.includes(
            "exhaustive_completed_partial_unit_adjudication",
        )
    )
    && checkpoint.event.evidence.notes.includes(
        "completed_mixed_frontier_is_newest_event",
    )
    && checkpoint.event.evidence.algorithmSources.some((source) => (
        source === "completed_partial_missing_composition"
        || source === "completed_partial_false_composition"
    ));

const preferredSelectedCompletedComposition = (
    cluster: HypothesisCluster,
): DiagnosisReviewEventCheckpoint | null => cluster.checkpoints
    .filter(isSelectedCompletedCompositionCheckpoint)
    .sort((left, right) => (
        eventLocationQuality(right.event) - eventLocationQuality(left.event)
        || (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
    ))[0] ?? null;

const preferredValidatedFinalSequentialUnit = (
    cluster: HypothesisCluster,
): DiagnosisReviewEventCheckpoint | null => {
    const selected = cluster.checkpoints.filter(isValidatedSelectedSequentialUnit)
        .sort((left, right) => (
        representativeQuality(cluster, right) - representativeQuality(cluster, left)
        || eventLocationQuality(right.event) - eventLocationQuality(left.event)
        || (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
        ))[0] ?? null;
    if (!selected || !isValidatedSelectedTerminalUnitStaircaseCheckpoint(selected)) {
        return selected;
    }
    const location = cluster.checkpoints.filter((checkpoint) => (
        checkpoint !== selected
        && !isValidatedSelectedSequentialUnit(checkpoint)
        && sameOperation(checkpoint.event, selected.event)
        && windowsOverlap(checkpoint.event, selected.event)
        && eventHasIndependentLocationAuthority(checkpoint.event)
    )).sort((left, right) => (
        eventLocationQuality(right.event) - eventLocationQuality(left.event)
        || representativeQuality(cluster, right) - representativeQuality(cluster, left)
        || stagePriority[right.stage] - stagePriority[left.stage]
    ))[0] ?? null;
    if (!location) return selected;
    if (!preservesStrongBoundedPathMode(
        selected.event,
        location.event.startYear,
        location.event.endYear,
    )) {
        return {
            ...selected,
            event: withEvidenceLedger({
                ...selected.event,
                evidence: {
                    ...selected.event.evidence,
                    notes: Array.from(new Set([
                        ...selected.event.evidence.notes,
                        "terminal_unit_location_rejected=detached_from_strong_bounded_path",
                        `terminal_unit_location_rejected_window=${
                            location.event.startYear
                        }-${location.event.endYear}`,
                    ])),
                },
            }),
        };
    }
    return {
        ...selected,
        event: withEvidenceLedger({
            ...selected.event,
            id: `${selected.event.id}-independent-location-${
                topYear(location.event) ?? "window"
            }`,
            startYear: location.event.startYear,
            endYear: location.event.endYear,
            rankedYears: location.event.rankedYears.map((row) => ({ ...row })),
            reviewCoreRange: location.event.reviewCoreRange,
            evidence: {
                ...selected.event.evidence,
                algorithmSources: Array.from(new Set([
                    ...selected.event.evidence.algorithmSources,
                    ...location.event.evidence.algorithmSources,
                    "terminal_unit_independent_location_projection",
                ])).sort(),
                candidateIds: Array.from(new Set([
                    ...selected.event.evidence.candidateIds,
                    ...location.event.evidence.candidateIds,
                ])),
                locationEvidence: [
                    ...(selected.event.evidence.locationEvidence ?? []),
                    ...(location.event.evidence.locationEvidence ?? []),
                ],
                notes: Array.from(new Set([
                    ...selected.event.evidence.notes,
                    ...location.event.evidence.notes,
                    `terminal_unit_location_previous_top_year=${
                        topYear(selected.event) ?? "none"
                    }`,
                    `terminal_unit_location_projected_top_year=${
                        topYear(location.event) ?? "none"
                    }`,
                ])),
            },
        }),
    };
};

type TerminalLocationSupport = {
    checkpoint: DiagnosisReviewEventCheckpoint;
    kind: "exact_unit_frontier" | "workflow_equivalent_partial";
};

const exactTerminalUnitCandidate = (
    checkpoint: DiagnosisReviewEventCheckpoint,
    terminal: DiagnosisEvent,
    aggregateShiftYears: number,
): boolean => {
    const event = checkpoint.event;
    const direction = Math.sign(aggregateShiftYears);
    const eventTop = topYear(event);
    const terminalTop = topYear(terminal);
    return checkpoint.stage === "candidate"
        && checkpoint.authority !== "supplemental"
        && sameOperation(event, terminal)
        && sameTerminalLocationMode(event, terminal)
        && event.evidence.notes.includes("candidate_hard_gate_passed")
        && event.evidence.algorithmSources.includes("candidate_ranking")
        && event.evidence.lagBefore === aggregateShiftYears
        && event.evidence.lagAfter === aggregateShiftYears - direction
        && (event.evidence.correlationGain ?? 0) > 0
        && (
            event.evidence.scoreMargin >= 0.25
            || (
                eventTop !== null
                && terminalTop !== null
                && eventTop < terminalTop
            )
        );
};

const workflowEquivalentTerminalPartial = (
    checkpoint: DiagnosisReviewEventCheckpoint,
    terminal: DiagnosisEvent,
    aggregateShiftYears: number,
): boolean => {
    const event = checkpoint.event;
    return terminal.eventType === "missingRing"
        && aggregateShiftYears < -1
        && stagePriority[checkpoint.stage] >= stagePriority.displayed
        && checkpoint.authority !== "supplemental"
        && event.eventType === "partialMove"
        && event.shiftSide === "older"
        && event.shiftYears === aggregateShiftYears
        && event.evidence.lagBefore === aggregateShiftYears
        && event.evidence.lagAfter === 0
        && event.confidenceLevel === "high"
        && sameTerminalLocationMode(event, terminal)
        && event.evidence.algorithmSources.includes(
            "decisive_joint_operation_fusion",
        )
        && event.evidence.algorithmSources.includes(
            "full_interval_counterfactual_scan",
        )
        && event.evidence.algorithmSources.includes(
            "joint_year_operation_evidence",
        )
        && (event.evidence.correlationGain ?? 0) >= 0.2
        && event.evidence.scoreMargin >= 0.2;
};

/**
 * The terminal path owns the unit operation and cumulative direction, but its final run boundary
 * is only a coarse locator. A hard-gated candidate for that exact terminal transition, or an
 * independently scored equivalent partial-gap hypothesis, may contribute location only.
 */
const projectTerminalUnitCompatibleLocation = (
    terminal: DiagnosisEvent,
    checkpoints: readonly DiagnosisReviewEventCheckpoint[],
): DiagnosisEvent => {
    if (!terminal.evidence.algorithmSources.includes(
        "stable_terminal_unit_staircase_frontier",
    ) || terminal.evidence.algorithmSources.includes(
        "terminal_unit_independent_location_projection",
    )) return terminal;
    const aggregateShiftYears = noteNumber(
        terminal,
        "terminal_unit_staircase_aggregate_shift=",
    );
    if (aggregateShiftYears === null || Math.abs(aggregateShiftYears) < 2) return terminal;

    const exact = checkpoints.filter((checkpoint) => exactTerminalUnitCandidate(
        checkpoint,
        terminal,
        aggregateShiftYears,
    )).sort((left, right) => (
        right.event.evidence.score - left.event.evidence.score
        || (right.event.evidence.correlationGain ?? 0)
            - (left.event.evidence.correlationGain ?? 0)
        || right.event.evidence.scoreMargin - left.event.evidence.scoreMargin
        || (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
    ))[0];
    const partial = checkpoints.filter((checkpoint) => workflowEquivalentTerminalPartial(
        checkpoint,
        terminal,
        aggregateShiftYears,
    )).sort((left, right) => (
        right.event.evidence.scoreMargin - left.event.evidence.scoreMargin
        || (right.event.evidence.correlationGain ?? 0)
            - (left.event.evidence.correlationGain ?? 0)
        || stagePriority[right.stage] - stagePriority[left.stage]
    ))[0];
    const support: TerminalLocationSupport | null = exact
        ? { checkpoint: exact, kind: "exact_unit_frontier" }
        : partial
            ? { checkpoint: partial, kind: "workflow_equivalent_partial" }
            : null;
    if (!support) return terminal;

    const location = support.checkpoint.event;
    const weakInteriorCandidate = support.kind === "exact_unit_frontier"
        && eventWidth(terminal) === 13
        && location.startYear >= terminal.startYear
        && location.endYear <= terminal.endYear
        && location.evidence.scoreMargin < 0.25;
    if (weakInteriorCandidate) return terminal;
    const terminalBoundaryYear = noteNumber(
        terminal,
        "terminal_unit_staircase_boundary_year=",
    );
    let projectedStartYear = location.startYear;
    let projectedEndYear = location.endYear;
    let projectedRankedYears = location.rankedYears.map((row) => ({ ...row }));
    if (terminalBoundaryYear !== null
        && (terminalBoundaryYear < location.startYear
            || terminalBoundaryYear > location.endYear)) {
        const minimumYear = Math.min(location.startYear, terminalBoundaryYear);
        const maximumYear = Math.max(location.endYear, terminalBoundaryYear);
        const requiredSpan = maximumYear - minimumYear + 1;
        const width = [5, 7, 9, 13].find((value) => value >= requiredSpan);
        if (width === undefined) return terminal;
        projectedStartYear = minimumYear;
        projectedStartYear = Math.max(
            projectedStartYear,
            maximumYear - width + 1,
        );
        if (terminal.seriesRange) {
            projectedStartYear = Math.max(
                terminal.seriesRange.startYear,
                Math.min(
                    projectedStartYear,
                    terminal.seriesRange.endYear - width + 1,
                ),
            );
        }
        projectedEndYear = projectedStartYear + width - 1;
        const prior = new Map([
            ...terminal.rankedYears,
            ...location.rankedYears,
        ].map((row) => [row.year, row]));
        const minimumScore = Math.min(
            0,
            ...terminal.rankedYears.map(({ score }) => score),
            ...location.rankedYears.map(({ score }) => score),
        );
        projectedRankedYears = Array.from(
            { length: width },
            (_, index) => projectedStartYear + index,
        ).map((year) => prior.get(year) ?? {
            year,
            rank: 0,
            score: minimumScore - 1,
            evidenceTags: ["terminal_unit_boundary_union"],
        }).sort((left, right) => (
            right.score - left.score
            || right.year - left.year
        )).map((row, index) => ({ ...row, rank: index + 1 }));
    }
    return withEvidenceLedger({
        ...terminal,
        id: `${terminal.id}-${support.kind}-location-${
            topYear(location) ?? "window"
        }`,
        startYear: projectedStartYear,
        endYear: projectedEndYear,
        rankedYears: projectedRankedYears,
        reviewCoreRange: location.reviewCoreRange,
        evidence: {
            ...terminal.evidence,
            algorithmSources: Array.from(new Set([
                ...terminal.evidence.algorithmSources,
                ...location.evidence.algorithmSources,
                "terminal_unit_compatible_location_projection",
                `terminal_unit_${support.kind}_location`,
            ])).sort(),
            candidateIds: Array.from(new Set([
                ...terminal.evidence.candidateIds,
                ...location.evidence.candidateIds,
            ])),
            locationEvidence: [
                ...(terminal.evidence.locationEvidence ?? []),
                ...(location.evidence.locationEvidence ?? []),
            ],
            notes: Array.from(new Set([
                ...terminal.evidence.notes,
                ...location.evidence.notes,
                `terminal_unit_location_support=${support.kind}`,
                `terminal_unit_location_support_stage=${support.checkpoint.stage}`,
                `terminal_unit_location_previous_top_year=${topYear(terminal) ?? "none"}`,
                `terminal_unit_location_projected_top_year=${topYear(location) ?? "none"}`,
                ...(terminalBoundaryYear !== null
                    && (projectedStartYear !== location.startYear
                        || projectedEndYear !== location.endYear)
                    ? [
                        `terminal_unit_location_boundary_year=${terminalBoundaryYear}`,
                        `terminal_unit_location_boundary_union=${
                            projectedStartYear
                        }-${projectedEndYear}`,
                    ]
                    : []),
            ])),
        },
    });
};

const preferredHighConfidenceBarkSidePartialCandidate = (
    cluster: HypothesisCluster,
): DiagnosisReviewEventCheckpoint | null => {
    const selectedFinals = cluster.checkpoints.filter((checkpoint) => {
        const event = checkpoint.event;
        return checkpoint.stage === "final"
            && checkpoint.authority !== "supplemental"
            && event.eventType === "partialMove"
            && event.shiftSide === "older"
            && (event.shiftYears ?? 0) < -1
            && event.evidence.lagBefore === event.shiftYears
            && event.evidence.lagAfter === 0
            && !eventHasIndependentLocationAuthority(event);
    });
    if (selectedFinals.length === 0) return null;
    const candidate = cluster.checkpoints.filter((checkpoint) => {
        const event = checkpoint.event;
        const eventTop = topYear(event);
        return checkpoint.stage === "candidate"
            && checkpoint.authority !== "supplemental"
            && event.eventType === "partialMove"
            && event.shiftSide === "older"
            && event.confidenceLevel === "high"
            && (event.evidence.correlationGain ?? 0) >= 0.2
            && event.evidence.notes.includes("candidate_hard_gate_passed")
            && event.evidence.algorithmSources.includes("candidate_ranking")
            && event.evidence.algorithmSources.includes("cofecha_segment_lag")
            && eventTop !== null
            && selectedFinals.some((selected) => {
                const selectedTop = topYear(selected.event);
                return sameOperation(event, selected.event)
                    && selectedTop !== null
                    && eventTop > selectedTop
                    && eventTop - selectedTop <= 13
                    && event.endYear > selected.event.endYear;
            });
    }).sort((left, right) => (
        (right.event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY)
            - (left.event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY)
        || (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
    ))[0] ?? null;
    if (!candidate) return null;
    const selectedFinal = selectedFinals.slice().sort((left, right) => (
        representativeQuality(cluster, right) - representativeQuality(cluster, left)
        || eventLocationQuality(right.event) - eventLocationQuality(left.event)
    ))[0]!;
    const candidateTop = topYear(candidate.event)!;
    const selectedTop = topYear(selectedFinal.event);
    return {
        ...selectedFinal,
        event: withEvidenceLedger({
            ...selectedFinal.event,
            id: `${selectedFinal.event.id}-cofecha-bark-frontier-${candidateTop}`,
            startYear: candidate.event.startYear,
            endYear: candidate.event.endYear,
            rankedYears: candidate.event.rankedYears.map((row) => ({ ...row })),
            interpretationAmbiguity: undefined,
            evidence: {
                ...selectedFinal.event.evidence,
                algorithmSources: Array.from(new Set([
                    ...selectedFinal.event.evidence.algorithmSources,
                    ...candidate.event.evidence.algorithmSources,
                    "cofecha_bark_side_partial_location",
                ])).sort(),
                notes: Array.from(new Set([
                    ...selectedFinal.event.evidence.notes,
                    ...candidate.event.evidence.notes,
                    `cofecha_bark_side_previous_top_year=${selectedTop ?? "none"}`,
                    `cofecha_bark_side_selected_top_year=${candidateTop}`,
                ])),
            },
        }),
    };
};

const preferredSelectedFinalLocation = (
    cluster: HypothesisCluster,
): DiagnosisReviewEventCheckpoint | null => {
    const hasSupplementalFinal = cluster.checkpoints.some((checkpoint) => (
        checkpoint.stage === "final"
        && checkpoint.authority === "supplemental"
    ));
    if (!hasSupplementalFinal) return null;
    return cluster.checkpoints.filter((checkpoint) => (
        checkpoint.stage === "final"
        && checkpoint.authority !== "supplemental"
    ))
    .sort((left, right) => (
        representativeQuality(cluster, right) - representativeQuality(cluster, left)
        || eventLocationQuality(right.event) - eventLocationQuality(left.event)
        || (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
    ))[0] ?? null;
};

const preferredSelectedMultiEventLocation = (
    cluster: HypothesisCluster,
): DiagnosisReviewEventCheckpoint | null => cluster.checkpoints
    .filter((checkpoint) => {
        if (checkpoint.stage !== "final" || checkpoint.authority === "supplemental") {
            return false;
        }
        const evidenceYears = checkpoint.event.evidence.notes.find((note) => (
            note.startsWith("multi_frontier_evidence_years=")
        ))?.split("=")[1]?.split(",").filter(Boolean) ?? [];
        return checkpoint.event.evidence.algorithmSources.includes(
            "multi_event_frontier_location_consensus",
        ) && new Set(evidenceYears).size >= 2;
    })
    .sort((left, right) => (
        eventLocationQuality(right.event) - eventLocationQuality(left.event)
        || (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
    ))[0] ?? null;

const representative = (
    cluster: HypothesisCluster,
): DiagnosisReviewEventCheckpoint => {
    const ranked = [...cluster.checkpoints].sort((left, right) => (
        representativeQuality(cluster, right) - representativeQuality(cluster, left)
        || persistedStageCount(cluster, right) - persistedStageCount(cluster, left)
        || stagePriority[right.stage] - stagePriority[left.stage]
        || (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
    ))[0];
    const selected = preferredSelectedMultiEventLocation(cluster)
        ?? preferredValidatedFinalSequentialUnit(cluster)
        ?? preferredSelectedCompletedComposition(cluster)
        ?? preferredHighConfidenceBarkSidePartialCandidate(cluster)
        ?? preferredAcceptedFinalLocation(cluster)
        ?? preferredStrongBoundedLocation(cluster)
        ?? preferredStrongSelectedBoundedLocation(cluster)
        ?? preferredSelectedFinalLocation(cluster)
        ?? ranked;
    return preferredEndpointCandidate(cluster, selected)
        ?? preferredSequentialSupport(cluster, selected)
        ?? selected;
};

const hasIndependentLocationAuthority = (cluster: HypothesisCluster): boolean => (
    cluster.checkpoints.some(({ event }) => eventHasIndependentLocationAuthority(event))
);

const locationScore = (cluster: HypothesisCluster): number => {
    const selected = representative(cluster);
    const supportStages = new Set(cluster.checkpoints.map(({ stage }) => stage));
    const maxStage = Math.max(...[...supportStages].map((stage) => stagePriority[stage]));
    return maxStage / 6 * 0.35
        + supportStages.size / 6 * 0.35
        + (hasIndependentLocationAuthority(cluster) ? 0.2 : 0)
        + eventLocationQuality(selected.event) * 0.07
        + confidenceScore(selected.event) * 0.03;
};

const clusterId = (cluster: HypothesisCluster): string => {
    const selected = representative(cluster).event;
    return [selected.seriesId, selected.eventType, selected.shiftYears ?? "unit",
        selected.startYear, selected.endYear, topYear(selected) ?? "none"].join(":");
};

const summary = (cluster: HypothesisCluster): DiagnosisJointHypothesisSummary => {
    const selected = representative(cluster);
    const event = selected.event;
    return {
        id: clusterId(cluster),
        eventType: event.eventType,
        shiftYears: event.shiftYears ?? null,
        startYear: event.startYear,
        endYear: event.endYear,
        topYear: topYear(event),
        sourceStage: selected.stage,
        supportStages: [...new Set(cluster.checkpoints.map(({ stage }) => stage))]
            .sort((left, right) => stagePriority[right] - stagePriority[left]),
        claimCount: new Set(cluster.checkpoints.flatMap(({ event: candidate }) => (
            [...evidenceClaimsFor(candidate)]
        ))).size,
        locationEvidenceCount: matchingLocationEvidence(event).length,
        score: locationScore(cluster),
    };
};

const deduplicateCheckpoints = (
    checkpoints: readonly DiagnosisReviewEventCheckpoint[],
): DiagnosisReviewEventCheckpoint[] => {
    const selected = new Map<string, DiagnosisReviewEventCheckpoint>();
    checkpoints.forEach((checkpoint) => {
        const event = checkpoint.event;
        const key = [checkpoint.stage, checkpoint.authority ?? "selected",
            event.eventType, event.shiftYears ?? "unit",
            event.startYear, event.endYear, topYear(event) ?? "none"].join(":");
        if (!selected.has(key)) {
            selected.set(key, {
                stage: checkpoint.stage,
                ...(checkpoint.authority ? { authority: checkpoint.authority } : {}),
                event: withEvidenceLedger(event),
            });
        }
    });
    return [...selected.values()];
};

const clusterCheckpoints = (
    checkpoints: readonly DiagnosisReviewEventCheckpoint[],
): HypothesisCluster[] => {
    const clusters: HypothesisCluster[] = [];
    deduplicateCheckpoints(checkpoints)
        .sort((left, right) => stagePriority[right.stage] - stagePriority[left.stage])
        .forEach((checkpoint) => {
            const cluster = clusters.find((candidate) => {
                const current = representative(candidate).event;
                return sameOperation(current, checkpoint.event)
                    && sameLocationMode(current, checkpoint.event);
            });
            if (cluster) cluster.checkpoints.push(checkpoint);
            else clusters.push({ checkpoints: [checkpoint] });
        });
    return clusters;
};

const operationKey = (event: DiagnosisEvent): string => [
    event.eventType,
    event.eventType === "missingRing" || event.eventType === "falseRing"
        ? "unit"
        : event.shiftYears ?? "none",
].join(":");

const isHardGatedUnitLocationCheckpoint = (event: DiagnosisEvent): boolean => (
    (event.eventType === "missingRing" || event.eventType === "falseRing")
    && event.evidence.notes.includes("candidate_hard_gate_passed")
    && event.evidence.algorithmSources.some((source) => (
        source === "candidate_ranking"
        || source === "candidate_frontier_checkpoint"
        || source === "cofecha_boundary_checkpoint"
    ))
);

const MAXIMUM_ENDPOINT_CANDIDATE_WINDOW_DISTANCE = 2;

const isHardGatedEndpointMissingCandidate = (
    event: DiagnosisEvent,
): boolean => {
    if (event.eventType !== "missingRing" || !event.seriesRange) return false;
    const endpointDistance = event.seriesRange.endYear - event.endYear;
    return endpointDistance >= 0
        && endpointDistance <= MAXIMUM_ENDPOINT_CANDIDATE_WINDOW_DISTANCE
        && event.evidence.notes.includes("candidate_hard_gate_passed")
        && event.evidence.algorithmSources.includes("candidate_ranking")
        && event.evidence.algorithmSources.includes("local_edit_alignment");
};

const hasPersistedDisplayedUnitLocation = (
    checkpoint: DiagnosisReviewEventCheckpoint,
    submitted: readonly DiagnosisReviewEventCheckpoint[],
): boolean => {
    if (!isHardGatedUnitLocationCheckpoint(checkpoint.event)) return false;
    const matches = (candidate: DiagnosisReviewEventCheckpoint): boolean => (
        isHardGatedUnitLocationCheckpoint(candidate.event)
        && samePersistedLocation(checkpoint.event, candidate.event)
    );
    return submitted.some((candidate) => candidate.stage === "candidate" && matches(candidate))
        && submitted.some((candidate) => candidate.stage === "displayed" && matches(candidate));
};

const operationContractValid = (
    checkpoint: DiagnosisReviewEventCheckpoint,
    submitted: readonly DiagnosisReviewEventCheckpoint[],
): boolean => {
    const { event } = checkpoint;
    if (event.eventType !== "missingRing" && event.eventType !== "falseRing") {
        return true;
    }
    const { lagBefore, lagAfter } = event.evidence;
    if (lagBefore === null || lagAfter === null) return false;
    const transition = lagAfter - lagBefore;
    if (event.eventType === "missingRing" ? transition > 0 : transition < 0) {
        return true;
    }
    const claims = evidenceClaimsFor(event);
    if (event.eventType === "missingRing"
        && (
            claims.has("fixed_side_resolution")
            || claims.has("endpoint_unit_resolution")
        )) {
        return true;
    }
    if (isHardGatedEndpointMissingCandidate(event)) return true;
    const protectedCandidateCheckpoint = event.evidence.notes.includes(
        "candidate_hard_gate_passed",
    ) && event.evidence.algorithmSources.some((source) => (
        source === "candidate_frontier_checkpoint"
        || source === "cofecha_boundary_checkpoint"
    ));
    return (
        protectedCandidateCheckpoint
        && lagBefore === lagAfter
        && (event.eventType === "missingRing" ? lagBefore < 0 : lagBefore > 0)
    )
        || hasPersistedDisplayedUnitLocation(checkpoint, submitted);
};

const groupOperations = (clusters: readonly HypothesisCluster[]): OperationGroup[] => {
    const groups = new Map<string, OperationGroup>();
    clusters.forEach((cluster) => {
        const key = operationKey(representative(cluster).event);
        const group = groups.get(key) ?? { clusters: [] };
        group.clusters.push(cluster);
        groups.set(key, group);
    });
    return [...groups.values()];
};

const operationScore = (group: OperationGroup): number => {
    const checkpoints = group.clusters.flatMap((cluster) => cluster.checkpoints);
    const supportStages = new Set(checkpoints.map(({ stage }) => stage));
    const maxStage = Math.max(...[...supportStages].map((stage) => stagePriority[stage]));
    const confidence = Math.max(...checkpoints.map(({ event }) => confidenceScore(event)));
    return maxStage / 6 * 0.5
        + supportStages.size / 6 * 0.1
        + claimStrength(checkpoints.map(({ event }) => event)) * 0.35
        + confidence * 0.05;
};

const hasFinalCheckpoint = (cluster: HypothesisCluster): boolean => (
    cluster.checkpoints.some(({ stage }) => stage === "final")
);

const hasSelectedCompletedComposition = (cluster: HypothesisCluster): boolean => (
    cluster.checkpoints.some(isSelectedCompletedCompositionCheckpoint)
);

const eventShiftYears = (event: DiagnosisEvent): number | null => {
    const lagBefore = event.evidence.lagBefore;
    const lagAfter = event.evidence.lagAfter;
    if (lagBefore === null || lagAfter === null) return null;
    const shiftYears = lagBefore - lagAfter;
    if (event.eventType === "missingRing") return shiftYears === -1 ? -1 : null;
    if (event.eventType === "falseRing") return shiftYears === 1 ? 1 : null;
    if (event.eventType !== "partialMove"
        || event.shiftYears !== shiftYears
        || shiftYears > -2) return null;
    return shiftYears;
};

/**
 * A selected mixed composition is not authoritative when the complete bounded path already
 * resolves the same cumulative shift into separated, state-contiguous physical transitions.
 */
const exactBoundedComponentFrontier = (
    allFinalClusters: readonly HypothesisCluster[],
    completedCompositionClusters: readonly HypothesisCluster[],
    selectedFinalClusters: readonly HypothesisCluster[],
    minimumSeparationYears: number,
): HypothesisCluster | null => {
    const bounded = allFinalClusters.filter((cluster) => (
        cluster.checkpoints.some((checkpoint) => (
            checkpoint.stage === "final"
            && checkpoint.authority === "supplemental"
            && evidenceClaimsFor(checkpoint.event).has("bounded_lag_state_path")
        ))
    )).sort((left, right) => (
        (topYear(representative(left).event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(representative(right).event) ?? Number.NEGATIVE_INFINITY)
    ));
    if (bounded.length < 2) return null;

    const aggregateHypotheses = [
        ...completedCompositionClusters.flatMap((cluster) => {
            const event = representative(cluster).event;
            const shiftYears = event.evidence.notes.includes(
                "completed_mixed_source_segment_anchored=false",
            )
                ? noteYear(event, "completed_mixed_cumulative_shift=")
                : null;
            return shiftYears === null ? [] : [{ event, shiftYears }];
        }),
        ...selectedFinalClusters.flatMap((cluster) => {
            const event = representative(cluster).event;
            const shiftYears = eventShiftYears(event);
            const boundedAggregate = evidenceClaimsFor(event).has(
                "bounded_lag_state_path",
            );
            return event.eventType === "partialMove"
                && shiftYears !== null
                && !boundedAggregate
                ? [{ event, shiftYears }]
                : [];
        }),
    ];

    for (const aggregate of aggregateHypotheses) {
        const aggregateShiftYears = aggregate.shiftYears;
        const baselineLag = aggregate.event.evidence.lagAfter;
        if (aggregateShiftYears === null || baselineLag === null) continue;
        for (let start = 0; start < bounded.length - 1; start += 1) {
            let shiftSum = 0;
            for (let end = start; end < bounded.length; end += 1) {
                const current = representative(bounded[end]!).event;
                const currentShift = eventShiftYears(current);
                const previous = end > start
                    ? representative(bounded[end - 1]!).event
                    : null;
                const currentTop = topYear(current);
                const previousTop = previous ? topYear(previous) : null;
                if (currentShift === null || currentTop === null || (
                    previous && (
                        previousTop === null
                        || currentTop - previousTop < minimumSeparationYears
                        || previous.evidence.lagAfter !== current.evidence.lagBefore
                    )
                )) break;
                shiftSum += currentShift;
                const transitionCount = end - start + 1;
                const oldest = representative(bounded[start]!).event;
                if (transitionCount >= 2
                    && shiftSum === aggregateShiftYears
                    && oldest.evidence.lagBefore === baselineLag + aggregateShiftYears
                    && current.evidence.lagAfter === baselineLag) {
                    const frontier = bounded[end]!;
                    return {
                        checkpoints: frontier.checkpoints.map((checkpoint) => ({
                            ...checkpoint,
                            event: withEvidenceLedger({
                                ...checkpoint.event,
                                evidence: {
                                    ...checkpoint.event.evidence,
                                    algorithmSources: Array.from(new Set([
                                        ...checkpoint.event.evidence.algorithmSources,
                                        "exact_bounded_component_decomposition",
                                    ])).sort(),
                                    notes: Array.from(new Set([
                                        ...checkpoint.event.evidence.notes,
                                        `aggregate_partial_decomposed_shift=${
                                            aggregateShiftYears
                                        }`,
                                        `aggregate_partial_decomposed_component_count=${
                                            transitionCount
                                        }`,
                                        `aggregate_partial_decomposed_frontier_shift=${
                                            currentShift
                                        }`,
                                    ])),
                                },
                            }),
                        })),
                    };
                }
            }
        }
    }
    return null;
};

const exactTerminalBoundedPartialFrontier = (
    allFinalClusters: readonly HypothesisCluster[],
    completedCompositionClusters: readonly HypothesisCluster[],
): HypothesisCluster | null => {
    const hasUnanchoredComposition = completedCompositionClusters.some((cluster) => (
        representative(cluster).event.evidence.notes.includes(
            "completed_mixed_source_segment_anchored=false",
        )
    ));
    if (!hasUnanchoredComposition) return null;
    return allFinalClusters.filter((cluster) => cluster.checkpoints.some((checkpoint) => {
        const event = checkpoint.event;
        const shiftYears = eventShiftYears(event);
        return checkpoint.stage === "final"
            && checkpoint.authority === "supplemental"
            && event.eventType === "partialMove"
            && shiftYears !== null
            && event.evidence.lagAfter === 0
            && event.evidence.algorithmSources.includes("bounded_complete_lag_path")
            && event.evidence.algorithmSources.includes("joint_year_operation_evidence")
            && event.evidence.notes.includes("bounded_path_complete_hypothesis=true")
            && (noteNumber(event, "bounded_path_transition_gain=") ?? 0) >= 20
            && (noteNumber(event, "bounded_path_runner_up_margin=") ?? 0) >= 1
            && (noteNumber(event, "bounded_operation_location_remote_margin=") ?? 0)
                >= 0.01;
    })).sort((left, right) => (
        (topYear(representative(right).event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(representative(left).event) ?? Number.NEGATIVE_INFINITY)
        || representative(right).event.endYear - representative(left).event.endYear
    ))[0] ?? null;
};

const WHOLE_FRAME_STAGES = new Set<DiagnosisReviewSourceStage>([
    "detected",
    "fused",
    "retained",
    "displayed",
]);

const wholeFrameAuthority = (event: DiagnosisEvent): number => {
    const claims = evidenceClaimsFor(event);
    if (claims.has("whole_path_fixed_baseline")) return 3;
    if (claims.has("whole_terminal_baseline")) return 2;
    if (claims.has("whole_global_lag")) return 1;
    return 0;
};

/**
 * A durable negative whole hypothesis defines the coordinate frame for later local edits.
 * A local event may precede it only when its untouched side lands exactly on that frame.
 */
const selectDurableWholeFrame = (
    clusters: readonly HypothesisCluster[],
    allFinalClusters: readonly HypothesisCluster[],
    selectedFinalClusters: readonly HypothesisCluster[],
): HypothesisCluster | null => {
    if (!selectedFinalClusters.some((cluster) => (
        representative(cluster).event.eventType !== "wholeSeriesMove"
    ))) return null;

    const frames = clusters.filter((cluster) => {
        const event = representative(cluster).event;
        const stages = new Set(cluster.checkpoints.map(({ stage }) => stage));
        return event.eventType === "wholeSeriesMove"
            && (event.shiftYears ?? 0) < 0
            && wholeFrameAuthority(event) > 0
            && [...WHOLE_FRAME_STAGES].every((stage) => stages.has(stage));
    }).sort((left, right) => (
        wholeFrameAuthority(representative(right).event)
            - wholeFrameAuthority(representative(left).event)
        || new Set(right.checkpoints.map(({ stage }) => stage)).size
            - new Set(left.checkpoints.map(({ stage }) => stage)).size
        || confidenceScore(representative(right).event)
            - confidenceScore(representative(left).event)
    ));
    const frame = frames[0];
    if (!frame) return null;
    const frameEvent = representative(frame).event;
    const frameLag = frameEvent.shiftYears!;
    const compatibleLocal = allFinalClusters.filter((cluster) => {
        const event = representative(cluster).event;
        return event.eventType !== "wholeSeriesMove"
            && event.evidence.lagAfter === frameLag
            && evidenceClaimsFor(event).has("bounded_lag_state_path")
            && strongBoundedPathLocation(event) !== null;
    }).sort((left, right) => (
        (topYear(representative(right).event) ?? Number.NEGATIVE_INFINITY)
            - (topYear(representative(left).event) ?? Number.NEGATIVE_INFINITY)
        || eventLocationQuality(representative(right).event)
            - eventLocationQuality(representative(left).event)
    ))[0];
    if (compatibleLocal) return compatibleLocal;

    return {
        checkpoints: frame.checkpoints.map((checkpoint) => ({
            ...checkpoint,
            event: withEvidenceLedger({
                ...checkpoint.event,
                evidence: {
                    ...checkpoint.event.evidence,
                    algorithmSources: Array.from(new Set([
                        ...checkpoint.event.evidence.algorithmSources,
                        "durable_whole_frame_priority",
                    ])).sort(),
                    notes: Array.from(new Set([
                        ...checkpoint.event.evidence.notes,
                        "whole_frame_precedes_unresolved_local_aggregate=true",
                    ])),
                },
            }),
        })),
    };
};

const selectStrongerGlobalWholeCandidate = (
    clusters: readonly HypothesisCluster[],
    selectedFinalClusters: readonly HypothesisCluster[],
): HypothesisCluster | null => {
    const selectedWhole = selectedFinalClusters.filter((cluster) => (
        representative(cluster).event.eventType === "wholeSeriesMove"
    )).sort((left, right) => (
        wholeFrameAuthority(representative(right).event)
            - wholeFrameAuthority(representative(left).event)
    ))[0];
    if (!selectedWhole) return null;
    const selectedEvent = representative(selectedWhole).event;
    const selectedShift = selectedEvent.shiftYears;
    const selectedGain = selectedEvent.evidence.correlationGain
        ?? Number.NEGATIVE_INFINITY;
    const selectedStateSupport = noteNumber(
        selectedEvent,
        "whole_state_support_fraction=",
    ) ?? 0;
    if (selectedShift === undefined
        || selectedShift >= 0
        || !evidenceClaimsFor(selectedEvent).has("whole_path_fixed_baseline")
        || selectedStateSupport > 0.2) return null;

    const candidate = clusters.filter((cluster) => (
        !hasFinalCheckpoint(cluster)
        && cluster.checkpoints.some(({ stage }) => stage === "candidate")
    )).map((cluster) => ({ cluster, event: representative(cluster).event }))
        .filter(({ event }) => {
            const shiftYears = event.shiftYears;
            const observedLag = noteNumber(event, "whole_observed_dominant_lag=");
            const support = noteNumber(event, "whole_state_support_fraction=") ?? 0;
            const weightedSupport = noteNumber(
                event,
                "whole_state_weighted_support_fraction=",
            ) ?? 0;
            const newerEdgeSupport = noteNumber(
                event,
                "whole_state_newer_edge_support_fraction=",
            ) ?? 0;
            return event.eventType === "wholeSeriesMove"
                && shiftYears !== undefined
                && shiftYears < 0
                && Math.abs(shiftYears - selectedShift) === 1
                && observedLag === shiftYears
                && support >= 0.55
                && weightedSupport >= 0.55
                && newerEdgeSupport >= 0.5
                && event.confidenceLevel === "high"
                && event.evidence.notes.includes("candidate_hard_gate_passed")
                && (event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY) >= 0.2
                && (event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY)
                    >= selectedGain + 0.15;
        }).sort((left, right) => (
            (right.event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY)
                - (left.event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY)
        ))[0];
    if (!candidate) return null;

    return {
        checkpoints: candidate.cluster.checkpoints.map((checkpoint) => ({
            ...checkpoint,
            event: withEvidenceLedger({
                ...checkpoint.event,
                evidence: {
                    ...checkpoint.event.evidence,
                    algorithmSources: Array.from(new Set([
                        ...checkpoint.event.evidence.algorithmSources,
                        "stronger_global_whole_candidate",
                    ])).sort(),
                    notes: Array.from(new Set([
                        ...checkpoint.event.evidence.notes,
                        `replaced_path_fixed_whole_shift=${selectedShift}`,
                        `replaced_path_fixed_whole_gain=${selectedGain.toFixed(6)}`,
                    ])),
                },
            }),
        })),
    };
};

const deduplicateObjects = <T>(values: readonly T[]): T[] => {
    const selected = new Map<string, T>();
    values.forEach((value) => selected.set(JSON.stringify(value), value));
    return [...selected.values()];
};

const aggregateCompatibleClusterEvidence = (
    event: DiagnosisEvent,
    cluster: HypothesisCluster,
): DiagnosisEvent => {
    if (cluster.checkpoints.length <= 1) return event;
    const supportEvents = cluster.checkpoints.map((checkpoint) => checkpoint.event);
    return withEvidenceLedger({
        ...event,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                ...supportEvents.flatMap((candidate) => candidate.evidence.algorithmSources),
                "joint_hypothesis_evidence_aggregation",
            ])).sort(),
            notes: Array.from(new Set([
                ...event.evidence.notes,
                ...supportEvents.flatMap((candidate) => candidate.evidence.notes),
                `joint_compatible_evidence_count=${supportEvents.length}`,
            ])),
            candidateIds: Array.from(new Set(
                [
                    ...event.evidence.candidateIds,
                    ...supportEvents.flatMap((candidate) => (
                        candidate.evidence.candidateIds
                    )),
                ],
            )),
            samplePairs: Math.max(
                ...supportEvents.map((candidate) => candidate.evidence.samplePairs),
            ),
            locationEvidence: deduplicateObjects([
                ...(event.evidence.locationEvidence ?? []),
                ...supportEvents.flatMap((candidate) => (
                    candidate.evidence.locationEvidence ?? []
                )),
            ]),
            ledger: {
                version: 1,
                entries: deduplicateObjects([
                    ...(event.evidence.ledger?.entries ?? []),
                    ...supportEvents.flatMap((candidate) => (
                        candidate.evidence.ledger?.entries ?? []
                    )),
                ]),
            },
        },
    });
};

const checkpointsWithFinalClaim = (
    cluster: HypothesisCluster,
    claims: ReadonlySet<DiagnosisEvidenceClaim>,
): DiagnosisReviewEventCheckpoint[] => cluster.checkpoints.filter((checkpoint) => (
    checkpoint.stage === "final"
    && [...evidenceClaimsFor(checkpoint.event)].some((claim) => claims.has(claim))
));

const retainFinalClaimAuthority = (
    cluster: HypothesisCluster,
    claims: ReadonlySet<DiagnosisEvidenceClaim>,
): HypothesisCluster | null => {
    const checkpoints = checkpointsWithFinalClaim(cluster, claims);
    if (checkpoints.length === 0) return null;
    const endpointAuthority = checkpoints.some(({ event }) => (
        evidenceClaimsFor(event).has("endpoint_unit_resolution")
    ));
    if (!endpointAuthority) return { checkpoints };
    const endpointLocationCheckpoints = cluster.checkpoints.filter((checkpoint) => (
        checkpoint.stage === "candidate"
        && checkpoint.event.eventType === "missingRing"
        && checkpoint.event.evidence.notes.includes("candidate_hard_gate_passed")
        && checkpoint.event.evidence.algorithmSources.includes("candidate_ranking")
        && checkpoints.some((authority) => (
            sameOperation(authority.event, checkpoint.event)
            && sameLocationMode(authority.event, checkpoint.event)
        ))
    ));
    return {
        checkpoints: [...checkpoints, ...endpointLocationCheckpoints],
    };
};

const ENDPOINT_REVIEW_WIDTHS = new Set([5, 7, 9, 13]);
const MAX_CANDIDATE_ENDPOINT_INTERPRETATION_DISTANCE_YEARS = 15;
const MAX_WHOLE_MISSING_AMBIGUITY_DISTANCE_YEARS = 15;
const ENDPOINT_MISSING_CLAIMS = new Set<DiagnosisEvidenceClaim>([
    "endpoint_unit_resolution",
    "fixed_side_resolution",
    "explicit_missing_staircase",
    "independent_reference_staircase",
    "whole_baseline_exhausted_by_missing_staircase",
]);

type ReviewableWholeMissingShift = -1 | -2 | -3;

const reviewableWholeMissingShift = (
    event: DiagnosisEvent,
): ReviewableWholeMissingShift | null => {
    const shift = wholeSeriesMoveShiftYears(event);
    return shift === -1 || shift === -2 || shift === -3 ? shift : null;
};

const endpointMissingAuthority = (event: DiagnosisEvent): number => {
    const claims = evidenceClaimsFor(event);
    if (claims.has("whole_baseline_exhausted_by_missing_staircase")) return 5;
    if (claims.has("endpoint_unit_resolution")) return 4;
    if (claims.has("fixed_side_resolution")) return 3;
    if (claims.has("independent_reference_staircase")) return 2;
    if (claims.has("explicit_missing_staircase")) return 1;
    const independentlyReviewedUnit = event.evidence.algorithmSources.includes(
        "sequential_missing_staircase_head",
    ) || event.evidence.notes.includes("candidate_hard_gate_passed");
    return independentlyReviewedUnit
        && event.evidence.lagBefore !== null
        && event.evidence.lagAfter !== null
        && event.evidence.lagBefore >= -3
        && event.evidence.lagBefore < 0
        && event.evidence.lagAfter === event.evidence.lagBefore + 1
        ? 0
        : -1;
};

const selectEndpointMissingInterpretation = (
    clusters: readonly HypothesisCluster[],
    whole: DiagnosisEvent,
): DiagnosisEvent | null => {
    if (whole.eventType !== "wholeSeriesMove"
        || reviewableWholeMissingShift(whole) === null) return null;
    return clusters.flatMap((cluster) => cluster.checkpoints)
        .filter((checkpoint) => {
            const { event } = checkpoint;
            if (event.eventType !== "missingRing") return false;
            const width = event.endYear - event.startYear + 1;
            const endpointDistance = whole.endYear - event.endYear;
            if (!ENDPOINT_REVIEW_WIDTHS.has(width) || endpointDistance < 0) return false;
            if (checkpoint.stage === "final") {
                return endpointDistance <= 29 && endpointMissingAuthority(event) >= 0;
            }
            return checkpoint.stage === "candidate"
                && endpointDistance
                    <= MAX_CANDIDATE_ENDPOINT_INTERPRETATION_DISTANCE_YEARS
                && event.evidence.notes.includes("candidate_hard_gate_passed")
                && event.evidence.algorithmSources.includes("candidate_ranking")
                && event.evidence.algorithmSources.includes("local_edit_alignment");
        })
        .sort((left, right) => (
            (right.stage === "final" ? 1 : 0) - (left.stage === "final" ? 1 : 0)
            || endpointMissingAuthority(right.event)
                - endpointMissingAuthority(left.event)
            || confidenceScore(right.event) - confidenceScore(left.event)
            || right.event.endYear - left.event.endYear
            || (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
                - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
        ))
        .map(({ event }) => event)
        [0] ?? null;
};

const isProtectedCandidateFrontier = (cluster: HypothesisCluster): boolean => (
    cluster.checkpoints.some(({ event }) => (
        (event.eventType === "missingRing" || event.eventType === "falseRing")
        && event.evidence.notes.includes("candidate_hard_gate_passed")
        && event.evidence.algorithmSources.some((source) => (
            source === "candidate_frontier_checkpoint"
            || source === "cofecha_boundary_checkpoint"
        ))
    ))
);

const PATH_ANCHORED_REVIEW_WIDTHS = new Set([5, 7, 9, 13]);
const MAXIMUM_PATH_ANCHOR_SPREAD = 2;
const MAXIMUM_CANDIDATE_TOP_ANCHOR_DISTANCE = 4;

const annotatePathAnchoredCandidate = (
    cluster: HypothesisCluster,
    finalEvent: DiagnosisEvent,
    rawPathYear: number,
    directTransitionYear: number,
): HypothesisCluster => ({
    checkpoints: cluster.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        event: withEvidenceLedger({
            ...checkpoint.event,
            evidence: {
                ...checkpoint.event.evidence,
                algorithmSources: Array.from(new Set([
                    ...checkpoint.event.evidence.algorithmSources,
                    "path_transition_candidate_authority",
                ])).sort(),
                notes: Array.from(new Set([
                    ...checkpoint.event.evidence.notes,
                    `path_transition_authority_raw_year=${rawPathYear}`,
                    `path_transition_authority_direct_year=${directTransitionYear}`,
                    `path_transition_authority_discarded_window=${
                        finalEvent.startYear
                    }-${finalEvent.endYear}`,
                ])),
            },
        }),
    })),
});

const selectPathAnchoredCandidate = (
    clusters: readonly HypothesisCluster[],
    finalClusters: readonly HypothesisCluster[],
    config: JointEventAdjudicationConfig,
): HypothesisCluster | null => {
    const matches = finalClusters.flatMap((finalCluster) => {
        const finalEvent = representative(finalCluster).event;
        if (
            finalEvent.eventType !== "missingRing"
            || hasIndependentLocationAuthority(finalCluster)
        ) return [];
        const rawPathYear = noteYear(finalEvent, "raw_path_top_year=");
        const directTransitionYear = noteYear(
            finalEvent,
            "direct_transition_year=",
        );
        const finalTopYear = topYear(finalEvent);
        if (
            rawPathYear === null
            || directTransitionYear === null
            || finalTopYear === null
            || Math.abs(rawPathYear - directTransitionYear)
                > MAXIMUM_PATH_ANCHOR_SPREAD
            || Math.abs(
                finalTopYear - (rawPathYear + directTransitionYear) / 2,
            ) <= config.remoteModeDistanceYears
        ) return [];

        const candidates = clusters.filter((cluster) => {
            if (hasFinalCheckpoint(cluster)) return false;
            const checkpoint = representative(cluster);
            const candidate = checkpoint.event;
            const candidateTopYear = topYear(candidate);
            const width = eventWidth(candidate);
            return checkpoint.stage === "candidate"
                && sameOperation(candidate, finalEvent)
                && PATH_ANCHORED_REVIEW_WIDTHS.has(width)
                && candidate.evidence.notes.includes("candidate_hard_gate_passed")
                && candidate.evidence.algorithmSources.includes("candidate_ranking")
                && candidate.evidence.algorithmSources.includes("local_edit_alignment")
                && rawPathYear >= candidate.startYear
                && rawPathYear <= candidate.endYear
                && directTransitionYear >= candidate.startYear
                && directTransitionYear <= candidate.endYear
                && candidateTopYear !== null
                && Math.max(
                    Math.abs(candidateTopYear - rawPathYear),
                    Math.abs(candidateTopYear - directTransitionYear),
                ) <= MAXIMUM_CANDIDATE_TOP_ANCHOR_DISTANCE;
        });
        return candidates.length === 1
            ? [annotatePathAnchoredCandidate(
                    candidates[0]!,
                    finalEvent,
                    rawPathYear,
                    directTransitionYear,
                )]
            : [];
    });
    return matches.length === 1 ? matches[0] : null;
};

const annotateEndpointCandidate = (
    cluster: HypothesisCluster,
    finalEvent: DiagnosisEvent,
    endpointDistance: number,
): HypothesisCluster => ({
    checkpoints: cluster.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        event: withEvidenceLedger({
            ...checkpoint.event,
            evidence: {
                ...checkpoint.event.evidence,
                algorithmSources: Array.from(new Set([
                    ...checkpoint.event.evidence.algorithmSources,
                    "endpoint_candidate_location_authority",
                ])).sort(),
                notes: Array.from(new Set([
                    ...checkpoint.event.evidence.notes,
                    `endpoint_candidate_authority_distance=${endpointDistance}`,
                    `endpoint_candidate_authority_discarded_window=${
                        finalEvent.startYear
                    }-${finalEvent.endYear}`,
                ])),
            },
        }),
    })),
});

const selectEndpointCandidate = (
    clusters: readonly HypothesisCluster[],
    finalClusters: readonly HypothesisCluster[],
    config: JointEventAdjudicationConfig,
): HypothesisCluster | null => {
    const matches = finalClusters.flatMap((finalCluster) => {
        const finalEvent = representative(finalCluster).event;
        const finalTopYear = topYear(finalEvent);
        const seriesEndYear = finalEvent.seriesRange?.endYear;
        if (
            finalEvent.eventType !== "missingRing"
            || finalTopYear === null
            || seriesEndYear === undefined
        ) return [];
        const candidates = clusters.filter((cluster) => {
            if (hasFinalCheckpoint(cluster)) return false;
            const checkpoint = representative(cluster);
            const candidate = checkpoint.event;
            const candidateTopYear = topYear(candidate);
            const endpointDistance = seriesEndYear - candidate.endYear;
            return checkpoint.stage === "candidate"
                && sameOperation(candidate, finalEvent)
                && PATH_ANCHORED_REVIEW_WIDTHS.has(eventWidth(candidate))
                && endpointDistance >= 0
                && endpointDistance
                    <= MAXIMUM_ENDPOINT_CANDIDATE_WINDOW_DISTANCE
                && candidateTopYear !== null
                && candidateTopYear - finalTopYear
                    > config.remoteModeDistanceYears
                && candidate.evidence.notes.includes("candidate_hard_gate_passed")
                && candidate.evidence.algorithmSources.includes("candidate_ranking")
                && candidate.evidence.algorithmSources.includes("local_edit_alignment");
        });
        if (candidates.length !== 1) return [];
        const candidate = representative(candidates[0]!).event;
        return [annotateEndpointCandidate(
            candidates[0]!,
            finalEvent,
            seriesEndYear - candidate.endYear,
        )];
    });
    return matches.length === 1 ? matches[0] : null;
};

const finalFrontierClusters = (
    clusters: readonly HypothesisCluster[],
    config: JointEventAdjudicationConfig,
): HypothesisCluster[] | null => {
    const allFinalClusters = clusters.filter(hasFinalCheckpoint);
    if (allFinalClusters.length === 0) return null;
    const completedCompositionClusters = allFinalClusters.filter(
        hasSelectedCompletedComposition,
    );
    const selectedFinalClusters = allFinalClusters.filter((cluster) => (
        cluster.checkpoints.some((checkpoint) => (
            checkpoint.stage === "final"
            && checkpoint.authority !== "supplemental"
        ))
    ));
    const durableWholeFrame = selectDurableWholeFrame(
        clusters,
        allFinalClusters,
        selectedFinalClusters,
    );
    if (durableWholeFrame) return [durableWholeFrame];
    const strongerGlobalWholeCandidate = selectStrongerGlobalWholeCandidate(
        clusters,
        selectedFinalClusters,
    );
    if (strongerGlobalWholeCandidate) return [strongerGlobalWholeCandidate];
    const persistedWholeBaseline = clusters.filter((cluster) => {
        const event = representative(cluster).event;
        const stages = new Set(cluster.checkpoints.map(({ stage }) => stage));
        return event.eventType === "wholeSeriesMove"
            && event.shiftYears !== undefined
            && event.shiftYears !== 0
            && stages.has("candidate")
            && stages.has("displayed")
            && stages.size >= 4;
    }).sort((left, right) => (
        new Set(right.checkpoints.map(({ stage }) => stage)).size
            - new Set(left.checkpoints.map(({ stage }) => stage)).size
        || confidenceScore(representative(right).event)
            - confidenceScore(representative(left).event)
    ))[0] ?? null;
    if (persistedWholeBaseline) {
        const baselineLag = representative(persistedWholeBaseline).event.shiftYears!;
        const compatibleBoundedCheckpoints = allFinalClusters.flatMap((cluster) => (
            cluster.checkpoints.filter((checkpoint) => (
                checkpoint.stage === "final"
                && evidenceClaimsFor(checkpoint.event).has("bounded_lag_state_path")
                && checkpoint.event.eventType !== "wholeSeriesMove"
                && checkpoint.event.evidence.lagAfter === baselineLag
                && strongBoundedPathLocation(checkpoint.event) !== null
            ))
        )).sort((left, right) => (
            (topYear(right.event) ?? Number.NEGATIVE_INFINITY)
                - (topYear(left.event) ?? Number.NEGATIVE_INFINITY)
            || eventLocationQuality(right.event) - eventLocationQuality(left.event)
        ));
        if (compatibleBoundedCheckpoints.length > 0) {
            // A persistent global frame fixes the untouched side's lag. Prefer the direct local
            // transition that lands on that frame over a zero-terminal staircase synthesized
            // from the same cumulative displacement.
            return [{ checkpoints: [compatibleBoundedCheckpoints[0]!] }];
        }
    }
    const validatedSelectedSequentialFalse = selectedFinalClusters.filter((cluster) => (
        cluster.checkpoints.some(isValidatedSelectedSequentialUnit)
    ));
    if (validatedSelectedSequentialFalse.length > 0) {
        return validatedSelectedSequentialFalse.sort((left, right) => (
            (topYear(representative(right).event) ?? Number.NEGATIVE_INFINITY)
                - (topYear(representative(left).event) ?? Number.NEGATIVE_INFINITY)
        ));
    }
    const boundedComponentFrontier = exactBoundedComponentFrontier(
        allFinalClusters,
        completedCompositionClusters,
        selectedFinalClusters,
        config.remoteModeDistanceYears + 1,
    );
    if (boundedComponentFrontier) return [boundedComponentFrontier];
    const terminalBoundedPartial = exactTerminalBoundedPartialFrontier(
        allFinalClusters,
        completedCompositionClusters,
    );
    if (terminalBoundedPartial) return [terminalBoundedPartial];
    // An unanchored composition is an interpretation, not an override. Keep its independently
    // validated aggregate or component hypotheses in the same final arbitration set.
    const anchoredCompositionClusters = completedCompositionClusters.filter((cluster) => (
        !representative(cluster).event.evidence.notes.includes(
            "completed_mixed_source_segment_anchored=false",
        )
    ));
    const finalClusters = anchoredCompositionClusters.length > 0
        ? anchoredCompositionClusters
        : allFinalClusters;
    const boundedPathClusters = finalClusters.filter((cluster) => (
        cluster.checkpoints.some(({ event }) => evidenceClaimsFor(event).has(
            "bounded_lag_state_path",
        ))
    ));
    if (boundedPathClusters.length > 0) {
        const selectedWhole = selectedFinalClusters.find((cluster) => (
            representative(cluster).event.eventType === "wholeSeriesMove"
        ));
        if (selectedWhole) {
            const selectedWholeEvent = representative(selectedWhole).event;
            if (selectedWholeEvent.evidence.algorithmSources.includes(
                "dominant_whole_state_consensus",
            )) {
                // Correct a broadly verified global state first. The bounded transition remains
                // evidence for the next diagnosis but cannot rewrite this operation.
                return [selectedWhole];
            }
            const wholeShift = selectedWholeEvent.shiftYears;
            const localOnWholeBaseline = boundedPathClusters.filter((cluster) => {
                const event = representative(cluster).event;
                return event.eventType !== "wholeSeriesMove"
                    && event.evidence.lagAfter === wholeShift;
            }).sort((left, right) => (
                (topYear(representative(right).event) ?? Number.NEGATIVE_INFINITY)
                    - (topYear(representative(left).event) ?? Number.NEGATIVE_INFINITY)
            ));
            // A local transition may precede the whole correction only when its untouched
            // newer state is exactly the selected whole baseline.
            return localOnWholeBaseline.length > 0
                ? [localOnWholeBaseline[0]!]
                : [selectedWhole];
        }
        const boundedWhole = boundedPathClusters.find((cluster) => (
            representative(cluster).event.eventType === "wholeSeriesMove"
        ));
        if (boundedWhole) return [boundedWhole];
        const selectedLocal = selectedFinalClusters.filter((cluster) => (
            representative(cluster).event.eventType !== "wholeSeriesMove"
        ));
        const operationProtectedSelectedLocal = selectedLocal.filter((cluster) => (
            !representative(cluster).event.evidence.notes.includes(
                "completed_mixed_source_segment_anchored=false",
            )
        ));
        const boundedMatchingSelectedOperation = boundedPathClusters.filter((bounded) => (
            operationProtectedSelectedLocal.some((selected) => sameOperation(
                representative(selected).event,
                representative(bounded).event,
            ))
        ));
        if (operationProtectedSelectedLocal.length > 0
            && boundedMatchingSelectedOperation.length === 0) {
            // Supplemental paths can sharpen a selected operation, but an ordinary bounded
            // checkpoint cannot rewrite the operation already emitted by the production pass.
            return operationProtectedSelectedLocal;
        }
        const validatedSequentialFalse = operationProtectedSelectedLocal.filter((cluster) => (
            cluster.checkpoints.some(isValidatedSelectedSequentialUnit)
        ));
        if (validatedSequentialFalse.length > 0) {
            // A remote bounded mode remains evidence, but cannot relocate a final frontier whose
            // candidate depth, monotone unit path, and local operation direction all agree.
            return validatedSequentialFalse.sort((left, right) => (
                (topYear(representative(right).event) ?? Number.NEGATIVE_INFINITY)
                    - (topYear(representative(left).event) ?? Number.NEGATIVE_INFINITY)
            ));
        }
        const corroboratedSelected = selectedFinalClusters.filter((selected) => (
            boundedMatchingSelectedOperation.some((bounded) => {
                const selectedEvent = representative(selected).event;
                const boundedEvent = representative(bounded).event;
                return sameOperation(selectedEvent, boundedEvent)
                    && sameLocationMode(selectedEvent, boundedEvent);
            })
        ));
        if (corroboratedSelected.length > 0) {
            const corroboratingBounded = boundedPathClusters.filter((bounded) => (
                corroboratedSelected.some((selected) => (
                    sameOperation(
                        representative(selected).event,
                        representative(bounded).event,
                    )
                    && sameLocationMode(
                        representative(selected).event,
                        representative(bounded).event,
                    )
                ))
            ));
            return [[...new Set([
                ...corroboratingBounded,
                ...corroboratedSelected,
            ])].sort((left, right) => (
                (topYear(representative(right).event) ?? Number.NEGATIVE_INFINITY)
                    - (topYear(representative(left).event) ?? Number.NEGATIVE_INFINITY)
                || representative(right).event.endYear
                    - representative(left).event.endYear
            ))[0]!];
        }
        const acceptedSelectedLocator = operationProtectedSelectedLocal
            .filter(hasAcceptedStrongSelectedLocator)
            .sort((left, right) => (
                locationScore(right) - locationScore(left)
                || (topYear(representative(right).event) ?? Number.NEGATIVE_INFINITY)
                    - (topYear(representative(left).event)
                        ?? Number.NEGATIVE_INFINITY)
            ));
        if (acceptedSelectedLocator.length > 0) {
            // The supplemental path remains corroborating evidence. Once the selected final has
            // passed the locator contract with a concentrated, remote-separated mode, a distant
            // bounded plateau cannot acquire authority merely by having a larger path score.
            return [acceptedSelectedLocator[0]!];
        }
        const independentlyLocatedSelectedUnit = operationProtectedSelectedLocal.flatMap(
            (cluster) => {
                const selectedCheckpoints = cluster.checkpoints.filter((checkpoint) => {
                    const event = checkpoint.event;
                    return checkpoint.stage === "final"
                        && checkpoint.authority !== "supplemental"
                        && (event.eventType === "missingRing"
                            || event.eventType === "falseRing")
                        && eventHasIndependentLocationAuthority(event);
                });
                return selectedCheckpoints.length > 0
                    ? [{ checkpoints: selectedCheckpoints }]
                    : [];
            },
        );
        if (independentlyLocatedSelectedUnit.length > 0) {
            // A selected unit frontier with its own location authority is the adjudicated result.
            // A remote supplemental path may corroborate the operation, but cannot resurrect a
            // location that the production pass already replaced.
            return independentlyLocatedSelectedUnit.sort((left, right) => (
                (topYear(representative(right).event) ?? Number.NEGATIVE_INFINITY)
                    - (topYear(representative(left).event) ?? Number.NEGATIVE_INFINITY)
            ));
        }
        const strongRemoteBounded = boundedMatchingSelectedOperation.filter(
            hasIndependentLocationAuthority,
        );
        if (operationProtectedSelectedLocal.length > 0
            && strongRemoteBounded.length === 0) {
            return operationProtectedSelectedLocal;
        }
        return [[...(strongRemoteBounded.length > 0
            ? strongRemoteBounded
            : boundedPathClusters)].sort((left, right) => (
            (topYear(representative(right).event) ?? Number.NEGATIVE_INFINITY)
                - (topYear(representative(left).event) ?? Number.NEGATIVE_INFINITY)
            || representative(right).event.endYear
                - representative(left).event.endYear
        ))[0]!];
    }
    const protectedWholeClusters = clusters.filter((cluster) => {
        const event = representative(cluster).event;
        return event.eventType === "wholeSeriesMove"
            && evidenceClaimsFor(event).has("whole_terminal_baseline");
    });
    const wholeClusters = finalClusters.filter((cluster) => (
        representative(cluster).event.eventType === "wholeSeriesMove"
    ));
    const localClusters = finalClusters.filter((cluster) => (
        representative(cluster).event.eventType !== "wholeSeriesMove"
    ));
    if (protectedWholeClusters.length > 0) {
        const decisiveClaims = new Set<DiagnosisEvidenceClaim>([
            "fixed_side_resolution",
            "endpoint_unit_resolution",
            "independent_reference_staircase",
            "whole_baseline_exhausted_by_missing_staircase",
        ]);
        const decisiveLocal = localClusters.flatMap((cluster) => {
            const authoritative = retainFinalClaimAuthority(cluster, decisiveClaims);
            return authoritative ? [authoritative] : [];
        });
        return decisiveLocal.length > 0
            ? decisiveLocal
            : protectedWholeClusters;
    }
    if (wholeClusters.length > 0) {
        const decisiveClaims = new Set<DiagnosisEvidenceClaim>([
            "fixed_side_resolution",
            "endpoint_unit_resolution",
            "explicit_missing_staircase",
            "independent_reference_staircase",
        ]);
        const decisiveLocal = localClusters.flatMap((cluster) => {
            const authoritative = retainFinalClaimAuthority(cluster, decisiveClaims);
            return authoritative ? [authoritative] : [];
        });
        return decisiveLocal.length > 0 ? decisiveLocal : wholeClusters;
    }
    const pathAnchoredCandidate = selectPathAnchoredCandidate(
        clusters,
        localClusters,
        config,
    );
    if (pathAnchoredCandidate) return [pathAnchoredCandidate];
    const endpointCandidate = selectEndpointCandidate(
        clusters,
        localClusters,
        config,
    );
    if (endpointCandidate) return [endpointCandidate];
    const protectedCandidate = clusters
        .filter((cluster) => !hasFinalCheckpoint(cluster))
        .filter(isProtectedCandidateFrontier)
        .filter((cluster) => localClusters.some((finalCluster) => {
            if (hasIndependentLocationAuthority(finalCluster)) return false;
            const candidate = representative(cluster).event;
            const finalEvent = representative(finalCluster).event;
            const candidateTop = topYear(candidate);
            const finalTop = topYear(finalEvent);
            return sameOperation(candidate, finalEvent)
                && candidateTop !== null
                && finalTop !== null
                && candidateTop - finalTop > config.remoteModeDistanceYears;
        }))
        .sort((left, right) => (
            stagePriority[representative(right).stage]
                - stagePriority[representative(left).stage]
            || locationScore(right) - locationScore(left)
            || (topYear(representative(right).event) ?? Number.NEGATIVE_INFINITY)
                - (topYear(representative(left).event) ?? Number.NEGATIVE_INFINITY)
        ))[0];
    if (protectedCandidate) return [protectedCandidate];
    if (localClusters.length <= 1) return localClusters;
    const newestYear = Math.max(...localClusters.map((cluster) => (
        topYear(representative(cluster).event) ?? Number.NEGATIVE_INFINITY
    )));
    return localClusters.filter((cluster) => {
        const year = topYear(representative(cluster).event);
        return year !== null
            && newestYear - year <= config.remoteModeDistanceYears;
    });
};

const productionAgreement = (
    selected: DiagnosisEvent | null,
    production: DiagnosisEvent | null,
): DiagnosisJointProductionAgreement => {
    if (!selected || !production) return selected === production
        ? "same"
        : "presence_mismatch";
    if (!sameOperation(selected, production)) return "operation_mismatch";
    return sameLocationMode(selected, production) ? "same" : "location_mismatch";
};

const productionExactMatch = (
    selected: DiagnosisEvent | null,
    production: DiagnosisEvent | null,
): boolean => {
    if (!selected || !production) return selected === production;
    return sameOperation(selected, production)
        && selected.startYear === production.startYear
        && selected.endYear === production.endYear
        && topYear(selected) === topYear(production);
};

const noteYears = (event: DiagnosisEvent, key: string): number[] => {
    const prefix = `${key}=`;
    return event.evidence.notes.filter((note) => note.startsWith(prefix))
        .flatMap((note) => note.slice(prefix.length).split(","))
        .map(Number)
        .filter(Number.isInteger);
};

const recenterSequentialMissingHeadWindow = (
    event: DiagnosisEvent,
): DiagnosisEvent => {
    if (event.eventType !== "missingRing"
        || !event.evidence.algorithmSources.includes(
            "sequential_missing_staircase_head",
        )) return event;
    const headYear = noteYears(event, "sequential_missing_head_year")[0];
    const width = eventWidth(event);
    if (headYear === undefined || ![5, 7, 9, 13].includes(width)) return event;

    const range = event.seriesRange ?? {
        startYear: Math.min(event.startYear, headYear),
        endYear: Math.max(event.endYear, headYear),
    };
    let startYear = headYear - Math.floor((width - 1) / 2);
    startYear = Math.max(range.startYear, Math.min(
        startYear,
        range.endYear - width + 1,
    ));
    const endYear = startYear + width - 1;
    if (startYear === event.startYear && endYear === event.endYear) return event;

    const competingAnchors = [
        ...noteYears(event, "multi_frontier_evidence_years"),
        ...noteYears(event, "direct_transition_year"),
        ...noteYears(event, "paired_core_selected_year"),
    ];
    const nearbyCompetingAnchorWouldBeLost = competingAnchors.some((year) => (
        year >= event.startYear - 2
        && year <= event.endYear + 2
        && (year < startYear || year > endYear)
    ));
    if (nearbyCompetingAnchorWouldBeLost) return event;

    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const minimumScore = Math.min(0, ...event.rankedYears.map(({ score }) => score));
    const rankedYears = Array.from({ length: width }, (_, index) => (
        startYear + index
    )).map((year) => {
        const existing = prior.get(year);
        return existing ?? {
            year,
            rank: 0,
            score: minimumScore - 1,
            evidenceTags: ["sequential_missing_head_window"],
        };
    }).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({
        ...row,
        rank: index + 1,
        evidenceTags: Array.from(new Set([
            ...row.evidenceTags,
            "sequential_missing_head_window",
        ])).sort(),
    }));
    return withEvidenceLedger({
        ...event,
        id: `${event.id}-head-window-${startYear}-${endYear}`,
        startYear,
        endYear,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "sequential_missing_head_window",
            ])).sort(),
            notes: Array.from(new Set([
                ...event.evidence.notes,
                `sequential_head_previous_window=${event.startYear}-${event.endYear}`,
                `sequential_head_final_window=${startYear}-${endYear}`,
            ])),
        },
    });
};

export const adjudicateJointEventHypotheses = (
    seriesId: string,
    checkpoints: readonly DiagnosisReviewEventCheckpoint[],
    productionEvent: DiagnosisEvent | null = null,
    overrides: Partial<JointEventAdjudicationConfig> = {},
): DiagnosisJointEventDecision => {
    const config = { ...DEFAULT_JOINT_EVENT_ADJUDICATION_CONFIG, ...overrides };
    const submitted = checkpoints.filter(({ event }) => (
        event.seriesId === seriesId
        && isAllowedAutomaticDiagnosisEvent(event)
    ));
    const submittedClusters = clusterCheckpoints(submitted);
    const hypotheses = submittedClusters.map(summary);
    const clusters = clusterCheckpoints(submitted.filter((checkpoint) => (
        operationContractValid(checkpoint, submitted)
    ))).sort((left, right) => (
        locationScore(right) - locationScore(left)
        || stagePriority[representative(right).stage]
            - stagePriority[representative(left).stage]
        || clusterId(left).localeCompare(clusterId(right))
    ));
    if (clusters.length === 0) {
        return {
            seriesId,
            status: "refused",
            reason: submittedClusters.length > 0
                ? "operation_contract_conflict"
                : "no_complete_hypothesis",
            sourceStage: null,
            event: null,
            hypotheses,
            operationMargin: null,
            remoteModeMargin: null,
            productionAgreement: productionAgreement(null, productionEvent),
            productionExactMatch: productionExactMatch(null, productionEvent),
        };
    }

    // Final output may contain several serial events. Only the newest local mode is the current
    // user-facing frontier; older modes stay immutable and are reconsidered after one edit.
    const frontierClusters = finalFrontierClusters(clusters, config) ?? clusters;
    const operationGroups = groupOperations(frontierClusters).sort((left, right) => (
        operationScore(right) - operationScore(left)
        || operationKey(representative(left.clusters[0]).event).localeCompare(
            operationKey(representative(right.clusters[0]).event),
        )
    ));
    const winningOperation = operationGroups[0];
    const operationCompetitor = operationGroups[1] ?? null;
    const operationMargin = operationCompetitor
        ? operationScore(winningOperation) - operationScore(operationCompetitor)
        : null;
    if (operationMargin !== null
        && operationMargin < config.minimumOperationMargin) {
        return {
            seriesId,
            status: "refused",
            reason: "operation_conflict",
            sourceStage: null,
            event: null,
            hypotheses,
            operationMargin,
            remoteModeMargin: null,
            productionAgreement: productionAgreement(null, productionEvent),
            productionExactMatch: productionExactMatch(null, productionEvent),
        };
    }

    const operationClusters = [...winningOperation.clusters].sort((left, right) => (
        locationScore(right) - locationScore(left)
        || stagePriority[representative(right).stage]
            - stagePriority[representative(left).stage]
        || clusterId(left).localeCompare(clusterId(right))
    ));
    const winner = operationClusters[0];
    const winnerCheckpoint = representative(winner);
    const winnerEvent = aggregateCompatibleClusterEvidence(
        winnerCheckpoint.event,
        winner,
    );
    const winnerScore = locationScore(winner);
    const remoteCompetitor = operationClusters.find((cluster) => {
        if (cluster === winner) return false;
        const event = representative(cluster).event;
        const winnerTop = topYear(winnerEvent);
        const candidateTop = topYear(event);
        return sameOperation(winnerEvent, event)
            && winnerTop !== null
            && candidateTop !== null
            && Math.abs(winnerTop - candidateTop) > config.remoteModeDistanceYears;
    });
    const remoteModeMargin = remoteCompetitor
        ? winnerScore - locationScore(remoteCompetitor)
        : null;
    const reason = remoteModeMargin !== null
        && remoteModeMargin < config.minimumRemoteModeMargin
        ? "remote_mode_conflict"
        : "selected";
    const baseSelectedEvent = reason === "selected"
        ? projectTerminalUnitCompatibleLocation(winnerEvent, submitted)
        : null;
    const endpointWholeShift = baseSelectedEvent
        ? reviewableWholeMissingShift(baseSelectedEvent)
        : null;
    const endpointMissing = baseSelectedEvent
        ? selectEndpointMissingInterpretation(clusters, baseSelectedEvent)
            ?? makeEndpointMissingReviewFromWhole(baseSelectedEvent)
        : null;
    const endpointDistance = baseSelectedEvent && endpointMissing
        ? baseSelectedEvent.endYear - endpointMissing.endYear
        : null;
    const endpointResolvedEvent = baseSelectedEvent && endpointMissing && endpointWholeShift
        ? endpointDistance !== null
            && endpointDistance > MAX_WHOLE_MISSING_AMBIGUITY_DISTANCE_YEARS
            ? endpointMissing
            : attachEndpointWholeMissingInterpretation(
                baseSelectedEvent,
                endpointMissing,
                {
                    wholeShiftYears: endpointWholeShift,
                    endpointDistanceYears: endpointDistance ?? 0,
                    missingWindowWidth: (
                        endpointMissing.endYear - endpointMissing.startYear + 1
                    ) as 5 | 7 | 9 | 13,
                    operationScoreMargin: operationMargin,
                    finalEvidenceClaims: [...evidenceClaimsFor(endpointMissing)]
                        .filter((claim) => ENDPOINT_MISSING_CLAIMS.has(claim))
                        .sort(),
                },
            )
        : baseSelectedEvent;
    const evidenceLocatedEvent = endpointResolvedEvent
        ? projectUnsupportedLocationToStrongBoundedPath(endpointResolvedEvent)
        : endpointResolvedEvent;
    const locationGuardedEvent = evidenceLocatedEvent?.seriesRange
        ? addStablePartialRankEdgeGuard(evidenceLocatedEvent, {
            targetRange: evidenceLocatedEvent.seriesRange,
        })
        : evidenceLocatedEvent;
    const selectedEvent = locationGuardedEvent
        ? recenterSequentialMissingHeadWindow(
            synchronizePreservedMissingPartialWindow(locationGuardedEvent),
        )
        : locationGuardedEvent;
    return {
        seriesId,
        status: selectedEvent ? "selected" : "refused",
        reason,
        sourceStage: selectedEvent ? winnerCheckpoint.stage : null,
        event: selectedEvent,
        hypotheses,
        operationMargin,
        remoteModeMargin,
        productionAgreement: productionAgreement(selectedEvent, productionEvent),
        productionExactMatch: productionExactMatch(selectedEvent, productionEvent),
    };
};

/** Adds an audit-only comparison without changing the selected hypothesis. */
export const compareJointDecisionToProduction = (
    decision: DiagnosisJointEventDecision,
    productionEvent: DiagnosisEvent | null,
): DiagnosisJointEventDecision => ({
    ...decision,
    productionAgreement: productionAgreement(decision.event, productionEvent),
    productionExactMatch: productionExactMatch(decision.event, productionEvent),
});

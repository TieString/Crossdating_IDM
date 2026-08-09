import { getDisplayedDiagnosisEvents } from "./eventDisplay";
import type {
    CrossdatingDiagnosis,
    DiagnosisEvent,
    DiagnosisEventAuditSnapshot,
} from "./types";

export type EvidenceRefreshDecisionReason =
    | "fresh_only"
    | "fresh_compatible_update"
    | "fresh_cross_supported_operation"
    | "fresh_cross_supported_location"
    | "fresh_decisive_operation_evidence"
    | "fresh_decisive_detached_location"
    | "previous_cross_supported_operation"
    | "previous_supported_hidden_hypothesis"
    | "previous_operation_conflict_retained"
    | "previous_detached_location_retained"
    | "fresh_no_supported_replacement";

export type EvidenceRefreshDecision = {
    reason: EvidenceRefreshDecisionReason;
    selectedEvidence: "previous" | "fresh";
    operationChanged: boolean;
    locationChanged: boolean;
};

type EventHypothesis = Pick<
    DiagnosisEventAuditSnapshot,
    "eventType" | "startYear" | "endYear" | "topYear" | "shiftYears"
>;

const topYear = (event: DiagnosisEvent): number => (
    [...event.rankedYears].sort((left, right) => (
        left.rank - right.rank || right.score - left.score || right.year - left.year
    ))[0]?.year ?? Math.round((event.startYear + event.endYear) / 2)
);

const asHypothesis = (event: DiagnosisEvent): EventHypothesis => ({
    eventType: event.eventType,
    startYear: event.startYear,
    endYear: event.endYear,
    topYear: topYear(event),
    shiftYears: event.shiftYears ?? null,
});

const sameOperation = (left: EventHypothesis, right: EventHypothesis): boolean => (
    left.eventType === right.eventType
    && (
        left.eventType === "missingRing"
        || left.eventType === "falseRing"
        || left.shiftYears === right.shiftYears
    )
);

const sameLocation = (left: EventHypothesis, right: EventHypothesis): boolean => {
    if (left.eventType === "wholeSeriesMove" || right.eventType === "wholeSeriesMove") {
        return left.eventType === right.eventType;
    }
    const overlap = Math.max(left.startYear, right.startYear)
        <= Math.min(left.endYear, right.endYear);
    if (overlap) return true;
    if (left.topYear === null || right.topYear === null) return false;
    return Math.abs(left.topYear - right.topYear) <= 4;
};

const compatibleHypothesis = (
    left: EventHypothesis,
    right: EventHypothesis,
): boolean => sameOperation(left, right) && sameLocation(left, right);

const auditHypotheses = (
    diagnosis: CrossdatingDiagnosis,
    seriesId: string,
): DiagnosisEventAuditSnapshot[] => diagnosis.eventDecisionAudits
    ?.filter((audit) => audit.seriesId === seriesId)
    .flatMap((audit) => [
        ...audit.candidateProjectedEvents,
        ...audit.detectedBeforeFusion,
        ...audit.detectedAfterFusion,
        ...audit.retainedAfterEndpointGuard,
        ...audit.displayedBeforeLocator,
        ...audit.finalEvents,
    ]) ?? [];

const diagnosisSupports = (
    diagnosis: CrossdatingDiagnosis,
    event: DiagnosisEvent,
): boolean => {
    const hypothesis = asHypothesis(event);
    const completeEvents = [
        ...diagnosis.events,
        ...(diagnosis.reviewEvents ?? []),
    ].filter((candidate) => candidate.seriesId === event.seriesId);
    return completeEvents.some((candidate) => (
        compatibleHypothesis(hypothesis, asHypothesis(candidate))
    )) || auditHypotheses(diagnosis, event.seriesId).some((candidate) => (
        compatibleHypothesis(hypothesis, candidate)
    ));
};

const evidenceTokens = (event: DiagnosisEvent): Set<string> => new Set([
    ...event.evidence.algorithmSources,
    ...event.evidence.notes,
]);

const hasToken = (tokens: Set<string>, token: string): boolean => (
    tokens.has(token)
    || [...tokens].some((value) => value.startsWith(`${token}=`))
);

const hasDecisiveOperationEvidence = (
    event: DiagnosisEvent,
    previousEvent: DiagnosisEvent,
): boolean => {
    const tokens = evidenceTokens(event);
    const transition = event.evidence.lagBefore !== null
        && event.evidence.lagAfter !== null
        ? event.evidence.lagAfter - event.evidence.lagBefore
        : null;

    if (event.eventType === "missingRing") {
        const explicitStaircase = hasToken(tokens, "explicit_partial_vs_missing_staircase")
            || hasToken(tokens, "sequential_missing_staircase_head");
        const independentSupport = hasToken(tokens, "robust_per_reference_missing_staircase")
            || hasToken(tokens, "per_reference_intermediate_lag_consensus");
        const fixedSideResolution = hasToken(tokens, "newer_fixed_side_lag_contrast")
            && hasToken(tokens, "terminal_whole_alias_removed");
        const jointDirection = transition === 1
            && hasToken(tokens, "decisive_joint_operation_fusion")
            && hasToken(tokens, "joint_year_operation_evidence");
        if (previousEvent.eventType === "partialMove") {
            return explicitStaircase && independentSupport;
        }
        if (previousEvent.eventType === "wholeSeriesMove") {
            return fixedSideResolution;
        }
        return jointDirection;
    }

    if (event.eventType === "falseRing") {
        return transition === -1
            && hasToken(tokens, "decisive_joint_operation_fusion")
            && hasToken(tokens, "joint_year_operation_evidence");
    }

    if (event.eventType === "partialMove") {
        return (event.shiftYears ?? 0) < -1
            && (
                hasToken(tokens, "negative_partial_multiview_consensus")
                || hasToken(tokens, "candidate_grid_reference_partial_consensus")
                || hasToken(tokens, "completed_partial_preferred_over_discrete_missing_staircase")
            );
    }

    return hasToken(tokens, "whole_state_global_lag_matches_shift")
        && [...tokens].some((value) => value === "whole_state_global_lag_matches_shift=true");
};

const hasDecisiveDetachedLocation = (
    diagnosis: CrossdatingDiagnosis,
    event: DiagnosisEvent,
): boolean => diagnosis.eventDecisionAudits
    ?.filter((audit) => audit.seriesId === event.seriesId)
    .flatMap((audit) => audit.locatorDecisions ?? [])
    .some((decision) => (
        decision.accepted
        && decision.reason === "accepted_detached_strong_mode"
        && compatibleHypothesis(asHypothesis(event), decision.selectedEvent)
    )) ?? false;

const annotateRetainedEvent = (
    event: DiagnosisEvent,
    reason: EvidenceRefreshDecisionReason,
): DiagnosisEvent => ({
    ...event,
    reviewOnly: true,
    stale: false,
    evidence: {
        ...event.evidence,
        algorithmSources: Array.from(new Set([
            ...event.evidence.algorithmSources,
            "evidence_refresh_adjudicator",
        ])).sort(),
        notes: [
            ...event.evidence.notes,
            `evidence_refresh=${reason}`,
        ],
    },
});

const withDisplayedEvent = (
    fresh: CrossdatingDiagnosis,
    seriesId: string,
    event: DiagnosisEvent,
): CrossdatingDiagnosis => ({
    ...fresh,
    reviewEvents: [
        ...(fresh.reviewEvents ?? fresh.events).filter((candidate) => (
            candidate.seriesId !== seriesId
        )),
        event,
    ],
});

export const stabilizeDiagnosisAcrossEvidenceRefresh = (
    previous: CrossdatingDiagnosis,
    fresh: CrossdatingDiagnosis,
    seriesId: string,
): { diagnosis: CrossdatingDiagnosis; decision: EvidenceRefreshDecision } => {
    const previousEvent = getDisplayedDiagnosisEvents(previous).find((event) => (
        event.seriesId === seriesId && !event.stale
    ));
    const freshEvent = getDisplayedDiagnosisEvents(fresh).find((event) => (
        event.seriesId === seriesId && !event.stale
    ));

    if (!previousEvent) {
        return {
            diagnosis: fresh,
            decision: {
                reason: "fresh_only",
                selectedEvidence: "fresh",
                operationChanged: false,
                locationChanged: false,
            },
        };
    }

    if (!freshEvent) {
        const supported = diagnosisSupports(fresh, previousEvent);
        const reason: EvidenceRefreshDecisionReason = supported
            ? "previous_supported_hidden_hypothesis"
            : "fresh_no_supported_replacement";
        if (!supported) {
            return {
                diagnosis: fresh,
                decision: {
                    reason,
                    selectedEvidence: "fresh",
                    operationChanged: false,
                    locationChanged: false,
                },
            };
        }
        return {
            diagnosis: withDisplayedEvent(
                fresh,
                seriesId,
                annotateRetainedEvent(previousEvent, reason),
            ),
            decision: {
                reason,
                selectedEvidence: "previous",
                operationChanged: false,
                locationChanged: false,
            },
        };
    }

    const previousHypothesis = asHypothesis(previousEvent);
    const freshHypothesis = asHypothesis(freshEvent);
    const operationChanged = !sameOperation(previousHypothesis, freshHypothesis);
    const locationChanged = !sameLocation(previousHypothesis, freshHypothesis);
    if (!operationChanged && !locationChanged) {
        return {
            diagnosis: fresh,
            decision: {
                reason: "fresh_compatible_update",
                selectedEvidence: "fresh",
                operationChanged: false,
                locationChanged: false,
            },
        };
    }

    const previousSupportedByFresh = diagnosisSupports(fresh, previousEvent);
    const freshSupportedByPrevious = diagnosisSupports(previous, freshEvent);
    let reason: EvidenceRefreshDecisionReason;
    let selectFresh = false;

    if (operationChanged) {
        if (freshSupportedByPrevious && !previousSupportedByFresh) {
            reason = "fresh_cross_supported_operation";
            selectFresh = true;
        } else if (previousSupportedByFresh && !freshSupportedByPrevious) {
            reason = "previous_cross_supported_operation";
        } else if (hasDecisiveOperationEvidence(freshEvent, previousEvent)) {
            reason = "fresh_decisive_operation_evidence";
            selectFresh = true;
        } else {
            reason = "previous_operation_conflict_retained";
        }
    } else if (freshSupportedByPrevious && !previousSupportedByFresh) {
        reason = "fresh_cross_supported_location";
        selectFresh = true;
    } else if (hasDecisiveDetachedLocation(fresh, freshEvent)) {
        reason = "fresh_decisive_detached_location";
        selectFresh = true;
    } else {
        reason = "previous_detached_location_retained";
    }

    if (selectFresh) {
        return {
            diagnosis: fresh,
            decision: {
                reason,
                selectedEvidence: "fresh",
                operationChanged,
                locationChanged,
            },
        };
    }

    return {
        diagnosis: withDisplayedEvent(
            fresh,
            seriesId,
            annotateRetainedEvent(previousEvent, reason),
        ),
        decision: {
            reason,
            selectedEvidence: "previous",
            operationChanged,
            locationChanged,
        },
    };
};

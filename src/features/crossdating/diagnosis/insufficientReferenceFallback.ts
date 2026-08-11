import type {
    CrossdatingDiagnosis,
    DiagnosisEvent,
    YearRange,
} from "./types";

const pairwiseEndpointEventIsEligible = (
    event: DiagnosisEvent,
    targetRange: YearRange,
): boolean => {
    const newerDistance = targetRange.endYear - event.endYear;
    return event.eventType === "missingRing"
        && newerDistance >= 0
        && newerDistance <= 13
        && event.evidence.lagBefore === -1
        && event.evidence.lagAfter === 0
        && (event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY) >= 0.1
        && event.evidence.samplePairs >= 30
        && event.evidence.algorithmSources.includes(
            "sequential_missing_exhausts_whole_baseline",
        );
};

const numericNote = (
    event: DiagnosisEvent,
    prefix: string,
): number | null => {
    const note = event.evidence.notes.find((entry) => entry.startsWith(prefix));
    if (!note) return null;
    const value = Number(note.slice(prefix.length));
    return Number.isFinite(value) ? value : null;
};

const pairwiseSharedMarkerEventIsEligible = (
    event: DiagnosisEvent,
    targetSeries: ReadonlyMap<number, number | null> | undefined,
): boolean => {
    const markerYear = numericNote(event, "shared_zero_marker_year=");
    const markerSupport = numericNote(event, "shared_zero_marker_support=");
    const markerDistance = numericNote(event, "shared_zero_marker_distance=");
    const weightedSupport = numericNote(
        event,
        "shared_zero_marker_weighted_support=",
    );
    const fixedTailAdvantage = numericNote(
        event,
        "sequential_missing_fixed_tail_advantage=",
    );
    const markerValue = markerYear === null ? undefined : targetSeries?.get(markerYear);
    return event.eventType === "missingRing"
        && event.evidence.lagBefore === -1
        && event.evidence.lagAfter === 0
        && event.evidence.samplePairs >= 100
        && event.evidence.algorithmSources.includes("shared_explicit_zero_marker")
        && event.evidence.algorithmSources.includes("sequential_missing_staircase_head")
        && markerYear !== null
        && (markerSupport ?? Number.NEGATIVE_INFINITY) >= 6
        && (markerDistance ?? Number.POSITIVE_INFINITY) <= 1
        && (weightedSupport ?? Number.NEGATIVE_INFINITY) >= 3
        && (fixedTailAdvantage ?? Number.NEGATIVE_INFINITY) >= 0.25
        && markerValue !== undefined
        && markerValue !== 0;
};

/** Keeps the primary diagnosis unless one independently verified pairwise fallback applies. */
export const selectInsufficientReferencePairwiseFallback = (
    primary: CrossdatingDiagnosis,
    pairwise: CrossdatingDiagnosis,
    targetSeries?: ReadonlyMap<number, number | null>,
): CrossdatingDiagnosis => {
    if ((primary.reviewEvents?.length ?? 0) > 0) return primary;
    const primaryAudit = primary.eventDecisionAudits?.[0];
    const pairwiseAudit = pairwise.eventDecisionAudits?.[0];
    const pairwiseDecision = pairwise.jointEventDecisions?.[0];
    const pairwiseEvent = pairwise.reviewEvents?.[0];
    if (!primaryAudit?.cofechaFlagged
        || !primaryAudit.targetRange
        || pairwiseAudit?.seriesId !== primaryAudit.seriesId
        || pairwiseDecision?.status !== "selected"
        || !pairwiseEvent) {
        return primary;
    }
    const zeroDepthEndpoint = primaryAudit.finalReason
        === "insufficient_reference_depth"
        && pairwiseEndpointEventIsEligible(pairwiseEvent, primaryAudit.targetRange);
    const rejectedPartialAlias = primary.reviewWindowDecisions?.[0]?.reason
        === "partial_move_evidence_insufficient"
        && pairwiseSharedMarkerEventIsEligible(pairwiseEvent, targetSeries);
    if (!zeroDepthEndpoint && !rejectedPartialAlias) return primary;
    return pairwise;
};

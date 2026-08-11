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

/** Keeps the primary diagnosis unless a zero-depth refusal has one safe endpoint fallback. */
export const selectInsufficientReferencePairwiseFallback = (
    primary: CrossdatingDiagnosis,
    pairwise: CrossdatingDiagnosis,
): CrossdatingDiagnosis => {
    if ((primary.reviewEvents?.length ?? 0) > 0) return primary;
    const primaryAudit = primary.eventDecisionAudits?.[0];
    const pairwiseAudit = pairwise.eventDecisionAudits?.[0];
    const pairwiseDecision = pairwise.jointEventDecisions?.[0];
    const pairwiseEvent = pairwise.reviewEvents?.[0];
    if (primaryAudit?.finalReason !== "insufficient_reference_depth"
        || !primaryAudit.cofechaFlagged
        || !primaryAudit.targetRange
        || pairwiseAudit?.seriesId !== primaryAudit.seriesId
        || pairwiseDecision?.status !== "selected"
        || !pairwiseEvent
        || !pairwiseEndpointEventIsEligible(
            pairwiseEvent,
            primaryAudit.targetRange,
        )) {
        return primary;
    }
    return pairwise;
};

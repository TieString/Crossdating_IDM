export * from "./diagnosis/types";
export { CrossdateConfig } from "./diagnosis/config";
export {
    DEFAULT_MAX_PARTIAL_GAP_YEARS,
    MAX_SUPPORTED_PARTIAL_GAP_YEARS,
    MIN_PARTIAL_GAP_YEARS,
    firstFixedYearFromLastMovedYear,
    getAutomaticEventShiftCandidates,
    getAutomaticPartialShiftCandidates,
    getEffectiveMaxPartialGapYears,
    isAutomaticPartialShift,
    isNegativePartialShift,
    lastMovedYearFromFirstFixedYear,
    partialMoveBreakpoint,
} from "./diagnosis/partialMoveSemantics";
export { runLocalEditAlignment } from "./diagnosis/localEditAlignment";
export { runGlobalSlidingMatch } from "./diagnosis/sliding";
export {
    planDiagnosisEventEdit,
    type DiagnosisEventEditPlan,
} from "./diagnosis/eventApply";
export {
    eventAtLocationAlternative,
} from "./diagnosis/eventLocationAlternatives";
export { getDisplayedDiagnosisEvents } from "./diagnosis/eventDisplay";
export {
    projectActiveDiagnosisEventInterpretation,
    refreshActiveDiagnosisEventInterpretation,
} from "./diagnosis/activeEventInterpretation";
export {
    stabilizeDiagnosisAcrossEvidenceRefresh,
    type EvidenceRefreshDecision,
    type EvidenceRefreshDecisionReason,
} from "./diagnosis/evidenceRefreshAdjudicator";
export {
    applyLocalCrossdatingOption,
    diagnoseCrossdating,
    getDiagnosisCandidateLabel,
    isActionableDiagnosisCandidate,
    markCandidatesStale,
    markDiagnosisEventsStale,
    rankDiagnosisCandidates,
    selectSafeDiagnosisCandidateBatch,
    simulateDiagnosisEventPreview,
} from "./diagnosis/engine";

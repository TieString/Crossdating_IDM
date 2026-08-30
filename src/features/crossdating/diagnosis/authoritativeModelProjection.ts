import type {
    AuthoritativeDiagnosisDecision,
    CrossdatingDiagnosis,
    DiagnosisEvent,
} from "./types";

const effectiveShift = (event: DiagnosisEvent): number => {
    if (event.eventType === "missingRing") return -1;
    if (event.eventType === "falseRing") return 1;
    return event.shiftYears ?? 0;
};

const topYear = (event: DiagnosisEvent): number | null => (
    [...event.rankedYears].sort((left, right) => left.rank - right.rank)[0]?.year ?? null
);

const executablePackageMatchesDecision = (
    decision: AuthoritativeDiagnosisDecision,
    event: DiagnosisEvent,
    seriesId: string,
): boolean => decision.status === "selected"
    && decision.eventType !== "noEvent"
    && event.seriesId === seriesId
    && event.id === decision.packageId
    && event.eventType === decision.eventType
    && effectiveShift(event) === decision.shiftYears
    && event.startYear === decision.startYear
    && event.endYear === decision.endYear
    && topYear(event) === decision.topYear;

/**
 * Makes the online model the sole owner of the final answer. The legacy diagnosis
 * may supply evidence packages, but it is never used to reconstruct or repair a
 * selected operation, shift or window after model inference.
 */
export const applyAuthoritativeModelDecision = (
    diagnosis: CrossdatingDiagnosis,
    decision: AuthoritativeDiagnosisDecision,
    seriesId: string,
    executableEvent: DiagnosisEvent | null = null,
): CrossdatingDiagnosis => {
    const selected = executableEvent
        && executablePackageMatchesDecision(decision, executableEvent, seriesId)
        ? executableEvent
        : null;
    const events = selected ? [selected] : [];
    const selectedWithoutPackage = decision.status === "selected" && !selected;
    return {
        ...diagnosis,
        eventCount: events.length,
        events,
        reviewEvents: events,
        reviewWindowDecisions: [],
        authoritativeModelDecision: selectedWithoutPackage
            ? {
                ...decision,
                status: "error",
                refusalReason: "online_executable_package_contract_mismatch",
            }
            : decision,
    };
};

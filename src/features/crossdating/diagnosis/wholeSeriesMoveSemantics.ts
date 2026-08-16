/**
 * Returns the executable whole-series correction, keeping it separate from the observed
 * dominant lag. Mixed local events can make those two values differ by one or more years.
 */
import type { DiagnosisEvent } from "./types";

export const wholeSeriesMoveShiftYears = (
    event: DiagnosisEvent | null | undefined,
): number | null => {
    if (!event || event.eventType !== "wholeSeriesMove") return null;
    const explicitShift = event.shiftYears;
    if (explicitShift !== undefined && Number.isFinite(explicitShift) && explicitShift !== 0) {
        return explicitShift;
    }
    const legacyLag = event.evidence.lagBefore;
    return legacyLag !== null && Number.isFinite(legacyLag) && legacyLag !== 0
        ? legacyLag
        : null;
};

/** Automatic diagnosis only models whole-series corrections toward older years. */
export const isAllowedAutomaticDiagnosisEvent = (
    event: DiagnosisEvent,
): boolean => {
    if (event.eventType !== "wholeSeriesMove") return true;
    const shiftYears = wholeSeriesMoveShiftYears(event);
    return shiftYears !== null && shiftYears < 0;
};

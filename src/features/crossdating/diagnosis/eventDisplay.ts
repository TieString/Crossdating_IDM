import type { CrossdatingDiagnosis, DiagnosisEvent } from "./types";

/**
 * Review-mode diagnoses keep the strict automatic result in `events` and expose the
 * lower display-gate result separately. User-facing surfaces must use one source so
 * the list, chart highlight, and click preview cannot disagree about the active window.
 */
export const getDisplayedDiagnosisEvents = (
    diagnosis: CrossdatingDiagnosis | null | undefined,
): DiagnosisEvent[] => diagnosis?.reviewEvents ?? diagnosis?.events ?? [];

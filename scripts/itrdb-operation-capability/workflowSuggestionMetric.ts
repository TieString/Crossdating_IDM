import type { DiagnosisEvent } from "@/features/crossdating/diagnosis/types";
import type { CapabilityTruth } from "./types";

export type WorkflowSuggestionInterpretation = "primary" | "alternative";

export type WorkflowSuggestionMatch = {
    interpretation: WorkflowSuggestionInterpretation;
    event: DiagnosisEvent;
    truth: CapabilityTruth;
};

export const diagnosisShiftYears = (event: DiagnosisEvent): number => (
    event.eventType === "missingRing"
        ? -1
        : event.eventType === "falseRing"
            ? 1
            : event.shiftYears ?? event.evidence.lagBefore ?? 0
);

const coversLocalTruth = (
    event: DiagnosisEvent,
    truth: CapabilityTruth,
): boolean => truth.year !== null
    && truth.year >= event.startYear
    && truth.year <= event.endYear;

const matchesLocalTruth = (
    event: DiagnosisEvent,
    truth: CapabilityTruth,
): boolean => truth.eventType !== "wholeSeriesMove"
    && event.eventType === truth.eventType
    && diagnosisShiftYears(event) === truth.shiftYears
    && coversLocalTruth(event, truth);

const matchesWholeTruth = (
    event: DiagnosisEvent,
    truth: CapabilityTruth,
): boolean => truth.eventType === "wholeSeriesMove"
    && truth.shiftYears < 0
    && event.eventType === "wholeSeriesMove"
    && diagnosisShiftYears(event) === truth.shiftYears;

/**
 * Scores the complete user-facing suggestion at the current diagnostic frontier.
 * Whole-series moves must be the primary exact negative operation. Local ambiguity
 * may use the independently validated alternative interpretation, but still needs
 * the exact operation/shift and a window that covers the frontier truth.
 */
export const matchWorkflowSuggestion = (
    primary: DiagnosisEvent | null,
    alternative: DiagnosisEvent | null,
    frontierTruths: readonly CapabilityTruth[],
): WorkflowSuggestionMatch | null => {
    if (primary) {
        const wholeTruth = frontierTruths.find((truth) => (
            matchesWholeTruth(primary, truth)
        ));
        if (wholeTruth) {
            return { interpretation: "primary", event: primary, truth: wholeTruth };
        }
        const localTruth = frontierTruths.find((truth) => (
            matchesLocalTruth(primary, truth)
        ));
        if (localTruth) {
            return { interpretation: "primary", event: primary, truth: localTruth };
        }
    }
    if (alternative && alternative.eventType !== "wholeSeriesMove") {
        const localTruth = frontierTruths.find((truth) => (
            matchesLocalTruth(alternative, truth)
        ));
        if (localTruth) {
            return { interpretation: "alternative", event: alternative, truth: localTruth };
        }
    }
    return null;
};

export const countWorkflowSuggestionAttempts = (
    attempts: readonly { workflowSuggestionCorrect: boolean }[],
): { numerator: number; denominator: number } => ({
    numerator: attempts.filter((attempt) => attempt.workflowSuggestionCorrect).length,
    denominator: attempts.length,
});

import type { DiagnosisEvent } from "@/features/crossdating/diagnosis/types";
import type { CapabilityTruth } from "./types";

export type WorkflowSuggestionInterpretation = "primary" | "alternative";

export type WorkflowSuggestionMatch = {
    interpretation: WorkflowSuggestionInterpretation;
    event: DiagnosisEvent;
    truth: CapabilityTruth;
    reviewPath: CapabilityTruth["eventType"][];
    transitiveReview: boolean;
};

export type HumanRescueAttempt = {
    workflowSuggestionCorrect: boolean;
    diagnosedTruthId: string | null;
    humanRescueApplied: boolean;
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
    requireWindow: boolean,
): boolean => truth.eventType !== "wholeSeriesMove"
    && event.eventType === truth.eventType
    && diagnosisShiftYears(event) === truth.shiftYears
    && (!requireWindow || coversLocalTruth(event, truth));

const matchesWholeTruth = (
    event: DiagnosisEvent,
    truth: CapabilityTruth,
): boolean => truth.eventType === "wholeSeriesMove"
    && truth.shiftYears < 0
    && event.eventType === "wholeSeriesMove"
    && diagnosisShiftYears(event) === truth.shiftYears;

const missingReviewFromPartial = (event: DiagnosisEvent): DiagnosisEvent | null => (
    event.eventType === "partialMove"
    && event.shiftSide === "older"
    && diagnosisShiftYears(event) <= -2
        ? {
                ...event,
                id: `${event.id}-evaluated-missing-review`,
                eventType: "missingRing",
                shiftYears: undefined,
                shiftSide: undefined,
                interpretationAmbiguity: undefined,
            }
        : null
);

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
    options: { requireWindow?: boolean } = {},
): WorkflowSuggestionMatch | null => {
    const requireWindow = options.requireWindow ?? true;
    const reviewedPrimary = primary ? missingReviewFromPartial(primary) : null;
    const reviewedAlternative = alternative ? missingReviewFromPartial(alternative) : null;
    const candidates: Array<{
        interpretation: WorkflowSuggestionInterpretation;
        event: DiagnosisEvent;
        reviewPath: CapabilityTruth["eventType"][];
        transitiveReview: boolean;
    }> = [
        ...(primary ? [{
            interpretation: "primary" as const,
            event: primary,
            reviewPath: [primary.eventType],
            transitiveReview: false,
        }] : []),
        ...(alternative && alternative.eventType !== "wholeSeriesMove" ? [{
            interpretation: "alternative" as const,
            event: alternative,
            reviewPath: primary
                ? [primary.eventType, alternative.eventType]
                : [alternative.eventType],
            transitiveReview: false,
        }] : []),
        ...(reviewedPrimary ? [{
            interpretation: "alternative" as const,
            event: reviewedPrimary,
            reviewPath: [primary!.eventType, "missingRing" as const],
            transitiveReview: true,
        }] : []),
        ...(reviewedAlternative ? [{
            interpretation: "alternative" as const,
            event: reviewedAlternative,
            reviewPath: primary
                ? [primary.eventType, alternative!.eventType, "missingRing" as const]
                : [alternative!.eventType, "missingRing" as const],
            transitiveReview: true,
        }] : []),
    ];
    for (const candidate of candidates) {
        const truth = frontierTruths.find((frontierTruth) => (
            matchesWholeTruth(candidate.event, frontierTruth)
            || matchesLocalTruth(candidate.event, frontierTruth, requireWindow)
        ));
        if (truth) return { ...candidate, truth };
    }
    return null;
};

export const countWorkflowSuggestionAttempts = (
    attempts: readonly { workflowSuggestionCorrect: boolean }[],
): { numerator: number; denominator: number } => ({
    numerator: attempts.filter((attempt) => attempt.workflowSuggestionCorrect).length,
    denominator: attempts.length,
});

/** Selects only the current blocked truth; hidden later truths are never consulted. */
export const selectHumanRescueTruth = (
    frontierTruths: readonly CapabilityTruth[],
    primaryOperationTruth: CapabilityTruth | null,
    alternativeOperationTruth: CapabilityTruth | null,
    workflowOperationTruth: CapabilityTruth | null = null,
): CapabilityTruth | null => primaryOperationTruth
    ?? alternativeOperationTruth
    ?? workflowOperationTruth
    ?? frontierTruths[0]
    ?? null;

export const countHumanAssistedFullEventSuggestions = (
    attempts: readonly HumanRescueAttempt[],
    totalTruthEvents: number,
) => {
    const opportunities = attempts.filter((attempt) => (
        attempt.diagnosedTruthId !== null
    ));
    return {
        correctSuggestions: opportunities.filter((attempt) => (
            attempt.workflowSuggestionCorrect
        )).length,
        humanRescues: opportunities.filter((attempt) => (
            attempt.humanRescueApplied
        )).length,
        opportunities: opportunities.length,
        totalTruthEvents,
    };
};

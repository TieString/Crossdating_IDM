/** Review-only ambiguity between a terminal whole-series -1..-3 lag and one next missing-ring step. */
import type {
    DiagnosisEvent,
    DiagnosisWholeMissingInterpretationEvidence,
} from "./types";

export const attachEndpointWholeMissingInterpretation = (
    whole: DiagnosisEvent,
    missing: DiagnosisEvent,
    evidence: DiagnosisWholeMissingInterpretationEvidence,
): DiagnosisEvent => ({
    ...whole,
    interpretationAmbiguity: {
        kind: "wholeSeriesMoveOrMissingRing",
        alternative: {
            ...missing,
            interpretationAmbiguity: undefined,
            stale: whole.stale || missing.stale ? true : undefined,
            evidence: {
                ...missing.evidence,
                algorithmSources: Array.from(new Set([
                    ...missing.evidence.algorithmSources,
                    "endpoint_whole_missing_interpretation_tie",
                ])).sort(),
                notes: Array.from(new Set([
                    ...missing.evidence.notes,
                    "interpretation=endpoint_missing_ring",
                    `endpoint_whole_missing_distance=${evidence.endpointDistanceYears}`,
                    `endpoint_whole_missing_operation_margin=${
                        evidence.operationScoreMargin?.toFixed(6) ?? "none"
                    }`,
                ])),
            },
        },
        evidence,
    },
});

import { describe, expect, it } from "vitest";
import { selectInsufficientReferencePairwiseFallback } from "../insufficientReferenceFallback";
import type {
    CrossdatingDiagnosis,
    DiagnosisEvent,
    DiagnosisEventDecisionAudit,
} from "../types";

const event = (): DiagnosisEvent => ({
    id: "pairwise-endpoint",
    seriesId: "TARGET",
    eventType: "missingRing",
    startYear: 1978,
    endYear: 1990,
    rankedYears: [{ year: 1984, rank: 1, score: 1, evidenceTags: [] }],
    confidenceLevel: "low",
    alternativeTypes: [],
    evidence: {
        algorithmSources: [
            "sequential_missing_exhausts_whole_baseline",
            "sequential_missing_staircase_head",
        ],
        score: 1,
        scoreMargin: 1,
        baselineCorrelation: 0.1,
        correctedCorrelation: 0.4,
        correlationGain: 0.3,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 100,
        candidateIds: [],
        notes: [],
    },
});

const audit = (
    finalReason: DiagnosisEventDecisionAudit["finalReason"],
): DiagnosisEventDecisionAudit => ({
    seriesId: "TARGET",
    targetRange: { startYear: 1500, endYear: 1997 },
    cofechaFlagged: true,
    referenceSourceCount: 0,
    minimumReferenceDepth: 0,
    medianReferenceDepth: 0,
    candidateCount: 0,
    candidateModeCount: 0,
    candidates: [],
    pass: {
        selectedReferencePass: "primary",
        cofechaDiagnosisAvailable: false,
        candidateEventCount: 0,
        lagPathEventCount: 0,
        rawLagPathEventCount: 0,
        assembledEventCount: 0,
        jointRefinedEventCount: 0,
        referenceVotedEventCount: 0,
        recoveredEventCount: 0,
        finalEventCount: 0,
    },
    candidateProjectedEvents: [],
    detectedBeforeFusion: [],
    detectedAfterFusion: [],
    retainedAfterEndpointGuard: [],
    displayedBeforeLocator: [],
    finalEvents: [],
    automaticSemanticsRejectedCount: 0,
    finalReason,
});

const diagnosis = ({
    reviewEvent = null,
    finalReason = "insufficient_reference_depth",
    selected = false,
    reviewReason = "insufficient_reference_support",
}: {
    reviewEvent?: DiagnosisEvent | null;
    finalReason?: DiagnosisEventDecisionAudit["finalReason"];
    selected?: boolean;
    reviewReason?: "insufficient_reference_support" | "partial_move_evidence_insufficient";
} = {}): CrossdatingDiagnosis => ({
    reviewEvents: reviewEvent ? [reviewEvent] : [],
    eventDecisionAudits: [audit(finalReason)],
    jointEventDecisions: [{ status: selected ? "selected" : "refused" }],
    reviewWindowDecisions: [{
        seriesId: "TARGET",
        status: reviewEvent ? "review" : "refused",
        reason: reviewEvent ? "lower_display_gate_passed" : reviewReason,
        strictReason: finalReason,
        sourceStage: reviewEvent ? "final" : null,
        event: reviewEvent,
    }],
} as unknown as CrossdatingDiagnosis);

const sharedMarkerEvent = (): DiagnosisEvent => {
    const result = event();
    result.startYear = 1579;
    result.endYear = 1587;
    result.rankedYears = [{ year: 1585, rank: 1, score: 1, evidenceTags: [] }];
    result.evidence.algorithmSources = [
        "sequential_missing_staircase_head",
        "shared_explicit_zero_marker",
    ];
    result.evidence.samplePairs = 559;
    result.evidence.notes = [
        "shared_zero_marker_year=1585",
        "shared_zero_marker_support=8",
        "shared_zero_marker_distance=1",
        "shared_zero_marker_weighted_support=4.000000",
        "sequential_missing_fixed_tail_advantage=0.316325",
    ];
    return result;
};

describe("insufficient-reference pairwise fallback", () => {
    it("uses one verified endpoint unit event after a zero-depth refusal", () => {
        const primary = diagnosis();
        const pairwise = diagnosis({ reviewEvent: event(), selected: true });

        expect(selectInsufficientReferencePairwiseFallback(
            primary,
            pairwise,
        )).toBe(pairwise);
    });

    it("never replaces an existing primary review event", () => {
        const primary = diagnosis({ reviewEvent: event(), selected: true });
        const pairwise = diagnosis({ reviewEvent: event(), selected: true });

        expect(selectInsufficientReferencePairwiseFallback(
            primary,
            pairwise,
        )).toBe(primary);
    });

    it("does not use a remote pairwise window", () => {
        const primary = diagnosis();
        const remote = event();
        remote.startYear = 1850;
        remote.endYear = 1862;
        const pairwise = diagnosis({ reviewEvent: remote, selected: true });

        expect(selectInsufficientReferencePairwiseFallback(
            primary,
            pairwise,
        )).toBe(primary);
    });

    it("requires fixed-side evidence that exhausts the whole lag alias", () => {
        const primary = diagnosis();
        const unverified = event();
        unverified.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        const pairwise = diagnosis({ reviewEvent: unverified, selected: true });

        expect(selectInsufficientReferencePairwiseFallback(
            primary,
            pairwise,
        )).toBe(primary);
    });

    it("does not handle refusals caused by another decision layer", () => {
        const primary = diagnosis({ finalReason: "operation_fusion_rejected" });
        const pairwise = diagnosis({ reviewEvent: event(), selected: true });

        expect(selectInsufficientReferencePairwiseFallback(
            primary,
            pairwise,
        )).toBe(primary);
    });

    it("recovers a refused partial alias from a strongly shared missing marker", () => {
        const primary = diagnosis({
            finalReason: "emitted",
            reviewReason: "partial_move_evidence_insufficient",
        });
        const pairwise = diagnosis({ reviewEvent: sharedMarkerEvent(), selected: true });
        const target = new Map([[1585, 87]]);

        expect(selectInsufficientReferencePairwiseFallback(
            primary,
            pairwise,
            target,
        )).toBe(pairwise);
    });

    it("does not revisit an explicit zero that was already restored", () => {
        const primary = diagnosis({
            finalReason: "emitted",
            reviewReason: "partial_move_evidence_insufficient",
        });
        const pairwise = diagnosis({ reviewEvent: sharedMarkerEvent(), selected: true });

        expect(selectInsufficientReferencePairwiseFallback(
            primary,
            pairwise,
            new Map([[1585, 0]]),
        )).toBe(primary);
    });

    it("keeps refusing weak shared-marker support", () => {
        const primary = diagnosis({
            finalReason: "emitted",
            reviewReason: "partial_move_evidence_insufficient",
        });
        const weak = sharedMarkerEvent();
        weak.evidence.notes = weak.evidence.notes.map((note) => (
            note === "shared_zero_marker_support=8"
                ? "shared_zero_marker_support=5"
                : note
        ));
        const pairwise = diagnosis({ reviewEvent: weak, selected: true });

        expect(selectInsufficientReferencePairwiseFallback(
            primary,
            pairwise,
            new Map([[1585, 87]]),
        )).toBe(primary);
    });
});

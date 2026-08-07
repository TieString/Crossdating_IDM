import { describe, expect, it } from "vitest";
import {
    buildReviewWindowDisplays,
    selectReviewWindowDisplay,
} from "../reviewWindowDisplay";
import type {
    DiagnosisEvent,
    DiagnosisEventAuditSnapshot,
    DiagnosisEventDecisionAudit,
} from "../types";

const snapshot = (
    eventType: DiagnosisEventAuditSnapshot["eventType"],
    startYear = 1897,
    endYear = 1903,
    score = 1,
): DiagnosisEventAuditSnapshot => ({
    eventType,
    startYear,
    endYear,
    topYear: 1900,
    shiftYears: eventType === "partialMove" ? -2 : null,
    confidenceLevel: "medium",
    score,
    scoreMargin: 0.1,
    lagBefore: eventType === "missingRing" ? -1 : eventType === "falseRing" ? 1 : -2,
    lagAfter: 0,
    samplePairs: 40,
    baselineCorrelation: 0.3,
    correctedCorrelation: 0.5,
    correlationGain: 0.2,
    algorithmSources: ["test"],
    notes: [],
});

const audit = (
    candidates: DiagnosisEventAuditSnapshot[],
    overrides: Partial<DiagnosisEventDecisionAudit> = {},
): DiagnosisEventDecisionAudit => ({
    seriesId: "T",
    targetRange: { startYear: 1800, endYear: 2000 },
    cofechaFlagged: true,
    referenceSourceCount: 6,
    minimumReferenceDepth: 4,
    medianReferenceDepth: 5,
    candidateCount: candidates.length,
    candidateModeCount: candidates.length,
    candidates: [],
    pass: {
        selectedReferencePass: "primary",
        cofechaDiagnosisAvailable: true,
        candidateEventCount: candidates.length,
        lagPathEventCount: 0,
        rawLagPathEventCount: 0,
        assembledEventCount: 0,
        jointRefinedEventCount: 0,
        referenceVotedEventCount: 0,
        recoveredEventCount: 0,
        finalEventCount: 0,
    },
    candidateProjectedEvents: candidates,
    detectedBeforeFusion: [],
    detectedAfterFusion: [],
    retainedAfterEndpointGuard: [],
    displayedBeforeLocator: [],
    finalEvents: [],
    automaticSemanticsRejectedCount: 0,
    finalReason: "ensemble_gate_rejected",
    ...overrides,
});

const strictEvent = (): DiagnosisEvent => ({
    id: "strict",
    seriesId: "T",
    eventType: "missingRing",
    startYear: 1898,
    endYear: 1902,
    rankedYears: [{ year: 1900, rank: 1, score: 1, evidenceTags: [] }],
    confidenceLevel: "high",
    evidence: {
        algorithmSources: ["strict"],
        score: 1,
        scoreMargin: 0.2,
        baselineCorrelation: 0.3,
        correctedCorrelation: 0.5,
        correlationGain: 0.2,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 40,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
});

const reviewablePartial = (
    shiftYears = -2,
    evidence: Partial<DiagnosisEvent["evidence"]> = {},
): DiagnosisEvent => ({
    ...strictEvent(),
    eventType: "partialMove",
    shiftYears,
    shiftSide: "older",
    evidence: {
        ...strictEvent().evidence,
        lagBefore: shiftYears,
        lagAfter: 0,
        correlationGain: 0,
        algorithmSources: ["full_interval_counterfactual_locator"],
        notes: [
            `counterfactual_correction_years=${shiftYears}`,
            "partial_reference_vote_year=1900",
            `partial_reference_vote_shift=${shiftYears}`,
            "partial_reference_vote_gain=0.08",
        ],
        ...evidence,
    },
});

describe("lower review-window display gate", () => {
    it("keeps an existing strict event unchanged", () => {
        const strict = strictEvent();
        const result = selectReviewWindowDisplay(audit([]), [strict]);
        expect(result).toMatchObject({
            status: "strict",
            reason: "strict_event",
            sourceStage: "final",
        });
        expect(result.event).toBe(strict);
    });

    it("keeps a strict partial move in the display layer", () => {
        const partial = reviewablePartial();
        const result = selectReviewWindowDisplay(audit([
            snapshot("missingRing"),
        ]), [partial]);
        expect(result).toMatchObject({
            status: "strict",
            reason: "strict_event",
            event: partial,
        });
    });

    it("shows an independent whole-series baseline before its local partial", () => {
        const partial = reviewablePartial(-4, {
            correlationGain: 0.12,
            algorithmSources: ["decisive_joint_operation_fusion"],
            notes: [
                "counterfactual_correction_years=-4",
                "joint_operation_correction=-4",
                "joint_operation_best_difference_gain=0.12",
            ],
        });
        const whole = {
            ...strictEvent(),
            id: "whole",
            eventType: "wholeSeriesMove" as const,
            startYear: 1800,
            endYear: 2000,
        };
        const result = selectReviewWindowDisplay(audit([]), [whole, partial]);

        expect(result).toMatchObject({
            status: "strict",
            reason: "strict_event",
            event: whole,
        });
    });

    it("shows an independent whole-series baseline before a local unit event", () => {
        const unit = strictEvent();
        const whole = {
            ...strictEvent(),
            id: "whole-before-unit",
            eventType: "wholeSeriesMove" as const,
            shiftYears: -5,
            startYear: 1800,
            endYear: 2000,
        };

        expect(selectReviewWindowDisplay(audit([]), [unit, whole])).toMatchObject({
            status: "strict",
            reason: "strict_event",
            event: whole,
        });
    });

    it("falls back to an independent whole move when a local partial is not reviewable", () => {
        const partial = reviewablePartial(-4, {
            correlationGain: 0,
            algorithmSources: ["piecewise_lag_path"],
            notes: [
                "partial_reference_vote_shift=-30",
                "partial_exhaustive_vote_shift=-40",
            ],
        });
        const whole = {
            ...strictEvent(),
            id: "whole-fallback",
            eventType: "wholeSeriesMove" as const,
            startYear: 1800,
            endYear: 2000,
        };

        expect(selectReviewWindowDisplay(audit([]), [whole, partial]))
            .toMatchObject({
                status: "strict",
                reason: "strict_event",
                event: whole,
            });
    });

    it("keeps a high-gain reference-core partial without a per-shift vote", () => {
        const partial = reviewablePartial(-50, {
            correlationGain: 0.18,
            algorithmSources: ["full_interval_counterfactual_locator", "reference_core_voting"],
            notes: [
                "counterfactual_correction_years=-50",
                "reference_vote_year=1900",
                "reference_vote_gain=0.18",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "strict",
            event: partial,
        });
    });

    it("keeps a partial boundary supported by five independent local views", () => {
        const partial = reviewablePartial(-4, {
            correlationGain: 0,
            algorithmSources: [
                "full_interval_counterfactual_locator",
                "negative_partial_multiview_consensus",
                "piecewise_lag_path",
            ],
            notes: [
                "counterfactual_correction_years=-4",
                "partial_consensus_year=1900",
                "partial_consensus_support=5",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "strict",
            event: partial,
        });
    });

    it("refuses a lag-path partial when independent votes choose unrelated shifts", () => {
        const partial = reviewablePartial(-4, {
            score: 17.85,
            scoreMargin: 0.28,
            correlationGain: 0,
            algorithmSources: [
                "full_interval_counterfactual_locator",
                "piecewise_lag_path",
            ],
            notes: [
                "counterfactual_correction_years=-4",
                "partial_reference_vote_year=1943",
                "partial_reference_vote_shift=-99",
                "partial_reference_vote_gain=0.003",
                "partial_exhaustive_vote_year=1878",
                "partial_exhaustive_vote_shift=-93",
                "partial_exhaustive_vote_gain=0.030",
            ],
        });
        const result = selectReviewWindowDisplay(audit([]), [partial]);

        expect(result).toMatchObject({
            status: "refused",
            reason: "partial_move_evidence_insufficient",
            event: null,
        });
        expect(partial.evidence.score).toBe(17.85);
    });

    it("does not hide a strict whole-series move because it has no narrow window", () => {
        const whole = {
            ...strictEvent(),
            eventType: "wholeSeriesMove" as const,
            startYear: 1800,
            endYear: 2000,
        };
        const result = selectReviewWindowDisplay(audit([]), [whole]);

        expect(result).toMatchObject({
            status: "strict",
            reason: "strict_event",
            event: whole,
        });
    });

    it("recovers one review-only missing-ring window with no alternatives", () => {
        const result = selectReviewWindowDisplay(audit([
            snapshot("missingRing"),
        ]), []);
        expect(result).toMatchObject({
            status: "review",
            reason: "lower_display_gate_passed",
            sourceStage: "candidate",
        });
        expect(result.event).toMatchObject({
            eventType: "missingRing",
            startYear: 1897,
            endYear: 1903,
            reviewOnly: true,
            alternativeTypes: [],
        });
        expect(result.event?.rankedYears[0].year).toBe(1900);
        expect(result.event?.evidence.notes).toContain("review_only=true");
    });

    it("does not lower the gate for unflagged, partial, or direction-conflicted evidence", () => {
        expect(selectReviewWindowDisplay(audit([
            snapshot("missingRing"),
        ], { cofechaFlagged: false }), []).reason).toBe("cofecha_target_unflagged");
        expect(selectReviewWindowDisplay(audit([
            snapshot("partialMove"),
        ]), []).reason).toBe("no_unit_hypothesis");
        expect(selectReviewWindowDisplay(audit([{
            ...snapshot("missingRing"),
            lagBefore: 1,
            lagAfter: 0,
        }]), []).reason).toBe("lag_direction_conflict");
    });

    it("rejects unresolved operation and remote-mode competition", () => {
        expect(selectReviewWindowDisplay(audit([
            snapshot("missingRing"),
            snapshot("falseRing"),
        ]), []).reason).toBe("operation_type_conflict");

        const remote = {
            ...snapshot("missingRing", 1937, 1943),
            topYear: 1940,
        };
        expect(selectReviewWindowDisplay(audit([
            snapshot("missingRing"),
            remote,
        ]), []).reason).toBe("competing_remote_modes");
    });

    it("uses only 5, 7, 9, or 13-year windows", () => {
        const decisions = [
            snapshot("missingRing", 1898, 1902),
            snapshot("missingRing", 1897, 1902),
            snapshot("missingRing", 1896, 1904),
            snapshot("missingRing", 1895, 1904),
        ].map((candidate, index) => selectReviewWindowDisplay(
            audit([candidate], { seriesId: `T${index}` }),
            [],
        ));
        expect(decisions.map((row) => (
            row.event ? row.event.endYear - row.event.startYear + 1 : null
        ))).toEqual([5, 7, 9, 13]);
        expect(buildReviewWindowDisplays(
            decisions.map((_, index) => audit([
                snapshot("missingRing"),
            ], { seriesId: `T${index}` })),
            [],
        ).events).toHaveLength(4);
    });
});

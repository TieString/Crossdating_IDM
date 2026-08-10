import { describe, expect, it } from "vitest";
import {
    buildReviewWindowDisplays,
    selectReviewWindowDisplay,
} from "../reviewWindowDisplay";
import type {
    DiagnosisEvent,
    DiagnosisEventAuditSnapshot,
    DiagnosisEventDecisionAudit,
    DiagnosisJointEventDecision,
    DiagnosisReviewEventCheckpoint,
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

const checkpoint = (
    source: DiagnosisEventAuditSnapshot,
    stage: DiagnosisReviewEventCheckpoint["stage"] = "candidate",
): DiagnosisReviewEventCheckpoint => ({
    stage,
    event: {
        ...strictEvent(),
        id: `checkpoint-${source.eventType}-${source.startYear}-${source.endYear}`,
        eventType: source.eventType,
        startYear: source.startYear,
        endYear: source.endYear,
        rankedYears: source.topYear === null ? [] : [{
            year: source.topYear,
            rank: 1,
            score: source.score,
            evidenceTags: ["upstream_ranked_evidence"],
        }],
        confidenceLevel: source.confidenceLevel,
        evidence: {
            algorithmSources: [...source.algorithmSources],
            score: source.score,
            scoreMargin: source.scoreMargin,
            baselineCorrelation: source.baselineCorrelation,
            correctedCorrelation: source.correctedCorrelation,
            correlationGain: source.correlationGain,
            lagBefore: source.lagBefore,
            lagAfter: source.lagAfter,
            samplePairs: source.samplePairs,
            candidateIds: ["upstream-candidate"],
            notes: [...source.notes],
        },
        shiftYears: source.shiftYears ?? undefined,
        shiftSide: source.eventType === "partialMove" ? "older" : undefined,
    },
});

const jointDecision = (
    event: DiagnosisEvent | null,
    sourceStage: DiagnosisJointEventDecision["sourceStage"] = "final",
): DiagnosisJointEventDecision => ({
    seriesId: "T",
    status: event ? "selected" : "refused",
    reason: event ? "selected" : "operation_conflict",
    sourceStage: event ? sourceStage : null,
    event,
    hypotheses: [],
    operationMargin: event ? 0.2 : 0,
    remoteModeMargin: null,
    productionAgreement: "same",
    productionExactMatch: true,
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

    it("uses the latest counterfactual correction when an earlier locator left a stale shift", () => {
        const partial = reviewablePartial(-6, {
            correlationGain: 0.12,
            algorithmSources: ["decisive_joint_operation_fusion"],
            notes: [
                "counterfactual_correction_years=-2",
                "joint_operation_correction=-6",
                "joint_operation_best_difference_gain=0.12",
                "counterfactual_correction_years=-6",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "strict",
            reason: "strict_event",
            event: partial,
        });
    });

    it("rejects a partial move when the latest correction still disagrees", () => {
        const partial = reviewablePartial(-6, {
            correlationGain: 0.12,
            algorithmSources: ["decisive_joint_operation_fusion"],
            notes: [
                "counterfactual_correction_years=-6",
                "joint_operation_correction=-6",
                "joint_operation_best_difference_gain=0.12",
                "counterfactual_correction_years=-2",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "refused",
            reason: "partial_move_evidence_insufficient",
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

    it("shows an endpoint unit first when its newer side decisively remains at lag zero", () => {
        const unit = strictEvent();
        unit.evidence.algorithmSources = [
            "series_endpoint_review_window",
            "newer_fixed_side_lag_contrast",
        ];
        const whole = {
            ...strictEvent(),
            id: "terminal-whole-alias",
            eventType: "wholeSeriesMove" as const,
            shiftYears: -1,
            startYear: 1800,
            endYear: 2000,
        };

        expect(selectReviewWindowDisplay(audit([]), [whole, unit])).toMatchObject({
            status: "strict",
            reason: "strict_event",
            event: unit,
        });
    });

    it("shows a recovered sequential missing frontier before a competing whole baseline", () => {
        const unit = strictEvent();
        unit.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        const whole = {
            ...strictEvent(),
            id: "whole-competing-with-sequential-frontier",
            eventType: "wholeSeriesMove" as const,
            shiftYears: -1,
            startYear: 1800,
            endYear: 2000,
        };

        expect(selectReviewWindowDisplay(audit([]), [whole, unit])).toMatchObject({
            status: "strict",
            reason: "strict_event",
            event: unit,
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

    it("keeps a candidate-grid partial with concentrated per-reference support", () => {
        const partial = reviewablePartial(-10, {
            candidateIds: ["partial-candidate"],
            correlationGain: 0.1,
            algorithmSources: [
                "candidate_grid_reference_partial_consensus",
                "full_interval_counterfactual_locator",
                "per_reference_counterfactual_evidence",
            ],
            notes: [
                "counterfactual_correction_years=-10",
                "candidate_grid_partial_shift=-10",
                "candidate_grid_partial_candidate_year=1906",
                "candidate_grid_partial_operation_year=1900",
                "candidate_grid_partial_score=0.12",
                "candidate_grid_partial_family_margin=0.08",
                "candidate_grid_partial_shift_margin=0.04",
                "candidate_grid_partial_reference_count=8",
                "candidate_grid_partial_reference_peak_kernel5=0.5",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "strict",
            event: partial,
        });
    });

    it("refuses a candidate-grid partial with diffuse reference breakpoints", () => {
        const partial = reviewablePartial(-10, {
            candidateIds: ["partial-candidate"],
            correlationGain: 0.1,
            algorithmSources: [
                "candidate_grid_reference_partial_consensus",
                "per_reference_counterfactual_evidence",
            ],
            notes: [
                "counterfactual_correction_years=-10",
                "candidate_grid_partial_shift=-10",
                "candidate_grid_partial_candidate_year=1900",
                "candidate_grid_partial_operation_year=1901",
                "candidate_grid_partial_score=0.12",
                "candidate_grid_partial_family_margin=0.08",
                "candidate_grid_partial_shift_margin=0.04",
                "candidate_grid_partial_reference_count=8",
                "candidate_grid_partial_reference_peak_kernel5=0.2",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "refused",
            reason: "partial_move_evidence_insufficient",
        });
    });

    it("shows a completed partial correction that decisively beats the full missing staircase", () => {
        const partial = reviewablePartial(-4, {
            candidateIds: ["partial-candidate"],
            algorithmSources: [
                "cofecha_segment_lag",
                "completed_partial_staircase_competition",
                "per_reference_completed_correction",
            ],
            notes: [
                "candidate_hard_gate_passed",
                "completed_family_partial_shift=-4",
                "completed_family_partial_first_fixed_year=1900",
                "completed_family_reference_count=13",
                "completed_family_partial_reference_ratio=0.846154",
                "completed_family_reference_median=-0.052363",
                "completed_family_reference_q75=-0.003920",
                "completed_partial_preferred_over_discrete_missing_staircase",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "strict",
            event: partial,
        });
    });

    it("uses the final completed partial amplitude instead of its stale cumulative seed", () => {
        const notes = [
            "counterfactual_correction_years=-19",
            "completed_mixed_partial_shift=-20",
            "completed_mixed_frontier_year=1900",
            "completed_mixed_frontier_type=partialMove",
            "completed_mixed_frontier_is_newest_event",
            "completed_mixed_master_margin=0.106143",
            "completed_mixed_reference_support=18/54",
            "completed_mixed_reference_median=-0.028553",
            "completed_mixed_reference_q25=-0.066097",
            "completed_mixed_orientation_support=54/54",
            "completed_mixed_orientation_median=0.280473",
            "completed_mixed_orientation_q25=0.249770",
            "completed_mixed_master_orientation_margin=0.147521",
        ];
        const evidence = {
            candidateIds: ["cumulative-partial"],
            algorithmSources: [
                "completed_partial_false_composition",
                "per_reference_completed_correction",
            ],
            notes,
        };
        const stale = reviewablePartial(-20, evidence);
        expect(selectReviewWindowDisplay(audit([]), [stale])).toMatchObject({
            status: "refused",
            reason: "partial_move_evidence_insufficient",
        });

        const completed = reviewablePartial(-20, {
            ...evidence,
            notes: [...notes, "counterfactual_correction_years=-20"],
        });
        expect(selectReviewWindowDisplay(audit([]), [completed])).toMatchObject({
            status: "strict",
            event: completed,
        });
    });

    it("keeps a weak completed-partial family hidden", () => {
        const partial = reviewablePartial(-4, {
            candidateIds: ["partial-candidate"],
            algorithmSources: [
                "completed_partial_staircase_competition",
                "per_reference_completed_correction",
            ],
            notes: [
                "candidate_hard_gate_passed",
                "completed_family_partial_shift=-4",
                "completed_family_partial_first_fixed_year=1904",
                "completed_family_reference_count=13",
                "completed_family_partial_reference_ratio=0.769231",
                "completed_family_reference_median=-0.01",
                "completed_family_reference_q75=0.002",
                "completed_partial_preferred_over_discrete_missing_staircase",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "refused",
            reason: "partial_move_evidence_insufficient",
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
        const source = snapshot("missingRing");
        const sourceCheckpoint = checkpoint(source);
        const result = selectReviewWindowDisplay(
            audit([source]),
            [],
            [sourceCheckpoint],
        );
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
        expect(result.event?.id).toBe(sourceCheckpoint.event.id);
        expect(result.event?.evidence.candidateIds).toEqual(["upstream-candidate"]);
        expect(result.event?.rankedYears[0].evidenceTags)
            .toContain("upstream_ranked_evidence");
        expect(result.event?.evidence.notes).toContain("review_only=true");
    });

    it("does not reconstruct a review event from a lossy audit snapshot", () => {
        expect(selectReviewWindowDisplay(audit([
            snapshot("missingRing"),
        ]), [])).toMatchObject({
            status: "refused",
            reason: "no_unit_hypothesis",
            event: null,
        });
    });

    it("does not lower the gate for unflagged, partial, or direction-conflicted evidence", () => {
        const missing = snapshot("missingRing");
        const partial = snapshot("partialMove");
        const conflicted = {
            ...snapshot("missingRing"),
            lagBefore: 1,
            lagAfter: 0,
        };
        expect(selectReviewWindowDisplay(
            audit([missing], { cofechaFlagged: false }),
            [],
            [checkpoint(missing)],
        ).reason).toBe("cofecha_target_unflagged");
        expect(selectReviewWindowDisplay(
            audit([partial]),
            [],
            [checkpoint(partial)],
        ).reason).toBe("no_unit_hypothesis");
        expect(selectReviewWindowDisplay(
            audit([conflicted]),
            [],
            [checkpoint(conflicted)],
        ).reason).toBe("lag_direction_conflict");
    });

    it("rejects unresolved operation and remote-mode competition", () => {
        const missing = snapshot("missingRing");
        const falseRing = snapshot("falseRing");
        expect(selectReviewWindowDisplay(
            audit([missing, falseRing]),
            [],
            [checkpoint(missing), checkpoint(falseRing)],
        ).reason).toBe("operation_type_conflict");

        const remote = {
            ...snapshot("missingRing", 1937, 1943),
            topYear: 1940,
        };
        expect(selectReviewWindowDisplay(
            audit([missing, remote]),
            [],
            [checkpoint(missing), checkpoint(remote)],
        ).reason).toBe("competing_remote_modes");
    });

    it("uses only 5, 7, 9, or 13-year windows", () => {
        const sources = [
            snapshot("missingRing", 1898, 1902),
            snapshot("missingRing", 1897, 1903),
            snapshot("missingRing", 1896, 1904),
            snapshot("missingRing", 1894, 1906),
        ];
        const checkpoints = sources.map((candidate, index) => {
            const value = checkpoint(candidate);
            value.event.seriesId = `T${index}`;
            return value;
        });
        const decisions = sources.map((candidate, index) => selectReviewWindowDisplay(
            audit([candidate], { seriesId: `T${index}` }),
            [],
            [checkpoints[index]],
        ));
        expect(decisions.map((row) => (
            row.event ? row.event.endYear - row.event.startYear + 1 : null
        ))).toEqual([5, 7, 9, 13]);
        expect(buildReviewWindowDisplays(
            sources.map((candidate, index) => audit([
                candidate,
            ], { seriesId: `T${index}` })),
            [],
            checkpoints,
        ).events).toHaveLength(4);
    });

    it("refuses an uncalibrated width instead of recentering it", () => {
        const source = snapshot("missingRing", 1897, 1902);
        const sourceCheckpoint = checkpoint(source);
        const result = selectReviewWindowDisplay(
            audit([source]),
            [],
            [sourceCheckpoint],
        );

        expect(result).toMatchObject({
            status: "refused",
            reason: "window_width_unsafe",
            event: null,
        });
        expect(sourceCheckpoint.event).toMatchObject({
            startYear: 1897,
            endYear: 1902,
        });
    });

    it("projects a final joint hypothesis without rebuilding any event field", () => {
        const selected = strictEvent();
        const result = selectReviewWindowDisplay(
            audit([], { finalReason: "emitted" }),
            [],
            [],
            {},
            jointDecision(selected),
        );

        expect(result).toMatchObject({
            status: "strict",
            sourceStage: "final",
            event: {
                id: "strict",
                eventType: "missingRing",
                startYear: 1898,
                endYear: 1902,
            },
        });
        expect(result.event).toBe(selected);
    });

    it("uses display gates only for a non-final joint hypothesis", () => {
        const selected = strictEvent();
        const result = selectReviewWindowDisplay(
            audit([]),
            [],
            [],
            {},
            jointDecision(selected, "displayed"),
        );

        expect(result).toMatchObject({
            status: "review",
            reason: "lower_display_gate_passed",
            sourceStage: "displayed",
            event: {
                eventType: "missingRing",
                startYear: 1898,
                endYear: 1902,
                reviewOnly: true,
            },
        });
    });

    it("does not recover another checkpoint after the joint adjudicator refuses", () => {
        const result = selectReviewWindowDisplay(
            audit([snapshot("missingRing")]),
            [strictEvent()],
            [checkpoint(snapshot("missingRing"))],
            {},
            jointDecision(null),
        );

        expect(result).toMatchObject({
            status: "refused",
            reason: "operation_type_conflict",
            event: null,
        });
    });
});

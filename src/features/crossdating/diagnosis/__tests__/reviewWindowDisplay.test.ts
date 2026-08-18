import { describe, expect, it } from "vitest";
import {
    buildReviewWindowDisplays as buildJointReviewWindowDisplays,
    selectReviewWindowDisplay as selectJointReviewWindowDisplay,
    type ReviewWindowDisplayConfig,
} from "../reviewWindowDisplay";
import { adjudicateJointEventHypotheses } from "../jointEventAdjudicator";
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

// Existing cases keep their compact fixture shape, but every assertion now traverses the
// production joint adjudicator before the display-only gate.
const selectReviewWindowDisplay = (
    decisionAudit: DiagnosisEventDecisionAudit,
    strictEvents: readonly DiagnosisEvent[],
    reviewCheckpoints: readonly DiagnosisReviewEventCheckpoint[] = [],
    overrides: Partial<ReviewWindowDisplayConfig> = {},
    explicitDecision: DiagnosisJointEventDecision | null = null,
) => selectJointReviewWindowDisplay(
    decisionAudit,
    explicitDecision ?? adjudicateJointEventHypotheses(
        decisionAudit.seriesId,
        [
            ...strictEvents.map((event) => ({ stage: "final" as const, event })),
            ...reviewCheckpoints,
        ],
    ),
    overrides,
);

const buildReviewWindowDisplays = (
    audits: readonly DiagnosisEventDecisionAudit[],
    strictEvents: readonly DiagnosisEvent[],
    reviewCheckpoints: readonly DiagnosisReviewEventCheckpoint[] = [],
    overrides: Partial<ReviewWindowDisplayConfig> = {},
) => {
    const decisions = audits.map((decisionAudit) => adjudicateJointEventHypotheses(
        decisionAudit.seriesId,
        [
            ...strictEvents
                .filter((event) => event.seriesId === decisionAudit.seriesId)
                .map((event) => ({ stage: "final" as const, event })),
            ...reviewCheckpoints.filter(({ event }) => (
                event.seriesId === decisionAudit.seriesId
            )),
        ],
    ));
    return buildJointReviewWindowDisplays(audits, decisions, overrides);
};

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
        const result = selectReviewWindowDisplay(
            audit([]),
            [strict],
            [],
            {},
            jointDecision(strict),
        );
        expect(result).toMatchObject({
            status: "strict",
            reason: "strict_event",
            sourceStage: "final",
        });
        expect(result.event).toBe(strict);
    });

    it("shows an unflagged exact cumulative unit frontier after working-data edits", () => {
        const frontier = strictEvent();
        frontier.evidence = {
            ...frontier.evidence,
            algorithmSources: ["cumulative_lag_path_frontier", "piecewise_lag_path"],
            score: 10.8,
            scoreMargin: 0.5,
            correlationGain: 0.6,
            samplePairs: 66,
            notes: [
                "cumulative_path_aggregate_shift=-2",
                "cumulative_path_component_shift=-1",
                "cumulative_path_companion_shift=-1",
                "cumulative_path_component_year=1899",
                "cumulative_path_operation_year=1900",
                "cumulative_path_component_score=10.800000",
                "cumulative_path_transition_count=2",
            ],
        };

        expect(selectReviewWindowDisplay(
            audit([], { cofechaFlagged: false }),
            [frontier],
        )).toMatchObject({
            status: "strict",
            reason: "strict_event",
            event: frontier,
        });
    });

    it("does not let a final-stage label bypass the unflagged clean-series gate", () => {
        const strict = strictEvent();
        expect(selectReviewWindowDisplay(
            audit([], { cofechaFlagged: false }),
            [strict],
            [],
            {},
            jointDecision(strict),
        )).toMatchObject({
            status: "refused",
            reason: "cofecha_target_unflagged",
            event: null,
        });
    });

    it("keeps an unflagged event with a complete bounded path authority", () => {
        const bounded = strictEvent();
        bounded.evidence.algorithmSources = ["bounded_complete_lag_path"];
        bounded.evidence.notes = ["bounded_path_complete_hypothesis=true"];
        expect(selectReviewWindowDisplay(
            audit([], { cofechaFlagged: false }),
            [bounded],
            [],
            {},
            jointDecision(bounded),
        )).toMatchObject({ status: "strict", reason: "strict_event" });
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

    it("shows a candidate-anchored raw -2 frontier after a weak detached locator", () => {
        const partial = reviewablePartial(-2, {
            samplePairs: 80,
            algorithmSources: [
                "full_interval_counterfactual_locator",
                "candidate_anchored_raw_partial_frontier",
            ],
            notes: [
                "counterfactual_correction_years=-2",
                "candidate_anchored_raw_partial_year=1900",
                "candidate_anchored_raw_partial_region_year=1913",
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
            evidence: {
                ...strictEvent().evidence,
                notes: ["whole_state_global_lag_matches_shift=true"],
            },
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
            evidence: {
                ...strictEvent().evidence,
                notes: ["whole_state_global_lag_matches_shift=true"],
            },
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
            "terminal_whole_alias_removed",
        ];
        const whole = {
            ...strictEvent(),
            id: "terminal-whole-alias",
            eventType: "wholeSeriesMove" as const,
            shiftYears: -1,
            startYear: 1800,
            endYear: 2000,
            evidence: {
                ...strictEvent().evidence,
                notes: ["whole_state_global_lag_matches_shift=true"],
            },
        };

        expect(selectReviewWindowDisplay(audit([]), [whole, unit])).toMatchObject({
            status: "strict",
            reason: "strict_event",
            event: unit,
        });
    });

    it("shows a partial with an independently validated missing-ring interpretation", () => {
        const partial = reviewablePartial(-2, {
            algorithmSources: ["full_interval_counterfactual_locator"],
            notes: [
                "counterfactual_correction_years=-2",
                "locator_adjudication=accepted_detached_strong_mode",
            ],
        });
        const alternative = {
            ...strictEvent(),
            id: "structured-missing-alternative",
            startYear: 1898,
            endYear: 1902,
        };
        partial.interpretationAmbiguity = {
            kind: "missingRingsOrPartialMove",
            alternative,
            evidence: {
                interpretationBasis: "structuredLocatorCumulativeLagAlternative",
                missingRingCount: 2,
                cumulativeShiftYears: -2,
                missingYears: [1896, 1900],
                partialFirstFixedYear: 1900,
                normalizedCounterfactualGainDifference: 0,
                masterMargin: 0,
                referenceMedianMargin: 0,
                referenceCount: 55,
                missingReferenceSupport: 7,
                partialReferenceSupport: 48,
            },
        };

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "strict",
            reason: "strict_event",
            event: partial,
        });
    });

    it("keeps a bounded partial transition measured relative to a whole baseline", () => {
        const partial = reviewablePartial(-20, {
            lagBefore: -24,
            lagAfter: -4,
            samplePairs: 120,
            algorithmSources: ["bounded_complete_lag_path"],
            notes: [
                "bounded_path_complete_hypothesis=true",
                "bounded_path_transition_gain=36",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "strict",
            reason: "strict_event",
            event: partial,
        });
    });

    it("shows a partial carrying a concentrated local two-step interpretation", () => {
        const partial = reviewablePartial(-2, {
            algorithmSources: [
                "bounded_complete_lag_path",
                "compressed_missing_staircase_evidence",
            ],
            notes: [
                "bounded_path_complete_hypothesis=true",
                "counterfactual_correction_years=-2",
            ],
        });
        partial.interpretationAmbiguity = {
            kind: "missingRingsOrPartialMove",
            alternative: {
                ...strictEvent(),
                id: "localized-two-step-missing-alternative",
            },
            evidence: {
                interpretationBasis: "localizedTwoStepStaircaseAlternative",
                missingRingCount: 2,
                cumulativeShiftYears: -2,
                missingYears: [1893, 1900],
                partialFirstFixedYear: 1900,
                normalizedCounterfactualGainDifference: 0.4,
                masterMargin: 0.04,
                referenceMedianMargin: 0.009,
                referenceCount: 26,
                missingReferenceSupport: 26,
                partialReferenceSupport: 0,
            },
        };

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "strict",
            event: partial,
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
            evidence: {
                ...strictEvent().evidence,
                notes: ["whole_state_global_lag_matches_shift=true"],
            },
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

    it("shows an exact high-gain partial supported by four independent views", () => {
        const partial = reviewablePartial(-6, {
            score: 12.39,
            scoreMargin: 2.68,
            correlationGain: 0.396,
            algorithmSources: [
                "negative_partial_multiview_consensus",
                "piecewise_lag_path",
            ],
            notes: [
                "counterfactual_correction_years=-6",
                "partial_consensus_year=1900",
                "partial_consensus_support=4",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "strict",
            event: partial,
        });
    });

    it("keeps weak four-view partials hidden", () => {
        const partial = reviewablePartial(-6, {
            scoreMargin: 0.01,
            correlationGain: 0.04,
            algorithmSources: [
                "negative_partial_multiview_consensus",
                "piecewise_lag_path",
            ],
            notes: [
                "counterfactual_correction_years=-6",
                "partial_consensus_year=1900",
                "partial_consensus_support=4",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "refused",
            reason: "partial_move_evidence_insufficient",
        });
    });

    it("shows a uniquely decomposed cumulative partial component", () => {
        const partial = reviewablePartial(-6, {
            correlationGain: 0.1,
            algorithmSources: ["cumulative_partial_component_decomposition"],
            notes: [
                "counterfactual_correction_years=-6",
                "cumulative_partial_aggregate_shift=-26",
                "cumulative_partial_component_shift=-6",
                "cumulative_partial_companion_shift=-20",
                "cumulative_partial_component_year=1900",
                "cumulative_partial_component_difference_gain=0.06",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "strict",
            event: partial,
        });
    });

    it("shows the newest exact component from a two-step cumulative lag path", () => {
        const partial = reviewablePartial(-6, {
            algorithmSources: ["cumulative_lag_path_frontier", "piecewise_lag_path"],
            notes: [
                "counterfactual_correction_years=-6",
                "cumulative_path_aggregate_shift=-26",
                "cumulative_path_component_shift=-6",
                "cumulative_path_companion_shift=-20",
                "cumulative_path_component_year=1900",
                "cumulative_path_component_score=8.200000",
                "cumulative_path_transition_count=2",
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
            "completed_mixed_separation=8",
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

    it("uses the same short-plateau contract as completed mixed-event generation", () => {
        const partial = reviewablePartial(-6, {
            candidateIds: ["joint-distribution", "cofecha-segment"],
            algorithmSources: [
                "completed_partial_missing_composition",
                "per_reference_completed_correction",
            ],
            notes: [
                "counterfactual_correction_years=-6",
                "completed_mixed_partial_shift=-6",
                "completed_mixed_frontier_year=1900",
                "completed_mixed_frontier_type=partialMove",
                "completed_mixed_frontier_is_newest_event",
                "completed_mixed_separation=5",
                "completed_mixed_master_margin=-0.024000",
                "completed_mixed_reference_support=19/28",
                "completed_mixed_reference_median=0.072559",
                "completed_mixed_reference_q25=-0.008036",
                "completed_mixed_orientation_support=24/28",
                "completed_mixed_orientation_median=0.053000",
                "completed_mixed_orientation_q25=0.037000",
                "completed_mixed_master_orientation_margin=-0.024000",
                "completed_mixed_source_segment_anchored=false",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "strict",
            event: partial,
        });
    });

    it("shows an exhaustive partial only after regional unit-boundary validation", () => {
        const partial = reviewablePartial(-6, {
            candidateIds: [],
            algorithmSources: [
                "completed_partial_missing_composition",
                "exhaustive_completed_partial_unit_adjudication",
                "per_reference_completed_correction",
            ],
            notes: [
                "counterfactual_correction_years=-6",
                "completed_mixed_partial_shift=-6",
                "completed_mixed_frontier_year=1900",
                "completed_mixed_frontier_type=partialMove",
                "completed_mixed_frontier_is_newest_event",
                "completed_mixed_separation=6",
                "completed_mixed_master_margin=-1.1",
                "completed_mixed_reference_support=18/28",
                "completed_mixed_reference_median=0.03",
                "completed_mixed_reference_q25=-0.01",
                "completed_mixed_orientation_support=20/28",
                "completed_mixed_orientation_median=0.03",
                "completed_mixed_orientation_q25=0.00",
                "completed_mixed_master_orientation_margin=-1.1",
                "completed_mixed_source_segment_anchored=false",
                "completed_mixed_exhaustive_reason=regional_unit_direction",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "strict",
            event: partial,
        });
    });

    it("keeps a two-year exhaustive partial decomposition hidden", () => {
        const partial = reviewablePartial(-5, {
            candidateIds: [],
            algorithmSources: [
                "completed_partial_missing_composition",
                "exhaustive_completed_partial_unit_adjudication",
                "per_reference_completed_correction",
            ],
            notes: [
                "counterfactual_correction_years=-5",
                "completed_mixed_partial_shift=-5",
                "completed_mixed_frontier_year=1900",
                "completed_mixed_frontier_type=partialMove",
                "completed_mixed_frontier_is_newest_event",
                "completed_mixed_separation=2",
                "completed_mixed_master_margin=0",
                "completed_mixed_reference_support=20/25",
                "completed_mixed_reference_median=0.028611",
                "completed_mixed_reference_q25=0.011442",
                "completed_mixed_orientation_support=25/27",
                "completed_mixed_orientation_median=0.092859",
                "completed_mixed_orientation_q25=0.054859",
                "completed_mixed_master_orientation_margin=0",
                "completed_mixed_source_segment_anchored=false",
                "completed_mixed_exhaustive_reason=cofecha_completed_family",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "refused",
            reason: "partial_move_evidence_insufficient",
        });
    });

    it("shows a long exhaustive partial with decisive COFECHA family support", () => {
        const partial = reviewablePartial(-20, {
            candidateIds: [],
            algorithmSources: [
                "completed_partial_missing_composition",
                "exhaustive_completed_partial_unit_adjudication",
                "per_reference_completed_correction",
            ],
            notes: [
                "counterfactual_correction_years=-20",
                "completed_mixed_partial_shift=-20",
                "completed_mixed_frontier_year=1900",
                "completed_mixed_frontier_type=partialMove",
                "completed_mixed_frontier_is_newest_event",
                "completed_mixed_separation=31",
                "completed_mixed_master_margin=0",
                "completed_mixed_reference_support=25/25",
                "completed_mixed_reference_median=0.508",
                "completed_mixed_reference_q25=0.364",
                "completed_mixed_orientation_support=26/26",
                "completed_mixed_orientation_median=0.223",
                "completed_mixed_orientation_q25=0.156",
                "completed_mixed_master_orientation_margin=0",
                "completed_mixed_source_segment_anchored=false",
                "completed_mixed_exhaustive_reason=cofecha_completed_family",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "strict",
            event: partial,
        });
    });

    it("shows a high-gain long exhaustive partial with distributed reference support", () => {
        const partial = reviewablePartial(-20, {
            candidateIds: ["partial-candidate"],
            algorithmSources: [
                "completed_partial_false_composition",
                "exhaustive_completed_partial_unit_adjudication",
                "per_reference_completed_correction",
            ],
            notes: [
                "counterfactual_correction_years=-20",
                "completed_mixed_partial_shift=-20",
                "completed_mixed_frontier_year=1900",
                "completed_mixed_frontier_type=partialMove",
                "completed_mixed_frontier_is_newest_event",
                "completed_mixed_separation=34",
                "completed_mixed_reference_support=23/37",
                "completed_mixed_reference_median=0.357",
                "completed_mixed_reference_q25=0",
                "completed_mixed_orientation_support=28/37",
                "completed_mixed_orientation_median=0.151",
                "completed_mixed_orientation_q25=0.0002",
                "completed_mixed_exhaustive_reason=cofecha_completed_family",
            ],
        });

        expect(selectReviewWindowDisplay(audit([]), [partial])).toMatchObject({
            status: "strict",
            event: partial,
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
        ).reason).toBe("partial_move_evidence_insufficient");
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

    it("displays an independently verified terminal whole from an earlier stage", () => {
        const selected = {
            ...strictEvent(),
            eventType: "wholeSeriesMove" as const,
            shiftYears: -5,
            startYear: 1600,
            endYear: 2000,
            evidence: {
                ...strictEvent().evidence,
                notes: [
                    "whole_baseline_source=cofecha_terminal_lag",
                    "cofecha_terminal_segments=3",
                    "cofecha_terminal_consistency=1.000000",
                ],
            },
        };
        const result = selectReviewWindowDisplay(
            audit([], { finalReason: "emitted" }),
            [],
            [],
            {},
            jointDecision(selected, "detected"),
        );

        expect(result).toMatchObject({
            status: "strict",
            reason: "strict_event",
            sourceStage: "detected",
            event: { eventType: "wholeSeriesMove", shiftYears: -5 },
        });
        expect(result.event).toBe(selected);
    });

    it("displays a durable path-fixed whole frame selected from an earlier stage", () => {
        const selected = {
            ...strictEvent(),
            eventType: "wholeSeriesMove" as const,
            shiftYears: -11,
            startYear: 1600,
            endYear: 2000,
            evidence: {
                ...strictEvent().evidence,
                algorithmSources: ["durable_whole_frame_priority"],
                notes: [
                    "candidate_hard_gate_passed",
                    "whole_baseline_source=path_fixed_side_lag",
                    "path_fixed_side_lag=-11",
                    "path_fixed_side_newer_context_years=158",
                ],
            },
        };
        const result = selectReviewWindowDisplay(
            audit([], { finalReason: "emitted" }),
            [],
            [],
            {},
            jointDecision(selected, "displayed"),
        );

        expect(result).toMatchObject({
            status: "strict",
            reason: "strict_event",
            sourceStage: "displayed",
            event: { eventType: "wholeSeriesMove", shiftYears: -11 },
        });
        expect(result.event).toBe(selected);
    });

    it("displays a durable global-lag whole frame selected from an earlier stage", () => {
        const selected = {
            ...strictEvent(),
            eventType: "wholeSeriesMove" as const,
            shiftYears: -50,
            startYear: 1600,
            endYear: 2000,
            evidence: {
                ...strictEvent().evidence,
                algorithmSources: ["durable_whole_frame_priority"],
                notes: [
                    "whole_state_global_lag_matches_shift=true",
                    "whole_state_newer_edge_support_fraction=1.000000",
                ],
            },
        };

        expect(selectReviewWindowDisplay(
            audit([], { finalReason: "emitted" }),
            [],
            [],
            {},
            jointDecision(selected, "displayed"),
        )).toMatchObject({
            status: "strict",
            sourceStage: "displayed",
            event: { eventType: "wholeSeriesMove", shiftYears: -50 },
        });
    });

    it("displays a stronger globally supported whole candidate", () => {
        const selected = {
            ...strictEvent(),
            eventType: "wholeSeriesMove" as const,
            shiftYears: -11,
            startYear: 1600,
            endYear: 2000,
            evidence: {
                ...strictEvent().evidence,
                algorithmSources: ["stronger_global_whole_candidate"],
            },
        };

        expect(selectReviewWindowDisplay(
            audit([], { finalReason: "emitted" }),
            [],
            [],
            {},
            jointDecision(selected, "candidate"),
        )).toMatchObject({
            status: "strict",
            sourceStage: "candidate",
            event: { eventType: "wholeSeriesMove", shiftYears: -11 },
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

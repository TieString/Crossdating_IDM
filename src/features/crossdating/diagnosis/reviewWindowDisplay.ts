/** Selects one lower-threshold manual-review window without changing strict event output. */
import { adjudicateReviewEventHypothesis } from "./eventAdjudicator";
import type {
    DiagnosisEvent,
    DiagnosisEventDecisionAudit,
    DiagnosisJointEventDecision,
    DiagnosisReviewEventCheckpoint,
    DiagnosisReviewSourceStage,
    DiagnosisReviewWindowDecision,
} from "./types";

export type ReviewWindowDisplayConfig = {
    minimumReferenceSources: number;
    minimumMedianReferenceDepth: number;
    remoteModeDistanceYears: number;
    minimumRemoteModeStrengthMargin: number;
    minimumOperationStrengthMargin: number;
    minimumPartialVoteGain: number;
    minimumPartialJointGain: number;
    minimumPartialReferenceCoreGain: number;
    minimumPartialMultiviewSupport: number;
    partialVoteWindowToleranceYears: number;
    allowedWindowWidths: readonly number[];
};

export const DEFAULT_REVIEW_WINDOW_DISPLAY_CONFIG: ReviewWindowDisplayConfig = {
    minimumReferenceSources: 3,
    minimumMedianReferenceDepth: 3,
    remoteModeDistanceYears: 13,
    minimumRemoteModeStrengthMargin: 0.05,
    minimumOperationStrengthMargin: 0.05,
    minimumPartialVoteGain: 0.02,
    minimumPartialJointGain: 0.05,
    minimumPartialReferenceCoreGain: 0.05,
    minimumPartialMultiviewSupport: 5,
    partialVoteWindowToleranceYears: 1,
    allowedWindowWidths: [5, 7, 9, 13],
};

const numericNote = (
    event: DiagnosisEvent,
    key: string,
): number | null => {
    const prefix = `${key}=`;
    const note = event.evidence.notes.find((candidate) => candidate.startsWith(prefix));
    if (!note) return null;
    const value = Number(note.slice(prefix.length));
    return Number.isFinite(value) ? value : null;
};

const latestNumericNote = (
    event: DiagnosisEvent,
    key: string,
): number | null => {
    const prefix = `${key}=`;
    const values = event.evidence.notes.flatMap((candidate) => {
        if (!candidate.startsWith(prefix)) return [];
        const value = Number(candidate.slice(prefix.length));
        return Number.isFinite(value) ? [value] : [];
    });
    return values[values.length - 1] ?? null;
};

const yearSupportsWindow = (
    event: DiagnosisEvent,
    year: number | null,
    toleranceYears: number,
): boolean => year !== null
    && year >= event.startYear - toleranceYears
    && year <= event.endYear + toleranceYears;

const hasOperationConsistentPartialVote = (
    event: DiagnosisEvent,
    prefix: "partial_reference_vote" | "partial_exhaustive_vote",
    config: ReviewWindowDisplayConfig,
): boolean => numericNote(event, `${prefix}_shift`) === event.shiftYears
    && yearSupportsWindow(
        event,
        numericNote(event, `${prefix}_year`),
        config.partialVoteWindowToleranceYears,
    )
    && (numericNote(event, `${prefix}_gain`) ?? Number.NEGATIVE_INFINITY)
        >= config.minimumPartialVoteGain;

const hasReviewablePartialMoveEvidence = (
    event: DiagnosisEvent,
    config: ReviewWindowDisplayConfig,
): boolean => {
    if (event.eventType !== "partialMove") return false;
    const shiftYears = event.shiftYears;
    if (shiftYears === undefined
        || shiftYears > -2
        || event.shiftSide !== "older"
        || event.evidence.lagBefore !== shiftYears
        || event.evidence.lagAfter !== 0) return false;

    const counterfactualShift = latestNumericNote(
        event,
        "counterfactual_correction_years",
    );
    if (counterfactualShift !== null && counterfactualShift !== shiftYears) return false;

    const sources = new Set(event.evidence.algorithmSources);
    const referenceVote = hasOperationConsistentPartialVote(
        event,
        "partial_reference_vote",
        config,
    );
    const exhaustiveVote = hasOperationConsistentPartialVote(
        event,
        "partial_exhaustive_vote",
        config,
    );
    if (referenceVote || exhaustiveVote) return true;

    const jointCorrection = numericNote(event, "joint_operation_correction");
    const jointGain = Math.max(
        numericNote(event, "joint_operation_best_difference_gain")
            ?? Number.NEGATIVE_INFINITY,
        numericNote(event, "joint_operation_top3_difference_gain")
            ?? Number.NEGATIVE_INFINITY,
        event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY,
    );
    if (sources.has("decisive_joint_operation_fusion")
        && jointCorrection === shiftYears
        && jointGain >= config.minimumPartialJointGain) return true;

    const multiviewConsensusYear = numericNote(event, "partial_consensus_year");
    const multiviewSupport = numericNote(event, "partial_consensus_support") ?? 0;
    if (sources.has("negative_partial_multiview_consensus")
        && multiviewSupport >= config.minimumPartialMultiviewSupport
        && yearSupportsWindow(
            event,
            multiviewConsensusYear,
            config.partialVoteWindowToleranceYears,
        )) return true;

    const candidateConsensusShift = numericNote(
        event,
        "partial_candidate_consensus_shift",
    );
    const candidateConsensusCount = numericNote(
        event,
        "partial_candidate_consensus_count",
    ) ?? 0;
    const hasMultiCandidateConsensus = sources.has("candidate_backed_partial_consensus")
        && candidateConsensusCount >= 2
        && event.evidence.candidateIds.length >= 2;
    const hasCofechaOverrideOfIncoherentAlternatives = sources.has(
        "cofecha_backed_partial_over_incoherent_alternatives",
    ) && candidateConsensusCount >= 1
        && event.evidence.candidateIds.length >= 1
        && (event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY) >= 0.1;
    if ((hasMultiCandidateConsensus || hasCofechaOverrideOfIncoherentAlternatives)
        && candidateConsensusShift === shiftYears
        && (event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY)
            >= config.minimumPartialJointGain) return true;

    const completedShift = numericNote(event, "completed_family_partial_shift");
    const completedFirstFixedYear = numericNote(
        event,
        "completed_family_partial_first_fixed_year",
    );
    const completedReferenceCount = numericNote(
        event,
        "completed_family_reference_count",
    ) ?? 0;
    const completedPartialRatio = numericNote(
        event,
        "completed_family_partial_reference_ratio",
    ) ?? 0;
    const completedMedian = numericNote(
        event,
        "completed_family_reference_median",
    ) ?? Number.POSITIVE_INFINITY;
    const completedUpperQuartile = numericNote(
        event,
        "completed_family_reference_q75",
    ) ?? Number.POSITIVE_INFINITY;
    if (sources.has("completed_partial_staircase_competition")
        && sources.has("per_reference_completed_correction")
        && event.evidence.notes.includes(
            "completed_partial_preferred_over_discrete_missing_staircase",
        )
        && event.evidence.notes.includes("candidate_hard_gate_passed")
        && completedShift === shiftYears
        && yearSupportsWindow(
            event,
            completedFirstFixedYear,
            config.partialVoteWindowToleranceYears,
        )
        && completedReferenceCount >= 8
        && completedPartialRatio >= 0.8
        && completedMedian < 0
        && completedUpperQuartile <= 0
        && event.evidence.candidateIds.length >= 1) return true;

    const completedMixedShift = numericNote(event, "completed_mixed_partial_shift");
    const completedMixedFrontierYear = numericNote(event, "completed_mixed_frontier_year");
    const completedMixedMasterMargin = numericNote(
        event,
        "completed_mixed_master_margin",
    ) ?? Number.NEGATIVE_INFINITY;
    const completedMixedReferenceSupportNote = event.evidence.notes.find(
        (note) => note.startsWith("completed_mixed_reference_support="),
    );
    const completedMixedReference = completedMixedReferenceSupportNote
        ? (() => {
            const [support, count] = completedMixedReferenceSupportNote
                .split("=")[1]?.split("/").map(Number) ?? [];
            return {
                count: Number.isFinite(count) ? count : 0,
                ratio: Number.isFinite(support) && Number.isFinite(count) && count > 0
                    ? support / count
                    : 0,
            };
        })()
        : { count: 0, ratio: 0 };
    const completedMixedMedian = numericNote(
        event,
        "completed_mixed_reference_median",
    ) ?? Number.NEGATIVE_INFINITY;
    const completedMixedQ25 = numericNote(
        event,
        "completed_mixed_reference_q25",
    ) ?? Number.NEGATIVE_INFINITY;
    const completedMixedOrientationSupportNote = event.evidence.notes.find(
        (note) => note.startsWith("completed_mixed_orientation_support="),
    );
    const completedMixedOrientation = completedMixedOrientationSupportNote
        ? (() => {
            const [support, count] = completedMixedOrientationSupportNote
                .split("=")[1]?.split("/").map(Number) ?? [];
            return {
                count: Number.isFinite(count) ? count : 0,
                ratio: Number.isFinite(support) && Number.isFinite(count) && count > 0
                    ? support / count
                    : 0,
            };
        })()
        : { count: 0, ratio: 0 };
    const completedMixedOrientationMedian = numericNote(
        event,
        "completed_mixed_orientation_median",
    ) ?? Number.NEGATIVE_INFINITY;
    const completedMixedOrientationQ25 = numericNote(
        event,
        "completed_mixed_orientation_q25",
    ) ?? Number.NEGATIVE_INFINITY;
    const completedMixedMasterOrientation = numericNote(
        event,
        "completed_mixed_master_orientation_margin",
    ) ?? Number.NEGATIVE_INFINITY;
    const completedMixedReferenceFamily = completedMixedReference.count >= 8
        && completedMixedReference.ratio >= 0.75
        && completedMixedMedian >= 0.04
        && completedMixedQ25 >= 0.01;
    const completedMixedMasterFamily = completedMixedMasterMargin >= 0.05
        && completedMixedMasterOrientation >= 0.05
        && completedMixedOrientation.ratio >= 0.9
        && completedMixedOrientationMedian >= 0.1
        && completedMixedOrientationQ25 >= 0.05;
    if ((sources.has("completed_partial_missing_composition")
            || sources.has("completed_partial_false_composition"))
        && sources.has("per_reference_completed_correction")
        && event.evidence.notes.includes("completed_mixed_frontier_type=partialMove")
        && event.evidence.notes.includes("completed_mixed_frontier_is_newest_event")
        && completedMixedShift === shiftYears
        && yearSupportsWindow(
            event,
            completedMixedFrontierYear,
            config.partialVoteWindowToleranceYears,
        )
        && completedMixedOrientation.count >= 8
        && completedMixedOrientation.ratio >= 0.85
        && completedMixedOrientationMedian >= 0.04
        && completedMixedOrientationQ25 >= 0.01
        && (completedMixedReferenceFamily || completedMixedMasterFamily)
        && event.evidence.candidateIds.length >= 1) return true;

    const gridConsensusShift = numericNote(event, "candidate_grid_partial_shift");
    const gridCandidateYear = numericNote(
        event,
        "candidate_grid_partial_candidate_year",
    );
    const gridOperationYear = numericNote(
        event,
        "candidate_grid_partial_operation_year",
    );
    const gridReferenceCount = numericNote(
        event,
        "candidate_grid_partial_reference_count",
    ) ?? 0;
    const gridPeakKernel5 = numericNote(
        event,
        "candidate_grid_partial_reference_peak_kernel5",
    ) ?? 0;
    const gridScore = numericNote(event, "candidate_grid_partial_score") ?? 0;
    const gridFamilyMargin = numericNote(
        event,
        "candidate_grid_partial_family_margin",
    ) ?? 0;
    const gridShiftMargin = numericNote(
        event,
        "candidate_grid_partial_shift_margin",
    ) ?? 0;
    if (sources.has("candidate_grid_reference_partial_consensus")
        && sources.has("per_reference_counterfactual_evidence")
        && gridConsensusShift === shiftYears
        && yearSupportsWindow(
            event,
            gridOperationYear,
            config.partialVoteWindowToleranceYears,
        )
        && gridCandidateYear !== null
        && gridOperationYear !== null
        && Math.abs(gridCandidateYear - gridOperationYear) <= 6
        && gridScore >= 0.08
        && gridFamilyMargin >= 0.05
        && gridShiftMargin >= 0.01
        && gridReferenceCount >= 6
        && gridPeakKernel5 >= 1 / 3
        && (event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY) >= 0.04
        && event.evidence.candidateIds.length >= 1) return true;

    const referenceVoteYear = numericNote(event, "reference_vote_year");
    const referenceCoreGain = Math.max(
        numericNote(event, "reference_vote_gain") ?? Number.NEGATIVE_INFINITY,
        event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY,
    );
    return sources.has("reference_core_voting")
        && yearSupportsWindow(
            event,
            referenceVoteYear,
            config.partialVoteWindowToleranceYears,
        )
        && referenceCoreGain >= config.minimumPartialReferenceCoreGain;
};

const markReviewOnly = (
    audit: DiagnosisEventDecisionAudit,
    event: DiagnosisEvent,
    sourceStage: DiagnosisReviewSourceStage,
): DiagnosisEvent => {
    return {
        ...event,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "review_window_display_recovery",
            ])).sort(),
            notes: Array.from(new Set([
                ...event.evidence.notes,
                "review_only=true",
                `review_recovery_stage=${sourceStage}`,
                `strict_refusal_reason=${audit.finalReason}`,
            ])),
        },
        reviewOnly: true,
    };
};

const refused = (
    audit: DiagnosisEventDecisionAudit,
    reason: DiagnosisReviewWindowDecision["reason"],
): DiagnosisReviewWindowDecision => ({
    seriesId: audit.seriesId,
    status: "refused",
    reason,
    strictReason: audit.finalReason,
    sourceStage: null,
    event: null,
});

const selectAdjudicatedReviewWindowDisplay = (
    audit: DiagnosisEventDecisionAudit,
    decision: DiagnosisJointEventDecision,
    config: ReviewWindowDisplayConfig,
): DiagnosisReviewWindowDecision => {
    const event = decision.event;
    if (!event || !decision.sourceStage) {
        const reason = decision.reason === "operation_conflict"
            ? "operation_type_conflict"
            : decision.reason === "remote_mode_conflict"
                ? "competing_remote_modes"
                : "no_unit_hypothesis";
        return refused(audit, reason);
    }
    const width = event.endYear - event.startYear + 1;
    if (event.eventType !== "wholeSeriesMove"
        && !config.allowedWindowWidths.includes(width)) {
        return refused(audit, "window_width_unsafe");
    }
    if (decision.sourceStage === "final") {
        if (event.eventType === "partialMove"
            && !hasReviewablePartialMoveEvidence(event, config)) {
            return refused(audit, "partial_move_evidence_insufficient");
        }
        return {
            seriesId: audit.seriesId,
            status: "strict",
            reason: "strict_event",
            strictReason: audit.finalReason,
            sourceStage: decision.sourceStage,
            event,
        };
    }
    if (event.eventType === "partialMove") {
        return refused(audit, "partial_move_evidence_insufficient");
    }
    if (event.eventType === "wholeSeriesMove") {
        return refused(audit, "operation_type_conflict");
    }
    if (audit.finalReason === "older_endpoint_context") {
        return refused(audit, "endpoint_context_insufficient");
    }
    if (!audit.cofechaFlagged) {
        return refused(audit, "cofecha_target_unflagged");
    }
    if (audit.referenceSourceCount < config.minimumReferenceSources
        || audit.medianReferenceDepth < config.minimumMedianReferenceDepth) {
        return refused(audit, "insufficient_reference_support");
    }
    return {
        seriesId: audit.seriesId,
        status: "review",
        reason: "lower_display_gate_passed",
        strictReason: audit.finalReason,
        sourceStage: decision.sourceStage,
        event: markReviewOnly(audit, event, decision.sourceStage),
    };
};

export const selectReviewWindowDisplay = (
    audit: DiagnosisEventDecisionAudit,
    strictEvents: readonly DiagnosisEvent[],
    reviewCheckpoints: readonly DiagnosisReviewEventCheckpoint[] = [],
    overrides: Partial<ReviewWindowDisplayConfig> = {},
    jointDecision: DiagnosisJointEventDecision | null = null,
): DiagnosisReviewWindowDecision => {
    const config = { ...DEFAULT_REVIEW_WINDOW_DISPLAY_CONFIG, ...overrides };
    if (jointDecision) {
        return selectAdjudicatedReviewWindowDisplay(
            audit,
            jointDecision,
            config,
        );
    }
    const strictUnit = strictEvents.find((event) => (
        event.eventType === "missingRing" || event.eventType === "falseRing"
    )) ?? null;
    const strictPartial = strictEvents.find((event) => (
        hasReviewablePartialMoveEvidence(event, config)
    )) ?? null;
    const strictWhole = strictEvents.find((event) => (
        event.eventType === "wholeSeriesMove"
    )) ?? null;
    // A retained whole-series correction is applied first. Local events are re-diagnosed on the
    // corrected calendar instead of competing with the global baseline in the same UI step.
    const decisiveEndpointUnit = strictUnit?.evidence.algorithmSources.some((source) => (
        source === "newer_fixed_side_lag_contrast"
        || source === "sequential_missing_staircase_head"
    )) ? strictUnit : null;
    const strict = decisiveEndpointUnit ?? strictWhole ?? strictUnit ?? strictPartial;
    if (strict) {
        const width = strict.endYear - strict.startYear + 1;
        if (strict.eventType !== "wholeSeriesMove"
            && !config.allowedWindowWidths.includes(width)) {
            return refused(audit, "window_width_unsafe");
        }
        return {
            seriesId: audit.seriesId,
            status: "strict",
            reason: "strict_event",
            strictReason: audit.finalReason,
            sourceStage: "final",
            event: strict,
        };
    }
    if (strictEvents.length > 0) {
        if (strictEvents.some((event) => event.eventType === "partialMove")) {
            return refused(audit, "partial_move_evidence_insufficient");
        }
        return refused(audit, "operation_type_conflict");
    }
    if (audit.finalReason === "older_endpoint_context") {
        return refused(audit, "endpoint_context_insufficient");
    }
    if (!audit.cofechaFlagged) {
        return refused(audit, "cofecha_target_unflagged");
    }
    if (audit.referenceSourceCount < config.minimumReferenceSources
        || audit.medianReferenceDepth < config.minimumMedianReferenceDepth) {
        return refused(audit, "insufficient_reference_support");
    }

    const adjudication = adjudicateReviewEventHypothesis(
        reviewCheckpoints.filter(({ event }) => event.seriesId === audit.seriesId),
        config,
    );
    if (!adjudication.event || !adjudication.sourceStage) {
        return refused(
            audit,
            adjudication.reason === "selected"
                ? "no_unit_hypothesis"
                : adjudication.reason,
        );
    }
    const width = adjudication.event.endYear - adjudication.event.startYear + 1;
    if (!config.allowedWindowWidths.includes(width)) {
        return refused(audit, "window_width_unsafe");
    }
    const event = markReviewOnly(
        audit,
        adjudication.event,
        adjudication.sourceStage,
    );
    return {
        seriesId: audit.seriesId,
        status: "review",
        reason: "lower_display_gate_passed",
        strictReason: audit.finalReason,
        sourceStage: adjudication.sourceStage,
        event,
    };
};

export const buildReviewWindowDisplays = (
    audits: readonly DiagnosisEventDecisionAudit[],
    strictEvents: readonly DiagnosisEvent[],
    reviewCheckpoints: readonly DiagnosisReviewEventCheckpoint[] = [],
    overrides: Partial<ReviewWindowDisplayConfig> = {},
    jointDecisions: readonly DiagnosisJointEventDecision[] = [],
): {
    decisions: DiagnosisReviewWindowDecision[];
    events: DiagnosisEvent[];
} => {
    const strictBySeries = new Map<string, DiagnosisEvent[]>();
    strictEvents.forEach((event) => {
        const group = strictBySeries.get(event.seriesId) ?? [];
        group.push(event);
        strictBySeries.set(event.seriesId, group);
    });
    const checkpointsBySeries = new Map<string, DiagnosisReviewEventCheckpoint[]>();
    reviewCheckpoints.forEach((checkpoint) => {
        const group = checkpointsBySeries.get(checkpoint.event.seriesId) ?? [];
        group.push(checkpoint);
        checkpointsBySeries.set(checkpoint.event.seriesId, group);
    });
    const jointBySeries = new Map(jointDecisions.map((decision) => [
        decision.seriesId,
        decision,
    ]));
    const decisions = audits.map((audit) => selectReviewWindowDisplay(
        audit,
        strictBySeries.get(audit.seriesId) ?? [],
        checkpointsBySeries.get(audit.seriesId) ?? [],
        overrides,
        jointBySeries.get(audit.seriesId) ?? null,
    ));
    return {
        decisions,
        events: decisions.flatMap((decision) => decision.event ? [decision.event] : []),
    };
};

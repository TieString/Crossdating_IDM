import { evidenceClaimsFor } from "./evidenceLedger";
import { supportsCompletedPartialUnitCompositionEvidence } from "./discreteMissingStaircaseCompetition";
import type {
    DiagnosisEvidenceClaim,
    DiagnosisEvent,
    DiagnosisEventDecisionAudit,
    DiagnosisJointEventDecision,
    DiagnosisReviewSourceStage,
    DiagnosisReviewWindowDecision,
} from "./types";

export type ReviewWindowDisplayConfig = {
    minimumReferenceSources: number;
    minimumMedianReferenceDepth: number;
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

const hasConfirmedCumulativeUnitFrontier = (event: DiagnosisEvent): boolean => {
    if (event.eventType !== "missingRing" && event.eventType !== "falseRing") {
        return false;
    }
    const expectedShift = event.eventType === "missingRing" ? -1 : 1;
    const componentShift = numericNote(event, "cumulative_path_component_shift");
    const companionShift = numericNote(event, "cumulative_path_companion_shift");
    const aggregateShift = numericNote(event, "cumulative_path_aggregate_shift");
    const transitionCount = numericNote(event, "cumulative_path_transition_count") ?? 0;
    const componentScore = numericNote(event, "cumulative_path_component_score")
        ?? Number.NEGATIVE_INFINITY;
    const operationYear = numericNote(event, "cumulative_path_operation_year")
        ?? numericNote(event, "cumulative_path_component_year");
    return event.evidence.algorithmSources.includes("cumulative_lag_path_frontier")
        && componentShift === expectedShift
        && companionShift !== null
        && aggregateShift === componentShift + companionShift
        && transitionCount >= 2
        && componentScore >= 4.5
        && event.evidence.lagBefore === expectedShift
        && event.evidence.lagAfter === 0
        && event.confidenceLevel === "high"
        && event.evidence.scoreMargin >= 0.05
        && (event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY) >= 0.1
        && event.evidence.samplePairs >= 30
        && yearSupportsWindow(event, operationYear, 0);
};

const hasUnflaggedReviewAuthority = (event: DiagnosisEvent): boolean => {
    if (hasConfirmedCumulativeUnitFrontier(event)) return true;
    const claims = evidenceClaimsFor(event);
    const decisiveClaims: DiagnosisEvidenceClaim[] = [
        "bounded_lag_state_path",
        "fixed_side_resolution",
        "endpoint_unit_resolution",
        "explicit_missing_staircase",
        "whole_baseline_exhausted_by_missing_staircase",
        "independent_reference_staircase",
        "continuous_gap_consensus",
        "whole_terminal_baseline",
    ];
    if (decisiveClaims.some((claim) => claims.has(claim))) {
        return true;
    }
    const sources = new Set(event.evidence.algorithmSources);
    return sources.has("long_pulse_consensus")
        && sources.has("reference_core_pair_voting");
};

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
    const lagBefore = event.evidence.lagBefore;
    const lagAfter = event.evidence.lagAfter;
    if (shiftYears === undefined
        || shiftYears > -2
        || event.shiftSide !== "older"
        || lagBefore === null
        || lagAfter === null
        || lagBefore - lagAfter !== shiftYears) return false;

    const counterfactualShift = latestNumericNote(
        event,
        "counterfactual_correction_years",
    );
    if (counterfactualShift !== null && counterfactualShift !== shiftYears) return false;

    const sources = new Set(event.evidence.algorithmSources);
    const boundedPathGain = numericNote(event, "bounded_path_transition_gain");
    if (sources.has("bounded_complete_lag_path")
        && evidenceClaimsFor(event).has("bounded_lag_state_path")
        && lagBefore - lagAfter === shiftYears
        && (boundedPathGain ?? Number.NEGATIVE_INFINITY) >= 2
        && event.evidence.samplePairs >= 30) return true;
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
    const rawFallbackYear = numericNote(
        event,
        "candidate_anchored_raw_partial_year",
    );
    const rawFallbackRegionYear = numericNote(
        event,
        "candidate_anchored_raw_partial_region_year",
    );
    if (sources.has("candidate_anchored_raw_partial_frontier")
        && shiftYears === -2
        && rawFallbackYear !== null
        && rawFallbackRegionYear !== null
        && Math.abs(rawFallbackRegionYear - rawFallbackYear) <= 13
        && yearSupportsWindow(
            event,
            rawFallbackYear,
            config.partialVoteWindowToleranceYears,
        )
        && event.evidence.samplePairs >= 30) return true;

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
    const strongFourChannelConsensus = multiviewSupport >= 4
        && event.confidenceLevel === "high"
        && sources.has("piecewise_lag_path")
        && (event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY) >= 0.1
        && event.evidence.scoreMargin >= 0.05;
    if (sources.has("negative_partial_multiview_consensus")
        && (
            multiviewSupport >= config.minimumPartialMultiviewSupport
            || strongFourChannelConsensus
        )
        && yearSupportsWindow(
            event,
            multiviewConsensusYear,
            config.partialVoteWindowToleranceYears,
        )) return true;

    const cumulativeComponentShift = numericNote(
        event,
        "cumulative_partial_component_shift",
    );
    const cumulativeCompanionShift = numericNote(
        event,
        "cumulative_partial_companion_shift",
    );
    const cumulativeAggregateShift = numericNote(
        event,
        "cumulative_partial_aggregate_shift",
    );
    const cumulativeComponentYear = numericNote(
        event,
        "cumulative_partial_component_year",
    );
    const cumulativeDifferenceGain = numericNote(
        event,
        "cumulative_partial_component_difference_gain",
    ) ?? Number.NEGATIVE_INFINITY;
    if (sources.has("cumulative_partial_component_decomposition")
        && cumulativeComponentShift === shiftYears
        && cumulativeCompanionShift !== null
        && cumulativeAggregateShift === shiftYears + cumulativeCompanionShift
        && cumulativeDifferenceGain >= 0.02
        && yearSupportsWindow(
            event,
            cumulativeComponentYear,
            config.partialVoteWindowToleranceYears,
        )) return true;

    const cumulativePathComponentShift = numericNote(
        event,
        "cumulative_path_component_shift",
    );
    const cumulativePathCompanionShift = numericNote(
        event,
        "cumulative_path_companion_shift",
    );
    const cumulativePathAggregateShift = numericNote(
        event,
        "cumulative_path_aggregate_shift",
    );
    const cumulativePathComponentYear = numericNote(
        event,
        "cumulative_path_component_year",
    );
    const cumulativePathComponentScore = numericNote(
        event,
        "cumulative_path_component_score",
    ) ?? Number.NEGATIVE_INFINITY;
    if (sources.has("cumulative_lag_path_frontier")
        && cumulativePathComponentShift === shiftYears
        && cumulativePathCompanionShift !== null
        && cumulativePathAggregateShift
            === shiftYears + cumulativePathCompanionShift
        && (numericNote(event, "cumulative_path_transition_count") ?? 0) >= 2
        && cumulativePathComponentScore >= 4.5
        && yearSupportsWindow(
            event,
            cumulativePathComponentYear,
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
    const completedMixedSeparation = numericNote(
        event,
        "completed_mixed_separation",
    ) ?? 0;
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
    const completedMixedSupported = supportsCompletedPartialUnitCompositionEvidence({
        unitEventType: event.evidence.notes.includes("completed_mixed_unit_type=falseRing")
            ? "falseRing"
            : "missingRing",
        sourceSegmentAnchored: event.evidence.notes.includes(
            "completed_mixed_source_segment_anchored=true",
        ),
        separationYears: completedMixedSeparation,
        masterMargin: completedMixedMasterMargin,
        referenceCount: completedMixedReference.count,
        mixedReferenceSupportRatio: completedMixedReference.ratio,
        referenceMedianMargin: completedMixedMedian,
        referenceLowerQuartileMargin: completedMixedQ25,
        orientationReferenceCount: completedMixedOrientation.count,
        orientationReferenceSupportRatio: completedMixedOrientation.ratio,
        orientationMedianMargin: completedMixedOrientationMedian,
        orientationLowerQuartileMargin: completedMixedOrientationQ25,
        masterOrientationMargin: completedMixedMasterOrientation,
    });
    const exhaustiveRegionalPartialSupported = sources.has(
        "exhaustive_completed_partial_unit_adjudication",
    )
        && event.evidence.notes.includes(
            "completed_mixed_exhaustive_reason=regional_unit_direction",
        )
        && completedMixedSeparation >= 4
        && completedMixedSeparation <= 13;
    const exhaustiveLongCofechaPartialConsensus = completedMixedReference.ratio >= 0.85
        && completedMixedMedian >= 0.12
        && completedMixedQ25 >= 0.03
        && completedMixedOrientation.ratio >= 0.85
        && completedMixedOrientationMedian >= 0.08
        && completedMixedOrientationQ25 >= 0.02;
    const exhaustiveLongCofechaPartialHighGain = completedMixedReference.ratio >= 0.6
        && completedMixedMedian >= 0.25
        && completedMixedQ25 >= -0.001
        && completedMixedOrientation.ratio >= 0.7
        && completedMixedOrientationMedian >= 0.1
        && completedMixedOrientationQ25 >= 0;
    const exhaustiveLongCofechaPartialSupported = sources.has(
        "exhaustive_completed_partial_unit_adjudication",
    )
        && event.evidence.notes.includes(
            "completed_mixed_exhaustive_reason=cofecha_completed_family",
        )
        && completedMixedSeparation >= 14
        && completedMixedSeparation <= 40
        && completedMixedReference.count >= 8
        && completedMixedOrientation.count >= 8
        && (
            exhaustiveLongCofechaPartialConsensus
            || exhaustiveLongCofechaPartialHighGain
        );
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
        && (
            (completedMixedSupported && event.evidence.candidateIds.length >= 1)
            || exhaustiveRegionalPartialSupported
            || exhaustiveLongCofechaPartialSupported
        )) return true;

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

const hasReviewableMissingPartialInterpretation = (
    event: DiagnosisEvent,
    config: ReviewWindowDisplayConfig,
): boolean => {
    const ambiguity = event.interpretationAmbiguity;
    if (!ambiguity
        || ambiguity.kind !== "missingRingsOrPartialMove"
        || event.eventType !== "partialMove"
        || ambiguity.alternative.eventType !== "missingRing"
        || ![
            "exactSequentialStaircaseAlternative",
            "localizedTwoStepStaircaseAlternative",
            "structuredLocatorCumulativeLagAlternative",
        ].includes(ambiguity.evidence.interpretationBasis ?? "")
        || ambiguity.evidence.cumulativeShiftYears !== event.shiftYears
        || ambiguity.evidence.missingRingCount !== Math.abs(event.shiftYears ?? 0)) {
        return false;
    }
    const alternativeWidth = ambiguity.alternative.endYear
        - ambiguity.alternative.startYear + 1;
    return config.allowedWindowWidths.includes(alternativeWidth)
        && ambiguity.alternative.evidence.lagBefore === -1
        && ambiguity.alternative.evidence.lagAfter === 0;
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
            : decision.reason === "operation_contract_conflict"
                ? "lag_direction_conflict"
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
    if (!audit.cofechaFlagged && !hasUnflaggedReviewAuthority(event)) {
        return refused(audit, "cofecha_target_unflagged");
    }
    const wholeClaims = evidenceClaimsFor(event);
    const independentlyStrictWhole = event.eventType === "wholeSeriesMove"
        && (
            wholeClaims.has("whole_terminal_baseline")
            || event.evidence.algorithmSources.includes(
                "stronger_global_whole_candidate",
            )
            || (
                event.evidence.algorithmSources.includes(
                    "durable_whole_frame_priority",
                )
                && (
                    wholeClaims.has("whole_path_fixed_baseline")
                    || wholeClaims.has("whole_global_lag")
                )
            )
        );
    if (decision.sourceStage === "final" || independentlyStrictWhole) {
        if (event.eventType === "partialMove"
            && !hasReviewablePartialMoveEvidence(event, config)
            && !hasReviewableMissingPartialInterpretation(event, config)) {
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
    jointDecision: DiagnosisJointEventDecision,
    overrides: Partial<ReviewWindowDisplayConfig> = {},
): DiagnosisReviewWindowDecision => {
    const config = { ...DEFAULT_REVIEW_WINDOW_DISPLAY_CONFIG, ...overrides };
    return selectAdjudicatedReviewWindowDisplay(audit, jointDecision, config);
};

export const buildReviewWindowDisplays = (
    audits: readonly DiagnosisEventDecisionAudit[],
    jointDecisions: readonly DiagnosisJointEventDecision[],
    overrides: Partial<ReviewWindowDisplayConfig> = {},
): {
    decisions: DiagnosisReviewWindowDecision[];
    events: DiagnosisEvent[];
} => {
    const jointBySeries = new Map(jointDecisions.map((decision) => [
        decision.seriesId,
        decision,
    ]));
    const decisions = audits.map((audit) => selectReviewWindowDisplay(
        audit,
        jointBySeries.get(audit.seriesId) ?? {
            seriesId: audit.seriesId,
            status: "refused",
            reason: "no_complete_hypothesis",
            sourceStage: null,
            event: null,
            hypotheses: [],
            operationMargin: null,
            remoteModeMargin: null,
            productionAgreement: "same",
            productionExactMatch: true,
        },
        overrides,
    ));
    return {
        decisions,
        events: decisions.flatMap((decision) => decision.event ? [decision.event] : []),
    };
};

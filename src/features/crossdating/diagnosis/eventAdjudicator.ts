import type {
    DiagnosisEvent,
    DiagnosisLocatorDecisionReason,
    DiagnosisReviewEventCheckpoint,
    DiagnosisReviewSourceStage,
} from "./types";

export type LocatorAdjudicationEvidence = {
    concentration: number;
    remoteMargin: number;
    coarseOverlapConsensus: number;
    coarseModelMargin: number;
    pairReferenceCount: number;
    partialSideStepRemoteMargin: number;
    proposedLocationFamilyCount: number;
    checkpointLocationFamilyCount: number;
    locationFamilyAdvantage: number;
    operationLocationGain: number;
    structuredCheckpoint: boolean;
    structuredProposal: boolean;
    checkpointTopYear: number | null;
    proposedTopYear: number | null;
    checkpointWidth: number;
    proposedWidth: number;
    checkpointTopFamilyCount: number;
    proposedTopFamilyCount: number;
    precisionRegression: boolean;
};

export type LocatorProposalAdjudication = {
    event: DiagnosisEvent;
    proposedEvent: DiagnosisEvent | null;
    reason: DiagnosisLocatorDecisionReason;
    accepted: boolean;
    overlapYears: number;
    centerDistanceYears: number;
    operationContractValid: boolean;
    detachedEvidenceStrong: boolean;
    precisionRegression: boolean;
    evidence: LocatorAdjudicationEvidence;
};

export type LocatorAdjudicationConfig = {
    minimumConcentration: number;
    minimumRemoteMargin: number;
    minimumCoarseOverlapConsensus: number;
    minimumCoarseModelMargin: number;
    minimumPairReferenceCount: number;
    minimumPartialSideStepRemoteMargin: number;
    minimumStrongChannels: number;
    minimumLocationFamilyCount: number;
    minimumLocationFamilyAdvantage: number;
    minimumOperationLocationGain: number;
};

export const DEFAULT_LOCATOR_ADJUDICATION_CONFIG: LocatorAdjudicationConfig = {
    minimumConcentration: 0.55,
    minimumRemoteMargin: 0.05,
    minimumCoarseOverlapConsensus: 0.6,
    minimumCoarseModelMargin: 0.08,
    minimumPairReferenceCount: 4,
    minimumPartialSideStepRemoteMargin: 0.08,
    minimumStrongChannels: 3,
    minimumLocationFamilyCount: 2,
    minimumLocationFamilyAdvantage: 1,
    minimumOperationLocationGain: 0.08,
};

const noteNumber = (event: DiagnosisEvent, prefix: string): number => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const value = Number(note?.slice(prefix.length));
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
};

const overlapYears = (
    left: Pick<DiagnosisEvent, "startYear" | "endYear">,
    right: Pick<DiagnosisEvent, "startYear" | "endYear">,
): number => Math.max(
    0,
    Math.min(left.endYear, right.endYear)
        - Math.max(left.startYear, right.startYear) + 1,
);

const centerYear = (
    event: Pick<DiagnosisEvent, "startYear" | "endYear">,
): number => (event.startYear + event.endYear) / 2;

const primaryYear = (event: DiagnosisEvent): number | null => (
    [...event.rankedYears].sort((left, right) => (
        left.rank - right.rank || right.score - left.score || right.year - left.year
    ))[0]?.year ?? null
);

const windowWidth = (
    event: Pick<DiagnosisEvent, "startYear" | "endYear">,
): number => event.endYear - event.startYear + 1;

const structuredLocationEvidenceForWindow = (
    event: DiagnosisEvent,
    window: Pick<DiagnosisEvent, "startYear" | "endYear">,
) => [...(event.evidence.locationEvidence ?? [])].reverse().find((entry) => (
    entry.startYear === window.startYear && entry.endYear === window.endYear
)) ?? null;

const noteYear = (
    event: DiagnosisEvent,
    prefixes: readonly string[],
): number | null => {
    for (const prefix of prefixes) {
        const value = noteNumber(event, prefix);
        if (Number.isInteger(value)) return value;
    }
    return null;
};

const profileMedianYear = (event: DiagnosisEvent): number | null => {
    const years = [
        "partial_gap_raw31_year=",
        "partial_gap_difference31_year=",
        "partial_gap_whitened31_year=",
        "partial_gap_combo31_year=",
        "partial_gap_combo41_year=",
        "partial_gap_combo61_year=",
        "partial_gap_multiScale_year=",
    ].map((prefix) => noteNumber(event, prefix))
        .filter(Number.isInteger)
        .sort((left, right) => left - right);
    return years.length > 0 ? years[Math.floor(years.length / 2)] : null;
};

const locationFamilyYears = (event: DiagnosisEvent): number[] => [
    noteYear(event, ["candidate_top_year="]),
    noteYear(event, ["profile_boundary_year=", "nominal_boundary_year="]),
    noteYear(event, [
        "partial_reference_vote_year=",
        "reference_vote_year=",
    ]),
    noteYear(event, ["partial_exhaustive_vote_year="]),
    noteYear(event, ["local_raw_boundary_year="]),
    noteYear(event, ["multiview_boundary_year="]),
    noteYear(event, ["paired_breakpoint_year="]),
    noteYear(event, ["direct_transition_year="]),
    noteYear(event, ["endpoint_residual_posterior_top_year="]),
    profileMedianYear(event),
].filter((year): year is number => year !== null);

const locationFamilySupport = (
    event: DiagnosisEvent,
    window: Pick<DiagnosisEvent, "startYear" | "endYear">,
): number => locationFamilyYears(event).filter((year) => (
    year >= window.startYear - 1 && year <= window.endYear + 1
)).length;

const locationFamilyTopSupport = (
    event: DiagnosisEvent,
    year: number | null,
): number => year === null ? 0 : locationFamilyYears(event).filter((candidate) => (
    Math.abs(candidate - year) <= 1
)).length;

const sameStringSet = (
    left: readonly string[],
    right: readonly string[],
): boolean => {
    if (left.length !== right.length) return false;
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((value, index) => value === sortedRight[index]);
};

export const locatorPreservesOperationContract = (
    checkpoint: DiagnosisEvent,
    proposal: DiagnosisEvent,
): boolean => (
    checkpoint.seriesId === proposal.seriesId
    && checkpoint.eventType === proposal.eventType
    && (checkpoint.shiftYears ?? null) === (proposal.shiftYears ?? null)
    && (checkpoint.shiftSide ?? null) === (proposal.shiftSide ?? null)
    && checkpoint.evidence.lagBefore === proposal.evidence.lagBefore
    && checkpoint.evidence.lagAfter === proposal.evidence.lagAfter
    && sameStringSet(
        checkpoint.evidence.candidateIds,
        proposal.evidence.candidateIds,
    )
);

const locatorEvidence = (
    checkpoint: DiagnosisEvent,
    proposal: DiagnosisEvent,
): LocatorAdjudicationEvidence => {
    const proposedLocationFamilyCount = locationFamilySupport(
        proposal,
        proposal,
    );
    const checkpointLocationFamilyCount = locationFamilySupport(
        proposal,
        checkpoint,
    );
    const checkpointTopYear = primaryYear(checkpoint);
    const proposedTopYear = primaryYear(proposal);
    const checkpointWidth = windowWidth(checkpoint);
    const proposedWidth = windowWidth(proposal);
    const checkpointTopFamilyCount = locationFamilyTopSupport(
        proposal,
        checkpointTopYear,
    );
    const proposedTopFamilyCount = locationFamilyTopSupport(
        proposal,
        proposedTopYear,
    );
    const checkpointLocationEvidence = structuredLocationEvidenceForWindow(
        checkpoint,
        checkpoint,
    );
    const proposalLocationEvidence = structuredLocationEvidenceForWindow(
        proposal,
        proposal,
    );
    const structuredCheckpoint = checkpointLocationEvidence !== null;
    const structuredProposal = proposalLocationEvidence !== null;
    const precisionRegression = proposedWidth > checkpointWidth
        || proposedTopYear !== checkpointTopYear;
    return {
        concentration: proposalLocationEvidence?.concentration
            ?? noteNumber(proposal, "counterfactual_window_concentration="),
        remoteMargin: proposalLocationEvidence?.remoteMargin
            ?? noteNumber(proposal, "counterfactual_window_remote_margin="),
        coarseOverlapConsensus: noteNumber(
        proposal,
        "counterfactual_coarse_overlap_consensus=",
        ),
        coarseModelMargin: noteNumber(
        proposal,
        "counterfactual_coarse_model_margin=",
        ),
        pairReferenceCount: proposalLocationEvidence?.referenceCount
            ?? noteNumber(proposal, "counterfactual_pair_reference_count="),
        partialSideStepRemoteMargin: noteNumber(
        proposal,
        "partial_side_step_remote_margin=",
        ),
        proposedLocationFamilyCount,
        checkpointLocationFamilyCount,
        locationFamilyAdvantage:
            proposedLocationFamilyCount - checkpointLocationFamilyCount,
        operationLocationGain: Math.max(
            noteNumber(proposal, "partial_reference_vote_gain="),
            noteNumber(proposal, "reference_vote_gain="),
            noteNumber(proposal, "partial_exhaustive_vote_gain="),
            noteNumber(proposal, "joint_operation_top3_difference_gain="),
        ),
        structuredCheckpoint,
        structuredProposal,
        checkpointTopYear,
        proposedTopYear,
        checkpointWidth,
        proposedWidth,
        checkpointTopFamilyCount,
        proposedTopFamilyCount,
        precisionRegression,
    };
};

export const hasStrongDetachedLocatorEvidence = (
    evidence: LocatorAdjudicationEvidence,
    overrides: Partial<LocatorAdjudicationConfig> = {},
): boolean => {
    const config = { ...DEFAULT_LOCATOR_ADJUDICATION_CONFIG, ...overrides };
    const strongChannels = [
        evidence.concentration >= config.minimumConcentration,
        evidence.remoteMargin >= config.minimumRemoteMargin,
        evidence.coarseOverlapConsensus
            >= config.minimumCoarseOverlapConsensus,
        evidence.coarseModelMargin >= config.minimumCoarseModelMargin,
        evidence.partialSideStepRemoteMargin
            >= config.minimumPartialSideStepRemoteMargin,
        evidence.proposedLocationFamilyCount
            >= config.minimumLocationFamilyCount
            && evidence.locationFamilyAdvantage
                >= config.minimumLocationFamilyAdvantage,
    ].filter(Boolean).length;
    const calibratedLocatorStrength = evidence.pairReferenceCount
        >= config.minimumPairReferenceCount
        && strongChannels >= config.minimumStrongChannels;
    const independentlyLocatedOperation = evidence.proposedLocationFamilyCount
        >= config.minimumLocationFamilyCount
        && evidence.locationFamilyAdvantage
            >= config.minimumLocationFamilyAdvantage
        && evidence.operationLocationGain
            >= config.minimumOperationLocationGain;
    return calibratedLocatorStrength || independentlyLocatedOperation;
};

const annotateDecision = (
    event: DiagnosisEvent,
    reason: DiagnosisLocatorDecisionReason,
    proposal: DiagnosisEvent | null,
): DiagnosisEvent => ({
    ...event,
    evidence: {
        ...event.evidence,
        algorithmSources: Array.from(new Set([
            ...event.evidence.algorithmSources,
            "event_hypothesis_adjudicator",
        ])).sort(),
        notes: Array.from(new Set([
            ...event.evidence.notes,
            `locator_adjudication=${reason}`,
            ...(proposal ? [
                `locator_proposed_window=${proposal.startYear}-${proposal.endYear}`,
            ] : []),
        ])),
    },
});

export const adjudicateLocatorProposal = (
    checkpoint: DiagnosisEvent,
    proposal: DiagnosisEvent | null,
    overrides: Partial<LocatorAdjudicationConfig> = {},
): LocatorProposalAdjudication => {
    if (!proposal) {
        const evidence = locatorEvidence(checkpoint, checkpoint);
        return {
            event: annotateDecision(checkpoint, "no_locator_proposal", null),
            proposedEvent: null,
            reason: "no_locator_proposal",
            accepted: false,
            overlapYears: 0,
            centerDistanceYears: 0,
            operationContractValid: true,
            detachedEvidenceStrong: false,
            precisionRegression: false,
            evidence,
        };
    }

    const sharedYears = overlapYears(checkpoint, proposal);
    const centerDistanceYears = Math.abs(
        centerYear(checkpoint) - centerYear(proposal),
    );
    const operationContractValid = locatorPreservesOperationContract(
        checkpoint,
        proposal,
    );
    const evidence = locatorEvidence(checkpoint, proposal);
    const detachedEvidenceStrong = hasStrongDetachedLocatorEvidence(
        evidence,
        overrides,
    );
    const protectedPrecisionRegression = evidence.structuredCheckpoint
        && evidence.precisionRegression
        && !detachedEvidenceStrong;
    const reason: DiagnosisLocatorDecisionReason = !operationContractValid
        ? "fallback_operation_contract"
        : sharedYears > 0
            ? protectedPrecisionRegression
                ? "fallback_overlapping_precision_regression"
                : evidence.precisionRegression && detachedEvidenceStrong
                    ? "accepted_overlapping_strong_mode"
                    : "accepted_overlapping_mode"
            : detachedEvidenceStrong
                ? "accepted_detached_strong_mode"
                : "fallback_detached_locator_mode";
    const accepted = reason === "accepted_overlapping_mode"
        || reason === "accepted_overlapping_strong_mode"
        || reason === "accepted_detached_strong_mode";
    const selected = accepted ? proposal : checkpoint;
    return {
        event: annotateDecision(selected, reason, proposal),
        proposedEvent: proposal,
        reason,
        accepted,
        overlapYears: sharedYears,
        centerDistanceYears,
        operationContractValid,
        detachedEvidenceStrong,
        precisionRegression: evidence.precisionRegression,
        evidence,
    };
};

export type ReviewHypothesisAdjudicationReason =
    | "selected"
    | "no_unit_hypothesis"
    | "lag_direction_conflict"
    | "operation_type_conflict"
    | "competing_remote_modes";

export type ReviewHypothesisAdjudicationConfig = {
    remoteModeDistanceYears: number;
    minimumRemoteModeStrengthMargin: number;
    minimumOperationStrengthMargin: number;
};

export type ReviewHypothesisAdjudication = {
    reason: ReviewHypothesisAdjudicationReason;
    event: DiagnosisEvent | null;
    sourceStage: DiagnosisReviewSourceStage | null;
};

const reviewStagePriority: Record<DiagnosisReviewSourceStage, number> = {
    final: 6,
    displayed: 5,
    retained: 4,
    fused: 3,
    detected: 2,
    candidate: 1,
};

const reviewEventCenterYear = (event: DiagnosisEvent): number => (
    [...event.rankedYears].sort((left, right) => (
        left.rank - right.rank || right.score - left.score || right.year - left.year
    ))[0]?.year ?? Math.round((event.startYear + event.endYear) / 2)
);

const reviewEventStrength = (checkpoint: DiagnosisReviewEventCheckpoint): number => {
    const confidenceStrength = checkpoint.event.confidenceLevel === "high"
        ? 0.2
        : checkpoint.event.confidenceLevel === "medium"
            ? 0.1
            : 0;
    return checkpoint.event.evidence.score
        + checkpoint.event.evidence.scoreMargin
        + confidenceStrength
        + reviewStagePriority[checkpoint.stage] * 0.01;
};

const isUnitReviewEvent = (event: DiagnosisEvent): boolean => (
    event.eventType === "missingRing" || event.eventType === "falseRing"
);

const hasConsistentUnitReviewDirection = (event: DiagnosisEvent): boolean => {
    if (!isUnitReviewEvent(event)
        || event.evidence.lagBefore === null
        || event.evidence.lagAfter === null) return false;
    const transition = event.evidence.lagAfter - event.evidence.lagBefore;
    return event.eventType === "missingRing" ? transition === 1 : transition === -1;
};

const deduplicateReviewCheckpoints = (
    checkpoints: readonly DiagnosisReviewEventCheckpoint[],
): DiagnosisReviewEventCheckpoint[] => {
    const selected = new Map<string, DiagnosisReviewEventCheckpoint>();
    checkpoints.forEach((checkpoint) => {
        const event = checkpoint.event;
        const key = [
            event.eventType,
            event.startYear,
            event.endYear,
            reviewEventCenterYear(event),
            event.shiftYears ?? "",
        ].join(":");
        const current = selected.get(key);
        if (!current
            || reviewStagePriority[checkpoint.stage]
                > reviewStagePriority[current.stage]) {
            selected.set(key, checkpoint);
        }
    });
    return [...selected.values()];
};

/** Selects one already-complete unit hypothesis; it never rebuilds its operation or window. */
export const adjudicateReviewEventHypothesis = (
    checkpoints: readonly DiagnosisReviewEventCheckpoint[],
    config: ReviewHypothesisAdjudicationConfig,
): ReviewHypothesisAdjudication => {
    const unitEvents = deduplicateReviewCheckpoints(checkpoints)
        .filter(({ event }) => isUnitReviewEvent(event));
    if (unitEvents.length === 0) {
        return { reason: "no_unit_hypothesis", event: null, sourceStage: null };
    }
    const directed = unitEvents.filter(({ event }) => (
        hasConsistentUnitReviewDirection(event)
    ));
    if (directed.length === 0) {
        return { reason: "lag_direction_conflict", event: null, sourceStage: null };
    }
    directed.sort((left, right) => (
        reviewEventStrength(right) - reviewEventStrength(left)
        || reviewEventCenterYear(right.event) - reviewEventCenterYear(left.event)
    ));
    const selected = directed[0];
    const selectedStrength = reviewEventStrength(selected);
    const operationCompetitor = directed.find(({ event }) => (
        event.eventType !== selected.event.eventType
    ));
    if (operationCompetitor
        && selectedStrength - reviewEventStrength(operationCompetitor)
            < config.minimumOperationStrengthMargin) {
        return { reason: "operation_type_conflict", event: null, sourceStage: null };
    }
    const remoteCompetitor = directed.find(({ event }) => (
        event.eventType === selected.event.eventType
        && Math.abs(
            reviewEventCenterYear(event) - reviewEventCenterYear(selected.event),
        ) > config.remoteModeDistanceYears
    ));
    if (remoteCompetitor
        && selectedStrength - reviewEventStrength(remoteCompetitor)
            < config.minimumRemoteModeStrengthMargin) {
        return { reason: "competing_remote_modes", event: null, sourceStage: null };
    }
    return {
        reason: "selected",
        event: selected.event,
        sourceStage: selected.stage,
    };
};

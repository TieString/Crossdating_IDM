/**
 * Event-level ensemble for the internal diagnosis engine.
 *
 * The constrained lag path supplies narrow, potentially repeated changepoints. Existing
 * counterfactual candidates supply conservative operation/type support and remain the only
 * executable objects. The ensemble never applies an edit.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import { cofechaStyleStandardize } from "../reference";
import {
    createLagPathCache,
    diagnoseLagPath,
    type EventPathConfig,
    type LagPathCache,
    type LagPathDiagnosis,
} from "./eventPath";
import { makeDiagnosisEventsFromCandidates } from "./events";
import {
    refineEventYearsJointly,
    scoreDiagnosisEventSets,
    type DiagnosisEventSetScore,
    type JointEventRefinementConfig,
} from "./jointEventRefinement";
import { locateDenseLagProfileEvents } from "./denseLagProfile";
import { locateSegmentedLagEvents } from "./segmentedEventPath";
import { refinePartialMoveWithRepeatedBlock } from "./partialBreakpointRefinement";
import { refineUnitEventWithIndependentBreakpoints } from "./pairedCoreBreakpoint";
import { diagnoseSeriesCore } from "./segments";
import {
    refineEventsWithReferenceVoting,
    type AdjacentUnitPairVote,
    voteForAdjacentUnitPair,
    voteForAdjacentUnitPairLocalized,
} from "./eventReferenceVoting";
import {
    refineUnitEventWindows,
    type UnitWindowRefinementConfig,
} from "./eventWindowRefinement";
import {
    addFalseRingUnscoredBoundaryGuard,
    addUnitEventEvidenceEdgeGuard,
    addUnitEventRankEdgeGuard,
    refineUnitEventWithLocalEditScores,
    rerankMissingRingWithNeighborAgreement,
    restoreUnitEventLocalYearRanking,
} from "./unitBreakpointRefinement";
import { locateReturnToZeroEvents } from "./transitionScan";
import { verifyDiagnosisEvent } from "./eventVerification";
import { addCumulativeLocationAlternatives } from "./eventLocationAlternatives";
import {
    applyDecisiveJointOperationFusion,
    DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG,
    recoverSingleEventOperationSuggestions,
    rerankEventYearsByAnchorConsensus,
    type EventOperationRecoveryConfig,
} from "./eventOperationRecovery";
import {
    addDiagnosisReviewWindowPadding,
    restoreUnlocalizedFalseRingReviewWindow,
} from "./eventReviewWindow";
import { rerankMissingEventsNearExplicitZeros } from "./explicitZeroRanking";
import {
    createEndpointResidualWindowCache,
    refineUnitEventWithEndpointResidualWindow,
} from "./endpointResidualWindow";
import { refineEventWithCounterfactualLocator } from "./counterfactualEventLocator";
import {
    isAutomaticPartialShift,
} from "./partialMoveSemantics";
import type {
    DiagnosisCandidateOperation,
    DiagnosisEvent,
    DiagnosisEventType,
    EffectiveDiagnosisConfig,
    NumericSeries,
    SeriesCoreDiagnosis,
} from "./types";

export const INTERNAL_EVENT_PATH_CONFIG: Partial<EventPathConfig> = {
    useCofechaStandardization: true,
    transitionPenaltyUnit: 9.5,
    transitionPenaltyBig: 10,
    transitionPenaltyPerYear: 1.5,
    minTransitionGain: 1,
    minRunYears: 18,
    missingBoundaryYearAdjustment: -1,
    falseBoundaryYearAdjustment: -1,
    partialBoundaryYearAdjustment: 0,
    excludeTransitionDifferenceFromLocalization: true,
    multiTransitionMissingBoundaryYearAdjustment: -1,
    multiTransitionFalseBoundaryYearAdjustment: 0,
    multiTransitionPartialBoundaryYearAdjustment: 0,
    multiTransitionPartialRankYearAdjustment: 0,
    enablePulseScan: false,
};

export type DiagnosisEventEnsembleOptions = {
    eventPathConfig?: Partial<EventPathConfig>;
    jointEventRefinementConfig?: Partial<JointEventRefinementConfig>;
    enableMissingWindowRefinement?: boolean;
    enableReferenceVoting?: boolean;
    wholeOffsetUnitRankAdjustment?: number;
    unitWindowRefinementConfig?: Partial<UnitWindowRefinementConfig>;
    enableLearnedWindowRanking?: boolean;
    enableIndependentBreakpointConsensus?: boolean;
    enableTargetedPathVerification?: boolean;
    enableCumulativeLocationAlternatives?: boolean;
    enableGainGatedOperationRecovery?: boolean;
    enableDecisiveJointOperationFusion?: boolean;
    eventOperationRecoveryConfig?: Partial<EventOperationRecoveryConfig>;
    enableMixedReferenceSupplement?: boolean;
    enableIncoherentPartialPruning?: boolean;
    enableUnitNeighborRanking?: boolean;
    enableEndpointResidualWindow?: boolean;
    reviewWindowPaddingYears?: number;
    reviewWindowDirectionalExtraYears?: number;
    enableCounterfactualEventLocator?: boolean;
};

export const INTERNAL_EVENT_ENSEMBLE_OPTIONS: DiagnosisEventEnsembleOptions = {
    enableGainGatedOperationRecovery: false,
    enableDecisiveJointOperationFusion: true,
    enableMixedReferenceSupplement: true,
    enableIncoherentPartialPruning: true,
    enableUnitNeighborRanking: true,
    enableEndpointResidualWindow: true,
    enableCounterfactualEventLocator: true,
    eventOperationRecoveryConfig: {
        outputSingleMainWindow: true,
        verificationHypothesisCount: 3,
        primaryDecisionHypothesisCount: 3,
    },
};

export const shouldRunMixedReferencePass = (
    primary: DiagnosisEvent[],
): boolean => {
    if (primary.length === 0) return false;
    const localEvents = primary.filter((event) => event.eventType !== "wholeSeriesMove");
    const hasWhole = primary.length > localEvents.length;
    const weakPartialSingleton = (
        primary.length === 1
        && primary[0].eventType === "partialMove"
        && primary[0].evidence.score < 1
    );
    return hasWhole || localEvents.length >= 2 || weakPartialSingleton;
};

export const shouldSelectMixedReferenceAlternative = (
    primary: DiagnosisEvent[],
    alternate: DiagnosisEvent[],
    primaryScore: DiagnosisEventSetScore,
    alternateScore: DiagnosisEventSetScore,
): boolean => {
    const primaryHasWhole = primary.some((event) => (
        event.eventType === "wholeSeriesMove"
    ));
    const alternateHasWhole = alternate.some((event) => (
        event.eventType === "wholeSeriesMove"
    ));
    const primaryRemovedIncoherentPartial = primary.some((event) => (
        event.evidence.notes.some((note) => (
            note.startsWith("incoherent_partial_supplements_removed=")
        ))
    ));
    const scoreSupportedGrowth = (
        !primaryRemovedIncoherentPartial
        &&
        alternateScore.score > primaryScore.score + 0.015
        && alternateScore.localEventCount > primaryScore.localEventCount
    );
    const replacesWholeWithLocalChain = (
        primaryHasWhole
        && !alternateHasWhole
        && alternateScore.localEventCount >= 2
    );
    const primaryMaximumEvidence = Math.max(
        ...primary.map((event) => event.evidence.score),
    );
    const alternateMinimumEvidence = Math.min(
        ...alternate.map((event) => event.evidence.score),
    );
    const replacesWeakSingleton = (
        primary.length === 1
        && primaryMaximumEvidence < 1
        && alternate.length > 1
        && alternateMinimumEvidence > 1
    );
    return scoreSupportedGrowth
        || replacesWholeWithLocalChain
        || replacesWeakSingleton;
};

const PARTIAL_SEGMENTED_OUTPUT_ADJUSTMENT = 0;

const typeEvents = (
    events: DiagnosisEvent[],
    eventType: DiagnosisEventType,
): DiagnosisEvent[] => events
    .filter((event) => event.eventType === eventType)
    .sort((a, b) => b.evidence.score - a.evidence.score || b.endYear - a.endYear);

const eventOverlap = (a: DiagnosisEvent, b: DiagnosisEvent, padding = 0): boolean => (
    Math.max(a.startYear, b.startYear - padding)
        <= Math.min(a.endYear, b.endYear + padding)
);

const partialEventsAgree = (a: DiagnosisEvent, b: DiagnosisEvent): boolean => (
    a.eventType === "partialMove"
    && b.eventType === "partialMove"
    && a.shiftYears === b.shiftYears
    && a.shiftSide === b.shiftSide
    && eventOverlap(a, b)
);

const shiftEventWindow = (
    event: DiagnosisEvent,
    deltaYears: number,
    diagnosis: SeriesCoreDiagnosis,
): DiagnosisEvent => {
    const width = event.endYear - event.startYear + 1;
    const requestedStart = event.startYear + deltaYears;
    const startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(requestedStart, diagnosis.targetRange.endYear - width + 1),
    );
    const actualDelta = startYear - event.startYear;
    return {
        ...event,
        id: `${event.id}-boundary-adjusted-${actualDelta}`,
        startYear,
        endYear: startYear + width - 1,
        rankedYears: event.rankedYears.map((row) => ({
            ...row,
            year: row.year + actualDelta,
        })),
        evidence: {
            ...event.evidence,
            notes: [
                ...event.evidence.notes,
                `output_boundary_adjustment=${actualDelta}`,
            ],
        },
    };
};

const shiftEventCalendar = (event: DiagnosisEvent, deltaYears: number): DiagnosisEvent => ({
    ...event,
    id: `${event.id}-calendar-shift-${deltaYears}`,
    startYear: event.startYear + deltaYears,
    endYear: event.endYear + deltaYears,
    rankedYears: event.rankedYears.map((row) => ({
        ...row,
        year: row.year + deltaYears,
    })),
});

const adjustEventRankingCalendar = (
    event: DiagnosisEvent,
    deltaYears: number,
): DiagnosisEvent => {
    if (deltaYears === 0 || event.rankedYears.length === 0) return event;
    const byYear = new Map(event.rankedYears.map((row) => [row.year, row]));
    const minimumScore = Math.min(...event.rankedYears.map((row) => row.score));
    const rankedYears = Array.from(
        { length: event.endYear - event.startYear + 1 },
        (_, index) => {
            const year = event.startYear + index;
            const source = byYear.get(year - deltaYears);
            return {
                year,
                score: source?.score ?? minimumScore - 1,
                evidenceTags: Array.from(new Set([
                    ...(source?.evidenceTags ?? []),
                    "whole_offset_calendar_rank_adjustment",
                ])).sort(),
            };
        },
    )
        .sort((a, b) => b.score - a.score || a.year - b.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...event,
        id: `${event.id}-whole-offset-rank-${deltaYears}`,
        rankedYears,
        evidence: {
            ...event.evidence,
            notes: [
                ...event.evidence.notes,
                `whole_offset_unit_rank_adjustment=${deltaYears}`,
            ],
        },
    };
};

const noteYear = (event: DiagnosisEvent, prefix: string): number | null => {
    const note = event.evidence.notes.find((value) => value.startsWith(prefix));
    if (!note) return null;
    const year = Number(note.slice(prefix.length));
    return Number.isFinite(year) ? year : null;
};

const inferWholeOffsetUnitRankAdjustment = (
    event: DiagnosisEvent,
    originalEvent: DiagnosisEvent,
): number => {
    if (event.eventType !== "missingRing") return 0;
    const topYear = event.rankedYears[0]?.year;
    const originalTopYear = originalEvent.rankedYears[0]?.year;
    if (topYear === undefined || originalTopYear === undefined) return 0;

    if (event.evidence.algorithmSources.includes("reference_core_voting")
        && topYear <= event.endYear - 2) {
        return -1;
    }

    const scanTopYear = noteYear(event, "scan_top_year=");
    return topYear === originalTopYear
        && scanTopYear !== null
        && scanTopYear < topYear
        && topYear - scanTopYear <= 3
        ? -1
        : 0;
};

const alignDiagnosisCalendar = (
    diagnosis: SeriesCoreDiagnosis,
    lag: number,
): SeriesCoreDiagnosis => ({
    ...diagnosis,
    rawTarget: new Map(Array.from(diagnosis.rawTarget.entries()).map(([year, value]) => (
        [year + lag, value]
    ))),
    targetRange: {
        startYear: diagnosis.targetRange.startYear + lag,
        endYear: diagnosis.targetRange.endYear + lag,
    },
});

const withMultiviewSupport = (
    event: DiagnosisEvent,
    supporters: DiagnosisEvent[],
): DiagnosisEvent => ({
    ...event,
    evidence: {
        ...event.evidence,
        algorithmSources: Array.from(new Set([
            ...event.evidence.algorithmSources,
            ...supporters.flatMap((supporter) => supporter.evidence.algorithmSources),
        ])).sort(),
        notes: Array.from(new Set([
            ...event.evidence.notes,
            "partial_move_multiview_support",
        ])),
    },
});

const locateMultiviewPartialEvents = (
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis,
    primaryEvents: DiagnosisEvent[],
    rawPathEvents: DiagnosisEvent[],
): DiagnosisEvent[] => {
    const largeLagSegments = diagnosis.segments.filter((segment) => (
        segment.flagged && Math.abs(segment.bestLag) >= 2
    ));
    const hasLargeLagSignal = primaryEvents.some((event) => event.eventType === "partialMove")
        || diagnosis.propagationPatterns.some((pattern) => (
            pattern.patternType === "possiblePartialRangeMove"
            && Math.abs(pattern.dominantLag) >= 2
        ))
        || largeLagSegments.length >= 2;
    if (!hasLargeLagSignal) return primaryEvents;
    const raw = rawPathEvents.filter((event) => (
        event.eventType === "partialMove"
        && event.evidence.algorithmSources.includes("piecewise_lag_path")
    ));
    const segmented = locateSegmentedLagEvents(cofechaDiagnosis, {
        minRunYears: 14,
        maxSegments: 5,
        transitionPenalty: 7,
        largeTransitionPenalty: 8,
        minLocalGain: 3,
    }).filter((event) => event.eventType === "partialMove");
    const dense = locateDenseLagProfileEvents(cofechaDiagnosis, {
        windowYears: 21,
        stepYears: 2,
        transitionPenaltyUnit: 1.4,
        transitionPenaltyBig: 1.8,
        minRunYears: 10,
        minSideMeanAdvantage: 0.04,
        minBoundaryGain: 0.08,
    }).filter((event) => event.eventType === "partialMove");

    const supported: DiagnosisEvent[] = [];
    const addSupported = (
        event: DiagnosisEvent,
        otherViews: DiagnosisEvent[][],
        output = event,
    ) => {
        const supporters = otherViews.flatMap((view) => (
            view.filter((other) => partialEventsAgree(event, other))
        ));
        if (supporters.length > 0) supported.push(withMultiviewSupport(output, supporters));
    };
    raw.forEach((event) => addSupported(event, [segmented, dense]));
    segmented.forEach((event) => addSupported(
        event,
        [raw, dense],
        shiftEventWindow(event, PARTIAL_SEGMENTED_OUTPUT_ADJUSTMENT, diagnosis),
    ));
    dense.forEach((event) => addSupported(event, [raw, segmented]));

    const merged = [...primaryEvents];
    supported
        .sort((a, b) => (
            Number(b.evidence.algorithmSources.includes("piecewise_lag_path"))
                - Number(a.evidence.algorithmSources.includes("piecewise_lag_path"))
            || b.evidence.score - a.evidence.score
        ))
        .forEach((event) => {
            if (!merged.some((other) => eventOverlap(event, other))) merged.push(event);
        });
    return merged;
};

const withCandidateSupport = (
    event: DiagnosisEvent,
    candidateEvents: DiagnosisEvent[],
): DiagnosisEvent => {
    const supporting = candidateEvents.filter((candidate) => (
        candidate.eventType === event.eventType
        && eventOverlap(event, candidate, 6)
        && (event.eventType !== "partialMove"
            || (candidate.shiftYears === event.shiftYears
                && candidate.shiftSide === event.shiftSide))
    ));
    if (supporting.length === 0) return event;
    return {
        ...event,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                ...supporting.flatMap((candidate) => candidate.evidence.algorithmSources),
            ])).sort(),
            candidateIds: Array.from(new Set([
                ...event.evidence.candidateIds,
                ...supporting.flatMap((candidate) => candidate.evidence.candidateIds),
            ])),
            notes: Array.from(new Set([
                ...event.evidence.notes,
                "counterfactual_candidate_support",
            ])),
        },
    };
};

export const pruneUnsupportedFalseRingPathSupplements = (
    events: DiagnosisEvent[],
    hasCandidateOperation: boolean,
): DiagnosisEvent[] => {
    if (!hasCandidateOperation || events.length <= 1) return events;
    const independentlySupported = events.filter((event) => (
        event.evidence.candidateIds.length > 0
        || event.evidence.notes.includes("counterfactual_candidate_support")
    ));
    return independentlySupported.length > 0 ? independentlySupported : events;
};

const withTargetedCandidateVerification = (
    event: DiagnosisEvent,
    candidates: DiagnosisCandidateOperation[],
): DiagnosisEvent => {
    const best = candidates[0];
    const delta = best?.evidence.evaluationDelta;
    return {
        ...event,
        evidence: {
            ...event.evidence,
            candidateIds: Array.from(new Set([
                ...event.evidence.candidateIds,
                ...candidates.map((candidate) => candidate.id),
            ])),
            notes: Array.from(new Set([
                ...event.evidence.notes,
                "targeted_path_candidate_verified",
                `targeted_verification_candidate_count=${candidates.length}`,
                ...(best ? [
                    `targeted_verification_best_year=${best.targetYear ?? best.anchorYear}`,
                    `targeted_verification_best_score=${best.score.toFixed(6)}`,
                    `targeted_verification_probability=${best.probabilityLike.toFixed(6)}`,
                    `targeted_verification_resolved_segments=${best.evidence.resolvedSegmentCount}`,
                ] : []),
                ...(delta ? [
                    `targeted_verification_hard_conditions=${delta.hardGatePassedConditions}`,
                    `targeted_verification_mean_r_delta=${delta.meanSegmentRDelta.toFixed(6)}`,
                    `targeted_verification_whole_r_delta=${delta.wholeSeriesRDelta.toFixed(6)}`,
                    `targeted_verification_local_r_delta=${delta.localBoundaryRDelta?.toFixed(6) ?? "none"}`,
                    `targeted_verification_lag_recovery=${delta.lagRecoveryScore.toFixed(6)}`,
                ] : []),
            ])),
        },
    };
};

const coherentTargetedFalseVerification = (
    candidate: DiagnosisCandidateOperation,
): boolean => {
    const delta = candidate.evidence.evaluationDelta;
    return Boolean(
        delta
        && delta.hardGatePassedConditions >= 4
        && delta.meanSegmentRDelta >= 0.005
        && delta.wholeSeriesRDelta >= 0.015
        && (delta.localBoundaryRDelta ?? 0) >= 0.05
        && !delta.introducedNewStrongProblem,
    );
};

const keepWholeSeriesEvent = (
    whole: DiagnosisEvent | undefined,
    partialEvents: DiagnosisEvent[],
    pathDiagnosis: LagPathDiagnosis,
): DiagnosisEvent[] => {
    if (!whole) return [];
    if (pathDiagnosis.newestLag === 0 && pathDiagnosis.newestLagMargin >= 1) return [];
    if (partialEvents.length === 0) return [whole];
    // A partial transition that returns to lag 0 explains a local move without a whole-series
    // offset. A non-zero newer-side lag is the signature needed to retain both event types.
    const hasIndependentWholeOffset = partialEvents.some((event) => (
        event.evidence.lagAfter !== null && event.evidence.lagAfter !== 0
    ));
    return hasIndependentWholeOffset ? [{
        ...whole,
        evidence: {
            ...whole.evidence,
            notes: [
                ...whole.evidence.notes,
                `newest_tail_lag=${pathDiagnosis.newestLag}`,
                `newest_tail_lag_margin=${pathDiagnosis.newestLagMargin.toFixed(3)}`,
            ],
        },
    }] : [];
};

const hasCoherentLagChain = (events: DiagnosisEvent[]): boolean => {
    const ordered = events
        .filter((event) => event.eventType !== "wholeSeriesMove")
        .sort((left, right) => right.endYear - left.endYear || right.startYear - left.startYear);
    return ordered.length > 0 && ordered.every((event, index) => {
        const older = ordered[index + 1];
        return event.evidence.lagBefore !== null
            && event.evidence.lagAfter !== null
            && (!older || event.evidence.lagBefore === older.evidence.lagAfter);
    });
};

/**
 * A coherent chain of two or more unit events already fixes the cumulative lag states. A
 * supplemental partial move that cannot join that chain is contradictory evidence, while the
 * unit events themselves remain untouched.
 */
export const pruneIncoherentPartialSupplements = (
    events: DiagnosisEvent[],
): DiagnosisEvent[] => {
    if (events.some((event) => event.eventType === "wholeSeriesMove")) return events;
    const localEvents = events.filter((event) => event.eventType !== "wholeSeriesMove");
    const unitEvents = localEvents.filter((event) => (
        event.eventType === "missingRing" || event.eventType === "falseRing"
    ));
    if (unitEvents.length < 2 || !hasCoherentLagChain(unitEvents)) return events;
    const rejectedIds = new Set(localEvents
        .filter((event) => (
            event.eventType === "partialMove"
            && event.evidence.candidateIds.length === 0
            && !event.evidence.algorithmSources.includes(
                "counterfactual_operation_verification",
            )
            && !event.evidence.algorithmSources.includes(
                "local_corrected_raw_breakpoint",
            )
            && !event.evidence.algorithmSources.includes(
                "unique_repeated_block_boundary",
            )
            && !hasCoherentLagChain([...unitEvents, event])
        ))
        .map((event) => event.id));
    if (rejectedIds.size === 0) return events;
    return events
        .filter((event) => !rejectedIds.has(event.id))
        .map((event) => ({
            ...event,
            evidence: {
                ...event.evidence,
                notes: [
                    ...event.evidence.notes,
                    `incoherent_partial_supplements_removed=${rejectedIds.size}`,
                ],
            },
        }));
};

export const passesJointNecessityPairGate = (
    vote: AdjacentUnitPairVote,
    localizedVote: AdjacentUnitPairVote,
    pulseDurationYears: number,
): boolean => (
    vote.orientation === "missingThenFalse"
    && vote.remoteMargin >= 0.01
    && vote.jointExcessGain >= 0.3
    && localizedVote.gain >= 0.07
    && localizedVote.remoteMargin >= 0.05
    && localizedVote.referenceCount >= 8
    && localizedVote.positiveReferenceFraction >= 0.875
    && localizedVote.lowerQuartileReferenceGain >= 0.025
    && localizedVote.jointExcessGain >= 0.18
    && Number.isFinite(pulseDurationYears)
    && pulseDurationYears <= 14
);

export const passesUnhintedAdjacentPairGate = (
    vote: AdjacentUnitPairVote,
): boolean => (
    vote.gain >= 0.085
    && vote.remoteMargin >= 0.05
    && vote.referenceCount >= 8
    && vote.positiveReferenceFraction >= 0.999
    && vote.lowerQuartileReferenceGain >= 0.06
    && vote.jointExcessGain >= 0.3
);

const locateReferenceVerifiedPulse = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    eventPathConfig: Partial<EventPathConfig>,
    pathCache: LagPathCache,
    allowUnhintedLocalizedPair = true,
): DiagnosisEvent[] => {
    const annotate = (
        events: DiagnosisEvent[],
        source: "reference_verified_bounded_pulse" | "reference_verified_localized_pair",
        algorithmSource: "bounded_lag_pulse" | "localized_reference_pair",
    ): DiagnosisEvent[] => events.map((event) => ({
        ...event,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                algorithmSource,
            ])).sort(),
            notes: [...event.evidence.notes, source],
        },
    }));
    const pulseEvents = diagnoseLagPath(diagnosis, siteData, {
        ...eventPathConfig,
        enablePulseScan: true,
        maxPulseYears: 14,
        maxPulseCount: 1,
        minPulseGain: 3,
        minPulseContextGain: 0.3,
    }, pathCache).events.filter((event) => (
        event.evidence.algorithmSources.includes("bounded_lag_pulse")
    ));
    if (pulseEvents.length === 2) {
        const ordered = [...pulseEvents].sort((a, b) => a.startYear - b.startYear);
        const [older, newer] = ordered;
        if (older.eventType !== newer.eventType
            && (older.eventType === "missingRing" || older.eventType === "falseRing")
            && (newer.eventType === "missingRing" || newer.eventType === "falseRing")) {
            const pulseDurationYears = Number(
                older.evidence.notes.find((note) => (
                    note.startsWith("pulse_duration_years=")
                ))?.slice("pulse_duration_years=".length),
            );
            const hint = {
                orientation: older.eventType === "missingRing"
                    ? "missingThenFalse" as const
                    : "falseThenMissing" as const,
                olderYear: Math.round((older.startYear + older.endYear) / 2),
                newerYear: Math.round((newer.startYear + newer.endYear) / 2),
                maximumDistance: 4,
            };
            const vote = voteForAdjacentUnitPair(diagnosis, siteData, hint);
            if (vote && vote.gain >= 0.005 && vote.remoteMargin >= 0.003) {
                const localizedVote = voteForAdjacentUnitPairLocalized(
                    diagnosis,
                    siteData,
                    hint,
                );
                const passesStandardGate = vote.gain >= 0.015
                    && vote.remoteMargin >= 0.005
                    && (vote.masterRemoteMargin >= 0.015 || vote.gain >= 0.05)
                    && localizedVote !== null
                    && localizedVote.referenceCount >= 5
                    && localizedVote.positiveReferenceFraction >= 0.9
                    && localizedVote.lowerQuartileReferenceGain >= 0.05
                    && (localizedVote.masterRemoteMargin >= 0.015 || vote.gain >= 0.05);
                const passesStrongLocalConsensus = localizedVote !== null
                    && vote.remoteMargin >= 0.005
                    && localizedVote.gain >= 0.13
                    && localizedVote.referenceCount >= 8
                    && localizedVote.positiveReferenceFraction >= 0.9375
                    && localizedVote.lowerQuartileReferenceGain >= 0.09
                    && Number.isFinite(pulseDurationYears)
                    && pulseDurationYears <= 12;
                const passesJointNecessityGate = localizedVote !== null
                    && passesJointNecessityPairGate(
                        vote,
                        localizedVote,
                        pulseDurationYears,
                    );
                if (localizedVote && (
                    passesStandardGate
                    || passesStrongLocalConsensus
                    || passesJointNecessityGate
                )) {
                    return annotate(
                        vote.events.map((event) => ({
                            ...event,
                            evidence: {
                                ...event.evidence,
                                notes: [
                                    ...event.evidence.notes,
                                    `localized_pair_gain=${localizedVote.gain.toFixed(6)}`,
                                    `localized_pair_margin=${localizedVote.remoteMargin.toFixed(6)}`,
                                    `localized_pair_positive_fraction=${localizedVote.positiveReferenceFraction.toFixed(6)}`,
                                    `localized_pair_lower_quartile_gain=${localizedVote.lowerQuartileReferenceGain.toFixed(6)}`,
                                    `localized_pair_master_remote_margin=${localizedVote.masterRemoteMargin.toFixed(6)}`,
                                    `localized_pair_gate=${passesStandardGate
                                        ? "standard"
                                        : passesStrongLocalConsensus
                                            ? "strong_local_consensus"
                                            : "joint_necessity"}`,
                                    `localized_pair_joint_excess_gain=${
                                        localizedVote.jointExcessGain.toFixed(6)
                                    }`,
                                    `global_pair_joint_excess_gain=${
                                        vote.jointExcessGain.toFixed(6)
                                    }`,
                                    `bounded_pulse_score=${older.evidence.score.toFixed(6)}`,
                                    ...older.evidence.notes.filter((note) => (
                                        note.startsWith("pulse_")
                                    )),
                                ],
                            },
                        })),
                        "reference_verified_bounded_pulse",
                        "bounded_lag_pulse",
                    );
                }
            }
        }
    }
    if (!allowUnhintedLocalizedPair) return [];
    const localizedVote = voteForAdjacentUnitPairLocalized(diagnosis, siteData);
    if (localizedVote && passesUnhintedAdjacentPairGate(localizedVote)) {
        return annotate(
            localizedVote.events.map((event) => ({
                ...event,
                evidence: {
                    ...event.evidence,
                    notes: [
                        ...event.evidence.notes,
                        "localized_pair_gate=unhinted_unanimous_joint_necessity",
                        `localized_pair_joint_excess_gain=${
                            localizedVote.jointExcessGain.toFixed(6)
                        }`,
                    ],
                },
            })),
            "reference_verified_localized_pair",
            "localized_reference_pair",
        );
    }
    return [];
};

const cofechaPreprocess = (series: NumericSeries): NumericSeries => new Map(
    cofechaStyleStandardize(series).map((point) => [point.year, point.value]),
);

const eventsForSeriesPass = (
    siteData: RwlSiteData,
    diagnosis: SeriesCoreDiagnosis,
    candidates: DiagnosisCandidateOperation[],
    effectiveConfig: EffectiveDiagnosisConfig,
    options: DiagnosisEventEnsembleOptions,
): DiagnosisEvent[] => {
    const pathCache = createLagPathCache();
    const eventPathConfig = {
        ...INTERNAL_EVENT_PATH_CONFIG,
        maxPartialGapYears: effectiveConfig.maxPartialGapYears,
        ...options.eventPathConfig,
    };
    const operationRecoveryConfig = {
        maxPartialGapYears: effectiveConfig.maxPartialGapYears,
        ...options.eventOperationRecoveryConfig,
    };
    const ownCandidates = candidates.filter((candidate) => candidate.targetTree === diagnosis.targetTree);
    const candidateEvents = makeDiagnosisEventsFromCandidates([diagnosis], ownCandidates);
    const cofechaDiagnosis = diagnoseSeriesCore(
        siteData,
        diagnosis.targetTree,
        effectiveConfig,
        cofechaPreprocess,
    );
    if (!cofechaDiagnosis) return candidateEvents;
    const pathDiagnosis = diagnoseLagPath(
        cofechaDiagnosis,
        siteData,
        eventPathConfig,
        pathCache,
    );
    let pathEvents = pathDiagnosis.events;
    const isUnitEvent = (event: DiagnosisEvent): boolean => (
        event.eventType === "missingRing" || event.eventType === "falseRing"
    );
    if (pathEvents.length >= 2 && pathEvents.every(isUnitEvent)) {
        const adaptiveEvents = diagnoseLagPath(cofechaDiagnosis, siteData, {
            ...eventPathConfig,
            adaptiveProfileWindowPlacement: true,
            profileWindowMaxShift: 1,
        }, pathCache).events;
        const signature = (events: DiagnosisEvent[]): string => events
            .map((event) => [
                event.eventType,
                event.evidence.lagBefore,
                event.evidence.lagAfter,
            ].join(":"))
            .sort()
            .join("|");
        if (adaptiveEvents.length === pathEvents.length
            && adaptiveEvents.every(isUnitEvent)
            && signature(adaptiveEvents) === signature(pathEvents)) {
            pathEvents = adaptiveEvents;
        }
    }
    const rawPathEvents = diagnoseLagPath(diagnosis, siteData, {
        ...eventPathConfig,
        useCofechaStandardization: false,
        enablePulseScan: false,
    }, pathCache).events;
    const hasWholeCandidate = typeEvents(candidateEvents, "wholeSeriesMove").length > 0;
    let cachedReferenceVerifiedFallback: DiagnosisEvent[] | null = null;
    const referenceVerifiedFallback = (): DiagnosisEvent[] => {
        if (cachedReferenceVerifiedFallback === null) {
            cachedReferenceVerifiedFallback = locateReferenceVerifiedPulse(
                cofechaDiagnosis,
                siteData,
                eventPathConfig,
                pathCache,
            );
        }
        return cachedReferenceVerifiedFallback;
    };
    let cachedEmptyReferenceRecovery: DiagnosisEvent[] | null = null;
    const emptyReferenceRecovery = (): DiagnosisEvent[] => {
        if (cachedEmptyReferenceRecovery === null) {
            cachedEmptyReferenceRecovery = refineEventsWithReferenceVoting(
                [],
                diagnosis,
                siteData,
                effectiveConfig.maxPartialGapYears,
            );
        }
        return cachedEmptyReferenceRecovery;
    };

    const pathMissing = typeEvents(pathEvents, "missingRing")
        .map((event) => withCandidateSupport(event, candidateEvents));
    const candidateMissing = typeEvents(candidateEvents, "missingRing")[0];
    let missingEvents = pathMissing.length > 0
        ? pathMissing
        : candidateMissing ? [candidateMissing] : [];

    const pathFalse = typeEvents(pathEvents, "falseRing");
    const candidateFalse = typeEvents(candidateEvents, "falseRing");
    const hasMultiplePathEvents = pathEvents.length >= 2;
    const verifiedFalseCandidates = options.enableTargetedPathVerification === true
        && pathFalse.length === 1
        && candidateFalse.length === 0
        && !hasMultiplePathEvents
        && !hasWholeCandidate
        && missingEvents.length === 0
        && pathFalse[0].confidenceLevel !== "low"
        ? verifyDiagnosisEvent(
            siteData,
            diagnosis,
            pathFalse[0],
            effectiveConfig,
        ).filter(coherentTargetedFalseVerification)
        : [];
    const targetedFalseCandidates = verifiedFalseCandidates.length > 0
        && emptyReferenceRecovery().length === 0
        && referenceVerifiedFallback().length === 0
        ? verifiedFalseCandidates
        : [];
    const targetedFalseEvents = makeDiagnosisEventsFromCandidates(
        [diagnosis],
        targetedFalseCandidates,
    ).filter((event) => event.eventType === "falseRing");
    // The path rejects short old-end runs, while candidate presence independently confirms that
    // a delete operation passed the existing before/after gate. A lone path-only false-ring event
    // stays suppressed because clean-series false positives concentrate in that ambiguity class.
    // Multiple independent path transitions are instead retained so one candidate cannot mask
    // additional false rings in a genuinely mixed series.
    let falseEvents = pathFalse.length > 0 && (
        candidateFalse.length > 0
        || hasMultiplePathEvents
        || targetedFalseEvents.length > 0
    )
        ? pathFalse.map((event) => (
            candidateFalse.length > 0
                ? withCandidateSupport(event, candidateFalse)
                : targetedFalseCandidates.length > 0
                    ? withTargetedCandidateVerification(event, targetedFalseCandidates)
                    : event
        ))
        : pathFalse.length === 0 && candidateFalse[0]
            && !(hasWholeCandidate && pathMissing.length > 0)
            ? [candidateFalse[0]]
            : [];
    falseEvents = pruneUnsupportedFalseRingPathSupplements(
        falseEvents,
        candidateFalse.length > 0,
    );

    const primaryPartialEvents = typeEvents(pathEvents, "partialMove")
        .map((event) => withCandidateSupport(event, candidateEvents));
    const partialEvents = locateMultiviewPartialEvents(
        diagnosis,
        cofechaDiagnosis,
        primaryPartialEvents,
        rawPathEvents,
    )
        .map((event) => withCandidateSupport(event, candidateEvents))
        .map((event) => refinePartialMoveWithRepeatedBlock(
            event,
            diagnosis,
            options.enableLearnedWindowRanking !== false,
        ));
    if (partialEvents.length > 0) {
        const conditionedUnitEvents = diagnoseLagPath(cofechaDiagnosis, siteData, {
            ...eventPathConfig,
            enablePulseScan: false,
            transitionPenaltyUnit: 5,
            minRunYears: 12,
            minTransitionGain: 1,
        }, pathCache).events
            .filter((event) => (
                event.eventType === "missingRing" || event.eventType === "falseRing"
            ))
            .map((event) => withCandidateSupport({
                ...event,
                evidence: {
                    ...event.evidence,
                    notes: [
                        ...event.evidence.notes,
                        "partial_conditioned_unit_transition",
                    ],
                },
            }, candidateEvents));
        const canAdd = (event: DiagnosisEvent): boolean => (
            !partialEvents.some((partial) => eventOverlap(event, partial))
            && ![...missingEvents, ...falseEvents].some((other) => eventOverlap(event, other))
        );
        conditionedUnitEvents.forEach((event) => {
            if (event.eventType === "missingRing" && canAdd(event)) {
                missingEvents = [...missingEvents, event];
            }
            if (event.eventType === "falseRing" && canAdd(event)) {
                falseEvents = [...falseEvents, event];
            }
        });
        const hasUnitTransition = (event: DiagnosisEvent): boolean => (
            event.evidence.lagBefore !== event.evidence.lagAfter
            && (event.evidence.algorithmSources.includes("piecewise_lag_path")
                || event.evidence.score > 0)
        );
        missingEvents = missingEvents.filter(hasUnitTransition);
        falseEvents = falseEvents.filter(hasUnitTransition);
    }
    const wholeEvents = keepWholeSeriesEvent(
        typeEvents(candidateEvents, "wholeSeriesMove")[0],
        partialEvents,
        pathDiagnosis,
    );
    const hasOnlyUnitEvents = partialEvents.length === 0 && wholeEvents.length === 0;
    const refinedUnitEvents = refineUnitEventWindows(
        [...missingEvents, ...falseEvents],
        diagnosis,
        rawPathEvents,
        ownCandidates,
        effectiveConfig,
        options.enableMissingWindowRefinement !== false
            && hasOnlyUnitEvents,
        false,
        options.unitWindowRefinementConfig,
    );

    const independentlyRefinedUnitEvents = hasOnlyUnitEvents
        && refinedUnitEvents.length === 1
        && options.enableIndependentBreakpointConsensus !== false
        ? (() => {
            const directEvents = locateReturnToZeroEvents(diagnosis, {
                minGain: Number.NEGATIVE_INFINITY,
            });
            return refinedUnitEvents.map((event) => refineUnitEventWithIndependentBreakpoints(
                event,
                diagnosis,
                siteData,
                directEvents.find((candidate) => candidate.eventType === event.eventType) ?? null,
            ));
        })()
        : refinedUnitEvents;

    const scoredUnitEvents = hasOnlyUnitEvents
        ? independentlyRefinedUnitEvents.map((event) => (
            refineUnitEventWithLocalEditScores(
                event,
                diagnosis,
                siteData,
            )
        ))
        : independentlyRefinedUnitEvents;
    const assembledEvents = [
        ...scoredUnitEvents,
        ...partialEvents,
        ...wholeEvents,
    ];
    const coherentAssembledEvents = options.enableIncoherentPartialPruning === true
        ? pruneIncoherentPartialSupplements(assembledEvents)
        : assembledEvents;
    const jointRefinedEvents = refineEventYearsJointly(
        coherentAssembledEvents,
        diagnosis,
        siteData,
        options.jointEventRefinementConfig,
    );
    const localEvents = jointRefinedEvents.filter((event) => event.eventType !== "wholeSeriesMove");
    const canAlignWholeOffset = options.enableReferenceVoting !== false
        && wholeEvents.length === 1
        && localEvents.length === 1
        && (localEvents[0].eventType === "missingRing" || localEvents[0].eventType === "falseRing")
        && pathDiagnosis.newestLag !== 0;
    const votedEvents = options.enableReferenceVoting === false
        ? jointRefinedEvents
        : canAlignWholeOffset
            ? (() => {
                const alignedDiagnosis = alignDiagnosisCalendar(
                    diagnosis,
                    pathDiagnosis.newestLag,
                );
                const alignedLocalEvents = localEvents.map((event) => (
                    shiftEventCalendar(event, pathDiagnosis.newestLag)
                ));
                const alignedRawEvents = rawPathEvents.map((event) => (
                    shiftEventCalendar(event, pathDiagnosis.newestLag)
                ));
                const alignedRefinedEvents = refineUnitEventWindows(
                    alignedLocalEvents,
                    alignedDiagnosis,
                    alignedRawEvents,
                    [],
                    effectiveConfig,
                    true,
                    true,
                    options.unitWindowRefinementConfig,
                );
                const votedAlignedEvents = refineEventsWithReferenceVoting(
                    alignedRefinedEvents,
                    alignedDiagnosis,
                    siteData,
                    effectiveConfig.maxPartialGapYears,
                );
                return [
                    ...votedAlignedEvents
                        .map((event) => {
                            const rankAdjustment = options.wholeOffsetUnitRankAdjustment
                                ?? inferWholeOffsetUnitRankAdjustment(
                                    event,
                                    alignedLocalEvents[0],
                                );
                            return adjustEventRankingCalendar(event, rankAdjustment);
                        })
                        .map((event) => shiftEventCalendar(event, -pathDiagnosis.newestLag)),
                    ...wholeEvents,
                ];
            })()
            : jointRefinedEvents.length === 0
                ? options.enableGainGatedOperationRecovery === true
                    ? []
                    : emptyReferenceRecovery()
                : refineEventsWithReferenceVoting(
                    jointRefinedEvents,
                    diagnosis,
                    siteData,
                    effectiveConfig.maxPartialGapYears,
                );
    let operationRecoveredBeforeFallback = false;
    const recoveredEvents = votedEvents.length > 0
        ? votedEvents
        : options.enableGainGatedOperationRecovery === true
            ? (() => {
                const singleEventRecovery = recoverSingleEventOperationSuggestions(
                    [],
                    diagnosis,
                    cofechaDiagnosis,
                    siteData,
                    operationRecoveryConfig,
                );
                if (singleEventRecovery.length > 0) {
                    operationRecoveredBeforeFallback = true;
                    return singleEventRecovery;
                }
                return referenceVerifiedFallback();
            })()
            : referenceVerifiedFallback();
    const edgeGuardedEvents = wholeEvents.length > 0
        ? recoveredEvents
        : recoveredEvents
            .map((event) => addUnitEventRankEdgeGuard(event, diagnosis))
            .map((event) => recoveredEvents.length > 1
                ? addUnitEventEvidenceEdgeGuard(event, diagnosis)
                : event);
    const finallyRankedEvents = hasOnlyUnitEvents
        ? edgeGuardedEvents.map((event) => restoreUnitEventLocalYearRanking(
            event.evidence.algorithmSources.includes("reference_core_pair_voting")
                ? event
                : addFalseRingUnscoredBoundaryGuard(event, diagnosis),
        ))
        : edgeGuardedEvents;
    const operationRecoveredEvents = options.enableGainGatedOperationRecovery === true
        && !operationRecoveredBeforeFallback
        ? recoverSingleEventOperationSuggestions(
            finallyRankedEvents,
            diagnosis,
            cofechaDiagnosis,
            siteData,
            operationRecoveryConfig,
        )
        : finallyRankedEvents;
    const consensusRankedEvents = operationRecoveredEvents.map(
        rerankEventYearsByAnchorConsensus,
    );
    const neighborRankedEvents = options.enableUnitNeighborRanking !== false
        ? consensusRankedEvents.map((event) => (
            rerankMissingRingWithNeighborAgreement(event, diagnosis, siteData)
        ))
        : consensusRankedEvents;
    const eventsWithLocationAlternatives = options.enableCumulativeLocationAlternatives === true
        && options.enableGainGatedOperationRecovery !== true
        ? addCumulativeLocationAlternatives(
            neighborRankedEvents,
            diagnosis,
            cofechaDiagnosis,
            siteData,
        )
        : neighborRankedEvents;
    return eventsWithLocationAlternatives.sort((a, b) => (
        b.endYear - a.endYear || b.evidence.score - a.evidence.score
    ));
};

const eventsForSeries = (
    siteData: RwlSiteData,
    diagnosis: SeriesCoreDiagnosis,
    candidates: DiagnosisCandidateOperation[],
    effectiveConfig: EffectiveDiagnosisConfig,
    options: DiagnosisEventEnsembleOptions,
): DiagnosisEvent[] => {
    const keepStrongestPartialMove = (
        events: DiagnosisEvent[],
    ): DiagnosisEvent[] => {
        const partialEvents = events.filter(
            (event) => event.eventType === "partialMove",
        );
        if (partialEvents.length <= 1) return events;
        const strongest = partialEvents.slice().sort((left, right) => (
            right.evidence.score - left.evidence.score
            || right.evidence.scoreMargin - left.evidence.scoreMargin
            || right.evidence.samplePairs - left.evidence.samplePairs
            || right.endYear - left.endYear
        ))[0];
        return events.filter((event) => event.eventType !== "partialMove")
            .concat(strongest);
    };
    const passOptions = {
        ...options,
        enableMixedReferenceSupplement: false,
    };
    const primary = eventsForSeriesPass(
        siteData,
        diagnosis,
        candidates,
        effectiveConfig,
        passOptions,
    );
    if (options.enableMixedReferenceSupplement !== true || primary.length === 0) {
        return keepStrongestPartialMove(primary);
    }
    if (!shouldRunMixedReferencePass(primary)) {
        return keepStrongestPartialMove(primary);
    }
    const alternate = eventsForSeriesPass(
        siteData,
        diagnosis,
        candidates,
        effectiveConfig,
        {
            ...passOptions,
            eventPathConfig: {
                ...options.eventPathConfig,
                transitionPenaltyUnit: 8,
                transitionPenaltyBig: 9,
                minRunYears: 16,
                individualMasterWeight: 0.1,
            },
        },
    );
    const [primaryScore, alternateScore] = scoreDiagnosisEventSets(
        [primary, alternate],
        diagnosis,
        siteData,
    );
    if (!shouldSelectMixedReferenceAlternative(
        primary,
        alternate,
        primaryScore,
        alternateScore,
    )) {
        return keepStrongestPartialMove(primary);
    }
    return keepStrongestPartialMove(alternate.map((event) => ({
        ...event,
        evidence: {
            ...event.evidence,
            notes: [
                ...event.evidence.notes,
                "mixed_reference_counterfactual_selected",
            ],
        },
    })));
};

const PARTIAL_GAP_YEAR_PREFIXES = [
    "partial_gap_raw31_year=",
    "partial_gap_difference31_year=",
    "partial_gap_whitened31_year=",
    "partial_gap_combo31_year=",
    "partial_gap_combo41_year=",
    "partial_gap_combo61_year=",
    "partial_gap_multiScale_year=",
] as const;
const FALSE_RING_SHIFT_YEAR_PREFIXES = [
    "scan_top_year=",
    "raw_path_top_year=",
    "candidate_top_year=",
    "direct_transition_year=",
    "paired_breakpoint_year=",
    "endpoint_residual_posterior_top_year=",
    "unit_local_raw31_year=",
    "unit_local_difference31_year=",
    "unit_local_whitened31_year=",
    "unit_local_combo31_year=",
    "unit_local_combo41_year=",
    "unit_local_combo61_year=",
    "unit_local_multiScale_year=",
    "unit_local_pairMean31_year=",
    "unit_local_pairMedian31_year=",
    "unit_local_pairTrimmed31_year=",
    "unit_local_pairWeighted31_year=",
    "unit_local_bestReference31_year=",
    "unit_local_pairedCore31_year=",
] as const;

const evidenceNoteYear = (
    event: DiagnosisEvent,
    prefix: string,
): number | null => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const year = Number(note?.slice(prefix.length));
    return Number.isInteger(year) ? year : null;
};

export const selectFalseRingConsensusWindowShift = (
    event: DiagnosisEvent,
): -1 | 0 | 1 => {
    if (event.eventType !== "falseRing") return 0;
    const candidateYear = evidenceNoteYear(event, "candidate_top_year=");
    const topYear = [...event.rankedYears]
        .sort((left, right) => left.rank - right.rank)[0]?.year;
    if (candidateYear === null || topYear === undefined) return 0;
    const center = (event.startYear + event.endYear) / 2;
    const delta = candidateYear - center;
    if (Math.abs(delta) < 3 || Math.abs(delta) > 9) return 0;
    const direction = Math.sign(delta) as -1 | 1;
    const shiftedStart = event.startYear + direction;
    const shiftedEnd = event.endYear + direction;
    if (topYear < shiftedStart || topYear > shiftedEnd) return 0;
    const votes = FALSE_RING_SHIFT_YEAR_PREFIXES
        .map((prefix) => evidenceNoteYear(event, prefix))
        .filter((year): year is number => year !== null);
    const directionalLead = direction > 0
        ? votes.filter((year) => year > center).length
            - votes.filter((year) => year < center).length
        : votes.filter((year) => year < center).length
            - votes.filter((year) => year > center).length;
    const enteringSupport = direction > 0
        ? votes.filter((year) => year > event.endYear).length
        : votes.filter((year) => year < event.startYear).length;
    const droppedSupport = direction > 0
        ? votes.filter((year) => year <= event.startYear).length
        : votes.filter((year) => year >= event.endYear).length;
    return directionalLead >= 6
        && enteringSupport >= 2
        && droppedSupport <= 2
        ? direction
        : 0;
};

const compactMainWindow = (
    event: DiagnosisEvent,
    centerYear: number,
    algorithmSource: string,
    notes: string[],
): DiagnosisEvent => {
    const width = 7;
    const startYear = Math.max(
        event.startYear,
        Math.min(centerYear - Math.floor(width / 2), event.endYear - width + 1),
    );
    const endYear = startYear + width - 1;
    return {
        ...event,
        startYear,
        endYear,
        rankedYears: event.rankedYears
            .filter((row) => row.year >= startYear && row.year <= endYear)
            .sort((a, b) => a.rank - b.rank || b.score - a.score || b.year - a.year)
            .map((row, index) => ({ ...row, rank: index + 1 })),
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                algorithmSource,
            ])).sort(),
            notes: [...event.evidence.notes, ...notes],
        },
    };
};

const trimMainWindowNewerEdge = (
    event: DiagnosisEvent,
    algorithmSource: string,
    notes: string[],
): DiagnosisEvent => {
    const endYear = event.endYear - 1;
    return {
        ...event,
        endYear,
        rankedYears: event.rankedYears
            .filter((row) => row.year <= endYear)
            .sort((left, right) => (
                left.rank - right.rank || right.score - left.score || right.year - left.year
            ))
            .map((row, index) => ({ ...row, rank: index + 1 })),
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                algorithmSource,
            ])).sort(),
            notes: [...event.evidence.notes, ...notes],
        },
    };
};

const shiftMainWindow = (
    event: DiagnosisEvent,
    direction: -1 | 1,
): DiagnosisEvent => {
    const startYear = event.startYear + direction;
    const endYear = event.endYear + direction;
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const minimumScore = event.rankedYears.length > 0
        ? Math.min(...event.rankedYears.map((row) => row.score))
        : 0;
    const rankedYears = Array.from(
        { length: endYear - startYear + 1 },
        (_, index) => {
            const year = startYear + index;
            return prior.get(year) ?? {
                year,
                rank: Number.MAX_SAFE_INTEGER,
                score: minimumScore - 1,
                evidenceTags: ["false_ring_directional_consensus_window_shift"],
            };
        },
    )
        .sort((left, right) => (
            left.rank - right.rank || right.score - left.score || right.year - left.year
        ))
        .map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...event,
        startYear,
        endYear,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "false_ring_directional_consensus_window_shift",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                "window_refinement=false_ring_directional_consensus_shift",
                `false_ring_window_shift=${direction}`,
            ],
        },
    };
};

export const keepSingleMainWindow = (event: DiagnosisEvent): DiagnosisEvent => {
    const repeatedBoundaryNote = event.evidence.notes.find((note) => (
        note.startsWith("repeated_block_boundary_year=")
    ));
    const repeatedBoundaryYear = repeatedBoundaryNote
        ? Number(repeatedBoundaryNote.slice(repeatedBoundaryNote.indexOf("=") + 1))
        : Number.NaN;
    const currentWidth = event.endYear - event.startYear + 1;
    const shouldNarrowRepeatedBoundary = event.eventType === "partialMove"
        && currentWidth > 7
        && event.evidence.algorithmSources.includes("unique_repeated_block_boundary")
        && Number.isInteger(repeatedBoundaryYear)
        && repeatedBoundaryYear >= event.startYear
        && repeatedBoundaryYear <= event.endYear;
    const primaryYear = [...event.rankedYears]
        .sort((left, right) => left.rank - right.rank)[0]?.year;
    const partialGapYears = PARTIAL_GAP_YEAR_PREFIXES
        .flatMap((prefix) => {
            const note = [...event.evidence.notes]
                .reverse()
                .find((value) => value.startsWith(prefix));
            const year = Number(note?.slice(prefix.length));
            return Number.isInteger(year) ? [year] : [];
        });
    const negativePartialCompactSupport = Number.isInteger(primaryYear)
        ? partialGapYears.filter((year) => (
            Math.abs(year - primaryYear) <= 2
        )).length
        : 0;
    const shouldNarrowNegativePartial = event.eventType === "partialMove"
        && (event.shiftYears ?? 0) < 0
        && currentWidth > 7
        && Number.isInteger(primaryYear)
        && negativePartialCompactSupport >= 6;
    let displayedEvent = event;
    if (shouldNarrowRepeatedBoundary) {
        displayedEvent = compactMainWindow(
            event,
            repeatedBoundaryYear,
            "unique_repeated_block_boundary",
            [],
        );
    } else if (shouldNarrowNegativePartial) {
        displayedEvent = compactMainWindow(
            event,
            primaryYear,
            "negative_partial_consensus_compact_window",
            [
                "window_refinement=negative_partial_consensus_compact",
                `negative_partial_compact_support=${negativePartialCompactSupport}`,
            ],
        );
    }
    const displayedPrimaryYear = [...displayedEvent.rankedYears]
        .sort((left, right) => left.rank - right.rank)[0]?.year;
    const partialNewerEdgeSupport = partialGapYears.filter((year) => (
        year >= displayedEvent.endYear
    )).length;
    const shouldTrimPartialNewerEdge = displayedEvent.eventType === "partialMove"
        && displayedEvent.endYear - displayedEvent.startYear + 1 > 7
        && Number.isInteger(displayedPrimaryYear)
        && displayedEvent.endYear - displayedPrimaryYear >= 3
        && partialNewerEdgeSupport <= 2;
    if (shouldTrimPartialNewerEdge) {
        displayedEvent = trimMainWindowNewerEdge(
            displayedEvent,
            "partial_move_unsupported_newer_edge_trim",
            [
                "window_refinement=partial_move_unsupported_newer_edge_trim",
                `partial_newer_edge_support=${partialNewerEdgeSupport}`,
            ],
        );
    }
    const falseRingWindowShift = selectFalseRingConsensusWindowShift(
        displayedEvent,
    );
    if (falseRingWindowShift !== 0) {
        displayedEvent = shiftMainWindow(
            displayedEvent,
            falseRingWindowShift,
        );
    }
    const primary = {
        ...displayedEvent,
        alternativeTypes: [],
    };
    delete primary.locationAlternatives;
    delete primary.operationAlternatives;
    delete primary.reviewCoreRange;
    return primary;
};

const stripDiagnosisEventAlternatives = (
    event: DiagnosisEvent,
): DiagnosisEvent => {
    const primary = {
        ...event,
        alternativeTypes: [],
    };
    delete primary.locationAlternatives;
    delete primary.operationAlternatives;
    delete primary.reviewCoreRange;
    return primary;
};

const preserveJointLagStateWindows = (
    events: DiagnosisEvent[],
): DiagnosisEvent[] | null => {
    const localEvents = events.filter((event) => (
        event.eventType !== "wholeSeriesMove"
    ));
    const stateTransitions = localEvents.filter((event) => (
        event.evidence.lagBefore !== null
        && event.evidence.lagAfter !== null
        && event.evidence.lagBefore !== event.evidence.lagAfter
    ));
    const wholeSeriesEvent = events.find((event) => (
        event.eventType === "wholeSeriesMove"
    ));
    const newestTransition = stateTransitions
        .slice()
        .sort((left, right) => right.endYear - left.endYear)[0];
    const hasWholeSeriesBaseline = wholeSeriesEvent !== undefined
        && newestTransition?.evidence.lagAfter !== null
        && newestTransition?.evidence.lagAfter
            === wholeSeriesEvent.evidence.lagBefore;
    const hasWholeUnitBoundary = wholeSeriesEvent !== undefined
        && stateTransitions.length === 1
        && (
            stateTransitions[0].eventType === "missingRing"
            || stateTransitions[0].eventType === "falseRing"
        )
        && Math.abs(
            (stateTransitions[0].evidence.lagAfter ?? 0)
            - (stateTransitions[0].evidence.lagBefore ?? 0),
        ) === 1;
    const hasStrongWholeLocalBoundary = wholeSeriesEvent !== undefined
        && stateTransitions.some((event) => (
            event.evidence.algorithmSources.includes("unique_repeated_block_boundary")
            || event.evidence.algorithmSources.includes("partial_neighbor_agreement_ranker")
        ));
    const representsSingleBoundaryAlternatives = stateTransitions.length >= 2
        && stateTransitions.every((event) => (
            event.evidence.lagBefore === stateTransitions[0].evidence.lagBefore
            && event.evidence.lagAfter === stateTransitions[0].evidence.lagAfter
            && event.startYear <= stateTransitions[0].endYear
            && event.endYear >= stateTransitions[0].startYear
        ));
    const hasJointLocalPath = stateTransitions.length >= 2
        && hasCoherentLagChain(stateTransitions);
    if (!hasWholeSeriesBaseline
        && !hasWholeUnitBoundary
        && !hasStrongWholeLocalBoundary
        && !representsSingleBoundaryAlternatives
        && !hasJointLocalPath) {
        return null;
    }
    if (stateTransitions.length !== localEvents.length) return null;
    return events.map((event) => {
        if (event.eventType === "wholeSeriesMove") return event;
        return {
            ...event,
            evidence: {
                ...event.evidence,
                algorithmSources: Array.from(new Set([
                    ...event.evidence.algorithmSources,
                    "joint_lag_state_location",
                ])).sort(),
                notes: [
                    ...event.evidence.notes,
                    "counterfactual_location=joint_lag_state_preserved",
                ],
            },
        };
    });
};

export const makeDiagnosisEvents = (
    siteData: RwlSiteData,
    diagnoses: SeriesCoreDiagnosis[],
    candidates: DiagnosisCandidateOperation[],
    effectiveConfig: EffectiveDiagnosisConfig,
    options: DiagnosisEventEnsembleOptions = {},
): DiagnosisEvent[] => {
    const endpointCache = createEndpointResidualWindowCache();
    const locatorPathCache = createLagPathCache();
    return diagnoses.flatMap((diagnosis) => {
        const detectedBeforeFusion = eventsForSeries(
            siteData,
            diagnosis,
            candidates,
            effectiveConfig,
            options,
        );
        const detected = options.enableDecisiveJointOperationFusion === true
            ? applyDecisiveJointOperationFusion(
                detectedBeforeFusion,
                diagnosis,
                {
                    maxPartialGapYears: effectiveConfig.maxPartialGapYears,
                    ...options.eventOperationRecoveryConfig,
                },
                siteData,
            )
            : detectedBeforeFusion;
        const endpointRefined = options.enableEndpointResidualWindow === true
            && detected.length === 1
            && (
                detected[0].eventType === "missingRing"
                || detected[0].eventType === "falseRing"
            )
            ? [
                refineUnitEventWithEndpointResidualWindow(
                    detected[0],
                    diagnosis,
                    siteData,
                    endpointCache,
                ),
            ]
            : detected;
        const displayed = rerankMissingEventsNearExplicitZeros(
            addDiagnosisReviewWindowPadding(
                endpointRefined,
                diagnosis.targetRange,
                options.reviewWindowPaddingYears ?? 0,
                options.reviewWindowDirectionalExtraYears,
            ),
            siteData.get(diagnosis.targetTree),
        ).map(
            options.enableCounterfactualEventLocator === true
                ? stripDiagnosisEventAlternatives
                : keepSingleMainWindow,
        );
        const validAutomaticEvents = (events: DiagnosisEvent[]): DiagnosisEvent[] => (
            events
                .filter((event) => (
                    event.eventType !== "partialMove"
                    || (
                        event.shiftSide === "older"
                        && isAutomaticPartialShift(event.shiftYears, {
                            maxPartialGapYears: effectiveConfig.maxPartialGapYears,
                            lagMin: effectiveConfig.lagMin,
                            seriesLength:
                                diagnosis.targetRange.endYear
                                - diagnosis.targetRange.startYear + 1,
                            minimumSideYears:
                                DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG.minimumSideYears,
                        })
                    )
                ))
                .map(stripDiagnosisEventAlternatives)
                .map((event) => (
                    event.evidence.algorithmSources.includes(
                        "full_interval_counterfactual_locator",
                    )
                        ? event
                        : restoreUnlocalizedFalseRingReviewWindow(
                                event,
                                diagnosis.targetRange,
                            )
                ))
                .map((event) => ({
                    ...event,
                    seriesRange: { ...diagnosis.targetRange },
                }))
        );
        if (options.enableCounterfactualEventLocator !== true
            || !displayed.some((event) => event.eventType !== "wholeSeriesMove")) {
            return validAutomaticEvents(displayed);
        }
        const jointStateEvents = preserveJointLagStateWindows(displayed);
        if (jointStateEvents) return validAutomaticEvents(jointStateEvents);
        const cofechaDiagnosis = diagnoseSeriesCore(
            siteData,
            diagnosis.targetTree,
            effectiveConfig,
            cofechaPreprocess,
        );
        if (!cofechaDiagnosis) return validAutomaticEvents(displayed);
        const hasWholeSeriesBaseline = displayed.some(
            (event) => event.eventType === "wholeSeriesMove",
        );
        return validAutomaticEvents(displayed.map((event) => {
            if (event.eventType === "wholeSeriesMove") return event;
            const fixedSideBaselineLag = hasWholeSeriesBaseline
                ? event.evidence.lagAfter ?? 0
                : 0;
            const located = refineEventWithCounterfactualLocator(
                event,
                diagnosis,
                cofechaDiagnosis,
                siteData,
                {
                    ...INTERNAL_EVENT_PATH_CONFIG,
                    maxPartialGapYears: effectiveConfig.maxPartialGapYears,
                    ...options.eventPathConfig,
                },
                locatorPathCache,
                fixedSideBaselineLag,
            );
            const firstLocated = located?.event ?? event;
            if (
                firstLocated.eventType !== "partialMove"
                || hasWholeSeriesBaseline
            ) {
                return firstLocated;
            }
            const operationRefined = applyDecisiveJointOperationFusion(
                [firstLocated],
                diagnosis,
                {
                    maxPartialGapYears: effectiveConfig.maxPartialGapYears,
                    ...options.eventOperationRecoveryConfig,
                },
                siteData,
            )[0] ?? firstLocated;
            if (
                operationRefined.eventType === firstLocated.eventType
                && operationRefined.shiftYears === firstLocated.shiftYears
            ) {
                return firstLocated;
            }
            return refineEventWithCounterfactualLocator(
                operationRefined,
                diagnosis,
                cofechaDiagnosis,
                siteData,
                {
                    ...INTERNAL_EVENT_PATH_CONFIG,
                    maxPartialGapYears: effectiveConfig.maxPartialGapYears,
                    ...options.eventPathConfig,
                },
                locatorPathCache,
                fixedSideBaselineLag,
            )?.event ?? operationRefined;
        }));
    });
};

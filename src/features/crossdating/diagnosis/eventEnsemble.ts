/**
 * Event-level ensemble for the internal diagnosis engine.
 *
 * The constrained lag path supplies narrow, potentially repeated changepoints. Existing
 * counterfactual candidates supply conservative operation/type support and remain the only
 * executable objects. The ensemble may run in-memory counterfactuals but never mutates caller
 * data or commits an edit.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import { cofechaStyleStandardize } from "../reference";
import {
    compareCompletedPartialWithSingleFalse,
    compareCompletedPartialWithSingleMissing,
    compareCompletedPartialWithMissingStaircase,
    comparePartialMoveWithMissingStaircase,
    comparePartialMoveWithRobustMissingStaircase,
    compareTwoStepUnitDirections,
    supportsDecisiveUnanchoredMissingStaircase,
    supportsCompletedPartialUnitCompositionEvidence,
    type CompletedPartialUnitSupportEvidence,
    supportsDiscreteMissingStaircase,
    supportsRobustMissingStaircaseCorrection,
    type CompletedPartialStaircaseCompetition,
    type CompletedPartialFalseComposition,
    type CompletedPartialMissingComposition,
    type MissingStaircaseCompetition,
} from "./discreteMissingStaircaseCompetition";
import {
    attachMissingPartialInterpretation,
    attachUniversalPartialMissingWorkflow,
    evaluateCompletedPartialMissingInterpretation,
    evaluateExactSequentialMissingInterpretation,
    evaluateLocalizedTwoStepMissingInterpretation,
    evaluateMissingPartialInterpretationTie,
    makeMissingRingInterpretation,
    makePartialMoveInterpretation,
} from "./missingPartialInterpretation";
import {
    boundedLagPathHasObservedFixedSide,
    createLagPathCache,
    diagnoseLagPath,
    locateBoundedLagStateEvents,
    locateSequentialFalseHead,
    locateSequentialMissingHead,
    locateTwoStepMissingStaircase,
    selectSharedExplicitZeroMarker,
    type EventPathConfig,
    type BoundedLagStateEventSet,
    type LagPathCache,
    type LagPathDiagnosis,
    type SequentialMissingHead,
    type SharedExplicitZeroMarker,
    type TwoStepMissingStaircase,
} from "./eventPath";
import {
    makeDiagnosisEventsFromCandidates,
    wholeEventFromCandidate,
} from "./events";
import {
    compareCompletedPartialPair,
    type CompletedPartialPairCompetition,
} from "./completedPartialPairCompetition";
import {
    evaluatePathFixedSideWholeCandidate,
    measureRecentTailLagConsensus,
    wholeBaselineCandidatePriority,
} from "./pathFixedSideWholeBaseline";
import {
    refineEventYearsJointly,
    scoreDiagnosisEventSets,
    type DiagnosisEventSetScore,
    type JointEventRefinementConfig,
} from "./jointEventRefinement";
import { locateDenseLagProfileEvents } from "./denseLagProfile";
import { locateSegmentedLagEvents } from "./segmentedEventPath";
import { refinePartialMoveWithRepeatedBlock } from "./partialBreakpointRefinement";
import {
    addStablePartialRankEdgeGuard,
    refineStablePartialMoveLocation,
} from "./stablePartialLocationConsensus";
import {
    projectUnitLocationFromIndependentConsensus,
    strongBoundedPathLocation,
} from "./locationAuthority";
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
    refineStableUnitEventWithLocalConsensus,
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
    isAllowedAutomaticDiagnosisEvent,
    wholeSeriesMoveShiftYears,
} from "./wholeSeriesMoveSemantics";
import {
    completeUnitTransitionChainExplainsWholeShift,
    measureWholeSeriesStateConsistency,
    supportsDominantWholeSeriesBaseline,
    supportsNonTerminalWholeSeriesCandidate,
    wholeSeriesStateConsistencyNotes,
} from "./wholeSeriesStateConsistency";
import {
    addDiagnosisReviewWindowPadding,
    restoreUnlocalizedFalseRingReviewWindow,
} from "./eventReviewWindow";
import { rerankMissingEventsNearExplicitZeros } from "./explicitZeroRanking";
import {
    createEndpointResidualWindowCache,
    isAutomaticOlderEndpointUnitEvent,
    refineUnitEventWithEndpointResidualWindow,
} from "./endpointResidualWindow";
import {
    hasDecisiveNewerSideFixedEvidence,
    scoreNewerSideEndpointOperationContrast,
} from "./endpointOperationContrast";
import { refineEventWithCounterfactualLocator } from "./counterfactualEventLocator";
import { adjudicateLocatorProposal } from "./eventAdjudicator";
import { evidenceClaimsFor, withEvidenceLedger } from "./evidenceLedger";
import {
    hasNearLagClusterCandidate,
    selectStableNearLagCluster,
    selectStableTerminalUnitStaircaseFrontier,
    type StableTerminalUnitStaircaseFrontier,
} from "./nearLagCluster";
import { refineEventWithBoundaryConsensus } from "./eventBoundaryConsensus";
import {
    getJointCounterfactualOperationScores,
    type JointCounterfactualOperationScore,
} from "./jointCounterfactualOperation";
import {
    scoreDynamicJointOperation,
    selectDynamicJointOperation,
    selectDynamicUnitOperation,
    summarizeJointOperationRegion,
    type DynamicJointOperationSelection,
    type JointOperationRegionalEvidence,
} from "./jointOperationSelector";
import {
    isExactPartialLagTransition,
    isAutomaticPartialShift,
} from "./partialMoveSemantics";
import type {
    DiagnosisCandidateAuditSnapshot,
    DiagnosisCandidateOperation,
    DiagnosisEventAuditSnapshot,
    DiagnosisEventDecisionAudit,
    DiagnosisEventDecisionReason,
    DiagnosisLocatorDecisionAudit,
    DiagnosisEventPassAudit,
    DiagnosisEvent,
    DiagnosisEventType,
    DiagnosisLocalLagTransitionEvidence,
    DiagnosisReviewEventCheckpoint,
    EffectiveDiagnosisConfig,
    NumericSeries,
    SeriesCoreDiagnosis,
    SharedZeroMarkerMode,
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
    /** Latest COFECHA PART 6 targets; used only to gate cumulative missing-ring recovery. */
    cofechaFlaggedSeriesIds?: readonly string[];
    /** Shared zeros may only rerank a lag-derived head in production local2 mode. */
    sharedZeroMarkerMode?: SharedZeroMarkerMode;
    /** All-flagged cold start may use a target-specific paired core as a relative frontier. */
    preferRemotePairedMissingFrontier?: boolean;
    /** Optional caller-owned sink. Recording must never affect event selection. */
    eventDecisionAudits?: DiagnosisEventDecisionAudit[];
    /** Full immutable hypotheses for review adjudication; never reconstructed from audit snapshots. */
    reviewEventCheckpoints?: DiagnosisReviewEventCheckpoint[];
    /** Validated candidates recovered during path assembly and required for UI event application. */
    supplementalCandidates?: DiagnosisCandidateOperation[];
};

const emptyEventPassAudit = (): DiagnosisEventPassAudit => ({
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
});

const copyEventPassAudit = (
    target: DiagnosisEventPassAudit,
    source: DiagnosisEventPassAudit,
    selectedReferencePass: DiagnosisEventPassAudit["selectedReferencePass"],
): void => {
    Object.assign(target, source, { selectedReferencePass });
};

const auditEvent = (event: DiagnosisEvent): DiagnosisEventAuditSnapshot => ({
    eventType: event.eventType,
    startYear: event.startYear,
    endYear: event.endYear,
    topYear: event.rankedYears.slice().sort((left, right) => (
        left.rank - right.rank || right.year - left.year
    ))[0]?.year ?? null,
    shiftYears: event.shiftYears ?? null,
    confidenceLevel: event.confidenceLevel,
    score: event.evidence.score,
    scoreMargin: event.evidence.scoreMargin,
    lagBefore: event.evidence.lagBefore,
    lagAfter: event.evidence.lagAfter,
    samplePairs: event.evidence.samplePairs,
    baselineCorrelation: event.evidence.baselineCorrelation,
    correctedCorrelation: event.evidence.correctedCorrelation,
    correlationGain: event.evidence.correlationGain,
    algorithmSources: [...event.evidence.algorithmSources],
    notes: [...event.evidence.notes],
});

const auditCandidate = (
    candidate: DiagnosisCandidateOperation,
): DiagnosisCandidateAuditSnapshot => ({
    operationType: candidate.operationType,
    targetYear: candidate.targetYear ?? null,
    anchorYear: candidate.anchorYear,
    shiftYears: candidate.deltaYears ?? candidate.shift ?? null,
    score: candidate.score,
    confidenceLevel: candidate.confidenceLevel,
    ambiguous: candidate.ambiguous,
    algorithmSources: [...candidate.algorithmSource],
});

export const INTERNAL_EVENT_ENSEMBLE_OPTIONS: DiagnosisEventEnsembleOptions = {
    enableGainGatedOperationRecovery: false,
    enableDecisiveJointOperationFusion: true,
    enableMixedReferenceSupplement: true,
    enableIncoherentPartialPruning: true,
    enableUnitNeighborRanking: true,
    enableEndpointResidualWindow: true,
    enableCounterfactualEventLocator: true,
    sharedZeroMarkerMode: "local2",
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

const candidateEventAnchorYear = (event: DiagnosisEvent): number | null => {
    const year = event.rankedYears
        .slice()
        .sort((left, right) => left.rank - right.rank)[0]?.year;
    return Number.isInteger(year) ? year : null;
};

/**
 * Recover a physical partial move when executable edit evidence is stronger than the regularized
 * lag path: either independent candidates agree, or a COFECHA-backed amplitude is the only one
 * coherent with the observed lag. Candidate before/after metrics are global, so the recovered
 * local state is normalized to the directly evaluated `shift -> 0` edit.
 */
export const recoverCandidateBackedPartialConsensus = (
    candidateEvents: DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    maxPartialGapYears: number,
): DiagnosisEvent | null => {
    if (candidateEvents.some((event) => event.eventType !== "partialMove")) return null;
    const eligible = candidateEvents.filter((event) => (
        event.eventType === "partialMove"
        && event.shiftSide === "older"
        // Unit-depth -2/-3 steps have a dedicated explicit missing-staircase competition. Let
        // that path run before using this large-gap candidate fallback.
        && (event.shiftYears ?? 0) <= -4
        && isAutomaticPartialShift(event.shiftYears, {
            maxPartialGapYears,
            seriesLength:
                diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
            minimumSideYears: DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG.minimumSideYears,
        })
        && event.evidence.notes.includes("candidate_hard_gate_passed")
        && (event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY) >= 0.04
        && candidateEventAnchorYear(event) !== null
    ));
    if (eligible.length === 0) return null;
    const shifts = new Set(eligible.map((event) => event.shiftYears));
    const hasCofechaSupport = eligible.some((event) => (
        event.evidence.algorithmSources.includes("cofecha_segment_lag")
    ));
    const hasIndependentSegmentedSupport = eligible.some((event) => (
        !event.evidence.algorithmSources.includes("cofecha_segment_lag")
        && event.evidence.algorithmSources.includes("segmented_diagnosis")
    ));
    let supporting: DiagnosisEvent[];
    let recoverySource: "candidate_backed_partial_consensus"
        | "cofecha_backed_partial_over_incoherent_alternatives";
    const allCandidateIds = new Set(
        eligible.flatMap((event) => event.evidence.candidateIds),
    );
    if (shifts.size === 1
        && allCandidateIds.size >= 2
        && hasCofechaSupport
        && hasIndependentSegmentedSupport) {
        supporting = eligible;
        recoverySource = "candidate_backed_partial_consensus";
    } else {
        const coherentCofecha = eligible.filter((event) => (
            event.evidence.algorithmSources.includes("cofecha_segment_lag")
            && event.shiftYears === event.evidence.lagBefore
            && (event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY) >= 0.1
        ));
        const alternatives = eligible.filter((event) => event !== coherentCofecha[0]);
        const alternativesAreIncoherent = alternatives.length > 0
            && alternatives.every((event) => (
                !event.evidence.algorithmSources.includes("cofecha_segment_lag")
                && event.shiftYears !== event.evidence.lagBefore
            ));
        if (coherentCofecha.length !== 1 || !alternativesAreIncoherent) return null;
        supporting = coherentCofecha;
        recoverySource = "cofecha_backed_partial_over_incoherent_alternatives";
    }

    const candidateIds = new Set(
        supporting.flatMap((event) => event.evidence.candidateIds),
    );

    const anchors = supporting
        .map(candidateEventAnchorYear)
        .filter((year): year is number => year !== null)
        .sort((left, right) => left - right);
    const cofechaAnchors = Array.from(new Set(
        supporting
            .filter((event) => event.evidence.algorithmSources.includes(
                "cofecha_segment_lag",
            ))
            .map(candidateEventAnchorYear)
            .filter((year): year is number => year !== null),
    )).sort((left, right) => left - right);
    const anchorSpan = anchors[anchors.length - 1] - anchors[0];
    if (anchorSpan > 24) return null;
    const centerYear = Math.round(
        anchors.reduce((sum, year) => sum + year, 0) / anchors.length,
    );
    const width = 13;
    const boundedWidth = Math.min(
        width,
        diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
    );
    const startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(
            centerYear - Math.floor(boundedWidth / 2),
            diagnosis.targetRange.endYear - boundedWidth + 1,
        ),
    );
    const endYear = startYear + boundedWidth - 1;
    const rankedYears = Array.from(
        { length: boundedWidth },
        (_, index) => {
            const year = startYear + index;
            const totalDistance = anchors.reduce(
                (sum, anchor) => sum + Math.abs(year - anchor),
                0,
            );
            return {
                year,
                score: -totalDistance,
                evidenceTags: ["candidate_backed_partial_consensus"],
            };
        },
    )
        .sort((left, right) => right.score - left.score || left.year - right.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
    const strongest = supporting.slice().sort((left, right) => (
        right.evidence.score - left.evidence.score
    ))[0];
    const shiftYears = supporting[0].shiftYears!;
    return {
        ...strongest,
        id: `${strongest.id}-candidate-backed-partial-consensus`,
        eventType: "partialMove",
        shiftYears,
        shiftSide: "older",
        startYear,
        endYear,
        rankedYears,
        confidenceLevel: "medium",
        evidence: {
            ...strongest.evidence,
            algorithmSources: Array.from(new Set([
                ...supporting.flatMap((event) => event.evidence.algorithmSources),
                "candidate_backed_partial_consensus",
                recoverySource,
            ])).sort(),
            lagBefore: shiftYears,
            lagAfter: 0,
            candidateIds: Array.from(candidateIds).sort(),
            samplePairs: Math.max(...supporting.map((event) => event.evidence.samplePairs)),
            notes: Array.from(new Set([
                ...strongest.evidence.notes,
                `partial_recovery=${recoverySource}`,
                `partial_candidate_consensus_shift=${shiftYears}`,
                `partial_candidate_consensus_count=${candidateIds.size}`,
                `partial_candidate_consensus_anchors=${anchors.join(",")}`,
                ...(cofechaAnchors.length > 0
                    ? [`partial_candidate_cofecha_anchors=${cofechaAnchors.join(",")}`]
                    : []),
                `partial_candidate_consensus_anchor_span=${anchorSpan}`,
                "partial_candidate_global_after_lag_not_used_as_local_state",
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

export const shouldSuppressSelfWorseningCandidateFalseRing = (
    event: DiagnosisEvent,
    hasFalseRingPathSupport: boolean,
): boolean => {
    if (hasFalseRingPathSupport || event.eventType !== "falseRing") return false;
    const gain = event.evidence.correlationGain;
    const before = event.evidence.lagBefore;
    const after = event.evidence.lagAfter;
    return gain !== null
        && Number.isFinite(gain)
        && gain <= 0
        && before !== null
        && after !== null
        && before < 0
        && after === before - 1;
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

export const unitEventExplainsWholeSeriesCandidate = (
    whole: DiagnosisEvent,
    event: DiagnosisEvent,
): boolean => {
    const wholeLag = wholeSeriesMoveShiftYears(whole);
    if (whole.eventType !== "wholeSeriesMove" || wholeLag === null || wholeLag === 0) {
        return false;
    }
    const isUnit = event.eventType === "missingRing" || event.eventType === "falseRing";
    const operationMatchesLag = event.eventType === "missingRing"
        ? wholeLag === -1
        : event.eventType === "falseRing" && wholeLag === 1;
    if (!isUnit || !operationMatchesLag || event.evidence.lagBefore !== wholeLag) {
        return false;
    }
    const returnsToZero = event.evidence.lagAfter === 0;
    const competitiveUnitCounterfactual = event.evidence.score
        >= whole.evidence.score - Math.max(
            1,
            Math.abs(whole.evidence.score) * 0.12,
        );
    return returnsToZero || competitiveUnitCounterfactual;
};

export const unitEventCompetesWithWholeAtNewerEndpoint = (
    whole: DiagnosisEvent,
    event: DiagnosisEvent,
): boolean => {
    const wholeLag = wholeSeriesMoveShiftYears(whole);
    if (
        whole.eventType !== "wholeSeriesMove"
        || (wholeLag !== -1 && wholeLag !== 1)
        || event.evidence.lagBefore !== wholeLag
    ) return false;
    const operationMatchesLag = event.eventType === "missingRing"
        ? wholeLag === -1
        : event.eventType === "falseRing" && wholeLag === 1;
    if (!operationMatchesLag) return false;
    return event.evidence.score >= whole.evidence.score - Math.max(
        2,
        Math.abs(whole.evidence.score) * 0.25,
    );
};

export const wholeSeriesEventIsLocalUnitAlias = (
    whole: DiagnosisEvent,
    unitEvents: DiagnosisEvent[],
): boolean => {
    return unitEvents.some((event) => (
        unitEventExplainsWholeSeriesCandidate(whole, event)
    ));
};

const terminalWholeNoteNumber = (
    event: DiagnosisEvent,
    prefix: string,
): number | null => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const value = Number(note?.slice(prefix.length));
    return Number.isFinite(value) ? value : null;
};

const hasCoherentNegativeCofechaWholeBaseline = (
    event: DiagnosisEvent,
): boolean => {
    const shiftYears = wholeSeriesMoveShiftYears(event);
    if (shiftYears === null
        || !event.evidence.notes.includes("candidate_hard_gate_passed")
        || !event.evidence.notes.includes(
            "whole_baseline_source=cofecha_terminal_lag",
        )) return false;
    const terminalSegments = terminalWholeNoteNumber(
        event,
        "cofecha_terminal_segments=",
    ) ?? 0;
    const terminalConsistency = terminalWholeNoteNumber(
        event,
        "cofecha_terminal_consistency=",
    ) ?? 0;
    const matchingSupport = terminalWholeNoteNumber(
        event,
        "cofecha_terminal_matching_pattern_support=",
    ) ?? 0;
    const opposingSupport = terminalWholeNoteNumber(
        event,
        "cofecha_terminal_opposing_pattern_support=",
    ) ?? 0;
    const stateSupport = terminalWholeNoteNumber(
        event,
        "whole_state_support_fraction=",
    ) ?? 0;
    const newestLag = terminalWholeNoteNumber(
        event,
        "whole_state_newest_lag=",
    );
    const newerEdgeSupport = terminalWholeNoteNumber(
        event,
        "whole_state_newer_edge_support_fraction=",
    ) ?? 0;
    return terminalSegments >= 2
        && terminalConsistency >= 0.9
        && matchingSupport >= 1
        && matchingSupport >= opposingSupport + 1
        && stateSupport >= 0.3
        && newestLag === shiftYears
        && newerEdgeSupport >= 0.9;
};

export const isTerminalWholeBaselineEvent = (
    event: DiagnosisEvent,
): boolean => event.eventType === "wholeSeriesMove"
    && event.evidence.notes.some((note) => [
        "whole_baseline_source=cofecha_terminal_lag",
        "whole_baseline_source=path_fixed_side_lag",
        "whole_baseline_source=recent_tail_lag",
    ].includes(note))
    && (
        event.evidence.score > 0
        || hasCoherentNegativeCofechaWholeBaseline(event)
    );

const PARTIAL_BOUNDARY_ANCHOR_SOURCES = new Set([
    "candidate_backed_partial_consensus",
    "cofecha_segment_lag",
    "counterfactual_operation_verification",
    "local_corrected_raw_breakpoint",
    "partial_neighbor_agreement_ranker",
    "piecewise_lag_path",
    "unique_repeated_block_boundary",
]);

export const hasIndependentPartialBoundaryAnchor = (
    event: DiagnosisEvent,
): boolean => event.eventType === "partialMove"
    && (
        event.evidence.candidateIds.length > 0
        || event.evidence.algorithmSources.some((source) => (
            PARTIAL_BOUNDARY_ANCHOR_SOURCES.has(source)
        ))
    );

export const partialMoveSharesWholeSeriesState = (
    whole: DiagnosisEvent,
    event: DiagnosisEvent,
): boolean => {
    const wholeLag = wholeSeriesMoveShiftYears(whole);
    return whole.eventType === "wholeSeriesMove"
        && wholeLag !== null
        && wholeLag !== 0
        && event.eventType === "partialMove"
        && event.shiftYears === wholeLag
        && event.evidence.lagBefore === wholeLag
        && event.evidence.lagAfter === 0;
};

const WHOLE_ALIAS_FIXED_SIDE_ADVANTAGE_MAXIMUM = -0.1;

export const shouldPreferWholeSeriesAlias = (
    whole: DiagnosisEvent,
    partial: DiagnosisEvent,
    fixedSideAdvantage: number | null,
): boolean => {
    if (!partialMoveSharesWholeSeriesState(whole, partial)) return false;
    if (isTerminalWholeBaselineEvent(whole)) return true;
    if (hasIndependentPartialBoundaryAnchor(partial)) return false;
    return fixedSideAdvantage !== null
        && fixedSideAdvantage <= WHOLE_ALIAS_FIXED_SIDE_ADVANTAGE_MAXIMUM;
};

export const partialMoveExplainsWholeSeriesCandidate = (
    whole: DiagnosisEvent,
    event: DiagnosisEvent,
    fixedSideAdvantage: number | null = null,
): boolean => partialMoveSharesWholeSeriesState(whole, event)
    && !shouldPreferWholeSeriesAlias(whole, event, fixedSideAdvantage);

const partialFixedSideAdvantage = (
    diagnosis: SeriesCoreDiagnosis | undefined,
    event: DiagnosisEvent,
    maxPartialGapYears: number,
): number | null => {
    if (!diagnosis || event.eventType !== "partialMove") return null;
    const operation = getJointCounterfactualOperationScores(
        diagnosis,
        15,
        maxPartialGapYears,
        0,
    ).find((candidate) => (
        candidate.eventType === "partialMove"
        && candidate.shiftYears === event.shiftYears
    ));
    const row = operation?.rows.find((candidate) => (
        candidate.year === operation.sideStepBestYear
    ));
    return row && Number.isFinite(row.sideNewerAdvantage)
        ? row.sideNewerAdvantage
        : null;
};

export const pruneWholeSeriesPartialAliases = (
    events: DiagnosisEvent[],
    diagnosis?: SeriesCoreDiagnosis,
    maxPartialGapYears = DEFAULT_EVENT_OPERATION_RECOVERY_CONFIG.maxPartialGapYears,
): DiagnosisEvent[] => {
    const wholeEvents = events.filter((event) => (
        event.eventType === "wholeSeriesMove"
    ));
    const partialEvents = events.filter((event) => event.eventType === "partialMove");
    const fixedSideAdvantageById = new Map(partialEvents
        .map((event) => [
            event.id,
            partialFixedSideAdvantage(diagnosis, event, maxPartialGapYears),
        ]));
    const relations = wholeEvents.flatMap((whole) => partialEvents
        .filter((partial) => partialMoveSharesWholeSeriesState(whole, partial))
        .map((partial) => ({
            whole,
            partial,
            fixedSideAdvantage: fixedSideAdvantageById.get(partial.id) ?? null,
            preferWhole: shouldPreferWholeSeriesAlias(
                whole,
                partial,
                fixedSideAdvantageById.get(partial.id) ?? null,
            ),
        })));
    if (relations.length === 0) return events;

    const rejectedPartialIds = new Set(relations
        .filter((relation) => relation.preferWhole)
        .map((relation) => relation.partial.id));
    const partialPreferredRelations = relations.filter((relation) => (
        !relation.preferWhole
        && !rejectedPartialIds.has(relation.partial.id)
    ));
    const rejectedWholeIds = new Set(partialPreferredRelations.map((relation) => (
        relation.whole.id
    )));
    const retainedPartialAliasIds = new Set(partialPreferredRelations.map((relation) => (
        relation.partial.id
    )));

    return events
        .filter((event) => (
            !rejectedPartialIds.has(event.id)
            && !rejectedWholeIds.has(event.id)
        ))
        .map((event) => {
            if (retainedPartialAliasIds.has(event.id)) return {
                ...event,
                evidence: {
                    ...event.evidence,
                    algorithmSources: Array.from(new Set([
                        ...event.evidence.algorithmSources,
                        "partial_move_preferred_over_global_lag",
                    ])).sort(),
                    notes: [
                        ...event.evidence.notes,
                        "whole_series_candidate=local_partial_alias",
                    ],
                },
            };
            if (event.eventType !== "wholeSeriesMove") return event;
            const rejectedRelations = relations.filter((relation) => (
                relation.whole.id === event.id
                && rejectedPartialIds.has(relation.partial.id)
            ));
            if (rejectedRelations.length === 0) return event;
            const advantages = rejectedRelations
                .map((relation) => relation.fixedSideAdvantage)
                .filter((value): value is number => value !== null);
            return {
                ...event,
                evidence: {
                    ...event.evidence,
                    algorithmSources: Array.from(new Set([
                        ...event.evidence.algorithmSources,
                        "whole_series_preferred_over_partial_alias",
                    ])).sort(),
                    notes: [
                        ...event.evidence.notes,
                        `partial_aliases_removed=${rejectedRelations.length}`,
                        ...(advantages.length === 0 ? [] : [
                            `partial_alias_best_fixed_side_advantage=${Math.max(
                                ...advantages,
                            ).toFixed(6)}`,
                        ]),
                    ],
                },
            };
        });
};

/**
 * A retained whole-series lag is the newer-side baseline for every local transition. Local
 * supplements with finite lag states must connect to that baseline, directly or through another
 * event. Disconnected path fragments are competing noise rather than an independent edit.
 */
export const pruneLocalEventsDisconnectedFromWholeBaseline = (
    events: DiagnosisEvent[],
): DiagnosisEvent[] => {
    const wholeEvents = events.filter((event) => event.eventType === "wholeSeriesMove");
    if (wholeEvents.length !== 1) return events;
    const wholeLag = wholeSeriesMoveShiftYears(wholeEvents[0]);
    if (wholeLag === null || wholeLag === 0) return events;

    const comparableLocalEvents = events.filter((event) => (
        event.eventType !== "wholeSeriesMove"
        && event.evidence.lagBefore !== null
        && event.evidence.lagAfter !== null
    ));
    if (comparableLocalEvents.length === 0) return events;

    const connectedIds = new Set<string>();
    const residualPathLagNote = wholeEvents[0].evidence.notes.find((note) => (
        note.startsWith("recent_tail_residual_path_lag=")
    ));
    const residualPathLag = Number(
        residualPathLagNote?.slice("recent_tail_residual_path_lag=".length),
    );
    const connectedStates = new Set([
        wholeLag,
        ...(Number.isInteger(residualPathLag) ? [residualPathLag] : []),
    ]);
    let added = true;
    while (added) {
        added = false;
        comparableLocalEvents.forEach((event) => {
            if (connectedIds.has(event.id)) return;
            const before = event.evidence.lagBefore!;
            const after = event.evidence.lagAfter!;
            if (!connectedStates.has(before) && !connectedStates.has(after)) return;
            connectedIds.add(event.id);
            connectedStates.add(before);
            connectedStates.add(after);
            added = true;
        });
    }

    const rejectedIds = new Set(comparableLocalEvents
        .filter((event) => !connectedIds.has(event.id))
        .map((event) => event.id));
    if (rejectedIds.size === 0) return events;
    return events
        .filter((event) => !rejectedIds.has(event.id))
        .map((event) => event.eventType !== "wholeSeriesMove"
            ? event
            : {
                ...event,
                evidence: {
                    ...event.evidence,
                    notes: [
                        ...event.evidence.notes,
                        `disconnected_local_supplements_removed=${rejectedIds.size}`,
                    ],
                },
            });
};

const keepWholeSeriesEvent = (
    whole: DiagnosisEvent | undefined,
    partialEvents: DiagnosisEvent[],
    unitEvents: DiagnosisEvent[],
    pathDiagnosis: LagPathDiagnosis,
): DiagnosisEvent[] => {
    if (!whole) return [];
    const terminalBaseline = isTerminalWholeBaselineEvent(whole);
    // A terminal COFECHA baseline has already passed either the ordinary whole hard gate or the
    // joint gate proving that its application leaves exactly one residual unit lag. It is an
    // independent baseline, so local unit hypotheses must be diagnosed after that baseline is
    // applied rather than deleting it as an endpoint alias.
    if (terminalBaseline) return [whole];
    // A local unit error can make its long older side dominate the global lag. A matching unit
    // correction that returns to zero or remains score-competitive is one boundary explanation,
    // not an independent whole-series move.
    if (wholeSeriesEventIsLocalUnitAlias(whole, unitEvents)) return [];
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
 * A whole-interval single-event posterior is misspecified once two independent local state
 * transitions already form one continuous lag path. Keep its boundary search local in that case;
 * otherwise the unresolved companion event can pull the posterior to a distant false mode.
 */
export const hasMultipleCoherentLocalTransitions = (
    events: readonly DiagnosisEvent[],
): boolean => {
    const localEvents = events.filter((event) => (
        event.eventType !== "wholeSeriesMove"
    ));
    return localEvents.length >= 2 && hasCoherentLagChain(localEvents);
};

/** The endpoint residual model assumes a zero global baseline and cannot relocate this boundary. */
export const unitEventUsesWholeSeriesBaseline = (
    whole: DiagnosisEvent | undefined,
    event: DiagnosisEvent,
): boolean => {
    const wholeShift = wholeSeriesMoveShiftYears(whole);
    if (wholeShift === null
        || (event.eventType !== "missingRing" && event.eventType !== "falseRing")
        || event.evidence.lagBefore === null
        || event.evidence.lagAfter === null
        || (event.evidence.lagBefore !== wholeShift
            && event.evidence.lagAfter !== wholeShift)) return false;
    const transition = event.evidence.lagAfter - event.evidence.lagBefore;
    return event.eventType === "missingRing" ? transition === 1 : transition === -1;
};

const isDirectedUnitTransition = (
    event: DiagnosisEvent,
    eventType: "missingRing" | "falseRing",
): boolean => {
    const before = event.evidence.lagBefore;
    const after = event.evidence.lagAfter;
    if (before === null || after === null) return false;
    if (event.eventType !== eventType) return false;
    return eventType === "missingRing"
        ? after - before === 1 && after <= 0
        : before - after === 1 && after >= 0;
};

const supportsCompressedMissingStaircase = (
    staircase: TwoStepMissingStaircase | null,
): staircase is TwoStepMissingStaircase => {
    if (!staircase) return false;
    const supportRatio = staircase.referenceCount > 0
        ? staircase.referenceSupport / staircase.referenceCount
        : 0;
    const aggregateGainSupport = staircase.staircaseGain > 0
        && staircase.referenceSupport >= 5
        && supportRatio >= 0.25;
    // A short real -1 run can lose slightly after averaging all references. Require a decisive
    // per-core majority before accepting that exception; genuine physical -2 gaps lack it.
    const perReferenceSupport = staircase.staircaseGain >= -0.5
        && staircase.middleMeanAdvantage > 0
        && staircase.referenceSupport >= 8
        && supportRatio >= 0.65
        && staircase.referenceMedianAdvantage >= 0.03;
    return staircase.newerBoundaryYear - staircase.olderBoundaryYear >= 4
        && (aggregateGainSupport || perReferenceSupport);
};

/**
 * An overwhelming same-year marker may recover an exact staircase even when one direct partial
 * fit wins the aggregate score. Every fitted unit boundary must remain in one local mode.
 */
export const supportsConsensusAnchoredSequentialMissingStaircase = (
    head: Pick<
        SequentialMissingHead,
        | "year"
        | "pathStartLag"
        | "transitionCount"
        | "unitEventYears"
        | "headMeanAdvantage"
        | "fixedTailMeanAdvantage"
    >,
    sharedZeroSupport: number,
): boolean => {
    const unitYears = [...head.unitEventYears].sort((left, right) => left - right);
    const oldestYear = unitYears[0];
    const newestYear = unitYears[unitYears.length - 1];
    return sharedZeroSupport >= 10
        && head.pathStartLag <= -3
        && Math.abs(head.pathStartLag) === head.transitionCount
        && unitYears.length === head.transitionCount
        && oldestYear !== undefined
        && newestYear === head.year
        && newestYear - oldestYear <= 12
        && head.headMeanAdvantage >= 0.04
        && head.fixedTailMeanAdvantage >= 0.28;
};

/**
 * After one missing ring is confirmed, a compact exact path may remain tied with one aggregate
 * partial fit. Advance only when the confirmed head is externally anchored and the fixed side is
 * stable; this keeps the rule unavailable on an untouched or weakly referenced series.
 */
export const supportsConfirmedSequentialMissingPathAdvance = (
    head: Pick<
        SequentialMissingHead,
        | "year"
        | "pathStartLag"
        | "transitionCount"
        | "unitEventYears"
        | "headRunYears"
        | "gainOverDirect"
        | "fixedTailMeanAdvantage"
    >,
    confirmedTargetZeroYears: readonly number[],
    sharedZeroSupport: number,
): boolean => {
    const confirmedYears = new Set(confirmedTargetZeroYears);
    const isConfirmedBoundary = (year: number): boolean => (
        confirmedYears.has(year) || confirmedYears.has(year + 1)
    );
    const unitYears = [...head.unitEventYears].sort((left, right) => left - right);
    const hasLocalOlderBoundary = unitYears.some((year) => (
        year < head.year
        && head.year - year <= MAX_LOCAL_CONFIRMED_PATH_ADVANCE_YEARS
    ));
    return sharedZeroSupport >= 10
        && head.pathStartLag <= -2
        && Math.abs(head.pathStartLag) === head.transitionCount
        && unitYears.length === head.transitionCount
        && unitYears[unitYears.length - 1] === head.year
        && head.headRunYears <= 2
        && head.gainOverDirect >= -0.5
        && head.fixedTailMeanAdvantage >= 0.28
        && isConfirmedBoundary(head.year)
        && hasLocalOlderBoundary;
};

const isCandidateBackedExactPartial = (event: DiagnosisEvent): boolean => (
    event.eventType === "partialMove"
    && event.evidence.candidateIds.length > 0
    && isExactPartialLagTransition(
        event.shiftYears,
        event.evidence.lagBefore,
        event.evidence.lagAfter,
    )
);

const MIN_CONFIRMED_NEWER_MISSING_MARKERS = 2;

const hasIndependentUnitSpecificAnchor = (event: DiagnosisEvent): boolean => (
    event.evidence.candidateIds.length > 0
    || event.evidence.algorithmSources.some((source) => (
        source === "shared_explicit_zero_marker"
        || source === "confirmed_target_zero_staircase"
        || source === "sequential_missing_candidate_consensus"
        || source === "compressed_missing_staircase_evidence"
    ))
    || event.evidence.notes.some((note) => (
        note.startsWith("shared_zero_marker_year=")
        || note.startsWith("confirmed_target_staircase_year=")
    ))
);

/** Remove a conditioned unit hypothesis that is an unanchored alternative to the same fixed side. */
export const pruneUnanchoredUnitAlternativesToCandidatePartial = (
    events: DiagnosisEvent[],
): DiagnosisEvent[] => {
    const exactPartials = events.filter(isCandidateBackedExactPartial);
    if (exactPartials.length === 0) return events;
    return events.filter((event) => {
        if (event.eventType !== "missingRing" && event.eventType !== "falseRing") {
            return true;
        }
        if (!event.evidence.notes.includes("partial_conditioned_unit_transition")) {
            return true;
        }
        if (hasIndependentUnitSpecificAnchor(event)) return true;
        return !exactPartials.some((partial) => (
            event.evidence.lagAfter === partial.evidence.lagAfter
            && event.evidence.lagBefore !== partial.evidence.lagAfter
            && event.evidence.lagAfter !== partial.evidence.lagBefore
        ));
    });
};

const addCompressedMissingStaircaseEvidence = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    eventPathConfig: Partial<EventPathConfig>,
    pathCache: LagPathCache,
    hasIndependentWholeSeriesBaseline = false,
): DiagnosisEvent => {
    const compressedShift = event.eventType === "partialMove"
        && event.shiftSide === "older"
        && event.shiftYears === -2
        ? -2
        : null;
    const staircaseConfig = compressedShift === null ? eventPathConfig : {
        ...eventPathConfig,
        minLag: compressedShift,
        maxPartialGapYears: 2,
    };
    const staircaseCache = compressedShift === null
        ? pathCache
        : createLagPathCache();
    const staircase = locateTwoStepMissingStaircase(
        diagnosis,
        siteData,
        event,
        staircaseConfig,
        staircaseCache,
    );
    if (!staircase) return event;
    const competition = comparePartialMoveWithMissingStaircase(
        diagnosis,
        siteData,
        event,
        true,
        staircase.newerBoundaryYear,
    );
    const exactHead = event.eventType === "partialMove"
        && event.shiftSide === "older"
        && (event.shiftYears ?? 0) < -1
        ? locateSequentialMissingHead(
            diagnosis,
            siteData,
            {
                minLag: event.shiftYears,
                maxPartialGapYears: Math.abs(event.shiftYears!),
            },
            createLagPathCache(),
            0,
        )
        : null;
    const exactCompetition = exactHead
        && exactHead.year !== staircase.newerBoundaryYear
        ? comparePartialMoveWithMissingStaircase(
            diagnosis,
            siteData,
            event,
            true,
            exactHead.year,
        )
        : competition;
    const exactEvidence = evaluateExactSequentialMissingInterpretation(
        event,
        exactCompetition,
        exactHead,
        {
            missingReviewPassed: true,
            partialReviewPassed: event.eventType === "partialMove"
                && event.shiftSide === "older",
            hasIndependentWholeSeriesBaseline,
        },
    );
    // A compact 1-3 year run is too ambiguous to replace the physical-gap primary operation,
    // but an independently verified exact unit path may remain available for sample inspection.
    if (!supportsCompressedMissingStaircase(staircase)) {
        return exactEvidence
            ? attachMissingPartialInterpretation(
                event,
                makeMissingRingInterpretation(
                    event,
                    exactEvidence,
                    diagnosis.targetRange,
                ),
                exactEvidence,
            )
            : event;
    }
    const confirmedNewerMissingCount = Array.from(
        siteData.get(event.seriesId) ?? [],
    ).filter(([year, value]) => (
        value === 0 && year > staircase.newerBoundaryYear
    )).length;
    // A two-boundary fit has more degrees of freedom than one physical -2 gap. Local lag shape
    // alone is therefore insufficient. Confirmed newer missing rings may relax only a borderline
    // unanimous vote; first-pass cases still need the stronger independent operation margin.
    const discreteMissingSupported = supportsDiscreteMissingStaircase(
        competition,
        staircase,
        {
            allowConfirmedHistoryRelaxation:
                confirmedNewerMissingCount >= MIN_CONFIRMED_NEWER_MISSING_MARKERS,
        },
    );
    if (!discreteMissingSupported) {
        const tieEvidence = evaluateMissingPartialInterpretationTie(competition, {
            missingReviewPassed: true,
            partialReviewPassed: event.eventType === "partialMove"
                && event.shiftSide === "older",
            hasIndependentWholeSeriesBaseline,
        });
        const localizedEvidence = evaluateLocalizedTwoStepMissingInterpretation(
            event,
            competition,
            exactHead,
            staircase,
            {
                missingReviewPassed: true,
                partialReviewPassed: event.eventType === "partialMove"
                    && event.shiftSide === "older",
                hasIndependentWholeSeriesBaseline,
            },
        );
        const interpretationEvidence = tieEvidence ?? exactEvidence ?? localizedEvidence;
        return interpretationEvidence
            ? attachMissingPartialInterpretation(
                event,
                makeMissingRingInterpretation(
                    event,
                    interpretationEvidence,
                    diagnosis.targetRange,
                ),
                interpretationEvidence,
            )
            : event;
    }
    const sharedUnitAnchor = selectSharedExplicitZeroMarker(
        siteData,
        event.seriesId,
        staircase.newerBoundaryYear,
        2,
    );
    if (isCandidateBackedExactPartial(event) && sharedUnitAnchor === null) return event;
    return addExplicitStaircaseCompetitionEvidence({
        ...event,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "compressed_missing_staircase_evidence",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                `compressed_staircase_older_boundary=${staircase.olderBoundaryYear}`,
                `compressed_staircase_newer_boundary=${staircase.newerBoundaryYear}`,
                `compressed_staircase_gain=${staircase.staircaseGain.toFixed(6)}`,
                `compressed_staircase_reference_support=${staircase.referenceSupport}/${staircase.referenceCount}`,
                `compressed_staircase_reference_median=${staircase.referenceMedianAdvantage.toFixed(6)}`,
                `compressed_staircase_confirmed_newer_missing_count=${confirmedNewerMissingCount}`,
            ],
        },
    }, competition!, staircase);
};

/**
 * Multiple absent rings form a monotone cumulative-lag staircase. The UI applies one edit and
 * re-diagnoses, so expose only the bark-side unit transition that returns to the fixed lag 0.
 * Deeper staircase states must not be presented as an independent whole/partial move.
 */
export const projectSequentialUnitChainHead = (
    events: DiagnosisEvent[],
): DiagnosisEvent[] => {
    // A terminal whole baseline is the operation that must be applied first. Projecting the
    // remaining states into one unit event here would erase that independently verified baseline.
    if (events.some(isTerminalWholeBaselineEvent)) return events;

    const compressedHeads = events.filter((event) => (
        event.eventType === "partialMove"
        && event.shiftYears === -2
        && event.evidence.algorithmSources.includes(
            "compressed_missing_staircase_evidence",
        )
    ));
    if (compressedHeads.length > 0) {
        const partial = compressedHeads.slice().sort((left, right) => (
            right.endYear - left.endYear || right.evidence.score - left.evidence.score
        ))[0];
        const partialTop = partial.rankedYears.slice().sort((left, right) => (
            left.rank - right.rank
        ))[0];
        const referenceVoteYear = evidenceNoteYear(
            partial,
            "partial_reference_vote_year=",
        );
        const explicitStaircaseYears = partial.evidence.algorithmSources.includes(
            "explicit_partial_vs_missing_staircase",
        )
            ? partial.evidence.notes
                .filter((note) => note.startsWith("explicit_staircase_missing_years="))
                .flatMap((note) => note
                    .slice("explicit_staircase_missing_years=".length)
                    .split(",")
                    .map(Number)
                    .filter(Number.isInteger))
            : [];
        const explicitStaircaseYear = explicitStaircaseYears.length > 0
            ? Math.max(...explicitStaircaseYears)
            : null;
        const missingYear = explicitStaircaseYear
            ?? referenceVoteYear
            ?? ((partialTop?.year
                ?? Math.round((partial.startYear + partial.endYear) / 2)) - 1);
        const width = partial.endYear - partial.startYear + 1;
        const seriesStart = partial.seriesRange?.startYear ?? partial.startYear - 1;
        const seriesEnd = partial.seriesRange?.endYear ?? partial.endYear;
        if (missingYear < seriesStart || missingYear > seriesEnd) return events;
        let startYear = explicitStaircaseYear === null
            ? partial.startYear
            : missingYear - Math.floor(width / 2);
        if (missingYear < startYear) startYear = missingYear;
        if (missingYear > startYear + width - 1) startYear = missingYear - width + 1;
        startYear = Math.max(
            seriesStart,
            Math.min(startYear, seriesEnd - width + 1),
        );
        const endYear = startYear + width - 1;
        const shiftedRankedYears = partial.rankedYears
            .map((row) => ({ ...row, year: row.year - 1 }))
            .filter((row) => row.year >= startYear && row.year <= endYear)
            .filter((row) => row.year !== missingYear)
            .sort((left, right) => left.rank - right.rank);
        const rankedYears = [{
                year: missingYear,
                rank: 1,
                score: partialTop?.score ?? partial.evidence.score,
                evidenceTags: Array.from(new Set([
                    ...(partialTop?.evidenceTags ?? []),
                    "compressed_missing_staircase_projection",
                ])),
            }, ...shiftedRankedYears]
            .map((row, index) => ({ ...row, rank: index + 1 }));
        const projected: DiagnosisEvent = {
            ...partial,
            id: `${partial.id}-compressed-missing-head`,
            eventType: "missingRing",
            startYear,
            endYear,
            rankedYears,
            evidence: {
                ...partial.evidence,
                algorithmSources: Array.from(new Set([
                    ...partial.evidence.algorithmSources,
                    "compressed_missing_staircase_projection",
                ])).sort(),
                lagBefore: -1,
                lagAfter: 0,
                notes: [
                    ...partial.evidence.notes,
                    "compressed_missing_staircase_projected_shift=-1",
                    `compressed_missing_staircase_selected_year=${missingYear}`,
                    `compressed_missing_staircase_selected_year_source=${
                        explicitStaircaseYear !== null
                            ? "explicit_staircase_newest_year"
                            : referenceVoteYear === null
                                ? "shifted_partial_top"
                                : "partial_reference_vote"
                    }`,
                    `compressed_missing_staircase_deferred_events=${events.length - 1}`,
                ],
            },
        };
        delete projected.shiftYears;
        delete projected.shiftSide;
        return [projected];
    }

    const units = events.filter((event): event is DiagnosisEvent & {
        eventType: "missingRing" | "falseRing";
    } => event.eventType === "missingRing" || event.eventType === "falseRing");
    if (units.length === 0) return events;
    const eventType = units[0].eventType;
    if (units.some((event) => event.eventType !== eventType)) return events;
    if (!units.every((event) => isDirectedUnitTransition(event, eventType))) return events;

    const partials = events.filter((event) => event.eventType === "partialMove");
    const hasCandidateBackedExactPartial = partials.some(
        isCandidateBackedExactPartial,
    );
    const hasIndependentUnitAnchor = units.some(hasIndependentUnitSpecificAnchor);
    // A conditioned unit path has more freedom than one directly evaluated partial edit. Do not
    // reinterpret an exact candidate-backed step unless a unit-specific candidate/zero anchor
    // independently supports the staircase explanation.
    if (hasCandidateBackedExactPartial && !hasIndependentUnitAnchor) return events;
    if (eventType === "missingRing") {
        const overlappingBoundaryUnits = partials.flatMap((partial) => {
            const partialBefore = partial.evidence.lagBefore;
            if (
                partial.evidence.lagAfter !== 0
                || partialBefore === null
                || partialBefore > -2
            ) return [];
            return units.filter((unit) => (
                unit.evidence.lagAfter === partialBefore
                && unit.startYear <= partial.endYear
                && partial.startYear <= unit.endYear
            ));
        });
        if (overlappingBoundaryUnits.length > 0) {
            const head = overlappingBoundaryUnits.slice().sort((left, right) => (
                right.evidence.score - left.evidence.score
                || right.endYear - left.endYear
            ))[0];
            return [{
                ...head,
                evidence: {
                    ...head.evidence,
                    algorithmSources: Array.from(new Set([
                        ...head.evidence.algorithmSources,
                        "overlapping_collapsed_boundary_projection",
                    ])).sort(),
                    notes: [
                        ...head.evidence.notes,
                        "overlapping_collapsed_boundary_type=missingRing",
                        `overlapping_collapsed_boundary_deferred_events=${events.length - 1}`,
                    ],
                },
            }];
        }
    }

    const expectedHeadLag = eventType === "missingRing" ? -1 : 1;
    const heads = units.filter((event) => (
        event.evidence.lagBefore === expectedHeadLag
        && event.evidence.lagAfter === 0
    ));
    if (heads.length !== 1) return events;
    const head = heads[0];
    const partialsFollowMissingDirection = partials.every((event) => {
        const before = event.evidence.lagBefore;
        const after = event.evidence.lagAfter;
        return eventType === "missingRing"
            && before !== null
            && after !== null
            && before < after
            && after <= 0;
    });
    if (!partialsFollowMissingDirection) return events;
    const wholeEvents = events.filter((event) => event.eventType === "wholeSeriesMove");
    const wholeEventsFollowDirection = wholeEvents.every((event) => {
        const lag = event.evidence.lagBefore;
        return lag !== null && (eventType === "missingRing" ? lag < 0 : lag > 0);
    });
    if (!wholeEventsFollowDirection) return events;

    const hasDeferredState = units.some((event) => (
        event.id !== head.id
        && Math.abs(event.evidence.lagBefore ?? 0) >= 2
    )) || partials.some((event) => (
        Math.abs(
            (event.evidence.lagAfter ?? 0)
            - (event.evidence.lagBefore ?? 0),
        ) >= 2
    )) || wholeEvents.some((event) => (
        Math.abs(event.evidence.lagBefore ?? 0) >= 2
    ));
    if (!hasDeferredState) return events;
    const otherUnitEnd = Math.max(
        ...units.filter((event) => event.id !== head.id).map((event) => event.endYear),
        Number.NEGATIVE_INFINITY,
    );
    if (head.endYear < otherUnitEnd) return events;

    return [{
        ...head,
        evidence: {
            ...head.evidence,
            algorithmSources: Array.from(new Set([
                ...head.evidence.algorithmSources,
                "sequential_unit_chain_projection",
            ])).sort(),
            notes: [
                ...head.evidence.notes,
                `sequential_unit_chain_type=${eventType}`,
                `sequential_unit_chain_deferred_events=${events.length - 1}`,
            ],
        },
    }];
};

export const prioritizeEndpointUnitAgainstWhole = (
    events: DiagnosisEvent[],
    diagnosis?: SeriesCoreDiagnosis,
    siteData?: RwlSiteData,
): DiagnosisEvent[] => {
    const whole = events.find((event) => event.eventType === "wholeSeriesMove");
    if (!whole) return events;
    const endpointUnit = events.find((event) => (
        (
            event.evidence.algorithmSources.includes(
                "series_endpoint_review_window",
            )
            || event.evidence.algorithmSources.includes(
                "newer_endpoint_unit_alias_of_global_lag",
            )
            || event.evidence.algorithmSources.includes(
                "newer_endpoint_unit_competitor_of_global_lag",
            )
        )
        && (
            event.eventType === "missingRing"
            || event.eventType === "falseRing"
        )
    ));
    const wholeLag = wholeSeriesMoveShiftYears(whole);
    const operationMatchesWholeLag = endpointUnit?.eventType === "missingRing"
        ? wholeLag === -1
        : endpointUnit?.eventType === "falseRing" && wholeLag === 1;
    if (!endpointUnit || !operationMatchesWholeLag) return events;
    const fixedSideContrast = diagnosis && siteData
        ? scoreNewerSideEndpointOperationContrast(
            diagnosis,
            siteData,
            whole,
            endpointUnit,
        )
        : null;
    const terminalWhole = isTerminalWholeBaselineEvent(whole);
    const decisiveFixedSide = Boolean(
        fixedSideContrast
        && hasDecisiveNewerSideFixedEvidence(fixedSideContrast),
    );
    if (terminalWhole && !decisiveFixedSide) {
        return events;
    }
    const removeTerminalWholeAlias = terminalWhole
        && decisiveFixedSide
        && endpointUnit.evidence.algorithmSources.some((source) => (
            source === "newer_endpoint_unit_alias_of_global_lag"
            || source === "newer_endpoint_unit_competitor_of_global_lag"
        ));
    const preferredUnit = {
        ...endpointUnit,
        evidence: {
            ...endpointUnit.evidence,
            algorithmSources: Array.from(new Set([
                ...endpointUnit.evidence.algorithmSources,
                "newer_endpoint_unit_preferred_over_global_lag",
                ...(terminalWhole
                    ? ["newer_fixed_side_lag_contrast"] as const
                    : []),
                ...(removeTerminalWholeAlias
                    ? ["terminal_whole_alias_removed"] as const
                    : []),
            ])).sort(),
            notes: [
                ...endpointUnit.evidence.notes,
                "event_order=newer_endpoint_unit_before_global_lag",
                ...(removeTerminalWholeAlias
                    ? ["whole_series_candidate=removed_terminal_unit_alias"]
                    : []),
                ...(fixedSideContrast ? [
                    `newer_fixed_side_boundary_year=${fixedSideContrast.boundaryYear}`,
                    `newer_fixed_side_range=${fixedSideContrast.startYear}-${fixedSideContrast.endYear}`,
                    `newer_fixed_side_master_advantage=${fixedSideContrast.masterAdvantage?.toFixed(6) ?? "none"}`,
                    `newer_fixed_side_reference_count=${fixedSideContrast.referenceCount}`,
                    `newer_fixed_side_positive_fraction=${fixedSideContrast.positiveReferenceFraction.toFixed(6)}`,
                    `newer_fixed_side_median_advantage=${fixedSideContrast.medianReferenceAdvantage?.toFixed(6) ?? "none"}`,
                    `newer_fixed_side_lower_quartile_advantage=${fixedSideContrast.lowerQuartileReferenceAdvantage?.toFixed(6) ?? "none"}`,
                    `newer_fixed_side_paired_advantage=${fixedSideContrast.pairedReferenceAdvantage?.toFixed(6) ?? "none"}`,
                ] : []),
            ],
        },
    };
    return [
        preferredUnit,
        ...events.filter((event) => (
            event.id !== endpointUnit.id
            && (!removeTerminalWholeAlias || event.id !== whole.id)
        )),
    ];
};

const isCofechaFlaggedSeries = (
    seriesId: string,
    flaggedSeriesIds: readonly string[] | undefined,
): boolean => flaggedSeriesIds?.some((candidate) => (
    candidate.toLowerCase() === seriesId.toLowerCase()
)) ?? false;

const boundedSequentialWindow = (
    centerYear: number,
    width: number,
    range: { startYear: number; endYear: number },
): { startYear: number; endYear: number } => {
    const actualWidth = Math.min(
        width,
        range.endYear - range.startYear + 1,
    );
    let startYear = centerYear - Math.floor((actualWidth - 1) / 2);
    startYear = Math.max(
        range.startYear,
        Math.min(startYear, range.endYear - actualWidth + 1),
    );
    return { startYear, endYear: startYear + actualWidth - 1 };
};

const legacySequentialWindowWidth = (
    head: SequentialMissingHead,
    marker: SharedExplicitZeroMarker | null,
): 5 | 7 | 13 => {
    if (!Number.isFinite(head.headMeanAdvantage)
        || head.headMeanAdvantage < 0.05) return 13;
    if (marker?.distanceFromHead === 0) return 5;
    if ((marker?.distanceFromHead ?? Infinity) <= 2) return 7;
    return 13;
};

/** Width calibration uses only lag-head concentration, never explicit-zero availability. */
const lagHeadSequentialWindowWidth = (
    head: SequentialMissingHead,
): 5 | 7 | 13 => {
    if (head.headRunYears <= 2) return 13;
    if (!Number.isFinite(head.headMeanAdvantage)
        || head.headMeanAdvantage < 0.08) return 13;
    if (head.headMeanAdvantage < 0.4) return 7;
    return 5;
};

const calibratedSequentialWindowWidth = (
    minimumWidth: number,
): 5 | 7 | 9 | 13 => (
    ([5, 7, 9, 13] as const).find((width) => width >= minimumWidth) ?? 13
);

// A local advance must leave one year of context on both sides inside the 13-year review window.
const MAX_LOCAL_CONFIRMED_PATH_ADVANCE_YEARS = 10;
const CONFIRMED_FRONTIER_FOOTPRINT_RADIUS_YEARS = 4;
const MIN_REMOTE_CONFIRMED_PATH_ADVANCE_YEARS = 14;
const MAX_RESIDUAL_PATH_MODE_WIDTH_YEARS = 5;

/**
 * A confirmed zero can leave a nearby smoothing/path footprint after the edit. Skip that already
 * explained frontier only when the remaining exact staircase contains a separate, internally
 * concentrated older mode. This exposes the next event without using its calendar truth.
 */
export const selectResidualSequentialMissingPathYear = (
    head: Pick<
        SequentialMissingHead,
        | "year"
        | "pathStartLag"
        | "transitionCount"
        | "unitEventYears"
        | "gainOverDirect"
        | "fixedTailMeanAdvantage"
    >,
    confirmedTargetZeroYears: readonly number[],
): number | null => {
    const matchesConfirmedFrontier = confirmedTargetZeroYears.some((year) => (
        Math.abs(year - head.year) <= CONFIRMED_FRONTIER_FOOTPRINT_RADIUS_YEARS
    ));
    if (!matchesConfirmedFrontier
        || head.pathStartLag > -3
        || Math.abs(head.pathStartLag) !== head.transitionCount
        || head.unitEventYears.length !== head.transitionCount
        || head.gainOverDirect < 8
        || head.fixedTailMeanAdvantage < 0.28) return null;

    const unconfirmedOlderYears = [...head.unitEventYears]
        .filter((year) => (
            year < head.year
            && confirmedTargetZeroYears.every((confirmedYear) => (
                Math.abs(confirmedYear - year)
                    > CONFIRMED_FRONTIER_FOOTPRINT_RADIUS_YEARS
            ))
        ))
        .sort((left, right) => right - left);
    const newestResidualYear = unconfirmedOlderYears[0];
    if (newestResidualYear === undefined
        || head.year - newestResidualYear < MIN_REMOTE_CONFIRMED_PATH_ADVANCE_YEARS) return null;

    const residualMode = unconfirmedOlderYears.filter((year) => (
        newestResidualYear - year <= MAX_RESIDUAL_PATH_MODE_WIDTH_YEARS
    )).sort((left, right) => left - right);
    if (residualMode.length < 2) return null;
    const middle = Math.floor(residualMode.length / 2);
    return residualMode.length % 2 === 1
        ? residualMode[middle]!
        : Math.round((residualMode[middle - 1]! + residualMode[middle]!) / 2);
};

export type SequentialMissingPresentation = {
    marker: SharedExplicitZeroMarker | null;
    selectedYear: number;
    windowCenterYear: number;
    width: 5 | 7 | 9 | 13;
    candidateConsensusYear: number | null;
    candidateWindowSupportYear: number | null;
    preferredLocationSupportYear: number | null;
    confirmedTargetStaircaseYear: number | null;
    advancedSequentialPathYear: number | null;
    rejectedRemoteSequentialPathYear: number | null;
};

/** Shared zeros can reorder only the local lag head; production windows stay lag-centered. */
export const resolveSequentialMissingPresentation = (
    head: SequentialMissingHead,
    candidateMarker: SharedExplicitZeroMarker | null,
    mode: SharedZeroMarkerMode,
    candidateCenters: readonly number[] = [],
    confirmedTargetZeroYears: readonly number[] = [],
    preferredLocationCenters: readonly number[] = [],
): SequentialMissingPresentation => {
    const confirmedTargetYears = new Set(confirmedTargetZeroYears);
    const isConfirmedPathBoundary = (year: number): boolean => (
        confirmedTargetYears.has(year)
        || confirmedTargetYears.has(year + 1)
    );
    const currentHeadAlreadyConfirmed = isConfirmedPathBoundary(head.year);
    const candidateAdvancedSequentialPathYear = currentHeadAlreadyConfirmed
        ? [...head.unitEventYears].reverse().find((year) => (
            year < head.year && !isConfirmedPathBoundary(year)
        )) ?? null
        : null;
    const localAdvancedSequentialPathYear = candidateAdvancedSequentialPathYear !== null
        && head.year - candidateAdvancedSequentialPathYear
            <= MAX_LOCAL_CONFIRMED_PATH_ADVANCE_YEARS
        ? candidateAdvancedSequentialPathYear
        : null;
    const residualSequentialPathYear = selectResidualSequentialMissingPathYear(
        head,
        confirmedTargetZeroYears,
    );
    const advancedSequentialPathYear = localAdvancedSequentialPathYear
        ?? residualSequentialPathYear;
    const rejectedRemoteSequentialPathYear = candidateAdvancedSequentialPathYear !== null
        && advancedSequentialPathYear === null
        ? candidateAdvancedSequentialPathYear
        : null;
    const marker = currentHeadAlreadyConfirmed
        || mode === "none"
        || (mode === "local2" && (candidateMarker?.distanceFromHead ?? 0) > 2)
        ? null
        : candidateMarker;
    const preferredLocationSupportYear = mode === "legacy6"
        || advancedSequentialPathYear !== null
        ? null
        : preferredLocationCenters.find((year) => (
            Math.abs(year - head.year) <= 13
        )) ?? null;
    const candidateWindowSupportYear = mode === "legacy6"
        || advancedSequentialPathYear !== null
        ? null
        : preferredLocationSupportYear ?? candidateCenters
            .filter((year) => Math.abs(year - head.year) <= 13)
            .sort((left, right) => (
                Math.abs(left - head.year) - Math.abs(right - head.year)
                || right - left
            ))[0] ?? null;
    const candidateConsensusYear = (marker?.support ?? 0) >= 10
        ? null
        : candidateWindowSupportYear === null
            ? null
            : Math.round((candidateWindowSupportYear + head.year) / 2);
    const candidateDistance = candidateWindowSupportYear === null
        ? null
        : Math.abs(candidateWindowSupportYear - head.year);
    const nearbyOlderConfirmedZeros = confirmedTargetZeroYears
        .filter((year) => year < head.year && head.year - year <= 13)
        .sort((left, right) => left - right);
    const confirmedTargetStaircaseYear = advancedSequentialPathYear === null
        && candidateWindowSupportYear === null
        && nearbyOlderConfirmedZeros.length >= 2
        ? (nearbyOlderConfirmedZeros[0] ?? head.year) - 1
        : null;
    const baseLagWidth = mode === "legacy6"
        ? legacySequentialWindowWidth(head, marker)
        : lagHeadSequentialWindowWidth(head);
    const boundedHeadRun = head.headRunYears >= 3 && head.headRunYears <= 13;
    const headRunStartYear = head.year - head.headRunYears + 1;
    const lagOnlyCenterYear = boundedHeadRun
        ? Math.round((headRunStartYear + head.year) / 2)
        : head.headRunYears <= 2 && candidateWindowSupportYear === null
            ? head.year - 2
            : head.year;
    const markerDistanceFromLagCenter = marker === null
        ? 0
        : Math.abs(marker.year - lagOnlyCenterYear);
    const deepStaircaseMarkerWidth = head.transitionCount >= 4
        && markerDistanceFromLagCenter >= 2
        ? 9
        : 0;
    const deepUnanchoredStaircaseWidth = head.transitionCount >= 4
        && marker === null
        && candidateWindowSupportYear === null
        && (!Number.isFinite(head.headMeanAdvantage) || head.headMeanAdvantage < 0.4)
        ? 13
        : 0;
    const lagWidth = calibratedSequentialWindowWidth(Math.max(
        baseLagWidth,
        boundedHeadRun ? head.headRunYears : 0,
        deepStaircaseMarkerWidth,
        deepUnanchoredStaircaseWidth,
    ));
    const width = candidateDistance === null
        ? lagWidth
        : candidateDistance <= 2
            ? Math.max(9, lagWidth) as 9 | 13
            : 13;
    const selectedYear = advancedSequentialPathYear
        ?? confirmedTargetStaircaseYear
        ?? marker?.year
        ?? candidateConsensusYear
        ?? head.year;
    return {
        marker,
        selectedYear,
        windowCenterYear: advancedSequentialPathYear
            ?? confirmedTargetStaircaseYear
            ?? candidateConsensusYear
            ?? (mode === "legacy6" && marker && marker.distanceFromHead > 2
                ? selectedYear
                : lagOnlyCenterYear),
        width: confirmedTargetStaircaseYear === null
            && advancedSequentialPathYear === null
            ? width
            : 13,
        candidateConsensusYear,
        candidateWindowSupportYear,
        preferredLocationSupportYear,
        confirmedTargetStaircaseYear,
        advancedSequentialPathYear,
        rejectedRemoteSequentialPathYear,
    };
};

export const partialMoveSupportsSequentialMissingDepth = (
    event: DiagnosisEvent,
    head: Pick<SequentialMissingHead, "transitionCount" | "headRunYears">,
): boolean => {
    if (event.eventType !== "partialMove"
        || event.shiftYears === undefined
        || event.shiftYears > -2
        || head.transitionCount <= 0) return false;
    const candidateDepth = Math.abs(event.shiftYears);
    const depthDifference = Math.abs(candidateDepth - head.transitionCount);
    return depthDifference <= 1
        || (
            candidateDepth < head.transitionCount
            && candidateDepth / head.transitionCount >= 0.4
            && head.headRunYears >= 3
        );
};

const sequentialMissingCandidateCenters = (
    candidateEvents: readonly DiagnosisEvent[],
): number[] => candidateEvents
    .filter((event) => event.eventType === "partialMove")
    .map((event) => event.rankedYears[0]?.year)
    .filter((year): year is number => year !== undefined);

/** A raw partial peak on the fixed/newer side cannot relocate a lag head without stage support. */
export const rawCandidateMayRecenterSequentialMissing = (
    headYear: number,
    candidateYear: number,
): boolean => candidateYear <= headYear + 2;

const sequentialMissingPreferredLocationCenters = (
    displayedEvents: readonly DiagnosisEvent[],
    earlierCheckpoints: readonly DiagnosisEvent[],
): number[] => Array.from(new Set([
    ...earlierCheckpoints
        .filter((event) => event.eventType === "missingRing")
        .map(rankedEventYear),
    ...displayedEvents
        .filter((event) => event.eventType === "missingRing")
        .map(rankedEventYear),
    ...displayedEvents
        .filter((event) => event.eventType === "partialMove")
        .map(rankedEventYear),
]));

const MAX_REMOTE_SEQUENTIAL_UNIT_REPLACEMENT_DISTANCE_YEARS = 13;

const rankedEventYear = (event: DiagnosisEvent): number => (
    event.rankedYears.slice().sort((left, right) => (
        left.rank - right.rank || right.score - left.score || right.year - left.year
    ))[0]?.year ?? Math.round((event.startYear + event.endYear) / 2)
);

/** A lag-path head cannot relocate an independently evaluated unit event to a remote mode. */
export const shouldPreserveCandidateBackedUnitFromRemoteSequentialHead = (
    detected: readonly DiagnosisEvent[],
    candidateEvents: readonly DiagnosisEvent[],
    headYear: number,
): boolean => {
    const candidateSupportsHead = candidateEvents.some((event) => (
        event.eventType === "missingRing"
        && Math.abs(rankedEventYear(event) - headYear)
            <= MAX_CONFIRMED_STAIRCASE_CANDIDATE_DISTANCE_YEARS
    ));
    if (candidateSupportsHead) return false;

    return detected.some((event) => {
        const hasIndependentLocation = event.evidence.algorithmSources.includes(
            "cofecha_segment_lag",
        ) || event.evidence.algorithmSources.includes(
            "paired_core_cold_start_frontier",
        );
        if (event.eventType !== "missingRing"
            || (event.confidenceLevel === "low" && !hasIndependentLocation)) {
            return false;
        }
        const candidateBacked = event.evidence.candidateIds.length > 0
            || candidateEvents.some((candidate) => (
                candidate.eventType === "missingRing"
                && Math.abs(
                    rankedEventYear(candidate) - rankedEventYear(event),
                ) <= 4
            ));
        return candidateBacked
            && Math.abs(rankedEventYear(event) - headYear)
                > MAX_REMOTE_SEQUENTIAL_UNIT_REPLACEMENT_DISTANCE_YEARS;
    });
};

const hasIndependentDisplayedMissingAnchor = (event: DiagnosisEvent): boolean => {
    if (event.eventType !== "missingRing") return false;
    const sources = new Set(event.evidence.algorithmSources);
    const hardGatedCandidate = event.evidence.notes.includes("candidate_hard_gate_passed")
        && (
            event.evidence.candidateIds.length > 0
            || sources.has("candidate_ranking")
            || sources.has("cofecha_boundary_checkpoint")
            || sources.has("candidate_frontier_checkpoint")
        );
    const jointUnitLocation = sources.has("decisive_joint_operation_fusion")
        && sources.has("joint_year_operation_evidence");
    return hardGatedCandidate
        || jointUnitLocation
        || sources.has("paired_core_cold_start_frontier")
        || sources.has("paired_direct_breakpoint_consensus");
};

const coherentPartialConditionedLagPathHead = (
    displayed: readonly DiagnosisEvent[],
): DiagnosisEvent | null => {
    const unitTransitions = displayed.filter((event) => (
        event.eventType === "missingRing"
        && event.evidence.algorithmSources.includes("piecewise_lag_path")
        && event.evidence.notes.includes("mixed_reference_counterfactual_selected")
        && event.evidence.lagBefore !== null
        && event.evidence.lagAfter !== null
        && event.evidence.lagAfter - event.evidence.lagBefore === 1
        && event.evidence.lagAfter <= 0
        && (event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY) >= 0.15
        && event.evidence.samplePairs >= 50
    ));
    const head = unitTransitions.find((event) => (
        event.evidence.lagBefore === -1
        && event.evidence.lagAfter === 0
        && event.evidence.notes.includes("partial_conditioned_unit_transition")
    ));
    if (!head) return null;
    const transitionLags = new Set(unitTransitions.map((event) => (
        event.evidence.lagBefore
    )));
    const sameCorrection = unitTransitions.every((event) => Math.abs(
        (event.evidence.correlationGain ?? 0)
        - (head.evidence.correlationGain ?? 0),
    ) <= 1e-9);
    return sameCorrection
        && [-1, -2, -3, -4].every((lag) => transitionLags.has(lag))
        ? head
        : null;
};

/**
 * Sequential recovery contributes another complete hypothesis. It must not erase a unit event
 * that already survived the candidate, operation and display gates with an independent anchor.
 */
export const retainDisplayedMissingHypothesesDuringSequentialRecovery = (
    displayed: readonly DiagnosisEvent[],
    recovered: DiagnosisEvent,
): DiagnosisEvent[] => {
    const recoveredYear = rankedEventYear(recovered);
    const coherentPathHead = coherentPartialConditionedLagPathHead(displayed);
    const retained = displayed.filter((event) => (
        (
            hasIndependentDisplayedMissingAnchor(event)
            || event.id === coherentPathHead?.id
        )
        && !(
            event.startYear === recovered.startYear
            && event.endYear === recovered.endYear
            && rankedEventYear(event) === recoveredYear
        )
    ));
    return retained;
};

/** Keeps the newest hard-gated unit frontier from being absorbed by an older lag plateau. */
export const preserveNewestCandidateUnitCheckpoint = (
    events: DiagnosisEvent[],
    candidateEvents: readonly DiagnosisEvent[],
    allowIndependentCandidates = false,
): DiagnosisEvent[] => {
    const checkpoints = candidateEvents.filter((event) => (
        event.eventType === "missingRing"
        && event.evidence.notes.includes("candidate_hard_gate_passed")
        && (
            event.evidence.algorithmSources.includes("cofecha_segment_lag")
            || (
                allowIndependentCandidates
                && event.evidence.candidateIds.length > 0
            )
        )
    )).sort((left, right) => allowIndependentCandidates
        ? rankedEventYear(right) - rankedEventYear(left)
            || right.evidence.score - left.evidence.score
        : right.evidence.score - left.evidence.score
            || rankedEventYear(right) - rankedEventYear(left));
    const checkpoint = checkpoints[0];
    if (!checkpoint) return events;
    const incumbent = events.find((event) => (
        event.eventType === checkpoint.eventType
        && rankedEventYear(checkpoint) - rankedEventYear(event)
            > MAX_REMOTE_SEQUENTIAL_UNIT_REPLACEMENT_DISTANCE_YEARS
    ));
    if (!incumbent) return events;

    const checkpointSource = allowIndependentCandidates
        ? "candidate_frontier_checkpoint"
        : "cofecha_boundary_checkpoint";
    const notePrefix = allowIndependentCandidates
        ? "candidate_frontier"
        : "cofecha_boundary";
    const retained: DiagnosisEvent = {
        ...checkpoint,
        evidence: {
            ...checkpoint.evidence,
            algorithmSources: Array.from(new Set([
                ...checkpoint.evidence.algorithmSources,
                checkpointSource,
            ])).sort(),
            notes: [
                ...checkpoint.evidence.notes,
                `${notePrefix}_replaced_remote_top=${rankedEventYear(incumbent)}`,
                `${notePrefix}_checkpoint_top=${rankedEventYear(checkpoint)}`,
            ],
        },
    };
    return events.map((event) => event.id === incumbent.id ? retained : event);
};

/**
 * A hard unit candidate can be the exposed frontier of a cumulative partial state. Require the
 * unit transition, cumulative amplitude and calendar ordering to agree across independent
 * candidate families before it is allowed to preempt a compressed partial path.
 */
export const selectCandidateBackedCumulativeUnitFrontier = (
    candidateEvents: readonly DiagnosisEvent[],
    completedLocation: DiagnosisEvent | null = null,
): DiagnosisEvent | null => {
    const sourceSegmentCenter = (event: DiagnosisEvent): number | null => {
        const startYear = noteYear(event, "candidate_source_segment_start=");
        const endYear = noteYear(event, "candidate_source_segment_end=");
        return startYear !== null && endYear !== null
            && startYear <= endYear && endYear - startYear <= 80
            ? (startYear + endYear) / 2
            : null;
    };
    const completedLocationYear = completedLocation?.eventType === "partialMove"
        && completedLocation.evidence.algorithmSources.includes("bounded_complete_lag_path")
        && completedLocation.evidence.algorithmSources.includes(
            "per_reference_completed_correction",
        )
        && completedLocation.evidence.notes.includes("completed_mixed_frontier_type=partialMove")
        && completedLocation.endYear - completedLocation.startYear + 1 <= 13
        ? rankedEventYear(completedLocation)
        : null;
    const partials = candidateEvents.filter((event) => (
        event.eventType === "partialMove"
        && event.shiftSide === "older"
        && (event.shiftYears ?? 0) <= -3
        && event.evidence.candidateIds.length > 0
        && event.evidence.notes.includes("candidate_hard_gate_passed")
        && event.evidence.algorithmSources.includes("global_sliding_match")
        && event.evidence.algorithmSources.includes("propagation_pattern")
        && event.evidence.algorithmSources.includes("segmented_diagnosis")
        && (event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY) >= 0.02
    ));
    const pairs = candidateEvents.flatMap((unit) => {
        const correlationGain = unit.evidence.correlationGain
            ?? Number.NEGATIVE_INFINITY;
        const hasCofechaUnitSupport = unit.evidence.algorithmSources.includes(
            "cofecha_segment_lag",
        );
        // Under a still-unfixed cumulative partial state, deleting the independently observed
        // false ring can slightly reduce the aggregate correlation. Four agreeing candidate
        // channels plus an exact lag step and ordered source segments are required instead.
        const hasIndependentFalseConsensus = unit.eventType === "falseRing"
            && unit.evidence.candidateIds.length >= 4
            && unit.evidence.scoreMargin >= 0.05
            && correlationGain >= -0.02;
        if ((unit.eventType !== "missingRing" && unit.eventType !== "falseRing")
            || unit.evidence.candidateIds.length < 2
            || !unit.evidence.notes.includes("candidate_hard_gate_passed")
            || (!hasCofechaUnitSupport && !hasIndependentFalseConsensus)
            || !unit.evidence.algorithmSources.includes("local_edit_alignment")
            || !unit.evidence.algorithmSources.includes("segmented_diagnosis")
            || (hasCofechaUnitSupport && correlationGain < 0.005)
            || unit.evidence.scoreMargin < 0.01
            || unit.evidence.lagBefore === null
            || unit.evidence.lagAfter === null) return [];
        const expectedStep = unit.eventType === "missingRing" ? 1 : -1;
        if (unit.evidence.lagAfter - unit.evidence.lagBefore !== expectedStep
            || unit.evidence.lagAfter > -2) return [];
        const unitYear = rankedEventYear(unit);
        return partials.flatMap((partial) => {
            if (partial.shiftYears !== unit.evidence.lagBefore) return [];
            const partialYear = rankedEventYear(partial);
            const separationYears = unitYear - partialYear;
            const completedSeparationYears = completedLocationYear === null
                ? null
                : unitYear - completedLocationYear;
            const unitSourceCenter = sourceSegmentCenter(unit);
            const partialSourceCenter = sourceSegmentCenter(partial);
            const sourceSegmentSeparationYears = unitSourceCenter === null
                || partialSourceCenter === null
                ? null
                : unitSourceCenter - partialSourceCenter;
            const candidateOrdered = separationYears >= 14 && separationYears <= 60;
            const completedOrdered = completedSeparationYears !== null
                && completedSeparationYears >= 14
                && completedSeparationYears <= 60;
            const sourceSegmentsOrdered = sourceSegmentSeparationYears !== null
                && sourceSegmentSeparationYears >= 14
                && sourceSegmentSeparationYears <= 60;
            return candidateOrdered || completedOrdered || sourceSegmentsOrdered
                ? [{
                    unit,
                    partial,
                    separationYears,
                    completedSeparationYears,
                    sourceSegmentSeparationYears,
                    independentFalseConsensus: hasIndependentFalseConsensus,
                }]
                : [];
        });
    }).sort((left, right) => (
        right.unit.evidence.scoreMargin - left.unit.evidence.scoreMargin
        || right.unit.evidence.candidateIds.length - left.unit.evidence.candidateIds.length
        || right.unit.evidence.score - left.unit.evidence.score
    ));
    const selected = pairs[0];
    if (!selected) return null;
    return {
        ...selected.unit,
        evidence: {
            ...selected.unit.evidence,
            algorithmSources: Array.from(new Set([
                ...selected.unit.evidence.algorithmSources,
                "cumulative_unit_candidate_pair",
            ])).sort(),
            notes: Array.from(new Set([
                ...selected.unit.evidence.notes,
                `cumulative_unit_pair_partial_year=${rankedEventYear(selected.partial)}`,
                `cumulative_unit_pair_unit_year=${rankedEventYear(selected.unit)}`,
                `cumulative_unit_pair_shift=${selected.partial.shiftYears}`,
                `cumulative_unit_pair_separation=${selected.separationYears}`,
                ...(selected.completedSeparationYears === null ? [] : [
                    `cumulative_unit_pair_completed_separation=${selected.completedSeparationYears}`,
                ]),
                ...(selected.sourceSegmentSeparationYears === null ? [] : [
                    `cumulative_unit_pair_source_segment_separation=${selected.sourceSegmentSeparationYears}`,
                ]),
                ...(selected.independentFalseConsensus
                    ? ["cumulative_unit_pair_independent_false_consensus=true"]
                    : []),
            ])),
        },
    };
};

/** Uses completed correction only as a locator; the independently backed unit keeps operation. */
export const reconcileCumulativeUnitOperationWithCompletedLocation = (
    unit: DiagnosisEvent | null,
    completed: DiagnosisEvent | null,
): DiagnosisEvent | null => {
    if (!unit || !completed
        || (unit.eventType !== "missingRing" && unit.eventType !== "falseRing")
        || !unit.evidence.algorithmSources.includes("cumulative_unit_candidate_pair")
        || completed.eventType !== "partialMove"
        || !completed.evidence.algorithmSources.includes("bounded_complete_lag_path")
        || !completed.evidence.algorithmSources.includes("per_reference_completed_correction")
        || !completed.evidence.notes.includes("completed_mixed_frontier_type=partialMove")
        || !completed.evidence.notes.includes("completed_mixed_frontier_is_newest_event")
        || completed.endYear - completed.startYear + 1 > 13) return null;
    const locationDistance = Math.abs(rankedEventYear(unit) - rankedEventYear(completed));
    if (locationDistance > 8) {
        return {
            ...unit,
            evidence: {
                ...unit.evidence,
                notes: Array.from(new Set([
                    ...unit.evidence.notes,
                    `completed_unit_remote_location_rejected=${rankedEventYear(completed)}`,
                    `completed_unit_location_distance=${locationDistance}`,
                ])),
            },
        };
    }
    return {
        ...unit,
        startYear: completed.startYear,
        endYear: completed.endYear,
        reviewCoreRange: completed.reviewCoreRange,
        rankedYears: completed.rankedYears,
        evidence: {
            ...unit.evidence,
            algorithmSources: Array.from(new Set([
                ...unit.evidence.algorithmSources,
                ...completed.evidence.algorithmSources,
                "completed_unit_location_reconciliation",
            ])).sort(),
            notes: Array.from(new Set([
                ...unit.evidence.notes,
                `completed_unit_candidate_year=${rankedEventYear(unit)}`,
                `completed_unit_location_year=${rankedEventYear(completed)}`,
                `completed_unit_location_window=${completed.startYear}-${completed.endYear}`,
            ])),
        },
    };
};

const hasDepthConsistentSequentialMissingCandidate = (
    candidateEvents: readonly DiagnosisEvent[],
    head: Pick<SequentialMissingHead, "transitionCount" | "headRunYears" | "year">,
): boolean => candidateEvents.some((event) => (
    partialMoveSupportsSequentialMissingDepth(event, head)
    && event.rankedYears[0]?.year !== undefined
    && Math.abs(event.rankedYears[0].year - head.year) <= 13
));

const selectSharedZeroMarkerForMode = (
    siteData: RwlSiteData,
    targetTree: string,
    headYear: number,
    mode: SharedZeroMarkerMode,
    legacyRadius = 6,
): SharedExplicitZeroMarker | null => {
    if (mode === "none") return null;
    return selectSharedExplicitZeroMarker(
        siteData,
        targetTree,
        headYear,
        mode === "legacy6" ? legacyRadius : 2,
    );
};

const finiteNote = (value: number): string => (
    Number.isFinite(value) ? value.toFixed(6) : "unavailable"
);

const makeSequentialMissingHeadEvent = (
    head: SequentialMissingHead,
    candidateMarker: SharedExplicitZeroMarker | null,
    detected: DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    candidates: DiagnosisCandidateOperation[],
    candidateEvents: DiagnosisEvent[],
    preferredLocationCenters: readonly number[],
    confirmedTargetZeroYears: readonly number[],
    markerMode: SharedZeroMarkerMode,
): DiagnosisEvent => {
    const candidateCenters = sequentialMissingCandidateCenters(candidateEvents).filter(
        (year) => rawCandidateMayRecenterSequentialMissing(head.year, year),
    );
    const {
        marker,
        selectedYear,
        windowCenterYear,
        width,
        candidateConsensusYear,
        candidateWindowSupportYear,
        preferredLocationSupportYear,
        confirmedTargetStaircaseYear,
        advancedSequentialPathYear,
        rejectedRemoteSequentialPathYear,
    } = resolveSequentialMissingPresentation(
        head,
        candidateMarker,
        markerMode,
        candidateCenters,
        confirmedTargetZeroYears,
        preferredLocationCenters,
    );
    const window = boundedSequentialWindow(
        windowCenterYear,
        width,
        diagnosis.targetRange,
    );
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            const selected = year === selectedYear;
            return {
                year,
                score: head.gainOverDirect
                    - Math.abs(year - selectedYear) * 0.01
                    - Math.abs(year - head.year) * 0.001,
                evidenceTags: [
                    "sequential_missing_staircase_head",
                    ...(selected && marker
                        ? ["shared_explicit_zero_marker"]
                        : []),
                ],
            };
        },
    ).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    const template = detected[0];
    const candidateIds = candidates.filter((candidate) => (
        candidate.targetTree === diagnosis.targetTree
        && candidate.operationType === "INSERT_MISSING_RING"
        && candidate.targetYear !== undefined
        && candidate.targetYear >= window.startYear
        && candidate.targetYear <= window.endYear
    )).map((candidate) => candidate.id);
    return {
        id: `diagnosis-event-${diagnosis.targetTree}-sequential-missing-${
            window.startYear
        }-${window.endYear}`,
        seriesId: diagnosis.targetTree,
        eventType: "missingRing",
        ...window,
        rankedYears,
        confidenceLevel: width === 5 ? "high" : width === 7 ? "medium" : "low",
        evidence: {
            algorithmSources: [
                "sequential_missing_staircase_head",
                ...(candidateConsensusYear !== null
                    ? ["sequential_missing_candidate_consensus"]
                    : []),
                ...(confirmedTargetStaircaseYear !== null
                    ? ["confirmed_target_zero_staircase"]
                    : []),
                ...(advancedSequentialPathYear !== null
                    ? ["confirmed_target_zero_path_advance"]
                    : []),
                ...(preferredLocationSupportYear !== null
                    ? ["sequential_missing_checkpoint_location"]
                    : []),
                ...(marker ? ["shared_explicit_zero_marker"] : []),
            ].sort(),
            score: head.gainOverDirect,
            scoreMargin: Math.max(0, head.gainOverDirect),
            baselineCorrelation:
                template?.evidence.baselineCorrelation
                ?? diagnosis.globalSlidingMatch.currentR,
            correctedCorrelation:
                template?.evidence.correctedCorrelation
                ?? diagnosis.globalSlidingMatch.bestGlobalR,
            correlationGain: template?.evidence.correlationGain ?? null,
            lagBefore: -1,
            lagAfter: 0,
            samplePairs: diagnosis.rawTarget.size,
            candidateIds,
            notes: [
                `sequential_missing_head_year=${head.year}`,
                `sequential_missing_path_start_lag=${head.pathStartLag}`,
                `sequential_missing_transition_count=${head.transitionCount}`,
                `sequential_missing_head_run_years=${head.headRunYears}`,
                `sequential_missing_gain_over_direct=${head.gainOverDirect.toFixed(6)}`,
                `sequential_missing_head_mean_advantage=${finiteNote(
                    head.headMeanAdvantage,
                )}`,
                `sequential_missing_fixed_tail_advantage=${finiteNote(
                    head.fixedTailMeanAdvantage,
                )}`,
                ...(marker ? [
                    `shared_zero_marker_year=${marker.year}`,
                    `shared_zero_marker_support=${marker.support}`,
                    `shared_zero_marker_distance=${marker.distanceFromHead}`,
                    `shared_zero_marker_weighted_support=${marker.weightedSupport.toFixed(6)}`,
                ] : [`shared_zero_marker=none_mode_${markerMode}`]),
                ...(candidateConsensusYear !== null ? [
                    `sequential_missing_candidate_consensus_year=${candidateConsensusYear}`,
                    `sequential_missing_candidate_head_distance=${Math.abs(
                        candidateConsensusYear - head.year,
                    )}`,
                ] : ["sequential_missing_candidate_consensus=none"]),
                ...(candidateWindowSupportYear !== null ? [
                    `sequential_missing_candidate_window_support_year=${candidateWindowSupportYear}`,
                ] : []),
                ...(preferredLocationSupportYear !== null ? [
                    `sequential_missing_preferred_location_support_year=${preferredLocationSupportYear}`,
                ] : []),
                ...(confirmedTargetStaircaseYear !== null ? [
                    `confirmed_target_staircase_year=${confirmedTargetStaircaseYear}`,
                ] : []),
                ...(advancedSequentialPathYear !== null ? [
                    `sequential_missing_confirmed_head_year=${head.year}`,
                    `sequential_missing_advanced_path_year=${advancedSequentialPathYear}`,
                ] : []),
                ...(rejectedRemoteSequentialPathYear !== null ? [
                    `sequential_missing_remote_path_advance_rejected=${rejectedRemoteSequentialPathYear}`,
                    `sequential_missing_remote_path_advance_distance=${
                        head.year - rejectedRemoteSequentialPathYear
                    }`,
                ] : []),
                `sequential_missing_unit_event_years=${head.unitEventYears.join(",")}`,
                `shared_zero_marker_mode=${markerMode}`,
                `sequential_missing_width_source=${
                    markerMode === "legacy6" ? "legacy_shared_zero" : "lag_head_advantage"
                }`,
                `sequential_missing_window_width=${width}`,
                `sequential_missing_window_center=${windowCenterYear}`,
                `sequential_missing_replaced_types=${detected.map(
                    (event) => event.eventType,
                ).join(",") || "none"}`,
                "sequential_missing_score_is_relative_not_probability",
            ],
        },
        alternativeTypes: [],
        seriesRange: { ...diagnosis.targetRange },
    };
};

const addExplicitStaircaseCompetitionEvidence = (
    event: DiagnosisEvent,
    competition: MissingStaircaseCompetition,
    staircase: TwoStepMissingStaircase,
): DiagnosisEvent => ({
    ...event,
    evidence: {
        ...event.evidence,
        algorithmSources: Array.from(new Set([
            ...event.evidence.algorithmSources,
            "explicit_partial_vs_missing_staircase",
            "per_reference_intermediate_lag_consensus",
        ])).sort(),
        notes: [
            ...event.evidence.notes,
            `explicit_staircase_missing_years=${competition.missingYears.join(",")}`,
            `explicit_staircase_span=${competition.missingSpanYears}`,
            `explicit_staircase_master_margin=${competition.masterMargin.toFixed(6)}`,
            `explicit_staircase_reference_support=${competition.referenceSupport}/${competition.referenceCount}`,
            `explicit_staircase_reference_median=${competition.referenceMedianMargin.toFixed(6)}`,
            `explicit_staircase_reference_q25=${competition.referenceLowerQuartileMargin.toFixed(6)}`,
            `local_staircase_boundaries=${staircase.olderBoundaryYear}-${staircase.newerBoundaryYear}`,
            `local_staircase_gain=${staircase.staircaseGain.toFixed(6)}`,
            `local_staircase_reference_support=${staircase.referenceSupport}/${staircase.referenceCount}`,
            `local_staircase_reference_median=${staircase.referenceMedianAdvantage.toFixed(6)}`,
        ],
    },
});

type SequentialMissingRecovery = {
    event: DiagnosisEvent;
    preserveWholeBaseline: boolean;
};

const recoverSequentialFalseHeadEvent = (
    detected: readonly DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    candidates: readonly DiagnosisCandidateOperation[],
    effectiveConfig: EffectiveDiagnosisConfig,
    options: DiagnosisEventEnsembleOptions,
    pathCache: LagPathCache,
): DiagnosisEvent | null => {
    if (
        detected.some((event) => event.eventType === "falseRing")
        || !isCofechaFlaggedSeries(
            diagnosis.targetTree,
            options.cofechaFlaggedSeriesIds,
        )
    ) return null;
    const cumulativePositiveCandidates = candidates.flatMap((candidate) => {
        const shift = candidate.deltaYears ?? candidate.suggestedLag;
        return candidate.targetTree === diagnosis.targetTree
            && candidate.operationType === "SHIFT_RANGE"
            && Number.isInteger(shift)
            && shift >= 2
            && shift <= effectiveConfig.lagMax
            ? [{ candidate, shift }]
            : [];
    });
    const cumulativePositiveCandidateDepths = Array.from(new Set(
        cumulativePositiveCandidates.map(({ shift }) => shift),
    )).sort((left, right) => left - right);
    if (cumulativePositiveCandidateDepths.length === 0) return null;
    const head = locateSequentialFalseHead(
        cofechaDiagnosis,
        siteData,
        {
            maxLag: cumulativePositiveCandidateDepths[
                cumulativePositiveCandidateDepths.length - 1
            ],
            maxPartialGapYears: effectiveConfig.maxPartialGapYears,
        },
        pathCache,
        0,
    );
    if (
        !head
        || head.pathStartLag < 2
        || head.transitionCount !== head.pathStartLag
        || !cumulativePositiveCandidateDepths.includes(head.pathStartLag)
        || head.gainOverDirect <= 0
        || head.headMeanAdvantage <= 0
        || head.fixedTailMeanAdvantage <= 0
    ) return null;
    const matchingCandidate = cumulativePositiveCandidates
        .filter(({ shift }) => shift === head.pathStartLag)
        .sort((left, right) => right.candidate.score - left.candidate.score)[0]?.candidate;
    const candidateFrontierYear = matchingCandidate
        ? matchingCandidate.anchorYear - 1
        : null;
    const presentationYear = candidateFrontierYear !== null
        && candidateFrontierYear >= diagnosis.targetRange.startYear
        && candidateFrontierYear <= diagnosis.targetRange.endYear
        && Math.abs(candidateFrontierYear - head.year) <= 8
        ? candidateFrontierYear
        : head.year;
    // Compare opposite edits at the same identified frontier. Requiring a separately fitted
    // negative path either rejects a valid positive staircase or compares two unrelated modes.
    const direction = compareTwoStepUnitDirections(
        cofechaDiagnosis,
        siteData,
        presentationYear,
        presentationYear,
        true,
    );
    if (
        !direction
        || direction.masterMargin <= 0
    ) return null;
    const window = boundedSequentialWindow(presentationYear, 7, diagnosis.targetRange);
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return {
                year,
                score: head.gainOverDirect - Math.abs(year - presentationYear) * 0.01,
                evidenceTags: [
                    "sequential_false_staircase_head",
                    "positive_unit_staircase_direction",
                ],
            };
        },
    ).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    const template = detected[0];
    return {
        id: `diagnosis-event-${diagnosis.targetTree}-sequential-false-${
            window.startYear
        }-${window.endYear}`,
        seriesId: diagnosis.targetTree,
        eventType: "falseRing",
        ...window,
        rankedYears,
        confidenceLevel: "medium",
        evidence: {
            algorithmSources: [
                "candidate_anchored_positive_staircase",
                "per_reference_two_step_direction_competition",
                "positive_unit_staircase_direction",
                "sequential_false_staircase_head",
            ],
            score: direction.masterMargin,
            scoreMargin: Math.max(0, direction.referenceMedianMargin),
            baselineCorrelation:
                template?.evidence.baselineCorrelation
                ?? diagnosis.globalSlidingMatch.currentR,
            correctedCorrelation:
                template?.evidence.correctedCorrelation
                ?? diagnosis.globalSlidingMatch.bestGlobalR,
            correlationGain: template?.evidence.correlationGain ?? null,
            lagBefore: 1,
            lagAfter: 0,
            samplePairs: diagnosis.rawTarget.size,
            candidateIds: candidates.filter((candidate) => (
                candidate.targetTree === diagnosis.targetTree
                && candidate.operationType === "DELETE_FALSE_RING"
                && candidate.targetYear !== undefined
                && candidate.targetYear >= window.startYear
                && candidate.targetYear <= window.endYear
            )).map((candidate) => candidate.id),
            notes: [
                `sequential_false_head_year=${head.year}`,
                `sequential_false_presented_year=${presentationYear}`,
                ...(candidateFrontierYear === null ? [] : [
                    `sequential_false_candidate_frontier_year=${candidateFrontierYear}`,
                ]),
                `sequential_false_path_start_lag=${head.pathStartLag}`,
                `sequential_false_transition_count=${head.transitionCount}`,
                `sequential_false_candidate_depth=${head.pathStartLag}`,
                `sequential_false_head_run_years=${head.headRunYears}`,
                `sequential_false_gain_over_direct=${head.gainOverDirect.toFixed(6)}`,
                `sequential_false_head_mean_advantage=${finiteNote(
                    head.headMeanAdvantage,
                )}`,
                `sequential_false_fixed_tail_advantage=${finiteNote(
                    head.fixedTailMeanAdvantage,
                )}`,
                `sequential_false_delete_years=${direction.falseYears.join(",")}`,
                `sequential_false_insert_alias_years=${direction.missingYears.join(",")}`,
                `sequential_false_direction_master_margin=${direction.masterMargin.toFixed(6)}`,
                `sequential_false_direction_reference_support=${
                    direction.referenceSupport
                }/${direction.referenceCount}`,
                `sequential_false_direction_reference_median=${
                    direction.referenceMedianMargin.toFixed(6)
                }`,
                `sequential_false_direction_reference_q25=${
                    direction.referenceLowerQuartileMargin.toFixed(6)
                }`,
                "sequential_false_score_is_relative_not_probability",
            ],
        },
        alternativeTypes: [],
        seriesRange: { ...diagnosis.targetRange },
    };
};

const MIN_SEQUENTIAL_GAIN_PER_EXTRA_TRANSITION = 0.8;
const MIN_STABLE_SEQUENTIAL_HEAD_RUN_YEARS = 30;
const MIN_DISTINCT_PARTIAL_MODE_SEPARATION_YEARS = 9;
const MAX_CONFIRMED_STAIRCASE_CANDIDATE_DISTANCE_YEARS = 2;

const completedPartialCompetitionNotes = (
    competition: CompletedPartialStaircaseCompetition,
): string[] => [
    `completed_family_partial_shift=${competition.partialShiftYears}`,
    `completed_family_best_fit_shift=${competition.familyShiftYears}`,
    `completed_family_shift_selection_source=${competition.shiftSelectionSource}`,
    `completed_family_partial_first_fixed_year=${competition.partialFirstFixedYear}`,
    `completed_family_boundary_prior_year=${competition.boundaryPriorYear}`,
    `completed_family_missing_years=${competition.missingYears.join(",")}`,
    `completed_family_master_margin=${competition.masterMargin.toFixed(6)}`,
    `completed_family_partial_reference_support=${
        competition.partialReferenceSupport
    }/${competition.referenceCount}`,
    `completed_family_reference_count=${competition.referenceCount}`,
    `completed_family_partial_reference_ratio=${
        competition.partialReferenceSupportRatio.toFixed(6)
    }`,
    `completed_family_reference_total=${competition.totalReferenceCount}`,
    `completed_family_reference_ambiguous=${competition.ambiguousReferenceCount}`,
    `completed_family_staircase_reference_support=${
        competition.staircaseReferenceSupport
    }/${competition.referenceCount}`,
    `completed_family_reference_median=${competition.referenceMedianMargin.toFixed(6)}`,
    `completed_family_reference_q25=${
        competition.referenceLowerQuartileMargin.toFixed(6)
    }`,
    `completed_family_reference_q75=${
        competition.referenceUpperQuartileMargin.toFixed(6)
    }`,
    ...competition.shiftProfiles.map((profile) => (
        `completed_family_shift_profile=${profile.shiftYears}:support=${
            profile.partialReferenceSupport
        }/${profile.referenceCount}:median=${
            profile.referenceMedianMargin.toFixed(6)
        }:q75=${profile.referenceUpperQuartileMargin.toFixed(6)}:master=${
            profile.masterScore.toFixed(6)
        }`
    )),
];

const supportsCompletedPartialOverMissingStaircase = (
    competition: CompletedPartialStaircaseCompetition | null,
): competition is CompletedPartialStaircaseCompetition => Boolean(
    competition
    && competition.referenceCount >= 8
    && competition.partialReferenceSupportRatio >= 0.8
    && competition.partialReferenceSupport
        >= competition.staircaseReferenceSupport + 5
    && competition.referenceMedianMargin < -1e-9
    && competition.referenceUpperQuartileMargin <= 0,
);

export type CompletedPartialUnitComposition = CompletedPartialMissingComposition
    | CompletedPartialFalseComposition;

const completedPartialUnitNotes = (
    competition: CompletedPartialUnitComposition,
): string[] => [
    `completed_mixed_unit_type=${competition.unitEventType}`,
    `completed_mixed_cumulative_shift=${competition.cumulativeShiftYears}`,
    `completed_mixed_partial_shift=${competition.partialShiftYears}`,
    `completed_mixed_orientation=${competition.orientation}`,
    `completed_mixed_older_boundary=${competition.olderBoundaryYear}`,
    `completed_mixed_newer_boundary=${competition.newerBoundaryYear}`,
    `completed_mixed_frontier_type=${competition.frontierEventType}`,
    `completed_mixed_frontier_year=${competition.frontierYear}`,
    `completed_mixed_separation=${competition.separationYears}`,
    `completed_mixed_master_margin=${competition.masterMargin.toFixed(6)}`,
    `completed_mixed_reference_support=${competition.mixedReferenceSupport}/${
        competition.referenceCount
    }`,
    `completed_mixed_reference_median=${competition.referenceMedianMargin.toFixed(6)}`,
    `completed_mixed_reference_q25=${
        competition.referenceLowerQuartileMargin.toFixed(6)
    }`,
    `completed_mixed_orientation_support=${competition.orientationReferenceSupport}/${
        competition.orientationReferenceCount
    }`,
    `completed_mixed_orientation_median=${
        competition.orientationMedianMargin.toFixed(6)
    }`,
    `completed_mixed_orientation_q25=${
        competition.orientationLowerQuartileMargin.toFixed(6)
    }`,
    `completed_mixed_master_orientation_margin=${
        competition.masterOrientationMargin.toFixed(6)
    }`,
    `completed_mixed_compared_with_missing_staircase=${
        competition.comparedWithMissingStaircase
    }`,
    `completed_mixed_source_segment_anchored=${competition.sourceSegmentAnchored}`,
];

export const supportsCompletedPartialUnitComposition = (
    competition: CompletedPartialUnitSupportEvidence | null,
): boolean => supportsCompletedPartialUnitCompositionEvidence(competition);

/**
 * A completed partial+unit hypothesis must add evidence, not merely split an already decisive
 * exact partial amplitude by one year. This protects the jointly selected operation while still
 * allowing a real mixed event when the per-reference correction has positive broad support.
 */
export const decisiveExactPartialRejectsWeakUnitComposition = (
    event: DiagnosisEvent,
    competition: CompletedPartialUnitComposition | null,
): boolean => {
    if (!competition || event.eventType !== "partialMove") return false;
    const shiftYears = event.shiftYears;
    const jointShift = latestCompletedMixedNoteNumber(event, "joint_operation_correction");
    const gridShift = latestCompletedMixedNoteNumber(event, "candidate_grid_partial_shift");
    const familyMargin = latestCompletedMixedNoteNumber(
        event,
        "candidate_grid_partial_family_margin",
    ) ?? Number.NEGATIVE_INFINITY;
    const shiftMargin = latestCompletedMixedNoteNumber(
        event,
        "candidate_grid_partial_shift_margin",
    ) ?? Number.NEGATIVE_INFINITY;
    const referenceCount = latestCompletedMixedNoteNumber(
        event,
        "candidate_grid_partial_reference_count",
    ) ?? 0;
    const peakKernel5 = latestCompletedMixedNoteNumber(
        event,
        "candidate_grid_partial_reference_peak_kernel5",
    ) ?? 0;
    const boundedPathGain = latestCompletedMixedNoteNumber(
        event,
        "bounded_path_transition_gain",
    ) ?? Number.NEGATIVE_INFINITY;
    const boundedRunnerMargin = latestCompletedMixedNoteNumber(
        event,
        "bounded_path_runner_up_margin",
    ) ?? Number.NEGATIVE_INFINITY;
    const decisiveCompletePath = event.evidence.algorithmSources.includes(
        "bounded_complete_lag_path",
    )
        && event.evidence.notes.includes("bounded_path_complete_hypothesis=true")
        && shiftYears !== undefined
        && event.evidence.lagBefore === shiftYears
        && event.evidence.lagAfter === 0
        && boundedPathGain >= 20
        && boundedRunnerMargin >= 1
        && competition.frontierEventType === "partialMove"
        && competition.separationYears <= 13
        && !competition.sourceSegmentAnchored;
    if (decisiveCompletePath) return true;

    const exactPartialIsDecisive = shiftYears !== undefined
        && shiftYears <= -2
        && jointShift === shiftYears
        && gridShift === shiftYears
        && event.evidence.algorithmSources.includes(
            "candidate_grid_reference_partial_consensus",
        )
        && event.evidence.algorithmSources.includes("per_reference_counterfactual_evidence")
        && familyMargin >= 0.1
        && shiftMargin >= 0.05
        && referenceCount >= 6
        && peakKernel5 >= 1 / 3;
    if (!exactPartialIsDecisive) return false;

    return competition.mixedReferenceSupportRatio < 0.5
        || competition.referenceMedianMargin <= 0
        || competition.referenceLowerQuartileMargin < -0.02;
};

const preservesDecisiveExactPartial = (event: DiagnosisEvent): boolean => {
    if (event.eventType !== "partialMove"
        || event.shiftYears === undefined
        || event.shiftYears > -2
        || event.evidence.lagBefore !== event.shiftYears
        || event.evidence.lagAfter !== 0) return false;
    const jointShift = latestCompletedMixedNoteNumber(event, "joint_operation_correction");
    const gridShift = latestCompletedMixedNoteNumber(event, "candidate_grid_partial_shift");
    const gridReferenceCount = latestCompletedMixedNoteNumber(
        event,
        "candidate_grid_partial_reference_count",
    ) ?? 0;
    const gridFamilyMargin = latestCompletedMixedNoteNumber(
        event,
        "candidate_grid_partial_family_margin",
    ) ?? Number.NEGATIVE_INFINITY;
    const gridShiftMargin = latestCompletedMixedNoteNumber(
        event,
        "candidate_grid_partial_shift_margin",
    ) ?? Number.NEGATIVE_INFINITY;
    const boundedPathGain = latestCompletedMixedNoteNumber(
        event,
        "bounded_path_transition_gain",
    ) ?? Number.NEGATIVE_INFINITY;
    const boundedRunnerMargin = latestCompletedMixedNoteNumber(
        event,
        "bounded_path_runner_up_margin",
    ) ?? Number.NEGATIVE_INFINITY;
    const boundedExact = event.evidence.algorithmSources.includes(
        "bounded_complete_lag_path",
    )
        && event.evidence.notes.includes("bounded_path_complete_hypothesis=true")
        && boundedPathGain >= 20
        && boundedRunnerMargin >= 1;
    const gridExact = jointShift === event.shiftYears
        && gridShift === event.shiftYears
        && gridReferenceCount >= 6
        && gridFamilyMargin >= 0.1
        && gridShiftMargin >= 0.05
        && event.evidence.algorithmSources.includes(
            "candidate_grid_reference_partial_consensus",
        )
        && event.evidence.algorithmSources.includes(
            "per_reference_counterfactual_evidence",
        );
    return boundedExact || gridExact;
};

const supportsCompletedPartialMissingComposition = (
    competition: CompletedPartialMissingComposition | null,
): competition is CompletedPartialMissingComposition => (
    supportsCompletedPartialUnitComposition(competition)
);

const supportsCompletedPartialFalseComposition = (
    competition: CompletedPartialFalseComposition | null,
): competition is CompletedPartialFalseComposition => (
    supportsCompletedPartialUnitComposition(competition)
);

const latestCompletedMixedNoteNumber = (
    event: DiagnosisEvent,
    key: string,
): number | null => {
    const prefix = `${key}=`;
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const value = Number(note?.slice(prefix.length));
    return Number.isFinite(value) ? value : null;
};

type CompletedPartialUnitSeed = {
    event: DiagnosisEvent;
    anchorYears: number[];
};

type BoundedCompletedPartialUnitSeed = CompletedPartialUnitSeed & {
    unitEventType: "missingRing" | "falseRing";
};

export type ExhaustiveCompletedPartialUnitCandidate = {
    unitEventType: "missingRing" | "falseRing";
    rawCompetition: CompletedPartialUnitComposition;
    cofechaCompetition: CompletedPartialUnitComposition;
    regionalEvidence: JointOperationRegionalEvidence;
};

export type ExhaustiveCompletedPartialUnitSelection = {
    unitEventType: "missingRing" | "falseRing";
    competition: CompletedPartialUnitComposition;
    reason: "regional_unit_direction"
        | "cross_view_boundary_consensus"
        | "cofecha_completed_family"
        | "raw_completed_family";
};

const exhaustiveCompositionIsLocalized = (
    competition: CompletedPartialUnitComposition,
    startYear: number,
    endYear: number,
): boolean => {
    const otherBoundaryYear = competition.frontierYear
        === competition.olderBoundaryYear
        ? competition.newerBoundaryYear
        : competition.olderBoundaryYear;
    return competition.separationYears >= 2
        && competition.separationYears <= 40
        && [competition.frontierYear, otherBoundaryYear].some((year) => (
            year >= startYear - 2 && year <= endYear + 2
        ));
};

const completedCompositionUnitBoundaryYear = (
    competition: CompletedPartialUnitComposition,
): number => competition.frontierEventType === competition.unitEventType
    ? competition.frontierYear
    : competition.frontierYear === competition.olderBoundaryYear
        ? competition.newerBoundaryYear
        : competition.olderBoundaryYear;

/**
 * Chooses between the two net-lag decompositions only after complete corrections have been
 * scored. A net -N state merely defines the two hypotheses; it never decides whether the unit
 * component is a missing or false ring, nor where either component occurred.
 */
export const selectExhaustiveCompletedPartialUnitComposition = (
    candidates: readonly ExhaustiveCompletedPartialUnitCandidate[],
    startYear: number,
    endYear: number,
): ExhaustiveCompletedPartialUnitSelection | null => {
    if (candidates.length !== 2
        || new Set(candidates.map((candidate) => candidate.unitEventType)).size !== 2) {
        return null;
    }
    const boundaryDistanceToRange = (year: number): number => (
        year < startYear ? startYear - year : year > endYear ? year - endYear : 0
    );
    const crossViewBoundaryConsensus = candidates.filter((candidate) => {
        const raw = candidate.rawCompetition;
        const cofecha = candidate.cofechaCompetition;
        return raw.orientation === cofecha.orientation
            && raw.frontierEventType === cofecha.frontierEventType
            && raw.separationYears >= 14 && raw.separationYears <= 40
            && cofecha.separationYears >= 14 && cofecha.separationYears <= 40
            && Math.abs(raw.olderBoundaryYear - cofecha.olderBoundaryYear) <= 7
            && Math.abs(raw.newerBoundaryYear - cofecha.newerBoundaryYear) <= 7
            && boundaryDistanceToRange(raw.olderBoundaryYear) <= 8
            && boundaryDistanceToRange(cofecha.olderBoundaryYear) <= 8
            && raw.referenceCount >= 8
            && raw.mixedReferenceSupportRatio >= 0.5
            && raw.referenceMedianMargin >= 0.005
            && raw.referenceLowerQuartileMargin >= -0.005
            && raw.orientationReferenceCount >= 8
            && raw.orientationReferenceSupportRatio >= 0.6
            && raw.orientationMedianMargin >= 0.04
            && cofecha.referenceCount >= 8
            && cofecha.mixedReferenceSupportRatio >= 0.8
            && cofecha.referenceMedianMargin >= 0.06
            && cofecha.referenceLowerQuartileMargin >= 0
            && cofecha.orientationReferenceCount >= 8
            && cofecha.orientationReferenceSupportRatio >= 0.8
            && cofecha.orientationMedianMargin >= 0.08;
    });
    if (crossViewBoundaryConsensus.length === 1) {
        const winner = crossViewBoundaryConsensus[0]!;
        return {
            unitEventType: winner.unitEventType,
            competition: winner.cofechaCompetition,
            reason: "cross_view_boundary_consensus",
        };
    }

    const localized = candidates.filter((candidate) => (
        exhaustiveCompositionIsLocalized(
            candidate.cofechaCompetition,
            startYear,
            endYear,
        )
    ));
    if (localized.length !== 2) return null;

    const regionalWinner = localized.find((candidate) => {
        const other = localized.find((row) => row !== candidate)!;
        const evidence = candidate.regionalEvidence;
        const competing = other.regionalEvidence;
        return exhaustiveCompositionIsLocalized(
            candidate.rawCompetition,
            startYear,
            endYear,
        )
            && evidence.bestDifferenceGain >= 0.02
            && evidence.bestSideStepScore >= 0.05
            && evidence.bestSideMinimumAdvantage >= 0.02
            && evidence.bestDifferenceGain - competing.bestDifferenceGain >= 0.015
            && evidence.bestSideStepScore - competing.bestSideStepScore >= 0.025
            && candidate.rawCompetition.referenceCount >= 8
            && candidate.rawCompetition.mixedReferenceSupportRatio >= 0.65
            && candidate.rawCompetition.referenceMedianMargin >= 0.01
            && candidate.rawCompetition.orientationReferenceSupportRatio >= 0.7
            && candidate.rawCompetition.orientationMedianMargin >= 0.02;
    });
    if (regionalWinner) {
        const evidence = regionalWinner.regionalEvidence;
        const regionalYears = [
            evidence.bestYear,
            evidence.bestSideStepYear,
        ].filter((year): year is number => year !== null);
        const cofechaCompetition = regionalWinner.cofechaCompetition;
        const unitBoundaryYear = completedCompositionUnitBoundaryYear(
            cofechaCompetition,
        );
        const partialFrontierHasSeparatedUnitBoundary = cofechaCompetition
            .frontierEventType === "partialMove"
            && cofechaCompetition.separationYears >= 4
            && cofechaCompetition.separationYears <= 13;
        const cofechaAlignsWithUnit = (
            cofechaCompetition.frontierEventType === regionalWinner.unitEventType
            || partialFrontierHasSeparatedUnitBoundary
        ) && regionalYears.some((year) => Math.abs(year - unitBoundaryYear) <= 4);
        if (cofechaAlignsWithUnit) {
            return {
                unitEventType: regionalWinner.unitEventType,
                competition: cofechaCompetition,
                reason: "regional_unit_direction",
            };
        }
    }

    const cofechaRanked = localized.slice().sort((left, right) => (
        right.cofechaCompetition.referenceMedianMargin
            - left.cofechaCompetition.referenceMedianMargin
        || right.cofechaCompetition.referenceLowerQuartileMargin
            - left.cofechaCompetition.referenceLowerQuartileMargin
    ));
    const cofechaWinner = cofechaRanked[0]!;
    const cofechaRunnerUp = cofechaRanked[1]!;
    const cofecha = cofechaWinner.cofechaCompetition;
    const unitFrontierFamily = cofecha.frontierEventType
        === cofechaWinner.unitEventType
        && cofecha.separationYears >= 4;
    const longSeparatedPartialConsensus = cofecha.frontierEventType === "partialMove"
        && cofecha.separationYears >= 14
        && cofecha.separationYears <= 40
        && cofecha.referenceMedianMargin >= 0.12
        && cofecha.referenceMedianMargin
            - cofechaRunnerUp.cofechaCompetition.referenceMedianMargin >= 0.08
        && cofecha.referenceLowerQuartileMargin >= 0.03
        && cofecha.mixedReferenceSupportRatio >= 0.85
        && cofecha.orientationReferenceSupportRatio >= 0.85
        && cofecha.orientationMedianMargin >= 0.08
        && cofecha.orientationLowerQuartileMargin >= 0.02;
    const longSeparatedPartialHighGain = cofecha.frontierEventType === "partialMove"
        && cofecha.separationYears >= 14
        && cofecha.separationYears <= 40
        && cofecha.referenceMedianMargin >= 0.25
        && cofecha.referenceMedianMargin
            - cofechaRunnerUp.cofechaCompetition.referenceMedianMargin >= 0.15
        && cofecha.referenceLowerQuartileMargin >= -0.001
        && cofecha.mixedReferenceSupportRatio >= 0.6
        && cofecha.orientationReferenceSupportRatio >= 0.7
        && cofecha.orientationMedianMargin >= 0.1
        && cofecha.orientationMedianMargin
            - cofechaRunnerUp.cofechaCompetition.orientationMedianMargin >= 0.05
        && cofecha.orientationLowerQuartileMargin >= 0;
    const longSeparatedPartialFamily = longSeparatedPartialConsensus
        || longSeparatedPartialHighGain;
    const familySpecificSupport = unitFrontierFamily
        ? cofecha.referenceLowerQuartileMargin >= 0
            && cofecha.mixedReferenceSupportRatio >= 0.75
            && cofecha.orientationReferenceSupportRatio >= 0.75
            && cofecha.orientationMedianMargin >= 0.03
            && cofecha.orientationLowerQuartileMargin >= 0.003
        : longSeparatedPartialFamily;
    if ((unitFrontierFamily || longSeparatedPartialFamily)
        && familySpecificSupport
        && cofecha.referenceCount >= 8
        && cofecha.referenceMedianMargin >= 0.025
        && cofecha.referenceMedianMargin
            - cofechaRunnerUp.cofechaCompetition.referenceMedianMargin >= 0.015
        && cofecha.orientationReferenceCount >= 8
    ) {
        return {
            unitEventType: cofechaWinner.unitEventType,
            competition: cofecha,
            reason: "cofecha_completed_family",
        };
    }

    const rawRanked = localized.slice().sort((left, right) => (
        right.rawCompetition.masterMargin - left.rawCompetition.masterMargin
        || right.rawCompetition.referenceMedianMargin
            - left.rawCompetition.referenceMedianMargin
    ));
    const rawWinner = rawRanked[0]!;
    const rawRunnerUp = rawRanked[1]!;
    const raw = rawWinner.rawCompetition;
    const corroboratingCofecha = rawWinner.cofechaCompetition;
    if (exhaustiveCompositionIsLocalized(raw, startYear, endYear)
        && corroboratingCofecha.frontierEventType === rawWinner.unitEventType
        && raw.masterMargin - rawRunnerUp.rawCompetition.masterMargin >= 0.05
        && raw.referenceMedianMargin >= 0.02
        && raw.referenceMedianMargin
            - rawRunnerUp.rawCompetition.referenceMedianMargin >= 0.02
        && raw.mixedReferenceSupportRatio >= 0.5
        && corroboratingCofecha.referenceCount >= 8
        && corroboratingCofecha.referenceMedianMargin >= 0.04
        && corroboratingCofecha.referenceMedianMargin
            >= rawRunnerUp.cofechaCompetition.referenceMedianMargin - 0.01
        && corroboratingCofecha.mixedReferenceSupportRatio >= 0.8
        && corroboratingCofecha.orientationReferenceSupportRatio >= 0.8
        && corroboratingCofecha.orientationMedianMargin >= 0.005) {
        return {
            unitEventType: rawWinner.unitEventType,
            competition: corroboratingCofecha,
            reason: "raw_completed_family",
        };
    }
    return null;
};

const completedMixedSourceSegmentAnchors = (event: DiagnosisEvent): number[] => {
    const startYear = latestCompletedMixedNoteNumber(
        event,
        "candidate_source_segment_start",
    );
    const endYear = latestCompletedMixedNoteNumber(
        event,
        "candidate_source_segment_end",
    );
    if (startYear === null || endYear === null
        || startYear > endYear || endYear - startYear > 80) return [];
    const span = endYear - startYear;
    if (span <= 8) {
        return Array.from({ length: span + 1 }, (_, index) => startYear + index);
    }
    return Array.from(new Set([
        startYear,
        startYear + Math.round(span * 0.25),
        startYear + Math.round(span * 0.5),
        startYear + Math.round(span * 0.75),
        endYear,
    ])).sort((left, right) => left - right);
};

/**
 * A bounded path can observe the cumulative lag while a hard partial candidate observes the
 * intermediate state. Their exact one-year amplitude difference is only a seed; the completed
 * per-reference correction still has to prove the mixed interpretation before it can be shown.
 */
export const selectBoundedCompletedPartialUnitSeeds = (
    boundedEvents: readonly DiagnosisEvent[],
    candidateEvents: readonly DiagnosisEvent[],
    supportingEvents: readonly DiagnosisEvent[] = [],
): BoundedCompletedPartialUnitSeed[] => {
    if (boundedEvents.some((event) => event.eventType === "wholeSeriesMove")) return [];
    const aggregates = boundedEvents.filter((event) => (
        event.eventType === "partialMove"
        && event.shiftSide === "older"
        && Number.isInteger(event.shiftYears)
        && event.shiftYears! <= -3
    ));
    const hardComponents = candidateEvents.filter((event) => (
        event.eventType === "partialMove"
        && event.shiftSide === "older"
        && Number.isInteger(event.shiftYears)
        && event.shiftYears! <= -2
        && event.evidence.candidateIds.length > 0
        && event.evidence.notes.includes("candidate_hard_gate_passed")
    ));
    return aggregates.flatMap((aggregate) => {
        const groups = new Map<string, DiagnosisEvent[]>();
        hardComponents.filter((component) => (
            Math.abs(aggregate.shiftYears! - component.shiftYears!) === 1
        )).forEach((component) => {
            const unitEventType = aggregate.shiftYears! - component.shiftYears! === -1
                ? "missingRing"
                : "falseRing";
            const key = `${unitEventType}:${component.shiftYears}`;
            groups.set(key, [...(groups.get(key) ?? []), component]);
        });
        const exactSeeds = Array.from(groups.entries()).map(([key, components]) => {
            const [unitEventType] = key.split(":") as ["missingRing" | "falseRing"];
            const component = components.slice().sort((left, right) => (
                right.evidence.score - left.evidence.score
            ))[0];
            const unitAnchors = supportingEvents.filter((event) => (
                event.eventType === unitEventType
            )).flatMap((event) => event.rankedYears.slice(0, 3).map((row) => row.year));
            const anchorYears = Array.from(new Set([
                ...components.flatMap((event) => {
                    const anchor = candidateEventAnchorYear(event);
                    return [
                        ...(anchor === null ? [] : [anchor]),
                        ...completedMixedSourceSegmentAnchors(event),
                    ];
                }),
                ...unitAnchors,
            ])).sort((left, right) => left - right);
            return {
                unitEventType,
                anchorYears,
                event: {
                    ...aggregate,
                    evidence: {
                        ...aggregate.evidence,
                        algorithmSources: Array.from(new Set([
                            ...aggregate.evidence.algorithmSources,
                            ...components.flatMap((event) => event.evidence.algorithmSources),
                        ])).sort(),
                        candidateIds: Array.from(new Set([
                            ...aggregate.evidence.candidateIds,
                            ...components.flatMap((event) => event.evidence.candidateIds),
                        ])),
                        notes: Array.from(new Set([
                            ...aggregate.evidence.notes,
                            "candidate_hard_gate_passed",
                            "bounded_completed_mixed_seed=exact_component_amplitude",
                            `bounded_completed_mixed_component_shift=${component.shiftYears}`,
                            `bounded_completed_mixed_unit_type=${unitEventType}`,
                            ...(anchorYears.length > 0
                                ? [`bounded_completed_mixed_anchor_min=${anchorYears[0]}`]
                                : []),
                        ])),
                    },
                },
            };
        });
        if (exactSeeds.length > 0) return exactSeeds;
        const unitTransitionEvents = supportingEvents.filter((event) => {
            if (event.eventType !== "missingRing" && event.eventType !== "falseRing") {
                return false;
            }
            const unitShift = event.eventType === "missingRing" ? -1 : 1;
            return event.evidence.lagBefore !== null
                && event.evidence.lagAfter !== null
                && event.evidence.lagBefore - event.evidence.lagAfter === unitShift;
        });
        const inferredSeeds = (["missingRing", "falseRing"] as const).flatMap(
            (unitEventType) => {
                const supports = unitTransitionEvents.filter((event) => {
                    if (event.eventType !== unitEventType) return false;
                    const correlationGain = event.evidence.correlationGain
                        ?? Number.NEGATIVE_INFINITY;
                    const connectsAggregateState = event.evidence.lagBefore
                        === aggregate.shiftYears
                        || event.evidence.lagAfter === aggregate.shiftYears;
                    const candidateBackedTransition = connectsAggregateState
                        && event.evidence.notes.includes("candidate_hard_gate_passed")
                        && event.evidence.scoreMargin >= 0.02;
                    const independentPathTransition = event.evidence.scoreMargin >= 0.02
                        && correlationGain >= 0.03
                        && (
                            event.evidence.algorithmSources.includes("piecewise_lag_path")
                            || event.evidence.algorithmSources.includes(
                                "constrained_lag_path",
                            )
                            || event.evidence.algorithmSources.includes(
                                "reference_core_voting",
                            )
                            || event.evidence.algorithmSources.includes(
                                "joint_year_operation_evidence",
                            )
                        );
                    return candidateBackedTransition || independentPathTransition;
                });
                if (supports.length === 0) return [];
                const unitShift = unitEventType === "missingRing" ? -1 : 1;
                const partialShiftYears = aggregate.shiftYears! - unitShift;
                if (partialShiftYears > -2) return [];
                const anchorYears = Array.from(new Set(supports.flatMap((event) => [
                    ...event.rankedYears.slice(0, 5).map((row) => row.year),
                    ...completedMixedSourceSegmentAnchors(event),
                ]))).sort((left, right) => left - right);
                return [{
                    unitEventType,
                    anchorYears,
                    event: {
                        ...aggregate,
                        evidence: {
                            ...aggregate.evidence,
                            algorithmSources: Array.from(new Set([
                                ...aggregate.evidence.algorithmSources,
                                ...supports.flatMap(
                                    (event) => event.evidence.algorithmSources,
                                ),
                            ])).sort(),
                            notes: Array.from(new Set([
                                ...aggregate.evidence.notes,
                                "bounded_completed_mixed_seed=independent_unit_transition",
                                `bounded_completed_mixed_component_shift=${partialShiftYears}`,
                                `bounded_completed_mixed_unit_type=${unitEventType}`,
                                ...(anchorYears.length > 0
                                    ? [`bounded_completed_mixed_anchor_min=${anchorYears[0]}`]
                                    : []),
                            ])),
                        },
                    },
                }];
            },
        );
        return inferredSeeds;
    });
};

/**
 * Chooses a cumulative negative-lag seed without trusting the already-localized window. A stale
 * path peak may have the right operation family but the wrong amplitude and year, while the two
 * independent partial votes still agree on both. Candidate hard gates remain mandatory.
 */
export const selectCompletedPartialMissingSeed = (
    displayed: readonly DiagnosisEvent[],
    candidateEvents: readonly DiagnosisEvent[],
): CompletedPartialUnitSeed | null => {
    if (displayed.length !== 1
        || displayed[0].eventType !== "partialMove"
        || displayed[0].shiftSide !== "older") return null;
    const current = displayed[0];
    const hardCandidates = candidateEvents.filter((event) => (
        event.eventType === "partialMove"
        && event.shiftSide === "older"
        && (event.shiftYears ?? 0) <= -3
        && event.evidence.candidateIds.length > 0
        && event.evidence.notes.includes("candidate_hard_gate_passed")
    ));
    const currentIsHardCandidate = (current.shiftYears ?? 0) <= -3
        && current.evidence.candidateIds.length > 0
        && current.evidence.notes.includes("candidate_hard_gate_passed");
    const currentHasIndependentDistribution = current.evidence.algorithmSources.includes(
        "full_interval_counterfactual_scan",
    ) && current.evidence.algorithmSources.includes("decisive_joint_operation_fusion");
    if (!currentIsHardCandidate && hardCandidates.length === 0) return null;

    const referenceShift = latestCompletedMixedNoteNumber(
        current,
        "partial_reference_vote_shift",
    );
    const referenceYear = latestCompletedMixedNoteNumber(
        current,
        "partial_reference_vote_year",
    );
    const referenceGain = latestCompletedMixedNoteNumber(
        current,
        "partial_reference_vote_gain",
    ) ?? Number.NEGATIVE_INFINITY;
    const exhaustiveShift = latestCompletedMixedNoteNumber(
        current,
        "partial_exhaustive_vote_shift",
    );
    const exhaustiveYear = latestCompletedMixedNoteNumber(
        current,
        "partial_exhaustive_vote_year",
    );
    const exhaustiveGain = latestCompletedMixedNoteNumber(
        current,
        "partial_exhaustive_vote_gain",
    ) ?? Number.NEGATIVE_INFINITY;
    const dualVoteShift = referenceShift !== null
        && referenceShift === exhaustiveShift
        && referenceShift <= -3
        && referenceGain >= 0.04
        && exhaustiveGain >= 0.04
        && referenceYear !== null
        && exhaustiveYear !== null
        && Math.abs(referenceYear - exhaustiveYear) <= 6
        ? referenceShift
        : null;

    const groups = new Map<number, DiagnosisEvent[]>();
    hardCandidates.forEach((event) => {
        const shiftYears = event.shiftYears!;
        const group = groups.get(shiftYears) ?? [];
        group.push(event);
        groups.set(shiftYears, group);
    });
    const matchingVoteShift = (shiftYears: number): boolean => (
        (referenceShift === shiftYears && referenceGain >= 0.04)
        || (exhaustiveShift === shiftYears && exhaustiveGain >= 0.04)
    );
    const candidateGroup = Array.from(groups.entries())
        .filter(([shiftYears, events]) => {
            const candidateIds = new Set(events.flatMap(
                (event) => event.evidence.candidateIds,
            ));
            const hasCofecha = events.some((event) => (
                event.evidence.algorithmSources.includes("cofecha_segment_lag")
            ));
            const hasIndependent = events.some((event) => (
                !event.evidence.algorithmSources.includes("cofecha_segment_lag")
                && event.evidence.algorithmSources.includes("segmented_diagnosis")
            ));
            return candidateIds.size >= 2
                && hasCofecha
                && hasIndependent
                && matchingVoteShift(shiftYears);
        })
        .sort((left, right) => (
            right[1].length - left[1].length
            || Math.max(...right[1].map((event) => event.evidence.score))
                - Math.max(...left[1].map((event) => event.evidence.score))
        ))[0] ?? null;

    const residualPair = hardCandidates.flatMap((cumulative) => hardCandidates
        .filter((partial) => (
            partial !== cumulative
            && partial.shiftYears === cumulative.shiftYears! + 1
            && cumulative.evidence.lagBefore === cumulative.shiftYears
            && cumulative.evidence.lagAfter === 0
            && partial.evidence.lagBefore === cumulative.shiftYears
            && partial.evidence.lagAfter === -1
        ))
        .map((partial) => ({ cumulative, partial })))
        .sort((left, right) => (
            right.cumulative.evidence.score - left.cumulative.evidence.score
        ))[0] ?? null;
    const strongSingleVoteCandidates = hardCandidates.filter((candidate) => {
        const candidateYear = candidateEventAnchorYear(candidate);
        if (candidateYear === null) return false;
        return (referenceShift === candidate.shiftYears
                && referenceGain >= 0.08
                && referenceYear !== null
                && Math.abs(referenceYear - candidateYear) <= 13)
            || (exhaustiveShift === candidate.shiftYears
                && exhaustiveGain >= 0.08
                && exhaustiveYear !== null
                && Math.abs(exhaustiveYear - candidateYear) <= 13);
    }).sort((left, right) => right.evidence.score - left.evidence.score);
    const dualSourceAggregateCandidate = hardCandidates.find((candidate) => (
        candidate.shiftYears === current.shiftYears
        && candidate.evidence.algorithmSources.includes("cofecha_segment_lag")
        && candidate.evidence.algorithmSources.includes("segmented_diagnosis")
    ));

    const cumulativeShiftYears = currentIsHardCandidate
        ? current.shiftYears!
        : currentHasIndependentDistribution && dualSourceAggregateCandidate
            ? current.shiftYears!
            : dualVoteShift
                ?? residualPair?.cumulative.shiftYears
                ?? candidateGroup?.[0]
                ?? strongSingleVoteCandidates[0]?.shiftYears
                ?? null;
    if (cumulativeShiftYears === null) return null;
    const useCurrentJointDistribution = currentHasIndependentDistribution
        && dualSourceAggregateCandidate?.shiftYears === cumulativeShiftYears;
    const voteAnchorYears = [
        ...(referenceShift === cumulativeShiftYears && referenceGain >= 0.04
            && referenceYear !== null ? [referenceYear] : []),
        ...(exhaustiveShift === cumulativeShiftYears && exhaustiveGain >= 0.04
            && exhaustiveYear !== null ? [exhaustiveYear] : []),
    ];
    const matchingCandidates = hardCandidates.filter(
        (event) => event.shiftYears === cumulativeShiftYears,
    );
    const anchorYears = Array.from(new Set([
        ...voteAnchorYears,
        ...matchingCandidates.flatMap((event) => {
            const year = candidateEventAnchorYear(event);
            return year === null ? [] : [year];
        }),
    ])).sort((left, right) => left - right);
    const distanceToVote = (event: DiagnosisEvent): number => {
        const year = candidateEventAnchorYear(event);
        if (year === null || voteAnchorYears.length === 0) return 0;
        return Math.min(...voteAnchorYears.map((voteYear) => Math.abs(year - voteYear)));
    };
    const source = (currentIsHardCandidate || useCurrentJointDistribution
        ? [current]
        : matchingCandidates)
        .slice()
        .sort((left, right) => (
            distanceToVote(left) - distanceToVote(right)
            || Number(right.evidence.lagAfter === 0) - Number(left.evidence.lagAfter === 0)
            || right.evidence.score - left.evidence.score
        ))[0] ?? current;
    const candidateIds = Array.from(new Set([
        ...source.evidence.candidateIds,
        ...hardCandidates.flatMap((event) => event.evidence.candidateIds),
    ]));
    return {
        event: {
            ...source,
            shiftYears: cumulativeShiftYears,
            shiftSide: "older",
            evidence: {
                ...source.evidence,
                lagBefore: cumulativeShiftYears,
                lagAfter: 0,
                candidateIds,
                notes: Array.from(new Set([
                    ...source.evidence.notes,
                    "candidate_hard_gate_passed",
                    dualVoteShift === cumulativeShiftYears
                        ? "completed_mixed_seed=dual_partial_vote"
                        : dualSourceAggregateCandidate?.shiftYears === cumulativeShiftYears
                            ? "completed_mixed_seed=joint_distribution_dual_source_candidate"
                        : residualPair?.cumulative.shiftYears === cumulativeShiftYears
                            ? "completed_mixed_seed=unit_residual_pair"
                            : candidateGroup?.[0] === cumulativeShiftYears
                                ? "completed_mixed_seed=candidate_consensus"
                                : "completed_mixed_seed=single_vote_candidate",
                ])),
            },
        },
        anchorYears,
    };
};

/**
 * A full-interval partial result can still be a cumulative partial+false state. Let an executable
 * hard candidate confirm its amplitude, then leave the actual family decision to the completed
 * per-reference correction comparison.
 */
export const selectCompletedPartialFalseSeed = (
    displayed: readonly DiagnosisEvent[],
    candidateEvents: readonly DiagnosisEvent[],
): CompletedPartialUnitSeed | null => {
    if (displayed.length !== 1) return null;
    const displayedCurrent = displayed[0];
    const hardPartialCandidates = candidateEvents.filter((event) => (
        event.eventType === "partialMove"
        && event.shiftSide === "older"
        && (event.shiftYears ?? 0) <= -3
        && event.evidence.candidateIds.length > 0
        && event.evidence.notes.includes("candidate_hard_gate_passed")
    ));
    const sourceSegmentRange = (event: DiagnosisEvent): {
        startYear: number;
        endYear: number;
    } | null => {
        const startYear = latestCompletedMixedNoteNumber(
            event,
            "candidate_source_segment_start",
        );
        const endYear = latestCompletedMixedNoteNumber(
            event,
            "candidate_source_segment_end",
        );
        return startYear !== null && endYear !== null && startYear <= endYear
            ? { startYear, endYear }
            : null;
    };
    const remoteFalseSelectorProbability = latestCompletedMixedNoteNumber(
        displayedCurrent,
        "joint_operation_selector_probability",
    ) ?? 1;
    const sourceSegmentCandidate = displayedCurrent.eventType === "falseRing"
        && displayedCurrent.evidence.candidateIds.length === 0
        && displayedCurrent.evidence.algorithmSources.includes(
            "decisive_joint_operation_fusion",
        )
        && remoteFalseSelectorProbability <= 0.75
        && displayedCurrent.evidence.scoreMargin <= 0.03
        ? hardPartialCandidates.find((candidate) => {
            const range = sourceSegmentRange(candidate);
            return range !== null
                && (displayedCurrent.endYear < range.startYear
                    || displayedCurrent.startYear > range.endYear);
        }) ?? null
        : null;
    const current = displayedCurrent.eventType === "partialMove"
        && displayedCurrent.shiftSide === "older"
        && (displayedCurrent.shiftYears ?? 0) <= -3
        ? displayedCurrent
        : sourceSegmentCandidate;
    if (!current) return null;
    const currentIsHardCandidate = current.evidence.candidateIds.length > 0
        && current.evidence.notes.includes("candidate_hard_gate_passed");
    const currentHasIndependentDistribution = current.evidence.algorithmSources.includes(
        "full_interval_counterfactual_locator",
    ) && current.evidence.algorithmSources.includes("decisive_joint_operation_fusion");
    if (!currentIsHardCandidate && !currentHasIndependentDistribution) return null;

    const matchingPartialCandidates = candidateEvents.filter((event) => (
        event.eventType === "partialMove"
        && event.shiftSide === "older"
        && event.shiftYears === current.shiftYears
        && event.evidence.candidateIds.length > 0
        && event.evidence.notes.includes("candidate_hard_gate_passed")
    ));
    const explicitFalseCandidates = candidateEvents.filter((event) => (
        event.eventType === "falseRing"
        && event.evidence.lagBefore === 1
        && event.evidence.lagAfter === 0
        && event.evidence.candidateIds.length > 0
        && event.evidence.notes.includes("candidate_hard_gate_passed")
    ));
    const supportingCandidates = [
        ...matchingPartialCandidates,
        ...explicitFalseCandidates,
    ];
    if (supportingCandidates.length === 0) return null;
    const anchorYears = Array.from(new Set(supportingCandidates.flatMap((event) => {
        const year = candidateEventAnchorYear(event);
        const range = sourceSegmentRange(event);
        const segmentYears = range && range.endYear - range.startYear <= 80
            ? Array.from(
                { length: range.endYear - range.startYear + 1 },
                (_, index) => range.startYear + index,
            )
            : [];
        return [...(year === null ? [] : [year]), ...segmentYears];
    }))).sort((left, right) => left - right);
    return {
        event: {
            ...current,
            evidence: {
                ...current.evidence,
                algorithmSources: Array.from(new Set([
                    ...current.evidence.algorithmSources,
                    ...supportingCandidates.flatMap(
                        (event) => event.evidence.algorithmSources,
                    ),
                ])).sort(),
                candidateIds: Array.from(new Set(supportingCandidates.flatMap(
                    (event) => event.evidence.candidateIds,
                ))),
                notes: Array.from(new Set([
                    ...current.evidence.notes,
                    "candidate_hard_gate_passed",
                    matchingPartialCandidates.length > 0
                        ? sourceSegmentCandidate
                            ? "completed_mixed_seed=source_segment_partial_over_remote_false"
                            : "completed_mixed_seed=displayed_candidate_amplitude_consensus"
                        : "completed_mixed_seed=explicit_false_frontier_candidate",
                ])),
            },
        },
        anchorYears,
    };
};

const makeCompletedPartialUnitFrontierEvent = (
    source: DiagnosisEvent,
    competition: CompletedPartialUnitComposition,
    diagnosis: SeriesCoreDiagnosis,
): DiagnosisEvent => {
    const sourceTag = competition.unitEventType === "missingRing"
        ? "completed_partial_missing_composition"
        : "completed_partial_false_composition";
    const isLongComposition = competition.separationYears >= 14;
    const isLongBoundedComposition = source.evidence.algorithmSources.includes(
        "bounded_complete_lag_path",
    ) && isLongComposition;
    const width = isLongComposition
        ? 13
        : competition.referenceMedianMargin >= 0.04
            && competition.orientationMedianMargin >= 0.01
            ? 7
            : 9;
    const boundedAnchorMinimum = latestCompletedMixedNoteNumber(
        source,
        "bounded_completed_mixed_anchor_min",
    );
    const centeredStartYear = competition.frontierYear - Math.floor(width / 2);
    const proposedStartYear = isLongBoundedComposition
        ? Math.max(
            competition.frontierYear - width + 1,
            Math.min(
                competition.frontierYear - 4,
                (boundedAnchorMinimum ?? competition.frontierYear) - 7,
            ),
        )
        : centeredStartYear;
    const startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(
            proposedStartYear,
            diagnosis.targetRange.endYear - width + 1,
        ),
    );
    const endYear = startYear + width - 1;
    const rankedYears = Array.from({ length: width }, (_, index) => {
        const year = startYear + index;
        return {
            year,
            score: -Math.abs(year - competition.frontierYear),
            evidenceTags: [sourceTag],
        };
    }).sort((left, right) => (
        right.score - left.score || left.year - right.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    const common: DiagnosisEvent = {
        ...source,
        id: `${source.id}-completed-partial-unit-frontier`,
        eventType: competition.frontierEventType,
        startYear,
        endYear,
        reviewCoreRange: { startYear, endYear },
        rankedYears,
        confidenceLevel: "medium",
        alternativeTypes: [],
        locationAlternatives: undefined,
        operationAlternatives: undefined,
        evidence: {
            ...source.evidence,
            algorithmSources: Array.from(new Set([
                ...source.evidence.algorithmSources,
                sourceTag,
                "per_reference_completed_correction",
            ])).sort(),
            scoreMargin: Math.max(0, competition.referenceMedianMargin),
            lagBefore: competition.frontierEventType === "partialMove"
                ? competition.partialShiftYears
                : competition.unitEventType === "missingRing" ? -1 : 1,
            lagAfter: 0,
            notes: Array.from(new Set([
                ...source.evidence.notes,
                ...completedPartialUnitNotes(competition),
                ...(competition.frontierEventType === "partialMove"
                    ? [`counterfactual_correction_years=${competition.partialShiftYears}`]
                    : []),
                "completed_mixed_frontier_is_newest_event",
                "completed_mixed_score_is_relative_not_probability",
            ])),
        },
    };
    if (competition.frontierEventType === "partialMove") {
        const partial: DiagnosisEvent = {
            ...common,
            shiftYears: competition.partialShiftYears,
            shiftSide: "older",
        };
        if (competition.unitEventType !== "missingRing") return partial;
        const interpretationEvidence = evaluateCompletedPartialMissingInterpretation(
            partial,
            competition,
            {
                compositionReviewPassed: true,
                hasIndependentWholeSeriesBaseline: false,
            },
        );
        return interpretationEvidence
            ? attachMissingPartialInterpretation(
                partial,
                makeMissingRingInterpretation(
                    partial,
                    interpretationEvidence,
                    diagnosis.targetRange,
                ),
                interpretationEvidence,
            )
            : partial;
    }
    const unit = { ...common };
    delete unit.shiftYears;
    delete unit.shiftSide;
    return unit;
};

export const hardCandidateMaySeedExhaustiveComposition = (
    event: DiagnosisEvent,
    candidateEvents: readonly DiagnosisEvent[],
): boolean => {
    if (event.eventType !== "partialMove"
        || event.evidence.candidateIds.length < 1
        || !event.evidence.notes.includes("candidate_hard_gate_passed")
        || ![
            "candidate_ranking",
            "global_sliding_match",
            "propagation_pattern",
            "segmented_diagnosis",
        ].every((source) => event.evidence.algorithmSources.includes(source))) {
        return false;
    }
    const cumulativeMagnitude = Math.abs(event.shiftYears ?? 0);
    if (cumulativeMagnitude >= 14
        && event.evidence.lagBefore !== null
        && event.evidence.lagAfter !== null
        && Math.abs(event.evidence.lagAfter - event.evidence.lagBefore) === 1) {
        return true;
    }
    if (cumulativeMagnitude < 3 || cumulativeMagnitude > 13) return false;
    const eventYear = rankedEventYear(event);
    return candidateEvents.some((candidate) => {
        if ((candidate.eventType !== "missingRing"
                && candidate.eventType !== "falseRing")
            || !candidate.evidence.notes.includes("candidate_hard_gate_passed")) {
            return false;
        }
        if (candidate.evidence.candidateIds.length < 2
            || candidate.evidence.correlationGain === null
            || candidate.evidence.correlationGain < 0.005
            || !candidate.evidence.algorithmSources.includes("cofecha_segment_lag")
            || !candidate.evidence.algorithmSources.includes("local_edit_alignment")) {
            return false;
        }
        const distance = Math.abs(rankedEventYear(candidate) - eventYear);
        return distance >= 4 && distance <= 40;
    });
};

/**
 * Resolves a long unit+partial composition only when raw and COFECHA views independently place
 * both boundaries in the same mode. This checkpoint runs before generic lag-path projection so
 * a remote path cannot overwrite a completed, operation-specific correction.
 */
const recoverCrossViewCompletedPartialUnitFrontier = (
    boundedEvents: readonly DiagnosisEvent[],
    displayedEvents: readonly DiagnosisEvent[],
    candidateEvents: readonly DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    maxPartialGapYears: number,
    operations: readonly JointCounterfactualOperationScore[],
): DiagnosisEvent | null => {
    if (displayedEvents.some((event) => event.eventType === "wholeSeriesMove")) {
        return null;
    }
    const operationHypotheses = candidateEvents.filter((event) => (
        event.eventType === "partialMove"
        && event.shiftSide === "older"
        && Number.isInteger(event.shiftYears)
        && event.shiftYears! <= -3
        && Math.abs(event.shiftYears!) <= maxPartialGapYears
        && event.evidence.candidateIds.length > 0
        && event.evidence.notes.includes("candidate_hard_gate_passed")
        && [
            "candidate_ranking",
            "global_sliding_match",
            "propagation_pattern",
            "segmented_diagnosis",
        ].every((source) => event.evidence.algorithmSources.includes(source))
        && (event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY) >= 0.02
    )).sort((left, right) => (
        right.evidence.scoreMargin - left.evidence.scoreMargin
        || right.evidence.score - left.evidence.score
    ));
    const locationHypotheses = [
        ...boundedEvents,
        ...displayedEvents,
    ].filter((event, index, events) => (
        event.eventType === "partialMove"
        && event.shiftSide === "older"
        && Number.isInteger(event.shiftYears)
        && event.shiftYears! <= -3
        && Math.abs(event.shiftYears!) <= maxPartialGapYears
        && event.endYear - event.startYear + 1 <= 13
        && (
            event.evidence.algorithmSources.includes("bounded_complete_lag_path")
            || (
                event.evidence.algorithmSources.includes(
                    "full_interval_counterfactual_scan",
                )
                && event.evidence.algorithmSources.includes(
                    "decisive_joint_operation_fusion",
                )
            )
        )
        && events.findIndex((candidate) => (
            candidate.eventType === "partialMove"
            && candidate.shiftYears === event.shiftYears
            && candidate.startYear === event.startYear
            && candidate.endYear === event.endYear
        )) === index
    )).sort((left, right) => (
        Number(right.evidence.algorithmSources.includes("bounded_complete_lag_path"))
            - Number(left.evidence.algorithmSources.includes("bounded_complete_lag_path"))
        || right.evidence.scoreMargin - left.evidence.scoreMargin
    ));
    const aggregates = locationHypotheses.flatMap((location, index) => {
        if (locationHypotheses.findIndex((candidate) => (
            candidate.shiftYears === location.shiftYears
        )) !== index) return [];
        const operation = operationHypotheses.find((candidate) => (
            candidate.shiftYears === location.shiftYears
        ));
        if (!operation) return [];
        return [{
            ...location,
            evidence: {
                ...location.evidence,
                algorithmSources: Array.from(new Set([
                    ...location.evidence.algorithmSources,
                    ...operation.evidence.algorithmSources,
                ])).sort(),
                score: Math.max(location.evidence.score, operation.evidence.score),
                scoreMargin: Math.max(
                    location.evidence.scoreMargin,
                    operation.evidence.scoreMargin,
                ),
                baselineCorrelation: operation.evidence.baselineCorrelation
                    ?? location.evidence.baselineCorrelation,
                correctedCorrelation: operation.evidence.correctedCorrelation
                    ?? location.evidence.correctedCorrelation,
                correlationGain: Math.max(
                    location.evidence.correlationGain ?? Number.NEGATIVE_INFINITY,
                    operation.evidence.correlationGain ?? Number.NEGATIVE_INFINITY,
                ),
                samplePairs: Math.max(
                    location.evidence.samplePairs,
                    operation.evidence.samplePairs,
                ),
                candidateIds: Array.from(new Set([
                    ...location.evidence.candidateIds,
                    ...operation.evidence.candidateIds,
                ])),
                notes: Array.from(new Set([
                    ...location.evidence.notes,
                    ...operation.evidence.notes,
                    "cross_view_location_operation_hypothesis",
                ])),
            },
        }];
    });
    for (const aggregate of aggregates) {
        const regionalStartYear = Math.max(
            diagnosis.targetRange.startYear,
            aggregate.startYear - 6,
        );
        const regionalEndYear = Math.min(
            diagnosis.targetRange.endYear,
            aggregate.endYear + 6,
        );
        const regionalAnchorYear = rankedEventYear(aggregate);
        const exhaustiveCandidates = (["missingRing", "falseRing"] as const)
            .flatMap((unitEventType): ExhaustiveCompletedPartialUnitCandidate[] => {
                const unitShiftYears = unitEventType === "missingRing" ? -1 : 1;
                const partialShiftYears = aggregate.shiftYears! - unitShiftYears;
                if (partialShiftYears > -2) return [];
                const operation = operations.find((candidate) => (
                    candidate.eventType === unitEventType
                    && candidate.shiftYears === unitShiftYears
                ));
                if (!operation) return [];
                const regionalEvidence = summarizeJointOperationRegion(
                    operation,
                    regionalStartYear,
                    regionalEndYear,
                    regionalAnchorYear,
                );
                const regionalAnchorYears = [
                    regionalEvidence.bestYear,
                    regionalEvidence.bestSideStepYear,
                ].filter((year): year is number => year !== null);
                const seed: DiagnosisEvent = {
                    ...aggregate,
                    evidence: {
                        ...aggregate.evidence,
                        notes: Array.from(new Set([
                            ...aggregate.evidence.notes,
                            "completed_mixed_seed=cross_view_boundary_consensus",
                        ])),
                    },
                };
                const rawCompetition = unitEventType === "missingRing"
                    ? compareCompletedPartialWithSingleMissing(
                        diagnosis,
                        siteData,
                        seed,
                        [],
                        false,
                        regionalAnchorYears,
                        40,
                    )
                    : compareCompletedPartialWithSingleFalse(
                        diagnosis,
                        siteData,
                        seed,
                        false,
                        regionalAnchorYears,
                        40,
                    );
                const cofechaCompetition = unitEventType === "missingRing"
                    ? compareCompletedPartialWithSingleMissing(
                        cofechaDiagnosis,
                        siteData,
                        seed,
                        [],
                        true,
                        regionalAnchorYears,
                        40,
                    )
                    : compareCompletedPartialWithSingleFalse(
                        cofechaDiagnosis,
                        siteData,
                        seed,
                        true,
                        regionalAnchorYears,
                        40,
                    );
                return rawCompetition && cofechaCompetition ? [{
                    unitEventType,
                    rawCompetition,
                    cofechaCompetition,
                    regionalEvidence,
                }] : [];
            });
        const selected = selectExhaustiveCompletedPartialUnitComposition(
            exhaustiveCandidates,
            aggregate.startYear,
            aggregate.endYear,
        );
        if (selected?.reason !== "cross_view_boundary_consensus"
            || decisiveExactPartialRejectsWeakUnitComposition(
                aggregate,
                selected.competition,
            )) continue;
        const selectedSource: DiagnosisEvent = {
            ...aggregate,
            evidence: {
                ...aggregate.evidence,
                algorithmSources: Array.from(new Set([
                    ...aggregate.evidence.algorithmSources,
                    "cross_view_completed_composition_checkpoint",
                    "exhaustive_completed_partial_unit_adjudication",
                ])).sort(),
                notes: Array.from(new Set([
                    ...aggregate.evidence.notes,
                    `completed_mixed_exhaustive_selected_type=${selected.unitEventType}`,
                    `completed_mixed_exhaustive_reason=${selected.reason}`,
                ])),
            },
        };
        return makeCompletedPartialUnitFrontierEvent(
            selectedSource,
            selected.competition,
            diagnosis,
        );
    }
    return null;
};

const recoverBoundedCompletedPartialUnitFrontier = (
    boundedEvents: readonly DiagnosisEvent[],
    displayedEvents: readonly DiagnosisEvent[],
    candidateEvents: readonly DiagnosisEvent[],
    supportingEvents: readonly DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    maxPartialGapYears: number,
    locatorPathCache: LagPathCache,
    unitOperationSelection: DynamicJointOperationSelection | null,
    operations: readonly JointCounterfactualOperationScore[],
): DiagnosisEvent | null => {
    const selectedUnitOperation = unitOperationSelection
        && unitOperationSelection.score >= 0.04
        && unitOperationSelection.scoreMargin >= 0.02
        && unitOperationSelection.operation.bestDifferenceGain >= 0.03
        ? unitOperationSelection
        : null;
    const unitOperationEvent: DiagnosisEvent[] = selectedUnitOperation
        ? (() => {
            const operation = selectedUnitOperation.operation;
            const unitShift = operation.eventType === "missingRing" ? -1 : 1;
            const startYear = Math.max(
                diagnosis.targetRange.startYear,
                operation.bestYear - 3,
            );
            const endYear = Math.min(diagnosis.targetRange.endYear, startYear + 6);
            return [{
                id: `${diagnosis.targetTree}-bounded-unit-operation-${operation.eventType}`,
                seriesId: diagnosis.targetTree,
                eventType: operation.eventType,
                startYear,
                endYear,
                rankedYears: [{
                    year: operation.bestYear,
                    rank: 1,
                    score: selectedUnitOperation.score,
                    evidenceTags: ["joint_year_operation_evidence"],
                }],
                confidenceLevel: "medium",
                evidence: {
                    algorithmSources: ["joint_year_operation_evidence"],
                    score: selectedUnitOperation.score,
                    scoreMargin: selectedUnitOperation.scoreMargin,
                    baselineCorrelation: null,
                    correctedCorrelation: null,
                    correlationGain: operation.bestDifferenceGain,
                    lagBefore: unitShift,
                    lagAfter: 0,
                    samplePairs: 0,
                    candidateIds: [],
                    notes: ["bounded_unit_operation_selection"],
                },
                alternativeTypes: [],
            }];
        })()
        : [];
    const directSeeds = selectBoundedCompletedPartialUnitSeeds(
        boundedEvents,
        candidateEvents,
        supportingEvents,
    );
    const seeds = directSeeds.length > 0
        ? directSeeds
        : selectBoundedCompletedPartialUnitSeeds(
            boundedEvents,
            candidateEvents,
            [...supportingEvents, ...unitOperationEvent],
        );
    const isExhaustiveHardCandidateAggregate = (event: DiagnosisEvent): boolean => (
        hardCandidateMaySeedExhaustiveComposition(event, candidateEvents)
    );
    const aggregateCandidates = [
        ...displayedEvents,
        ...boundedEvents,
        ...candidateEvents,
    ].filter((event, index, events) => (
        event.eventType === "partialMove"
        && event.shiftSide === "older"
        && Number.isInteger(event.shiftYears)
        && event.shiftYears! <= -3
        && Math.abs(event.shiftYears!) <= maxPartialGapYears
        && event.endYear - event.startYear + 1 <= 13
        && (
            event.evidence.scoreMargin >= 0.02
            || isExhaustiveHardCandidateAggregate(event)
        )
        && (
            event.evidence.algorithmSources.includes("bounded_complete_lag_path")
            || (
                event.evidence.algorithmSources.includes(
                    "full_interval_counterfactual_scan",
                )
                && event.evidence.algorithmSources.includes(
                    "decisive_joint_operation_fusion",
                )
            )
            || isExhaustiveHardCandidateAggregate(event)
        )
        && events.findIndex((candidate) => (
            candidate.eventType === "partialMove"
            && candidate.shiftYears === event.shiftYears
            && candidate.startYear === event.startYear
            && candidate.endYear === event.endYear
        )) === index
    )).sort((left, right) => (
        Number(displayedEvents.includes(right))
            - Number(displayedEvents.includes(left))
        || Number(boundedEvents.includes(right))
            - Number(boundedEvents.includes(left))
        || right.evidence.scoreMargin - left.evidence.scoreMargin
        || right.evidence.score - left.evidence.score
    ));
    const missingPath = seeds.some((seed) => seed.unitEventType === "missingRing")
        || aggregateCandidates.length > 0
        ? locateSequentialMissingHead(
            cofechaDiagnosis,
            siteData,
            { minLag: -maxPartialGapYears, maxPartialGapYears },
            locatorPathCache,
        )
        : null;
    const supported = seeds.flatMap((seed) => {
        const competition = seed.unitEventType === "missingRing"
            ? compareCompletedPartialWithSingleMissing(
                cofechaDiagnosis,
                siteData,
                seed.event,
                missingPath?.unitEventYears ?? [],
                true,
                seed.anchorYears,
                40,
            )
            : compareCompletedPartialWithSingleFalse(
                cofechaDiagnosis,
                siteData,
                seed.event,
                true,
                seed.anchorYears,
                40,
            );
        const masterDominantComposition = Boolean(
            competition
            && seed.event.evidence.notes.includes(
                "bounded_completed_mixed_seed=independent_unit_transition",
            )
            && competition.separationYears >= 14
            && competition.separationYears <= 40
            && competition.masterMargin >= 0.5
            && competition.masterOrientationMargin >= 0.4
            && competition.referenceCount >= 8
            && competition.mixedReferenceSupportRatio >= 0.4
            && competition.referenceMedianMargin >= -0.02
            && competition.orientationReferenceCount >= 8
            && competition.orientationReferenceSupportRatio >= 0.6
            && competition.orientationMedianMargin >= 0.01,
        );
        const referenceDominantComposition = Boolean(
            competition
            && seed.event.evidence.notes.includes(
                "bounded_completed_mixed_seed=independent_unit_transition",
            )
            && competition.separationYears >= 14
            && competition.separationYears <= 40
            && competition.masterMargin >= 0.5
            && competition.masterOrientationMargin >= 0.1
            && competition.referenceCount >= 8
            && competition.mixedReferenceSupportRatio >= 0.7
            && competition.referenceMedianMargin >= 0.08
            && competition.referenceLowerQuartileMargin >= -0.005
            && competition.orientationReferenceCount >= 8
            && competition.orientationReferenceSupportRatio >= 0.75
            && competition.orientationMedianMargin >= 0.025
            && competition.orientationLowerQuartileMargin >= 0,
        );
        return competition
            && !decisiveExactPartialRejectsWeakUnitComposition(seed.event, competition)
            && (
                supportsCompletedPartialUnitComposition(competition)
                || masterDominantComposition
                || referenceDominantComposition
            )
            ? [{ seed, competition }]
            : [];
    }).sort((left, right) => (
        right.competition.referenceMedianMargin
            - left.competition.referenceMedianMargin
        || right.competition.referenceLowerQuartileMargin
            - left.competition.referenceLowerQuartileMargin
        || right.competition.orientationMedianMargin
            - left.competition.orientationMedianMargin
        || right.competition.mixedReferenceSupportRatio
            - left.competition.mixedReferenceSupportRatio
    ));
    const selected = supported[0];
    const runnerUp = supported[1];
    const directSelectionIsAmbiguous = Boolean(selected && runnerUp
        && runnerUp.seed.unitEventType !== selected.seed.unitEventType
        && selected.competition.referenceMedianMargin
            - runnerUp.competition.referenceMedianMargin < 0.01
        && selected.competition.orientationMedianMargin
            - runnerUp.competition.orientationMedianMargin < 0.01);
    if (selected && !directSelectionIsAmbiguous) {
        return makeCompletedPartialUnitFrontierEvent(
            selected.seed.event,
            selected.competition,
            diagnosis,
        );
    }

    // Candidate segment amplitudes are not guaranteed to expose the intermediate state. When
    // they do not, enumerate both unit families and let the complete corrections decide.
    if (displayedEvents.some((event) => event.eventType === "wholeSeriesMove")) return null;
    for (const aggregate of aggregateCandidates) {
        const regionalStartYear = Math.max(
            diagnosis.targetRange.startYear,
            aggregate.startYear - 6,
        );
        const regionalEndYear = Math.min(
            diagnosis.targetRange.endYear,
            aggregate.endYear + 6,
        );
        const regionalAnchorYear = aggregate.rankedYears.slice().sort(
            (left, right) => left.rank - right.rank,
        )[0]?.year ?? Math.round((aggregate.startYear + aggregate.endYear) / 2);
        const exhaustiveCandidates = (["missingRing", "falseRing"] as const).flatMap(
            (unitEventType): ExhaustiveCompletedPartialUnitCandidate[] => {
                const unitShiftYears = unitEventType === "missingRing" ? -1 : 1;
                const partialShiftYears = aggregate.shiftYears! - unitShiftYears;
                if (partialShiftYears > -2) return [];
                const operation = operations.find((candidate) => (
                    candidate.eventType === unitEventType
                    && candidate.shiftYears === unitShiftYears
                ));
                if (!operation) return [];
                const regionalEvidence = summarizeJointOperationRegion(
                    operation,
                    regionalStartYear,
                    regionalEndYear,
                    regionalAnchorYear,
                );
                const regionalAnchorYears = [
                    regionalEvidence.bestYear,
                    regionalEvidence.bestSideStepYear,
                ].filter((year): year is number => year !== null);
                const seed: DiagnosisEvent = {
                    ...aggregate,
                    evidence: {
                        ...aggregate.evidence,
                        notes: Array.from(new Set([
                            ...aggregate.evidence.notes,
                            "completed_mixed_seed=exhaustive_unit_family",
                            `completed_mixed_exhaustive_unit_type=${unitEventType}`,
                            `completed_mixed_exhaustive_partial_shift=${partialShiftYears}`,
                        ])),
                    },
                };
                const rawCompetition = unitEventType === "missingRing"
                    ? compareCompletedPartialWithSingleMissing(
                        diagnosis,
                        siteData,
                        seed,
                        [],
                        false,
                        [],
                        40,
                    )
                    : compareCompletedPartialWithSingleFalse(
                        diagnosis,
                        siteData,
                        seed,
                        false,
                        [],
                        40,
                    );
                const cofechaCompetition = unitEventType === "missingRing"
                    ? compareCompletedPartialWithSingleMissing(
                        cofechaDiagnosis,
                        siteData,
                        seed,
                        [],
                        true,
                        regionalAnchorYears,
                        40,
                    )
                    : compareCompletedPartialWithSingleFalse(
                        cofechaDiagnosis,
                        siteData,
                        seed,
                        true,
                        regionalAnchorYears,
                        40,
                    );
                if (!rawCompetition || !cofechaCompetition) return [];
                return [{
                    unitEventType,
                    rawCompetition,
                    cofechaCompetition,
                    regionalEvidence,
                }];
            },
        );
        const exhaustiveSelection = selectExhaustiveCompletedPartialUnitComposition(
            exhaustiveCandidates,
            aggregate.startYear,
            aggregate.endYear,
        );
        if (!exhaustiveSelection
            || decisiveExactPartialRejectsWeakUnitComposition(
                aggregate,
                exhaustiveSelection.competition,
            )) continue;
        const selectedSource: DiagnosisEvent = {
            ...aggregate,
            evidence: {
                ...aggregate.evidence,
                algorithmSources: Array.from(new Set([
                    ...aggregate.evidence.algorithmSources,
                    "exhaustive_completed_partial_unit_adjudication",
                ])).sort(),
                notes: Array.from(new Set([
                    ...aggregate.evidence.notes,
                    "completed_mixed_seed=exhaustive_unit_family",
                    `completed_mixed_exhaustive_selected_type=${
                        exhaustiveSelection.unitEventType
                    }`,
                    `completed_mixed_exhaustive_reason=${exhaustiveSelection.reason}`,
                ])),
            },
        };
        return makeCompletedPartialUnitFrontierEvent(
            selectedSource,
            exhaustiveSelection.competition,
            diagnosis,
        );
    }
    return null;
};

/**
 * A distant unit edit can be hidden inside the net lag of one aggregate partial correction.
 * Recover the newer unit only when its hard-gated candidate connects the aggregate and residual
 * lag states exactly, and an independent year-by-operation scan places it in the same mode.
 */
export const recoverAggregatePartialUnitFrontier = (
    displayedEvents: readonly DiagnosisEvent[],
    candidateEvents: readonly DiagnosisEvent[],
    unitSelection: DynamicJointOperationSelection | null,
    operations: readonly JointCounterfactualOperationScore[],
    targetRange: { startYear: number; endYear: number },
    minimumSeparationYears = 14,
): DiagnosisEvent | null => {
    if (displayedEvents.some((event) => event.eventType === "wholeSeriesMove")
        || !unitSelection
        || unitSelection.score < 0.06
        || unitSelection.scoreMargin < 0.04
        || unitSelection.operation.bestDifferenceGain < 0.08
        || unitSelection.operation.bestCombinedGain < 0.05) return null;
    const unitOperation = unitSelection.operation;
    if (unitOperation.eventType !== "missingRing"
        && unitOperation.eventType !== "falseRing") return null;
    const unitShiftYears = unitOperation.eventType === "missingRing" ? -1 : 1;
    const aggregates = displayedEvents.filter((event) => (
        event.eventType === "partialMove"
        && event.shiftSide === "older"
        && event.shiftYears !== undefined
        && event.shiftYears <= -3
        && event.evidence.lagBefore === event.shiftYears
        && event.evidence.lagAfter === 0
        && event.evidence.scoreMargin >= 0.04
        && event.evidence.algorithmSources.includes("decisive_joint_operation_fusion")
    )).sort((left, right) => (
        right.evidence.scoreMargin - left.evidence.scoreMargin
        || right.evidence.score - left.evidence.score
    ));
    for (const aggregate of aggregates) {
        const residualPartialShift = aggregate.shiftYears! - unitShiftYears;
        if (!isAutomaticPartialShift(residualPartialShift, {
            maxPartialGapYears: 100,
            lagMin: -100,
        })) continue;
        const aggregateOperation = operations.filter((operation) => (
            operation.eventType === "partialMove"
            && operation.shiftYears === aggregate.shiftYears
            && operation.baselineLag === 0
        )).sort((left, right) => (
            scoreDynamicJointOperation(right, operations)
                - scoreDynamicJointOperation(left, operations)
            || right.bestDifferenceGain - left.bestDifferenceGain
        ))[0];
        if (!aggregateOperation
            || scoreDynamicJointOperation(aggregateOperation, operations) < 0.08
            || aggregateOperation.bestDifferenceGain < 0.08
            || unitOperation.bestYear - aggregateOperation.bestYear
                < minimumSeparationYears) continue;
        const connectingCandidate = candidateEvents.filter((event) => {
            if (event.eventType !== unitOperation.eventType
                || !event.evidence.notes.includes("candidate_hard_gate_passed")
                || event.evidence.lagBefore === null
                || event.evidence.lagAfter === null
                || event.evidence.lagBefore - event.evidence.lagAfter !== unitShiftYears) {
                return false;
            }
            const states = new Set([event.evidence.lagBefore, event.evidence.lagAfter]);
            return states.has(aggregate.shiftYears!)
                && states.has(residualPartialShift)
                && Math.abs(rankedEventYear(event) - unitOperation.bestYear) <= 8;
        }).sort((left, right) => (
            Math.abs(rankedEventYear(left) - unitOperation.bestYear)
                - Math.abs(rankedEventYear(right) - unitOperation.bestYear)
            || right.evidence.score - left.evidence.score
        ))[0];
        if (!connectingCandidate) continue;

        const width = Math.min(
            9,
            targetRange.endYear - targetRange.startYear + 1,
        );
        const startYear = Math.max(
            targetRange.startYear,
            Math.min(
                unitOperation.bestYear - Math.floor(width / 2),
                targetRange.endYear - width + 1,
            ),
        );
        const endYear = startYear + width - 1;
        const rankedYears = Array.from({ length: width }, (_, index) => {
            const year = startYear + index;
            return {
                year,
                score: year === unitOperation.bestYear
                    ? unitSelection.score + 1
                    : -Math.abs(year - unitOperation.bestYear),
                evidenceTags: ["aggregate_partial_unit_decomposition"],
            };
        }).sort((left, right) => (
            right.score - left.score || left.year - right.year
        )).map((row, index) => ({ ...row, rank: index + 1 }));
        return {
            ...connectingCandidate,
            id: `${aggregate.id}-aggregate-unit-${unitOperation.eventType}-${unitOperation.bestYear}`,
            startYear,
            endYear,
            reviewCoreRange: { startYear, endYear },
            rankedYears,
            confidenceLevel: "medium",
            alternativeTypes: [],
            locationAlternatives: undefined,
            operationAlternatives: undefined,
            shiftYears: undefined,
            shiftSide: undefined,
            evidence: {
                ...connectingCandidate.evidence,
                algorithmSources: Array.from(new Set([
                    ...connectingCandidate.evidence.algorithmSources,
                    "aggregate_partial_unit_decomposition",
                    "joint_year_operation_evidence",
                ])).sort(),
                score: unitSelection.score,
                scoreMargin: unitSelection.scoreMargin,
                correlationGain: Math.max(
                    connectingCandidate.evidence.correlationGain ?? 0,
                    unitOperation.bestDifferenceGain,
                ),
                candidateIds: Array.from(new Set([
                    ...aggregate.evidence.candidateIds,
                    ...connectingCandidate.evidence.candidateIds,
                ])).sort(),
                notes: Array.from(new Set([
                    ...connectingCandidate.evidence.notes,
                    `aggregate_partial_net_shift=${aggregate.shiftYears}`,
                    `aggregate_partial_residual_shift=${residualPartialShift}`,
                    `aggregate_partial_unit_shift=${unitShiftYears}`,
                    `aggregate_partial_boundary_year=${aggregateOperation.bestYear}`,
                    `aggregate_partial_unit_year=${unitOperation.bestYear}`,
                    "aggregate_partial_unit_state_bridge=exact",
                ])),
            },
        };
    }
    return null;
};

const recoverCompletedCandidateBackedPartial = (
    competition: CompletedPartialStaircaseCompetition,
    candidateEvents: readonly DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    interpretationRole: "preferred" | "tied-alternative" = "preferred",
): DiagnosisEvent | null => {
    const supporting = candidateEvents.filter((event) => (
        event.eventType === "partialMove"
        && event.shiftSide === "older"
        && event.shiftYears === competition.partialShiftYears
        && event.evidence.candidateIds.length > 0
        && event.evidence.notes.includes("candidate_hard_gate_passed")
    )).sort((left, right) => (
        Number(right.evidence.algorithmSources.includes("cofecha_segment_lag"))
            - Number(left.evidence.algorithmSources.includes("cofecha_segment_lag"))
        || right.evidence.score - left.evidence.score
    ));
    const strongest = supporting[0];
    if (!strongest) return null;
    const width = Math.min(
        13,
        diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
    );
    const startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(
            competition.partialFirstFixedYear - Math.floor(width / 2),
            diagnosis.targetRange.endYear - width + 1,
        ),
    );
    const endYear = startYear + width - 1;
    const rankedYears = Array.from({ length: width }, (_, index) => {
        const year = startYear + index;
        return {
            year,
            score: -Math.abs(year - competition.partialFirstFixedYear),
            evidenceTags: ["completed_partial_staircase_competition"],
        };
    }).sort((left, right) => (
        right.score - left.score || left.year - right.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...strongest,
        id: `${strongest.id}-completed-family-partial`,
        eventType: "partialMove",
        startYear,
        endYear,
        reviewCoreRange: { startYear, endYear },
        rankedYears,
        confidenceLevel: "medium",
        alternativeTypes: [],
        locationAlternatives: undefined,
        operationAlternatives: undefined,
        shiftYears: competition.partialShiftYears,
        shiftSide: "older",
        evidence: {
            ...strongest.evidence,
            algorithmSources: Array.from(new Set([
                ...supporting.flatMap((event) => event.evidence.algorithmSources),
                "completed_partial_staircase_competition",
                "per_reference_completed_correction",
            ])).sort(),
            scoreMargin: Math.max(0, -competition.referenceMedianMargin),
            lagBefore: competition.partialShiftYears,
            lagAfter: 0,
            candidateIds: Array.from(new Set(
                supporting.flatMap((event) => event.evidence.candidateIds),
            )).sort(),
            notes: Array.from(new Set([
                ...strongest.evidence.notes,
                ...completedPartialCompetitionNotes(competition),
                interpretationRole === "preferred"
                    ? "completed_partial_preferred_over_discrete_missing_staircase"
                    : "completed_partial_tied_with_discrete_missing_staircase",
                "completed_partial_score_is_relative_not_probability",
            ])),
        },
    };
};

/** A multi-step path needs enough complexity-adjusted gain or one durable unit-lag state. */
export const supportsSequentialMissingReplacementOfPartial = (
    head: Pick<
        SequentialMissingHead,
        "gainOverDirect" | "transitionCount" | "headRunYears"
    >,
): boolean => head.headRunYears >= MIN_STABLE_SEQUENTIAL_HEAD_RUN_YEARS
    || head.gainOverDirect / Math.max(1, head.transitionCount - 1)
        >= MIN_SEQUENTIAL_GAIN_PER_EXTRA_TRANSITION;

/**
 * A deep one-year staircase is target-specific direction evidence: a single false ring or whole
 * shift cannot explain several successive -1 lag states. Keep this deliberately above the
 * two/three-step range where a physical local gap can overfit as discrete missing rings.
 */
export const supportsCumulativeSequentialMissingStaircase = (
    head: Pick<
        SequentialMissingHead,
        "gainOverDirect" | "transitionCount" | "headMeanAdvantage" | "pathStartLag"
    >,
): boolean => head.pathStartLag <= -4
    && head.transitionCount >= 4
    && head.gainOverDirect >= 8
    && head.headMeanAdvantage >= 0.02;

/**
 * At the newest boundary, the last unit step of a deep exact missing-ring staircase is
 * observationally aliased with a whole-series -1 lag. The staircase may exhaust that alias only
 * when it accounts for every accumulated lag level; endpoint proximity alone is not evidence.
 */
export const terminalCumulativeMissingExhaustsUnitWhole = (
    head: Pick<
        SequentialMissingHead,
        | "gainOverDirect"
        | "headMeanAdvantage"
        | "pathStartLag"
        | "transitionCount"
        | "year"
    >,
    wholeShiftYears: number | null,
    targetEndYear: number,
): boolean => wholeShiftYears === -1
    && head.year >= targetEndYear - 1
    && Math.abs(head.pathStartLag) === head.transitionCount
    && supportsCumulativeSequentialMissingStaircase(head);

/**
 * A local zero-year marker may anchor either a high-gain deep staircase or an exact
 * unit-depth staircase with a durable corrected tail. The latter recovers late serial
 * frontiers whose individual head contrast is weak after most other events are fixed.
 */
export const supportsMarkerAnchoredSequentialMissingStaircase = (
    head: Pick<
        SequentialMissingHead,
        | "gainOverDirect"
        | "transitionCount"
        | "headMeanAdvantage"
        | "fixedTailMeanAdvantage"
        | "pathStartLag"
    >,
    sharedZeroSupport: number,
): boolean => {
    if (sharedZeroSupport < 1) return false;
    const highGainDeepStaircase = head.pathStartLag <= -4
        && head.transitionCount >= 4
        && head.gainOverDirect >= 6
        && head.headMeanAdvantage >= 0.1;
    const durableExactStaircase = sharedZeroSupport >= 5
        && head.pathStartLag <= -3
        && head.transitionCount >= 3
        && Math.abs(head.pathStartLag) === head.transitionCount
        && head.fixedTailMeanAdvantage >= 0.33
        && (sharedZeroSupport >= 10 || head.gainOverDirect >= 1);
    const concentratedFourMarkerStaircase = sharedZeroSupport >= 4
        && head.pathStartLag <= -4
        && head.transitionCount >= 4
        && Math.abs(head.pathStartLag) === head.transitionCount
        && head.gainOverDirect >= 1.2
        && head.headMeanAdvantage >= 0.05
        && head.fixedTailMeanAdvantage >= 0.4;
    return highGainDeepStaircase
        || durableExactStaircase
        || concentratedFourMarkerStaircase;
};

/** A single opposite unit draft is often a local alias; two positive adjacent states are not. */
export const hasCoherentSequentialFalseStaircase = (
    events: readonly DiagnosisEvent[],
): boolean => {
    const positiveLevels = new Set(events.filter((event) => (
        event.eventType === "falseRing"
        && event.evidence.lagBefore !== null
        && event.evidence.lagAfter !== null
        && event.evidence.lagBefore > 0
        && event.evidence.lagAfter === event.evidence.lagBefore - 1
    )).map((event) => event.evidence.lagBefore as number));
    return [...positiveLevels].some((level) => positiveLevels.has(level - 1));
};

/** One remaining false ring is authoritative only when candidate and path evidence agree. */
export const hasCandidateBackedSequentialFalseDirection = (
    events: readonly DiagnosisEvent[],
): boolean => events.some((event) => (
    event.eventType === "falseRing"
    && event.evidence.lagBefore !== null
    && event.evidence.lagAfter !== null
    && event.evidence.lagBefore === event.evidence.lagAfter + 1
    && (
        (
            event.evidence.algorithmSources.includes("joint_event_counterfactual")
            && (
                event.evidence.notes.includes("counterfactual_candidate_support")
                || event.evidence.notes.includes("candidate_hard_gate_passed")
                || event.evidence.notes.includes(
                    "window_refinement=raw_path_candidate_consensus",
                )
            )
        )
        || (
            event.evidence.notes.includes("candidate_hard_gate_passed")
            && event.evidence.algorithmSources.includes("candidate_ranking")
            && event.evidence.algorithmSources.includes("local_edit_alignment")
        )
    )
));

const latestEventNoteNumber = (
    event: DiagnosisEvent,
    prefix: string,
): number | null => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const value = Number(note?.slice(prefix.length));
    return Number.isFinite(value) ? value : null;
};

/** Protects a complete whole-series operation, not a terminal lag alias. */
export const isAuthoritativeWholeSeriesCheckpoint = (
    event: DiagnosisEvent,
): boolean => {
    if (event.eventType !== "wholeSeriesMove"
        || !event.shiftYears
        || !event.evidence.notes.includes("candidate_hard_gate_passed")
        || event.evidence.score <= 0) return false;
    const terminalSegments = latestEventNoteNumber(
        event,
        "cofecha_terminal_segments=",
    ) ?? 0;
    const terminalConsistency = latestEventNoteNumber(
        event,
        "cofecha_terminal_consistency=",
    ) ?? 0;
    const terminalResidualLag = latestEventNoteNumber(
        event,
        "cofecha_terminal_residual_lag=",
    );
    const stateSupport = latestEventNoteNumber(
        event,
        "whole_state_support_fraction=",
    ) ?? 0;
    const newestLag = latestEventNoteNumber(
        event,
        "whole_state_newest_lag=",
    );
    const newerEdgeSupport = latestEventNoteNumber(
        event,
        "whole_state_newer_edge_support_fraction=",
    ) ?? 0;
    const globallyConsistent = event.evidence.notes.includes(
        "whole_state_global_lag_matches_shift=true",
    ) && terminalResidualLag === 0
        && stateSupport >= 0.5;
    // In a whole + local composition the local edit changes the older/global mode, while the
    // untouched newer edge still identifies the whole-series baseline exactly.
    const newerEdgeConsistent = newestLag === event.shiftYears
        && newerEdgeSupport >= 0.9
        && stateSupport >= 0.3
        && (event.evidence.correlationGain ?? 0) >= 0.1;
    return terminalSegments >= 2
        && terminalConsistency >= 0.9
        && (globallyConsistent || newerEdgeConsistent);
};

/** A validated fixed-side whole baseline owns the coordinate frame unless unit steps exhaust it. */
export const pathFixedWholeBaselinePreemptsLocalPath = (
    event: DiagnosisEvent,
    pathEvents: readonly DiagnosisEvent[],
): boolean => {
    const shiftYears = wholeSeriesMoveShiftYears(event);
    return shiftYears !== null
        && evidenceClaimsFor(event).has("whole_path_fixed_baseline")
        && !completeUnitTransitionChainExplainsWholeShift(pathEvents, shiftYears);
};

type CumulativePartialComponent = {
    event: DiagnosisEvent;
    operation: JointCounterfactualOperationScore;
    shiftYears: number;
};

const lagPathTransitionShift = (event: DiagnosisEvent): number | null => {
    const lagBefore = event.evidence.lagBefore;
    const lagAfter = event.evidence.lagAfter;
    if (lagBefore === null || lagAfter === null || lagBefore === lagAfter) return null;
    const shiftYears = lagBefore - lagAfter;
    if (event.eventType === "missingRing") return shiftYears === -1 ? shiftYears : null;
    if (event.eventType === "falseRing") return shiftYears === 1 ? shiftYears : null;
    if (event.eventType !== "partialMove"
        || event.shiftSide !== "older"
        || event.shiftYears !== shiftYears) return null;
    return isAutomaticPartialShift(shiftYears, {
        maxPartialGapYears: 100,
        lagMin: -100,
    }) ? shiftYears : null;
};

/**
 * Recovers the newest operation from an exact raw lag chain. The aggregate operation may score
 * best because it fixes the longest old segment, but it is not the next serial edit.
 */
type ExactLagPathTransition = {
    event: DiagnosisEvent;
    shiftYears: number;
    topYear: number;
};

const exactLagPathTransitions = (
    pathEvents: readonly DiagnosisEvent[],
    minimumTransitionScore: number,
): ExactLagPathTransition[] => pathEvents.flatMap((event) => {
    const shiftYears = lagPathTransitionShift(event);
    const topYear = event.rankedYears[0]?.year;
    return shiftYears !== null
        && topYear !== undefined
        && event.evidence.algorithmSources.some((source) => (
            source === "piecewise_lag_path"
            || source === "bounded_complete_lag_path"
        ))
        && event.evidence.score >= minimumTransitionScore
        ? [{ event, shiftYears, topYear }]
        : [];
}).sort((left, right) => left.topYear - right.topYear);

type ExactLagPathChain = {
    event: DiagnosisEvent;
    aggregateShiftYears: number;
    transitionCount: number;
};

type StableBoundedLagPathFrontier = {
    event: DiagnosisEvent;
    newestEvent: DiagnosisEvent;
    transitions: readonly ExactLagPathTransition[];
    aggregateShiftYears: number;
    suffixAggregateShiftYears: number[];
    transitionCount: number;
    allTransitionsPartial: boolean;
    baselineLag: number;
    maximumYearDrift: number;
    structuralSubset: boolean;
};

const withExactLagPathChain = (
    chain: ExactLagPathChain,
): ExactLagPathChain => ({
    ...chain,
    event: {
        ...chain.event,
        evidence: {
            ...chain.event.evidence,
            notes: Array.from(new Set([
                ...chain.event.evidence.notes,
                `exact_cumulative_path_transition_count=${chain.transitionCount}`,
                `exact_cumulative_path_aggregate_shift=${chain.aggregateShiftYears}`,
            ])),
        },
    },
});

const exactCumulativeLagPathChains = (
    transitions: readonly ExactLagPathTransition[],
    baselineLag: number,
    minimumSeparationYears: number,
    minimumTransitionCount: number,
): ExactLagPathChain[] => {
    const chains: ExactLagPathChain[] = [];
    for (let start = 0; start < transitions.length; start += 1) {
        let aggregateShiftYears = 0;
        for (let end = start; end < transitions.length; end += 1) {
            const current = transitions[end];
            const previous = end > start ? transitions[end - 1] : null;
            if (previous && (
                current.topYear - previous.topYear < minimumSeparationYears
                || previous.event.evidence.lagAfter !== current.event.evidence.lagBefore
            )) break;
            aggregateShiftYears += current.shiftYears;
            const transitionCount = end - start + 1;
            const oldestLag = transitions[start].event.evidence.lagBefore;
            if (transitionCount < minimumTransitionCount
                || oldestLag === null
                || current.event.evidence.lagAfter !== baselineLag
                || oldestLag - baselineLag !== aggregateShiftYears) continue;
            chains.push(withExactLagPathChain({
                event: current.event,
                aggregateShiftYears,
                transitionCount,
            }));
        }
    }
    return chains.sort((left, right) => (
        right.transitionCount - left.transitionCount
        || (right.event.rankedYears[0]?.year ?? Number.NEGATIVE_INFINITY)
            - (left.event.rankedYears[0]?.year ?? Number.NEGATIVE_INFINITY)
        || right.event.evidence.score - left.event.evidence.score
    ));
};

const transitionSequenceMatches = (
    left: readonly ExactLagPathTransition[],
    right: readonly ExactLagPathTransition[],
    maximumYearDrift: number,
): boolean => left.length === right.length && left.every((transition, index) => {
    const other = right[index];
    return other !== undefined
        && transition.event.eventType === other.event.eventType
        && transition.shiftYears === other.shiftYears
        && Math.abs(transition.topYear - other.topYear) <= maximumYearDrift;
});

const stableTransitionSequence = (
    regularized: readonly ExactLagPathTransition[],
    permissive: readonly ExactLagPathTransition[],
    maximumYearDrift: number,
): { transitions: readonly ExactLagPathTransition[]; structuralSubset: boolean } | null => {
    if (transitionSequenceMatches(regularized, permissive, maximumYearDrift)) {
        return { transitions: regularized, structuralSubset: false };
    }
    if (regularized.length < 2
        || permissive.length <= regularized.length
        || !regularized.every(({ event }) => event.eventType === "partialMove")) return null;

    let regularizedIndex = 0;
    const unmatched: ExactLagPathTransition[] = [];
    permissive.forEach((transition) => {
        const expected = regularized[regularizedIndex];
        if (expected
            && transition.event.eventType === expected.event.eventType
            && transition.shiftYears === expected.shiftYears
            && Math.abs(transition.topYear - expected.topYear) <= maximumYearDrift) {
            regularizedIndex += 1;
        } else {
            unmatched.push(transition);
        }
    });
    const reversibleUnitExcursion = regularizedIndex === regularized.length
        && unmatched.length >= 2
        && unmatched.every(({ event, shiftYears }) => (
            (event.eventType === "missingRing" || event.eventType === "falseRing")
            && Math.abs(shiftYears) === 1
        ))
        && unmatched.reduce((sum, transition) => sum + transition.shiftYears, 0) === 0;
    return reversibleUnitExcursion
        ? { transitions: regularized, structuralSubset: true }
        : null;
};

const exactCompleteTransitionChain = (
    path: BoundedLagStateEventSet,
    baselineLag: number,
    minimumSeparationYears: number,
): ExactLagPathTransition[] | null => {
    const transitions = exactLagPathTransitions(
        path.events,
        Number.NEGATIVE_INFINITY,
    );
    if (transitions.length < 2) return null;
    for (let index = 1; index < transitions.length; index += 1) {
        const older = transitions[index - 1];
        const newer = transitions[index];
        if (newer.topYear - older.topYear < minimumSeparationYears
            || older.event.evidence.lagAfter !== newer.event.evidence.lagBefore) {
            return null;
        }
    }
    const oldestLag = transitions[0].event.evidence.lagBefore;
    const newestLag = transitions[transitions.length - 1].event.evidence.lagAfter;
    const aggregateShiftYears = transitions.reduce(
        (sum, transition) => sum + transition.shiftYears,
        0,
    );
    return oldestLag !== null
        && newestLag === baselineLag
        && oldestLag - baselineLag === aggregateShiftYears
        ? transitions
        : null;
};

const stableTransitionLocationPriority = (
    transition: ExactLagPathTransition,
): number => {
    const location = transition.event.evidence.locationEvidence
        ?.find((row) => row.source === "bounded_complete_lag_path")
        ?? transition.event.evidence.locationEvidence?.[0];
    return Math.max(0, location?.concentration ?? 0)
        * Math.max(0, location?.remoteMargin ?? 0);
};

const selectStableUnitTransition = (
    transitions: readonly ExactLagPathTransition[],
): ExactLagPathTransition => {
    const newest = transitions[transitions.length - 1]!;
    if (newest.event.eventType !== "missingRing"
        && newest.event.eventType !== "falseRing") return newest;
    // The complete path is ordered pith-to-bark and already agrees across two penalties. Location
    // sharpness may rank years inside one transition, but it must not replace the executable
    // bark-side frontier with an older member of the same event chain.
    return newest;
};

const selectStableStructuralPartialTransition = (
    transitions: readonly ExactLagPathTransition[],
): ExactLagPathTransition => [...transitions].sort((left, right) => (
    stableTransitionLocationPriority(right) - stableTransitionLocationPriority(left)
    || right.topYear - left.topYear
))[0]!;

const unobservedFixedSideWholeLag = (
    path: BoundedLagStateEventSet,
    minimumObservedPairs: number,
): { lag: number; boundaryYear: number } | null => {
    const terminal = path.path.runs[path.path.runs.length - 1];
    const observed = path.path.runs[path.path.runs.length - 2];
    if (!terminal
        || !observed
        || terminal.lag !== 0
        || terminal.samplePairs !== 0
        || observed.lag === 0
        || observed.samplePairs < minimumObservedPairs
        || path.path.transitionGain < 8) return null;
    const matchingTransition = path.events.some((event) => (
        event.eventType === "partialMove"
        && event.shiftYears === observed.lag
        && event.evidence.lagBefore === observed.lag
        && event.evidence.lagAfter === 0
    ));
    return matchingTransition ? {
        lag: observed.lag,
        boundaryYear: observed.endYear + 1,
    } : null;
};

/**
 * Converts an unobservable bark-side zero state into the whole baseline supported by all
 * observed years. Two regularizations and an independent whole candidate must agree.
 */
export const selectUnobservedFixedSideWholeLag = (
    penaltyOnePath: BoundedLagStateEventSet | null,
    penaltyHalfPath: BoundedLagStateEventSet | null,
    candidateWholeLags: ReadonlySet<number>,
    minimumObservedPairs = 30,
    maximumBoundaryDrift = 2,
): number | null => {
    if (!penaltyOnePath || !penaltyHalfPath) return null;
    const stronger = unobservedFixedSideWholeLag(
        penaltyOnePath,
        minimumObservedPairs,
    );
    const weaker = unobservedFixedSideWholeLag(
        penaltyHalfPath,
        minimumObservedPairs,
    );
    return stronger
        && weaker
        && stronger.lag === weaker.lag
        && Math.abs(stronger.boundaryYear - weaker.boundaryYear) <= maximumBoundaryDrift
        && candidateWholeLags.has(stronger.lag)
        ? stronger.lag
        : null;
};

/**
 * A distant multi-event decomposition is authoritative only when two independently regularized
 * complete paths agree on every operation and changepoint. This prevents a long corrected older
 * segment from collapsing several real edits into one aggregate partial move.
 */
export const selectStableBoundedLagPathFrontier = (
    penaltyOnePath: BoundedLagStateEventSet | null,
    penaltyHalfPath: BoundedLagStateEventSet | null,
    baselineLag = 0,
    minimumSeparationYears = 14,
    maximumYearDrift = 2,
    penaltyLabel = "1,0.5",
): StableBoundedLagPathFrontier | null => {
    if (!penaltyOnePath || !penaltyHalfPath) return null;
    if (!boundedLagPathHasObservedFixedSide(penaltyOnePath)
        || !boundedLagPathHasObservedFixedSide(penaltyHalfPath)) return null;
    const penaltyOneTransitions = exactCompleteTransitionChain(
        penaltyOnePath,
        baselineLag,
        minimumSeparationYears,
    );
    const penaltyHalfTransitions = exactCompleteTransitionChain(
        penaltyHalfPath,
        baselineLag,
        minimumSeparationYears,
    );
    if (!penaltyOneTransitions || !penaltyHalfTransitions) return null;
    const stableSequence = stableTransitionSequence(
        penaltyOneTransitions,
        penaltyHalfTransitions,
        maximumYearDrift,
    );
    if (!stableSequence) return null;
    const stableTransitions = stableSequence.transitions;
    const newest = stableTransitions[stableTransitions.length - 1];
    const selectedTransition = stableSequence.structuralSubset
        ? selectStableStructuralPartialTransition(stableTransitions)
        : selectStableUnitTransition(stableTransitions);
    const aggregateShiftYears = stableTransitions.reduce(
        (sum, transition) => sum + transition.shiftYears,
        0,
    );
    let suffixShift = 0;
    const suffixAggregateShiftYears = [...stableTransitions]
        .reverse()
        .map((transition) => {
            suffixShift += transition.shiftYears;
            return suffixShift;
        });
    return {
        event: {
            ...selectedTransition.event,
            evidence: {
                ...selectedTransition.event.evidence,
                algorithmSources: Array.from(new Set([
                    ...selectedTransition.event.evidence.algorithmSources,
                    "stable_multiscale_bounded_path_frontier",
                ])).sort(),
                notes: Array.from(new Set([
                    ...selectedTransition.event.evidence.notes,
                    `stable_bounded_path_transition_count=${penaltyOneTransitions.length}`,
                    `stable_bounded_path_aggregate_shift=${aggregateShiftYears}`,
                    `stable_bounded_path_all_transitions_partial=${
                        stableTransitions.every(({ event }) => (
                            event.eventType === "partialMove"
                        ))
                    }`,
                    `stable_bounded_path_suffix_shifts=${
                        suffixAggregateShiftYears.join(",")
                    }`,
                    `stable_bounded_path_baseline_lag=${baselineLag}`,
                    `stable_bounded_path_penalties=${penaltyLabel}`,
                    `stable_bounded_path_maximum_year_drift=${maximumYearDrift}`,
                    `stable_bounded_path_newest_year=${newest.topYear}`,
                    `stable_bounded_path_selected_year=${selectedTransition.topYear}`,
                    `stable_bounded_path_selected_location_priority=${
                        stableTransitionLocationPriority(selectedTransition).toFixed(6)
                    }`,
                    `stable_bounded_path_structural_subset=${stableSequence.structuralSubset}`,
                ])),
            },
        },
        newestEvent: newest.event,
        transitions: stableTransitions,
        aggregateShiftYears,
        suffixAggregateShiftYears,
        transitionCount: stableTransitions.length,
        allTransitionsPartial: stableTransitions.every(({ event }) => (
            event.eventType === "partialMove"
        )),
        baselineLag,
        maximumYearDrift,
        structuralSubset: stableSequence.structuralSubset,
    };
};

/**
 * Keeps a regularized direct partial when a permissive path only decomposes that same state
 * change and the independently scored operation supports the aggregate amplitude. This is a
 * model-complexity decision; it does not merge unrelated transitions or invent a new location.
 */
export const selectOperationAnchoredRegularizedAggregatePartialFrontier = (
    regularizedPath: BoundedLagStateEventSet | null,
    permissivePath: BoundedLagStateEventSet | null,
    operation: JointCounterfactualOperationScore | null,
    baselineLag = 0,
    maximumAmplitudeDrift = 1,
): StableBoundedLagPathFrontier | null => {
    if (!regularizedPath || !permissivePath || operation?.eventType !== "partialMove") {
        return null;
    }
    const regularized = exactCompleteTransitionChain(regularizedPath, baselineLag, 14);
    const permissive = exactCompleteTransitionChain(permissivePath, baselineLag, 14);
    const direct = regularized?.[regularized.length - 1];
    if (!regularized || !permissive || !direct
        || direct.event.eventType !== "partialMove"
        || Math.abs(direct.shiftYears - operation.shiftYears) > maximumAmplitudeDrift) {
        return null;
    }
    const firstIndex = permissive.findIndex((transition) => (
        transition.event.eventType === "partialMove"
        && transition.event.evidence.lagBefore === direct.event.evidence.lagBefore
        && Math.abs(transition.topYear - direct.topYear) <= 2
        && Math.sign(transition.shiftYears) === Math.sign(direct.shiftYears)
    ));
    if (firstIndex < 0) return null;
    let aggregateShiftYears = 0;
    let previousLagAfter = direct.event.evidence.lagBefore;
    let decomposedCount = 0;
    for (let index = firstIndex; index < permissive.length; index += 1) {
        const transition = permissive[index];
        if (transition.event.eventType !== "partialMove"
            || transition.event.evidence.lagBefore !== previousLagAfter
            || Math.sign(transition.shiftYears) !== Math.sign(direct.shiftYears)) break;
        aggregateShiftYears += transition.shiftYears;
        previousLagAfter = transition.event.evidence.lagAfter;
        decomposedCount += 1;
        if (previousLagAfter !== direct.event.evidence.lagAfter) continue;
        if (decomposedCount < 2 || aggregateShiftYears !== direct.shiftYears) return null;
        const stable = selectStableBoundedLagPathFrontier(
            regularizedPath,
            regularizedPath,
            baselineLag,
        );
        if (!stable || stable.event.id !== direct.event.id) return null;
        const event = {
            ...stable.event,
            evidence: {
                ...stable.event.evidence,
                algorithmSources: Array.from(new Set([
                    ...stable.event.evidence.algorithmSources,
                    "operation_anchored_regularized_aggregate",
                ])).sort(),
                notes: Array.from(new Set([
                    ...stable.event.evidence.notes,
                    "stable_bounded_path_preserved_regularized_aggregate=true",
                    `regularized_aggregate_shift=${direct.shiftYears}`,
                    `regularized_aggregate_operation_shift=${operation.shiftYears}`,
                    `regularized_aggregate_decomposed_count=${decomposedCount}`,
                ])),
            },
        };
        return { ...stable, event, newestEvent: event };
    }
    return null;
};

export const calibratedTerminalUnitStaircaseWindowWidth = (
    frontier: StableTerminalUnitStaircaseFrontier,
): 9 | 13 => {
    const pathLocation = frontier.representative.evidence.locationEvidence?.find((entry) => (
        entry.source === "bounded_complete_lag_path"
    ));
    const runnerUpMarginNote = frontier.representative.evidence.notes.find((note) => (
        note.startsWith("bounded_path_runner_up_margin=")
    ));
    const runnerUpMargin = Number(runnerUpMarginNote?.split("=")[1]);
    const diffuseTwoStep = frontier.eventCount === 2
        && typeof pathLocation?.concentration === "number"
        && pathLocation.concentration < 0.7;
    const deepWeaklySeparatedMode = frontier.eventCount >= 4
        && typeof pathLocation?.concentration === "number"
        && pathLocation.concentration > 0.95
        && Number.isFinite(runnerUpMargin)
        && runnerUpMargin < 1.2;
    return diffuseTwoStep || deepWeaklySeparatedMode ? 13 : 9;
};

const projectStableTerminalSequentialUnit = (
    frontier: StableTerminalUnitStaircaseFrontier,
    diagnosis: SeriesCoreDiagnosis,
    candidates: readonly DiagnosisCandidateOperation[],
): DiagnosisEvent => {
    const presentationYear = frontier.boundaryYear;
    const eventType = frontier.aggregateShiftYears > 0 ? "falseRing" : "missingRing";
    const directionSource = frontier.aggregateShiftYears > 0
        ? "positive_unit_staircase_direction"
        : "negative_unit_staircase_direction";
    const candidateSource = frontier.aggregateShiftYears > 0
        ? "candidate_anchored_positive_staircase"
        : "candidate_anchored_negative_staircase";
    const windowWidth = calibratedTerminalUnitStaircaseWindowWidth(frontier);
    const window = boundedSequentialWindow(
        presentationYear,
        windowWidth,
        diagnosis.targetRange,
    );
    const baseScore = Math.min(
        frontier.strongerTransitionGain,
        frontier.weakerTransitionGain,
    );
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return {
                year,
                score: baseScore - Math.abs(year - presentationYear) * 0.01,
                evidenceTags: [
                    "stable_terminal_unit_staircase_frontier",
                    directionSource,
                ],
            };
        },
    ).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    const matchingCandidateIds = candidates.filter((candidate) => {
        const shift = candidate.deltaYears ?? candidate.suggestedLag;
        return candidate.targetTree === diagnosis.targetTree
            && candidate.operationType === "SHIFT_RANGE"
            && shift === frontier.aggregateShiftYears;
    }).map((candidate) => candidate.id);
    return {
        ...frontier.representative,
        id: `diagnosis-event-${diagnosis.targetTree}-terminal-sequential-${eventType}-${
            window.startYear
        }-${window.endYear}`,
        seriesId: diagnosis.targetTree,
        eventType,
        ...window,
        reviewCoreRange: undefined,
        rankedYears,
        confidenceLevel: "medium",
        evidence: {
            ...frontier.representative.evidence,
            algorithmSources: Array.from(new Set([
                ...frontier.representative.evidence.algorithmSources,
                candidateSource,
                directionSource,
                "stable_terminal_unit_staircase_frontier",
            ])).sort(),
            score: baseScore,
            scoreMargin: Math.min(
                frontier.representative.evidence.scoreMargin,
                baseScore,
            ),
            lagBefore: Math.sign(frontier.aggregateShiftYears),
            lagAfter: 0,
            candidateIds: Array.from(new Set([
                ...frontier.representative.evidence.candidateIds,
                ...matchingCandidateIds,
            ])),
            notes: Array.from(new Set([
                ...frontier.representative.evidence.notes,
                `terminal_unit_staircase_depth=${frontier.eventCount}`,
                `terminal_unit_staircase_aggregate_shift=${
                    frontier.aggregateShiftYears
                }`,
                `terminal_unit_staircase_boundary_year=${presentationYear}`,
                `terminal_unit_staircase_max_adjacent_gap_years=${
                    frontier.maximumAdjacentTransitionGapYears
                }`,
                `terminal_unit_staircase_maximum_year_drift=${
                    frontier.maximumYearDrift
                }`,
                `terminal_unit_staircase_stronger_gain=${
                    frontier.strongerTransitionGain.toFixed(6)
                }`,
                `terminal_unit_staircase_weaker_gain=${
                    frontier.weakerTransitionGain.toFixed(6)
                }`,
                `terminal_unit_staircase_window_width=${windowWidth}`,
                `terminal_unit_staircase_window_rule=${
                    windowWidth === 13
                        ? frontier.eventCount === 2
                            ? "two_step_low_location_concentration"
                            : "deep_staircase_weak_mode_separation"
                        : "stable_default_9"
                }`,
                "terminal_unit_staircase_fixed_tail_lag=0",
                "terminal_unit_staircase_outputs_newest_event_only",
            ])),
        },
        alternativeTypes: [],
        locationAlternatives: undefined,
        operationAlternatives: undefined,
        seriesRange: { ...diagnosis.targetRange },
    };
};

const stableFrontierCandidateAnchorDistance = (
    frontier: StableBoundedLagPathFrontier,
    candidates: readonly DiagnosisEvent[],
): number | null => {
    const newest = frontier.newestEvent;
    const newestYear = newest.rankedYears[0]?.year;
    const distances = candidates.flatMap((candidate) => {
        if (candidate.evidence.candidateIds.length === 0
            || candidate.eventType !== newest.eventType
            || (candidate.eventType === "partialMove"
                && candidate.shiftYears !== newest.shiftYears)) return [];
        if (candidate.startYear <= newest.endYear && candidate.endYear >= newest.startYear) {
            return [0];
        }
        const candidateYear = candidate.rankedYears[0]?.year;
        return newestYear !== undefined && candidateYear !== undefined
            ? [Math.abs(candidateYear - newestYear)]
            : [];
    });
    const distance = distances.length > 0 ? Math.min(...distances) : null;
    return distance !== null && distance <= 8 ? distance : null;
};

/**
 * A sixth path segment is extra model complexity. It may recover a real newest transition, but it
 * may also fit an unsupported old-side lag and change an otherwise stable frontier. Only let the
 * extended path win when its newest transition has a closer independent candidate anchor.
 */
export const selectCandidateAnchoredStableBoundedLagPathFrontier = (
    parsimonious: StableBoundedLagPathFrontier | null,
    extended: StableBoundedLagPathFrontier | null,
    candidates: readonly DiagnosisEvent[],
): StableBoundedLagPathFrontier | null => {
    if (!parsimonious) return extended;
    if (!extended) return parsimonious;
    const parsimoniousDistance = stableFrontierCandidateAnchorDistance(
        parsimonious,
        candidates,
    );
    const extendedDistance = stableFrontierCandidateAnchorDistance(extended, candidates);
    if (extendedDistance === null
        || (parsimoniousDistance !== null && parsimoniousDistance <= extendedDistance)) {
        return parsimonious;
    }
    return extended;
};

/**
 * A permissive penalty can split one real partial transition into a short reversible excursion.
 * When the regularized path contains exactly two distant partial transitions whose sum is also
 * independently proposed as an aggregate move, recover the newest component instead of letting
 * the aggregate proposal erase both locations.
 */
export const selectAggregateAnchoredRegularizedPartialFrontier = (
    regularizedPath: BoundedLagStateEventSet | null,
    candidates: readonly DiagnosisEvent[],
    baselineLag = 0,
): StableBoundedLagPathFrontier | null => {
    if (!regularizedPath || regularizedPath.path.transitionGain < 12) return null;
    const frontier = selectStableBoundedLagPathFrontier(
        regularizedPath,
        regularizedPath,
        baselineLag,
    );
    if (!frontier
        || frontier.transitionCount !== 2
        || !frontier.allTransitionsPartial
        || frontier.transitions.some(({ shiftYears }) => shiftYears > -2)) return null;
    const aggregateAnchor = candidates.some((candidate) => (
        candidate.eventType === "partialMove"
        && candidate.shiftYears === frontier.aggregateShiftYears
        && candidate.evidence.candidateIds.length > 0
    ));
    return aggregateAnchor ? frontier : null;
};

export const selectStableUnitPathLocationCheckpoints = (
    regularizedPath: BoundedLagStateEventSet | null,
    permissivePath: BoundedLagStateEventSet | null,
    maximumYearDrift = 2,
): DiagnosisEvent[] => {
    if (!regularizedPath || !permissivePath) return [];
    const eligible = (event: DiagnosisEvent): boolean => {
        if (event.eventType !== "missingRing" && event.eventType !== "falseRing") return false;
        // Unit-boundary scores assume the proposed edit returns the target to the
        // zero-lag baseline. Intermediate cumulative transitions need a scorer
        // conditioned on their non-zero baseline and cannot anchor later layers.
        if (event.evidence.lagAfter !== 0) return false;
        const location = event.evidence.locationEvidence?.find(
            (row) => row.source === "bounded_complete_lag_path",
        );
        return (location?.concentration ?? 0) >= 0.5
            && (location?.remoteMargin ?? 0) >= 1;
    };
    return regularizedPath.events.filter((event) => {
        if (!eligible(event)) return false;
        const year = event.rankedYears[0]?.year;
        return year !== undefined && permissivePath.events.some((other) => (
            eligible(other)
            && other.eventType === event.eventType
            && other.evidence.lagBefore === event.evidence.lagBefore
            && other.evidence.lagAfter === event.evidence.lagAfter
            && other.rankedYears[0]?.year !== undefined
            && Math.abs(other.rankedYears[0].year - year) <= maximumYearDrift
        ));
    });
};

/** Pairwise cold starts keep bounded paths as evidence until an absolute anchor is restored. */
export const allowStableBoundedPathFinalAuthority = (
    preferRemotePairedMissingFrontier = false,
): boolean => !preferRemotePairedMissingFrontier;

export const recoverStableBoundedLagPathFrontier = (
    frontier: StableBoundedLagPathFrontier | null,
    displayed: readonly DiagnosisEvent[],
    operations: readonly JointCounterfactualOperationScore[] = [],
    targetRange?: { startYear: number; endYear: number },
    candidateEvents: readonly DiagnosisEvent[] = [],
): DiagnosisEvent | null => {
    if (!frontier) return null;
    const frontierSelectedYear = frontier.event.rankedYears[0]?.year;
    const newestYear = frontier.newestEvent.rankedYears[0]?.year;
    const latestHasIndependentLocation = frontierSelectedYear !== newestYear
        && newestYear !== undefined
        && displayed.some((event) => (
            event.eventType === frontier.newestEvent.eventType
            && (event.eventType !== "partialMove"
                || event.shiftYears === frontier.newestEvent.shiftYears)
            && event.startYear <= frontier.newestEvent.endYear
            && event.endYear >= frontier.newestEvent.startYear
            && (
                event.evidence.candidateIds.length > 0
                || event.evidence.algorithmSources.some((source) => (
                    source === "candidate_ranking"
                    || source === "cofecha_segment_lag"
                    || source === "local_edit_alignment"
                    || source === "counterfactual_window_refinement"
                ))
            )
        ));
    const frontierEvent = latestHasIndependentLocation
        ? frontier.newestEvent
        : frontier.event;
    const pathComponentShift = lagPathTransitionShift(frontierEvent);
    const componentYear = frontierEvent.rankedYears[0]?.year;
    if (pathComponentShift === null || componentYear === undefined) return null;
    const selectedTransitionIndex = frontier.transitions.findIndex((transition) => (
        transition.topYear === componentYear
        && transition.shiftYears === pathComponentShift
    ));
    const structuralCalibration = frontier.structuralSubset
        && frontier.allTransitionsPartial
        && frontier.transitionCount === 2
        && selectedTransitionIndex >= 0
        ? candidateEvents.flatMap((candidate) => {
                if (candidate.eventType !== "partialMove"
                    || candidate.shiftYears === undefined
                    || candidate.shiftYears === frontier.aggregateShiftYears
                    || !candidate.evidence.algorithmSources.includes("cofecha_segment_lag")) {
                    return [];
                }
                const candidateYear = candidate.rankedYears[0]?.year;
                if (candidateYear === undefined) return [];
                const matchedTransitionIndex = frontier.transitions
                    .map((transition, index) => ({
                        index,
                        shiftDistance: Math.abs(
                            transition.shiftYears - candidate.shiftYears!,
                        ),
                        yearDistance: Math.abs(transition.topYear - candidateYear),
                    }))
                    .filter((row) => row.shiftDistance <= 2 && row.yearDistance <= 35)
                    .sort((left, right) => (
                        left.shiftDistance - right.shiftDistance
                        || left.yearDistance - right.yearDistance
                    ))[0];
                if (!matchedTransitionIndex) return [];
                const calibratedShift = matchedTransitionIndex.index === selectedTransitionIndex
                    ? candidate.shiftYears
                    : frontier.aggregateShiftYears - candidate.shiftYears;
                return isAutomaticPartialShift(calibratedShift, {
                    maxPartialGapYears: 100,
                    lagMin: -100,
                }) ? [{
                        candidate,
                        calibratedShift,
                        matchedTransitionIndex: matchedTransitionIndex.index,
                        shiftDistance: matchedTransitionIndex.shiftDistance,
                        yearDistance: matchedTransitionIndex.yearDistance,
                    }] : [];
            }).sort((left, right) => (
                left.shiftDistance - right.shiftDistance
                || left.yearDistance - right.yearDistance
            ))[0] ?? null
        : null;
    const componentShift = structuralCalibration?.calibratedShift ?? pathComponentShift;
    const componentHypotheses = [...displayed, ...candidateEvents];
    const matchingDisplayedComponent = componentHypotheses.find((event) => (
        event.eventType === frontierEvent.eventType
        && event.shiftYears === componentShift
    ));
    const matchingDisplayedAggregate = displayed.find((event) => (
        event.eventType === "partialMove"
        && event.shiftYears !== undefined
        && frontier.suffixAggregateShiftYears.includes(event.shiftYears)
    ));
    const matchingDisplayedWholeComponent = displayed.find((event) => (
        event.eventType === "wholeSeriesMove"
        && event.shiftYears === componentShift
        && frontier.transitionCount >= 2
    ));
    const matchingDisplayedWholeAggregate = displayed.find((event) => (
        event.eventType === "wholeSeriesMove"
        && event.shiftYears !== undefined
        && frontier.allTransitionsPartial
        && frontier.transitionCount >= 2
        && Math.abs(event.shiftYears - frontier.aggregateShiftYears) <= 1
    ));
    const matchingOperation = operations.find((operation) => (
        operation.eventType === frontierEvent.eventType
        && operation.shiftYears === componentShift
    ));
    const matchingAggregateOperation = operations.find((operation) => (
        operation.eventType === "partialMove"
        && operation.shiftYears === frontier.aggregateShiftYears
    ));
    const operationSupported = (
        operation: JointCounterfactualOperationScore | undefined,
    ): operation is JointCounterfactualOperationScore => operation !== undefined
        && scoreDynamicJointOperation(operation, operations) >= 0.02
        && operation.bestDifferenceGain >= 0.02
        && operation.bestCombinedGain >= 0.015
        && operation.topThreeDifferenceGain >= 0.02;
    const partialOperationSupported = operationSupported(matchingOperation);
    const aggregateOperationSupported = operationSupported(matchingAggregateOperation);
    const selectedUnitOpposesAggregate = frontier.aggregateShiftYears !== 0
        && (frontierEvent.eventType === "missingRing"
            || frontierEvent.eventType === "falseRing")
        && Math.sign(componentShift) !== Math.sign(frontier.aggregateShiftYears);
    const independentlySupportedSelectedUnit = partialOperationSupported
        || componentHypotheses.some((event) => (
            event.eventType === frontierEvent.eventType
            && lagPathTransitionShift(event) === componentShift
            && Math.abs(rankedEventYear(event) - componentYear) <= 6
            && hasIndependentUnitSpecificAnchor(event)
        ));
    // A complete path may use a short opposite-sign excursion to fit residual noise. Such a
    // component needs independent operation evidence before it can become the product answer.
    if (selectedUnitOpposesAggregate && !independentlySupportedSelectedUnit) return null;
    const componentOperationScore = matchingOperation
        ? scoreDynamicJointOperation(matchingOperation, operations)
        : Number.NEGATIVE_INFINITY;
    const aggregateOperationScore = matchingAggregateOperation
        ? scoreDynamicJointOperation(matchingAggregateOperation, operations)
        : Number.NEGATIVE_INFINITY;
    const aggregateBoundaryDistance = matchingAggregateOperation?.sideStepBestYear === null
        || matchingAggregateOperation?.sideStepBestYear === undefined
        ? Number.POSITIVE_INFINITY
        : Math.abs(
            matchingAggregateOperation.bestYear
            - matchingAggregateOperation.sideStepBestYear,
        );
    const componentBoundaryDistance = matchingOperation?.sideStepBestYear === null
        || matchingOperation?.sideStepBestYear === undefined
        ? Number.POSITIVE_INFINITY
        : Math.abs(matchingOperation.bestYear - matchingOperation.sideStepBestYear);
    const exactDisplayedAggregate = displayed.find((event) => (
        event.eventType === "partialMove"
        && event.shiftYears === frontier.aggregateShiftYears
    ));
    const aggregateOperationDominates = structuralCalibration === null
        && frontier.allTransitionsPartial
        && exactDisplayedAggregate !== undefined
        && aggregateOperationSupported
        && aggregateBoundaryDistance <= 2
        && matchingAggregateOperation.bestDifferenceGain >= 0.5
        && matchingAggregateOperation.bestCombinedGain >= 0.5
        && aggregateOperationScore >= componentOperationScore + 0.08
        && matchingAggregateOperation.bestDifferenceGain
            >= (matchingOperation?.bestDifferenceGain ?? 0) + 0.05
        && componentBoundaryDistance > 12;
    if (frontierEvent.eventType === "partialMove"
        && !matchingDisplayedComponent
        && !matchingDisplayedAggregate
        && !matchingDisplayedWholeComponent
        && !matchingDisplayedWholeAggregate
        && !partialOperationSupported
        && structuralCalibration === null) return null;
    const selectedPathEvent = aggregateOperationDominates
        ? exactDisplayedAggregate
        : frontierEvent;
    const selectedShift = aggregateOperationDominates
        ? frontier.aggregateShiftYears
        : componentShift;
    const selectedOperation = aggregateOperationDominates
        ? matchingAggregateOperation
        : matchingOperation;
    const selectedYear = aggregateOperationDominates
        ? matchingAggregateOperation.bestYear
        : componentYear;
    const operationYear = operationSupported(selectedOperation)
        ? selectedOperation.bestYear
        : null;
    const operationPathDistance = operationYear === null
        ? null
        : Math.abs(operationYear - selectedYear);
    const calibratedCenter = selectedPathEvent.eventType === "partialMove"
        ? operationPathDistance !== null
            && operationPathDistance >= 2
            && operationPathDistance <= 12
            ? Math.round((operationYear! + selectedYear) / 2)
            : selectedYear + (selectedShift <= -10 ? 1 : 0)
        : operationPathDistance !== null
            && operationPathDistance >= 2
            && operationPathDistance <= 10
            ? Math.round((operationYear! + selectedYear) / 2)
            : selectedYear;
    const width = 13;
    let calibratedStart = calibratedCenter - Math.floor(width / 2);
    let calibratedEnd = calibratedStart + width - 1;
    if (targetRange) {
        if (calibratedStart < targetRange.startYear) {
            calibratedStart = targetRange.startYear;
            calibratedEnd = calibratedStart + width - 1;
        }
        if (calibratedEnd > targetRange.endYear) {
            calibratedEnd = targetRange.endYear;
            calibratedStart = calibratedEnd - width + 1;
        }
    }
    const preferredTop = operationYear !== null
        && operationYear >= calibratedStart
        && operationYear <= calibratedEnd
        ? operationYear
        : selectedYear;
    const existingYears = new Map(selectedPathEvent.rankedYears.map((row) => [row.year, row]));
    const maximumScore = Math.max(0, ...selectedPathEvent.rankedYears.map((row) => row.score));
    const calibratedRankedYears = Array.from(
        { length: calibratedEnd - calibratedStart + 1 },
        (_, offset) => calibratedStart + offset,
    ).map((year) => {
        const existing = existingYears.get(year);
        return {
            year,
            score: year === preferredTop
                ? maximumScore + Math.max(1e-9, Math.abs(maximumScore) * 1e-12)
                : existing?.score ?? 0,
            rank: 0,
            evidenceTags: Array.from(new Set([
                ...(existing?.evidenceTags ?? []),
                "stable_multiscale_bounded_path_frontier",
                ...(year === operationYear ? ["joint_operation_location"] : []),
            ])),
        };
    }).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    const authority = structuralCalibration?.candidate
        ?? matchingDisplayedAggregate
        ?? matchingDisplayedWholeComponent
        ?? displayed.find((event) => event.eventType === "wholeSeriesMove")
        ?? null;
    return {
        ...selectedPathEvent,
        id: `${selectedPathEvent.id}-stable-multiscale-frontier`,
        startYear: calibratedStart,
        endYear: calibratedEnd,
        rankedYears: calibratedRankedYears,
        confidenceLevel: selectedPathEvent.confidenceLevel === "low"
            ? "medium"
            : selectedPathEvent.confidenceLevel,
        alternativeTypes: [],
        ...(selectedPathEvent.eventType === "partialMove" ? {
            shiftYears: selectedShift,
            shiftSide: "older" as const,
        } : {}),
        locationAlternatives: undefined,
        operationAlternatives: undefined,
        evidence: {
            ...selectedPathEvent.evidence,
            algorithmSources: Array.from(new Set([
                ...selectedPathEvent.evidence.algorithmSources,
                ...frontierEvent.evidence.algorithmSources,
            ])).sort(),
            correlationGain: Math.max(
                selectedPathEvent.evidence.correlationGain ?? 0,
                authority?.evidence.correlationGain ?? 0,
            ),
            lagBefore: selectedShift,
            lagAfter: 0,
            candidateIds: Array.from(new Set([
                ...selectedPathEvent.evidence.candidateIds,
                ...frontierEvent.evidence.candidateIds,
                ...(authority?.evidence.candidateIds ?? []),
            ])),
            notes: Array.from(new Set([
                ...selectedPathEvent.evidence.notes,
                ...frontierEvent.evidence.notes,
                `stable_bounded_path_component_shift=${componentShift}`,
                `stable_bounded_path_component_lag_before=${
                    frontierEvent.evidence.lagBefore
                }`,
                `stable_bounded_path_component_lag_after=${
                    frontierEvent.evidence.lagAfter
                }`,
                ...(structuralCalibration ? [
                    `stable_bounded_path_raw_component_shift=${pathComponentShift}`,
                    `stable_bounded_path_component_calibrated_from_cofecha=${
                        structuralCalibration.candidate.shiftYears
                    }`,
                    `stable_bounded_path_component_calibrated_shift=${componentShift}`,
                ] : []),
                `stable_bounded_path_component_year=${componentYear}`,
                ...(latestHasIndependentLocation ? [
                    `stable_bounded_path_preserved_candidate_backed_newest=${newestYear}`,
                ] : []),
                ...(aggregateOperationDominates ? [
                    `stable_bounded_path_preserved_dominant_aggregate=${
                        frontier.aggregateShiftYears
                    }`,
                    `stable_bounded_path_aggregate_operation_margin=${
                        (aggregateOperationScore - componentOperationScore).toFixed(6)
                    }`,
                    `stable_bounded_path_aggregate_boundary_distance=${
                        aggregateBoundaryDistance
                    }`,
                    `stable_bounded_path_component_boundary_distance=${
                        componentBoundaryDistance
                    }`,
                ] : []),
                ...(matchingDisplayedWholeAggregate ? [
                    `stable_bounded_path_replaced_whole_alias=${
                        matchingDisplayedWholeAggregate.shiftYears
                    }`,
                ] : []),
                `stable_bounded_path_calibrated_center=${calibratedCenter}`,
                `stable_bounded_path_preferred_year=${preferredTop}`,
                ...(operationYear === null ? [] : [
                    `stable_bounded_path_operation_year=${operationYear}`,
                ]),
                ...(selectedPathEvent.eventType === "partialMove"
                    ? [`counterfactual_correction_years=${selectedShift}`]
                    : []),
            ])),
        },
    };
};

/**
 * A multi-transition path may miss a newer terminal unit step or compress several unresolved
 * steps into one partial move. A separately localized terminal step is the executable bark-side
 * frontier; the remaining cumulative state is reconsidered after it is applied.
 */
export const selectDirectTerminalUnitBeforeDerivedStablePartial = (
    frontier: StableBoundedLagPathFrontier | null,
    stableEvent: DiagnosisEvent | null,
    displayed: readonly DiagnosisEvent[],
    candidateEvents: readonly DiagnosisEvent[] = [],
): DiagnosisEvent | null => {
    if (!frontier
        || !stableEvent
        || frontier.transitionCount < 2) return null;

    const stableYear = rankedEventYear(stableEvent);
    const hypotheses = [...displayed, ...candidateEvents];
    const terminalUnits = hypotheses.filter((event) => {
        if (event.eventType !== "missingRing" && event.eventType !== "falseRing") return false;
        const expectedShift = event.eventType === "missingRing" ? -1 : 1;
        const year = rankedEventYear(event);
        const nominalBoundaryYear = noteYear(event, "nominal_boundary_year=");
        const profileBoundaryYear = noteYear(event, "profile_boundary_year=");
        const sources = new Set(event.evidence.algorithmSources);
        return lagPathTransitionShift(event) === expectedShift
            && event.evidence.lagAfter === 0
            && sources.has("piecewise_lag_path")
            && sources.has("counterfactual_window_refinement")
            && sources.has("joint_event_counterfactual")
            && event.evidence.scoreMargin >= 0.05
            && (event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY) >= 0.1
            && event.evidence.samplePairs >= 30
            && nominalBoundaryYear !== null
            && nominalBoundaryYear === profileBoundaryYear
            && Math.abs(year - nominalBoundaryYear) <= 1;
    });
    const remoteDirectUnit = terminalUnits
        .filter((event) => rankedEventYear(event) > stableEvent.endYear + 2)
        .sort((left, right) => (
            rankedEventYear(right) - rankedEventYear(left)
            || right.evidence.score - left.evidence.score
        ))[0];
    if (remoteDirectUnit) {
        return {
            ...remoteDirectUnit,
            id: `${remoteDirectUnit.id}-terminal-unit-frontier-checkpoint`,
            alternativeTypes: [],
            locationAlternatives: undefined,
            operationAlternatives: undefined,
            evidence: {
                ...remoteDirectUnit.evidence,
                algorithmSources: Array.from(new Set([
                    ...remoteDirectUnit.evidence.algorithmSources,
                    "direct_terminal_unit_frontier_checkpoint",
                ])).sort(),
                notes: Array.from(new Set([
                    ...remoteDirectUnit.evidence.notes,
                    `older_stable_path_deferred_year=${stableYear}`,
                    `older_stable_path_transition_count=${frontier.transitionCount}`,
                ])),
            },
        };
    }

    if (stableEvent.eventType !== "partialMove"
        || stableEvent.shiftYears === undefined
        || frontier.aggregateShiftYears === stableEvent.shiftYears) return null;
    const hasIndependentPartial = [...displayed, ...candidateEvents].some((event) => (
        event.eventType === "partialMove"
        && event.shiftYears === stableEvent.shiftYears
        && Math.abs(rankedEventYear(event) - stableYear) <= 6
        && (
            event.evidence.candidateIds.length > 0
            || event.evidence.algorithmSources.some((source) => (
                source === "cofecha_segment_lag"
                || source === "joint_event_counterfactual"
                || source === "partial_local_consensus_recenter"
            ))
        )
    ));
    if (hasIndependentPartial) return null;

    const directUnit = displayed.filter((event) => {
        if (event.eventType !== "missingRing"
            || event.evidence.lagBefore !== -1
            || event.evidence.lagAfter !== 0) return false;
        const sources = new Set(event.evidence.algorithmSources);
        const hasIndependentYearEvidence = sources.has("joint_event_counterfactual")
            && sources.has("piecewise_lag_path")
            && sources.has("counterfactual_window_refinement")
            && (
                sources.has("local_counterfactual_raw_year")
                || sources.has("paired_core_counterfactual_year")
            );
        const year = rankedEventYear(event);
        return hasIndependentYearEvidence
            && event.evidence.notes.includes("mixed_reference_counterfactual_selected")
            && year >= stableEvent.startYear - 2
            && year <= stableEvent.endYear + 2
            && Math.abs(year - stableYear) <= 4;
    }).sort((left, right) => (
        rankedEventYear(right) - rankedEventYear(left)
        || right.evidence.score - left.evidence.score
    ))[0];
    if (!directUnit) return null;

    return {
        ...directUnit,
        id: `${directUnit.id}-terminal-unit-frontier-checkpoint`,
        alternativeTypes: [],
        locationAlternatives: undefined,
        operationAlternatives: undefined,
        evidence: {
            ...directUnit.evidence,
            algorithmSources: Array.from(new Set([
                ...directUnit.evidence.algorithmSources,
                "direct_terminal_unit_frontier_checkpoint",
            ])).sort(),
            notes: Array.from(new Set([
                ...directUnit.evidence.notes,
                `derived_stable_partial_deferred_shift=${stableEvent.shiftYears}`,
                `derived_stable_partial_aggregate_shift=${frontier.aggregateShiftYears}`,
                `derived_stable_partial_transition_count=${frontier.transitionCount}`,
            ])),
        },
    };
};

export const selectCumulativeLagPathFrontier = (
    aggregate: DiagnosisEvent,
    pathEvents: readonly DiagnosisEvent[],
    minimumSeparationYears = 14,
    minimumTransitionScore = 4.5,
    baselineLag = 0,
): DiagnosisEvent | null => {
    if (aggregate.eventType !== "partialMove"
        || aggregate.shiftYears === undefined
        || aggregate.shiftYears > -2) return null;
    const aggregateShiftCandidates = new Set([
        aggregate.shiftYears,
        noteYear(aggregate, "completed_mixed_cumulative_shift="),
        noteYear(aggregate, "joint_operation_correction="),
    ].filter((shift): shift is number => shift !== null));
    const chain = exactCumulativeLagPathChains(
        exactLagPathTransitions(pathEvents, minimumTransitionScore),
        baselineLag,
        minimumSeparationYears,
        2,
    ).find((candidate) => aggregateShiftCandidates.has(candidate.aggregateShiftYears));
    return chain?.event ?? null;
};

export const selectWholeBaselineLagPathFrontier = (
    whole: DiagnosisEvent,
    pathEvents: readonly DiagnosisEvent[],
    minimumSeparationYears = 14,
    minimumTransitionScore = 4.5,
): { event: DiagnosisEvent; aggregateShiftYears: number } | null => {
    if (whole.eventType !== "wholeSeriesMove"
        || whole.shiftYears === undefined
        || whole.shiftYears === 0) return null;
    const chain = exactCumulativeLagPathChains(
        exactLagPathTransitions(pathEvents, minimumTransitionScore),
        whole.shiftYears,
        minimumSeparationYears,
        1,
    )[0];
    return chain ? {
        event: chain.event,
        aggregateShiftYears: chain.aggregateShiftYears,
    } : null;
};

export const refineBoundedPathLocationWithOperation = (
    event: DiagnosisEvent,
    operations: readonly JointCounterfactualOperationScore[],
    targetRange: { startYear: number; endYear: number },
): DiagnosisEvent => {
    if (!event.evidence.algorithmSources.includes("bounded_complete_lag_path")) {
        return event;
    }
    const shiftYears = lagPathTransitionShift(event);
    const lagAfter = event.evidence.lagAfter;
    const currentTopYear = event.rankedYears[0]?.year;
    if (shiftYears === null || lagAfter === null || currentTopYear === undefined) return event;
    const operation = operations.find((candidate) => (
        candidate.eventType === event.eventType
        && candidate.shiftYears === shiftYears
        && candidate.baselineLag === lagAfter
    ));
    if (!operation) return event;
    const width = event.endYear - event.startYear + 1;
    const neighborRadius = Math.floor(width / 2);
    const bestYear = operation.bestYear;
    const maximumUnitRecenterYears = 3;
    if ((event.eventType === "missingRing" || event.eventType === "falseRing")
        && Math.abs(bestYear - currentTopYear) > maximumUnitRecenterYears) {
        return event;
    }
    if (bestYear < event.startYear - neighborRadius
        || bestYear > event.endYear + neighborRadius
        || operation.remoteDifferenceMargin < 0.01
        || Math.max(operation.bestRawGain, operation.bestDifferenceGain) < 0.02) {
        return event;
    }
    const actualWidth = Math.min(
        width,
        targetRange.endYear - targetRange.startYear + 1,
    );
    const startYear = Math.max(
        targetRange.startYear,
        Math.min(
            bestYear - Math.floor((actualWidth - 1) / 2),
            targetRange.endYear - actualWidth + 1,
        ),
    );
    const endYear = startYear + actualWidth - 1;
    const scoreByYear = new Map(operation.rows.map((row) => [
        row.year,
        row.differenceGain * 0.75 + row.rawGain * 0.25,
    ]));
    const rankedYears = Array.from(
        { length: endYear - startYear + 1 },
        (_, index) => {
            const year = startYear + index;
            return {
                year,
                score: scoreByYear.get(year) ?? -Math.abs(year - bestYear),
                rank: 0,
                evidenceTags: [
                    "bounded_complete_lag_path",
                    "joint_year_operation_evidence",
                ],
            };
        },
    ).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...event,
        id: `${event.id}-operation-location-${bestYear}`,
        startYear,
        endYear,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "joint_year_operation_evidence",
            ])).sort(),
            notes: Array.from(new Set([
                ...event.evidence.notes,
                `bounded_operation_location_previous_top_year=${currentTopYear}`,
                `bounded_operation_location_year=${bestYear}`,
                `bounded_operation_location_shift=${shiftYears}`,
                `bounded_operation_location_remote_margin=${
                    operation.remoteDifferenceMargin.toFixed(6)
                }`,
            ])),
        },
    };
};

const partialTransitionShift = (event: DiagnosisEvent): number | null => {
    if (event.eventType !== "partialMove"
        || !event.evidence.notes.includes("candidate_hard_gate_passed")
        || event.evidence.lagBefore === null
        || event.evidence.lagAfter === null) return null;
    const transitionShift = event.evidence.lagBefore - event.evidence.lagAfter;
    return isAutomaticPartialShift(transitionShift, {
        maxPartialGapYears: 100,
        lagMin: -100,
    }) ? transitionShift : null;
};

/**
 * Splits a cumulative partial state only when two hard-gated candidate transitions and two
 * full-interval counterfactual modes independently recover the same decomposition.
 */
export const selectCumulativePartialFrontier = (
    aggregate: DiagnosisEvent,
    candidateEvents: readonly DiagnosisEvent[],
    operations: readonly JointCounterfactualOperationScore[],
    minimumSeparationYears = 14,
): CumulativePartialComponent | null => {
    if (aggregate.eventType !== "partialMove"
        || aggregate.shiftYears === undefined
        || aggregate.evidence.lagBefore !== aggregate.shiftYears
        || aggregate.evidence.lagAfter !== 0) return null;
    const operationByShift = new Map(operations
        .filter((operation) => operation.eventType === "partialMove")
        .map((operation) => [operation.shiftYears, operation]));
    const components = candidateEvents.flatMap<CumulativePartialComponent>((event) => {
        const shiftYears = partialTransitionShift(event);
        if (shiftYears === null) return [];
        const operation = operationByShift.get(shiftYears);
        return operation ? [{ event, operation, shiftYears }] : [];
    });
    const pairs = components.flatMap((left, index) => components.slice(index + 1)
        .flatMap((right) => {
            if (left.shiftYears === right.shiftYears
                || left.shiftYears + right.shiftYears !== aggregate.shiftYears) return [];
            const leftCandidateYear = left.event.rankedYears[0]?.year;
            const rightCandidateYear = right.event.rankedYears[0]?.year;
            if (leftCandidateYear === undefined
                || rightCandidateYear === undefined
                || Math.abs(leftCandidateYear - rightCandidateYear)
                    < minimumSeparationYears
                || Math.abs(left.operation.bestYear - right.operation.bestYear)
                    < minimumSeparationYears) return [];
            const operationEvidencePasses = [left.operation, right.operation].every(
                (operation) => operation.bestDifferenceGain >= 0.02
                    && operation.topThreeDifferenceGain >= 0.015
                    && operation.bestCombinedGain > 0,
            );
            return operationEvidencePasses ? [{ left, right }] : [];
        }));
    if (pairs.length !== 1) return null;
    const pair = pairs[0];
    return pair.left.operation.bestYear >= pair.right.operation.bestYear
        ? pair.left
        : pair.right;
};

const recoverCumulativePartialFrontier = (
    displayed: readonly DiagnosisEvent[],
    candidateEvents: readonly DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    maxPartialGapYears: number,
): DiagnosisEvent | null => {
    if (displayed.some((event) => event.eventType === "wholeSeriesMove")) return null;
    const aggregate = displayed.filter((event) => event.eventType === "partialMove")
        .sort((left, right) => (
            Math.abs(right.shiftYears ?? 0) - Math.abs(left.shiftYears ?? 0)
            || Number(right.evidence.algorithmSources.includes(
                "bounded_complete_lag_path",
            )) - Number(left.evidence.algorithmSources.includes(
                "bounded_complete_lag_path",
            ))
        ))[0];
    if (!aggregate) return null;
    const operations = getJointCounterfactualOperationScores(
        diagnosis,
        15,
        maxPartialGapYears,
        0,
    );
    const selected = selectCumulativePartialFrontier(
        aggregate,
        candidateEvents,
        operations,
    );
    if (!selected) return null;
    const componentPairs = candidateEvents.flatMap((event) => {
        const shiftYears = partialTransitionShift(event);
        return shiftYears === null ? [] : [shiftYears];
    }).filter((shiftYears) => shiftYears !== selected.shiftYears);
    const companionShift = componentPairs.find((shiftYears) => (
        shiftYears + selected.shiftYears === aggregate.shiftYears
    ));
    if (companionShift === undefined) return null;
    const width = 9;
    const startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(
            selected.operation.bestYear - Math.floor(width / 2),
            diagnosis.targetRange.endYear - width + 1,
        ),
    );
    const endYear = startYear + width - 1;
    const rowsByYear = new Map(selected.operation.rows.map((row) => [row.year, row]));
    const rankedYears = Array.from({ length: width }, (_, index) => {
        const year = startYear + index;
        const row = rowsByYear.get(year);
        return {
            year,
            score: row?.combinedGain ?? selected.operation.bestCombinedGain - 1,
            evidenceTags: ["cumulative_partial_component_decomposition"],
        };
    }).sort((left, right) => (
        right.score - left.score
        || Math.abs(left.year - selected.operation.bestYear)
            - Math.abs(right.year - selected.operation.bestYear)
        || left.year - right.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...aggregate,
        id: `${aggregate.id}-cumulative-partial-component-${selected.shiftYears}`,
        startYear,
        endYear,
        reviewCoreRange: { startYear, endYear },
        rankedYears,
        confidenceLevel: "medium",
        shiftYears: selected.shiftYears,
        shiftSide: "older",
        alternativeTypes: [],
        locationAlternatives: undefined,
        operationAlternatives: undefined,
        evidence: {
            ...aggregate.evidence,
            algorithmSources: Array.from(new Set([
                ...aggregate.evidence.algorithmSources,
                "cumulative_partial_component_decomposition",
                "joint_counterfactual_operation",
            ])).sort(),
            score: selected.operation.bestCombinedGain,
            scoreMargin: selected.operation.remoteDifferenceMargin,
            correlationGain: Math.max(
                aggregate.evidence.correlationGain ?? 0,
                selected.operation.bestCombinedGain,
            ),
            lagBefore: selected.shiftYears,
            lagAfter: 0,
            candidateIds: Array.from(new Set([
                ...aggregate.evidence.candidateIds,
                ...candidateEvents.flatMap((event) => event.evidence.candidateIds),
            ])),
            notes: Array.from(new Set([
                ...aggregate.evidence.notes,
                `cumulative_partial_aggregate_shift=${aggregate.shiftYears}`,
                `cumulative_partial_component_shift=${selected.shiftYears}`,
                `cumulative_partial_companion_shift=${companionShift}`,
                `cumulative_partial_component_year=${selected.operation.bestYear}`,
                `cumulative_partial_component_difference_gain=${
                    selected.operation.bestDifferenceGain.toFixed(6)
                }`,
                `cumulative_partial_component_remote_margin=${
                    selected.operation.remoteDifferenceMargin.toFixed(6)
                }`,
                "cumulative_partial_component_count=2",
                `counterfactual_correction_years=${selected.shiftYears}`,
            ])),
        },
    };
};

const recoverNearCumulativePartialPairFrontier = (
    displayed: readonly DiagnosisEvent[],
    boundedPathEvents: readonly DiagnosisEvent[],
    candidateEvents: readonly DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    maxPartialGapYears: number,
): DiagnosisEvent | null => {
    if (displayed.some((event) => event.eventType === "wholeSeriesMove")) return null;
    const displayedPartials = displayed.filter((event) => event.eventType === "partialMove");
    const displayedShifts = new Set(displayedPartials.map((event) => event.shiftYears));
    const matchingBoundedPaths = boundedPathEvents.filter((event) => (
        event.eventType === "partialMove"
        && displayedShifts.has(event.shiftYears)
    ));
    const aggregate = [...matchingBoundedPaths, ...displayedPartials]
        .sort((left, right) => (
            Number(right.evidence.algorithmSources.includes(
                "bounded_complete_lag_path",
            )) - Number(left.evidence.algorithmSources.includes(
                "bounded_complete_lag_path",
            ))
            || Math.abs(right.shiftYears ?? 0) - Math.abs(left.shiftYears ?? 0)
    ))[0];
    if (!aggregate) return null;
    // A complete exact operation is the null hypothesis for this decomposition. The nearby-pair
    // fitter may only replace it when an independent path already exposes both transitions;
    // otherwise a single physical gap is routinely overfit as two smaller gaps.
    if (preservesDecisiveExactPartial(aggregate)) return null;
    const competition: CompletedPartialPairCompetition | null = compareCompletedPartialPair(
        diagnosis,
        cofechaDiagnosis,
        siteData,
        aggregate,
        candidateEvents,
        maxPartialGapYears,
    );
    if (!competition) return null;
    const width = 9;
    const startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(
            competition.newerYear - Math.floor(width / 2),
            diagnosis.targetRange.endYear - width + 1,
        ),
    );
    const endYear = startYear + width - 1;
    const rankedYears = Array.from({ length: width }, (_, index) => {
        const year = startYear + index;
        return {
            year,
            score: -Math.abs(year - competition.newerYear),
            evidenceTags: ["completed_partial_pair_competition"],
        };
    }).sort((left, right) => (
        right.score - left.score || left.year - right.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...aggregate,
        id: `${aggregate.id}-completed-partial-pair-${competition.newerShiftYears}`,
        startYear,
        endYear,
        reviewCoreRange: { startYear, endYear },
        rankedYears,
        confidenceLevel: "medium",
        shiftYears: competition.newerShiftYears,
        shiftSide: "older",
        alternativeTypes: [],
        locationAlternatives: undefined,
        operationAlternatives: undefined,
        evidence: {
            ...aggregate.evidence,
            algorithmSources: Array.from(new Set([
                ...aggregate.evidence.algorithmSources,
                "completed_partial_pair_competition",
                "cumulative_partial_component_decomposition",
            ])).sort(),
            scoreMargin: Math.max(0, Math.min(
                competition.rawPairMargin,
                competition.cofechaPairMargin,
            )),
            lagBefore: competition.newerShiftYears,
            lagAfter: 0,
            candidateIds: Array.from(new Set([
                ...aggregate.evidence.candidateIds,
                ...candidateEvents.flatMap((event) => event.evidence.candidateIds),
            ])),
            notes: Array.from(new Set([
                ...aggregate.evidence.notes,
                `cumulative_partial_aggregate_shift=${competition.aggregateShiftYears}`,
                `cumulative_partial_component_shift=${competition.newerShiftYears}`,
                `cumulative_partial_companion_shift=${competition.olderShiftYears}`,
                `cumulative_partial_component_year=${competition.newerYear}`,
                `cumulative_partial_component_difference_gain=${
                    competition.newerOperationDifferenceGain.toFixed(6)
                }`,
                `completed_partial_pair_older_year=${competition.olderYear}`,
                `completed_partial_pair_raw_years=${
                    competition.rawOlderYear
                }/${competition.rawNewerYear}`,
                `completed_partial_pair_cofecha_years=${
                    competition.cofechaOlderYear
                }/${competition.cofechaNewerYear}`,
                `completed_partial_pair_raw_margin=${competition.rawPairMargin.toFixed(6)}`,
                `completed_partial_pair_cofecha_margin=${
                    competition.cofechaPairMargin.toFixed(6)
                }`,
                `completed_partial_pair_raw_family_margin=${
                    competition.rawFamilyMargin.toFixed(6)
                }`,
                `completed_partial_pair_cofecha_family_margin=${
                    competition.cofechaFamilyMargin.toFixed(6)
                }`,
                "cumulative_partial_component_count=2",
                `counterfactual_correction_years=${competition.newerShiftYears}`,
            ])),
        },
    };
};

const recoverCumulativeLagPathFrontier = (
    displayed: readonly DiagnosisEvent[],
    rawPathEvents: readonly DiagnosisEvent[],
): DiagnosisEvent | null => {
    const whole = displayed.find((event) => event.eventType === "wholeSeriesMove");
    const baselineLag = whole?.shiftYears ?? 0;
    const aggregate = displayed.filter((event) => event.eventType === "partialMove")
        .sort((left, right) => (
            Math.abs(right.shiftYears ?? 0) - Math.abs(left.shiftYears ?? 0)
    ))[0];
    const selectedWithShift = aggregate
        ? {
            event: selectCumulativeLagPathFrontier(
                aggregate,
                rawPathEvents,
                14,
                4,
                baselineLag,
            ),
            aggregateShiftYears: aggregate.shiftYears,
        }
        : whole
            ? selectWholeBaselineLagPathFrontier(whole, rawPathEvents)
            : null;
    const selected = selectedWithShift?.event ?? null;
    if (!selected) return null;
    const componentShift = lagPathTransitionShift(selected);
    const aggregateShiftYears = noteYear(
        selected,
        "exact_cumulative_path_aggregate_shift=",
    ) ?? selectedWithShift?.aggregateShiftYears;
    if (componentShift === null || aggregateShiftYears === undefined) return null;
    const companionShift = aggregateShiftYears - componentShift;
    const componentYear = selected.rankedYears[0]?.year;
    if (componentYear === undefined) return null;
    const nominalBoundaryYear = noteYear(selected, "nominal_boundary_year=");
    const profileBoundaryYear = noteYear(selected, "profile_boundary_year=");
    const operationYear = (selected.eventType === "missingRing"
        || selected.eventType === "falseRing")
        && nominalBoundaryYear !== null
        && nominalBoundaryYear === profileBoundaryYear
        && nominalBoundaryYear >= selected.startYear
        && nominalBoundaryYear <= selected.endYear
        && Math.abs(nominalBoundaryYear - componentYear) <= 2
        ? nominalBoundaryYear
        : componentYear;
    const maximumRankScore = Math.max(
        0,
        ...selected.rankedYears.map((row) => row.score),
    );
    const rankedYears = operationYear === componentYear
        ? selected.rankedYears
        : selected.rankedYears.map((row) => ({
            ...row,
            score: row.year === operationYear
                ? maximumRankScore + Math.max(1e-9, Math.abs(maximumRankScore) * 1e-12)
                : row.score,
            evidenceTags: Array.from(new Set([
                ...row.evidenceTags,
                ...(row.year === operationYear
                    ? ["cumulative_frontier_operation_year"]
                    : []),
            ])).sort(),
        })).sort((left, right) => (
            right.score - left.score || right.year - left.year
        )).map((row, index) => ({ ...row, rank: index + 1 }));
    const authority = aggregate ?? whole!;
    return {
        ...selected,
        id: `${authority.id}-cumulative-lag-path-frontier-${selected.eventType}-${componentShift}`,
        rankedYears,
        confidenceLevel: selected.confidenceLevel === "low" ? "medium" : selected.confidenceLevel,
        alternativeTypes: [],
        locationAlternatives: undefined,
        operationAlternatives: undefined,
        evidence: {
            ...selected.evidence,
            algorithmSources: Array.from(new Set([
                ...selected.evidence.algorithmSources,
                "cumulative_lag_path_frontier",
            ])).sort(),
            correlationGain: Math.max(
                selected.evidence.correlationGain ?? 0,
                authority.evidence.correlationGain ?? 0,
            ),
            lagBefore: componentShift,
            lagAfter: 0,
            candidateIds: Array.from(new Set([
                ...selected.evidence.candidateIds,
                ...authority.evidence.candidateIds,
            ])),
            notes: Array.from(new Set([
                ...selected.evidence.notes,
                `cumulative_path_baseline_lag=${baselineLag}`,
                `cumulative_path_aggregate_shift=${aggregateShiftYears}`,
                `cumulative_path_component_shift=${componentShift}`,
                `cumulative_path_companion_shift=${companionShift}`,
                `cumulative_path_component_year=${componentYear}`,
                `cumulative_path_operation_year=${operationYear}`,
                `cumulative_path_component_score=${selected.evidence.score.toFixed(6)}`,
                `cumulative_path_transition_count=${
                    selected.evidence.notes.find((note) => (
                        note.startsWith("exact_cumulative_path_transition_count=")
                    ))?.split("=")[1] ?? "2"
                }`,
                `counterfactual_correction_years=${componentShift}`,
            ])),
        },
    };
};

/** A compressed +2 range candidate can carry the older step of a two-false-ring staircase. */
export const hasCompressedSequentialFalseDirection = (
    events: readonly DiagnosisEvent[],
    candidates: readonly Pick<
        DiagnosisCandidateOperation,
        "targetTree" | "operationType" | "deltaYears" | "suggestedLag"
    >[],
    targetTree: string,
): boolean => events.some((event) => (
    event.eventType === "falseRing"
    && event.evidence.lagBefore !== null
    && event.evidence.lagAfter !== null
    && event.evidence.lagBefore === event.evidence.lagAfter + 1
)) && candidates.some((candidate) => (
    candidate.targetTree === targetTree
    && candidate.operationType === "SHIFT_RANGE"
    && (candidate.deltaYears ?? candidate.suggestedLag) === 2
));

type SequentialMissingDirectionEvidence = {
    hasOppositeUnitOnly: boolean;
    hasAuthoritativeOppositeUnit?: boolean;
    hasDetectedMissing: boolean;
    hasMissingCandidate: boolean;
    hasConfirmedTargetStaircase: boolean;
    sharedZeroSupport: number;
    hasCumulativeStaircase?: boolean;
    hasMarkerAnchoredStaircase?: boolean;
};

/** Shared reference zeros may locate a missing event, but cannot reverse explicit +1 lag evidence. */
export const supportsSequentialMissingDirectionOverride = ({
    hasOppositeUnitOnly,
    hasAuthoritativeOppositeUnit = false,
    hasDetectedMissing,
    hasMissingCandidate,
    hasConfirmedTargetStaircase,
    sharedZeroSupport,
    hasCumulativeStaircase = false,
    hasMarkerAnchoredStaircase = false,
}: SequentialMissingDirectionEvidence): boolean => {
    // Historical zero markers describe already accepted missing rings. They can locate another
    // missing frontier, but cannot by themselves reverse a current, independently hard-gated
    // false-ring operation. A competing missing operation needs its own current candidate.
    if (hasAuthoritativeOppositeUnit) {
        return hasMissingCandidate;
    }
    return hasDetectedMissing
    || hasMissingCandidate
    || hasConfirmedTargetStaircase
    || (!hasOppositeUnitOnly && (
        hasCumulativeStaircase
        || hasMarkerAnchoredStaircase
        || sharedZeroSupport >= 10
    ));
};

/** Keeps a confirmed unit-event frontier separate from a distant partial-move mode. */
export const hasDistinctConfirmedSequentialMissingMode = (
    detected: readonly DiagnosisEvent[],
    candidateEvents: readonly DiagnosisEvent[],
    head: Pick<SequentialMissingHead, "year" | "transitionCount" | "headRunYears">,
    confirmedTargetZeroYears: readonly number[],
): boolean => {
    const partialCenters = detected
        .filter((event) => event.eventType === "partialMove")
        .map((event) => event.rankedYears[0]?.year)
        .filter((year): year is number => year !== undefined);
    const nearestPartialDistance = partialCenters.length === 0
        ? 0
        : Math.min(...partialCenters.map((year) => Math.abs(year - head.year)));
    const newerConfirmedMissingCount = confirmedTargetZeroYears.filter(
        (year) => year > head.year,
    ).length;
    const hasHeadCandidate = hasDepthConsistentSequentialMissingCandidate(
        candidateEvents,
        head,
    );
    return nearestPartialDistance >= MIN_DISTINCT_PARTIAL_MODE_SEPARATION_YEARS
        && newerConfirmedMissingCount >= MIN_CONFIRMED_NEWER_MISSING_MARKERS
        && hasHeadCandidate;
};

const recoverSequentialMissingHeadEvent = (
    detected: DiagnosisEvent[],
    earlierLocationCheckpoints: readonly DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    candidates: DiagnosisCandidateOperation[],
    candidateEvents: DiagnosisEvent[],
    effectiveConfig: EffectiveDiagnosisConfig,
    options: DiagnosisEventEnsembleOptions,
    pathCache: LagPathCache,
): SequentialMissingRecovery | null => {
    const markerMode = options.sharedZeroMarkerMode ?? "local2";
    const confirmedTargetZeroYears = Array.from(
        siteData.get(diagnosis.targetTree) ?? [],
    ).filter(([, value]) => value === 0).map(([year]) => year);
    const preferredLocationCenters = sequentialMissingPreferredLocationCenters(
        detected,
        earlierLocationCheckpoints,
    );
    const allowedByCofecha = isCofechaFlaggedSeries(
        diagnosis.targetTree,
        options.cofechaFlaggedSeriesIds,
    );
    if (!allowedByCofecha) return null;
    const head = locateSequentialMissingHead(
        cofechaDiagnosis,
        siteData,
        {
            minLag: effectiveConfig.lagMin,
            maxPartialGapYears: effectiveConfig.maxPartialGapYears,
        },
        pathCache,
    );
    const hasDetectedUnitEvent = detected.some((event) => (
        event.eventType === "missingRing" || event.eventType === "falseRing"
    ));
    const compactPartial = detected.find((event) => (
        event.eventType === "partialMove"
        && (event.shiftYears === -2 || event.shiftYears === -3)
        && isExactPartialLagTransition(
            event.shiftYears,
            event.evidence.lagBefore,
            event.evidence.lagAfter,
        )
    ));
    const compressedPartial = compactPartial?.shiftYears === -2
        ? compactPartial
        : undefined;
    const recoverRobustCompactPartial = (): SequentialMissingRecovery | null => {
        if (
            !compactPartial
            || hasDetectedUnitEvent
            || detected.some((event) => event.eventType === "wholeSeriesMove")
        ) return null;
        const compactShift = compactPartial.shiftYears!;
        const compactCache = createLagPathCache();
        const compactHead = locateSequentialMissingHead(
            cofechaDiagnosis,
            siteData,
            {
                minLag: compactShift,
                maxPartialGapYears: Math.abs(compactShift),
            },
            compactCache,
            0,
        );
        if (!compactHead) return null;
        const compactCompetition = comparePartialMoveWithMissingStaircase(
            cofechaDiagnosis,
            siteData,
            compactPartial,
            true,
            compactHead.year,
        );
        const tieEvidence = evaluateMissingPartialInterpretationTie(
            compactCompetition,
            {
                missingReviewPassed: true,
                partialReviewPassed: true,
                hasIndependentWholeSeriesBaseline: false,
            },
        );
        if (tieEvidence) {
            return {
                event: attachMissingPartialInterpretation(
                    compactPartial,
                    makeMissingRingInterpretation(
                        compactPartial,
                        tieEvidence,
                        diagnosis.targetRange,
                    ),
                    tieEvidence,
                ),
                preserveWholeBaseline: false,
            };
        }
        if (!compressedPartial) return null;
        const robustCache = createLagPathCache();
        const robustHead = locateSequentialMissingHead(
            cofechaDiagnosis,
            siteData,
            { minLag: -2, maxPartialGapYears: 2 },
            robustCache,
            0,
        );
        const robustStaircase = locateTwoStepMissingStaircase(
            cofechaDiagnosis,
            siteData,
            compressedPartial,
            { minLag: -2, maxPartialGapYears: 2 },
            robustCache,
        );
        const robustCompetition = comparePartialMoveWithRobustMissingStaircase(
            cofechaDiagnosis,
            siteData,
            compressedPartial,
            true,
            robustHead?.year ?? null,
        );
        const robustSupport = supportsRobustMissingStaircaseCorrection(
            robustCompetition,
            robustStaircase,
        ) || supportsDecisiveUnanchoredMissingStaircase(
            robustCompetition,
            robustStaircase,
        );
        if (!robustHead || !robustSupport) return null;
        const selectedHead = {
            ...robustHead,
            year: robustCompetition!.missingYears[0] ?? robustHead.year,
        };
        const marker = selectSharedZeroMarkerForMode(
            siteData,
            diagnosis.targetTree,
            selectedHead.year,
            markerMode,
            2,
        );
        const recovered = addExplicitStaircaseCompetitionEvidence(
            makeSequentialMissingHeadEvent(
                selectedHead,
                marker,
                detected,
                diagnosis,
                candidates,
                [],
                preferredLocationCenters,
                confirmedTargetZeroYears,
                markerMode,
            ),
            robustCompetition!,
            robustStaircase!,
        );
        return {
            event: {
                ...recovered,
                evidence: {
                    ...recovered.evidence,
                    algorithmSources: Array.from(new Set([
                        ...recovered.evidence.algorithmSources,
                        "robust_per_reference_missing_staircase",
                    ])).sort(),
                },
            },
            preserveWholeBaseline: false,
        };
    };
    const headMarker = head ? selectSharedZeroMarkerForMode(
        siteData,
        diagnosis.targetTree,
        head.year,
        markerMode,
    ) : null;
    const hasConsensusAnchoredMissingStaircase = head
        ? supportsConsensusAnchoredSequentialMissingStaircase(
            head,
            headMarker?.support ?? 0,
        )
        : false;
    const hasConfirmedPathAdvance = head
        ? supportsConfirmedSequentialMissingPathAdvance(
            head,
            confirmedTargetZeroYears,
            headMarker?.support ?? 0,
        )
        : false;
    // A true continuous gap normally wins the direct fit. A dense external zero marker plus one
    // local exact unit staircase is independent evidence that the aggregate score cannot erase.
    if (head && (
        head.gainOverDirect > 0
        || hasConsensusAnchoredMissingStaircase
        || hasConfirmedPathAdvance
    )) {
        const marker = headMarker;
        const candidateCenters = sequentialMissingCandidateCenters(candidateEvents);
        const presentation = resolveSequentialMissingPresentation(
            head,
            marker,
            markerMode,
            candidateCenters,
            confirmedTargetZeroYears,
            preferredLocationCenters,
        );
        const preserveCandidateBackedUnit =
            shouldPreserveCandidateBackedUnitFromRemoteSequentialHead(
                detected,
                candidateEvents,
                head.year,
            )
            && presentation.confirmedTargetStaircaseYear === null
            && (marker?.support ?? 0) < 10
            && !hasDepthConsistentSequentialMissingCandidate(
                candidateEvents,
                head,
            );
        if (preserveCandidateBackedUnit) return null;
        const completedFamilyCompetition = compareCompletedPartialWithMissingStaircase(
            cofechaDiagnosis,
            siteData,
            candidateEvents,
            head.unitEventYears,
            true,
        );
        const replacesNonUnitEvent = detected.some((event) => (
            event.eventType === "partialMove" || event.eventType === "wholeSeriesMove"
        ));
        const replacesPartial = detected.some((event) => event.eventType === "partialMove");
        const hasExistingUnitEvent = detected.some((event) => (
            event.eventType === "missingRing" || event.eventType === "falseRing"
        ));
        const hasAuthoritativeOppositeUnit =
            hasCandidateBackedSequentialFalseDirection([
                ...detected,
                ...candidateEvents,
            ]);
        const hasDetectedMissing = detected.some(
            (event) => event.eventType === "missingRing",
        );
        const hasMissingCandidate = candidateEvents.some(
            (event) => event.eventType === "missingRing",
        );
        const hasOppositeUnitOnly = (
            hasCoherentSequentialFalseStaircase(detected)
            || hasAuthoritativeOppositeUnit
            || hasCompressedSequentialFalseDirection(
                detected,
                candidates,
                diagnosis.targetTree,
            )
        )
            && !(hasAuthoritativeOppositeUnit
                ? hasMissingCandidate
                : hasDetectedMissing);
        const hasCumulativeMissingStaircase =
            supportsCumulativeSequentialMissingStaircase(head);
        const hasMarkerAnchoredMissingStaircase =
            supportsMarkerAnchoredSequentialMissingStaircase(
                head,
                marker?.support ?? 0,
            ) || hasConsensusAnchoredMissingStaircase;
        const hasCandidateBackedExactPartial = detected.some(
            isCandidateBackedExactPartial,
        );
        const hasStrongMarkerAgainstUnbackedPartial = (marker?.support ?? 0) >= 10
            && !hasCandidateBackedExactPartial;
        const hasIndependentMissingDirection =
            supportsSequentialMissingDirectionOverride({
                hasOppositeUnitOnly,
                hasAuthoritativeOppositeUnit,
                hasDetectedMissing,
                hasMissingCandidate,
                hasConfirmedTargetStaircase:
                    presentation.confirmedTargetStaircaseYear !== null
                    || presentation.advancedSequentialPathYear !== null,
                sharedZeroSupport: marker?.support ?? 0,
                hasCumulativeStaircase: hasCumulativeMissingStaircase,
                hasMarkerAnchoredStaircase: hasMarkerAnchoredMissingStaircase,
            });
        const whole = detected.find((event) => event.eventType === "wholeSeriesMove");
        const wholeShift = wholeSeriesMoveShiftYears(whole);
        const hasAuthoritativeWholeCheckpoint = whole
            ? isAuthoritativeWholeSeriesCheckpoint(whole)
            : false;
        const zeroLagFixedTailResolvesWhole = Number.isFinite(
            head.fixedTailMeanAdvantage,
        ) && head.fixedTailMeanAdvantage >= 0.05;
        const terminalCumulativeStaircaseResolvesWhole =
            terminalCumulativeMissingExhaustsUnitWhole(
                head,
                wholeShift,
                diagnosis.targetRange.endYear,
            );
        const independentWholeBaseline = wholeShift !== null && (
            hasAuthoritativeWholeCheckpoint
            || (
                wholeShift !== head.pathStartLag
                && detected.some((event) => (
                    event.eventType !== "wholeSeriesMove"
                    && event.evidence.lagAfter === wholeShift
                ))
                && !zeroLagFixedTailResolvesWhole
                && !terminalCumulativeStaircaseResolvesWhole
            )
        );
        const hasIndependentStaircaseSupport = hasExistingUnitEvent
            || hasCumulativeMissingStaircase
            || hasMarkerAnchoredMissingStaircase
            || head.headRunYears >= 7
            || hasDepthConsistentSequentialMissingCandidate(candidateEvents, head)
            || presentation.confirmedTargetStaircaseYear !== null
            || (marker?.support ?? 0) >= 10;
        const hasDistinctConfirmedMissingMode = hasDistinctConfirmedSequentialMissingMode(
            detected,
            candidateEvents,
            head,
            confirmedTargetZeroYears,
        );
        const completedFamilySupported = supportsCompletedPartialOverMissingStaircase(
            completedFamilyCompetition,
        );
        const completedFamilyCandidateCount = completedFamilyCompetition
            ? candidateEvents.filter((event) => (
                event.eventType === "partialMove"
                && event.shiftSide === "older"
                && event.shiftYears === completedFamilyCompetition.partialShiftYears
                && event.evidence.candidateIds.length > 0
                && event.evidence.notes.includes("candidate_hard_gate_passed")
            )).length
            : 0;
        const completedPartialReviewCandidate = completedFamilyCompetition
            && !whole
            && !hasConsensusAnchoredMissingStaircase
            ? recoverCompletedCandidateBackedPartial(
                completedFamilyCompetition,
                candidateEvents,
                diagnosis,
                completedFamilySupported ? "preferred" : "tied-alternative",
            )
            : null;
        const completedPartialCandidate = !hasDistinctConfirmedMissingMode
            ? completedPartialReviewCandidate
            : null;
        const completedPartial = completedFamilySupported
            ? completedPartialCandidate
            : null;
        if (completedPartial) {
            return { event: completedPartial, preserveWholeBaseline: false };
        }
        if (hasOppositeUnitOnly && !hasIndependentMissingDirection) {
            return recoverRobustCompactPartial();
        }
        if (replacesPartial
            && !supportsSequentialMissingReplacementOfPartial(head)
            && !hasCumulativeMissingStaircase
            && !hasMarkerAnchoredMissingStaircase
            && !hasStrongMarkerAgainstUnbackedPartial
            && !hasDistinctConfirmedMissingMode) {
            return recoverRobustCompactPartial();
        }
        // A staircase may be an endpoint artefact of a non-zero global baseline. It may replace a
        // whole candidate only when that candidate is the staircase's older state. An independently
        // connected baseline needs its own missing-direction evidence and remains in the event set.
        if (independentWholeBaseline && !hasIndependentMissingDirection) {
            return recoverRobustCompactPartial();
        }
        if (replacesNonUnitEvent && !hasIndependentStaircaseSupport) {
            return recoverRobustCompactPartial();
        }
        const localConfirmedYears = confirmedTargetZeroYears.filter((year) => (
            year <= head.year
            && head.year - year <= MAX_LOCAL_CONFIRMED_PATH_ADVANCE_YEARS
        ));
        const collapsedAdvanceYear = hasConfirmedPathAdvance
            && localConfirmedYears.length > 0
            ? Math.min(...localConfirmedYears) - 2
            : null;
        const presentationHead = collapsedAdvanceYear === null ? head : {
            ...head,
            year: collapsedAdvanceYear,
        };
        const baseRecoveredEvent = makeSequentialMissingHeadEvent(
            presentationHead,
            collapsedAdvanceYear === null ? marker : null,
            detected,
            diagnosis,
            candidates,
            candidateEvents,
            preferredLocationCenters,
            confirmedTargetZeroYears,
            markerMode,
        );
        const recoveredEvent = completedFamilyCompetition ? {
            ...baseRecoveredEvent,
            evidence: {
                ...baseRecoveredEvent.evidence,
                algorithmSources: Array.from(new Set([
                    ...baseRecoveredEvent.evidence.algorithmSources,
                    "completed_partial_staircase_competition_audit",
                ])).sort(),
                notes: [
                    ...baseRecoveredEvent.evidence.notes,
                    ...completedPartialCompetitionNotes(completedFamilyCompetition),
                    `completed_family_recovery_supported=${completedFamilySupported}`,
                    `completed_family_recovery_candidate_count=${
                        completedFamilyCandidateCount
                    }`,
                    `completed_family_recovery_blocked_by_whole=${Boolean(whole)}`,
                    `completed_family_recovery_blocked_by_unit=${hasExistingUnitEvent}`,
                    `completed_family_recovery_blocked_by_distinct_missing=${
                        hasDistinctConfirmedMissingMode
                    }`,
                ],
            },
        } : baseRecoveredEvent;
        const evidencedRecoveredEvent = hasCumulativeMissingStaircase
            || hasMarkerAnchoredMissingStaircase
            || hasConfirmedPathAdvance ? {
                ...recoveredEvent,
                evidence: {
                    ...recoveredEvent.evidence,
                    algorithmSources: Array.from(new Set([
                        ...recoveredEvent.evidence.algorithmSources,
                        ...(hasCumulativeMissingStaircase
                            ? ["cumulative_sequential_missing_staircase"]
                            : []),
                        ...(hasMarkerAnchoredMissingStaircase
                            ? ["marker_anchored_sequential_missing_staircase"]
                            : []),
                        ...(hasConsensusAnchoredMissingStaircase
                            ? ["consensus_anchored_sequential_missing_staircase"]
                            : []),
                        ...(hasConfirmedPathAdvance
                            ? ["confirmed_sequential_missing_path_advance"]
                            : []),
                    ])).sort(),
                    notes: [
                        ...recoveredEvent.evidence.notes,
                        ...(collapsedAdvanceYear === null ? [] : [
                            `confirmed_path_advance_from=${head.year}`,
                            `confirmed_path_advance_to=${collapsedAdvanceYear}`,
                        ]),
                    ],
                },
            } : recoveredEvent;
        const preferredMissingEvent = hasDistinctConfirmedMissingMode ? {
                ...evidencedRecoveredEvent,
                evidence: {
                    ...evidencedRecoveredEvent.evidence,
                    algorithmSources: Array.from(new Set([
                        ...evidencedRecoveredEvent.evidence.algorithmSources,
                        "confirmed_missing_history_distinct_mode",
                    ])).sort(),
                    notes: [
                        ...evidencedRecoveredEvent.evidence.notes,
                        `sequential_missing_confirmed_newer_zero_count=${
                            confirmedTargetZeroYears.filter((year) => year > head.year).length
                        }`,
                        "sequential_missing_distinct_partial_mode=true",
                    ],
                },
            } : evidencedRecoveredEvent;
        const completedTieEvidence = evaluateMissingPartialInterpretationTie(
            completedFamilyCompetition,
            {
                missingReviewPassed: hasIndependentStaircaseSupport,
                partialReviewPassed: completedPartialCandidate !== null,
                hasIndependentWholeSeriesBaseline: independentWholeBaseline,
            },
        );
        const smallStaircase = compressedPartial
            ? locateTwoStepMissingStaircase(
                cofechaDiagnosis,
                siteData,
                compressedPartial,
                { minLag: -2, maxPartialGapYears: 2 },
                pathCache,
            )
            : null;
        const smallCompetition = compressedPartial
            ? comparePartialMoveWithMissingStaircase(
                cofechaDiagnosis,
                siteData,
                compressedPartial,
                true,
                head.year,
            )
            : null;
        const smallTieEvidence = evaluateMissingPartialInterpretationTie(
            smallCompetition,
            {
                missingReviewPassed: supportsCompressedMissingStaircase(smallStaircase)
                    && hasIndependentStaircaseSupport,
                partialReviewPassed: compressedPartial !== undefined
                    && !hasDistinctConfirmedMissingMode,
                hasIndependentWholeSeriesBaseline: independentWholeBaseline,
            },
        );
        const interpretationEvidence = completedTieEvidence
            ?? smallTieEvidence;
        const partialInterpretation = completedTieEvidence
            ? completedPartialCandidate
            : smallTieEvidence && compressedPartial
                ? makePartialMoveInterpretation(
                    compressedPartial,
                    smallTieEvidence,
                    diagnosis.targetRange,
                )
                : null;
        const selectedMissingEvent = interpretationEvidence && partialInterpretation
                ? attachMissingPartialInterpretation(
                    preferredMissingEvent,
                    partialInterpretation,
                    interpretationEvidence,
                )
                : preferredMissingEvent;
        const resolvedMissingEvent = whole && !independentWholeBaseline ? {
            ...selectedMissingEvent,
            evidence: {
                ...selectedMissingEvent.evidence,
                algorithmSources: Array.from(new Set([
                    ...selectedMissingEvent.evidence.algorithmSources,
                    "sequential_missing_exhausts_whole_baseline",
                ])).sort(),
                notes: [
                    ...selectedMissingEvent.evidence.notes,
                    "sequential_missing_preserve_whole_baseline=false",
                ],
            },
        } : selectedMissingEvent;
        return {
            event: resolvedMissingEvent,
            preserveWholeBaseline: independentWholeBaseline,
        };
    }
    const partial = compressedPartial;
    if (!partial) return recoverRobustCompactPartial();
    const constrainedCache = createLagPathCache();
    const constrainedHead = locateSequentialMissingHead(
        cofechaDiagnosis,
        siteData,
        { minLag: -2, maxPartialGapYears: 2 },
        constrainedCache,
        0,
    );
    if (!constrainedHead) return recoverRobustCompactPartial();
    const staircase = locateTwoStepMissingStaircase(
        cofechaDiagnosis,
        siteData,
        partial,
        { minLag: -2, maxPartialGapYears: 2 },
        constrainedCache,
    );
    const competition = comparePartialMoveWithMissingStaircase(
        cofechaDiagnosis,
        siteData,
        partial,
        true,
        constrainedHead.year,
    );
    if (!supportsDiscreteMissingStaircase(competition, staircase)) {
        return recoverRobustCompactPartial();
    }
    const marker = selectSharedZeroMarkerForMode(
        siteData,
        diagnosis.targetTree,
        constrainedHead.year,
        markerMode,
        2,
    );
    const hasIndependentMissingCandidate = candidateEvents.some(
        (event) => event.eventType === "missingRing",
    );
    const hasCandidateBackedExactPartial = isCandidateBackedExactPartial(partial);
    // A separated two-ring fit has more degrees of freedom than one physical gap. When COFECHA
    // and the lag path independently agree on the exact direct step, require a unit-specific
    // anchor before replacing it with a missing-ring operation.
    if (hasCandidateBackedExactPartial
        && !hasIndependentMissingCandidate
        && marker === null) return recoverRobustCompactPartial();
    return {
        event: addExplicitStaircaseCompetitionEvidence(makeSequentialMissingHeadEvent(
            constrainedHead,
            marker,
            detected,
            diagnosis,
            candidates,
            [],
            preferredLocationCenters,
            confirmedTargetZeroYears,
            markerMode,
        ), competition!, staircase!),
        preserveWholeBaseline: false,
    };
};

const recoverCollapsedMissingStaircaseHead = (
    events: DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
): DiagnosisEvent | null => {
    if (events.length < 3) return null;
    if (!events.some((event) => event.eventType === "missingRing")) return null;
    if (events.some((event) => (
        event.eventType === "falseRing"
        || event.eventType === "wholeSeriesMove"
        || event.evidence.lagBefore === null
        || event.evidence.lagAfter === null
        || event.evidence.lagBefore >= event.evidence.lagAfter
        || event.evidence.lagAfter > 0
    ))) return null;
    const newest = events.slice().sort((left, right) => (
        right.endYear - left.endYear || right.evidence.score - left.evidence.score
    ))[0];
    if (
        newest.eventType !== "partialMove"
        || newest.evidence.lagAfter !== 0
        || (newest.evidence.lagBefore ?? 0) > -2
    ) return null;

    const ranked = newest.rankedYears.slice().sort((left, right) => left.rank - right.rank);
    const partialFirstFixedYear = ranked[0]?.year
        ?? Math.round((newest.startYear + newest.endYear) / 2);
    const missingYear = partialFirstFixedYear - 1;
    const width = newest.endYear - newest.startYear + 1;
    let startYear = missingYear - Math.floor((width - 1) / 2);
    startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(startYear, diagnosis.targetRange.endYear - width + 1),
    );
    const endYear = startYear + width - 1;
    const projected: DiagnosisEvent = {
        ...newest,
        id: `${newest.id}-collapsed-missing-head`,
        eventType: "missingRing",
        startYear,
        endYear,
        rankedYears: newest.rankedYears
            .map((row) => ({ ...row, year: row.year - 1 }))
            .filter((row) => row.year >= startYear && row.year <= endYear)
            .sort((left, right) => left.rank - right.rank)
            .map((row, index) => ({ ...row, rank: index + 1 })),
        evidence: {
            ...newest.evidence,
            algorithmSources: Array.from(new Set([
                ...newest.evidence.algorithmSources,
                "collapsed_missing_staircase_head",
            ])).sort(),
            lagBefore: -1,
            lagAfter: 0,
            notes: [
                ...newest.evidence.notes,
                `collapsed_staircase_lag_before=${newest.evidence.lagBefore}`,
                "collapsed_staircase_lag_after=0",
                `collapsed_staircase_transition_count=${events.length}`,
                `collapsed_staircase_missing_year=${missingYear}`,
            ],
        },
    };
    delete projected.shiftYears;
    delete projected.shiftSide;
    return projected;
};

const isCollapsedNegativeHead = (events: DiagnosisEvent[]): boolean => {
    if (events.length !== 1) return false;
    const [event] = events;
    return event.eventType === "partialMove"
        && event.evidence.lagAfter === 0
        && (event.evidence.lagBefore ?? 0) <= -2;
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

export const passesLongPulsePairGate = (
    vote: AdjacentUnitPairVote,
    localizedVote: AdjacentUnitPairVote,
    pulseDurationYears: number,
): boolean => (
    Number.isFinite(pulseDurationYears)
    && pulseDurationYears >= 15
    && pulseDurationYears <= 70
    && vote.gain >= 0.012
    && vote.remoteMargin >= 0.0045
    && localizedVote.gain >= 0.2
    && localizedVote.remoteMargin >= 0.075
    && localizedVote.referenceCount >= 7
    && localizedVote.positiveReferenceFraction >= 0.999
    && localizedVote.lowerQuartileReferenceGain >= 0.15
    && localizedVote.jointExcessGain >= 0.25
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

export const shouldReplaceUnanchoredPartialWithReferencePulse = (
    partialEvents: readonly DiagnosisEvent[],
    existingUnitEvents: readonly DiagnosisEvent[],
    pulseEvents: readonly DiagnosisEvent[],
    hasWholeCandidate: boolean,
): boolean => {
    if (hasWholeCandidate
        || existingUnitEvents.length > 0
        || partialEvents.length !== 1
        || pulseEvents.length !== 2) return false;
    const partial = partialEvents[0];
    if (partial.eventType !== "partialMove"
        || partial.shiftYears !== -2
        || partial.evidence.candidateIds.length > 0
        || partial.evidence.algorithmSources.some((source) => [
            "candidate_backed_partial_consensus",
            "cofecha_segment_lag",
            "counterfactual_operation_verification",
            "local_corrected_raw_breakpoint",
            "unique_repeated_block_boundary",
        ].includes(source))) return false;
    const pulseTypes = new Set(pulseEvents.map((event) => event.eventType));
    return pulseTypes.size === 2
        && pulseTypes.has("missingRing")
        && pulseTypes.has("falseRing")
        && pulseEvents.every((event) => (
            event.evidence.algorithmSources.includes("reference_core_pair_voting")
            && (
                event.evidence.algorithmSources.includes("bounded_lag_pulse")
                || event.evidence.algorithmSources.includes("localized_reference_pair")
            )
        ));
};

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
    const pulseAttempts: Array<Partial<EventPathConfig>> = [
        {
            maxPulseYears: 14,
            maxPulseCount: 1,
            minPulseGain: 3,
            minPulseContextGain: 0.3,
        },
        {
            minPulseYears: 15,
            maxPulseYears: 70,
            maxPulseCount: 1,
            minPulseGain: 2,
            minPulseContextGain: 0.2,
        },
    ];
    for (const pulseAttempt of pulseAttempts) {
        const pulseEvents = diagnoseLagPath(diagnosis, siteData, {
            ...eventPathConfig,
            ...pulseAttempt,
            enablePulseScan: true,
        }, pathCache).events.filter((event) => (
            event.evidence.algorithmSources.includes("bounded_lag_pulse")
        ));
        if (pulseEvents.length !== 2) continue;
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
                const passesLongPulseGate = localizedVote !== null
                    && passesLongPulsePairGate(
                        vote,
                        localizedVote,
                        pulseDurationYears,
                    );
                if (localizedVote && (
                    passesStandardGate
                    || passesStrongLocalConsensus
                    || passesJointNecessityGate
                    || passesLongPulseGate
                )) {
                    return annotate(
                        vote.events.map((event) => ({
                            ...event,
                            evidence: {
                                ...event.evidence,
                                algorithmSources: Array.from(new Set([
                                    ...event.evidence.algorithmSources,
                                    ...(passesLongPulseGate
                                        ? ["long_pulse_consensus"]
                                        : []),
                                ])).sort(),
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
                                            : passesJointNecessityGate
                                                ? "joint_necessity"
                                                : "long_pulse_consensus"}`,
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
    audit?: DiagnosisEventPassAudit,
    rawPathEventsOut?: { events: DiagnosisEvent[] },
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
    let ownCandidates = candidates.filter((candidate) => candidate.targetTree === diagnosis.targetTree);
    let candidateEvents = makeDiagnosisEventsFromCandidates([diagnosis], ownCandidates);
    const cofechaDiagnosis = diagnoseSeriesCore(
        siteData,
        diagnosis.targetTree,
        effectiveConfig,
        cofechaPreprocess,
    );
    if (!cofechaDiagnosis) {
        if (audit) audit.finalEventCount = candidateEvents.length;
        return candidateEvents;
    }
    if (audit) audit.cofechaDiagnosisAvailable = true;
    const pathDiagnosis = diagnoseLagPath(
        cofechaDiagnosis,
        siteData,
        eventPathConfig,
        pathCache,
    );
    const pathHasWholeSeriesBaseline = pathDiagnosis.events.some(
        (event) => event.eventType === "wholeSeriesMove",
    );
    let pathEvents = pathDiagnosis.events.map((event) => (
        addCompressedMissingStaircaseEvidence(
            event,
            cofechaDiagnosis,
            siteData,
            eventPathConfig,
            pathCache,
            pathHasWholeSeriesBaseline,
        )
    ));
    const primaryCollapsedMissingHead = recoverCollapsedMissingStaircaseHead(
        pathEvents,
        diagnosis,
    );
    if (primaryCollapsedMissingHead) {
        pathEvents = [primaryCollapsedMissingHead];
    } else if (
        isCollapsedNegativeHead(pathEvents)
        || (
            pathEvents.length === 0
            && cofechaDiagnosis.globalSlidingMatch.bestGlobalLag <= -2
        )
    ) {
        const relaxedPathEvents = diagnoseLagPath(cofechaDiagnosis, siteData, {
            ...eventPathConfig,
            transitionPenaltyUnit: Math.min(eventPathConfig.transitionPenaltyUnit ?? 6, 6),
            transitionPenaltyBig: Math.min(eventPathConfig.transitionPenaltyBig ?? 7, 7),
            transitionPenaltyPerYear: Math.min(
                eventPathConfig.transitionPenaltyPerYear ?? 1,
                1,
            ),
            minRunYears: Math.min(eventPathConfig.minRunYears ?? 10, 10),
        }, pathCache).events;
        const collapsedMissingHead = recoverCollapsedMissingStaircaseHead(
            relaxedPathEvents,
            diagnosis,
        );
        if (collapsedMissingHead) pathEvents = [collapsedMissingHead];
    }
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
    if (audit) audit.lagPathEventCount = pathEvents.length;
    const rawPathEvents = diagnoseLagPath(diagnosis, siteData, {
        ...eventPathConfig,
        useCofechaStandardization: false,
        enablePulseScan: false,
    }, pathCache).events;
    if (rawPathEventsOut) rawPathEventsOut.events = rawPathEvents;
    if (audit) audit.rawLagPathEventCount = rawPathEvents.length;
    // Local event extraction uses the COFECHA-core diagnosis above. The fixed-side baseline must
    // retain the original diagnosis identity, otherwise mixed events can be standardized twice
    // and a residual local state can replace the true whole-series lag.
    const fixedSidePathDiagnosis = diagnoseLagPath(
        diagnosis,
        siteData,
        eventPathConfig,
        pathCache,
    );
    const cofechaFixedSideWholeCandidate = evaluatePathFixedSideWholeCandidate(
        siteData,
        diagnosis,
        pathDiagnosis.events,
        effectiveConfig,
        {
            lag: pathDiagnosis.newestLag,
            margin: pathDiagnosis.newestLagMargin,
            pairs: pathDiagnosis.newestLagPairs,
        },
    );
    const directFixedSideWholeCandidate = evaluatePathFixedSideWholeCandidate(
        siteData,
        diagnosis,
        fixedSidePathDiagnosis.events,
        effectiveConfig,
        {
            lag: fixedSidePathDiagnosis.newestLag,
            margin: fixedSidePathDiagnosis.newestLagMargin,
            pairs: fixedSidePathDiagnosis.newestLagPairs,
        },
    );
    const recentTailLag = measureRecentTailLagConsensus(diagnosis, effectiveConfig);
    const directShift = directFixedSideWholeCandidate?.deltaYears
        ?? directFixedSideWholeCandidate?.suggestedLag;
    const cofechaShift = cofechaFixedSideWholeCandidate?.deltaYears
        ?? cofechaFixedSideWholeCandidate?.suggestedLag;
    const cofechaTags = cofechaFixedSideWholeCandidate?.evidence.recallSourceTags ?? [];
    const crossViewResidualShift = Number.isInteger(directShift)
        && Number.isInteger(cofechaShift)
        ? cofechaShift! - directShift!
        : 0;
    const directTailExplainsResidualPartial = directFixedSideWholeCandidate !== null
        && recentTailLag !== null
        && directFixedSideWholeCandidate.evidence.recallSourceTags?.includes(
            "recent_tail_whole_baseline",
        ) === true
        && recentTailLag.lag === directShift
        && recentTailLag.supportCount === recentTailLag.rows.length
        && recentTailLag.competingSupportCount === 0
        && (cofechaTags.includes("path_fixed_side_event_type:missingRing")
            || cofechaTags.includes("path_fixed_side_event_type:falseRing"))
        && crossViewResidualShift <= -2
        && crossViewResidualShift >= -effectiveConfig.maxPartialGapYears;
    const crossViewTailCandidate = directTailExplainsResidualPartial
        ? {
            ...directFixedSideWholeCandidate,
            evidence: {
                ...directFixedSideWholeCandidate.evidence,
                recallSourceTags: Array.from(new Set([
                    ...(directFixedSideWholeCandidate.evidence.recallSourceTags ?? []),
                    "recent_tail_residual_partial_baseline",
                    `recent_tail_cross_view_path_lag:${cofechaShift}`,
                    `recent_tail_cross_view_residual_partial_shift:${crossViewResidualShift}`,
                ])),
            },
        }
        : directFixedSideWholeCandidate;
    const pathWholeCandidate = [
        cofechaFixedSideWholeCandidate,
        crossViewTailCandidate,
    ].filter((candidate): candidate is DiagnosisCandidateOperation => candidate !== null)
        .sort((left, right) => (
            wholeBaselineCandidatePriority(right) - wholeBaselineCandidatePriority(left)
            || right.score - left.score
        ))[0] ?? null;
    const fixedSideCandidateCanOverride = (
        candidate: DiagnosisCandidateOperation | null,
    ): candidate is DiagnosisCandidateOperation => {
        if (!candidate) return false;
        if (candidate.evidence.recallSourceTags?.includes(
            "recent_tail_whole_baseline",
        )) return true;
        const shiftYears = candidate.deltaYears ?? candidate.suggestedLag;
        if (!Number.isInteger(shiftYears)) return false;
        return measureWholeSeriesStateConsistency(
            diagnosis,
            shiftYears!,
        ).newestLag !== 0;
    };
    const upsertWholeBaselineCandidate = (
        pool: DiagnosisCandidateOperation[],
        candidate: DiagnosisCandidateOperation,
    ): DiagnosisCandidateOperation[] => {
        const shiftYears = candidate.deltaYears ?? candidate.suggestedLag;
        const sameHypothesis = (existing: DiagnosisCandidateOperation): boolean => (
            existing.operationType === "SHIFT_RANGE"
            && existing.mode === "wholeSeriesMove"
            && (existing.deltaYears ?? existing.suggestedLag) === shiftYears
        );
        const existing = pool.filter(sameHypothesis);
        if (existing.length === 0) return [...pool, candidate];
        const strongest = [candidate, ...existing].sort((left, right) => (
            wholeBaselineCandidatePriority(right) - wholeBaselineCandidatePriority(left)
            || right.score - left.score
        ))[0];
        return strongest === candidate
            ? [...pool.filter((row) => !sameHypothesis(row)), candidate]
            : pool;
    };
    if (fixedSideCandidateCanOverride(pathWholeCandidate)) {
        ownCandidates = upsertWholeBaselineCandidate(ownCandidates, pathWholeCandidate);
        if (options.supplementalCandidates) {
            const supplemented = upsertWholeBaselineCandidate(
                options.supplementalCandidates,
                pathWholeCandidate,
            );
            options.supplementalCandidates.splice(
                0,
                options.supplementalCandidates.length,
                ...supplemented,
            );
        }
        candidateEvents = makeDiagnosisEventsFromCandidates(
            [diagnosis],
            ownCandidates,
        );
    }
    if (audit) audit.candidateEventCount = candidateEvents.length;
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
    // A candidate-only deletion that deepens the negative lag is the opposite of a
    // false-ring correction. Path-backed cases remain eligible for local arbitration.
    const candidateFalse = typeEvents(candidateEvents, "falseRing")
        .filter((event) => !shouldSuppressSelfWorseningCandidateFalseRing(
            event,
            pathFalse.length > 0,
        ));
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

    const pathPartialEvents = typeEvents(pathEvents, "partialMove")
        .map((event) => withCandidateSupport(event, candidateEvents));
    const candidateBackedPartial = !hasWholeCandidate
        ? recoverCandidateBackedPartialConsensus(
            candidateEvents,
            diagnosis,
            effectiveConfig.maxPartialGapYears,
        )
        : null;
    const pathAgreesWithCandidate = candidateBackedPartial !== null
        && pathPartialEvents.some((event) => (
            event.shiftYears === candidateBackedPartial.shiftYears
        ));
    const primaryPartialEvents = candidateBackedPartial && !pathAgreesWithCandidate
        ? [candidateBackedPartial]
        : pathPartialEvents;
    let partialEvents = locateMultiviewPartialEvents(
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
    if (partialEvents.length === 1
        && missingEvents.length === 0
        && falseEvents.length === 0
        && !hasWholeCandidate) {
        const verifiedPulse = referenceVerifiedFallback();
        if (shouldReplaceUnanchoredPartialWithReferencePulse(
            partialEvents,
            [...missingEvents, ...falseEvents],
            verifiedPulse,
            hasWholeCandidate,
        )) {
            partialEvents = [];
            missingEvents = verifiedPulse.filter((event) => (
                event.eventType === "missingRing"
            ));
            falseEvents = verifiedPulse.filter((event) => (
                event.eventType === "falseRing"
            ));
        }
    }
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
    const lateFixedSideWholeCandidate = evaluatePathFixedSideWholeCandidate(
        siteData,
        diagnosis,
        [...partialEvents, ...missingEvents, ...falseEvents],
        effectiveConfig,
        {
            lag: pathDiagnosis.newestLag,
            margin: pathDiagnosis.newestLagMargin,
            pairs: pathDiagnosis.newestLagPairs,
        },
    );
    if (fixedSideCandidateCanOverride(lateFixedSideWholeCandidate)) {
        ownCandidates = upsertWholeBaselineCandidate(
            ownCandidates,
            lateFixedSideWholeCandidate,
        );
        if (options.supplementalCandidates) {
            const supplemented = upsertWholeBaselineCandidate(
                options.supplementalCandidates,
                lateFixedSideWholeCandidate,
            );
            options.supplementalCandidates.splice(
                0,
                options.supplementalCandidates.length,
                ...supplemented,
            );
        }
        candidateEvents = makeDiagnosisEventsFromCandidates(
            [diagnosis],
            ownCandidates,
        );
    }
    const wholeCandidate = typeEvents(candidateEvents, "wholeSeriesMove")[0];
    const unitEventsBeforeWholeSelection = [...missingEvents, ...falseEvents];
    const wholeAliasUnitIds = new Set(
        wholeCandidate
            ? unitEventsBeforeWholeSelection
                .filter((event) => unitEventExplainsWholeSeriesCandidate(
                    wholeCandidate,
                    event,
                ))
                .map((event) => event.id)
            : [],
    );
    const wholeEvents = keepWholeSeriesEvent(
        wholeCandidate,
        partialEvents,
        unitEventsBeforeWholeSelection,
        pathDiagnosis,
    );
    const hasOnlyUnitEvents = partialEvents.length === 0 && wholeEvents.length === 0;
    const refinedUnitEvents = refineUnitEventWindows(
        unitEventsBeforeWholeSelection.map((event) => (
            wholeAliasUnitIds.has(event.id)
                ? {
                    ...event,
                    evidence: {
                        ...event.evidence,
                        algorithmSources: Array.from(new Set([
                            ...event.evidence.algorithmSources,
                            "newer_endpoint_unit_alias_of_global_lag",
                        ])).sort(),
                        notes: [
                            ...event.evidence.notes,
                            "whole_series_candidate=local_unit_alias",
                        ],
                    },
                }
                : event
        )),
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
                {
                    preferRemotePairedMissingFrontier:
                        options.preferRemotePairedMissingFrontier === true,
                },
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
    const assembledEvents = pruneUnanchoredUnitAlternativesToCandidatePartial([
        ...scoredUnitEvents,
        ...partialEvents,
        ...wholeEvents,
    ]);
    if (audit) audit.assembledEventCount = assembledEvents.length;
    const coherentAssembledEvents = options.enableIncoherentPartialPruning === true
        ? pruneIncoherentPartialSupplements(assembledEvents)
        : assembledEvents;
    const jointRefinedEvents = refineEventYearsJointly(
        coherentAssembledEvents,
        diagnosis,
        siteData,
        options.jointEventRefinementConfig,
    );
    if (audit) audit.jointRefinedEventCount = jointRefinedEvents.length;
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
    if (audit) audit.referenceVotedEventCount = votedEvents.length;
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
    if (audit) audit.recoveredEventCount = recoveredEvents.length;
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
    if (audit) audit.finalEventCount = eventsWithLocationAlternatives.length;
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
    audit?: DiagnosisEventPassAudit,
    rawPathEventsOut?: { events: DiagnosisEvent[] },
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
    const primaryAudit = emptyEventPassAudit();
    const primaryRawPathEvents = { events: [] as DiagnosisEvent[] };
    const primary = eventsForSeriesPass(
        siteData,
        diagnosis,
        candidates,
        effectiveConfig,
        passOptions,
        primaryAudit,
        primaryRawPathEvents,
    );
    if (options.enableMixedReferenceSupplement !== true || primary.length === 0) {
        const selected = keepStrongestPartialMove(primary);
        primaryAudit.finalEventCount = selected.length;
        if (audit) copyEventPassAudit(audit, primaryAudit, "primary");
        if (rawPathEventsOut) rawPathEventsOut.events = primaryRawPathEvents.events;
        return selected;
    }
    if (!shouldRunMixedReferencePass(primary)) {
        const selected = keepStrongestPartialMove(primary);
        primaryAudit.finalEventCount = selected.length;
        if (audit) copyEventPassAudit(audit, primaryAudit, "primary");
        if (rawPathEventsOut) rawPathEventsOut.events = primaryRawPathEvents.events;
        return selected;
    }
    const alternateAudit = emptyEventPassAudit();
    const alternateRawPathEvents = { events: [] as DiagnosisEvent[] };
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
        alternateAudit,
        alternateRawPathEvents,
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
        const selected = keepStrongestPartialMove(primary);
        primaryAudit.finalEventCount = selected.length;
        if (audit) copyEventPassAudit(audit, primaryAudit, "primary");
        if (rawPathEventsOut) rawPathEventsOut.events = primaryRawPathEvents.events;
        return selected;
    }
    const selected = keepStrongestPartialMove(alternate.map((event) => ({
        ...event,
        evidence: {
            ...event.evidence,
            notes: [
                ...event.evidence.notes,
                "mixed_reference_counterfactual_selected",
            ],
        },
    })));
    alternateAudit.finalEventCount = selected.length;
    if (audit) copyEventPassAudit(audit, alternateAudit, "mixed");
    if (rawPathEventsOut) rawPathEventsOut.events = alternateRawPathEvents.events;
    return selected;
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

type ContinuedEdgeRecenterShift = -2 | 0 | 2;

/** Recenters only after two same-direction edge advances and a retained continuation window. */
export const selectFalseRingContinuedEdgeRecenterShift = (
    event: DiagnosisEvent,
): ContinuedEdgeRecenterShift => {
    if (event.eventType !== "falseRing"
        || event.endYear - event.startYear + 1 !== 9
        || !event.evidence.algorithmSources.includes("edge_rank_guard")
        || !event.evidence.algorithmSources.includes("continued_edge_guard_location")
        || !event.evidence.notes.includes("window_refinement=joint_event_edge_nudge")) {
        return 0;
    }
    const topYear = [...event.rankedYears]
        .sort((left, right) => left.rank - right.rank)[0]?.year;
    if (topYear === undefined) return 0;
    const centerYear = Math.floor((event.startYear + event.endYear) / 2);
    const shift = topYear - centerYear;
    if (shift !== -2 && shift !== 2) return 0;
    const direction = Math.sign(shift);
    const priorWindows = event.evidence.notes.flatMap((note) => {
        const match = note.match(/^window_before=(-?\d+)-(-?\d+)$/);
        return match ? [{ startYear: Number(match[1]), endYear: Number(match[2]) }] : [];
    });
    const [olderWindow, newerWindow] = priorWindows.slice(-2);
    if (!olderWindow || !newerWindow
        || newerWindow.startYear - olderWindow.startYear !== direction
        || newerWindow.endYear - olderWindow.endYear !== direction
        || (direction > 0 ? topYear !== newerWindow.endYear : topYear !== newerWindow.startYear)
        || (direction > 0
            ? event.startYear !== newerWindow.startYear
                || event.endYear !== newerWindow.endYear + 2
            : event.startYear !== newerWindow.startYear - 2
                || event.endYear !== newerWindow.endYear)) {
        return 0;
    }
    const hasContinuation = event.locationAlternatives?.some((location) => (
        direction > 0
            ? location.endYear === event.endYear + 2
            : location.startYear === event.startYear - 2
    )) ?? false;
    return hasContinuation ? shift : 0;
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
    direction: -2 | -1 | 1 | 2,
    algorithmSource = "false_ring_directional_consensus_window_shift",
    refinement = "false_ring_directional_consensus_shift",
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
                algorithmSource,
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                `window_refinement=${refinement}`,
                `false_ring_window_shift=${direction}`,
            ],
        },
    };
};

const recenterFalseRingContinuedEdgeMainWindow = (
    event: DiagnosisEvent,
): DiagnosisEvent => {
    const shift = selectFalseRingContinuedEdgeRecenterShift(event);
    return shift === 0
        ? event
        : shiftMainWindow(
            event,
            shift,
            "false_ring_continued_edge_recenter",
            "false_ring_continued_edge_recenter",
        );
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
    const continuedEdgeRecentered = recenterFalseRingContinuedEdgeMainWindow(
        displayedEvent,
    );
    if (continuedEdgeRecentered !== displayedEvent) {
        displayedEvent = continuedEdgeRecentered;
    } else {
        const falseRingWindowShift = selectFalseRingConsensusWindowShift(displayedEvent);
        if (falseRingWindowShift !== 0) {
            displayedEvent = shiftMainWindow(
                displayedEvent,
                falseRingWindowShift,
            );
        }
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
    const displayedEvent = recenterFalseRingContinuedEdgeMainWindow(event);
    const primary = {
        ...displayedEvent,
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
        const passAudit = emptyEventPassAudit();
        const ownCandidates = candidates.filter((candidate) => (
            candidate.targetTree === diagnosis.targetTree
        ));
        const candidateEvents = makeDiagnosisEventsFromCandidates(
            [diagnosis],
            ownCandidates,
        );
        const passRawPathEvents = { events: [] as DiagnosisEvent[] };
        const detectedBeforeFusion = eventsForSeries(
            siteData,
            diagnosis,
            candidates,
            effectiveConfig,
            options,
            passAudit,
            passRawPathEvents,
        );
        const fusedDetected = options.enableDecisiveJointOperationFusion === true
            ? applyDecisiveJointOperationFusion(
                detectedBeforeFusion,
                diagnosis,
                {
                    maxPartialGapYears: effectiveConfig.maxPartialGapYears,
                    ...options.eventOperationRecoveryConfig,
                },
                siteData,
                candidateEvents,
            )
            : detectedBeforeFusion;
        const coherentDetected = pruneLocalEventsDisconnectedFromWholeBaseline(
            fusedDetected,
        );
        const detected = pruneWholeSeriesPartialAliases(
            coherentDetected,
            diagnosis,
            effectiveConfig.maxPartialGapYears,
        );
        const retainedDetected = detected.filter((event) => (
            !isAutomaticOlderEndpointUnitEvent(event, diagnosis)
        ));
        const endpointUnits = retainedDetected.filter((event) => (
            event.eventType === "missingRing" || event.eventType === "falseRing"
        ));
        const endpointWhole = retainedDetected.find((event) => (
            event.eventType === "wholeSeriesMove"
        ));
        const forcedEndpointUnitId = endpointUnits.length === 1
            && endpointWhole
            && unitEventCompetesWithWholeAtNewerEndpoint(
                endpointWhole,
                endpointUnits[0],
            )
            ? endpointUnits[0].id
            : null;
        const endpointPrepared = forcedEndpointUnitId
            ? retainedDetected.map((event) => event.id === forcedEndpointUnitId
                ? {
                    ...event,
                    evidence: {
                        ...event.evidence,
                        algorithmSources: Array.from(new Set([
                            ...event.evidence.algorithmSources,
                            "newer_endpoint_unit_competitor_of_global_lag",
                        ])).sort(),
                        notes: [
                            ...event.evidence.notes,
                            "endpoint_test=unit_competitor_of_global_lag",
                        ],
                    },
                }
                : event)
            : retainedDetected;
        const locatorDecisionAudits: DiagnosisLocatorDecisionAudit[] = [];
        const endpointRefined = options.enableEndpointResidualWindow === true
            && endpointUnits.length === 1
            && !hasMultipleCoherentLocalTransitions(retainedDetected)
            && !unitEventUsesWholeSeriesBaseline(endpointWhole, endpointUnits[0])
            && !endpointUnits[0].evidence.algorithmSources.includes(
                "collapsed_missing_staircase_head",
            )
            ? endpointPrepared.map((event) => {
                if (event.id !== endpointUnits[0].id) return event;
                const proposed = refineUnitEventWithEndpointResidualWindow(
                    event,
                    diagnosis,
                    siteData,
                    endpointCache,
                );
                if (event.eventType !== "missingRing") return proposed;
                const decision = adjudicateLocatorProposal(event, proposed);
                locatorDecisionAudits.push({
                    reason: decision.reason,
                    accepted: decision.accepted,
                    overlapYears: decision.overlapYears,
                    centerDistanceYears: decision.centerDistanceYears,
                    operationContractValid: decision.operationContractValid,
                    detachedEvidenceStrong: decision.detachedEvidenceStrong,
                    structuredCheckpoint: decision.evidence.structuredCheckpoint,
                    structuredProposal: decision.evidence.structuredProposal,
                    precisionRegression: decision.precisionRegression,
                    checkpointTopYear: decision.evidence.checkpointTopYear,
                    proposedTopYear: decision.evidence.proposedTopYear,
                    checkpointWidth: decision.evidence.checkpointWidth,
                    proposedWidth: decision.evidence.proposedWidth,
                    preLocatorEvent: auditEvent(event),
                    proposedEvent: decision.proposedEvent
                        ? auditEvent(decision.proposedEvent)
                        : null,
                    selectedEvent: auditEvent(decision.event),
                });
                return decision.event;
            })
            : endpointPrepared;
        const projectedDisplayed = rerankMissingEventsNearExplicitZeros(
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
        const displayed = preserveNewestCandidateUnitCheckpoint(
            projectedDisplayed,
            candidateEvents,
            options.preferRemotePairedMissingFrontier === true,
        );
        const cofechaFlagged = isCofechaFlaggedSeries(
            diagnosis.targetTree,
            options.cofechaFlaggedSeriesIds,
        );
        const shouldFitBoundedPath = cofechaFlagged
            || ownCandidates.length > 0
            || detectedBeforeFusion.length > 0;
        const wholeBaselineHypotheses = [
            ...candidateEvents,
            ...detectedBeforeFusion,
            ...detected,
            ...displayed,
        ].filter((event) => event.eventType === "wholeSeriesMove");
        const independentlySupportedWholeHypotheses = wholeBaselineHypotheses.filter(
            (event) => {
                const claims = evidenceClaimsFor(event);
                const shiftYears = wholeSeriesMoveShiftYears(event);
                const stateConsistency = shiftYears === null
                    ? null
                    : measureWholeSeriesStateConsistency(diagnosis, shiftYears);
                return claims.has("whole_terminal_baseline")
                    || claims.has("whole_path_fixed_baseline")
                    || claims.has("whole_global_lag")
                    || (
                        stateConsistency !== null
                        && supportsNonTerminalWholeSeriesCandidate(stateConsistency)
                    )
                    || (
                        event.confidenceLevel === "high"
                        && (event.evidence.correlationGain
                            ?? Number.NEGATIVE_INFINITY) >= 0.1
                        && event.evidence.notes.includes("candidate_hard_gate_passed")
                        && event.evidence.notes.includes(
                            "whole_state_newer_edge_support_fraction=1.000000",
                        )
                    );
            },
        );
        const fixedFrameWholeHypotheses = independentlySupportedWholeHypotheses.filter(
            (event) => {
                const claims = evidenceClaimsFor(event);
                return claims.has("whole_terminal_baseline")
                    || claims.has("whole_path_fixed_baseline");
            },
        );
        const anchoredWholeHypotheses = fixedFrameWholeHypotheses.length > 0
            ? fixedFrameWholeHypotheses
            : independentlySupportedWholeHypotheses;
        const supportedWholeLags = [...new Set(
            anchoredWholeHypotheses.flatMap((event) => (
                event.shiftYears === undefined ? [] : [event.shiftYears]
            )),
        )];
        const globalTerminalLag = diagnosis.globalSlidingMatch.bestGlobalLag;
        const globalTerminalStateConsistency = globalTerminalLag === 0
            ? null
            : measureWholeSeriesStateConsistency(diagnosis, globalTerminalLag);
        const globallySupportedTerminalLag = globalTerminalStateConsistency
            && supportsNonTerminalWholeSeriesCandidate(
                globalTerminalStateConsistency,
            )
            ? globalTerminalLag
            : null;
        const boundedTerminalLags = supportedWholeLags.length > 0
            ? supportedWholeLags
            : globallySupportedTerminalLag === null
                ? [0]
                : [0, globallySupportedTerminalLag];
        const boundedOperationBaseline = boundedTerminalLags.length === 1
            ? boundedTerminalLags[0]
            : 0;
        const boundedOperations = shouldFitBoundedPath
            ? getJointCounterfactualOperationScores(
                diagnosis,
                15,
                effectiveConfig.maxPartialGapYears,
                boundedOperationBaseline,
            )
            : [];
        // The bounded path may legitimately use a non-zero terminal lag as a state baseline.
        // Completed local compositions instead compare edits against the fixed newer side, whose
        // residual baseline is zero after any whole-series correction has been exposed. Keeping
        // these tables separate prevents a remote terminal state from changing the operation
        // family considered by the composition adjudicator.
        const localCompositionOperations = shouldFitBoundedPath
            ? getJointCounterfactualOperationScores(
                diagnosis,
                15,
                effectiveConfig.maxPartialGapYears,
                0,
            )
            : [];
        const rankedBoundedOperations = boundedOperations
            .map((operation) => ({
                operation,
                score: scoreDynamicJointOperation(operation, boundedOperations),
            }))
            .sort((left, right) => (
                right.score - left.score
                || right.operation.bestDifferenceGain
                    - left.operation.bestDifferenceGain
                || right.operation.remoteDifferenceMargin
                    - left.operation.remoteDifferenceMargin
            ));
        const boundedOperationSelection = selectDynamicJointOperation(boundedOperations);
        const boundedUnitSelection = selectDynamicUnitOperation(boundedOperations);
        const localCompositionUnitSelection = selectDynamicUnitOperation(
            localCompositionOperations,
        );
        const trustedPartialOperation = boundedOperationSelection
            ?.operation.eventType === "partialMove"
            && boundedOperationSelection.score >= 0.04
            && boundedOperationSelection.scoreMargin >= 0.025
            && (boundedOperationSelection.shiftScoreMargin ?? 0) >= 0.01
            ? boundedOperationSelection.operation
            : null;
        const requiredUnitOperation = boundedUnitSelection
            && boundedUnitSelection.score >= 0.04
            && boundedUnitSelection.scoreMargin >= 0.02
            && (
                trustedPartialOperation === null
                || boundedUnitSelection.score >= boundedOperationSelection!.score * 0.5
            )
            ? boundedUnitSelection.operation
            : null;
        const boundedStateBaselines = [...new Set([
            ...boundedTerminalLags,
            0,
        ])];
        const boundedOperationStates = rankedBoundedOperations
            .slice(0, 12)
            .flatMap(({ operation }) => boundedStateBaselines.flatMap((terminalLag) => {
                const state = terminalLag + operation.shiftYears;
                return [state - 1, state, state + 1];
            }));
        const boundedComponentShifts = [...new Set([
            -1,
            1,
            ...rankedBoundedOperations
                .slice(0, 12)
                .map(({ operation }) => operation.shiftYears)
                .filter((shift) => shift !== 0),
        ])];
        const boundedCumulativeStates = boundedStateBaselines.flatMap((terminalLag) => {
            const states = new Set<number>();
            let frontier = new Set([terminalLag]);
            for (let depth = 0; depth < 4; depth += 1) {
                const next = new Set<number>();
                frontier.forEach((lag) => boundedComponentShifts.forEach((shift) => {
                    const state = lag + shift;
                    if (state < effectiveConfig.lagMin || state > effectiveConfig.lagMax) {
                        return;
                    }
                    states.add(state);
                    next.add(state);
                }));
                frontier = next;
            }
            return [...states];
        });
        const boundedUnitStates = requiredUnitOperation
            ? boundedStateBaselines.flatMap((terminalLag) => (
                [1, 2, 3].map((count) => (
                    terminalLag + requiredUnitOperation.shiftYears * count
                ))
            ))
            : [];
        const boundedContractStates = trustedPartialOperation
            ? [...boundedOperationStates, ...boundedCumulativeStates]
            : requiredUnitOperation
                ? [...boundedUnitStates, ...boundedCumulativeStates]
                : [...boundedOperationStates, ...boundedCumulativeStates];
        const boundedHypothesisStates = [
            ...candidateEvents,
            ...detectedBeforeFusion,
            ...detected,
            ...displayed,
        ].flatMap((event) => [
            event.evidence.lagBefore,
            event.evidence.lagAfter,
        ]).filter((lag): lag is number => lag !== null && lag !== undefined);
        const boundedRestrictedLags = [...new Set([
            ...boundedStateBaselines,
            ...boundedStateBaselines.flatMap((lag) => [lag - 1, lag + 1]),
            ...boundedContractStates,
            ...boundedHypothesisStates,
        ].filter((lag) => (
            lag >= effectiveConfig.lagMin && lag <= effectiveConfig.lagMax
        )))];
        const locateBoundedEvents = (
            useCofechaStandardization: boolean,
            allowedLags?: readonly number[],
            terminalLags: readonly number[] = boundedTerminalLags,
            transitionPenalty = 3,
            minimumTransitionGain = 2,
            forceFit = false,
            maxSegments = 5,
            minRunYears = 18,
        ): BoundedLagStateEventSet | null => (
            shouldFitBoundedPath || forceFit
                ? locateBoundedLagStateEvents(
                diagnosis,
                siteData,
                {
                    ...INTERNAL_EVENT_PATH_CONFIG,
                    useCofechaStandardization,
                    transitionPenaltyUnit: transitionPenalty,
                    transitionPenaltyBig: transitionPenalty,
                    transitionPenaltyPerYear: 0,
                    minLag: effectiveConfig.lagMin,
                    maxLag: effectiveConfig.lagMax,
                    maxPartialGapYears: effectiveConfig.maxPartialGapYears,
                    ...options.eventPathConfig,
                },
                {
                    maxSegments,
                    minRunYears,
                    windowWidth: 13,
                    terminalLags,
                    allowedLags,
                    minimumTransitionGain,
                    minimumWholeLagGain: 8,
                },
                locatorPathCache,
            )
                : null
        );
        const boundedFrameIsSupported = (
            result: BoundedLagStateEventSet | null,
        ): result is BoundedLagStateEventSet => {
            if (!result) return false;
            if (!boundedLagPathHasObservedFixedSide(result)) return false;
            const boundedWhole = result.events.find((event) => (
                event.eventType === "wholeSeriesMove"
            ));
            const boundedWholeShift = boundedWhole
                ? wholeSeriesMoveShiftYears(boundedWhole)
                : null;
            const globallyAnchoredWhole = boundedWholeShift !== null
                && boundedWholeShift === globallySupportedTerminalLag
                && result.path.wholeLagGain >= 8;
            return !boundedWhole
                || globallyAnchoredWhole
                || independentlySupportedWholeHypotheses.some((whole) => (
                    whole.shiftYears === boundedWholeShift
                ));
        };
        const hasBoundedLocalEvent = (result: BoundedLagStateEventSet): boolean => (
            result.events.some((event) => event.eventType !== "wholeSeriesMove")
        );
        const boundedResultSupport = (result: BoundedLagStateEventSet): {
            strongestOperationRepresented: boolean;
            operationScore: number;
            localEventCount: number;
            hasPartialTransition: boolean;
            directCorrections: ReadonlySet<number>;
            allTransitionsAreUnit: boolean;
        } => {
            const newestLag = result.path.runs[result.path.runs.length - 1]?.lag
                ?? boundedOperationBaseline;
            const representedCorrections = new Set([
                ...result.path.runs.slice(0, -1).map((run) => run.lag - newestLag),
                ...result.path.runs.slice(0, -1).map((run, index) => (
                    run.lag - result.path.runs[index + 1].lag
                )),
            ]);
            const represented = rankedBoundedOperations.filter(({ operation }) => (
                representedCorrections.has(operation.shiftYears)
            ));
            const directCorrections = new Set(result.path.runs.slice(0, -1).map(
                (run, index) => run.lag - result.path.runs[index + 1].lag,
            ));
            return {
                strongestOperationRepresented: rankedBoundedOperations.length === 0
                    || representedCorrections.has(
                        rankedBoundedOperations[0].operation.shiftYears,
                    ),
                operationScore: represented.reduce(
                    (sum, row) => sum + Math.max(0, row.score),
                    0,
                ),
                localEventCount: result.events.filter((event) => (
                    event.eventType !== "wholeSeriesMove"
                )).length,
                hasPartialTransition: result.events.some((event) => (
                    event.eventType === "partialMove"
                )),
                directCorrections,
                allTransitionsAreUnit: directCorrections.size > 0
                    && [...directCorrections].every((shift) => Math.abs(shift) === 1),
            };
        };
        const boundedResultIsOperationCompatible = (
            result: BoundedLagStateEventSet,
        ): boolean => {
            const support = boundedResultSupport(result);
            if (support.localEventCount === 0) return true;
            const hasSupportedWhole = result.events.some((event) => (
                event.eventType === "wholeSeriesMove"
                && (
                    supportedWholeLags.includes(event.shiftYears ?? 0)
                    || (
                        event.shiftYears === globallySupportedTerminalLag
                        && result.path.wholeLagGain >= 8
                    )
                )
            ));
            if (hasSupportedWhole && result.path.wholeLagGain >= 8) return true;
            const strongUnitPath = [...support.directCorrections].some(
                (shift) => Math.abs(shift) === 1,
            )
                && (
                    !support.hasPartialTransition
                    || (
                        trustedPartialOperation !== null
                        && support.strongestOperationRepresented
                    )
                )
                && result.path.transitionGain >= 8
                && result.path.runnerUpMargin >= 2;
            if (strongUnitPath) return true;
            if (trustedPartialOperation) {
                if (!support.strongestOperationRepresented) return false;
            }
            if (requiredUnitOperation
                && !support.directCorrections.has(requiredUnitOperation.shiftYears)) {
                const strongPathUnit = support.allTransitionsAreUnit
                    && result.path.transitionGain >= 8
                    && result.path.runnerUpMargin >= 2;
                if (!strongPathUnit) return false;
            }
            if (!support.hasPartialTransition) return true;
            return trustedPartialOperation !== null;
        };
        const preferBoundedResult = (
            left: BoundedLagStateEventSet,
            right: BoundedLagStateEventSet,
        ): BoundedLagStateEventSet => {
            const leftSupport = boundedResultSupport(left);
            const rightSupport = boundedResultSupport(right);
            const leftLocal = hasBoundedLocalEvent(left);
            const rightLocal = hasBoundedLocalEvent(right);
            if (leftLocal !== rightLocal) return leftLocal ? left : right;
            if (trustedPartialOperation) {
                const leftDirect = leftSupport.directCorrections.has(
                    trustedPartialOperation.shiftYears,
                );
                const rightDirect = rightSupport.directCorrections.has(
                    trustedPartialOperation.shiftYears,
                );
                if (leftDirect !== rightDirect) {
                    const direct = leftDirect ? left : right;
                    const decomposed = leftDirect ? right : left;
                    if (direct.path.transitionGain > decomposed.path.transitionGain
                        || direct.path.runnerUpMargin > decomposed.path.runnerUpMargin) {
                        return direct;
                    }
                    return decomposed;
                }
            }
            if (leftSupport.allTransitionsAreUnit !== rightSupport.allTransitionsAreUnit) {
                return leftSupport.allTransitionsAreUnit ? left : right;
            }
            if (right.path.transitionGain > left.path.transitionGain
                && right.path.runnerUpMargin > left.path.runnerUpMargin) {
                return right;
            }
            // The left argument is the more stable COFECHA view at every call site.
            return left;
        };
        const preferCofechaTerminalFrame = (
            supportedTerminal: BoundedLagStateEventSet,
            zeroTerminal: BoundedLagStateEventSet,
        ): BoundedLagStateEventSet => {
            const terminalHasWhole = supportedTerminal.events.some((event) => (
                event.eventType === "wholeSeriesMove"
            ));
            const zeroHasWhole = zeroTerminal.events.some((event) => (
                event.eventType === "wholeSeriesMove"
            ));
            if (terminalHasWhole && !zeroHasWhole) {
                return zeroTerminal.path.score > supportedTerminal.path.score
                    && zeroTerminal.path.runnerUpMargin
                        > supportedTerminal.path.runnerUpMargin
                    ? zeroTerminal
                    : supportedTerminal;
            }
            return preferBoundedResult(supportedTerminal, zeroTerminal);
        };
        const initialCofechaBoundedResult = locateBoundedEvents(true);
        const zeroTerminalCofechaResult = boundedTerminalLags.some((lag) => lag !== 0)
            ? locateBoundedEvents(true, undefined, [0])
            : null;
        const supportedInitialCofecha = boundedFrameIsSupported(
            initialCofechaBoundedResult,
        ) && boundedResultIsOperationCompatible(initialCofechaBoundedResult)
            ? initialCofechaBoundedResult
            : null;
        const supportedZeroTerminalCofecha = boundedFrameIsSupported(
            zeroTerminalCofechaResult,
        ) && boundedResultIsOperationCompatible(zeroTerminalCofechaResult)
            ? zeroTerminalCofechaResult
            : null;
        const cofechaBoundedResult = supportedInitialCofecha
            && supportedZeroTerminalCofecha
            ? preferCofechaTerminalFrame(
                    supportedInitialCofecha,
                    supportedZeroTerminalCofecha,
                )
            : supportedInitialCofecha ?? supportedZeroTerminalCofecha;
        const supportedCofechaResult = boundedFrameIsSupported(cofechaBoundedResult)
            && boundedResultIsOperationCompatible(cofechaBoundedResult)
            ? cofechaBoundedResult
            : null;
        const needsRawBoundedView = supportedCofechaResult === null
            || trustedPartialOperation !== null;
        const rawBoundedResult = needsRawBoundedView
            ? locateBoundedEvents(false)
            : null;
        const supportedRawResult = boundedFrameIsSupported(rawBoundedResult)
            && boundedResultIsOperationCompatible(rawBoundedResult)
            ? rawBoundedResult
            : null;
        const unrestrictedBoundedResult = supportedCofechaResult && supportedRawResult
            ? preferBoundedResult(supportedCofechaResult, supportedRawResult)
            : supportedCofechaResult ?? supportedRawResult;
        const unrestrictedSupport = unrestrictedBoundedResult
            ? boundedResultSupport(unrestrictedBoundedResult)
            : null;
        const needsRestrictedBoundedView = unrestrictedBoundedResult === null
            || (
                requiredUnitOperation !== null
                && !unrestrictedSupport?.directCorrections.has(
                    requiredUnitOperation.shiftYears,
                )
                && !(
                    unrestrictedSupport !== null
                    && [...unrestrictedSupport.directCorrections].some(
                        (shift) => Math.abs(shift) === 1,
                    )
                    && (
                        !unrestrictedSupport.hasPartialTransition
                        || (
                            trustedPartialOperation !== null
                            && unrestrictedSupport.strongestOperationRepresented
                        )
                    )
                    && unrestrictedBoundedResult.path.transitionGain >= 8
                    && unrestrictedBoundedResult.path.runnerUpMargin >= 2
                )
            );
        const restrictedTerminalCofechaResult = needsRestrictedBoundedView
            ? locateBoundedEvents(true, boundedRestrictedLags)
            : null;
        const restrictedZeroTerminalCofechaResult = needsRestrictedBoundedView
            && boundedTerminalLags.some((lag) => lag !== 0)
            ? locateBoundedEvents(true, boundedRestrictedLags, [0])
            : null;
        const supportedRestrictedTerminalCofecha = boundedFrameIsSupported(
            restrictedTerminalCofechaResult,
        ) && boundedResultIsOperationCompatible(restrictedTerminalCofechaResult)
            ? restrictedTerminalCofechaResult
            : null;
        const supportedRestrictedZeroTerminalCofecha = boundedFrameIsSupported(
            restrictedZeroTerminalCofechaResult,
        ) && boundedResultIsOperationCompatible(restrictedZeroTerminalCofechaResult)
            ? restrictedZeroTerminalCofechaResult
            : null;
        const supportedRestrictedCofecha = supportedRestrictedTerminalCofecha
            && supportedRestrictedZeroTerminalCofecha
            ? preferCofechaTerminalFrame(
                    supportedRestrictedTerminalCofecha,
                    supportedRestrictedZeroTerminalCofecha,
                )
            : supportedRestrictedTerminalCofecha
                ?? supportedRestrictedZeroTerminalCofecha;
        const selectedBoundedResult = supportedRestrictedCofecha
            ?? unrestrictedBoundedResult;
        const jointlyLocatedBoundedEvents = selectedBoundedResult
            ? refineEventYearsJointly(
                selectedBoundedResult.events,
                diagnosis,
                siteData,
                {
                    candidateRadiusYears: 3,
                    refinePartialLocations: false,
                },
            )
            : [];
        const boundedPathEvents = jointlyLocatedBoundedEvents.map((event) => (
            refineBoundedPathLocationWithOperation(
                event,
                boundedOperations,
                diagnosis.targetRange,
            )
        )) ?? [];
        const boundedHypotheses = [
            ...candidateEvents,
            ...detectedBeforeFusion,
            ...detected,
            ...displayed,
        ];
        const needsStableMultiscaleBoundedPath = shouldFitBoundedPath && (
            boundedHypotheses.some((event) => (
                event.eventType === "wholeSeriesMove"
                || (event.eventType === "partialMove"
                    && Math.abs(event.shiftYears ?? 0) >= 2)
            ))
            || (initialCofechaBoundedResult?.events.filter((event) => (
                event.eventType !== "wholeSeriesMove"
            )).length ?? 0) >= 2
            || (rawBoundedResult?.events.filter((event) => (
                event.eventType !== "wholeSeriesMove"
            )).length ?? 0) >= 2
        );
        const terminalBaselineLag = boundedTerminalLags.length === 1
            ? boundedTerminalLags[0]
            : 0;
        const hasAuthoritativeWholeBaseline = wholeBaselineHypotheses.some(
            isAuthoritativeWholeSeriesCheckpoint,
        );
        const rawTerminalAliasProbe = needsStableMultiscaleBoundedPath
            && terminalBaselineLag !== 0
            ? rawBoundedResult ?? locateBoundedEvents(false)
            : null;
        const terminalLocalTransitionHasIndependentOperationSupport =
            rawTerminalAliasProbe?.events.some((event) => {
                const transitionShift = lagPathTransitionShift(event);
                if (transitionShift === null || event.evidence.lagAfter !== terminalBaselineLag) {
                    return false;
                }
                return (
                    requiredUnitOperation !== null
                    && event.eventType === requiredUnitOperation.eventType
                    && transitionShift === requiredUnitOperation.shiftYears
                ) || (
                    trustedPartialOperation !== null
                    && event.eventType === "partialMove"
                    && transitionShift === trustedPartialOperation.shiftYears
                );
            }) === true;
        const terminalBaselineIsUnsupportedAlias = terminalBaselineLag !== 0
            && !hasAuthoritativeWholeBaseline
            && rawTerminalAliasProbe !== null
            && !(
                rawTerminalAliasProbe.path.runs[
                    rawTerminalAliasProbe.path.runs.length - 1
                ]?.lag === terminalBaselineLag
                && terminalLocalTransitionHasIndependentOperationSupport
            )
            && rawTerminalAliasProbe.path.wholeLagGain < 0;
        const stableTerminalLags = terminalBaselineIsUnsupportedAlias
            ? [0]
            : boundedTerminalLags;
        const nearClusterLags = [...new Set([
            ...stableTerminalLags.flatMap((baseline) => (
                Array.from({ length: 11 }, (_, index) => baseline + index - 5)
            )),
            ...rankedBoundedOperations.slice(0, 16).flatMap(({ operation }) => (
                stableTerminalLags.flatMap((baseline) => {
                    const state = baseline + operation.shiftYears;
                    return [state - 1, state, state + 1];
                })
            )),
            ...boundedHypothesisStates,
        ].filter((lag) => (
            lag >= effectiveConfig.lagMin && lag <= effectiveConfig.lagMax
        )))];
        const cumulativeUnitCandidateDepths = Array.from(new Set(
            ownCandidates.flatMap((candidate) => {
                const shift = candidate.deltaYears ?? candidate.suggestedLag;
                return candidate.operationType === "SHIFT_RANGE"
                    && Number.isInteger(shift)
                    && Math.abs(shift) >= 2
                    && shift >= effectiveConfig.lagMin
                    && shift <= effectiveConfig.lagMax
                    ? [shift]
                    : [];
            }),
        )).sort((left, right) => Math.abs(right) - Math.abs(left) || right - left);
        const nearClusterProbeEligible = shouldFitBoundedPath
            && diagnosis.master.sourceTrees.length >= 8
            && diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1 >= 80
            && (
                cumulativeUnitCandidateDepths.length > 0
                || boundedHypotheses.some((event) => (
                    event.eventType !== "wholeSeriesMove"
                ))
            );
        const rawNearPenaltyTwoPath = nearClusterProbeEligible
            ? locateBoundedEvents(
                false,
                nearClusterLags,
                stableTerminalLags,
                2,
                2,
                false,
                6,
                2,
            )
            : null;
        const rawNearPenaltyOnePath = rawNearPenaltyTwoPath && (
            cumulativeUnitCandidateDepths.length > 0
            || hasNearLagClusterCandidate(rawNearPenaltyTwoPath, boundedHypotheses)
        )
            ? locateBoundedEvents(
                false,
                nearClusterLags,
                stableTerminalLags,
                1,
                2,
                false,
                6,
                2,
            )
            : null;
        const stableNearLagCluster = selectStableNearLagCluster(
            rawNearPenaltyTwoPath,
            rawNearPenaltyOnePath,
            boundedHypotheses,
        );
        const stableTerminalSequentialUnit = cumulativeUnitCandidateDepths
            .map((depth) => selectStableTerminalUnitStaircaseFrontier(
                rawNearPenaltyTwoPath,
                rawNearPenaltyOnePath,
                depth,
            ))
            .filter((frontier): frontier is StableTerminalUnitStaircaseFrontier => (
                frontier !== null && Math.abs(frontier.aggregateShiftYears) > 1
            ))
            .map((frontier) => projectStableTerminalSequentialUnit(
                frontier,
                diagnosis,
                ownCandidates,
            ))[0] ?? null;
        const localLagTransitionEvidence: DiagnosisLocalLagTransitionEvidence | null =
            stableNearLagCluster ? {
                eventCount: stableNearLagCluster.eventCount,
                evidenceYears: [...stableNearLagCluster.evidenceYears],
                operationTypes: [...stableNearLagCluster.operationTypes],
                aggregateShiftYears: stableNearLagCluster.aggregateShiftYears,
                locallyComplete: stableNearLagCluster.locallyComplete,
                maximumYearDrift: stableNearLagCluster.maximumYearDrift,
            } : null;
        const unflaggedUnitPulseProbeEligible = diagnosis.master.sourceTrees.length >= 8
            && diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1 >= 120
            && (
                displayed.length === 0
                || boundedHypotheses.filter((event) => (
                    event.eventType !== "wholeSeriesMove"
                )).length >= 2
            );
        const unflaggedUnitPenaltyOnePath = unflaggedUnitPulseProbeEligible
            ? locateBoundedEvents(false, [-1, 0, 1], [0], 1, 2, true, 6)
            : null;
        const unflaggedUnitPenaltyHalfPath = unflaggedUnitPulseProbeEligible
            ? locateBoundedEvents(false, [-1, 0, 1], [0], 0.5, 2, true, 6)
            : null;
        const unflaggedUnitPulseCandidate = selectStableBoundedLagPathFrontier(
            unflaggedUnitPenaltyOnePath,
            unflaggedUnitPenaltyHalfPath,
        );
        const unflaggedUnitPulseFrontier = unflaggedUnitPulseCandidate?.transitionCount === 2
            && unflaggedUnitPulseCandidate.aggregateShiftYears === 0
            && (unflaggedUnitPulseCandidate.event.eventType === "missingRing"
                || unflaggedUnitPulseCandidate.event.eventType === "falseRing")
            && (unflaggedUnitPenaltyOnePath?.path.transitionGain ?? 0) >= 3
            && (unflaggedUnitPenaltyOnePath?.path.runnerUpMargin ?? 0) >= 0.5
            ? {
                    ...unflaggedUnitPulseCandidate,
                    event: {
                        ...unflaggedUnitPulseCandidate.event,
                        evidence: {
                            ...unflaggedUnitPulseCandidate.event.evidence,
                            notes: [
                                ...unflaggedUnitPulseCandidate.event.evidence.notes,
                                "stable_bounded_path_unflagged_unit_probe=true",
                            ],
                        },
                    },
                }
            : null;
        // Keep a parsimonious path and admit a sixth segment only when it recovers a candidate-
        // anchored newest transition. This avoids both old-side overfit and lost frontier events.
        const parsimoniousStablePathMaxSegments = 5;
        const rawPenaltyOneStablePath = needsStableMultiscaleBoundedPath
            ? locateBoundedEvents(
                    false,
                    undefined,
                    stableTerminalLags,
                    1,
                    2,
                    false,
                    parsimoniousStablePathMaxSegments,
                )
            : null;
        const rawPenaltyHalfStablePath = needsStableMultiscaleBoundedPath
            ? locateBoundedEvents(
                    false,
                    undefined,
                    stableTerminalLags,
                    0.5,
                    0.5,
                    false,
                    parsimoniousStablePathMaxSegments,
                )
            : null;
        const candidateWholeLags = new Set(ownCandidates.flatMap((candidate) => (
            candidate.operationType === "SHIFT_RANGE"
            && candidate.mode === "wholeSeriesMove"
            && candidate.ambiguous !== true
                ? [candidate.deltaYears ?? candidate.suggestedLag]
                : []
        )));
        const unobservedFixedSideBaselineLag = selectUnobservedFixedSideWholeLag(
            rawPenaltyOneStablePath,
            rawPenaltyHalfStablePath,
            candidateWholeLags,
        );
        const unobservedFixedSideWholeCandidate = unobservedFixedSideBaselineLag === null
            ? null
            : ownCandidates
                .filter((candidate) => (
                    candidate.operationType === "SHIFT_RANGE"
                    && candidate.mode === "wholeSeriesMove"
                    && (candidate.deltaYears ?? candidate.suggestedLag)
                        === unobservedFixedSideBaselineLag
                ))
                .sort((left, right) => right.score - left.score)[0] ?? null;
        const unobservedFixedSideWholeBaseline = unobservedFixedSideWholeCandidate
            ? (() => {
                    const event = wholeEventFromCandidate(
                        diagnosis,
                        unobservedFixedSideWholeCandidate,
                    );
                    return {
                        ...event,
                        evidence: {
                            ...event.evidence,
                            algorithmSources: Array.from(new Set([
                                ...event.evidence.algorithmSources,
                                "unobserved_fixed_side_whole_baseline",
                            ])).sort(),
                            notes: Array.from(new Set([
                                ...event.evidence.notes,
                                "whole_baseline_source=unobserved_fixed_side_lag",
                                `unobserved_fixed_side_lag=${unobservedFixedSideBaselineLag}`,
                                "unobserved_fixed_side_pairs=0",
                                `unobserved_fixed_side_regularized_gain=${
                                    rawPenaltyOneStablePath!.path.transitionGain.toFixed(6)
                                }`,
                                `unobserved_fixed_side_permissive_gain=${
                                    rawPenaltyHalfStablePath!.path.transitionGain.toFixed(6)
                                }`,
                            ])),
                        },
                    };
                })()
            : null;
        const operationAnchoredRegularizedAggregate = trustedPartialOperation
            ? selectOperationAnchoredRegularizedAggregatePartialFrontier(
                    rawPenaltyOneStablePath,
                    rawPenaltyHalfStablePath,
                    trustedPartialOperation,
                    terminalBaselineIsUnsupportedAlias ? 0 : terminalBaselineLag,
                )
            : null;
        const parsimoniousStrongMultiscaleBoundedFrontier =
            selectStableBoundedLagPathFrontier(
                rawPenaltyOneStablePath,
                rawPenaltyHalfStablePath,
                terminalBaselineIsUnsupportedAlias ? 0 : terminalBaselineLag,
            );
        const parsimoniousFrontierHasCandidateAnchor =
            parsimoniousStrongMultiscaleBoundedFrontier !== null
            && stableFrontierCandidateAnchorDistance(
                parsimoniousStrongMultiscaleBoundedFrontier,
                candidateEvents,
            ) !== null;
        const rawPenaltyOneExtendedStablePath = needsStableMultiscaleBoundedPath
            && !parsimoniousFrontierHasCandidateAnchor
            ? locateBoundedEvents(false, undefined, stableTerminalLags, 1, 2, false, 6)
            : null;
        const rawPenaltyHalfExtendedStablePath = rawPenaltyOneExtendedStablePath
            ? locateBoundedEvents(false, undefined, stableTerminalLags, 0.5, 0.5, false, 6)
            : null;
        const extendedStrongMultiscaleBoundedFrontier = selectStableBoundedLagPathFrontier(
            rawPenaltyOneExtendedStablePath,
            rawPenaltyHalfExtendedStablePath,
            terminalBaselineIsUnsupportedAlias ? 0 : terminalBaselineLag,
        );
        const strongMultiscaleBoundedFrontier =
            selectCandidateAnchoredStableBoundedLagPathFrontier(
                parsimoniousStrongMultiscaleBoundedFrontier,
                extendedStrongMultiscaleBoundedFrontier,
                candidateEvents,
            );
        const strongFrontierUsesExtendedPath = strongMultiscaleBoundedFrontier !== null
            && strongMultiscaleBoundedFrontier === extendedStrongMultiscaleBoundedFrontier;
        const selectedPenaltyHalfStablePath = strongFrontierUsesExtendedPath
            ? rawPenaltyHalfExtendedStablePath
            : rawPenaltyHalfStablePath;
        const selectedStablePathMaxSegments = strongFrontierUsesExtendedPath
            ? 6
            : parsimoniousStablePathMaxSegments;
        const stableStrongFrontier = strongMultiscaleBoundedFrontier;
        const zeroTerminalPenaltyOneStablePath = needsStableMultiscaleBoundedPath
            && terminalBaselineLag !== 0
            && !hasAuthoritativeWholeBaseline
            ? locateBoundedEvents(false, undefined, [0], 1, 2, false, 6)
            : null;
        const zeroTerminalPenaltyHalfStablePath = zeroTerminalPenaltyOneStablePath
            ? locateBoundedEvents(false, undefined, [0], 0.5, 0.5, false, 6)
            : null;
        const zeroTerminalWholeAliasFrontier = selectStableBoundedLagPathFrontier(
            zeroTerminalPenaltyOneStablePath,
            zeroTerminalPenaltyHalfStablePath,
            0,
        );
        const decomposedWholeAliasFrontier = zeroTerminalWholeAliasFrontier
            ?.allTransitionsPartial
            && zeroTerminalWholeAliasFrontier.transitionCount >= 2
            && wholeBaselineHypotheses.some((event) => (
                event.shiftYears !== undefined
                && Math.abs(
                    event.shiftYears
                    - zeroTerminalWholeAliasFrontier.aggregateShiftYears
                ) <= 1
            ))
            ? zeroTerminalWholeAliasFrontier
            : null;
        const rawPenaltyQuarterStablePath = needsStableMultiscaleBoundedPath
            && stableStrongFrontier === null
            ? locateBoundedEvents(
                    false,
                    undefined,
                    stableTerminalLags,
                    0.25,
                    0.5,
                    false,
                    selectedStablePathMaxSegments,
                )
            : null;
        const weakUnitPulseFrontier = selectStableBoundedLagPathFrontier(
            selectedPenaltyHalfStablePath,
            rawPenaltyQuarterStablePath,
            terminalBaselineIsUnsupportedAlias ? 0 : terminalBaselineLag,
            14,
            2,
            "0.5,0.25",
        );
        const aggregateAnchoredRegularizedPartialFrontier = stableStrongFrontier === null
            ? selectAggregateAnchoredRegularizedPartialFrontier(
                    rawPenaltyOneStablePath,
                    candidateEvents,
                    terminalBaselineIsUnsupportedAlias ? 0 : terminalBaselineLag,
                )
            : null;
        const stablePathHasFinalAuthority = allowStableBoundedPathFinalAuthority(
            options.preferRemotePairedMissingFrontier === true,
        );
        const stableUnitPathLocationCheckpoints = stablePathHasFinalAuthority
            ? selectStableUnitPathLocationCheckpoints(
                    rawPenaltyOneStablePath,
                    rawPenaltyHalfStablePath,
                )
            : [];
        const stableMultiscaleBoundedFrontier = decomposedWholeAliasFrontier
            ?? stableStrongFrontier
            ?? operationAnchoredRegularizedAggregate
            ?? aggregateAnchoredRegularizedPartialFrontier
            ?? (weakUnitPulseFrontier
                && (
                    weakUnitPulseFrontier.transitionCount > 2
                    || (
                        weakUnitPulseFrontier.transitionCount === 2
                        && weakUnitPulseFrontier.aggregateShiftYears === 0
                        && (weakUnitPulseFrontier.event.eventType === "missingRing"
                            || weakUnitPulseFrontier.event.eventType === "falseRing")
                    )
                )
                ? weakUnitPulseFrontier
                : null)
            ?? unflaggedUnitPulseFrontier;
        const decisiveExactPartialHypotheses = [
            ...boundedPathEvents,
            ...displayed,
        ].filter(preservesDecisiveExactPartial);
        const isValidAutomaticEvent = (event: DiagnosisEvent): boolean => (
            isAllowedAutomaticDiagnosisEvent(event)
            && (
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
            )
        );
        const validAutomaticEvents = (events: DiagnosisEvent[]): DiagnosisEvent[] => {
            const valid = events
                .filter(isValidAutomaticEvent)
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
                .map(refineEventWithBoundaryConsensus)
                .map((event) => {
                    const shiftYears = wholeSeriesMoveShiftYears(event);
                    if (shiftYears === null) return event;
                    const stateConsistency = measureWholeSeriesStateConsistency(
                        diagnosis,
                        shiftYears,
                    );
                    if (!supportsDominantWholeSeriesBaseline(stateConsistency)) return event;
                    return {
                        ...event,
                        evidence: {
                            ...event.evidence,
                            algorithmSources: Array.from(new Set([
                                ...event.evidence.algorithmSources,
                                "dominant_whole_state_consensus",
                            ])),
                            notes: Array.from(new Set([
                                ...event.evidence.notes,
                                ...wholeSeriesStateConsistencyNotes(stateConsistency),
                            ])),
                        },
                    };
                });
            const projected = projectSequentialUnitChainHead(valid);
            return prioritizeEndpointUnitAgainstWhole(
                projected,
                diagnosis,
                siteData,
            );
        };
        const finalize = (
            sourceEvents: DiagnosisEvent[],
            supplementalFinalHypotheses: DiagnosisEvent[] = [],
            includeBoundedPathHypotheses = true,
        ): DiagnosisEvent[] => {
            const independentlyLocatedEvents = sourceEvents.map((event) => (
                projectUnitLocationFromIndependentConsensus(
                    event,
                    candidateEvents,
                    passRawPathEvents.events,
                    boundedUnitSelection ? {
                        eventType: boundedUnitSelection.operation.eventType,
                        bestYear: boundedUnitSelection.operation.bestYear,
                        score: boundedUnitSelection.score,
                        scoreMargin: boundedUnitSelection.scoreMargin,
                    } : null,
                    diagnosis.targetRange,
                )
            ));
            const automaticSemanticsRejectedCount = independentlyLocatedEvents.filter(
                (event) => !isValidAutomaticEvent(event),
            ).length;
            const finalEvents = validAutomaticEvents(independentlyLocatedEvents)
                .map((event) => event.eventType === "partialMove"
                        ? attachUniversalPartialMissingWorkflow(
                            event,
                            getCofechaDiagnosis(),
                            siteData,
                            localLagTransitionEvidence,
                            candidateEvents,
                        )
                    : event)
                .map(withEvidenceLedger);
            const boundedFinalEvents = includeBoundedPathHypotheses
                ? boundedPathEvents.flatMap((event) => validAutomaticEvents([event]))
                : [];
            const supplementalFinalEvents = [
                ...boundedFinalEvents,
                ...validAutomaticEvents(supplementalFinalHypotheses),
            ].map(withEvidenceLedger);
            let finalReason: DiagnosisEventDecisionReason = "post_location_rejected";
            if (finalEvents.length > 0) {
                finalReason = "emitted";
            } else if (
                ownCandidates.length === 0
                && candidateEvents.length === 0
                && passAudit.lagPathEventCount === 0
                && passAudit.rawLagPathEventCount === 0
            ) {
                finalReason = "no_internal_hypothesis";
            } else if (detectedBeforeFusion.length === 0) {
                finalReason = "ensemble_gate_rejected";
            } else if (detected.length === 0) {
                finalReason = "operation_fusion_rejected";
            } else if (retainedDetected.length === 0) {
                finalReason = "older_endpoint_context";
            } else if (displayed.length === 0) {
                finalReason = "display_projection_rejected";
            } else if (automaticSemanticsRejectedCount > 0) {
                finalReason = "automatic_semantics_conflict";
            }
            if (options.eventDecisionAudits) {
                const depths = [...diagnosis.master.sampleDepth]
                    .filter(([year, depth]) => (
                        year >= diagnosis.targetRange.startYear
                        && year <= diagnosis.targetRange.endYear
                        && depth > 0
                    ))
                    .map(([, depth]) => depth)
                    .sort((left, right) => left - right);
                options.eventDecisionAudits.push({
                    seriesId: diagnosis.targetTree,
                    targetRange: { ...diagnosis.targetRange },
                    cofechaFlagged: isCofechaFlaggedSeries(
                        diagnosis.targetTree,
                        options.cofechaFlaggedSeriesIds,
                    ),
                    referenceSourceCount: diagnosis.master.sourceTrees.length,
                    minimumReferenceDepth: depths[0] ?? 0,
                    medianReferenceDepth: depths[Math.floor(depths.length / 2)] ?? 0,
                    candidateCount: ownCandidates.length,
                    candidateModeCount: candidateEvents.filter((event) => (
                        event.eventType !== "wholeSeriesMove"
                    )).length,
                    candidates: ownCandidates
                        .slice()
                        .sort((left, right) => right.score - left.score)
                        .map(auditCandidate),
                    pass: { ...passAudit },
                    candidateProjectedEvents: candidateEvents.map(auditEvent),
                    detectedBeforeFusion: detectedBeforeFusion.map(auditEvent),
                    detectedAfterFusion: detected.map(auditEvent),
                    retainedAfterEndpointGuard: retainedDetected.map(auditEvent),
                    displayedBeforeLocator: displayed.map(auditEvent),
                    finalEvents: finalEvents.map(auditEvent),
                    localLagTransitionEvidence,
                    terminalUnitStaircaseEvidence: {
                        candidateDepths: [...cumulativeUnitCandidateDepths],
                        strongerTerminalLags: rawNearPenaltyTwoPath?.path.runs
                            .slice(-6).map((run) => run.lag) ?? [],
                        weakerTerminalLags: rawNearPenaltyOnePath?.path.runs
                            .slice(-6).map((run) => run.lag) ?? [],
                        selectedBoundaryYear: stableTerminalSequentialUnit
                            ? rankedEventYear(stableTerminalSequentialUnit)
                            : null,
                    },
                    locatorDecisions: locatorDecisionAudits.map((decision) => ({
                        ...decision,
                        preLocatorEvent: { ...decision.preLocatorEvent },
                        proposedEvent: decision.proposedEvent
                            ? { ...decision.proposedEvent }
                            : null,
                        selectedEvent: { ...decision.selectedEvent },
                    })),
                    automaticSemanticsRejectedCount,
                    finalReason,
                });
            }
            if (options.reviewEventCheckpoints) {
                const stages: Array<{
                    stage: DiagnosisReviewEventCheckpoint["stage"];
                    events: DiagnosisEvent[];
                }> = [
                    { stage: "candidate", events: candidateEvents },
                    { stage: "detected", events: detectedBeforeFusion },
                    { stage: "fused", events: detected },
                    { stage: "retained", events: retainedDetected },
                    { stage: "displayed", events: displayed },
                ];
                stages.forEach(({ stage, events }) => events.forEach((event) => {
                    options.reviewEventCheckpoints?.push({
                        stage,
                        event: withEvidenceLedger(stripDiagnosisEventAlternatives({
                            ...event,
                            seriesRange: event.seriesRange
                                ? { ...event.seriesRange }
                                : { ...diagnosis.targetRange },
                        })),
                    });
                }));
                const pushFinalCheckpoint = (
                    event: DiagnosisEvent,
                    authority: NonNullable<DiagnosisReviewEventCheckpoint["authority"]>,
                ): void => {
                    options.reviewEventCheckpoints?.push({
                        stage: "final",
                        authority,
                        event: withEvidenceLedger(stripDiagnosisEventAlternatives({
                            ...event,
                            seriesRange: event.seriesRange
                                ? { ...event.seriesRange }
                                : { ...diagnosis.targetRange },
                        })),
                    });
                };
                supplementalFinalEvents.forEach((event) => (
                    pushFinalCheckpoint(event, "supplemental")
                ));
                finalEvents.forEach((event) => pushFinalCheckpoint(event, "selected"));
            }
            return finalEvents;
        };
        const hasLocalEvent = displayed.some(
            (event) => event.eventType !== "wholeSeriesMove",
        );
        const mayRecoverSequentialMissing = cofechaFlagged;
        const stableBoundedPathFrontier = recoverStableBoundedLagPathFrontier(
            stableMultiscaleBoundedFrontier,
            displayed,
            boundedOperations,
            diagnosis.targetRange,
            candidateEvents,
        );
        let cachedCofechaDiagnosis: ReturnType<typeof diagnoseSeriesCore> | undefined;
        const getCofechaDiagnosis = (): ReturnType<typeof diagnoseSeriesCore> => {
            if (cachedCofechaDiagnosis === undefined) {
                cachedCofechaDiagnosis = diagnoseSeriesCore(
                    siteData,
                    diagnosis.targetTree,
                    effectiveConfig,
                    cofechaPreprocess,
                );
            }
            return cachedCofechaDiagnosis;
        };
        let cachedSequentialFalse: DiagnosisEvent | null | undefined;
        const getSequentialFalse = (): DiagnosisEvent | null => {
            if (cachedSequentialFalse === undefined) {
                const currentCofechaDiagnosis = getCofechaDiagnosis();
                cachedSequentialFalse = currentCofechaDiagnosis
                    ? recoverSequentialFalseHeadEvent(
                            displayed,
                            diagnosis,
                            currentCofechaDiagnosis,
                            siteData,
                            ownCandidates,
                            effectiveConfig,
                            options,
                            locatorPathCache,
                        )
                    : null;
            }
            return cachedSequentialFalse;
        };
        let cachedSequentialMissing: SequentialMissingRecovery | null | undefined;
        const getSequentialMissing = (): SequentialMissingRecovery | null => {
            if (cachedSequentialMissing === undefined) {
                const currentCofechaDiagnosis = getCofechaDiagnosis();
                cachedSequentialMissing = mayRecoverSequentialMissing
                    && currentCofechaDiagnosis
                    ? recoverSequentialMissingHeadEvent(
                            displayed,
                            [...detectedBeforeFusion, ...stableUnitPathLocationCheckpoints],
                            diagnosis,
                            currentCofechaDiagnosis,
                            siteData,
                            candidates,
                            candidateEvents,
                            effectiveConfig,
                            options,
                            locatorPathCache,
                        )
                    : null;
            }
            return cachedSequentialMissing;
        };
        if (unobservedFixedSideWholeBaseline
            && !completeUnitTransitionChainExplainsWholeShift(
                passRawPathEvents.events,
                unobservedFixedSideBaselineLag!,
            )) {
            return finalize([unobservedFixedSideWholeBaseline], [], false);
        }
        const boundedWholeShiftHasAnchor = (event: DiagnosisEvent): boolean => {
            const shiftYears = wholeSeriesMoveShiftYears(event);
            if (shiftYears === null) return false;
            return supportedWholeLags.length > 0
                ? supportedWholeLags.includes(shiftYears)
                : shiftYears === globallySupportedTerminalLag;
        };
        const boundedSelectedWholeBaseline = selectedBoundedResult
            && selectedBoundedResult.path.wholeLagGain >= 8
            ? boundedPathEvents.find((event) => (
                event.eventType === "wholeSeriesMove"
                && boundedWholeShiftHasAnchor(event)
            )) ?? null
            : null;
        const boundedRawWholeBaseline = rawBoundedResult
            && rawBoundedResult.path.wholeLagGain >= 8
            ? rawBoundedResult.events.find((event) => (
                event.eventType === "wholeSeriesMove"
                && boundedWholeShiftHasAnchor(event)
            )) ?? null
            : null;
        const boundedWholeBaselines = [
            ...(boundedSelectedWholeBaseline ? [{
                event: boundedSelectedWholeBaseline,
                wholeLagGain: selectedBoundedResult!.path.wholeLagGain,
                source: "bounded_selected_constant_path",
            }] : []),
            ...(boundedRawWholeBaseline ? [{
                event: boundedRawWholeBaseline,
                wholeLagGain: rawBoundedResult!.path.wholeLagGain,
                source: "bounded_raw_constant_path",
            }] : []),
        ];
        const dominantWholeSeriesBaseline = [
            ...displayed.filter((event) => event.eventType === "wholeSeriesMove"),
            ...boundedWholeBaselines.map((entry) => entry.event),
        ]
            .map((event) => {
                const shiftYears = wholeSeriesMoveShiftYears(event);
                if (shiftYears === null) return null;
                const stateConsistency = measureWholeSeriesStateConsistency(
                    diagnosis,
                    shiftYears,
                );
                const boundedPathBaseline = boundedWholeBaselines.find((entry) => (
                    entry.event === event
                ));
                const completeUnitPathAlias = boundedPathBaseline !== undefined
                    && stateConsistency.newerEdgeSupportFraction === 0
                    && completeUnitTransitionChainExplainsWholeShift(
                        passRawPathEvents.events,
                        shiftYears,
                    );
                const boundedPathSupport = boundedPathBaseline !== undefined
                    && !completeUnitPathAlias
                    && supportsNonTerminalWholeSeriesCandidate(stateConsistency);
                const pathFixedSupport = pathFixedWholeBaselinePreemptsLocalPath(
                    event,
                    passRawPathEvents.events,
                );
                return supportsDominantWholeSeriesBaseline(stateConsistency)
                    || boundedPathSupport
                    || pathFixedSupport
                    ? {
                        event: {
                            ...event,
                            evidence: {
                                ...event.evidence,
                                algorithmSources: Array.from(new Set([
                                    ...event.evidence.algorithmSources,
                                    "dominant_whole_state_consensus",
                                    ...(boundedPathSupport
                                        ? ["bounded_constant_lag_baseline"]
                                        : []),
                                    ...(pathFixedSupport
                                        ? ["path_fixed_whole_baseline_authority"]
                                        : []),
                                ])),
                                notes: Array.from(new Set([
                                    ...event.evidence.notes,
                                    ...wholeSeriesStateConsistencyNotes(stateConsistency),
                                    ...(boundedPathSupport ? [
                                        `whole_baseline_source=${boundedPathBaseline.source}`,
                                        `bounded_constant_path_whole_gain=${
                                            boundedPathBaseline.wholeLagGain.toFixed(6)
                                        }`,
                                    ] : []),
                                    ...(pathFixedSupport ? [
                                        "whole_baseline_source=validated_path_fixed_side",
                                    ] : []),
                                    "whole_baseline_preempts_weak_local_path",
                                ])),
                            },
                        },
                        stateConsistency,
                    }
                    : null;
            })
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
            .sort((left, right) => (
                right.stateConsistency.weightedSupportFraction
                    - left.stateConsistency.weightedSupportFraction
                || right.stateConsistency.supportFraction
                    - left.stateConsistency.supportFraction
                || right.event.evidence.score - left.event.evidence.score
            ))[0]?.event ?? null;
        const targetHasExplicitZero = Array.from(
            siteData.get(diagnosis.targetTree)?.values() ?? [],
        ).some((value) => value === 0);
        const mayHaveDistantCumulativeMissingFrontier = !targetHasExplicitZero
            && cumulativeUnitCandidateDepths.some((depth) => depth <= -2);
        const earlySequentialMissing = mayHaveDistantCumulativeMissingFrontier
            ? getSequentialMissing()
            : null;
        const sequentialFrontierYear = earlySequentialMissing
            ? rankedEventYear(earlySequentialMissing.event)
            : null;
        const distantCumulativeMissingFrontier = earlySequentialMissing
            && !earlySequentialMissing.preserveWholeBaseline
            && earlySequentialMissing.event.eventType === "missingRing"
            && sequentialFrontierYear !== null
            && diagnosis.targetRange.endYear - sequentialFrontierYear >= 15
            && earlySequentialMissing.event.evidence.algorithmSources.some((source) => (
                source === "cumulative_sequential_missing_staircase"
                || source === "marker_anchored_sequential_missing_staircase"
                || source === "shared_explicit_zero_marker"
            ));
        if (distantCumulativeMissingFrontier) {
            return finalize(
                [earlySequentialMissing.event],
                retainDisplayedMissingHypothesesDuringSequentialRecovery(
                    displayed,
                    earlySequentialMissing.event,
                ),
                false,
            );
        }
        if (dominantWholeSeriesBaseline && (
            stableBoundedPathFrontier
            || boundedPathEvents.length > 0
            || stableTerminalSequentialUnit
        )) {
            // Establish the global coordinate frame before interpreting a cumulative terminal
            // staircase. The next diagnosis can localize the local step on that fixed baseline.
            return finalize([dominantWholeSeriesBaseline], [], false);
        }
        const wholeFramedTerminalHypothesis = (
            terminal: DiagnosisEvent,
        ): DiagnosisEvent | null => {
            const terminalYear = rankedEventYear(terminal);
            const wholeBaselineShifts = displayed.flatMap((event) => {
                const shiftYears = wholeSeriesMoveShiftYears(event);
                return shiftYears === null ? [] : [shiftYears];
            });
            const wholeFramedTerminal = [
                ...(rawBoundedResult?.events ?? []),
                ...(rawPenaltyOneStablePath?.events ?? []),
                ...(rawNearPenaltyTwoPath?.events ?? []),
            ]
                .filter((event) => (
                    event.eventType === terminal.eventType
                    && wholeBaselineShifts.includes(event.evidence.lagAfter ?? NaN)
                    && strongBoundedPathLocation(event) !== null
                    && terminalYear !== null
                    && rankedEventYear(event) !== null
                    && Math.abs(rankedEventYear(event)! - terminalYear) <= 13
                ))
                .sort((left, right) => (
                    (strongBoundedPathLocation(right)?.concentration ?? 0)
                        - (strongBoundedPathLocation(left)?.concentration ?? 0)
                    || (strongBoundedPathLocation(right)?.remoteMargin ?? 0)
                        - (strongBoundedPathLocation(left)?.remoteMargin ?? 0)
                ))[0] ?? null;
            return wholeFramedTerminal ? {
                ...wholeFramedTerminal,
                evidence: {
                    ...wholeFramedTerminal.evidence,
                    algorithmSources: Array.from(new Set([
                        ...wholeFramedTerminal.evidence.algorithmSources,
                        "whole_baseline_compatible_bounded_location",
                    ])).sort(),
                    notes: Array.from(new Set([
                        ...wholeFramedTerminal.evidence.notes,
                        `whole_baseline_compatible_lag=${
                            wholeFramedTerminal.evidence.lagAfter
                        }`,
                    ])),
                },
            } : null;
        };
        if (stableTerminalSequentialUnit) {
            // The two regularizations and the independently estimated cumulative depth agree on
            // the complete signed unit suffix. Older path contamination cannot reverse this
            // newest operation or compress the staircase into one automatic range move.
            const wholeFramedHypothesis = wholeFramedTerminalHypothesis(
                stableTerminalSequentialUnit,
            );
            return finalize(
                [stableTerminalSequentialUnit],
                wholeFramedHypothesis ? [wholeFramedHypothesis] : [],
                false,
            );
        }
        const candidateAnchoredSequentialFalse = cumulativeUnitCandidateDepths.some(
            (depth) => depth > 1,
        )
            ? getSequentialFalse()
            : null;
        if (candidateAnchoredSequentialFalse?.evidence.algorithmSources.includes(
            "candidate_anchored_positive_staircase",
        )) {
            // Resolve a candidate-depth positive staircase before an unrelated negative bounded
            // path can return early. The helper has already required exact depth, monotone unit
            // transitions, fixed-tail support, and same-region operation direction.
            const wholeFramedHypothesis = wholeFramedTerminalHypothesis(
                candidateAnchoredSequentialFalse,
            );
            return finalize(
                [candidateAnchoredSequentialFalse],
                wholeFramedHypothesis ? [wholeFramedHypothesis] : [],
                false,
            );
        }
        const directTerminalUnitFrontier =
            selectDirectTerminalUnitBeforeDerivedStablePartial(
                stableMultiscaleBoundedFrontier,
                stableBoundedPathFrontier,
                [...displayed, ...detectedBeforeFusion],
                candidateEvents,
            );
        if (directTerminalUnitFrontier && stablePathHasFinalAuthority) {
            return finalize([directTerminalUnitFrontier], [], false);
        }
        const stableFrontierYear = stableBoundedPathFrontier
            ? rankedEventYear(stableBoundedPathFrontier)
            : null;
        const stableFrontierMatchesConfirmedZero = stableFrontierYear !== null
            && Array.from(siteData.get(diagnosis.targetTree) ?? []).some(([year, value]) => (
                value === 0
                && Math.abs(year - stableFrontierYear)
                    <= CONFIRMED_FRONTIER_FOOTPRINT_RADIUS_YEARS
            ));
        if (stableBoundedPathFrontier
            && stablePathHasFinalAuthority
            && stableFrontierMatchesConfirmedZero
            && mayRecoverSequentialMissing
            && options.enableCounterfactualEventLocator === true) {
            const confirmedFrontierCofechaDiagnosis = getCofechaDiagnosis();
            const residualSequentialMissing = confirmedFrontierCofechaDiagnosis
                ? recoverSequentialMissingHeadEvent(
                        displayed,
                        [...detectedBeforeFusion, ...stableUnitPathLocationCheckpoints],
                        diagnosis,
                        confirmedFrontierCofechaDiagnosis,
                        siteData,
                        candidates,
                        candidateEvents,
                        effectiveConfig,
                        options,
                        locatorPathCache,
                    )
                : null;
            if (residualSequentialMissing?.event.evidence.algorithmSources.includes(
                "confirmed_target_zero_path_advance",
            )) {
                return finalize([residualSequentialMissing.event], [], false);
            }
        }
        if (stableBoundedPathFrontier && stablePathHasFinalAuthority) {
            // The complete path has already resolved the serial frontier. Aggregate move
            // hypotheses are intentionally excluded so later review cannot recombine it.
            const locatedStableFrontier = stableBoundedPathFrontier.eventType === "partialMove"
                ? addStablePartialRankEdgeGuard(
                        refineStablePartialMoveLocation(
                            stableBoundedPathFrontier,
                            diagnosis,
                            siteData,
                            stableMultiscaleBoundedFrontier?.baselineLag ?? 0,
                        ),
                        diagnosis,
                    )
                : refineStableUnitEventWithLocalConsensus(
                        stableBoundedPathFrontier,
                        diagnosis,
                        siteData,
                    );
            return finalize([locatedStableFrontier], [], false);
        }
        const aggregatePartialUnitFrontier = recoverAggregatePartialUnitFrontier(
            displayed,
            candidateEvents,
            localCompositionUnitSelection,
            localCompositionOperations,
            diagnosis.targetRange,
        );
        if (aggregatePartialUnitFrontier) {
            return finalize([aggregatePartialUnitFrontier], [], false);
        }
        if (options.enableCounterfactualEventLocator !== true
            || (!hasLocalEvent && !mayRecoverSequentialMissing)) {
            return finalize(displayed);
        }
        const cofechaDiagnosis = getCofechaDiagnosis();
        if (!cofechaDiagnosis) return finalize(displayed);
        const boundedCompressedMissingFrontier = boundedPathEvents
            .filter((event) => (
                event.eventType === "partialMove"
                && event.shiftSide === "older"
                && event.shiftYears === -2
            ))
            .map((event) => addCompressedMissingStaircaseEvidence(
                event,
                cofechaDiagnosis,
                siteData,
                { minLag: -2, maxPartialGapYears: 2 },
                createLagPathCache(),
            ))
            .find((event) => (
                event.interpretationAmbiguity?.kind === "missingRingsOrPartialMove"
                || event.evidence.algorithmSources.includes(
                    "compressed_missing_staircase_evidence",
                )
            ));
        if (boundedCompressedMissingFrontier) {
            return finalize([boundedCompressedMissingFrontier], [], false);
        }
        const crossViewCompletedPartialUnitFrontier =
            recoverCrossViewCompletedPartialUnitFrontier(
                boundedPathEvents,
                displayed,
                candidateEvents,
                diagnosis,
                cofechaDiagnosis,
                siteData,
                effectiveConfig.maxPartialGapYears,
                localCompositionOperations,
            );
        if (crossViewCompletedPartialUnitFrontier) {
            return finalize(
                [crossViewCompletedPartialUnitFrontier],
                decisiveExactPartialHypotheses,
                false,
            );
        }
        const nearCumulativePartialPairFrontier = recoverNearCumulativePartialPairFrontier(
            displayed,
            boundedPathEvents,
            candidateEvents,
            diagnosis,
            cofechaDiagnosis,
            siteData,
            effectiveConfig.maxPartialGapYears,
        );
        if (nearCumulativePartialPairFrontier) {
            return finalize(
                [nearCumulativePartialPairFrontier],
                decisiveExactPartialHypotheses,
                false,
            );
        }
        const cumulativeLagPathFrontier = recoverCumulativeLagPathFrontier(
            displayed,
            passRawPathEvents.events,
        );
        const boundedCompletedPartialUnitFrontier =
            recoverBoundedCompletedPartialUnitFrontier(
                boundedPathEvents,
                displayed,
                candidateEvents,
                detectedBeforeFusion,
                diagnosis,
                cofechaDiagnosis,
                siteData,
                effectiveConfig.maxPartialGapYears,
                locatorPathCache,
                localCompositionUnitSelection,
                localCompositionOperations,
            );
        if (boundedCompletedPartialUnitFrontier) {
            const reconciledUnit = reconcileCumulativeUnitOperationWithCompletedLocation(
                selectCandidateBackedCumulativeUnitFrontier(
                    candidateEvents,
                    boundedCompletedPartialUnitFrontier,
                ),
                boundedCompletedPartialUnitFrontier,
            );
            // The completed correction has already adjudicated the bounded cumulative state.
            // Keeping that aggregate as a review hypothesis would let it overwrite the result.
            return finalize([
                reconciledUnit ?? boundedCompletedPartialUnitFrontier,
            ], decisiveExactPartialHypotheses, false);
        }
        const cumulativePathHasWholeBaseline = displayed.some(
            (event) => event.eventType === "wholeSeriesMove",
        );
        if (cumulativeLagPathFrontier && dominantWholeSeriesBaseline) {
            // The full chronology agrees on a global baseline. Correct that baseline first and
            // re-diagnose; the bounded path is retained as evidence but must not rewrite it as a
            // local transition ending at the same non-zero state.
            return finalize([dominantWholeSeriesBaseline], [], false);
        }
        if (cumulativeLagPathFrontier && (
            cumulativeLagPathFrontier.eventType === "partialMove"
            || cumulativePathHasWholeBaseline
        )) {
            // The raw path has resolved one executable component of the cumulative state.
            // Re-emitting the bounded aggregate would let review replace its operation window.
            return finalize([cumulativeLagPathFrontier], [], false);
        }
        const cumulativePartialFrontier = cumulativeLagPathFrontier === null
            ? recoverCumulativePartialFrontier(
                displayed,
                candidateEvents,
                diagnosis,
                effectiveConfig.maxPartialGapYears,
            )
            : null;
        if (cumulativePartialFrontier) {
            return finalize([cumulativePartialFrontier]);
        }
        const sequentialMissing = earlySequentialMissing ?? getSequentialMissing();
        // A directly validated positive unit staircase is the operation-direction authority.
        // Evaluate it before a deep aggregate missing path can claim the same serial frontier.
        const sequentialFalse = getSequentialFalse();
        if (sequentialFalse) {
            return finalize([sequentialFalse]);
        }
        const sequentialMissingPreemptsComposition = sequentialMissing
            && !displayed.some((event) => event.eventType === "falseRing")
            && sequentialMissing.event.evidence.algorithmSources.some((source) => (
                source === "cumulative_sequential_missing_staircase"
                || source === "marker_anchored_sequential_missing_staircase"
                || source === "shared_explicit_zero_marker"
            ));
        if (sequentialMissingPreemptsComposition) {
            const preservedWhole = sequentialMissing.preserveWholeBaseline
                ? displayed.filter((event) => event.eventType === "wholeSeriesMove")
                : [];
            return finalize(
                [...preservedWhole, sequentialMissing.event],
                retainDisplayedMissingHypothesesDuringSequentialRecovery(
                    displayed,
                    sequentialMissing.event,
                ),
            );
        }
        const completedMixedSeed = mayRecoverSequentialMissing
            ? selectCompletedPartialMissingSeed(displayed, candidateEvents)
            : null;
        if (completedMixedSeed) {
            const compositionPath = locateSequentialMissingHead(
                cofechaDiagnosis,
                siteData,
                {
                    minLag: effectiveConfig.lagMin,
                    maxPartialGapYears: effectiveConfig.maxPartialGapYears,
                },
                locatorPathCache,
            );
            const baseComposition = compareCompletedPartialWithSingleMissing(
                cofechaDiagnosis,
                siteData,
                completedMixedSeed.event,
                compositionPath
                    && supportsSequentialMissingReplacementOfPartial(compositionPath)
                    ? compositionPath.unitEventYears
                    : [],
                true,
            );
            const composition = supportsCompletedPartialMissingComposition(baseComposition)
                || completedMixedSeed.anchorYears.length === 0
                ? baseComposition
                : compareCompletedPartialWithSingleMissing(
                    cofechaDiagnosis,
                    siteData,
                    completedMixedSeed.event,
                    compositionPath
                        && supportsSequentialMissingReplacementOfPartial(compositionPath)
                        ? compositionPath.unitEventYears
                        : [],
                    true,
                    completedMixedSeed.anchorYears,
                ) ?? baseComposition;
            if (supportsCompletedPartialMissingComposition(composition)
                && !decisiveExactPartialRejectsWeakUnitComposition(
                    completedMixedSeed.event,
                    composition,
                )) {
                return finalize([makeCompletedPartialUnitFrontierEvent(
                    completedMixedSeed.event,
                    composition,
                    diagnosis,
                )], decisiveExactPartialHypotheses);
            }
        }
        // A terminal whole baseline and a newer unit frontier can coexist. The sequential
        // counterfactual decides whether the unit event survives; the whole baseline is retained
        // as an alternative only when it has independent support.
        if (sequentialMissing) {
            const preservedWhole = sequentialMissing.preserveWholeBaseline
                ? displayed.filter((event) => event.eventType === "wholeSeriesMove")
                : [];
            return finalize(
                [...preservedWhole, sequentialMissing.event],
                retainDisplayedMissingHypothesesDuringSequentialRecovery(
                    displayed,
                    sequentialMissing.event,
                ),
            );
        }
        if (cumulativeLagPathFrontier) {
            return finalize([cumulativeLagPathFrontier], [], false);
        }
        if (!hasLocalEvent) return finalize(displayed);
        const locatedInputEvents = prioritizeEndpointUnitAgainstWhole(
            displayed,
            diagnosis,
            siteData,
        );
        const jointStateEvents = preserveJointLagStateWindows(locatedInputEvents);
        if (jointStateEvents) return finalize(jointStateEvents);
        const hasWholeSeriesBaseline = locatedInputEvents.some(
            (event) => event.eventType === "wholeSeriesMove",
        );
        const locatorEventPathConfig = {
            ...INTERNAL_EVENT_PATH_CONFIG,
            maxPartialGapYears: effectiveConfig.maxPartialGapYears,
            ...options.eventPathConfig,
        };
        const locatedEvents = locatedInputEvents.map((event) => {
            if (event.eventType === "wholeSeriesMove") return event;
            if (event.evidence.algorithmSources.includes(
                "collapsed_missing_staircase_head",
            )) {
                return event;
            }
            if (event.evidence.algorithmSources.includes(
                "series_endpoint_review_window",
            )) {
                return event;
            }
            const fixedSideBaselineLag = hasWholeSeriesBaseline
                ? event.evidence.lagAfter ?? 0
                : 0;
            const located = refineEventWithCounterfactualLocator(
                event,
                diagnosis,
                cofechaDiagnosis,
                siteData,
                locatorEventPathConfig,
                locatorPathCache,
                fixedSideBaselineLag,
            );
            const decision = adjudicateLocatorProposal(
                event,
                located?.event ?? null,
            );
            locatorDecisionAudits.push({
                reason: decision.reason,
                accepted: decision.accepted,
                overlapYears: decision.overlapYears,
                centerDistanceYears: decision.centerDistanceYears,
                operationContractValid: decision.operationContractValid,
                detachedEvidenceStrong: decision.detachedEvidenceStrong,
                structuredCheckpoint: decision.evidence.structuredCheckpoint,
                structuredProposal: decision.evidence.structuredProposal,
                precisionRegression: decision.precisionRegression,
                checkpointTopYear: decision.evidence.checkpointTopYear,
                proposedTopYear: decision.evidence.proposedTopYear,
                checkpointWidth: decision.evidence.checkpointWidth,
                proposedWidth: decision.evidence.proposedWidth,
                preLocatorEvent: auditEvent(event),
                proposedEvent: decision.proposedEvent
                    ? auditEvent(decision.proposedEvent)
                    : null,
                selectedEvent: auditEvent(decision.event),
            });
            return addCompressedMissingStaircaseEvidence(
                decision.event,
                cofechaDiagnosis,
                siteData,
                locatorEventPathConfig,
                locatorPathCache,
                hasWholeSeriesBaseline,
            );
        });
        const completedFalseSeed = mayRecoverSequentialMissing
            ? selectCompletedPartialFalseSeed(locatedEvents, candidateEvents)
            : null;
        if (completedFalseSeed) {
            const baseFalseComposition = compareCompletedPartialWithSingleFalse(
                cofechaDiagnosis,
                siteData,
                completedFalseSeed.event,
                true,
            );
            const falseComposition = supportsCompletedPartialFalseComposition(
                baseFalseComposition,
            ) || completedFalseSeed.anchorYears.length === 0
                ? baseFalseComposition
                : compareCompletedPartialWithSingleFalse(
                    cofechaDiagnosis,
                    siteData,
                    completedFalseSeed.event,
                    true,
                    completedFalseSeed.anchorYears,
                ) ?? baseFalseComposition;
            if (supportsCompletedPartialFalseComposition(falseComposition)
                && !decisiveExactPartialRejectsWeakUnitComposition(
                    completedFalseSeed.event,
                    falseComposition,
                )) {
                return finalize([makeCompletedPartialUnitFrontierEvent(
                    completedFalseSeed.event,
                    falseComposition,
                    diagnosis,
                )], decisiveExactPartialHypotheses);
            }
        }
        return finalize(locatedEvents);
    });
};

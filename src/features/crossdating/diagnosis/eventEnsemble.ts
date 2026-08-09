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
    compareCompletedPartialWithMissingStaircase,
    comparePartialMoveWithMissingStaircase,
    comparePartialMoveWithRobustMissingStaircase,
    compareTwoStepUnitDirections,
    supportsDiscreteMissingStaircase,
    supportsRobustMissingStaircaseCorrection,
    type CompletedPartialStaircaseCompetition,
    type MissingStaircaseCompetition,
} from "./discreteMissingStaircaseCompetition";
import {
    createLagPathCache,
    diagnoseLagPath,
    locateSequentialFalseHead,
    locateSequentialMissingHead,
    locateTwoStepMissingStaircase,
    selectSharedExplicitZeroMarker,
    type EventPathConfig,
    type LagPathCache,
    type LagPathDiagnosis,
    type SequentialMissingHead,
    type SharedExplicitZeroMarker,
    type TwoStepMissingStaircase,
} from "./eventPath";
import { makeDiagnosisEventsFromCandidates } from "./events";
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
import { wholeSeriesMoveShiftYears } from "./wholeSeriesMoveSemantics";
import { measureWholeSeriesStateConsistency } from "./wholeSeriesStateConsistency";
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
import { refineEventWithAdjacentBoundaryConsensus } from "./eventBoundaryConsensus";
import { getJointCounterfactualOperationScores } from "./jointCounterfactualOperation";
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
    DiagnosisEventPassAudit,
    DiagnosisEvent,
    DiagnosisEventType,
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
    /** Optional caller-owned sink. Recording must never affect event selection. */
    eventDecisionAudits?: DiagnosisEventDecisionAudit[];
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

export const isTerminalWholeBaselineEvent = (
    event: DiagnosisEvent,
): boolean => event.eventType === "wholeSeriesMove"
    && event.evidence.notes.some((note) => [
        "whole_baseline_source=cofecha_terminal_lag",
        "whole_baseline_source=path_fixed_side_lag",
        "whole_baseline_source=recent_tail_lag",
    ].includes(note));

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
): DiagnosisEvent => {
    const staircase = locateTwoStepMissingStaircase(
        diagnosis,
        siteData,
        event,
        eventPathConfig,
        pathCache,
    );
    if (!supportsCompressedMissingStaircase(staircase)) return event;
    const competition = comparePartialMoveWithMissingStaircase(
        diagnosis,
        siteData,
        event,
        true,
        staircase.newerBoundaryYear,
    );
    const confirmedNewerMissingCount = Array.from(
        siteData.get(event.seriesId) ?? [],
    ).filter(([year, value]) => (
        value === 0 && year > staircase.newerBoundaryYear
    )).length;
    // A two-boundary fit has more degrees of freedom than one physical -2 gap. Local lag shape
    // alone is therefore insufficient. Confirmed newer missing rings may relax only a borderline
    // unanimous vote; first-pass cases still need the stronger independent operation margin.
    if (!supportsDiscreteMissingStaircase(competition, staircase, {
        allowConfirmedHistoryRelaxation:
            confirmedNewerMissingCount >= MIN_CONFIRMED_NEWER_MISSING_MARKERS,
    })) return event;
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
        const missingYear = referenceVoteYear
            ?? ((partialTop?.year
                ?? Math.round((partial.startYear + partial.endYear) / 2)) - 1);
        const width = partial.endYear - partial.startYear + 1;
        const seriesStart = partial.seriesRange?.startYear ?? partial.startYear - 1;
        const seriesEnd = partial.seriesRange?.endYear ?? partial.endYear;
        if (missingYear < seriesStart || missingYear > seriesEnd) return events;
        let startYear = partial.startYear;
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
                        referenceVoteYear === null ? "shifted_partial_top" : "partial_reference_vote"
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
        event.evidence.algorithmSources.includes(
            "series_endpoint_review_window",
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
    if (isTerminalWholeBaselineEvent(whole)
        && (!fixedSideContrast
            || !hasDecisiveNewerSideFixedEvidence(fixedSideContrast))) {
        return events;
    }
    const preferredUnit = {
        ...endpointUnit,
        evidence: {
            ...endpointUnit.evidence,
            algorithmSources: Array.from(new Set([
                ...endpointUnit.evidence.algorithmSources,
                "newer_endpoint_unit_preferred_over_global_lag",
                ...(isTerminalWholeBaselineEvent(whole)
                    ? ["newer_fixed_side_lag_contrast"] as const
                    : []),
            ])).sort(),
            notes: [
                ...endpointUnit.evidence.notes,
                "event_order=newer_endpoint_unit_before_global_lag",
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
        ...events.filter((event) => event.id !== endpointUnit.id),
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

export type SequentialMissingPresentation = {
    marker: SharedExplicitZeroMarker | null;
    selectedYear: number;
    windowCenterYear: number;
    width: 5 | 7 | 9 | 13;
    candidateConsensusYear: number | null;
    candidateWindowSupportYear: number | null;
    confirmedTargetStaircaseYear: number | null;
};

/** Shared zeros can reorder only the local lag head; production windows stay lag-centered. */
export const resolveSequentialMissingPresentation = (
    head: SequentialMissingHead,
    candidateMarker: SharedExplicitZeroMarker | null,
    mode: SharedZeroMarkerMode,
    candidateCenters: readonly number[] = [],
    confirmedTargetZeroYears: readonly number[] = [],
): SequentialMissingPresentation => {
    const marker = mode === "none"
        || (mode === "local2" && (candidateMarker?.distanceFromHead ?? 0) > 2)
        ? null
        : candidateMarker;
    const candidateWindowSupportYear = mode === "legacy6"
        ? null
        : candidateCenters
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
    const confirmedTargetStaircaseYear = candidateWindowSupportYear === null
        && nearbyOlderConfirmedZeros.length >= 2
        ? (nearbyOlderConfirmedZeros[0] ?? head.year) - 1
        : null;
    const lagWidth = mode === "legacy6"
        ? legacySequentialWindowWidth(head, marker)
        : lagHeadSequentialWindowWidth(head);
    const width = candidateDistance === null
        ? lagWidth
        : candidateDistance <= 2
            ? Math.max(9, lagWidth) as 9 | 13
            : 13;
    const lagOnlyCenterYear = head.headRunYears <= 2
        && candidateWindowSupportYear === null
        ? head.year - 2
        : head.year;
    const selectedYear = confirmedTargetStaircaseYear
        ?? marker?.year
        ?? candidateConsensusYear
        ?? head.year;
    return {
        marker,
        selectedYear,
        windowCenterYear: confirmedTargetStaircaseYear
            ?? candidateConsensusYear
            ?? (mode === "legacy6" && marker && marker.distanceFromHead > 2
                ? selectedYear
                : lagOnlyCenterYear),
        width: confirmedTargetStaircaseYear === null ? width : 13,
        candidateConsensusYear,
        candidateWindowSupportYear,
        confirmedTargetStaircaseYear,
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
    confirmedTargetZeroYears: readonly number[],
    markerMode: SharedZeroMarkerMode,
): DiagnosisEvent => {
    const candidateCenters = sequentialMissingCandidateCenters(candidateEvents);
    const {
        marker,
        selectedYear,
        windowCenterYear,
        width,
        candidateConsensusYear,
        candidateWindowSupportYear,
        confirmedTargetStaircaseYear,
    } = resolveSequentialMissingPresentation(
        head,
        candidateMarker,
        markerMode,
        candidateCenters,
        confirmedTargetZeroYears,
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
                ...(confirmedTargetStaircaseYear !== null ? [
                    `confirmed_target_staircase_year=${confirmedTargetStaircaseYear}`,
                ] : []),
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

const MIN_SEQUENTIAL_FALSE_HEAD_RUN_YEARS = 4;

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
    const hasCumulativePositiveCandidate = candidates.some((candidate) => (
        candidate.targetTree === diagnosis.targetTree
        && candidate.operationType === "SHIFT_RANGE"
        && (candidate.deltaYears ?? candidate.suggestedLag) === 2
    ));
    if (!hasCumulativePositiveCandidate) return null;
    const head = locateSequentialFalseHead(
        cofechaDiagnosis,
        siteData,
        {
            maxLag: 2,
            maxPartialGapYears: effectiveConfig.maxPartialGapYears,
        },
        pathCache,
        0,
    );
    if (
        !head
        || head.pathStartLag !== 2
        || head.transitionCount !== 2
        || head.headRunYears < MIN_SEQUENTIAL_FALSE_HEAD_RUN_YEARS
        || head.gainOverDirect <= 0
        || head.headMeanAdvantage <= 0
        || head.fixedTailMeanAdvantage <= 0
    ) return null;
    const oppositeHead = locateSequentialMissingHead(
        cofechaDiagnosis,
        siteData,
        { minLag: -2, maxPartialGapYears: 2 },
        pathCache,
        0,
    );
    if (!oppositeHead) return null;
    const direction = compareTwoStepUnitDirections(
        cofechaDiagnosis,
        siteData,
        head.year,
        oppositeHead.year,
        true,
    );
    if (
        !direction
        || direction.masterMargin <= 0
        || direction.referenceCount < 8
        || direction.referenceSupportRatio < 0.8
        || direction.referenceMedianMargin < 0.02
        || direction.referenceLowerQuartileMargin < 0.005
    ) return null;
    const window = boundedSequentialWindow(head.year, 7, diagnosis.targetRange);
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return {
                year,
                score: head.gainOverDirect - Math.abs(year - head.year) * 0.01,
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
                `sequential_false_path_start_lag=${head.pathStartLag}`,
                `sequential_false_transition_count=${head.transitionCount}`,
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

const recoverCompletedCandidateBackedPartial = (
    competition: CompletedPartialStaircaseCompetition,
    candidateEvents: readonly DiagnosisEvent[],
    diagnosis: SeriesCoreDiagnosis,
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
                "completed_partial_preferred_over_discrete_missing_staircase",
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
    const hasHeadCandidate = candidateEvents.some((event) => (
        partialMoveSupportsSequentialMissingDepth(event, head)
        && event.rankedYears[0]?.year !== undefined
        && Math.abs(event.rankedYears[0].year - head.year)
            <= MAX_CONFIRMED_STAIRCASE_CANDIDATE_DISTANCE_YEARS
    ));
    return nearestPartialDistance >= MIN_DISTINCT_PARTIAL_MODE_SEPARATION_YEARS
        && newerConfirmedMissingCount >= MIN_CONFIRMED_NEWER_MISSING_MARKERS
        && hasHeadCandidate;
};

const recoverSequentialMissingHeadEvent = (
    detected: DiagnosisEvent[],
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
    const compressedPartial = detected.find((event) => (
        event.eventType === "partialMove"
        && event.shiftYears === -2
        && event.evidence.lagBefore === -2
        && event.evidence.lagAfter === 0
    ));
    const recoverRobustCompressedPartial = (): SequentialMissingRecovery | null => {
        if (
            !compressedPartial
            || hasDetectedUnitEvent
            || detected.some((event) => event.eventType === "wholeSeriesMove")
        ) return null;
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
        if (!robustHead || !supportsRobustMissingStaircaseCorrection(
            robustCompetition,
            robustStaircase,
        )) return null;
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
    // A true continuous gap is normally better explained by one direct breakpoint.
    if (head && head.gainOverDirect > 0) {
        const marker = selectSharedZeroMarkerForMode(
            siteData,
            diagnosis.targetTree,
            head.year,
            markerMode,
        );
        const candidateCenters = sequentialMissingCandidateCenters(candidateEvents);
        const presentation = resolveSequentialMissingPresentation(
            head,
            marker,
            markerMode,
            candidateCenters,
            confirmedTargetZeroYears,
        );
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
        const hasOppositeUnitOnly = detected.some(
            (event) => event.eventType === "falseRing",
        ) && !detected.some((event) => event.eventType === "missingRing");
        const hasIndependentMissingDirection = detected.some(
            (event) => event.eventType === "missingRing",
        ) || candidateEvents.some((event) => event.eventType === "missingRing")
            || presentation.confirmedTargetStaircaseYear !== null
            || (marker?.support ?? 0) >= 10;
        const whole = detected.find((event) => event.eventType === "wholeSeriesMove");
        const wholeShift = wholeSeriesMoveShiftYears(whole);
        const independentWholeBaseline = wholeShift !== null
            && wholeShift !== head.pathStartLag
            && detected.some((event) => (
                event.eventType !== "wholeSeriesMove"
                && event.evidence.lagAfter === wholeShift
            ));
        const hasIndependentStaircaseSupport = hasExistingUnitEvent
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
        const completedPartial = !whole
            && !hasDistinctConfirmedMissingMode
            && completedFamilySupported
            ? recoverCompletedCandidateBackedPartial(
                completedFamilyCompetition,
                candidateEvents,
                diagnosis,
            )
            : null;
        if (completedPartial) {
            return { event: completedPartial, preserveWholeBaseline: false };
        }
        if (hasOppositeUnitOnly && !hasIndependentMissingDirection) {
            return recoverRobustCompressedPartial();
        }
        if (replacesPartial
            && !supportsSequentialMissingReplacementOfPartial(head)
            && !hasDistinctConfirmedMissingMode) {
            return recoverRobustCompressedPartial();
        }
        // A staircase may be an endpoint artefact of a non-zero global baseline. It may replace a
        // whole candidate only when that candidate is the staircase's older state. An independently
        // connected baseline needs its own missing-direction evidence and remains in the event set.
        if (independentWholeBaseline && !hasIndependentMissingDirection) {
            return recoverRobustCompressedPartial();
        }
        if (replacesNonUnitEvent && !hasIndependentStaircaseSupport) {
            return recoverRobustCompressedPartial();
        }
        const baseRecoveredEvent = makeSequentialMissingHeadEvent(
            head,
            marker,
            detected,
            diagnosis,
            candidates,
            candidateEvents,
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
        return {
            event: hasDistinctConfirmedMissingMode ? {
                ...recoveredEvent,
                evidence: {
                    ...recoveredEvent.evidence,
                    algorithmSources: Array.from(new Set([
                        ...recoveredEvent.evidence.algorithmSources,
                        "confirmed_missing_history_distinct_mode",
                    ])).sort(),
                    notes: [
                        ...recoveredEvent.evidence.notes,
                        `sequential_missing_confirmed_newer_zero_count=${
                            confirmedTargetZeroYears.filter((year) => year > head.year).length
                        }`,
                        "sequential_missing_distinct_partial_mode=true",
                    ],
                },
            } : recoveredEvent,
            preserveWholeBaseline: independentWholeBaseline,
        };
    }
    const partial = compressedPartial;
    if (!partial) return recoverRobustCompressedPartial();
    const constrainedCache = createLagPathCache();
    const constrainedHead = locateSequentialMissingHead(
        cofechaDiagnosis,
        siteData,
        { minLag: -2, maxPartialGapYears: 2 },
        constrainedCache,
        0,
    );
    if (!constrainedHead) return recoverRobustCompressedPartial();
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
        return recoverRobustCompressedPartial();
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
        && marker === null) return recoverRobustCompressedPartial();
    return {
        event: addExplicitStaircaseCompetitionEvidence(makeSequentialMissingHeadEvent(
            constrainedHead,
            marker,
            detected,
            diagnosis,
            candidates,
            [],
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
    let pathEvents = pathDiagnosis.events.map((event) => (
        addCompressedMissingStaircaseEvidence(
            event,
            cofechaDiagnosis,
            siteData,
            eventPathConfig,
            pathCache,
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
    const primary = eventsForSeriesPass(
        siteData,
        diagnosis,
        candidates,
        effectiveConfig,
        passOptions,
        primaryAudit,
    );
    if (options.enableMixedReferenceSupplement !== true || primary.length === 0) {
        const selected = keepStrongestPartialMove(primary);
        primaryAudit.finalEventCount = selected.length;
        if (audit) copyEventPassAudit(audit, primaryAudit, "primary");
        return selected;
    }
    if (!shouldRunMixedReferencePass(primary)) {
        const selected = keepStrongestPartialMove(primary);
        primaryAudit.finalEventCount = selected.length;
        if (audit) copyEventPassAudit(audit, primaryAudit, "primary");
        return selected;
    }
    const alternateAudit = emptyEventPassAudit();
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
        const passAudit = emptyEventPassAudit();
        const ownCandidates = candidates.filter((candidate) => (
            candidate.targetTree === diagnosis.targetTree
        ));
        const candidateEvents = makeDiagnosisEventsFromCandidates(
            [diagnosis],
            ownCandidates,
        );
        const detectedBeforeFusion = eventsForSeries(
            siteData,
            diagnosis,
            candidates,
            effectiveConfig,
            options,
            passAudit,
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
        const endpointRefined = options.enableEndpointResidualWindow === true
            && endpointUnits.length === 1
            && !hasMultipleCoherentLocalTransitions(retainedDetected)
            && !unitEventUsesWholeSeriesBaseline(endpointWhole, endpointUnits[0])
            && !endpointUnits[0].evidence.algorithmSources.includes(
                "collapsed_missing_staircase_head",
            )
            ? retainedDetected.map((event) => (
                event.id === endpointUnits[0].id
                    ? refineUnitEventWithEndpointResidualWindow(
                        event.id === forcedEndpointUnitId
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
                            : event,
                        diagnosis,
                        siteData,
                        endpointCache,
                    )
                    : event
            ))
            : retainedDetected;
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
        const isValidAutomaticEvent = (event: DiagnosisEvent): boolean => (
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
                .map(refineEventWithAdjacentBoundaryConsensus);
            const projected = projectSequentialUnitChainHead(valid);
            return prioritizeEndpointUnitAgainstWhole(
                projected,
                diagnosis,
                siteData,
            );
        };
        const finalize = (sourceEvents: DiagnosisEvent[]): DiagnosisEvent[] => {
            const automaticSemanticsRejectedCount = sourceEvents.filter(
                (event) => !isValidAutomaticEvent(event),
            ).length;
            const finalEvents = validAutomaticEvents(sourceEvents);
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
                    automaticSemanticsRejectedCount,
                    finalReason,
                });
            }
            return finalEvents;
        };
        const hasLocalEvent = displayed.some(
            (event) => event.eventType !== "wholeSeriesMove",
        );
        const mayRecoverSequentialMissing = isCofechaFlaggedSeries(
            diagnosis.targetTree,
            options.cofechaFlaggedSeriesIds,
        );
        const hasTerminalWholeBaseline = displayed.some(isTerminalWholeBaselineEvent);
        if (options.enableCounterfactualEventLocator !== true
            || (!hasLocalEvent && !mayRecoverSequentialMissing)) {
            return finalize(displayed);
        }
        const cofechaDiagnosis = diagnoseSeriesCore(
            siteData,
            diagnosis.targetTree,
            effectiveConfig,
            cofechaPreprocess,
        );
        if (!cofechaDiagnosis) return finalize(displayed);
        const sequentialFalse = recoverSequentialFalseHeadEvent(
            displayed,
            diagnosis,
            cofechaDiagnosis,
            siteData,
            ownCandidates,
            effectiveConfig,
            options,
            locatorPathCache,
        );
        if (sequentialFalse) {
            return finalize([sequentialFalse]);
        }
        if (mayRecoverSequentialMissing && !hasTerminalWholeBaseline) {
            const sequentialMissing = recoverSequentialMissingHeadEvent(
                displayed,
                diagnosis,
                cofechaDiagnosis,
                siteData,
                candidates,
                candidateEvents,
                effectiveConfig,
                options,
                locatorPathCache,
            );
            if (sequentialMissing) {
                const preservedWhole = sequentialMissing.preserveWholeBaseline
                    ? displayed.filter((event) => event.eventType === "wholeSeriesMove")
                    : [];
                return finalize([...preservedWhole, sequentialMissing.event]);
            }
        }
        if (!hasLocalEvent) return finalize(displayed);
        const jointStateEvents = preserveJointLagStateWindows(displayed);
        if (jointStateEvents) return finalize(jointStateEvents);
        const hasWholeSeriesBaseline = displayed.some(
            (event) => event.eventType === "wholeSeriesMove",
        );
        const locatorEventPathConfig = {
            ...INTERNAL_EVENT_PATH_CONFIG,
            maxPartialGapYears: effectiveConfig.maxPartialGapYears,
            ...options.eventPathConfig,
        };
        const locatedEvents = displayed.map((event) => {
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
            const firstLocated = located?.event ?? event;
            let finalLocated = firstLocated;
            if (
                firstLocated.eventType === "partialMove"
                && !hasWholeSeriesBaseline
            ) {
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
                    operationRefined.eventType !== firstLocated.eventType
                    || operationRefined.shiftYears !== firstLocated.shiftYears
                ) {
                    finalLocated = refineEventWithCounterfactualLocator(
                        operationRefined,
                        diagnosis,
                        cofechaDiagnosis,
                        siteData,
                        locatorEventPathConfig,
                        locatorPathCache,
                        fixedSideBaselineLag,
                    )?.event ?? operationRefined;
                }
            }
            return addCompressedMissingStaircaseEvidence(
                finalLocated,
                cofechaDiagnosis,
                siteData,
                locatorEventPathConfig,
                locatorPathCache,
            );
        });
        return finalize(locatedEvents);
    });
};

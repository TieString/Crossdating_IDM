/** Conservative tie policy for discrete missing rings versus one continuous partial gap. */
import { insertMissingYearAtSide } from "@/features/rwl/edit";
import type {
    CompletedPartialMissingComposition,
    CompletedPartialStaircaseCompetition,
    MissingStaircaseCompetition,
} from "./discreteMissingStaircaseCompetition";
import type { SequentialMissingHead, TwoStepMissingStaircase } from "./eventPath";
import {
    scoreUnitBoundaries,
    selectStableUnitLocalConsensus,
    type UnitBreakpointScore,
} from "./unitBreakpointRefinement";
import type { RwlSiteData } from "@/features/rwl/types";
import { getRangeForSeries, toNumericSeries } from "./series";
import type {
    DiagnosisEvent,
    DiagnosisLocalLagTransitionEvidence,
    DiagnosisMissingPartialInterpretationEvidence,
    SeriesCoreDiagnosis,
    YearRange,
} from "./types";

export const MISSING_PARTIAL_INTERPRETATION_CALIBRATION = {
    minimumReferenceCount: 8,
    minimumSupportPerExplanation: 2,
    maximumDominantReferenceRatio: 0.7,
    maximumMasterMargin: 0.08,
    maximumReferenceMedianMargin: 0.025,
    maximumNormalizedGainDifference: 1,
    maximumBoundaryDistanceYears: 6,
    maximumMissingRegionWidthYears: 13,
} as const;

type InterpretationCompetition = {
    cumulativeShiftYears: number;
    partialFirstFixedYear: number;
    missingYears: number[];
    masterMargin: number;
    referenceMedianMargin: number;
    referenceCount: number;
    missingReferenceSupport: number;
    partialReferenceSupport: number;
};

export type MissingPartialInterpretationGate = {
    missingReviewPassed: boolean;
    partialReviewPassed: boolean;
    hasIndependentWholeSeriesBaseline: boolean;
};

const eventNoteNumber = (event: DiagnosisEvent, prefix: string): number => {
    const note = [...event.evidence.notes].reverse().find((value) => (
        value.startsWith(prefix)
    ));
    const value = Number(note?.slice(prefix.length));
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
};

const normalizeCompetition = (
    competition: MissingStaircaseCompetition | CompletedPartialStaircaseCompetition,
): InterpretationCompetition => {
    if ("directFirstFixedYear" in competition) {
        return {
            cumulativeShiftYears: competition.cumulativeShiftYears,
            partialFirstFixedYear: competition.directFirstFixedYear,
            missingYears: competition.missingYears,
            masterMargin: competition.masterMargin,
            referenceMedianMargin: competition.referenceMedianMargin,
            referenceCount: competition.referenceCount,
            missingReferenceSupport: competition.referenceSupport,
            partialReferenceSupport:
                competition.referenceCount - competition.referenceSupport,
        };
    }
    return {
        cumulativeShiftYears: competition.partialShiftYears,
        partialFirstFixedYear: competition.partialFirstFixedYear,
        missingYears: competition.missingYears,
        masterMargin: competition.masterMargin,
        referenceMedianMargin: competition.referenceMedianMargin,
        referenceCount: competition.referenceCount,
        missingReferenceSupport: competition.staircaseReferenceSupport,
        partialReferenceSupport: competition.partialReferenceSupport,
    };
};

/**
 * Returns review evidence only inside the calibrated tie region. Positive margins favour
 * discrete missing rings; negative margins favour one continuous partial move.
 */
export const evaluateMissingPartialInterpretationTie = (
    competition: MissingStaircaseCompetition | CompletedPartialStaircaseCompetition | null,
    gate: MissingPartialInterpretationGate,
): DiagnosisMissingPartialInterpretationEvidence | null => {
    if (!competition
        || !gate.missingReviewPassed
        || !gate.partialReviewPassed
        || gate.hasIndependentWholeSeriesBaseline) return null;

    const normalized = normalizeCompetition(competition);
    const missingYears = Array.from(new Set(normalized.missingYears))
        .filter(Number.isInteger)
        .sort((left, right) => left - right);
    if (
        normalized.cumulativeShiftYears >= -1
        || Math.abs(normalized.cumulativeShiftYears) !== missingYears.length
        || normalized.referenceCount
            < MISSING_PARTIAL_INTERPRETATION_CALIBRATION.minimumReferenceCount
        || normalized.missingReferenceSupport
            < MISSING_PARTIAL_INTERPRETATION_CALIBRATION.minimumSupportPerExplanation
        || normalized.partialReferenceSupport
            < MISSING_PARTIAL_INTERPRETATION_CALIBRATION.minimumSupportPerExplanation
    ) return null;

    const newestMissingYear = missingYears[missingYears.length - 1];
    const oldestMissingYear = missingYears[0];
    if (newestMissingYear === undefined || oldestMissingYear === undefined) return null;
    const missingRegionWidth = newestMissingYear - oldestMissingYear + 1;
    const boundaryDistance = Math.abs(
        normalized.partialFirstFixedYear - (newestMissingYear + 1),
    );
    const dominantReferenceRatio = Math.max(
        normalized.missingReferenceSupport,
        normalized.partialReferenceSupport,
    ) / normalized.referenceCount;
    const normalizedCounterfactualGainDifference = Math.max(
        Math.abs(normalized.masterMargin)
            / MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumMasterMargin,
        Math.abs(normalized.referenceMedianMargin)
            / MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumReferenceMedianMargin,
    );
    if (
        missingRegionWidth
            > MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumMissingRegionWidthYears
        || boundaryDistance
            > MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumBoundaryDistanceYears
        || dominantReferenceRatio
            > MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumDominantReferenceRatio
        || normalizedCounterfactualGainDifference
            > MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumNormalizedGainDifference
    ) return null;

    return {
        interpretationBasis: "counterfactualTie",
        missingRingCount: missingYears.length,
        cumulativeShiftYears: normalized.cumulativeShiftYears,
        missingYears,
        partialFirstFixedYear: normalized.partialFirstFixedYear,
        normalizedCounterfactualGainDifference,
        masterMargin: normalized.masterMargin,
        referenceMedianMargin: normalized.referenceMedianMargin,
        referenceCount: normalized.referenceCount,
        missingReferenceSupport: normalized.missingReferenceSupport,
        partialReferenceSupport: normalized.partialReferenceSupport,
    };
};

/**
 * A validated partial+missing composition can leave the newest -N frontier observationally
 * equivalent to N nearby missing rings. The exact unit years remain unresolved; the user only
 * receives the independently localized frontier window and confirms the physical explanation.
 */
export const evaluateCompletedPartialMissingInterpretation = (
    partial: DiagnosisEvent,
    competition: CompletedPartialMissingComposition,
    gate: {
        compositionReviewPassed: boolean;
        hasIndependentWholeSeriesBaseline: boolean;
    },
): DiagnosisMissingPartialInterpretationEvidence | null => {
    const shiftYears = partial.shiftYears ?? 0;
    const missingRingCount = Math.abs(shiftYears);
    if (
        !gate.compositionReviewPassed
        || gate.hasIndependentWholeSeriesBaseline
        || partial.eventType !== "partialMove"
        || partial.shiftSide !== "older"
        || shiftYears >= -1
        || competition.frontierEventType !== "partialMove"
        || competition.orientation !== "missingThenPartial"
        || competition.partialShiftYears !== shiftYears
        || missingRingCount
            > MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumMissingRegionWidthYears
        || competition.separationYears
            > MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumMissingRegionWidthYears
        || competition.referenceCount
            < MISSING_PARTIAL_INTERPRETATION_CALIBRATION.minimumReferenceCount
        || competition.orientationReferenceCount
            < MISSING_PARTIAL_INTERPRETATION_CALIBRATION.minimumReferenceCount
        || competition.mixedReferenceSupport
            < MISSING_PARTIAL_INTERPRETATION_CALIBRATION.minimumSupportPerExplanation
        || competition.orientationReferenceSupport
            < MISSING_PARTIAL_INTERPRETATION_CALIBRATION.minimumSupportPerExplanation
    ) return null;

    return {
        interpretationBasis: "completedPartialMissingComposition",
        missingRingCount,
        cumulativeShiftYears: shiftYears,
        // The composition locates the shared frontier, not each individual absent ring.
        missingYears: [],
        partialFirstFixedYear: competition.frontierYear,
        normalizedCounterfactualGainDifference: 0,
        masterMargin: competition.masterMargin,
        referenceMedianMargin: competition.referenceMedianMargin,
        referenceCount: competition.referenceCount,
        missingReferenceSupport: competition.orientationReferenceSupport,
        partialReferenceSupport: competition.mixedReferenceSupport,
        completedComposition: {
            separationYears: competition.separationYears,
            mixedReferenceSupport: competition.mixedReferenceSupport,
            mixedReferenceCount: competition.referenceCount,
            orientationReferenceSupport: competition.orientationReferenceSupport,
            orientationReferenceCount: competition.orientationReferenceCount,
        },
    };
};

/**
 * Keeps a directly localized unit staircase as a review alternative when a nearby partial move
 * remains the stronger primary explanation. This never changes the primary operation.
 */
export const evaluateExactSequentialMissingInterpretation = (
    partial: DiagnosisEvent,
    competition: MissingStaircaseCompetition | null,
    head: SequentialMissingHead | null,
    gate: MissingPartialInterpretationGate,
): DiagnosisMissingPartialInterpretationEvidence | null => {
    if (!competition
        || !head
        || !gate.missingReviewPassed
        || !gate.partialReviewPassed
        || gate.hasIndependentWholeSeriesBaseline
        || partial.eventType !== "partialMove"
        || partial.shiftSide !== "older") return null;

    const shiftYears = partial.shiftYears ?? 0;
    const missingRingCount = Math.abs(shiftYears);
    const missingYears = [...head.unitEventYears].sort((left, right) => left - right);
    const topYear = partial.rankedYears.slice().sort(
        (left, right) => left.rank - right.rank,
    )[0]?.year ?? Math.round((partial.startYear + partial.endYear) / 2);
    const newestMissingYear = missingYears[missingYears.length - 1];
    const oldestMissingYear = missingYears[0];
    if (newestMissingYear === undefined || oldestMissingYear === undefined) return null;
    const missingRegionWidth = newestMissingYear - oldestMissingYear + 1;
    const distanceFromPrimaryWindow = head.year < partial.startYear
        ? partial.startYear - head.year
        : head.year > partial.endYear ? head.year - partial.endYear : 0;
    const dominantReferenceRatio = Math.max(
        competition.referenceSupport,
        competition.referenceCount - competition.referenceSupport,
    ) / Math.max(1, competition.referenceCount);
    const normalizedCounterfactualGainDifference = Math.max(
        Math.abs(competition.masterMargin)
            / MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumMasterMargin,
        Math.abs(competition.referenceMedianMargin)
            / MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumReferenceMedianMargin,
    );
    const structuredLocatorAlternative = shiftYears === -2
        && partial.evidence.algorithmSources.includes(
            "full_interval_counterfactual_locator",
        )
        && partial.evidence.notes.includes(
            "locator_adjudication=accepted_detached_strong_mode",
        )
        && eventNoteNumber(partial, "counterfactual_window_concentration=") >= 0.6
        && eventNoteNumber(partial, "counterfactual_window_remote_margin=") >= 0.2
        && eventNoteNumber(partial, "counterfactual_pair_reference_count=") >= 8
        && head.gainOverDirect >= -0.6
        && head.headRunYears >= 2
        && head.headRunYears <= 13
        && head.fixedTailMeanAdvantage >= 0.25
        && competition.referenceSupport >= 6
        && competition.referenceCount - competition.referenceSupport
            >= MISSING_PARTIAL_INTERPRETATION_CALIBRATION.minimumSupportPerExplanation
        && normalizedCounterfactualGainDifference
            <= MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumNormalizedGainDifference;
    const directExactAlternative = head.gainOverDirect > 0
        && head.headRunYears >= 2
        && head.headMeanAdvantage >= 0.02
        && head.fixedTailMeanAdvantage >= 0.3
        && competition.referenceSupport >= 8
        && competition.referenceCount - competition.referenceSupport
            >= MISSING_PARTIAL_INTERPRETATION_CALIBRATION.minimumSupportPerExplanation
        && dominantReferenceRatio <= 0.85
        && normalizedCounterfactualGainDifference
            <= MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumNormalizedGainDifference;

    if (
        shiftYears >= -1
        || competition.cumulativeShiftYears !== shiftYears
        || head.pathStartLag !== shiftYears
        || head.transitionCount !== missingRingCount
        || missingYears.length !== missingRingCount
        || newestMissingYear !== head.year
        || missingRegionWidth
            > MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumMissingRegionWidthYears
        || Math.abs(topYear - (newestMissingYear + 1))
            > MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumBoundaryDistanceYears
        || distanceFromPrimaryWindow > 2
        || competition.referenceCount
            < MISSING_PARTIAL_INTERPRETATION_CALIBRATION.minimumReferenceCount
        || (!directExactAlternative && !structuredLocatorAlternative)
    ) return null;

    return {
        interpretationBasis: structuredLocatorAlternative && !directExactAlternative
            ? "structuredLocatorCumulativeLagAlternative"
            : "exactSequentialStaircaseAlternative",
        missingRingCount,
        cumulativeShiftYears: shiftYears,
        missingYears,
        partialFirstFixedYear: topYear,
        normalizedCounterfactualGainDifference,
        masterMargin: competition.masterMargin,
        referenceMedianMargin: competition.referenceMedianMargin,
        referenceCount: competition.referenceCount,
        missingReferenceSupport: competition.referenceSupport,
        partialReferenceSupport:
            competition.referenceCount - competition.referenceSupport,
    };
};

/**
 * Keeps a two-step unit interpretation available when local lag shape is decisive but the
 * whole-series direct-vs-staircase fit cannot identify whether the physical sample is broken.
 */
export const evaluateLocalizedTwoStepMissingInterpretation = (
    partial: DiagnosisEvent,
    competition: MissingStaircaseCompetition | null,
    head: SequentialMissingHead | null,
    staircase: TwoStepMissingStaircase | null,
    gate: MissingPartialInterpretationGate,
): DiagnosisMissingPartialInterpretationEvidence | null => {
    if (!competition
        || !head
        || !staircase
        || !gate.missingReviewPassed
        || !gate.partialReviewPassed
        || gate.hasIndependentWholeSeriesBaseline
        || partial.eventType !== "partialMove"
        || partial.shiftSide !== "older"
        || partial.shiftYears !== -2) return null;
    const supportRatio = staircase.referenceSupport
        / Math.max(1, staircase.referenceCount);
    const missingYears = [...head.unitEventYears].sort((left, right) => left - right);
    const oldestYear = missingYears[0];
    const newestYear = missingYears[missingYears.length - 1];
    if (oldestYear === undefined
        || newestYear === undefined
        || head.pathStartLag !== -2
        || head.transitionCount !== 2
        || missingYears.length !== 2
        || newestYear !== head.year
        || newestYear - oldestYear + 1
            > MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumMissingRegionWidthYears
        || staircase.newerBoundaryYear - staircase.olderBoundaryYear < 4
        || staircase.newerBoundaryYear - staircase.olderBoundaryYear > 13
        || Math.abs(head.year - staircase.newerBoundaryYear) > 2
        || staircase.staircaseGain <= 0
        || staircase.middleMeanAdvantage < 0.04
        || staircase.referenceCount
            < MISSING_PARTIAL_INTERPRETATION_CALIBRATION.minimumReferenceCount
        || supportRatio < 0.9
        || staircase.referenceMedianAdvantage < 0.03
        || head.gainOverDirect <= 0
        || head.headMeanAdvantage < 0.03
        || head.year < partial.startYear - 2
        || head.year > partial.endYear + 2) return null;
    const topYear = partial.rankedYears.slice().sort(
        (left, right) => left.rank - right.rank,
    )[0]?.year ?? Math.round((partial.startYear + partial.endYear) / 2);
    return {
        interpretationBasis: "localizedTwoStepStaircaseAlternative",
        missingRingCount: 2,
        cumulativeShiftYears: -2,
        missingYears,
        partialFirstFixedYear: topYear,
        normalizedCounterfactualGainDifference: Math.max(
            Math.abs(competition.masterMargin)
                / MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumMasterMargin,
            Math.abs(competition.referenceMedianMargin)
                / MISSING_PARTIAL_INTERPRETATION_CALIBRATION.maximumReferenceMedianMargin,
        ),
        masterMargin: competition.masterMargin,
        referenceMedianMargin: competition.referenceMedianMargin,
        referenceCount: staircase.referenceCount,
        missingReferenceSupport: staircase.referenceSupport,
        partialReferenceSupport:
            staircase.referenceCount - staircase.referenceSupport,
    };
};

const supportedWindowWidth = (width: number): 5 | 7 | 9 | 13 => (
    width <= 5 ? 5 : width <= 7 ? 7 : width <= 9 ? 9 : 13
);

const boundedWindow = (
    centerYear: number,
    requestedWidth: number,
    range: YearRange,
): YearRange => {
    const availableWidth = range.endYear - range.startYear + 1;
    const width = Math.min(supportedWindowWidth(requestedWidth), availableWidth);
    const startYear = Math.max(
        range.startYear,
        Math.min(
            centerYear - Math.floor(width / 2),
            range.endYear - width + 1,
        ),
    );
    return { startYear, endYear: startYear + width - 1 };
};

const interpretationNotes = (
    evidence: DiagnosisMissingPartialInterpretationEvidence,
): string[] => [
    `missing_partial_interpretation_basis=${
        evidence.interpretationBasis ?? "counterfactualTie"
    }`,
    `missing_partial_tie_count=${evidence.missingRingCount}`,
    `missing_partial_tie_shift=${evidence.cumulativeShiftYears}`,
    `missing_partial_tie_missing_years=${evidence.missingYears.join(",")}`,
    `missing_partial_tie_first_fixed_year=${evidence.partialFirstFixedYear}`,
    `missing_partial_tie_normalized_gain_difference=${
        evidence.normalizedCounterfactualGainDifference.toFixed(6)
    }`,
    `missing_partial_tie_reference_support=${
        evidence.missingReferenceSupport
    }:${evidence.partialReferenceSupport}/${evidence.referenceCount}`,
    `missing_partial_count_evidence=${
        evidence.countEvidence ?? "cumulativeLagOnly"
    }`,
    ...(evidence.frontierYear === undefined
        ? []
        : [`missing_partial_frontier_year=${evidence.frontierYear}`]),
    ...(evidence.frontierLocalization === undefined
        ? []
        : [`missing_partial_frontier_localization=${evidence.frontierLocalization}`]),
    ...(evidence.virtualCountEvaluation === undefined ? [] : [
        `missing_partial_virtual_count_status=${evidence.virtualCountEvaluation.status}`,
        `missing_partial_virtual_count_steps=${evidence.virtualCountEvaluation.validatedSteps}`,
        `missing_partial_virtual_count_years=${evidence.virtualCountEvaluation.years.join(",")}`,
        `missing_partial_virtual_count_min_reference_count=${
            evidence.virtualCountEvaluation.minimumReferenceCount
        }`,
        `missing_partial_virtual_count_min_reference_vote_ratio=${
            evidence.virtualCountEvaluation.minimumReferenceVoteRatio.toFixed(6)
        }`,
        `missing_partial_virtual_count_min_raw_gain=${
            evidence.virtualCountEvaluation.minimumRawGain.toFixed(6)
        }`,
    ]),
];

export const makeMissingRingInterpretation = (
    partial: DiagnosisEvent,
    evidence: DiagnosisMissingPartialInterpretationEvidence,
    range: YearRange,
): DiagnosisEvent => {
    const selectedYear = evidence.frontierYear
        ?? evidence.missingYears[evidence.missingYears.length - 1]
        ?? evidence.partialFirstFixedYear - 1;
    const interpretationSource = evidence.interpretationBasis
        === "completedPartialMissingComposition"
        ? "completed_partial_missing_interpretation"
        : evidence.interpretationBasis === "exactSequentialStaircaseAlternative"
            ? "exact_sequential_missing_interpretation"
        : evidence.interpretationBasis === "localizedTwoStepStaircaseAlternative"
            ? "localized_two_step_missing_interpretation"
        : evidence.interpretationBasis === "structuredLocatorCumulativeLagAlternative"
            ? "structured_locator_missing_interpretation"
        : evidence.interpretationBasis === "virtualSequentialFrontier"
            ? "virtual_sequential_missing_frontier"
        : "missing_partial_interpretation_tie";
    const preservePrimaryWindow = partial.evidence.algorithmSources.includes(
        "multi_event_frontier_location_consensus",
    );
    const window = preservePrimaryWindow
        ? { startYear: partial.startYear, endYear: partial.endYear }
        : boundedWindow(
            selectedYear,
            partial.endYear - partial.startYear + 1,
            range,
        );
    const rankedCenterYear = Math.max(
        window.startYear,
        Math.min(window.endYear, selectedYear),
    );
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return {
                year,
                score: partial.evidence.score - Math.abs(year - rankedCenterYear) * 0.01,
                evidenceTags: [interpretationSource],
            };
        },
    ).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    const alternative: DiagnosisEvent = {
        ...partial,
        id: `${partial.id}-missing-interpretation`,
        eventType: "missingRing",
        ...window,
        rankedYears,
        alternativeTypes: [],
        locationAlternatives: undefined,
        operationAlternatives: undefined,
        interpretationAmbiguity: undefined,
        evidence: {
            ...partial.evidence,
            algorithmSources: Array.from(new Set([
                ...partial.evidence.algorithmSources,
                interpretationSource,
                "discrete_missing_staircase_interpretation",
            ])).sort(),
            scoreMargin: Math.max(0, evidence.referenceMedianMargin),
            correctedCorrelation: null,
            correlationGain: null,
            lagBefore: -1,
            lagAfter: 0,
            candidateIds: [],
            notes: Array.from(new Set([
                ...partial.evidence.notes,
                ...interpretationNotes(evidence),
                ...(evidence.missingYears.length === 0
                    ? ["interpretation_missing_years=unresolved_frontier_sequence"]
                    : []),
                ...(preservePrimaryWindow
                    ? ["interpretation_window=preserved_multi_event_consensus"]
                    : []),
                "interpretation=discrete_missing_ring_frontier",
            ])),
        },
    };
    delete alternative.shiftYears;
    delete alternative.shiftSide;
    return alternative;
};

export const makePartialMoveInterpretation = (
    source: DiagnosisEvent,
    evidence: DiagnosisMissingPartialInterpretationEvidence,
    range: YearRange,
): DiagnosisEvent => {
    const window = boundedWindow(
        evidence.partialFirstFixedYear,
        source.endYear - source.startYear + 1,
        range,
    );
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return {
                year,
                score: source.evidence.score
                    - Math.abs(year - evidence.partialFirstFixedYear) * 0.01,
                evidenceTags: ["missing_partial_interpretation_tie"],
            };
        },
    ).sort((left, right) => (
        right.score - left.score || left.year - right.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...source,
        id: `${source.id}-partial-interpretation`,
        eventType: "partialMove",
        ...window,
        rankedYears,
        alternativeTypes: [],
        locationAlternatives: undefined,
        operationAlternatives: undefined,
        interpretationAmbiguity: undefined,
        shiftYears: evidence.cumulativeShiftYears,
        shiftSide: "older",
        evidence: {
            ...source.evidence,
            algorithmSources: Array.from(new Set([
                ...source.evidence.algorithmSources,
                "missing_partial_interpretation_tie",
                "continuous_partial_gap_interpretation",
            ])).sort(),
            lagBefore: evidence.cumulativeShiftYears,
            lagAfter: 0,
            notes: Array.from(new Set([
                ...source.evidence.notes,
                ...interpretationNotes(evidence),
                "interpretation=continuous_partial_gap",
            ])),
        },
    };
};

export const attachMissingPartialInterpretation = (
    primary: DiagnosisEvent,
    alternative: DiagnosisEvent,
    evidence: DiagnosisMissingPartialInterpretationEvidence,
): DiagnosisEvent => {
    const countEvidence = evidence.countEvidence ?? (
        evidence.missingYears.length === evidence.missingRingCount
        && evidence.referenceCount
            >= MISSING_PARTIAL_INTERPRETATION_CALIBRATION.minimumReferenceCount
            ? "multiReferenceStaircase"
            : "cumulativeLagOnly"
    );
    return {
        ...primary,
        interpretationAmbiguity: {
            kind: "missingRingsOrPartialMove",
            alternative: {
                ...alternative,
                interpretationAmbiguity: undefined,
                stale: primary.stale || alternative.stale ? true : undefined,
            },
            evidence: { ...evidence, countEvidence },
        },
    };
};

/**
 * Makes an independently validated bark-side unit step the current workflow frontier while
 * retaining the aggregate physical-gap interpretation for sample-based review.
 */
export const promoteValidatedSequentialMissingInterpretation = (
    event: DiagnosisEvent,
    hasIndependentUnitLocation: boolean,
): DiagnosisEvent => {
    const ambiguity = event.interpretationAmbiguity;
    if (event.eventType !== "partialMove"
        || ambiguity?.kind !== "missingRingsOrPartialMove"
        || ambiguity.alternative.eventType !== "missingRing") return event;
    const virtual = ambiguity.evidence.virtualCountEvaluation;
    if (!virtual || virtual.validatedSteps < 1) return event;

    const primaryYear = rankedTopYear(event);
    const alternativeYear = rankedTopYear(ambiguity.alternative);
    const isMixedCumulativePath = event.evidence.notes.includes(
        "stable_bounded_path_all_transitions_partial=false",
    );
    if ((!isMixedCumulativePath && !hasIndependentUnitLocation)
        || alternativeYear < primaryYear) return event;

    const partialAlternative: DiagnosisEvent = {
        ...event,
        interpretationAmbiguity: undefined,
        evidence: {
            ...event.evidence,
            notes: Array.from(new Set([
                ...event.evidence.notes,
                "validated_sequential_frontier_retains_partial_interpretation",
            ])),
        },
    };
    const missingPrimary: DiagnosisEvent = {
        ...ambiguity.alternative,
        id: `${ambiguity.alternative.id}-workflow-frontier`,
        evidence: {
            ...ambiguity.alternative.evidence,
            algorithmSources: Array.from(new Set([
                ...ambiguity.alternative.evidence.algorithmSources,
                "validated_sequential_missing_frontier_priority",
            ])).sort(),
            notes: Array.from(new Set([
                ...ambiguity.alternative.evidence.notes,
                "validated_sequential_frontier_preempts_aggregate_partial",
            ])),
        },
    };
    return attachMissingPartialInterpretation(
        missingPrimary,
        partialAlternative,
        ambiguity.evidence,
    );
};

const rankedTopYear = (event: DiagnosisEvent): number => (
    [...event.rankedYears].sort((left, right) => (
        left.rank - right.rank || right.score - left.score || right.year - left.year
    ))[0]?.year ?? Math.round((event.startYear + event.endYear) / 2)
);

const unitFrontierScore = (row: UnitBreakpointScore): number => (
    row.multiScale * 0.35
    + row.combo21 * 0.2
    + row.combo31 * 0.15
    + row.pairMedian31 * 0.3
);

// A 13-year review window cannot hold more than this many separately testable unit events
// without collapsing into adjacent/physically indistinguishable rings. Larger shifts keep
// their cumulative-lag wording and avoid an unbounded diagnostic loop.
const MAX_EXPLICIT_VIRTUAL_MISSING_COUNT = 8;
const MINIMUM_VIRTUAL_RAW_GAIN = 0.01;
const MINIMUM_REFERENCE_PEAK_VOTES = 3;
const MINIMUM_REFERENCE_PEAK_VOTE_RATIO = 0.55;
const MINIMUM_REMOTE_VOTE_MARGIN = 0.1;
const REMOTE_VOTE_EXCLUSION_YEARS = 4;

type VirtualSequentialCountEvaluation = NonNullable<
    DiagnosisMissingPartialInterpretationEvidence["virtualCountEvaluation"]
> & {
    frontierYear: number | null;
    frontierScores: UnitBreakpointScore[];
};

const virtualFrontierCandidateAnchor = (
    partial: DiagnosisEvent,
    candidateEvents: readonly DiagnosisEvent[],
): number | null => {
    const matchingCandidates = candidateEvents.filter((candidate) => (
        candidate.eventType === "partialMove"
        && candidate.shiftSide === "older"
        && candidate.shiftYears === partial.shiftYears
        && candidate.evidence.notes.includes("candidate_hard_gate_passed")
    ));
    const strongest = matchingCandidates.slice().sort((left, right) => (
        (right.evidence.correlationGain ?? Number.NEGATIVE_INFINITY)
            - (left.evidence.correlationGain ?? Number.NEGATIVE_INFINITY)
        || right.evidence.score - left.evidence.score
        || rankedTopYear(right) - rankedTopYear(left)
    ))[0];
    return strongest ? rankedTopYear(strongest) : null;
};

const virtualFrontierSearchRadius = (expectedCount: number): number => (
    Math.min(30, Math.max(13, expectedCount * 6))
);

const publicVirtualCountEvaluation = (
    evaluation: VirtualSequentialCountEvaluation,
): NonNullable<DiagnosisMissingPartialInterpretationEvidence["virtualCountEvaluation"]> => ({
    status: evaluation.status,
    validatedSteps: evaluation.validatedSteps,
    years: [...evaluation.years],
    minimumReferenceCount: evaluation.minimumReferenceCount,
    minimumReferenceVoteRatio: evaluation.minimumReferenceVoteRatio,
    minimumRawGain: evaluation.minimumRawGain,
});

const evaluateVirtualSequentialMissingCount = (
    partial: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis | null,
    siteData: RwlSiteData,
    candidateEvents: readonly DiagnosisEvent[] = [],
): VirtualSequentialCountEvaluation => {
    const expectedCount = Math.abs(partial.shiftYears ?? 0);
    if (!diagnosis
        || expectedCount < 2
        || expectedCount > MAX_EXPLICIT_VIRTUAL_MISSING_COUNT) {
        return {
            status: "skipped",
            validatedSteps: 0,
            years: [],
            minimumReferenceCount: 0,
            minimumReferenceVoteRatio: 0,
            minimumRawGain: 0,
            frontierYear: null,
            frontierScores: [],
        };
    }

    let workingSite = siteData;
    let workingDiagnosis = diagnosis;
    let previousYear: number | null = null;
    let minimumReferenceCount = Infinity;
    let minimumReferenceVoteRatio = Infinity;
    let minimumRawGain = Infinity;
    const years: number[] = [];
    let frontierScores: UnitBreakpointScore[] = [];
    const candidateSearchAnchor = virtualFrontierCandidateAnchor(
        partial,
        candidateEvents,
    );
    const initialSearchAnchor = candidateSearchAnchor ?? Math.max(
        partial.startYear,
        Math.min(partial.endYear, rankedTopYear(partial) - 1),
    );
    const endpointAggregateSearch = candidateSearchAnchor === null
        && partial.evidence.lagAfter === 0
        && partial.evidence.algorithmSources.includes(
            "endpoint_aggregate_partial_frontier",
        )
        && diagnosis.targetRange.endYear - partial.endYear <= 15;
    const endpointSearchEnd = diagnosis.targetRange.endYear - 2;
    const searchRadiusYears = candidateSearchAnchor === null
        ? endpointAggregateSearch
            ? Math.min(30, Math.max(
                    partial.endYear - partial.startYear + 1,
                    endpointSearchEnd - initialSearchAnchor,
                ))
            : Math.max(2, partial.endYear - partial.startYear + 1)
        : virtualFrontierSearchRadius(expectedCount);
    for (let step = 0; step < expectedCount; step += 1) {
        const fallbackYear: number = previousYear === null
            ? initialSearchAnchor
            : Math.max(partial.startYear, previousYear - 1);
        const scanStartYear = candidateSearchAnchor === null
            ? endpointAggregateSearch
                ? Math.max(
                        workingDiagnosis.targetRange.startYear + 30,
                        fallbackYear - searchRadiusYears,
                    )
                : partial.startYear
            : Math.max(
                    workingDiagnosis.targetRange.startYear + 30,
                    fallbackYear - searchRadiusYears,
                );
        const scanEndYear = candidateSearchAnchor === null
            ? endpointAggregateSearch
                ? Math.min(
                        endpointSearchEnd,
                        previousYear === null ? endpointSearchEnd : previousYear - 1,
                    )
                : partial.endYear
            : Math.min(
                    workingDiagnosis.targetRange.endYear - 30,
                    fallbackYear + searchRadiusYears,
                );
        const probe: DiagnosisEvent = {
            ...partial,
            id: `${partial.id}-virtual-missing-count-${step + 1}`,
            eventType: "missingRing",
            startYear: Math.min(scanStartYear, scanEndYear),
            endYear: Math.max(scanStartYear, scanEndYear),
            rankedYears: [{
                year: fallbackYear,
                rank: 1,
                score: partial.evidence.score,
                evidenceTags: ["virtual_sequential_missing_count"],
            }],
            shiftYears: undefined,
            shiftSide: undefined,
            interpretationAmbiguity: undefined,
        };
        const scores = scoreUnitBoundaries(probe, workingDiagnosis, workingSite, {
            includeReferencePeakVotes: true,
        });
        if (step === 0) frontierScores = scores;
        const consensus = selectStableUnitLocalConsensus(
            scores,
            fallbackYear,
            searchRadiusYears,
        );
        const selected: UnitBreakpointScore | null = consensus
            ? scores.filter((row) => Math.abs(row.year - consensus.year) <= 1)
                .sort((left: UnitBreakpointScore, right: UnitBreakpointScore): number => (
                    right.referencePeakVoteRatio - left.referencePeakVoteRatio
                    || right.rawGain31 - left.rawGain31
                    || unitFrontierScore(right) - unitFrontierScore(left)
                    || Math.abs(left.year - fallbackYear)
                        - Math.abs(right.year - fallbackYear)
                    || right.year - left.year
                ))[0] ?? null
            : null;
        const remoteVoteRatio = selected ? Math.max(
            0,
            ...scores.filter((row) => (
                Math.abs(row.year - selected.year) > REMOTE_VOTE_EXCLUSION_YEARS
            ))
                .map((row) => row.referencePeakVoteRatio),
        ) : 0;
        const sequential = selected !== null
            && (previousYear === null || selected.year < previousYear);
        const independentlySupported = selected !== null
            && selected.referenceCount
                >= MISSING_PARTIAL_INTERPRETATION_CALIBRATION.minimumReferenceCount
            && selected.referencePeakVotes >= MINIMUM_REFERENCE_PEAK_VOTES
            && selected.referencePeakVoteRatio >= MINIMUM_REFERENCE_PEAK_VOTE_RATIO
            && selected.referencePeakVoteRatio - remoteVoteRatio
                >= MINIMUM_REMOTE_VOTE_MARGIN
            && selected.rawGain31 >= MINIMUM_VIRTUAL_RAW_GAIN;
        if (!selected || !sequential || !independentlySupported) break;

        years.push(selected.year);
        minimumReferenceCount = Math.min(minimumReferenceCount, selected.referenceCount);
        minimumReferenceVoteRatio = Math.min(
            minimumReferenceVoteRatio,
            selected.referencePeakVoteRatio,
        );
        minimumRawGain = Math.min(minimumRawGain, selected.rawGain31);
        previousYear = selected.year;

        const target = workingSite.get(partial.seriesId);
        if (!target?.has(selected.year)) break;
        const correctedTarget = insertMissingYearAtSide(target, selected.year, "right");
        const rawTarget = toNumericSeries(correctedTarget);
        const targetRange = getRangeForSeries(rawTarget);
        if (!targetRange) break;
        workingSite = new Map(workingSite);
        workingSite.set(partial.seriesId, correctedTarget);
        workingDiagnosis = {
            ...workingDiagnosis,
            rawTarget,
            targetRange,
        };
    }
    const completed = years.length === expectedCount;
    return {
        status: completed ? "confirmed" : "inconclusive",
        validatedSteps: years.length,
        years,
        minimumReferenceCount: Number.isFinite(minimumReferenceCount)
            ? minimumReferenceCount
            : 0,
        minimumReferenceVoteRatio: Number.isFinite(minimumReferenceVoteRatio)
            ? minimumReferenceVoteRatio
            : 0,
        minimumRawGain: Number.isFinite(minimumRawGain) ? minimumRawGain : 0,
        frontierYear: years[0] ?? null,
        frontierScores,
    };
};

const appendMissingWorkflowNotes = (
    event: DiagnosisEvent,
    localLagEvidence: DiagnosisLocalLagTransitionEvidence | null,
): DiagnosisEvent => ({
    ...event,
    evidence: {
        ...event.evidence,
        notes: Array.from(new Set([
            ...event.evidence.notes,
            "missing_workflow_applies_one_frontier_event_only",
            ...(localLagEvidence ? [
                `internal_lag_transition_count=${localLagEvidence.eventCount}`,
                `internal_lag_transition_years=${localLagEvidence.evidenceYears.join(",")}`,
                `internal_lag_transition_shift=${localLagEvidence.aggregateShiftYears}`,
            ] : []),
        ])),
    },
});

/**
 * Every automatic physical-gap suggestion keeps a one-step missing-ring workflow available.
 * The alternative locates only the current bark-side unit event. The cumulative shift is never
 * expanded into several zero insertions, and event-count wording stays uncalibrated unless an
 * existing multi-reference staircase already resolved every unit year.
 */
export const attachUniversalPartialMissingWorkflow = (
    partial: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis | null,
    siteData: RwlSiteData,
    localLagEvidence: DiagnosisLocalLagTransitionEvidence | null = null,
    candidateEvents: readonly DiagnosisEvent[] = [],
): DiagnosisEvent => {
    if (partial.eventType !== "partialMove"
        || partial.shiftSide !== "older"
        || (partial.shiftYears ?? 0) >= -1) return partial;
    if (partial.interpretationAmbiguity?.kind === "missingRingsOrPartialMove") {
        const ambiguity = partial.interpretationAmbiguity;
        if (ambiguity.evidence.countEvidence === "multiReferenceStaircase"
            || ambiguity.evidence.virtualCountEvaluation) {
            return attachMissingPartialInterpretation(
                partial,
                appendMissingWorkflowNotes(ambiguity.alternative, localLagEvidence),
                ambiguity.evidence,
            );
        }
        const virtual = evaluateVirtualSequentialMissingCount(
            partial,
            diagnosis,
            siteData,
            candidateEvents,
        );
        const confirmed = virtual.status === "confirmed";
        const evidence: DiagnosisMissingPartialInterpretationEvidence = {
            ...ambiguity.evidence,
            ...(confirmed ? {
                missingYears: [...virtual.years].sort((left, right) => left - right),
                countEvidence: "multiReferenceStaircase" as const,
                frontierYear: virtual.frontierYear ?? ambiguity.evidence.frontierYear,
                frontierLocalization: "multiReferenceCounterfactual" as const,
                referenceCount: virtual.minimumReferenceCount,
                missingReferenceSupport: Math.round(
                    virtual.minimumReferenceCount * virtual.minimumReferenceVoteRatio,
                ),
            } : { countEvidence: "cumulativeLagOnly" as const }),
            virtualCountEvaluation: publicVirtualCountEvaluation(virtual),
        };
        const alternative = confirmed
            ? makeMissingRingInterpretation(
                    partial,
                    evidence,
                    partial.seriesRange ?? diagnosis?.targetRange ?? {
                        startYear: partial.startYear,
                        endYear: partial.endYear,
                    },
                )
            : ambiguity.alternative;
        return attachMissingPartialInterpretation(
            partial,
            appendMissingWorkflowNotes(alternative, localLagEvidence),
            evidence,
        );
    }

    const firstFixedYear = rankedTopYear(partial);
    const fallbackYear = Math.max(
        partial.startYear,
        Math.min(partial.endYear, firstFixedYear - 1),
    );
    const probe: DiagnosisEvent = {
        ...partial,
        id: `${partial.id}-virtual-missing-probe`,
        eventType: "missingRing",
        rankedYears: [{
            year: fallbackYear,
            rank: 1,
            score: partial.evidence.score,
            evidenceTags: ["virtual_sequential_missing_frontier"],
        }],
        shiftYears: undefined,
        shiftSide: undefined,
        interpretationAmbiguity: undefined,
    };
    const virtual = evaluateVirtualSequentialMissingCount(
        partial,
        diagnosis,
        siteData,
        candidateEvents,
    );
    const scores = virtual.frontierScores.length > 0
        ? virtual.frontierScores
        : diagnosis ? scoreUnitBoundaries(probe, diagnosis, siteData) : [];
    const consensus = selectStableUnitLocalConsensus(
        scores,
        fallbackYear,
        Math.max(2, partial.endYear - partial.startYear + 1),
    );
    const bestScore = [...scores].sort((left, right) => (
        unitFrontierScore(right) - unitFrontierScore(left)
        || Math.abs(left.year - fallbackYear) - Math.abs(right.year - fallbackYear)
        || right.year - left.year
    ))[0] ?? null;
    // Consensus and best-score rows are exploratory until one virtual correction passes all
    // reference, remote-mode, and raw-gain gates. A zero-step probe must not move the user's
    // missing-ring interpretation away from the already validated partial boundary.
    const endpointAggregateReview = virtual.frontierYear === null
        && partial.evidence.algorithmSources.includes(
            "endpoint_aggregate_partial_frontier",
        )
        && diagnosis !== null;
    const endpointReviewRange = endpointAggregateReview ? {
        startYear: Math.max(
            diagnosis!.targetRange.startYear,
            diagnosis!.targetRange.endYear - 14,
        ),
        endYear: diagnosis!.targetRange.endYear - 2,
    } : null;
    const endpointReviewRows = endpointReviewRange
        ? scores.filter((row) => (
                row.year >= endpointReviewRange.startYear
                && row.year <= endpointReviewRange.endYear
            )).sort((left, right) => (
                unitFrontierScore(right) - unitFrontierScore(left)
                || right.referencePeakVoteRatio - left.referencePeakVoteRatio
                || right.rawGain31 - left.rawGain31
                || right.year - left.year
            ))
        : [];
    const endpointReviewTopYear = endpointReviewRows[0]?.year
        ?? (endpointReviewRange
            ? Math.round((endpointReviewRange.startYear + endpointReviewRange.endYear) / 2)
            : fallbackYear);
    const selectedYear = virtual.frontierYear
        ?? (endpointAggregateReview ? endpointReviewTopYear : fallbackYear);
    const selectedScore = scores.find((row) => row.year === selectedYear) ?? bestScore;
    const multiReferenceLocalized = virtual.frontierYear !== null
        && consensus !== null
        && (selectedScore?.referenceCount ?? 0)
            >= MISSING_PARTIAL_INTERPRETATION_CALIBRATION.minimumReferenceCount;
    const shiftYears = partial.shiftYears!;
    const evidence: DiagnosisMissingPartialInterpretationEvidence = {
        interpretationBasis: "virtualSequentialFrontier",
        missingRingCount: Math.abs(shiftYears),
        cumulativeShiftYears: shiftYears,
        missingYears: virtual.status === "confirmed"
            ? [...virtual.years].sort((left, right) => left - right)
            : [],
        partialFirstFixedYear: firstFixedYear,
        normalizedCounterfactualGainDifference: 0,
        masterMargin: 0,
        referenceMedianMargin: 0,
        referenceCount: virtual.status === "confirmed"
            ? virtual.minimumReferenceCount
            : selectedScore?.referenceCount ?? 0,
        missingReferenceSupport: virtual.status === "confirmed"
            ? Math.round(
                    virtual.minimumReferenceCount * virtual.minimumReferenceVoteRatio,
                )
            : 0,
        partialReferenceSupport: 0,
        countEvidence: virtual.status === "confirmed"
            ? "multiReferenceStaircase"
            : "cumulativeLagOnly",
        frontierYear: selectedYear,
        frontierLocalization: multiReferenceLocalized
            ? "multiReferenceCounterfactual"
            : endpointAggregateReview
                ? "endpointAggregateReview"
            : "partialBoundaryFallback",
        virtualCountEvaluation: publicVirtualCountEvaluation(virtual),
    };
    const baseAlternative = makeMissingRingInterpretation(
        partial,
        evidence,
        partial.seriesRange ?? diagnosis?.targetRange ?? {
            startYear: partial.startYear,
            endYear: partial.endYear,
        },
    );
    const alternative = endpointReviewRange ? {
        ...baseAlternative,
        id: `${baseAlternative.id}-endpoint-aggregate-review`,
        ...endpointReviewRange,
        reviewCoreRange: { ...endpointReviewRange },
        rankedYears: Array.from(
            { length: endpointReviewRange.endYear - endpointReviewRange.startYear + 1 },
            (_, index) => endpointReviewRange.startYear + index,
        ).map((year) => {
            const row = endpointReviewRows.find((candidate) => candidate.year === year);
            return {
                year,
                rank: 0,
                score: row ? unitFrontierScore(row) : Number.NEGATIVE_INFINITY,
                evidenceTags: ["endpoint_aggregate_missing_review"],
            };
        }).sort((left, right) => (
            right.score - left.score || right.year - left.year
        )).map((row, index) => ({ ...row, rank: index + 1 })),
        confidenceLevel: "low" as const,
        evidence: {
            ...baseAlternative.evidence,
            algorithmSources: Array.from(new Set([
                ...baseAlternative.evidence.algorithmSources,
                "endpoint_aggregate_missing_review",
            ])).sort(),
            notes: Array.from(new Set([
                ...baseAlternative.evidence.notes,
                `endpoint_aggregate_missing_review_window=${
                    endpointReviewRange.startYear
                }-${endpointReviewRange.endYear}`,
                "endpoint_aggregate_missing_review=low_confidence_unique_window",
            ])),
        },
    } : baseAlternative;
    return attachMissingPartialInterpretation(
        partial,
        appendMissingWorkflowNotes(alternative, localLagEvidence),
        evidence,
    );
};

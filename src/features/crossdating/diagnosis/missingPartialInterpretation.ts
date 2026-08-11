/** Conservative tie policy for discrete missing rings versus one continuous partial gap. */
import type {
    CompletedPartialMissingComposition,
    CompletedPartialStaircaseCompetition,
    MissingStaircaseCompetition,
} from "./discreteMissingStaircaseCompetition";
import type {
    DiagnosisEvent,
    DiagnosisMissingPartialInterpretationEvidence,
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
];

export const makeMissingRingInterpretation = (
    partial: DiagnosisEvent,
    evidence: DiagnosisMissingPartialInterpretationEvidence,
    range: YearRange,
): DiagnosisEvent => {
    const selectedYear = evidence.missingYears[evidence.missingYears.length - 1]
        ?? evidence.partialFirstFixedYear;
    const interpretationSource = evidence.interpretationBasis
        === "completedPartialMissingComposition"
        ? "completed_partial_missing_interpretation"
        : "missing_partial_interpretation_tie";
    const window = boundedWindow(
        selectedYear,
        partial.endYear - partial.startYear + 1,
        range,
    );
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return {
                year,
                score: partial.evidence.score - Math.abs(year - selectedYear) * 0.01,
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
): DiagnosisEvent => ({
    ...primary,
    interpretationAmbiguity: {
        kind: "missingRingsOrPartialMove",
        alternative: {
            ...alternative,
            interpretationAmbiguity: undefined,
            stale: primary.stale || alternative.stale ? true : undefined,
        },
        evidence,
    },
});

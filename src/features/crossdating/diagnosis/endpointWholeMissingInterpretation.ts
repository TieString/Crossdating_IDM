/** Review-only ambiguity between a negative whole-series lag and one next missing-ring step. */
import type {
    DiagnosisEvent,
    DiagnosisWholeLocalInterpretationEvidence,
    DiagnosisWholeMissingInterpretationEvidence,
} from "./types";

const SYNTHETIC_ENDPOINT_WINDOW_WIDTH = 13;
const ALLOWED_REVIEW_WINDOW_WIDTHS = [5, 7, 9, 13] as const;

const endpointReviewRange = (
    whole: DiagnosisEvent,
    width: number,
    endOffsetYears = 0,
): { startYear: number; endYear: number } => {
    const seriesStart = whole.seriesRange?.startYear ?? whole.startYear;
    const endYear = (whole.seriesRange?.endYear ?? whole.endYear) - endOffsetYears;
    return {
        startYear: Math.max(seriesStart, endYear - width + 1),
        endYear,
    };
};

const rankedEndpointYears = (
    range: { startYear: number; endYear: number },
    previous: DiagnosisEvent["rankedYears"],
): DiagnosisEvent["rankedYears"] => {
    const previousByYear = new Map(previous.map((row) => [row.year, row]));
    const minimumPreviousScore = previous.length > 0
        ? Math.min(...previous.map((row) => row.score))
        : null;
    return Array.from(
        { length: range.endYear - range.startYear + 1 },
        (_, index) => {
            const year = range.startYear + index;
            const retained = previousByYear.get(year);
            return {
                year,
                rank: 0,
                score: retained?.score ?? (minimumPreviousScore === null
                    ? 1 / (1 + range.endYear - year)
                    : minimumPreviousScore - 1 - (range.endYear - year) / 100),
                evidenceTags: Array.from(new Set([
                    ...(retained?.evidenceTags ?? []),
                    "endpoint_whole_missing_review_window",
                ])).sort(),
            };
        },
    ).sort((left, right) => (
        right.score - left.score || right.year - left.year
    )).map((row, index) => ({ ...row, rank: index + 1 }));
};

const alignMissingReviewToEndpoint = (
    whole: DiagnosisEvent,
    missing: DiagnosisEvent,
): DiagnosisEvent => {
    const endpointYear = whole.seriesRange?.endYear ?? whole.endYear;
    const endpointDistance = endpointYear - missing.endYear;
    if (endpointDistance <= 0 || endpointDistance > 15) return missing;
    const topYear = missing.rankedYears[0]?.year
        ?? Math.round((missing.startYear + missing.endYear) / 2);
    const completeCandidateSpan = endpointYear - missing.startYear + 1;
    const topYearSpan = endpointYear - topYear + 1;
    const requiredSpan = completeCandidateSpan <= SYNTHETIC_ENDPOINT_WINDOW_WIDTH
        ? completeCandidateSpan
        : topYearSpan;
    const width = ALLOWED_REVIEW_WINDOW_WIDTHS.find(
        (candidateWidth) => candidateWidth >= requiredSpan,
    ) ?? (topYearSpan <= 16 ? SYNTHETIC_ENDPOINT_WINDOW_WIDTH : null);
    if (!width) return missing;
    const range = endpointReviewRange(
        whole,
        width,
        Math.max(0, topYearSpan - width),
    );
    return {
        ...missing,
        ...range,
        reviewCoreRange: { ...range },
        rankedYears: rankedEndpointYears(range, missing.rankedYears),
        evidence: {
            ...missing.evidence,
            algorithmSources: Array.from(new Set([
                ...missing.evidence.algorithmSources,
                "endpoint_whole_missing_window_alignment",
            ])).sort(),
            notes: Array.from(new Set([
                ...missing.evidence.notes,
                `endpoint_missing_original_window=${missing.startYear}-${missing.endYear}`,
                `endpoint_missing_aligned_window=${range.startYear}-${range.endYear}`,
                `endpoint_missing_bridge_top_year=${topYear}`,
            ])),
        },
    };
};

export const makeEndpointMissingReviewFromWhole = (
    whole: DiagnosisEvent,
): DiagnosisEvent | null => {
    const shiftYears = whole.shiftYears ?? null;
    if (whole.eventType !== "wholeSeriesMove"
        || shiftYears === null
        || !Number.isInteger(shiftYears)
        || shiftYears >= 0) return null;
    const range = endpointReviewRange(whole, SYNTHETIC_ENDPOINT_WINDOW_WIDTH);
    return {
        ...whole,
        id: `${whole.id}-synthetic-endpoint-missing-review`,
        eventType: "missingRing",
        ...range,
        reviewCoreRange: { ...range },
        rankedYears: rankedEndpointYears(range, []),
        confidenceLevel: "low",
        alternativeTypes: ["wholeSeriesMove"],
        locationAlternatives: undefined,
        operationAlternatives: undefined,
        interpretationAmbiguity: undefined,
        shiftYears: undefined,
        shiftSide: undefined,
        reviewOnly: true,
        evidence: {
            ...whole.evidence,
            lagBefore: shiftYears,
            lagAfter: shiftYears + 1,
            candidateIds: [],
            scoreMargin: 0,
            algorithmSources: Array.from(new Set([
                ...whole.evidence.algorithmSources,
                "synthetic_endpoint_missing_review",
            ])).sort(),
            notes: Array.from(new Set([
                ...whole.evidence.notes,
                "endpoint_missing_review=synthesized_from_terminal_whole",
                `endpoint_missing_review_whole_shift=${shiftYears}`,
                `endpoint_missing_aligned_window=${range.startYear}-${range.endYear}`,
            ])),
        },
    };
};

export const attachEndpointWholeMissingInterpretation = (
    whole: DiagnosisEvent,
    missing: DiagnosisEvent,
    evidence: DiagnosisWholeMissingInterpretationEvidence,
): DiagnosisEvent => {
    const alignedMissing = alignMissingReviewToEndpoint(whole, missing);
    const width = alignedMissing.endYear - alignedMissing.startYear + 1;
    const alignedEvidence: DiagnosisWholeMissingInterpretationEvidence = {
        ...evidence,
        missingWindowWidth: width as 5 | 7 | 9 | 13,
    };
    return {
        ...whole,
        interpretationAmbiguity: {
            kind: "wholeSeriesMoveOrMissingRing",
            alternative: {
                ...alignedMissing,
                interpretationAmbiguity: undefined,
                stale: whole.stale || alignedMissing.stale ? true : undefined,
                evidence: {
                    ...alignedMissing.evidence,
                    algorithmSources: Array.from(new Set([
                        ...alignedMissing.evidence.algorithmSources,
                        "endpoint_whole_missing_interpretation_tie",
                    ])).sort(),
                    notes: Array.from(new Set([
                        ...alignedMissing.evidence.notes,
                        "interpretation=endpoint_missing_ring",
                        `endpoint_whole_missing_distance=${
                            alignedEvidence.endpointDistanceYears
                        }`,
                        `endpoint_whole_missing_operation_margin=${
                            evidence.operationScoreMargin?.toFixed(6) ?? "none"
                        }`,
                    ])),
                },
            },
            evidence: alignedEvidence,
        },
    };
};

export const attachWholeLocalEventInterpretation = (
    whole: DiagnosisEvent,
    local: DiagnosisEvent,
    evidence: DiagnosisWholeLocalInterpretationEvidence,
): DiagnosisEvent => ({
    ...whole,
    interpretationAmbiguity: {
        kind: "wholeSeriesMoveOrLocalEvent",
        alternative: {
            ...local,
            interpretationAmbiguity: undefined,
            stale: whole.stale || local.stale ? true : undefined,
            evidence: {
                ...local.evidence,
                algorithmSources: Array.from(new Set([
                    ...local.evidence.algorithmSources,
                    "whole_local_event_interpretation",
                ])).sort(),
                notes: Array.from(new Set([
                    ...local.evidence.notes,
                    `whole_local_interpretation_type=${local.eventType}`,
                    `whole_local_interpretation_shift=${evidence.wholeShiftYears}`,
                ])),
            },
        },
        evidence,
    },
});

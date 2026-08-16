/** Review-only ambiguity between a terminal whole-series -1..-3 lag and one next missing-ring step. */
import type {
    DiagnosisEvent,
    DiagnosisWholeMissingInterpretationEvidence,
} from "./types";

const REVIEWABLE_WHOLE_SHIFTS = new Set([-1, -2, -3]);
const SYNTHETIC_ENDPOINT_WINDOW_WIDTH = 13;

const endpointReviewRange = (
    whole: DiagnosisEvent,
    width: number,
): { startYear: number; endYear: number } => {
    const seriesStart = whole.seriesRange?.startYear ?? whole.startYear;
    const endYear = whole.seriesRange?.endYear ?? whole.endYear;
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
    return Array.from(
        { length: range.endYear - range.startYear + 1 },
        (_, index) => {
            const year = range.startYear + index;
            const retained = previousByYear.get(year);
            return {
                year,
                rank: 0,
                score: retained?.score ?? 1 / (1 + range.endYear - year),
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
    const width = missing.endYear - missing.startYear + 1;
    if (![5, 7, 9, 13].includes(width)) return missing;
    const range = endpointReviewRange(whole, width);
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
        || !REVIEWABLE_WHOLE_SHIFTS.has(shiftYears)) return null;
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
        endpointDistanceYears: Math.max(0, whole.endYear - alignedMissing.endYear),
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

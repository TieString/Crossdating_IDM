import { describe, expect, it } from "vitest";
import type { DiagnosisEvent, DiagnosisEventType } from "../types";
import {
    projectActiveDiagnosisEventInterpretation,
    refreshActiveDiagnosisEventInterpretation,
} from "../activeEventInterpretation";

const eventOf = (
    id: string,
    eventType: DiagnosisEventType,
    startYear: number,
    endYear: number,
): DiagnosisEvent => ({
    id,
    seriesId: "ZSL141",
    eventType,
    startYear,
    endYear,
    rankedYears: eventType === "wholeSeriesMove"
        ? []
        : [{ year: 2015, rank: 1, score: 1, evidenceTags: [] }],
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: [],
        score: 1,
        scoreMargin: 0.1,
        baselineCorrelation: 0.19,
        correctedCorrelation: 0.38,
        correlationGain: 0.19,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 80,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
});

describe("active diagnosis event interpretation", () => {
    it("projects the reviewed endpoint missing-ring window instead of the primary whole move", () => {
        const missing = eventOf("zsl141-missing-2015", "missingRing", 2012, 2018);
        const whole: DiagnosisEvent = {
            ...eventOf("zsl141-whole-minus-1", "wholeSeriesMove", 1907, 2023),
            shiftYears: -1,
            interpretationAmbiguity: {
                kind: "wholeSeriesMoveOrMissingRing",
                alternative: missing,
                evidence: {
                    wholeShiftYears: -1,
                    endpointDistanceYears: 8,
                    missingWindowWidth: 7,
                    operationScoreMargin: 0.08,
                    finalEvidenceClaims: [],
                },
            },
        };

        const projected = projectActiveDiagnosisEventInterpretation([whole], missing);

        expect(projected).toEqual([missing]);
        expect(projected[0].startYear).toBe(2012);
        expect(projected[0].endYear).toBe(2018);
        expect(projected[0].rankedYears[0]?.year).toBe(2015);
    });

    it("uses the same projection when a partial move is reviewed as missing rings", () => {
        const missing = eventOf("partial-as-missing", "missingRing", 1798, 1806);
        const partial: DiagnosisEvent = {
            ...eventOf("partial-minus-2", "partialMove", 1796, 1804),
            shiftYears: -2,
            interpretationAmbiguity: {
                kind: "missingRingsOrPartialMove",
                alternative: missing,
                evidence: {
                    missingRingCount: 2,
                    cumulativeShiftYears: -2,
                    missingYears: [1801, 1803],
                    partialFirstFixedYear: 1804,
                    normalizedCounterfactualGainDifference: 0.04,
                    masterMargin: 0.03,
                    referenceMedianMargin: 0.02,
                    referenceCount: 8,
                    missingReferenceSupport: 4,
                    partialReferenceSupport: 4,
                    countEvidence: "multiReferenceStaircase",
                },
            },
        };

        expect(projectActiveDiagnosisEventInterpretation([partial], missing)).toEqual([missing]);
    });

    it("refreshes by interpretation id and drops an event that is no longer diagnosed", () => {
        const oldMissing = eventOf("missing", "missingRing", 2012, 2018);
        const refreshedMissing = {
            ...oldMissing,
            startYear: 2010,
            endYear: 2018,
        };
        const whole: DiagnosisEvent = {
            ...eventOf("whole", "wholeSeriesMove", 1907, 2023),
            shiftYears: -1,
            interpretationAmbiguity: {
                kind: "wholeSeriesMoveOrMissingRing",
                alternative: refreshedMissing,
                evidence: {
                    wholeShiftYears: -1,
                    endpointDistanceYears: 8,
                    missingWindowWidth: 9,
                    operationScoreMargin: null,
                    finalEvidenceClaims: [],
                },
            },
        };

        expect(refreshActiveDiagnosisEventInterpretation([whole], oldMissing)).toBe(refreshedMissing);
        expect(refreshActiveDiagnosisEventInterpretation([], oldMissing)).toBeNull();
    });
});

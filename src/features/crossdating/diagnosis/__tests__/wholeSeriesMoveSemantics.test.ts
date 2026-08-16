import { describe, expect, it } from "vitest";
import type { DiagnosisEvent } from "../types";
import {
    isAllowedAutomaticDiagnosisEvent,
    wholeSeriesMoveShiftYears,
} from "../wholeSeriesMoveSemantics";

const whole = (
    shiftYears: number | undefined,
    legacyLag: number,
): DiagnosisEvent => ({
    id: `whole-${shiftYears ?? "legacy"}`,
    seriesId: "TARGET",
    eventType: "wholeSeriesMove",
    ...(shiftYears === undefined ? {} : { shiftYears }),
    startYear: 1700,
    endYear: 2000,
    rankedYears: [],
    confidenceLevel: "high",
    evidence: {
        algorithmSources: ["global_sliding_match"],
        score: 1,
        scoreMargin: 1,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.7,
        correlationGain: 0.5,
        lagBefore: legacyLag,
        lagAfter: 0,
        samplePairs: 200,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
});

describe("automatic whole-series move semantics", () => {
    it("allows only negative whole-series corrections after normalization", () => {
        expect(isAllowedAutomaticDiagnosisEvent(whole(-20, 20))).toBe(true);
        expect(isAllowedAutomaticDiagnosisEvent(whole(20, -20))).toBe(false);
        expect(isAllowedAutomaticDiagnosisEvent(whole(undefined, -11))).toBe(true);
        expect(isAllowedAutomaticDiagnosisEvent(whole(undefined, 11))).toBe(false);
    });

    it("uses the explicit executable shift before the legacy observed lag", () => {
        expect(wholeSeriesMoveShiftYears(whole(-50, 50))).toBe(-50);
        expect(wholeSeriesMoveShiftYears(whole(50, -50))).toBe(50);
    });
});

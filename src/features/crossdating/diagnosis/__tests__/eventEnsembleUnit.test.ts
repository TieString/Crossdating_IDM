import { describe, expect, it } from "vitest";
import type { DiagnosisEvent } from "../types";
import { pruneUnsupportedFalseRingPathSupplements } from "../eventEnsemble";

const falseRingEvent = (
    startYear: number,
    supported: boolean,
): DiagnosisEvent => ({
    id: `false-${startYear}`,
    seriesId: "TEST",
    eventType: "falseRing",
    startYear,
    endYear: startYear + 6,
    confidenceLevel: "medium",
    rankedYears: [],
    alternativeTypes: [],
    evidence: {
        score: 1,
        scoreMargin: 0.1,
        baselineCorrelation: 0.3,
        correctedCorrelation: 0.6,
        correlationGain: 0.3,
        lagBefore: 1,
        lagAfter: 0,
        samplePairs: 30,
        algorithmSources: ["piecewise_lag_path"],
        candidateIds: supported ? [`candidate-${startYear}`] : [],
        notes: supported ? ["counterfactual_candidate_support"] : [],
    },
});

describe("pruneUnsupportedFalseRingPathSupplements", () => {
    it("removes a remote path-only duplicate when one event has edit support", () => {
        const supported = falseRingEvent(1900, true);
        const remotePathOnly = falseRingEvent(1700, false);

        expect(pruneUnsupportedFalseRingPathSupplements(
            [supported, remotePathOnly],
            true,
        )).toEqual([supported]);
    });

    it("preserves a multi-event path when no candidate operation can arbitrate", () => {
        const first = falseRingEvent(1700, false);
        const second = falseRingEvent(1900, false);

        expect(pruneUnsupportedFalseRingPathSupplements(
            [first, second],
            false,
        )).toEqual([first, second]);
    });
});

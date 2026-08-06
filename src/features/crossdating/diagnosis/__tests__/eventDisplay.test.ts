import { describe, expect, it } from "vitest";
import type { CrossdatingDiagnosis, DiagnosisEvent } from "../types";
import { getDisplayedDiagnosisEvents } from "../eventDisplay";

const event = (id: string): DiagnosisEvent => ({
    id,
    seriesId: "TARGET",
    eventType: "missingRing",
    startYear: 1900,
    endYear: 1904,
    rankedYears: [],
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: [],
        score: 1,
        scoreMargin: 0.2,
        baselineCorrelation: null,
        correctedCorrelation: null,
        correlationGain: null,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 20,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
});

const diagnosis = (events: DiagnosisEvent[], reviewEvents?: DiagnosisEvent[]): CrossdatingDiagnosis => ({
    createdAt: "2026-08-06T00:00:00.000Z",
    seriesCount: 1,
    problemSegmentCount: 0,
    candidateCount: 0,
    eventCount: events.length,
    segmentLength: 50,
    overlap: 25,
    lagRange: { min: -10, max: 10 },
    lowCorrelationThreshold: 0.3,
    summaries: [],
    segments: [],
    propagationPatterns: [],
    globalSlidingMatches: [],
    masterNarrowYears: [],
    events,
    candidates: [],
    ...(reviewEvents ? { reviewEvents } : {}),
});

describe("getDisplayedDiagnosisEvents", () => {
    it("uses the calibrated review surface when available and strict events otherwise", () => {
        expect(getDisplayedDiagnosisEvents(diagnosis([event("strict")], [event("review")]))[0]?.id)
            .toBe("review");
        expect(getDisplayedDiagnosisEvents(diagnosis([event("strict")]))[0]?.id)
            .toBe("strict");
    });
});

import { describe, expect, it } from "vitest";
import { markDiagnosisEventsStale } from "../candidateUtils";
import type { DiagnosisEvent } from "../types";
import { matchDiagnosisEvents, type TruthEvent } from "./eventMetrics";

const event = (
    id: string,
    eventType: DiagnosisEvent["eventType"],
    startYear: number,
    endYear: number,
    extra: Partial<DiagnosisEvent> = {},
): DiagnosisEvent => ({
    id,
    seriesId: "A",
    eventType,
    startYear,
    endYear,
    rankedYears: Array.from({ length: endYear - startYear + 1 }, (_, index) => ({
        year: startYear + index,
        rank: index + 1,
        score: endYear - index,
        evidenceTags: [],
    })),
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: ["test"],
        score: 1,
        scoreMargin: 0,
        baselineCorrelation: null,
        correctedCorrelation: null,
        correlationGain: null,
        lagBefore: null,
        lagAfter: null,
        samplePairs: 0,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
    ...extra,
});

describe("event-level one-to-one matching", () => {
    it("does not let one wide prediction cover two truths", () => {
        const truths: TruthEvent[] = [
            { id: "t1", seriesId: "A", eventType: "missingRing", year: 1900 },
            { id: "t2", seriesId: "A", eventType: "missingRing", year: 1902 },
        ];
        const metrics = matchDiagnosisEvents(truths, [event("p1", "missingRing", 1899, 1903)]);
        expect(metrics.matchedCount).toBe(1);
        expect(metrics.recall).toBe(0.5);
        expect(metrics.precision).toBe(1);
        expect(metrics.completeCaseSuccess).toBe(false);
    });

    it("requires partial-move direction, magnitude, and side", () => {
        const truth: TruthEvent = {
            id: "move",
            seriesId: "A",
            eventType: "partialMove",
            year: 1920,
            shiftYears: -2,
            shiftSide: "older",
        };
        const wrong = event("wrong", "partialMove", 1918, 1922, {
            shiftYears: 2,
            shiftSide: "older",
        });
        const right = event("right", "partialMove", 1918, 1922, {
            shiftYears: -2,
            shiftSide: "older",
        });
        expect(matchDiagnosisEvents([truth], [wrong]).matchedCount).toBe(0);
        expect(matchDiagnosisEvents([truth], [right]).matchedCount).toBe(1);
    });

    it("marks old review windows stale without mutating the completed result", () => {
        const completed = event("fresh", "missingRing", 1897, 1903);
        const alternative = event("partial", "partialMove", 1897, 1903, {
            shiftYears: -2,
            shiftSide: "older",
        });
        completed.interpretationAmbiguity = {
            kind: "missingRingsOrPartialMove",
            alternative,
            evidence: {
                missingRingCount: 2,
                cumulativeShiftYears: -2,
                missingYears: [1899, 1901],
                partialFirstFixedYear: 1902,
                normalizedCounterfactualGainDifference: 0.5,
                masterMargin: 0.01,
                referenceMedianMargin: 0.005,
                referenceCount: 10,
                missingReferenceSupport: 5,
                partialReferenceSupport: 5,
            },
        };
        const original = [completed];
        const stale = markDiagnosisEventsStale(original);

        expect(completed.stale).toBeUndefined();
        expect(stale).not.toBe(original);
        expect(stale[0]).not.toBe(completed);
        expect(stale[0].stale).toBe(true);
        expect(alternative.stale).toBeUndefined();
        expect(stale[0].interpretationAmbiguity?.alternative).not.toBe(alternative);
        expect(stale[0].interpretationAmbiguity?.alternative.stale).toBe(true);
    });
});

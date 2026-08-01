import { describe, expect, it } from "vitest";
import {
    EXPLICIT_ZERO_MIDPOINT_GUARD_SOURCE,
    rerankMissingEventsNearExplicitZeros,
} from "../explicitZeroRanking";
import type { DiagnosisEvent, DiagnosisRankedYear } from "../types";

const ranked = (
    startYear: number,
    endYear: number,
    topYear: number,
): DiagnosisRankedYear[] => {
    const years = Array.from(
        { length: endYear - startYear + 1 },
        (_, index) => startYear + index,
    );
    return [topYear, ...years.filter((year) => year !== topYear)]
        .map((year, index) => ({
            year,
            rank: index + 1,
            score: 1 - index / 10,
            evidenceTags: ["fixture"],
        }));
};

const event = (
    eventType: DiagnosisEvent["eventType"],
    startYear: number,
    endYear: number,
    topYear: number,
): DiagnosisEvent => ({
    id: `${eventType}-${startYear}`,
    seriesId: "TARGET",
    eventType,
    startYear,
    endYear,
    rankedYears: ranked(startYear, endYear, topYear),
    confidenceLevel: "medium",
    alternativeTypes: [],
    evidence: {
        score: 1,
        scoreMargin: 0.2,
        lagBefore: -1,
        lagAfter: 0,
        baselineCorrelation: 0.3,
        correctedCorrelation: 0.4,
        correlationGain: 0.1,
        samplePairs: 80,
        candidateIds: [],
        algorithmSources: ["fixture"],
        notes: [],
    },
});

describe("explicit-zero missing-ring ranking", () => {
    it("promotes the narrow-window midpoint when a nearby zero accompanies a remote top", () => {
        const [result] = rerankMissingEventsNearExplicitZeros(
            [event("missingRing", 1900, 1910, 1902)],
            new Map([[1895, 0], [1915, 120]]),
        );

        expect(result.rankedYears[0].year).toBe(1905);
        expect(result.rankedYears[0].evidenceTags)
            .toContain(EXPLICIT_ZERO_MIDPOINT_GUARD_SOURCE);
        expect(result.evidence.algorithmSources)
            .toContain(EXPLICIT_ZERO_MIDPOINT_GUARD_SOURCE);
    });

    it("does not alter other operations, nearby tops, or windows without a nearby zero", () => {
        const falseRing = event("falseRing", 1900, 1910, 1902);
        const nearbyTop = event("missingRing", 1900, 1910, 1904);
        const distantZero = event("missingRing", 1900, 1910, 1902);
        const midpointTowardZero = event("missingRing", 1900, 1910, 1902);
        const results = rerankMissingEventsNearExplicitZeros(
            [falseRing, nearbyTop, distantZero],
            new Map([[1940, 0]]),
        );
        const [towardZeroResult] = rerankMissingEventsNearExplicitZeros(
            [midpointTowardZero],
            new Map([[1914, 0]]),
        );

        expect(results[0]).toEqual(falseRing);
        expect(results[1]).toEqual(nearbyTop);
        expect(results[2]).toEqual(distantZero);
        expect(towardZeroResult).toEqual(midpointTowardZero);
    });

    it("reranks missing-ring location and operation alternatives independently", () => {
        const primary = event("missingRing", 1950, 1958, 1952);
        primary.operationAlternatives = [event("missingRing", 1900, 1910, 1902)];
        primary.locationAlternatives = [{
            rank: 1,
            startYear: 1900,
            endYear: 1910,
            rankedYears: ranked(1900, 1910, 1902),
            evidenceScore: 0.8,
            scoreMargin: 0.1,
            algorithmSource: "fixture-location",
        }];

        const [result] = rerankMissingEventsNearExplicitZeros(
            [primary],
            new Map([[1895, 0]]),
        );

        expect(result.locationAlternatives?.[0].rankedYears[0].year).toBe(1905);
        expect(result.operationAlternatives?.[0].rankedYears[0].year).toBe(1905);
    });
});

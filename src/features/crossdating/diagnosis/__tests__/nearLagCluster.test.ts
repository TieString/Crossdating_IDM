import { describe, expect, it } from "vitest";
import { selectStableNearLagCluster } from "../nearLagCluster";
import type { BoundedLagStateEventSet } from "../eventPath";
import type { DiagnosisEvent } from "../types";

const event = (
    year: number,
    before: number,
    after: number,
): DiagnosisEvent => {
    const shift = before - after;
    const eventType = shift === -1
        ? "missingRing" as const
        : shift === 1
            ? "falseRing" as const
            : "partialMove" as const;
    return {
        id: `event-${year}-${before}-${after}`,
        seriesId: "TARGET",
        eventType,
        startYear: year - 6,
        endYear: year + 6,
        rankedYears: [{ year, rank: 1, score: 1, evidenceTags: [] }],
        confidenceLevel: "high",
        evidence: {
            algorithmSources: ["bounded_complete_lag_path"],
            score: 10,
            scoreMargin: 1,
            baselineCorrelation: 0.2,
            correctedCorrelation: 0.6,
            correlationGain: 0.4,
            lagBefore: before,
            lagAfter: after,
            samplePairs: 100,
            candidateIds: [],
            notes: [],
        },
        alternativeTypes: [],
        ...(eventType === "partialMove" ? {
            shiftYears: shift,
            shiftSide: "older" as const,
        } : {}),
    };
};

const path = (events: DiagnosisEvent[]): BoundedLagStateEventSet => ({
    events,
    path: {
        runs: [],
        score: 20,
        bestConstantScore: 0,
        zeroLagScore: 0,
        transitionGain: 20,
        wholeLagGain: 0,
        runnerUpMargin: 1,
    },
});

describe("stable near lag cluster", () => {
    it("keeps a stable three-transition mode inside one 13-year region", () => {
        const preferred = event(1907, -7, -6);
        const selected = selectStableNearLagCluster(
            path([event(1901, -8, -7), event(1906, -7, -6), event(1912, -6, 0)]),
            path([event(1902, -8, -7), event(1905, -7, -6), event(1911, -6, 0)]),
            [preferred],
        );

        expect(selected).toMatchObject({
            eventCount: 3,
            evidenceYears: [1902, 1906, 1912],
            operationTypes: ["missingRing", "partialMove"],
        });
    });

    it("does not turn one stable transition into a cluster", () => {
        expect(selectStableNearLagCluster(
            path([event(1904, -6, 0)]),
            path([event(1905, -6, 0)]),
            [],
        )).toBeNull();
    });

    it("does not merge distant transitions", () => {
        expect(selectStableNearLagCluster(
            path([event(1860, -2, -1), event(1900, -1, 0)]),
            path([event(1861, -2, -1), event(1901, -1, 0)]),
            [],
        )).toBeNull();
    });

    it("rejects a close path whose operation changes across regularizations", () => {
        expect(selectStableNearLagCluster(
            path([event(1900, -2, -1), event(1907, -1, 0)]),
            path([event(1900, 0, 1), event(1907, -1, 0)]),
            [],
        )).toBeNull();
    });

    it("ignores a stable old-edge cluster when the newest transition is isolated", () => {
        const preferred = event(1950, -6, 0);
        expect(selectStableNearLagCluster(
            path([event(1700, -40, -39), event(1707, -39, 0), preferred]),
            path([event(1701, -40, -39), event(1708, -39, 0), event(1951, -6, 0)]),
            [preferred],
        )).toBeNull();
    });

    it("rejects a stable newest cluster without an independently located mode", () => {
        expect(selectStableNearLagCluster(
            path([event(1900, -2, -1), event(1907, -1, 0)]),
            path([event(1901, -2, -1), event(1908, -1, 0)]),
            [],
        )).toBeNull();
    });
});

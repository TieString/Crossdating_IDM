import { describe, expect, it } from "vitest";
import {
    selectStableNearLagCluster,
    selectStableTerminalUnitStaircaseFrontier,
} from "../nearLagCluster";
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

const pathWithRuns = (
    runs: Array<{ lag: number; startYear: number; endYear: number }>,
    events: DiagnosisEvent[],
): BoundedLagStateEventSet => ({
    events,
    path: {
        runs: runs.map((run, index) => ({
            ...run,
            startIndex: index * 10,
            endIndex: index * 10 + run.endYear - run.startYear,
            score: 1,
            samplePairs: run.endYear - run.startYear + 1,
        })),
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
            aggregateShiftYears: -8,
            locallyComplete: true,
        });
    });

    it("marks a matched subgroup incomplete when another chained transition is nearby", () => {
        const preferred = event(1904, -2, -1);
        const selected = selectStableNearLagCluster(
            path([event(1901, -2, -1), event(1907, -1, 0)]),
            path([
                event(1898, -3, -2),
                event(1901, -2, -1),
                event(1907, -1, 0),
            ]),
            [preferred],
        );

        expect(selected).toMatchObject({
            eventCount: 2,
            evidenceYears: [1901, 1907],
            aggregateShiftYears: -2,
            locallyComplete: false,
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

    it("selects the bark-side group when equally supported clusters overlap one mode", () => {
        const stronger = path([
            event(1900, -4, -3),
            event(1905, -3, -2),
            event(1910, -2, -1),
            event(1915, -1, 0),
        ]);
        const weaker = path([
            event(1901, -4, -3),
            event(1906, -3, -2),
            event(1911, -2, -1),
            event(1916, -1, 0),
        ]);

        expect(selectStableNearLagCluster(
            stronger,
            weaker,
            [event(1908, -2, -1)],
            6,
            2,
            2,
        )).toMatchObject({
            evidenceYears: [1911, 1916],
            representative: { rankedYears: [{ year: 1915 }] },
        });
    });
});

describe("stable terminal unit staircase frontier", () => {
    const positiveThree = (boundaryYear: number) => pathWithRuns([
        { lag: -70, startYear: 1500, endYear: 1520 },
        { lag: 3, startYear: 1521, endYear: boundaryYear - 18 },
        { lag: 2, startYear: boundaryYear - 17, endYear: boundaryYear - 10 },
        { lag: 1, startYear: boundaryYear - 9, endYear: boundaryYear - 1 },
        { lag: 0, startYear: boundaryYear, endYear: 2000 },
    ], [
        event(boundaryYear - 17, 3, 2),
        event(boundaryYear - 9, 2, 1),
        event(boundaryYear, 1, 0),
        event(1521, -70, 3),
    ]);

    const negativeThree = (boundaryYear: number) => pathWithRuns([
        { lag: -70, startYear: 1500, endYear: 1520 },
        { lag: -3, startYear: 1521, endYear: boundaryYear - 18 },
        { lag: -2, startYear: boundaryYear - 17, endYear: boundaryYear - 10 },
        { lag: -1, startYear: boundaryYear - 9, endYear: boundaryYear - 1 },
        { lag: 0, startYear: boundaryYear, endYear: 2000 },
    ], [
        event(boundaryYear - 17, -3, -2),
        event(boundaryYear - 9, -2, -1),
        event(boundaryYear, -1, 0),
        event(1521, -70, -3),
    ]);

    it("projects the newest event from a stable +3 to 0 terminal suffix", () => {
        expect(selectStableTerminalUnitStaircaseFrontier(
            positiveThree(1877),
            positiveThree(1878),
            3,
        )).toMatchObject({
            eventCount: 3,
            aggregateShiftYears: 3,
            boundaryYear: 1878,
            representative: { eventType: "falseRing" },
        });
    });

    it("projects the newest event from a stable -3 to 0 terminal suffix", () => {
        expect(selectStableTerminalUnitStaircaseFrontier(
            negativeThree(1877),
            negativeThree(1878),
            -3,
        )).toMatchObject({
            eventCount: 3,
            aggregateShiftYears: -3,
            boundaryYear: 1878,
            representative: { eventType: "missingRing" },
        });
    });

    it("does not reinterpret a direct negative partial transition as unit events", () => {
        const partial = pathWithRuns([
            { lag: -3, startYear: 1500, endYear: 1876 },
            { lag: 0, startYear: 1877, endYear: 2000 },
        ], [event(1877, -3, 0)]);
        expect(selectStableTerminalUnitStaircaseFrontier(partial, partial, -3)).toBeNull();
    });

    it("rejects a candidate depth that does not equal the complete suffix", () => {
        expect(selectStableTerminalUnitStaircaseFrontier(
            positiveThree(1877),
            positiveThree(1877),
            2,
        )).toBeNull();
    });

    it("rejects a whole-series terminal baseline instead of inventing a local event", () => {
        const whole = pathWithRuns([
            { lag: 3, startYear: 1500, endYear: 2000 },
        ], []);
        expect(selectStableTerminalUnitStaircaseFrontier(whole, whole, 3)).toBeNull();
    });

    it("rejects terminal boundaries that do not reproduce across regularizations", () => {
        expect(selectStableTerminalUnitStaircaseFrontier(
            positiveThree(1877),
            positiveThree(1882),
            3,
        )).toBeNull();
    });

    it("records distant spacing without changing the terminal event semantics", () => {
        const distant = (boundaryYear: number) => pathWithRuns([
            { lag: -3, startYear: 1700, endYear: boundaryYear - 61 },
            { lag: -2, startYear: boundaryYear - 60, endYear: boundaryYear - 31 },
            { lag: -1, startYear: boundaryYear - 30, endYear: boundaryYear - 1 },
            { lag: 0, startYear: boundaryYear, endYear: 2000 },
        ], [
            event(boundaryYear - 60, -3, -2),
            event(boundaryYear - 30, -2, -1),
            event(boundaryYear, -1, 0),
        ]);

        expect(selectStableTerminalUnitStaircaseFrontier(
            distant(1900),
            distant(1901),
            -3,
        )).toMatchObject({
            eventCount: 3,
            boundaryYear: 1901,
            maximumAdjacentTransitionGapYears: 30,
        });
    });
});

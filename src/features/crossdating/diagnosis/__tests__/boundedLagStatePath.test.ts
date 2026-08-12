import { describe, expect, it } from "vitest";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    fitBoundedLagStatePath,
    locateBoundedLagStateEvents,
} from "../eventPath";
import type { NumericSeries, SeriesCoreDiagnosis } from "../types";

const START_YEAR = 1800;
const END_YEAR = 2019;

const signal = (year: number): number => (
    1000
    + 210 * Math.sin(year * 0.731)
    + 130 * Math.cos(year * 0.193)
    + ((year * 73) % 97) * 3
);

const reference = new Map(Array.from(
    { length: END_YEAR - START_YEAR + 241 },
    (_, index) => {
        const year = START_YEAR - 120 + index;
        return [year, signal(year)] as const;
    },
));

const buildCase = (
    lagForYear: (year: number) => number,
): { diagnosis: SeriesCoreDiagnosis; site: RwlSiteData } => {
    const target: NumericSeries = new Map(Array.from(
        { length: END_YEAR - START_YEAR + 1 },
        (_, index) => {
            const year = START_YEAR + index;
            return [year, signal(year + lagForYear(year))] as const;
        },
    ));
    const referenceIds = ["REF01", "REF02", "REF03"];
    const site: RwlSiteData = new Map([
        ["TARGET", new Map(target)],
        ...referenceIds.map((id, index) => [
            id,
            new Map(Array.from(reference, ([year, value]) => [
                year,
                value + (index - 1) * Math.sin(year * 0.417),
            ])),
        ] as const),
    ]);
    return {
        site,
        diagnosis: {
            targetTree: "TARGET",
            rawTarget: target,
            targetRange: { startYear: START_YEAR, endYear: END_YEAR },
            master: {
                data: new Map(reference),
                sampleDepth: new Map(Array.from(reference.keys(), (year) => [year, 3])),
                sourceTrees: referenceIds,
            },
            segments: [],
            propagationPatterns: [],
            globalSlidingMatch: {
                seriesId: "TARGET",
                lagResults: [],
                bestGlobalLag: 0,
                bestGlobalR: null,
                bestGlobalTLike: null,
                overlapYears: END_YEAR - START_YEAR + 1,
                currentR: null,
                currentTLike: null,
                currentOverlapYears: END_YEAR - START_YEAR + 1,
            },
            unresolvedA: 0,
            unresolvedB: 0,
        },
    };
};

const pathConfig = {
    useCofechaStandardization: false,
    minLag: -100,
    maxLag: 10,
    transitionPenaltyUnit: 3,
    transitionPenaltyBig: 5,
    transitionPenaltyPerYear: 0,
    minRunYears: 18,
};

describe("bounded complete lag-state path", () => {
    it("keeps a clean chronology in one zero-lag run", () => {
        const { diagnosis, site } = buildCase(() => 0);
        const path = fitBoundedLagStatePath(diagnosis, site, pathConfig);

        expect(path?.runs.map((run) => run.lag)).toEqual([0]);
        expect(path?.transitionGain).toBe(0);
    });

    it("separates two missing rings instead of collapsing their cumulative lag", () => {
        const { diagnosis, site } = buildCase((year) => (
            year < 1870 ? -2 : year < 1940 ? -1 : 0
        ));
        const result = locateBoundedLagStateEvents(diagnosis, site, pathConfig);

        expect(result?.path.runs.map((run) => run.lag)).toEqual([-2, -1, 0]);
        expect(result?.events.map((event) => event.eventType)).toEqual([
            "missingRing",
            "missingRing",
        ]);
    });

    it("represents a missing-ring and false-ring pulse as two opposite unit events", () => {
        const { diagnosis, site } = buildCase((year) => (
            year < 1870 ? 0 : year < 1940 ? 1 : 0
        ));
        const result = locateBoundedLagStateEvents(diagnosis, site, pathConfig);

        expect(result?.path.runs.map((run) => run.lag)).toEqual([0, 1, 0]);
        expect(result?.events.map((event) => event.eventType)).toEqual([
            "falseRing",
            "missingRing",
        ]);
    });

    it("does not penalize a large partial shift into a cumulative approximation", () => {
        const { diagnosis, site } = buildCase((year) => (
            year < 1870 ? -26 : year < 1940 ? -6 : 0
        ));
        const result = locateBoundedLagStateEvents(diagnosis, site, pathConfig);

        expect(result?.path.runs.map((run) => run.lag)).toEqual([-26, -6, 0]);
        expect(result?.events.map((event) => [event.eventType, event.shiftYears])).toEqual([
            ["partialMove", -6],
            ["partialMove", -20],
        ]);
    });

    it("retains a non-zero newest run as an independent whole baseline", () => {
        const { diagnosis, site } = buildCase((year) => (year < 1900 ? 3 : 4));
        const result = locateBoundedLagStateEvents(diagnosis, site, pathConfig);

        expect(result?.path.runs.map((run) => run.lag)).toEqual([3, 4]);
        expect(result?.events.map((event) => [event.eventType, event.shiftYears])).toEqual([
            ["wholeSeriesMove", 4],
            ["missingRing", undefined],
        ]);
    });

    it("limits the dynamic program to independently supported lag states", () => {
        const { diagnosis, site } = buildCase((year) => (
            year < 1870 ? -26 : year < 1940 ? -20 : 0
        ));
        const path = fitBoundedLagStatePath(
            diagnosis,
            site,
            pathConfig,
            { allowedLags: [-26, -20, 0], terminalLags: [0] },
        );

        expect(path?.runs.map((run) => run.lag)).toEqual([-26, -20, 0]);
    });

    it("retains an evidence-supported -100 partial shift without approximation", () => {
        const { diagnosis, site } = buildCase((year) => (year < 1900 ? -100 : 0));
        const result = locateBoundedLagStateEvents(
            diagnosis,
            site,
            pathConfig,
            { allowedLags: [-100, 0], terminalLags: [0] },
        );

        expect(result?.path.runs.map((run) => run.lag)).toEqual([-100, 0]);
        expect(result?.events).toHaveLength(1);
        expect(result?.events[0]).toMatchObject({
            eventType: "partialMove",
            shiftYears: -100,
            shiftSide: "older",
        });
    });

    it("keeps an independently supplied whole lag as the newest terminal state", () => {
        const { diagnosis, site } = buildCase((year) => (year < 1900 ? 3 : 4));
        const result = locateBoundedLagStateEvents(
            diagnosis,
            site,
            pathConfig,
            {
                allowedLags: [0, 3, 4],
                terminalLags: [4],
                minimumWholeLagGain: Number.NEGATIVE_INFINITY,
            },
        );

        expect(result?.path.runs.slice(-1)[0]?.lag).toBe(4);
        expect(result?.events[0]).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: 4,
        });
    });
});

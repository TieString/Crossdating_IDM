import { describe, expect, it } from "vitest";
import { locateSegmentedLagEvents } from "../segmentedEventPath";
import type { NumericSeries, SeriesCoreDiagnosis } from "../types";

const makeSeries = (startYear: number, length: number): NumericSeries => new Map(
    Array.from({ length }, (_, index) => [
        startYear + index,
        100 + Math.sin(index / 3) * 20 + index % 7,
    ]),
);

describe("locateSegmentedLagEvents", () => {
    it("returns no event when target and master have no scoreable overlap", () => {
        const diagnosis: SeriesCoreDiagnosis = {
            targetTree: "TARGET",
            rawTarget: makeSeries(1900, 60),
            targetRange: { startYear: 1900, endYear: 1959 },
            master: {
                data: makeSeries(2100, 60),
                sampleDepth: new Map(),
                sourceTrees: ["REFERENCE"],
            },
            segments: [],
            propagationPatterns: [],
            globalSlidingMatch: {
                seriesId: "TARGET",
                lagResults: [],
                bestGlobalLag: 0,
                bestGlobalR: null,
                bestGlobalTLike: null,
                overlapYears: 0,
                currentR: null,
                currentTLike: null,
                currentOverlapYears: 0,
            },
            unresolvedA: 0,
            unresolvedB: 0,
        };

        expect(locateSegmentedLagEvents(diagnosis)).toEqual([]);
    });
});

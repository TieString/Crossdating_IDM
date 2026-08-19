import { describe, expect, it } from "vitest";
import { buildSampleDepthSeries } from "./sampleDepth";

describe("sample depth series", () => {
    it("stops at the last observed year instead of falling to zero at a stop marker", () => {
        const result = buildSampleDepthSeries(
            [1999, 2000, 2001, 2002],
            new Map([
                ["A", new Map([[1999, 20], [2000, 0], [2001, 30], [2002, -9999]])],
            ]),
            -9999,
        );
        expect(result).toEqual({ counts: [1, 1, 1, null], max: 1 });
    });

    it("breaks the line across years with no observations and counts overlapping series", () => {
        const result = buildSampleDepthSeries(
            [1900, 1901, 1902],
            new Map([
                ["A", new Map([[1900, 10], [1902, 12]])],
                ["B", new Map([[1900, 20], [1902, 22]])],
            ]),
            999,
        );
        expect(result).toEqual({ counts: [2, null, 2], max: 2 });
    });
});

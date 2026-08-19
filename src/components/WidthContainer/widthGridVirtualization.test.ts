import { describe, expect, it } from "vitest";
import { getVisibleSeriesRange, sameVisibleSeriesRange } from "./widthGridVirtualization";

const series = [
    { top: 0, bottom: 1500 },
    { top: 1512, bottom: 1812 },
    { top: 1824, bottom: 2124 },
];

describe("width-grid series virtualization", () => {
    it("keeps the same rendered range while scrolling inside one long series", () => {
        const first = getVisibleSeriesRange(series, 0, 700, 320);
        const middle = getVisibleSeriesRange(series, 400, 700, 320);
        expect(first).toEqual({ startIndex: 0, endIndex: 0 });
        expect(sameVisibleSeriesRange(first, middle)).toBe(true);
    });

    it("changes the range only when another series reaches the overscan window", () => {
        expect(getVisibleSeriesRange(series, 500, 700, 320)).toEqual({ startIndex: 0, endIndex: 1 });
        expect(getVisibleSeriesRange(series, 1700, 300, 0)).toEqual({ startIndex: 1, endIndex: 2 });
    });
});

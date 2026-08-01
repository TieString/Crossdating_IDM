import { describe, expect, it } from "vitest";
import { rebuildCurrentEventRrfTree } from "./rebuild";

describe("current-event RRF workspace rebuild", () => {
    it("removes every existing zero and rebuilds only confirmed years newest-first", () => {
        const source = new Map<number, number | null>([
            [1895, 80],
            [1896, 0],
            [1897, 110],
            [1898, 120],
            [1899, 0],
            [1900, 130],
        ]);
        const first = rebuildCurrentEventRrfTree(source, [1897, 1899, 1897]);
        const second = rebuildCurrentEventRrfTree(source, [1899, 1897]);

        expect(first.removedExistingZeroYears).toEqual([1896, 1899]);
        expect(first.confirmedYears).toEqual([1899, 1897]);
        expect(Array.from(first.data.entries())).toEqual(Array.from(second.data.entries()));
        expect(Array.from(first.data.entries()).filter(([, width]) => width === 0).map(([year]) => year))
            .toEqual([1897, 1899]);
        expect(Array.from(source.entries())).toEqual([
            [1895, 80],
            [1896, 0],
            [1897, 110],
            [1898, 120],
            [1899, 0],
            [1900, 130],
        ]);
    });

    it("fails before mutation when a confirmation is outside the rebuilt series", () => {
        const source = new Map<number, number | null>([[1900, 100], [1901, 110]]);
        expect(() => rebuildCurrentEventRrfTree(source, [1800])).toThrow(RangeError);
        expect(Array.from(source.entries())).toEqual([[1900, 100], [1901, 110]]);
    });
});

import { describe, expect, it } from "vitest";
import {
    getGridSelectAllRange,
    isGridSelectAllShortcut,
    resolveGridSelectAllTree,
} from "./gridSelectAll";

describe("width-grid Ctrl+A selection", () => {
    const availableTrees = new Set(["mon031", "mon052"]);

    it("uses the selector's concrete series before the last clicked series", () => {
        expect(resolveGridSelectAllTree("mon031", availableTrees, "mon052")).toBe("mon031");
    });

    it("uses the last clicked series when the selector is in all-series mode", () => {
        expect(resolveGridSelectAllTree("全部", availableTrees, "mon052")).toBe("mon052");
    });

    it("does not enable selection without a valid concrete series", () => {
        expect(resolveGridSelectAllTree("全部", availableTrees, null)).toBeNull();
        expect(resolveGridSelectAllTree("全部", availableTrees, "removed-series")).toBeNull();
    });

    it("recognizes only the unmodified select-all shortcut", () => {
        expect(isGridSelectAllShortcut({ key: "a", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(true);
        expect(isGridSelectAllShortcut({ key: "A", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBe(true);
        expect(isGridSelectAllShortcut({ key: "a", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(false);
        expect(isGridSelectAllShortcut({ key: "a", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe(false);
    });

    it("selects the complete editable year range and excludes the stop marker", () => {
        const treeData = new Map<number, number | null>([
            [2000, 123],
            [1998, 456],
            [2001, -9999],
            [1999, null],
        ]);

        expect(getGridSelectAllRange("mon031", treeData, -9999)).toEqual({
            tree: "mon031",
            startYear: 1998,
            endYear: 2000,
        });
    });

    it("returns no range when a series contains only a stop marker", () => {
        expect(getGridSelectAllRange("empty", new Map([[2000, -9999]]), -9999)).toBeNull();
    });
});

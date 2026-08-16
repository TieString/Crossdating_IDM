import { describe, expect, it } from "vitest";
import type { RwlEditOperation, RwlOperationLogEntry } from "@/features/rwl/edit";
import {
    buildTreeRingYearMapping,
    getFirstTreeRingScanAnchorYear,
    getTreeRingScanMarkerCount,
    type TreeRingScanSeriesState,
} from "./index";

const baseline: TreeRingScanSeriesState = {
    mode: "scan",
    anchors: [],
    baselineStartYear: 1900,
    baselineEndYear: 2024,
    baselineOperationSequence: 0,
};

const entry = (sequence: number, operation: RwlEditOperation): RwlOperationLogEntry => ({
    id: String(sequence),
    sequence,
    timestamp: "2026-08-16T00:00:00.000Z",
    action: "apply",
    operation,
    summary: "test",
    detail: "test",
    tree: "sample",
    undoDepth: sequence,
    redoDepth: 0,
});

describe("tree-ring scan original/current year mapping", () => {
    it("keeps a physical year stable across a missing-ring insertion", () => {
        const mapping = buildTreeRingYearMapping("sample", baseline, [
            entry(1, { type: "insert-missing", tree: "sample", year: 1977, side: "right" }),
        ]);
        expect(mapping.valid).toBe(true);
        expect(mapping.currentByOriginal.get(1950)).toBe(1949);
        expect(mapping.currentByOriginal.get(1978)).toBe(1978);
        expect(mapping.originalByCurrent.get(1949)).toBe(1950);
    });

    it("follows currently applied history when an insertion is undone", () => {
        const mapping = buildTreeRingYearMapping("sample", baseline, []);
        expect(mapping.currentByOriginal.get(1950)).toBe(1950);
    });

    it("restores the same physical identity after a deletion marker is restored", () => {
        const mapping = buildTreeRingYearMapping("sample", baseline, [
            entry(1, { type: "delete-year", tree: "sample", year: 1960, mode: "direct", shift: "right" }),
            entry(2, { type: "restore-deletion", tree: "sample", markerYear: 1961, index: 0 }),
        ]);
        expect(mapping.valid).toBe(true);
        expect(mapping.currentByOriginal.get(1960)).toBe(1960);
        expect(mapping.currentByOriginal.get(1950)).toBe(1950);
    });

    it("moves only identities inside a local move and drops overwritten identities", () => {
        const mapping = buildTreeRingYearMapping("sample", baseline, [
            entry(1, {
                type: "move-selection",
                tree: "sample",
                selectedStartYear: 1950,
                selectedEndYear: 1954,
                yearOffset: 2,
            }),
        ]);
        expect(mapping.currentByOriginal.get(1950)).toBe(1952);
        expect(mapping.currentByOriginal.get(1954)).toBe(1956);
        expect(mapping.currentByOriginal.get(1955)).toBeNull();
        expect(mapping.currentByOriginal.get(1949)).toBe(1949);
    });

    it("invalidates provenance after an arbitrary whole-tree replacement", () => {
        const mapping = buildTreeRingYearMapping("sample", baseline, [
            entry(1, { type: "replace-tree-data", tree: "sample" }),
        ]);
        expect(mapping.valid).toBe(false);
        expect(mapping.invalidReason).toContain("重新标注");
    });

    it("assigns decade anchors and automatic one/two/three-dot marks", () => {
        expect(getFirstTreeRingScanAnchorYear(2024)).toBe(2020);
        expect(getTreeRingScanMarkerCount(1990)).toBe(1);
        expect(getTreeRingScanMarkerCount(1950)).toBe(2);
        expect(getTreeRingScanMarkerCount(1900)).toBe(3);
    });
});

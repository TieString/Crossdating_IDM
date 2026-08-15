import { describe, expect, it } from "vitest";
import { moveSeriesTailByOffset } from "@/features/rwl/edit";
import {
    createManualMoveShiftTargets,
    createOlderSidePartialMovePlan,
    createWholeSeriesMovePlan,
    remapSelectionForMoveHistory,
} from "./manualMovePlan";

describe("manual move plans", () => {
    it("converts whole-series direction and magnitude into a signed offset", () => {
        expect(createWholeSeriesMovePlan(1800, 2024, "older", 6)).toEqual({
            selectedStartYear: 1800,
            selectedEndYear: 2024,
            yearOffset: -6,
        });
        expect(createWholeSeriesMovePlan(1800, 2024, "newer", 3)).toEqual({
            selectedStartYear: 1800,
            selectedEndYear: 2024,
            yearOffset: 3,
        });
    });

    it("uses firstFixedYear for a strictly older-side partial move", () => {
        expect(createOlderSidePartialMovePlan(1800, 2024, 1904, 4)).toEqual({
            selectedStartYear: 1800,
            selectedEndYear: 1903,
            yearOffset: -4,
        });
    });

    it("keeps the breakpoint and newer side unchanged when the plan is applied", () => {
        const source = new Map<number, number | null>([
            [1900, 10],
            [1901, 11],
            [1902, 12],
            [1903, 13],
            [1904, 14],
            [1905, 15],
        ]);
        const plan = createOlderSidePartialMovePlan(1900, 1905, 1904, 4);

        expect(plan).not.toBeNull();
        const moved = moveSeriesTailByOffset(
            source,
            plan!.selectedStartYear,
            plan!.selectedEndYear,
            plan!.yearOffset,
        );

        expect(Array.from(moved.entries())).toEqual([
            [1896, 10],
            [1897, 11],
            [1898, 12],
            [1899, 13],
            [1904, 14],
            [1905, 15],
        ]);
        expect(moved.has(1900)).toBe(false);
        expect(moved.has(1903)).toBe(false);
    });

    it("maps moved cells to their final years from an adjacent visual origin", () => {
        const plan = createOlderSidePartialMovePlan(1900, 1906, 1904, 3);

        expect(plan).not.toBeNull();
        expect(createManualMoveShiftTargets(plan!, [1899, 1900, 1901, 1903, 1904, 1906])).toEqual([
            { sourceYear: 1898, targetYear: 1897 },
            { sourceYear: 1899, targetYear: 1898 },
            { sourceYear: 1901, targetYear: 1900 },
        ]);
    });

    it("keeps every multi-year visual shift to one neighboring cell", () => {
        const plan = createWholeSeriesMovePlan(1900, 1902, "newer", 5);
        const targets = createManualMoveShiftTargets(plan!, [1900, 1901, 1902]);

        expect(targets).toEqual([
            { sourceYear: 1904, targetYear: 1905 },
            { sourceYear: 1905, targetYear: 1906 },
            { sourceYear: 1906, targetYear: 1907 },
        ]);
        expect(targets.every(({ sourceYear, targetYear }) => Math.abs(targetYear - sourceYear) === 1)).toBe(true);
    });

    it("rejects empty fixed sides and non-positive movement magnitudes", () => {
        expect(createOlderSidePartialMovePlan(1800, 2024, 1800, 4)).toBeNull();
        expect(createOlderSidePartialMovePlan(1800, 2024, 2025, 4)).toBeNull();
        expect(createOlderSidePartialMovePlan(1800, 2024, 1904, 0)).toBeNull();
        expect(createWholeSeriesMovePlan(1800, 2024, "older", -2)).toBeNull();
    });

    it("returns a moved selection to its original years on undo and reapplies it on redo", () => {
        const history = {
            tree: "TARGET",
            selectedStartYear: 1898,
            selectedEndYear: 1903,
            yearOffset: -4,
        };
        const movedSelection = {
            tree: "TARGET",
            startYear: 1894,
            endYear: 1899,
        };
        const restored = remapSelectionForMoveHistory(movedSelection, {
            ...history,
            direction: "undo",
        });

        expect(restored).toEqual({
            tree: "TARGET",
            startYear: 1898,
            endYear: 1903,
        });
        expect(remapSelectionForMoveHistory(restored, {
            ...history,
            direction: "redo",
        })).toEqual(movedSelection);
    });

    it("does not move unrelated or partially overlapping selections", () => {
        const history = {
            tree: "TARGET",
            selectedStartYear: 1900,
            selectedEndYear: 1905,
            yearOffset: 3,
            direction: "undo" as const,
        };
        const otherTree = { tree: "OTHER", startYear: 1903, endYear: 1908 };
        const partialOverlap = { tree: "TARGET", startYear: 1902, endYear: 1904 };

        expect(remapSelectionForMoveHistory(otherTree, history)).toBe(otherTree);
        expect(remapSelectionForMoveHistory(partialOverlap, history))
            .toBe(partialOverlap);
    });
});

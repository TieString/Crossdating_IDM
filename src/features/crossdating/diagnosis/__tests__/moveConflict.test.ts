import { describe, expect, it } from "vitest";
import {
    RwlEditor,
    RwlMoveConflictError,
    getSeriesMoveConflicts,
} from "@/features/rwl/edit";

const tree = new Map<number, number>([
    [1898, 10],
    [1899, 20],
    [1900, 30],
    [1901, 40],
    [1902, 50],
    [1903, 60],
    [1904, 70],
    [1905, 80],
]);

describe("partial-range move conflicts", () => {
    it("rejects a positive move before it overwrites fixed data", () => {
        expect(getSeriesMoveConflicts(tree, 1898, 1903, 2))
            .toEqual([1904, 1905]);
        const editor = new RwlEditor(new Map([["TARGET", tree]]));
        const before = [...editor.getData().get("TARGET")!.entries()];

        expect(() => editor.moveSeriesTailByOffset(
            "TARGET",
            1898,
            1903,
            2,
        )).toThrow(RwlMoveConflictError);
        expect([...editor.getData().get("TARGET")!.entries()]).toEqual(before);
        expect(editor.getHistoryStatus().undoCount).toBe(0);
    });

    it("moves the older side negatively without changing firstFixedYear onward", () => {
        expect(getSeriesMoveConflicts(tree, 1898, 1903, -4)).toEqual([]);
        const editor = new RwlEditor(new Map([["TARGET", tree]]));
        const fixedBefore = new Map(
            [...tree.entries()].filter(([year]) => year >= 1904),
        );

        editor.moveSeriesTailByOffset("TARGET", 1898, 1903, -4);
        const moved = editor.getData().get("TARGET")!;

        expect([...moved.entries()].filter(([year]) => year >= 1904))
            .toEqual([...fixedBefore.entries()]);
        expect([...moved.keys()].filter((year) => year >= 1894 && year <= 1899))
            .toEqual([1894, 1895, 1896, 1897, 1898, 1899]);
        expect([...moved.keys()].some((year) => year >= 1900 && year <= 1903))
            .toBe(false);
    });
});

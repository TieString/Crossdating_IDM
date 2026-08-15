import { describe, expect, it } from "vitest";
import { RwlEditor, deleteYearRange } from "./edit";

const createSeries = () => new Map<number, number | null>([
    [1998, 10],
    [1999, 20],
    [2000, 30],
    [2001, 40],
    [2002, 50],
    [2003, 60],
    [2004, 70],
]);

describe("deleteYearRange", () => {
    it("保持缺失时只移除选区，不移动两侧年份", () => {
        const result = deleteYearRange(createSeries(), 2000, 2002, "missing");

        expect(Array.from(result.entries())).toEqual([
            [1998, 10],
            [1999, 20],
            [2003, 60],
            [2004, 70],
        ]);
    });

    it("左侧补位时舍弃选区值并把左侧整体右移", () => {
        const source = createSeries();
        const result = deleteYearRange(source, 2000, 2002, "left");

        expect(Array.from(result.entries())).toEqual([
            [2001, 10],
            [2002, 20],
            [2003, 60],
            [2004, 70],
        ]);
        expect(Array.from(source.entries())).toEqual(Array.from(createSeries().entries()));
    });

    it("右侧补位时舍弃选区值并把右侧整体左移", () => {
        const result = deleteYearRange(createSeries(), 2000, 2002, "right");

        expect(Array.from(result.entries())).toEqual([
            [1998, 10],
            [1999, 20],
            [2000, 60],
            [2001, 70],
        ]);
    });

    it("RwlEditor 将多年补位记录为一次可撤销操作", () => {
        const editor = new RwlEditor(new Map([["TREE", createSeries()]]));

        editor.deleteYearRange("TREE", 2000, 2002, "left");

        expect(Array.from(editor.getData().get("TREE")!.entries())).toEqual([
            [2001, 10],
            [2002, 20],
            [2003, 60],
            [2004, 70],
        ]);
        expect(editor.getDeletionMarkers().get("TREE")?.get(2003)).toHaveLength(3);
        expect(editor.getOperationLog()).toHaveLength(1);
        expect(editor.getOperationLog()[0]?.operation).toEqual({
            type: "delete-year-range",
            tree: "TREE",
            startYear: 2000,
            endYear: 2002,
            fill: "left",
        });

        expect(editor.undo()).toMatchObject({ type: "delete-year-range", direction: "undo" });
        expect(Array.from(editor.getData().get("TREE")!.entries())).toEqual(Array.from(createSeries().entries()));

        expect(editor.redo()).toMatchObject({ type: "delete-year-range", direction: "redo" });
        expect(Array.from(editor.getData().get("TREE")!.entries())).toEqual([
            [2001, 10],
            [2002, 20],
            [2003, 60],
            [2004, 70],
        ]);
    });
});

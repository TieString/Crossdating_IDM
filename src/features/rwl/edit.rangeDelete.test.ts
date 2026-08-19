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

    it("一次范围删除的全部标记作为一组删除，并支持一次撤销重做", () => {
        const editor = new RwlEditor(new Map([["TREE", createSeries()]]));
        editor.deleteYearRange("TREE", 2000, 2002, "left");
        const dataAfterDelete = Array.from(editor.getData().get("TREE")!.entries());
        const markerStack = editor.getDeletionMarkers().get("TREE")!.get(2003)!;
        const expectedTopIndex = markerStack.reduce((bestIndex, marker, index) => (
            (marker.deleteOrder ?? index) > (markerStack[bestIndex]?.deleteOrder ?? bestIndex)
                ? index
                : bestIndex
        ), 0);

        editor.removeDeletionMarker("TREE", 2003);

        expect(editor.getDeletionMarkers().has("TREE")).toBe(false);
        expect(Array.from(editor.getData().get("TREE")!.entries())).toEqual(dataAfterDelete);
        const operationLog = editor.getOperationLog();
        expect(operationLog[operationLog.length - 1]?.operation).toMatchObject({
            type: "remove-deletion-marker",
            tree: "TREE",
            markerYear: 2003,
            index: expectedTopIndex,
            markerCount: 3,
        });
        expect(operationLog[operationLog.length - 1]?.summary).toBe("删除标记");

        expect(editor.undo()).toMatchObject({ type: "remove-deletion-marker", direction: "undo" });
        expect(editor.getDeletionMarkers().get("TREE")?.get(2003)).toHaveLength(3);
        expect(Array.from(editor.getData().get("TREE")!.entries())).toEqual(dataAfterDelete);

        expect(editor.redo()).toMatchObject({ type: "remove-deletion-marker", direction: "redo" });
        expect(editor.getDeletionMarkers().has("TREE")).toBe(false);
        expect(Array.from(editor.getData().get("TREE")!.entries())).toEqual(dataAfterDelete);
    });

    it("删除唯一标记后移除红线，但不恢复年份数据", () => {
        const editor = new RwlEditor(new Map([["TREE", createSeries()]]));
        editor.deleteYearWithMode("TREE", 2000, "direct", "right");
        const dataAfterDelete = Array.from(editor.getData().get("TREE")!.entries());

        expect(editor.getDeletionMarkers().get("TREE")?.get(2001)).toHaveLength(1);
        editor.removeDeletionMarker("TREE", 2001);

        expect(editor.getDeletionMarkers().has("TREE")).toBe(false);
        expect(Array.from(editor.getData().get("TREE")!.entries())).toEqual(dataAfterDelete);
    });

    it("逐次单年删除即使叠在同一红线，右键仍只移除当前一层", () => {
        const editor = new RwlEditor(new Map([["TREE", createSeries()]]));
        editor.deleteYearWithMode("TREE", 2000, "direct", "right");
        editor.deleteYearWithMode("TREE", 2000, "direct", "right");

        expect(editor.getDeletionMarkers().get("TREE")?.get(2001)).toHaveLength(2);
        editor.removeDeletionMarker("TREE", 2001);
        expect(editor.getDeletionMarkers().get("TREE")?.get(2001)).toHaveLength(1);
    });

    it("逐次单年删除叠在同一红线时，双击也只恢复最近一层", () => {
        const editor = new RwlEditor(new Map([["TREE", createSeries()]]));
        editor.deleteYearWithMode("TREE", 2000, "direct", "right");
        const dataAfterFirstDelete = Array.from(editor.getData().get("TREE")!.entries());
        editor.deleteYearWithMode("TREE", 2000, "direct", "right");

        editor.restoreDeletion("TREE", 2001);

        expect(editor.getDeletionMarkers().get("TREE")?.get(2001)).toHaveLength(1);
        expect(Array.from(editor.getData().get("TREE")!.entries())).toEqual(dataAfterFirstDelete);
    });

    it("双击范围删除标记会一次恢复该操作的全部年份", () => {
        const editor = new RwlEditor(new Map([["TREE", createSeries()]]));
        editor.deleteYearRange("TREE", 2000, 2002, "left");
        const deletedData = Array.from(editor.getData().get("TREE")!.entries());

        editor.restoreDeletion("TREE", 2003);

        expect(Array.from(editor.getData().get("TREE")!.entries())).toEqual(Array.from(createSeries().entries()));
        expect(editor.getDeletionMarkers().has("TREE")).toBe(false);
        const operationLog = editor.getOperationLog();
        expect(operationLog[operationLog.length - 1]?.operation).toMatchObject({
            type: "restore-deletion",
            markerCount: 3,
        });

        expect(editor.undo()).toMatchObject({ type: "restore-deletion", direction: "undo" });
        expect(Array.from(editor.getData().get("TREE")!.entries())).toEqual(deletedData);
        expect(editor.getDeletionMarkers().get("TREE")?.get(2003)).toHaveLength(3);
    });
});

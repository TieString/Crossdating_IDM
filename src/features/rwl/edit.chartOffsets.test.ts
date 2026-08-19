import { describe, expect, it } from "vitest";
import { RwlEditor } from "./edit";

const makeEditor = () => new RwlEditor(new Map([
    ["LEFT", new Map([[1900, 10], [1901, 11], [1902, 12]])],
    ["RIGHT", new Map([[1950, 20], [1951, 21], [1952, 22]])],
]));

describe("save-time chart offsets", () => {
    it("commits every series as one undoable transaction with grouped logs", () => {
        const editor = makeEditor();

        expect(editor.applyWholeSeriesOffsets(new Map([
            ["LEFT", -1],
            ["RIGHT", 2],
        ]))).toBe(2);

        expect(Array.from(editor.getData().get("LEFT")!.keys())).toEqual([1899, 1900, 1901]);
        expect(Array.from(editor.getData().get("RIGHT")!.keys())).toEqual([1952, 1953, 1954]);
        const logs = editor.getOperationLog();
        expect(logs).toHaveLength(2);
        expect(logs[0]?.batchId).toBeTruthy();
        expect(logs[1]?.batchId).toBe(logs[0]?.batchId);
        expect(logs.every((entry) => entry.reason === "保存时应用图表临时偏移")).toBe(true);

        expect(editor.undo()).toMatchObject({ type: "move-series-batch", direction: "undo" });
        expect(Array.from(editor.getData().get("LEFT")!.keys())).toEqual([1900, 1901, 1902]);
        expect(Array.from(editor.getData().get("RIGHT")!.keys())).toEqual([1950, 1951, 1952]);

        expect(editor.redo()).toMatchObject({ type: "move-series-batch", direction: "redo" });
        expect(Array.from(editor.getData().get("LEFT")!.keys())).toEqual([1899, 1900, 1901]);
        expect(Array.from(editor.getData().get("RIGHT")!.keys())).toEqual([1952, 1953, 1954]);
    });

    it("rejects a non-integer offset before changing any series", () => {
        const editor = makeEditor();

        expect(() => editor.applyWholeSeriesOffsets(new Map([["LEFT", 1.5]])))
            .toThrow("图表偏移不是整数");
        expect(Array.from(editor.getData().get("LEFT")!.keys())).toEqual([1900, 1901, 1902]);
        expect(editor.getOperationLog()).toHaveLength(0);
    });
});

import { describe, expect, it } from "vitest";
import { RwlEditor } from "./edit";

const fixture = () => new RwlEditor(new Map([["A", new Map([[1900, 10], [1901, 20], [1902, 30]])]]));
const data = (editor: RwlEditor) => [...editor.getData().get("A")!];

describe("immutable operation history sharing", () => {
    it("preserves every undo/redo data and log state across many edits", () => {
        const editor = fixture();
        const states = [data(editor)];
        for (let i = 1; i <= 80; i++) { editor.changeYearWidth("A", 1901, 20 + i); states.push(data(editor)); }
        for (let i = 79; i >= 0; i--) {
            editor.undo(); expect(data(editor)).toEqual(states[i]); expect(editor.getOperationLog()).toHaveLength(i);
        }
        for (let i = 1; i <= 80; i++) {
            editor.redo(); expect(data(editor)).toEqual(states[i]); expect(editor.getOperationLog()).toHaveLength(i);
        }
    });
    it("isolates exported payload mutation from live and retained history", () => {
        const editor = fixture();
        editor.changeYearWidth("A", 1901, 21);
        editor.changeYearWidth("A", 1901, 22);
        const exported = editor.getOperationLog();
        exported[0]!.afterTreeData![1]![1] = 999;
        const persisted = editor.toHistorySnapshot();
        persisted.operationLogBySeries![0]![1][0]!.afterTreeData![1]![1] = 888;
        editor.undo(); expect(editor.getData().get("A")!.get(1901)).toBe(21);
        expect(editor.getOperationLog()[0]!.afterTreeData![1]![1]).toBe(21);
        editor.redo(); expect(editor.getData().get("A")!.get(1901)).toBe(22);
    });
    it("retains operation semantics without copying width snapshots for scan mapping", () => {
        const editor = fixture(); editor.insertMissingYearAtSide("A", 1901, "right");
        const full = editor.getAllAppliedOperationLogEntries(), light = editor.getAllAppliedOperationLogEntries(false);
        expect(light[0]!.operation).toEqual(full[0]!.operation);
        expect(light[0]!.sequence).toBe(full[0]!.sequence);
        expect(light[0]!.beforeTreeData).toBeUndefined();
        expect(light[0]!.afterTreeData).toBeUndefined();
        expect(full[0]!.afterTreeData).toBeDefined();
    });
});

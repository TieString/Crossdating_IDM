import { afterEach, expect, it } from "vitest";
import { RwlEditor } from "../edit";
import { effectiveChanges, effectiveChangesCsv } from "../effectiveChanges";
import { stopMarker } from "@/shared/constants";
const oldMarker = stopMarker.value;
afterEach(() => { stopMarker.value = oldMarker; });
const editor = () => {
    stopMarker.value = -9999;
    return new RwlEditor(new Map([["A", new Map([[2000, 100], [2001, 0], [2002, 300], [2003, 400], [2004, -9999]])]]),
        { stopMarkerValue: -9999 }, "tucson");
};
const changes = (e: RwlEditor) => effectiveChanges(e.toHistorySnapshot());

it("cancels insertion then deletion of the same ring", () => {
    const e = editor(); e.insertMissingYearAtSide("A", 2002, "right"); e.deleteYearWithMode("A", 2002, "direct", "right");
    expect(changes(e)).toEqual([]);
    expect(e.getAllAppliedOperationLogEntries()).toHaveLength(2);
});
it("reduces width edits to baseline → current and cancels a return to baseline", () => {
    const e = editor(); e.changeYearWidth("A", 2000, 120); e.changeYearWidth("A", 2000, 130);
    expect(changes(e)).toMatchObject([{ type: "轮宽修改", original: "2000", oldValue: "100", newValue: "130" }]);
    e.changeYearWidth("A", 2000, 100); expect(changes(e)).toEqual([]);
});
it("combines consecutive movement of the same rings and respects undo", () => {
    const e = editor(); e.moveSeriesTailByOffset("A", 2000, 2003, 7); e.moveSeriesTailByOffset("A", 2007, 2010, -3);
    expect(changes(e)).toMatchObject([{ type: "整体年份移动", original: "2000–2003", current: "2004–2007", shift: "4" }]);
    e.undo(); expect(changes(e)[0].shift).toBe("7"); e.undo(); expect(changes(e)).toEqual([]);
});
it("tracks ring identity across insertions, later moves and value edits", () => {
    const e = editor(); e.insertMissingYearAtSide("A", 2002, "right");
    e.changeYearWidth("A", 1999, 130);
    e.moveSeriesTailByOffset("A", 1999, 2003, 7);
    const rows = changes(e);
    expect(rows.filter((r) => r.type === "轮宽修改")).toMatchObject([{ original: "2000", current: "2006", oldValue: "100", newValue: "130" }]);
    expect(rows.filter((r) => r.type === "插入缺轮")).toMatchObject([{ current: "2009" }]);
    expect(rows.filter((r) => r.type.includes("区间差异"))).toHaveLength(0);
});
it("does not cancel deleting an original ring then inserting a different value", () => {
    const e = editor(); e.deleteYearWithMode("A", 2002, "direct", "right");
    e.insertMissingYearAtSide("A", 2002, "right"); e.changeYearWidth("A", 2002, 350);
    expect(changes(e).map((r) => r.type)).toEqual(["删除伪轮/轮宽", "插入轮宽"]);
});
it("does not classify missing measurements or opaque text replacements as many shifted width changes", () => {
    const e = editor(); e.markYearRangeAsMissing("A", 2000, 2001);
    expect(changes(e).map((r) => r.type)).toEqual(["缺测标记", "缺测标记"]);
    const other = editor(); other.replaceTreeData("A", new Map([[2000, 777], [2001, 888], [2002, -9999]]));
    expect(changes(other)).toMatchObject([{ type: "区间差异（需复核）" }]);
});
it("preserves baseline and full histories beyond 500 edits across save/reopen", () => {
    const e = editor(); for (let i = 0; i < 510; i++) e.changeYearWidth("A", 2000, 200 + i);
    e.commitCurrentDataAsRawBaseline();
    const restored = editor(); restored.restorePersistedHistory(e.toHistorySnapshot());
    expect(restored.getAllAppliedOperationLogEntries()).toHaveLength(510);
    expect(changes(restored)).toMatchObject([{ oldValue: "100", newValue: "709" }]);
});
it("exports explicit renames without silently reassigning ring identity", () => {
    const e = editor(); e.changeYearWidth("A", 2000, 120);
    e.replaceAllData(new Map([["B", e.getData().get("A")!]]), e.getReadOptions(), "tucson",
        { preserveDeletionMarkers: true, treeKeyMap: new Map([["A", "B"]]) });
    expect(changes(e)).toMatchObject([{ series: "B", type: "序列改名", original: "A", current: "B" },
        { series: "B", type: "轮宽修改", oldValue: "100", newValue: "120" }]);
});
it("uses BOM, quoted Chinese columns and CRLF for Excel", () => {
    const e = editor(); e.changeYearWidth("A", 2000, 130);
    const csv = effectiveChangesCsv(e.toHistorySnapshot());
    expect(csv.startsWith('\uFEFF"序列编号"')).toBe(true); expect(csv).toContain('"轮宽修改"'); expect(csv.endsWith("\r\n")).toBe(true);
});

it("combines local moves by identity without moving the fixed side", () => {
    const e = editor(); e.moveSeriesTailByOffset("A", 2000, 2001, -2); e.moveSeriesTailByOffset("A", 1998, 1999, -3);
    expect(changes(e)).toMatchObject([{ type: "局部年份移动", original: "2000–2001", current: "1995–1996", shift: "-5" }]);
});

it("exports additions and deletions of whole series", () => {
    const e = editor(); e.deleteSeries("A");
    expect(changes(e)).toMatchObject([{ type: "序列删除" }]);
    e.replaceAllData(new Map([["NEW", new Map([[1990, 10], [1991, -9999]])]]), { stopMarkerValue: -9999 }, "tucson");
    expect(changes(e).map((r) => r.type)).toEqual(["序列删除", "序列新增"]);
});

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { parseTucson } from "@/features/rwl/parsers/tucson";
import { RwlEditor } from "@/features/rwl/edit";
import { stopMarker } from "@/shared/constants";
import { effectiveChanges } from "@/features/rwl/effectiveChanges";
import { createEmptyTreeRingScanState } from "@/features/treeRingScans";
import { exportWorkspacePackage, importWorkspacePackage, matchWorkspaceRwl, restoredWorkspaceEditor, sha256, workspaceRwl } from "./package";

const initialMarker = stopMarker.value;
afterEach(() => { stopMarker.value = initialMarker; });
const line = (id: string, year: number, values: number[]) => id.padEnd(8) + String(year).padStart(4) + values.map((v) => String(v).padStart(6)).join("");
const source = [line("A", 2000, [10, 0, 30, 40, 999]), line("B", 2000, [100, 999, 300, -9999])].join("\n");
const fixture = () => {
    stopMarker.value = -9999;
    const parsed = parseTucson(source, { stopMarker: -9999 });
    const editor = new RwlEditor(parsed.data, parsed.readOptions, "tucson");
    editor.insertMissingYearAtSide("A", 2002, "right");
    editor.deleteYearWithMode("B", 2001, "direct", "right");
    editor.markYearRangeAsMissing("A", 1999, 1999);
    return editor;
};
const pack = (editor: RwlEditor) => exportWorkspacePackage({ fileName: "D:\\old\\BL1.rwl", editor, reference: null });

describe("cdworkspace contract", () => {
    it("preserves same-name boundaries, source units and real 999 through transfer and reopen", async () => {
        const text = [line("A",1990,[100,999,120,999]),line("A",1994,[999,130,-9999])].join("\n");
        const parsed = parseTucson(text);
        const editor = new RwlEditor(parsed.data, parsed.readOptions, "tucson");
        const bundle = await importWorkspacePackage(await pack(editor));
        const restored = restoredWorkspaceEditor(bundle, "E:/new/A.rwl");
        expect(restored.getData()).toEqual(editor.getData());
        expect(restored.getReadOptions()?.tucsonSegments).toEqual(parsed.readOptions?.tucsonSegments);
        expect(restored.exportAsRwlString().trim().split(/\r?\n/)).toEqual(text.split("\n"));
        const reopened = new RwlEditor(parsed.data, parsed.readOptions, "tucson");
        reopened.restorePersistedHistory(restored.toHistorySnapshot());
        expect(reopened.getData()).toEqual(editor.getData());
        expect(reopened.exportAsRwlString()).toBe(restored.exportAsRwlString());
    });
    it.each(["ca646.rwl", "co589.rwl", "co612.rwl", "or093.rwl", "paki033.rwl", "ut529.rwl"])("migrates the real %s fixture without writing the source", async (file) => {
        const path = resolve("test-data", file), original = readFileSync(path);
        const parsed = parseTucson(original.toString("utf8"), { stopMarker: -9999 });
        stopMarker.value = -9999;
        const editor = new RwlEditor(parsed.data, parsed.readOptions, "tucson");
        const [id, tree] = [...parsed.data][0];
        const year = [...tree.keys()].sort((a, b) => a - b)[1];
        editor.insertMissingYearAtSide(id, year, "right");
        const bundle = await importWorkspacePackage(await exportWorkspacePackage({ fileName: file, editor, reference: null }));
        const restored = restoredWorkspaceEditor(bundle, "E:/renamed.rwl");
        expect(restored.getData()).toEqual(editor.getData());
        expect(restored.toHistorySnapshot().comparisonBaseline).toEqual(editor.toHistorySnapshot().comparisonBaseline);
        expect(restored.getDeletionMarkers()).toEqual(editor.getDeletionMarkers());
        expect(await matchWorkspaceRwl(bundle, original.toString("utf8"))).toBe("baseline");
        expect(await sha256(readFileSync(path))).toBe(await sha256(original));
    });
    it("round-trips data, comparison baseline, mixed precision, logs and deletion/insert/missing provenance", async () => {
        const editor = fixture();
        const before = editor.toHistorySnapshot();
        const bytes = await pack(editor);
        expect(Object.keys(unzipSync(bytes)).sort()).toEqual(["manifest.json", "workspace.json"]);
        const bundle = await importWorkspacePackage(bytes);
        const restored = restoredWorkspaceEditor(bundle, "E:\\renamed.rwl");
        const after = restored.toHistorySnapshot();
        expect(after.workingData).toEqual(before.workingData);
        expect(after.rawData).toEqual(before.rawData);
        expect(after.comparisonBaseline).toEqual(before.comparisonBaseline);
        expect(after.deletionMarkers).toEqual(before.deletionMarkers);
        expect(after.readOptions).toEqual(before.readOptions);
        expect(effectiveChanges(after)).toEqual(effectiveChanges(before));
        expect(restored.getAllAppliedOperationLogEntries().map((l) => l.operation)).toEqual(editor.getAllAppliedOperationLogEntries().map((l) => l.operation));
        expect(restored.getAllAppliedOperationLogEntries().every((l) => l.projectId === "E:\\renamed.rwl")).toBe(true);
        const [markerYear, deleted] = [...restored.getDeletionMarkers().get("B")!][0];
        expect(deleted[0].deletedWidth).toBe(999);
        restored.restoreDeletion("B", markerYear, 0);
        expect(restored.getData().get("B")!.get(2001)).toBe(999);
        expect(before.comparisonBaseline!.data.find(([id]) => id === "A")![1].filter(([, v]) => v === 0)).toHaveLength(1);
        expect(before.operationLogBySeries!.flatMap(([, logs]) => logs).filter((l) => l.operation?.type === "insert-missing")).toHaveLength(1);
        expect(editor.toHistorySnapshot()).toMatchObject({ workingData: before.workingData, comparisonBaseline: before.comparisonBaseline });
    });
    it("matches renamed/reformatted files against both original and current content identities", async () => {
        const editor = fixture(); const bundle = await importWorkspacePackage(await pack(editor));
        expect(await matchWorkspaceRwl(bundle, source.replace(/\n/g, "\r\n"))).toBe("baseline");
        expect(await matchWorkspaceRwl(bundle, workspaceRwl(bundle.workspace.history))).toBe("current");
        expect(await matchWorkspaceRwl(bundle, source.replace("    10", "    11"))).toBe("mismatch");
    });
    it("repeated import replaces rather than stacks logs or marks, and snapshot reopen retains them", async () => {
        const bundle = await importWorkspacePackage(await pack(fixture()));
        const once = restoredWorkspaceEditor(bundle, "new.rwl");
        const twice = restoredWorkspaceEditor(bundle, "new.rwl");
        const reopened = new RwlEditor(new Map()); reopened.restorePersistedHistory(twice.toHistorySnapshot());
        expect(reopened.getData()).toEqual(once.getData());
        expect(reopened.getOperationLog()).toEqual(once.getOperationLog());
        expect(reopened.getDeletionMarkers()).toEqual(once.getDeletionMarkers());
        expect(reopened.toHistorySnapshot().comparisonBaseline).toEqual(once.toHistorySnapshot().comparisonBaseline);
    });
    it("rejects tampering, unsupported versions and illegal ZIP paths before any restoration", async () => {
        const editor = fixture(); const original = editor.exportAsRwlString();
        const entries = unzipSync(await pack(editor));
        const malformed = { ...entries, "../workspace.json": entries["workspace.json"] };
        await expect(importWorkspacePackage(zipSync(malformed))).rejects.toThrow("ZIP");
        const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
        await expect(importWorkspacePackage(zipSync({ ...entries, "manifest.json": strToU8(JSON.stringify({ ...manifest, version: 99 })) }))).rejects.toThrow("版本");
        await expect(importWorkspacePackage(zipSync({ ...entries, "workspace.json": strToU8("{}") }))).rejects.toThrow("SHA-256");
        expect(editor.exportAsRwlString()).toBe(original);
    });
    it("rejects structurally invalid snapshots even if their checksum was recomputed", async () => {
        const entries = unzipSync(await pack(fixture()));
        const workspace = JSON.parse(strFromU8(entries["workspace.json"]));
        workspace.history.workingData[0][1].push(workspace.history.workingData[0][1][0]);
        const modified = strToU8(JSON.stringify(workspace));
        const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
        manifest.workspaceSha256 = await sha256(modified);
        await expect(importWorkspacePackage(zipSync({ "workspace.json": modified, "manifest.json": strToU8(JSON.stringify(manifest)) }))).rejects.toThrow("重复年份");
    });

    it("retains scan calibration and hash identity without shipping paths or image bytes", async () => {
        const scans = createEmptyTreeRingScanState();
        scans.folderPath = "D:/private/scans";
        scans.filesBySeries.a = { path: "D:/private/scans/A.tif", name: "A.tif", extension: "tif" };
        scans.series.a = { mode: "scan", imagePath: "D:/private/scans/A.tif", imageSha256: "a".repeat(64),
            anchors: [{ originalYear: 2000, xRatio: 0.1, yRatio: 0.2, markerCount: 3 }, { originalYear: 1990, xRatio: 0.8, yRatio: 0.2, markerCount: 1 }],
            baselineWidths: [[2000, 100]], baselineStartYear: 2000, baselineEndYear: 2003, baselineOperationSequence: 0,
            crop: { xRatio: 0, yRatio: 0, widthRatio: 1, heightRatio: 1 } };
        const data = await exportWorkspacePackage({ fileName: "test.rwl", editor: fixture(), reference: null, scans });
        const bundle = await importWorkspacePackage(data);
        expect(bundle.workspace.scans.series.a.anchors).toEqual(scans.series.a.anchors);
        expect(bundle.workspace.scans.series.a.baselineWidths).toEqual(scans.series.a.baselineWidths);
        expect(bundle.workspace.scans.series.a.imageSha256).toBe("a".repeat(64));
        expect(bundle.workspace.scans.filesBySeries).toEqual({});
        expect(bundle.workspace.scans.series.a.imagePath).toBeUndefined();
        expect(strFromU8(unzipSync(data)["workspace.json"])).not.toContain("D:/private");
        expect(scans.filesBySeries.a.path).toBe("D:/private/scans/A.tif");
    });
});

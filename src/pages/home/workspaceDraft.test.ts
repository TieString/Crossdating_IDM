import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RwlEditor } from "@/features/rwl/edit";
import { resolveWorkspaceDraft } from "./workspaceDraft";
import { loadPersistedHistorySnapshot, persistHistorySnapshot } from "./workspacePersistence";
import { commitWorkspaceImport } from "./workspaceImport";
import { exportWorkspacePackage, importWorkspacePackage } from "@/features/workspaceTransfer/package";
import { buildRwlDisplayUnits, displayUnitFor, displayWidth } from "@/features/rwl/displayUnits";

const backend = vi.hoisted(() => ({
    native: true,
    files: new Map<string, string>(),
    write: vi.fn<(path: string, content: string) => Promise<void>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => backend.native }));
vi.mock("@tauri-apps/api/path", () => ({
    appDataDir: async () => "app-data",
    join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
    exists: async (path: string) => backend.files.has(path),
    mkdir: async () => undefined,
    readTextFile: async (path: string) => backend.files.get(path),
    writeTextFile: (path: string, content: string) => backend.write(path, content),
    rename: async (from: string, to: string) => {
        const content = backend.files.get(from);
        if (!content) throw new Error("missing staging file");
        backend.files.set(to, content); backend.files.delete(from);
    },
}));

const diskEditor = () => new RwlEditor(new Map([
    ["TEST", new Map([[2000, 120], [2001, 230], [2002, -9999]])],
]), { stopMarkerValue: -9999 }, "tucson");
const changedEditor = () => {
    const editor = diskEditor();
    editor.changeYearWidth("TEST", 2001, 999);
    return editor;
};

beforeEach(() => {
    backend.files.clear();
    backend.write.mockReset();
    backend.write.mockImplementation(async (path, content) => { backend.files.set(path, content); });
    const local = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => { local.set(key, value); },
        removeItem: (key: string) => { local.delete(key); },
    } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe.each([true, false])("draft conflict resolution (native=%s)", (native) => {
    beforeEach(() => { backend.native = native; });
    it("uses disk display units when values match a stale-unit cache, preserving its baseline and logs", async () => {
        const source = new Map([["TEST",new Map([[1960,7050],[1961,8150],[1962,-9999]])]]);
        const cached = new RwlEditor(source,{stopMarkerValue:-9999,tucsonOutputMarkers:{TEST:-9999}},"tucson");
        cached.setProjectId("units.rwl");
        cached.changeYearWidth("TEST",1960,7060);
        const before=cached.toHistorySnapshot();
        const disk=new RwlEditor(cached.getData(),{stopMarkerValue:-9999,tucsonOutputMarkers:{TEST:999},
            tucsonSegments:[{id:"TEST",startYear:1960,endYear:1961,terminalYear:1962,marker:999}]},"tucson");
        const choose=vi.fn(async()=>false);
        const restored=await resolveWorkspaceDraft("units.rwl",disk,before,choose);
        const units=buildRwlDisplayUnits(restored.getData(),restored.getReadOptions());
        expect(displayWidth(restored.getData().get("TEST")!.get(1960)!,displayUnitFor(units,"TEST",1960),units.workingMarker)).toBe(706);
        expect(restored.toHistorySnapshot().comparisonBaseline).toEqual(before.comparisonBaseline);
        expect(restored.toHistorySnapshot().operationLogBySeries).toEqual(before.operationLogBySeries);
        const saved=(await loadPersistedHistorySnapshot("units.rwl"))!;
        expect(saved.readOptions).toEqual(disk.getReadOptions());
        const reopened=await resolveWorkspaceDraft("units.rwl",disk,saved,choose);
        expect(reopened.getReadOptions()).toEqual(disk.getReadOptions());
        expect(choose).not.toHaveBeenCalled();
    });

    it("persists a disk choice without needing an edit/save and does not prompt on later opens", async () => {
        const path = "site.rwl";
        await persistHistorySnapshot(path, changedEditor());
        const choose = vi.fn(async () => false);
        const disk = diskEditor();
        const result = await resolveWorkspaceDraft(path, disk, (await loadPersistedHistorySnapshot(path))!, choose);
        expect(result).toBe(disk);
        expect(result.getOperationLog()).toEqual([]);
        for (let reopen = 0; reopen < 3; reopen++) {
            const reopened = await resolveWorkspaceDraft(path, diskEditor(), (await loadPersistedHistorySnapshot(path))!, choose);
            expect(reopened.getData()).toEqual(disk.getData());
            expect(reopened.toHistorySnapshot().rawData).toEqual(disk.toHistorySnapshot().rawData);
        }
        expect(choose).toHaveBeenCalledTimes(1);
    });

    it("preserves the chosen draft and leaves other files' drafts unchanged", async () => {
        await persistHistorySnapshot("site.rwl", changedEditor());
        await persistHistorySnapshot("other.rwl", changedEditor());
        const before = await loadPersistedHistorySnapshot("other.rwl");
        const snapshot = (await loadPersistedHistorySnapshot("site.rwl"))!;
        const retained = await resolveWorkspaceDraft("site.rwl", diskEditor(), snapshot, async () => true);
        expect(retained.getData().get("TEST")!.get(2001)).toBe(999);
        expect(await loadPersistedHistorySnapshot("site.rwl")).toEqual(snapshot);
        await resolveWorkspaceDraft("site.rwl", diskEditor(), snapshot, async () => false);
        expect(await loadPersistedHistorySnapshot("other.rwl")).toEqual(before);
    });

    it("commits the entire imported state and restores it after reopening at a new path", async () => {
        const source = changedEditor();
        const bundle = await importWorkspacePackage(await exportWorkspacePackage({ fileName: "old.rwl", editor: source, reference: null }));
        const imported = await commitWorkspaceImport(bundle, "new-name.rwl");
        const persisted = (await loadPersistedHistorySnapshot("new-name.rwl"))!;
        const reopened = diskEditor(); reopened.restorePersistedHistory(persisted);
        expect(reopened.getData()).toEqual(imported.getData());
        expect(reopened.getOperationLog()).toEqual(imported.getOperationLog());
        expect(persisted.comparisonBaseline).toEqual(source.toHistorySnapshot().comparisonBaseline);
        expect(persisted.workspaceContext).toEqual(imported.toHistorySnapshot().workspaceContext);
        await commitWorkspaceImport(bundle, "new-name.rwl");
        expect((await loadPersistedHistorySnapshot("new-name.rwl"))!.operationLogCounter).toBe(1);
    });
});

it("does not activate imported data or overwrite a prior durable snapshot when staging fails", async () => {
    backend.native = true;
    const source = changedEditor();
    const bundle = await importWorkspacePackage(await exportWorkspacePackage({ fileName: "old.rwl", editor: source, reference: null }));
    let active = diskEditor();
    await persistHistorySnapshot("current.rwl", active);
    const stored = await loadPersistedHistorySnapshot("current.rwl");
    backend.write.mockRejectedValueOnce(new Error("disk full"));
    await expect(commitWorkspaceImport(bundle, "current.rwl").then((editor) => { active = editor; })).rejects.toThrow("disk full");
    expect(active.getData()).toEqual(diskEditor().getData());
    expect(await loadPersistedHistorySnapshot("current.rwl")).toEqual(stored);
});

it("writes the disk choice after an older in-flight native write has completed", async () => {
    backend.native = true;
    let finishOldWrite!: () => void;
    const oldWriteGate = new Promise<void>((resolve) => { finishOldWrite = resolve; });
    backend.write.mockImplementationOnce(async (path, content) => {
        await oldWriteGate;
        backend.files.set(path, content);
    });
    const oldEditor = changedEditor();
    const pending = persistHistorySnapshot("race.rwl", oldEditor);
    await vi.waitFor(() => expect(backend.write).toHaveBeenCalledTimes(1));
    const resolution = resolveWorkspaceDraft("race.rwl", diskEditor(), oldEditor.toHistorySnapshot(), async () => false);
    finishOldWrite();
    await Promise.all([pending, resolution]);
    const reopened = (await loadPersistedHistorySnapshot("race.rwl"))!;
    expect(reopened.workingData).toEqual(diskEditor().toHistorySnapshot().workingData);
    expect(backend.write).toHaveBeenCalledTimes(2);
});

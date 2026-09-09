import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cancelCacheCleanup, getCacheUsage, pendingCacheCleanup,
    runPendingCacheCleanup, scheduleCacheCleanup } from "./cacheMaintenance";

const fs = vi.hoisted(() => ({
    entries: new Map<string, { isDirectory: boolean; isFile: boolean; isSymlink: boolean; size: number }>(),
    remove: vi.fn<(path: string) => Promise<void>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/path", () => ({
    appDataDir: async () => "/app/data", appCacheDir: async () => "/app/cache",
    join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
    exists: async (path: string) => fs.entries.has(path),
    lstat: async (path: string) => fs.entries.get(path),
    readDir: async (path: string) => [...fs.entries].filter(([key]) => key.startsWith(path + "/")
        && !key.slice(path.length + 1).includes("/"))
        .map(([key, info]) => ({ name: key.slice(path.length + 1), ...info })),
    remove: (path: string) => fs.remove(path),
}));

const historyPath = "/app/data/workspace-state-v1/history-0123456789abcdef.json";
const reportPath = "/app/data/workspace-state-v1/cofecha-0123456789abcdef.json";
const originalPath = "/user/source.rwl";
const addFile = (path: string) => fs.entries.set(path,
    { isDirectory: false, isFile: true, isSymlink: false, size: 100 });
beforeEach(() => {
    fs.entries.clear();
    fs.remove.mockReset();
    fs.remove.mockImplementation(async (path) => { fs.entries.delete(path); });
    for (const dir of ["/app/data/cofecha-work", "/app/cache/tree-ring-scans-v1", "/app/data/workspace-state-v1"]) {
        fs.entries.set(dir, { isDirectory: true, isFile: false, isSymlink: false, size: 0 });
    }
    for (const file of [historyPath, reportPath, originalPath,
        "/app/data/settings.json", "/app/data/cofecha-work/VERYCOF.OUT", "/app/cache/tree-ring-scans-v1/image.png"]) addFile(file);
    const stored = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: {
        get length() { return stored.size; },
        key: (index: number) => [...stored.keys()][index] ?? null,
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value); },
        removeItem: (key: string) => { stored.delete(key); },
    } });
});
afterEach(() => vi.unstubAllGlobals());

describe("cache maintenance", () => {
    it("schedules/cancels without deleting anything during the active session", async () => {
        scheduleCacheCleanup(true);
        expect(pendingCacheCleanup()).toEqual({ includeWorkspaces: true });
        expect(fs.remove).not.toHaveBeenCalled();
        cancelCacheCleanup();
        await runPendingCacheCleanup();
        expect(fs.remove).not.toHaveBeenCalled();
    });

    it("clears regenerable files while preserving drafts, settings and originals by default", async () => {
        window.localStorage.setItem("crossdating:rwl-operation-journal:v1:old-name.rwl", "draft");
        window.localStorage.setItem("crossdating:cofecha-state:v1:old-name.rwl", "report");
        const usage = await getCacheUsage();
        expect(usage.temporary.files).toBe(4);
        expect(usage.workspace.files).toBe(2);
        scheduleCacheCleanup(false);
        await runPendingCacheCleanup();
        expect(fs.entries.has(historyPath)).toBe(true);
        expect(fs.entries.has(originalPath)).toBe(true);
        expect(fs.entries.has("/app/data/settings.json")).toBe(true);
        expect(fs.entries.has(reportPath)).toBe(false);
        expect(window.localStorage.getItem("crossdating:rwl-operation-journal:v1:old-name.rwl")).toBe("draft");
        expect(window.localStorage.getItem("crossdating:cofecha-state:v1:old-name.rwl")).toBeNull();
        expect(pendingCacheCleanup()).toBeNull();
    });

    it("explicit workspace cleanup also removes old-name legacy drafts so migration cannot restore them", async () => {
        window.localStorage.setItem("crossdating:rwl-operation-journal:v1:old-name.rwl", "draft");
        window.localStorage.setItem("crossdating:tree-ring-scans:v1:old-name.rwl", "annotations");
        window.localStorage.setItem("crossdating:settings:v1", "settings");
        scheduleCacheCleanup(true);
        await runPendingCacheCleanup();
        expect(fs.entries.has(historyPath)).toBe(false);
        expect(window.localStorage.getItem("crossdating:rwl-operation-journal:v1:old-name.rwl")).toBeNull();
        expect(window.localStorage.getItem("crossdating:tree-ring-scans:v1:old-name.rwl")).toBeNull();
        expect(window.localStorage.getItem("crossdating:settings:v1")).toBe("settings");
        expect(fs.entries.has(originalPath)).toBe(true);
    });

    it("never follows directory symlinks or removes unknown workspace files", async () => {
        const link = "/app/data/cofecha-work/link";
        fs.entries.set(link, { isDirectory: true, isFile: false, isSymlink: true, size: 0 });
        addFile(link + "/source.rwl");
        addFile("/app/data/workspace-state-v1/user.json");
        scheduleCacheCleanup(true);
        await runPendingCacheCleanup();
        expect(fs.entries.has(link + "/source.rwl")).toBe(true);
        expect(fs.entries.has("/app/data/workspace-state-v1/user.json")).toBe(true);
    });
});

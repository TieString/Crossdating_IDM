import { isTauri } from "@tauri-apps/api/core";
import { appCacheDir, appDataDir, join } from "@tauri-apps/api/path";
import { exists, lstat, readDir, remove } from "@tauri-apps/plugin-fs";

const REQUEST_KEY = "crossdating:cache-cleanup-request:v1";
const RESULT_KEY = "crossdating:cache-cleanup-result:v1";
const REPORT_PREFIX = "crossdating:cofecha-state:v1:";
const WORKSPACE_PREFIXES = ["crossdating:reference-state:v1:",
    "crossdating:rwl-operation-journal:v1:", "crossdating:tree-ring-scans:v1:"];
const workspaceFile = /^(history|reference|tree-ring-scans)-[a-f0-9]{16}\.json$/;
const reportFile = /^cofecha-[a-f0-9]{16}\.json$/;
export type CacheGroup = "temporary" | "workspace";
export type CacheUsage = Record<CacheGroup, { files: number; bytes: number }>;
type CacheEntry = { path: string; group: CacheGroup; bytes: number; storage?: true };

export function pendingCacheCleanup(): { includeWorkspaces: boolean } | null {
    const raw = window.localStorage.getItem(REQUEST_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed?.version === 1 && typeof parsed.includeWorkspaces === "boolean"
            ? { includeWorkspaces: parsed.includeWorkspaces } : null;
    } catch { return null; }
}

export function scheduleCacheCleanup(includeWorkspaces: boolean): void {
    window.localStorage.setItem(REQUEST_KEY, JSON.stringify({ version: 1, includeWorkspaces }));
}

export function cancelCacheCleanup(): void {
    window.localStorage.removeItem(REQUEST_KEY);
}

export function lastCacheCleanupResult(): string | null {
    return window.localStorage.getItem(RESULT_KEY);
}

async function collectEntries(): Promise<CacheEntry[]> {
    const entries: CacheEntry[] = [];
    if (isTauri()) {
        const data = await appDataDir();
        const cache = await appCacheDir();
        // All deletion candidates originate in these app-owned directories.
        // Never follow links, or use the source RWL paths stored in envelopes.
        const walk = async (dir: string, nested: boolean) => {
            if (!await exists(dir)) return;
            const info = await lstat(dir);
            if (!info.isDirectory || info.isSymlink) return;
            for (const child of await readDir(dir)) {
                if (child.isSymlink) continue;
                const path = await join(dir, child.name);
                if (child.isDirectory && nested) await walk(path, true);
                else if (child.isFile) {
                    const group = nested || reportFile.test(child.name) ? "temporary"
                        : workspaceFile.test(child.name) ? "workspace" : null;
                    if (group) entries.push({ path, group, bytes: (await lstat(path)).size });
                }
            }
        };
        await walk(await join(data, "cofecha-work"), true);
        await walk(await join(cache, "tree-ring-scans-v1"), true);
        await walk(await join(data, "workspace-state-v1"), false);
    }
    const storage = window.localStorage;
    for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key) continue;
        const group = key.startsWith(REPORT_PREFIX) ? "temporary"
            : WORKSPACE_PREFIXES.some((prefix) => key.startsWith(prefix)) ? "workspace" : null;
        if (group) entries.push({ path: key, group, storage: true,
            bytes: new Blob([storage.getItem(key) ?? ""]).size });
    }
    return entries;
}

export async function getCacheUsage(): Promise<CacheUsage> {
    const usage: CacheUsage = { temporary: { files: 0, bytes: 0 }, workspace: { files: 0, bytes: 0 } };
    for (const entry of await collectEntries()) {
        usage[entry.group].files++;
        usage[entry.group].bytes += entry.bytes;
    }
    return usage;
}

/** Main-window bootstrap only, before React/workspace migration or any workers. */
export async function runPendingCacheCleanup(): Promise<void> {
    const request = pendingCacheCleanup();
    if (!request) return;
    let removed = 0;
    let failed = 0;
    for (const entry of await collectEntries()) {
        if (entry.group === "workspace" && !request.includeWorkspaces) continue;
        try {
            if (entry.storage) window.localStorage.removeItem(entry.path);
            else {
                // Check again immediately before deletion; remove files only.
                const info = await lstat(entry.path);
                if (!info.isFile || info.isSymlink) continue;
                await remove(entry.path);
            }
            removed++;
        } catch { failed++; }
    }
    window.localStorage.setItem(RESULT_KEY,
        `上次清理：已删除 ${removed} 项${failed ? `，${failed} 项未能删除，请重新安排清理` : ""}。`);
    cancelCacheCleanup();
}

import type { ICofechaResult } from "@/features/cofecha/types";
import type { ReferenceSeriesConfig } from "@/features/crossdating/reference";
import { RwlEditor, type RwlOperationLogEntry } from "@/features/rwl/edit";
import {
    isPersistedTreeRingScanState,
    type PersistedTreeRingScanState,
} from "@/features/treeRingScans";
import { isTauri } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { CofechaVersion } from "./homeShared";

const COFECHA_STORAGE_PREFIX = "crossdating:cofecha-state:v1:";
const REFERENCE_STORAGE_PREFIX = "crossdating:reference-state:v1:";
const HISTORY_STORAGE_PREFIX = "crossdating:rwl-operation-journal:v1:";
const TREE_RING_SCAN_STORAGE_PREFIX = "crossdating:tree-ring-scans:v1:";
const WORKSPACE_STATE_DIR_NAME = "workspace-state-v1";

type WorkspaceStateKind = "cofecha" | "reference" | "history" | "tree-ring-scans";

type WorkspaceStateEnvelope<T> = {
    version: 1;
    filePath: string;
    value: T;
};

const workspaceWriteQueues = new Map<string, Promise<void>>();
let legacyMigrationPromise: Promise<void> | null = null;
let workspaceStateDirPromise: Promise<string> | null = null;
const runningInTauri = () => typeof window !== "undefined" && isTauri();

export type SerializedCofechaResult = Omit<ICofechaResult, "masterDatingSeries" | "masterCorrelations" | "seriesProblemCounts" | "possibleProblemsDetail"> & {
    masterDatingSeries: Array<[number, number]>;
    masterCorrelations: Array<[string, number]>;
    seriesProblemCounts: Array<[string, number]>;
    possibleProblemsDetail: Array<[string, string]>;
};

export type PersistedCofechaState = {
    version: 1;
    savedAt: string;
    outFileContent: string;
    cofechaResult?: SerializedCofechaResult;
    cofechaVersion: CofechaVersion;
    selectedPart: string;
    // 该 .OUT 对应数据的签名（hashRwlSiteData）。恢复后据此判断 .OUT 是否仍与当前数据匹配——
    // 匹配则可直接把 COFECHA 文本用于诊断（无需先重跑），不匹配则视为过期。
    cofechaInputSignature?: string;
};

export type PersistedReferenceState = {
    version: 1;
    savedAt: string;
    referenceConfig: ReferenceSeriesConfig | null;
    dynamicReferenceConfig?: ReferenceSeriesConfig | null;
    referenceOperationLog: RwlOperationLogEntry[];
    referenceOperationCounter: number;
};

const getCofechaStorageKey = (filePath: string) => `${COFECHA_STORAGE_PREFIX}${filePath}`;
const getReferenceStorageKey = (filePath: string) => `${REFERENCE_STORAGE_PREFIX}${filePath}`;
const getHistoryStorageKey = (filePath: string) => `${HISTORY_STORAGE_PREFIX}${filePath}`;

const getLegacyStorageKey = (kind: WorkspaceStateKind, filePath: string) => {
    switch (kind) {
        case "cofecha":
            return getCofechaStorageKey(filePath);
        case "reference":
            return getReferenceStorageKey(filePath);
        case "history":
            return getHistoryStorageKey(filePath);
        case "tree-ring-scans":
            return `${TREE_RING_SCAN_STORAGE_PREFIX}${filePath}`;
    }
};

const stablePathHash = (value: string) => {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ (code + index), 0x85ebca6b);
    }
    return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
};

const getWorkspaceStateDir = () => {
    if (!workspaceStateDirPromise) {
        workspaceStateDirPromise = (async () => {
            const stateDir = await join(await appDataDir(), WORKSPACE_STATE_DIR_NAME);
            if (!await exists(stateDir)) {
                await mkdir(stateDir, { recursive: true });
            }
            return stateDir;
        })().catch((error) => {
            workspaceStateDirPromise = null;
            throw error;
        });
    }
    return workspaceStateDirPromise;
};

const getWorkspaceStateFilePath = async (kind: WorkspaceStateKind, filePath: string) => {
    const stateDir = await getWorkspaceStateDir();
    return join(stateDir, `${kind}-${stablePathHash(filePath)}.json`);
};

const enqueueWorkspaceFileWrite = async (path: string, content: string) => {
    const previous = workspaceWriteQueues.get(path) ?? Promise.resolve();
    const current = previous
        .catch(() => undefined)
        .then(() => writeTextFile(path, content));
    workspaceWriteQueues.set(path, current);
    try {
        await current;
    } finally {
        if (workspaceWriteQueues.get(path) === current) {
            workspaceWriteQueues.delete(path);
        }
    }
};

const loadLegacyState = <T>(
    storageKey: string,
    isValid: (value: unknown) => value is T,
    label: string,
): T | null => {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        return isValid(parsed) ? parsed : null;
    } catch (error) {
        console.warn(`读取${label}旧缓存失败:`, error);
        return null;
    }
};

const removeLegacyState = (storageKey: string) => {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.removeItem(storageKey);
    } catch (error) {
        console.warn("清理已迁移的工作区旧缓存失败:", error);
    }
};

const persistWorkspaceState = async <T>(
    kind: WorkspaceStateKind,
    filePath: string,
    value: T,
    label: string,
) => {
    const legacyKey = getLegacyStorageKey(kind, filePath);
    if (runningInTauri()) {
        try {
            const statePath = await getWorkspaceStateFilePath(kind, filePath);
            const envelope: WorkspaceStateEnvelope<T> = {
                version: 1,
                filePath,
                value,
            };
            await enqueueWorkspaceFileWrite(statePath, JSON.stringify(envelope));
            removeLegacyState(legacyKey);
            return;
        } catch (error) {
            console.warn(`保存${label}到应用数据目录失败，回退到浏览器缓存:`, error);
        }
    }

    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(legacyKey, JSON.stringify(value));
    } catch (error) {
        console.warn(`保存${label}失败:`, error);
    }
};

const loadWorkspaceState = async <T>(
    kind: WorkspaceStateKind,
    filePath: string,
    isValid: (value: unknown) => value is T,
    label: string,
): Promise<T | null> => {
    if (runningInTauri()) {
        try {
            const statePath = await getWorkspaceStateFilePath(kind, filePath);
            const pendingWrite = workspaceWriteQueues.get(statePath);
            if (pendingWrite) {
                await pendingWrite.catch(() => undefined);
            }
            if (await exists(statePath)) {
                const parsed = JSON.parse(await readTextFile(statePath)) as Partial<WorkspaceStateEnvelope<unknown>>;
                if (
                    parsed.version === 1
                    && parsed.filePath === filePath
                    && isValid(parsed.value)
                ) {
                    return parsed.value;
                }
                console.warn(`忽略无效的${label}应用数据文件:`, statePath);
            }
        } catch (error) {
            console.warn(`读取${label}应用数据文件失败，尝试旧缓存:`, error);
        }
    }

    const legacyKey = getLegacyStorageKey(kind, filePath);
    const legacyState = loadLegacyState(legacyKey, isValid, label);
    if (legacyState && runningInTauri()) {
        await persistWorkspaceState(kind, filePath, legacyState, label);
    }
    return legacyState;
};

const isPersistedCofechaState = (value: unknown): value is PersistedCofechaState => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<PersistedCofechaState>;
    return candidate.version === 1
        && typeof candidate.outFileContent === "string";
};

const isPersistedReferenceState = (value: unknown): value is PersistedReferenceState => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<PersistedReferenceState>;
    return candidate.version === 1
        && Array.isArray(candidate.referenceOperationLog);
};

const serializeCofechaResult = (result: ICofechaResult): SerializedCofechaResult => ({
    ...result,
    masterDatingSeries: Array.from(result.masterDatingSeries.entries()),
    masterCorrelations: Array.from(result.masterCorrelations.entries()),
    seriesProblemCounts: Array.from(result.seriesProblemCounts.entries()),
    possibleProblemsDetail: Array.from(result.possibleProblemsDetail.entries()),
});

export const deserializeCofechaResult = (result: SerializedCofechaResult): ICofechaResult => ({
    ...result,
    masterDatingSeries: new Map(result.masterDatingSeries),
    masterCorrelations: new Map(result.masterCorrelations ?? []),
    seriesProblemCounts: new Map(result.seriesProblemCounts ?? []),
    possibleProblemsDetail: new Map(result.possibleProblemsDetail),
});

export const loadPersistedCofechaState = (filePath: string) => (
    loadWorkspaceState("cofecha", filePath, isPersistedCofechaState, "COFECHA 状态")
);

export const persistCofechaState = (
    filePath: string,
    outFileContent: string,
    cofechaResult: ICofechaResult | undefined,
    cofechaVersion: CofechaVersion,
    selectedPart: string,
    cofechaInputSignature?: string,
) => persistWorkspaceState(
    "cofecha",
    filePath,
    {
        version: 1,
        savedAt: new Date().toISOString(),
        outFileContent,
        cofechaResult: cofechaResult ? serializeCofechaResult(cofechaResult) : undefined,
        cofechaVersion,
        selectedPart,
        cofechaInputSignature,
    } satisfies PersistedCofechaState,
    "COFECHA 状态",
);

export const loadPersistedReferenceState = (filePath: string) => (
    loadWorkspaceState("reference", filePath, isPersistedReferenceState, "参考序列状态")
);

export const persistReferenceState = (
    filePath: string,
    referenceConfig: ReferenceSeriesConfig | null,
    dynamicReferenceConfig: ReferenceSeriesConfig | null,
    referenceOperationLog: RwlOperationLogEntry[],
    referenceOperationCounter: number,
) => persistWorkspaceState(
    "reference",
    filePath,
    {
        version: 1,
        savedAt: new Date().toISOString(),
        referenceConfig,
        dynamicReferenceConfig,
        referenceOperationLog,
        referenceOperationCounter,
    } satisfies PersistedReferenceState,
    "参考序列状态",
);

export const loadPersistedHistorySnapshot = (filePath: string) => (
    loadWorkspaceState("history", filePath, RwlEditor.isPersistedHistorySnapshot, "操作日志")
);

export const persistHistorySnapshot = (filePath: string, editor: RwlEditor) => (
    persistWorkspaceState("history", filePath, editor.toHistorySnapshot(), "操作日志")
);

export const loadPersistedTreeRingScanState = (filePath: string) => (
    loadWorkspaceState("tree-ring-scans", filePath, isPersistedTreeRingScanState, "树轮扫描影像状态")
);

export const persistTreeRingScanState = (
    filePath: string,
    state: PersistedTreeRingScanState,
) => persistWorkspaceState(
    "tree-ring-scans",
    filePath,
    { ...state, version: 1, savedAt: new Date().toISOString() } satisfies PersistedTreeRingScanState,
    "树轮扫描影像状态",
);

/** Moves legacy per-file localStorage payloads into app-data files without dropping failed migrations. */
export const migrateLegacyWorkspaceStorage = () => {
    if (!runningInTauri()) {
        return Promise.resolve();
    }
    if (legacyMigrationPromise) {
        return legacyMigrationPromise;
    }

    legacyMigrationPromise = (async () => {
        const definitions: Array<{
            kind: WorkspaceStateKind;
            prefix: string;
            label: string;
            isValid: (value: unknown) => boolean;
        }> = [
            { kind: "cofecha", prefix: COFECHA_STORAGE_PREFIX, label: "COFECHA 状态", isValid: isPersistedCofechaState },
            { kind: "reference", prefix: REFERENCE_STORAGE_PREFIX, label: "参考序列状态", isValid: isPersistedReferenceState },
            { kind: "history", prefix: HISTORY_STORAGE_PREFIX, label: "操作日志", isValid: RwlEditor.isPersistedHistorySnapshot },
            { kind: "tree-ring-scans", prefix: TREE_RING_SCAN_STORAGE_PREFIX, label: "树轮扫描影像状态", isValid: isPersistedTreeRingScanState },
        ];
        const keys = Array.from({ length: window.localStorage.length }, (_, index) => (
            window.localStorage.key(index)
        )).filter((key): key is string => Boolean(key));

        for (const key of keys) {
            const definition = definitions.find(({ prefix }) => key.startsWith(prefix));
            if (!definition) continue;
            const filePath = key.slice(definition.prefix.length);
            if (!filePath) continue;
            try {
                const raw = window.localStorage.getItem(key);
                if (!raw) continue;
                const value = JSON.parse(raw) as unknown;
                if (!definition.isValid(value)) continue;
                await persistWorkspaceState(definition.kind, filePath, value, definition.label);
            } catch (error) {
                console.warn(`迁移${definition.label}旧缓存失败:`, error);
            }
        }
    })();

    return legacyMigrationPromise;
};

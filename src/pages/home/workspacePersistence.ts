import type { ICofechaResult } from "@/features/cofecha/types";
import type { ReferenceSeriesConfig } from "@/features/crossdating/reference";
import { RwlEditor, type RwlOperationLogEntry, type RwlPersistedHistorySnapshot } from "@/features/rwl/edit";
import type { CofechaVersion } from "./homeShared";

const COFECHA_STORAGE_PREFIX = "crossdating:cofecha-state:v1:";
const REFERENCE_STORAGE_PREFIX = "crossdating:reference-state:v1:";
const HISTORY_STORAGE_PREFIX = "crossdating:rwl-operation-journal:v1:";

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
};

export type PersistedReferenceState = {
    version: 1;
    savedAt: string;
    referenceConfig: ReferenceSeriesConfig | null;
    referenceOperationLog: RwlOperationLogEntry[];
    referenceOperationCounter: number;
};

const getCofechaStorageKey = (filePath: string) => `${COFECHA_STORAGE_PREFIX}${filePath}`;
const getReferenceStorageKey = (filePath: string) => `${REFERENCE_STORAGE_PREFIX}${filePath}`;
const getHistoryStorageKey = (filePath: string) => `${HISTORY_STORAGE_PREFIX}${filePath}`;

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

export const loadPersistedCofechaState = (filePath: string): PersistedCofechaState | null => {
    try {
        const raw = window.localStorage.getItem(getCofechaStorageKey(filePath));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        return isPersistedCofechaState(parsed) ? parsed : null;
    } catch (error) {
        console.warn("读取 COFECHA 状态失败:", error);
        return null;
    }
};

export const persistCofechaState = (
    filePath: string,
    outFileContent: string,
    cofechaResult: ICofechaResult | undefined,
    cofechaVersion: CofechaVersion,
    selectedPart: string,
) => {
    try {
        window.localStorage.setItem(
            getCofechaStorageKey(filePath),
            JSON.stringify({
                version: 1,
                savedAt: new Date().toISOString(),
                outFileContent,
                cofechaResult: cofechaResult ? serializeCofechaResult(cofechaResult) : undefined,
                cofechaVersion,
                selectedPart,
            } satisfies PersistedCofechaState),
        );
    } catch (error) {
        console.warn("保存 COFECHA 状态失败:", error);
    }
};

export const loadPersistedReferenceState = (filePath: string): PersistedReferenceState | null => {
    try {
        const raw = window.localStorage.getItem(getReferenceStorageKey(filePath));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        return isPersistedReferenceState(parsed) ? parsed : null;
    } catch (error) {
        console.warn("读取参考序列状态失败:", error);
        return null;
    }
};

export const persistReferenceState = (
    filePath: string,
    referenceConfig: ReferenceSeriesConfig | null,
    referenceOperationLog: RwlOperationLogEntry[],
    referenceOperationCounter: number,
) => {
    try {
        window.localStorage.setItem(
            getReferenceStorageKey(filePath),
            JSON.stringify({
                version: 1,
                savedAt: new Date().toISOString(),
                referenceConfig,
                referenceOperationLog,
                referenceOperationCounter,
            } satisfies PersistedReferenceState),
        );
    } catch (error) {
        console.warn("保存参考序列状态失败:", error);
    }
};

export const loadPersistedHistorySnapshot = (filePath: string): RwlPersistedHistorySnapshot | null => {
    try {
        const raw = window.localStorage.getItem(getHistoryStorageKey(filePath));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        return RwlEditor.isPersistedHistorySnapshot(parsed) ? parsed : null;
    } catch (error) {
        console.warn("读取操作日志失败:", error);
        return null;
    }
};

export const persistHistorySnapshot = (filePath: string, editor: RwlEditor) => {
    try {
        window.localStorage.setItem(
            getHistoryStorageKey(filePath),
            JSON.stringify(editor.toHistorySnapshot()),
        );
    } catch (error) {
        console.warn("保存操作日志失败:", error);
    }
};

import type { CrossdatingDiagnosis } from "@/features/crossdating/diagnosis";
import type { ReferenceSeriesConfig } from "@/features/crossdating/reference";
import type { RwlOperationLogEntry } from "@/features/rwl/edit";
import type { RwlSiteData } from "@/features/rwl/types";

export const MAX_REFERENCE_OPERATION_LOG_ENTRIES = 200;

export const createEmptyCrossdatingDiagnosis = (): CrossdatingDiagnosis => ({
    createdAt: new Date().toISOString(),
    seriesCount: 0,
    problemSegmentCount: 0,
    candidateCount: 0,
    eventCount: 0,
    segmentLength: 0,
    overlap: 0,
    lagRange: { min: 0, max: 0 },
    lowCorrelationThreshold: 0,
    summaries: [],
    segments: [],
    propagationPatterns: [],
    globalSlidingMatches: [],
    masterNarrowYears: [],
    events: [],
    candidates: [],
});

export const rwlDataEquals = (a: RwlSiteData, b: RwlSiteData) => {
    if (a.size !== b.size) {
        return false;
    }

    for (const [tree, mapA] of a) {
        const mapB = b.get(tree);
        if (!mapB || mapA.size !== mapB.size) {
            return false;
        }

        for (const [year, widthA] of mapA) {
            if (widthA !== mapB.get(year)) {
                return false;
            }
        }
    }

    return true;
};

export const stringArraysEqual = (a: string[], b: string[]) => (
    a.length === b.length && a.every((value, index) => value === b[index])
);

export const createReferenceOperationLogEntry = (
    config: ReferenceSeriesConfig | null,
    sequence: number,
    projectId?: string | null,
): RwlOperationLogEntry => {
    const selectedCount = config?.selectedTrees.length ?? 0;
    const isDynamic = config?.mode === "dynamic";
    const id = `reference-${Date.now()}-${sequence}`;
    const timestamp = new Date().toISOString();

    return {
        id,
        operationId: id,
        projectId: projectId || undefined,
        seriesId: "Reference",
        sequence,
        timestamp,
        createdAt: timestamp,
        createdBy: "user",
        action: "apply",
        operationType: config ? "SET_REFERENCE_SERIES" : "CLEAR_REFERENCE_SERIES",
        source: "reference-assisted",
        summary: config ? (isDynamic ? "恢复动态参考序列" : "设置参考序列") : "关闭参考序列",
        detail: config
            ? isDynamic
                ? `COFECHA 无 A 参考组 ${selectedCount} 条 · 待检查 ${config.classification?.candidateFlaggedIds.length ?? 0} 条`
                : `${selectedCount} 条序列 · ${config.method} · min n=${config.minSampleDepth}`
            : "移除当前 reference / master-like series",
        tree: "Reference",
        reason: config
            ? isDynamic
                ? "使用最新 COFECHA-pass 动态参考序列"
                : "用户选择可靠序列生成视觉参考线"
            : "用户关闭参考线",
        undone: false,
        isApplied: true,
        isReverted: false,
        canUndo: false,
        canRedo: false,
        undoDepth: 0,
        redoDepth: 0,
    };
};

export const normalizeWorkspaceOperationLogEntry = (
    entry: RwlOperationLogEntry,
    projectId?: string | null,
): RwlOperationLogEntry => {
    const isReverted = entry.isReverted ?? Boolean(entry.undone);
    const isApplied = entry.isApplied ?? !isReverted;
    return {
        ...entry,
        operationId: entry.operationId ?? entry.id,
        projectId: entry.projectId ?? projectId ?? undefined,
        seriesId: entry.seriesId ?? entry.tree,
        createdAt: entry.createdAt ?? entry.timestamp,
        createdBy: entry.createdBy ?? (entry.source === "system" ? "system" : "user"),
        isApplied,
        isReverted,
    };
};

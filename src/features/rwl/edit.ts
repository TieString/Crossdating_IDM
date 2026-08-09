import { RwlFormat, RwlTreeData, RwlReadResult, RwlSiteData } from "./types";
import { formatHandlers } from "./index";
import { stopMarker } from "@/shared/constants";

// RWL 编辑器
// ===========
// 负责记录 RWL 数据的编辑历史（undo/redo）和导出。
// 
// exportAsRwlString() 通过 formatHandlers 注册表自动选择相应的 format 函数，
// 确保导出格式与读入时一致（通过 readOptions 记录的元数据）。

// 插年：在year处插入0，之前的年份总体向前移动1年，最新年份不变
export type MissingInsertSide = "left" | "right";
export type DeleteMode = "direct" | "left" | "right" | "both";
// 删除后用哪一侧的格子来填补缺口（即"向哪个方向靠"）：
// - "right"（默认）：左侧格子整体向右靠，最新（最右）年份不变。
// - "left"：右侧格子整体向左靠，最早（最左）年份不变。
export type DeleteShift = "left" | "right";

export type RwlEditOperation =
    | { type: "insert-missing"; tree: string; year: number; side: MissingInsertSide }
    | { type: "move-selection"; tree: string; selectedStartYear: number; selectedEndYear: number; yearOffset: number }
    | { type: "delete-year"; tree: string; year: number; mode: DeleteMode; shift?: DeleteShift }
    | { type: "mark-missing-range"; tree: string; startYear: number; endYear: number }
    | { type: "restore-deletion"; tree: string; markerYear: number; index: number }
    | { type: "delete-series"; tree: string }
    | { type: "change-width"; tree: string; year: number; width: number | null }
    | { type: "replace-tree-data"; tree: string }
    | { type: "replace-all-data"; treeCount: number; format?: RwlFormat };

export type RwlHistoryAnimation = RwlEditOperation & {
    direction: "undo" | "redo";
};

export type RwlOperationLogAction = "apply";
export type RwlOperationSource =
    | "manual"
    | "reference-assisted"
    | "auto-suggested"
    | "imported"
    | "system";
export type RwlOperationLogCreator = "user" | "system" | "imported";

type RwlOperationMetricMap = Record<string, number | string | null>;

export type RwlOperationLogMetadata = {
    operationType?: string;
    source?: RwlOperationSource;
    projectId?: string;
    createdBy?: RwlOperationLogCreator;
    reason?: string;
    targetIndex?: number;
    oldValue?: number | null;
    newValue?: number | null;
    oldYear?: number;
    newYear?: number;
    metricsBefore?: RwlOperationMetricMap;
    metricsAfter?: RwlOperationMetricMap;
    cofechaBefore?: RwlOperationMetricMap;
    cofechaAfter?: RwlOperationMetricMap;
    parentOperationId?: string;
    batchId?: string;
};

export type SerializedRwlTreeData = Array<[number, number | null]>;
export type SerializedTreeDeletionMarkers = Array<[number, DeletionMarkerInfo[]]>;
export type SerializedRwlOperationLogBySeries = Array<[string, RwlOperationLogEntry[]]>;

export type RwlOperationLogEntry = {
    id: string;
    operationId?: string;
    projectId?: string;
    seriesId?: string;
    sequence: number;
    timestamp: string;
    createdAt?: string;
    createdBy?: RwlOperationLogCreator;
    action: RwlOperationLogAction;
    operation?: RwlEditOperation;
    operationType?: string;
    source?: RwlOperationSource;
    targetYear?: number;
    targetIndex?: number;
    oldValue?: number | null;
    newValue?: number | null;
    oldYear?: number;
    newYear?: number;
    affectedRange?: { startYear: number; endYear: number };
    reason?: string;
    metricsBefore?: RwlOperationMetricMap;
    metricsAfter?: RwlOperationMetricMap;
    cofechaBefore?: RwlOperationMetricMap;
    cofechaAfter?: RwlOperationMetricMap;
    isApplied?: boolean;
    isReverted?: boolean;
    parentOperationId?: string;
    batchId?: string;
    summary: string;
    detail: string;
    tree?: string;
    beforeTreeData?: SerializedRwlTreeData | null;
    afterTreeData?: SerializedRwlTreeData | null;
    beforeDeletionMarkers?: SerializedTreeDeletionMarkers;
    afterDeletionMarkers?: SerializedTreeDeletionMarkers;
    undone?: boolean;
    canUndo?: boolean;
    canUndoBatch?: boolean;
    canRedo?: boolean;
    undoDepth: number;
    redoDepth: number;
};

export type RwlHistoryStatus = {
    undoCount: number;
    redoCount: number;
    logCount: number;
};

export type SerializedRwlSiteData = Array<[string, SerializedRwlTreeData]>;
export type SerializedRwlDeletionMarkers = Array<[string, SerializedTreeDeletionMarkers]>;

// 每个 tree 的删除标记：年份 M 表示 "在当前年份 M 的左边沿画一条红色竖线"。
// 仅在内存中维护，与 undo/redo 联动；不写入 RWL 文件。
//
// 每一层都是一条「自包含、可精确回放的逆操作」：恢复时只看本层记录的原值与配置，
// 不依赖其它层的累积计算。同一缝隙叠多层时按严格后进先出（deleteOrder 最大者先恢复），
// 因此即使各层配置不同也互不干扰、绝不会把数据算乱。
export type DeletionMarkerInfo = {
    // 被删除格子的原值（删除时的精确值）；null 表示原本就是 gap/缺测，恢复时不写入。
    deletedWidth: number | null;
    // 删除模式（分配方向）；direct 恢复时不修改任何邻居。
    mode?: DeleteMode;
    // 删除时的填补方向；undefined 视为 "right"（默认：左侧向右靠）。恢复时据此镜像还原。
    shiftSide?: DeleteShift;
    // 删除顺序：同一缝隙的栈内决定哪一层是「最近一次」（最大者）。
    deleteOrder?: number;
    // 删除时实际注入到左/右邻的宽度（邻居不存在或为缺测时为 0）；恢复时原样减回。
    leftContribution?: number;
    rightContribution?: number;
};

// 同一格子位置可以堆叠多个删除标记（连续或相邻删除都可能压到同一条红线）。
// 数组顺序按空间从左到右排列；恢复某层后，左侧剩余层回左缝，右侧剩余层回右缝。
export type RwlDeletionMarkers = Map<string, Map<number, DeletionMarkerInfo[]>>;

type RwlHistoryEntry = {
    data: RwlSiteData;
    deletionMarkers: RwlDeletionMarkers;
    readOptions?: RwlReadResult['readOptions'];
    format: string;
    operation?: RwlEditOperation;
    operationLogSnapshot?: RwlOperationLogBySeries;
    operationLogCounter?: number;
};

type RwlTreeLogState = {
    data: SerializedRwlTreeData | null;
    deletionMarkers: SerializedTreeDeletionMarkers;
};

type RwlOperationLogBySeries = Map<string, RwlOperationLogEntry[]>;

export type RwlPersistedHistorySnapshot = {
    version: 1;
    savedAt: string;
    rawData?: SerializedRwlSiteData;
    workingData?: SerializedRwlSiteData;
    deletionMarkers?: SerializedRwlDeletionMarkers;
    readOptions?: RwlReadResult['readOptions'];
    format?: string;
    rawReadOptions?: RwlReadResult['readOptions'];
    rawFormat?: string;
    operationLog?: RwlOperationLogEntry[];
    operationLogBySeries?: SerializedRwlOperationLogBySeries;
    operationLogCounter: number;
    deletionOrderCounter: number;
};

const MAX_OPERATION_LOG_ENTRIES = 500;
const BASIC_OPERATION_LOG_TYPES = new Set<RwlEditOperation["type"]>([
    "insert-missing",
    "move-selection",
    "delete-year",
    "mark-missing-range",
    "restore-deletion",
    "change-width",
]);

const cloneTreeData = (treeData: RwlTreeData): RwlTreeData => new Map(treeData);

const cloneSiteData = (siteData: RwlSiteData): RwlSiteData => {
    const result: RwlSiteData = new Map();
    siteData.forEach((treeData, tree) => {
        result.set(tree, cloneTreeData(treeData));
    });
    return result;
};

const cloneOperation = (operation: RwlEditOperation | undefined): RwlEditOperation | undefined => (
    operation ? { ...operation } : undefined
);

const cloneSerializedTreeData = (
    treeData: SerializedRwlTreeData | null | undefined
): SerializedRwlTreeData | null | undefined => (
    treeData ? treeData.map(([year, width]) => [year, width]) : treeData
);

const cloneSerializedTreeDeletionMarkers = (
    markers: SerializedTreeDeletionMarkers | undefined
): SerializedTreeDeletionMarkers | undefined => (
    markers?.map(([year, stack]) => [year, stack.map((info) => ({ ...info }))])
);

const getSerializedTreeYearValue = (
    treeData: SerializedRwlTreeData | null | undefined,
    year: number | undefined,
): number | null | undefined => {
    if (!treeData || year === undefined) return undefined;
    return treeData.find(([candidateYear]) => candidateYear === year)?.[1];
};

const normalizeOperationLogEntry = (entry: RwlOperationLogEntry): RwlOperationLogEntry => {
    const isReverted = entry.isReverted ?? Boolean(entry.undone);
    const isApplied = entry.isApplied ?? !isReverted;
    return {
        ...entry,
        operationId: entry.operationId ?? entry.id,
        seriesId: entry.seriesId ?? entry.tree,
        createdAt: entry.createdAt ?? entry.timestamp,
        createdBy: entry.createdBy ?? (entry.source === "system" ? "system" : "user"),
        isApplied,
        isReverted,
    };
};

const cloneOperationLogEntry = (entry: RwlOperationLogEntry): RwlOperationLogEntry => ({
    ...normalizeOperationLogEntry(entry),
    operation: cloneOperation(entry.operation),
    beforeTreeData: cloneSerializedTreeData(entry.beforeTreeData),
    afterTreeData: cloneSerializedTreeData(entry.afterTreeData),
    beforeDeletionMarkers: cloneSerializedTreeDeletionMarkers(entry.beforeDeletionMarkers),
    afterDeletionMarkers: cloneSerializedTreeDeletionMarkers(entry.afterDeletionMarkers),
});

const getOperationLogSeriesKey = (entry: RwlOperationLogEntry): string => (
    entry.seriesId ?? entry.tree ?? "__unknown__"
);

const flattenOperationLogBySeries = (operationLogBySeries: RwlOperationLogBySeries): RwlOperationLogEntry[] => (
    Array.from(operationLogBySeries.values())
        .flat()
        .sort((a, b) => a.sequence - b.sequence)
);

const countOperationLogBySeries = (operationLogBySeries: RwlOperationLogBySeries): number => (
    Array.from(operationLogBySeries.values()).reduce((total, entries) => total + entries.length, 0)
);

const groupOperationLogBySeries = (operationLog: RwlOperationLogEntry[]): RwlOperationLogBySeries => {
    const grouped: RwlOperationLogBySeries = new Map();
    operationLog
        .map(cloneOperationLogEntry)
        .sort((a, b) => a.sequence - b.sequence)
        .forEach((entry) => {
            const key = getOperationLogSeriesKey(entry);
            grouped.set(key, [...(grouped.get(key) ?? []), entry]);
        });
    return grouped;
};

const cloneOperationLogBySeries = (operationLogBySeries: RwlOperationLogBySeries): RwlOperationLogBySeries => (
    groupOperationLogBySeries(flattenOperationLogBySeries(operationLogBySeries))
);

const trimOperationLogBySeries = (operationLogBySeries: RwlOperationLogBySeries): RwlOperationLogBySeries => (
    groupOperationLogBySeries(flattenOperationLogBySeries(operationLogBySeries).slice(-MAX_OPERATION_LOG_ENTRIES))
);

const maybeTrimOperationLogBySeries = (operationLogBySeries: RwlOperationLogBySeries): RwlOperationLogBySeries => (
    countOperationLogBySeries(operationLogBySeries) > MAX_OPERATION_LOG_ENTRIES
        ? trimOperationLogBySeries(operationLogBySeries)
        : operationLogBySeries
);

const serializeOperationLogBySeries = (
    operationLogBySeries: RwlOperationLogBySeries
): SerializedRwlOperationLogBySeries => (
    Array.from(trimOperationLogBySeries(operationLogBySeries).entries())
        .map(([seriesId, entries]) => [seriesId, entries.map(cloneOperationLogEntry)])
);

const deserializeOperationLogBySeries = (
    operationLogBySeries: SerializedRwlOperationLogBySeries | undefined,
    fallbackOperationLog: RwlOperationLogEntry[] | undefined,
): RwlOperationLogBySeries => {
    if (Array.isArray(operationLogBySeries)) {
        return trimOperationLogBySeries(new Map(operationLogBySeries.map(([seriesId, entries]) => [
            seriesId,
            entries.map(cloneOperationLogEntry),
        ])));
    }

    return groupOperationLogBySeries(fallbackOperationLog ?? []);
};

const serializeTreeData = (treeData: RwlTreeData): SerializedRwlTreeData => (
    Array.from(treeData.entries())
);

const deserializeTreeData = (treeData: SerializedRwlTreeData): RwlTreeData => (
    new Map(treeData)
);

const serializeSiteData = (siteData: RwlSiteData): SerializedRwlSiteData => (
    Array.from(siteData.entries()).map(([tree, treeData]) => [tree, serializeTreeData(treeData)])
);

const deserializeSiteData = (siteData: SerializedRwlSiteData): RwlSiteData => (
    new Map(siteData.map(([tree, treeData]) => [tree, deserializeTreeData(treeData)]))
);

const serializeTreeDeletionMarkers = (
    markers: Map<number, DeletionMarkerInfo[]> | undefined
): SerializedTreeDeletionMarkers => (
    Array.from(markers?.entries() ?? []).map(([year, stack]) => [
        year,
        stack.map((info) => ({ ...info })),
    ])
);

const deserializeTreeDeletionMarkers = (
    markers: SerializedTreeDeletionMarkers | undefined
): Map<number, DeletionMarkerInfo[]> => (
    new Map((markers ?? []).map(([year, stack]) => [
        year,
        stack.map((info) => ({ ...info })),
    ]))
);

const serializeDeletionMarkers = (markers: RwlDeletionMarkers): SerializedRwlDeletionMarkers => (
    Array.from(markers.entries()).map(([tree, treeMarkers]) => [tree, serializeTreeDeletionMarkers(treeMarkers)])
);

const deserializeDeletionMarkers = (markers: SerializedRwlDeletionMarkers | undefined): RwlDeletionMarkers => (
    new Map((markers ?? []).map(([tree, treeMarkers]) => [tree, deserializeTreeDeletionMarkers(treeMarkers)]))
);

const siteDataEquals = (a: RwlSiteData, b: RwlSiteData): boolean => {
    if (a.size !== b.size) return false;
    for (const [tree, treeData] of a) {
        const otherTree = b.get(tree);
        if (!otherTree || otherTree.size !== treeData.size) return false;
        for (const [year, width] of treeData) {
            if (otherTree.get(year) !== width) return false;
        }
    }
    return true;
};

const deletionMarkersEmpty = (markers: RwlDeletionMarkers): boolean => (
    Array.from(markers.values()).every((treeMarkers) => treeMarkers.size === 0)
);

const treeDataEquals = (
    treeData: RwlTreeData | undefined,
    serialized: SerializedRwlTreeData | null | undefined
) => {
    if (serialized === undefined) return false;
    if (serialized === null) return treeData === undefined;
    if (!treeData || treeData.size !== serialized.length) return false;

    return serialized.every(([year, width]) => treeData.get(year) === width);
};

const treeDeletionMarkersEquals = (
    markers: Map<number, DeletionMarkerInfo[]> | undefined,
    serialized: SerializedTreeDeletionMarkers | undefined
) => {
    const normalized = serializeTreeDeletionMarkers(markers);
    const expected = serialized ?? [];
    if (normalized.length !== expected.length) return false;

    return normalized.every(([year, stack], index) => {
        const expectedEntry = expected[index];
        if (!expectedEntry) return false;
        const [expectedYear, expectedStack] = expectedEntry;
        if (year !== expectedYear || stack.length !== expectedStack.length) return false;
        return stack.every((info, infoIndex) => (
            JSON.stringify(info) === JSON.stringify(expectedStack[infoIndex])
        ));
    });
};

const getOperationTree = (operation: RwlEditOperation | undefined): string | undefined => {
    if (!operation || !("tree" in operation)) return undefined;
    return operation.tree;
};

const getDeleteModeLabel = (mode: DeleteMode) => {
    switch (mode) {
        case "left": return "并入左侧";
        case "right": return "并入右侧";
        case "both": return "两侧均分";
        case "direct":
        default:
            return "直接删除";
    }
};

const getDeleteShiftLabel = (shift: DeleteShift | undefined) => (
    shift === "left" ? "右侧左靠" : "左侧右靠"
);

const getOperationType = (operation: RwlEditOperation | undefined): string | undefined => {
    switch (operation?.type) {
        case "insert-missing": return "INSERT_MISSING_RING";
        case "move-selection": return "SHIFT_RANGE";
        case "delete-year": return "DELETE_FALSE_RING";
        case "mark-missing-range": return "MARK_SUSPICIOUS";
        case "restore-deletion": return "REVERT_OPERATION";
        case "delete-series": return "DELETE_SERIES";
        case "change-width": return "UPDATE_WIDTH_VALUE";
        case "replace-tree-data": return "REPLACE_TREE_DATA";
        case "replace-all-data": return "REPLACE_ALL_DATA";
        default: return undefined;
    }
};

const getOperationTargetYear = (operation: RwlEditOperation | undefined): number | undefined => {
    if (!operation) return undefined;
    if ("year" in operation) return operation.year;
    if (operation.type === "move-selection") return operation.selectedStartYear;
    if (operation.type === "mark-missing-range") return operation.startYear;
    if (operation.type === "restore-deletion") return operation.markerYear;
    return undefined;
};

const getOperationNewYear = (operation: RwlEditOperation | undefined): number | undefined => {
    if (!operation) return undefined;
    if (operation.type === "move-selection") return operation.selectedStartYear + operation.yearOffset;
    if ("year" in operation) return operation.year;
    if (operation.type === "mark-missing-range") return operation.startYear;
    if (operation.type === "restore-deletion") return operation.markerYear;
    return undefined;
};

const getOperationAffectedRange = (
    operation: RwlEditOperation | undefined
): { startYear: number; endYear: number } | undefined => {
    if (!operation) return undefined;
    if (operation.type === "move-selection") {
        return {
            startYear: Math.min(operation.selectedStartYear, operation.selectedEndYear),
            endYear: Math.max(operation.selectedStartYear, operation.selectedEndYear),
        };
    }
    if (operation.type === "mark-missing-range") {
        return {
            startYear: Math.min(operation.startYear, operation.endYear),
            endYear: Math.max(operation.startYear, operation.endYear),
        };
    }
    if ("year" in operation) {
        return { startYear: operation.year, endYear: operation.year };
    }
    if (operation.type === "restore-deletion") {
        return { startYear: operation.markerYear, endYear: operation.markerYear };
    }
    return undefined;
};

export function describeRwlEditOperation(operation: RwlEditOperation | undefined): { summary: string; detail: string; tree?: string } {
    if (!operation) {
        return { summary: "数据变更", detail: "未标记的编辑操作" };
    }

    switch (operation.type) {
        case "insert-missing":
            return {
                summary: "插入缺轮",
                detail: `${operation.tree} · ${operation.year} · ${operation.side === "left" ? "左侧" : "右侧"}`,
                tree: operation.tree,
            };
        case "move-selection":
            return {
                summary: "移动选区",
                detail: `${operation.tree} · ${operation.selectedStartYear}-${operation.selectedEndYear} · ${operation.yearOffset > 0 ? "+" : ""}${operation.yearOffset} 年`,
                tree: operation.tree,
            };
        case "delete-year":
            return {
                summary: "删除年份",
                detail: `${operation.tree} · ${operation.year} · ${getDeleteModeLabel(operation.mode)} · ${getDeleteShiftLabel(operation.shift)}`,
                tree: operation.tree,
            };
        case "mark-missing-range":
            return {
                summary: "标记缺测区间",
                detail: `${operation.tree} · ${operation.startYear}-${operation.endYear}`,
                tree: operation.tree,
            };
        case "restore-deletion":
            return {
                summary: "恢复删除标记",
                detail: `${operation.tree} · 标记 ${operation.markerYear} · #${operation.index + 1}`,
                tree: operation.tree,
            };
        case "delete-series":
            return {
                summary: "删除序列",
                detail: operation.tree,
                tree: operation.tree,
            };
        case "change-width":
            return {
                summary: "修改宽度",
                detail: `${operation.tree} · ${operation.year} → ${operation.width ?? "缺测"}`,
                tree: operation.tree,
            };
        case "replace-tree-data":
            return {
                summary: "替换序列文本",
                detail: operation.tree,
                tree: operation.tree,
            };
        case "replace-all-data":
            return {
                summary: "替换全部数据",
                detail: `${operation.treeCount} 条序列${operation.format ? ` · ${operation.format}` : ""}`,
            };
        default:
            return { summary: "数据变更", detail: "未知编辑操作", tree: getOperationTree(operation) };
    }
}

function cloneReadOptions(options: RwlReadResult['readOptions']): RwlReadResult['readOptions'] {
    if (!options) return undefined;
    return {
        ...options,
        fhUnit: options.fhUnit ? { ...options.fhUnit } : undefined,
    };
}

const cloneDeletionMarkers = (markers: RwlDeletionMarkers): RwlDeletionMarkers => {
    const result: RwlDeletionMarkers = new Map();
    markers.forEach((years, tree) => {
        const inner = new Map<number, DeletionMarkerInfo[]>();
        years.forEach((stack, year) => {
            inner.set(year, stack.map((info) => ({ ...info })));
        });
        result.set(tree, inner);
    });
    return result;
};

const isStopMarkerValue = (value: number | null | undefined) => value === stopMarker.value;

const sortedTreeData = (entries: Array<[number, number | null]>): RwlTreeData => (
    new Map(entries.sort((a, b) => a[0] - b[0]))
);

const editableEntries = (rwlData: RwlTreeData) => (
    Array.from(rwlData.entries()).filter(([, value]) => !isStopMarkerValue(value))
);

export const getSeriesMoveConflicts = (
    rwlData: RwlTreeData,
    selectedStartYear: number,
    selectedEndYear: number,
    yearOffset: number,
): number[] => {
    if (yearOffset === 0) return [];
    const selectedStart = Math.min(selectedStartYear, selectedEndYear);
    const selectedEnd = Math.max(selectedStartYear, selectedEndYear);
    const selectedYears = new Set(
        editableEntries(rwlData)
            .filter(([year]) => year >= selectedStart && year <= selectedEnd)
            .map(([year]) => year),
    );
    return Array.from(selectedYears)
        .map((year) => year + yearOffset)
        .filter((destinationYear) => (
            !selectedYears.has(destinationYear)
            && rwlData.has(destinationYear)
            && !isStopMarkerValue(rwlData.get(destinationYear))
        ))
        .sort((left, right) => left - right);
};

export type RwlMoveConflictPolicy = "reject" | "overwrite";

export class RwlMoveConflictError extends Error {
    readonly conflictYears: number[];

    constructor(conflictYears: number[]) {
        super(`移动目标年份已有数据：${conflictYears.join("、")}`);
        this.name = "RwlMoveConflictError";
        this.conflictYears = [...conflictYears];
    }
}

export function insertMissingYearAtSide(
    rwlData: RwlTreeData,
    currentYear: number,
    side: MissingInsertSide
): RwlTreeData {
    const nextEntries: Array<[number, number | null]> = [];

    editableEntries(rwlData).forEach(([year, width]) => {
        if (side === "left") {
            nextEntries.push([year >= currentYear ? year + 1 : year, width]);
        } else {
            nextEntries.push([year <= currentYear ? year - 1 : year, width]);
        }
    });

    nextEntries.push([currentYear, 0]);
    return sortedTreeData(nextEntries);
}

export function moveSeriesTailByOffset(
    rwlData: RwlTreeData,
    selectedStartYear: number,
    selectedEndYear: number,
    yearOffset: number
): RwlTreeData {
    if (yearOffset === 0) {
        return new Map(rwlData);
    }

    const selectedStart = Math.min(selectedStartYear, selectedEndYear);
    const selectedEnd = Math.max(selectedStartYear, selectedEndYear);
    const entries = editableEntries(rwlData);
    const selectedEntries = entries.filter(([year]) => year >= selectedStart && year <= selectedEnd);

    if (selectedEntries.length === 0) {
        return new Map(rwlData);
    }

    const next = new Map<number, number | null>();

    entries.forEach(([year, width]) => {
        if (year < selectedStart || year > selectedEnd) {
            next.set(year, width);
        }
    });

    // Moved values are written last so explicit overwrite moves replace destination values.
    selectedEntries.forEach(([year, width]) => {
        next.set(year + yearOffset, width);
    });

    return sortedTreeData(Array.from(next.entries()));
}

// 删年：在year处删除0，并用一侧的格子填补缺口。
// - shift="right"（默认）：之前（更早/更左）的年份整体向后(+1)移动，最新（最右）年份不变。
// - shift="left"：之后（更晚/更右）的年份整体向前(-1)移动，最早（最左）年份不变。
function deleteYearFromRwl(rwlData: RwlTreeData, year: number, shift: DeleteShift = "right"): RwlTreeData {
    let rwl_new: RwlTreeData = new Map()
    rwlData.forEach((value, key) => {
        if (key === year) return
        const offset = shift === "left"
            ? (key > year ? -1 : 0)
            : (key < year ? 1 : 0)
        rwl_new.set(key + offset, value)
    })
    return rwl_new
}

const addWidthToNeighbor = (
    rwlData: RwlTreeData,
    neighborYear: number,
    extraWidth: number,
): void => {
    const existing = rwlData.get(neighborYear);
    if (existing === undefined || existing === null || isStopMarkerValue(existing)) {
        return;
    }
    rwlData.set(neighborYear, existing + extraWidth);
};

// 按模式删年：在 year 处删除，并可选择将其宽度并入左/右/两侧邻居
// year 不在数据中（gap/missing 年份）也允许：此时无宽度可分配，仍会平移更早的年份以收紧时间轴。
export function deleteYearWithMode(
    rwlData: RwlTreeData,
    year: number,
    mode: DeleteMode,
    shift: DeleteShift = "right",
): RwlTreeData {
    const currentValue = rwlData.get(year);
    const distributable = currentValue !== undefined && currentValue !== null && !isStopMarkerValue(currentValue);
    const working = new Map(rwlData);

    if (distributable) {
        const width = currentValue as number;
        if (mode === "left") {
            addWidthToNeighbor(working, year - 1, width);
        } else if (mode === "right") {
            addWidthToNeighbor(working, year + 1, width);
        } else if (mode === "both") {
            // 向两侧分配时取整
            const half = Math.round(width / 2);
            addWidthToNeighbor(working, year - 1, half);
            addWidthToNeighbor(working, year + 1, half);
        }
    }

    return deleteYearFromRwl(working, year, shift);
}

export function markYearRangeAsMissing(
    rwlData: RwlTreeData,
    selectedStartYear: number,
    selectedEndYear: number,
): RwlTreeData {
    const startYear = Math.min(selectedStartYear, selectedEndYear);
    const endYear = Math.max(selectedStartYear, selectedEndYear);

    return sortedTreeData(
        editableEntries(rwlData).filter(([year]) => year < startYear || year > endYear)
    );
}

// 更改年：在year处更改为width，其他年份不变
function changeYearWidth(rwlData: RwlTreeData, year: number, width: number | null): RwlTreeData {
    let rwl_new: RwlTreeData = new Map(rwlData)
    if (rwl_new.has(year)) {
        rwl_new.set(year, width)
    }
    return rwl_new
}


export class RwlEditor {
    private rwlData: RwlSiteData;
    private rawData: RwlSiteData;
    private readOptions?: RwlReadResult['readOptions'];
    private rawReadOptions?: RwlReadResult['readOptions'];
    private format: string = 'tucson'; // 记录原始读取格式
    private rawFormat: string = 'tucson';
    private undoStack: RwlHistoryEntry[] = [];
    private redoStack: RwlHistoryEntry[] = [];
    private operationLogBySeries: RwlOperationLogBySeries = new Map();
    private operationLogCounter = 0;
    private deletionMarkers: RwlDeletionMarkers = new Map();
    private deletionOrderCounter = 0;
    private projectId?: string;
    private changeCallback?: () => void;

    constructor(initialData: RwlSiteData, options?: RwlReadResult['readOptions'], format?: string) {
        this.rwlData = cloneSiteData(initialData);
        this.rawData = cloneSiteData(initialData);
        this.readOptions = options;
        this.rawReadOptions = cloneReadOptions(options);
        this.format = format || 'tucson'; // 默认 tucson
        this.rawFormat = this.format;
    }

    static isPersistedHistorySnapshot(value: unknown): value is RwlPersistedHistorySnapshot {
        if (!value || typeof value !== "object") return false;
        const candidate = value as Partial<RwlPersistedHistorySnapshot>;
        return candidate.version === 1
            && (Array.isArray(candidate.operationLogBySeries) || Array.isArray(candidate.operationLog));
    }

    // 获取当前所有删除标记（深拷贝，避免外部修改影响内部状态）
    getDeletionMarkers(): RwlDeletionMarkers {
        return cloneDeletionMarkers(this.deletionMarkers);
    }

    // 删除年份后，将原有标记映射到新坐标，并把本次删除压入该缝隙的栈顶。
    // 同一红线上的 stack 保持从左到右的空间顺序；恢复时按这个顺序把剩余层拆回左右两侧。
    // shift="right"（默认）：红线落在 year+1（被删格右侧）。
    // shift="left"：右侧格子向左靠，红线落在 year（被删格左侧）；整套映射是 "right" 的镜像。
    private recordDeletionMarkerForDelete(tree: string, year: number, info: DeletionMarkerInfo, shift: DeleteShift = "right"): void {
        const insertMarkerYear = shift === "left" ? year : year + 1;
        const entries = this.deletionMarkers.get(tree);
        if (!entries || entries.size === 0) {
            this.deletionMarkers.set(tree, new Map([[insertMarkerYear, [info]]]));
            return;
        }

        const next = new Map<number, DeletionMarkerInfo[]>();

        const addStack = (markerYear: number, stack: DeletionMarkerInfo[]) => {
            const existing = next.get(markerYear);
            next.set(markerYear, existing ? [...existing, ...stack] : stack);
        };

        Array.from(entries.entries()).sort(([yearA], [yearB]) => yearA - yearB).forEach(([m, stack]) => {
            if (shift === "left") {
                // 右侧格子向左靠：右侧远端标记整体 -1；紧邻两侧的标记稍后按空间顺序并入红线。
                if (m < year) {
                    addStack(m, stack);
                } else if (m > year + 1) {
                    addStack(m - 1, stack);
                }
            } else {
                // 左侧格子向右靠：左侧远端标记整体 +1；紧邻两侧的标记稍后按空间顺序并入红线。
                if (m < year) {
                    addStack(m + 1, stack);
                } else if (m > year + 1) {
                    addStack(m, stack);
                }
            }
        });

        const leftStack = entries.get(year);
        if (leftStack) {
            addStack(insertMarkerYear, leftStack);
        }
        addStack(insertMarkerYear, [info]);
        const rightStack = entries.get(year + 1);
        if (rightStack) {
            addStack(insertMarkerYear, rightStack);
        }

        this.deletionMarkers.set(tree, next);
    }

    // 插入年份时同步偏移：side="left" → years >= year 向右平移；side="right" → years <= year 向左平移。
    private shiftDeletionMarkersForInsert(tree: string, year: number, side: MissingInsertSide): void {
        const entries = this.deletionMarkers.get(tree);
        if (!entries || entries.size === 0) return;
        const next = new Map<number, DeletionMarkerInfo[]>();
        entries.forEach((stack, m) => {
            if (side === "left") {
                next.set(m >= year ? m + 1 : m, stack);
            } else {
                next.set(m <= year ? m - 1 : m, stack);
            }
        });
        this.deletionMarkers.set(tree, next);
    }

    // 移动选区时，处于选区范围内的标记跟随偏移。
    private shiftDeletionMarkersForMove(tree: string, startYear: number, endYear: number, yearOffset: number): void {
        const entries = this.deletionMarkers.get(tree);
        if (!entries || entries.size === 0 || yearOffset === 0) return;
        const start = Math.min(startYear, endYear);
        const end = Math.max(startYear, endYear);
        const next = new Map<number, DeletionMarkerInfo[]>();
        entries.forEach((stack, m) => {
            if (m >= start && m <= end) next.set(m + yearOffset, stack);
            else next.set(m, stack);
        });
        this.deletionMarkers.set(tree, next);
    }

    /**
     * 注册一个在数据更改时触发的回调。
     * 这样外部可以监听编辑器状态变化，例如标记文件为已修改。
     */
    registerChangeCallback(cb: () => void) {
        this.changeCallback = cb;
    }

    /**
     * 内部便捷函数，在执行完修改操作后调用 changeCallback（如果存在）。
     */
    private notifyChange() {
        if (this.changeCallback) {
            try {
                this.changeCallback();
            } catch (e) {
                console.error("RwlEditor change callback threw:", e);
            }
        }
    }

    private captureTreeLogState(tree: string): RwlTreeLogState {
        return {
            data: this.rwlData.has(tree) ? serializeTreeData(this.rwlData.get(tree)!) : null,
            deletionMarkers: serializeTreeDeletionMarkers(this.deletionMarkers.get(tree)),
        };
    }

    private isLogEntryUndoable(entry: RwlOperationLogEntry): boolean {
        if (!entry.tree || entry.undone || entry.afterTreeData === undefined) return false;
        return treeDataEquals(this.rwlData.get(entry.tree), entry.afterTreeData)
            && treeDeletionMarkersEquals(this.deletionMarkers.get(entry.tree), entry.afterDeletionMarkers);
    }

    private cloneOperationLogEntryWithAvailability(entry: RwlOperationLogEntry): RwlOperationLogEntry {
        return {
            ...cloneOperationLogEntry(entry),
            canUndo: this.isLogEntryUndoable(entry),
            canUndoBatch: false,
            canRedo: false,
        };
    }

    private captureOperationLogSnapshot(): RwlOperationLogBySeries {
        return cloneOperationLogBySeries(this.operationLogBySeries);
    }

    private restoreOperationLogSnapshot(snapshot: RwlOperationLogBySeries | undefined, counter?: number): void {
        if (!snapshot) return;
        this.operationLogBySeries = cloneOperationLogBySeries(snapshot);
        this.operationLogCounter = counter ?? Math.max(
            ...flattenOperationLogBySeries(this.operationLogBySeries).map((entry) => entry.sequence),
            0,
        );
    }

    private applyTreeLogState(
        tree: string,
        data: SerializedRwlTreeData | null | undefined,
        deletionMarkers: SerializedTreeDeletionMarkers | undefined,
    ): void {
        if (data === undefined) return;

        const nextData = new Map(this.rwlData);
        if (data === null) {
            nextData.delete(tree);
        } else {
            nextData.set(tree, deserializeTreeData(data));
        }
        this.rwlData = nextData;

        const nextMarkers = cloneDeletionMarkers(this.deletionMarkers);
        const treeMarkers = deserializeTreeDeletionMarkers(deletionMarkers);
        if (treeMarkers.size === 0) {
            nextMarkers.delete(tree);
        } else {
            nextMarkers.set(tree, treeMarkers);
        }
        this.deletionMarkers = nextMarkers;
    }

    private appendOperationLog(
        operation: RwlEditOperation,
        tree: string,
        beforeState: RwlTreeLogState,
        metadata: RwlOperationLogMetadata = {},
    ): void {
        const afterState = this.captureTreeLogState(tree);
        if (
            treeDataEquals(beforeState.data === null ? undefined : deserializeTreeData(beforeState.data), afterState.data)
            && treeDeletionMarkersEquals(deserializeTreeDeletionMarkers(beforeState.deletionMarkers), afterState.deletionMarkers)
        ) {
            return;
        }

        const nextSequence = this.operationLogCounter + 1;
        const description = describeRwlEditOperation(operation);
        const operationId = `${Date.now()}-${nextSequence}`;
        const timestamp = new Date().toISOString();
        const targetYear = getOperationTargetYear(operation);
        const targetValueBefore = metadata.oldValue ?? getSerializedTreeYearValue(beforeState.data, targetYear);
        const targetValueAfter = metadata.newValue ?? getSerializedTreeYearValue(afterState.data, targetYear);
        const nextEntry: RwlOperationLogEntry = {
            id: operationId,
            operationId,
            projectId: metadata.projectId ?? this.projectId,
            seriesId: tree,
            sequence: nextSequence,
            timestamp,
            createdAt: timestamp,
            createdBy: metadata.createdBy ?? (metadata.source === "system" ? "system" : "user"),
            action: "apply" as const,
            operation: cloneOperation(operation),
            operationType: metadata.operationType ?? getOperationType(operation),
            source: metadata.source ?? "manual",
            targetYear,
            targetIndex: metadata.targetIndex,
            oldValue: targetValueBefore,
            newValue: targetValueAfter,
            oldYear: metadata.oldYear ?? targetYear,
            newYear: metadata.newYear ?? getOperationNewYear(operation),
            affectedRange: getOperationAffectedRange(operation),
            reason: metadata.reason,
            metricsBefore: metadata.metricsBefore,
            metricsAfter: metadata.metricsAfter,
            cofechaBefore: metadata.cofechaBefore,
            cofechaAfter: metadata.cofechaAfter,
            parentOperationId: metadata.parentOperationId,
            batchId: metadata.batchId,
            summary: description.summary,
            detail: description.detail,
            tree,
            beforeTreeData: cloneSerializedTreeData(beforeState.data),
            afterTreeData: cloneSerializedTreeData(afterState.data),
            beforeDeletionMarkers: cloneSerializedTreeDeletionMarkers(beforeState.deletionMarkers),
            afterDeletionMarkers: cloneSerializedTreeDeletionMarkers(afterState.deletionMarkers),
            undoDepth: this.undoStack.length,
            redoDepth: this.redoStack.length,
        };

        this.operationLogCounter = nextSequence;
        const seriesEntries = this.operationLogBySeries.get(tree) ?? [];
        this.operationLogBySeries = maybeTrimOperationLogBySeries(new Map([
            ...this.operationLogBySeries,
            [tree, [...seriesEntries, nextEntry]],
        ]));
    }


    // 获取当前 RWL 数据
    getData(): RwlSiteData {
        return cloneSiteData(this.rwlData);
    }

    getRawData(): RwlSiteData {
        return cloneSiteData(this.rawData);
    }

    hasRawDataChanges(): boolean {
        return !siteDataEquals(this.rwlData, this.rawData) || !deletionMarkersEmpty(this.deletionMarkers);
    }

    commitCurrentDataAsRawBaseline(savedData: RwlSiteData = this.rwlData): void {
        this.rawData = cloneSiteData(savedData);
        this.rawReadOptions = cloneReadOptions(this.readOptions);
        this.rawFormat = this.format;
    }

    setProjectId(projectId: string | null | undefined): void {
        const normalizedProjectId = projectId || undefined;
        this.projectId = normalizedProjectId;
        if (!normalizedProjectId) return;

        this.operationLogBySeries = new Map(Array.from(this.operationLogBySeries.entries()).map(([seriesId, entries]) => [
            seriesId,
            entries.map((entry) => entry.projectId ? entry : { ...entry, projectId: normalizedProjectId }),
        ]));
    }

    getOperationLog(): RwlOperationLogEntry[] {
        return flattenOperationLogBySeries(this.operationLogBySeries)
            .filter((entry) => (
                entry.operation
                && BASIC_OPERATION_LOG_TYPES.has(entry.operation.type)
                && !(entry.isReverted ?? entry.undone)
            ))
            .map((entry) => this.cloneOperationLogEntryWithAvailability(entry));
    }

    getHistoryStatus(): RwlHistoryStatus {
        return {
            undoCount: this.undoStack.length,
            redoCount: this.redoStack.length,
            logCount: countOperationLogBySeries(this.operationLogBySeries),
        };
    }

    toHistorySnapshot(): RwlPersistedHistorySnapshot {
        return {
            version: 1,
            savedAt: new Date().toISOString(),
            rawData: serializeSiteData(this.rawData),
            workingData: serializeSiteData(this.rwlData),
            deletionMarkers: serializeDeletionMarkers(this.deletionMarkers),
            readOptions: cloneReadOptions(this.readOptions),
            format: this.format,
            rawReadOptions: cloneReadOptions(this.rawReadOptions),
            rawFormat: this.rawFormat,
            operationLogBySeries: serializeOperationLogBySeries(this.operationLogBySeries),
            operationLogCounter: this.operationLogCounter,
            deletionOrderCounter: this.deletionOrderCounter,
        };
    }

    restorePersistedHistory(snapshot: RwlPersistedHistorySnapshot): void {
        this.undoStack = [];
        this.redoStack = [];
        this.operationLogBySeries = deserializeOperationLogBySeries(snapshot.operationLogBySeries, snapshot.operationLog);
        this.operationLogCounter = snapshot.operationLogCounter
            ?? Math.max(...flattenOperationLogBySeries(this.operationLogBySeries).map((entry) => entry.sequence), 0);
        this.deletionOrderCounter = snapshot.deletionOrderCounter ?? 0;

        if (snapshot.rawData) {
            this.rawData = deserializeSiteData(snapshot.rawData);
        }
        if (snapshot.workingData) {
            this.rwlData = deserializeSiteData(snapshot.workingData);
        }
        if (snapshot.deletionMarkers) {
            this.deletionMarkers = deserializeDeletionMarkers(snapshot.deletionMarkers);
        }
        if (snapshot.readOptions !== undefined) {
            this.readOptions = cloneReadOptions(snapshot.readOptions);
        }
        if (snapshot.format) {
            this.format = snapshot.format;
        }
        if (snapshot.rawReadOptions !== undefined) {
            this.rawReadOptions = cloneReadOptions(snapshot.rawReadOptions);
        }
        if (snapshot.rawFormat) {
            this.rawFormat = snapshot.rawFormat;
        }
    }

    restoreOperationLog(operationLog: RwlOperationLogEntry[]): void {
        this.undoStack = [];
        this.redoStack = [];
        this.operationLogBySeries = trimOperationLogBySeries(groupOperationLogBySeries(operationLog));
        this.operationLogCounter = Math.max(
            ...flattenOperationLogBySeries(this.operationLogBySeries).map((entry) => entry.sequence),
            0,
        );
    }

    resetToRawData(): RwlHistoryAnimation | null {
        if (!this.hasRawDataChanges()) return null;

        const operation: RwlEditOperation = {
            type: "replace-all-data",
            treeCount: this.rawData.size,
            format: this.rawFormat as RwlFormat,
        };
        this.saveToUndoStack(operation);
        this.redoStack = [];
        this.rwlData = cloneSiteData(this.rawData);
        this.readOptions = cloneReadOptions(this.rawReadOptions);
        this.format = this.rawFormat;
        this.deletionMarkers = new Map();
        this.operationLogBySeries = new Map();
        this.operationLogCounter = 0;
        this.notifyChange();
        return { ...operation, direction: "redo" };
    }

    undoOperationLogEntry(entryId: string): RwlHistoryAnimation | null {
        const allEntries = flattenOperationLogBySeries(this.operationLogBySeries);
        const entry = allEntries.find((candidate) => candidate.id === entryId);
        if (!entry || !entry.tree || !this.isLogEntryUndoable(entry)) {
            return null;
        }

        this.applyTreeLogState(entry.tree, entry.beforeTreeData, entry.beforeDeletionMarkers);
        const seriesKey = getOperationLogSeriesKey(entry);
        const nextSeriesEntries = (this.operationLogBySeries.get(seriesKey) ?? [])
            .filter((candidate) => candidate.id !== entryId);
        const nextOperationLogBySeries = new Map(this.operationLogBySeries);
        if (nextSeriesEntries.length === 0) {
            nextOperationLogBySeries.delete(seriesKey);
        } else {
            nextOperationLogBySeries.set(seriesKey, nextSeriesEntries);
        }
        this.operationLogBySeries = nextOperationLogBySeries;
        this.undoStack = [];
        this.redoStack = [];
        this.notifyChange();
        return entry.operation ? { ...entry.operation, direction: "undo" } : null;
    }

    // 获取原始格式信息（用于保存时复现格式）
    getReadOptions(): RwlReadResult['readOptions'] {
        return this.readOptions;
    }

    getFormat(): string {
        return this.format;
    }

    // 插年：在 year 处插入 0
    insertYear(tree: string, year: number): void {
        if (!this.rwlData.has(tree)) return;
        let treeData = this.rwlData.get(tree)!;
        if (!treeData.has(year)) return;

        const operation: RwlEditOperation = { type: "insert-missing", tree, year, side: "right" };
        const beforeState = this.captureTreeLogState(tree);
        this.saveToUndoStack(operation); // 记录操作前状态
        this.redoStack = []; // 清空 redo 记录

        this.shiftDeletionMarkersForInsert(tree, year, "right");
        let updatedTree = insertMissingYearAtSide(treeData, year, "right");
        this.rwlData.set(tree, updatedTree);
        this.appendOperationLog(operation, tree, beforeState);
        this.notifyChange();
    }

    // 删年：在 year 处删除 0
    // Insert a missing placeholder from the requested side of the current year.
    insertMissingYearAtSide(
        tree: string,
        year: number,
        side: MissingInsertSide,
        logMetadata?: RwlOperationLogMetadata,
    ): void {
        if (!this.rwlData.has(tree)) return;
        let treeData = this.rwlData.get(tree)!;
        if (!treeData.has(year)) return;

        const operation: RwlEditOperation = { type: "insert-missing", tree, year, side };
        const beforeState = this.captureTreeLogState(tree);
        this.saveToUndoStack(operation);
        this.redoStack = [];

        this.shiftDeletionMarkersForInsert(tree, year, side);
        let updatedTree = insertMissingYearAtSide(treeData, year, side);
        this.rwlData.set(tree, updatedTree);
        this.appendOperationLog(operation, tree, beforeState, logMetadata);
        this.notifyChange();
    }

    moveSeriesTailByOffset(
        tree: string,
        selectedStartYear: number,
        selectedEndYear: number,
        yearOffset: number,
        logMetadata?: RwlOperationLogMetadata,
        conflictPolicy: RwlMoveConflictPolicy = "reject",
    ): void {
        if (yearOffset === 0) return;
        if (!this.rwlData.has(tree)) return;
        const treeData = this.rwlData.get(tree)!;
        if (conflictPolicy === "reject") {
            const conflicts = getSeriesMoveConflicts(
                treeData,
                selectedStartYear,
                selectedEndYear,
                yearOffset,
            );
            if (conflicts.length > 0) throw new RwlMoveConflictError(conflicts);
        }

        const operation: RwlEditOperation = { type: "move-selection", tree, selectedStartYear, selectedEndYear, yearOffset };
        const beforeState = this.captureTreeLogState(tree);
        this.saveToUndoStack(operation);
        this.redoStack = [];

        this.shiftDeletionMarkersForMove(tree, selectedStartYear, selectedEndYear, yearOffset);
        let updatedTree = moveSeriesTailByOffset(treeData, selectedStartYear, selectedEndYear, yearOffset);
        this.rwlData.set(tree, updatedTree);
        this.appendOperationLog(operation, tree, beforeState, logMetadata);
        this.notifyChange();
    }

    deleteYear(tree: string, year: number): void {
        if (!this.rwlData.has(tree)) return;
        let treeData = this.rwlData.get(tree)!;
        if (!treeData.has(year)) return;

        const operation: RwlEditOperation = { type: "delete-year", tree, year, mode: "direct", shift: "right" };
        const beforeState = this.captureTreeLogState(tree);
        this.saveToUndoStack(operation);
        this.redoStack = [];

        const info = this.captureDeletionInfo(treeData, year, "direct", "right");
        this.recordDeletionMarkerForDelete(tree, year, info, "right");
        let updatedTree = deleteYearFromRwl(treeData, year);
        this.rwlData.set(tree, updatedTree);
        this.appendOperationLog(operation, tree, beforeState);
        this.notifyChange();
    }

    deleteYearWithMode(
        tree: string,
        year: number,
        mode: DeleteMode,
        shift: DeleteShift = "right",
        logMetadata?: RwlOperationLogMetadata,
    ): void {
        if (!this.rwlData.has(tree)) return;
        let treeData = this.rwlData.get(tree)!;
        // 允许删除 gap/missing 年份（年份不在 treeData 中）：仍会平移更早年份以收紧 gap。

        const operation: RwlEditOperation = { type: "delete-year", tree, year, mode, shift };
        const beforeState = this.captureTreeLogState(tree);
        this.saveToUndoStack(operation);
        this.redoStack = [];

        const info = this.captureDeletionInfo(treeData, year, mode, shift);
        this.recordDeletionMarkerForDelete(tree, year, info, shift);
        let updatedTree = deleteYearWithMode(treeData, year, mode, shift);
        this.rwlData.set(tree, updatedTree);
        this.appendOperationLog(operation, tree, beforeState, logMetadata);
        this.notifyChange();
    }

    markYearRangeAsMissing(tree: string, selectedStartYear: number, selectedEndYear: number): void {
        if (!this.rwlData.has(tree)) return;

        const startYear = Math.min(selectedStartYear, selectedEndYear);
        const endYear = Math.max(selectedStartYear, selectedEndYear);
        const treeData = this.rwlData.get(tree)!;
        const hasEditableEntryInRange = editableEntries(treeData).some(([year]) => (
            year >= startYear && year <= endYear
        ));

        if (!hasEditableEntryInRange) {
            return;
        }

        const operation: RwlEditOperation = { type: "mark-missing-range", tree, startYear, endYear };
        const beforeState = this.captureTreeLogState(tree);
        this.saveToUndoStack(operation);
        this.redoStack = [];

        const updatedTree = markYearRangeAsMissing(treeData, startYear, endYear);
        this.rwlData.set(tree, updatedTree);
        this.appendOperationLog(operation, tree, beforeState);
        this.notifyChange();
    }

    // 恢复某条红线最近一次删除（双击红线 / ghost 时调用）。
    // 严格后进先出：无视传入 index，永远恢复该缝隙 deleteOrder 最大的那一层，
    // 用该层自己记录的配置（原值 + 填补方向 + 实际注入量）做精确逆操作 —— 不做任何跨层累积计算，
    // 因此连续恢复也绝不会把数据算乱。多次删除沿来时的路一层层退回，直至回到最初。
    restoreDeletion(tree: string, markerYear: number, _index: number = -1): void {
        if (!this.rwlData.has(tree)) return;
        const treeMarkers = this.deletionMarkers.get(tree);
        const stack = treeMarkers?.get(markerYear);
        if (!treeMarkers || !stack || stack.length === 0) return;

        const topIndex = stack.reduce((bestIndex, item, itemIndex) => {
            const bestOrder = stack[bestIndex]?.deleteOrder ?? bestIndex;
            const order = item.deleteOrder ?? itemIndex;
            return order > bestOrder ? itemIndex : bestIndex;
        }, 0);
        const info = stack[topIndex];

        const operation: RwlEditOperation = { type: "restore-deletion", tree, markerYear, index: topIndex };
        const beforeState = this.captureTreeLogState(tree);
        this.saveToUndoStack(operation);
        this.redoStack = [];

        // 镜像删除时的填补方向，重新顶开缺口：
        // - shift="right"（默认）：插回到 markerYear-1，并把 key < markerYear 的年份整体 -1。
        // - shift="left"：插回到 markerYear，并把 key >= markerYear 的年份整体 +1。
        const shiftSide: DeleteShift = info.shiftSide ?? "right";
        const treeData = this.rwlData.get(tree)!;
        const restoredYear = shiftSide === "left" ? markerYear : markerYear - 1;

        const newTreeData: RwlTreeData = new Map();
        treeData.forEach((value, key) => {
            if (shiftSide === "left") {
                newTreeData.set(key >= markerYear ? key + 1 : key, value);
            } else {
                newTreeData.set(key < markerYear ? key - 1 : key, value);
            }
        });

        // 把删除时注入到邻居的固定宽度精确减回（在当前数据上做，保留后续在别处的改动）。
        // 恢复后左右邻所在坐标随填补方向不同。
        const subtractFromNeighbor = (neighborYear: number, amount: number) => {
            if (!amount) return;
            const value = newTreeData.get(neighborYear);
            if (value === undefined || value === null || isStopMarkerValue(value)) return;
            newTreeData.set(neighborYear, value - amount);
        };
        const leftInjected = info.leftContribution ?? 0;
        const rightInjected = info.rightContribution ?? 0;
        if (shiftSide === "left") {
            subtractFromNeighbor(markerYear - 1, leftInjected);  // 左邻位置不变
            subtractFromNeighbor(markerYear + 1, rightInjected); // 右邻被 +1 顶到 markerYear+1
        } else {
            subtractFromNeighbor(markerYear - 2, leftInjected);  // 左邻被 -1 顶到 markerYear-2
            subtractFromNeighbor(markerYear, rightInjected);     // 右邻位置不变
        }

        // 放回被删格的原值（null 表示原本是 gap/stopMarker，不写入即可保留缺口）。
        if (info.deletedWidth !== null && info.deletedWidth !== undefined) {
            newTreeData.set(restoredYear, info.deletedWidth);
        }
        this.rwlData.set(tree, newTreeData);

        // 更新标记：移除顶层；同一 stack 中空间上位于它左/右侧的剩余层，
        // 分别回到恢复格左右两条缝。别处的标记随缺口重新顶开而平移。
        const leftRemainingStack = stack.slice(0, topIndex);
        const rightRemainingStack = stack.slice(topIndex + 1);
        const newMarkers = new Map<number, DeletionMarkerInfo[]>();
        const addMarkerStack = (nextMarkerYear: number, markerStack: DeletionMarkerInfo[]) => {
            if (markerStack.length === 0) return;
            const existing = newMarkers.get(nextMarkerYear);
            newMarkers.set(nextMarkerYear, existing ? [...existing, ...markerStack] : markerStack);
        };

        Array.from(treeMarkers.entries()).sort(([yearA], [yearB]) => yearA - yearB).forEach(([m, markerStack]) => {
            if (m === markerYear) {
                if (shiftSide === "left") {
                    addMarkerStack(markerYear, leftRemainingStack);
                    addMarkerStack(markerYear + 1, rightRemainingStack);
                } else {
                    addMarkerStack(markerYear - 1, leftRemainingStack);
                    addMarkerStack(markerYear, rightRemainingStack);
                }
                return;
            }
            if (shiftSide === "left") {
                addMarkerStack(m > markerYear ? m + 1 : m, markerStack);
            } else {
                addMarkerStack(m < markerYear ? m - 1 : m, markerStack);
            }
        });
        if (newMarkers.size === 0) {
            this.deletionMarkers.delete(tree);
        } else {
            this.deletionMarkers.set(tree, newMarkers);
        }

        this.appendOperationLog(operation, tree, beforeState);
        this.notifyChange();
    }

    // 删除前快照出一条「自包含的逆操作」：被删格原值 + 分配/填补配置 + 实际注入到邻居的固定宽度。
    // 恢复时只看这条记录即可精确还原，不依赖其它层。
    private captureDeletionInfo(treeData: RwlTreeData, year: number, mode: DeleteMode, shift: DeleteShift = "right"): DeletionMarkerInfo {
        const deletedRaw = treeData.get(year);
        const leftRaw = treeData.get(year - 1);
        const rightRaw = treeData.get(year + 1);
        const deletedWidth = (deletedRaw === undefined || isStopMarkerValue(deletedRaw)) ? null : deletedRaw;
        const isNumericWidth = (value: number | null | undefined): value is number => (
            typeof value === "number" && !isStopMarkerValue(value)
        );
        // 与删除逻辑（addWidthToNeighbor）一致：邻居不存在/为缺测则不注入，记 0。
        const injectedInto = (side: "left" | "right"): number => {
            if (deletedWidth === null) return 0;
            const neighborRaw = side === "left" ? leftRaw : rightRaw;
            if (!isNumericWidth(neighborRaw)) return 0;
            if (mode === side) return deletedWidth;
            if (mode === "both") return Math.round(deletedWidth / 2);
            return 0;
        };

        return {
            deletedWidth,
            mode,
            shiftSide: shift,
            deleteOrder: this.deletionOrderCounter++,
            leftContribution: injectedInto("left"),
            rightContribution: injectedInto("right"),
        };
    }

    replaceTreeData(tree: string, newData: RwlTreeData, logMetadata?: RwlOperationLogMetadata): void {
        if (!this.rwlData.has(tree)) return;

        const operation: RwlEditOperation = { type: "replace-tree-data", tree };
        const beforeState = this.captureTreeLogState(tree);
        this.saveToUndoStack(operation);
        this.redoStack = [];

        const next = new Map(this.rwlData);
        next.set(tree, cloneTreeData(newData));
        this.rwlData = next;

        const nextMarkers = cloneDeletionMarkers(this.deletionMarkers);
        nextMarkers.delete(tree);
        this.deletionMarkers = nextMarkers;

        this.appendOperationLog(operation, tree, beforeState, logMetadata);
        this.notifyChange();
    }

    replaceAllData(data: RwlSiteData, options?: RwlReadResult['readOptions'], format?: RwlFormat): void {
        const operation: RwlEditOperation = { type: "replace-all-data", treeCount: data.size, format };
        const previousData = cloneSiteData(this.rwlData);
        const previousMarkers = cloneDeletionMarkers(this.deletionMarkers);
        this.saveToUndoStack(operation);
        this.redoStack = [];
        this.rwlData = cloneSiteData(data);
        this.readOptions = cloneReadOptions(options);
        this.format = format || this.format;
        this.deletionMarkers = new Map();

        const changedTrees = new Set([...previousData.keys(), ...this.rwlData.keys()]);
        changedTrees.forEach((tree) => {
            const beforeState = {
                data: previousData.has(tree) ? serializeTreeData(previousData.get(tree)!) : null,
                deletionMarkers: serializeTreeDeletionMarkers(previousMarkers.get(tree)),
            };
            this.appendOperationLog(operation, tree, beforeState);
        });
        this.notifyChange();
    }

    deleteSeries(tree: string): void {
        if (!this.rwlData.has(tree)) return;

        const operation: RwlEditOperation = { type: "delete-series", tree };
        const beforeState = this.captureTreeLogState(tree);
        this.saveToUndoStack(operation);
        this.redoStack = [];

        const updatedData = new Map(this.rwlData);
        updatedData.delete(tree);
        this.rwlData = updatedData;
        this.deletionMarkers.delete(tree);
        this.appendOperationLog(operation, tree, beforeState);
        this.notifyChange();
    }

    changeYearWidth(tree: string, year: number, width: number | null): void {
        if (!this.rwlData.has(tree)) return;
        let treeData = this.rwlData.get(tree)!;
        if (!treeData.has(year)) return;

        const operation: RwlEditOperation = { type: "change-width", tree, year, width };
        const beforeState = this.captureTreeLogState(tree);
        this.saveToUndoStack(operation);
        this.redoStack = [];

        let updatedTree = changeYearWidth(treeData, year, width);
        this.rwlData.set(tree, updatedTree);
        this.appendOperationLog(operation, tree, beforeState);
        this.notifyChange();
    }

    // 撤销（Undo）
    undo(): RwlHistoryAnimation | null {
        if (this.undoStack.length === 0) return null;
        const previousEntry = this.undoStack.pop()!;
        const currentData = cloneSiteData(this.rwlData);
        const currentMarkers = cloneDeletionMarkers(this.deletionMarkers);
        const currentOperationLogSnapshot = this.captureOperationLogSnapshot();
        const currentOperationLogCounter = this.operationLogCounter;
        this.redoStack.push({
            data: currentData,
            deletionMarkers: currentMarkers,
            readOptions: cloneReadOptions(this.readOptions),
            format: this.format,
            operation: previousEntry.operation,
            operationLogSnapshot: currentOperationLogSnapshot,
            operationLogCounter: currentOperationLogCounter,
        });
        this.rwlData = previousEntry.data;
        this.deletionMarkers = previousEntry.deletionMarkers;
        this.readOptions = cloneReadOptions(previousEntry.readOptions);
        this.format = previousEntry.format;
        this.restoreOperationLogSnapshot(previousEntry.operationLogSnapshot, previousEntry.operationLogCounter);
        this.notifyChange();
        return previousEntry.operation ? { ...previousEntry.operation, direction: "undo" } : null;
    }

    // 恢复（Redo）
    redo(): RwlHistoryAnimation | null {
        if (this.redoStack.length === 0) return null;
        const nextEntry = this.redoStack.pop()!;
        const currentData = cloneSiteData(this.rwlData);
        const currentMarkers = cloneDeletionMarkers(this.deletionMarkers);
        const currentOperationLogSnapshot = this.captureOperationLogSnapshot();
        const currentOperationLogCounter = this.operationLogCounter;
        this.undoStack.push({
            data: currentData,
            deletionMarkers: currentMarkers,
            readOptions: cloneReadOptions(this.readOptions),
            format: this.format,
            operation: nextEntry.operation,
            operationLogSnapshot: currentOperationLogSnapshot,
            operationLogCounter: currentOperationLogCounter,
        });
        this.rwlData = nextEntry.data;
        this.deletionMarkers = nextEntry.deletionMarkers;
        this.readOptions = cloneReadOptions(nextEntry.readOptions);
        this.format = nextEntry.format;
        this.restoreOperationLogSnapshot(nextEntry.operationLogSnapshot, nextEntry.operationLogCounter);
        this.notifyChange();
        return nextEntry.operation ? { ...nextEntry.operation, direction: "redo" } : null;
    }

    // 记录当前状态到 Undo 栈
    private saveToUndoStack(operation?: RwlEditOperation): void {
        this.undoStack.push({
            data: cloneSiteData(this.rwlData),
            deletionMarkers: cloneDeletionMarkers(this.deletionMarkers),
            readOptions: cloneReadOptions(this.readOptions),
            format: this.format,
            operation,
            operationLogSnapshot: this.captureOperationLogSnapshot(),
            operationLogCounter: this.operationLogCounter,
        });
    }

    // 导出为 RWL 字符串，使用读取时的原始格式
    // 通过 formatHandlers 注册表路由到相应的 format 函数
    // 例：tucson 格式使用 formatTucson，并以 readOptions.tucsonLong 复现原始字段宽度
    exportAsRwlString(selectedTree?: string): string {
        const handler = formatHandlers[this.format as any as keyof typeof formatHandlers];
        if (!handler || !handler.format) {
            console.warn(`No format handler found for: ${this.format}`);
            return '';
        }
        return handler.format(this.rwlData, this.readOptions, selectedTree);
    }
}

// 新增：全局注册/调用桥
export let changeYearWidthHandler: ((tree: string, year: number, width: number | null) => void) | null = null;

export function registerChangeYearWidth(handler: (tree: string, year: number, width: number | null) => void) {
    changeYearWidthHandler = handler;
}

export function callChangeYearWidth(tree: string, year: number, width: number | null) {
    changeYearWidthHandler?.(tree, year, width);
}

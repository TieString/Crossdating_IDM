import { RwlTreeData, RwlReadResult, RwlSiteData } from "./types";
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

export type RwlEditOperation =
    | { type: "insert-missing"; tree: string; year: number; side: MissingInsertSide }
    | { type: "move-selection"; tree: string; selectedStartYear: number; selectedEndYear: number; yearOffset: number }
    | { type: "delete-year"; tree: string; year: number; mode: DeleteMode }
    | { type: "mark-missing-range"; tree: string; startYear: number; endYear: number }
    | { type: "restore-deletion"; tree: string; markerYear: number; index: number }
    | { type: "delete-series"; tree: string };

export type RwlHistoryAnimation = RwlEditOperation & {
    direction: "undo" | "redo";
};

// 每个 tree 的删除标记：年份 M 表示 "在当前年份 M 的左边沿画一条红色竖线"。
// 仅在内存中维护，与 undo/redo 联动；不写入 RWL 文件。
// 同时记录删除发生时的原始数据，以便悬停预览时还原被删格子和两侧值。
export type DeletionMarkerInfo = {
    // 被删除年份的宽度（删除前）
    deletedWidth: number | null;
    // 恢复时写回的源宽度；连续分配删除时会去掉相邻 ghost 已注入的宽度。
    restoreWidth?: number | null;
    // 删除模式；direct 恢复时不应修改任何邻居。
    mode?: DeleteMode;
    sourceYear?: number;
    sourceRunStartYear?: number;
    sourceRunEndYear?: number;
    deleteOrder?: number;
    leftContribution?: number;
    rightContribution?: number;
    // 删除前左邻 (year - 1) 的宽度；undefined 表示当时左侧无格子
    leftOriginalWidth?: number | null;
    // 删除前右邻 (year + 1) 的宽度；undefined 表示当时右侧无格子
    rightOriginalWidth?: number | null;
};

// 同一格子位置可以堆叠多个删除标记（连续在同一处删除时）。
// 数组顺序按空间排列：0 = 远离红线，length - 1 = 贴近红线。
export type RwlDeletionMarkers = Map<string, Map<number, DeletionMarkerInfo[]>>;

type RwlHistoryEntry = {
    data: RwlSiteData;
    deletionMarkers: RwlDeletionMarkers;
    operation?: RwlEditOperation;
};

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

    // Moved selected values intentionally overwrite any fixed values at target years.
    selectedEntries.forEach(([year, width]) => {
        next.set(year + yearOffset, width);
    });

    return sortedTreeData(Array.from(next.entries()));
}

// 删年：在year处删除0，之前的年份总体向后移动1年，最新年份不变
function deleteYearFromRwl(rwlData: RwlTreeData, year: number): RwlTreeData {
    let rwl_new: RwlTreeData = new Map()
    rwlData.forEach((value, key) => {
        if (key === year) return
        let offset = (key < year) ? 1 : 0
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

const getLeftContribution = (info: DeletionMarkerInfo | undefined): number => {
    if (!info || info.deletedWidth === null) return 0;
    if (info.leftContribution !== undefined) return info.leftContribution;
    const mode = info.mode ?? "direct";
    if (mode === "left") return info.deletedWidth;
    if (mode === "both") return Math.round(info.deletedWidth / 2);
    return 0;
};

const getRightContribution = (info: DeletionMarkerInfo | undefined): number => {
    if (!info || info.deletedWidth === null) return 0;
    if (info.rightContribution !== undefined) return info.rightContribution;
    const mode = info.mode ?? "direct";
    if (mode === "right") return info.deletedWidth;
    if (mode === "both") return Math.round(info.deletedWidth / 2);
    return 0;
};

const getStackRunStartYear = (stack: DeletionMarkerInfo[] | undefined): number | undefined => {
    if (!stack || stack.length === 0) return undefined;
    const years = stack
        .map((info) => info.sourceRunStartYear ?? info.sourceYear)
        .filter((year): year is number => year !== undefined);
    if (years.length === 0) return undefined;
    return Math.min(...years);
};

const getStackRunEndYear = (stack: DeletionMarkerInfo[] | undefined): number | undefined => {
    if (!stack || stack.length === 0) return undefined;
    const years = stack
        .map((info) => info.sourceRunEndYear ?? info.sourceYear)
        .filter((year): year is number => year !== undefined);
    if (years.length === 0) return undefined;
    return Math.max(...years);
};

export const getDeletionStackBoundaryContributions = (stack: DeletionMarkerInfo[]): { left: number; right: number } => {
    if (stack.length === 0) return { left: 0, right: 0 };

    const ordered = stack
        .map((info, index) => ({ info, index }))
        .sort((a, b) => (
            (a.info.deleteOrder ?? a.index) - (b.info.deleteOrder ?? b.index)
        ));
    const alive = Array.from({ length: stack.length + 2 }, () => true);
    const contributions = Array.from({ length: stack.length + 2 }, () => 0);

    ordered.forEach(({ info, index }) => {
        const cellIndex = index + 1;
        if (!alive[cellIndex]) return;

        let leftIndex = cellIndex - 1;
        while (leftIndex >= 0 && !alive[leftIndex]) leftIndex -= 1;
        let rightIndex = cellIndex + 1;
        while (rightIndex < alive.length && !alive[rightIndex]) rightIndex += 1;

        if (leftIndex >= 0) contributions[leftIndex] += getLeftContribution(info);
        if (rightIndex < alive.length) contributions[rightIndex] += getRightContribution(info);
        alive[cellIndex] = false;
    });

    return {
        left: contributions[0],
        right: contributions[contributions.length - 1],
    };
};

// 按模式删年：在 year 处删除，并可选择将其宽度并入左/右/两侧邻居
// year 不在数据中（gap/missing 年份）也允许：此时无宽度可分配，仍会平移更早的年份以收紧时间轴。
export function deleteYearWithMode(
    rwlData: RwlTreeData,
    year: number,
    mode: DeleteMode,
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

    return deleteYearFromRwl(working, year);
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
    private readOptions?: RwlReadResult['readOptions'];
    private format: string = 'tucson'; // 记录原始读取格式
    private undoStack: RwlHistoryEntry[] = [];
    private redoStack: RwlHistoryEntry[] = [];
    private deletionMarkers: RwlDeletionMarkers = new Map();
    private deletionOrderCounter = 0;
    private changeCallback?: () => void;

    constructor(initialData: RwlSiteData, options?: RwlReadResult['readOptions'], format?: string) {
        this.rwlData = new Map(initialData);
        this.readOptions = options;
        this.format = format || 'tucson'; // 默认 tucson
    }

    // 获取当前所有删除标记（深拷贝，避免外部修改影响内部状态）
    getDeletionMarkers(): RwlDeletionMarkers {
        return cloneDeletionMarkers(this.deletionMarkers);
    }

    // 删除年份后，将原标记的年份映射到新坐标，并把本次删除插入到空间顺序中。
    // 同一个 marker 的 stack 按从左到右排列：0 = 远离红线，length - 1 = 贴近红线。
    private recordDeletionMarkerForDelete(tree: string, year: number, info: DeletionMarkerInfo): void {
        const insertMarkerYear = year + 1;
        const sourceRunStartYear = info.sourceRunStartYear ?? info.sourceYear ?? year;
        const sourceRunEndYear = info.sourceRunEndYear ?? info.sourceYear ?? year;
        const withRunBounds = (stack: DeletionMarkerInfo[]) => stack.map((item) => ({
            ...item,
            sourceRunStartYear,
            sourceRunEndYear,
        }));
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
            if (m < year) {
                addStack(m + 1, stack);
            } else if (m === year) {
                addStack(insertMarkerYear, withRunBounds(stack));
            } else if (m !== insertMarkerYear) {
                addStack(m, stack);
            }
        });

        addStack(insertMarkerYear, [info]);

        const rightStack = entries.get(insertMarkerYear);
        if (rightStack) {
            addStack(insertMarkerYear, withRunBounds(rightStack));
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


    // 获取当前 RWL 数据
    getData(): RwlSiteData {
        return new Map(this.rwlData);
    }

    // 获取原始格式信息（用于保存时复现格式）
    getReadOptions(): RwlReadResult['readOptions'] {
        return this.readOptions;
    }

    // 插年：在 year 处插入 0
    insertYear(tree: string, year: number): void {
        this.saveToUndoStack(); // 记录操作前状态
        this.redoStack = []; // 清空 redo 记录

        if (!this.rwlData.has(tree)) return;
        let treeData = this.rwlData.get(tree)!;
        if (!treeData.has(year)) return;

        this.undoStack[this.undoStack.length - 1].operation = { type: "insert-missing", tree, year, side: "right" };

        this.shiftDeletionMarkersForInsert(tree, year, "right");
        let updatedTree = insertMissingYearAtSide(treeData, year, "right");
        this.rwlData.set(tree, updatedTree);
        this.notifyChange();
    }

    // 删年：在 year 处删除 0
    // Insert a missing placeholder from the requested side of the current year.
    insertMissingYearAtSide(tree: string, year: number, side: MissingInsertSide): void {
        this.saveToUndoStack({ type: "insert-missing", tree, year, side });
        this.redoStack = [];

        if (!this.rwlData.has(tree)) return;
        let treeData = this.rwlData.get(tree)!;
        if (!treeData.has(year)) return;

        this.shiftDeletionMarkersForInsert(tree, year, side);
        let updatedTree = insertMissingYearAtSide(treeData, year, side);
        this.rwlData.set(tree, updatedTree);
        this.notifyChange();
    }

    moveSeriesTailByOffset(tree: string, selectedStartYear: number, selectedEndYear: number, yearOffset: number): void {
        if (yearOffset === 0) return;

        this.saveToUndoStack({ type: "move-selection", tree, selectedStartYear, selectedEndYear, yearOffset });
        this.redoStack = [];

        if (!this.rwlData.has(tree)) return;
        let treeData = this.rwlData.get(tree)!;

        this.shiftDeletionMarkersForMove(tree, selectedStartYear, selectedEndYear, yearOffset);
        let updatedTree = moveSeriesTailByOffset(treeData, selectedStartYear, selectedEndYear, yearOffset);
        this.rwlData.set(tree, updatedTree);
        this.notifyChange();
    }

    deleteYear(tree: string, year: number): void {
        this.saveToUndoStack();
        this.redoStack = [];

        if (!this.rwlData.has(tree)) return;
        let treeData = this.rwlData.get(tree)!;
        if (!treeData.has(year)) return;

        const info = this.captureDeletionInfo(tree, treeData, year, "direct");
        this.recordDeletionMarkerForDelete(tree, year, info);
        let updatedTree = deleteYearFromRwl(treeData, year);
        this.rwlData.set(tree, updatedTree);
        this.notifyChange();
    }

    deleteYearWithMode(tree: string, year: number, mode: DeleteMode): void {
        this.saveToUndoStack({ type: "delete-year", tree, year, mode });
        this.redoStack = [];

        if (!this.rwlData.has(tree)) return;
        let treeData = this.rwlData.get(tree)!;
        // 允许删除 gap/missing 年份（年份不在 treeData 中）：仍会平移更早年份以收紧 gap。

        const info = this.captureDeletionInfo(tree, treeData, year, mode);
        this.recordDeletionMarkerForDelete(tree, year, info);
        let updatedTree = deleteYearWithMode(treeData, year, mode);
        this.rwlData.set(tree, updatedTree);
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

        this.saveToUndoStack({ type: "mark-missing-range", tree, startYear, endYear });
        this.redoStack = [];

        const updatedTree = markYearRangeAsMissing(treeData, startYear, endYear);
        this.rwlData.set(tree, updatedTree);
        this.notifyChange();
    }

    // 撤销某一个具体的删除标记（双击对应 ghost 时调用）。
    // markerYear 即标记当前所处的年份；index 指定栈中第几个被删除条目。
    // 还原后：在 markerYear - 1 处插回 restoreWidth + 剩余 ghost 的边界贡献，
    // 同时把 key < markerYear 的年份整体向前回退 1 年；
    // 左右边界只按恢复前后的贡献差额调整；其他删除标记同步左移。
    restoreDeletion(tree: string, markerYear: number, index: number = -1): void {
        if (!this.rwlData.has(tree)) return;
        const treeMarkers = this.deletionMarkers.get(tree);
        const stack = treeMarkers?.get(markerYear);
        if (!treeMarkers || !stack || stack.length === 0) return;

        const latestIndex = stack.reduce((bestIndex, item, itemIndex) => {
            const bestOrder = stack[bestIndex]?.deleteOrder ?? bestIndex;
            const order = item.deleteOrder ?? itemIndex;
            return order > bestOrder ? itemIndex : bestIndex;
        }, 0);
        const resolvedIndex = index < 0 ? latestIndex : index;
        if (resolvedIndex < 0 || resolvedIndex >= stack.length) return;
        const info = stack[resolvedIndex];

        this.saveToUndoStack({ type: "restore-deletion", tree, markerYear, index: resolvedIndex });
        this.redoStack = [];

        const treeData = this.rwlData.get(tree)!;
        const restoredYear = markerYear - 1;
        const restoredValue = info.restoreWidth ?? info.deletedWidth;

        const newTreeData: RwlTreeData = new Map();
        treeData.forEach((value, key) => {
            if (key < markerYear) {
                newTreeData.set(key - 1, value);
            } else {
                newTreeData.set(key, value);
            }
        });
        // 仅从该年的栈中拿掉指定那条；恢复后，原来位于它左侧的 ghost 需要跟随
        // 新插回的格子，移动到 markerYear - 1；右侧 ghost 继续留在 markerYear。
        const leftRemainingStack = stack.slice(0, resolvedIndex);
        const rightRemainingStack = stack.slice(resolvedIndex + 1);
        const oldContributions = getDeletionStackBoundaryContributions(stack);
        const leftContributions = getDeletionStackBoundaryContributions(leftRemainingStack);
        const rightContributions = getDeletionStackBoundaryContributions(rightRemainingStack);

        const applyContributionDelta = (targetYear: number, from: number, to: number) => {
            if (from === to) return;
            const value = newTreeData.get(targetYear);
            if (value === undefined || value === null || isStopMarkerValue(value)) return;
            newTreeData.set(targetYear, value - from + to);
        };

        applyContributionDelta(markerYear - 2, oldContributions.left, leftContributions.left);
        applyContributionDelta(markerYear, oldContributions.right, rightContributions.right);

        // deletedWidth 为 null 表示原本就是 gap/stopMarker，不写入数据即可（保留缺口）。
        if (restoredValue !== null) {
            newTreeData.set(
                restoredYear,
                restoredValue + leftContributions.right + rightContributions.left,
            );
        }
        this.rwlData.set(tree, newTreeData);

        const newMarkers = new Map<number, DeletionMarkerInfo[]>();
        const addMarkerStack = (nextMarkerYear: number, markerStack: DeletionMarkerInfo[]) => {
            if (markerStack.length === 0) return;
            const existing = newMarkers.get(nextMarkerYear);
            newMarkers.set(nextMarkerYear, existing ? [...existing, ...markerStack] : markerStack);
        };

        treeMarkers.forEach((markerStack, m) => {
            if (m === markerYear) {
                addMarkerStack(markerYear - 1, leftRemainingStack);
                addMarkerStack(markerYear, rightRemainingStack);
                return;
            }
            if (m < markerYear) addMarkerStack(m - 1, markerStack);
            else addMarkerStack(m, markerStack);
        });
        if (newMarkers.size === 0) {
            this.deletionMarkers.delete(tree);
        } else {
            this.deletionMarkers.set(tree, newMarkers);
        }

        this.notifyChange();
    }

    // 在执行删除前快照被删年份及其相邻年份的原始宽度，用于悬停预览。
    // 跳过 stopMarker 邻居（不应作为原值还原）。
    private captureDeletionInfo(tree: string, treeData: RwlTreeData, year: number, mode: DeleteMode): DeletionMarkerInfo {
        const deletedRaw = treeData.get(year);
        const leftRaw = treeData.get(year - 1);
        const rightRaw = treeData.get(year + 1);
        const treeMarkers = this.deletionMarkers.get(tree);
        const leftStack = treeMarkers?.get(year);
        const rightStack = treeMarkers?.get(year + 1);
        const leftRunStart = getStackRunStartYear(leftStack);
        const leftRunEnd = getStackRunEndYear(leftStack);
        const rightRunStart = getStackRunStartYear(rightStack);
        const rightRunEnd = getStackRunEndYear(rightStack);
        const sourceYear = rightRunStart !== undefined
            ? rightRunStart - 1
            : leftRunEnd !== undefined
                ? leftRunEnd + 1
                : year;
        const sourceRunStartYear = Math.min(
            sourceYear,
            leftRunStart ?? sourceYear,
            rightRunStart ?? sourceYear,
        );
        const sourceRunEndYear = Math.max(
            sourceYear,
            leftRunEnd ?? sourceYear,
            rightRunEnd ?? sourceYear,
        );
        const leftBoundaryContribution = getDeletionStackBoundaryContributions(leftStack ?? []).right;
        const rightBoundaryContribution = getDeletionStackBoundaryContributions(rightStack ?? []).left;
        const deletedWidth = (deletedRaw === undefined || isStopMarkerValue(deletedRaw)) ? null : deletedRaw;
        const restoreWidth = (() => {
            if (deletedRaw === undefined || deletedRaw === null || isStopMarkerValue(deletedRaw)) return null;
            return deletedRaw - leftBoundaryContribution - rightBoundaryContribution;
        })();
        const sanitize = (value: number | null | undefined): number | null | undefined => {
            if (value === undefined) return undefined;
            if (isStopMarkerValue(value)) return undefined;
            return value;
        };
        const leftOriginalWidth = mode === "left" || mode === "both" ? sanitize(leftRaw) : undefined;
        const rightOriginalWidth = mode === "right" || mode === "both" ? sanitize(rightRaw) : undefined;
        const getContributionAmount = (side: "left" | "right") => {
            if (deletedWidth === null) return 0;
            if (side === "left" && typeof leftOriginalWidth !== "number") return 0;
            if (side === "right" && typeof rightOriginalWidth !== "number") return 0;
            if (mode === side) return deletedWidth;
            if (mode === "both") return Math.round(deletedWidth / 2);
            return 0;
        };

        return {
            deletedWidth,
            restoreWidth,
            mode,
            sourceYear,
            sourceRunStartYear,
            sourceRunEndYear,
            deleteOrder: this.deletionOrderCounter++,
            leftContribution: getContributionAmount("left"),
            rightContribution: getContributionAmount("right"),
            leftOriginalWidth,
            rightOriginalWidth,
        };
    }

    deleteSeries(tree: string): void {
        if (!this.rwlData.has(tree)) return;

        this.saveToUndoStack({ type: "delete-series", tree });
        this.redoStack = [];

        const updatedData = new Map(this.rwlData);
        updatedData.delete(tree);
        this.rwlData = updatedData;
        this.deletionMarkers.delete(tree);
        this.notifyChange();
    }

    changeYearWidth(tree: string, year: number, width: number | null): void {
        this.saveToUndoStack();
        this.redoStack = [];

        if (!this.rwlData.has(tree)) return;
        let treeData = this.rwlData.get(tree)!;
        if (!treeData.has(year)) return;

        let updatedTree = changeYearWidth(treeData, year, width);
        this.rwlData.set(tree, updatedTree);
        this.notifyChange();
    }

    // 撤销（Undo）
    undo(): RwlHistoryAnimation | null {
        if (this.undoStack.length === 0) return null;
        const previousEntry = this.undoStack.pop()!;
        this.redoStack.push({
            data: new Map(this.rwlData),
            deletionMarkers: cloneDeletionMarkers(this.deletionMarkers),
            operation: previousEntry.operation,
        });
        this.rwlData = previousEntry.data;
        this.deletionMarkers = previousEntry.deletionMarkers;
        this.notifyChange();
        return previousEntry.operation ? { ...previousEntry.operation, direction: "undo" } : null;
    }

    // 恢复（Redo）
    redo(): RwlHistoryAnimation | null {
        if (this.redoStack.length === 0) return null;
        const nextEntry = this.redoStack.pop()!;
        this.undoStack.push({
            data: new Map(this.rwlData),
            deletionMarkers: cloneDeletionMarkers(this.deletionMarkers),
            operation: nextEntry.operation,
        });
        this.rwlData = nextEntry.data;
        this.deletionMarkers = nextEntry.deletionMarkers;
        this.notifyChange();
        return nextEntry.operation ? { ...nextEntry.operation, direction: "redo" } : null;
    }

    // 记录当前状态到 Undo 栈
    private saveToUndoStack(operation?: RwlEditOperation): void {
        this.undoStack.push({
            data: new Map(this.rwlData),
            deletionMarkers: cloneDeletionMarkers(this.deletionMarkers),
            operation,
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

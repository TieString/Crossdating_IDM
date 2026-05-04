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

export type RwlEditOperation =
    | { type: "insert-missing"; tree: string; year: number; side: MissingInsertSide }
    | { type: "move-selection"; tree: string; selectedStartYear: number; selectedEndYear: number; yearOffset: number };

export type RwlHistoryAnimation = RwlEditOperation & {
    direction: "undo" | "redo";
};

type RwlHistoryEntry = {
    data: RwlSiteData;
    operation?: RwlEditOperation;
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
    private changeCallback?: () => void;

    constructor(initialData: RwlSiteData, options?: RwlReadResult['readOptions'], format?: string) {
        this.rwlData = new Map(initialData);
        this.readOptions = options;
        this.format = format || 'tucson'; // 默认 tucson
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

        let updatedTree = deleteYearFromRwl(treeData, year);
        this.rwlData.set(tree, updatedTree);
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
            operation: previousEntry.operation,
        });
        this.rwlData = previousEntry.data;
        this.notifyChange();
        return previousEntry.operation ? { ...previousEntry.operation, direction: "undo" } : null;
    }

    // 恢复（Redo）
    redo(): RwlHistoryAnimation | null {
        if (this.redoStack.length === 0) return null;
        const nextEntry = this.redoStack.pop()!;
        this.undoStack.push({
            data: new Map(this.rwlData),
            operation: nextEntry.operation,
        });
        this.rwlData = nextEntry.data;
        this.notifyChange();
        return nextEntry.operation ? { ...nextEntry.operation, direction: "redo" } : null;
    }

    // 记录当前状态到 Undo 栈
    private saveToUndoStack(operation?: RwlEditOperation): void {
        this.undoStack.push({
            data: new Map(this.rwlData),
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

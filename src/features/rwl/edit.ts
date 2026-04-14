import { RwlTreeData, RwlReadResult } from "./types";
import { RwlSiteData } from './types';
import { formatHandlers } from "./index";

// RWL 编辑器
// ===========
// 负责记录 RWL 数据的编辑历史（undo/redo）和导出。
// 
// exportAsRwlString() 通过 formatHandlers 注册表自动选择相应的 format 函数，
// 确保导出格式与读入时一致（通过 readOptions 记录的元数据）。

// 插年：在year处插入0，之前的年份总体向前移动1年，最新年份不变
function insertYearToRwl(rwlData: RwlTreeData, year: number): RwlTreeData {
    let rwl_new: RwlTreeData = new Map()
    rwlData.forEach((value, key) => {
        let offset = (key <= year) ? 1 : 0
        rwl_new.set(key - offset, value)
        if (key === year) rwl_new.set(key, 0)
    })
    return rwl_new
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
    private undoStack: RwlSiteData[] = [];
    private redoStack: RwlSiteData[] = [];
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

        let updatedTree = insertYearToRwl(treeData, year);
        this.rwlData.set(tree, updatedTree);
        this.notifyChange();
    }

    // 删年：在 year 处删除 0
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
    undo(): void {
        if (this.undoStack.length === 0) return;
        this.redoStack.push(new Map(this.rwlData));
        this.rwlData = this.undoStack.pop()!;
        this.notifyChange();
    }

    // 恢复（Redo）
    redo(): void {
        if (this.redoStack.length === 0) return;
        this.undoStack.push(new Map(this.rwlData));
        this.rwlData = this.redoStack.pop()!;
        this.notifyChange();
    }

    // 记录当前状态到 Undo 栈
    private saveToUndoStack(): void {
        this.undoStack.push(new Map(this.rwlData));
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
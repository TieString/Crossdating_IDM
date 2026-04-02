import { RwlTreeData, RwlReadResult } from "./types";
import { RwlSiteData } from './types';
import { stopMarker } from "@/shared/constants";

// RWL 编辑模块。
// 这里集中处理两类事情：
// 1. 在内存里对树轮宽度数据做结构化编辑；
// 2. 在读取与导出之间完成 RWL 文本和 Map 结构的互转。
// 页面层只需要调用 RwlEditor，不需要关心具体的行宽格式和年份偏移规则。
//
// 格式透明性设计：
// - RwlEditor 记录原始格式信息 (readOptions)
// - formateRwlFromMapToString 支持格式参数，保存时复现原格式
// 详见 RWL_FORMAT_SPEC.md#格式透明性原则

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


// 将RwlTreeData类型的数据格式化为字符串，以样点名称 年份 宽度 宽度 宽度...的格式输出，每整十年换行
export function formateRwlFromMapToString(
    rwl_data: RwlSiteData,
    selectedTree?: string,
    options?: { tucsonLong?: boolean }
): string {
    // 样点编号宽度：true 为 7 列（长格式），false 为 8 列（短格式）
    const idWidth = options?.tucsonLong ? 7 : 8;
    // 可选：只导出选中树
    if (selectedTree && selectedTree !== '全部') {
        const treeData = rwl_data.get(selectedTree)
        if (!treeData) return ''
        rwl_data = new Map([[selectedTree, treeData]])
    }

    let rwl_str = ''

    rwl_data.forEach((treeMap, treeCode) => {
        const entries = Array.from(treeMap.entries()).sort((a, b) => a[0] - b[0]) // 按年份排序
        let interrupt_flag = false // 中断标志 表示上一个值是否-9999
        entries.forEach(([year, width], index) => {
            const isFirst = index === 0
            const isTenth = year % 10 === 0
            const isLast = index === entries.length - 1

            const widthStr = (width === null ? '' : width).toString().padStart(6, ' ')

            // 新行：首行或整十年或上一年是中断
            if (isFirst || isTenth || interrupt_flag) {
                if (!isFirst) rwl_str += '\r\n'
                rwl_str += treeCode.padStart(idWidth, ' ') + year.toString().padStart(6, ' ') + widthStr
                interrupt_flag = false
            } else {
                rwl_str += widthStr
            }

            // 中断行（-9999 且不是最后一项）
            if ((width === stopMarker.value) && !isLast) {
                interrupt_flag = true
            }
        })

        rwl_str += '\r\n' // 每棵树结束后换行
    })

    return rwl_str.trimEnd() + '\r\n'
}



export class RwlEditor {
    private rwlData: RwlSiteData; // 现在存储的是 RwlSiteData
    private readOptions?: RwlReadResult['readOptions']; // 记录原始格式信息
    private undoStack: RwlSiteData[] = [];
    private redoStack: RwlSiteData[] = [];
    /** 可选的变更回调，编辑器每次修改数据时调用。 */
    private changeCallback?: () => void;

    constructor(initialData: RwlSiteData, options?: RwlReadResult['readOptions']) {
        this.rwlData = new Map(initialData); // 复制初始数据，避免修改原始对象
        this.readOptions = options; // 保存格式信息（不可变元数据）
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
}

// 新增：全局注册/调用桥
export let changeYearWidthHandler: ((tree: string, year: number, width: number | null) => void) | null = null;

export function registerChangeYearWidth(handler: (tree: string, year: number, width: number | null) => void) {
    changeYearWidthHandler = handler;
}

export function callChangeYearWidth(tree: string, year: number, width: number | null) {
    changeYearWidthHandler?.(tree, year, width);
}
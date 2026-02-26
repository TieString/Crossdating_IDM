import { RwlTreeData } from "../types";
import { message } from '@tauri-apps/plugin-dialog';
import { RwlSiteData } from '../types';


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


export function readRwlToMap(rwl_str: string): RwlSiteData | undefined {
    // 使用 \r\n 将字符串按行分割
    const lines = rwl_str.split(/\r?\n/)
    let rwl_data: RwlSiteData = new Map()

    if (!lines || lines.length < 1) {
        message('没有数据或内容格式错误', { title: '错误', kind: 'error' })
        return undefined
    }

    // 遍历每一行
    lines.forEach(line => {
        if (!line.trim()) return;
        // 使用正则表达式将每 6 个字符分割
        const parts = line.match(/.{6}/g)

        if (!parts) return

        // 获取年份和宽度
        const tree_code: string = parts[0]
        const year: number = parseInt(parts[1])
        const width_array: (number | null)[] = parts.slice(2).map(s => {
            const trimmed = s.trim()
            return trimmed === '' ? null : Number(trimmed)
        })
        // 将数据存入字典
        if (!rwl_data.has(tree_code)) {
            rwl_data.set(tree_code, new Map())
        }
        width_array.forEach((width, index) => {
            rwl_data.get(tree_code)?.set(year + index, width)
        })
    })

    return rwl_data
}

// 将RwlTreeData类型的数据格式化为字符串，以样点名称 年份 宽度 宽度 宽度...的格式输出，每整十年换行
export function formateRwlFromMapToString(
    rwl_data: RwlSiteData,
    selectedTree?: string
): string {
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
                rwl_str += treeCode.padStart(6, ' ') + year.toString().padStart(6, ' ') + widthStr
                interrupt_flag = false
            } else {
                rwl_str += widthStr
            }

            // 中断行（-9999 且不是最后一项）
            if ((width === -9999 || width === 999) && !isLast) {
                interrupt_flag = true
            }
        })

        rwl_str += '\r\n' // 每棵树结束后换行
    })

    return rwl_str.trimEnd() + '\r\n'
}



export class RwlEditor {
    private rwlData: RwlSiteData; // 现在存储的是 RwlSiteData
    private undoStack: RwlSiteData[] = [];
    private redoStack: RwlSiteData[] = [];

    constructor(initialData: RwlSiteData) {
        this.rwlData = new Map(initialData); // 复制初始数据，避免修改原始对象
    }

    // 获取当前 RWL 数据
    getData(): RwlSiteData {
        return new Map(this.rwlData);
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
    }

    // 撤销（Undo）
    undo(): void {
        if (this.undoStack.length === 0) return;
        this.redoStack.push(new Map(this.rwlData));
        this.rwlData = this.undoStack.pop()!;
    }

    // 恢复（Redo）
    redo(): void {
        if (this.redoStack.length === 0) return;
        this.undoStack.push(new Map(this.rwlData));
        this.rwlData = this.redoStack.pop()!;
    }

    // 记录当前状态到 Undo 栈
    private saveToUndoStack(): void {
        this.undoStack.push(new Map(this.rwlData));
    }
}

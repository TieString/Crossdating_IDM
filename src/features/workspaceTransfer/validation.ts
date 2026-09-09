import type { RwlPersistedHistorySnapshot } from "@/features/rwl/edit";

export function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`工作区包无效：${message}`);
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value);
const name = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const year = (value: unknown) => integer(value) && Math.abs(value) <= 100000;
const width = (value: unknown) => value === null || integer(value);

function tree(value: unknown) {
    check(Array.isArray(value) && value.length <= 200000, "序列数据必须为年/值数组");
    const seen = new Set();
    for (const row of value) {
        check(Array.isArray(row) && row.length === 2 && year(row[0]) && width(row[1]) && !seen.has(row[0]), "重复年份或非整数轮宽");
        seen.add(row[0]);
    }
}
function site(value: unknown) {
    check(Array.isArray(value) && value.length <= 20000, "站点数据格式错误");
    const seen = new Set();
    for (const row of value) {
        check(Array.isArray(row) && row.length === 2 && name(row[0]) && !seen.has(row[0]), "重复或无效序列编号");
        seen.add(row[0]); tree(row[1]);
    }
}
function options(value: unknown) {
    if (value === undefined) return;
    check(object(value), "精度元数据错误");
    check(value.stopMarkerValue === 999 || value.stopMarkerValue === -9999, "缺少明确工作精度");
    for (const key of ["tucsonLong", "edgeZeros", "preserveNegativeMeasurements"]) {
        check(value[key] === undefined || typeof value[key] === "boolean", "格式选项错误");
    }
    if (value.tucsonOutputMarkers !== undefined) {
        check(object(value.tucsonOutputMarkers) && Object.values(value.tucsonOutputMarkers).every((v) => v === 999 || v === -9999), "混合精度错误");
    }
}
function markers(value: unknown, deletionCounter: number) {
    check(Array.isArray(value), "删除标记缺失");
    const seen = new Set();
    for (const row of value) {
        check(Array.isArray(row) && row.length === 2 && year(row[0]) && !seen.has(row[0]) && Array.isArray(row[1]), "删除标记位置错误");
        seen.add(row[0]);
        for (const info of row[1]) {
            check(object(info) && width(info.deletedWidth), "被删除轮宽错误");
            check(info.mode === undefined || ["direct", "left", "right", "both"].includes(String(info.mode)), "删除模式错误");
            check(info.shiftSide === undefined || ["left", "right"].includes(String(info.shiftSide)), "删除方向错误");
            check(info.deleteOrder === undefined || (integer(info.deleteOrder) && info.deleteOrder >= 0 && info.deleteOrder < deletionCounter), "删除计数器错误");
            for (const field of ["leftContribution", "rightContribution"]) check(info[field] === undefined || integer(info[field]), "删除分配值错误");
            check(info.operationGroupId === undefined || name(info.operationGroupId), "删除批次错误");
        }
    }
}

function operation(value: unknown) {
    check(object(value) && typeof value.type === "string", "操作缺失");
    const types = ["insert-missing", "move-selection", "move-series-batch", "delete-year", "delete-year-range", "mark-missing-range",
        "restore-deletion", "remove-deletion-marker", "delete-series", "change-width", "replace-tree-data", "replace-all-data"];
    check(types.includes(value.type), "未知操作类型");
    if (!["replace-all-data", "move-series-batch"].includes(value.type)) check(name(value.tree), "操作序列编号错误");
    for (const field of ["year", "selectedStartYear", "selectedEndYear", "startYear", "endYear", "markerYear", "yearOffset"]) {
        check(value[field] === undefined || year(value[field]), "操作年份/位移错误");
    }
    const required: Record<string, string[]> = { "insert-missing": ["year"], "change-width": ["year"], "delete-year": ["year"],
        "move-selection": ["selectedStartYear", "selectedEndYear", "yearOffset"], "delete-year-range": ["startYear", "endYear"],
        "mark-missing-range": ["startYear", "endYear"], "restore-deletion": ["markerYear", "index"], "remove-deletion-marker": ["markerYear", "index"] };
    for (const field of required[value.type] ?? []) check(integer(value[field]), "操作参数缺失");
    check(value.index === undefined || (integer(value.index) && value.index >= 0), "标记索引错误");
    check(value.markerCount === undefined || (integer(value.markerCount) && value.markerCount > 0), "标记数量错误");
    check(value.treeCount === undefined || (integer(value.treeCount) && value.treeCount >= 0), "序列数量错误");
    if (value.type === "change-width") check(width(value.width), "修改轮宽错误");
    if (value.type === "insert-missing") check(value.side === "left" || value.side === "right", "插入方向错误");
    if (value.type === "delete-year") {
        check(["direct", "left", "right", "both"].includes(String(value.mode)), "删除模式错误");
        check(value.shift === undefined || value.shift === "left" || value.shift === "right", "删除方向错误");
    }
    if (value.type === "delete-year-range") check(["left", "right", "missing"].includes(String(value.fill)), "区间补位错误");
    if (value.type === "move-series-batch") {
        check(Array.isArray(value.moves), "批量移动数据错误");
        for (const move of value.moves) {
            check(object(move) && name(move.tree) && year(move.selectedStartYear) && year(move.selectedEndYear) && year(move.yearOffset), "批量移动参数错误");
        }
    }
    if (value.treeKeyMap !== undefined) check(Array.isArray(value.treeKeyMap) && value.treeKeyMap.every((row) => Array.isArray(row)
        && row.length === 2 && name(row[0]) && name(row[1])), "改名映射错误");
}

export function validateHistory(value: unknown): asserts value is RwlPersistedHistorySnapshot {
    check(object(value) && value.version === 1, "不支持的快照版本");
    site(value.workingData); site(value.rawData);
    check(object(value.comparisonBaseline), "缺少原始对比基线");
    site(value.comparisonBaseline.data);
    for (const format of [value.format, value.rawFormat, value.comparisonBaseline.format]) check(format === "tucson", "迁移暂仅支持Tucson RWL");
    check(["initial", "legacy-snapshot"].includes(String(value.comparisonBaseline.provenance)), "基线来源错误");
    options(value.readOptions); options(value.rawReadOptions); options(value.comparisonBaseline.readOptions);
    check(object(value.readOptions) && object(value.rawReadOptions) && object(value.comparisonBaseline.readOptions), "精度缺失");
    check(integer(value.operationLogCounter) && value.operationLogCounter >= 0 && integer(value.deletionOrderCounter) && value.deletionOrderCounter >= 0, "历史计数器错误");
    check(Array.isArray(value.deletionMarkers), "删除标记格式错误");
    const seenMarkers = new Set();
    for (const row of value.deletionMarkers) {
        check(Array.isArray(row) && row.length === 2 && name(row[0]) && !seenMarkers.has(row[0]), "删除标记序列错误");
        seenMarkers.add(row[0]); markers(row[1], value.deletionOrderCounter);
    }
    check(Array.isArray(value.operationLogBySeries), "完整操作日志缺失");
    const ids = new Set(), sequences = new Set(), groups = new Set();
    for (const group of value.operationLogBySeries) {
        check(Array.isArray(group) && group.length === 2 && name(group[0]) && !groups.has(group[0]) && Array.isArray(group[1]), "日志分组错误");
        groups.add(group[0]);
        for (const entry of group[1]) {
            check(object(entry) && name(entry.id) && !ids.has(entry.id) && integer(entry.sequence) && entry.sequence > 0
                && entry.sequence <= value.operationLogCounter && !sequences.has(entry.sequence), "重复日志或日志计数器错误");
            ids.add(entry.id); sequences.add(entry.sequence);
            check(entry.tree === group[0] && entry.action === "apply" && typeof entry.summary === "string" && typeof entry.detail === "string", "日志身份错误");
            check(typeof entry.timestamp === "string" && integer(entry.undoDepth) && integer(entry.redoDepth), "日志元数据错误");
            for (const key of ["targetYear", "oldYear", "newYear"]) check(entry[key] === undefined || year(entry[key]), "日志年份错误");
            for (const key of ["oldValue", "newValue"]) check(entry[key] === undefined || width(entry[key]), "日志轮宽错误");
            for (const key of ["reason", "operationType", "createdAt", "parentOperationId", "batchId", "operationId", "projectId", "seriesId"])
                check(entry[key] === undefined || typeof entry[key] === "string", "日志文本字段错误");
            if (entry.affectedRange !== undefined) check(object(entry.affectedRange) && year(entry.affectedRange.startYear)
                && year(entry.affectedRange.endYear), "日志范围错误");
            for (const key of ["metricsBefore", "metricsAfter", "cofechaBefore", "cofechaAfter"]) {
                if (entry[key] !== undefined) check(object(entry[key]) && Object.values(entry[key]).every((v) => v === null
                    || typeof v === "string" || (typeof v === "number" && Number.isFinite(v))), "日志指标错误");
            }
            for (const flag of ["undone", "isApplied", "isReverted"]) check(entry[flag] === undefined || typeof entry[flag] === "boolean", "日志状态错误");
            operation(entry.operation);
            for (const field of ["beforeTreeData", "afterTreeData"]) { if (entry[field] !== null) tree(entry[field]); }
            for (const field of ["beforeDeletionMarkers", "afterDeletionMarkers"]) markers(entry[field], value.deletionOrderCounter);
        }
    }
}

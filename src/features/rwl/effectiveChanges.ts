import { t, localizeMessage, getLocale, type Locale } from '@/i18n/core';
import type { RwlOperationLogEntry, RwlPersistedHistorySnapshot, SerializedRwlTreeData } from "./edit";
import { buildRwlDisplayUnits, displayUnitFor, physicalUnit, unitLabel } from "./displayUnits";

export type EffectiveChange = { series: string; type: string; original: string; current: string;
    oldValue: string; newValue: string; shift: string; unit: string; note: string };
type Ring = { origin?: number; initial?: number | null; year?: number; value: number | null;
    move: number; removed?: string };
type Core = { originalId: string; id: string; rings: Ring[]; uncertain: boolean; unit: string };
const ordered = (entries: SerializedRwlTreeData | null | undefined, marker: number) =>
    (entries ?? []).filter(([, value]) => value !== marker).sort(([a], [b]) => a - b);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const range = (years: number[]) => !years.length ? "" : years.length === 1 ? String(years[0]) : `${Math.min(...years)}–${Math.max(...years)}`;
const text = (value: number | null | undefined) => value === undefined ? "" : value === null ? "缺测" : String(value);

/** Replay ring identities, then compare final identity state with the persistent
 * baseline. Ambiguous replacements become one explicit range diff, never a
 * cascade of guessed width edits at shifted calendar years.
 */
export function effectiveChanges(snapshot: RwlPersistedHistorySnapshot): EffectiveChange[] {
    const baseline = snapshot.comparisonBaseline;
    if (!baseline || !snapshot.workingData) throw new Error("缺少持久化原始对比基线");
    const marker = snapshot.readOptions?.stopMarkerValue ?? -9999;
    const baseMarker = baseline.readOptions?.stopMarkerValue ?? marker;
    const unit = marker === 999 ? "0.01 mm" : "0.001 mm";
    const originals = new Map(baseline.data);
    const current = new Map(snapshot.workingData);
    const beforeUnits = buildRwlDisplayUnits(new Map(baseline.data.map(([id,rows]) => [id,new Map(rows)])), baseline.readOptions);
    const afterUnits = buildRwlDisplayUnits(new Map(snapshot.workingData.map(([id,rows]) => [id,new Map(rows)])), snapshot.readOptions);
    const cores = new Map<string, Core>();
    for (const [id, entries] of originals) cores.set(id, { originalId: id, id, unit, uncertain: marker !== baseMarker,
        rings: ordered(entries, baseMarker).map(([year, value]) => ({ origin: year, initial: value, year, value, move: 0 })) });
    const logs = (snapshot.operationLogBySeries?.flatMap(([, entries]) => entries) ?? snapshot.operationLog ?? [])
        .filter((entry) => !(entry.isReverted ?? entry.undone) && entry.isApplied !== false)
        .sort((a, b) => a.sequence - b.sequence);
    const retired = new Map<string, Core>();
    const unknown = (core: Core, entry: RwlOperationLogEntry) => {
        core.uncertain = true;
        core.rings = ordered(entry.afterTreeData, marker).map(([year, value]) => ({ year, value, move: 0 }));
    };
    for (const entry of logs) {
        const id = entry.tree ?? entry.seriesId;
        const op = entry.operation;
        if (!id || !op) continue;
        let core = cores.get(id);
        if (!core && op.type === "replace-all-data" && entry.beforeTreeData === null) {
            const from = op.treeKeyMap?.find(([old, next]) => old !== next && next === id)?.[0];
            const renamed = from ? retired.get(from) ?? cores.get(from) : undefined;
            if (renamed && same(ordered(entry.afterTreeData, marker),
                renamed.rings.filter((r) => r.year !== undefined).map((r) => [r.year, r.value]).sort(([a], [b]) => Number(a) - Number(b)))) {
                core = renamed; core.id = id; if (from) { retired.delete(from); cores.delete(from); }
            }
        }
        if (!core) { core = { originalId: id, id, unit, uncertain: entry.beforeTreeData !== null, rings: [] }; }
        cores.set(id, core);
        if (op.type === "replace-all-data" && entry.afterTreeData === null
            && op.treeKeyMap?.some(([old, next]) => old === id && old !== next)) {
            retired.set(id, core); cores.delete(id); continue;
        }
        if (core.uncertain) { unknown(core, entry); continue; }
        const live = () => core!.rings.filter((ring) => ring.year !== undefined);
        const before = live().map((ring): [number, number | null] => [ring.year!, ring.value]).sort(([a], [b]) => a - b);
        if (!same(before, ordered(entry.beforeTreeData, marker))) {
            // A recognized rename's addition record has no prior tree.
            if (!(op.type === "replace-all-data" && entry.beforeTreeData === null && core.id !== core.originalId)) unknown(core, entry);
            continue;
        }
        const move = (first: number, last: number, delta: number, explicit: boolean) => {
            for (const ring of live()) if (ring.year! >= first && ring.year! <= last) {
                ring.year! += delta; if (explicit) ring.move += delta;
            }
        };
        const removeYear = (year: number, shift: "left" | "right", reason: string) => {
            for (const ring of live()) if (ring.year === year) { ring.year = undefined; ring.removed = reason; }
            if (shift === "right") move(-Infinity, year - 1, 1, false);
            else move(year + 1, Infinity, -1, false);
        };
        switch (op.type) {
            case "insert-missing":
                if (op.side === "right") move(-Infinity, op.year, -1, false);
                else move(op.year, Infinity, 1, false);
                core.rings.push({ year: op.year, value: 0, move: 0 }); break;
            case "delete-year": removeYear(op.year, op.shift ?? "right", "删除伪轮/轮宽"); break;
            case "delete-year-range": {
                const first = Math.min(op.startYear, op.endYear), last = Math.max(op.startYear, op.endYear);
                if (op.fill === "missing") {
                    live().filter((r) => r.year! >= first && r.year! <= last).forEach((r) => { r.year = undefined; r.removed = "缺测标记"; });
                } else for (let i = first; i <= last; i++) removeYear(op.fill === "left" ? last : first,
                    op.fill === "left" ? "right" : "left", "删除区间");
                break;
            }
            case "mark-missing-range":
                live().filter((r) => r.year! >= Math.min(op.startYear, op.endYear) && r.year! <= Math.max(op.startYear, op.endYear))
                    .forEach((r) => { r.year = undefined; r.removed = "缺测标记"; }); break;
            case "move-selection": move(Math.min(op.selectedStartYear, op.selectedEndYear), Math.max(op.selectedStartYear, op.selectedEndYear), op.yearOffset, true); break;
            case "move-series-batch":
                for (const m of op.moves.filter((m) => m.tree === id)) move(m.selectedStartYear, m.selectedEndYear, m.yearOffset, true); break;
            case "change-width": break;
            case "delete-series": core.rings.forEach((r) => { r.year = undefined; }); break;
            case "remove-deletion-marker": break;
            case "replace-all-data":
                if (entry.beforeTreeData === null) { core.rings = ordered(entry.afterTreeData, marker).map(([year, value]) => ({ year, value, move: 0 })); break; }
                if (entry.afterTreeData === null) { core.rings.forEach((r) => { r.year = undefined; }); break; }
                if (!same(before, ordered(entry.afterTreeData, marker))) unknown(core, entry);
                break;
            default: unknown(core, entry);
        }
        if (core.uncertain) continue;
        const after = new Map(ordered(entry.afterTreeData, marker));
        if (!same(live().map((r) => r.year!).sort((a, b) => a - b), [...after.keys()])) { unknown(core, entry); continue; }
        for (const ring of live()) {
            const value = after.get(ring.year!)!;
            if (value !== ring.value && op.type !== "change-width" && op.type !== "delete-year") { core.uncertain = true; break; }
            ring.value = value;
        }
    }
    for (const [id, core] of retired) if (!cores.has(id)) cores.set(id, core);
    for (const id of current.keys()) if (!cores.has(id)) cores.set(id, { id, originalId: id, rings: [], unit, uncertain: true });
    const output: EffectiveChange[] = [];
    for (const core of cores.values()) {
        const base = ordered(originals.get(core.originalId), baseMarker);
        const now = ordered(current.get(core.id), marker);
        if (same(base, now) && core.id === core.originalId && marker === baseMarker) continue;
        const add = (type: string, original = "", present = "", oldValue = "", newValue = "", shift = "", note = "") => {
            let rowUnit = core.unit;
            const numeric = (s: string) => s !== "" && Number.isFinite(Number(s));
            if ((numeric(oldValue) || numeric(newValue)) && (!original || numeric(original)) && (!present || numeric(present))) {
                const oldUnit = displayUnitFor(beforeUnits, core.originalId, Number(original));
                const newUnit = displayUnitFor(afterUnits, core.id, Number(present));
                const target = !oldValue ? newUnit.marker : !newValue ? oldUnit.marker
                    : oldUnit.marker === newUnit.marker ? oldUnit.marker : marker;
                if (numeric(oldValue)) oldValue = String(Number(oldValue) / (physicalUnit(target) / physicalUnit(baseMarker)));
                if (numeric(newValue)) newValue = String(Number(newValue) / (physicalUnit(target) / physicalUnit(marker)));
                rowUnit = unitLabel(target);
            }
            output.push({ series: core.id, type, original, current: present, oldValue, newValue, shift, unit: rowUnit, note });
        };
        const blocks = (type: string, oldEntries: SerializedRwlTreeData, newEntries: SerializedRwlTreeData, note = "") => {
            const count = Math.max(1, Math.ceil(Math.max(oldEntries.length, newEntries.length) / 200));
            for (let i = 0; i < count; i++) {
                const before = oldEntries.slice(i * 200, i * 200 + 200), after = newEntries.slice(i * 200, i * 200 + 200);
                add(type, range(before.map(([y]) => y)), range(after.map(([y]) => y)), JSON.stringify(before), JSON.stringify(after), "",
                    note + (count > 1 ? ` 分块${i + 1}/${count}（仅分块展示，不表示逐项年轮对应）。` : ""));
            }
        };
        if (!originals.has(core.originalId)) { if (current.has(core.id)) blocks("序列新增", [], now); continue; }
        if (!current.has(core.id)) { blocks("序列删除", base, []); continue; }
        if (core.id !== core.originalId) add("序列改名", core.originalId, core.id);
        const mapped = core.rings.filter((r) => r.year !== undefined).map((r) => [r.year, r.value]).sort(([a], [b]) => Number(a) - Number(b));
        if (core.uncertain || !same(mapped, now)) {
            blocks("区间差异（需复核）", base, now,
                `日志不足或包含无法可靠归因的整段替换；未推断事件类型。原单位${baseMarker === 999 ? "0.01" : "0.001"} mm。`);
            continue;
        }
        for (const ring of core.rings) {
            if (ring.origin === undefined && ring.year !== undefined) add(ring.value === 0 ? "插入缺轮" : "插入轮宽", "", String(ring.year), "", text(ring.value));
            else if (ring.origin !== undefined && ring.year === undefined) add(ring.removed ?? "删除轮宽", String(ring.origin), "", text(ring.initial));
            else if (ring.origin !== undefined && ring.year !== undefined && ring.initial !== ring.value)
                add(ring.value === null ? "缺测标记" : "轮宽修改", String(ring.origin), String(ring.year), text(ring.initial), text(ring.value));
        }
        const survivors = core.rings.filter((r) => r.origin !== undefined && r.year !== undefined);
        const moving = survivors.filter((r) => r.move !== 0).sort((a, b) => a.origin! - b.origin!);
        const groups: Ring[][] = [];
        for (const ring of moving) {
            const last = groups[groups.length - 1];
            const previous = last?.[last.length - 1];
            if (previous && previous.move === ring.move && previous.origin! + 1 === ring.origin && previous.year! + 1 === ring.year) last.push(ring);
            else groups.push([ring]);
        }
        for (const group of groups) add(group.length === survivors.length ? "整体年份移动" : "局部年份移动",
            range(group.map((r) => r.origin!)), range(group.map((r) => r.year!)), "", "", String(group[0].move), "按同一批年轮合并显式净位移；插删产生的附带年份变化不另算移动。");
    }
    if (baseline.provenance === "legacy-snapshot") output.unshift({ series: "", type: "基线说明", original: "", current: "", oldValue: "", newValue: "", shift: "", unit: "", note: "旧版快照仅能使用其中保留的原始基线；此前已被重置或截断的历史无法补回。" });
    return output.sort((a, b) => a.series.localeCompare(b.series, "zh-CN", { numeric: true }));
}

export function effectiveChangesCsv(snapshot: RwlPersistedHistorySnapshot, locale: Locale = getLocale()): string {
    const quote = (value: string) => `"${(/^[=+@\t\r]/.test(value) || /^-[^\d]/.test(value) ? "'" : "") + value.replace(/"/g, '""')}"`;
    // Notes can append a block descriptor. Localize those app-owned sentences
    // independently; do not apply replacements to series IDs or numeric payloads.
    const note = (value: string) => value.split(/(?= 分块\d+\/\d+（)/)
        .map((part) => localizeMessage(part, locale)).join(" ");
    const rows = effectiveChanges(snapshot).map((row) => [row.series, localizeMessage(row.type, locale), row.original, row.current, row.oldValue, row.newValue, row.shift, row.unit, note(row.note)]);
    return "\uFEFF" + [["序列编号", "修改类型", "原年份/范围", "现年份/范围", "原值", "现值", "位移量", "单位", "说明"].map((label) => t(label, [], locale)), ...rows]
        .map((row) => row.map(quote).join(",")).join("\r\n") + "\r\n";
}

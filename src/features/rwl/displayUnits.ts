import type { RwlReadResult, RwlSiteData } from "./types";

export type DisplayUnit = { marker: number; multiplier: number };
export type RwlDisplayUnits = { workingMarker: number; series: Record<string, {
    fallback: DisplayUnit;
    ranges: Array<DisplayUnit & { start: number; end: number }>;
}> };
export const unitLabel = (marker: number) => marker === 999 ? "0.01 mm" : "0.001 mm";
export const physicalUnit = (marker: number) => marker === 999 ? 0.01 : 0.001;

/** Same source-precision decision as the serializer; unmatched mixed segments
 * use explicit working units rather than guessing a ring's provenance. */
export function segmentOutputMarker(id: string, start: number, end: number,
    values: readonly (number | null)[], options: RwlReadResult["readOptions"], workingMarker: number) {
    const source = options?.tucsonSegments?.find(s => s.id === id && s.startYear === start && s.endYear === end);
    const sourceMarker = source?.marker ?? options?.tucsonOutputMarkers?.[id] ?? workingMarker;
    return workingMarker === -9999 && sourceMarker === 999 && values.every(v => v === null || v % 10 === 0)
        ? 999 : workingMarker;
}

export function buildRwlDisplayUnits(data: RwlSiteData, options: RwlReadResult["readOptions"]): RwlDisplayUnits {
    const workingMarker = options?.stopMarkerValue ?? ([...data.values()].some(t => [...t.values()].includes(-9999)) ? -9999 : 999);
    const series: RwlDisplayUnits["series"] = Object.create(null);
    const unit = (marker: number): DisplayUnit => ({ marker, multiplier: physicalUnit(marker) / physicalUnit(workingMarker) });
    for (const [id, tree] of data) {
        const ranges: RwlDisplayUnits["series"][string]["ranges"] = [];
        let entries: Array<[number, number | null]> = [];
        const flush = () => {
            if (!entries.length) return;
            const start = entries[0][0], end = entries[entries.length - 1][0];
            const marker = segmentOutputMarker(id, start, end, entries.map(([,v]) => v), options, workingMarker);
            ranges.push({ start, end: end + 1, ...unit(marker) }); // includes the display terminator
            entries = [];
        };
        for (const [year,value] of [...tree].sort(([a],[b]) => a-b)) {
            if (value === workingMarker || value === null) { flush(); continue; }
            if (entries.length && year !== entries[entries.length - 1][0] + 1) flush();
            entries.push([year,value]);
        }
        flush();
        const source = options?.tucsonOutputMarkers?.[id] ?? workingMarker;
        series[id] = { fallback: unit(source), ranges };
    }
    return { workingMarker, series };
}

export function displayUnitFor(units: RwlDisplayUnits | undefined, tree: string, year: number): DisplayUnit {
    const series = units && Object.prototype.hasOwnProperty.call(units.series,tree) ? units.series[tree] : undefined;
    return series?.ranges.find(r => r.start <= year && year <= r.end) ?? series?.fallback
        ?? { marker: units?.workingMarker ?? -9999, multiplier: 1 };
}
export function displayWidth(value: number | null, unit: DisplayUnit, workingMarker: number): number | null {
    return value === null ? null : value === workingMarker ? unit.marker : value / unit.multiplier;
}
export function workingWidth(value: number | null, unit: DisplayUnit): number | null {
    if (value === null) return null;
    const scaled = value * unit.multiplier, rounded = Math.round(scaled);
    if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-7 || value < 0) {
        throw new Error("请输入可精确表示的非负轮宽数值（最小单位为当前工作精度）。");
    }
    return rounded;
}

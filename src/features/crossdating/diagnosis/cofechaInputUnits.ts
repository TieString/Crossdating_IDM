import { splitCofecha606SeriesSegments } from "cofecha-js";
import type { RwlSiteData } from "../../rwl/types";

/** In-memory physical-unit normalization, including mixed-precision RWL files.
 * Keep original files unchanged; 999-terminated widths are 0.01 mm, -9999 widths
 * are 0.001 mm. Normalized maps always use 0.001 mm and explicit -9999 markers.
 */
export const normalizeCofechaInputUnits = (source: RwlSiteData): RwlSiteData => {
    const result: RwlSiteData = new Map();
    for (const segment of splitCofecha606SeriesSegments(source)) {
        const tree = result.get(segment.seriesId) ?? new Map<number, number | null>();
        const scale = segment.stopMarkerValue === 999 ? 10 : 1;
        for (const [year, width] of segment.data) if (width !== null) tree.set(year, width * scale);
        const end = Math.max(...segment.data.keys());
        if (Number.isFinite(end)) tree.set(end + 1, -9999);
        result.set(segment.seriesId, tree);
    }
    return result;
};

/** Runtime edits can remove a terminator. Carry the file's known precision
 * instead of letting an unterminated target silently default to 0.01 mm.
 * An explicit -9999 still identifies a higher-precision core. In a declared
 * -9999 file, an endpoint width of 999 is a measurement, not a terminator.
 */
export const normalizeCofechaRuntimeUnits = (source: RwlSiteData, defaultStopMarker: number): RwlSiteData => {
    if (defaultStopMarker !== 999 && defaultStopMarker !== -9999) throw new Error("Unknown RWL source precision");
    const marked: RwlSiteData = new Map();
    for (const [id, tree] of source) {
        const entries = [...tree].sort(([a], [b]) => a - b);
        if (!entries.length) { marked.set(id, new Map()); continue; }
        const last = entries[entries.length - 1]!;
        const marker = last[1] === -9999 ? -9999 : defaultStopMarker;
        if (last[1] !== marker) entries.push([last[0] + 1, marker]);
        if (marker === -9999) {
            for (let index = entries.length - 2; index >= 0; index--) {
                const entry = entries[index]!;
                if (entry[1] !== null && entry[1] !== -9999 && entries[index + 1]![0] > entry[0] + 1) {
                    entries.splice(index + 1, 0, [entry[0] + 1, -9999]);
                }
            }
        }
        marked.set(id, new Map(entries));
    }
    return normalizeCofechaInputUnits(marked);
};

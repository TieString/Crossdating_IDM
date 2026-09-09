import { parseRwl } from "cofecha-js";
import { formatTucson } from "@/features/rwl/parsers/tucson";

/** Normalize only the EXE transport copy, never the user's original file. */
export function normalizeOfficialCofechaInput(text: string): string {
    const parsed = parseRwl(text);
    const segments = parsed.segments ?? [];
    const needsNormalization = new Set(segments.map(s => s.marker)).size > 1
        || segments.some(s => s.marker === 999 && s.entries.some(([, v]) => v === 999));
    if (!needsNormalization) return text;
    return formatTucson(parsed.data, parsed.longFormat, undefined, { stopMarkerValue: parsed.stopMarker });
}

import {
    deleteYearWithMode,
    insertMissingYearAtSide,
} from "@/features/rwl/edit";
import type { RwlTreeData } from "@/features/rwl/types";

export type CurrentEventRrfRebuild = {
    data: RwlTreeData;
    removedExistingZeroYears: number[];
    confirmedYears: number[];
};

/** Reproduce the frozen RRF session state before one audited workspace edit. */
export const rebuildCurrentEventRrfTree = (
    source: RwlTreeData,
    requestedConfirmedYears: readonly number[],
): CurrentEventRrfRebuild => {
    const confirmedYears = Array.from(new Set(requestedConfirmedYears)).sort((a, b) => b - a);
    if (confirmedYears.length === 0 || confirmedYears.length > 6) {
        throw new RangeError("RRF rebuild requires 1..6 unique confirmed years");
    }

    const removedExistingZeroYears = Array.from(source.entries())
        .filter(([, width]) => width === 0)
        .map(([year]) => year)
        .sort((a, b) => a - b);
    let data = new Map(source);
    removedExistingZeroYears.forEach((year) => {
        data = deleteYearWithMode(data, year, "direct", "right");
    });
    confirmedYears.forEach((year) => {
        if (!data.has(year) || data.get(year) === 0) {
            throw new RangeError(`confirmed RRF year ${year} cannot be rebuilt`);
        }
        data = insertMissingYearAtSide(data, year, "right");
    });
    return { data, removedExistingZeroYears, confirmedYears };
};

export type WholeSeriesMoveDirection = "older" | "newer";

export interface ManualSeriesMovePlan {
    selectedStartYear: number;
    selectedEndYear: number;
    yearOffset: number;
}

export interface ManualMoveShiftTarget {
    sourceYear: number;
    targetYear: number;
}

export interface ManualMoveSelection {
    tree: string;
    startYear: number;
    endYear: number;
}

export interface ManualMoveHistory {
    tree: string;
    selectedStartYear: number;
    selectedEndYear: number;
    yearOffset: number;
    direction: "undo" | "redo";
}

const isValidYearCount = (yearCount: number): boolean => (
    Number.isInteger(yearCount) && yearCount > 0
);

export function createWholeSeriesMovePlan(
    seriesStartYear: number,
    seriesEndYear: number,
    direction: WholeSeriesMoveDirection,
    yearCount: number,
): ManualSeriesMovePlan | null {
    if (!Number.isInteger(seriesStartYear)
        || !Number.isInteger(seriesEndYear)
        || seriesStartYear > seriesEndYear
        || !isValidYearCount(yearCount)) {
        return null;
    }

    return {
        selectedStartYear: seriesStartYear,
        selectedEndYear: seriesEndYear,
        yearOffset: direction === "older" ? -yearCount : yearCount,
    };
}

export function createOlderSidePartialMovePlan(
    seriesStartYear: number,
    seriesEndYear: number,
    firstFixedYear: number,
    yearCount: number,
): ManualSeriesMovePlan | null {
    if (!Number.isInteger(seriesStartYear)
        || !Number.isInteger(seriesEndYear)
        || !Number.isInteger(firstFixedYear)
        || seriesStartYear > seriesEndYear
        || firstFixedYear <= seriesStartYear
        || firstFixedYear > seriesEndYear
        || !isValidYearCount(yearCount)) {
        return null;
    }

    return {
        selectedStartYear: seriesStartYear,
        selectedEndYear: firstFixedYear - 1,
        yearOffset: -yearCount,
    };
}

/**
 * Maps moved cells to their final years while using an adjacent visual origin.
 *
 * The data still jumps by the complete year offset in one undoable edit.  The
 * animation origin is deliberately only one grid cell away so multi-year moves
 * reuse the single-delete row-wrap animation instead of creating one cross-row
 * ghost for every crossed column.
 */
export function createManualMoveShiftTargets(
    plan: ManualSeriesMovePlan,
    sourceYears: Iterable<number>,
): ManualMoveShiftTarget[] {
    if (plan.yearOffset === 0) return [];

    const selectedStartYear = Math.min(plan.selectedStartYear, plan.selectedEndYear);
    const selectedEndYear = Math.max(plan.selectedStartYear, plan.selectedEndYear);
    const visualStep = Math.sign(plan.yearOffset);

    return Array.from(new Set(sourceYears))
        .filter((year) => year >= selectedStartYear && year <= selectedEndYear)
        .sort((yearA, yearB) => yearA - yearB)
        .map((dataSourceYear) => {
            const targetYear = dataSourceYear + plan.yearOffset;
            return {
                sourceYear: targetYear - visualStep,
                targetYear,
            };
        });
}

export function remapSelectionForMoveHistory<T extends ManualMoveSelection>(
    selection: T | null,
    history: ManualMoveHistory,
): T | null {
    if (!selection || selection.tree !== history.tree) {
        return selection;
    }

    const sourceStart = Math.min(
        history.selectedStartYear,
        history.selectedEndYear,
    );
    const sourceEnd = Math.max(
        history.selectedStartYear,
        history.selectedEndYear,
    );
    const targetStart = sourceStart + history.yearOffset;
    const targetEnd = sourceEnd + history.yearOffset;
    const currentStart = history.direction === "undo" ? targetStart : sourceStart;
    const currentEnd = history.direction === "undo" ? targetEnd : sourceEnd;

    if (selection.startYear < currentStart || selection.endYear > currentEnd) {
        return selection;
    }

    const offset = history.direction === "undo"
        ? -history.yearOffset
        : history.yearOffset;
    return {
        ...selection,
        startYear: selection.startYear + offset,
        endYear: selection.endYear + offset,
    };
}

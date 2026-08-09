export type WholeSeriesMoveDirection = "older" | "newer";

export interface ManualSeriesMovePlan {
    selectedStartYear: number;
    selectedEndYear: number;
    yearOffset: number;
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

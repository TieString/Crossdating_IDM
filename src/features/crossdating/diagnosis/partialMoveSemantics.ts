import type { YearRange } from "./types";

export const MAX_SUPPORTED_PARTIAL_GAP_YEARS = 100;
export const DEFAULT_MAX_PARTIAL_GAP_YEARS = MAX_SUPPORTED_PARTIAL_GAP_YEARS;
export const MIN_PARTIAL_GAP_YEARS = 2;

export type PartialShiftCandidateOptions = {
    maxPartialGapYears?: number;
    lagMin?: number;
    seriesLength?: number;
    minimumSideYears?: number;
};

const finiteFloor = (value: number | undefined): number | null => (
    value !== undefined && Number.isFinite(value)
        ? Math.floor(value)
        : null
);

/**
 * Resolves the largest physically valid unmeasured block for one scan.
 * Negative lag capacity and the amount of data left on both sides are hard limits.
 */
export const getEffectiveMaxPartialGapYears = (
    options: PartialShiftCandidateOptions = {},
): number => {
    const requested = Math.max(
        0,
        Math.min(
            MAX_SUPPORTED_PARTIAL_GAP_YEARS,
            finiteFloor(options.maxPartialGapYears)
                ?? DEFAULT_MAX_PARTIAL_GAP_YEARS,
        ),
    );
    const lagCapacity = options.lagMin === undefined
        ? requested
        : Math.max(0, -Math.ceil(options.lagMin));
    const seriesLength = finiteFloor(options.seriesLength);
    const minimumSideYears = Math.max(0, finiteFloor(options.minimumSideYears) ?? 0);
    const contextCapacity = seriesLength === null
        ? requested
        : Math.max(0, seriesLength - (2 * minimumSideYears));

    return Math.min(requested, lagCapacity, contextCapacity);
};

export const getAutomaticPartialShiftCandidates = (
    options: PartialShiftCandidateOptions = {},
): number[] => {
    const maximumGap = getEffectiveMaxPartialGapYears(options);
    if (maximumGap < MIN_PARTIAL_GAP_YEARS) return [];
    return Array.from(
        { length: maximumGap - MIN_PARTIAL_GAP_YEARS + 1 },
        (_, index) => -(index + MIN_PARTIAL_GAP_YEARS),
    );
};

/** Missing and false rings retain their dedicated one-year operations. */
export const getAutomaticEventShiftCandidates = (
    options: PartialShiftCandidateOptions = {},
): number[] => [
    -1,
    1,
    ...getAutomaticPartialShiftCandidates(options),
];

export const isNegativePartialShift = (shiftYears: number | undefined): shiftYears is number => (
    Number.isInteger(shiftYears) && (shiftYears ?? 0) <= -MIN_PARTIAL_GAP_YEARS
);

export const isAutomaticPartialShift = (
    shiftYears: number | undefined,
    options: PartialShiftCandidateOptions = {},
): shiftYears is number => (
    isNegativePartialShift(shiftYears)
    && Math.abs(shiftYears) <= getEffectiveMaxPartialGapYears(options)
);

export const firstFixedYearFromLastMovedYear = (lastMovedYear: number): number => (
    lastMovedYear + 1
);

export const lastMovedYearFromFirstFixedYear = (firstFixedYear: number): number => (
    firstFixedYear - 1
);

export type PartialMoveBreakpoint = {
    firstFixedYear: number;
    lastMovedYear: number;
    movedRange: YearRange;
    fixedRange: YearRange;
    missingRange: YearRange;
};

/**
 * Converts the public first-fixed breakpoint into the exact editor ranges.
 * The returned gap is the calendar interval left empty by a negative move.
 */
export const partialMoveBreakpoint = (
    firstFixedYear: number,
    seriesStartYear: number,
    seriesEndYear: number,
    shiftYears: number,
): PartialMoveBreakpoint | null => {
    if (!Number.isInteger(firstFixedYear)
        || !Number.isInteger(seriesStartYear)
        || !Number.isInteger(seriesEndYear)
        || !isNegativePartialShift(shiftYears)
        || seriesStartYear >= firstFixedYear
        || firstFixedYear > seriesEndYear) {
        return null;
    }

    const lastMovedYear = lastMovedYearFromFirstFixedYear(firstFixedYear);
    return {
        firstFixedYear,
        lastMovedYear,
        movedRange: {
            startYear: seriesStartYear,
            endYear: lastMovedYear,
        },
        fixedRange: {
            startYear: firstFixedYear,
            endYear: seriesEndYear,
        },
        missingRange: {
            startYear: firstFixedYear + shiftYears,
            endYear: lastMovedYear,
        },
    };
};

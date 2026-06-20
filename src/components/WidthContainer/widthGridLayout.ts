export interface LayoutCellPosition {
    /** Zero-based visual row index. */
    rowIndex: number;
    /** Zero-based cell index inside a 10-year row. */
    cellIndex: number;
}

export const ROW_HEIGHT = 24;
export const ROW_GAP = 5;
export const VALUE_COLUMN_COUNT = 10;

/** Returns the 0-9 year offset used by Tucson decade rows. */
export const getYearOffsetWithinDecade = (year: number) => ((year % 10) + 10) % 10;

/** Returns the first year that starts a full decade row after a partial first row. */
export const getFirstRowBreakYear = (startYear: number) => {
    const offset = getYearOffsetWithinDecade(startYear);
    return offset === 0 ? startYear : startYear + (VALUE_COLUMN_COUNT - offset);
};

/** Maps an absolute year to its rendered row/cell location for a series grid. */
export const getLayoutCellPosition = (firstYear: number, year: number): LayoutCellPosition => {
    if (getYearOffsetWithinDecade(firstYear) === 0) {
        return {
            rowIndex: Math.floor((year - firstYear) / VALUE_COLUMN_COUNT),
            cellIndex: getYearOffsetWithinDecade(year),
        };
    }

    const firstRowBreakYear = getFirstRowBreakYear(firstYear);

    if (year < firstRowBreakYear) {
        return {
            rowIndex: 0,
            cellIndex: year - firstYear,
        };
    }

    return {
        rowIndex: 1 + Math.floor((year - firstRowBreakYear) / VALUE_COLUMN_COUNT),
        cellIndex: getYearOffsetWithinDecade(year),
    };
};

/** Returns the last occupied value-column index for a series first row. */
export const getFirstRowLastCellIndex = (firstYear: number) => {
    const offset = getYearOffsetWithinDecade(firstYear);
    return offset === 0 ? VALUE_COLUMN_COUNT - 1 : VALUE_COLUMN_COUNT - offset - 1;
};

/** Compares two layout cell coordinates. */
export const sameLayoutCellPosition = (a: LayoutCellPosition, b: LayoutCellPosition) => (
    a.rowIndex === b.rowIndex && a.cellIndex === b.cellIndex
);

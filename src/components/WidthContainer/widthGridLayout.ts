export interface LayoutCellPosition {
    rowIndex: number;
    cellIndex: number;
}

export const ROW_HEIGHT = 24;
export const ROW_GAP = 5;
export const VALUE_COLUMN_COUNT = 10;

export const getYearOffsetWithinDecade = (year: number) => ((year % 10) + 10) % 10;

export const getFirstRowBreakYear = (startYear: number) => {
    const offset = getYearOffsetWithinDecade(startYear);
    return offset === 0 ? startYear : startYear + (VALUE_COLUMN_COUNT - offset);
};

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

export const getFirstRowLastCellIndex = (firstYear: number) => {
    const offset = getYearOffsetWithinDecade(firstYear);
    return offset === 0 ? VALUE_COLUMN_COUNT - 1 : VALUE_COLUMN_COUNT - offset - 1;
};

export const sameLayoutCellPosition = (a: LayoutCellPosition, b: LayoutCellPosition) => (
    a.rowIndex === b.rowIndex && a.cellIndex === b.cellIndex
);

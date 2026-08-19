export type ChartJumpTarget = {
    id: number;
    tree: string;
    year: number;
    /** When present, the jump also requests a preview of this diagnosis event at `year`. */
    diagnosisPreviewEventId?: string;
};

export type ChartViewport = {
    min: number;
    max: number;
};

export type CalendarChartViewport = {
    minYear: number;
    maxYear: number;
};

export const DEFAULT_CHART_JUMP_SPAN = 50;

function categoryIndexToCalendarYear(index: number, years: readonly number[]): number | null {
    if (!Number.isFinite(index) || years.length === 0) return null;
    const bounded = Math.max(0, Math.min(years.length - 1, index));
    const lowerIndex = Math.floor(bounded);
    const upperIndex = Math.ceil(bounded);
    const lowerYear = years[lowerIndex];
    const upperYear = years[upperIndex];
    if (lowerIndex === upperIndex || upperYear === lowerYear) return lowerYear;
    return lowerYear + (upperYear - lowerYear) * (bounded - lowerIndex);
}

function calendarYearToCategoryIndex(year: number, years: readonly number[]): number | null {
    if (!Number.isFinite(year) || years.length === 0) return null;
    if (year <= years[0]) return 0;
    if (year >= years[years.length - 1]) return years.length - 1;

    let lowerIndex = 0;
    let upperIndex = years.length - 1;
    while (upperIndex - lowerIndex > 1) {
        const middleIndex = Math.floor((lowerIndex + upperIndex) / 2);
        if (years[middleIndex] <= year) {
            lowerIndex = middleIndex;
        } else {
            upperIndex = middleIndex;
        }
    }

    const lowerYear = years[lowerIndex];
    const upperYear = years[upperIndex];
    if (upperYear === lowerYear) return lowerIndex;
    return lowerIndex + (year - lowerYear) / (upperYear - lowerYear);
}

export function categoryViewportToCalendarViewport(
    viewport: ChartViewport,
    years: readonly number[],
): CalendarChartViewport | null {
    const minYear = categoryIndexToCalendarYear(viewport.min, years);
    const maxYear = categoryIndexToCalendarYear(viewport.max, years);
    return minYear === null || maxYear === null ? null : { minYear, maxYear };
}

export function calendarViewportToCategoryViewport(
    viewport: CalendarChartViewport,
    years: readonly number[],
): ChartViewport | null {
    const min = calendarYearToCategoryIndex(viewport.minYear, years);
    const max = calendarYearToCategoryIndex(viewport.maxYear, years);
    return min === null || max === null ? null : { min, max };
}

/**
 * Returns a CategoryScale index window centred on a calendar year.
 * Chart.js stores category-axis zoom bounds as label indexes rather than label values.
 */
export function centerChartViewportOnYear(
    year: number,
    years: readonly number[],
    defaultSpan = DEFAULT_CHART_JUMP_SPAN,
): ChartViewport | null {
    if (!Number.isFinite(year) || years.length === 0) {
        return null;
    }

    let targetIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    years.forEach((candidate, index) => {
        const distance = Math.abs(candidate - year);
        if (distance < closestDistance) {
            targetIndex = index;
            closestDistance = distance;
        }
    });

    const availableSpan = years.length - 1;
    if (availableSpan <= 0) {
        return { min: 0, max: 0 };
    }

    const span = Math.min(Math.max(1, defaultSpan), availableSpan);
    let min = targetIndex - span / 2;
    let max = min + span;

    if (min < 0) {
        min = 0;
        max = span;
    }
    if (max > availableSpan) {
        max = availableSpan;
        min = availableSpan - span;
    }

    return { min, max };
}

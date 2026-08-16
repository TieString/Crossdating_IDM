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

export const DEFAULT_CHART_JUMP_SPAN = 50;

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

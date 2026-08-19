export interface PositionedSeriesBounds {
    top: number;
    bottom: number;
}

export interface VisibleSeriesRange {
    startIndex: number;
    endIndex: number;
}

const findVisibleStartIndex = (series: readonly PositionedSeriesBounds[], start: number) => {
    let low = 0;
    let high = series.length - 1;
    let answer = series.length;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (series[mid].bottom >= start) {
            answer = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }
    return Math.max(0, answer);
};

const findVisibleEndIndex = (series: readonly PositionedSeriesBounds[], end: number) => {
    let low = 0;
    let high = series.length - 1;
    let answer = -1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (series[mid].top <= end) {
            answer = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return answer;
};

export function getVisibleSeriesRange(
    series: readonly PositionedSeriesBounds[],
    scrollTop: number,
    viewportHeight: number,
    overscan: number,
): VisibleSeriesRange {
    if (series.length === 0) return { startIndex: 0, endIndex: -1 };
    const start = Math.max(0, scrollTop - overscan);
    const effectiveHeight = viewportHeight || 800;
    const end = scrollTop + effectiveHeight + overscan;
    return {
        startIndex: findVisibleStartIndex(series, start),
        endIndex: findVisibleEndIndex(series, end),
    };
}

export const sameVisibleSeriesRange = (
    left: VisibleSeriesRange,
    right: VisibleSeriesRange,
) => left.startIndex === right.startIndex && left.endIndex === right.endIndex;

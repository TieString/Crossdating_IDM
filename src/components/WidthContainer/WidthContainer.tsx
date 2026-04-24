import { memo, ReactNode, RefObject, useCallback, useEffect, useMemo, useState } from 'react';
import { RwlSiteData } from '@/features/rwl';
import WidthGrid from './WidthGrid/WidthGrid';
import style from "./WidthContainer.module.css";
import { stopMarker } from '@/shared/constants';

interface YearCell {
    year: number;
    width?: number | null;
    isInterruptPad?: boolean;
}

interface SeriesRow {
    startYear: number;
    cells: Array<YearCell | null>;
}

interface VirtualRow extends SeriesRow {
    treeCode: string;
}

interface VirtualSeries {
    treeCode: string;
    rows: VirtualRow[];
    top: number;
    height: number;
    bottom: number;
}

const ROW_HEIGHT = 24;
const ROW_GAP = 5;
const SERIES_GAP = 12;
const OVERSCAN_PX = 320;

const getYearOffsetWithinDecade = (year: number) => ((year % 10) + 10) % 10;

const getFirstRowBreakYear = (startYear: number) => {
    const offset = getYearOffsetWithinDecade(startYear);
    return offset === 0 ? startYear : startYear + (10 - offset);
};

const buildTimeline = (entries: Array<[number, number | null]>): YearCell[] => {
    const sortedEntries = [...entries].sort((a, b) => a[0] - b[0]);
    if (sortedEntries.length === 0) {
        return [];
    }

    const timeline: YearCell[] = [];

    for (let i = 0; i < sortedEntries.length; i++) {
        const [year, width] = sortedEntries[i];
        timeline.push({ year, width });

        const nextYear = sortedEntries[i + 1]?.[0];
        if (nextYear === undefined) {
            continue;
        }

        for (let missingYear = year + 1; missingYear < nextYear; missingYear++) {
            timeline.push({ year: missingYear, isInterruptPad: true });
        }
    }

    const [lastYear, lastWidth] = sortedEntries[sortedEntries.length - 1];
    if (lastWidth !== stopMarker.value) {
        timeline.push({ year: lastYear + 1, width: stopMarker.value });
    }

    return timeline;
};

const buildSeriesRows = (treeCode: string, timeline: YearCell[]): VirtualRow[] => {
    if (timeline.length === 0) {
        return [];
    }

    const firstYear = timeline[0].year;
    const firstRowBreakYear = getFirstRowBreakYear(firstYear);
    const rows: VirtualRow[] = [];
    const rowsByStartYear = new Map<number, VirtualRow>();

    for (const cell of timeline) {
        const inFirstRow = cell.year < firstRowBreakYear;
        const startYear = inFirstRow ? firstYear : cell.year - getYearOffsetWithinDecade(cell.year);
        const cellIndex = inFirstRow ? cell.year - firstYear : getYearOffsetWithinDecade(cell.year);
        let row = rowsByStartYear.get(startYear);

        if (!row) {
            row = {
                treeCode,
                startYear,
                cells: [],
            };
            rowsByStartYear.set(startYear, row);
            rows.push(row);
        }

        while (row.cells.length < cellIndex) {
            row.cells.push(null);
        }

        row.cells.push(cell);
    }

    return rows;
};

const findVisibleStartIndex = (series: VirtualSeries[], start: number) => {
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

const findVisibleEndIndex = (series: VirtualSeries[], end: number) => {
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

type WidthContainerProps = {
    siteData: RwlSiteData,
    masterSeries?: Map<number, number>,
    selected?: string,
    onYearClick?: (tree: string, year: number) => void,
    scrollContainerRef?: RefObject<HTMLElement | null>
};

function WidthContainer({ siteData: site, masterSeries, selected, onYearClick, scrollContainerRef }: WidthContainerProps): ReactNode {
    const visibleSite = useMemo(() => (
        selected && site.has(selected)
            ? (() => {
                const treeData = site.get(selected);
                return treeData ? new Map([[selected, treeData]]) : new Map<string, Map<number, number | null>>();
            })()
            : site
    ), [selected, site]);
    const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });

    const virtualSeries = useMemo(() => {
        const seriesList: VirtualSeries[] = [];
        let currentTop = 0;

        for (const [key, value] of visibleSite.entries()) {
            const timeline = buildTimeline(Array.from(value.entries()));
            if (timeline.length === 0) {
                continue;
            }

            const seriesRows = buildSeriesRows(key, timeline);
            const blockHeight = seriesRows.length * ROW_HEIGHT + Math.max(0, seriesRows.length - 1) * ROW_GAP;

            seriesList.push({
                treeCode: key,
                rows: seriesRows,
                top: currentTop,
                height: blockHeight,
                bottom: currentTop + blockHeight,
            });

            currentTop += blockHeight + SERIES_GAP;
        }

        return {
            series: seriesList,
            totalHeight: Math.max(0, currentTop - SERIES_GAP),
        };
    }, [visibleSite]);

    const handleYearClick = useCallback((tree: string, year: number) => {
        if (onYearClick) {
            onYearClick(tree, year);
        }
    }, [onYearClick]);

    useEffect(() => {
        const scrollContainer = scrollContainerRef?.current;
        if (!scrollContainer) {
            return;
        }

        let rafId: number | null = null;

        const syncViewport = () => {
            if (rafId !== null) {
                return;
            }

            rafId = window.requestAnimationFrame(() => {
                rafId = null;
                setViewport((previous) => {
                    const next = {
                        scrollTop: scrollContainer.scrollTop,
                        height: scrollContainer.clientHeight,
                    };

                    return previous.scrollTop === next.scrollTop && previous.height === next.height
                        ? previous
                        : next;
                });
            });
        };

        syncViewport();

        scrollContainer.addEventListener("scroll", syncViewport, { passive: true });
        const resizeObserver = new ResizeObserver(syncViewport);
        resizeObserver.observe(scrollContainer);

        return () => {
            scrollContainer.removeEventListener("scroll", syncViewport);
            resizeObserver.disconnect();
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
            }
        };
    }, [scrollContainerRef, virtualSeries.totalHeight]);

    const visibleSeries = useMemo(() => {
        if (virtualSeries.series.length === 0) {
            return [];
        }

        const start = Math.max(0, viewport.scrollTop - OVERSCAN_PX);
        const effectiveHeight = viewport.height || 800;
        const end = viewport.scrollTop + effectiveHeight + OVERSCAN_PX;
        const startIndex = findVisibleStartIndex(virtualSeries.series, start);
        const endIndex = findVisibleEndIndex(virtualSeries.series, end);

        if (endIndex < startIndex) {
            return [];
        }

        return virtualSeries.series.slice(startIndex, endIndex + 1);
    }, [viewport.height, viewport.scrollTop, virtualSeries.series]);

    const topSpacerHeight = visibleSeries.length > 0 ? visibleSeries[0].top : 0;
    const bottomSpacerHeight = visibleSeries.length > 0
        ? Math.max(0, virtualSeries.totalHeight - visibleSeries[visibleSeries.length - 1].bottom)
        : virtualSeries.totalHeight;

    return (
        <div className={style["width-grid-container"]}>
            {topSpacerHeight > 0 ? (
                <div
                    aria-hidden="true"
                    className={style["virtual-spacer"]}
                    style={{ height: `${topSpacerHeight}px` }}
                />
            ) : null}

            {visibleSeries.map((series, seriesIndex) => (
                <div
                    className={style["series-block"]}
                    key={series.treeCode}
                    style={seriesIndex > 0 ? { marginTop: `${SERIES_GAP}px` } : undefined}
                >
                    {series.rows.map((row, rowIndex) => (
                        <div className={style["series-row"]} key={`${series.treeCode}-${rowIndex}-${row.startYear}`}>
                            <WidthGrid gridValue={series.treeCode} style={{ textAlign: 'left' }} title={series.treeCode} />
                            <WidthGrid gridValue={row.startYear} />

                            {row.cells.map((cell, cellIndex) => {
                                if (!cell) {
                                    return <div key={`gap-${series.treeCode}-${row.startYear}-${cellIndex}`}></div>;
                                }

                                if (cell.isInterruptPad) {
                                    return <div className={style["interrupt-year"]} key={`interrupt-${series.treeCode}-${cell.year}`} />;
                                }

                                if (cell.width === stopMarker.value) {
                                    return <WidthGrid gridValue={cell.width} key={`stop-${series.treeCode}-${cell.year}`} />;
                                }

                                return (
                                    <WidthGrid
                                        key={`value-${series.treeCode}-${cell.year}`}
                                        gridValue={cell.width ?? null}
                                        year={cell.year}
                                        tree={series.treeCode}
                                        masterSeriesValue={masterSeries?.get(cell.year)}
                                        isEditable={true}
                                        onYearClick={handleYearClick}
                                    />
                                );
                            })}

                            {Array.from({ length: 10 - row.cells.length }, (_, emptyIndex) => (
                                <div key={`tail-empty-${series.treeCode}-${rowIndex}-${emptyIndex}`}></div>
                            ))}
                        </div>
                    ))}
                </div>
            ))}

            {bottomSpacerHeight > 0 ? (
                <div
                    aria-hidden="true"
                    className={style["virtual-spacer"]}
                    style={{ height: `${bottomSpacerHeight}px` }}
                />
            ) : null}
        </div>
    );
}

export default memo(WidthContainer);

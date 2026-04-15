import { memo, ReactNode, RefObject, useEffect, useMemo, useState } from 'react';
import { RwlSiteData } from '@/features/rwl';
import WidthGrid from './WidthGrid/WidthGrid';
import style from "./WidthContainer.module.css"
import { stopMarker } from '@/shared/constants';

interface YearCell {
    year: number;
    width?: number | null;
    isInterruptPad?: boolean;
}

interface SeriesRow {
    startYear: number;
    cells: YearCell[];
}

interface VirtualRow extends SeriesRow {
    treeCode: string;
    top: number;
}

const ROW_HEIGHT = 24;
const ROW_GAP = 5;
const SERIES_GAP = 12;
const OVERSCAN_PX = 320;

const findVisibleStartIndex = (rows: VirtualRow[], start: number) => {
    let low = 0;
    let high = rows.length - 1;
    let answer = rows.length;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (rows[mid].top + ROW_HEIGHT >= start) {
            answer = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    return Math.max(0, answer);
};

const findVisibleEndIndex = (rows: VirtualRow[], end: number) => {
    let low = 0;
    let high = rows.length - 1;
    let answer = -1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (rows[mid].top <= end) {
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
    onYearClick?: (year: number) => void,
    scrollContainerRef?: RefObject<HTMLElement | null>
};

function WidthContainer({ siteData: site, masterSeries, selected, onYearClick, scrollContainerRef }: WidthContainerProps): ReactNode {
    // 支持按序列筛选：仅渲染选中的树木编号。
    const visibleSite = useMemo(() => (
        selected && selected !== '全部'
            ? (() => {
                const treeData = site.get(selected);
                return treeData ? new Map([[selected, treeData]]) : new Map<string, Map<number, number | null>>();
            })()
            : site
    ), [selected, site]);
    const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });

    const virtualRows = useMemo(() => {
        const rows: VirtualRow[] = [];
        let currentTop = 0;

        for (const [key, value] of visibleSite.entries()) {
            const entries = Array.from(value.entries());
            if (entries.length === 0) {
                continue;
            }

            // timeline 是序列内部的线性单元流：真实值 + 中断后灰色占位。
            const timeline: YearCell[] = [];

            for (let i = 0; i < entries.length; i++) {
                const [year, width] = entries[i];
                timeline.push({ year, width });

                if (width === stopMarker.value && i < entries.length - 1) {
                    let nextValidYear: number | undefined;
                    for (let j = i + 1; j < entries.length; j++) {
                        const [candidateYear, candidateWidth] = entries[j];
                        if (candidateWidth !== stopMarker.value) {
                            nextValidYear = candidateYear;
                            break;
                        }
                    }

                    if (nextValidYear !== undefined) {
                        // stopMarker 与下一个有效值之间的年份，用灰格占位但不触发额外断行。
                        for (let missingYear = year + 1; missingYear < nextValidYear; missingYear++) {
                            timeline.push({ year: missingYear, isInterruptPad: true });
                        }
                    }
                }
            }

            // 按 10 个数据格打包成行；每行前两列固定为编号和起始年份。
            const seriesRows: SeriesRow[] = [];
            for (const cell of timeline) {
                const lastRow = seriesRows[seriesRows.length - 1];
                if (!lastRow || lastRow.cells.length >= 10) {
                    seriesRows.push({
                        startYear: cell.year,
                        cells: [cell]
                    });
                    continue;
                }

                lastRow.cells.push(cell);
            }

            seriesRows.forEach((row, rowIndex) => {
                rows.push({
                    ...row,
                    treeCode: key,
                    top: currentTop,
                });

                currentTop += ROW_HEIGHT;
                currentTop += rowIndex === seriesRows.length - 1 ? SERIES_GAP : ROW_GAP;
            });
        }

        return {
            rows,
            totalHeight: Math.max(0, currentTop - SERIES_GAP),
        };
    }, [visibleSite]);

    const handleYearClick = (year: number) => {
        if (onYearClick) {
            onYearClick(year);
        }
    };

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
    }, [scrollContainerRef, virtualRows.totalHeight]);

    const visibleRows = useMemo(() => {
        if (virtualRows.rows.length === 0) {
            return [];
        }

        const start = Math.max(0, viewport.scrollTop - OVERSCAN_PX);
        const end = viewport.scrollTop + viewport.height + OVERSCAN_PX;
        const startIndex = findVisibleStartIndex(virtualRows.rows, start);
        const endIndex = findVisibleEndIndex(virtualRows.rows, end);

        return virtualRows.rows.slice(startIndex, Math.max(startIndex, endIndex + 1));
    }, [viewport.height, viewport.scrollTop, virtualRows.rows]);

    return (
        <div className={style["width-grid-container"]} style={{ height: `${virtualRows.totalHeight}px` }}>
            {visibleRows.map((row) => (
                <div
                    className={style["series-row"]}
                    key={`${row.treeCode}-${row.startYear}-${row.top}`}
                    style={{ top: `${row.top}px` }}
                >
                    <WidthGrid gridValue={row.treeCode} style={{ textAlign: 'left' }} title={row.treeCode} />
                    <WidthGrid gridValue={row.startYear} />

                    {row.cells.map((cell) => {
                        if (cell.isInterruptPad) {
                            return <div className={style["interrupt-year"]} key={`interrupt-${row.treeCode}-${cell.year}`} />;
                        }

                        if (cell.width === stopMarker.value) {
                            return <WidthGrid gridValue={cell.width} key={`stop-${row.treeCode}-${cell.year}`} />;
                        }

                        return (
                            <WidthGrid
                                key={`value-${row.treeCode}-${cell.year}`}
                                gridValue={cell.width ?? null}
                                year={cell.year}
                                tree={row.treeCode}
                                masterSeriesValue={masterSeries?.get(cell.year)}
                                isEditable={true}
                                onYearClick={handleYearClick}
                            />
                        );
                    })}

                    {/* 尾部补空槽，保证每行数据区固定为 10 列。 */}
                    {Array.from({ length: 10 - row.cells.length }, (_, emptyIndex) => (
                        <div key={`tail-empty-${row.treeCode}-${row.startYear}-${emptyIndex}`}></div>
                    ))}
                </div>
            ))}
        </div>
    );
}

export default memo(WidthContainer);

import { ReactNode } from 'react';
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


export default function ({ siteData: site, masterSeries, selected, onYearClick }: {
    siteData: RwlSiteData,
    masterSeries?: Map<number, number>,
    selected?: string,
    onYearClick?: (year: number) => void
}): ReactNode {
    // 支持按序列筛选：仅渲染选中的树木编号。
    const visibleSite = selected && selected !== '全部'
        ? (() => {
            const treeData = site.get(selected);
            return treeData ? new Map([[selected, treeData]]) : new Map<string, Map<number, number | null>>();
        })()
        : site;

    const handleYearClick = (year: number) => {
        if (onYearClick) {
            onYearClick(year);
        }
    };

    return (
        <div className={style["width-grid-container"]}>
            {Array.from(visibleSite.entries()).map(([key, value]) => {
                const entries = Array.from(value.entries());
                if (entries.length === 0) {
                    return null;
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
                const rows: SeriesRow[] = [];
                for (const cell of timeline) {
                    const lastRow = rows[rows.length - 1];
                    if (!lastRow || lastRow.cells.length >= 10) {
                        rows.push({
                            startYear: cell.year,
                            cells: [cell]
                        });
                        continue;
                    }

                    lastRow.cells.push(cell);
                }

                return (
                    // 每个序列独立成块，避免某个序列布局异常影响其他序列。
                    <div className={style["series-block"]} key={key}>
                        {rows.map((row, rowIndex) => {
                            return (
                                <div className={style["series-row"]} key={`${key}-${rowIndex}-${row.startYear}`}>
                                    <WidthGrid gridValue={key} />
                                    <WidthGrid gridValue={row.startYear} />

                                    {row.cells.map((cell) => {
                                        if (cell.isInterruptPad) {
                                            return <div className={style["interrupt-year"]} key={`interrupt-${key}-${cell.year}`} />;
                                        }

                                        if (cell.width === stopMarker.value) {
                                            return <WidthGrid gridValue={cell.width} key={`stop-${key}-${cell.year}`} />;
                                        }

                                        return (
                                            <WidthGrid
                                                key={`value-${key}-${cell.year}`}
                                                gridValue={cell.width ?? null}
                                                year={cell.year}
                                                tree={key}
                                                masterSeriesValue={masterSeries?.get(cell.year)}
                                                isEditable={true}
                                                onYearClick={handleYearClick}
                                            />
                                        );
                                    })}

                                    {/* 尾部补空槽，保证每行数据区固定为 10 列。 */}
                                    {Array.from({ length: 10 - row.cells.length }, (_, i) => (
                                        <div key={`tail-empty-${key}-${rowIndex}-${i}`}></div>
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
}

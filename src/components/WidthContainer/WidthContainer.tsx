import { Fragment, ReactNode } from 'react';
import { RwlSiteData } from '@/features/rwl';
import WidthGrid from './WidthGrid/WidthGrid';
import style from "./WidthContainer.module.css"
import { stopMarker } from '@/shared/constants';

interface YearCell {
    year: number;
    width?: number | null;
    isInterruptPad?: boolean;
}


export default function ({ siteData: site, masterSeries, selected, onYearClick }: {
    siteData: RwlSiteData,
    masterSeries?: Map<number, number>,
    selected?: string,
    onYearClick?: (year: number) => void
}): ReactNode {
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
                const firstYear = entries[0]?.[0];
                if (firstYear === undefined) {
                    return null;
                }

                const yearCells = new Map<number, YearCell>();

                for (let i = 0; i < entries.length; i++) {
                    const [year, width] = entries[i];
                    yearCells.set(year, { year, width });

                    // 仅在中断标记之后补齐缺失年份（灰格），并保持年份对应
                    if (width === stopMarker.value && i < entries.length - 1) {
                        const [nextYear] = entries[i + 1];
                        for (let missingYear = year + 1; missingYear < nextYear; missingYear++) {
                            yearCells.set(missingYear, { year: missingYear, isInterruptPad: true });
                        }
                    }
                }

                const allYears = Array.from(yearCells.keys());
                const maxYear = allYears.length > 0 ? Math.max(...allYears) : firstYear;

                const firstDecadeStart = Math.floor(firstYear / 10) * 10;
                const lastDecadeStart = Math.floor(maxYear / 10) * 10;

                const decadeStarts: number[] = [];
                for (let decade = firstDecadeStart; decade <= lastDecadeStart; decade += 10) {
                    decadeStarts.push(decade);
                }

                return (
                    <Fragment key={key}>
                        {decadeStarts.map((decadeStart) => {
                            const rowLabelYear = decadeStart === firstDecadeStart ? firstYear : decadeStart;

                            return (
                                <div className={style["series-row"]} key={`${key}-${decadeStart}`}>
                                    <WidthGrid gridValue={key} />
                                    <WidthGrid gridValue={rowLabelYear} />

                                    {Array.from({ length: 10 }, (_, offset) => {
                                        const year = decadeStart + offset;
                                        const beforeFirstYear = decadeStart === firstDecadeStart && year < firstYear;

                                        if (beforeFirstYear) {
                                            return <div key={`empty-${key}-${year}`}></div>;
                                        }

                                        const cell = yearCells.get(year);
                                        if (!cell) {
                                            return <div key={`empty-${key}-${year}`}></div>;
                                        }

                                        if (cell.isInterruptPad) {
                                            return <div className={style["interrupt-year"]} key={`interrupt-${key}-${year}`}></div>;
                                        }

                                        if (cell.width === stopMarker.value) {
                                            return <WidthGrid gridValue={cell.width} key={`stop-${key}-${year}`} />;
                                        }

                                        return (
                                            <WidthGrid
                                                key={`value-${key}-${year}`}
                                                gridValue={cell.width ?? null}
                                                year={year}
                                                tree={key}
                                                masterSeriesValue={masterSeries?.get(year)}
                                                isEditable={true}
                                                onYearClick={handleYearClick}
                                            />
                                        );
                                    })}
                                </div>
                            );
                        })}
                    </Fragment>
                );
            })}
        </div>
    );
}

import { Fragment, ReactNode } from 'react';
import { RwlSiteData } from '../types';
import WidthGrid from './WidthGrid';
import "./WidthContainer.css"

interface RenderItem {
    key: string;
    year: number;
    width: number | null;
    firstYear: number;
    interrupted: boolean;
    isLast: boolean;
    nextValidYear?: number;
    interruptPadCount?: number;
}

export default function ({ siteData: site, masterSeries, selected, onYearClick }: {
    siteData: RwlSiteData,
    masterSeries?: Map<number, number>,
    selected?: string,
    onYearClick?: (year: number) => void
}): ReactNode {
    if (selected && selected !== '全部') {
        const treeData = site.get(selected);
        if (!treeData) return '';
        site = new Map([[selected, treeData]]);
    }

    const handleYearClick = (year: number) => {
        if (onYearClick) {
            onYearClick(year);
        }
    };

    const renderItems: RenderItem[] = [];

    site.forEach((value, key) => {
        const entries = Array.from(value.entries());
        const firstYear = entries[0]?.[0];

        for (let i = 0; i < entries.length; i++) {
            const [year, width] = entries[i];
            const isLast = i === entries.length - 1;

            let interrupted = false;
            let nextValidYear: number | undefined = undefined;
            let interruptPadCount: number | undefined = undefined;

            if ((width === -9999 || width === 999) && !isLast) {
                interrupted = true;

                // 找下一个有效年份并计算需补格子数
                for (let j = i + 1; j < entries.length; j++) {
                    const [nextYear, nextWidth] = entries[j];
                    if (nextWidth !== -9999 && nextWidth !== 999) {
                        nextValidYear = nextYear;
                        interruptPadCount = nextValidYear % 10;
                        break;
                    }
                }
            }

            renderItems.push({
                key,
                year,
                width,
                firstYear,
                interrupted,
                isLast,
                nextValidYear,
                interruptPadCount
            });
        }
    });

    return (
        <div className='width-grid-container'>
            {renderItems.map(({ key, year, width, firstYear, interrupted, nextValidYear, interruptPadCount }) => {
                const isLineStart = year === firstYear || year % 10 === 0;
                const needEmptyStart = (year % 10 === 0 && year - firstYear <= 10);

                return (
                    <Fragment key={`${key}-${year}`}>
                        {/* 补空格：十年起始年份前补空格 */}
                        {needEmptyStart && [...Array(firstYear % 10)].map((_, i) => (
                            <div key={`pad-${key}-${year}-${i}`}></div>
                        ))}

                        {/* 每行起始编号与年份 */}
                        {isLineStart && <WidthGrid gridValue={key} />}
                        {isLineStart && <WidthGrid gridValue={year} />}

                        {/* 实际宽度值 */}
                        <WidthGrid
                            gridValue={width}
                            year={year}
                            masterSeriesValue={masterSeries?.get(year)}
                            isEditable={true}
                            onYearClick={handleYearClick}
                        />

                        {/* 当前行为中断值或末尾值时补空格 */}
                        {(width === -9999||width === 999) && [...Array((10 - year % 10) - 1)].map((_, i) => (
                            <div key={`endpad-${key}-${year}-${i}`}></div>
                        ))}

                        {/* 中断后 自动补空格 */}
                        {interrupted && nextValidYear !== undefined && (
                            <>
                                <WidthGrid gridValue={key} />
                                <WidthGrid gridValue={nextValidYear} />
                                {[...Array(interruptPadCount ?? 0)].map((_, i) => (
                                    <div key={`interrupt-pad-${key}-${nextValidYear}-${i}`}></div>
                                ))}
                            </>
                        )}
                    </Fragment>
                );
            })}
        </div>
    );
}

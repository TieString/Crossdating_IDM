import { Fragment, ReactNode } from 'react';
import { RwlSiteData } from '../types';
import WidthGrid from './WidthGrid';
import "./WidthContainer.css"

export default function ({ siteData: site, masterSeries, selected, onYearClick }: {
    siteData: RwlSiteData,
    masterSeries?: Map<number, number>,
    selected?: string,
    onYearClick?: (year: number) => void
}): ReactNode {
    if (selected && selected !== '全部') {
        // 如果选择了一棵树，则只输出该树的数据
        const treeData = site.get(selected)
        if (!treeData) return ''  // 或者抛出错误
        site = new Map([[selected, treeData]])
    }

    const handleYearClick = (year: number) => {
        if (onYearClick) {
            onYearClick(year); // ✅ 继续传递给祖父组件
        }
    };

    // 将site用WidthGrid展示出
    return (
        <div className='width-grid-container'>
            {
                Array.from(site).map(([key, value]) => {
                    // 获取第一个年份
                    const first_year = Array.from(value.keys())[0];
                    return Array.from(value).map(([year, width]) => (
                        <Fragment key={`${key}-${year}`}>
                            {(year % 10 === 0 && year - first_year <= 10) && [...Array(first_year % 10)].map((_, i) => (
                                <div key={i}></div>
                            ))}

                            {(year === first_year || year % 10 === 0) && <WidthGrid gridValue={key} />}

                            {(year === first_year || year % 10 === 0) && <WidthGrid gridValue={year} />}

                            <WidthGrid
                                gridValue={width}
                                year={year}
                                masterSeriesValue={masterSeries?.get(year)}
                                isEditable={true}
                                onYearClick={handleYearClick} // ✅ 传递 `handleYearClick`
                            />

                            {(width === -9999) && [...Array((10 - year % 10) - 1)].map((_, i) => (
                                <div key={i}></div>
                            ))}
                        </Fragment>
                    ));
                })
            }
        </div>
    )

}
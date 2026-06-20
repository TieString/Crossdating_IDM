import { ReactNode, useMemo } from "react";
import { VALUE_COLUMN_COUNT } from "./widthGridLayout";
import style from "./WidthGridSkeleton.module.css";

/** Internal view props for rendering the width-grid skeleton with the parent grid header. */
export interface WidthGridSkeletonViewProps {
    header: ReactNode;
    containerClassName: string;
    baseSkeletonClassName?: string;
    showRows?: boolean;
}

export function WidthGridSkeletonView({
    header,
    containerClassName,
    baseSkeletonClassName,
    showRows = false,
}: WidthGridSkeletonViewProps): ReactNode {
    const skeletonSeriesRows = useMemo(() => (
        Array.from({ length: 12 }, () => 3 + Math.floor(Math.random() * 4))
    ), []);

    return (
        <div
            className={`${containerClassName} ${baseSkeletonClassName}${showRows ? ` ${style["width-grid-skeleton-loading"]}` : ""}`}
            aria-hidden="true"
        >
            {header}
            {showRows ? (
                <div className={style["width-grid-skeleton-body"]}>
                    {skeletonSeriesRows.map((rowCount, seriesIndex) => (
                        <div className={style["width-grid-skeleton-series"]} key={`skeleton-series-${seriesIndex}`}>
                            <div className={style["width-grid-skeleton-series-header"]}>
                                <span className={style["width-grid-skeleton-title"]} />
                                <span className={style["width-grid-skeleton-meta"]} />
                            </div>
                            {Array.from({ length: rowCount }, (_, rowIndex) => (
                                <div className={style["width-grid-skeleton-row"]} key={`skeleton-row-${seriesIndex}-${rowIndex}`}>
                                    <span className={`${style["width-grid-skeleton-cell"]} ${style["width-grid-skeleton-code"]}`} />
                                    <span className={`${style["width-grid-skeleton-cell"]} ${style["width-grid-skeleton-year"]}`} />
                                    {Array.from({ length: VALUE_COLUMN_COUNT }, (_, cellIndex) => (
                                        <span
                                            key={`skeleton-cell-${seriesIndex}-${rowIndex}-${cellIndex}`}
                                            className={style["width-grid-skeleton-cell"]}
                                            style={{ animationDelay: `${(seriesIndex * 7 + rowIndex * 3 + cellIndex) * 45}ms` }}
                                        />
                                    ))}
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

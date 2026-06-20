import { RollingNumber } from "@/components/RollingNumber/RollingNumber";
import style from "./HomePanelComponents.module.css";

const COFECHA_SKELETON_LINE_WIDTHS = [48, 84, 64, 92, 76, 52, 88, 58, 71, 43, 80, 66];

type CofechaStatValueProps = {
    value: string | number | null | undefined;
    showSkeleton: boolean;
};

export function CofechaStatValue({ value, showSkeleton }: CofechaStatValueProps) {
    return showSkeleton
        ? <span className={style["stat-value-skeleton"]} aria-hidden="true" />
        : <RollingNumber value={value} />;
}

export function CofechaToolbarSkeleton() {
    return (
        <div className={style["cofecha-toolbar-skeleton"]} aria-hidden="true">
            <span className={`${style["skeleton-block"]} ${style["skeleton-select"]}`} />
            <span className={`${style["skeleton-block"]} ${style["skeleton-button"]}`} />
            <span className={`${style["skeleton-block"]} ${style["skeleton-chip"]}`} />
        </div>
    );
}

export function CofechaEmptySkeleton() {
    return (
        <div className={style["cofecha-empty-skeleton"]} aria-hidden="true">
            <span className={`${style["skeleton-block"]} ${style["cofecha-skeleton-title"]}`} />
            <div className={style["cofecha-skeleton-rule"]} />
            <div className={style["cofecha-skeleton-lines"]}>
                {COFECHA_SKELETON_LINE_WIDTHS.map((width, index) => (
                    <span
                        key={`${width}-${index}`}
                        className={`${style["skeleton-block"]} ${style["cofecha-skeleton-line"]}`}
                        style={{ width: `${width}%` }}
                    />
                ))}
            </div>
        </div>
    );
}

export function CofechaEmptyState() {
    return (
        <div className={style["cofecha-empty-state"]} aria-hidden="true">
            <div className={style["cofecha-empty-state-rule"]} />
            <div className={style["cofecha-empty-state-lines"]}>
                {COFECHA_SKELETON_LINE_WIDTHS.slice(0, 7).map((width, index) => (
                    <span
                        key={`${width}-${index}`}
                        className={style["cofecha-empty-state-line"]}
                        style={{ width: `${width}%` }}
                    />
                ))}
            </div>
        </div>
    );
}

export function LineChartEmptySkeleton() {
    return (
        <div className={style["chart-empty-skeleton"]} aria-hidden="true">
            <div className={style["chart-skeleton-toolbar"]}>
                <div className={style["chart-skeleton-toolbar-group"]}>
                    <span className={`${style["skeleton-block"]} ${style["chart-skeleton-tab"]}`} />
                    <span className={`${style["skeleton-block"]} ${style["chart-skeleton-tab-short"]}`} />
                </div>
                <div className={style["chart-skeleton-toolbar-group"]}>
                    <span className={`${style["skeleton-block"]} ${style["chart-skeleton-icon"]}`} />
                    <span className={`${style["skeleton-block"]} ${style["chart-skeleton-icon"]}`} />
                    <span className={`${style["skeleton-block"]} ${style["chart-skeleton-icon"]}`} />
                </div>
            </div>
            <div className={style["chart-skeleton-plot"]}>
                <svg className={style["chart-skeleton-svg"]} viewBox="0 0 100 100" preserveAspectRatio="none">
                    <polyline points="0,72 10,64 19,70 30,46 42,54 53,30 65,42 76,24 88,36 100,18" />
                    <polyline points="0,58 12,50 24,57 36,42 48,47 60,36 74,44 86,32 100,39" />
                </svg>
                <div className={style["chart-skeleton-axis-x"]} />
                <div className={style["chart-skeleton-axis-y"]} />
            </div>
        </div>
    );
}

export function LineChartEmptyState() {
    return (
        <div className={style["chart-empty-state"]} aria-hidden="true">
            <div className={style["chart-empty-state-toolbar"]}>
                <span />
                <span />
            </div>
            <div className={style["chart-empty-state-plot"]}>
                <svg className={style["chart-empty-state-svg"]} viewBox="0 0 100 100" preserveAspectRatio="none">
                    <polyline points="0,70 12,62 23,68 36,50 49,56 61,40 74,48 86,34 100,42" />
                    <polyline points="0,78 14,73 27,76 41,64 54,68 68,55 82,60 100,48" />
                </svg>
                <div className={style["chart-empty-state-axis-x"]} />
                <div className={style["chart-empty-state-axis-y"]} />
            </div>
        </div>
    );
}

type WorkspaceWindowPlaceholderProps = {
    message: string;
    onFocusWindow: () => void;
};

export function WorkspaceWindowPlaceholder({ message, onFocusWindow }: WorkspaceWindowPlaceholderProps) {
    return (
        <div className={style["external-window-placeholder"]}>
            <span>{message}</span>
            <button
                type="button"
                className={style["placeholder-button"]}
                onClick={onFocusWindow}
            >
                聚焦窗口
            </button>
        </div>
    );
}

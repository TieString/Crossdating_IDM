import { memo, ReactNode, RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { RwlSiteData } from '@/features/rwl';
import { moveSeriesTailByOffset as previewMoveSeriesTailByOffset } from '@/features/rwl/edit';
import type { DeleteMode, DeleteShift, DeletionMarkerInfo, RwlDeletionMarkers, RwlHistoryAnimation } from '@/features/rwl/edit';
import { RollingNumber } from '@/components/RollingNumber/RollingNumber';
import WidthGrid from './WidthGrid/WidthGrid';
import WidthGridContextMenu from './WidthGridContextMenu/WidthGridContextMenu';
import SeriesTextEditor, { seriesDataToText, textToSeriesData } from './SeriesTextEditor/SeriesTextEditor';
import style from "./WidthContainer.module.css";
import { stopMarker } from '@/shared/constants';
import { useSettings } from "@/features/settings/SettingsContext";
import { normalizeAnimationSpeed } from "@/features/settings/settings";
import {
    ROW_GAP,
    ROW_HEIGHT,
    VALUE_COLUMN_COUNT,
    getFirstRowBreakYear,
    getYearOffsetWithinDecade,
} from "./widthGridLayout";
import {
    buildHistoryShiftPlan,
    buildShiftPlan,
    getDeleteShiftAnchorTargetYear,
    getInsertShiftAnchorTargetYear,
    getOppositeSide,
    getRestoreShiftAnchorTargetYear,
    getVisibleInsertShiftTargets,
    isYearOnInsertSide,
    type GridAnimationPlan,
    type GridAnimationPlanInput,
    type InsertFlipCell,
    type PlusSide,
    type RollingCellAnimation,
    type ShiftedCellAnimation,
} from "./widthGridAnimationPlan";

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

const SERIES_HEADER_HEIGHT = 36;
const SERIES_GAP = 12;
const OVERSCAN_PX = 320;
const GRID_GAP = 5;
const DRAG_THRESHOLD_PX = 3;
const INSERT_SHIFT_ANIMATION_MS = 1250;
const CROSS_ROW_SOURCE_EXIT_MS = 1320;
const CROSS_ROW_SOURCE_EXIT_EASING = "cubic-bezier(0.25, 0.1, 0.25, 1)";
const ANIMATION_PLAN_CLEAR_PADDING_MS = 360;
const DELETE_BURST_ANIMATION_MS = 820;
const DELETE_BURST_SWEEP_MS = 420;
const SERIES_DELETE_ANIMATION_MS = 900;
const COFECHA_JUMP_HIGHLIGHT_MS = 3200;

const scaleAnimationMs = (durationMs: number, animationSpeed: number) => (
    Math.max(1, Math.round(durationMs / animationSpeed))
);

type WidthHistoryAnimation = RwlHistoryAnimation & { id: number };

interface GridSelection {
    tree: string;
    startYear: number;
    endYear: number;
}

interface DragPreview extends GridSelection {
    yearOffset: number;
    hasMoved: boolean;
}

interface GridJumpTarget {
    id: number;
    tree: string;
    year?: number;
}

interface GridEditHighlightTarget {
    id: number;
    cells: { tree: string; year: number }[];
    scrollTree: string;
    scrollYear?: number;
}

interface PendingInsertFlip {
    tree: string;
    side: PlusSide;
    cells: InsertFlipCell[];
}

type GridAnimationKind =
    | "insert-left"
    | "insert-right"
    | "insert-shift-left"
    | "insert-shift-right"
    | "insert-edge-fade-left"
    | "insert-edge-fade-right"
    | "insert-cross-row-shift-left"
    | "insert-cross-row-shift-right"
    | "move-target"
    | "move-gap"
    | "overwrite";

interface DeletionHoverItem {
    year: number;
    anchorLeft: number;  // x of the right-neighbor cell's left edge, relative to container
    anchorTop: number;   // y of the right-neighbor cell's top, relative to container
    anchorHeight: number;
    cellWidth: number;
    side: "left" | "right";
}

interface DeletionHoverState {
    tree: string;
    hoveredYear: number;
    items: DeletionHoverItem[]; // all consecutive markers in the run (sorted by year)
}

type GridInteraction =
    | { mode: "select"; tree: string; anchorYear: number; pointerId: number }
    | {
        mode: "move";
        tree: string;
        startYear: number;
        endYear: number;
        clickedYear: number;
        pointerId: number;
        startX: number;
        startY: number;
        columnStride: number;
        rowStride: number;
        yearOffset: number;
        hasMoved: boolean;
    };

const getRollingWidthValue = (value: number | null | undefined) => (
    typeof value === "number" && value !== stopMarker.value ? value : undefined
);

const getEditableTreeYears = (treeData: Map<number, number | null> | undefined) => {
    if (!treeData) {
        return [];
    }

    return Array.from(treeData.entries())
        .filter(([, value]) => value !== stopMarker.value)
        .map(([year]) => year);
};

const addRollingTargetIfChanged = (
    targets: RollingCellAnimation[],
    targetYear: number,
    fromValue: number | null | undefined,
    toValue: number | null | undefined,
) => {
    const numericFromValue = getRollingWidthValue(fromValue);
    const numericToValue = getRollingWidthValue(toValue);

    if (numericFromValue === undefined || numericToValue === undefined || numericFromValue === numericToValue) {
        return;
    }

    targets.push({ year: targetYear, fromValue: numericFromValue });
};

const getAnimationPlanTimeoutMs = (plan: GridAnimationPlan, animationSpeed: number) => {
    const maxShiftDelaySeconds = plan.shiftedCells.reduce(
        (maxDelay, cell) => Math.max(maxDelay, cell.delaySeconds),
        0
    );

    return Math.max(
        scaleAnimationMs(2400, animationSpeed),
        scaleAnimationMs(Math.ceil(maxShiftDelaySeconds * 1000) + INSERT_SHIFT_ANIMATION_MS + ANIMATION_PLAN_CLEAR_PADDING_MS, animationSpeed)
    );
};

const buildDeleteRollingCells = (
    treeData: Map<number, number | null> | undefined,
    year: number,
    mode: DeleteMode,
    shift: DeleteShift = "right",
): RollingCellAnimation[] => {
    const deletedWidth = getRollingWidthValue(treeData?.get(year));

    if (deletedWidth === undefined) {
        return [];
    }

    const rollingCells: RollingCellAnimation[] = [];
    const addNeighbor = (targetYear: number, neighborYear: number, extraWidth: number) => {
        const neighborWidth = getRollingWidthValue(treeData?.get(neighborYear));
        addRollingTargetIfChanged(
            rollingCells,
            targetYear,
            neighborWidth,
            neighborWidth === undefined ? undefined : neighborWidth + extraWidth,
        );
    };

    // 邻居在删除收紧后所处的位置取决于填补方向：
    // - shift="right"：左侧格子右移，左邻 (year-1) 落到 year，右邻 (year+1) 不动。
    // - shift="left"：右侧格子左移，左邻 (year-1) 不动，右邻 (year+1) 落到 year。
    const leftNeighborTargetYear = shift === "left" ? year - 1 : year;
    const rightNeighborTargetYear = shift === "left" ? year : year + 1;

    if (mode === "left") {
        addNeighbor(leftNeighborTargetYear, year - 1, deletedWidth);
    } else if (mode === "right") {
        addNeighbor(rightNeighborTargetYear, year + 1, deletedWidth);
    } else if (mode === "both") {
        const halfWidth = Math.round(deletedWidth / 2);
        addNeighbor(leftNeighborTargetYear, year - 1, halfWidth);
        addNeighbor(rightNeighborTargetYear, year + 1, halfWidth);
    }

    return rollingCells;
};

const normalizeSelection = (tree: string, yearA: number, yearB: number): GridSelection => ({
    tree,
    startYear: Math.min(yearA, yearB),
    endYear: Math.max(yearA, yearB),
});

const isYearInSelection = (selection: GridSelection | null, tree: string, year: number) => (
    Boolean(selection && selection.tree === tree && year >= selection.startYear && year <= selection.endYear)
);

const getYearRange = (startYear: number, endYear: number) => {
    const start = Math.min(startYear, endYear);
    const end = Math.max(startYear, endYear);
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
};

const getGridCellFromPoint = (clientX: number, clientY: number) => {
    const element = document.elementFromPoint(clientX, clientY);
    const cell = element?.closest<HTMLElement>("[data-width-grid-cell='true']");
    const tree = cell?.dataset.tree;
    const rawYear = cell?.dataset.year;

    if (!tree || rawYear === undefined) {
        return null;
    }

    const year = Number(rawYear);
    return Number.isFinite(year) ? { tree, year } : null;
};

const buildTimeline = (entries: Array<[number, number | null]>): YearCell[] => {
    const sortedRawEntries = [...entries].sort((a, b) => a[0] - b[0]);
    const sortedEntries = sortedRawEntries.filter(([, width], index) => (
        width !== stopMarker.value || index === sortedRawEntries.length - 1
    ));

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

const getTreeYearGridElements = (container: HTMLElement, tree: string) => {
    const elementsByYear = new Map<number, HTMLElement>();
    const cells = container.querySelectorAll<HTMLElement>("[data-width-grid-cell='true']");

    cells.forEach((cell) => {
        if (cell.dataset.tree !== tree) {
            return;
        }

        const year = Number(cell.dataset.year);
        if (Number.isFinite(year)) {
            elementsByYear.set(year, cell);
        }
    });

    return elementsByYear;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const isTransparentColor = (color: string) => (
    color === ""
    || color === "transparent"
    || /^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(?:,\s*0\s*)?\)$/i.test(color)
    || /,\s*0\s*\)$/i.test(color)
);

const getUsableCssColor = (color: string, fallback: string) => (
    isTransparentColor(color.trim()) ? fallback : color
);

const createDeletePixelBurst = (container: HTMLElement, sourceElement: HTMLElement, animationSpeed = 1) => {
    const containerRect = container.getBoundingClientRect();
    const sourceRect = sourceElement.getBoundingClientRect();

    if (sourceRect.width <= 0 || sourceRect.height <= 0) {
        return null;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const computedStyle = window.getComputedStyle(sourceElement);
    const baseColor = getUsableCssColor(computedStyle.backgroundColor, "#f3f4f6");
    const textColor = getUsableCssColor(computedStyle.color, "#111827");
    const particleColors = [baseColor, textColor, "#f97316", "#facc15", "#38bdf8"];
    const root = document.createElement("span");
    root.className = style["delete-pixel-burst"];
    root.style.left = `${sourceRect.left - containerRect.left}px`;
    root.style.top = `${sourceRect.top - containerRect.top}px`;
    root.style.width = `${sourceRect.width}px`;
    root.style.height = `${sourceRect.height}px`;
    root.style.setProperty("--delete-burst-height", `${sourceRect.height}px`);

    const sourceGhost = sourceElement.cloneNode(true) as HTMLElement;
    sourceGhost.classList.add(style["delete-pixel-burst-source"]);
    sourceGhost.removeAttribute("data-width-grid-cell");
    sourceGhost.removeAttribute("data-tree");
    sourceGhost.removeAttribute("data-year");
    sourceGhost.removeAttribute("title");
    sourceGhost.setAttribute("aria-hidden", "true");
    root.appendChild(sourceGhost);

    container.appendChild(root);

    const animations: Animation[] = [];
    let timerId: number | null = null;
    let isDone = false;

    const finish = () => {
        if (isDone) {
            return;
        }

        isDone = true;
        if (timerId !== null) {
            window.clearTimeout(timerId);
            timerId = null;
        }
        root.remove();
    };

    if (reducedMotion) {
        animations.push(root.animate([
            { opacity: 1 },
            { opacity: 0 },
        ], {
            duration: scaleAnimationMs(180, animationSpeed),
            easing: "ease-out",
            fill: "forwards",
        }));
        timerId = window.setTimeout(finish, scaleAnimationMs(220, animationSpeed));
    } else {
        animations.push(sourceGhost.animate([
            { clipPath: "inset(0 0 0 0)", opacity: 1, transform: "scale(1)" },
            { clipPath: "inset(0 0 0 58%)", opacity: 0.74, transform: "scale(0.98)", offset: 0.46 },
            { clipPath: "inset(0 0 0 100%)", opacity: 0.08, transform: "scale(0.92)" },
        ], {
            duration: scaleAnimationMs(DELETE_BURST_SWEEP_MS, animationSpeed),
            easing: "cubic-bezier(0.3, 0, 0.2, 1)",
            fill: "forwards",
        }));

        const mouth = document.createElement("span");
        mouth.className = style["delete-pixel-burst-mouth"];
        mouth.style.width = `${Math.max(13, sourceRect.height * 0.72)}px`;
        mouth.style.height = `${Math.max(13, sourceRect.height * 0.72)}px`;
        root.appendChild(mouth);
        animations.push(mouth.animate([
            { opacity: 0, transform: `translate(-${sourceRect.height * 0.7}px, -50%) scale(0.8)` },
            { opacity: 1, transform: "translate(0, -50%) scale(1)", offset: 0.18 },
            { opacity: 1, transform: `translate(${sourceRect.width * 0.62}px, -50%) scale(1.04)`, offset: 0.7 },
            { opacity: 0, transform: `translate(${sourceRect.width + sourceRect.height * 0.62}px, -50%) scale(0.82)` },
        ], {
            duration: scaleAnimationMs(DELETE_BURST_SWEEP_MS + 80, animationSpeed),
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
            fill: "forwards",
        }));

        const columns = clamp(Math.round(sourceRect.width / 6), 6, 11);
        const rows = clamp(Math.round(sourceRect.height / 6), 3, 5);
        const particleWidth = sourceRect.width / columns;
        const particleHeight = sourceRect.height / rows;
        let maxParticleEnd = 0;

        for (let row = 0; row < rows; row += 1) {
            for (let column = 0; column < columns; column += 1) {
                const particle = document.createElement("span");
                const left = column * particleWidth;
                const top = row * particleHeight;
                const rowDrift = row - (rows - 1) / 2;
                const columnDrift = column - (columns - 1) / 2;
                const delay = scaleAnimationMs(column * 34 + row * 12 + Math.random() * 38, animationSpeed);
                const duration = scaleAnimationMs(430 + Math.random() * 260, animationSpeed);
                const dx = 14 + column * 2.2 + Math.random() * 38;
                const dy = rowDrift * (13 + Math.random() * 9) + (Math.random() - 0.5) * 14;
                const rotate = columnDrift * 18 + (Math.random() - 0.5) * 110;

                particle.className = style["delete-pixel-burst-pixel"];
                particle.style.left = `${left}px`;
                particle.style.top = `${top}px`;
                particle.style.width = `${Math.max(2, particleWidth - 1)}px`;
                particle.style.height = `${Math.max(2, particleHeight - 1)}px`;
                particle.style.backgroundColor = particleColors[(row + column) % particleColors.length];
                root.appendChild(particle);

                animations.push(particle.animate([
                    { opacity: 0, transform: "translate(0, 0) scale(0.9) rotate(0deg)" },
                    { opacity: 1, transform: "translate(0, 0) scale(1) rotate(0deg)", offset: 0.16 },
                    { opacity: 0.74, transform: `translate(${dx * 0.46}px, ${dy * 0.46}px) scale(0.92) rotate(${rotate * 0.4}deg)`, offset: 0.58 },
                    { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(0.22) rotate(${rotate}deg)` },
                ], {
                    duration,
                    delay,
                    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
                    fill: "forwards",
                }));
                maxParticleEnd = Math.max(maxParticleEnd, delay + duration);
            }
        }

        timerId = window.setTimeout(finish, Math.max(scaleAnimationMs(DELETE_BURST_ANIMATION_MS, animationSpeed), maxParticleEnd) + scaleAnimationMs(80, animationSpeed));
    }

    return () => {
        if (isDone) {
            return;
        }

        animations.forEach((animation) => animation.cancel());
        finish();
    };
};

const getTreeYearRange = (treeData: Map<number, number | null> | undefined): [number, number] | null => {
    if (!treeData) return null;
    let start: number | undefined;
    let end: number | undefined;

    for (const [year, width] of treeData.entries()) {
        if (width === stopMarker.value) continue;
        if (start === undefined || year < start) start = year;
        if (end === undefined || year > end) end = year;
    }

    return start !== undefined && end !== undefined ? [start, end] : null;
};

const getFirstSeriesYear = (treeData: Map<number, number | null>) => {
    let firstYear: number | undefined;

    treeData.forEach((_, year) => {
        firstYear = firstYear === undefined ? year : Math.min(firstYear, year);
    });

    return firstYear;
};

const getFirstYearAfterInsert = (
    treeData: Map<number, number | null> | undefined,
    currentYear: number,
    side: PlusSide,
) => {
    const nextYears = getEditableTreeYears(treeData).map((year) => (
        side === "left"
            ? (year >= currentYear ? year + 1 : year)
            : (year <= currentYear ? year - 1 : year)
    ));

    nextYears.push(currentYear);
    return nextYears.length > 0 ? Math.min(...nextYears) : undefined;
};

const getFirstYearAfterDelete = (
    treeData: Map<number, number | null> | undefined,
    deletedYear: number,
    shift: DeleteShift,
) => {
    const nextYears = getEditableTreeYears(treeData)
        .filter((year) => year !== deletedYear)
        .map((year) => {
            if (shift === "left") {
                return year > deletedYear ? year - 1 : year;
            }

            return year < deletedYear ? year + 1 : year;
        });

    return nextYears.length > 0 ? Math.min(...nextYears) : undefined;
};

const getMoveAnimationYears = (
    selectedStartYear: number,
    selectedEndYear: number,
    yearOffset: number,
    direction: "undo" | "redo",
) => {
    const sourceStart = direction === "redo" ? selectedStartYear : selectedStartYear + yearOffset;
    const sourceEnd = direction === "redo" ? selectedEndYear : selectedEndYear + yearOffset;
    const targetStart = direction === "redo" ? selectedStartYear + yearOffset : selectedStartYear;
    const targetEnd = direction === "redo" ? selectedEndYear + yearOffset : selectedEndYear;
    const targetSelection = normalizeSelection("", targetStart, targetEnd);

    return {
        movedYears: getYearRange(targetStart, targetEnd),
        gapYears: getYearRange(sourceStart, sourceEnd).filter((year) => (
            year < targetSelection.startYear || year > targetSelection.endYear
        )),
    };
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
    /** COFECHA PART 7 各序列与主序列的整体相关性，键为大写序列号。 */
    masterCorrelations?: Map<string, number>,
    /** COFECHA PART 7 各序列的潜在问题分段数（Flags），键为大写序列号。 */
    seriesProblemCounts?: Map<string, number>,
    selected?: string,
    historyAnimation?: WidthHistoryAnimation | null,
    jumpTarget?: GridJumpTarget | null,
    editHighlightTarget?: GridEditHighlightTarget | null,
    deleteSeriesRequest?: { id: number; tree: string } | null,
    deletionMarkers?: RwlDeletionMarkers,
    onYearClick?: (tree: string, year: number) => void,
    onInsertMissingYearAtSide?: (tree: string, year: number, side: PlusSide) => void,
    onMoveSeriesTailByOffset?: (tree: string, selectedStartYear: number, selectedEndYear: number, yearOffset: number) => void,
    onDeleteYearWithMode?: (tree: string, year: number, mode: DeleteMode, shift?: DeleteShift) => void,
    onMarkYearRangeAsMissing?: (tree: string, startYear: number, endYear: number) => void,
    onRestoreDeletion?: (tree: string, markerYear: number, index: number) => void,
    onDeleteSeries?: (tree: string) => void,
    onEditAsText?: () => void,
    onJumpToCofecha?: (tree: string) => void,
    /** 拥有 PART 6 潜在问题块的序列集合（小写），决定是否显示“在 COFECHA 中定位”。 */
    cofechaPart6Trees?: ReadonlySet<string>,
    onDeleteSeriesRequestHandled?: (id: number) => void,
    onReplaceTreeData?: (tree: string, data: Map<number, number | null>) => void,
    scrollContainerRef?: RefObject<HTMLElement | null>,
    /** Actual scrolling element. Preferred over scrollContainerRef when provided. */
    scrollElement?: HTMLElement | null
};

interface ContextMenuState {
    tree: string;
    year: number;
    startYear: number;
    endYear: number;
    x: number;
    y: number;
}

function WidthGridHeader(): ReactNode {
    return (
        <div className={style["grid-header"]} data-grid-header aria-hidden="true">
            <div className={`${style["grid-header-cell"]} ${style["grid-header-sid"]}`}>序列</div>
            <div className={`${style["grid-header-cell"]} ${style["grid-header-yr"]}`}>年份</div>
            {Array.from({ length: VALUE_COLUMN_COUNT }, (_, i) => (
                <div key={i} className={`${style["grid-header-cell"]} ${style["grid-header-val"]}`}>
                    <span>{i}</span>
                </div>
            ))}
        </div>
    );
}

export function WidthGridSkeleton(): ReactNode {
    return (
        <div className={style["width-grid-container"]}>
            <WidthGridHeader />
        </div>
    );
}

function createSeriesShatterAnimation(rect: { left: number; top: number; width: number; height: number }, animationSpeed = 1): () => void {
    const COLS = 24;
    const ROWS = Math.max(3, Math.round((rect.height / rect.width) * COLS * 2.4));
    const tileW = rect.width / COLS;
    const tileH = rect.height / ROWS;

    // overflow:hidden 让向上飞出容器顶部的碎片被裁切，形成"顶部压碎"视觉
    const container = document.createElement("div");
    Object.assign(container.style, {
        position: "fixed",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        pointerEvents: "none",
        zIndex: "50",
        overflow: "hidden",
    });
    document.body.appendChild(container);

    const animations: Animation[] = [];

    // 所有碎片向上飞，汇聚压碎于容器顶部内侧
    const crushCenterY = tileH * 0.5;

    for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
            const tile = document.createElement("div");

            const rowT = row / Math.max(1, ROWS - 1); // 0=顶部, 1=底部
            const colT = col / Math.max(1, COLS - 1);

            // 每块碎片中心的起始 Y，向上运动到 crushCenterY（负值 = 向上）
            const startCenterY = row * tileH + tileH / 2;
            const riseY = crushCenterY - startCenterY; // 负数，向上

            // 水平轻微抖动
            const jitterX = (Math.random() - 0.5) * 10;

            // 延迟：底部行最先响应（下方力量最先到达），从下到上依次激活
            // rowT=1(底部) delay≈85ms，rowT=0(顶部) delay≈140ms
            const delay = scaleAnimationMs(85 + (1 - rowT) * 15 + colT * 18 + Math.random() * 30, animationSpeed);

            // 上升时长：底部行上升距离最长，时长最长
            const riseDuration = scaleAnimationMs(140 + rowT * 220, animationSpeed); // 底部360ms，顶部140ms
            const squishDuration = scaleAnimationMs(60, animationSpeed);
            const fadeDuration = scaleAnimationMs(100, animationSpeed);
            const totalDuration = riseDuration + squishDuration + fadeDuration;

            const riseEnd = riseDuration / totalDuration;
            const squishEnd = (riseDuration + squishDuration) / totalDuration;

            const gray = Math.floor(90 + Math.random() * 130);
            const alpha = 0.7 + Math.random() * 0.25;

            Object.assign(tile.style, {
                position: "absolute",
                left: `${col * tileW}px`,
                top: `${row * tileH}px`,
                width: `${tileW + 0.5}px`,
                height: `${tileH + 0.5}px`,
                background: `rgba(${gray}, ${gray}, ${gray}, ${alpha})`,
                borderRadius: "1px",
                transformOrigin: "center center",
            });
            container.appendChild(tile);

            const anim = tile.animate(
                [
                    // 起始：原位，下方力量开始上推
                    {
                        transform: "translate(0, 0) scaleX(1) scaleY(1)",
                        opacity: alpha,
                        offset: 0,
                        easing: "cubic-bezier(0.4, 0, 1, 1)", // 加速上冲
                    },
                    // 撞上顶部压碎区
                    {
                        transform: `translate(${jitterX}px, ${riseY}px) scaleX(1) scaleY(1)`,
                        opacity: alpha,
                        offset: riseEnd,
                        easing: "linear",
                    },
                    // 被顶部压扁：横向扩散，纵向消失
                    {
                        transform: `translate(${jitterX}px, ${riseY}px) scaleX(2.4) scaleY(0.06)`,
                        opacity: alpha * 0.4,
                        offset: squishEnd,
                        easing: "ease-out",
                    },
                    // 消散
                    {
                        transform: `translate(${jitterX}px, ${riseY}px) scaleX(2.8) scaleY(0)`,
                        opacity: 0,
                        offset: 1,
                    },
                ],
                { duration: totalDuration, delay, fill: "both" },
            );
            animations.push(anim);
        }
    }

    return () => {
        animations.forEach((a) => { try { a.cancel(); } catch { /* ignore */ } });
        container.remove();
    };
}

function WidthContainer({
    siteData: site,
    masterSeries,
    masterCorrelations,
    seriesProblemCounts,
    selected,
    historyAnimation,
    jumpTarget,
    editHighlightTarget,
    deleteSeriesRequest,
    deletionMarkers,
    onYearClick,
    onInsertMissingYearAtSide,
    onMoveSeriesTailByOffset,
    onDeleteYearWithMode,
    onMarkYearRangeAsMissing,
    onRestoreDeletion,
    onDeleteSeries,
    onEditAsText,
    onJumpToCofecha,
    cofechaPart6Trees,
    onDeleteSeriesRequestHandled,
    onReplaceTreeData,
    scrollContainerRef,
    scrollElement
}: WidthContainerProps): ReactNode {
    const visibleSite = useMemo(() => (
        selected && site.has(selected)
            ? (() => {
                const treeData = site.get(selected);
                return treeData ? new Map([[selected, treeData]]) : new Map<string, Map<number, number | null>>();
            })()
            : site
    ), [selected, site]);
    const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
    const [selection, setSelection] = useState<GridSelection | null>(null);
    const [dragYearOffset, setDragYearOffset] = useState(0);
    const [isDraggingSelection, setIsDraggingSelection] = useState(false);
    const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
    const [animationPlan, setAnimationPlan] = useState<GridAnimationPlan | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [hoveredMarker, setHoveredMarker] = useState<DeletionHoverState | null>(null);
    const [deletingTree, setDeletingTree] = useState<string | null>(null);
    const [textEditTree, setTextEditTree] = useState<string | null>(null);
    const [jumpHighlight, setJumpHighlight] = useState<GridJumpTarget | null>(null);
    const [editHighlight, setEditHighlight] = useState<{ id: number; keys: Set<string> } | null>(null);
    const seriesBlockRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const seriesDeleteCleanupRef = useRef<(() => void) | null>(null);
    const jumpHighlightTimerRef = useRef<number | null>(null);
    const handledJumpIdRef = useRef<number | null>(null);
    const editHighlightTimerRef = useRef<number | null>(null);
    const handledEditIdRef = useRef<number | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const interactionRef = useRef<GridInteraction | null>(null);
    const animationPlanIdRef = useRef(0);
    const handledHistoryAnimationIdRef = useRef<number | null>(null);
    const pendingInsertFlipRef = useRef<PendingInsertFlip | null>(null);
    const insertAnimationCleanupRef = useRef<Array<() => void>>([]);
    const deleteBurstCleanupRef = useRef<Array<() => void>>([]);
    const previousVisibleSiteRef = useRef<RwlSiteData | null>(null);

    const { settings } = useSettings();
    const {
        enabled: animationSwitch,
        deleteSeries: deleteSeriesAnim,
        deleteYear: deleteYearAnim,
        insertYear: insertYearAnim,
        historyAnim: historyAnimSetting,
        speed: rawAnimationSpeed,
    } = settings.animation;
    const animationSpeed = normalizeAnimationSpeed(rawAnimationSpeed);
    const seriesDeleteAnimationMs = scaleAnimationMs(SERIES_DELETE_ANIMATION_MS, animationSpeed);
    const animationsEnabled = animationSwitch === "enabled";
    const shouldAnimateHistory = animationsEnabled && historyAnimSetting === "enabled";
    const shouldAnimateInsertYear = animationsEnabled && insertYearAnim !== "none";
    const shouldAnimateDeleteYear = animationsEnabled && deleteYearAnim !== "none";
    const shouldAnimateDeleteSeries = animationsEnabled && deleteSeriesAnim !== "none";
    const shouldUseFlightShift = insertYearAnim === "flight-shift";
    const insertCellMotion = insertYearAnim === "side-pop-shift"
        ? "side-pop"
        : insertYearAnim === "pulse-shift"
            ? "pulse"
            : "rise";

    const showAnimationPlan = useCallback((plan: GridAnimationPlanInput) => {
        animationPlanIdRef.current += 1;
        setAnimationPlan({
            id: animationPlanIdRef.current,
            shiftedCells: [],
            rollingCells: [],
            elevatedYears: [],
            ...plan,
        });
    }, []);

    const clearInsertAnimations = useCallback(() => {
        insertAnimationCleanupRef.current.forEach((cleanup) => cleanup());
        insertAnimationCleanupRef.current = [];
    }, []);

    const clearDeleteBurstAnimations = useCallback(() => {
        deleteBurstCleanupRef.current.forEach((cleanup) => cleanup());
        deleteBurstCleanupRef.current = [];
    }, []);

    useEffect(() => {
        if (animationsEnabled) {
            return;
        }

        pendingInsertFlipRef.current = null;
        clearInsertAnimations();
        clearDeleteBurstAnimations();
        seriesDeleteCleanupRef.current?.();
        seriesDeleteCleanupRef.current = null;
        setAnimationPlan(null);
        setDeletingTree(null);
    }, [animationsEnabled, clearDeleteBurstAnimations, clearInsertAnimations]);

    const renderSite = useMemo(() => {
        if (!dragPreview?.hasMoved || dragPreview.yearOffset === 0) {
            return visibleSite;
        }

        const treeData = visibleSite.get(dragPreview.tree);
        if (!treeData) {
            return visibleSite;
        }

        const nextSite = new Map(visibleSite);
        nextSite.set(
            dragPreview.tree,
            previewMoveSeriesTailByOffset(treeData, dragPreview.startYear, dragPreview.endYear, dragPreview.yearOffset)
        );
        return nextSite;
    }, [dragPreview, visibleSite]);

    const virtualSeries = useMemo(() => {
        const seriesList: VirtualSeries[] = [];
        let currentTop = 0;

        for (const [key, value] of renderSite.entries()) {
            const timeline = buildTimeline(Array.from(value.entries()));
            if (timeline.length === 0) {
                continue;
            }

            const seriesRows = buildSeriesRows(key, timeline);
            const blockHeight = SERIES_HEADER_HEIGHT + ROW_GAP + seriesRows.length * ROW_HEIGHT + Math.max(0, seriesRows.length - 1) * ROW_GAP;

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
    }, [renderSite]);

    const seriesYearRanges = useMemo(() => {
        const result = new Map<string, [number, number] | null>();
        for (const [treeCode, treeData] of renderSite.entries()) {
            result.set(treeCode, getTreeYearRange(treeData));
        }
        return result;
    }, [renderSite]);

    const renderSelection = useMemo(() => {
        if (!dragPreview?.hasMoved || dragPreview.yearOffset === 0) {
            return selection;
        }

        return normalizeSelection(
            dragPreview.tree,
            dragPreview.startYear + dragPreview.yearOffset,
            dragPreview.endYear + dragPreview.yearOffset
        );
    }, [dragPreview, selection]);

    const selectedYears = useMemo(() => {
        const years = new Set<number>();

        if (!renderSelection) {
            return years;
        }

        for (let year = renderSelection.startYear; year <= renderSelection.endYear; year++) {
            years.add(year);
        }

        return years;
    }, [renderSelection]);

    const animationLookup = useMemo(() => {
        if (!animationsEnabled || !animationPlan) {
            return null;
        }

        return {
            tree: animationPlan.tree,
            insertSide: animationPlan.insertSide,
            insertedYears: new Set(animationPlan.insertedYears),
            shiftedYears: new Set(animationPlan.shiftedYears),
            movedYears: new Set(animationPlan.movedYears),
            gapYears: new Set(animationPlan.gapYears),
            overwrittenYears: new Set(animationPlan.overwrittenYears),
            shiftedDelays: new Map(animationPlan.shiftedCells.map((cell) => [cell.year, cell.delaySeconds])),
            shiftedOffsets: new Map(
                animationPlan.shiftedCells
                    .filter((cell) => cell.offsetX !== undefined || cell.offsetY !== undefined)
                    .map((cell) => [
                        cell.year,
                        { x: cell.offsetX ?? 0, y: cell.offsetY ?? 0 },
                    ])
            ),
            crossRowShiftedYears: new Set(
                animationPlan.shiftedCells
                    .filter((cell) => cell.crossRow)
                    .map((cell) => cell.year)
            ),
            edgeFadeYears: new Set(
                animationPlan.shiftedCells
                    .filter((cell) => cell.edgeFade)
                    .map((cell) => cell.year)
            ),
            rollingCells: new Map(animationPlan.rollingCells.map((cell) => [cell.year, cell.fromValue])),
            elevatedYears: new Set(animationPlan.elevatedYears),
        };
    }, [animationsEnabled, animationPlan]);

    const getGridAnimationKind = useCallback((tree: string, year: number): GridAnimationKind | undefined => {
        if (!animationLookup || animationLookup.tree !== tree) {
            return undefined;
        }

        if (animationLookup.insertedYears.has(year)) {
            return animationLookup.insertSide === "right" ? "insert-right" : "insert-left";
        }

        if (animationLookup.shiftedYears.has(year)) {
            const isCrossRowShift = animationLookup.crossRowShiftedYears.has(year);
            const isEdgeFade = animationLookup.edgeFadeYears.has(year);

            if (animationLookup.insertSide === "right") {
                if (isEdgeFade) return "insert-edge-fade-left";
                return isCrossRowShift ? "insert-cross-row-shift-left" : "insert-shift-left";
            }

            if (isEdgeFade) return "insert-edge-fade-right";
            return isCrossRowShift ? "insert-cross-row-shift-right" : "insert-shift-right";
        }

        if (animationLookup.overwrittenYears.has(year)) {
            return "overwrite";
        }

        if (animationLookup.movedYears.has(year)) {
            return "move-target";
        }

        if (animationLookup.gapYears.has(year)) {
            return "move-gap";
        }

        return undefined;
    }, [animationLookup]);

    const getGridAnimationDelay = useCallback((tree: string, year: number) => (
        animationLookup && animationLookup.tree === tree ? animationLookup.shiftedDelays.get(year) ?? 0 : 0
    ), [animationLookup]);

    const getGridAnimationOffset = useCallback((tree: string, year: number) => (
        animationLookup && animationLookup.tree === tree ? animationLookup.shiftedOffsets.get(year) : undefined
    ), [animationLookup]);

    const buildDeleteHistoryRollingTargets = useCallback((
        tree: string,
        year: number,
        mode: DeleteMode,
        direction: RwlHistoryAnimation["direction"],
        shift: DeleteShift = "right",
    ) => {
        const previousTreeData = previousVisibleSiteRef.current?.get(tree);
        const currentTreeData = visibleSite.get(tree);
        const rollingCells: RollingCellAnimation[] = [];
        const addTarget = (targetYear: number, previousYear: number) => {
            addRollingTargetIfChanged(
                rollingCells,
                targetYear,
                previousTreeData?.get(previousYear),
                currentTreeData?.get(targetYear),
            );
        };

        if (shift === "left") {
            // 右侧向左靠：左邻 (year-1) 位置不变；右邻 (year+1) 收紧后落到 year。
            if (direction === "undo") {
                if (mode === "left" || mode === "both") addTarget(year - 1, year - 1);
                if (mode === "right" || mode === "both") addTarget(year + 1, year);
            } else {
                if (mode === "left" || mode === "both") addTarget(year - 1, year - 1);
                if (mode === "right" || mode === "both") addTarget(year, year + 1);
            }
        } else if (direction === "undo") {
            if (mode === "left" || mode === "both") addTarget(year - 1, year);
            if (mode === "right" || mode === "both") addTarget(year + 1, year + 1);
        } else {
            if (mode === "left" || mode === "both") addTarget(year, year - 1);
            if (mode === "right" || mode === "both") addTarget(year + 1, year + 1);
        }

        return rollingCells;
    }, [visibleSite]);

    useEffect(() => {
        if (!animationPlan) {
            return;
        }

        const timerId = window.setTimeout(() => {
            setAnimationPlan((previous) => previous?.id === animationPlan.id ? null : previous);
        }, getAnimationPlanTimeoutMs(animationPlan, animationSpeed));

        return () => {
            window.clearTimeout(timerId);
        };
    }, [animationPlan, animationSpeed]);

    useLayoutEffect(() => {
        if (!jumpTarget) {
            return;
        }

        // 同一次跳转只处理一次：后续因数据/虚拟列表变化导致的重渲染（如进出文本编辑）
        // 不应再次滚动并高亮，否则会出现多余的跳转动画。
        if (handledJumpIdRef.current === jumpTarget.id) {
            return;
        }

        const targetSeries = virtualSeries.series.find((series) => series.treeCode === jumpTarget.tree);
        const scrollContainer = scrollElement ?? scrollContainerRef?.current;

        if (!targetSeries || !scrollContainer) {
            return;
        }

        const isSeriesJump = jumpTarget.year === undefined;
        const rowIndex = isSeriesJump
            ? 0
            : targetSeries.rows.findIndex((row) => (
                row.cells.some((cell) => cell?.year === jumpTarget.year)
            ));

        if (rowIndex < 0) {
            return;
        }

        handledJumpIdRef.current = jumpTarget.id;

        const rowTop = isSeriesJump
            ? targetSeries.top
            : targetSeries.top + SERIES_HEADER_HEIGHT + ROW_GAP + rowIndex * (ROW_HEIGHT + ROW_GAP);
        // 序列跳转时让序列顶部贴近模块上缘（仅留少量留白），避免整段序列落在视图中部偏下；
        // 单元格跳转仍保留约 35% 的前导空间，便于看到目标年份上方的上下文。
        const viewportLead = isSeriesJump
            ? 100
            : Math.max(56, Math.floor(scrollContainer.clientHeight * 0.35));
        const maxScrollTop = Math.max(
            0,
            Math.max(scrollContainer.scrollHeight, virtualSeries.totalHeight) - scrollContainer.clientHeight,
        );
        const nextScrollTop = Math.min(Math.max(rowTop - viewportLead, 0), maxScrollTop);

        interactionRef.current = null;
        setDragPreview(null);
        setDragYearOffset(0);
        setIsDraggingSelection(false);
        setContextMenu(null);
        const targetYear = jumpTarget.year;

        if (targetYear === undefined) {
            const yearRange = seriesYearRanges.get(jumpTarget.tree);
            setSelection(yearRange ? normalizeSelection(jumpTarget.tree, yearRange[0], yearRange[1]) : null);
        } else {
            setSelection(normalizeSelection(jumpTarget.tree, targetYear, targetYear));
        }
        setJumpHighlight(jumpTarget);

        const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const scrollBehavior: ScrollBehavior = prefersReducedMotion ? "auto" : "smooth";

        scrollContainer.scrollTo({ top: nextScrollTop, behavior: scrollBehavior });

        if (scrollBehavior === "auto") {
            setViewport({
                scrollTop: nextScrollTop,
                height: scrollContainer.clientHeight,
            });
        }

        if (jumpHighlightTimerRef.current !== null) {
            window.clearTimeout(jumpHighlightTimerRef.current);
        }

        jumpHighlightTimerRef.current = window.setTimeout(() => {
            setJumpHighlight((previous) => (
                previous?.id === jumpTarget.id ? null : previous
            ));
            jumpHighlightTimerRef.current = null;
        }, COFECHA_JUMP_HIGHLIGHT_MS);
    }, [jumpTarget, scrollElement, scrollContainerRef, seriesYearRanges, virtualSeries.series, virtualSeries.totalHeight]);

    // 文本编辑提交后：高亮被改动的格子，并滚动到最上面那条被改动的序列。
    // 与跳转一样按 id 去重，避免数据/虚拟列表变化引发的重渲染重复触发。
    useLayoutEffect(() => {
        if (!editHighlightTarget) {
            return;
        }
        if (handledEditIdRef.current === editHighlightTarget.id) {
            return;
        }

        const targetSeries = virtualSeries.series.find((series) => series.treeCode === editHighlightTarget.scrollTree);
        const scrollContainer = scrollElement ?? scrollContainerRef?.current;
        if (!targetSeries || !scrollContainer) {
            return;
        }

        const scrollYear = editHighlightTarget.scrollYear;
        const rowIndex = scrollYear === undefined
            ? 0
            : targetSeries.rows.findIndex((row) => row.cells.some((cell) => cell?.year === scrollYear));
        if (rowIndex < 0) {
            return;
        }

        handledEditIdRef.current = editHighlightTarget.id;

        const rowTop = targetSeries.top + SERIES_HEADER_HEIGHT + ROW_GAP + rowIndex * (ROW_HEIGHT + ROW_GAP);
        const viewportLead = Math.max(56, Math.floor(scrollContainer.clientHeight * 0.35));
        const maxScrollTop = Math.max(
            0,
            Math.max(scrollContainer.scrollHeight, virtualSeries.totalHeight) - scrollContainer.clientHeight,
        );
        const nextScrollTop = Math.min(Math.max(rowTop - viewportLead, 0), maxScrollTop);

        interactionRef.current = null;
        setDragPreview(null);
        setDragYearOffset(0);
        setIsDraggingSelection(false);
        setContextMenu(null);
        setSelection(null);
        setEditHighlight({
            id: editHighlightTarget.id,
            keys: new Set(editHighlightTarget.cells.map((cell) => `${cell.tree} ${cell.year}`)),
        });

        const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const scrollBehavior: ScrollBehavior = prefersReducedMotion ? "auto" : "smooth";
        scrollContainer.scrollTo({ top: nextScrollTop, behavior: scrollBehavior });

        if (scrollBehavior === "auto") {
            setViewport({
                scrollTop: nextScrollTop,
                height: scrollContainer.clientHeight,
            });
        }

        if (editHighlightTimerRef.current !== null) {
            window.clearTimeout(editHighlightTimerRef.current);
        }

        editHighlightTimerRef.current = window.setTimeout(() => {
            setEditHighlight((previous) => (
                previous?.id === editHighlightTarget.id ? null : previous
            ));
            editHighlightTimerRef.current = null;
        }, COFECHA_JUMP_HIGHLIGHT_MS);
    }, [editHighlightTarget, scrollElement, scrollContainerRef, virtualSeries.series, virtualSeries.totalHeight]);

    useEffect(() => {
        setSelection((previous) => (
            previous && visibleSite.has(previous.tree) ? previous : null
        ));
    }, [visibleSite]);

    useEffect(() => () => {
        if (jumpHighlightTimerRef.current !== null) {
            window.clearTimeout(jumpHighlightTimerRef.current);
        }
        if (editHighlightTimerRef.current !== null) {
            window.clearTimeout(editHighlightTimerRef.current);
        }
    }, []);

    useLayoutEffect(() => {
        if (!historyAnimation) {
            return;
        }

        if (handledHistoryAnimationIdRef.current === historyAnimation.id) {
            return;
        }

        handledHistoryAnimationIdRef.current = historyAnimation.id;
        pendingInsertFlipRef.current = null;
        clearInsertAnimations();

        if (!shouldAnimateHistory) return;
        // replace-all-data（整库替换）没有单序列位移动画，这里不处理。
        if (historyAnimation.type === "replace-all-data") return;

        // 撤回/重做时数据已改、DOM 已是「操作后」状态。用 prev/current 数据算首年，
        // 把每个 target 年份反推出 source 年份（sourceYear = targetYear - 位移方向），
        // 交给 buildHistoryShiftPlan 做绕列分类并从布局反推 col0 淡出 ghost，与插入/删除/恢复一致。
        const prevTreeData = previousVisibleSiteRef.current?.get(historyAnimation.tree);
        const curTreeData = visibleSite.get(historyAnimation.tree);
        const firstYearBefore = prevTreeData ? getFirstSeriesYear(prevTreeData) : undefined;
        const firstYearAfter = curTreeData ? getFirstSeriesYear(curTreeData) : undefined;
        const applyHistoryShift = (shiftedYears: number[], insertSide: PlusSide, shiftAnchorTargetYear: number) => {
            const direction = insertSide === "right" ? -1 : 1;
            const shiftTargets = shiftedYears.map((targetYear) => ({ sourceYear: targetYear - direction, targetYear }));
            const afterElements = containerRef.current
                ? getTreeYearGridElements(containerRef.current, historyAnimation.tree)
                : new Map<number, HTMLElement>();
            const plan = buildHistoryShiftPlan({
                afterElements,
                ghostClassName: style["width-grid"],
                prevTreeData,
                shiftTargets,
                firstYearBefore,
                firstYearAfter,
                shiftAnchorTargetYear,
            });
            pendingInsertFlipRef.current = { tree: historyAnimation.tree, side: insertSide, cells: plan.ghostCells };
            return plan;
        };

        if (historyAnimation.type === "insert-missing") {
            const sourceElements = containerRef.current
                ? getTreeYearGridElements(containerRef.current, historyAnimation.tree)
                : new Map<number, HTMLElement>();
            const shiftedYears = Array.from(sourceElements.keys()).filter((year) => (
                isYearOnInsertSide(year, historyAnimation.year, historyAnimation.side)
            ));
            const visualSide = historyAnimation.direction === "undo"
                ? getOppositeSide(historyAnimation.side)
                : historyAnimation.side;
            const plan = applyHistoryShift(shiftedYears, visualSide, getInsertShiftAnchorTargetYear(historyAnimation.year, visualSide));

            showAnimationPlan({
                tree: historyAnimation.tree,
                insertSide: visualSide,
                insertedYears: historyAnimation.direction === "redo" ? [historyAnimation.year] : [],
                shiftedYears: plan.shiftedYears,
                shiftedCells: plan.shiftedCells,
                movedYears: [],
                gapYears: [],
                overwrittenYears: [],
            });
            return;
        }

        if (historyAnimation.type === "move-selection") {
            const { movedYears, gapYears } = getMoveAnimationYears(
                historyAnimation.selectedStartYear,
                historyAnimation.selectedEndYear,
                historyAnimation.yearOffset,
                historyAnimation.direction,
            );

            showAnimationPlan({
                tree: historyAnimation.tree,
                insertedYears: [],
                shiftedYears: [],
                movedYears,
                gapYears,
                overwrittenYears: [],
            });
            return;
        }

        if (historyAnimation.type === "delete-year") {
            const sourceElements = containerRef.current
                ? getTreeYearGridElements(containerRef.current, historyAnimation.tree)
                : new Map<number, HTMLElement>();
            const currentYears = Array.from(sourceElements.keys());
            const deleteShift: DeleteShift = historyAnimation.shift ?? "right";
            const rollingCells = buildDeleteHistoryRollingTargets(
                historyAnimation.tree,
                historyAnimation.year,
                historyAnimation.mode,
                historyAnimation.direction,
                deleteShift,
            );

            if (historyAnimation.direction === "undo") {
                // Undo 还原被删年份；其余格子滑回去。shift="left" 时是 "right" 的镜像。
                if (deleteShift === "left") {
                    const shiftedYears = currentYears.filter((y) => y >= historyAnimation.year).map((y) => y + 1);
                    const plan = applyHistoryShift(shiftedYears, "left", historyAnimation.year + 1);
                    showAnimationPlan({
                        tree: historyAnimation.tree,
                        insertSide: "left",
                        insertedYears: [historyAnimation.year],
                        shiftedYears: plan.shiftedYears,
                        shiftedCells: plan.shiftedCells,
                        movedYears: [],
                        gapYears: [],
                        overwrittenYears: [],
                        rollingCells,
                    });
                } else {
                    const shiftedYears = currentYears.filter((y) => y < historyAnimation.year);
                    const plan = applyHistoryShift(shiftedYears, "right", getRestoreShiftAnchorTargetYear(historyAnimation.year));
                    showAnimationPlan({
                        tree: historyAnimation.tree,
                        insertSide: "right",
                        insertedYears: [historyAnimation.year],
                        shiftedYears: plan.shiftedYears,
                        shiftedCells: plan.shiftedCells,
                        movedYears: [],
                        gapYears: [],
                        overwrittenYears: [],
                        rollingCells,
                    });
                }
            } else if (deleteShift === "left") {
                // Redo 重新应用 "左靠" 删除；右侧格子向左滑入缺口。
                const shiftedYears = currentYears.filter((y) => y >= historyAnimation.year);
                const plan = applyHistoryShift(shiftedYears, "right", getDeleteShiftAnchorTargetYear(historyAnimation.year));
                showAnimationPlan({
                    tree: historyAnimation.tree,
                    insertSide: "right",
                    insertedYears: [],
                    shiftedYears: plan.shiftedYears,
                    shiftedCells: plan.shiftedCells,
                    movedYears: [],
                    gapYears: [],
                    overwrittenYears: [],
                    rollingCells,
                });
            } else {
                // Redo re-applies the delete; cells slide right to fill the gap.
                const shiftedYears = currentYears.filter((y) => y <= historyAnimation.year);
                const plan = applyHistoryShift(shiftedYears, "left", getDeleteShiftAnchorTargetYear(historyAnimation.year));
                showAnimationPlan({
                    tree: historyAnimation.tree,
                    insertSide: "left",
                    insertedYears: [],
                    shiftedYears: plan.shiftedYears,
                    shiftedCells: plan.shiftedCells,
                    movedYears: [],
                    gapYears: [],
                    overwrittenYears: [],
                    rollingCells,
                });
            }
        }
    }, [buildDeleteHistoryRollingTargets, clearInsertAnimations, historyAnimation, showAnimationPlan, shouldAnimateHistory, visibleSite]);

    useLayoutEffect(() => {
        previousVisibleSiteRef.current = visibleSite;
    }, [visibleSite]);

    useLayoutEffect(() => {
        const pendingInsertFlip = pendingInsertFlipRef.current;
        const container = containerRef.current;

        if (!pendingInsertFlip || !container) {
            return;
        }

        pendingInsertFlipRef.current = null;
        clearInsertAnimations();

        const containerRect = container.getBoundingClientRect();
        const cleanups: Array<() => void> = [];
        // 绕列格子离开旧格时留一个淡出的 source-exit ghost，填住首列、不让 col0 突兀留白。
        // 它原地淡出（不横向漂移）——首列紧挨着 year 列（只隔一个格距），向左滑哪怕一点都会压住 year 标签；
        // 改用低 z-index：让滑入的新值盖在它上面，二者错开、也不会叠成「9̲811」。
        const createSourceExitGhost = (cell: InsertFlipCell) => {
            const ghost = document.createElement("span");
            ghost.className = cell.sourceClassName;
            ghost.textContent = cell.sourceText;
            ghost.setAttribute("style", cell.sourceStyleText);
            ghost.style.position = "absolute";
            ghost.style.left = `${cell.sourceRect.left - containerRect.left}px`;
            ghost.style.top = `${cell.sourceRect.top - containerRect.top}px`;
            ghost.style.width = `${cell.sourceRect.width}px`;
            ghost.style.height = `${cell.sourceRect.height}px`;
            ghost.style.lineHeight = `${cell.sourceRect.height}px`;
            ghost.style.pointerEvents = "none";
            ghost.style.transform = "translate3d(0, 0, 0)";
            ghost.style.willChange = "opacity, transform";
            ghost.style.backfaceVisibility = "hidden";
            ghost.style.textAlign = "center";
            // 低于滑入格子的 z-index(3)，让新值滑过来时盖住它；仍高于静态内容，空着的 col0 处可见
            ghost.style.zIndex = "2";
            container.appendChild(ghost);

            const driftDirection = pendingInsertFlip.side === "right" ? -1 : 1;
            const drift = Math.min(28, Math.max(14, cell.sourceRect.width * 0.55));
            const earlyDrift = driftDirection < 0 ? -Math.min(5.5, drift) : Math.min(12, drift);
            const animation = ghost.animate(driftDirection < 0 ? [
                { opacity: 1, transform: "translate3d(0, 0, 0)", offset: 0 },
                { opacity: 0.18, transform: `translate3d(${earlyDrift}px, 0, 0)`, offset: 0.24 },
                { opacity: 0, transform: `translate3d(${-drift}px, 0, 0)`, offset: 1 },
            ] : [
                { opacity: 1, transform: "translate3d(0, 0, 0)", offset: 0 },
                { opacity: 0.48, transform: `translate3d(${earlyDrift}px, 0, 0)`, offset: 0.34 },
                { opacity: 0, transform: `translate3d(${drift}px, 0, 0)`, offset: 1 },
            ], {
                duration: scaleAnimationMs(CROSS_ROW_SOURCE_EXIT_MS, animationSpeed),
                easing: CROSS_ROW_SOURCE_EXIT_EASING,
                delay: scaleAnimationMs(cell.delaySeconds * 1000, animationSpeed),
                fill: "both",
            });
            let isDone = false;
            const finish = () => {
                if (isDone) {
                    return;
                }

                isDone = true;
                ghost.remove();
            };
            const cleanup = () => {
                if (!isDone) {
                    animation.cancel();
                    finish();
                }
            };

            animation.addEventListener("finish", finish, { once: true });
            animation.addEventListener("cancel", finish, { once: true });
            cleanups.push(cleanup);
        };

        pendingInsertFlip.cells.forEach(createSourceExitGhost);

        insertAnimationCleanupRef.current = cleanups;
    }, [animationPlan?.id, animationSpeed, clearInsertAnimations, visibleSite]);

    useEffect(() => () => {
        clearInsertAnimations();
        clearDeleteBurstAnimations();
    }, [clearDeleteBurstAnimations, clearInsertAnimations]);

    const handleYearClick = useCallback((tree: string, year: number) => {
        if (onYearClick) {
            onYearClick(tree, year);
        }
    }, [onYearClick]);

    // 红线和 ghost 是兄弟元素而非父子，鼠标在它们之间移动时会先触发红线 mouseLeave，
    // 用一个小延迟保证 ghost mouseEnter 能在 hovered 被清掉之前把它取消。
    const hoverClearTimerRef = useRef<number | null>(null);
    const cancelHoverClear = useCallback(() => {
        if (hoverClearTimerRef.current !== null) {
            window.clearTimeout(hoverClearTimerRef.current);
            hoverClearTimerRef.current = null;
        }
    }, []);
    const scheduleHoverClear = useCallback(() => {
        cancelHoverClear();
        hoverClearTimerRef.current = window.setTimeout(() => {
            setHoveredMarker(null);
            hoverClearTimerRef.current = null;
        }, 80);
    }, [cancelHoverClear]);

    const handleDeletionMarkHoverChange = useCallback((tree: string, year: number, hovered: boolean, element: HTMLElement | null, side: "left" | "right" = "left") => {
        if (!hovered) {
            scheduleHoverClear();
            return;
        }
        cancelHoverClear();

        const container = containerRef.current;
        const markEl = element;
        if (!container || !markEl) return;

        const treeMarkers = deletionMarkers?.get(tree);
        if (!treeMarkers || !treeMarkers.has(year)) return;

        // 找连续 marker 的整个区间。
        let runStart = year;
        while (treeMarkers.has(runStart - 1)) runStart -= 1;
        let runEnd = year;
        while (treeMarkers.has(runEnd + 1)) runEnd += 1;

        // 查询区间内每个 marker 对应的右邻 cell DOM 位置。
        const cells = getTreeYearGridElements(container, tree);
        const containerRect = container.getBoundingClientRect();
        const items: DeletionHoverItem[] = [];
        for (let y = runStart; y <= runEnd; y++) {
            if (y === year && side === "right") {
                const anchorCell = markEl.closest<HTMLElement>("[data-width-grid-cell='true']");
                const rect = anchorCell?.getBoundingClientRect();
                if (!rect) continue;
                items.push({
                    year: y,
                    anchorLeft: rect.right - containerRect.left,
                    anchorTop: rect.top - containerRect.top,
                    anchorHeight: rect.height,
                    cellWidth: rect.width,
                    side: "right",
                });
                continue;
            }

            const cell = cells.get(y);
            if (!cell) continue;
            const rect = cell.getBoundingClientRect();
            items.push({
                year: y,
                anchorLeft: rect.left - containerRect.left,
                anchorTop: rect.top - containerRect.top,
                anchorHeight: rect.height,
                cellWidth: rect.width,
                side: "left",
            });
        }
        if (items.length === 0) return;

        setHoveredMarker({
            tree,
            hoveredYear: year,
            items,
        });
    }, [deletionMarkers, cancelHoverClear, scheduleHoverClear]);

    // 每条红线只预览「最近一次删除」那一个 ghost（双击即恢复它）；stackSize 用于显示 ×N 角标，
    // 提示这条缝隙还叠了几层、可继续按后进先出逐层恢复。
    const hoveredMarkerRun = useMemo(() => {
        if (!hoveredMarker || !deletionMarkers) return null;
        const treeMarkers = deletionMarkers.get(hoveredMarker.tree);
        if (!treeMarkers) return null;
        type Entry = {
            item: DeletionHoverItem;
            info: DeletionMarkerInfo;
            stackSize: number;
        };
        const result: Entry[] = [];
        hoveredMarker.items.forEach((item) => {
            const stack = treeMarkers.get(item.year);
            if (!stack || stack.length === 0) return;
            const topInfo = stack.reduce((best, info, index) => (
                (info.deleteOrder ?? index) > (best.deleteOrder ?? -Infinity) ? info : best
            ), stack[0]);
            result.push({ item, info: topInfo, stackSize: stack.length });
        });
        return result;
    }, [hoveredMarker, deletionMarkers]);

    // 恢复完成后用同一个 animationPlan 描述插入格、滑动格和邻居数字回滚。
    // 被恢复的格子只做插入反馈，不进入 rollingCells，避免恢复值本身跳动。
    // 恢复会镜像还原删除：shift="right" 时把 year < markerYear 的格子整体 -1（插回 markerYear-1，其余向左滑）；
    // shift="left" 时把 year >= markerYear 的格子整体 +1（插回 markerYear，其余向右滑）。
    // 返回喂给 buildShiftPlan 所需的全部输入（在 flushSync 之前调用，拿到的是恢复前的 DOM/数据）。
    const getRestoreShiftPlanInput = useCallback((tree: string, markerYear: number, shiftSide: DeleteShift = "right") => {
        const sourceElements = containerRef.current
            ? getTreeYearGridElements(containerRef.current, tree)
            : new Map<number, HTMLElement>();
        const shiftTargets = Array.from(sourceElements.keys())
            .filter((year) => shiftSide === "left" ? year >= markerYear : year < markerYear)
            .map((sourceYear) => ({
                sourceYear,
                targetYear: shiftSide === "left" ? sourceYear + 1 : sourceYear - 1,
            }));
        const restoredYear = shiftSide === "left" ? markerYear : markerYear - 1;
        const shiftAnchorTargetYear = shiftSide === "left" ? restoredYear + 1 : restoredYear - 1;
        const treeData = visibleSite.get(tree);
        const firstYearBefore = treeData ? getFirstSeriesYear(treeData) : undefined;
        const firstYearAfter = firstYearBefore === undefined
            ? restoredYear
            : shiftSide === "left"
                ? Math.min(firstYearBefore, markerYear)
                : (firstYearBefore < markerYear ? firstYearBefore - 1 : markerYear - 1);
        const side: PlusSide = shiftSide === "left" ? "left" : "right";
        return { sourceElements, shiftTargets, restoredYear, shiftAnchorTargetYear, firstYearBefore, firstYearAfter, side };
    }, [visibleSite]);

    const triggerRestoreAnimation = useCallback((
        tree: string,
        restoredYear: number,
        side: PlusSide,
        shiftedYears: number[],
        shiftedCells: ShiftedCellAnimation[],
        rollingCells: RollingCellAnimation[] = [],
    ) => {
        showAnimationPlan({
            tree,
            insertSide: side,
            insertedYears: [restoredYear],
            shiftedYears,
            shiftedCells,
            movedYears: [],
            gapYears: [],
            overwrittenYears: [],
            rollingCells,
        });
    }, [showAnimationPlan]);

    // 恢复顶层删除时，让被减回注入宽度的那个邻居跳动；被恢复格本身不进 rollingCells。
    const buildRestoreRollingCells = useCallback((tree: string, markerYear: number, info: DeletionMarkerInfo | undefined, shiftSide: DeleteShift = "right") => {
        const treeData = visibleSite.get(tree);
        const rollingCells: RollingCellAnimation[] = [];
        if (!treeData || !info) return rollingCells;

        const addNeighborRollingTarget = (targetYear: number, fromYear: number, injected: number) => {
            if (!injected) return;
            const fromValue = treeData.get(fromYear);
            const numericFromValue = getRollingWidthValue(fromValue);
            if (numericFromValue === undefined) return;
            addRollingTargetIfChanged(rollingCells, targetYear, fromValue, numericFromValue - injected);
        };

        // 恢复后左右邻所在坐标随填补方向镜像（与 edit.ts 的 restoreDeletion 一致）：
        // - shift="right"：左邻 markerYear-1 → markerYear-2，右邻留在 markerYear。
        // - shift="left"：左邻留在 markerYear-1，右邻 markerYear → markerYear+1。
        const leftInjected = info.leftContribution ?? 0;
        const rightInjected = info.rightContribution ?? 0;
        if (shiftSide === "left") {
            addNeighborRollingTarget(markerYear - 1, markerYear - 1, leftInjected);
            addNeighborRollingTarget(markerYear + 1, markerYear, rightInjected);
        } else {
            addNeighborRollingTarget(markerYear - 2, markerYear - 1, leftInjected);
            addNeighborRollingTarget(markerYear, markerYear, rightInjected);
        }

        return rollingCells;
    }, [visibleSite]);

    // 双击红线（或其顶层 ghost）：严格后进先出，恢复该缝隙最近一次删除（deleteOrder 最大的那层）。
    const handleRedLineDoubleClick = useCallback((tree: string, markerYear: number) => {
        const stack = deletionMarkers?.get(tree)?.get(markerYear);
        if (!stack || stack.length === 0) return;
        const topIndex = stack.reduce((bestIndex, info, index) => {
            const bestOrder = stack[bestIndex]?.deleteOrder ?? bestIndex;
            const order = info.deleteOrder ?? index;
            return order > bestOrder ? index : bestIndex;
        }, 0);
        const topInfo = stack[topIndex];
        const shiftSide: DeleteShift = topInfo?.shiftSide ?? "right";
        setHoveredMarker(null);

        if (!shouldAnimateHistory) {
            onRestoreDeletion?.(tree, markerYear, topIndex);
            return;
        }

        const input = getRestoreShiftPlanInput(tree, markerYear, shiftSide);
        const plan = buildShiftPlan({
            shiftTargets: input.shiftTargets,
            sourceElements: input.sourceElements,
            firstYearBefore: input.firstYearBefore,
            firstYearAfter: input.firstYearAfter,
            shiftAnchorTargetYear: input.shiftAnchorTargetYear,
            useFlightShift: shouldUseFlightShift,
        });
        pendingInsertFlipRef.current = { tree, side: input.side, cells: plan.ghostCells };
        const rollingCells = buildRestoreRollingCells(tree, markerYear, topInfo, shiftSide);
        flushSync(() => {
            onRestoreDeletion?.(tree, markerYear, topIndex);
            triggerRestoreAnimation(tree, input.restoredYear, input.side, plan.shiftedYears, plan.shiftedCells, rollingCells);
        });
    }, [onRestoreDeletion, deletionMarkers, shouldAnimateHistory, getRestoreShiftPlanInput, shouldUseFlightShift, buildRestoreRollingCells, triggerRestoreAnimation]);

    // 纯 opt-in：只有被 handler 明确标记过的格子才使用 RollingNumber。
    // 不再基于 marker 邻接自动启用，避免拖动预览时不相关的格子跟着跳动。
    const isRollingCell = useCallback((tree: string, year: number) => (
        Boolean(animationLookup && animationLookup.tree === tree && animationLookup.rollingCells.has(year))
    ), [animationLookup]);

    const getRollingFromValue = useCallback((tree: string, year: number) => (
        animationLookup && animationLookup.tree === tree ? animationLookup.rollingCells.get(year) : undefined
    ), [animationLookup]);

    const handleInsertMissingYearAtSide = useCallback((tree: string, year: number, side: PlusSide) => {
        if (!shouldAnimateInsertYear) {
            onInsertMissingYearAtSide?.(tree, year, side);
            return;
        }

        const treeData = visibleSite.get(tree);
        const container = containerRef.current;
        let shiftedYears: number[] = [];
        let shiftedCells: ShiftedCellAnimation[] = [];
        const shiftAnchorTargetYear = getInsertShiftAnchorTargetYear(year, side);

        pendingInsertFlipRef.current = null;

        if (container) {
            const sourceElements = getTreeYearGridElements(container, tree);
            const shiftTargets = getVisibleInsertShiftTargets(sourceElements, year, side);
            const plan = buildShiftPlan({
                shiftTargets,
                sourceElements,
                firstYearBefore: treeData ? getFirstSeriesYear(treeData) : undefined,
                firstYearAfter: getFirstYearAfterInsert(treeData, year, side),
                shiftAnchorTargetYear,
                useFlightShift: shouldUseFlightShift,
            });
            shiftedYears = plan.shiftedYears;
            shiftedCells = plan.shiftedCells;
            pendingInsertFlipRef.current = { tree, side, cells: plan.ghostCells };
        }

        flushSync(() => {
            onInsertMissingYearAtSide?.(tree, year, side);
            showAnimationPlan({
                tree,
                insertSide: side,
                insertedYears: [year],
                shiftedYears,
                shiftedCells,
                movedYears: [],
                gapYears: [],
                overwrittenYears: [],
            });
        });
    }, [onInsertMissingYearAtSide, showAnimationPlan, visibleSite, shouldAnimateInsertYear, shouldUseFlightShift]);

    const clearSelection = useCallback(() => {
        interactionRef.current = null;
        setSelection(null);
        setDragPreview(null);
        setDragYearOffset(0);
        setIsDraggingSelection(false);
    }, []);

    const handleContainerPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target;

        if (target instanceof Element && target.closest("[data-width-grid-cell='true']")) {
            return;
        }

        clearSelection();
    }, [clearSelection]);

    const handleContainerContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        const cell = target.closest<HTMLElement>("[data-width-grid-cell='true']");
        if (!cell) {
            return;
        }

        const tree = cell.dataset.tree;
        const rawYear = cell.dataset.year;
        if (!tree || rawYear === undefined) {
            return;
        }

        const year = Number(rawYear);
        if (!Number.isFinite(year)) {
            return;
        }

        event.preventDefault();

        interactionRef.current = null;
        setDragPreview(null);
        setDragYearOffset(0);
        setIsDraggingSelection(false);
        const shouldKeepRangeSelection = Boolean(
            selection
            && selection.tree === tree
            && selection.startYear !== selection.endYear
            && year >= selection.startYear
            && year <= selection.endYear
        );
        const nextSelection = shouldKeepRangeSelection
            ? selection!
            : normalizeSelection(tree, year, year);

        setSelection(nextSelection);
        onYearClick?.(tree, year);

        const cellRect = cell.getBoundingClientRect();
        setContextMenu({
            tree,
            year,
            startYear: nextSelection.startYear,
            endYear: nextSelection.endYear,
            x: cellRect.right,
            y: cellRect.bottom,
        });
    }, [onYearClick, selection]);

    const handleContextMenuClose = useCallback(() => {
        setContextMenu(null);
    }, []);

    const handleContextMenuInsert = useCallback((tree: string, year: number, side: PlusSide) => {
        handleInsertMissingYearAtSide(tree, year, side);
    }, [handleInsertMissingYearAtSide]);

    const handleContextMenuDelete = useCallback((tree: string, year: number, mode: DeleteMode, shift: DeleteShift = "right") => {
        if (!shouldAnimateDeleteYear) {
            onDeleteYearWithMode?.(tree, year, mode, shift);
            return;
        }

        const treeData = visibleSite.get(tree);
        const container = containerRef.current;
        let shiftedYears: number[] = [];
        let shiftedCells: ShiftedCellAnimation[] = [];
        const shiftAnchorTargetYear = getDeleteShiftAnchorTargetYear(year);
        const rollingCells = buildDeleteRollingCells(treeData, year, mode, shift);
        const rollingYears = rollingCells.map((cell) => cell.year);
        const rollingTargetSet = new Set(rollingYears);
        // shift="right"（默认）：左侧格子向右靠 → 复用 insert side="left" 的右移动画；
        // shift="left"：右侧格子向左靠 → 复用 insert side="right" 的左移动画。
        const animationInsertSide: PlusSide = shift === "left" ? "right" : "left";

        pendingInsertFlipRef.current = null;

        if (container) {
            const sourceElements = getTreeYearGridElements(container, tree);
            const deletedElement = sourceElements.get(year);
            const shiftTargets = Array.from(sourceElements.entries())
                .filter(([sourceYear]) => shift === "left" ? sourceYear > year : sourceYear < year)
                .map(([sourceYear]) => ({
                    sourceYear,
                    targetYear: shift === "left" ? sourceYear - 1 : sourceYear + 1,
                }));
            const plan = buildShiftPlan({
                shiftTargets,
                sourceElements,
                firstYearBefore: treeData ? getFirstSeriesYear(treeData) : undefined,
                firstYearAfter: getFirstYearAfterDelete(treeData, year, shift),
                shiftAnchorTargetYear,
                useFlightShift: shouldUseFlightShift,
                extraExcludedTargetYears: rollingTargetSet,
            });
            shiftedYears = plan.shiftedYears;
            shiftedCells = plan.shiftedCells;
            pendingInsertFlipRef.current = { tree, side: animationInsertSide, cells: plan.ghostCells };

            if (deletedElement) {
                clearDeleteBurstAnimations();
                const cleanup = createDeletePixelBurst(container, deletedElement, animationSpeed);
                if (cleanup) {
                    deleteBurstCleanupRef.current = [cleanup];
                }
            }
        }

        // 先把 mode 会改变值的邻居登记为 rolling，
        // 让它们在数据更新前先以 RollingNumber 状态呈现；下一帧数据改变时
        // RollingNumber 的 value prop 变化就能触发数字跳动。
        // 收紧后接收分配宽度的那一格需要短暂的 z-index 提升，
        // 让它在 slide-in 动画期间盖在滑入格子之上，随 animationPlan 一起清掉：
        // - shift="right"：left/both 时 year 处接收左邻的值。
        // - shift="left"：right/both 时 year 处接收右邻的值。
        const elevatedYears = shift === "left"
            ? (mode === "right" || mode === "both" ? [year] : [])
            : (mode === "left" || mode === "both" ? [year] : []);

        flushSync(() => {
            onDeleteYearWithMode?.(tree, year, mode, shift);
            showAnimationPlan({
                tree,
                insertSide: animationInsertSide,
                insertedYears: [],
                shiftedYears,
                shiftedCells,
                movedYears: [],
                gapYears: [],
                overwrittenYears: [],
                rollingCells,
                elevatedYears,
            });
        });
    }, [animationSpeed, clearDeleteBurstAnimations, onDeleteYearWithMode, showAnimationPlan, visibleSite, shouldAnimateDeleteYear, shouldUseFlightShift]);

    const handleContextMenuDeleteRange = useCallback((tree: string, startYear: number, endYear: number) => {
        const nextSelection = normalizeSelection(tree, startYear, endYear);

        pendingInsertFlipRef.current = null;
        clearInsertAnimations();
        clearDeleteBurstAnimations();
        setAnimationPlan(null);
        setSelection(nextSelection);
        onMarkYearRangeAsMissing?.(tree, nextSelection.startYear, nextSelection.endYear);
    }, [clearDeleteBurstAnimations, clearInsertAnimations, onMarkYearRangeAsMissing]);

    const handleContextMenuEditAsText = useCallback((tree: string) => {
        setContextMenu(null);
        if (onEditAsText) {
            onEditAsText();
            return;
        }
        setTextEditTree(tree);
    }, [onEditAsText]);

    const handleContextMenuJumpToCofecha = useCallback((tree: string) => {
        setContextMenu(null);
        onJumpToCofecha?.(tree);
    }, [onJumpToCofecha]);

    const handleTextEditorClose = useCallback((tree: string, newText?: string) => {
        setTextEditTree(null);
        if (newText === undefined) return;
        const treeData = visibleSite.get(tree);
        if (!treeData) return;
        const parsed = textToSeriesData(newText, stopMarker.value);
        if (!parsed) return;
        onReplaceTreeData?.(tree, parsed);
    }, [visibleSite, onReplaceTreeData]);

    const handleContextMenuDeleteSeries = useCallback((tree: string) => {
        setContextMenu(null);
        if (!shouldAnimateDeleteSeries) {
            onDeleteSeries?.(tree);
            return;
        }
        const el = seriesBlockRefs.current.get(tree);
        if (!el) {
            onDeleteSeries?.(tree);
            return;
        }
        if (deleteSeriesAnim === "shatter-rise") {
            const rect = el.getBoundingClientRect();
            seriesDeleteCleanupRef.current?.();
            seriesDeleteCleanupRef.current = createSeriesShatterAnimation(
                { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                animationSpeed,
            );
        }
        setDeletingTree(tree);
    }, [animationSpeed, onDeleteSeries, deleteSeriesAnim, shouldAnimateDeleteSeries]);

    useEffect(() => {
        if (!deleteSeriesRequest) {
            return;
        }

        handleContextMenuDeleteSeries(deleteSeriesRequest.tree);
        onDeleteSeriesRequestHandled?.(deleteSeriesRequest.id);
    }, [deleteSeriesRequest, handleContextMenuDeleteSeries, onDeleteSeriesRequestHandled]);

    useEffect(() => {
        if (!deletingTree) return;
        const timer = setTimeout(() => {
            seriesDeleteCleanupRef.current?.();
            seriesDeleteCleanupRef.current = null;
            onDeleteSeries?.(deletingTree);
            setDeletingTree(null);
        }, seriesDeleteAnimationMs);
        return () => {
            clearTimeout(timer);
            seriesDeleteCleanupRef.current?.();
            seriesDeleteCleanupRef.current = null;
        };
    }, [deletingTree, onDeleteSeries, seriesDeleteAnimationMs]);

    // 同步压缩序列块的高度，让布局跟随动画收缩（下方序列平滑上移）
    useLayoutEffect(() => {
        if (!deletingTree) return;
        const el = seriesBlockRefs.current.get(deletingTree);
        if (!el) return;

        const currentHeight = el.getBoundingClientRect().height;
        el.style.height = `${currentHeight}px`;
        el.style.overflow = "hidden";

        let raf1: number;
        let raf2: number;
        raf1 = requestAnimationFrame(() => {
            raf2 = requestAnimationFrame(() => {
                el.style.transition = `height ${seriesDeleteAnimationMs}ms cubic-bezier(0.6, 0, 1, 1), margin-top ${seriesDeleteAnimationMs}ms cubic-bezier(0.6, 0, 1, 1)`;
                el.style.height = "0";
                el.style.marginTop = "0";
            });
        });

        return () => {
            cancelAnimationFrame(raf1);
            cancelAnimationFrame(raf2);
            el.style.height = "";
            el.style.overflow = "";
            el.style.transition = "";
            el.style.marginTop = "";
        };
    }, [deletingTree, seriesDeleteAnimationMs]);

    const handleContextMenuPreviewYearChange = useCallback((tree: string, year: number) => {
        setSelection(normalizeSelection(tree, year, year));
        onYearClick?.(tree, year);
    }, [onYearClick]);

    const handleContextMenuPreviewYearRangeChange = useCallback((tree: string, startYear: number, endYear: number) => {
        const nextSelection = normalizeSelection(tree, startYear, endYear);
        setSelection(nextSelection);
        onYearClick?.(tree, nextSelection.startYear);
    }, [onYearClick]);

    const handleGridPointerDown = useCallback((event: React.PointerEvent<HTMLSpanElement>, tree: string, year: number) => {
        if (event.button !== 0) {
            return;
        }

        setDragPreview(null);
        setDragYearOffset(0);
        setIsDraggingSelection(false);

        if (event.shiftKey && selection?.tree === tree) {
            setSelection(normalizeSelection(tree, selection.startYear, year));
            interactionRef.current = { mode: "select", tree, anchorYear: selection.startYear, pointerId: event.pointerId };
            return;
        }

        const isSelectedCell = isYearInSelection(selection, tree, year);

        const shouldMoveSelection = isSelectedCell && (selectedYears.size > 1 || event.altKey);

        if (shouldMoveSelection) {
            const rect = event.currentTarget.getBoundingClientRect();
            interactionRef.current = {
                mode: "move",
                tree,
                startYear: selection!.startYear,
                endYear: selection!.endYear,
                clickedYear: year,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                columnStride: rect.width + GRID_GAP,
                rowStride: rect.height + ROW_GAP,
                yearOffset: 0,
                hasMoved: false,
            };
            return;
        }

        setSelection(normalizeSelection(tree, year, year));
        interactionRef.current = { mode: "select", tree, anchorYear: year, pointerId: event.pointerId };
    }, [selectedYears.size, selection]);

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            const interaction = interactionRef.current;

            if (!interaction || interaction.pointerId !== event.pointerId) {
                return;
            }

            if (interaction.mode === "select") {
                const cell = getGridCellFromPoint(event.clientX, event.clientY);

                if (cell && cell.tree === interaction.tree) {
                    setSelection(normalizeSelection(interaction.tree, interaction.anchorYear, cell.year));
                }

                return;
            }

            const deltaX = event.clientX - interaction.startX;
            const deltaY = event.clientY - interaction.startY;
            const deltaColumn = Math.round(deltaX / interaction.columnStride);
            const deltaRow = Math.round(deltaY / interaction.rowStride);
            const nextYearOffset = deltaColumn + deltaRow * VALUE_COLUMN_COUNT;
            const hasMoved = interaction.hasMoved || Math.hypot(deltaX, deltaY) >= DRAG_THRESHOLD_PX;

            if (hasMoved || nextYearOffset !== interaction.yearOffset || hasMoved !== interaction.hasMoved) {
                interactionRef.current = {
                    ...interaction,
                    yearOffset: nextYearOffset,
                    hasMoved,
                };
                setDragYearOffset(nextYearOffset);
                setIsDraggingSelection(hasMoved);
                setDragPreview({
                    tree: interaction.tree,
                    startYear: interaction.startYear,
                    endYear: interaction.endYear,
                    yearOffset: nextYearOffset,
                    hasMoved,
                });
            }
        };

        const handlePointerUp = (event: PointerEvent) => {
            const interaction = interactionRef.current;

            if (!interaction || interaction.pointerId !== event.pointerId) {
                return;
            }

            interactionRef.current = null;
            setDragYearOffset(0);
            setIsDraggingSelection(false);
            setDragPreview(null);

            if (interaction.mode !== "move") {
                return;
            }

            if (event.type === "pointercancel") {
                return;
            }

            if (!interaction.hasMoved) {
                setSelection(normalizeSelection(interaction.tree, interaction.clickedYear, interaction.clickedYear));
                return;
            }

            if (interaction.yearOffset === 0) {
                return;
            }

            const targetSelection = normalizeSelection(
                interaction.tree,
                interaction.startYear + interaction.yearOffset,
                interaction.endYear + interaction.yearOffset
            );
            const movedYears = getYearRange(targetSelection.startYear, targetSelection.endYear);
            const gapYears = getYearRange(interaction.startYear, interaction.endYear).filter((year) => (
                year < targetSelection.startYear || year > targetSelection.endYear
            ));
            const treeData = visibleSite.get(interaction.tree);
            const originalSelectedYears = new Set(getYearRange(interaction.startYear, interaction.endYear));
            const overwrittenYears = treeData
                ? Array.from(treeData.entries())
                    .filter(([year, width]) => (
                        width !== stopMarker.value
                        && year >= interaction.startYear
                        && year <= interaction.endYear
                    ))
                    .map(([year]) => year + interaction.yearOffset)
                    .filter((targetYear) => {
                        const existingValue = treeData.get(targetYear);
                        return existingValue !== undefined
                            && existingValue !== stopMarker.value
                            && !originalSelectedYears.has(targetYear);
                    })
                : [];

            flushSync(() => {
                onMoveSeriesTailByOffset?.(interaction.tree, interaction.startYear, interaction.endYear, interaction.yearOffset);
                setSelection(targetSelection);
                if (animationsEnabled) {
                    showAnimationPlan({
                        tree: interaction.tree,
                        insertedYears: [],
                        shiftedYears: [],
                        movedYears,
                        gapYears,
                        overwrittenYears,
                    });
                }
            });
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                clearSelection();
            }
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        window.addEventListener("keydown", handleKeyDown);

        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [animationsEnabled, clearSelection, onMoveSeriesTailByOffset, showAnimationPlan, visibleSite]);

    useEffect(() => {
        const scrollContainer = scrollElement ?? scrollContainerRef?.current;
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
    }, [scrollElement, scrollContainerRef, virtualSeries.totalHeight]);

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
        <div
            ref={containerRef}
            className={style["width-grid-container"]}
            onPointerDown={handleContainerPointerDown}
            onContextMenu={handleContainerContextMenu}
        >
            <WidthGridHeader />

            {topSpacerHeight > 0 ? (
                <div
                    aria-hidden="true"
                    className={style["virtual-spacer"]}
                    style={{ height: `${topSpacerHeight}px` }}
                />
            ) : null}

            {visibleSeries.map((series, seriesIndex) => {
                const yearRange = seriesYearRanges.get(series.treeCode);
                const masterCorrelation = masterCorrelations?.get(series.treeCode.toUpperCase());
                const problemCount = seriesProblemCounts?.get(series.treeCode.toUpperCase());
                return (
                <div
                    ref={(el) => {
                        if (el) seriesBlockRefs.current.set(series.treeCode, el);
                        else seriesBlockRefs.current.delete(series.treeCode);
                    }}
                    className={`${style["series-block"]}${deletingTree === series.treeCode ? ` ${style["series-block-annihilating"]}` : ""}`}
                    key={series.treeCode}
                    style={seriesIndex > 0 ? { marginTop: `${SERIES_GAP}px` } : undefined}
                >
                    {textEditTree === series.treeCode ? (
                        <SeriesTextEditor
                            treeCode={series.treeCode}
                            initialText={seriesDataToText(visibleSite.get(series.treeCode) ?? new Map(), stopMarker.value)}
                            stopMarkerValue={stopMarker.value}
                            onClose={(newText) => handleTextEditorClose(series.treeCode, newText)}
                        />
                    ) : (
                        <>
                            <div className={style["series-header"]}>
                                <span className={style["series-header-name"]}>{series.treeCode}</span>
                                {yearRange && (
                                    <span className={style["series-header-range"]}>
                                        {yearRange[0]}–{yearRange[1]} · {yearRange[1] - yearRange[0] + 1} 年
                                    </span>
                                )}
                                {(typeof masterCorrelation === "number" || typeof problemCount === "number") && (
                                    <span className={style["series-header-stats"]}>
                                        {typeof problemCount === "number" && (
                                            <span
                                                className={`${style["series-header-problems"]}${problemCount > 0 ? ` ${style["series-header-problems-flagged"]}` : ""}`}
                                                title="该样芯被标记为潜在问题（A/B）的分段数"
                                            >
                                                problem count：{problemCount}
                                            </span>
                                        )}
                                        {typeof masterCorrelation === "number" && (
                                            <span
                                                className={style["series-header-corr"]}
                                                title="该序列与主序列的整体相关性"
                                            >
                                                r={masterCorrelation.toFixed(3)}
                                            </span>
                                        )}
                                    </span>
                                )}
                            </div>
                            {series.rows.map((row, rowIndex) => (
                        <div className={style["series-row"]} key={`${series.treeCode}-${rowIndex}-${row.startYear}`}>
                            <WidthGrid gridValue={series.treeCode} style={{ textAlign: 'left', letterSpacing: '0.02em' }} title={series.treeCode} />
                            <WidthGrid gridValue={row.startYear} />

                            {row.cells.map((cell, cellIndex) => {
                                if (!cell) {
                                    return <div key={`gap-${series.treeCode}-${row.startYear}-${cellIndex}`}></div>;
                                }

                                const cellIsSelected = renderSelection?.tree === series.treeCode && selectedYears.has(cell.year);
                                const cellIsJumpMatch = Boolean(
                                    jumpHighlight
                                    && jumpHighlight.tree === series.treeCode
                                    && (jumpHighlight.year === undefined || jumpHighlight.year === cell.year)
                                );
                                const cellIsEditHighlighted = editHighlight?.keys.has(`${series.treeCode} ${cell.year}`) ?? false;
                                const cellIsJumpHighlighted = cellIsJumpMatch || cellIsEditHighlighted;
                                const cellJumpHighlightId = cellIsEditHighlighted
                                    ? editHighlight?.id
                                    : (cellIsJumpMatch ? jumpHighlight?.id : undefined);
                                const cellAnimationKind = getGridAnimationKind(series.treeCode, cell.year);
                                const cellAnimationDelay = getGridAnimationDelay(series.treeCode, cell.year);
                                const cellAnimationOffset = getGridAnimationOffset(series.treeCode, cell.year);
                                const cellAnimationKey = cellAnimationKind ? animationPlan?.id ?? 0 : 0;
                                const treeDeletionMarkers = deletionMarkers?.get(series.treeCode);
                                const rightDeletionMarkerYear = cell.year + 1;
                                const isRowFirstCell = cellIndex === 0;
                                const isRowLastCell = rowIndex < series.rows.length - 1 && cellIndex === row.cells.length - 1;
                                const hasLeftDeletionMark = Boolean(
                                    treeDeletionMarkers?.has(cell.year)
                                    && !(rowIndex > 0 && isRowFirstCell)
                                );
                                const hasRightDeletionMark = Boolean(
                                    treeDeletionMarkers?.has(rightDeletionMarkerYear)
                                    && isRowLastCell
                                );
                                // 拖动预览期间值会跟着鼠标频繁变动，这种"非操作"变更不应触发滚动；
                                // 一旦真正提交（pointerup 时调用 onMoveSeriesTailByOffset），数据写回，
                                // RollingNumber 只在 animationPlan.rollingCells 明确命中时启用。
                                const rollingDigits = !isDraggingSelection && isRollingCell(series.treeCode, cell.year);
                                const rollingFromValue = rollingDigits
                                    ? getRollingFromValue(series.treeCode, cell.year)
                                    : undefined;

                                // 仅高亮当前悬停的红线本身；hover 时不改变左右邻 cell 的值，
                                // 让 RollingNumber 只在数据真的因为撤销/恢复改动时才跳动。
                                const isDeletionMarkActive = Boolean(
                                    hoveredMarker
                                    && hoveredMarker.tree === series.treeCode
                                    && cell.year === hoveredMarker.hoveredYear
                                );
                                const isRightDeletionMarkActive = Boolean(
                                    hoveredMarker
                                    && hoveredMarker.tree === series.treeCode
                                    && rightDeletionMarkerYear === hoveredMarker.hoveredYear
                                );

                                if (cell.isInterruptPad) {
                                    return (
                                        <WidthGrid
                                            key={`interrupt-${series.treeCode}-${cell.year}-${cellAnimationKey}`}
                                            gridValue="missing"
                                            year={cell.year}
                                            tree={series.treeCode}
                                            masterSeriesValue={masterSeries?.get(cell.year)}
                                            isMissing={true}
                                            isSelected={cellIsSelected}
                                            isJumpHighlighted={cellIsJumpHighlighted}
                                            jumpHighlightId={cellJumpHighlightId}
                                            isDragging={isDraggingSelection && cellIsSelected}
                                            dragYearOffset={dragYearOffset}
                                            animationKind={cellAnimationKind}
                                            animationDelay={cellAnimationDelay}
                                            animationOffset={cellAnimationOffset}
                                            insertCellMotion={insertCellMotion}
                                            animationSpeed={animationSpeed}
                                            hasLeftDeletionMark={hasLeftDeletionMark}
                                            hasRightDeletionMark={hasRightDeletionMark}
                                            rightDeletionMarkerYear={rightDeletionMarkerYear}
                                            isDeletionMarkActive={isDeletionMarkActive}
                                            isRightDeletionMarkActive={isRightDeletionMarkActive}
                                            data-width-grid-cell="true"
                                            data-tree={series.treeCode}
                                            data-year={cell.year}
                                            onPointerDown={(event) => handleGridPointerDown(event, series.treeCode, cell.year)}
                                            onDeletionMarkHoverChange={handleDeletionMarkHoverChange}
                                            onDeletionMarkDoubleClick={handleRedLineDoubleClick}
                                        />
                                    );
                                }

                                if (cell.width === stopMarker.value) {
                                    return <WidthGrid gridValue={cell.width} key={`stop-${series.treeCode}-${cell.year}`} />;
                                }

                                const effectiveValue = cell.width ?? null;
                                // 滑入动画期间被原地保留的格子（典型为 left/both 删除时的 year M），
                                // 需要 z-index 提升，避免被其它 slide-in 格子盖住；这是临时状态，
                                // CSS 动画结束后 animationPlan 自动清空。
                                const isRollingFocused = Boolean(
                                    animationLookup
                                    && animationLookup.tree === series.treeCode
                                    && animationLookup.elevatedYears.has(cell.year)
                                );

                                return (
                                    <WidthGrid
                                        key={`value-${series.treeCode}-${cell.year}-${cellAnimationKey}`}
                                        gridValue={effectiveValue}
                                        year={cell.year}
                                        tree={series.treeCode}
                                        masterSeriesValue={masterSeries?.get(cell.year)}
                                        isEditable={true}
                                        isSelected={cellIsSelected}
                                        isJumpHighlighted={cellIsJumpHighlighted}
                                        jumpHighlightId={cellJumpHighlightId}
                                        isDragging={isDraggingSelection && cellIsSelected}
                                        dragYearOffset={dragYearOffset}
                                        animationKind={cellAnimationKind}
                                        animationDelay={cellAnimationDelay}
                                        animationOffset={cellAnimationOffset}
                                        insertCellMotion={insertCellMotion}
                                        animationSpeed={animationSpeed}
                                        hasLeftDeletionMark={hasLeftDeletionMark}
                                        hasRightDeletionMark={hasRightDeletionMark}
                                        rightDeletionMarkerYear={rightDeletionMarkerYear}
                                        isDeletionMarkActive={isDeletionMarkActive}
                                        isRightDeletionMarkActive={isRightDeletionMarkActive}
                                        rollingDigits={rollingDigits}
                                        rollingFromValue={rollingFromValue}
                                        style={isRollingFocused ? { zIndex: 4, backgroundColor: '#ffffff' } : undefined}
                                        data-width-grid-cell="true"
                                        data-tree={series.treeCode}
                                        data-year={cell.year}
                                        onPointerDown={(event) => handleGridPointerDown(event, series.treeCode, cell.year)}
                                        onInsertMissingYearAtSide={handleInsertMissingYearAtSide}
                                        onYearClick={handleYearClick}
                                        onDeletionMarkHoverChange={handleDeletionMarkHoverChange}
                                        onDeletionMarkDoubleClick={handleRedLineDoubleClick}
                                    />
                                );
                            })}

                            {Array.from({ length: 10 - row.cells.length }, (_, emptyIndex) => (
                                <div key={`tail-empty-${series.treeCode}-${rowIndex}-${emptyIndex}`}></div>
                            ))}
                        </div>
                    ))}
                        </>
                    )}
                </div>
                );
            })}

            {bottomSpacerHeight > 0 ? (
                <div
                    aria-hidden="true"
                    className={style["virtual-spacer"]}
                    style={{ height: `${bottomSpacerHeight}px` }}
                />
            ) : null}

            {hoveredMarkerRun && typeof document !== "undefined" ? createPortal(
                hoveredMarkerRun.map(({ item, info, stackSize }) => {
                    // 每条红线只预览最近一次删除的那一个 ghost，居中贴在红线上。
                    const containerRect = containerRef.current?.getBoundingClientRect();
                    const left = (containerRect?.left ?? 0)
                        + item.anchorLeft
                        - item.cellWidth / 2
                        - 2.5;
                    const top = (containerRect?.top ?? 0) + item.anchorTop;

                    return (
                        <div
                            key={`${item.year}`}
                            className={`${style["deletion-preview-ghost"]} ${animationsEnabled ? "" : style["deletion-preview-ghost-static"]}`}
                            style={{
                                position: "fixed",
                                zIndex: 2147483647,
                                left: `${left}px`,
                                top: `${top}px`,
                                width: `${item.cellWidth}px`,
                                height: `${item.anchorHeight}px`,
                            }}
                            title={stackSize > 1 ? `双击恢复最近一次删除（此处共 ${stackSize} 层）` : "双击恢复"}
                            onMouseEnter={cancelHoverClear}
                            onMouseLeave={scheduleHoverClear}
                            onDoubleClick={(event) => {
                                event.stopPropagation();
                                event.preventDefault();
                                if (hoveredMarker) {
                                    handleRedLineDoubleClick(hoveredMarker.tree, item.year);
                                }
                            }}
                        >
                            {info.deletedWidth === null
                                ? <span>missing</span>
                                : <RollingNumber value={info.deletedWidth} speed={animationSpeed} />}
                            {stackSize > 1 ? (
                                <span className={style["deletion-preview-ghost-count"]}>×{stackSize}</span>
                            ) : null}
                        </div>
                    );
                }),
                document.body,
            ) : null}


            <WidthGridContextMenu
                open={contextMenu !== null}
                x={contextMenu?.x ?? 0}
                y={contextMenu?.y ?? 0}
                tree={contextMenu?.tree ?? ""}
                defaultYear={contextMenu?.year ?? 0}
                defaultDeleteStartYear={contextMenu?.startYear ?? contextMenu?.year ?? 0}
                defaultDeleteEndYear={contextMenu?.endYear ?? contextMenu?.year ?? 0}
                onInsert={handleContextMenuInsert}
                onDelete={handleContextMenuDelete}
                onDeleteRange={handleContextMenuDeleteRange}
                onDeleteSeries={handleContextMenuDeleteSeries}
                onEditAsText={handleContextMenuEditAsText}
                onJumpToCofecha={onJumpToCofecha ? handleContextMenuJumpToCofecha : undefined}
                canJumpToCofecha={Boolean(contextMenu && cofechaPart6Trees?.has(contextMenu.tree.toLowerCase()))}
                onPreviewYearChange={handleContextMenuPreviewYearChange}
                onPreviewYearRangeChange={handleContextMenuPreviewYearRangeChange}
                onClose={handleContextMenuClose}
            />
        </div>
    );
}

export default memo(WidthContainer);

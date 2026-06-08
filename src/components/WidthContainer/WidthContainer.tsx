import { memo, ReactNode, RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { RwlSiteData } from '@/features/rwl';
import { getDeletionStackBoundaryContributions, moveSeriesTailByOffset as previewMoveSeriesTailByOffset } from '@/features/rwl/edit';
import type { DeleteMode, DeletionMarkerInfo, RwlDeletionMarkers, RwlHistoryAnimation } from '@/features/rwl/edit';
import { RollingNumber } from '@/components/RollingNumber/RollingNumber';
import WidthGrid from './WidthGrid/WidthGrid';
import WidthGridContextMenu from './WidthGridContextMenu/WidthGridContextMenu';
import SeriesTextEditor, { seriesDataToText, textToSeriesData } from './SeriesTextEditor/SeriesTextEditor';
import style from "./WidthContainer.module.css";
import { stopMarker } from '@/shared/constants';
import { useSettings } from "@/features/settings/SettingsContext";
import { normalizeAnimationSpeed } from "@/features/settings/settings";

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
const SERIES_HEADER_HEIGHT = 36;
const SERIES_GAP = 12;
const OVERSCAN_PX = 320;
const VALUE_COLUMN_COUNT = 10;
const GRID_GAP = 5;
const DRAG_THRESHOLD_PX = 3;
const INSERT_SHIFT_ANIMATION_MS = 1250;
const INSERT_SHIFT_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
const SHIFT_STAGGER_SECONDS = 0.008;
const ANIMATION_PLAN_CLEAR_PADDING_MS = 360;
const DELETE_BURST_ANIMATION_MS = 820;
const DELETE_BURST_SWEEP_MS = 420;
const SERIES_DELETE_ANIMATION_MS = 900;
const COFECHA_JUMP_HIGHLIGHT_MS = 3200;

const scaleAnimationMs = (durationMs: number, animationSpeed: number) => (
    Math.max(1, Math.round(durationMs / animationSpeed))
);

type PlusSide = "left" | "right";
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

interface InsertFlipCell {
    sourceYear: number;
    targetYear: number;
    sourceRect: DOMRect;
    sourceText: string;
    sourceClassName: string;
    sourceStyleText: string;
    delaySeconds: number;
}

interface InsertShiftTarget {
    sourceYear: number;
    targetYear: number;
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
    | "insert-cross-row-shift-left"
    | "insert-cross-row-shift-right"
    | "move-target"
    | "move-gap"
    | "overwrite";

interface RollingCellAnimation {
    year: number;
    fromValue?: number;
}

interface ShiftedCellAnimation {
    year: number;
    delaySeconds: number;
    crossRow?: boolean;
}

interface GridAnimationPlan {
    id: number;
    tree: string;
    insertSide?: PlusSide;
    insertedYears: number[];
    shiftedYears: number[];
    movedYears: number[];
    gapYears: number[];
    overwrittenYears: number[];
    shiftedCells: ShiftedCellAnimation[];
    rollingCells: RollingCellAnimation[];
    elevatedYears: number[];
}

type GridAnimationPlanInput =
    Omit<GridAnimationPlan, "id" | "shiftedCells" | "rollingCells" | "elevatedYears">
    & Partial<Pick<GridAnimationPlan, "shiftedCells" | "rollingCells" | "elevatedYears">>;

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

const getYearOffsetWithinDecade = (year: number) => ((year % 10) + 10) % 10;

const getRollingWidthValue = (value: number | null | undefined) => (
    typeof value === "number" && value !== stopMarker.value ? value : undefined
);

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

const getUniqueYears = (years: number[]) => Array.from(new Set(years));

const getOrderedShiftQueueYears = (years: number[], anchorTargetYear: number) => (
    getUniqueYears(years).sort((yearA, yearB) => {
        const distanceA = Math.abs(yearA - anchorTargetYear);
        const distanceB = Math.abs(yearB - anchorTargetYear);

        return distanceA === distanceB ? yearA - yearB : distanceA - distanceB;
    })
);

const buildShiftedCells = (
    shiftedYears: number[],
    anchorTargetYear: number,
    crossRowYears = new Set<number>(),
): ShiftedCellAnimation[] => (
    getOrderedShiftQueueYears(shiftedYears, anchorTargetYear).map((year, index) => ({
        year,
        delaySeconds: index * SHIFT_STAGGER_SECONDS,
        crossRow: crossRowYears.has(year),
    }))
);

const getShiftDelayByYear = (shiftedCells: ShiftedCellAnimation[]) => (
    new Map(shiftedCells.map((cell) => [cell.year, cell.delaySeconds]))
);

const buildShiftQueue = (
    shiftTargets: InsertShiftTarget[],
    anchorTargetYear: number,
    crossRowYears = new Set<number>(),
    excludedTargetYears = new Set<number>(),
) => {
    const shiftedYears = getUniqueYears(shiftTargets.map(({ targetYear }) => targetYear))
        .filter((targetYear) => !excludedTargetYears.has(targetYear));
    const shiftedCells = buildShiftedCells(shiftedYears, anchorTargetYear, crossRowYears);
    const shiftDelayByYear = getShiftDelayByYear(shiftedCells);

    return { shiftedYears, shiftedCells, shiftDelayByYear };
};

const buildCrossRowGhostCells = (
    shiftTargets: InsertShiftTarget[],
    sourceElements: Map<number, HTMLElement>,
    crossRowTargetYears: Set<number>,
    shiftDelayByYear: Map<number, number>,
): InsertFlipCell[] => (
    shiftTargets
        .filter(({ targetYear }) => crossRowTargetYears.has(targetYear))
        .map(({ sourceYear, targetYear }) => {
            const sourceElement = sourceElements.get(sourceYear);

            if (!sourceElement) {
                return null;
            }

            return {
                sourceYear,
                targetYear,
                sourceRect: sourceElement.getBoundingClientRect(),
                sourceText: getGridTextContent(sourceElement),
                sourceClassName: sourceElement.className,
                sourceStyleText: sourceElement.getAttribute("style") ?? "",
                delaySeconds: shiftDelayByYear.get(targetYear) ?? 0,
            };
        })
        .filter((cell): cell is InsertFlipCell => cell !== null)
);

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

const getInsertShiftAnchorTargetYear = (year: number, side: PlusSide) => (
    side === "right" ? year - 1 : year + 1
);

const getDeleteShiftAnchorTargetYear = (year: number) => year;

const getRestoreShiftAnchorTargetYear = (year: number) => year - 1;

const buildDeleteRollingCells = (
    treeData: Map<number, number | null> | undefined,
    year: number,
    mode: DeleteMode,
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

    if (mode === "left") {
        addNeighbor(year, year - 1, deletedWidth);
    } else if (mode === "right") {
        addNeighbor(year + 1, year + 1, deletedWidth);
    } else if (mode === "both") {
        const halfWidth = Math.round(deletedWidth / 2);
        addNeighbor(year, year - 1, halfWidth);
        addNeighbor(year + 1, year + 1, halfWidth);
    }

    return rollingCells;
};

const getFirstRowBreakYear = (startYear: number) => {
    const offset = getYearOffsetWithinDecade(startYear);
    return offset === 0 ? startYear : startYear + (10 - offset);
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

const getLayoutRowStart = (firstYear: number, year: number) => {
    if (year < firstYear) {
        return year;
    }

    const firstRowBreakYear = getFirstRowBreakYear(firstYear);
    return year < firstRowBreakYear ? firstYear : year - getYearOffsetWithinDecade(year);
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

const getGridTextContent = (element: HTMLElement) => {
    const firstTextNode = Array.from(element.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
    return firstTextNode?.textContent ?? element.textContent ?? "";
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

const getVisibleInsertShiftTargets = (
    sourceElements: Map<number, HTMLElement>,
    currentYear: number,
    side: PlusSide,
): InsertShiftTarget[] => {
    const direction = side === "left" ? 1 : -1;

    return Array.from(sourceElements.entries())
        .filter(([sourceYear]) => side === "left" ? sourceYear >= currentYear : sourceYear <= currentYear)
        .map(([sourceYear]) => ({
            sourceYear,
            targetYear: sourceYear + direction,
        }));
};

const isCrossRowInsertShift = (firstYear: number, sourceYear: number, targetYear: number) => (
    getLayoutRowStart(firstYear, sourceYear) !== getLayoutRowStart(firstYear, targetYear)
);

const getCrossRowTargetYears = (
    shiftTargets: InsertShiftTarget[],
    firstYear: number | undefined,
) => {
    if (firstYear === undefined || shiftTargets.length === 0) {
        return new Set<number>();
    }

    const sourceYears = shiftTargets.map(({ sourceYear }) => sourceYear);
    const minSourceYear = Math.min(...sourceYears);
    const maxSourceYear = Math.max(...sourceYears);

    return new Set(
        shiftTargets
            .filter(({ sourceYear, targetYear }) => (
                targetYear >= minSourceYear
                && targetYear <= maxSourceYear
                && isCrossRowInsertShift(firstYear, sourceYear, targetYear)
            ))
            .map(({ targetYear }) => targetYear)
    );
};

const getOppositeSide = (side: PlusSide): PlusSide => side === "left" ? "right" : "left";

const isYearOnInsertSide = (year: number, currentYear: number, side: PlusSide) => (
    side === "left" ? year >= currentYear : year <= currentYear
);

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
    selected?: string,
    historyAnimation?: WidthHistoryAnimation | null,
    jumpTarget?: GridJumpTarget | null,
    deleteSeriesRequest?: { id: number; tree: string } | null,
    deletionMarkers?: RwlDeletionMarkers,
    onYearClick?: (tree: string, year: number) => void,
    onInsertMissingYearAtSide?: (tree: string, year: number, side: PlusSide) => void,
    onMoveSeriesTailByOffset?: (tree: string, selectedStartYear: number, selectedEndYear: number, yearOffset: number) => void,
    onDeleteYearWithMode?: (tree: string, year: number, mode: DeleteMode) => void,
    onMarkYearRangeAsMissing?: (tree: string, startYear: number, endYear: number) => void,
    onRestoreDeletion?: (tree: string, markerYear: number, index: number) => void,
    onDeleteSeries?: (tree: string) => void,
    onEditAsText?: () => void,
    onDeleteSeriesRequestHandled?: (id: number) => void,
    onReplaceTreeData?: (tree: string, data: Map<number, number | null>) => void,
    scrollContainerRef?: RefObject<HTMLElement | null>,
    /** Actual scrolling element (e.g. the OverlayScrollbars viewport). Preferred over scrollContainerRef when provided. */
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

function WidthContainer({ siteData: site, masterSeries, selected, historyAnimation, jumpTarget, deleteSeriesRequest, deletionMarkers, onYearClick, onInsertMissingYearAtSide, onMoveSeriesTailByOffset, onDeleteYearWithMode, onMarkYearRangeAsMissing, onRestoreDeletion, onDeleteSeries, onEditAsText, onDeleteSeriesRequestHandled, onReplaceTreeData, scrollContainerRef, scrollElement }: WidthContainerProps): ReactNode {
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
    const seriesBlockRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const seriesDeleteCleanupRef = useRef<(() => void) | null>(null);
    const jumpHighlightTimerRef = useRef<number | null>(null);
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
            crossRowShiftedYears: new Set(
                animationPlan.shiftedCells
                    .filter((cell) => cell.crossRow)
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

            if (animationLookup.insertSide === "right") {
                return isCrossRowShift ? "insert-cross-row-shift-left" : "insert-shift-left";
            }

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

    const buildDeleteHistoryRollingTargets = useCallback((
        tree: string,
        year: number,
        mode: DeleteMode,
        direction: RwlHistoryAnimation["direction"],
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

        if (direction === "undo") {
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

        const rowTop = isSeriesJump
            ? targetSeries.top
            : targetSeries.top + SERIES_HEADER_HEIGHT + ROW_GAP + rowIndex * (ROW_HEIGHT + ROW_GAP);
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

    useEffect(() => {
        setSelection((previous) => (
            previous && visibleSite.has(previous.tree) ? previous : null
        ));
    }, [visibleSite]);

    useEffect(() => () => {
        if (jumpHighlightTimerRef.current !== null) {
            window.clearTimeout(jumpHighlightTimerRef.current);
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
            const shiftedCells = buildShiftedCells(
                shiftedYears,
                getInsertShiftAnchorTargetYear(historyAnimation.year, visualSide),
            );

            showAnimationPlan({
                tree: historyAnimation.tree,
                insertSide: visualSide,
                insertedYears: historyAnimation.direction === "redo" ? [historyAnimation.year] : [],
                shiftedYears,
                shiftedCells,
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
            const rollingCells = buildDeleteHistoryRollingTargets(
                historyAnimation.tree,
                historyAnimation.year,
                historyAnimation.mode,
                historyAnimation.direction,
            );

            if (historyAnimation.direction === "undo") {
                // Undo restores the deleted year; cells slide back left.
                const shiftedYears = currentYears.filter((y) => y < historyAnimation.year);
                const shiftedCells = buildShiftedCells(shiftedYears, getRestoreShiftAnchorTargetYear(historyAnimation.year));
                showAnimationPlan({
                    tree: historyAnimation.tree,
                    insertSide: "right",
                    insertedYears: [historyAnimation.year],
                    shiftedYears,
                    shiftedCells,
                    movedYears: [],
                    gapYears: [],
                    overwrittenYears: [],
                    rollingCells,
                });
            } else {
                // Redo re-applies the delete; cells slide right to fill the gap.
                const shiftedYears = currentYears.filter((y) => y <= historyAnimation.year);
                const shiftedCells = buildShiftedCells(shiftedYears, getDeleteShiftAnchorTargetYear(historyAnimation.year));
                showAnimationPlan({
                    tree: historyAnimation.tree,
                    insertSide: "left",
                    insertedYears: [],
                    shiftedYears,
                    shiftedCells,
                    movedYears: [],
                    gapYears: [],
                    overwrittenYears: [],
                    rollingCells,
                });
            }
        }
    }, [buildDeleteHistoryRollingTargets, clearInsertAnimations, historyAnimation, showAnimationPlan, shouldAnimateHistory]);

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
        const direction = pendingInsertFlip.side === "right" ? -1 : 1;

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
            ghost.style.zIndex = "5";
            container.appendChild(ghost);

            const distance = cell.sourceRect.width + GRID_GAP;
            const exitDistance = direction * distance * 0.5;
            const animation = ghost.animate([
                { opacity: 1, transform: "translateX(0)" },
                { opacity: 0.42, transform: `translateX(${exitDistance * 0.6}px)`, offset: 0.46 },
                { opacity: 0, transform: `translateX(${exitDistance}px)` },
            ], {
                duration: scaleAnimationMs(INSERT_SHIFT_ANIMATION_MS, animationSpeed),
                easing: INSERT_SHIFT_EASING,
                delay: scaleAnimationMs(cell.delaySeconds * 1000, animationSpeed),
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

    // 把 hover run 内每一个 marker 的整个 stack 都展平：一个被删除的 cell 对应一个 ghost。
    // stack 自身保持空间顺序；displayIndex 只用于显示，deleteOrder 最大的 ghost 贴近红线。
    const hoveredMarkerRun = useMemo(() => {
        if (!hoveredMarker || !deletionMarkers) return null;
        const treeMarkers = deletionMarkers.get(hoveredMarker.tree);
        if (!treeMarkers) return null;
        type Entry = {
            item: DeletionHoverItem;
            info: DeletionMarkerInfo;
            index: number;
            displayIndex: number;
            stackSize: number;
        };
        const result: Entry[] = [];
        hoveredMarker.items.forEach((item) => {
            const stack = treeMarkers.get(item.year);
            if (!stack || stack.length === 0) return;
            stack
                .map((info, index) => ({ info, index }))
                .sort((a, b) => (
                    (a.info.deleteOrder ?? a.index) - (b.info.deleteOrder ?? b.index)
                ))
                .forEach(({ info, index }, displayIndex) => {
                    result.push({ item, info, index, displayIndex, stackSize: stack.length });
            });
        });
        return result;
    }, [hoveredMarker, deletionMarkers]);

    // 恢复完成后用同一个 animationPlan 描述插入格、滑动格和邻居数字回滚。
    // 被恢复的格子只做插入反馈，不进入 rollingCells，避免恢复值本身跳动。
    const getRestoreShiftedYears = useCallback((tree: string, markerYear: number) => {
        const sourceElements = containerRef.current
            ? getTreeYearGridElements(containerRef.current, tree)
            : new Map<number, HTMLElement>();

        return Array.from(sourceElements.keys())
            .filter((year) => year < markerYear)
            .map((year) => year - 1);
    }, []);

    const triggerRestoreAnimation = useCallback((tree: string, markerYear: number, shiftedYears: number[] = [], rollingCells: RollingCellAnimation[] = []) => {
        const restoredYear = markerYear - 1;
        const shiftedCells = buildShiftedCells(shiftedYears, getRestoreShiftAnchorTargetYear(restoredYear));

        showAnimationPlan({
            tree,
            insertSide: "right",
            insertedYears: [restoredYear],
            shiftedYears,
            shiftedCells,
            movedYears: [],
            gapYears: [],
            overwrittenYears: [],
            rollingCells,
        });
    }, [showAnimationPlan]);

    // 只让恢复前后边界贡献发生变化的格子跳动；不要把"被恢复格"放进 rollingCells。
    const buildRestoreRollingCells = useCallback((tree: string, markerYear: number, index: number) => {
        const treeData = visibleSite.get(tree);
        const rollingCells: RollingCellAnimation[] = [];
        const stack = deletionMarkers?.get(tree)?.get(markerYear);
        if (!treeData || !stack || index < 0 || index >= stack.length) return rollingCells;

        const leftRemainingStack = stack.slice(0, index);
        const rightRemainingStack = stack.slice(index + 1);
        const oldContributions = getDeletionStackBoundaryContributions(stack);
        const leftContributions = getDeletionStackBoundaryContributions(leftRemainingStack);
        const rightContributions = getDeletionStackBoundaryContributions(rightRemainingStack);

        const addBoundaryRollingTarget = (
            targetYear: number,
            fromYear: number,
            oldContribution: number,
            nextContribution: number,
        ) => {
            const fromValue = treeData.get(fromYear);
            const numericFromValue = getRollingWidthValue(fromValue);
            if (numericFromValue === undefined) return;
            addRollingTargetIfChanged(
                rollingCells,
                targetYear,
                fromValue,
                numericFromValue - oldContribution + nextContribution,
            );
        };

        addBoundaryRollingTarget(markerYear - 2, markerYear - 1, oldContributions.left, leftContributions.left);
        addBoundaryRollingTarget(markerYear, markerYear, oldContributions.right, rightContributions.right);

        return rollingCells;
    }, [deletionMarkers, visibleSite]);

    // 双击红线：默认恢复离红线最近的 ghost，也就是 deleteOrder 最大的那条。
    const handleRedLineDoubleClick = useCallback((tree: string, markerYear: number) => {
        const stack = deletionMarkers?.get(tree)?.get(markerYear);
        if (!stack || stack.length === 0) return;
        const latestIndex = stack.reduce((bestIndex, info, index) => {
            const bestOrder = stack[bestIndex]?.deleteOrder ?? bestIndex;
            const order = info.deleteOrder ?? index;
            return order > bestOrder ? index : bestIndex;
        }, 0);
        setHoveredMarker(null);

        if (!shouldAnimateHistory) {
            onRestoreDeletion?.(tree, markerYear, latestIndex);
            return;
        }

        const shiftedYears = getRestoreShiftedYears(tree, markerYear);
        const rollingCells = buildRestoreRollingCells(tree, markerYear, latestIndex);
        flushSync(() => {
            onRestoreDeletion?.(tree, markerYear, latestIndex);
            triggerRestoreAnimation(tree, markerYear, shiftedYears, rollingCells);
        });
    }, [onRestoreDeletion, deletionMarkers, shouldAnimateHistory, getRestoreShiftedYears, buildRestoreRollingCells, triggerRestoreAnimation]);

    // 双击具体 ghost：恢复栈中指定那条删除。
    const handleGhostDoubleClick = useCallback((tree: string, markerYear: number, index: number) => {
        const info = deletionMarkers?.get(tree)?.get(markerYear)?.[index];
        if (!info) return;
        setHoveredMarker(null);

        if (!shouldAnimateHistory) {
            onRestoreDeletion?.(tree, markerYear, index);
            return;
        }

        const shiftedYears = getRestoreShiftedYears(tree, markerYear);
        const rollingCells = buildRestoreRollingCells(tree, markerYear, index);
        flushSync(() => {
            onRestoreDeletion?.(tree, markerYear, index);
            triggerRestoreAnimation(tree, markerYear, shiftedYears, rollingCells);
        });
    }, [onRestoreDeletion, deletionMarkers, shouldAnimateHistory, getRestoreShiftedYears, buildRestoreRollingCells, triggerRestoreAnimation]);

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
            const firstYear = treeData ? getFirstSeriesYear(treeData) : undefined;
            const crossRowTargetYears = getCrossRowTargetYears(shiftTargets, firstYear);
            const shiftQueue = buildShiftQueue(shiftTargets, shiftAnchorTargetYear, crossRowTargetYears);
            shiftedYears = shiftQueue.shiftedYears;
            shiftedCells = shiftQueue.shiftedCells;
            const cells = buildCrossRowGhostCells(
                shiftTargets,
                sourceElements,
                crossRowTargetYears,
                shiftQueue.shiftDelayByYear,
            );

            pendingInsertFlipRef.current = {
                tree,
                side,
                cells,
            };
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
    }, [onInsertMissingYearAtSide, showAnimationPlan, visibleSite, shouldAnimateInsertYear]);

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

    const handleContextMenuDelete = useCallback((tree: string, year: number, mode: DeleteMode) => {
        if (!shouldAnimateDeleteYear) {
            onDeleteYearWithMode?.(tree, year, mode);
            return;
        }

        const treeData = visibleSite.get(tree);
        const container = containerRef.current;
        let shiftedYears: number[] = [];
        let shiftedCells: ShiftedCellAnimation[] = [];
        const shiftAnchorTargetYear = getDeleteShiftAnchorTargetYear(year);
        const rollingCells = buildDeleteRollingCells(treeData, year, mode);
        const rollingYears = rollingCells.map((cell) => cell.year);
        const rollingTargetSet = new Set(rollingYears);

        pendingInsertFlipRef.current = null;

        if (container) {
            const sourceElements = getTreeYearGridElements(container, tree);
            const deletedElement = sourceElements.get(year);
            const shiftTargets = Array.from(sourceElements.entries())
                .filter(([sourceYear]) => sourceYear < year)
                .map(([sourceYear]) => ({
                    sourceYear,
                    targetYear: sourceYear + 1,
                }));
            const firstYear = treeData ? getFirstSeriesYear(treeData) : undefined;
            const crossRowTargetYears = getCrossRowTargetYears(shiftTargets, firstYear);
            const animatedCrossRowTargetYears = new Set(
                Array.from(crossRowTargetYears).filter((targetYear) => !rollingTargetSet.has(targetYear))
            );
            const shiftQueue = buildShiftQueue(
                shiftTargets,
                shiftAnchorTargetYear,
                animatedCrossRowTargetYears,
                rollingTargetSet,
            );
            shiftedYears = shiftQueue.shiftedYears;
            shiftedCells = shiftQueue.shiftedCells;
            const cells = buildCrossRowGhostCells(
                shiftTargets,
                sourceElements,
                animatedCrossRowTargetYears,
                shiftQueue.shiftDelayByYear,
            );

            // Reuse insert flip mechanism: delete shifts earlier years right, same direction as insert side="left".
            pendingInsertFlipRef.current = {
                tree,
                side: "left",
                cells,
            };

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
        // - right / both: 右邻 year+1 留在原位接收 +B 或 +B/2。
        // - left / both: 删除位 year（slot M）接收来自左邻的 A+B 或 A+B/2。
        // year M（mode left/both 时被排除出 shiftedYears 的那一格）需要短暂的 z-index 提升，
        // 让它在 slide-in 动画期间盖在滑入格子之上，随 animationPlan 一起清掉。
        const elevatedYears = mode === "left" || mode === "both" ? [year] : [];

        flushSync(() => {
            onDeleteYearWithMode?.(tree, year, mode);
            showAnimationPlan({
                tree,
                insertSide: "left",
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
    }, [animationSpeed, clearDeleteBurstAnimations, onDeleteYearWithMode, showAnimationPlan, visibleSite, shouldAnimateDeleteYear]);

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
            <div className={style["grid-header"]} data-grid-header aria-hidden="true">
                <div className={`${style["grid-header-cell"]} ${style["grid-header-sid"]}`}>序列</div>
                <div className={`${style["grid-header-cell"]} ${style["grid-header-yr"]}`}>年份</div>
                {Array.from({ length: 10 }, (_, i) => (
                    <div key={i} className={`${style["grid-header-cell"]} ${style["grid-header-val"]}`}>
                        <span>{i}</span>
                    </div>
                ))}
            </div>

            {topSpacerHeight > 0 ? (
                <div
                    aria-hidden="true"
                    className={style["virtual-spacer"]}
                    style={{ height: `${topSpacerHeight}px` }}
                />
            ) : null}

            {visibleSeries.map((series, seriesIndex) => {
                const yearRange = seriesYearRanges.get(series.treeCode);
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
                                const cellIsJumpHighlighted = Boolean(
                                    jumpHighlight
                                    && jumpHighlight.tree === series.treeCode
                                    && (jumpHighlight.year === undefined || jumpHighlight.year === cell.year)
                                );
                                const cellJumpHighlightId = cellIsJumpHighlighted ? jumpHighlight?.id : undefined;
                                const cellAnimationKind = getGridAnimationKind(series.treeCode, cell.year);
                                const cellAnimationDelay = getGridAnimationDelay(series.treeCode, cell.year);
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
                hoveredMarkerRun.map(({ item, info, index, displayIndex, stackSize }) => {
                    // 同一年份多次堆叠：displayIndex = stackSize - 1 紧贴红线，
                    // 最后删除的 ghost 会排在最右侧。
                    const offset = stackSize - 1 - displayIndex;
                    const containerRect = containerRef.current?.getBoundingClientRect();
                    const left = (containerRect?.left ?? 0)
                        + item.anchorLeft
                        - item.cellWidth / 2
                        - 2.5
                        - offset * (item.cellWidth + GRID_GAP);
                    const top = (containerRect?.top ?? 0) + item.anchorTop;

                    return (
                        <div
                            key={`${item.year}-${index}`}
                            className={`${style["deletion-preview-ghost"]} ${animationsEnabled ? "" : style["deletion-preview-ghost-static"]}`}
                            style={{
                                position: "fixed",
                                zIndex: 2147483647,
                                left: `${left}px`,
                                top: `${top}px`,
                                width: `${item.cellWidth}px`,
                                height: `${item.anchorHeight}px`,
                            }}
                            title="双击恢复"
                            onMouseEnter={cancelHoverClear}
                            onMouseLeave={scheduleHoverClear}
                            onDoubleClick={(event) => {
                                event.stopPropagation();
                                event.preventDefault();
                                if (hoveredMarker) {
                                    handleGhostDoubleClick(hoveredMarker.tree, item.year, index);
                                }
                            }}
                        >
                            {info.deletedWidth === null
                                ? <span>missing</span>
                                : <RollingNumber value={info.deletedWidth} speed={animationSpeed} />}
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
                onPreviewYearChange={handleContextMenuPreviewYearChange}
                onPreviewYearRangeChange={handleContextMenuPreviewYearRangeChange}
                onClose={handleContextMenuClose}
            />
        </div>
    );
}

export default memo(WidthContainer);

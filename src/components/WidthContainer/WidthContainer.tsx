import { memo, ReactNode, RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { RwlSiteData } from '@/features/rwl';
import { moveSeriesTailByOffset as previewMoveSeriesTailByOffset } from '@/features/rwl/edit';
import type { DeleteMode, DeletionMarkerInfo, RwlDeletionMarkers, RwlHistoryAnimation } from '@/features/rwl/edit';
import { RollingNumber } from '@/components/RollingNumber/RollingNumber';
import WidthGrid from './WidthGrid/WidthGrid';
import WidthGridContextMenu from './WidthGridContextMenu/WidthGridContextMenu';
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
const VALUE_COLUMN_COUNT = 10;
const GRID_GAP = 5;
const DRAG_THRESHOLD_PX = 3;
const INSERT_SHIFT_ANIMATION_MS = 1250;
const INSERT_SHIFT_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
const DELETE_BURST_ANIMATION_MS = 820;
const DELETE_BURST_SWEEP_MS = 420;

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

interface InsertFlipCell {
    sourceYear: number;
    targetYear: number;
    sourceRect: DOMRect;
    sourceText: string;
    sourceClassName: string;
    sourceStyleText: string;
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
    | "move-target"
    | "move-gap"
    | "overwrite";

interface GridAnimationCue {
    id: number;
    tree: string;
    insertSide?: PlusSide;
    insertedYears: number[];
    shiftedYears: number[];
    movedYears: number[];
    gapYears: number[];
    overwrittenYears: number[];
}

interface DeletionHoverItem {
    year: number;
    anchorLeft: number;  // x of the right-neighbor cell's left edge, relative to container
    anchorTop: number;   // y of the right-neighbor cell's top, relative to container
    anchorHeight: number;
    cellWidth: number;
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

const createDeletePixelBurst = (container: HTMLElement, sourceElement: HTMLElement) => {
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
            duration: 180,
            easing: "ease-out",
            fill: "forwards",
        }));
        timerId = window.setTimeout(finish, 220);
    } else {
        animations.push(sourceGhost.animate([
            { clipPath: "inset(0 0 0 0)", opacity: 1, transform: "scale(1)" },
            { clipPath: "inset(0 0 0 58%)", opacity: 0.74, transform: "scale(0.98)", offset: 0.46 },
            { clipPath: "inset(0 0 0 100%)", opacity: 0.08, transform: "scale(0.92)" },
        ], {
            duration: DELETE_BURST_SWEEP_MS,
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
            duration: DELETE_BURST_SWEEP_MS + 80,
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
                const delay = column * 34 + row * 12 + Math.random() * 38;
                const duration = 430 + Math.random() * 260;
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

        timerId = window.setTimeout(finish, Math.max(DELETE_BURST_ANIMATION_MS, maxParticleEnd) + 80);
    }

    return () => {
        if (isDone) {
            return;
        }

        animations.forEach((animation) => animation.cancel());
        finish();
    };
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
    deletionMarkers?: RwlDeletionMarkers,
    onYearClick?: (tree: string, year: number) => void,
    onInsertMissingYearAtSide?: (tree: string, year: number, side: PlusSide) => void,
    onMoveSeriesTailByOffset?: (tree: string, selectedStartYear: number, selectedEndYear: number, yearOffset: number) => void,
    onDeleteYearWithMode?: (tree: string, year: number, mode: DeleteMode) => void,
    onRestoreDeletion?: (tree: string, markerYear: number, index: number) => void,
    scrollContainerRef?: RefObject<HTMLElement | null>
};

interface ContextMenuState {
    tree: string;
    year: number;
    x: number;
    y: number;
}

function WidthContainer({ siteData: site, masterSeries, selected, historyAnimation, deletionMarkers, onYearClick, onInsertMissingYearAtSide, onMoveSeriesTailByOffset, onDeleteYearWithMode, onRestoreDeletion, scrollContainerRef }: WidthContainerProps): ReactNode {
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
    const [animationCue, setAnimationCue] = useState<GridAnimationCue | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [hoveredMarker, setHoveredMarker] = useState<DeletionHoverState | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const interactionRef = useRef<GridInteraction | null>(null);
    const animationCueIdRef = useRef(0);
    const pendingInsertFlipRef = useRef<PendingInsertFlip | null>(null);
    const insertAnimationCleanupRef = useRef<Array<() => void>>([]);
    const deleteBurstCleanupRef = useRef<Array<() => void>>([]);

    const showAnimationCue = useCallback((cue: Omit<GridAnimationCue, "id">) => {
        animationCueIdRef.current += 1;
        setAnimationCue({
            id: animationCueIdRef.current,
            ...cue,
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
        if (!animationCue) {
            return null;
        }

        return {
            tree: animationCue.tree,
            insertSide: animationCue.insertSide,
            insertedYears: new Set(animationCue.insertedYears),
            shiftedYears: new Set(animationCue.shiftedYears),
            movedYears: new Set(animationCue.movedYears),
            gapYears: new Set(animationCue.gapYears),
            overwrittenYears: new Set(animationCue.overwrittenYears),
        };
    }, [animationCue]);

    const getGridAnimationKind = useCallback((tree: string, year: number): GridAnimationKind | undefined => {
        if (!animationLookup || animationLookup.tree !== tree) {
            return undefined;
        }

        if (animationLookup.insertedYears.has(year)) {
            return animationLookup.insertSide === "right" ? "insert-right" : "insert-left";
        }

        if (animationLookup.shiftedYears.has(year)) {
            return animationLookup.insertSide === "right" ? "insert-shift-left" : "insert-shift-right";
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

    useEffect(() => {
        if (!animationCue) {
            return;
        }

        const timerId = window.setTimeout(() => {
            setAnimationCue((previous) => previous?.id === animationCue.id ? null : previous);
        }, 2400);

        return () => {
            window.clearTimeout(timerId);
        };
    }, [animationCue]);

    useEffect(() => {
        setSelection((previous) => (
            previous && visibleSite.has(previous.tree) ? previous : null
        ));
    }, [visibleSite]);

    useLayoutEffect(() => {
        if (!historyAnimation) {
            return;
        }

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

            showAnimationCue({
                tree: historyAnimation.tree,
                insertSide: visualSide,
                insertedYears: historyAnimation.direction === "redo" ? [historyAnimation.year] : [],
                shiftedYears,
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

            showAnimationCue({
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

            if (historyAnimation.direction === "undo") {
                // Undo restores the deleted year; cells slide back left.
                const shiftedYears = currentYears.filter((y) => y < historyAnimation.year);
                showAnimationCue({
                    tree: historyAnimation.tree,
                    insertSide: "right",
                    insertedYears: [historyAnimation.year],
                    shiftedYears,
                    movedYears: [],
                    gapYears: [],
                    overwrittenYears: [],
                });
            } else {
                // Redo re-applies the delete; cells slide right to fill the gap.
                const shiftedYears = currentYears.filter((y) => y <= historyAnimation.year);
                showAnimationCue({
                    tree: historyAnimation.tree,
                    insertSide: "left",
                    insertedYears: [],
                    shiftedYears,
                    movedYears: [],
                    gapYears: [],
                    overwrittenYears: [],
                });
            }
        }
    }, [historyAnimation, showAnimationCue]);

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
            const animation = ghost.animate([
                { opacity: 1, transform: "translateX(0)" },
                { opacity: 0.42, transform: `translateX(${direction * distance * 0.42}px)`, offset: 0.46 },
                { opacity: 0, transform: `translateX(${direction * distance * 0.72}px)` },
            ], {
                duration: INSERT_SHIFT_ANIMATION_MS,
                easing: INSERT_SHIFT_EASING,
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
    }, [animationCue?.id, clearInsertAnimations, visibleSite]);

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

    const handleDeletionMarkHoverChange = useCallback((tree: string, year: number, hovered: boolean, element: HTMLElement | null) => {
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
            const cell = cells.get(y);
            if (!cell) continue;
            const rect = cell.getBoundingClientRect();
            items.push({
                year: y,
                anchorLeft: rect.left - containerRect.left,
                anchorTop: rect.top - containerRect.top,
                anchorHeight: rect.height,
                cellWidth: rect.width,
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
    // 同一年份多次连续删除会形成多个 stack 条目，越靠数组末端表示越晚被删除。
    const hoveredMarkerRun = useMemo(() => {
        if (!hoveredMarker || !deletionMarkers) return null;
        const treeMarkers = deletionMarkers.get(hoveredMarker.tree);
        if (!treeMarkers) return null;
        type Entry = { item: DeletionHoverItem; info: DeletionMarkerInfo; index: number; stackSize: number };
        const result: Entry[] = [];
        hoveredMarker.items.forEach((item) => {
            const stack = treeMarkers.get(item.year);
            if (!stack || stack.length === 0) return;
            stack.forEach((info, index) => {
                result.push({ item, info, index, stackSize: stack.length });
            });
        });
        return result;
    }, [hoveredMarker, deletionMarkers]);

    // 删除时被强制留在原位（不进 shiftedYears）的格子需要 z-index 提升，避免在 slide-in 动画期间
    // 被周围滑入的格子覆盖。这里记一组 cell 让它们短暂处于"被提升"的状态，
    // 等 CSS 滑入动画结束后再恢复正常 z-index。
    const [pendingRollingCells, setPendingRollingCells] = useState<Map<string, Set<number>> | null>(null);
    const pendingRollingTimerRef = useRef<number | null>(null);

    const flagPendingRolling = useCallback((tree: string, years: number[]) => {
        if (years.length === 0) return;
        setPendingRollingCells((prev) => {
            const next = new Map(prev ?? []);
            const existing = next.get(tree);
            if (existing) {
                years.forEach((y) => existing.add(y));
            } else {
                next.set(tree, new Set(years));
            }
            return next;
        });
        if (pendingRollingTimerRef.current !== null) {
            window.clearTimeout(pendingRollingTimerRef.current);
        }
        pendingRollingTimerRef.current = window.setTimeout(() => {
            setPendingRollingCells(null);
            pendingRollingTimerRef.current = null;
        }, 2400);
    }, []);

    // 恢复完成后通过 animationCue 让"被恢复的那一格"作为 insertedYears，
    // 让它因 cellAnimationKey 变化而重新挂载——这样 RollingNumber 也会 reset，
    // 不会出现"恢复格"自己跳动；两侧邻居仍然保持原 React 实例，由 RollingNumber 自然滚动。
    const triggerRestoreAnimation = useCallback((tree: string, markerYear: number) => {
        showAnimationCue({
            tree,
            insertSide: "right",
            insertedYears: [markerYear - 1],
            shiftedYears: [],
            movedYears: [],
            gapYears: [],
            overwrittenYears: [],
        });
    }, [showAnimationCue]);

    // 双击红线：默认恢复该格子最新的一次删除（栈顶，index = stack.length - 1）。
    const handleRedLineDoubleClick = useCallback((tree: string, markerYear: number) => {
        const stack = deletionMarkers?.get(tree)?.get(markerYear);
        if (!stack || stack.length === 0) return;
        setHoveredMarker(null);
        flushSync(() => {
            onRestoreDeletion?.(tree, markerYear, stack.length - 1);
            triggerRestoreAnimation(tree, markerYear);
        });
    }, [onRestoreDeletion, deletionMarkers, triggerRestoreAnimation]);

    // 双击具体 ghost：恢复栈中指定那条删除。
    const handleGhostDoubleClick = useCallback((tree: string, markerYear: number, index: number) => {
        setHoveredMarker(null);
        flushSync(() => {
            onRestoreDeletion?.(tree, markerYear, index);
            triggerRestoreAnimation(tree, markerYear);
        });
    }, [onRestoreDeletion, triggerRestoreAnimation]);

    // 所有 value 格子默认开启 RollingNumber，因此不再需要按邻接关系判断；
    // pendingRollingCells 现在只用来给原地保留的格子提升 z-index，避免被滑入格子盖住。

    const handleInsertMissingYearAtSide = useCallback((tree: string, year: number, side: PlusSide) => {
        const treeData = visibleSite.get(tree);
        const container = containerRef.current;
        let shiftedYears: number[] = [];

        pendingInsertFlipRef.current = null;

        if (container) {
            const sourceElements = getTreeYearGridElements(container, tree);
            const shiftTargets = getVisibleInsertShiftTargets(sourceElements, year, side);
            const firstYear = treeData ? getFirstSeriesYear(treeData) : undefined;
            const cells = firstYear === undefined
                ? []
                : shiftTargets
                    .filter(({ sourceYear, targetYear }) => isCrossRowInsertShift(firstYear, sourceYear, targetYear))
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
                        };
                    })
                    .filter((cell): cell is InsertFlipCell => cell !== null);

            shiftedYears = Array.from(new Set(shiftTargets.map(({ targetYear }) => targetYear)));

            pendingInsertFlipRef.current = {
                tree,
                side,
                cells,
            };
        }

        flushSync(() => {
            onInsertMissingYearAtSide?.(tree, year, side);
            showAnimationCue({
                tree,
                insertSide: side,
                insertedYears: [year],
                shiftedYears,
                movedYears: [],
                gapYears: [],
                overwrittenYears: [],
            });
        });
    }, [onInsertMissingYearAtSide, showAnimationCue, visibleSite]);

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
        setSelection(normalizeSelection(tree, year, year));
        onYearClick?.(tree, year);

        const cellRect = cell.getBoundingClientRect();
        setContextMenu({ tree, year, x: cellRect.right, y: cellRect.bottom });
    }, [onYearClick]);

    const handleContextMenuClose = useCallback(() => {
        setContextMenu(null);
    }, []);

    const handleContextMenuInsert = useCallback((tree: string, year: number, side: PlusSide) => {
        handleInsertMissingYearAtSide(tree, year, side);
    }, [handleInsertMissingYearAtSide]);

    const handleContextMenuDelete = useCallback((tree: string, year: number, mode: DeleteMode) => {
        const treeData = visibleSite.get(tree);
        const container = containerRef.current;
        let shiftedYears: number[] = [];

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
            const cells = firstYear === undefined
                ? []
                : shiftTargets
                    .filter(({ sourceYear, targetYear }) => isCrossRowInsertShift(firstYear, sourceYear, targetYear))
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
                        };
                    })
                    .filter((cell): cell is InsertFlipCell => cell !== null);

            shiftedYears = Array.from(new Set(shiftTargets.map(({ targetYear }) => targetYear)));

            // 对于 left / both 模式，年份 M（被删格子那个 slot）在删除后会装入
            // 经过修改的左邻值。要让它在原地以 RollingNumber 跳动到新值，必须
            // 不让它进入 shiftedYears（否则会因 cellAnimationKey 变化而重挂载）。
            if (mode === "left" || mode === "both") {
                shiftedYears = shiftedYears.filter((y) => y !== year);
            }

            // Reuse insert flip mechanism: delete shifts earlier years right, same direction as insert side="left".
            pendingInsertFlipRef.current = {
                tree,
                side: "left",
                cells,
            };

            if (deletedElement) {
                clearDeleteBurstAnimations();
                const cleanup = createDeletePixelBurst(container, deletedElement);
                if (cleanup) {
                    deleteBurstCleanupRef.current = [cleanup];
                }
            }
        }

        // RollingNumber 默认开启，所以邻居跳动不再需要预先 flag。
        // 这里仅给"原地保留"的 slot M（left/both 模式下不进 shiftedYears 的那一格）
        // 加 z-index 提升，避免被周围的 slide-in 格子覆盖到看不见。
        if (mode === "left" || mode === "both") {
            flushSync(() => {
                flagPendingRolling(tree, [year]);
            });
        }

        flushSync(() => {
            onDeleteYearWithMode?.(tree, year, mode);
            showAnimationCue({
                tree,
                insertSide: "left",
                insertedYears: [],
                shiftedYears,
                movedYears: [],
                gapYears: [],
                overwrittenYears: [],
            });
        });
    }, [clearDeleteBurstAnimations, onDeleteYearWithMode, showAnimationCue, visibleSite, flagPendingRolling]);

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

            onMoveSeriesTailByOffset?.(interaction.tree, interaction.startYear, interaction.endYear, interaction.yearOffset);
            setSelection(targetSelection);
            showAnimationCue({
                tree: interaction.tree,
                insertedYears: [],
                shiftedYears: [],
                movedYears,
                gapYears,
                overwrittenYears,
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
    }, [clearSelection, onMoveSeriesTailByOffset, showAnimationCue, visibleSite]);

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
        <div
            ref={containerRef}
            className={style["width-grid-container"]}
            onPointerDown={handleContainerPointerDown}
            onContextMenu={handleContainerContextMenu}
        >
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

                                const cellIsSelected = renderSelection?.tree === series.treeCode && selectedYears.has(cell.year);
                                const cellAnimationKind = getGridAnimationKind(series.treeCode, cell.year);
                                const cellAnimationKey = cellAnimationKind ? animationCue?.id ?? 0 : 0;
                                const hasLeftDeletionMark = Boolean(deletionMarkers?.get(series.treeCode)?.has(cell.year));
                                // 所有 value 格子默认启用 RollingNumber：
                                // - 自动变动（删除/恢复/移动/撤销/重做等）会让 React 复用同一个挂载实例，
                                //   RollingNumber 的 value prop 变化自然触发数字跳动。
                                // - 用户双击编辑时，<input> 替换掉 RollingNumber 的渲染输出，
                                //   提交后 RollingNumber 重新挂载，初始化在输入值上，没有"跳动"动画。
                                // - 进入动画 cue（insertedYears / shiftedYears）的格子因 key 变化而重挂载，
                                //   也不会跳动，呈现 CSS 滑入效果。
                                const rollingDigits = true;

                                // 仅高亮当前悬停的红线本身；hover 时不改变左右邻 cell 的值，
                                // 让 RollingNumber 只在数据真的因为撤销/恢复改动时才跳动。
                                const isDeletionMarkActive = Boolean(
                                    hoveredMarker
                                    && hoveredMarker.tree === series.treeCode
                                    && cell.year === hoveredMarker.hoveredYear
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
                                            isDragging={isDraggingSelection && cellIsSelected}
                                            dragYearOffset={dragYearOffset}
                                            animationKind={cellAnimationKind}
                                            hasLeftDeletionMark={hasLeftDeletionMark}
                                            isDeletionMarkActive={isDeletionMarkActive}
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
                                // 被 pendingRolling 标记的格子（典型为 left/both 删除时的 year M），
                                // 因为我们故意让它留在原位 RollingNumber 跳动，需要盖在滑入的格子之上，
                                // 避免在 slide 过程中被覆盖看不见。
                                const isRollingFocused = pendingRollingCells?.get(series.treeCode)?.has(cell.year);

                                return (
                                    <WidthGrid
                                        key={`value-${series.treeCode}-${cell.year}-${cellAnimationKey}`}
                                        gridValue={effectiveValue}
                                        year={cell.year}
                                        tree={series.treeCode}
                                        masterSeriesValue={masterSeries?.get(cell.year)}
                                        isEditable={true}
                                        isSelected={cellIsSelected}
                                        isDragging={isDraggingSelection && cellIsSelected}
                                        dragYearOffset={dragYearOffset}
                                        animationKind={cellAnimationKind}
                                        hasLeftDeletionMark={hasLeftDeletionMark}
                                        isDeletionMarkActive={isDeletionMarkActive}
                                        rollingDigits={rollingDigits}
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
                </div>
            ))}

            {bottomSpacerHeight > 0 ? (
                <div
                    aria-hidden="true"
                    className={style["virtual-spacer"]}
                    style={{ height: `${bottomSpacerHeight}px` }}
                />
            ) : null}

            {hoveredMarkerRun?.map(({ item, info, index, stackSize }) => {
                // 同一年份多次堆叠：最晚一次（index = stackSize-1）紧贴格子，
                // 越早被删除的越往左排开。
                const offset = stackSize - 1 - index;
                const left = item.anchorLeft - item.cellWidth / 2 - 2.5 - offset * (item.cellWidth + GRID_GAP);
                return (
                    <div
                        key={`${item.year}-${index}`}
                        className={style["deletion-preview-ghost"]}
                        style={{
                            left: `${left}px`,
                            top: `${item.anchorTop}px`,
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
                            : <RollingNumber value={info.deletedWidth} />}
                    </div>
                );
            }) ?? null}

            <WidthGridContextMenu
                open={contextMenu !== null}
                x={contextMenu?.x ?? 0}
                y={contextMenu?.y ?? 0}
                tree={contextMenu?.tree ?? ""}
                defaultYear={contextMenu?.year ?? 0}
                onInsert={handleContextMenuInsert}
                onDelete={handleContextMenuDelete}
                onClose={handleContextMenuClose}
            />
        </div>
    );
}

export default memo(WidthContainer);

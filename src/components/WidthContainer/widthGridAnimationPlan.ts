import { stopMarker } from "@/shared/constants";
import {
    ROW_GAP,
    ROW_HEIGHT,
    VALUE_COLUMN_COUNT,
    getFirstRowLastCellIndex,
    getLayoutCellPosition,
    sameLayoutCellPosition,
} from "./widthGridLayout";

export type PlusSide = "left" | "right";

export interface InsertFlipCell {
    sourceYear: number;
    targetYear: number;
    sourceRect: DOMRect;
    sourceText: string;
    sourceClassName: string;
    sourceStyleText: string;
    delaySeconds: number;
}

export interface InsertShiftTarget {
    sourceYear: number;
    targetYear: number;
}

export interface RollingCellAnimation {
    year: number;
    fromValue?: number;
}

export interface ShiftedCellAnimation {
    year: number;
    delaySeconds: number;
    crossRow?: boolean;
    edgeFade?: boolean;
    offsetX?: number;
    offsetY?: number;
}

export interface GridAnimationPlan {
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

export type GridAnimationPlanInput =
    Omit<GridAnimationPlan, "id" | "shiftedCells" | "rollingCells" | "elevatedYears">
    & Partial<Pick<GridAnimationPlan, "shiftedCells" | "rollingCells" | "elevatedYears">>;

interface ShiftedCellOffset {
    x: number;
    y: number;
}

interface VisualShiftTargets {
    crossRowTargetYears: Set<number>;
    stationaryTargetYears: Set<number>;
    edgeFadeTargetYears: Set<number>;
    sourceExitTargetYears: Set<number>;
}

const SHIFT_STAGGER_SECONDS = 0.014;

export const getGridTextContent = (element: HTMLElement) => {
    const firstTextNode = Array.from(element.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
    return firstTextNode?.textContent ?? element.textContent ?? "";
};

const getEditableYears = (treeData: Map<number, number | null> | undefined) => {
    if (!treeData) {
        return [];
    }

    return Array.from(treeData.entries())
        .filter(([, value]) => value !== stopMarker.value)
        .map(([year]) => year);
};

const isFirstRowFull = (firstYear: number | undefined, years: Iterable<number>) => {
    if (firstYear === undefined) {
        return false;
    }

    let firstRowCellCount = 0;
    for (const year of years) {
        if (getLayoutCellPosition(firstYear, year).rowIndex === 0) {
            firstRowCellCount += 1;
        }
    }

    return firstRowCellCount >= VALUE_COLUMN_COUNT;
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
    offsets = new Map<number, ShiftedCellOffset>(),
    edgeFadeYears = new Set<number>(),
): ShiftedCellAnimation[] => (
    getOrderedShiftQueueYears(shiftedYears, anchorTargetYear).map((year, index) => {
        const offset = offsets.get(year);
        return {
            year,
            delaySeconds: index * SHIFT_STAGGER_SECONDS,
            crossRow: crossRowYears.has(year),
            edgeFade: edgeFadeYears.has(year),
            offsetX: offset?.x,
            offsetY: offset?.y,
        };
    })
);

const getShiftDelayByYear = (shiftedCells: ShiftedCellAnimation[]) => (
    new Map(shiftedCells.map((cell) => [cell.year, cell.delaySeconds]))
);

const buildShiftQueue = (
    shiftTargets: InsertShiftTarget[],
    anchorTargetYear: number,
    crossRowYears = new Set<number>(),
    excludedTargetYears = new Set<number>(),
    offsets = new Map<number, ShiftedCellOffset>(),
    edgeFadeYears = new Set<number>(),
) => {
    const shiftedYears = getUniqueYears(shiftTargets.map(({ targetYear }) => targetYear))
        .filter((targetYear) => !excludedTargetYears.has(targetYear));
    const shiftedCells = buildShiftedCells(shiftedYears, anchorTargetYear, crossRowYears, offsets, edgeFadeYears);
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
        .map(({ sourceYear, targetYear }): InsertFlipCell | null => {
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

export const getVisibleInsertShiftTargets = (
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

const getShiftTargetOffsets = (
    shiftTargets: InsertShiftTarget[],
    sourceElements: Map<number, HTMLElement>,
) => {
    const offsets = new Map<number, ShiftedCellOffset>();

    shiftTargets.forEach(({ sourceYear, targetYear }) => {
        const sourceElement = sourceElements.get(sourceYear);
        const targetElement = sourceElements.get(targetYear);

        if (!sourceElement || !targetElement) {
            return;
        }

        const sourceRect = sourceElement.getBoundingClientRect();
        const targetRect = targetElement.getBoundingClientRect();
        const x = sourceRect.left - targetRect.left;
        const y = sourceRect.top - targetRect.top;

        if (Math.abs(x) > 0.5 || Math.abs(y) > 0.5) {
            offsets.set(targetYear, { x, y });
        }
    });

    return offsets;
};

const getVisualShiftTargets = (
    shiftTargets: InsertShiftTarget[],
    firstYearBefore: number | undefined,
    firstYearAfter: number | undefined,
    canAnimateFirstRow: boolean,
): VisualShiftTargets => {
    const crossRowTargetYears = new Set<number>();
    const stationaryTargetYears = new Set<number>();
    const edgeFadeTargetYears = new Set<number>();
    const sourceExitTargetYears = new Set<number>();

    if (firstYearBefore === undefined || firstYearAfter === undefined || shiftTargets.length === 0) {
        return { crossRowTargetYears, stationaryTargetYears, edgeFadeTargetYears, sourceExitTargetYears };
    }

    const firstRowLastBefore = getFirstRowLastCellIndex(firstYearBefore);
    const firstYearMovesRight = firstYearAfter > firstYearBefore;

    shiftTargets.forEach(({ sourceYear, targetYear }) => {
        const sourcePosition = getLayoutCellPosition(firstYearBefore, sourceYear);
        const targetPosition = getLayoutCellPosition(firstYearAfter, targetYear);
        const yearDelta = targetYear - sourceYear;
        const touchesFirstRow = sourcePosition.rowIndex === 0 || targetPosition.rowIndex === 0;
        const hasSameVisualPosition = sameLayoutCellPosition(sourcePosition, targetPosition);
        const wrapsRightIntoNextRowStart = yearDelta > 0
            && sourcePosition.cellIndex === VALUE_COLUMN_COUNT - 1
            && targetPosition.cellIndex === 0;
        const wrapsLeftIntoPreviousRowEnd = yearDelta < 0
            && sourcePosition.cellIndex === 0
            && targetPosition.cellIndex === VALUE_COLUMN_COUNT - 1;
        const exitsFirstRowRightEdge = yearDelta > 0
            && sourcePosition.rowIndex === 0
            && sourcePosition.cellIndex === firstRowLastBefore
            && targetPosition.rowIndex === 1
            && targetPosition.cellIndex === 0;

        if (
            (wrapsRightIntoNextRowStart && sourcePosition.rowIndex === 0)
            || (wrapsLeftIntoPreviousRowEnd && targetPosition.rowIndex === 0)
            || exitsFirstRowRightEdge
        ) {
            edgeFadeTargetYears.add(targetYear);
            sourceExitTargetYears.add(targetYear);
            return;
        }

        if (hasSameVisualPosition) {
            stationaryTargetYears.add(targetYear);
            return;
        }

        if (touchesFirstRow && !canAnimateFirstRow) {
            if (targetPosition.rowIndex === 0 && sourcePosition.rowIndex > 0) {
                if (firstYearMovesRight && yearDelta > 0) {
                    stationaryTargetYears.add(targetYear);
                } else {
                    edgeFadeTargetYears.add(targetYear);
                    sourceExitTargetYears.add(targetYear);
                }
            } else {
                stationaryTargetYears.add(targetYear);
            }
            return;
        }

        const columnDelta = targetPosition.cellIndex - sourcePosition.cellIndex;
        if (columnDelta * yearDelta < 0) {
            crossRowTargetYears.add(targetYear);
        }
    });

    return { crossRowTargetYears, stationaryTargetYears, edgeFadeTargetYears, sourceExitTargetYears };
};

export const buildShiftPlan = (params: {
    shiftTargets: InsertShiftTarget[];
    sourceElements: Map<number, HTMLElement>;
    firstYearBefore: number | undefined;
    firstYearAfter: number | undefined;
    shiftAnchorTargetYear: number;
    useFlightShift: boolean;
    extraExcludedTargetYears?: Set<number>;
}): { shiftedYears: number[]; shiftedCells: ShiftedCellAnimation[]; ghostCells: InsertFlipCell[] } => {
    const { shiftTargets, sourceElements, firstYearBefore, firstYearAfter, shiftAnchorTargetYear, useFlightShift } = params;
    const extra = params.extraExcludedTargetYears ?? new Set<number>();
    const editableSourceYears = Array.from(sourceElements.entries())
        .filter(([, element]) => element.dataset.widthGridStopCell !== "true")
        .map(([year]) => year);
    const canAnimateFirstRow = isFirstRowFull(firstYearBefore, editableSourceYears);
    const {
        crossRowTargetYears,
        stationaryTargetYears,
        edgeFadeTargetYears,
        sourceExitTargetYears,
    } = getVisualShiftTargets(shiftTargets, firstYearBefore, firstYearAfter, canAnimateFirstRow);
    const excludedTargetYears = new Set<number>([...Array.from(extra), ...Array.from(stationaryTargetYears)]);
    const keepAnimatedTarget = (targetYear: number) => !excludedTargetYears.has(targetYear);
    const animatedCrossRowTargetYears = new Set(Array.from(crossRowTargetYears).filter(keepAnimatedTarget));
    const animatedEdgeFadeTargetYears = new Set(Array.from(edgeFadeTargetYears).filter(keepAnimatedTarget));
    const animatedSourceExitTargetYears = new Set(Array.from(sourceExitTargetYears).filter(keepAnimatedTarget));
    const measuredShiftOffsets = useFlightShift
        ? getShiftTargetOffsets(shiftTargets, sourceElements)
        : new Map<number, ShiftedCellOffset>();
    const shiftOffsets = measuredShiftOffsets;
    const shiftQueue = buildShiftQueue(shiftTargets, shiftAnchorTargetYear, animatedCrossRowTargetYears, excludedTargetYears, shiftOffsets, animatedEdgeFadeTargetYears);
    const crossRowGhostTargetYears = new Set(
        Array.from(animatedCrossRowTargetYears).filter((targetYear) => !useFlightShift || !shiftOffsets.has(targetYear))
    );
    const ghostTargetYears = new Set([...Array.from(crossRowGhostTargetYears), ...Array.from(animatedSourceExitTargetYears)]);
    const ghostCells = buildCrossRowGhostCells(shiftTargets, sourceElements, ghostTargetYears, shiftQueue.shiftDelayByYear);
    return { shiftedYears: shiftQueue.shiftedYears, shiftedCells: shiftQueue.shiftedCells, ghostCells };
};

export const buildHistoryShiftPlan = (params: {
    afterElements: Map<number, HTMLElement>;
    ghostClassName: string;
    prevTreeData: Map<number, number | null> | undefined;
    shiftTargets: InsertShiftTarget[];
    firstYearBefore: number | undefined;
    firstYearAfter: number | undefined;
    shiftAnchorTargetYear: number;
}): { shiftedYears: number[]; shiftedCells: ShiftedCellAnimation[]; ghostCells: InsertFlipCell[] } => {
    const { afterElements, ghostClassName, prevTreeData, shiftTargets, firstYearBefore, firstYearAfter, shiftAnchorTargetYear } = params;
    const canAnimateFirstRow = isFirstRowFull(firstYearBefore, getEditableYears(prevTreeData));
    const {
        crossRowTargetYears,
        stationaryTargetYears,
        edgeFadeTargetYears,
        sourceExitTargetYears,
    } = getVisualShiftTargets(shiftTargets, firstYearBefore, firstYearAfter, canAnimateFirstRow);
    const keepAnimatedTarget = (targetYear: number) => !stationaryTargetYears.has(targetYear);
    const animatedCrossRowTargetYears = new Set(Array.from(crossRowTargetYears).filter(keepAnimatedTarget));
    const animatedEdgeFadeTargetYears = new Set(Array.from(edgeFadeTargetYears).filter(keepAnimatedTarget));
    const animatedSourceExitTargetYears = new Set(Array.from(sourceExitTargetYears).filter(keepAnimatedTarget));
    const shiftedYears = shiftTargets.map((target) => target.targetYear).filter(keepAnimatedTarget);
    const shiftedCells = buildShiftedCells(shiftedYears, shiftAnchorTargetYear, animatedCrossRowTargetYears, new Map<number, ShiftedCellOffset>(), animatedEdgeFadeTargetYears);
    const shiftDelayByYear = getShiftDelayByYear(shiftedCells);
    const ghostTargetYears = new Set([...Array.from(animatedCrossRowTargetYears), ...Array.from(animatedSourceExitTargetYears)]);

    const ghostCells: InsertFlipCell[] = [];
    if (prevTreeData && firstYearBefore !== undefined && firstYearAfter !== undefined && ghostTargetYears.size > 0) {
        const colX = new Map<number, number>();
        const rowY = new Map<number, number>();
        let cellWidth = 0;
        let cellHeight = 0;
        afterElements.forEach((element, year) => {
            const pos = getLayoutCellPosition(firstYearAfter, year);
            const rect = element.getBoundingClientRect();
            if (!colX.has(pos.cellIndex)) colX.set(pos.cellIndex, rect.left);
            if (!rowY.has(pos.rowIndex)) rowY.set(pos.rowIndex, rect.top);
            cellWidth = rect.width;
            cellHeight = rect.height;
        });
        const rowIndices = Array.from(rowY.keys()).sort((a, b) => a - b);
        if (rowIndices.length > 0 && cellWidth > 0) {
            const rowStride = ROW_HEIGHT + ROW_GAP;
            const row0Y = rowY.get(rowIndices[0])! - rowIndices[0] * rowStride;
            shiftTargets.forEach(({ sourceYear, targetYear }) => {
                if (!ghostTargetYears.has(targetYear)) return;
                const beforePos = getLayoutCellPosition(firstYearBefore, sourceYear);
                const left = colX.get(beforePos.cellIndex);
                if (left === undefined) return;
                const value = prevTreeData.get(sourceYear);
                if (typeof value !== "number" || value === stopMarker.value) return;
                ghostCells.push({
                    sourceYear,
                    targetYear,
                    sourceRect: new DOMRect(left, row0Y + beforePos.rowIndex * rowStride, cellWidth, cellHeight),
                    sourceText: String(value),
                    sourceClassName: ghostClassName,
                    sourceStyleText: "",
                    delaySeconds: shiftDelayByYear.get(targetYear) ?? 0,
                });
            });
        }
    }

    return { shiftedYears, shiftedCells, ghostCells };
};

export const getInsertShiftAnchorTargetYear = (year: number, side: PlusSide) => (
    side === "right" ? year - 1 : year + 1
);

export const getDeleteShiftAnchorTargetYear = (year: number) => year;

export const getRestoreShiftAnchorTargetYear = (year: number) => year - 1;

export const getOppositeSide = (side: PlusSide): PlusSide => side === "left" ? "right" : "left";

export const isYearOnInsertSide = (year: number, currentYear: number, side: PlusSide) => (
    side === "left" ? year >= currentYear : year <= currentYear
);

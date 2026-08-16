import type { RwlEditOperation, RwlOperationLogEntry } from "@/features/rwl/edit";
import type { TreeRingScanSeriesState } from "./types";

interface DeletedYearToken {
    originalYear: number | null;
    order: number;
    shift: "left" | "right";
}

type DeletedYearStacks = Map<number, DeletedYearToken[]>;

export interface TreeRingYearMapping {
    valid: boolean;
    invalidReason?: string;
    currentByOriginal: Map<number, number | null>;
    originalByCurrent: Map<number, number>;
    appliedOperationCount: number;
}

const sortedAppliedOperations = (
    operationLog: readonly RwlOperationLogEntry[],
    seriesId: string,
    afterSequence: number,
) => operationLog
    .filter((entry) => (
        (entry.tree ?? entry.seriesId) === seriesId
        && entry.sequence > afterSequence
        && !(entry.isReverted ?? entry.undone)
        && entry.operation
    ))
    .sort((left, right) => left.sequence - right.sequence);

const addStack = (
    target: DeletedYearStacks,
    markerYear: number,
    stack: readonly DeletedYearToken[],
) => {
    if (stack.length === 0) return;
    const existing = target.get(markerYear);
    target.set(markerYear, existing ? [...existing, ...stack] : [...stack]);
};

const transformActiveYears = (
    currentByOriginal: Map<number, number | null>,
    transform: (currentYear: number, originalYear: number) => number | null,
) => {
    currentByOriginal.forEach((currentYear, originalYear) => {
        if (currentYear === null) return;
        currentByOriginal.set(originalYear, transform(currentYear, originalYear));
    });
};

const transformDeletedMarkersForInsert = (
    stacks: DeletedYearStacks,
    year: number,
    side: "left" | "right",
): DeletedYearStacks => {
    const next: DeletedYearStacks = new Map();
    stacks.forEach((stack, markerYear) => {
        const shifted = side === "left"
            ? (markerYear >= year ? markerYear + 1 : markerYear)
            : (markerYear <= year ? markerYear - 1 : markerYear);
        addStack(next, shifted, stack);
    });
    return next;
};

const transformDeletedMarkersForMove = (
    stacks: DeletedYearStacks,
    startYear: number,
    endYear: number,
    offset: number,
): DeletedYearStacks => {
    const start = Math.min(startYear, endYear);
    const end = Math.max(startYear, endYear);
    const next: DeletedYearStacks = new Map();
    stacks.forEach((stack, markerYear) => {
        addStack(next, markerYear >= start && markerYear <= end ? markerYear + offset : markerYear, stack);
    });
    return next;
};

const deleteOneYear = (
    currentByOriginal: Map<number, number | null>,
    stacks: DeletedYearStacks,
    year: number,
    shift: "left" | "right",
    order: number,
): DeletedYearStacks => {
    let removedOriginalYear: number | null = null;
    currentByOriginal.forEach((currentYear, originalYear) => {
        if (currentYear === year) {
            removedOriginalYear = originalYear;
            currentByOriginal.set(originalYear, null);
        }
    });

    transformActiveYears(currentByOriginal, (currentYear) => {
        if (shift === "left") return currentYear > year ? currentYear - 1 : currentYear;
        return currentYear < year ? currentYear + 1 : currentYear;
    });

    const markerYear = shift === "left" ? year : year + 1;
    const next: DeletedYearStacks = new Map();
    Array.from(stacks.entries()).sort(([left], [right]) => left - right).forEach(([candidateYear, stack]) => {
        if (shift === "left") {
            if (candidateYear < year) addStack(next, candidateYear, stack);
            else if (candidateYear > year + 1) addStack(next, candidateYear - 1, stack);
        } else {
            if (candidateYear < year) addStack(next, candidateYear + 1, stack);
            else if (candidateYear > year + 1) addStack(next, candidateYear, stack);
        }
    });
    addStack(next, markerYear, stacks.get(year) ?? []);
    addStack(next, markerYear, [{ originalYear: removedOriginalYear, order, shift }]);
    addStack(next, markerYear, stacks.get(year + 1) ?? []);
    return next;
};

const restoreOneYear = (
    currentByOriginal: Map<number, number | null>,
    stacks: DeletedYearStacks,
    markerYear: number,
): { stacks: DeletedYearStacks; restored: boolean } => {
    const stack = stacks.get(markerYear);
    if (!stack || stack.length === 0) {
        return { stacks, restored: false };
    }
    let topIndex = 0;
    for (let index = 1; index < stack.length; index += 1) {
        if (stack[index].order > stack[topIndex].order) topIndex = index;
    }
    const token = stack[topIndex];
    const restoredYear = token.shift === "left" ? markerYear : markerYear - 1;

    transformActiveYears(currentByOriginal, (currentYear) => {
        if (token.shift === "left") return currentYear >= markerYear ? currentYear + 1 : currentYear;
        return currentYear < markerYear ? currentYear - 1 : currentYear;
    });
    if (token.originalYear !== null) {
        currentByOriginal.set(token.originalYear, restoredYear);
    }

    const leftRemaining = stack.slice(0, topIndex);
    const rightRemaining = stack.slice(topIndex + 1);
    const next: DeletedYearStacks = new Map();
    Array.from(stacks.entries()).sort(([left], [right]) => left - right).forEach(([candidateYear, candidateStack]) => {
        if (candidateYear === markerYear) {
            if (token.shift === "left") {
                addStack(next, markerYear, leftRemaining);
                addStack(next, markerYear + 1, rightRemaining);
            } else {
                addStack(next, markerYear - 1, leftRemaining);
                addStack(next, markerYear, rightRemaining);
            }
            return;
        }
        if (token.shift === "left") {
            addStack(next, candidateYear > markerYear ? candidateYear + 1 : candidateYear, candidateStack);
        } else {
            addStack(next, candidateYear < markerYear ? candidateYear - 1 : candidateYear, candidateStack);
        }
    });
    return { stacks: next, restored: true };
};

function applyOperation(
    operation: RwlEditOperation,
    operationOrder: number,
    currentByOriginal: Map<number, number | null>,
    stacks: DeletedYearStacks,
): { stacks: DeletedYearStacks; invalidReason?: string } {
    switch (operation.type) {
        case "change-width":
            return { stacks };
        case "insert-missing":
            transformActiveYears(currentByOriginal, (currentYear) => (
                operation.side === "left"
                    ? (currentYear >= operation.year ? currentYear + 1 : currentYear)
                    : (currentYear <= operation.year ? currentYear - 1 : currentYear)
            ));
            return {
                stacks: transformDeletedMarkersForInsert(stacks, operation.year, operation.side),
            };
        case "move-selection": {
            const start = Math.min(operation.selectedStartYear, operation.selectedEndYear);
            const end = Math.max(operation.selectedStartYear, operation.selectedEndYear);
            const movingOriginalYears = new Set<number>();
            currentByOriginal.forEach((currentYear, originalYear) => {
                if (currentYear !== null && currentYear >= start && currentYear <= end) {
                    movingOriginalYears.add(originalYear);
                }
            });
            const destinations = new Set(Array.from(movingOriginalYears, (originalYear) => (
                currentByOriginal.get(originalYear)! + operation.yearOffset
            )));
            currentByOriginal.forEach((currentYear, originalYear) => {
                if (
                    currentYear !== null
                    && !movingOriginalYears.has(originalYear)
                    && destinations.has(currentYear)
                ) {
                    currentByOriginal.set(originalYear, null);
                }
            });
            movingOriginalYears.forEach((originalYear) => {
                const currentYear = currentByOriginal.get(originalYear);
                if (currentYear !== null && currentYear !== undefined) {
                    currentByOriginal.set(originalYear, currentYear + operation.yearOffset);
                }
            });
            return {
                stacks: transformDeletedMarkersForMove(
                    stacks,
                    operation.selectedStartYear,
                    operation.selectedEndYear,
                    operation.yearOffset,
                ),
            };
        }
        case "delete-year":
            return {
                stacks: deleteOneYear(
                    currentByOriginal,
                    stacks,
                    operation.year,
                    operation.shift ?? "right",
                    operationOrder,
                ),
            };
        case "delete-year-range": {
            const start = Math.min(operation.startYear, operation.endYear);
            const end = Math.max(operation.startYear, operation.endYear);
            if (operation.fill === "missing") {
                transformActiveYears(currentByOriginal, (currentYear) => (
                    currentYear >= start && currentYear <= end ? null : currentYear
                ));
                return { stacks };
            }
            const length = end - start + 1;
            const shift = operation.fill === "left" ? "right" : "left";
            const deletionYear = operation.fill === "left" ? end : start;
            let nextStacks = stacks;
            for (let index = 0; index < length; index += 1) {
                nextStacks = deleteOneYear(
                    currentByOriginal,
                    nextStacks,
                    deletionYear,
                    shift,
                    operationOrder * 1000 + index,
                );
            }
            return { stacks: nextStacks };
        }
        case "mark-missing-range": {
            const start = Math.min(operation.startYear, operation.endYear);
            const end = Math.max(operation.startYear, operation.endYear);
            transformActiveYears(currentByOriginal, (currentYear) => (
                currentYear >= start && currentYear <= end ? null : currentYear
            ));
            return { stacks };
        }
        case "restore-deletion": {
            const restored = restoreOneYear(currentByOriginal, stacks, operation.markerYear);
            return restored.restored
                ? { stacks: restored.stacks }
                : { stacks, invalidReason: "恢复了校准前已删除的年份，请重新标注扫描影像锚点" };
        }
        case "delete-series":
        case "replace-tree-data":
        case "replace-all-data":
            return { stacks, invalidReason: "序列已被整体替换，请重新标注扫描影像锚点" };
    }
}

/** Replay only post-calibration coordinate edits, preserving physical/original year identities. */
export function buildTreeRingYearMapping(
    seriesId: string,
    scanState: TreeRingScanSeriesState | undefined,
    operationLog: readonly RwlOperationLogEntry[],
): TreeRingYearMapping {
    const startYear = scanState?.baselineStartYear;
    const endYear = scanState?.baselineEndYear;
    const baselineSequence = scanState?.baselineOperationSequence;
    if (
        startYear === undefined
        || endYear === undefined
        || baselineSequence === undefined
        || endYear < startYear
    ) {
        return {
            valid: false,
            invalidReason: "尚未建立扫描影像年份基线",
            currentByOriginal: new Map(),
            originalByCurrent: new Map(),
            appliedOperationCount: 0,
        };
    }

    const currentByOriginal = new Map<number, number | null>();
    for (let year = startYear; year <= endYear; year += 1) {
        currentByOriginal.set(year, year);
    }

    let stacks: DeletedYearStacks = new Map();
    const entries = sortedAppliedOperations(operationLog, seriesId, baselineSequence);
    for (const entry of entries) {
        const result = applyOperation(entry.operation!, entry.sequence, currentByOriginal, stacks);
        stacks = result.stacks;
        if (result.invalidReason) {
            return {
                valid: false,
                invalidReason: result.invalidReason,
                currentByOriginal,
                originalByCurrent: new Map(),
                appliedOperationCount: entries.length,
            };
        }
    }

    const originalByCurrent = new Map<number, number>();
    currentByOriginal.forEach((currentYear, originalYear) => {
        if (currentYear !== null) originalByCurrent.set(currentYear, originalYear);
    });
    return {
        valid: true,
        currentByOriginal,
        originalByCurrent,
        appliedOperationCount: entries.length,
    };
}

export function getLatestSeriesOperationSequence(
    operationLog: readonly RwlOperationLogEntry[],
    seriesId: string,
): number {
    return operationLog.reduce((latest, entry) => (
        (entry.tree ?? entry.seriesId) === seriesId && !(entry.isReverted ?? entry.undone)
            ? Math.max(latest, entry.sequence)
            : latest
    ), 0);
}

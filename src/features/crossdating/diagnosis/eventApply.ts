/** Converts a reviewed event/year selection into one existing RWL editor operation. */
import type { DeleteShift, MissingInsertSide } from "@/features/rwl/edit";
import {
    isNegativePartialShift,
    partialMoveBreakpoint,
} from "./partialMoveSemantics";
import type { DiagnosisEvent } from "./types";

export type DiagnosisEventEditPlan =
    | {
        operationType: "INSERT_MISSING_RING";
        targetTree: string;
        targetYear: number;
        side: MissingInsertSide;
    }
    | {
        operationType: "DELETE_FALSE_RING";
        targetTree: string;
        targetYear: number;
        shift: DeleteShift;
    }
    | {
        operationType: "SHIFT_RANGE";
        targetTree: string;
        startYear: number;
        endYear: number;
        shiftYears: number;
        firstFixedYear: number;
        lastMovedYear: number;
        missingRange: { startYear: number; endYear: number };
    };

export const planDiagnosisEventEdit = (
    event: DiagnosisEvent,
    selectedYear: number,
    seriesStartYear: number,
    seriesEndYear: number,
): DiagnosisEventEditPlan | null => {
    if (event.stale
        || selectedYear < event.startYear
        || selectedYear > event.endYear
        || seriesStartYear > seriesEndYear) {
        return null;
    }
    if (event.eventType === "missingRing") {
        return {
            operationType: "INSERT_MISSING_RING",
            targetTree: event.seriesId,
            targetYear: selectedYear,
            side: "right",
        };
    }
    if (event.eventType === "falseRing") {
        return {
            operationType: "DELETE_FALSE_RING",
            targetTree: event.seriesId,
            targetYear: selectedYear,
            shift: "right",
        };
    }
    if (event.eventType !== "partialMove"
        || event.shiftSide !== "older"
        || !isNegativePartialShift(event.shiftYears)) {
        return null;
    }
    const breakpoint = partialMoveBreakpoint(
        selectedYear,
        seriesStartYear,
        seriesEndYear,
        event.shiftYears,
    );
    if (!breakpoint) return null;
    return {
        operationType: "SHIFT_RANGE",
        targetTree: event.seriesId,
        startYear: breakpoint.movedRange.startYear,
        endYear: breakpoint.movedRange.endYear,
        shiftYears: event.shiftYears,
        firstFixedYear: breakpoint.firstFixedYear,
        lastMovedYear: breakpoint.lastMovedYear,
        missingRange: breakpoint.missingRange,
    };
};

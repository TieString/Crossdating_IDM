import type { DeleteMode, DeleteRangeFill, DeleteShift, MissingInsertSide } from "@/features/rwl/edit";
import type { WholeSeriesMoveDirection } from "./manualMovePlan";

export const WIDTH_GRID_CONTEXT_MENU_PREFERENCES_STORAGE_KEY = "crossdating.widthGridContextMenuPreferences.v1";

export interface WidthGridContextMenuPreferences {
    insertSide: MissingInsertSide;
    deleteMode: DeleteMode;
    deleteShift: DeleteShift;
    rangeDeleteFill: DeleteRangeFill;
    wholeMoveDirection: WholeSeriesMoveDirection;
}

export const DEFAULT_WIDTH_GRID_CONTEXT_MENU_PREFERENCES: WidthGridContextMenuPreferences = {
    insertSide: "right",
    deleteMode: "direct",
    deleteShift: "right",
    rangeDeleteFill: "missing",
    wholeMoveDirection: "older",
};

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const getDefaultStorage = (): PreferenceStorage | null => {
    try {
        return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
    } catch {
        return null;
    }
};

export const normalizeWidthGridContextMenuPreferences = (value: unknown): WidthGridContextMenuPreferences => {
    const candidate = value && typeof value === "object"
        ? value as Partial<WidthGridContextMenuPreferences>
        : {};

    return {
        insertSide: candidate.insertSide === "left" || candidate.insertSide === "right"
            ? candidate.insertSide
            : DEFAULT_WIDTH_GRID_CONTEXT_MENU_PREFERENCES.insertSide,
        deleteMode: candidate.deleteMode === "direct"
            || candidate.deleteMode === "left"
            || candidate.deleteMode === "right"
            || candidate.deleteMode === "both"
            ? candidate.deleteMode
            : DEFAULT_WIDTH_GRID_CONTEXT_MENU_PREFERENCES.deleteMode,
        deleteShift: candidate.deleteShift === "left" || candidate.deleteShift === "right"
            ? candidate.deleteShift
            : DEFAULT_WIDTH_GRID_CONTEXT_MENU_PREFERENCES.deleteShift,
        rangeDeleteFill: candidate.rangeDeleteFill === "missing"
            || candidate.rangeDeleteFill === "left"
            || candidate.rangeDeleteFill === "right"
            ? candidate.rangeDeleteFill
            : DEFAULT_WIDTH_GRID_CONTEXT_MENU_PREFERENCES.rangeDeleteFill,
        wholeMoveDirection: candidate.wholeMoveDirection === "older" || candidate.wholeMoveDirection === "newer"
            ? candidate.wholeMoveDirection
            : DEFAULT_WIDTH_GRID_CONTEXT_MENU_PREFERENCES.wholeMoveDirection,
    };
};

export function loadWidthGridContextMenuPreferences(
    storage: PreferenceStorage | null = getDefaultStorage(),
): WidthGridContextMenuPreferences {
    if (!storage) {
        return { ...DEFAULT_WIDTH_GRID_CONTEXT_MENU_PREFERENCES };
    }

    try {
        const raw = storage.getItem(WIDTH_GRID_CONTEXT_MENU_PREFERENCES_STORAGE_KEY);
        return raw
            ? normalizeWidthGridContextMenuPreferences(JSON.parse(raw))
            : { ...DEFAULT_WIDTH_GRID_CONTEXT_MENU_PREFERENCES };
    } catch {
        return { ...DEFAULT_WIDTH_GRID_CONTEXT_MENU_PREFERENCES };
    }
}

export function saveWidthGridContextMenuPreferences(
    preferences: WidthGridContextMenuPreferences,
    storage: PreferenceStorage | null = getDefaultStorage(),
): void {
    if (!storage) return;

    try {
        storage.setItem(
            WIDTH_GRID_CONTEXT_MENU_PREFERENCES_STORAGE_KEY,
            JSON.stringify(normalizeWidthGridContextMenuPreferences(preferences)),
        );
    } catch {
        // localStorage may be unavailable; keep the in-memory selection usable.
    }
}

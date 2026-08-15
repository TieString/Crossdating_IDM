import { describe, expect, it } from "vitest";
import {
    DEFAULT_WIDTH_GRID_CONTEXT_MENU_PREFERENCES,
    WIDTH_GRID_CONTEXT_MENU_PREFERENCES_STORAGE_KEY,
    loadWidthGridContextMenuPreferences,
    saveWidthGridContextMenuPreferences,
} from "./widthGridContextMenuPreferences";

const createMemoryStorage = () => {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
    };
};

describe("width-grid context-menu preferences", () => {
    it("uses defaults when no saved preference exists", () => {
        expect(loadWidthGridContextMenuPreferences(createMemoryStorage())).toEqual(
            DEFAULT_WIDTH_GRID_CONTEXT_MENU_PREFERENCES,
        );
    });

    it("persists every categorical option and restores it on the next load", () => {
        const storage = createMemoryStorage();
        const selected = {
            insertSide: "left",
            deleteMode: "both",
            deleteShift: "left",
            rangeDeleteFill: "right",
            wholeMoveDirection: "newer",
        } as const;

        saveWidthGridContextMenuPreferences(selected, storage);

        expect(loadWidthGridContextMenuPreferences(storage)).toEqual(selected);
    });

    it("keeps valid saved fields and falls back field-by-field for invalid values", () => {
        const storage = createMemoryStorage();
        storage.setItem(WIDTH_GRID_CONTEXT_MENU_PREFERENCES_STORAGE_KEY, JSON.stringify({
            insertSide: "left",
            deleteMode: "invalid",
            deleteShift: "right",
            rangeDeleteFill: "invalid",
            wholeMoveDirection: "newer",
        }));

        expect(loadWidthGridContextMenuPreferences(storage)).toEqual({
            insertSide: "left",
            deleteMode: "direct",
            deleteShift: "right",
            rangeDeleteFill: "missing",
            wholeMoveDirection: "newer",
        });
    });
});

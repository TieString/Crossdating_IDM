import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_SETTINGS,
    loadSettings,
    saveSettings,
    STORAGE_KEY,
} from "./settings";

const createMemoryStorage = (): Storage => {
    const values = new Map<string, string>();
    return {
        get length() {
            return values.size;
        },
        clear: () => values.clear(),
        getItem: (key) => values.get(key) ?? null,
        key: (index) => Array.from(values.keys())[index] ?? null,
        removeItem: (key) => {
            values.delete(key);
        },
        setItem: (key, value) => {
            values.set(key, value);
        },
    };
};

describe("settings", () => {
    beforeEach(() => {
        vi.stubGlobal("localStorage", createMemoryStorage());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("enables automatic dating suggestions when migrating older settings", () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            animation: DEFAULT_SETTINGS.animation,
            cofecha: DEFAULT_SETTINGS.cofecha,
        }));

        expect(loadSettings().diagnosis.enabled).toBe(true);
        expect(loadSettings().treeRingImage.showGeneratedPreview).toBe(true);
        expect(loadSettings().cofecha.executablePath).toBe("");
    });

    it("persists and normalizes one user-selected COFECHA executable path", () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            cofecha: {
                executablePath: "  C:\\LTRR\\COFECHA.EXE  ",
            },
        }));

        expect(loadSettings().cofecha).toEqual({
            executablePath: "C:\\LTRR\\COFECHA.EXE",
        });
    });

    it("persists a disabled automatic dating-suggestion setting", () => {
        saveSettings({
            ...DEFAULT_SETTINGS,
            diagnosis: { enabled: false },
        });

        expect(loadSettings().diagnosis.enabled).toBe(false);
    });

    it("persists a hidden generated tree-ring preview setting", () => {
        saveSettings({
            ...DEFAULT_SETTINGS,
            treeRingImage: { showGeneratedPreview: false },
        });

        expect(loadSettings().treeRingImage.showGeneratedPreview).toBe(false);
    });
});

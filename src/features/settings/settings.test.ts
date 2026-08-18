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
    });

    it("persists a disabled automatic dating-suggestion setting", () => {
        saveSettings({
            ...DEFAULT_SETTINGS,
            diagnosis: { enabled: false },
        });

        expect(loadSettings().diagnosis.enabled).toBe(false);
    });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    getPersistedCofechaEngine,
    loadPersistedCofechaState,
    loadPersistedReferenceState,
    persistCofechaState,
    persistReferenceState,
} from "./workspacePersistence";

const createMemoryStorage = (): Storage => {
    const values = new Map<string, string>();
    return {
        get length() {
            return values.size;
        },
        clear() {
            values.clear();
        },
        getItem(key) {
            return values.get(key) ?? null;
        },
        key(index) {
            return Array.from(values.keys())[index] ?? null;
        },
        removeItem(key) {
            values.delete(key);
        },
        setItem(key, value) {
            values.set(key, value);
        },
    };
};

describe("workspace persistence browser fallback", () => {
    const originalWindow = globalThis.window;

    beforeEach(() => {
        Object.defineProperty(globalThis, "window", {
            configurable: true,
            value: { localStorage: createMemoryStorage() },
        });
    });

    afterEach(() => {
        if (originalWindow === undefined) {
            Reflect.deleteProperty(globalThis, "window");
        } else {
            Object.defineProperty(globalThis, "window", {
                configurable: true,
                value: originalWindow,
            });
        }
    });

    it("round-trips COFECHA state through the async API", async () => {
        const filePath = "D:/软件测试/co612.rwl";
        await persistCofechaState(
            filePath,
            "PART 6: smoke",
            undefined,
            "javascript",
            "PART 6",
            "hash-smoke",
            { filePath: "D:/软件测试/undated.rwl", fileName: "undated.rwl", sort: "adjustment" },
            "undated-hash",
            { cofechaJsVersion: "0.2.0", reportExecutablePath: null, reportIsStale: false },
        );

        await expect(loadPersistedCofechaState(filePath)).resolves.toMatchObject({
            version: 1,
            outFileContent: "PART 6: smoke",
            cofechaEngine: "javascript",
            selectedPart: "PART 6",
            cofechaInputSignature: "hash-smoke",
            cofechaUndatedInputSignature: "undated-hash",
            reportIsStale: false,
            undated: { filePath: "D:/软件测试/undated.rwl", fileName: "undated.rwl", sort: "adjustment" },
        });
    });

    it("maps legacy persisted report versions to the official engine", () => {
        expect(getPersistedCofechaEngine({ version: 1, savedAt: "2026-01-01T00:00:00Z",
            outFileContent: "", cofechaVersion: "cofecha", selectedPart: "全部" })).toBe("official");
    });

    it("round-trips reference state without requiring Tauri", async () => {
        const filePath = "D:/软件测试/co612.rwl";
        await persistReferenceState(filePath, null, null, [], 7);

        await expect(loadPersistedReferenceState(filePath)).resolves.toMatchObject({
            version: 1,
            referenceConfig: null,
            dynamicReferenceConfig: null,
            referenceOperationLog: [],
            referenceOperationCounter: 7,
        });
    });
});

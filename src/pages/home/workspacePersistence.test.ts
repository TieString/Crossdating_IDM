import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
            "cofecha",
            "PART 6",
            "hash-smoke",
        );

        await expect(loadPersistedCofechaState(filePath)).resolves.toMatchObject({
            version: 1,
            outFileContent: "PART 6: smoke",
            selectedPart: "PART 6",
            cofechaInputSignature: "hash-smoke",
        });
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

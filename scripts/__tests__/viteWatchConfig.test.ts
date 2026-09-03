import { describe, expect, it } from "vitest";
import configuration from "../../vite.config";

describe("development watcher boundaries", () => {
    it("excludes research caches without disabling source hot reload", async () => {
        if (typeof configuration !== "function") throw new Error("Expected Vite config function");
        const config = await configuration({ command: "serve", mode: "development" });
        expect(config.server?.watch).not.toBeNull();
        expect(config.server?.watch?.ignored).toEqual(expect.arrayContaining([
            "**/src-tauri/**", "**/.benchmark-results/**", "**/__pycache__/**",
        ]));
        expect(config.server?.watch?.ignored).not.toContain("**/src/**");
        expect(config.server?.watch?.ignored).not.toContain("**/public/**");
        expect(config.server?.port).toBe(1420);
        expect(config.server?.strictPort).toBe(true);
        expect(config.optimizeDeps?.entries).toEqual(["index.html"]);
    });
});

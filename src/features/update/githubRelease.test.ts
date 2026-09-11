import { describe, expect, it, vi } from "vitest";
import {
    AUTO_UPDATE_CHECK_INTERVAL_MS,
    CURRENT_APP_VERSION,
    checkGitHubRelease,
    compareVersions,
    readAutoUpdateCheckEnabled,
    shouldRunAutomaticUpdateCheck,
    writeAutoUpdateCheckEnabled,
} from "./githubRelease";
import tauriConfig from "../../../src-tauri/tauri.conf.json";

const release = (tag = "v1.6.3") => ({
    tag_name: tag,
    name: `Crossdating IDM ${tag.slice(1)}`,
    body: "notes",
    html_url: `https://github.com/TieString/Crossdating_IDM/releases/tag/${tag}`,
    published_at: "2026-09-11T00:00:00Z",
    draft: false,
    prerelease: false,
});

const response = (body: unknown, ok = true, status = 200) => vi.fn(async (_input: string, _init?: RequestInit) => ({
    ok,
    status,
    json: async () => body,
}));

describe("GitHub release update checks", () => {
    it("keeps the package and Tauri application versions aligned", () => {
        expect(tauriConfig.version).toBe(CURRENT_APP_VERSION);
    });

    it("compares numeric SemVer components instead of lexicographic strings", () => {
        expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
        expect(compareVersions("v1.6.2", "1.6.2")).toBe(0);
        expect(compareVersions("1.6.3-beta.2", "1.6.3-beta.10")).toBe(-1);
        expect(compareVersions("1.6.3", "1.6.3-beta.10")).toBe(1);
    });

    it("reports a newer stable release without downloading assets", async () => {
        const fetcher = response(release());
        const result = await checkGitHubRelease("1.6.2", fetcher);
        expect(result.status).toBe("available");
        expect(result.latest.version).toBe("1.6.3");
        expect(result.latest.htmlUrl).toContain("/releases/tag/v1.6.3");
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
    });

    it("treats the same or an older latest tag as current", async () => {
        await expect(checkGitHubRelease("1.6.2", response(release("v1.6.2"))))
            .resolves.toMatchObject({ status: "current" });
        await expect(checkGitHubRelease("1.6.2", response(release("v1.5.9"))))
            .resolves.toMatchObject({ status: "current" });
    });

    it("rejects malformed, prerelease, or non-repository release metadata", async () => {
        await expect(checkGitHubRelease("1.6.2", response({ ...release(), tag_name: "latest" }))).rejects.toThrow();
        await expect(checkGitHubRelease("1.6.2", response({ ...release(), prerelease: true }))).rejects.toThrow();
        await expect(checkGitHubRelease("1.6.2", response({ ...release(), html_url: "https://example.com/release" }))).rejects.toThrow();
    });

    it("surfaces GitHub HTTP failures", async () => {
        await expect(checkGitHubRelease("1.6.2", response({}, false, 403))).rejects.toThrow("github-http-403");
    });
});

describe("automatic update check preferences", () => {
    const makeStorage = (initial: Record<string, string> = {}) => {
        const values = new Map(Object.entries(initial));
        return {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => { values.set(key, value); },
        };
    };

    it("defaults automatic checks to enabled and persists opt-out", () => {
        const storage = makeStorage();
        expect(readAutoUpdateCheckEnabled(storage)).toBe(true);
        expect(writeAutoUpdateCheckEnabled(false, storage)).toBe(true);
        expect(readAutoUpdateCheckEnabled(storage)).toBe(false);
    });

    it("runs at most once per interval unless the preference is disabled", () => {
        const now = 1_800_000_000_000;
        expect(shouldRunAutomaticUpdateCheck(now, makeStorage())).toBe(true);
        expect(shouldRunAutomaticUpdateCheck(now, makeStorage({
            "crossdating-idm-update-last-check": String(now - AUTO_UPDATE_CHECK_INTERVAL_MS + 1),
        }))).toBe(false);
        expect(shouldRunAutomaticUpdateCheck(now, makeStorage({
            "crossdating-idm-update-last-check": String(now - AUTO_UPDATE_CHECK_INTERVAL_MS),
        }))).toBe(true);
        expect(shouldRunAutomaticUpdateCheck(now, makeStorage({
            "crossdating-idm-auto-update-check": "false",
        }))).toBe(false);
    });
});

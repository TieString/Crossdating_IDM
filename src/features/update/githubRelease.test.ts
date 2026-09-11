import { describe, expect, it, vi } from "vitest";
import {
    AUTO_UPDATE_CHECK_INTERVAL_MS,
    CDN_UPDATE_MANIFEST_URL,
    CURRENT_APP_VERSION,
    GITHUB_LATEST_RELEASE_API,
    GITHUB_LATEST_RELEASE_PAGE,
    UPDATE_CDN_FALLBACK_KEY,
    UPDATE_PROXY_KEY,
    UpdateCheckError,
    checkGitHubRelease,
    compareVersions,
    normalizeUpdateProxyUrl,
    readAutoUpdateCheckEnabled,
    readCdnFallbackEnabled,
    readUpdateProxyUrl,
    shouldRunAutomaticUpdateCheck,
    writeAutoUpdateCheckEnabled,
    writeCdnFallbackEnabled,
    writeUpdateProxyUrl,
} from "./githubRelease";
import tauriConfig from "../../../src-tauri/tauri.conf.json";

const release = (tag = "v1.6.5") => ({
    tag_name: tag,
    name: `Crossdating IDM ${tag.slice(1)}`,
    body: "notes",
    html_url: `https://github.com/TieString/Crossdating_IDM/releases/tag/${tag}`,
    published_at: "2026-09-12T00:00:00Z",
    draft: false,
    prerelease: false,
});

const manifest = (tag = "v1.6.5") => ({
    repository: "TieString/Crossdating_IDM",
    channel: "stable",
    version: tag.slice(1),
    tag,
    name: `Crossdating IDM ${tag.slice(1)}`,
    body: "mirror notes",
    releaseUrl: `https://github.com/TieString/Crossdating_IDM/releases/tag/${tag}`,
    publishedAt: "2026-09-12T00:00:00Z",
});

interface MockResponse {
    ok: boolean;
    status: number;
    url?: string;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
}

const response = (
    body: unknown,
    {
        ok = true,
        status = 200,
        url = "",
        text = "",
    }: { ok?: boolean; status?: number; url?: string; text?: string } = {},
): MockResponse => ({
    ok,
    status,
    url,
    json: async () => body,
    text: async () => text,
});

const makeStorage = (initial: Record<string, string> = {}) => {
    const values = new Map(Object.entries(initial));
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        values,
    };
};

describe("GitHub release update checks", () => {
    it("keeps the package and Tauri application versions aligned", () => {
        expect(tauriConfig.version).toBe(CURRENT_APP_VERSION);
    });

    it("compares numeric SemVer components instead of lexicographic strings", () => {
        expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
        expect(compareVersions("v1.6.4", "1.6.4")).toBe(0);
        expect(compareVersions("1.6.5-beta.2", "1.6.5-beta.10")).toBe(-1);
        expect(compareVersions("1.6.5", "1.6.5-beta.10")).toBe(1);
    });

    it("uses GitHub API first and never downloads release assets", async () => {
        const fetcher = vi.fn(async (input: string) => {
            expect(input).toBe(GITHUB_LATEST_RELEASE_API);
            return response(release());
        });
        const result = await checkGitHubRelease("1.6.4", { fetcher });
        expect(result.status).toBe("available");
        expect(result.latest.version).toBe("1.6.5");
        expect(result.source).toBe("github-api");
        expect(result.attempts).toEqual([{ source: "github-api", ok: true }]);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("falls back to the GitHub releases page when api.github.com is unreachable", async () => {
        const fetcher = vi.fn(async (input: string) => {
            if (input === GITHUB_LATEST_RELEASE_API) throw new TypeError("network failed");
            expect(input).toBe(GITHUB_LATEST_RELEASE_PAGE);
            return response({}, {
                url: "https://github.com/TieString/Crossdating_IDM/releases/tag/v1.6.5",
                text: "<html></html>",
            });
        });
        const result = await checkGitHubRelease("1.6.4", { fetcher, useCdnFallback: false });
        expect(result.source).toBe("github-web");
        expect(result.status).toBe("available");
        expect(result.attempts[0]).toMatchObject({ source: "github-api", ok: false, reason: "network" });
        expect(result.attempts[1]).toEqual({ source: "github-web", ok: true });
    });

    it("falls back to the read-only CDN manifest when both GitHub endpoints fail", async () => {
        const fetcher = vi.fn(async (input: string) => {
            if (input === CDN_UPDATE_MANIFEST_URL) return response(manifest());
            throw new TypeError("blocked");
        });
        const result = await checkGitHubRelease("1.6.4", { fetcher, useCdnFallback: true });
        expect(result.source).toBe("cdn-manifest");
        expect(result.latest.htmlUrl).toBe("https://github.com/TieString/Crossdating_IDM/releases/tag/v1.6.5");
        expect(result.attempts).toHaveLength(3);
    });

    it("does not use the CDN fallback when it is disabled", async () => {
        const fetcher = vi.fn(async () => { throw new TypeError("blocked"); });
        await expect(checkGitHubRelease("1.6.4", { fetcher, useCdnFallback: false }))
            .rejects.toBeInstanceOf(UpdateCheckError);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("records HTTP and invalid-data failures for diagnostics", async () => {
        const fetcher = vi.fn(async (input: string) => {
            if (input === GITHUB_LATEST_RELEASE_API) return response({}, { ok: false, status: 403 });
            if (input === GITHUB_LATEST_RELEASE_PAGE) return response({}, { text: "<html>no release</html>" });
            return response({ ...manifest(), releaseUrl: "https://example.com/fake" });
        });
        try {
            await checkGitHubRelease("1.6.4", { fetcher });
            throw new Error("expected failure");
        } catch (error) {
            expect(error).toBeInstanceOf(UpdateCheckError);
            const attempts = (error as UpdateCheckError).attempts;
            expect(attempts[0]).toMatchObject({ source: "github-api", reason: "http", status: 403 });
            expect(attempts[1]).toMatchObject({ source: "github-web", reason: "invalid-data" });
            expect(attempts[2]).toMatchObject({ source: "cdn-manifest", reason: "invalid-data" });
        }
    });

    it("rejects prerelease and non-repository API metadata", async () => {
        const invalid = [
            { ...release(), prerelease: true },
            { ...release(), html_url: "https://example.com/release" },
            { ...release(), tag_name: "latest" },
        ];
        for (const body of invalid) {
            const fetcher = vi.fn(async (input: string) => {
                if (input === GITHUB_LATEST_RELEASE_API) return response(body);
                throw new TypeError("blocked");
            });
            await expect(checkGitHubRelease("1.6.4", { fetcher, useCdnFallback: false }))
                .rejects.toBeInstanceOf(UpdateCheckError);
        }
    });
});

describe("update network preferences", () => {
    it("normalizes and persists an HTTP/HTTPS proxy without credentials", () => {
        expect(normalizeUpdateProxyUrl(" http://127.0.0.1:7890/ ")).toBe("http://127.0.0.1:7890");
        expect(() => normalizeUpdateProxyUrl("socks5://127.0.0.1:7890")).toThrow("invalid-proxy-url");
        expect(() => normalizeUpdateProxyUrl("http://user:pass@127.0.0.1:7890")).toThrow("proxy-auth-not-supported");

        const storage = makeStorage();
        expect(writeUpdateProxyUrl("http://127.0.0.1:7890", storage)).toBe(true);
        expect(storage.values.get(UPDATE_PROXY_KEY)).toBe("http://127.0.0.1:7890");
        expect(readUpdateProxyUrl(storage)).toBe("http://127.0.0.1:7890");
    });

    it("defaults the CDN fallback to enabled and persists opt-out", () => {
        const storage = makeStorage();
        expect(readCdnFallbackEnabled(storage)).toBe(true);
        expect(writeCdnFallbackEnabled(false, storage)).toBe(true);
        expect(storage.values.get(UPDATE_CDN_FALLBACK_KEY)).toBe("false");
        expect(readCdnFallbackEnabled(storage)).toBe(false);
    });
});

describe("automatic update check preferences", () => {
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

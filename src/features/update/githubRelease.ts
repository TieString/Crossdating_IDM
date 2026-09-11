import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import packageMetadata from "../../../package.json";

export const CURRENT_APP_VERSION = packageMetadata.version;
export const GITHUB_RELEASES_URL = "https://github.com/TieString/Crossdating_IDM/releases";
export const GITHUB_LATEST_RELEASE_API = "https://api.github.com/repos/TieString/Crossdating_IDM/releases/latest";
export const AUTO_UPDATE_CHECK_KEY = "crossdating-idm-auto-update-check";
export const LAST_UPDATE_CHECK_KEY = "crossdating-idm-update-last-check";
export const AUTO_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface GitHubReleaseInfo {
    version: string;
    tagName: string;
    name: string;
    body: string;
    htmlUrl: string;
    publishedAt: string | null;
}

export type UpdateCheckResult =
    | { status: "available"; currentVersion: string; latest: GitHubReleaseInfo }
    | { status: "current"; currentVersion: string; latest: GitHubReleaseInfo };

interface GitHubReleasePayload {
    tag_name?: unknown;
    name?: unknown;
    body?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    draft?: unknown;
    prerelease?: unknown;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
}>;

interface ParsedVersion {
    major: number;
    minor: number;
    patch: number;
    prerelease: string[];
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const defaultUpdateFetch: FetchLike = async (input, init) => {
    if (isTauri()) return tauriFetch(input, init);
    return globalThis.fetch(input, init);
};

function parseVersion(value: string): ParsedVersion | null {
    const match = value.trim().match(VERSION_PATTERN);
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ? match[4].split(".") : [],
    };
}

function comparePrerelease(left: string[], right: string[]): number {
    if (left.length === 0 && right.length === 0) return 0;
    if (left.length === 0) return 1;
    if (right.length === 0) return -1;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        if (left[index] === undefined) return -1;
        if (right[index] === undefined) return 1;
        const leftNumeric = /^\d+$/.test(left[index]);
        const rightNumeric = /^\d+$/.test(right[index]);
        if (leftNumeric && rightNumeric) {
            const difference = Number(left[index]) - Number(right[index]);
            if (difference !== 0) return Math.sign(difference);
            continue;
        }
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        const lexical = left[index].localeCompare(right[index]);
        if (lexical !== 0) return Math.sign(lexical);
    }
    return 0;
}

/** SemVer comparison for application and GitHub release tags. */
export function compareVersions(left: string, right: string): number {
    const parsedLeft = parseVersion(left);
    const parsedRight = parseVersion(right);
    if (!parsedLeft || !parsedRight) throw new Error("invalid-version");
    for (const key of ["major", "minor", "patch"] as const) {
        const difference = parsedLeft[key] - parsedRight[key];
        if (difference !== 0) return Math.sign(difference);
    }
    return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

function parseRelease(payload: unknown): GitHubReleaseInfo {
    if (!payload || typeof payload !== "object") throw new Error("invalid-release");
    const release = payload as GitHubReleasePayload;
    if (release.draft === true || release.prerelease === true) throw new Error("invalid-release");
    if (typeof release.tag_name !== "string") throw new Error("invalid-release");
    const parsed = parseVersion(release.tag_name);
    if (!parsed) throw new Error("invalid-release-version");
    if (typeof release.html_url !== "string" || !release.html_url.startsWith(`${GITHUB_RELEASES_URL}/`)) {
        throw new Error("invalid-release-url");
    }
    const version = `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease.length ? `-${parsed.prerelease.join(".")}` : ""}`;
    return {
        version,
        tagName: release.tag_name,
        name: typeof release.name === "string" && release.name.trim() ? release.name : release.tag_name,
        body: typeof release.body === "string" ? release.body : "",
        htmlUrl: release.html_url,
        publishedAt: typeof release.published_at === "string" ? release.published_at : null,
    };
}

/** Queries GitHub metadata only; it never downloads or installs release assets. */
export async function checkGitHubRelease(
    currentVersion = CURRENT_APP_VERSION,
    fetcher: FetchLike = defaultUpdateFetch,
    timeoutMs = 8_000,
): Promise<UpdateCheckResult> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetcher(GITHUB_LATEST_RELEASE_API, {
            method: "GET",
            headers: {
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            cache: "no-store",
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`github-http-${response.status}`);
        const latest = parseRelease(await response.json());
        return compareVersions(latest.version, currentVersion) > 0
            ? { status: "available", currentVersion, latest }
            : { status: "current", currentVersion, latest };
    } finally {
        globalThis.clearTimeout(timeout);
    }
}

export function readAutoUpdateCheckEnabled(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
    try { return storage?.getItem(AUTO_UPDATE_CHECK_KEY) !== "false"; }
    catch { return true; }
}

export function writeAutoUpdateCheckEnabled(
    enabled: boolean,
    storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): boolean {
    try {
        storage?.setItem(AUTO_UPDATE_CHECK_KEY, String(enabled));
        return true;
    } catch {
        return false;
    }
}

export function shouldRunAutomaticUpdateCheck(
    now = Date.now(),
    storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): boolean {
    if (!readAutoUpdateCheckEnabled(storage)) return false;
    try {
        const lastCheck = Number(storage?.getItem(LAST_UPDATE_CHECK_KEY));
        return !Number.isFinite(lastCheck) || lastCheck <= 0 || now - lastCheck >= AUTO_UPDATE_CHECK_INTERVAL_MS;
    } catch {
        return true;
    }
}

export function markAutomaticUpdateCheck(
    now = Date.now(),
    storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): void {
    try { storage?.setItem(LAST_UPDATE_CHECK_KEY, String(now)); }
    catch { /* A blocked preference store must not break update checking. */ }
}

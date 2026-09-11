import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import packageMetadata from "../../../package.json";

export const CURRENT_APP_VERSION = packageMetadata.version;
export const GITHUB_RELEASES_URL = "https://github.com/TieString/Crossdating_IDM/releases";
export const GITHUB_LATEST_RELEASE_API = "https://api.github.com/repos/TieString/Crossdating_IDM/releases/latest";
export const GITHUB_LATEST_RELEASE_PAGE = `${GITHUB_RELEASES_URL}/latest`;
export const CDN_UPDATE_MANIFEST_URL = "https://cdn.jsdelivr.net/gh/TieString/Crossdating_IDM@main/update.json";

export const AUTO_UPDATE_CHECK_KEY = "crossdating-idm-auto-update-check";
export const LAST_UPDATE_CHECK_KEY = "crossdating-idm-update-last-check";
export const UPDATE_PROXY_KEY = "crossdating-idm-update-proxy";
export const UPDATE_CDN_FALLBACK_KEY = "crossdating-idm-update-cdn-fallback";
export const AUTO_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export type UpdateSource = "github-api" | "github-web" | "cdn-manifest";
export type UpdateFailureReason = "timeout" | "network" | "http" | "invalid-data" | "permission";

export interface UpdateAttempt {
    source: UpdateSource;
    ok: boolean;
    reason?: UpdateFailureReason;
    status?: number;
}

export interface GitHubReleaseInfo {
    version: string;
    tagName: string;
    name: string;
    body: string;
    htmlUrl: string;
    publishedAt: string | null;
}

export type UpdateCheckResult =
    | { status: "available"; currentVersion: string; latest: GitHubReleaseInfo; source: UpdateSource; attempts: UpdateAttempt[] }
    | { status: "current"; currentVersion: string; latest: GitHubReleaseInfo; source: UpdateSource; attempts: UpdateAttempt[] };

interface GitHubReleasePayload {
    tag_name?: unknown;
    name?: unknown;
    body?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    draft?: unknown;
    prerelease?: unknown;
}

interface UpdateManifestPayload {
    repository?: unknown;
    channel?: unknown;
    version?: unknown;
    tag?: unknown;
    name?: unknown;
    body?: unknown;
    releaseUrl?: unknown;
    publishedAt?: unknown;
}

interface ResponseLike {
    ok: boolean;
    status: number;
    url?: string;
    json: () => Promise<unknown>;
    text?: () => Promise<string>;
}

type FetchInit = RequestInit & {
    connectTimeout?: number;
    proxy?: { all: string };
};

type FetchLike = (input: string, init?: FetchInit) => Promise<ResponseLike>;

export interface UpdateCheckOptions {
    fetcher?: FetchLike;
    timeoutMs?: number;
    proxyUrl?: string;
    useCdnFallback?: boolean;
    storage?: Pick<Storage, "getItem">;
}

interface ParsedVersion {
    major: number;
    minor: number;
    patch: number;
    prerelease: string[];
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const RELEASE_TAG_URL_PATTERN = /^https:\/\/github\.com\/TieString\/Crossdating_IDM\/releases\/tag\/([^/?#]+)\/?$/;
const RELEASE_TAG_IN_HTML_PATTERN = /(?:https:\/\/github\.com)?\/TieString\/Crossdating_IDM\/releases\/tag\/(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

class SourceFailure extends Error {
    constructor(
        readonly reason: UpdateFailureReason,
        readonly status?: number,
    ) {
        super(reason);
    }
}

export class UpdateCheckError extends Error {
    constructor(readonly attempts: UpdateAttempt[]) {
        super("update-check-failed");
        this.name = "UpdateCheckError";
    }
}

const defaultUpdateFetch: FetchLike = async (input, init = {}) => {
    if (isTauri()) return tauriFetch(input, init as Parameters<typeof tauriFetch>[1]);

    const { proxy: _proxy, connectTimeout: _connectTimeout, ...webInit } = init;
    return globalThis.fetch(input, webInit);
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

function normalizedVersion(parsed: ParsedVersion): string {
    return `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease.length ? `-${parsed.prerelease.join(".")}` : ""}`;
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

/** SemVer comparison for application and release tags. */
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

function releaseFromTag(tagName: string, body = "", publishedAt: string | null = null, name?: string): GitHubReleaseInfo {
    const parsed = parseVersion(tagName);
    if (!parsed) throw new SourceFailure("invalid-data");
    const version = normalizedVersion(parsed);
    return {
        version,
        tagName,
        name: name?.trim() || `Crossdating IDM ${version}`,
        body,
        htmlUrl: `${GITHUB_RELEASES_URL}/tag/${encodeURIComponent(tagName)}`,
        publishedAt,
    };
}

function parseOfficialReleaseUrl(value: string): string | null {
    const match = value.match(RELEASE_TAG_URL_PATTERN);
    if (!match) return null;
    try {
        const tagName = decodeURIComponent(match[1]);
        return parseVersion(tagName) ? tagName : null;
    } catch {
        return null;
    }
}

function parseApiRelease(payload: unknown): GitHubReleaseInfo {
    if (!payload || typeof payload !== "object") throw new SourceFailure("invalid-data");
    const release = payload as GitHubReleasePayload;
    if (release.draft === true || release.prerelease === true) throw new SourceFailure("invalid-data");
    if (typeof release.tag_name !== "string") throw new SourceFailure("invalid-data");
    if (typeof release.html_url !== "string" || !parseOfficialReleaseUrl(release.html_url)) {
        throw new SourceFailure("invalid-data");
    }
    const parsed = parseVersion(release.tag_name);
    if (!parsed) throw new SourceFailure("invalid-data");
    const expectedTag = parseOfficialReleaseUrl(release.html_url);
    if (expectedTag !== release.tag_name) throw new SourceFailure("invalid-data");
    return {
        version: normalizedVersion(parsed),
        tagName: release.tag_name,
        name: typeof release.name === "string" && release.name.trim() ? release.name : release.tag_name,
        body: typeof release.body === "string" ? release.body : "",
        htmlUrl: release.html_url,
        publishedAt: typeof release.published_at === "string" ? release.published_at : null,
    };
}

function parseManifest(payload: unknown): GitHubReleaseInfo {
    if (!payload || typeof payload !== "object") throw new SourceFailure("invalid-data");
    const manifest = payload as UpdateManifestPayload;
    if (manifest.repository !== "TieString/Crossdating_IDM" || manifest.channel !== "stable") {
        throw new SourceFailure("invalid-data");
    }
    if (typeof manifest.version !== "string" || typeof manifest.tag !== "string" || typeof manifest.releaseUrl !== "string") {
        throw new SourceFailure("invalid-data");
    }
    const version = parseVersion(manifest.version);
    const tag = parseVersion(manifest.tag);
    const urlTag = parseOfficialReleaseUrl(manifest.releaseUrl);
    if (!version || !tag || !urlTag) throw new SourceFailure("invalid-data");
    if (normalizedVersion(version) !== normalizedVersion(tag) || urlTag !== manifest.tag) {
        throw new SourceFailure("invalid-data");
    }
    return {
        version: normalizedVersion(version),
        tagName: manifest.tag,
        name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name : `Crossdating IDM ${normalizedVersion(version)}`,
        body: typeof manifest.body === "string" ? manifest.body : "",
        htmlUrl: manifest.releaseUrl,
        publishedAt: typeof manifest.publishedAt === "string" ? manifest.publishedAt : null,
    };
}

export function normalizeUpdateProxyUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error("invalid-proxy-url");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid-proxy-url");
    if (parsed.username || parsed.password) throw new Error("proxy-auth-not-supported");
    if (!parsed.hostname) throw new Error("invalid-proxy-url");
    return parsed.toString().replace(/\/$/, "");
}

export function readUpdateProxyUrl(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): string {
    try {
        return normalizeUpdateProxyUrl(storage?.getItem(UPDATE_PROXY_KEY) ?? "");
    } catch {
        return "";
    }
}

export function writeUpdateProxyUrl(
    value: string,
    storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): boolean {
    try {
        storage?.setItem(UPDATE_PROXY_KEY, normalizeUpdateProxyUrl(value));
        return true;
    } catch {
        return false;
    }
}

export function readCdnFallbackEnabled(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
    try { return storage?.getItem(UPDATE_CDN_FALLBACK_KEY) !== "false"; }
    catch { return true; }
}

export function writeCdnFallbackEnabled(
    enabled: boolean,
    storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage,
): boolean {
    try {
        storage?.setItem(UPDATE_CDN_FALLBACK_KEY, String(enabled));
        return true;
    } catch {
        return false;
    }
}

function failureFromUnknown(error: unknown): SourceFailure {
    if (error instanceof SourceFailure) return error;
    if (error instanceof DOMException && error.name === "AbortError") return new SourceFailure("timeout");
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes("abort") || message.includes("timeout") || message.includes("timed out")) {
        return new SourceFailure("timeout");
    }
    if (message.includes("scope") || message.includes("permission") || message.includes("denied") || message.includes("not allowed")) {
        return new SourceFailure("permission");
    }
    return new SourceFailure("network");
}

async function fetchWithTimeout(
    input: string,
    fetcher: FetchLike,
    timeoutMs: number,
    proxyUrl: string,
    init: FetchInit = {},
): Promise<ResponseLike> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const requestInit: FetchInit = {
            ...init,
            signal: controller.signal,
            cache: "no-store",
        };
        if (proxyUrl && isTauri()) {
            requestInit.proxy = { all: proxyUrl };
            requestInit.connectTimeout = Math.min(timeoutMs, 6_000);
        }
        return await fetcher(input, requestInit);
    } finally {
        globalThis.clearTimeout(timeout);
    }
}

async function fetchFromApi(fetcher: FetchLike, timeoutMs: number, proxyUrl: string): Promise<GitHubReleaseInfo> {
    const response = await fetchWithTimeout(GITHUB_LATEST_RELEASE_API, fetcher, timeoutMs, proxyUrl, {
        method: "GET",
        headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });
    if (!response.ok) throw new SourceFailure("http", response.status);
    return parseApiRelease(await response.json());
}

async function fetchFromGitHubWeb(fetcher: FetchLike, timeoutMs: number, proxyUrl: string): Promise<GitHubReleaseInfo> {
    const response = await fetchWithTimeout(GITHUB_LATEST_RELEASE_PAGE, fetcher, timeoutMs, proxyUrl, {
        method: "GET",
        headers: { Accept: "text/html" },
    });
    if (!response.ok) throw new SourceFailure("http", response.status);

    const finalTag = typeof response.url === "string" ? parseOfficialReleaseUrl(response.url) : null;
    if (finalTag) return releaseFromTag(finalTag);

    if (response.text) {
        const html = await response.text();
        const match = html.match(RELEASE_TAG_IN_HTML_PATTERN);
        if (match?.[1]) return releaseFromTag(match[1]);
    }
    throw new SourceFailure("invalid-data");
}

async function fetchFromCdnManifest(fetcher: FetchLike, timeoutMs: number, proxyUrl: string): Promise<GitHubReleaseInfo> {
    const response = await fetchWithTimeout(CDN_UPDATE_MANIFEST_URL, fetcher, timeoutMs, proxyUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new SourceFailure("http", response.status);
    return parseManifest(await response.json());
}

function toResult(
    latest: GitHubReleaseInfo,
    currentVersion: string,
    source: UpdateSource,
    attempts: UpdateAttempt[],
): UpdateCheckResult {
    const common = { currentVersion, latest, source, attempts };
    return compareVersions(latest.version, currentVersion) > 0
        ? { status: "available", ...common }
        : { status: "current", ...common };
}

/**
 * Checks stable release metadata without downloading or installing assets.
 * It tries GitHub's API first, the GitHub releases page second, and an optional
 * read-only jsDelivr mirror manifest last.
 */
export async function checkGitHubRelease(
    currentVersion = CURRENT_APP_VERSION,
    options: UpdateCheckOptions = {},
): Promise<UpdateCheckResult> {
    const fetcher = options.fetcher ?? defaultUpdateFetch;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const proxyUrl = options.proxyUrl !== undefined
        ? normalizeUpdateProxyUrl(options.proxyUrl)
        : readUpdateProxyUrl(options.storage);
    const useCdnFallback = options.useCdnFallback ?? readCdnFallbackEnabled(options.storage);

    const sources: Array<[UpdateSource, () => Promise<GitHubReleaseInfo>]> = [
        ["github-api", () => fetchFromApi(fetcher, timeoutMs, proxyUrl)],
        ["github-web", () => fetchFromGitHubWeb(fetcher, timeoutMs, proxyUrl)],
    ];
    if (useCdnFallback) {
        sources.push(["cdn-manifest", () => fetchFromCdnManifest(fetcher, timeoutMs, proxyUrl)]);
    }

    const attempts: UpdateAttempt[] = [];
    for (const [source, load] of sources) {
        try {
            const latest = await load();
            attempts.push({ source, ok: true });
            return toResult(latest, currentVersion, source, [...attempts]);
        } catch (error) {
            const failure = failureFromUnknown(error);
            attempts.push({ source, ok: false, reason: failure.reason, status: failure.status });
        }
    }
    throw new UpdateCheckError(attempts);
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

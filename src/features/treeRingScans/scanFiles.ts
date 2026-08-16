import { invoke, isTauri } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { readDir, readFile } from "@tauri-apps/plugin-fs";
import type { TreeRingScanCrop, TreeRingScanFile } from "./types";
import { normalizeTreeRingScanSeriesKey } from "./types";

const SUPPORTED_SCAN_EXTENSIONS = new Set([
    "svg",
    "png",
    "jpg",
    "jpeg",
    "webp",
    "bmp",
    "gif",
    "tif",
    "tiff",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    bmp: "image/bmp",
    gif: "image/gif",
    tif: "image/tiff",
    tiff: "image/tiff",
};

interface ScanDirectoryEntry {
    name: string;
    isDirectory?: boolean;
    isFile?: boolean;
}

interface CachedScanImage {
    cacheKey: string;
    url: string;
    byteLength: number;
    cropApplied: boolean;
    referenceCount: number;
    lastUsed: number;
}

interface PreparedTreeRingScanImage {
    path: string;
    mimeType: string;
    cropApplied?: boolean;
}

export function isFullResolutionTreeRingScanCrop(
    extension: string,
    crop: TreeRingScanCrop | undefined,
    prepared: Pick<PreparedTreeRingScanImage, "cropApplied"> | null,
): boolean {
    if (!crop || !["tif", "tiff"].includes(extension.toLocaleLowerCase())) return true;
    return prepared?.cropApplied === true;
}

const PREPARE_SCAN_COMMAND = "prepare_tree_ring_scan_image";

export interface AcquiredTreeRingScanImage {
    url: string;
    byteLength: number;
    cropApplied: boolean;
    release: () => void;
}

const scanImageCache = new Map<string, CachedScanImage>();
const pendingScanImages = new Map<string, Promise<CachedScanImage>>();
const MAX_SCAN_IMAGE_CACHE_ENTRIES = 12;
const MAX_SCAN_IMAGE_CACHE_BYTES = 384 * 1024 * 1024;

const getExtension = (name: string): string => {
    const separator = name.lastIndexOf(".");
    return separator >= 0 ? name.slice(separator + 1).toLocaleLowerCase() : "";
};

const getStem = (name: string): string => {
    const separator = name.lastIndexOf(".");
    return separator >= 0 ? name.slice(0, separator) : name;
};

/** Match exact, case-insensitive series stems without loading any image bytes. */
export function matchTreeRingScanEntries(
    entries: readonly ScanDirectoryEntry[],
    seriesIds: readonly string[],
): Map<string, { name: string; extension: string }> {
    const supportedFiles = entries
        .filter((entry) => !entry.isDirectory)
        .map((entry) => ({
            name: entry.name,
            extension: getExtension(entry.name),
            normalizedStem: normalizeTreeRingScanSeriesKey(getStem(entry.name)),
        }))
        .filter((entry) => SUPPORTED_SCAN_EXTENSIONS.has(entry.extension));

    const byStem = new Map<string, { name: string; extension: string }>();
    supportedFiles.forEach(({ normalizedStem, name, extension }) => {
        if (!byStem.has(normalizedStem)) {
            byStem.set(normalizedStem, { name, extension });
        }
    });

    const matches = new Map<string, { name: string; extension: string }>();
    seriesIds.forEach((seriesId) => {
        const key = normalizeTreeRingScanSeriesKey(seriesId);
        const match = byStem.get(key);
        if (match) matches.set(key, match);
    });
    return matches;
}

/** Index one selected directory. Images remain unloaded until a viewer or header needs one. */
export async function indexTreeRingScanFolder(
    folderPath: string,
    seriesIds: readonly string[],
): Promise<Record<string, TreeRingScanFile>> {
    const entries = await readDir(folderPath);
    const matches = matchTreeRingScanEntries(entries, seriesIds);
    const result: Record<string, TreeRingScanFile> = {};

    await Promise.all(Array.from(matches.entries()).map(async ([seriesKey, match]) => {
        result[seriesKey] = {
            ...match,
            path: await join(folderPath, match.name),
        };
    }));
    return result;
}

function cachedScanImageBytes(): number {
    return Array.from(scanImageCache.values()).reduce((sum, entry) => sum + entry.byteLength, 0);
}

function trimScanImageCache(): void {
    const candidates = Array.from(scanImageCache.values())
        .filter((entry) => entry.referenceCount === 0)
        .sort((left, right) => left.lastUsed - right.lastUsed);
    while (
        candidates.length > 0
        && (
            scanImageCache.size > MAX_SCAN_IMAGE_CACHE_ENTRIES
            || cachedScanImageBytes() > MAX_SCAN_IMAGE_CACHE_BYTES
        )
    ) {
        const entry = candidates.shift()!;
        scanImageCache.delete(entry.cacheKey);
        URL.revokeObjectURL(entry.url);
    }
}

/**
 * Rust commands are not hot-reloaded with the Vite frontend. During development an
 * already-running Tauri process can therefore legitimately lack the new command.
 */
export function isMissingTreeRingScanPrepareCommandError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.toLocaleLowerCase().includes(`command ${PREPARE_SCAN_COMMAND} not found`)
        || (
            message.toLocaleLowerCase().includes(PREPARE_SCAN_COMMAND)
            && /(?:unknown|missing|not found)\s+command|command\s+(?:unknown|missing|not found)/i.test(message)
        );
}

async function prepareScanImageIfAvailable(
    path: string,
    crop?: TreeRingScanCrop,
): Promise<PreparedTreeRingScanImage | null> {
    if (typeof window === "undefined" || !isTauri()) return null;
    try {
        return await invoke<PreparedTreeRingScanImage>(PREPARE_SCAN_COMMAND, {
            sourcePath: path,
            crop: crop ?? null,
        });
    } catch (error) {
        if (isMissingTreeRingScanPrepareCommandError(error)) return null;
        throw error;
    }
}

const scanImageCacheKey = (path: string, crop?: TreeRingScanCrop) => (
    crop
        ? `${path}#${crop.xRatio},${crop.yRatio},${crop.widthRatio},${crop.heightRatio}`
        : path
);

async function loadScanImage(
    path: string,
    extension: string,
    crop?: TreeRingScanCrop,
): Promise<CachedScanImage> {
    const cacheKey = scanImageCacheKey(path, crop);
    const existing = scanImageCache.get(cacheKey);
    if (existing) return existing;

    const pending = pendingScanImages.get(cacheKey);
    if (pending) return pending;

    const promise = (async () => {
        const prepared = await prepareScanImageIfAvailable(path, crop);
        if (!isFullResolutionTreeRingScanCrop(extension, crop, prepared)) {
            throw new Error(
                "当前程序仍在使用旧版扫描影像后端，选框只能读取低分辨率总览；请完全退出并重新启动软件后再打开该截面。",
            );
        }
        const readablePath = prepared?.path ?? path;
        const bytes = await readFile(readablePath);
        const mime = prepared?.mimeType
            ?? MIME_BY_EXTENSION[extension.toLocaleLowerCase()]
            ?? "application/octet-stream";
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        const loaded: CachedScanImage = {
            cacheKey,
            url,
            byteLength: bytes.byteLength,
            cropApplied: prepared?.cropApplied ?? false,
            referenceCount: 0,
            lastUsed: Date.now(),
        };
        scanImageCache.set(cacheKey, loaded);
        trimScanImageCache();
        return loaded;
    })().finally(() => {
        pendingScanImages.delete(cacheKey);
    });
    pendingScanImages.set(cacheKey, promise);
    return promise;
}

/** Acquire a cached object URL. Call release when the consuming component unmounts. */
export async function acquireTreeRingScanImage(
    file: TreeRingScanFile,
    crop?: TreeRingScanCrop,
): Promise<AcquiredTreeRingScanImage> {
    if (/^(?:blob:|data:|https?:)/i.test(file.path) || file.path.startsWith("/")) {
        return {
            url: file.path,
            byteLength: 0,
            cropApplied: false,
            release: () => undefined,
        };
    }
    const entry = await loadScanImage(file.path, file.extension, crop);
    entry.referenceCount += 1;
    entry.lastUsed = Date.now();
    let released = false;
    return {
        url: entry.url,
        byteLength: entry.byteLength,
        cropApplied: entry.cropApplied,
        release: () => {
            if (released) return;
            released = true;
            entry.referenceCount = Math.max(0, entry.referenceCount - 1);
            entry.lastUsed = Date.now();
            trimScanImageCache();
        },
    };
}

export function clearTreeRingScanImageCache(): void {
    scanImageCache.forEach((entry) => URL.revokeObjectURL(entry.url));
    scanImageCache.clear();
    pendingScanImages.clear();
}

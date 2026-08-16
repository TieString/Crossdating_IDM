import type { RwlSiteData, RwlTreeData } from "@/features/rwl";

const WIDTH_VALUE_TO_MM = 1 / 1000;
const LATEWOOD_RATIO = 0.5;
const DOT_SPACING_SCALE = 0.5;
const RING_BOUNDARY_WIDTH_MM = 0.18;
const WINDOW_HEIGHT_MM = 10;
const CACHE_VERSION = "tree-ring-artwork-v2";
const MAX_CACHE_ENTRIES = 256;
const MAX_CACHE_SVG_BYTES = 32 * 1024 * 1024;

const DOT_PATTERN_SPECS = [
    ["latewood_dots_1", 1.25, [[0.24, 0.36, 0.055], [0.86, 0.94, 0.055]]],
    ["latewood_dots_2", 1.10, [[0.19, 0.81, 0.060], [0.76, 0.27, 0.060]]],
    ["latewood_dots_3", 0.96, [[0.18, 0.24, 0.065], [0.69, 0.73, 0.065]]],
    ["latewood_dots_4", 0.83, [[0.16, 0.61, 0.070], [0.61, 0.19, 0.070]]],
    ["latewood_dots_5", 0.71, [[0.13, 0.17, 0.075], [0.53, 0.55, 0.075]]],
    ["latewood_dots_6", 0.60, [[0.11, 0.44, 0.080], [0.45, 0.13, 0.080]]],
] as const;

export interface TreeRingGeometryRing {
    year: number;
    widthMm: number;
    outerRadiusMm: number;
}

export interface TreeRingGeometryGap {
    startYear: number;
    endYear: number;
    yearCount: number;
    radiusMm: number;
}

export interface TreeRingGeometry {
    rings: TreeRingGeometryRing[];
    gaps: TreeRingGeometryGap[];
    radiusMm: number;
    diameterMm: number;
    windowLeftMm: number;
    windowTopMm: number;
    windowWidthMm: number;
    windowHeightMm: number;
    cacheKey: string;
}

export interface TreeRingArtwork {
    cacheKey: string;
    previewUrl: string;
    fullUrl?: string;
    ringCount: number;
    startYear: number;
    endYear: number;
    radiusMm: number;
    geometry: TreeRingGeometry;
}

export interface TreeRingFeature {
    kind: "ring" | "gap";
    startYear: number;
    endYear: number;
    innerRadiusMm: number;
    outerRadiusMm: number;
    centreRadiusMm: number;
}

interface CachedArtwork {
    geometry: TreeRingGeometry;
    previewUrl: string;
    fullUrl?: string;
    svgBytes: number;
}

const artworkCache = new Map<string, CachedArtwork>();
let cachedSvgBytes = 0;

const fixed = (value: number, digits = 6): string => value.toFixed(digits);

/** Convert the RWL integer width unit used by the width grid into millimetres. */
export const rwlWidthToMillimetres = (value: number): number => value * WIDTH_VALUE_TO_MM;

/** Build physical ring radii from the same width values shown in the grid. */
export function buildTreeRingGeometry(
    series: RwlTreeData,
    stopMarkerValue = -9999,
): TreeRingGeometry | null {
    const measurements = Array.from(series.entries())
        .filter((entry): entry is [number, number] => (
            typeof entry[1] === "number"
            && Number.isFinite(entry[1])
            && entry[1] !== stopMarkerValue
            && entry[1] >= 0
        ))
        .sort(([leftYear], [rightYear]) => leftYear - rightYear);

    if (measurements.length === 0) {
        return null;
    }

    let radiusMm = 0;
    const rings = measurements.map(([year, value]) => {
        const widthMm = rwlWidthToMillimetres(value);
        radiusMm += widthMm;
        return { year, widthMm, outerRadiusMm: radiusMm };
    });

    if (!(radiusMm > 0)) {
        return null;
    }

    const gaps: TreeRingGeometryGap[] = [];
    for (let index = 1; index < rings.length; index += 1) {
        const previous = rings[index - 1];
        const current = rings[index];
        if (current.year <= previous.year + 1) continue;
        gaps.push({
            startYear: previous.year + 1,
            endYear: current.year - 1,
            yearCount: current.year - previous.year - 1,
            radiusMm: previous.outerRadiusMm,
        });
    }

    const diameterMm = radiusMm * 2;
    const windowTopMm = Math.max(0, radiusMm - WINDOW_HEIGHT_MM / 2);
    const windowBottomMm = Math.min(diameterMm, radiusMm + WINDOW_HEIGHT_MM / 2);
    const widthSignature = measurements.map(([, value]) => Object.is(value, -0) ? "0" : String(value)).join(",");

    return {
        rings,
        gaps,
        radiusMm,
        diameterMm,
        windowLeftMm: radiusMm,
        windowTopMm,
        windowWidthMm: radiusMm,
        windowHeightMm: windowBottomMm - windowTopMm,
        cacheKey: `${CACHE_VERSION}|${widthSignature}`,
    };
}

/** Locate a measured ring or a bounded middle-year gap without inventing gap width. */
export function getTreeRingFeature(
    geometry: TreeRingGeometry,
    year: number | undefined,
): TreeRingFeature | null {
    if (year === undefined) return null;

    const ringIndex = geometry.rings.findIndex((ring) => ring.year === year);
    if (ringIndex >= 0) {
        const ring = geometry.rings[ringIndex];
        const innerRadiusMm = ringIndex > 0
            ? geometry.rings[ringIndex - 1].outerRadiusMm
            : 0;
        return {
            kind: "ring",
            startYear: year,
            endYear: year,
            innerRadiusMm,
            outerRadiusMm: ring.outerRadiusMm,
            centreRadiusMm: innerRadiusMm + (ring.outerRadiusMm - innerRadiusMm) / 2,
        };
    }

    const gap = geometry.gaps.find((candidate) => year >= candidate.startYear && year <= candidate.endYear);
    if (!gap) return null;
    return {
        kind: "gap",
        startYear: gap.startYear,
        endYear: gap.endYear,
        innerRadiusMm: gap.radiusMm,
        outerRadiusMm: gap.radiusMm,
        centreRadiusMm: gap.radiusMm,
    };
}

/** Resolve the visible radial coordinate to a ring, zero-width event, or missing-year divider. */
export function getTreeRingFeatureAtRadius(
    geometry: TreeRingGeometry,
    radiusMm: number,
    markerToleranceMm = 0,
): TreeRingFeature | null {
    if (!Number.isFinite(radiusMm) || radiusMm < 0 || radiusMm > geometry.radiusMm) {
        return null;
    }

    const tolerance = Math.max(0, markerToleranceMm);
    const gap = geometry.gaps.find((candidate) => (
        Math.abs(candidate.radiusMm - radiusMm) <= tolerance
    ));
    if (gap) return getTreeRingFeature(geometry, gap.startYear);

    const zeroRing = geometry.rings.find((ring) => (
        ring.widthMm === 0 && Math.abs(ring.outerRadiusMm - radiusMm) <= tolerance
    ));
    if (zeroRing) return getTreeRingFeature(geometry, zeroRing.year);

    const ring = geometry.rings.find((candidate, index) => {
        if (!(candidate.widthMm > 0)) return false;
        const innerRadiusMm = index > 0 ? geometry.rings[index - 1].outerRadiusMm : 0;
        return radiusMm >= innerRadiusMm && radiusMm <= candidate.outerRadiusMm;
    });
    return ring ? getTreeRingFeature(geometry, ring.year) : null;
}

function renderPatternDefinitions(): string {
    return DOT_PATTERN_SPECS.map(([patternId, tileSize, dots]) => {
        const scaledTileSize = tileSize * DOT_SPACING_SCALE;
        const circles = dots.map(([x, y, radius]) => (
            `<circle cx="${fixed(x * DOT_SPACING_SCALE, 3)}" cy="${fixed(y * DOT_SPACING_SCALE, 3)}" `
            + `r="${fixed(radius, 3)}" fill="#000000" />`
        )).join("");
        return `<pattern id="${patternId}" patternUnits="userSpaceOnUse" patternContentUnits="userSpaceOnUse" `
            + `width="${fixed(scaledTileSize, 3)}" height="${fixed(scaledTileSize, 3)}">${circles}</pattern>`;
    }).join("\n");
}

function renderRingShapes(geometry: TreeRingGeometry): string {
    const centre = geometry.radiusMm;
    return geometry.rings.flatMap(({ outerRadiusMm, widthMm }) => {
        const latewoodWidth = widthMm * LATEWOOD_RATIO;
        const latewoodStartRadius = outerRadiusMm - latewoodWidth;
        const latewoodBands = DOT_PATTERN_SPECS.map(([patternId], level) => {
            const bandInnerRadius = latewoodStartRadius
                + latewoodWidth * (level / DOT_PATTERN_SPECS.length);
            const bandWidth = outerRadiusMm - bandInnerRadius;
            const bandCentreRadius = bandInnerRadius + bandWidth / 2;
            return `<circle cx="${fixed(centre)}" cy="${fixed(centre)}" r="${fixed(bandCentreRadius)}" `
                + `fill="none" stroke="url(#${patternId})" stroke-width="${fixed(bandWidth)}" />`;
        });
        return [
            ...latewoodBands,
            `<circle cx="${fixed(centre)}" cy="${fixed(centre)}" r="${fixed(outerRadiusMm)}" `
                + `fill="none" stroke="#000000" stroke-width="${fixed(RING_BOUNDARY_WIDTH_MM)}" />`,
        ];
    }).join("\n");
}

export function renderTreeRingSvg(geometry: TreeRingGeometry, view: "preview" | "full"): string {
    const centre = geometry.radiusMm;
    const definitions = renderPatternDefinitions();
    const shapes = renderRingShapes(geometry);
    const isPreview = view === "preview";
    const widthMm = isPreview ? geometry.windowWidthMm : geometry.diameterMm;
    const heightMm = isPreview ? geometry.windowHeightMm : geometry.diameterMm;
    const viewBox = isPreview
        ? `${fixed(geometry.windowLeftMm)} ${fixed(geometry.windowTopMm)} ${fixed(geometry.windowWidthMm)} ${fixed(geometry.windowHeightMm)}`
        : `0 0 ${fixed(geometry.diameterMm)} ${fixed(geometry.diameterMm)}`;
    const label = isPreview
        ? "One-centimetre-high tree-ring window from pith to 3 o'clock"
        : "Tree-ring cross-section";

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${fixed(widthMm, 3)}mm" height="${fixed(heightMm, 3)}mm" `
        + `viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${label}">\n`
        + `<defs>\n${definitions}\n</defs>\n`
        + `<rect x="${isPreview ? fixed(geometry.windowLeftMm) : "0"}" y="${isPreview ? fixed(geometry.windowTopMm) : "0"}" `
        + `width="${fixed(widthMm)}" height="${fixed(heightMm)}" fill="#ffffff" />\n`
        + `<circle cx="${fixed(centre)}" cy="${fixed(centre)}" r="${fixed(geometry.radiusMm)}" fill="#ffffff" />\n`
        + `${shapes}\n</svg>`;
}

function createSvgUrl(svg: string): string {
    if (
        typeof Blob !== "undefined"
        && typeof URL !== "undefined"
        && typeof URL.createObjectURL === "function"
    ) {
        return URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    }
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function releaseSvgUrl(url: string | undefined): void {
    if (url?.startsWith("blob:") && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(url);
    }
}

function touchCacheEntry(cacheKey: string, entry: CachedArtwork): void {
    artworkCache.delete(cacheKey);
    artworkCache.set(cacheKey, entry);
}

function trimArtworkCache(): void {
    while (
        artworkCache.size > 1
        && (artworkCache.size > MAX_CACHE_ENTRIES || cachedSvgBytes > MAX_CACHE_SVG_BYTES)
    ) {
        const oldest = artworkCache.entries().next().value as [string, CachedArtwork] | undefined;
        if (!oldest) break;
        const [cacheKey, entry] = oldest;
        artworkCache.delete(cacheKey);
        cachedSvgBytes -= entry.svgBytes;
        releaseSvgUrl(entry.previewUrl);
        if (entry.fullUrl !== entry.previewUrl) releaseSvgUrl(entry.fullUrl);
    }
}

/** Return cached SVG image URLs; the expensive full section is created only when requested. */
export function getTreeRingArtwork(
    series: RwlTreeData,
    stopMarkerValue = -9999,
    includeFull = false,
): TreeRingArtwork | null {
    const geometry = buildTreeRingGeometry(series, stopMarkerValue);
    if (!geometry) return null;

    let entry = artworkCache.get(geometry.cacheKey);
    if (!entry) {
        // The preview and the floating viewer crop the same complete source SVG
        // through their own viewBox, avoiding duplicate large artwork blobs.
        const sharedSvg = renderTreeRingSvg(geometry, "full");
        const sharedUrl = createSvgUrl(sharedSvg);
        entry = {
            geometry,
            previewUrl: sharedUrl,
            fullUrl: sharedUrl,
            svgBytes: sharedSvg.length,
        };
        artworkCache.set(geometry.cacheKey, entry);
        cachedSvgBytes += entry.svgBytes;
    }

    if (includeFull && !entry.fullUrl) {
        entry.fullUrl = entry.previewUrl;
    }

    touchCacheEntry(geometry.cacheKey, entry);
    trimArtworkCache();

    return {
        cacheKey: geometry.cacheKey,
        previewUrl: entry.previewUrl,
        fullUrl: includeFull ? entry.fullUrl : undefined,
        ringCount: geometry.rings.length,
        startYear: geometry.rings[0].year,
        endYear: geometry.rings[geometry.rings.length - 1].year,
        radiusMm: geometry.radiusMm,
        geometry,
    };
}

/** Pre-generate header strips in short idle slices when a file is opened or edited. */
export function prewarmTreeRingArtworkCache(
    siteData: RwlSiteData,
    stopMarkerValue = -9999,
): () => void {
    if (typeof window === "undefined" || siteData.size === 0) {
        return () => undefined;
    }

    const series = Array.from(siteData.values());
    const idleWindow = window;
    let index = 0;
    let cancelled = false;
    let idleHandle: number | null = null;
    let timeoutHandle: number | null = null;

    const schedule = () => {
        if (cancelled || index >= series.length) return;
        if (typeof idleWindow.requestIdleCallback === "function") {
            idleHandle = idleWindow.requestIdleCallback(runSlice, { timeout: 500 });
        } else {
            timeoutHandle = window.setTimeout(
                () => runSlice({ timeRemaining: () => 8 }),
                16,
            );
        }
    };

    const runSlice = (deadline: { timeRemaining: () => number }) => {
        idleHandle = null;
        timeoutHandle = null;
        let generated = 0;
        while (
            !cancelled
            && index < series.length
            && (generated === 0 || (generated < 4 && deadline.timeRemaining() > 3))
        ) {
            getTreeRingArtwork(series[index], stopMarkerValue, false);
            index += 1;
            generated += 1;
        }
        schedule();
    };

    schedule();
    return () => {
        cancelled = true;
        if (idleHandle !== null && typeof idleWindow.cancelIdleCallback === "function") {
            idleWindow.cancelIdleCallback(idleHandle);
        }
        if (timeoutHandle !== null) {
            window.clearTimeout(timeoutHandle);
        }
    };
}

export function clearTreeRingArtworkCache(): void {
    artworkCache.forEach((entry) => {
        releaseSvgUrl(entry.previewUrl);
        if (entry.fullUrl !== entry.previewUrl) releaseSvgUrl(entry.fullUrl);
    });
    artworkCache.clear();
    cachedSvgBytes = 0;
}

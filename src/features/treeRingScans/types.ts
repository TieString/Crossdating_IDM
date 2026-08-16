export type TreeRingImageMode = "generated" | "scan";

export type TreeRingScanRotation = 0 | 90 | 180 | 270;

export type TreeRingScanMarkerCount = 1 | 2 | 3;

export interface TreeRingScanFile {
    name: string;
    path: string;
    extension: string;
}

/** Normalized rectangle in the full scanner image. */
export interface TreeRingScanCrop {
    xRatio: number;
    yRatio: number;
    widthRatio: number;
    heightRatio: number;
}

export interface TreeRingScanAnchor {
    originalYear: number;
    /** Coordinates are relative to the selected sample cross-section. */
    xRatio: number;
    yRatio: number;
    markerCount: TreeRingScanMarkerCount;
}

export interface TreeRingScanSeriesState {
    mode: TreeRingImageMode;
    anchors: TreeRingScanAnchor[];
    /** Clockwise display rotation shared by overview, crop, anchors and header. */
    rotation?: TreeRingScanRotation;
    /** The freely drawn rectangular, polished sample cross-section. */
    crop?: TreeRingScanCrop;
    /** Prevents anchors from being silently reused for a different same-named image. */
    imagePath?: string;
    /** The working calendar range when the first anchor was placed. */
    baselineStartYear?: number;
    baselineEndYear?: number;
    /** Only edits after this operation sequence are replayed into the scan mapping. */
    baselineOperationSequence?: number;
    /** Widths at calibration time keep interpolation independent of later edits. */
    baselineWidths?: Array<[number, number]>;
}

export interface PersistedTreeRingScanState {
    version: 1;
    savedAt: string;
    folderPath: string | null;
    filesBySeries: Record<string, TreeRingScanFile>;
    series: Record<string, TreeRingScanSeriesState>;
}

export const createEmptyTreeRingScanState = (): PersistedTreeRingScanState => ({
    version: 1,
    savedAt: new Date(0).toISOString(),
    folderPath: null,
    filesBySeries: {},
    series: {},
});

export const normalizeTreeRingScanSeriesKey = (seriesId: string): string => (
    seriesId.trim().toLocaleLowerCase()
);

export const getTreeRingScanMarkerCount = (year: number): TreeRingScanMarkerCount => {
    if (year % 100 === 0) return 3;
    if (year % 50 === 0) return 2;
    return 1;
};

export const getFirstTreeRingScanAnchorYear = (latestYear: number): number => (
    Math.floor(latestYear / 10) * 10
);

export const isTreeRingScanCalibrated = (state: TreeRingScanSeriesState | undefined): boolean => (
    Boolean(state?.crop && state.anchors.length >= 2)
);

export const getTreeRingScanFile = (
    state: PersistedTreeRingScanState,
    seriesId: string,
): TreeRingScanFile | undefined => state.filesBySeries[normalizeTreeRingScanSeriesKey(seriesId)];

export const getTreeRingScanSeriesState = (
    state: PersistedTreeRingScanState,
    seriesId: string,
): TreeRingScanSeriesState | undefined => state.series[normalizeTreeRingScanSeriesKey(seriesId)];

export const isPersistedTreeRingScanState = (value: unknown): value is PersistedTreeRingScanState => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<PersistedTreeRingScanState>;
    if (!(candidate.version === 1
        && (candidate.folderPath === null || typeof candidate.folderPath === "string")
        && Boolean(candidate.filesBySeries && typeof candidate.filesBySeries === "object")
        && Boolean(candidate.series && typeof candidate.series === "object"))) {
        return false;
    }
    const filesAreValid = Object.values(candidate.filesBySeries!).every((file) => (
        Boolean(file)
        && typeof file.name === "string"
        && typeof file.path === "string"
        && typeof file.extension === "string"
    ));
    const seriesAreValid = Object.values(candidate.series!).every((seriesState) => (
        Boolean(seriesState)
        && (seriesState.mode === "generated" || seriesState.mode === "scan")
        && (
            seriesState.rotation === undefined
            || seriesState.rotation === 0
            || seriesState.rotation === 90
            || seriesState.rotation === 180
            || seriesState.rotation === 270
        )
        && (
            seriesState.crop === undefined
            || (
                Number.isFinite(seriesState.crop.xRatio)
                && Number.isFinite(seriesState.crop.yRatio)
                && Number.isFinite(seriesState.crop.widthRatio)
                && Number.isFinite(seriesState.crop.heightRatio)
                && seriesState.crop.widthRatio > 0
                && seriesState.crop.heightRatio > 0
            )
        )
        && Array.isArray(seriesState.anchors)
        && seriesState.anchors.every((anchor) => (
            Number.isFinite(anchor.originalYear)
            && Number.isFinite(anchor.xRatio)
            && Number.isFinite(anchor.yRatio)
            && (anchor.markerCount === 1 || anchor.markerCount === 2 || anchor.markerCount === 3)
        ))
    ));
    return filesAreValid && seriesAreValid;
};

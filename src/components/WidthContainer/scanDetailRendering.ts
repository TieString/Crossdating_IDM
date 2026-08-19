export const TREE_RING_SCAN_MIN_ZOOM = 1;
export const TREE_RING_SCAN_MINIMUM_MAX_ZOOM = 64;
export const TREE_RING_SCAN_HARD_MAX_ZOOM = 1024;

const positiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0;
const MINIMUM_SCAN_VIEW_SPAN = 1e-6;

/** Supersample compact header canvases on low-DPI displays before CSS compositing. */
export function getTreeRingScanHeaderPixelRatio(devicePixelRatio: number): number {
    return Math.max(2, positiveFinite(devicePixelRatio) ? devicePixelRatio : 1);
}

/** Preserve the rendered header aspect even when the source window becomes sub-pixel. */
export function getTreeRingScanPreviewViewSize(
    sourceWidth: number,
    sourceHeight: number,
    zoom: number,
    viewportWidth: number,
    viewportHeight: number,
): { width: number; height: number; aspect: number } {
    const aspect = positiveFinite(viewportWidth) && positiveFinite(viewportHeight)
        ? viewportWidth / viewportHeight
        : 18;
    const safeZoom = positiveFinite(zoom) ? zoom : TREE_RING_SCAN_MIN_ZOOM;
    const requestedWidth = positiveFinite(sourceWidth) ? sourceWidth / safeZoom : 1;
    const constrainedWidth = positiveFinite(sourceHeight)
        ? Math.min(requestedWidth, sourceHeight * aspect)
        : requestedWidth;
    const width = Math.max(MINIMUM_SCAN_VIEW_SPAN, constrainedWidth);
    return {
        width,
        height: width / aspect,
        aspect,
    };
}

/**
 * Keep at least a generous inspection range, then extend it when the source contains enough
 * pixels to support still deeper native-detail zooming. The 2x allowance makes individual
 * source pixels inspectable without pretending that extra image detail exists.
 */
export function getTreeRingScanMaximumZoom(
    sourceWidth: number,
    sourceHeight: number,
    fittedWidth: number,
    fittedHeight: number,
    pixelRatio = 1,
): number {
    if (![sourceWidth, sourceHeight, fittedWidth, fittedHeight].every(positiveFinite)) {
        return TREE_RING_SCAN_MINIMUM_MAX_ZOOM;
    }
    const safePixelRatio = positiveFinite(pixelRatio) ? pixelRatio : 1;
    const nativeZoom = Math.max(
        sourceWidth / (fittedWidth * safePixelRatio),
        sourceHeight / (fittedHeight * safePixelRatio),
    );
    return Math.min(
        TREE_RING_SCAN_HARD_MAX_ZOOM,
        Math.max(TREE_RING_SCAN_MINIMUM_MAX_ZOOM, Math.ceil(nativeZoom * 2)),
    );
}

/** Disable interpolation once source pixels are being enlarged; this keeps maximum zoom honest. */
export function shouldSmoothTreeRingScanImage(
    sourceWidth: number,
    sourceHeight: number,
    renderedWidth: number,
    renderedHeight: number,
    pixelRatio = 1,
): boolean {
    if (![sourceWidth, sourceHeight, renderedWidth, renderedHeight].every(positiveFinite)) return true;
    const safePixelRatio = positiveFinite(pixelRatio) ? pixelRatio : 1;
    return renderedWidth * safePixelRatio <= sourceWidth + 0.5
        && renderedHeight * safePixelRatio <= sourceHeight + 0.5;
}

export function projectTreeRingScanAnchorToViewport(
    xRatio: number,
    yRatio: number,
    fittedWidth: number,
    fittedHeight: number,
    viewportSize: number,
    zoom: number,
    pan: { x: number; y: number },
): { left: number; top: number } {
    return {
        left: viewportSize / 2 + pan.x + (xRatio - 0.5) * fittedWidth * zoom,
        top: viewportSize / 2 + pan.y + (yRatio - 0.5) * fittedHeight * zoom,
    };
}

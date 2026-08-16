export interface TreeRingViewport {
    zoom: number;
    startX: number;
}

export const TREE_RING_MIN_ZOOM = 1;
export const TREE_RING_MAX_ZOOM = 32;

const clamp = (value: number, minimum: number, maximum: number) => (
    Math.min(maximum, Math.max(minimum, value))
);

/** Match the physical SVG window to the rendered strip without stretching or horizontal cropping. */
export function getTreeRingPreviewViewHeight(
    viewWidth: number,
    diameterMm: number,
    viewportWidth: number,
    viewportHeight: number,
    fallbackHeight: number,
): number {
    const measuredHeight = viewportWidth > 0 && viewportHeight > 0
        ? viewWidth * viewportHeight / viewportWidth
        : fallbackHeight;
    return Math.min(diameterMm, Math.max(0.001, measuredHeight));
}

export const getTreeRingViewportWidth = (radiusMm: number, zoom: number): number => (
    radiusMm / clamp(zoom, TREE_RING_MIN_ZOOM, TREE_RING_MAX_ZOOM)
);

export function clampTreeRingViewport(
    viewport: TreeRingViewport,
    radiusMm: number,
): TreeRingViewport {
    const zoom = clamp(viewport.zoom, TREE_RING_MIN_ZOOM, TREE_RING_MAX_ZOOM);
    const width = getTreeRingViewportWidth(radiusMm, zoom);
    return {
        zoom,
        startX: clamp(viewport.startX, radiusMm, radiusMm * 2 - width),
    };
}

/** Zoom around the mouse position so the ring below the cursor does not jump. */
export function zoomTreeRingViewport(
    viewport: TreeRingViewport,
    radiusMm: number,
    cursorRatio: number,
    wheelDeltaY: number,
): TreeRingViewport {
    const ratio = clamp(cursorRatio, 0, 1);
    const current = clampTreeRingViewport(viewport, radiusMm);
    const currentWidth = getTreeRingViewportWidth(radiusMm, current.zoom);
    const coordinateAtCursor = current.startX + currentWidth * ratio;
    const nextZoom = clamp(
        current.zoom * Math.exp(-wheelDeltaY * 0.0025),
        TREE_RING_MIN_ZOOM,
        TREE_RING_MAX_ZOOM,
    );
    const nextWidth = getTreeRingViewportWidth(radiusMm, nextZoom);
    return clampTreeRingViewport({
        zoom: nextZoom,
        startX: coordinateAtCursor - nextWidth * ratio,
    }, radiusMm);
}

export function panTreeRingViewport(
    viewport: TreeRingViewport,
    radiusMm: number,
    deltaPixels: number,
    viewportPixels: number,
): TreeRingViewport {
    if (!(viewportPixels > 0)) return clampTreeRingViewport(viewport, radiusMm);
    const current = clampTreeRingViewport(viewport, radiusMm);
    const width = getTreeRingViewportWidth(radiusMm, current.zoom);
    return clampTreeRingViewport({
        ...current,
        startX: current.startX - deltaPixels / viewportPixels * width,
    }, radiusMm);
}

export function focusTreeRingViewport(
    viewport: TreeRingViewport,
    radiusMm: number,
    featureRadiusMm: number,
): TreeRingViewport {
    const current = clampTreeRingViewport(viewport, radiusMm);
    if (current.zoom <= TREE_RING_MIN_ZOOM) return current;
    const width = getTreeRingViewportWidth(radiusMm, current.zoom);
    return clampTreeRingViewport({
        ...current,
        startX: radiusMm + featureRadiusMm - width / 2,
    }, radiusMm);
}

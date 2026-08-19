export interface TreeRingFullViewport {
    zoom: number;
    startX: number;
    startY: number;
}

export const TREE_RING_FULL_MIN_ZOOM = 1;
export const TREE_RING_FULL_MAX_ZOOM = 32;

const clamp = (value: number, minimum: number, maximum: number) => (
    Math.min(maximum, Math.max(minimum, value))
);

export const getTreeRingFullViewSize = (diameterMm: number, zoom: number): number => (
    diameterMm / clamp(zoom, TREE_RING_FULL_MIN_ZOOM, TREE_RING_FULL_MAX_ZOOM)
);

export function clampTreeRingFullViewport(
    viewport: TreeRingFullViewport,
    diameterMm: number,
): TreeRingFullViewport {
    const zoom = clamp(viewport.zoom, TREE_RING_FULL_MIN_ZOOM, TREE_RING_FULL_MAX_ZOOM);
    const size = getTreeRingFullViewSize(diameterMm, zoom);
    const maximumStart = Math.max(0, diameterMm - size);
    return {
        zoom,
        startX: clamp(viewport.startX, 0, maximumStart),
        startY: clamp(viewport.startY, 0, maximumStart),
    };
}

/** Zoom around the pointer so the physical point below it remains stationary. */
export function zoomTreeRingFullViewport(
    viewport: TreeRingFullViewport,
    diameterMm: number,
    cursorXRatio: number,
    cursorYRatio: number,
    wheelDeltaY: number,
): TreeRingFullViewport {
    const current = clampTreeRingFullViewport(viewport, diameterMm);
    const currentSize = getTreeRingFullViewSize(diameterMm, current.zoom);
    const ratioX = clamp(cursorXRatio, 0, 1);
    const ratioY = clamp(cursorYRatio, 0, 1);
    const pointX = current.startX + currentSize * ratioX;
    const pointY = current.startY + currentSize * ratioY;
    const nextZoom = clamp(
        current.zoom * Math.exp(-wheelDeltaY * 0.0025),
        TREE_RING_FULL_MIN_ZOOM,
        TREE_RING_FULL_MAX_ZOOM,
    );
    const nextSize = getTreeRingFullViewSize(diameterMm, nextZoom);
    return clampTreeRingFullViewport({
        zoom: nextZoom,
        startX: pointX - nextSize * ratioX,
        startY: pointY - nextSize * ratioY,
    }, diameterMm);
}

export function panTreeRingFullViewport(
    viewport: TreeRingFullViewport,
    diameterMm: number,
    deltaPixelsX: number,
    deltaPixelsY: number,
    viewportPixels: number,
): TreeRingFullViewport {
    if (!(viewportPixels > 0)) return clampTreeRingFullViewport(viewport, diameterMm);
    const current = clampTreeRingFullViewport(viewport, diameterMm);
    const size = getTreeRingFullViewSize(diameterMm, current.zoom);
    return clampTreeRingFullViewport({
        ...current,
        startX: current.startX - deltaPixelsX / viewportPixels * size,
        startY: current.startY - deltaPixelsY / viewportPixels * size,
    }, diameterMm);
}

/** Centre the selected ring's three-o'clock point while preserving the current zoom. */
export function focusTreeRingFullViewport(
    viewport: TreeRingFullViewport,
    diameterMm: number,
    featureRadiusMm: number,
): TreeRingFullViewport {
    const current = clampTreeRingFullViewport(viewport, diameterMm);
    if (current.zoom <= TREE_RING_FULL_MIN_ZOOM) return current;
    const size = getTreeRingFullViewSize(diameterMm, current.zoom);
    const radiusMm = diameterMm / 2;
    return clampTreeRingFullViewport({
        ...current,
        startX: radiusMm + featureRadiusMm - size / 2,
        startY: radiusMm - size / 2,
    }, diameterMm);
}

import type { TreeRingGeometry, TreeRingFeature } from "./treeRingArtwork";
import { getTreeRingFeatureAtRadius } from "./treeRingArtwork";
import { getTreeRingFullViewSize, type TreeRingFullViewport } from "./treeRingFullViewport";
import { getTreeRingViewportWidth, type TreeRingViewport } from "./treeRingViewport";

const clampRatio = (value: number) => Math.min(1, Math.max(0, value));

export function resolveFullTreeRingViewerFeature(
    geometry: TreeRingGeometry,
    viewport: TreeRingFullViewport,
    localX: number,
    localY: number,
    viewportWidth: number,
    viewportHeight: number,
): TreeRingFeature | null {
    if (!(viewportWidth > 0) || !(viewportHeight > 0)) return null;
    const viewSize = getTreeRingFullViewSize(geometry.diameterMm, viewport.zoom);
    const x = viewport.startX + clampRatio(localX / viewportWidth) * viewSize;
    const y = viewport.startY + clampRatio(localY / viewportHeight) * viewSize;
    const radialDistance = Math.hypot(x - geometry.radiusMm, y - geometry.radiusMm);
    const markerToleranceMm = viewSize / Math.min(viewportWidth, viewportHeight) * 5;
    return getTreeRingFeatureAtRadius(geometry, radialDistance, markerToleranceMm);
}

export function resolveStripTreeRingViewerFeature(
    geometry: TreeRingGeometry,
    viewport: TreeRingViewport,
    localX: number,
    viewportWidth: number,
): TreeRingFeature | null {
    if (!(viewportWidth > 0)) return null;
    const viewWidth = getTreeRingViewportWidth(geometry.radiusMm, viewport.zoom);
    const x = viewport.startX + clampRatio(localX / viewportWidth) * viewWidth;
    const markerToleranceMm = viewWidth / viewportWidth * 5;
    return getTreeRingFeatureAtRadius(
        geometry,
        x - geometry.radiusMm,
        markerToleranceMm,
    );
}

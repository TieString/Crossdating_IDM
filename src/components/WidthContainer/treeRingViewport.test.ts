import { describe, expect, it } from "vitest";
import {
    clampTreeRingViewport,
    focusTreeRingViewport,
    getTreeRingOneCentimetreZoom,
    getTreeRingPreviewViewHeight,
    getTreeRingViewportWidth,
    panTreeRingViewport,
    zoomTreeRingViewport,
} from "./treeRingViewport";

describe("tree-ring preview viewport", () => {
    it("matches the SVG viewBox to the strip while keeping the full radial width", () => {
        const height = getTreeRingPreviewViewHeight(361.823, 723.646, 834, 25, 10);
        expect(361.823 / height).toBeCloseTo(834 / 25, 12);
        expect(getTreeRingPreviewViewHeight(100, 200, 0, 25, 10)).toBe(10);
        expect(getTreeRingPreviewViewHeight(100, 120, 10, 100, 10)).toBe(120);
    });

    it("keeps the full pith-to-bark window at zoom 1", () => {
        expect(clampTreeRingViewport({ zoom: 1, startX: 0 }, 100)).toEqual({
            zoom: 1,
            startX: 100,
        });
        expect(getTreeRingViewportWidth(100, 1)).toBe(100);
    });

    it("derives an enlarged viewport that remains one centimetre high", () => {
        const zoom = getTreeRingOneCentimetreZoom(360, 10, 600, 100);
        expect(zoom).toBe(6);
        expect(getTreeRingViewportWidth(360, zoom)).toBe(60);
    });

    it("keeps the coordinate below the mouse stable while zooming", () => {
        const next = zoomTreeRingViewport(
            { zoom: 1, startX: 100 },
            100,
            0.5,
            -100,
        );
        const coordinateAtCentre = next.startX + getTreeRingViewportWidth(100, next.zoom) / 2;
        expect(next.zoom).toBeGreaterThan(1);
        expect(coordinateAtCentre).toBeCloseTo(150, 10);
    });

    it("pans horizontally in physical SVG coordinates and clamps at both edges", () => {
        expect(panTreeRingViewport({ zoom: 2, startX: 125 }, 100, 50, 200)).toEqual({
            zoom: 2,
            startX: 112.5,
        });
        expect(panTreeRingViewport({ zoom: 2, startX: 125 }, 100, 1000, 200).startX).toBe(100);
        expect(panTreeRingViewport({ zoom: 2, startX: 125 }, 100, -1000, 200).startX).toBe(150);
    });

    it("centres a clicked ring only after the preview is enlarged", () => {
        expect(focusTreeRingViewport({ zoom: 1, startX: 100 }, 100, 50)).toEqual({
            zoom: 1,
            startX: 100,
        });
        expect(focusTreeRingViewport({ zoom: 4, startX: 100 }, 100, 50)).toEqual({
            zoom: 4,
            startX: 137.5,
        });
    });
});

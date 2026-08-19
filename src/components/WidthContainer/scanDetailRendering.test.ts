import { describe, expect, it } from "vitest";
import {
    getTreeRingScanHeaderPixelRatio,
    getTreeRingScanMaximumZoom,
    getTreeRingScanPreviewViewSize,
    projectTreeRingScanAnchorToViewport,
    shouldSmoothTreeRingScanImage,
    TREE_RING_SCAN_HARD_MAX_ZOOM,
    TREE_RING_SCAN_MINIMUM_MAX_ZOOM,
} from "./scanDetailRendering";

describe("tree-ring scan detail rendering", () => {
    it("keeps a useful inspection floor and expands for very large sources", () => {
        expect(getTreeRingScanMaximumZoom(4000, 400, 600, 60, 2))
            .toBe(TREE_RING_SCAN_MINIMUM_MAX_ZOOM);
        expect(getTreeRingScanMaximumZoom(30_000, 3_000, 600, 60, 1)).toBe(100);
    });

    it("caps pathological source-to-viewport ratios", () => {
        expect(getTreeRingScanMaximumZoom(1_000_000, 100_000, 100, 10, 1))
            .toBe(TREE_RING_SCAN_HARD_MAX_ZOOM);
    });

    it("only smooths while reducing source pixels", () => {
        expect(shouldSmoothTreeRingScanImage(4000, 1000, 1000, 250, 2)).toBe(true);
        expect(shouldSmoothTreeRingScanImage(4000, 1000, 2200, 550, 2)).toBe(false);
    });

    it("keeps scan-header scaling uniform below a one-pixel source height", () => {
        const view = getTreeRingScanPreviewViewSize(1155, 13_708, 1024, 500, 24);
        expect(view.height).toBeLessThan(1);
        expect(view.width / view.height).toBeCloseTo(500 / 24, 12);
        expect(500 / view.width).toBeCloseTo(24 / view.height, 12);
    });

    it("supersamples the compact header on low-DPI displays", () => {
        expect(getTreeRingScanHeaderPixelRatio(1)).toBe(2);
        expect(getTreeRingScanHeaderPixelRatio(1.5)).toBe(2);
        expect(getTreeRingScanHeaderPixelRatio(3)).toBe(3);
    });

    it("projects anchors directly into the unscaled viewport overlay", () => {
        expect(projectTreeRingScanAnchorToViewport(
            0.75,
            0.25,
            600,
            200,
            620,
            4,
            { x: -20, y: 10 },
        )).toEqual({ left: 890, top: 120 });
    });
});

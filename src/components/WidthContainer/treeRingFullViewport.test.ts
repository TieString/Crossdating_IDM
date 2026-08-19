import { describe, expect, it } from "vitest";
import {
    clampTreeRingFullViewport,
    focusTreeRingFullViewport,
    getTreeRingFullViewSize,
    panTreeRingFullViewport,
    zoomTreeRingFullViewport,
} from "./treeRingFullViewport";

describe("full tree-ring viewport", () => {
    it("starts with the entire cross-section visible", () => {
        expect(clampTreeRingFullViewport({ zoom: 1, startX: 10, startY: 20 }, 200)).toEqual({
            zoom: 1,
            startX: 0,
            startY: 0,
        });
        expect(getTreeRingFullViewSize(200, 1)).toBe(200);
    });

    it("keeps the physical point below the mouse fixed while zooming", () => {
        const next = zoomTreeRingFullViewport(
            { zoom: 1, startX: 0, startY: 0 },
            200,
            0.25,
            0.75,
            -100,
        );
        const size = getTreeRingFullViewSize(200, next.zoom);
        expect(next.startX + size * 0.25).toBeCloseTo(50, 10);
        expect(next.startY + size * 0.75).toBeCloseTo(150, 10);
    });

    it("pans in both axes and clamps at the cross-section edges", () => {
        expect(panTreeRingFullViewport(
            { zoom: 2, startX: 50, startY: 50 },
            200,
            20,
            -40,
            200,
        )).toEqual({ zoom: 2, startX: 40, startY: 70 });
        expect(panTreeRingFullViewport(
            { zoom: 2, startX: 50, startY: 50 },
            200,
            2000,
            -2000,
            200,
        )).toEqual({ zoom: 2, startX: 0, startY: 100 });
    });

    it("centres a selected ring at the three-o'clock inspection point", () => {
        expect(focusTreeRingFullViewport(
            { zoom: 4, startX: 0, startY: 0 },
            200,
            60,
        )).toEqual({ zoom: 4, startX: 135, startY: 75 });
        expect(focusTreeRingFullViewport(
            { zoom: 1, startX: 0, startY: 0 },
            200,
            60,
        )).toEqual({ zoom: 1, startX: 0, startY: 0 });
    });
});

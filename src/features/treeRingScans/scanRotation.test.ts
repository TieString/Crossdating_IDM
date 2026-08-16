import { describe, expect, it } from "vitest";
import {
    displayTreeRingScanCropToOriginal,
    originalTreeRingScanCropToDisplay,
    rotateTreeRingScanAnchors,
} from "./scanRotation";

describe("tree-ring scan rotation", () => {
    it("round-trips a crop through every right-angle rotation", () => {
        const crop = { xRatio: 0.12, yRatio: 0.24, widthRatio: 0.56, heightRatio: 0.18 };
        ([0, 90, 180, 270] as const).forEach((rotation) => {
            const display = originalTreeRingScanCropToDisplay(crop, rotation);
            const restored = displayTreeRingScanCropToOriginal(display, rotation);
            expect(restored.xRatio).toBeCloseTo(crop.xRatio);
            expect(restored.yRatio).toBeCloseTo(crop.yRatio);
            expect(restored.widthRatio).toBeCloseTo(crop.widthRatio);
            expect(restored.heightRatio).toBeCloseTo(crop.heightRatio);
        });
    });

    it("keeps anchor identity while rotating its displayed coordinates", () => {
        const [anchor] = rotateTreeRingScanAnchors([
            { originalYear: 2000, xRatio: 0.2, yRatio: 0.7, markerCount: 3 },
        ], 0, 90);
        expect(anchor.originalYear).toBe(2000);
        expect(anchor.xRatio).toBeCloseTo(0.3);
        expect(anchor.yRatio).toBeCloseTo(0.2);
    });
});

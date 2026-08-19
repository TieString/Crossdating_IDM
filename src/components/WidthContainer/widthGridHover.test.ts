import { describe, expect, it } from "vitest";
import { resolveWidthGridHoverSide } from "./widthGridHover";

describe("width-grid hover side", () => {
    it("uses a cached cell rectangle to resolve left and right halves", () => {
        expect(resolveWidthGridHoverSide(109, 100, 20)).toBe("left");
        expect(resolveWidthGridHoverSide(110, 100, 20)).toBe("right");
        expect(resolveWidthGridHoverSide(119, 100, 20)).toBe("right");
    });
});

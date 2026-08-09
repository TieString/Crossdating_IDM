import { describe, expect, it } from "vitest";
import { getWidthGridMotionConfig } from "./WidthGrid";

describe("width-grid move animation", () => {
    it("does not mask semantic cell backgrounds while a restored gap animates", () => {
        const config = getWidthGridMotionConfig("move-gap");

        expect(config.initial).not.toHaveProperty("backgroundColor");
        expect(config.animate).not.toHaveProperty("backgroundColor");
        expect(config.transitionEnd).not.toHaveProperty("backgroundColor");
        expect(config.animate).toHaveProperty("boxShadow");
    });
});

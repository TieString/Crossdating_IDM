import { describe, expect, it } from "vitest";
import { getWheelSteppedIntegerValue } from "./numberInputWheel";

describe("context-menu number input wheel stepping", () => {
    it("increments on wheel-up and decrements on wheel-down", () => {
        expect(getWheelSteppedIntegerValue("2000", -120)).toBe(2001);
        expect(getWheelSteppedIntegerValue("2000", 120)).toBe(1999);
    });

    it("uses the configured step and clamps to min/max", () => {
        expect(getWheelSteppedIntegerValue("5", -1, { step: 2, max: 6 })).toBe(6);
        expect(getWheelSteppedIntegerValue("1", 1, { min: 1 })).toBe(1);
    });

    it("recovers an empty or invalid input from its fallback", () => {
        expect(getWheelSteppedIntegerValue("", -1, { fallback: 1999 })).toBe(2000);
        expect(getWheelSteppedIntegerValue("invalid", 1, { fallback: 0, min: 1 })).toBe(1);
    });

    it("ignores a wheel event without vertical movement", () => {
        expect(getWheelSteppedIntegerValue("2000", 0)).toBeNull();
    });
});

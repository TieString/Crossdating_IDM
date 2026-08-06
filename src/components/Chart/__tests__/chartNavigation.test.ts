import { describe, expect, it } from "vitest";
import { centerChartViewportOnYear } from "../chartNavigation";

describe("chart navigation", () => {
    const years = Array.from({ length: 201 }, (_, index) => 1800 + index);

    it("uses a fixed 50-year category-axis window", () => {
        expect(centerChartViewportOnYear(1900, years)).toEqual({
            min: 75,
            max: 125,
        });
    });

    it("clamps the fixed window at a series edge", () => {
        expect(centerChartViewportOnYear(1995, years)).toEqual({
            min: 150,
            max: 200,
        });
    });

    it("never writes a calendar year into the category-axis bounds", () => {
        const lateYears = Array.from({ length: 582 }, (_, index) => 1430 + index);
        const viewport = centerChartViewportOnYear(2009, lateYears);

        expect(viewport).not.toBeNull();
        expect(viewport!.min).toBeGreaterThanOrEqual(0);
        expect(viewport!.max).toBeLessThanOrEqual(lateYears.length - 1);
        expect(viewport!.max - viewport!.min).toBe(50);
    });
});

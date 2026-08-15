import { describe, expect, it } from "vitest";
import { createRangeDeleteAnimationPlan } from "./rangeDeleteAnimationPlan";

describe("range delete animation plan", () => {
    const sourceYears = [1998, 1999, 2000, 2001, 2002, 2003, 2004];

    it("has no side shift when the deleted range remains missing", () => {
        expect(createRangeDeleteAnimationPlan(sourceYears, 2000, 2002, "missing")).toBeNull();
    });

    it("moves the complete left side right by the selected range length", () => {
        expect(createRangeDeleteAnimationPlan(sourceYears, 2000, 2002, "left")).toEqual({
            animationSide: "left",
            anchorTargetYear: 2002,
            yearOffset: 3,
            shiftTargets: [
                { sourceYear: 2000, targetYear: 2001 },
                { sourceYear: 2001, targetYear: 2002 },
            ],
        });
    });

    it("moves the complete right side left by the selected range length", () => {
        expect(createRangeDeleteAnimationPlan(sourceYears, 2002, 2000, "right")).toEqual({
            animationSide: "right",
            anchorTargetYear: 2000,
            yearOffset: -3,
            shiftTargets: [
                { sourceYear: 2001, targetYear: 2000 },
                { sourceYear: 2002, targetYear: 2001 },
            ],
        });
    });

    it("keeps every range-fill visual shift to one neighboring cell", () => {
        const plan = createRangeDeleteAnimationPlan(sourceYears, 2000, 2002, "right");

        expect(plan?.shiftTargets.every(({ sourceYear, targetYear }) => (
            Math.abs(targetYear - sourceYear) === 1
        ))).toBe(true);
    });
});

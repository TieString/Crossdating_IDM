import { describe, expect, it } from "vitest";
import {
    residualBreakpointYearForEvaluation,
    residualFirstNewerYearForEvaluation,
    lagStepForEvaluation,
    residualNewerSideYearForOffsetForEvaluation,
    summarizeLagStateForEvaluation,
} from "../legacy-generalization/evaluator";

describe("applied residual fixed-side semantics", () => {
    it("starts partialMove at firstFixedYear", () => {
        const operation = {
            eventType: "partialMove",
            shiftYears: -4,
            year: 1904,
        } as const;
        expect(residualFirstNewerYearForEvaluation(operation, 1800)).toBe(1904);
        expect(residualBreakpointYearForEvaluation(operation)).toBe(1903);
        expect(residualNewerSideYearForOffsetForEvaluation(
            operation, 1800, 1,
        )).toBe(1904);
        expect(residualNewerSideYearForOffsetForEvaluation(
            operation, 1800, 5,
        )).toBe(1908);
    });

    it("starts unit-event fixed side after the edited year", () => {
        expect(residualFirstNewerYearForEvaluation({
            eventType: "missingRing",
            shiftYears: -1,
            year: 1903,
        }, 1800)).toBe(1904);
        expect(residualNewerSideYearForOffsetForEvaluation({
            eventType: "missingRing",
            shiftYears: -1,
            year: 1903,
        }, 1800, 5)).toBe(1908);
        expect(residualFirstNewerYearForEvaluation({
            eventType: "falseRing",
            shiftYears: 1,
            year: 1903,
        }, 1800)).toBe(1904);
    });

    it("evaluates whole-series and refusal residuals across the full series", () => {
        expect(residualFirstNewerYearForEvaluation({
            eventType: "wholeSeriesMove",
            shiftYears: -11,
            year: 0,
        }, 1800)).toBe(1800);
        expect(residualFirstNewerYearForEvaluation({
            eventType: "noEvent",
            shiftYears: 0,
            year: 0,
        }, 1800)).toBe(1800);
    });

    it("summarizes a constant baseline separately from a local lag step", () => {
        expect(summarizeLagStateForEvaluation([-3, -3, -3, -4])).toEqual({
            segmentCount: 4,
            distinctLagCount: 2,
            modeLag: -3,
            modeFraction: 0.75,
            zeroLagFraction: 0,
            meanAbsoluteLag: 3.25,
        });
        expect(lagStepForEvaluation(-4, -3)).toBe(-1);
    });
});

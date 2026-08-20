import { describe, expect, it } from "vitest";
import { insertMissingYearAtSide, moveSeriesTailByOffset, deleteYearWithMode } from "@/features/rwl/edit";
import {
    planDiagnosisEventEdit,
    planManuallyConfirmedDiagnosisEventEdit,
} from "../eventApply";
import type { DiagnosisEvent } from "../types";

const event = (
    eventType: DiagnosisEvent["eventType"],
    extra: Partial<DiagnosisEvent> = {},
): DiagnosisEvent => ({
    id: `event-${eventType}`,
    seriesId: "ABC01A",
    eventType,
    startYear: 1900,
    endYear: 1906,
    rankedYears: [],
    confidenceLevel: "high",
    evidence: {
        algorithmSources: ["piecewise_lag_path"],
        score: 3,
        scoreMargin: 1,
        baselineCorrelation: 0.3,
        correctedCorrelation: 0.7,
        correlationGain: 0.4,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 40,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
    ...extra,
});

const series = new Map([
    [1899, 10],
    [1900, 20],
    [1901, 30],
    [1902, 40],
    [1903, 50],
]);

describe("planDiagnosisEventEdit", () => {
    it("keeps the newer side fixed when applying a selected missing-ring year", () => {
        const plan = planDiagnosisEventEdit(event("missingRing"), 1902, 1899, 1903);
        expect(plan).toEqual({
            operationType: "INSERT_MISSING_RING",
            targetTree: "ABC01A",
            targetYear: 1902,
            side: "right",
        });
        if (plan?.operationType !== "INSERT_MISSING_RING") throw new Error("unexpected plan");
        const applied = insertMissingYearAtSide(series, plan.targetYear, plan.side);
        expect(applied.get(1902)).toBe(0);
        expect(applied.get(1903)).toBe(50);
        expect(applied.get(1901)).toBe(40);
    });

    it("deletes a selected false ring and advances the older side", () => {
        const plan = planDiagnosisEventEdit(event("falseRing"), 1902, 1899, 1903);
        expect(plan).toEqual({
            operationType: "DELETE_FALSE_RING",
            targetTree: "ABC01A",
            targetYear: 1902,
            shift: "right",
        });
        if (plan?.operationType !== "DELETE_FALSE_RING") throw new Error("unexpected plan");
        const applied = deleteYearWithMode(series, plan.targetYear, "direct", plan.shift);
        expect(applied.has(1902)).toBe(true);
        expect(applied.get(1902)).toBe(30);
        expect(applied.get(1903)).toBe(50);
    });

    it("treats the selected partial breakpoint as the first fixed year", () => {
        const plan = planDiagnosisEventEdit(event("partialMove", {
            shiftYears: -2,
            shiftSide: "older",
        }), 1902, 1899, 1903);
        expect(plan).toEqual({
            operationType: "SHIFT_RANGE",
            targetTree: "ABC01A",
            startYear: 1899,
            endYear: 1901,
            shiftYears: -2,
            firstFixedYear: 1902,
            lastMovedYear: 1901,
            missingRange: { startYear: 1900, endYear: 1901 },
        });
        if (plan?.operationType !== "SHIFT_RANGE") throw new Error("unexpected plan");
        const applied = moveSeriesTailByOffset(
            series,
            plan.startYear,
            plan.endYear,
            plan.shiftYears,
        );
        expect(applied.get(1899)).toBe(30);
        expect(applied.has(1900)).toBe(false);
        expect(applied.has(1901)).toBe(false);
        expect(applied.get(1902)).toBe(40);
        expect(applied.get(1903)).toBe(50);
    });

    it("rejects automatic positive, newer-side, and one-year partial moves", () => {
        const positive = planDiagnosisEventEdit(event("partialMove", {
            shiftYears: 2,
            shiftSide: "newer",
        }), 1901, 1899, 1903);
        const oneYear = planDiagnosisEventEdit(event("partialMove", {
            shiftYears: -1,
            shiftSide: "older",
        }), 1901, 1899, 1903);
        expect(positive).toBeNull();
        expect(oneYear).toBeNull();
    });

    it("does not turn a lower-threshold review window into a direct edit", () => {
        expect(planDiagnosisEventEdit(event("missingRing", {
            reviewOnly: true,
        }), 1902, 1899, 1903)).toBeNull();
    });

    it("allows an explicitly confirmed review window through the manual UI path", () => {
        expect(planManuallyConfirmedDiagnosisEventEdit(event("missingRing", {
            reviewOnly: true,
        }), 1902, 1899, 1903)).toEqual({
            operationType: "INSERT_MISSING_RING",
            targetTree: "ABC01A",
            targetYear: 1902,
            side: "right",
        });
    });

    it("applies the deterministic 1904 / -4 case without touching the fixed side", () => {
        const longSeries = new Map<number, number>(
            Array.from({ length: 225 }, (_, index) => {
                const year = 1800 + index;
                return [year, year * 10];
            }),
        );
        const plan = planDiagnosisEventEdit(event("partialMove", {
            startYear: 1900,
            endYear: 1908,
            shiftYears: -4,
            shiftSide: "older",
        }), 1904, 1800, 2024);
        expect(plan).toMatchObject({
            operationType: "SHIFT_RANGE",
            startYear: 1800,
            endYear: 1903,
            shiftYears: -4,
            firstFixedYear: 1904,
            lastMovedYear: 1903,
            missingRange: { startYear: 1900, endYear: 1903 },
        });
        if (plan?.operationType !== "SHIFT_RANGE") throw new Error("unexpected plan");
        const applied = moveSeriesTailByOffset(
            longSeries,
            plan.startYear,
            plan.endYear,
            plan.shiftYears,
        );
        expect(applied.get(1796)).toBe(18000);
        expect(applied.get(1899)).toBe(19030);
        for (let year = 1900; year <= 1903; year += 1) {
            expect(applied.has(year)).toBe(false);
        }
        for (let year = 1904; year <= 2024; year += 1) {
            expect(applied.get(year)).toBe(longSeries.get(year));
        }
        expect(plan.shiftYears).not.toBe(-3);
    });
});

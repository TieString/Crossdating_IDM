import { describe, expect, it } from "vitest";
import { rankUnitEventWindows } from "../unitEventWindowRanker";

const years = Array.from({ length: 41 }, (_, index) => 1900 + index);

describe("unit event window ranker", () => {
    it.each(["missingRing", "falseRing"] as const)(
        "returns one calibrated 9/13-year window for %s",
        (eventType) => {
            const result = rankUnitEventWindows({
                eventType,
                years,
                ranks: new Map(),
                internalCandidates: [],
            });

            expect(result).not.toBeNull();
            expect(result!.modeWindow.endYear - result!.modeWindow.startYear + 1)
                .toBe(13);
            expect([9, 13]).toContain(result!.recommendedWidth);
            expect(result!.window.endYear - result!.window.startYear + 1)
                .toBe(result!.recommendedWidth);
            const centerDelta = Math.abs(
                (result!.window.startYear + result!.window.endYear)
                - (result!.modeWindow.startYear + result!.modeWindow.endYear),
            ) / 2;
            expect(centerDelta).toBeLessThanOrEqual(
                eventType === "falseRing" ? 1 : 0,
            );
            expect(result!.nineYearSafety).toBeGreaterThanOrEqual(0);
            expect(result!.nineYearSafety).toBeLessThanOrEqual(1);
            expect(result!.scoredWindows.length).toBeGreaterThan(0);
            expect(result!.scoredWindows.length).toBeLessThanOrEqual(
                years.length - 13 + 1,
            );
        },
    );

    it("does not score a sequence shorter than the calibrated mode width", () => {
        expect(rankUnitEventWindows({
            eventType: "missingRing",
            years: years.slice(0, 12),
            ranks: new Map(),
            internalCandidates: [],
        })).toBeNull();
    });
});

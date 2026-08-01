import { describe, expect, it } from "vitest";
import { rankUnitEventYears } from "../unitEventYearRanking";

const allYears = Array.from({ length: 21 }, (_, index) => 1900 + index);
const peak = (center: number): number[] => allYears.map((year) => (
    Math.max(0, 1 - Math.abs(year - center) / 5)
));

describe("rankUnitEventYears", () => {
    it("combines reference, edit, and path evidence for missing rings", () => {
        const result = rankUnitEventYears({
            eventType: "missingRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([
                ["cumulativeReferenceVote", peak(1910)],
                ["comboFull", peak(1910)],
                ["piecewiseCombinedObjective", peak(1910)],
            ]),
        });

        expect(result?.profileNames).toEqual([
            "cumulativeReferenceVote",
            "comboFull",
            "piecewiseCombinedObjective",
        ]);
        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1],
        );
        expect(ranked[0][0]).toBe(1910);
    });

    it("uses the sharp corrected-difference profile for false rings", () => {
        const result = rankUnitEventYears({
            eventType: "falseRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map([
                ["differenceFull", peak(1911)],
            ]),
        });

        expect(result?.profileNames).toEqual(["differenceFull"]);
        const ranked = [...result!.scoreByYear.entries()].sort(
            (left, right) => right[1] - left[1],
        );
        expect(ranked[0][0]).toBe(1911);
    });

    it("falls back when required evidence is unavailable", () => {
        expect(rankUnitEventYears({
            eventType: "missingRing",
            years: allYears.slice(5, 16),
            allYears,
            ranks: new Map(),
        })).toBeNull();
    });
});

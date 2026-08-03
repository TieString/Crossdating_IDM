import { describe, expect, it } from "vitest";
import type { FalseRingCoarseCounterfactualRow } from "../falseRingCoarseCounterfactual";
import type { MissingRingCoarseCounterfactualRow } from "../missingRingCoarseCounterfactual";
import { selectUnitEventPointWindow } from "../unitEventPointWindowSelector";

const years = Array.from({ length: 41 }, (_, index) => 1880 + index);
const ranks = new Map<string, number[]>([
    ["differenceFull", years.map((year) => Math.max(0, 1 - Math.abs(year - 1900) / 20))],
]);

const missingRows: MissingRingCoarseCounterfactualRow[] = Array.from(
    { length: 25 },
    (_, index) => {
        const year = 1888 + index;
        const value = -Math.abs(year - 1900);
        return {
            year,
            profiles: {
                differencePredictiveWeightedHuber21: value,
                differencePredictiveEnsembleHuber31: value,
                differencePredictiveWeightedHuber61: value,
                whitenedPredictiveEnsembleHuber21: value,
            },
        };
    },
);

const falseRows: FalseRingCoarseCounterfactualRow[] = missingRows.map((row) => ({
    year: row.year,
    profiles: {
        differenceMasterHuber31:
            row.profiles.differencePredictiveWeightedHuber21,
        whitenedMasterHuber31:
            row.profiles.differencePredictiveEnsembleHuber31,
        differenceReferenceWeightedHuber31:
            row.profiles.differencePredictiveWeightedHuber61,
        differenceMasterHuber21:
            row.profiles.whitenedPredictiveEnsembleHuber21,
    },
}));

describe("unit-event point window selector", () => {
    it("returns one bounded missing-ring window", () => {
        const result = selectUnitEventPointWindow({
            eventType: "missingRing",
            years,
            ranks,
            internalCandidates: [],
            currentPrimaryYear: 1900,
            coarseWindow: { startYear: 1888, endYear: 1912 },
            operationEvidence: { bestYear: 1900, sideStepBestYear: 1900 },
            missingCounterfactualRows: missingRows,
        });

        expect(result).not.toBeNull();
        expect(result!.window.endYear - result!.window.startYear + 1).toBe(13);
        expect(result!.window.startYear).toBeGreaterThanOrEqual(years[0]);
        expect(result!.window.endYear).toBeLessThanOrEqual(
            years[years.length - 1],
        );
        expect(result!.scoredWindows[0]).toEqual(result!.window);
        expect(result!.yearScores.size).toBe(25);
        expect([5, 9, 13]).toContain(result!.recommendedWidth);
    });

    it("requires the matching event-specific counterfactual table", () => {
        expect(selectUnitEventPointWindow({
            eventType: "missingRing",
            years,
            ranks,
            internalCandidates: [],
            coarseWindow: { startYear: 1888, endYear: 1912 },
        })).toBeNull();
        const falseResult = selectUnitEventPointWindow({
            eventType: "falseRing",
            years,
            ranks,
            internalCandidates: [],
            coarseWindow: { startYear: 1888, endYear: 1912 },
            falseCounterfactualRows: falseRows,
        });
        expect(falseResult).not.toBeNull();
        expect(falseResult!.window.endYear - falseResult!.window.startYear + 1)
            .toBe(13);
        expect(falseResult!.recommendedWidth).toBe(13);
        expect(selectUnitEventPointWindow({
            eventType: "falseRing",
            years,
            ranks,
            internalCandidates: [],
            coarseWindow: { startYear: 1888, endYear: 1912 },
            missingCounterfactualRows: missingRows,
        })).toBeNull();
    });

    it("keeps wide-missing and narrow-false refinements internal", () => {
        const missing = selectUnitEventPointWindow({
            eventType: "missingRing",
            years,
            ranks,
            internalCandidates: [],
            coarseWindow: { startYear: 1888, endYear: 1912 },
            missingCounterfactualRows: missingRows,
        }, undefined, "wideMode");
        const falseRing = selectUnitEventPointWindow({
            eventType: "falseRing",
            years,
            ranks,
            internalCandidates: [],
            coarseWindow: { startYear: 1888, endYear: 1912 },
            falseCounterfactualRows: falseRows,
        }, undefined, "narrowMode", {
            modeWindow: { startYear: 1894, endYear: 1906 },
            recommendedWidth: 9,
            nineYearSafety: 0.7,
            widthThreshold: 0.6,
        });

        expect(missing).not.toBeNull();
        expect(missing!.window.endYear - missing!.window.startYear + 1).toBe(13);
        expect(falseRing).not.toBeNull();
        expect(falseRing!.window.endYear - falseRing!.window.startYear + 1).toBe(9);
        expect(falseRing!.safetyProbability).toBeGreaterThanOrEqual(0);
        expect(falseRing!.safetyProbability).toBeLessThanOrEqual(1);
    });
});

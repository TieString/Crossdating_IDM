import { describe, expect, it } from "vitest";
import type { MissingRingCoarseCounterfactualRow } from "../missingRingCoarseCounterfactual";
import { selectMissingRingDirectMode } from "../missingRingDirectModeSelector";

const years = Array.from({ length: 41 }, (_, index) => 1880 + index);
const ranks = new Map<string, number[]>([
    ["differenceFull", years.map((year) => (
        Math.max(0, 1 - Math.abs(year - 1900) / 20)
    ))],
    ["cumulativeCombined", years.map((year) => (
        Math.max(0, 1 - Math.abs(year - 1902) / 18)
    ))],
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
                differencePredictiveEnsembleHuber31: value * 0.9,
                differencePredictiveWeightedHuber61: value * 0.8,
                whitenedPredictiveEnsembleHuber21: value * 0.7,
            },
        };
    },
);

describe("missing-ring direct mode selector", () => {
    it("returns one scored 13-year mode inside the point evidence interval", () => {
        const result = selectMissingRingDirectMode({
            eventType: "missingRing",
            years,
            ranks,
            internalCandidates: [],
            currentPrimaryYear: 1900,
            coarseWindow: { startYear: 1888, endYear: 1912 },
            operationEvidence: { bestYear: 1900, sideStepBestYear: 1902 },
            missingCounterfactualRows: missingRows,
        }, {
            modeWindow: { startYear: 1894, endYear: 1906 },
            currentWindow: { startYear: 1894, endYear: 1906 },
            recommendedWidth: 13,
            learnedWindowScore: 0.8,
            learnedWindowMargin: 0.1,
            learnedWindowRemoteMargin: 0.2,
            nineYearSafety: 0.4,
            nineYearSafetyThreshold: 0.6,
        });

        expect(result).not.toBeNull();
        expect(result!.window.endYear - result!.window.startYear + 1).toBe(13);
        expect(result!.window.startYear).toBeGreaterThanOrEqual(1888);
        expect(result!.window.endYear).toBeLessThanOrEqual(1912);
        expect(result!.scoredWindows[0]).toMatchObject(result!.window);
        expect(Number.isFinite(result!.score)).toBe(true);
    });

    it("does not replace independently calibrated narrow windows", () => {
        expect(selectMissingRingDirectMode({
            eventType: "missingRing",
            years,
            ranks,
            internalCandidates: [],
            coarseWindow: { startYear: 1888, endYear: 1912 },
            missingCounterfactualRows: missingRows,
        }, {
            modeWindow: { startYear: 1894, endYear: 1906 },
            currentWindow: { startYear: 1896, endYear: 1904 },
            recommendedWidth: 9,
            learnedWindowScore: 0.8,
            learnedWindowMargin: 0.1,
            learnedWindowRemoteMargin: 0.2,
            nineYearSafety: 0.8,
            nineYearSafetyThreshold: 0.6,
        })).toBeNull();
    });
});

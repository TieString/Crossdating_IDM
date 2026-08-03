import { describe, expect, it } from "vitest";
import type { MissingRingCoarseCounterfactualRow } from "../missingRingCoarseCounterfactual";
import { selectMissingRingPredictiveMode } from "../missingRingPredictiveModeSelector";

const rows = (score: (year: number) => number): MissingRingCoarseCounterfactualRow[] => (
    Array.from({ length: 41 }, (_, index) => {
        const year = 1900 + index;
        return {
            year,
            profiles: {
                differencePredictiveWeightedHuber21: 0,
                differencePredictiveEnsembleHuber31: score(year),
                differencePredictiveWeightedHuber61: 0,
                whitenedPredictiveEnsembleHuber21: 0,
            },
        };
    })
);

describe("missing-ring predictive remote mode selector", () => {
    it("moves to a separated predictive insertion peak", () => {
        const selected = selectMissingRingPredictiveMode(
            rows((year) => -Math.abs(year - 1930)),
            { startYear: 1904, endYear: 1916 },
        );

        expect(selected?.window).toEqual({
            startYear: 1924,
            endYear: 1936,
        });
        expect(selected?.peakYear).toBe(1930);
        expect(selected?.startDistance).toBe(20);
        expect(selected?.advantage).toBeGreaterThanOrEqual(0.15);
        expect(selected?.remoteMargin).toBeGreaterThanOrEqual(0.1);
    });

    it("rejects an equally strong remote competitor", () => {
        expect(selectMissingRingPredictiveMode(
            rows((year) => year === 1910 || year === 1930 ? 1 : 0),
            { startYear: 1904, endYear: 1916 },
        )).toBeNull();
    });
});

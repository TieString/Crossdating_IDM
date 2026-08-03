import { describe, expect, it } from "vitest";
import {
    FALSE_RING_COUNTERFACTUAL_PROFILES,
    type FalseRingCoarseCounterfactualRow,
} from "../falseRingCoarseCounterfactual";
import { selectFalseRingCounterfactualMode } from "../falseRingCounterfactualModeSelector";

const years = Array.from({ length: 81 }, (_, index) => 1900 + index);
const curve = (center: number): number[] => years.map((year) => (
    Math.exp(-Math.pow((year - center) / 3, 2))
));
const profileNames = [
    "rawFull",
    "differenceFull",
    "whitenedFull",
    "comboFull",
    "cumulativeCombined",
    "cumulativeDifference",
    "transitionSplitGain",
    "piecewiseCombinedObjective",
    "cumulativeReferenceMean",
    "cumulativeReferenceVote",
    "reference:weightedRankMean",
];
const rows: FalseRingCoarseCounterfactualRow[] = Array.from(
    { length: 29 },
    (_, index) => {
        const year = 1926 + index;
        return {
            year,
            profiles: Object.fromEntries(
                FALSE_RING_COUNTERFACTUAL_PROFILES.map((profile, profileIndex) => [
                    profile,
                    Math.exp(-Math.pow((year - 1940 - profileIndex % 2) / 2.5, 2)),
                ]),
            ) as FalseRingCoarseCounterfactualRow["profiles"],
        };
    },
);

describe("false-ring counterfactual mode selector", () => {
    it("returns one deterministic 13-year posterior-consensus mode", () => {
        const input = {
            years,
            ranks: new Map(profileNames.map((name) => [name, curve(1940)])),
            currentModeWindow: { startYear: 1934, endYear: 1946 },
            coarseWindow: { startYear: 1926, endYear: 1954 },
            operationEvidence: {
                bestYear: 1940,
                bestDifferenceGain: 0.4,
                sideStepBestYear: 1940,
                bestSideStepScore: 0.7,
            },
        };
        const first = selectFalseRingCounterfactualMode(input, rows);
        const second = selectFalseRingCounterfactualMode(input, rows);

        expect(first).toEqual(second);
        expect(first).not.toBeNull();
        expect(first!.window.endYear - first!.window.startYear + 1).toBe(13);
        expect(first!.scoredWindows[0]).toMatchObject(first!.window);
        expect(new Set(first!.scoredWindows.map((window) => (
            window.startYear
        ))).size).toBe(first!.scoredWindows.length);
    });

});

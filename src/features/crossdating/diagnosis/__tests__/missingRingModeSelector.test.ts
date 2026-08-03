import { describe, expect, it } from "vitest";

import { selectMissingRingMode } from "../missingRingModeSelector";

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

describe("missing-ring mode selector", () => {
    it("selects one deterministic 13-year mode from concentrated evidence", () => {
        const ranks = new Map(profileNames.map((name) => [
            name,
            curve(name.includes("Reference") ? 1941 : 1940),
        ]));
        const input = {
            years,
            ranks,
            currentModeWindow: { startYear: 1910, endYear: 1922 },
            coarseWindow: { startYear: 1930, endYear: 1954 },
            operationEvidence: {
                bestYear: 1940,
                bestDifferenceGain: 0.4,
                bestCombinedGain: 0.3,
                remoteDifferenceMargin: 0.03,
                sideStepBestYear: 1940,
                bestSideStepScore: 0.7,
                topThreeSideStepScore: 0.65,
                bestSideMinimumAdvantage: 0.5,
                bestCorrectedSideSupport: 0.45,
                sideStepRemoteMargin: 0.04,
            },
        };

        const first = selectMissingRingMode(input);
        const second = selectMissingRingMode(input);

        expect(first).toEqual(second);
        expect(first?.window).toEqual({
            startYear: 1934,
            endYear: 1946,
        });
        expect(first!.window.endYear - first!.window.startYear + 1).toBe(13);
        expect(first!.scoredWindows).toHaveLength(6);
        expect(first!.margin).toBeGreaterThan(0);
    });

    it("does not select a mode for a sequence shorter than 13 years", () => {
        expect(selectMissingRingMode({
            years: years.slice(0, 12),
            ranks: new Map(),
            currentModeWindow: { startYear: 1900, endYear: 1912 },
            coarseWindow: { startYear: 1900, endYear: 1912 },
        })).toBeNull();
    });
});

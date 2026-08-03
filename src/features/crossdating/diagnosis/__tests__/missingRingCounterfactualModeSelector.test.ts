import { describe, expect, it } from "vitest";
import {
    MISSING_RING_COUNTERFACTUAL_PROFILES,
    type MissingRingCoarseCounterfactualRow,
} from "../missingRingCoarseCounterfactual";
import { selectMissingRingCounterfactualMode } from "../missingRingCounterfactualModeSelector";

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

const rows: MissingRingCoarseCounterfactualRow[] = Array.from(
    { length: 25 },
    (_, index) => {
        const year = 1928 + index;
        return {
            year,
            profiles: Object.fromEntries(
                MISSING_RING_COUNTERFACTUAL_PROFILES.map((profile, profileIndex) => [
                    profile,
                    Math.exp(-Math.pow((year - 1940 - profileIndex % 2) / 2.5, 2)),
                ]),
            ) as MissingRingCoarseCounterfactualRow["profiles"],
        };
    },
);

describe("missing-ring counterfactual mode selector", () => {
    it("returns one deterministic 13-year posterior-consensus mode", () => {
        const input = {
            years,
            ranks: new Map(profileNames.map((name) => [
                name,
                curve(name.includes("Reference") ? 1941 : 1940),
            ])),
            currentModeWindow: { startYear: 1910, endYear: 1922 },
            coarseWindow: { startYear: 1928, endYear: 1952 },
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
        const first = selectMissingRingCounterfactualMode(input, rows);
        const second = selectMissingRingCounterfactualMode(input, rows);

        expect(first).toEqual(second);
        expect(first).not.toBeNull();
        expect(first!.window.endYear - first!.window.startYear + 1).toBe(13);
        expect(first!.scoredWindows[0]).toMatchObject(first!.window);
        expect(new Set(first!.scoredWindows.map((window) => (
            window.startYear
        ))).size).toBe(first!.scoredWindows.length);
    });

    it("does not select without coarse counterfactual rows", () => {
        expect(selectMissingRingCounterfactualMode({
            years,
            ranks: new Map(),
            currentModeWindow: { startYear: 1900, endYear: 1912 },
            coarseWindow: { startYear: 1900, endYear: 1924 },
        }, [])).toBeNull();
    });
});

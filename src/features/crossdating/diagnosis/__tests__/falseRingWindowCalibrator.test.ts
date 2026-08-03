import { describe, expect, it } from "vitest";

import {
    calibrateFalseRingWindow,
    isFalseRingNarrowWindowConsistent,
} from "../falseRingWindowCalibrator";

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

describe("false-ring window calibrator", () => {
    it("keeps the 13-year mode when independent narrow evidence disagrees", () => {
        const selectedModeWindow = { startYear: 1934, endYear: 1946 };

        expect(isFalseRingNarrowWindowConsistent({
            selectedModeWindow,
            narrowWindow: { startYear: 1935, endYear: 1943 },
            transitionNarrowStart: 1938,
        })).toBe(false);
        expect(isFalseRingNarrowWindowConsistent({
            selectedModeWindow,
            narrowWindow: { startYear: 1936, endYear: 1944 },
            transitionNarrowStart: 1936,
        })).toBe(true);
        expect(isFalseRingNarrowWindowConsistent({
            selectedModeWindow,
            narrowWindow: { startYear: 1938, endYear: 1946 },
            transitionNarrowStart: 1938,
        })).toBe(false);
    });

    it("returns one deterministic 9- or 13-year window inside the selected mode", () => {
        const ranks = new Map(profileNames.map((name) => [
            name,
            curve(name.includes("Reference") ? 1941 : 1940),
        ]));
        const input = {
            years,
            ranks,
            selectedModeWindow: { startYear: 1934, endYear: 1946 },
            learnedModeWindow: { startYear: 1934, endYear: 1946 },
            previousModeWindow: { startYear: 1934, endYear: 1946 },
            previousWindow: { startYear: 1936, endYear: 1944 },
            coarseWindow: { startYear: 1930, endYear: 1954 },
            currentPrimaryYear: 1940,
            nineYearSafety: 0.75,
            nineYearSafetyThreshold: 0.61,
            operationEvidence: {
                bestYear: 1940,
                bestDifferenceGain: 0.4,
                remoteDifferenceMargin: 0.03,
                sideStepBestYear: 1940,
                bestSideStepScore: 0.7,
                bestSideMinimumAdvantage: 0.5,
                bestCorrectedSideSupport: 0.45,
                sideStepRemoteMargin: 0.04,
            },
            learnedWindowScore: 0.8,
            learnedWindowMargin: 0.1,
            learnedWindowRemoteMargin: 0.2,
        };

        const first = calibrateFalseRingWindow(input);
        const second = calibrateFalseRingWindow(input);

        expect(first).toEqual(second);
        expect([9, 13]).toContain(first.recommendedWidth);
        expect(first.window.endYear - first.window.startYear + 1).toBe(
            first.recommendedWidth,
        );
        expect(first.window.startYear).toBeGreaterThanOrEqual(1934);
        expect(first.window.endYear).toBeLessThanOrEqual(1946);
        expect(first.probability).toBeGreaterThanOrEqual(0);
        expect(first.probability).toBeLessThanOrEqual(1);
    });
});

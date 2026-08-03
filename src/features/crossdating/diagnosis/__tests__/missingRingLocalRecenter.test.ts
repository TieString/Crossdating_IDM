import { describe, expect, it } from "vitest";
import type { MissingRingCoarseCounterfactualRow } from "../missingRingCoarseCounterfactual";
import {
    recenterMissingRingNarrowWindow,
    recenterMissingRingWideWindow,
} from "../missingRingLocalRecenter";

const rows = (
    edgePeakYear: number,
    olderPeakYear = edgePeakYear,
): MissingRingCoarseCounterfactualRow[] => Array.from(
    { length: 25 },
    (_, index) => {
        const year = 1900 + index;
        return {
            year,
            profiles: {
                differencePredictiveWeightedHuber21: 0,
                differencePredictiveEnsembleHuber31: 0,
                differencePredictiveWeightedHuber61: 0,
                whitenedPredictiveEnsembleHuber21: 0,
                whitenedPredictiveMedianHuberEdge3Gain:
                    year === edgePeakYear ? 10 : 0,
                whitenedOlderHuberBoundary7:
                    year === olderPeakYear ? 10 : 0,
            },
        };
    },
);

describe("missing-ring local recentering", () => {
    it("moves a narrow window two years when all boundary anchors agree", () => {
        expect(recenterMissingRingNarrowWindow({
            rows: rows(1910),
            currentWindow: { startYear: 1908, endYear: 1916 },
            containingWindow: { startYear: 1906, endYear: 1918 },
            currentPrimaryYear: 1910,
            operationEvidence: {
                bestYear: 1909,
                sideStepBestYear: 1908,
            },
        })).toMatchObject({
            window: { startYear: 1906, endYear: 1914 },
            shiftYears: -2,
            rule: "boundary_anchor_consensus_step_2",
        });
    });

    it("limits a feature-only narrow correction to one year", () => {
        expect(recenterMissingRingNarrowWindow({
            rows: rows(1910),
            currentWindow: { startYear: 1908, endYear: 1916 },
            containingWindow: { startYear: 1906, endYear: 1918 },
            currentPrimaryYear: 1910,
            operationEvidence: { bestYear: 1912 },
        })).toMatchObject({
            window: { startYear: 1907, endYear: 1915 },
            shiftYears: -1,
            rule: "boundary_feature_step_1",
        });
    });

    it("moves a 13-year mode only for a strong immediately adjacent peak", () => {
        expect(recenterMissingRingWideWindow(
            rows(1912, 1906),
            { startYear: 1907, endYear: 1919 },
            { startYear: 1900, endYear: 1924 },
        )).toMatchObject({
            window: { startYear: 1906, endYear: 1918 },
            peakYear: 1906,
            shiftYears: -1,
        });
    });
});

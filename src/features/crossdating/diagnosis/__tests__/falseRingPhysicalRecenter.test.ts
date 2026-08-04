import { describe, expect, it } from "vitest";
import type { FalseRingCoarseCounterfactualRow } from "../falseRingCoarseCounterfactual";
import {
    selectFalseRingDirectConsensusRecenter,
    selectFalseRingMergeOlderRecenter,
} from "../falseRingPhysicalRecenter";

const rows = (
    selectedYear: number,
    mergeAdvantage = 0.08,
    remoteMargin = 0.12,
): FalseRingCoarseCounterfactualRow[] => Array.from(
    { length: 25 },
    (_, index) => {
        const year = 1900 + index;
        const distance = Math.abs(year - selectedYear);
        const mergeScore = distance === 0
            ? 0.5
            : distance > 6
                ? 0.5 - remoteMargin
                : 0.45 - distance * 0.01;
        return {
            year,
            profiles: {
                differenceMasterHuber31:
                    distance === 0 ? mergeScore - mergeAdvantage : mergeScore,
                whitenedMasterHuber31: 0,
                differenceReferenceWeightedHuber31: 0,
                differenceMasterHuber21: 0,
                falseMergeOlderDifferenceMasterHuber31: mergeScore,
            },
        };
    },
);

describe("false-ring physical recenter", () => {
    it("recenters an existing-width window on a distinct merge-older peak", () => {
        expect(selectFalseRingMergeOlderRecenter(
            rows(1918),
            { startYear: 1904, endYear: 1912 },
        )).toEqual({
            centerYear: 1918,
            window: { startYear: 1914, endYear: 1922 },
            mergeAdvantage: expect.closeTo(0.08),
            remoteMargin: expect.closeTo(0.12),
        });
    });

    it("keeps the current window when the peak is already covered", () => {
        expect(selectFalseRingMergeOlderRecenter(
            rows(1908),
            { startYear: 1904, endYear: 1912 },
        )).toBeNull();
    });

    it("rejects weak correction advantage and ambiguous remote modes", () => {
        const current = { startYear: 1904, endYear: 1912 };
        expect(selectFalseRingMergeOlderRecenter(
            rows(1918, 0.03, 0.12),
            current,
        )).toBeNull();
        expect(selectFalseRingMergeOlderRecenter(
            rows(1918, 0.08, 0.07),
            current,
        )).toBeNull();
    });
});

const directRows = (
    peak = 1918,
    disagreeingProfiles = 0,
): FalseRingCoarseCounterfactualRow[] => Array.from(
    { length: 25 },
    (_, index) => {
        const year = 1900 + index;
        const primary = -Math.abs(year - peak);
        const disagreeing = -Math.abs(year - (peak - 8));
        const value = (profileIndex: number) => (
            profileIndex < disagreeingProfiles ? disagreeing : primary
        );
        return {
            year,
            profiles: {
                differenceMasterHuber31: 0,
                whitenedMasterHuber31: 0,
                differenceReferenceWeightedHuber31: 0,
                differenceMasterHuber21: value(2),
                differenceMasterR31: value(0),
                differenceMasterR21: value(1),
                differenceReferenceWeightedR21: value(3),
                differenceReferenceWeightedR31: value(4),
                whitenedMasterR31: value(5),
            },
        };
    },
);

describe("false-ring direct consensus recenter", () => {
    it("moves an edge window by at most two years", () => {
        expect(selectFalseRingDirectConsensusRecenter(
            directRows(),
            { startYear: 1904, endYear: 1912 },
            [1918],
        )).toEqual({
            centerYear: 1910,
            window: { startYear: 1906, endYear: 1914 },
            candidateYear: 1918,
            shiftYears: 2,
            consensusCount: 6,
            anchorCount: 1,
        });
    });

    it("requires five profile votes and one independent anchor", () => {
        const current = { startYear: 1904, endYear: 1912 };
        expect(selectFalseRingDirectConsensusRecenter(
            directRows(1918, 2),
            current,
            [1918],
        )).toBeNull();
        expect(selectFalseRingDirectConsensusRecenter(
            directRows(),
            current,
            [1908],
        )).toBeNull();
    });
});

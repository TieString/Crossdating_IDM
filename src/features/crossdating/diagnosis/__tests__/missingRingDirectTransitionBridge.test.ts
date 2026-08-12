import { describe, expect, it } from "vitest";
import {
    selectMissingRingDiffuseOlderConsensusRecenter,
    selectMissingRingDirectTransitionBridge,
} from "../missingRingDirectTransitionBridge";

describe("selectMissingRingDirectTransitionBridge", () => {
    it("keeps the existing primary and a newer direct transition in one 13-year window", () => {
        const result = selectMissingRingDirectTransitionBridge({
            currentWindow: { startYear: 1848, endYear: 1860 },
            coarseWindow: { startYear: 1836, endYear: 1871 },
            currentPrimaryYear: 1851,
            directTransitionYear: 1863,
            locationAmbiguous: true,
        });

        expect(result).toEqual({
            window: { startYear: 1851, endYear: 1863 },
            discardedWindow: { startYear: 1848, endYear: 1860 },
            currentPrimaryYear: 1851,
            directTransitionYear: 1863,
            shiftYears: 3,
        });
    });

    it("uses the smallest older translation when the transition is older", () => {
        const result = selectMissingRingDirectTransitionBridge({
            currentWindow: { startYear: 1900, endYear: 1912 },
            coarseWindow: { startYear: 1880, endYear: 1920 },
            currentPrimaryYear: 1909,
            directTransitionYear: 1897,
            locationAmbiguous: true,
        });

        expect(result?.window).toEqual({ startYear: 1897, endYear: 1909 });
        expect(result?.shiftYears).toBe(-3);
    });

    it("does not rewrite a non-ambiguous mode", () => {
        const result = selectMissingRingDirectTransitionBridge({
            currentWindow: { startYear: 1848, endYear: 1860 },
            coarseWindow: { startYear: 1836, endYear: 1871 },
            currentPrimaryYear: 1851,
            directTransitionYear: 1863,
            locationAmbiguous: false,
        });

        expect(result).toBeNull();
    });

    it("refuses anchors that cannot fit in one 13-year window", () => {
        const result = selectMissingRingDirectTransitionBridge({
            currentWindow: { startYear: 1848, endYear: 1860 },
            coarseWindow: { startYear: 1836, endYear: 1880 },
            currentPrimaryYear: 1851,
            directTransitionYear: 1864,
            locationAmbiguous: true,
        });

        expect(result).toBeNull();
    });
});

describe("selectMissingRingDiffuseOlderConsensusRecenter", () => {
    const input = () => ({
        currentWindow: { startYear: 1579, endYear: 1591 },
        minimumYear: 1207,
        maximumYear: 1960,
        scanTopYear: 1574,
        directTransitionYear: 1573,
        candidateTopYear: 1579,
        candidateTopProbability: 0.483653,
        candidateTopMargin: 0.424708,
        locatorConcentration: 0,
        locatorRemoteMargin: 0,
        pairReferenceCount: 16,
    });

    it("moves a diffuse 13-year mode to retain agreeing older boundaries", () => {
        expect(selectMissingRingDiffuseOlderConsensusRecenter(input())).toEqual({
            window: { startYear: 1573, endYear: 1585 },
            discardedWindow: { startYear: 1579, endYear: 1591 },
            scanTopYear: 1574,
            directTransitionYear: 1573,
            candidateTopYear: 1579,
            shiftYears: -6,
        });
    });

    it("also retains a candidate just outside the discarded window", () => {
        const candidate = input();
        candidate.currentWindow = { startYear: 1774, endYear: 1786 };
        candidate.minimumYear = 1400;
        candidate.maximumYear = 2000;
        candidate.scanTopYear = 1767;
        candidate.directTransitionYear = 1768;
        candidate.candidateTopYear = 1772;

        expect(selectMissingRingDiffuseOlderConsensusRecenter(candidate)?.window)
            .toEqual({ startYear: 1767, endYear: 1779 });
    });

    it.each([
        ["a concentrated locator", { locatorConcentration: 0.2 }],
        ["a separated transition", { directTransitionYear: 1570 }],
        ["a detached candidate", { candidateTopYear: 1581 }],
        ["shallow reference support", { pairReferenceCount: 7 }],
    ])("keeps the current window for %s", (_name, override) => {
        expect(selectMissingRingDiffuseOlderConsensusRecenter({
            ...input(),
            ...override,
        })).toBeNull();
    });
});

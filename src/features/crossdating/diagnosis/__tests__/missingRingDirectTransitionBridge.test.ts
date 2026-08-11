import { describe, expect, it } from "vitest";
import { selectMissingRingDirectTransitionBridge } from "../missingRingDirectTransitionBridge";

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

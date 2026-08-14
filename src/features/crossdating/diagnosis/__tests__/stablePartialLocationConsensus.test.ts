import { describe, expect, it } from "vitest";
import { selectStablePartialLocationConsensus } from "../stablePartialLocationConsensus";

describe("stable partial location consensus", () => {
    it("moves a lag-path plateau to the robust boundary consensus", () => {
        expect(selectStablePartialLocationConsensus(
            1808,
            1818,
            1814,
            1809,
        )).toEqual({
            pathYear: 1808,
            localCorrelationYear: 1818,
            localStepYear: 1814,
            referenceVoteYear: 1809,
            centerYear: 1812,
        });
    });

    it("does not let one detached local peak drag the consensus away", () => {
        expect(selectStablePartialLocationConsensus(
            1836,
            1851,
            1835,
            1835,
        ).centerYear).toBe(1836);
    });

    it("keeps an upstream window center distinct from its ranked Top1", () => {
        expect(selectStablePartialLocationConsensus(
            1928,
            1928,
            1944,
            1922,
        ).centerYear).toBe(1928);
    });
});

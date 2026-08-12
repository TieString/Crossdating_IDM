import { describe, expect, it } from "vitest";
import {
    supportsCompletedPartialPairCompetition,
    type CompletedPartialPairCompetition,
} from "../completedPartialPairCompetition";

const supported = (): CompletedPartialPairCompetition => ({
    aggregateShiftYears: -26,
    olderShiftYears: -20,
    newerShiftYears: -6,
    olderYear: 1826,
    newerYear: 1833,
    rawOlderYear: 1825,
    rawNewerYear: 1831,
    cofechaOlderYear: 1827,
    cofechaNewerYear: 1834,
    rawPairMargin: -0.0004,
    cofechaPairMargin: 0.011,
    rawFamilyMargin: 0.02,
    cofechaFamilyMargin: 0.02,
    newerOperationDifferenceGain: 0.034,
    amplitudeFamilyCount: 3,
});

describe("supportsCompletedPartialPairCompetition", () => {
    it("accepts a nearby pair supported by both preprocessing views", () => {
        expect(supportsCompletedPartialPairCompetition(supported())).toBe(true);
    });

    it("rejects a pair when the two views choose detached boundaries", () => {
        const competition = supported();
        competition.cofechaNewerYear += 5;
        expect(supportsCompletedPartialPairCompetition(competition)).toBe(false);
    });

    it("rejects a decomposition without a distinct amplitude-family margin", () => {
        const competition = supported();
        competition.rawFamilyMargin = 0.004;
        expect(supportsCompletedPartialPairCompetition(competition)).toBe(false);
    });
});

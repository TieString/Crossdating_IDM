import { describe, expect, it } from "vitest";
import {
    supportsDiscreteMissingStaircase,
    type LocalTwoStepStaircaseEvidence,
    type MissingStaircaseCompetition,
} from "../discreteMissingStaircaseCompetition";

const competition = (
    overrides: Partial<MissingStaircaseCompetition> = {},
): MissingStaircaseCompetition => ({
    cumulativeShiftYears: -2,
    directFirstFixedYear: 1905,
    missingYears: [1904, 1900],
    missingSpanYears: 4,
    masterMargin: -0.01,
    globalMargin: -0.001,
    localMargin: -0.02,
    referenceSupport: 30,
    referenceCount: 36,
    referenceSupportRatio: 30 / 36,
    referenceMedianMargin: 0.05,
    referenceLowerQuartileMargin: 0.001,
    ...overrides,
});

const local = (
    overrides: Partial<LocalTwoStepStaircaseEvidence> = {},
): LocalTwoStepStaircaseEvidence => ({
    olderBoundaryYear: 1900,
    newerBoundaryYear: 1904,
    staircaseGain: -0.01,
    middleMeanAdvantage: 0.04,
    referenceSupport: 27,
    referenceCount: 36,
    referenceMedianAdvantage: 0.06,
    ...overrides,
});

describe("discrete missing-staircase safety gate", () => {
    it("accepts separated unit events supported by both independent views", () => {
        expect(supportsDiscreteMissingStaircase(
            competition(),
            local(),
        )).toBe(true);
    });

    it("rejects adjacent inserts because they are equivalent to one continuous gap", () => {
        expect(supportsDiscreteMissingStaircase(
            competition({ missingYears: [1904, 1903], missingSpanYears: 1 }),
            local(),
        )).toBe(false);
    });

    it("rejects a master-only peak without robust per-reference support", () => {
        expect(supportsDiscreteMissingStaircase(
            competition({
                masterMargin: 0.2,
                referenceSupport: 15,
                referenceSupportRatio: 15 / 36,
                referenceMedianMargin: -0.01,
            }),
            local(),
        )).toBe(false);
    });
});

import { describe, expect, it } from "vitest";
import {
    supportsDecisiveUnanchoredMissingStaircase,
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
    it("accepts a three-year boundary span only with decisive unanchored support", () => {
        const decisiveCompetition = competition({
            referenceSupport: 35,
            referenceCount: 36,
            referenceSupportRatio: 35 / 36,
            referenceMedianMargin: 0.12,
            referenceLowerQuartileMargin: 0.09,
        });
        const decisiveLocal = local({
            olderBoundaryYear: 1901,
            newerBoundaryYear: 1904,
            staircaseGain: 0.5,
            middleMeanAdvantage: 0.25,
            referenceSupport: 34,
            referenceCount: 36,
            referenceMedianAdvantage: 0.19,
        });

        expect(supportsDecisiveUnanchoredMissingStaircase(
            decisiveCompetition,
            decisiveLocal,
        )).toBe(true);
        expect(supportsDecisiveUnanchoredMissingStaircase(
            decisiveCompetition,
            { ...decisiveLocal, newerBoundaryYear: 1903 },
        )).toBe(false);
        expect(supportsDecisiveUnanchoredMissingStaircase(
            { ...decisiveCompetition, referenceLowerQuartileMargin: 0.019 },
            decisiveLocal,
        )).toBe(false);
    });

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

    it("accepts a near-threshold reference median when every aggregate margin is positive", () => {
        expect(supportsDiscreteMissingStaircase(
            competition({
                masterMargin: 0.015,
                localMargin: 0.024,
                referenceMedianMargin: 0.026,
                referenceLowerQuartileMargin: 0.009,
                referenceSupport: 42,
                referenceCount: 54,
                referenceSupportRatio: 42 / 54,
            }),
            local(),
            { allowConfirmedHistoryRelaxation: true },
        )).toBe(true);
    });

    it("rejects the same near-threshold median when the direct partial wins globally", () => {
        expect(supportsDiscreteMissingStaircase(
            competition({
                masterMargin: -0.01,
                localMargin: 0.024,
                referenceMedianMargin: 0.026,
                referenceLowerQuartileMargin: 0.009,
            }),
            local(),
            { allowConfirmedHistoryRelaxation: true },
        )).toBe(false);
    });

    it("allows a slightly penalized local path only under unanimous explicit support", () => {
        const unanimous = competition({
            masterMargin: 0.015,
            localMargin: 0.024,
            referenceMedianMargin: 0.026,
            referenceLowerQuartileMargin: 0.009,
        });
        expect(supportsDiscreteMissingStaircase(
            unanimous,
            local({ staircaseGain: -0.152 }),
            { allowConfirmedHistoryRelaxation: true },
        )).toBe(true);
        expect(supportsDiscreteMissingStaircase(
            { ...unanimous, masterMargin: -0.001 },
            local({ staircaseGain: -0.152 }),
            { allowConfirmedHistoryRelaxation: true },
        )).toBe(false);
    });

    it("does not use the borderline relaxation without confirmed history", () => {
        expect(supportsDiscreteMissingStaircase(
            competition({
                masterMargin: 0.02,
                localMargin: 0.03,
                referenceMedianMargin: 0.026,
                referenceLowerQuartileMargin: 0.008,
            }),
            local({ staircaseGain: 1.7 }),
        )).toBe(false);
    });
});

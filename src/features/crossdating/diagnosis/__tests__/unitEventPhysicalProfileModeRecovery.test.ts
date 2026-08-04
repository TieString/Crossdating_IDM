import { describe, expect, it } from "vitest";
import {
    selectFalseRingPhysicalProfileMode,
    selectMissingRingPhysicalProfileMode,
} from "../unitEventPhysicalProfileModeRecovery";
import type {
    UnitEventWindowRankerInput,
    UnitEventWindowType,
} from "../unitEventWindowRanker";

const years = Array.from({ length: 61 }, (_, index) => 1880 + index);

const block = (startYear: number): number[] => years.map((year) => (
    year >= startYear && year < startYear + 13 ? 1 : 0
));

const input = (
    eventType: UnitEventWindowType,
    preferredStart: number,
): UnitEventWindowRankerInput => ({
    eventType,
    years,
    ranks: new Map([
        ["differenceFull", block(preferredStart)],
        ["cumulativeReferenceVote", block(preferredStart)],
        ["cumulativeCombined", block(preferredStart)],
        ["cumulativeReferenceVoteCusum", block(preferredStart)],
        ["pairPeakKernel5", block(preferredStart)],
    ]),
    internalCandidates: [],
    coarseWindow: { startYear: 1898, endYear: 1926 },
});

describe("unit-event physical profile mode recovery", () => {
    it("moves an unresolved missing-ring mode when both profiles improve", () => {
        expect(selectMissingRingPhysicalProfileMode(
            {
                ...input("missingRing", 1908),
                operationEvidence: {
                    bestYear: 1910,
                    bestDifferenceGain: 0.2,
                },
            },
            { startYear: 1900, endYear: 1912 },
            13,
            "missing_direct_mode_ranker",
        )).toEqual({
            window: { startYear: 1908, endYear: 1920 },
            rule: "missing_physical_profile_mode",
        });
    });

    it("protects a supported missing-ring mode and all short modes", () => {
        const source = {
            ...input("missingRing", 1908),
            currentPrimaryYear: 1902,
            operationEvidence: {
                bestYear: 1910,
                bestDifferenceGain: 0.2,
            },
        };
        expect(selectMissingRingPhysicalProfileMode(
            source,
            { startYear: 1900, endYear: 1912 },
            13,
            "missing_direct_mode_ranker",
        )).toBeNull();
        expect(selectMissingRingPhysicalProfileMode(
            source,
            { startYear: 1900, endYear: 1912 },
            9,
            "missing_direct_mode_ranker",
        )).toBeNull();
    });

    it("accepts a large newer false-ring profile shift backed by operation evidence", () => {
        expect(selectFalseRingPhysicalProfileMode(
            {
                ...input("falseRing", 1908),
                operationEvidence: {
                    bestYear: 1912,
                    sideStepRemoteMargin: 0.02,
                },
            },
            { startYear: 1900, endYear: 1912 },
            13,
            "false_counterfactual_mass",
        )).toEqual({
            window: { startYear: 1908, endYear: 1920 },
            rule: "false_physical_profile_mode",
        });
    });

    it("does not replace a point mode when the new window drops its current anchor", () => {
        expect(selectFalseRingPhysicalProfileMode(
            {
                ...input("falseRing", 1902),
                currentPrimaryYear: 1900,
                operationEvidence: { bestYear: 1905 },
            },
            { startYear: 1900, endYear: 1912 },
            13,
            "false_point_mode",
        )).toBeNull();
    });

    it("uses low side confidence to resolve a remote-current false-ring mode", () => {
        const source = {
            ...input("falseRing", 1908),
            operationEvidence: {
                bestYear: 1910,
                sideStepRemoteMargin: 0.049,
            },
        };
        expect(selectFalseRingPhysicalProfileMode(
            source,
            { startYear: 1900, endYear: 1912 },
            13,
            "false_current_remote_mode",
        )?.window).toEqual({ startYear: 1908, endYear: 1920 });
        expect(selectFalseRingPhysicalProfileMode(
            {
                ...source,
                operationEvidence: {
                    bestYear: 1910,
                    sideStepRemoteMargin: 0.05,
                },
            },
            { startYear: 1900, endYear: 1912 },
            13,
            "false_current_remote_mode",
        )).toBeNull();
    });
});

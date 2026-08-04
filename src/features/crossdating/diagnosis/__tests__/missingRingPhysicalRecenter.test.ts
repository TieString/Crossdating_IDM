import { describe, expect, it } from "vitest";
import type { MissingRingCoarseCounterfactualRow } from "../missingRingCoarseCounterfactual";
import {
    selectMissingRingPhysicalRecenter,
    type MissingRingPhysicalRecenterInput,
} from "../missingRingPhysicalRecenter";

const years = Array.from({ length: 41 }, (_, index) => 1900 + index);

const profile = (startYear: number): number[] => years.map((year) => (
    year >= startYear && year <= startYear + 12 ? 1 : 0
));

const counterfactualRows = (
    sharpStartYear?: number,
): MissingRingCoarseCounterfactualRow[] => years.map((year) => ({
    year,
    profiles: {
        differencePredictiveWeightedHuber21: 0,
        differencePredictiveEnsembleHuber31: 0,
        differencePredictiveWeightedHuber61: 0,
        whitenedPredictiveEnsembleHuber21: 0,
        whitenedPredictiveMedianHuberEdge3Gain:
            sharpStartYear !== undefined
            && year >= sharpStartYear
            && year <= sharpStartYear + 12
                ? 1
                : 0,
        whitenedOlderHuberBoundary7: 0,
    },
}));

const input = (
    overrides: Partial<MissingRingPhysicalRecenterInput> = {},
): MissingRingPhysicalRecenterInput => ({
    years,
    ranks: new Map([
        ["pairDifferenceGainWeighted", profile(1910)],
        ["pairPositiveSideStepFraction", profile(1910)],
    ]),
    currentWindow: { startYear: 1910, endYear: 1918 },
    coarseWindow: { startYear: 1905, endYear: 1935 },
    coarseSource: "profile:cumulativeCombined",
    candidates: [],
    calibrationRule:
        "unit_event_short_window_missing_concentrated_profile_9",
    windowCenteringRule: "mode_mass",
    learnedWindowMargin: 0.1,
    learnedWindowRemoteMargin: 0,
    nineYearSafety: 1,
    nineYearSafetyThreshold: 0.8,
    coarseModelMargin: 0.2,
    operationEvidence: {
        bestYear: 1914,
        bestDifferenceGain: 0.5,
        sideStepBestYear: 1914,
        bestSideStepScore: 0.5,
        sideStepRemoteMargin: 0.05,
    },
    counterfactualRows: counterfactualRows(),
    ...overrides,
});

describe("missing-ring physical recenter", () => {
    it("widens only to a containing pair-reference window", () => {
        expect(selectMissingRingPhysicalRecenter(input({
            ranks: new Map([
                ["pairDifferenceGainWeighted", profile(1908)],
                ["pairPositiveSideStepFraction", profile(1910)],
            ]),
            learnedWindowMargin: 0.01,
            nineYearSafety: 0,
            nineYearSafetyThreshold: 1,
            operationEvidence: {
                bestYear: 1914,
                bestDifferenceGain: 0.1,
                sideStepBestYear: 1914,
                bestSideStepScore: 0.5,
                sideStepRemoteMargin: 0.2,
            },
        }))).toEqual({
            window: { startYear: 1908, endYear: 1920 },
            rule: "uncertain_pair_superset_13",
            supportCount: 1,
        });
    });

    it("selects an isolated older pair-reference mode", () => {
        expect(selectMissingRingPhysicalRecenter(input({
            currentWindow: { startYear: 1920, endYear: 1932 },
            ranks: new Map([
                ["pairDifferenceGainWeighted", profile(1905)],
                ["pairPositiveSideStepFraction", profile(1920)],
            ]),
            windowCenteringRule: "missing_evidence_profile_mode",
            learnedWindowRemoteMargin: 0.6,
            operationEvidence: {
                bestYear: 1926,
                bestDifferenceGain: 0.2,
                sideStepBestYear: 1926,
                bestSideStepScore: 0.5,
                sideStepRemoteMargin: 0.2,
            },
        }))).toMatchObject({
            window: { startYear: 1905, endYear: 1917 },
            rule: "remote_pair_consensus_13",
        });
    });

    it("resolves a side-corrector conflict with its own side-step anchor", () => {
        expect(selectMissingRingPhysicalRecenter(input({
            currentWindow: { startYear: 1920, endYear: 1932 },
            ranks: new Map([
                ["pairDifferenceGainWeighted", profile(1905)],
                ["pairPositiveSideStepFraction", profile(1920)],
            ]),
            windowCenteringRule: "missing_mode_side_corrector",
            learnedWindowMargin: 0.2,
            learnedWindowRemoteMargin: 0.3,
            operationEvidence: {
                bestYear: 1908,
                bestDifferenceGain: 0.2,
                sideStepBestYear: 1910,
                bestSideStepScore: 0.5,
                sideStepRemoteMargin: 0.05,
            },
        }))).toMatchObject({
            window: { startYear: 1905, endYear: 1917 },
            rule: "side_conflict_pair_consensus_13",
            supportCount: 2,
        });
    });

    it("uses reference-wise side-step voting for a weak physical mode", () => {
        expect(selectMissingRingPhysicalRecenter(input({
            currentWindow: { startYear: 1915, endYear: 1927 },
            ranks: new Map([
                ["pairDifferenceGainWeighted", profile(1915)],
                ["pairPositiveSideStepFraction", profile(1911)],
            ]),
            windowCenteringRule: "missing_physical_profile_mode",
            coarseModelMargin: 0.4,
            operationEvidence: {
                bestYear: 1921,
                bestDifferenceGain: 0.1,
                sideStepBestYear: 1921,
                bestSideStepScore: 0.4,
                sideStepRemoteMargin: 0.05,
            },
        }))).toMatchObject({
            window: { startYear: 1911, endYear: 1923 },
            rule: "reference_side_fraction_13",
        });
    });

    it("uses sharp newer-boundary evidence at a coarse-window edge", () => {
        expect(selectMissingRingPhysicalRecenter(input({
            currentWindow: { startYear: 1905, endYear: 1917 },
            ranks: new Map([
                ["pairDifferenceGainWeighted", profile(1905)],
                ["pairPositiveSideStepFraction", profile(1905)],
            ]),
            windowCenteringRule: "missing_evidence_profile_mode",
            coarseModelMargin: 0.4,
            operationEvidence: {
                bestYear: 1911,
                bestDifferenceGain: 0.05,
                sideStepBestYear: 1911,
                bestSideStepScore: 0.4,
                sideStepRemoteMargin: 0.05,
            },
            counterfactualRows: counterfactualRows(1923),
        }))).toMatchObject({
            window: { startYear: 1923, endYear: 1935 },
            rule: "sharp_newer_boundary_13",
        });
    });

    it("selects a newer mode supported by four independent candidates", () => {
        const candidates = Array.from({ length: 4 }, (_, index) => ({
            startYear: 1920 + index,
            endYear: 1944 + index,
            source: `source-${index}`,
        }));
        expect(selectMissingRingPhysicalRecenter(input({
            coarseSource: "current_event",
            candidates,
            operationEvidence: {
                bestYear: 1914,
                bestDifferenceGain: 0.05,
                sideStepBestYear: 1914,
                bestSideStepScore: 0.2,
                sideStepRemoteMargin: 0.05,
            },
        }))).toMatchObject({
            window: { startYear: 1923, endYear: 1935 },
            rule: "remote_newer_consensus_13",
            supportCount: 4,
        });
    });

    it("keeps the calibrated window when no evidence gate passes", () => {
        expect(selectMissingRingPhysicalRecenter(input())).toBeNull();
    });
});

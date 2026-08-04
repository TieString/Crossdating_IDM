import { describe, expect, it } from "vitest";
import {
    selectFalseRingFinalEvidenceModeRecovery,
    selectMissingRingFinalEvidenceModeRecovery,
    selectMissingRingFamilyProfileModeRecovery,
    selectUnitEventEvidenceModeRecovery,
    shouldRestoreUnitEventModeWidth,
} from "../unitEventEvidenceModeRecovery";
import type {
    UnitEventWindowRankerInput,
    UnitEventWindowRankerResult,
} from "../unitEventWindowRanker";

const years = Array.from({ length: 101 }, (_, index) => 1860 + index);

const block = (startYear: number, value = 1): number[] => years.map((year) => (
    year >= startYear && year < startYear + 13 ? value : 0
));

const wideBlock = (startYear: number, endYear: number): number[] => (
    years.map((year) => year >= startYear && year <= endYear ? 1 : 0)
);

const point = (year: number, value = 1): number[] => years.map((candidate) => (
    candidate === year ? value : 0
));

const falseCounterfactualRows = (preferredStart: number) => years
    .filter((year) => year >= 1880 && year <= 1940)
    .map((year) => ({
        year,
        profiles: {
            differenceMasterHuber31: 0,
            whitenedMasterHuber31: 0,
            differenceReferenceWeightedHuber31: 0,
            differenceMasterHuber21: 0,
            differenceReferenceRankMedian31:
                year >= preferredStart && year < preferredStart + 13
                    ? 1
                    : 0,
        },
    }));

const rankerInput = (
    eventType: UnitEventWindowRankerInput["eventType"],
    ranks: Array<[string, readonly number[]]>,
    overrides: Partial<UnitEventWindowRankerInput> = {},
): UnitEventWindowRankerInput => ({
    eventType,
    years,
    ranks: new Map(ranks),
    internalCandidates: [],
    coarseWindow: { startYear: 1880, endYear: 1940 },
    ...overrides,
});

const recover = (
    input: UnitEventWindowRankerInput,
    current: { startYear: number; endYear: number },
    sourceRule: UnitEventWindowRankerResult["windowCenteringRule"],
) => selectUnitEventEvidenceModeRecovery(
    input,
    current,
    13,
    sourceRule,
);

describe("unit-event evidence mode recovery", () => {
    it("preserves a coarse-validated older missing-ring side mode", () => {
        const input = rankerInput("missingRing", [], {
            currentPrimaryYear: 1901,
            coarseRecoveryRule: "missing_remote_side_consensus",
            operationEvidence: {
                bestYear: 1901,
                bestDifferenceGain: 0.08,
                sideStepBestYear: 1881,
            },
        });

        expect(selectMissingRingFinalEvidenceModeRecovery(
            input,
            { startYear: 1894, endYear: 1906 },
            "missing_mode_side_corrector",
            { startYear: 1896, endYear: 1908 },
            { learnedWindowMargin: -0.5, learnedWindowRemoteMargin: 0 },
        )).toMatchObject({
            window: { startYear: 1878, endYear: 1890 },
            rule: "missing_coarse_remote_side_mode",
            evidence: "missing_coarse_remote_side_consensus",
        });
    });

    it("rejects a coarse older-side peak at the chronology boundary", () => {
        expect(selectMissingRingFinalEvidenceModeRecovery(
            rankerInput("missingRing", [], {
                currentPrimaryYear: 1876,
                coarseRecoveryRule: "missing_remote_side_consensus",
                operationEvidence: {
                    bestYear: 1876,
                    bestDifferenceGain: 0.08,
                    sideStepBestYear: 1860,
                },
            }),
            { startYear: 1868, endYear: 1880 },
            "missing_direct_mode_ranker",
            { startYear: 1868, endYear: 1880 },
            { learnedWindowMargin: 0, learnedWindowRemoteMargin: 0 },
        )).toBeNull();
    });

    it("leaves an already recovered missing-ring mode unchanged", () => {
        expect(selectMissingRingFinalEvidenceModeRecovery(
            rankerInput("missingRing", [], {
                currentPrimaryYear: 1901,
                coarseRecoveryRule: "missing_remote_side_consensus",
                operationEvidence: {
                    bestYear: 1901,
                    bestDifferenceGain: 0.08,
                    sideStepBestYear: 1881,
                },
            }),
            { startYear: 1878, endYear: 1890 },
            "missing_predictive_remote_mode",
            { startYear: 1894, endYear: 1906 },
            { learnedWindowMargin: 0, learnedWindowRemoteMargin: 0 },
        )).toBeNull();
    });

    it("recovers a false-ring mode from a reliable coarse older edge", () => {
        expect(selectFalseRingFinalEvidenceModeRecovery(
            rankerInput("falseRing", [], {
                coarseWindow: { startYear: 1880, endYear: 1908 },
                coarseSource: "reference_transition:rankMedian",
                operationEvidence: {
                    bestYear: 1898,
                    bestDifferenceGain: 0.3,
                    sideStepBestYear: 1892,
                    sideStepRemoteMargin: 0.1,
                },
            }),
            { startYear: 1896, endYear: 1908 },
            "false_evidence_profile_mode",
        )).toMatchObject({
            window: { startYear: 1874, endYear: 1886 },
            rule: "false_boundary_evidence_mode",
            evidence: "false_coarse_older_edge_consensus",
        });
    });

    it("uses a corroborated false-ring joint-operation peak", () => {
        expect(selectFalseRingFinalEvidenceModeRecovery(
            rankerInput("falseRing", [
                ["jointOperationMargin", point(1914)],
            ], {
                coarseWindow: { startYear: 1883, endYear: 1911 },
                currentPrimaryYear: 1904,
                operationEvidence: {
                    bestYear: 1905,
                    bestDifferenceGain: 0.27,
                    remoteDifferenceMargin: 0.06,
                    sideStepBestYear: 1890,
                    sideStepRemoteMargin: 0.09,
                },
            }),
            { startYear: 1895, endYear: 1907 },
            "false_side_step_mode",
        )).toMatchObject({
            window: { startYear: 1908, endYear: 1920 },
            rule: "false_boundary_evidence_mode",
            evidence: "false_joint_operation_peak_consensus",
        });
    });

    it("uses agreement between two local false-ring boundary peaks", () => {
        expect(selectFalseRingFinalEvidenceModeRecovery(
            rankerInput("falseRing", [
                ["correctedSideSupport", point(1884)],
                ["cumulativeCombinedContrast", point(1885)],
            ]),
            { startYear: 1889, endYear: 1901 },
            "false_reference_median_mode",
        )).toMatchObject({
            window: { startYear: 1879, endYear: 1891 },
            rule: "false_boundary_evidence_mode",
            evidence: "false_local_boundary_consensus",
        });
    });

    it.each([
        {
            sourceRule: "missing_direct_mode_ranker" as const,
            profiles: [
                "cumulativeCombined",
                "cumulativeDifference",
                "cumulativeReferenceMean",
                "cumulativeReferenceMedian",
                "cumulativeReferenceVote",
            ],
            evidence: "missing_cumulative_family",
        },
        {
            sourceRule: "missing_evidence_profile_mode" as const,
            profiles: [
                "piecewiseCombinedObjective",
                "transitionSplitGain",
            ],
            evidence: "missing_transition_family",
        },
    ])("recovers a cross-profile $evidence mode", ({
        sourceRule,
        profiles,
        evidence,
    }) => {
        const candidateStart = 1918;
        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput(
                "missingRing",
                profiles.map((name) => [name, block(candidateStart)]),
                { currentPrimaryYear: 1920 },
            ),
            { startYear: 1900, endYear: 1912 },
            sourceRule,
        )).toMatchObject({
            window: { startYear: candidateStart, endYear: candidateStart + 12 },
            rule: "missing_family_profile_mode",
            evidence,
        });
    });

    it("uses a bounded nine-year window for older pair-family evidence", () => {
        const profiles = [
            "pairDifferenceWeighted",
            "pairWhitenedMean",
            "pairPeakKernel5",
            "pairPeakKernel9",
        ];
        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput(
                "missingRing",
                profiles.map((name) => [name, block(1898)]),
                {
                    currentPrimaryYear: 1907,
                    operationEvidence: {
                        bestYear: 1907,
                        sideStepBestYear: 1896,
                    },
                },
            ),
            { startYear: 1900, endYear: 1912 },
            "mode_mass",
            { startYear: 1902, endYear: 1910 },
        )).toEqual({
            window: { startYear: 1898, endYear: 1910 },
            finalWindow: { startYear: 1898, endYear: 1906 },
            recommendedWidth: 9,
            rule: "missing_family_profile_mode",
            evidence: "missing_pair_family",
        });
    });

    it("rejects a pair-family window that abandons both strong anchors", () => {
        const profiles = [
            "pairDifferenceWeighted",
            "pairWhitenedMean",
            "pairPeakKernel5",
            "pairPeakKernel9",
        ];
        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput(
                "missingRing",
                profiles.map((name) => [name, block(1898)]),
                {
                    currentPrimaryYear: 1908,
                    operationEvidence: {
                        bestYear: 1908,
                        sideStepBestYear: 1896,
                    },
                },
            ),
            { startYear: 1900, endYear: 1912 },
            "mode_mass",
            { startYear: 1902, endYear: 1910 },
        )).toBeNull();
    });

    it("recovers a full-interval cumulative mode outside the coarse region", () => {
        const profiles = [
            "cumulativeCombined",
            "cumulativeDifference",
            "cumulativeReferenceMean",
            "cumulativeReferenceMedian",
            "cumulativeReferenceVote",
        ];
        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput(
                "missingRing",
                profiles.map((name) => [name, block(1870)]),
                {
                    currentPrimaryYear: 1906,
                    operationEvidence: {
                        bestYear: 1875,
                        bestDifferenceGain: 0.4,
                        sideStepBestYear: 1875,
                    },
                },
            ),
            { startYear: 1900, endYear: 1912 },
            "missing_mode_side_corrector",
        )).toEqual({
            window: { startYear: 1870, endYear: 1882 },
            rule: "missing_family_profile_mode",
            evidence: "missing_full_interval_cumulative_family",
        });
    });

    it("restores a remote current-and-side anchor rejected by the profile mode", () => {
        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput("missingRing", [], {
                currentPrimaryYear: 1907,
                operationEvidence: {
                    bestYear: 1929,
                    bestDifferenceGain: 0.3,
                    sideStepBestYear: 1908,
                    bestSideStepScore: 0.7,
                    sideStepRemoteMargin: 0.1,
                },
            }),
            { startYear: 1920, endYear: 1932 },
            "missing_evidence_profile_mode",
        )).toEqual({
            window: { startYear: 1901, endYear: 1913 },
            rule: "missing_family_profile_mode",
            evidence: "missing_current_side_anchor",
        });
    });

    it("keeps a remote current anchor when its side evidence is weak", () => {
        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput("missingRing", [], {
                currentPrimaryYear: 1907,
                operationEvidence: {
                    bestYear: 1929,
                    bestDifferenceGain: 0.3,
                    sideStepBestYear: 1908,
                    bestSideStepScore: 0.7,
                    sideStepRemoteMargin: 0.099,
                },
            }),
            { startYear: 1920, endYear: 1932 },
            "missing_evidence_profile_mode",
        )).toBeNull();
    });

    it("uses a supported side-step anchor after a wrong-side correction", () => {
        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput("missingRing", [], {
                currentPrimaryYear: 1933,
                operationEvidence: {
                    bestYear: 1932,
                    sideStepBestYear: 1925,
                    bestSideStepScore: 0.2,
                    sideStepRemoteMargin: 0.01,
                },
            }),
            { startYear: 1925, endYear: 1937 },
            "missing_mode_side_corrector",
        )).toEqual({
            window: { startYear: 1919, endYear: 1931 },
            rule: "missing_family_profile_mode",
            evidence: "missing_side_step_anchor",
        });
    });

    it("recovers a remote missing-ring current anchor at calibrated distances", () => {
        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput("missingRing", [], {
                currentPrimaryYear: 1920,
                operationEvidence: {
                    bestYear: 1880,
                    sideStepBestYear: 1940,
                },
            }),
            { startYear: 1902, endYear: 1914 },
            "missing_direct_mode_ranker",
        )).toEqual({
            window: { startYear: 1914, endYear: 1926 },
            rule: "missing_family_profile_mode",
            evidence: "missing_current_anchor_mode",
        });

        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput("missingRing", [], {
                currentPrimaryYear: 1908,
                operationEvidence: {
                    bestYear: 1909,
                    sideStepBestYear: 1907,
                },
            }),
            { startYear: 1920, endYear: 1932 },
            "missing_family_profile_mode",
        )?.evidence).toBe("missing_current_anchor_mode");
    });

    it("combines operation and side anchors after a wrong-side missing correction", () => {
        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput("missingRing", [], {
                currentPrimaryYear: 1913,
                operationEvidence: {
                    bestYear: 1913,
                    bestDifferenceGain: 0.4,
                    sideStepBestYear: 1913,
                    bestSideStepScore: 0.5,
                },
            }),
            { startYear: 1909, endYear: 1921 },
            "missing_mode_side_corrector",
        )).toEqual({
            window: { startYear: 1907, endYear: 1919 },
            rule: "missing_family_profile_mode",
            evidence: "missing_operation_side_median",
        });
    });

    it("selects a remote side mode corroborated by two reference peaks", () => {
        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput("missingRing", [], {
                coarseWindow: { startYear: 1910, endYear: 1940 },
                currentPrimaryYear: 1933,
                internalCandidates: [
                    {
                        startYear: 1880,
                        endYear: 1904,
                        source: "reference_transition:peakKernel9",
                    },
                    {
                        startYear: 1882,
                        endYear: 1906,
                        source: "reference_transition:peakKernel13",
                    },
                ],
                operationEvidence: {
                    bestYear: 1932,
                    sideStepBestYear: 1890,
                    bestSideStepScore: 0.4,
                },
            }),
            { startYear: 1927, endYear: 1939 },
            "missing_direct_anchor_consensus",
        )).toEqual({
            window: { startYear: 1884, endYear: 1896 },
            rule: "missing_family_profile_mode",
            evidence: "missing_remote_reference_peak_side_anchor",
        });
    });

    it("requires every member of a missing-ring evidence family", () => {
        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput("missingRing", [
                ["pairDifferenceWeighted", block(1918)],
                ["pairWhitenedMean", block(1918)],
                ["pairPeakKernel5", block(1918)],
            ], { currentPrimaryYear: 1920 }),
            { startYear: 1900, endYear: 1912 },
            "mode_mass",
        )).toBeNull();
    });

    it("rejects a dispersed two-profile transition family", () => {
        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput("missingRing", [
                ["piecewiseCombinedObjective", block(1914)],
                ["transitionSplitGain", block(1918)],
            ], { currentPrimaryYear: 1920 }),
            { startYear: 1900, endYear: 1912 },
            "missing_evidence_profile_mode",
        )).toBeNull();
    });

    it("rejects a remote transition mode that drops three aligned anchors", () => {
        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput("missingRing", [
                ["piecewiseCombinedObjective", block(1918)],
                ["transitionSplitGain", block(1918)],
            ], {
                currentPrimaryYear: 1906,
                operationEvidence: {
                    bestYear: 1908,
                    sideStepBestYear: 1908,
                },
            }),
            { startYear: 1900, endYear: 1912 },
            "missing_evidence_profile_mode",
        )).toBeNull();
    });

    it("rejects a broad transition plateau even when member peaks agree", () => {
        const plateau = wideBlock(1912, 1930);
        expect(selectMissingRingFamilyProfileModeRecovery(
            rankerInput("missingRing", [
                ["piecewiseCombinedObjective", plateau],
                ["transitionSplitGain", plateau],
            ], { currentPrimaryYear: 1920 }),
            { startYear: 1900, endYear: 1912 },
            "missing_evidence_profile_mode",
        )).toBeNull();
    });

    it("recovers a distinct missing-ring cumulative step without dropping anchors", () => {
        expect(recover(
            rankerInput("missingRing", [
                ["cumulativeCombined", block(1918)],
            ]),
            { startYear: 1888, endYear: 1900 },
            "missing_direct_mode_ranker",
        )).toEqual({
            window: { startYear: 1918, endYear: 1930 },
            rule: "missing_evidence_profile_mode",
            evidence: "missing_cumulative_step",
        });
    });

    it("uses compact core-contrast agreement for a bounded missing-ring correction", () => {
        const contrast = block(1904);
        expect(recover(
            rankerInput("missingRing", [
                ["cumulativeCombinedContrast", contrast],
                ["cumulativeDifferenceContrast", contrast],
                ["cumulativeWhitenedContrast", contrast],
            ], {
                currentPrimaryYear: 1908,
                operationEvidence: {
                    bestYear: 1909,
                    sideStepBestYear: 1907,
                },
            }),
            { startYear: 1900, endYear: 1912 },
            "missing_direct_mode_ranker",
        )?.evidence).toBe("missing_local_core_contrast");
    });

    it("accepts only strongly separated remote missing-ring modes", () => {
        const contrast = block(1920);
        expect(recover(
            rankerInput("missingRing", [
                ["cumulativeCombinedContrast", contrast],
                ["cumulativeDifferenceContrast", contrast],
                ["cumulativeWhitenedContrast", contrast],
            ], {
                currentPrimaryYear: 1917,
            }),
            { startYear: 1900, endYear: 1912 },
            "missing_direct_mode_ranker",
        )?.evidence).toBe("missing_remote_core_contrast");

        expect(recover(
            rankerInput("missingRing", [
                ["cumulativeCombinedContrast", contrast],
                ["cumulativeDifferenceContrast", contrast],
                ["cumulativeWhitenedContrast", contrast],
            ], {
                currentPrimaryYear: 1913,
            }),
            { startYear: 1900, endYear: 1912 },
            "missing_direct_mode_ranker",
        )).toBeNull();

        expect(recover(
            rankerInput("missingRing", [
                ["reference:peakKernel13", block(1920)],
            ], {
                currentPrimaryYear: 1920,
            }),
            { startYear: 1900, endYear: 1912 },
            "missing_direct_anchor_consensus",
        )?.evidence).toBe("missing_reference_peak");
    });

    it("protects a current missing-ring anchor from a remote profile peak", () => {
        expect(recover(
            rankerInput("missingRing", [
                ["cumulativeCombined", block(1920)],
            ], {
                currentPrimaryYear: 1906,
            }),
            { startYear: 1900, endYear: 1912 },
            "missing_direct_mode_ranker",
        )).toBeNull();
    });

    it("re-centers a false-ring point mode on its older current anchor", () => {
        expect(recover(
            rankerInput("falseRing", [], { currentPrimaryYear: 1902 }),
            { startYear: 1905, endYear: 1917 },
            "false_point_mode",
        )).toEqual({
            window: { startYear: 1896, endYear: 1908 },
            rule: "false_evidence_profile_mode",
            evidence: "false_current_anchor",
        });
    });

    it("recovers a remote false-ring joint-operation peak", () => {
        expect(recover(
            rankerInput("falseRing", [
                ["jointOperationMargin", point(1890)],
            ], { currentPrimaryYear: 1921 }),
            { startYear: 1915, endYear: 1927 },
            "false_point_mode",
        )).toEqual({
            window: { startYear: 1884, endYear: 1896 },
            rule: "false_evidence_profile_mode",
            evidence: "false_remote_joint_peak",
        });
    });

    it("includes a strong false-ring side-step just outside the mode", () => {
        expect(recover(
            rankerInput("falseRing", [], {
                operationEvidence: {
                    bestYear: 1905,
                    sideStepBestYear: 1898,
                    remoteDifferenceMargin: 0.03,
                    sideStepRemoteMargin: 0.2,
                },
            }),
            { startYear: 1900, endYear: 1912 },
            "false_family_mode_consensus",
        )).toEqual({
            window: { startYear: 1898, endYear: 1910 },
            rule: "false_evidence_profile_mode",
            evidence: "false_side_step_edge",
        });
    });

    it("uses pair-peak mass in the calibrated direction", () => {
        expect(recover(
            rankerInput("falseRing", [
                ["pairPeakKernel9", block(1912)],
            ]),
            { startYear: 1900, endYear: 1912 },
            "false_counterfactual_mass",
        )?.evidence).toBe("false_counterfactual_pair_peak");

        expect(recover(
            rankerInput("falseRing", [
                ["pairPeakKernel9", block(1888)],
            ]),
            { startYear: 1910, endYear: 1922 },
            "false_family_mode_consensus",
        )?.evidence).toBe("false_older_pair_peak");
    });

    it("combines seven non-raw contrast profiles for a bounded false-ring mode", () => {
        const contrast = block(1904);
        expect(recover(
            rankerInput("falseRing", [
                ["cumulativeCombinedContrast", contrast],
                ["cumulativeDifferenceContrast", contrast],
                ["cumulativeWhitenedContrast", contrast],
                ["cumulativeCofechaContrast", contrast],
                ["cumulativeReferenceMedianContrast", contrast],
                ["cumulativeReferenceMeanContrast", contrast],
                ["cumulativeReferenceVoteContrast", contrast],
            ], { currentPrimaryYear: 1908 }),
            { startYear: 1900, endYear: 1912 },
            "false_family_mode_consensus",
        )?.evidence).toBe("false_bounded_contrast");
    });

    it("can recover a physical-profile mode whose current anchor is just outside coarse", () => {
        expect(recover(
            rankerInput("falseRing", [], {
                coarseWindow: { startYear: 1900, endYear: 1940 },
                currentPrimaryYear: 1896,
            }),
            { startYear: 1910, endYear: 1922 },
            "false_physical_profile_mode",
        )).toEqual({
            window: { startYear: 1890, endYear: 1902 },
            rule: "false_evidence_profile_mode",
            evidence: "false_physical_current_anchor",
        });
    });

    it("uses unanimous older candidate boundaries for a final false-ring mode", () => {
        expect(selectFalseRingFinalEvidenceModeRecovery(
            rankerInput("falseRing", [], {
                coarseWindow: { startYear: 1900, endYear: 1940 },
                internalCandidates: [
                    { startYear: 1894, endYear: 1918, source: "current_event" },
                    { startYear: 1904, endYear: 1928, source: "lag_transition" },
                ],
            }),
            { startYear: 1906, endYear: 1918 },
            "false_counterfactual_mass",
        )).toEqual({
            window: { startYear: 1904, endYear: 1916 },
            rule: "false_evidence_profile_mode",
            evidence: "false_candidate_older_consensus",
        });
    });

    it("restores a prior false-ring mode when weak evidence splits its anchors", () => {
        expect(selectFalseRingFinalEvidenceModeRecovery(
            rankerInput("falseRing", [], {
                currentPrimaryYear: 1904,
                operationEvidence: {
                    bestYear: 1920,
                    bestDifferenceGain: 0.1,
                    remoteDifferenceMargin: 0.01,
                    sideStepBestYear: 1905,
                },
            }),
            { startYear: 1898, endYear: 1910 },
            "false_evidence_profile_mode",
            { startYear: 1914, endYear: 1926 },
        )).toEqual({
            window: { startYear: 1914, endYear: 1926 },
            rule: "false_operation_evidence_reversion",
            evidence: "false_weak_split_anchor_reversion",
        });

        expect(selectFalseRingFinalEvidenceModeRecovery(
            rankerInput("falseRing", [], {
                currentPrimaryYear: 1904,
                operationEvidence: {
                    bestYear: 1920,
                    bestDifferenceGain: 0.101,
                    remoteDifferenceMargin: 0.01,
                    sideStepBestYear: 1905,
                },
            }),
            { startYear: 1898, endYear: 1910 },
            "false_evidence_profile_mode",
            { startYear: 1914, endYear: 1926 },
        )).toBeNull();
    });

    it.each([
        {
            name: "distant operation",
            current: { startYear: 1900, endYear: 1912 },
            prior: { startYear: 1903, endYear: 1915 },
            currentPrimaryYear: 1906,
            operationEvidence: {
                bestYear: 1800,
                bestDifferenceGain: -0.1,
                sideStepBestYear: 1850,
            },
            metrics: {
                learnedWindowMargin: 0,
                learnedWindowRemoteMargin: 0,
            },
            evidence: "missing_distant_operation_reversion",
        },
        {
            name: "inverted anchors",
            current: { startYear: 1910, endYear: 1922 },
            prior: { startYear: 1904, endYear: 1916 },
            currentPrimaryYear: 1918,
            operationEvidence: {
                bestYear: 1919,
                bestDifferenceGain: 0.5,
                sideStepBestYear: 1920,
                sideStepRemoteMargin: 0.25,
            },
            metrics: {
                learnedWindowMargin: -1,
                learnedWindowRemoteMargin: 0,
            },
            evidence: "missing_inverted_anchor_reversion",
        },
    ])("restores a prior missing-ring mode for $name evidence", (testCase) => {
        expect(selectMissingRingFinalEvidenceModeRecovery(
            rankerInput("missingRing", [], {
                currentPrimaryYear: testCase.currentPrimaryYear,
                operationEvidence: testCase.operationEvidence,
            }),
            testCase.current,
            "missing_evidence_profile_mode",
            testCase.prior,
            testCase.metrics,
        )).toMatchObject({
            window: testCase.prior,
            rule: "missing_operation_evidence_reversion",
            evidence: testCase.evidence,
        });
    });

    it.each([
        {
            name: "concentrated prior",
            sourceRule: "false_evidence_profile_mode" as const,
            current: { startYear: 1900, endYear: 1912 },
            prior: { startYear: 1902, endYear: 1914 },
            currentPrimaryYear: 1906,
            operationEvidence: {
                bestYear: 1907,
                bestDifferenceGain: 0.48,
                sideStepBestYear: 1908,
            },
            metrics: {
                learnedWindowMargin: -0.5,
                learnedWindowRemoteMargin: 8,
            },
            expected: { startYear: 1902, endYear: 1914 },
            evidence: "false_concentrated_prior_reversion",
        },
        {
            name: "current-prior split",
            sourceRule: "false_evidence_profile_mode" as const,
            current: { startYear: 1917, endYear: 1929 },
            prior: { startYear: 1906, endYear: 1918 },
            currentPrimaryYear: 1910,
            operationEvidence: {
                bestYear: 1932,
                bestDifferenceGain: 0.47,
                sideStepBestYear: 1930,
            },
            metrics: {
                learnedWindowMargin: -0.4,
                learnedWindowRemoteMargin: -0.4,
            },
            expected: { startYear: 1906, endYear: 1918 },
            evidence: "false_current_prior_reversion",
        },
        {
            name: "strong shared anchors",
            sourceRule: "false_evidence_profile_mode" as const,
            current: { startYear: 1900, endYear: 1912 },
            prior: { startYear: 1895, endYear: 1907 },
            currentPrimaryYear: 1905,
            operationEvidence: {
                bestYear: 1906,
                bestDifferenceGain: 0.8,
                sideStepBestYear: 1907,
                sideStepRemoteMargin: 0.3,
            },
            metrics: {
                learnedWindowMargin: -0.1,
                learnedWindowRemoteMargin: 0.6,
            },
            expected: { startYear: 1895, endYear: 1907 },
            evidence: "false_strong_anchor_prior_reversion",
        },
        {
            name: "counterfactual older side",
            sourceRule: "false_counterfactual_mass" as const,
            current: { startYear: 1910, endYear: 1922 },
            currentPrimaryYear: 1913,
            operationEvidence: {
                bestYear: 1921,
                bestDifferenceGain: 0.33,
                sideStepBestYear: 1891,
            },
            expected: { startYear: 1885, endYear: 1897 },
            evidence: "false_counterfactual_side_anchor",
        },
        {
            name: "distant operation",
            sourceRule: "false_mode_side_corrector" as const,
            current: { startYear: 1900, endYear: 1912 },
            currentPrimaryYear: 1904,
            operationEvidence: {
                bestYear: 1922,
                bestDifferenceGain: 0.6,
                remoteDifferenceMargin: 0.001,
                sideStepBestYear: 1905,
            },
            expected: { startYear: 1916, endYear: 1928 },
            evidence: "false_distant_operation_anchor",
        },
        {
            name: "bounded older side",
            sourceRule: "false_point_mode" as const,
            current: { startYear: 1900, endYear: 1912 },
            currentPrimaryYear: 1908,
            operationEvidence: {
                bestYear: 1906,
                bestDifferenceGain: 0.15,
                sideStepBestYear: 1885,
                sideStepRemoteMargin: 0.005,
            },
            expected: { startYear: 1880, endYear: 1892 },
            evidence: "false_bounded_older_side_anchor",
        },
    ])("recovers a final false-ring mode from $name evidence", (testCase) => {
        expect(selectFalseRingFinalEvidenceModeRecovery(
            rankerInput("falseRing", [], {
                currentPrimaryYear: testCase.currentPrimaryYear,
                operationEvidence: testCase.operationEvidence,
            }),
            testCase.current,
            testCase.sourceRule,
            testCase.prior,
            testCase.metrics,
        )).toMatchObject({
            window: testCase.expected,
            evidence: testCase.evidence,
        });
    });

    it("re-centers a failed side correction on strict reference-median evidence", () => {
        expect(selectFalseRingFinalEvidenceModeRecovery(
            rankerInput("falseRing", [], {
                falseCounterfactualRows: falseCounterfactualRows(1918),
            }),
            { startYear: 1900, endYear: 1912 },
            "false_mode_side_corrector",
        )).toEqual({
            window: { startYear: 1918, endYear: 1930 },
            rule: "false_reference_median_mode",
            evidence: "false_reference_median_recenter",
        });
    });

    it("keeps a side-corrected mode when reference-median evidence is tied", () => {
        expect(selectFalseRingFinalEvidenceModeRecovery(
            rankerInput("falseRing", [], {
                falseCounterfactualRows: falseCounterfactualRows(1900),
            }),
            { startYear: 1900, endYear: 1912 },
            "false_mode_side_corrector",
        )).toBeNull();
    });

    it("uses a side step immediately beyond a false-ring physical coarse mode", () => {
        expect(selectFalseRingFinalEvidenceModeRecovery(
            rankerInput("falseRing", [], {
                coarseWindow: { startYear: 1880, endYear: 1920 },
                operationEvidence: {
                    bestYear: 1888,
                    bestDifferenceGain: 0.6,
                    sideStepBestYear: 1922,
                    bestSideStepScore: 0.6,
                    bestCorrectedSideSupport: 0.4,
                },
            }),
            { startYear: 1885, endYear: 1897 },
            "false_physical_profile_mode",
        )?.evidence).toBe("false_physical_boundary_side");
    });

    it("uses a sharp remote side step after a clipped false-ring point mode", () => {
        expect(selectFalseRingFinalEvidenceModeRecovery(
            rankerInput("falseRing", [], {
                coarseWindow: { startYear: 1880, endYear: 1920 },
                operationEvidence: {
                    bestYear: 1888,
                    bestDifferenceGain: 0.7,
                    sideStepBestYear: 1927,
                    bestSideStepScore: 0.65,
                    bestCorrectedSideSupport: 0.5,
                    sideStepRemoteMargin: 0.01,
                },
            }),
            { startYear: 1885, endYear: 1897 },
            "false_point_mode",
        )).toMatchObject({
            window: { startYear: 1921, endYear: 1933 },
            evidence: "false_point_remote_side",
        });
    });

    it("prefers an older side step when operation evidence is weak", () => {
        expect(selectFalseRingFinalEvidenceModeRecovery(
            rankerInput("falseRing", [], {
                coarseWindow: { startYear: 1880, endYear: 1940 },
                operationEvidence: {
                    bestYear: 1920,
                    bestDifferenceGain: 0.2,
                    sideStepBestYear: 1905,
                    bestSideStepScore: 0.35,
                    bestCorrectedSideSupport: 0.35,
                    sideStepRemoteMargin: 0.02,
                },
            }),
            { startYear: 1916, endYear: 1928 },
            "false_evidence_profile_mode",
        )).toMatchObject({
            window: { startYear: 1899, endYear: 1911 },
            evidence: "false_weak_operation_side",
        });
    });

    it("combines paired remote reference peaks after a false side-step mode", () => {
        expect(selectFalseRingFinalEvidenceModeRecovery(
            rankerInput("falseRing", [], {
                internalCandidates: [
                    {
                        startYear: 1880,
                        endYear: 1904,
                        source: "reference_transition:peakKernel9",
                    },
                    {
                        startYear: 1881,
                        endYear: 1905,
                        source: "reference_transition:peakKernel13",
                    },
                ],
            }),
            { startYear: 1910, endYear: 1922 },
            "false_side_step_mode",
        )).toMatchObject({
            window: { startYear: 1887, endYear: 1899 },
            evidence: "false_paired_reference_peak",
        });
    });

    it("extends a clipped false-ring point mode beyond the coarse older edge", () => {
        expect(selectFalseRingFinalEvidenceModeRecovery(
            rankerInput("falseRing", [], {
                coarseWindow: { startYear: 1900, endYear: 1940 },
                internalCandidates: [
                    { startYear: 1890, endYear: 1914, source: "lag_transition" },
                    { startYear: 1897, endYear: 1921, source: "current_event" },
                    { startYear: 1900, endYear: 1924, source: "profile:differenceFull" },
                ],
            }),
            { startYear: 1900, endYear: 1912 },
            "false_point_mode",
        )).toEqual({
            window: { startYear: 1897, endYear: 1909 },
            rule: "false_evidence_profile_mode",
            evidence: "false_coarse_older_clipping",
        });
    });

    it("restores only calibrated boundary and strong point modes to 13 years", () => {
        expect(shouldRestoreUnitEventModeWidth({
            eventType: "missingRing",
            recommendedWidth: 9,
            sourceRule: "missing_boundary_anchor_recenter",
        })).toBe(true);
        expect(shouldRestoreUnitEventModeWidth({
            eventType: "missingRing",
            recommendedWidth: 9,
            sourceRule: "mode_mass",
            modeWindow: { startYear: 1900, endYear: 1912 },
            finalWindow: { startYear: 1902, endYear: 1910 },
            operationEvidence: {
                bestYear: 1905,
                bestDifferenceGain: 0.5,
                remoteDifferenceMargin: 0.05,
                sideStepBestYear: 1911,
                sideStepRemoteMargin: 0.2,
            },
        })).toBe(true);
        expect(shouldRestoreUnitEventModeWidth({
            eventType: "falseRing",
            recommendedWidth: 9,
            sourceRule: "false_point_narrow_mode",
            operationEvidence: {
                bestYear: 1900,
                remoteDifferenceMargin: 0.065,
                sideStepRemoteMargin: 0.16,
            },
        })).toBe(true);
        expect(shouldRestoreUnitEventModeWidth({
            eventType: "falseRing",
            recommendedWidth: 9,
            sourceRule: "false_point_narrow_mode",
            operationEvidence: {
                bestYear: 1900,
                remoteDifferenceMargin: 0.064,
                sideStepRemoteMargin: 0.16,
            },
        })).toBe(false);
    });
});

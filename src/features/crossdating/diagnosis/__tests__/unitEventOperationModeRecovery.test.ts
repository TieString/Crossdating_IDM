import { describe, expect, it } from "vitest";
import {
    selectFalseRingOperationModeRecovery,
    selectMissingRingCurrentAnchorRecovery,
    selectUnitEventEvidenceModeArbitration,
    shouldRejectMissingFamilyRemoteMode,
} from "../unitEventOperationModeRecovery";
import type {
    UnitEventWindowRankerInput,
    UnitEventWindowRankerResult,
} from "../unitEventWindowRanker";

const years = Array.from({ length: 81 }, (_, index) => 1870 + index);

const rankerInput = (
    eventType: UnitEventWindowRankerInput["eventType"],
    overrides: Partial<UnitEventWindowRankerInput> = {},
): UnitEventWindowRankerInput => ({
    eventType,
    years,
    ranks: new Map(),
    internalCandidates: [],
    coarseWindow: { startYear: 1870, endYear: 1950 },
    ...overrides,
});

describe("unit event operation-mode recovery", () => {
    it("rejects a missing-ring family jump only when anchors prefer the current mode", () => {
        const current = { startYear: 1900, endYear: 1912 };
        const remote = { startYear: 1880, endYear: 1892 };
        expect(shouldRejectMissingFamilyRemoteMode(rankerInput("missingRing", {
            currentPrimaryYear: 1906,
            operationEvidence: {
                bestYear: 1907,
                sideStepBestYear: 1886,
            },
        }), current, remote)).toBe(true);

        expect(shouldRejectMissingFamilyRemoteMode(rankerInput("missingRing", {
            currentPrimaryYear: 1906,
            operationEvidence: { bestYear: 1886 },
        }), current, remote)).toBe(false);
    });

    it("recovers a missing-ring mode only from compact two-anchor agreement", () => {
        const current = { startYear: 1900, endYear: 1912 };
        expect(selectMissingRingCurrentAnchorRecovery(rankerInput("missingRing", {
            currentPrimaryYear: 1914,
            operationEvidence: {
                bestYear: 1915,
                sideStepBestYear: 1904,
            },
        }), current)).toEqual({ startYear: 1908, endYear: 1920 });

        expect(selectMissingRingCurrentAnchorRecovery(rankerInput("missingRing", {
            currentPrimaryYear: 1912,
            operationEvidence: {
                bestYear: 1913,
                sideStepBestYear: 1904,
            },
        }), current)).toBeNull();

        expect(selectMissingRingCurrentAnchorRecovery(rankerInput("missingRing", {
            currentPrimaryYear: 1914,
            operationEvidence: {
                bestYear: 1917,
                sideStepBestYear: 1904,
            },
        }), current)).toBeNull();
    });

    it.each<{
        sourceRule: UnitEventWindowRankerResult["windowCenteringRule"];
        bestYear: number;
        operationEvidence: NonNullable<UnitEventWindowRankerInput["operationEvidence"]>;
        expectedStart: number;
    }>([
        {
            sourceRule: "false_current_remote_mode",
            bestYear: 1894,
            operationEvidence: { bestYear: 1894, bestDifferenceGain: 0.2 },
            expectedStart: 1888,
        },
        {
            sourceRule: "false_current_anchor_consensus",
            bestYear: 1907,
            operationEvidence: {
                bestYear: 1907,
                sideStepBestYear: 1908,
                remoteDifferenceMargin: 0.01,
            },
            expectedStart: 1901,
        },
        {
            sourceRule: "false_counterfactual_mass",
            bestYear: 1913,
            operationEvidence: {
                bestYear: 1913,
                sideStepBestYear: 1914,
                bestDifferenceGain: 0.15,
            },
            expectedStart: 1907,
        },
        {
            sourceRule: "false_family_mode_consensus",
            bestYear: 1913,
            operationEvidence: {
                bestYear: 1913,
                sideStepBestYear: 1914,
                remoteDifferenceMargin: 0.005,
            },
            expectedStart: 1907,
        },
        {
            sourceRule: "false_point_mode",
            bestYear: 1909,
            operationEvidence: {
                bestYear: 1909,
                sideStepBestYear: 1910,
                bestDifferenceGain: 0.3,
                remoteDifferenceMargin: 0.1,
            },
            expectedStart: 1903,
        },
    ])("recovers $sourceRule only at its calibrated gate", ({
        sourceRule,
        bestYear,
        operationEvidence,
        expectedStart,
    }) => {
        const result = selectFalseRingOperationModeRecovery(
            rankerInput("falseRing", {
                currentPrimaryYear: bestYear,
                operationEvidence,
            }),
            { startYear: 1900, endYear: 1912 },
            sourceRule,
        );
        expect(result?.window).toEqual({
            startYear: expectedStart,
            endYear: expectedStart + 12,
        });
    });

    it("keeps a false-ring mode when operation evidence misses a gate", () => {
        expect(selectFalseRingOperationModeRecovery(
            rankerInput("falseRing", {
                currentPrimaryYear: 1894,
                operationEvidence: {
                    bestYear: 1894,
                    bestDifferenceGain: 0.199,
                },
            }),
            { startYear: 1900, endYear: 1912 },
            "false_current_remote_mode",
        )).toBeNull();

        expect(selectFalseRingOperationModeRecovery(
            rankerInput("falseRing", {
                currentPrimaryYear: 1909,
                operationEvidence: {
                    bestYear: 1909,
                    bestDifferenceGain: 0.3,
                    remoteDifferenceMargin: 0.099,
                },
            }),
            { startYear: 1900, endYear: 1912 },
            "false_point_mode",
        )).toBeNull();
    });

    it("reverts missing-ring modes contradicted by boundary or side evidence", () => {
        const prePoint = { startYear: 1900, endYear: 1912 };
        expect(selectUnitEventEvidenceModeArbitration(
            rankerInput("missingRing", {
                operationEvidence: {
                    bestYear: 1900,
                    bestDifferenceGain: 0.6,
                    remoteDifferenceMargin: 0.08,
                },
            }),
            { startYear: 1904, endYear: 1916 },
            prePoint,
            "missing_boundary_feature_recenter",
        )).toEqual({
            window: prePoint,
            rule: "missing_boundary_operation_reversion",
        });

        expect(selectUnitEventEvidenceModeArbitration(
            rankerInput("missingRing", {
                operationEvidence: {
                    bestYear: 1910,
                    sideStepBestYear: 1899,
                },
            }),
            { startYear: 1903, endYear: 1915 },
            prePoint,
            "missing_family_remote_mode",
        )).toEqual({
            window: prePoint,
            rule: "missing_remote_side_reversion",
        });
    });

    it("reverts false-ring point, operation, and family modes on consensus", () => {
        const prePoint = { startYear: 1910, endYear: 1922 };
        expect(selectUnitEventEvidenceModeArbitration(
            rankerInput("falseRing", {
                operationEvidence: {
                    bestYear: 1904,
                    bestDifferenceGain: 0.6,
                    sideStepRemoteMargin: 0.2,
                },
            }),
            { startYear: 1900, endYear: 1912 },
            prePoint,
            "false_point_mode",
        )?.rule).toBe("false_point_evidence_reversion");

        expect(selectUnitEventEvidenceModeArbitration(
            rankerInput("falseRing", {
                currentPrimaryYear: 1916,
                operationEvidence: {
                    bestYear: 1905,
                    sideStepBestYear: 1917,
                },
            }),
            { startYear: 1900, endYear: 1912 },
            prePoint,
            "false_operation_mode_recovery",
        )?.rule).toBe("false_operation_evidence_reversion");

        expect(selectUnitEventEvidenceModeArbitration(
            rankerInput("falseRing", {
                currentPrimaryYear: 1914,
                operationEvidence: {
                    bestYear: 1915,
                    sideStepBestYear: 1916,
                },
            }),
            { startYear: 1900, endYear: 1912 },
            prePoint,
            "false_family_remote_mode",
        )?.rule).toBe("false_family_anchor_reversion");
    });

    it("reverts a newer point-narrow mode only under strong edit evidence", () => {
        const prePoint = { startYear: 1900, endYear: 1912 };
        const strongEvidence = {
            bestYear: 1908,
            sideStepBestYear: 1913,
            bestDifferenceGain: 0.5,
            remoteDifferenceMargin: 0.065,
            sideStepRemoteMargin: 0.2,
        };
        expect(selectUnitEventEvidenceModeArbitration(
            rankerInput("falseRing", { operationEvidence: strongEvidence }),
            { startYear: 1902, endYear: 1914 },
            prePoint,
            "false_point_narrow_mode",
        )).toEqual({
            window: prePoint,
            rule: "false_point_evidence_reversion",
        });

        expect(selectUnitEventEvidenceModeArbitration(
            rankerInput("falseRing", {
                operationEvidence: {
                    ...strongEvidence,
                    sideStepRemoteMargin: 0.199,
                },
            }),
            { startYear: 1902, endYear: 1914 },
            prePoint,
            "false_point_narrow_mode",
        )).toBeNull();

        expect(selectUnitEventEvidenceModeArbitration(
            rankerInput("falseRing", { operationEvidence: strongEvidence }),
            prePoint,
            prePoint,
            "false_point_narrow_mode",
        )).toBeNull();
    });

    it("accepts a two-year false-ring anchor pair only with strong evidence", () => {
        const prePoint = { startYear: 1913, endYear: 1925 };
        expect(selectUnitEventEvidenceModeArbitration(
            rankerInput("falseRing", {
                currentPrimaryYear: 1920,
                operationEvidence: {
                    bestYear: 1904,
                    bestDifferenceGain: 0.6,
                    sideStepBestYear: 1922,
                    sideStepRemoteMargin: 0.1,
                },
            }),
            { startYear: 1900, endYear: 1912 },
            prePoint,
            "false_operation_mode_recovery",
        )?.rule).toBe("false_operation_evidence_reversion");

        expect(selectUnitEventEvidenceModeArbitration(
            rankerInput("falseRing", {
                currentPrimaryYear: 1920,
                operationEvidence: {
                    bestYear: 1904,
                    bestDifferenceGain: 0.6,
                    sideStepBestYear: 1922,
                    sideStepRemoteMargin: 0.099,
                },
            }),
            { startYear: 1900, endYear: 1912 },
            prePoint,
            "false_operation_mode_recovery",
        )).toBeNull();
    });

    it("uses strong difference-profile mass as a bounded false-ring correction", () => {
        const differenceRanks = years.map((year) => (
            year >= 1896 && year <= 1908 ? 1 : 0
        ));
        const result = selectUnitEventEvidenceModeArbitration(
            rankerInput("falseRing", {
                ranks: new Map([["differenceFull", differenceRanks]]),
                operationEvidence: {
                    bestYear: 1904,
                    bestDifferenceGain: 0.6,
                    remoteDifferenceMargin: 0.05,
                    sideStepRemoteMargin: 0.2,
                },
            }),
            { startYear: 1900, endYear: 1912 },
            { startYear: 1899, endYear: 1911 },
            "false_counterfactual_mass",
        );
        expect(result).toEqual({
            window: { startYear: 1896, endYear: 1908 },
            rule: "false_difference_profile_mode",
        });

        expect(selectUnitEventEvidenceModeArbitration(
            rankerInput("falseRing", {
                ranks: new Map([["differenceFull", differenceRanks]]),
                operationEvidence: {
                    bestYear: 1904,
                    bestDifferenceGain: 0.6,
                    remoteDifferenceMargin: 0.05,
                    sideStepRemoteMargin: 0.199,
                },
            }),
            { startYear: 1900, endYear: 1912 },
            { startYear: 1899, endYear: 1911 },
            "false_counterfactual_mass",
        )).toBeNull();
    });
});

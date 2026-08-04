import { describe, expect, it } from "vitest";
import {
    rankUnitEventWindows,
    refineMissingRingWindow,
    isFalseRingNineYearSafetyAccepted,
    selectFalseRingCurrentAnchorMode,
    selectMissingRingDirectAnchorMode,
    selectMissingRingSideStepMode,
    selectFalseRingSideStepMode,
    selectRemoteCurrentPrimaryMode,
    selectFalseRingTransitionNarrowWindow,
    shouldRejectNarrowForRemoteSideEvidence,
    isMissingRingAnchorConsensusUncertain,
    shouldNarrowSurvivingMissingPredictiveMode,
    shouldUseCorroboratedPointPeak,
    shouldWidenMissingRingFiveYear,
} from "../unitEventWindowRanker";

const years = Array.from({ length: 41 }, (_, index) => 1900 + index);

describe("unit event window ranker", () => {
    it("requires calibrated 0.90 safety before narrowing a false-ring mode", () => {
        expect(isFalseRingNineYearSafetyAccepted(0.899, 0.75)).toBe(false);
        expect(isFalseRingNineYearSafetyAccepted(0.90, 0.75)).toBe(true);
        expect(isFalseRingNineYearSafetyAccepted(0.94, 0.95)).toBe(false);
    });

    it("uses calibrated missing-ring width only for concentrated evidence", () => {
        expect(refineMissingRingWindow({
            recommendedWidth: 13,
            centerYear: 1906,
            modeCenterYear: 1906,
            nineYearSafety: 0.95,
        })).toEqual({
            recommendedWidth: 9,
            centerYear: 1906,
            rule: "high_confidence_narrow",
        });
        expect(refineMissingRingWindow({
            recommendedWidth: 13,
            centerYear: 1906,
            modeCenterYear: 1906,
            nineYearSafety: 0.93,
        }).recommendedWidth).toBe(13);
    });

    it("widens a missing-ring mode when aligned anchors leave newer-side evidence", () => {
        expect(refineMissingRingWindow({
            recommendedWidth: 9,
            centerYear: 1906,
            modeCenterYear: 1906,
            nineYearSafety: 0.8,
            currentPrimaryYear: 1906,
            operationEvidence: {
                bestYear: 1906,
                sideStepBestYear: 1909,
            },
        })).toEqual({
            recommendedWidth: 13,
            centerYear: 1906,
            rule: "anchor_wide",
        });
    });

    it("moves a missing-ring wide window toward a corroborated open coarse flank", () => {
        expect(refineMissingRingWindow({
            recommendedWidth: 9,
            centerYear: 1906,
            modeCenterYear: 1906,
            nineYearSafety: 0.8,
            coarseWindow: { startYear: 1900, endYear: 1924 },
            operationEvidence: {
                bestYear: 1906,
                sideStepBestYear: 1926,
            },
        })).toEqual({
            recommendedWidth: 13,
            centerYear: 1908,
            rule: "open_flank_wide",
        });
    });

    it("uses the coarse center when operation and mode evidence conflict", () => {
        expect(refineMissingRingWindow({
            recommendedWidth: 9,
            centerYear: 1906,
            modeCenterYear: 1906,
            nineYearSafety: 0.8,
            coarseWindow: { startYear: 1897, endYear: 1921 },
            operationEvidence: { bestYear: 1903 },
        })).toEqual({
            recommendedWidth: 13,
            centerYear: 1909,
            rule: "coarse_operation_conflict",
        });
    });

    it.each(["missingRing", "falseRing"] as const)(
        "returns one calibrated 9/13-year window for %s",
        (eventType) => {
            const result = rankUnitEventWindows({
                eventType,
                years,
                ranks: new Map(),
                internalCandidates: [],
            });

            expect(result).not.toBeNull();
            expect(result!.modeWindow.endYear - result!.modeWindow.startYear + 1)
                .toBe(13);
            expect([9, 13]).toContain(result!.recommendedWidth);
            expect(result!.window.endYear - result!.window.startYear + 1)
                .toBe(result!.recommendedWidth);
            const centerDelta = Math.abs(
                (result!.window.startYear + result!.window.endYear)
                - (result!.modeWindow.startYear + result!.modeWindow.endYear),
            ) / 2;
            expect(centerDelta).toBeLessThanOrEqual(
                eventType === "falseRing" ? 1 : 0,
            );
            expect(result!.nineYearSafety).toBeGreaterThanOrEqual(0);
            expect(result!.nineYearSafety).toBeLessThanOrEqual(1);
            expect(result!.scoredWindows.length).toBeGreaterThan(0);
            expect(result!.scoredWindows.length).toBeLessThanOrEqual(
                years.length - 13 + 1,
            );
        },
    );

    it("does not score a sequence shorter than the calibrated mode width", () => {
        expect(rankUnitEventWindows({
            eventType: "missingRing",
            years: years.slice(0, 12),
            ranks: new Map(),
            internalCandidates: [],
        })).toBeNull();
    });

    it("widens a narrow window when the point peak and local operation agree", () => {
        expect(shouldUseCorroboratedPointPeak({
            recommendedWidth: 9,
            centerYear: 1856,
            peakYear: 1854,
            sideStepBestYear: 1854,
        })).toBe(true);
        expect(shouldUseCorroboratedPointPeak({
            recommendedWidth: 9,
            centerYear: 1856,
            peakYear: 1854,
            sideStepBestYear: 1858,
        })).toBe(false);
        expect(shouldUseCorroboratedPointPeak({
            recommendedWidth: 13,
            centerYear: 1856,
            peakYear: 1854,
            sideStepBestYear: 1854,
        })).toBe(false);
    });

    it("rejects narrowing when side-step evidence is remote from the mode", () => {
        expect(shouldRejectNarrowForRemoteSideEvidence({
            recommendedWidth: 9,
            centerYear: 1905,
            sideStepBestYear: 1968,
            coarseWindow: { startYear: 1897, endYear: 1921 },
        })).toBe(true);
        expect(shouldRejectNarrowForRemoteSideEvidence({
            recommendedWidth: 9,
            centerYear: 1905,
            sideStepBestYear: 1940,
            coarseWindow: { startYear: 1897, endYear: 1921 },
        })).toBe(false);
        expect(shouldRejectNarrowForRemoteSideEvidence({
            recommendedWidth: 13,
            centerYear: 1905,
            sideStepBestYear: 1968,
            coarseWindow: { startYear: 1897, endYear: 1921 },
        })).toBe(false);
    });

    it("uses a remote in-coarse current candidate as one competing mode", () => {
        expect(selectRemoteCurrentPrimaryMode({
            years,
            modeWindow: { startYear: 1900, endYear: 1912 },
            coarseWindow: { startYear: 1900, endYear: 1935 },
            currentPrimaryYear: 1925,
        })).toEqual({ startYear: 1919, endYear: 1931 });
        expect(selectRemoteCurrentPrimaryMode({
            years,
            modeWindow: { startYear: 1900, endYear: 1912 },
            coarseWindow: { startYear: 1900, endYear: 1935 },
            currentPrimaryYear: 1921,
        })).toEqual({ startYear: 1915, endYear: 1927 });
        expect(selectRemoteCurrentPrimaryMode({
            years,
            modeWindow: { startYear: 1900, endYear: 1912 },
            coarseWindow: { startYear: 1900, endYear: 1935 },
            currentPrimaryYear: 1913,
        })).toEqual({ startYear: 1907, endYear: 1919 });
        expect(selectRemoteCurrentPrimaryMode({
            years,
            modeWindow: { startYear: 1900, endYear: 1912 },
            coarseWindow: { startYear: 1900, endYear: 1920 },
            currentPrimaryYear: 1925,
        })).toBeNull();
        expect(selectRemoteCurrentPrimaryMode({
            years,
            modeWindow: { startYear: 1912, endYear: 1924 },
            coarseWindow: { startYear: 1900, endYear: 1935 },
            currentPrimaryYear: 1908,
        })).toBeNull();
    });

    it("restores a pre-point false-ring mode only when it better fits the current anchor", () => {
        expect(selectFalseRingCurrentAnchorMode({
            pointModeWindow: { startYear: 1638, endYear: 1650 },
            prePointModeWindow: { startYear: 1632, endYear: 1644 },
            currentPrimaryYear: 1638,
        })).toEqual({ startYear: 1632, endYear: 1644 });
        expect(selectFalseRingCurrentAnchorMode({
            pointModeWindow: { startYear: 1782, endYear: 1794 },
            prePointModeWindow: { startYear: 1789, endYear: 1801 },
            currentPrimaryYear: 1785,
        })).toBeNull();
        expect(selectFalseRingCurrentAnchorMode({
            pointModeWindow: { startYear: 1900, endYear: 1912 },
            prePointModeWindow: { startYear: 1899, endYear: 1911 },
            currentPrimaryYear: 1904,
        })).toBeNull();
        expect(selectFalseRingCurrentAnchorMode({
            pointModeWindow: { startYear: 1900, endYear: 1912 },
            prePointModeWindow: { startYear: 1907, endYear: 1919 },
            currentPrimaryYear: 1913,
        })).toBeNull();
    });

    it("keeps the pre-direct missing-ring mode when independent anchors agree", () => {
        const preDirectModeWindow = { startYear: 1900, endYear: 1912 };
        expect(selectMissingRingDirectAnchorMode({
            directModeWindow: { startYear: 1898, endYear: 1910 },
            preDirectModeWindow,
            currentPrimaryYear: 1908,
            operationEvidence: {
                bestYear: 1909,
                sideStepBestYear: 1899,
            },
        })).toEqual(preDirectModeWindow);
        expect(selectMissingRingDirectAnchorMode({
            directModeWindow: { startYear: 1898, endYear: 1910 },
            preDirectModeWindow,
            currentPrimaryYear: 1904,
            operationEvidence: {
                bestYear: 1905,
                sideStepBestYear: 1909,
            },
        })).toBeNull();
    });

    it("keeps strong side-step evidence just outside the pre-direct window", () => {
        const preDirectModeWindow = { startYear: 1900, endYear: 1912 };
        expect(selectMissingRingDirectAnchorMode({
            directModeWindow: { startYear: 1896, endYear: 1908 },
            preDirectModeWindow,
            operationEvidence: {
                bestYear: 1904,
                sideStepBestYear: 1914,
                sideStepRemoteMargin: 0.20,
            },
        })).toEqual(preDirectModeWindow);
        expect(selectMissingRingDirectAnchorMode({
            directModeWindow: { startYear: 1896, endYear: 1908 },
            preDirectModeWindow,
            operationEvidence: {
                bestYear: 1904,
                sideStepBestYear: 1914,
                sideStepRemoteMargin: 0.19,
            },
        })).toBeNull();
    });

    it("rejects a weak newer direct displacement", () => {
        const preDirectModeWindow = { startYear: 1900, endYear: 1912 };
        expect(selectMissingRingDirectAnchorMode({
            directModeWindow: { startYear: 1901, endYear: 1913 },
            preDirectModeWindow,
            operationEvidence: {
                bestYear: 1908,
                sideStepBestYear: 1915,
                sideStepRemoteMargin: 0.019,
            },
        })).toEqual(preDirectModeWindow);
    });

    it("widens a five-year missing-ring window when anchors sit at its edge", () => {
        expect(shouldWidenMissingRingFiveYear({
            recommendedWidth: 5,
            centerYear: 1904,
            currentPrimaryYear: 1902,
            operationEvidence: {
                bestYear: 1903,
                sideStepBestYear: 1902,
            },
        })).toBe(true);
        expect(shouldWidenMissingRingFiveYear({
            recommendedWidth: 5,
            centerYear: 1904,
            currentPrimaryYear: 1904,
            operationEvidence: {
                bestYear: 1903,
                sideStepBestYear: 1904,
            },
        })).toBe(false);
    });

    it("keeps the empirically under-covered anchor-consensus subgroup wide", () => {
        expect(isMissingRingAnchorConsensusUncertain({
            recommendedWidth: 13,
            modeWindow: { startYear: 1900, endYear: 1912 },
            currentPrimaryYear: 1906,
            operationEvidence: {
                bestYear: 1907,
                sideStepBestYear: 1904,
                bestDifferenceGain: 0.3,
                remoteDifferenceMargin: 0.05,
                sideStepRemoteMargin: 0.1,
            },
        })).toBe(true);
        expect(isMissingRingAnchorConsensusUncertain({
            recommendedWidth: 13,
            modeWindow: { startYear: 1900, endYear: 1912 },
            currentPrimaryYear: 1906,
            operationEvidence: {
                bestYear: 1907,
                sideStepBestYear: 1911,
                bestDifferenceGain: 0.3,
                remoteDifferenceMargin: 0.05,
                sideStepRemoteMargin: 0.1,
            },
        })).toBe(false);
    });

    it("moves a missing-ring mode one year toward strong side evidence", () => {
        expect(selectMissingRingSideStepMode({
            years,
            modeWindow: { startYear: 1910, endYear: 1922 },
            operationEvidence: {
                bestYear: 1916,
                sideStepBestYear: 1907,
                sideStepRemoteMargin: 0.15,
            },
        })).toEqual({ startYear: 1909, endYear: 1921 });
        expect(selectMissingRingSideStepMode({
            years,
            modeWindow: { startYear: 1910, endYear: 1922 },
            operationEvidence: {
                bestYear: 1916,
                sideStepBestYear: 1907,
                sideStepRemoteMargin: 0.149,
            },
        })).toBeNull();
    });

    it("moves a false-ring point mode only a bounded distance toward remote side evidence", () => {
        expect(selectFalseRingSideStepMode({
            years,
            modeWindow: { startYear: 1900, endYear: 1912 },
            operationEvidence: {
                bestYear: 1906,
                sideStepBestYear: 1930,
                sideStepRemoteMargin: 0.05,
            },
        })).toEqual({ startYear: 1903, endYear: 1915 });
        expect(selectFalseRingSideStepMode({
            years,
            modeWindow: { startYear: 1900, endYear: 1912 },
            operationEvidence: {
                bestYear: 1906,
                sideStepBestYear: 1930,
                sideStepRemoteMargin: 0.049,
            },
        })).toBeNull();
    });

    it("places a false-ring narrow window from transition mass", () => {
        const transitionRanks = years.map((year) => (
            year >= 1911 && year <= 1919 ? 1 : -10
        ));
        expect(selectFalseRingTransitionNarrowWindow({
            years,
            transitionRanks,
            modeWindow: { startYear: 1910, endYear: 1922 },
            currentPrimaryYear: 1915,
            operationBestYear: 1920,
            probability: 0.8,
            probabilityThreshold: 0.57,
        })).toEqual({ startYear: 1912, endYear: 1920 });
    });

    it("keeps a difficult offset-three false-ring mode wide", () => {
        const transitionRanks = years.map((year) => (
            year >= 1913 && year <= 1921 ? 1 : -10
        ));
        expect(selectFalseRingTransitionNarrowWindow({
            years,
            transitionRanks,
            modeWindow: { startYear: 1910, endYear: 1922 },
            currentPrimaryYear: 1920,
            probability: 0.8,
            probabilityThreshold: 0.57,
        })).toBeNull();
    });

    it("keeps an edge-aligned false-ring window wide when discarded evidence remains strong", () => {
        const transitionRanks = years.map((year) => (
            year >= 1914 && year <= 1922 ? 1 : -10
        ));
        const differenceRanks = years.map((year) => (
            year === 1912 ? 0.99 : year >= 1914 && year <= 1922 ? 1 : 0
        ));
        expect(selectFalseRingTransitionNarrowWindow({
            years,
            transitionRanks,
            differenceRanks,
            modeWindow: { startYear: 1910, endYear: 1922 },
            currentPrimaryYear: 1918,
            probability: 0.8,
            probabilityThreshold: 0.57,
        })).toBeNull();

        expect(selectFalseRingTransitionNarrowWindow({
            years,
            transitionRanks,
            differenceRanks: differenceRanks.map((value, index) => (
                years[index] < 1914 ? 0.5 : value
            )),
            modeWindow: { startYear: 1910, endYear: 1922 },
            currentPrimaryYear: 1918,
            probability: 0.8,
            probabilityThreshold: 0.57,
        })).toEqual({ startYear: 1914, endYear: 1922 });
    });

    it("keeps one calibrated window after missing-ring mode arbitration", () => {
        const result = rankUnitEventWindows({
            eventType: "missingRing",
            years,
            ranks: new Map(),
            internalCandidates: [],
            coarseWindow: { startYear: 1908, endYear: 1932 },
        });

        expect(result).not.toBeNull();
        expect(result!.modeWindow.endYear - result!.modeWindow.startYear + 1)
            .toBe(13);
        expect(result!.window.endYear - result!.window.startYear + 1)
            .toBe(result!.recommendedWidth);
        expect(result!.scoredWindows.length).toBeGreaterThan(0);
    });

    it("narrows only a predictive remote mode that survives recovery", () => {
        expect(shouldNarrowSurvivingMissingPredictiveMode({
            recommendedWidth: 13,
            windowCenteringRule: "missing_predictive_remote_mode",
            widthSelectionRule: "missing_predictive_remote_mode",
        })).toBe(true);
        expect(shouldNarrowSurvivingMissingPredictiveMode({
            recommendedWidth: 13,
            windowCenteringRule: "missing_operation_evidence_reversion",
            widthSelectionRule: "missing_operation_evidence_reversion",
        })).toBe(false);
        expect(shouldNarrowSurvivingMissingPredictiveMode({
            recommendedWidth: 13,
            windowCenteringRule: "missing_predictive_remote_mode",
            widthSelectionRule: "missing_anchor_consensus_uncertain_13",
        })).toBe(false);
    });

    it("centers one wide false-ring mode on corroborated current evidence", () => {
        const result = rankUnitEventWindows({
            eventType: "falseRing",
            years,
            ranks: new Map(),
            internalCandidates: [],
            currentPrimaryYear: 1914,
            corroboratedFalseRingModeCenterYear: 1915,
        });

        expect(result).not.toBeNull();
        expect(result!.window).toEqual({
            startYear: 1909,
            endYear: 1921,
        });
        expect(result!.recommendedWidth).toBe(13);
        expect(result!.windowCenteringRule)
            .toBe("false_current_candidate_consensus");
    });
});

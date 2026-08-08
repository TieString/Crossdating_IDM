import { describe, expect, it } from "vitest";
import {
    CALIBRATED_EVENT_WINDOW_WIDTHS,
    selectCalibratedEventWindow,
} from "../calibratedEventWindow";

const years = Array.from({ length: 41 }, (_, index) => 1900 + index);

const peak = (
    center: number,
    radius: number,
): number[] => years.map((year) => (
    Math.max(0, 1 - Math.abs(year - center) / Math.max(1, radius))
));

const ranks = (
    profiles: Record<string, number[]>,
): ReadonlyMap<string, readonly number[]> => new Map(Object.entries(profiles));

const coarseWindow = { startYear: 1905, endYear: 1933 };

const physicalPartialProfiles = (
    center: number,
): Record<string, number[]> => Object.fromEntries([
    "boundaryLocal:stepMinimum3",
    "boundaryLocal:stepMinimum5",
    "piecewiseCombinedObjective",
    "cumulativeCombined",
    "differenceFull",
    "whitenedFull",
    "rawFull",
    "cumulativeReferenceMedian",
    "reference:rankMean",
].map((profile) => [profile, peak(center, 5)]));

describe("selectCalibratedEventWindow", () => {
    it("keeps a concentrated missing-ring window inside one 13-year mode", () => {
        const result = selectCalibratedEventWindow({
            eventType: "missingRing",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1916, 6),
                differenceFull: peak(1916, 4),
                transitionSplitGain: peak(1917, 4),
                whitenedFull: peak(1916, 4),
            }),
            coarseWindow,
            internalCandidates: [
                { startYear: 1905, endYear: 1929, source: "a" },
                { startYear: 1906, endYear: 1930, source: "b" },
                { startYear: 1907, endYear: 1931, source: "c" },
            ],
            currentPrimaryYear: 1916,
            operationEvidence: {
                bestYear: 1917,
                remoteDifferenceMargin: 0.03,
            },
        });

        expect(result).not.toBeNull();
        expect(result?.width).toBe(9);
        expect(result?.calibrationRule).toBe(
            "missing_ring_cross_evidence_consensus_9",
        );
        expect(result!.window.startYear).toBeGreaterThanOrEqual(
            result!.modeWindow.startYear,
        );
        expect(result!.window.endYear).toBeLessThanOrEqual(
            result!.modeWindow.endYear,
        );
    });

    it("uses 13 years when missing-ring evidence is diffuse", () => {
        const result = selectCalibratedEventWindow({
            eventType: "missingRing",
            years,
            ranks: ranks({
                cumulativeCombined: years.map(() => 0.5),
            }),
            coarseWindow,
            internalCandidates: [],
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe("calibrated_default_13");
    });

    it("uses cross-profile consensus for a diffuse 13-year missing mode", () => {
        const result = selectCalibratedEventWindow({
            eventType: "missingRing",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1909, 4),
                differenceFull: peak(1924, 4),
                rawFull: peak(1924, 4),
                "reference:rankMedian": peak(1924, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1924,
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe(
            "missing_ring_diffuse_mode_consensus_13",
        );
        expect(result!.window.startYear).toBeLessThanOrEqual(1924);
        expect(result!.window.endYear).toBeGreaterThanOrEqual(1924);
    });

    it("keeps the original missing mode when diffuse evidence only nudges it", () => {
        const result = selectCalibratedEventWindow({
            eventType: "missingRing",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1916, 6),
                differenceFull: peak(1917, 6),
                rawFull: peak(1917, 6),
                "reference:rankMedian": peak(1917, 6),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1917,
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe("calibrated_default_13");
    });

    it("uses a strong side-step breakpoint when the missing-ring narrow window excludes it", () => {
        const result = selectCalibratedEventWindow({
            eventType: "missingRing",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1924, 5),
                differenceFull: peak(1924, 4),
                transitionSplitGain: peak(1924, 4),
                whitenedFull: peak(1924, 4),
                sideStepScore: peak(1914, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1924,
            operationEvidence: {
                bestYear: 1924,
                remoteDifferenceMargin: 0.1,
                sideStepBestYear: 1914,
                sideStepRemoteMargin: 0.08,
            },
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe(
            "missing_ring_side_step_disagreement_13",
        );
        expect(result?.profileNames).toEqual(["sideStepScore"]);
        expect(result!.window.startYear).toBeLessThanOrEqual(1914);
        expect(result!.window.endYear).toBeGreaterThanOrEqual(1914);
    });

    it("preserves a missing-ring narrow window when side-step separation is weak", () => {
        const result = selectCalibratedEventWindow({
            eventType: "missingRing",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1924, 5),
                differenceFull: peak(1924, 4),
                transitionSplitGain: peak(1924, 4),
                whitenedFull: peak(1924, 4),
                sideStepScore: peak(1914, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1924,
            operationEvidence: {
                bestYear: 1924,
                remoteDifferenceMargin: 0.1,
                sideStepBestYear: 1914,
                sideStepRemoteMargin: 0.039,
            },
        });

        expect(result?.width).toBeLessThan(13);
        expect(result?.calibrationRule).not.toBe(
            "missing_ring_side_step_disagreement_13",
        );
    });

    it("uses 5 years for a tightly concentrated missing-ring boundary", () => {
        const result = selectCalibratedEventWindow({
            eventType: "missingRing",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1920, 5),
                differenceFull: peak(1920, 4),
                transitionSplitGain: peak(1920, 4),
                whitenedFull: peak(1920, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
            operationEvidence: {
                bestYear: 1920,
                remoteDifferenceMargin: 0.1,
            },
        });

        expect(result?.width).toBe(5);
        expect(result?.calibrationRule).toBe(
            "missing_ring_concentrated_anchor_consensus_5",
        );
    });

    it("keeps 13 years when reference votes contradict a missing-ring five-year mode", () => {
        const result = selectCalibratedEventWindow({
            eventType: "missingRing",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1920, 5),
                cumulativeReferenceVote: peak(1927, 4),
                differenceFull: peak(1920, 4),
                transitionSplitGain: peak(1920, 4),
                whitenedFull: peak(1920, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
            operationEvidence: {
                bestYear: 1920,
                remoteDifferenceMargin: 0.1,
            },
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe("calibrated_default_13");
    });

    it("uses a sharp 13-year mode for low-margin missing-ring localization", () => {
        const result = selectCalibratedEventWindow({
            eventType: "missingRing",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1920, 6),
                differenceFull: peak(1920, 4),
                transitionSplitGain: peak(1920, 4),
                whitenedFull: peak(1920, 4),
                rawFull: peak(1916, 4),
                "reference:rankMedian": peak(1916, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
            operationEvidence: {
                bestYear: 1920,
                remoteDifferenceMargin: 0.015,
            },
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe(
            "missing_ring_low_operation_margin_difference_13",
        );
        expect(result?.profileNames).toEqual(["differenceFull"]);
    });

    it("uses a sharp 13-year mode when a missing-ring window excludes the operation year", () => {
        const result = selectCalibratedEventWindow({
            eventType: "missingRing",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1923, 6),
                differenceFull: peak(1923, 4),
                transitionSplitGain: peak(1923, 4),
                whitenedFull: peak(1923, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1922,
            operationEvidence: {
                bestYear: 1918,
                remoteDifferenceMargin: 0.03,
            },
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe(
            "missing_ring_low_operation_margin_difference_13",
        );
        expect(result?.profileNames).toEqual(["differenceFull"]);
    });

    it("uses 7 years for a strong but less decisive missing-ring boundary", () => {
        const result = selectCalibratedEventWindow({
            eventType: "missingRing",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1920, 5),
                differenceFull: peak(1920, 4),
                transitionSplitGain: peak(1921, 4),
                whitenedFull: peak(1920, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
            operationEvidence: {
                bestYear: 1921,
                remoteDifferenceMargin: 0.05,
            },
        });

        expect(result?.width).toBe(7);
        expect(result?.calibrationRule).toBe(
            "missing_ring_boundary_consensus_7",
        );
    });

    it("uses a 9-year partial window only when coarse candidates agree", () => {
        const longYears = Array.from(
            { length: 201 },
            (_, index) => 1850 + index,
        );
        const result = selectCalibratedEventWindow({
            eventType: "partialMove",
            years: longYears,
            ranks: ranks({
                differenceFull: longYears.map((year) => (
                    Math.max(0, 1 - Math.abs(year - 1920) / 8)
                )),
                whitenedFull: longYears.map((year) => (
                    Math.abs(year - 1920) <= 6 ? 1 : 0
                )),
                comboFull: longYears.map((year) => (
                    Math.abs(year - 1920) <= 6 ? 1 : 0
                )),
            }),
            coarseWindow,
            internalCandidates: [
                { startYear: 1908, endYear: 1932, source: "a" },
                { startYear: 1909, endYear: 1933, source: "b" },
                { startYear: 1907, endYear: 1931, source: "c" },
            ],
            currentPrimaryYear: 1920,
        });

        expect(result?.width).toBe(9);
        expect(result?.calibrationRule).toBe(
            "partial_physical_peak_score_9",
        );
    });

    it("keeps a low-margin partial move at 13 years around per-reference lag steps", () => {
        const result = selectCalibratedEventWindow({
            eventType: "partialMove",
            years,
            ranks: ranks({
                differenceFull: peak(1918, 8),
                whitenedFull: peak(1918, 6),
                comboFull: peak(1918, 6),
                pairFixedLagStepWeighted: peak(1924, 4),
                pairFixedLagStepMedian: peak(1923, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1918,
            operationEvidence: {
                bestYear: 1918,
                remoteDifferenceMargin: 0.008,
            },
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe("calibrated_default_13");
        expect(result!.window.startYear).toBeLessThanOrEqual(1924);
        expect(result!.window.endYear).toBeGreaterThanOrEqual(1924);
    });

    it("regularizes only a candidate-backed default partial mode with its accepted center", () => {
        const input = {
            eventType: "partialMove" as const,
            years,
            ranks: ranks({
                differenceFull: peak(1912, 8),
                whitenedFull: peak(1912, 6),
                comboFull: peak(1912, 6),
                pairFixedLagStepWeighted: peak(1912, 4),
                pairFixedLagStepMedian: peak(1913, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
            operationEvidence: {
                bestYear: 1912,
                remoteDifferenceMargin: 0.008,
            },
        };
        const baseline = selectCalibratedEventWindow(input);
        const regularized = selectCalibratedEventWindow({
            ...input,
            candidateBackedModePriorYear: 1920,
        });

        expect(baseline?.width).toBe(13);
        expect(baseline?.calibrationRule).toBe("calibrated_default_13");
        expect(regularized?.width).toBe(13);
        expect(regularized?.calibrationRule).toBe(
            "partial_candidate_mode_regularized_13",
        );
        expect(regularized!.window.startYear).toBeGreaterThan(
            baseline!.window.startYear,
        );
    });

    it("falls back to 13 years for weak partial-move peaks", () => {
        const result = selectCalibratedEventWindow({
            eventType: "partialMove",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1920, 8),
                cumulativeReferenceVote: peak(1920, 8),
                cumulativeReferenceMedian: peak(1920, 7),
                pairWhitenedMean: peak(1921, 7),
                whitenedFull: years.map(() => 0.5),
                comboFull: years.map(() => 0.5),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
        });

        expect(result?.width).toBe(13);
    });

    it("uses five years for separated physical evidence with full agreement", () => {
        const result = selectCalibratedEventWindow({
            eventType: "partialMove",
            years,
            ranks: ranks(physicalPartialProfiles(1920)),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
            candidateBackedModePriorYear: 1920,
            operationEvidence: {
                bestYear: 1920,
                remoteDifferenceMargin: 0.05,
            },
        });

        expect(result?.width).toBe(5);
        expect(result?.calibrationRule).toBe(
            "partial_physical_consensus_5",
        );
        expect(result!.window.startYear).toBeLessThanOrEqual(1920);
        expect(result!.window.endYear).toBeGreaterThanOrEqual(1920);
    });

    it("uses seven years for agreed but less separated physical evidence", () => {
        const result = selectCalibratedEventWindow({
            eventType: "partialMove",
            years,
            ranks: ranks(physicalPartialProfiles(1920)),
            coarseWindow,
            internalCandidates: [],
            operationEvidence: {
                bestYear: 1920,
                remoteDifferenceMargin: 0.03,
            },
        });

        expect(result?.width).toBe(7);
        expect(result?.calibrationRule).toBe(
            "partial_physical_consensus_7",
        );
    });

    it("uses the unshifted evidence maximum for a partial-move plateau", () => {
        const result = selectCalibratedEventWindow({
            eventType: "partialMove",
            years,
            ranks: ranks({
                differenceFull: years.map(() => 0.5),
                whitenedFull: years.map(() => 0.5),
                comboFull: years.map(() => 0.5),
            }),
            coarseWindow,
            internalCandidates: [],
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe("calibrated_default_13");
        expect(result?.window.startYear).toBe(1921);
    });

    it("uses sharp partial evidence instead of a misleading cumulative mode", () => {
        const result = selectCalibratedEventWindow({
            eventType: "partialMove",
            years,
            ranks: ranks({
                cumulativeDifference: peak(1909, 4),
                differenceFull: peak(1924, 4),
                whitenedFull: years.map(() => 0.5),
                comboFull: years.map(() => 0.5),
            }),
            coarseWindow,
            internalCandidates: [],
        });

        expect(result?.width).toBe(13);
        expect(result?.profileNames).toEqual(["differenceFull"]);
        expect(result!.window.startYear).toBeLessThanOrEqual(1924);
        expect(result!.window.endYear).toBeGreaterThanOrEqual(1924);
        expect(result!.window.startYear).toBeGreaterThan(1910);
    });

    it("keeps near-threshold physical partial evidence at 13 years", () => {
        const narrowValue = 2.9 / 3;
        const result = selectCalibratedEventWindow({
            eventType: "partialMove",
            years,
            ranks: ranks({
                differenceFull: peak(1920, 5),
                whitenedFull: years.map((year) => (
                    Math.abs(year - 1920) <= 4 ? narrowValue : 0
                )),
                comboFull: years.map((year) => (
                    Math.abs(year - 1920) <= 4 ? narrowValue : 0
                )),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe("calibrated_default_13");
    });

    it("does not bridge distant peaks or widen false-ring cases past 13", () => {
        const first = peak(1910, 3);
        const second = peak(1929, 3);
        const bimodal = first.map((value, index) => (
            Math.max(value, second[index])
        ));
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                cumulativeDifference: bimodal,
                comboFull: bimodal,
                differenceFull: bimodal,
                pairDifferenceWeighted: peak(1910, 4),
                transitionSplitGain: peak(1910, 5),
            }),
            coarseWindow,
            internalCandidates: [],
        });

        expect(result?.width).toBe(13);
        expect(result!.window.endYear - result!.window.startYear + 1).toBe(13);
        expect(
            result!.window.startYear <= 1910 && result!.window.endYear >= 1929,
        ).toBe(false);
        expect(CALIBRATED_EVENT_WINDOW_WIDTHS).toEqual([5, 7, 9, 13]);
    });

    it("uses event-specific false-ring evidence for the 13-year mode", () => {
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                cumulativeDifference: peak(1909, 4),
                comboFull: peak(1924, 4),
                differenceFull: peak(1924, 4),
                pairDifferenceWeighted: peak(1924, 4),
                transitionSplitGain: peak(1924, 4),
            }),
            coarseWindow,
            internalCandidates: [],
        });

        expect(result?.width).toBe(13);
        expect(result?.profileNames).toEqual([
            "comboFull",
            "cumulativeReferenceVote",
            "currentPeak",
        ]);
        expect(result!.window.startYear).toBeLessThanOrEqual(1924);
        expect(result!.window.endYear).toBeGreaterThanOrEqual(1924);
        expect(result!.window.startYear).toBeGreaterThan(1910);
    });

    it("uses a robust false-ring mode consensus instead of averaging distant peaks", () => {
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                comboFull: peak(1909, 4),
                cumulativeReferenceVote: peak(1924, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1924,
        });

        expect(result?.width).toBe(13);
        expect(result!.window.startYear).toBeLessThanOrEqual(1924);
        expect(result!.window.endYear).toBeGreaterThanOrEqual(1924);
        expect(result!.window.startYear).toBeGreaterThan(1910);
    });

    it("combines cumulative and standardized CUSUM modes for false rings", () => {
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1924, 4),
                cumulativeCombinedCusum: peak(1918, 4),
            }),
            coarseWindow,
            internalCandidates: [],
        });

        expect(result?.width).toBe(13);
        expect(result?.profileNames).toEqual([
            "cumulativeCombined",
            "cumulativeCombinedCusum",
        ]);
        expect(result!.window.startYear).toBeLessThanOrEqual(1918);
        expect(result!.window.endYear).toBeGreaterThanOrEqual(1924);
    });

    it("keeps 13 years when a false-ring narrow window contradicts CUSUM", () => {
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1924, 4),
                cumulativeCombinedCusum: peak(1914, 4),
                differenceFull: peak(1924, 4),
                transitionSplitGain: peak(1924, 4),
                whitenedFull: peak(1924, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1924,
            operationEvidence: {
                bestYear: 1924,
                remoteDifferenceMargin: 0.1,
            },
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe(
            "false_ring_cusum_disagreement_mode_13",
        );
    });

    it("uses an independent false-ring boundary mode when cumulative profiles share an older-edge bias", () => {
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1914, 4),
                cumulativeCombinedCusum: peak(1914, 4),
                differenceFull: peak(1914, 4),
                whitenedFull: peak(1914, 4),
                rawFull: peak(1916, 4),
                transitionSplitGain: peak(1916, 4),
                cumulativeReferenceVote: peak(1916, 4),
                sideStepScore: peak(1916, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1914,
            operationEvidence: {
                bestYear: 1914,
                remoteDifferenceMargin: 0.08,
            },
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe(
            "false_ring_independent_boundary_mode_13",
        );
        expect(result?.profileNames).toEqual([
            "rawFull",
            "transitionSplitGain",
            "cumulativeReferenceVote",
            "sideStepScore",
        ]);
        expect(result!.window.startYear).toBeLessThanOrEqual(1916);
        expect(result!.window.endYear).toBeGreaterThanOrEqual(1916);
    });

    it("preserves a false-ring narrow window when independent-mode operation separation is weak", () => {
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                cumulativeCombined: peak(1914, 4),
                cumulativeCombinedCusum: peak(1914, 4),
                differenceFull: peak(1914, 4),
                whitenedFull: peak(1914, 4),
                rawFull: peak(1916, 4),
                transitionSplitGain: peak(1916, 4),
                cumulativeReferenceVote: peak(1916, 4),
                sideStepScore: peak(1916, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1914,
            operationEvidence: {
                bestYear: 1914,
                remoteDifferenceMargin: 0.049,
            },
        });

        expect(result?.width).toBeLessThan(13);
        expect(result?.calibrationRule).not.toBe(
            "false_ring_independent_boundary_mode_13",
        );
    });

    it("uses the difference mode when a false-ring window excludes the operation year", () => {
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                comboFull: peak(1910, 4),
                cumulativeReferenceVote: peak(1910, 4),
                differenceFull: peak(1922, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1910,
            operationEvidence: {
                bestYear: 1922,
                remoteDifferenceMargin: 0.02,
            },
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe(
            "false_ring_operation_consistent_difference_13",
        );
        expect(result?.profileNames).toEqual(["differenceFull"]);
        expect(result!.window.startYear).toBeLessThanOrEqual(1922);
        expect(result!.window.endYear).toBeGreaterThanOrEqual(1922);
    });

    it("narrows a false-ring mode when independent boundary evidence agrees", () => {
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                comboFull: peak(1920, 5),
                cumulativeReferenceVote: peak(1921, 5),
                differenceFull: peak(1920, 4),
                transitionSplitGain: peak(1921, 4),
                whitenedFull: peak(1919, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
            operationEvidence: {
                bestYear: 1921,
                remoteDifferenceMargin: 0.03,
            },
        });

        expect(result?.width).toBe(9);
        expect(result?.calibrationRule).toBe(
            "false_ring_cross_evidence_consensus_9",
        );
        expect(result!.window.startYear).toBeGreaterThanOrEqual(
            result!.modeWindow.startYear,
        );
        expect(result!.window.endYear).toBeLessThanOrEqual(
            result!.modeWindow.endYear,
        );
    });

    it("keeps 13 years when false-ring operation separation is marginal", () => {
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                comboFull: peak(1920, 5),
                cumulativeReferenceVote: peak(1921, 5),
                differenceFull: peak(1920, 4),
                transitionSplitGain: peak(1921, 4),
                whitenedFull: peak(1919, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
            operationEvidence: {
                bestYear: 1921,
                remoteDifferenceMargin: 0.022,
            },
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe("calibrated_default_13");
    });

    it("keeps the false-ring mode at 13 years when raw evidence contradicts a nine-year window", () => {
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                comboFull: peak(1920, 5),
                cumulativeReferenceVote: peak(1920, 5),
                differenceFull: peak(1920, 4),
                transitionSplitGain: peak(1920, 4),
                whitenedFull: peak(1920, 4),
                rawFull: peak(1925, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
            operationEvidence: {
                bestYear: 1920,
                remoteDifferenceMargin: 0.03,
            },
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe(
            "false_ring_raw_disagreement_mode_13",
        );
        expect(result?.window).toEqual(result?.modeWindow);
    });

    it("uses 5 years for a tightly concentrated false-ring boundary", () => {
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                comboFull: peak(1920, 5),
                cumulativeReferenceVote: peak(1920, 5),
                differenceFull: peak(1920, 4),
                transitionSplitGain: peak(1920, 4),
                whitenedFull: peak(1920, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
            operationEvidence: {
                bestYear: 1920,
                remoteDifferenceMargin: 0.1,
            },
        });

        expect(result?.width).toBe(5);
        expect(result?.calibrationRule).toBe(
            "false_ring_concentrated_anchor_consensus_5",
        );
    });

    it("keeps 13 years when raw residuals contradict a false-ring five-year mode", () => {
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                comboFull: peak(1920, 5),
                cumulativeReferenceVote: peak(1920, 5),
                differenceFull: peak(1920, 4),
                transitionSplitGain: peak(1920, 4),
                whitenedFull: peak(1920, 4),
                rawFull: peak(1927, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
            operationEvidence: {
                bestYear: 1920,
                remoteDifferenceMargin: 0.1,
            },
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe("calibrated_default_13");
    });

    it("uses 7 years for a strong but less decisive false-ring boundary", () => {
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                comboFull: peak(1920, 5),
                cumulativeReferenceVote: peak(1920, 5),
                differenceFull: peak(1920, 4),
                transitionSplitGain: peak(1921, 4),
                whitenedFull: peak(1920, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
            operationEvidence: {
                bestYear: 1921,
                remoteDifferenceMargin: 0.05,
            },
        });

        expect(result?.width).toBe(7);
        expect(result?.calibrationRule).toBe(
            "false_ring_boundary_consensus_7",
        );
    });

    it("keeps a false-ring mode at 13 years when boundary evidence disagrees", () => {
        const result = selectCalibratedEventWindow({
            eventType: "falseRing",
            years,
            ranks: ranks({
                comboFull: peak(1920, 5),
                cumulativeReferenceVote: peak(1921, 5),
                differenceFull: peak(1913, 4),
                transitionSplitGain: peak(1921, 4),
                whitenedFull: peak(1928, 4),
            }),
            coarseWindow,
            internalCandidates: [],
            currentPrimaryYear: 1920,
            operationEvidence: {
                bestYear: 1921,
                remoteDifferenceMargin: 0.03,
            },
        });

        expect(result?.width).toBe(13);
        expect(result?.calibrationRule).toBe("calibrated_default_13");
    });
});

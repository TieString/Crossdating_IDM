import { describe, expect, it } from "vitest";
import type { JointCounterfactualOperationScore } from "../jointCounterfactualOperation";
import type { PerReferenceCounterfactualSummary } from "../perReferenceCounterfactualEvidence";
import {
    selectFalseRingReferenceConsensusRecovery,
    shouldScoreFalseRingReferenceConsensus,
} from "../unitReferenceConsensusRecovery";

const operation = (
    shiftYears: -1 | 1,
    values: Partial<JointCounterfactualOperationScore> = {},
): JointCounterfactualOperationScore => {
    const bestYear = values.bestYear ?? 1904;
    const score = values.bestDifferenceGain ?? 0.1;
    return {
        eventType: shiftYears === -1 ? "missingRing" : "falseRing",
        shiftYears,
        bestYear,
        bestRawGain: score,
        bestDifferenceGain: score,
        bestCombinedGain: score,
        topThreeDifferenceGain: score,
        remoteDifferenceMargin: 0.03,
        sideStepBestYear: bestYear,
        bestSideStepScore: score,
        topThreeSideStepScore: score,
        bestSideMinimumAdvantage: score,
        bestCorrectedSideSupport: 0.3,
        sideStepRemoteMargin: 0.02,
        baselineLag: 0,
        rows: [{
            year: bestYear,
            differenceGain: score,
            combinedGain: score,
        }] as JointCounterfactualOperationScore["rows"],
        ...values,
    };
};

const summary = (
    values: Partial<PerReferenceCounterfactualSummary> = {},
): PerReferenceCounterfactualSummary => ({
    bestYear: 1905,
    referenceCount: 8,
    bestCombinedGain: 0.06,
    topThreeCombinedGain: 0.055,
    bestDifferenceGain: 0.07,
    topThreeDifferenceGain: 0.065,
    bestWhitenedGain: 0.05,
    topThreeWhitenedGain: 0.045,
    positiveDifferenceGainFraction: 0.75,
    positiveWhitenedGainFraction: 0.625,
    peakKernel5: 0.7,
    peakKernel9: 0.8,
    remoteCombinedMargin: 0.01,
    ...values,
});

const operations = (
    falseValues: Partial<JointCounterfactualOperationScore> = {},
): JointCounterfactualOperationScore[] => [
    operation(-1, { bestDifferenceGain: 0.04 }),
    operation(1, falseValues),
];

describe("reference-consensus unit-event recovery", () => {
    it("recovers a false ring only when independent references agree", () => {
        const scored = operations();
        const selected = selectFalseRingReferenceConsensusRecovery(
            scored,
            summary(),
            summary({
                bestYear: 1910,
                bestCombinedGain: 0.03,
            }),
        );

        expect(selected).not.toBeNull();
        expect(selected?.operation.eventType).toBe("falseRing");
        expect(selected?.centerSource).toBe("master_operation");
        expect(selected?.centerYear).toBe(1904);
    });

    it("uses the per-reference center when the master peak is weak and remote", () => {
        const scored = operations({
            bestYear: 1904,
            sideStepBestYear: 1915,
            bestCorrectedSideSupport: 0.1,
            remoteDifferenceMargin: 0.01,
        });
        const selected = selectFalseRingReferenceConsensusRecovery(
            scored,
            summary({ bestYear: 1930 }),
            summary({
                bestYear: 1910,
                bestCombinedGain: 0.03,
            }),
        );

        expect(selected?.centerSource).toBe("per_reference_consensus");
        expect(selected?.centerYear).toBe(1930);
    });

    it("rejects a broad profile without a separated main mode", () => {
        const selected = selectFalseRingReferenceConsensusRecovery(
            operations(),
            summary({ remoteCombinedMargin: 0.003 }),
            summary({ bestCombinedGain: 0.03 }),
        );

        expect(selected).toBeNull();
    });

    it("rejects evidence that does not distinguish false from missing rings", () => {
        const selected = selectFalseRingReferenceConsensusRecovery(
            operations(),
            summary({ bestCombinedGain: 0.06 }),
            summary({ bestCombinedGain: 0.045 }),
        );

        expect(selected).toBeNull();
    });

    it("does not start reference scoring below the master pre-filter", () => {
        const scored = operations({
            bestDifferenceGain: 0.049,
            topThreeDifferenceGain: 0.049,
            bestCombinedGain: 0.049,
        });

        expect(shouldScoreFalseRingReferenceConsensus(scored)).toBe(false);
        expect(selectFalseRingReferenceConsensusRecovery(
            scored,
            summary(),
            summary({ bestCombinedGain: 0.03 }),
        )).toBeNull();
    });
});

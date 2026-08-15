import { describe, expect, it } from "vitest";
import { selectWholeSeriesCandidate } from "../events";
import type {
    DiagnosisCandidateOperation,
    SegmentDiagnosis,
    SeriesCoreDiagnosis,
} from "../types";
import {
    measureWholeSeriesStateConsistency,
    supportsDominantWholeSeriesBaseline,
    supportsNonTerminalWholeSeriesCandidate,
} from "../wholeSeriesStateConsistency";

const segment = (
    startYear: number,
    bestLag: number,
    confidence = 1,
    wholeSeriesLagProbe?: SegmentDiagnosis["wholeSeriesLagProbe"],
): SegmentDiagnosis => ({
    targetTree: "T",
    seriesId: "T",
    startYear,
    endYear: startYear + 49,
    r0: 0.2,
    bestLag,
    bestR: 0.7,
    flag: "A_like",
    sampleSize: 50,
    currentCorrelation: 0.2,
    bestCorrelation: 0.7,
    samplePairs: 50,
    flagged: true,
    reason: "test",
    effectiveN: 40,
    t0: 1,
    bestT: 5,
    tImprovement: 4,
    rImprovement: 0.5,
    fisherZ0: 0.2,
    fisherZBest: 0.8,
    fisherZImprovement: 0.6,
    classification: "A_like",
    confidence,
    wholeSeriesLagProbe,
});

const diagnosis = (lags: number[], globalLag: number) => ({
    segments: lags.map((lag, index) => segment(1800 + index * 25, lag)),
    globalSlidingMatch: {
        seriesId: "T",
        lagResults: [],
        bestGlobalLag: globalLag,
        bestGlobalR: 0.7,
        bestGlobalTLike: 5,
        overlapYears: 200,
        currentR: 0.2,
        currentTLike: 1,
        currentOverlapYears: 200,
    },
});

describe("whole-series state consistency", () => {
    it("recognizes a shift supported across both chronology ends", () => {
        const evidence = measureWholeSeriesStateConsistency(
            diagnosis([-4, -4, -4, -4], -4),
            -4,
        );

        expect(evidence.supportFraction).toBe(1);
        expect(evidence.olderEdgeSupportFraction).toBe(1);
        expect(evidence.newerEdgeSupportFraction).toBe(1);
        expect(evidence.globalLagMatchesShift).toBe(true);
    });

    it("exposes a partial transition whose newer fixed side stays at zero", () => {
        const evidence = measureWholeSeriesStateConsistency(
            diagnosis([-4, -4, 0, 0], -4),
            -4,
        );

        expect(evidence.supportFraction).toBe(0.5);
        expect(evidence.olderEdgeSupportFraction).toBe(1);
        expect(evidence.newerEdgeSupportFraction).toBe(0);
        expect(evidence.newestLag).toBe(0);
    });

    it("keeps global-lag agreement separate from endpoint agreement", () => {
        const evidence = measureWholeSeriesStateConsistency(
            diagnosis([-4, -4, -4, 0], -4),
            -4,
        );

        expect(evidence.globalLagMatchesShift).toBe(true);
        expect(evidence.newerEdgeSupportFraction).toBe(0.5);
        expect(evidence.newestLag).toBe(0);
    });

    it("accepts a stable newer baseline for a whole plus local-event path", () => {
        const evidence = measureWholeSeriesStateConsistency(
            diagnosis([0, -1, 2, 2], 2),
            2,
        );

        expect(evidence.supportFraction).toBe(0.5);
        expect(evidence.newerEdgeSupportFraction).toBe(1);
        expect(supportsNonTerminalWholeSeriesCandidate(evidence)).toBe(true);
    });

    it("accepts broad global consensus when an endpoint segment is noisy", () => {
        const evidence = measureWholeSeriesStateConsistency(
            diagnosis([-4, -4, -4, -4, -4, -4, -4, 0], -4),
            -4,
        );

        expect(evidence.newerEdgeSupportFraction).toBe(0.5);
        expect(evidence.supportFraction).toBeGreaterThanOrEqual(2 / 3);
        expect(supportsNonTerminalWholeSeriesCandidate(evidence)).toBe(true);
    });

    it("rejects a broad older-side majority when the newer side stays at zero", () => {
        const evidence = measureWholeSeriesStateConsistency(
            diagnosis([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0], 2),
            2,
        );

        expect(evidence.supportFraction).toBe(0.75);
        expect(evidence.weightedSupportFraction).toBe(0.75);
        expect(evidence.olderEdgeSupportFraction).toBe(1);
        expect(evidence.newerEdgeSupportFraction).toBe(0);
        expect(evidence.newestLag).toBe(0);
        expect(supportsNonTerminalWholeSeriesCandidate(evidence)).toBe(false);
    });

    it("accepts a strict robust segment majority when global lag is a remote alias", () => {
        const evidence = measureWholeSeriesStateConsistency(
            diagnosis([-4, -4, -4, -4, -4, -4, 10, -52, -50, -97], 62),
            -4,
        );

        expect(evidence.supportFraction).toBe(0.6);
        expect(evidence.globalLagMatchesShift).toBe(false);
        expect(supportsNonTerminalWholeSeriesCandidate(evidence)).toBe(true);
    });

    it("does not treat a tied local state as a whole-series majority", () => {
        const evidence = measureWholeSeriesStateConsistency(
            diagnosis([-4, -4, -4, -4, 0, 0, 0, 0], 0),
            -4,
        );

        expect(evidence.supportFraction).toBe(0.5);
        expect(supportsNonTerminalWholeSeriesCandidate(evidence)).toBe(false);
    });

    it("rejects a local majority when the fixed newer side and global lag disagree", () => {
        const evidence = measureWholeSeriesStateConsistency(
            diagnosis([-4, -4, -4, 0, 0], 0),
            -4,
        );

        expect(evidence.newerEdgeSupportFraction).toBe(0);
        expect(evidence.globalLagMatchesShift).toBe(false);
        expect(supportsNonTerminalWholeSeriesCandidate(evidence)).toBe(false);
    });

    it("uses direct global-lag probes without widening local best-lag states", () => {
        const globalLag = 11;
        const evidence = measureWholeSeriesStateConsistency({
            segments: [0, 1, 2, 3].map((_, index) => segment(
                1800 + index * 25,
                10,
                1,
                {
                    lag: globalLag,
                    correlation: 0.72,
                    samplePairs: 50,
                    rImprovement: 0.5,
                    competitiveWithLocalBest: true,
                    supportsLag: true,
                },
            )),
            globalSlidingMatch: diagnosis([], globalLag).globalSlidingMatch,
        }, globalLag);

        expect(evidence.shiftSupportCount).toBe(4);
        expect(evidence.oldestLag).toBe(globalLag);
        expect(evidence.newestLag).toBe(globalLag);
        expect(supportsDominantWholeSeriesBaseline(evidence)).toBe(true);
    });

    it("does not turn an older-side global probe into a whole baseline", () => {
        const globalLag = 20;
        const probe = (supportsLag: boolean): SegmentDiagnosis["wholeSeriesLagProbe"] => ({
            lag: globalLag,
            correlation: supportsLag ? 0.72 : 0.15,
            samplePairs: 50,
            rImprovement: supportsLag ? 0.5 : -0.05,
            competitiveWithLocalBest: supportsLag,
            supportsLag,
        });
        const evidence = measureWholeSeriesStateConsistency({
            segments: [
                segment(1800, 10, 1, probe(true)),
                segment(1825, 10, 1, probe(true)),
                segment(1850, 0, 1, probe(false)),
                segment(1875, 0, 1, probe(false)),
            ],
            globalSlidingMatch: diagnosis([], globalLag).globalSlidingMatch,
        }, globalLag);

        expect(evidence.olderEdgeSupportFraction).toBe(1);
        expect(evidence.newerEdgeSupportFraction).toBe(0);
        expect(evidence.newestLag).toBe(0);
        expect(supportsNonTerminalWholeSeriesCandidate(evidence)).toBe(false);
        expect(supportsDominantWholeSeriesBaseline(evidence)).toBe(false);
    });

    it("lets dominant whole-state evidence outrank a conflicting terminal label", () => {
        const globalLag = 50;
        const probe: SegmentDiagnosis["wholeSeriesLagProbe"] = {
            lag: globalLag,
            correlation: 0.72,
            samplePairs: 50,
            rImprovement: 0.5,
            competitiveWithLocalBest: true,
            supportsLag: true,
        };
        const core = {
            ...diagnosis([], globalLag),
            targetTree: "T",
            rawTarget: new Map(),
            targetRange: { startYear: 1800, endYear: 2000 },
            master: { data: new Map(), sampleDepth: new Map(), sourceTrees: [] },
            segments: Array.from({ length: 8 }, (_, index) => (
                segment(1800 + index * 20, 10, 1, probe)
            )),
            propagationPatterns: [],
            unresolvedA: 0,
            unresolvedB: 0,
        } as SeriesCoreDiagnosis;
        const candidate = (
            shiftYears: number,
            score: number,
            terminal: boolean,
        ): DiagnosisCandidateOperation => ({
            operationType: "SHIFT_RANGE",
            mode: "wholeSeriesMove",
            deltaYears: shiftYears,
            suggestedLag: shiftYears,
            score,
            candidateStrength: "strong",
            evidence: {
                recallSourceTags: terminal
                    ? ["cofecha_terminal_whole_baseline"]
                    : [],
                evaluationDelta: { hardGatePassed: true },
            },
        } as DiagnosisCandidateOperation);

        expect(selectWholeSeriesCandidate([
            candidate(globalLag, 24, false),
            candidate(7, -20, true),
        ], core)?.deltaYears).toBe(globalLag);
    });

    it("accepts a dominant whole baseline with uniform support", () => {
        const evidence = measureWholeSeriesStateConsistency(
            diagnosis([-4, -4, -4, -4, -4, -4], -4),
            -4,
        );

        expect(supportsDominantWholeSeriesBaseline(evidence)).toBe(true);
    });

    it("accepts one noisy chronology edge when the remaining evidence is broad", () => {
        const evidence = measureWholeSeriesStateConsistency(
            diagnosis([0, -4, -4, -4, -4, -4, -4, -4, -4], -4),
            -4,
        );

        expect(evidence.olderEdgeSupportFraction).toBe(0.5);
        expect(evidence.newerEdgeSupportFraction).toBe(1);
        expect(supportsDominantWholeSeriesBaseline(evidence)).toBe(true);
    });

    it("rejects a weak whole hypothesis from a bounded local state", () => {
        const evidence = measureWholeSeriesStateConsistency(
            diagnosis([0, 0, -4, -4, -4, -4, -4, -4], -4),
            -4,
        );

        expect(evidence.supportFraction).toBe(0.75);
        expect(supportsDominantWholeSeriesBaseline(evidence)).toBe(false);
    });

    it("rejects broad segment support when the global lag disagrees", () => {
        const evidence = measureWholeSeriesStateConsistency(
            diagnosis([-4, -4, -4, -4, -4, -4, -4, 0], 0),
            -4,
        );

        expect(evidence.supportFraction).toBe(0.875);
        expect(supportsDominantWholeSeriesBaseline(evidence)).toBe(false);
    });
});

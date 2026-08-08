import { describe, expect, it } from "vitest";
import type { SegmentDiagnosis } from "../types";
import {
    measureWholeSeriesStateConsistency,
    supportsNonTerminalWholeSeriesCandidate,
} from "../wholeSeriesStateConsistency";

const segment = (
    startYear: number,
    bestLag: number,
    confidence = 1,
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

    it("rejects a local majority when the fixed newer side and global lag disagree", () => {
        const evidence = measureWholeSeriesStateConsistency(
            diagnosis([-4, -4, -4, 0, 0], 0),
            -4,
        );

        expect(evidence.newerEdgeSupportFraction).toBe(0);
        expect(evidence.globalLagMatchesShift).toBe(false);
        expect(supportsNonTerminalWholeSeriesCandidate(evidence)).toBe(false);
    });
});

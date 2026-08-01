import { describe, expect, it } from "vitest";
import {
    findUniqueRepeatedBlockBoundary,
    refinePartialMoveWithRepeatedBlock,
    selectNegativePartialConsensusYear,
    selectNegativePartialNeighborYear,
    type GapBoundaryScore,
} from "../partialBreakpointRefinement";
import { refineEventsWithReferenceVoting } from "../eventReferenceVoting";
import type { DiagnosisEvent, SeriesCoreDiagnosis } from "../types";

describe("partial move repeated-block refinement", () => {
    const gapScore = (
        year: number,
        raw31: number,
        combo41: number,
    ): GapBoundaryScore => ({
        year,
        raw31,
        difference31: 0,
        whitened31: 0,
        combo31: 0,
        combo41,
        combo61: 0,
        multiScale: 0,
    });

    it("moves a negative-partial Top1 only when two views agree on its neighbour", () => {
        const selected = selectNegativePartialNeighborYear([
            gapScore(1898, -3, -2),
            gapScore(1899, 2, 1.5),
            gapScore(1900, 0, 0),
            gapScore(1901, -1, -0.5),
            gapScore(1902, 3, 2),
        ], 1900);
        expect(selected?.year).toBe(1899);
        expect(selected?.rawMargin).toBeGreaterThanOrEqual(0.1);
        expect(selected?.comboMargin).toBeGreaterThanOrEqual(0.05);
    });

    it("keeps the current negative-partial Top1 when the views disagree", () => {
        expect(selectNegativePartialNeighborYear([
            gapScore(1898, -3, -2),
            gapScore(1899, 2, -1),
            gapScore(1900, 0, 0),
            gapScore(1901, -1, 2),
            gapScore(1902, 3, 3),
        ], 1900)).toBeNull();
    });

    it("selects a nearby three-view negative-partial consensus", () => {
        const scores = [
            {
                ...gapScore(1896, 0, 0),
                difference31: 4,
                whitened31: 4,
                combo31: 4,
                combo41: 4,
                combo61: 4,
                multiScale: 4,
            },
            gapScore(1900, 1, 1),
            gapScore(1904, 2, 2),
        ];
        expect(selectNegativePartialConsensusYear(
            scores,
            1899,
            1907,
            1903,
        )).toEqual({
            year: 1896,
            support: 6,
            distanceToWindow: 3,
        });
    });

    it("rejects a strong negative-partial consensus far from the path window", () => {
        const scores = [
            {
                ...gapScore(1870, 0, 0),
                difference31: 4,
                whitened31: 4,
                combo31: 4,
                combo41: 4,
                combo61: 4,
                multiScale: 4,
            },
            gapScore(1900, 1, 1),
            gapScore(1904, 2, 2),
        ];
        expect(selectNegativePartialConsensusYear(
            scores,
            1899,
            1907,
            1903,
        )).toBeNull();
    });

    it("finds the unique boundary created by an older-side overlap", () => {
        const series = new Map<number, number>([
            [1900, 11], [1901, 17], [1902, 23], [1903, 37],
            [1904, 23], [1905, 37], [1906, 53], [1907, 67],
        ]);
        expect(findUniqueRepeatedBlockBoundary(series, 2)).toEqual({
            year: 1903,
            blockLength: 2,
            comparedValues: 2,
        });
        expect(findUniqueRepeatedBlockBoundary(series, -2)).toBeNull();
    });

    it("does not choose between repeated blocks when the structural cue is ambiguous", () => {
        const series = new Map<number, number>([
            [1900, 10], [1901, 20], [1902, 10], [1903, 20],
            [1904, 10], [1905, 20], [1906, 10], [1907, 20],
        ]);
        expect(findUniqueRepeatedBlockBoundary(series, 2)).toBeNull();
    });

    it("promotes the exact structural boundary before final presentation", () => {
        const rawTarget = new Map<number, number>();
        for (let year = 1880; year <= 1920; year += 1) rawTarget.set(year, year - 1800);
        rawTarget.set(1899, 401);
        rawTarget.set(1900, 509);
        rawTarget.set(1901, 401);
        rawTarget.set(1902, 509);
        const event: DiagnosisEvent = {
            id: "partial",
            seriesId: "A",
            eventType: "partialMove",
            startYear: 1905,
            endYear: 1913,
            rankedYears: Array.from({ length: 9 }, (_, index) => ({
                year: 1905 + index,
                rank: index + 1,
                score: 9 - index,
                evidenceTags: ["piecewise_lag_path"],
            })),
            confidenceLevel: "medium",
            evidence: {
                algorithmSources: ["piecewise_lag_path"],
                score: 2,
                scoreMargin: 0.2,
                baselineCorrelation: 0.2,
                correctedCorrelation: 0.6,
                correlationGain: 0.4,
                lagBefore: 2,
                lagAfter: 0,
                samplePairs: 60,
                candidateIds: [],
                notes: [],
            },
            alternativeTypes: [],
            shiftYears: 2,
            shiftSide: "older",
        };
        const diagnosis = {
            rawTarget,
            targetRange: { startYear: 1880, endYear: 1920 },
        } as SeriesCoreDiagnosis;
        const refined = refinePartialMoveWithRepeatedBlock(event, diagnosis);
        expect(refined.endYear - refined.startYear + 1).toBe(9);
        expect(refined.rankedYears[0].year).toBe(1900);
        expect(refined.startYear).toBe(1896);
        expect(refined.evidence.algorithmSources).toContain("unique_repeated_block_boundary");

        const voted = refineEventsWithReferenceVoting([refined], diagnosis, new Map());
        expect(voted[0].rankedYears[0].year).toBe(1900);
        expect(voted[0].startYear).toBe(1896);
    });
});

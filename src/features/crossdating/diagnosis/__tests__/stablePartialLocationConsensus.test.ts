import { describe, expect, it } from "vitest";
import {
    allowsNewerUnitChainLocationConsensus,
    centerDetachedPartialOnStrongBoundedPath,
    selectStablePartialLocationConsensus,
    selectStablePartialRankEdgeShift,
} from "../stablePartialLocationConsensus";
import type { DiagnosisEvent } from "../types";

describe("stable partial location consensus", () => {
    const detachedPartial = (pathYear: number): DiagnosisEvent => ({
        id: "partial-detached",
        seriesId: "TEST",
        eventType: "partialMove",
        shiftYears: -6,
        shiftSide: "older",
        startYear: 1794,
        endYear: 1806,
        rankedYears: Array.from({ length: 13 }, (_, index) => ({
            year: 1794 + index,
            rank: 0,
            score: 13 - Math.abs(index - 6),
            evidenceTags: [],
        })).sort((left, right) => right.score - left.score)
            .map((row, index) => ({ ...row, rank: index + 1 })),
        confidenceLevel: "high",
        evidence: {
            algorithmSources: ["bounded_complete_lag_path"],
            score: 20,
            scoreMargin: 1,
            baselineCorrelation: 0.2,
            correctedCorrelation: 0.7,
            correlationGain: 0.5,
            lagBefore: -6,
            lagAfter: 0,
            samplePairs: 100,
            candidateIds: [],
            notes: [],
            locationEvidence: [{
                source: "bounded_complete_lag_path",
                startYear: pathYear - 6,
                endYear: pathYear + 6,
                topYear: pathYear,
                referenceCount: 8,
                concentration: 0.8,
                remoteMargin: 1,
                calibrated: false,
            }],
        },
        alternativeTypes: [],
    });

    it("recenters only a partial window detached from its strong path by ten years", () => {
        const event = detachedPartial(1810);
        const centered = centerDetachedPartialOnStrongBoundedPath(event, {
            targetRange: { startYear: 1700, endYear: 1900 },
        });
        expect(centered).toMatchObject({
            startYear: 1804,
            endYear: 1816,
        });
        expect(centered.rankedYears[0]).toMatchObject({ year: 1810, rank: 1 });

        const nearby = detachedPartial(1809);
        expect(centerDetachedPartialOnStrongBoundedPath(nearby, {
            targetRange: { startYear: 1700, endYear: 1900 },
        })).toBe(nearby);
    });

    it("moves a lag-path plateau to the robust boundary consensus", () => {
        expect(selectStablePartialLocationConsensus(
            1808,
            1818,
            1814,
            1809,
        )).toEqual({
            pathYear: 1808,
            localCorrelationYear: 1818,
            localStepYear: 1814,
            referenceVoteYear: 1809,
            centerYear: 1812,
        });
    });

    it("does not let one detached local peak drag the consensus away", () => {
        expect(selectStablePartialLocationConsensus(
            1836,
            1851,
            1835,
            1835,
        ).centerYear).toBe(1836);
    });

    it("keeps an upstream window center distinct from its ranked Top1", () => {
        expect(selectStablePartialLocationConsensus(
            1928,
            1928,
            1944,
            1922,
        ).centerYear).toBe(1928);
    });

    it("keeps a clipped per-reference boundary vote out of the consensus", () => {
        expect(selectStablePartialLocationConsensus(
            1864,
            1860,
            1869,
            1864,
        ).centerYear).toBe(1864);
    });

    it("lets a multi-unit staircase expose its newer unresolved frontier", () => {
        const input = {
            endYear: 1918,
            evidence: {
                notes: [
                    "stable_bounded_path_transition_count=2",
                    "stable_bounded_path_all_transitions_partial=false",
                ],
            },
        } as DiagnosisEvent;
        expect(allowsNewerUnitChainLocationConsensus(input, 1919)).toBe(true);
        expect(allowsNewerUnitChainLocationConsensus(input, 1906)).toBe(false);
        input.evidence.notes = [
            "stable_bounded_path_transition_count=2",
            "stable_bounded_path_all_transitions_partial=true",
        ];
        expect(allowsNewerUnitChainLocationConsensus(input, 1919)).toBe(false);
    });
});

describe("stable partial ranked-edge continuation", () => {
    const rows = (ranks: number[]) => ranks.map((rank, index) => ({
        year: 1800 + index,
        rank,
        score: 20 - rank,
        evidenceTags: [],
    }));

    it("moves toward a newer Top3 edge when the older edge is exhausted", () => {
        expect(selectStablePartialRankEdgeShift(rows([
            13, 12, 11, 10, 9, 2, 1, 4, 5, 8, 6, 7, 3,
        ]))).toBe(2);
    });

    it("moves toward an older Top3 edge when the newer edge is exhausted", () => {
        expect(selectStablePartialRankEdgeShift(rows([
            2, 3, 7, 8, 5, 4, 1, 6, 9, 10, 11, 12, 13,
        ]))).toBe(-2);
    });

    it("keeps a window whose ranked mass is not clipped at one edge", () => {
        expect(selectStablePartialRankEdgeShift(rows([
            6, 5, 4, 3, 2, 1, 7, 8, 9, 10, 11, 12, 13,
        ]))).toBe(0);
    });
});

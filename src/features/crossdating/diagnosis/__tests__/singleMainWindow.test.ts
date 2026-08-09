import { describe, expect, it } from "vitest";
import type { DiagnosisEvent } from "../types";
import {
    INTERNAL_EVENT_ENSEMBLE_OPTIONS,
    keepSingleMainWindow,
    selectFalseRingContinuedEdgeRecenterShift,
    selectFalseRingConsensusWindowShift,
} from "../eventEnsemble";

const event = (): DiagnosisEvent => {
    const alternative: DiagnosisEvent = {
        id: "alternate-operation",
        seriesId: "A",
        eventType: "falseRing",
        startYear: 1920,
        endYear: 1926,
        rankedYears: [{ year: 1923, rank: 1, score: 1, evidenceTags: [] }],
        confidenceLevel: "low",
        evidence: {
            algorithmSources: ["test"],
            score: 1,
            scoreMargin: 0,
            baselineCorrelation: 0,
            correctedCorrelation: 0.1,
            correlationGain: 0.1,
            lagBefore: 1,
            lagAfter: 0,
            samplePairs: 30,
            candidateIds: [],
            notes: [],
        },
        alternativeTypes: [],
    };
    return {
        ...alternative,
        id: "primary",
        eventType: "missingRing",
        startYear: 1900,
        endYear: 1906,
        rankedYears: [{ year: 1903, rank: 1, score: 2, evidenceTags: [] }],
        alternativeTypes: ["falseRing"],
        locationAlternatives: [{
            rank: 1,
            startYear: 1870,
            endYear: 1876,
            rankedYears: [{ year: 1873, rank: 1, score: 1, evidenceTags: [] }],
            evidenceScore: 1,
            scoreMargin: 0,
            algorithmSource: "test",
        }],
        operationAlternatives: [alternative],
    };
};

describe("single main diagnosis window", () => {
    it("uses the single-window recovery path in the internal diagnosis", () => {
        expect(
            INTERNAL_EVENT_ENSEMBLE_OPTIONS
                .eventOperationRecoveryConfig
                ?.outputSingleMainWindow,
        ).toBe(true);
    });

    it("removes every user-visible alternative without changing the primary", () => {
        const primary = {
            ...event(),
            reviewCoreRange: { startYear: 1901, endYear: 1905 },
        };
        const result = keepSingleMainWindow(primary);

        expect(result).toMatchObject({
            id: "primary",
            eventType: "missingRing",
            startYear: 1900,
            endYear: 1906,
            alternativeTypes: [],
        });
        expect(result.locationAlternatives).toBeUndefined();
        expect(result.operationAlternatives).toBeUndefined();
        expect(result.reviewCoreRange).toBeUndefined();
        expect(primary.locationAlternatives).toHaveLength(1);
        expect(primary.operationAlternatives).toHaveLength(1);
        expect(primary.reviewCoreRange).toEqual({ startYear: 1901, endYear: 1905 });
    });

    it("narrows a unique repeated-block boundary only in the final main window", () => {
        const primary = {
            ...event(),
            eventType: "partialMove" as const,
            startYear: 1896,
            endYear: 1904,
            rankedYears: Array.from({ length: 9 }, (_, index) => {
                const year = 1896 + index;
                return {
                    year,
                    rank: year === 1900 ? 1 : index + 2,
                    score: year === 1900 ? 2 : 1,
                    evidenceTags: ["unique_repeated_block_boundary"],
                };
            }),
            evidence: {
                ...event().evidence,
                algorithmSources: ["unique_repeated_block_boundary"],
                notes: ["repeated_block_boundary_year=1900"],
            },
        };

        const result = keepSingleMainWindow(primary);

        expect([result.startYear, result.endYear]).toEqual([1897, 1903]);
        expect(result.rankedYears).toHaveLength(7);
        expect(result.rankedYears[0]).toMatchObject({ year: 1900, rank: 1 });
        expect(primary.startYear).toBe(1896);
        expect(primary.endYear).toBe(1904);
    });

    it("narrows a negative partial move when six local views agree near Top1", () => {
        const primary = {
            ...event(),
            eventType: "partialMove" as const,
            shiftYears: -2,
            shiftSide: "older" as const,
            startYear: 1896,
            endYear: 1904,
            rankedYears: Array.from({ length: 9 }, (_, index) => {
                const year = 1896 + index;
                return {
                    year,
                    rank: year === 1900 ? 1 : index + 2,
                    score: year === 1900 ? 2 : 1,
                    evidenceTags: ["negative_partial_multiview_consensus"],
                };
            }),
            evidence: {
                ...event().evidence,
                algorithmSources: ["negative_partial_multiview_consensus"],
                notes: [
                    "partial_gap_raw31_year=1898",
                    "partial_gap_difference31_year=1899",
                    "partial_gap_whitened31_year=1900",
                    "partial_gap_combo31_year=1901",
                    "partial_gap_combo41_year=1902",
                    "partial_gap_combo61_year=1900",
                    "partial_gap_multiScale_year=1904",
                ],
            },
        };

        const result = keepSingleMainWindow(primary);

        expect([result.startYear, result.endYear]).toEqual([1897, 1903]);
        expect(result.rankedYears).toHaveLength(7);
        expect(result.rankedYears[0]).toMatchObject({ year: 1900, rank: 1 });
        expect(result.evidence.algorithmSources).toContain(
            "negative_partial_consensus_compact_window",
        );
        expect(result.evidence.notes).toContain(
            "negative_partial_compact_support=6",
        );
    });

    it("does not compact to seven years when only five negative-partial views agree", () => {
        const primary = {
            ...event(),
            eventType: "partialMove" as const,
            shiftYears: -2,
            shiftSide: "older" as const,
            startYear: 1896,
            endYear: 1904,
            rankedYears: Array.from({ length: 9 }, (_, index) => ({
                year: 1896 + index,
                rank: index === 4 ? 1 : index + 2,
                score: index === 4 ? 2 : 1,
                evidenceTags: [],
            })),
            evidence: {
                ...event().evidence,
                notes: [
                    "partial_gap_raw31_year=1898",
                    "partial_gap_difference31_year=1899",
                    "partial_gap_whitened31_year=1900",
                    "partial_gap_combo31_year=1901",
                    "partial_gap_combo41_year=1902",
                    "partial_gap_combo61_year=1904",
                    "partial_gap_multiScale_year=1896",
                ],
            },
        };

        const result = keepSingleMainWindow(primary);

        expect([result.startYear, result.endYear]).toEqual([1896, 1903]);
        expect(result.rankedYears).toHaveLength(8);
        expect(result.evidence.algorithmSources).not.toContain(
            "negative_partial_consensus_compact_window",
        );
        expect(result.evidence.algorithmSources).toContain(
            "partial_move_unsupported_newer_edge_trim",
        );
    });

    it("keeps the partial-move newer edge when Top1 is too close to it", () => {
        const primary = {
            ...event(),
            eventType: "partialMove" as const,
            shiftYears: -2,
            shiftSide: "older" as const,
            startYear: 1896,
            endYear: 1904,
            rankedYears: Array.from({ length: 9 }, (_, index) => ({
                year: 1896 + index,
                rank: index === 7 ? 1 : index + 2,
                score: index === 7 ? 2 : 1,
                evidenceTags: [],
            })),
            evidence: {
                ...event().evidence,
                notes: [
                    "partial_gap_raw31_year=1898",
                    "partial_gap_difference31_year=1899",
                    "partial_gap_whitened31_year=1900",
                    "partial_gap_combo31_year=1901",
                    "partial_gap_combo41_year=1902",
                    "partial_gap_combo61_year=1903",
                    "partial_gap_multiScale_year=1904",
                ],
            },
        };

        const result = keepSingleMainWindow(primary);

        expect([result.startYear, result.endYear]).toEqual([1896, 1904]);
        expect(result.rankedYears).toHaveLength(9);
    });

    it("shifts one false-ring main window without widening or changing Top1", () => {
        const primary = {
            ...event(),
            eventType: "falseRing" as const,
            startYear: 1900,
            endYear: 1906,
            rankedYears: Array.from({ length: 7 }, (_, index) => ({
                year: 1900 + index,
                rank: index === 3 ? 1 : index + 2,
                score: index === 3 ? 2 : 1,
                evidenceTags: [],
            })),
            evidence: {
                ...event().evidence,
                notes: [
                    "scan_top_year=1907",
                    "raw_path_top_year=1907",
                    "candidate_top_year=1907",
                    "direct_transition_year=1907",
                    "paired_breakpoint_year=1907",
                    "endpoint_residual_posterior_top_year=1907",
                    "unit_local_raw31_year=1907",
                    "unit_local_difference31_year=1907",
                ],
            },
        };

        expect(selectFalseRingConsensusWindowShift(primary)).toBe(1);
        const result = keepSingleMainWindow(primary);

        expect([result.startYear, result.endYear]).toEqual([1901, 1907]);
        expect(result.rankedYears).toHaveLength(7);
        expect(result.rankedYears[0]).toMatchObject({ year: 1903, rank: 1 });
        expect(result.evidence.notes).toContain("false_ring_window_shift=1");
    });

    it("ignores a false-ring candidate peak outside the local review area", () => {
        const primary = {
            ...event(),
            eventType: "falseRing" as const,
            startYear: 1900,
            endYear: 1906,
            rankedYears: [{ year: 1903, rank: 1, score: 2, evidenceTags: [] }],
            evidence: {
                ...event().evidence,
                notes: [
                    "scan_top_year=1930",
                    "raw_path_top_year=1930",
                    "candidate_top_year=1930",
                    "direct_transition_year=1930",
                    "paired_breakpoint_year=1930",
                    "endpoint_residual_posterior_top_year=1930",
                    "unit_local_raw31_year=1930",
                    "unit_local_difference31_year=1930",
                ],
            },
        };

        expect(selectFalseRingConsensusWindowShift(primary)).toBe(0);
        expect(keepSingleMainWindow(primary)).toMatchObject({
            startYear: 1900,
            endYear: 1906,
        });
    });

    it("keeps a false-ring edge supported by two independent signals", () => {
        const primary = {
            ...event(),
            eventType: "falseRing" as const,
            startYear: 1900,
            endYear: 1906,
            rankedYears: [{ year: 1903, rank: 1, score: 2, evidenceTags: [] }],
            evidence: {
                ...event().evidence,
                notes: [
                    "scan_top_year=1905",
                    "raw_path_top_year=1905",
                    "candidate_top_year=1905",
                    "direct_transition_year=1905",
                    "paired_breakpoint_year=1905",
                    "endpoint_residual_posterior_top_year=1905",
                    "unit_local_raw31_year=1900",
                    "unit_local_difference31_year=1900",
                ],
            },
        };

        expect(selectFalseRingConsensusWindowShift(primary)).toBe(0);
    });

    it("recenters one 9-year window after two same-direction edge advances", () => {
        const primary = {
            ...event(),
            eventType: "falseRing" as const,
            startYear: 1881,
            endYear: 1889,
            rankedYears: Array.from({ length: 9 }, (_, index) => ({
                year: 1881 + index,
                rank: index === 6 ? 1 : index + 2,
                score: index === 6 ? 2 : 1,
                evidenceTags: [],
            })),
            locationAlternatives: [{
                rank: 1,
                startYear: 1885,
                endYear: 1891,
                rankedYears: [],
                evidenceScore: 1,
                scoreMargin: 0,
                algorithmSource: "continued_edge_guard_location",
            }],
            evidence: {
                ...event().evidence,
                algorithmSources: [
                    "continued_edge_guard_location",
                    "edge_rank_guard",
                    "joint_event_counterfactual",
                ],
                notes: [
                    "window_refinement=joint_event_edge_nudge",
                    "window_before=1880-1886",
                    "window_refinement=edge_rank_guard",
                    "window_before=1881-1887",
                ],
            },
        };

        expect(selectFalseRingContinuedEdgeRecenterShift(primary)).toBe(2);
        const result = keepSingleMainWindow(primary);
        expect([result.startYear, result.endYear]).toEqual([1883, 1891]);
        expect(result.rankedYears[0]).toMatchObject({ year: 1887, rank: 1 });
        expect(result.locationAlternatives).toBeUndefined();
        expect(result.evidence.algorithmSources).toContain(
            "false_ring_continued_edge_recenter",
        );
    });

    it("does not recenter from one edge guard without the preceding advance", () => {
        const primary = {
            ...event(),
            eventType: "falseRing" as const,
            startYear: 1881,
            endYear: 1889,
            rankedYears: [{ year: 1887, rank: 1, score: 2, evidenceTags: [] }],
            evidence: {
                ...event().evidence,
                algorithmSources: [
                    "continued_edge_guard_location",
                    "edge_rank_guard",
                ],
                notes: [
                    "window_refinement=edge_rank_guard",
                    "window_before=1881-1887",
                ],
            },
        };

        expect(selectFalseRingContinuedEdgeRecenterShift(primary)).toBe(0);
        expect(keepSingleMainWindow(primary)).toMatchObject({
            startYear: 1881,
            endYear: 1889,
        });
    });
});

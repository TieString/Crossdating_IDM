import { describe, expect, it } from "vitest";
import {
    addUnitEventEvidenceEdgeGuard,
    addUnitEventRankEdgeGuard,
    refineStableUnitEventWithLocalConsensus,
    selectMissingRingNeighborYear,
    selectStableUnitLocalConsensus,
} from "../unitBreakpointRefinement";
import type { DiagnosisEvent, SeriesCoreDiagnosis } from "../types";

const eventFor = (
    startYear: number,
    endYear: number,
    topYear: number,
    notes: string[] = [],
): DiagnosisEvent => ({
    id: "unit",
    seriesId: "A",
    eventType: "missingRing",
    startYear,
    endYear,
    rankedYears: Array.from({ length: endYear - startYear + 1 }, (_, index) => {
        const year = startYear + index;
        return {
            year,
            rank: 0,
            score: year === topYear ? 10 : -Math.abs(year - topYear),
            evidenceTags: ["test"],
        };
    }).sort((a, b) => b.score - a.score)
        .map((row, index) => ({ ...row, rank: index + 1 })),
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: ["piecewise_lag_path"],
        score: 2,
        scoreMargin: 0.2,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.6,
        correlationGain: 0.4,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 60,
        candidateIds: [],
        notes,
    },
    alternativeTypes: [],
});

const diagnosis = {
    targetRange: { startYear: 1800, endYear: 2000 },
} as SeriesCoreDiagnosis;

describe("unit-event edge guards", () => {
    it("shifts a full-width window one year toward a boundary Top1", () => {
        const guarded = addUnitEventRankEdgeGuard(eventFor(1900, 1908, 1900), diagnosis);
        expect([guarded.startYear, guarded.endYear]).toEqual([1899, 1907]);
        expect(guarded.endYear - guarded.startYear + 1).toBe(9);
        expect(guarded.rankedYears[0].year).toBe(1900);
        expect(guarded.evidence.algorithmSources).toContain("edge_rank_guard");
    });

    it("adds one fixed-width continuation when a narrow window expands at an edge", () => {
        const guarded = addUnitEventRankEdgeGuard(eventFor(1900, 1906, 1900), diagnosis);
        expect([guarded.startYear, guarded.endYear]).toEqual([1898, 1906]);
        expect(guarded.locationAlternatives?.[0]).toMatchObject({
            startYear: 1896,
            endYear: 1902,
            algorithmSource: "continued_edge_guard_location",
        });
        const alternative = guarded.locationAlternatives?.[0];
        expect(alternative && alternative.endYear - alternative.startYear + 1).toBe(7);
    });

    it("uses independent edge evidence to shift a full-width window by two years", () => {
        const notes = [
            "unit_local_difference31_year=1900",
            "unit_local_whitened31_year=1899",
            "unit_local_combo31_year=1900",
            "unit_local_combo41_year=1898",
            "unit_local_combo61_year=1904",
            "unit_local_multiScale_year=1903",
        ];
        const guarded = addUnitEventEvidenceEdgeGuard(
            eventFor(1900, 1908, 1904, notes),
            diagnosis,
        );
        expect([guarded.startYear, guarded.endYear]).toEqual([1898, 1906]);
        expect(guarded.endYear - guarded.startYear + 1).toBe(9);
        expect(guarded.evidence.algorithmSources).toContain("evidence_edge_guard");
    });

    it("does not stack the evidence guard after the rank guard", () => {
        const rankGuarded = addUnitEventRankEdgeGuard(eventFor(1900, 1908, 1900), diagnosis);
        expect(addUnitEventEvidenceEdgeGuard(rankGuarded, diagnosis)).toBe(rankGuarded);
    });

    it("preserves a window already anchored by long-pulse reference consensus", () => {
        const event = eventFor(1900, 1908, 1900, [
            "unit_local_combo31_year=1908",
            "unit_local_combo41_year=1908",
            "unit_local_combo61_year=1908",
        ]);
        event.evidence.algorithmSources.push("long_pulse_consensus");

        expect(addUnitEventEvidenceEdgeGuard(event, diagnosis)).toBe(event);
    });
});

describe("missing-ring neighbour ranking", () => {
    it("moves Top1 one year when the short score and breakpoint consensus agree", () => {
        const selected = selectMissingRingNeighborYear([
            { year: 1898, combo11: -2 },
            { year: 1899, combo11: 2 },
            { year: 1900, combo11: 0 },
            { year: 1901, combo11: -1 },
            { year: 1902, combo11: 3 },
        ], 1900, 1899, 1899);
        expect(selected?.year).toBe(1899);
        expect(selected?.scoreMargin).toBeGreaterThanOrEqual(0.5);
        expect(selected?.consensusMargin).toBeGreaterThan(0);
    });

    it("keeps Top1 when the short score and breakpoint consensus disagree", () => {
        expect(selectMissingRingNeighborYear([
            { year: 1898, combo11: -2 },
            { year: 1899, combo11: 2 },
            { year: 1900, combo11: 0 },
            { year: 1901, combo11: -1 },
            { year: 1902, combo11: 3 },
        ], 1900, 1901, 1901)).toBeNull();
    });

    it("keeps Top1 when the short-score margin is weak", () => {
        expect(selectMissingRingNeighborYear([
            { year: 1898, combo11: -10 },
            { year: 1899, combo11: 0.1 },
            { year: 1900, combo11: 0 },
            { year: 1901, combo11: -0.1 },
            { year: 1902, combo11: 10 },
        ], 1900, 1899, 1899)).toBeNull();
    });
});

describe("stable unit local consensus", () => {
    it("does not apply zero-baseline scores to an intermediate lag transition", () => {
        const event = eventFor(1848, 1860, 1854);
        event.evidence.algorithmSources.push("stable_multiscale_bounded_path_frontier");
        event.evidence.lagBefore = -2;
        event.evidence.lagAfter = 0;
        event.evidence.notes.push("stable_bounded_path_component_lag_after=-1");

        expect(refineStableUnitEventWithLocalConsensus(
            event,
            diagnosis,
            new Map(),
        )).toBe(event);
    });

    it("selects the nearest center supported by three local score families", () => {
        const rows = Array.from({ length: 31 }, (_, index) => {
            const year = 1839 + index;
            return {
                year,
                combo21: year === 1843 ? 4 : 0,
                combo31: year === 1843 ? 4 : 0,
                multiScale: year === 1843 ? 4 : 0,
                pairMedian31: year === 1844 ? 4 : 0,
            };
        });

        expect(selectStableUnitLocalConsensus(rows, 1854)).toEqual({
            year: 1844,
            votes: 4,
            peakYears: [1843, 1843, 1843, 1844],
        });
    });

    it("rejects a two-channel location mode", () => {
        const rows = [
            {
                year: 1843,
                combo21: 4,
                combo31: 4,
                multiScale: 0,
                pairMedian31: 0,
            },
            {
                year: 1854,
                combo21: 0,
                combo31: 0,
                multiScale: 4,
                pairMedian31: 4,
            },
        ];

        expect(selectStableUnitLocalConsensus(rows, 1854)).toBeNull();
    });
});

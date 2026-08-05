import { describe, expect, it } from "vitest";
import {
    refineEventWithAdjacentBoundaryConsensus,
    selectAdjacentBoundaryShift,
} from "../eventBoundaryConsensus";
import type { DiagnosisEvent } from "../types";

const event = (): DiagnosisEvent => ({
    id: "event",
    seriesId: "TGT01a",
    eventType: "missingRing",
    startYear: 2009,
    endYear: 2021,
    seriesRange: { startYear: 1900, endYear: 2023 },
    rankedYears: Array.from({ length: 13 }, (_, index) => ({
        year: 2009 + index,
        rank: index + 1,
        score: 13 - index,
        evidenceTags: ["fixture"],
    })),
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: ["series_endpoint_review_window"],
        score: 1,
        scoreMargin: 0.2,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.6,
        correlationGain: 0.4,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 100,
        candidateIds: [],
        notes: [
            "scan_top_year=2008",
            "candidate_top_year=2009",
            "direct_transition_year=2007",
            "endpoint_residual_previous_top_year=2009",
            "endpoint_residual_posterior_top_year=2009",
        ],
    },
    alternativeTypes: [],
});

describe("final adjacent boundary consensus", () => {
    it("shifts an endpoint window with three older-edge votes", () => {
        expect(selectAdjacentBoundaryShift(event())).toMatchObject({
            shiftYears: -1,
            enteringYear: 2008,
            olderSupport: 5,
            rule: "adjacent_consensus",
        });
    });

    it("uses a stricter threshold for a non-endpoint newer shift", () => {
        const ordinary = event();
        ordinary.evidence.algorithmSources = ["full_interval_counterfactual_locator"];
        ordinary.evidence.notes = [
            "scan_top_year=2022",
            "candidate_top_year=2022",
            "endpoint_residual_previous_top_year=2021",
        ];
        expect(selectAdjacentBoundaryShift(ordinary)).toBeNull();
        ordinary.evidence.notes.push("reference_vote_year=2022");
        expect(selectAdjacentBoundaryShift(ordinary)?.shiftYears).toBe(1);
    });

    it("does not remove an exact posterior boundary", () => {
        const guarded = event();
        guarded.evidence.notes = [
            "scan_top_year=2008",
            "candidate_top_year=2008",
            "reference_vote_year=2008",
            "endpoint_residual_posterior_top_year=2021",
        ];
        expect(selectAdjacentBoundaryShift(guarded)).toBeNull();
    });

    it("accepts exact false-ring direct evidence outside the newer edge", () => {
        const falseRing = event();
        falseRing.eventType = "falseRing";
        falseRing.evidence.algorithmSources = ["full_interval_counterfactual_locator"];
        falseRing.evidence.notes = [
            "endpoint_residual_posterior_top_year=2022",
            "false_direct_consensus_candidate_year=2023",
        ];
        expect(selectAdjacentBoundaryShift(falseRing)).toMatchObject({
            shiftYears: 1,
            enteringYear: 2022,
            rule: "false_ring_direct_edge_consensus",
        });
    });

    it("keeps width stable and promotes the entering year", () => {
        const refined = refineEventWithAdjacentBoundaryConsensus(event());
        expect([refined.startYear, refined.endYear]).toEqual([2008, 2020]);
        expect(refined.rankedYears).toHaveLength(13);
        expect(refined.rankedYears[0]?.year).toBe(2008);
        expect(refined.rankedYears.some((row) => row.year === 2021)).toBe(false);
        expect(refined.evidence.algorithmSources).toContain(
            "adjacent_boundary_consensus",
        );
    });
});

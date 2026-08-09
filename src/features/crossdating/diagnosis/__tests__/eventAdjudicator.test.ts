import { describe, expect, it } from "vitest";
import {
    adjudicateLocatorProposal,
    locatorPreservesOperationContract,
} from "../eventAdjudicator";
import type { DiagnosisEvent } from "../types";

const event = (
    startYear: number,
    endYear: number,
    notes: string[] = [],
): DiagnosisEvent => ({
    id: `partial-${startYear}-${endYear}`,
    seriesId: "TARGET",
    eventType: "partialMove",
    startYear,
    endYear,
    rankedYears: [{
        year: Math.floor((startYear + endYear) / 2),
        rank: 1,
        score: 1,
        evidenceTags: [],
    }],
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: ["piecewise_lag_path"],
        score: 1,
        scoreMargin: 0.2,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.5,
        correlationGain: 0.3,
        lagBefore: -4,
        lagAfter: 0,
        samplePairs: 80,
        candidateIds: ["candidate-1"],
        notes,
    },
    alternativeTypes: [],
    shiftYears: -4,
    shiftSide: "older",
});

describe("event hypothesis locator adjudication", () => {
    it("accepts an overlapping locator proposal without changing operation identity", () => {
        const checkpoint = event(1795, 1803);
        const proposal = event(1797, 1805);
        const result = adjudicateLocatorProposal(checkpoint, proposal);

        expect(locatorPreservesOperationContract(checkpoint, proposal)).toBe(true);
        expect(result).toMatchObject({
            accepted: true,
            reason: "accepted_overlapping_mode",
            overlapYears: 7,
        });
        expect(result.event.startYear).toBe(1797);
    });

    it("falls back when a locator proposal changes operation or shift", () => {
        const checkpoint = event(1795, 1803);
        const proposal: DiagnosisEvent = {
            ...event(1797, 1805),
            eventType: "missingRing",
            shiftYears: -1,
        };
        const result = adjudicateLocatorProposal(checkpoint, proposal);

        expect(result).toMatchObject({
            accepted: false,
            reason: "fallback_operation_contract",
            operationContractValid: false,
        });
        expect(result.event).toMatchObject({
            eventType: "partialMove",
            shiftYears: -4,
            startYear: 1795,
            endYear: 1803,
        });
    });

    it("keeps the checkpoint when a detached mode lacks concentrated evidence", () => {
        const checkpoint = event(1795, 1803);
        const proposal = event(1805, 1817, [
            "counterfactual_window_concentration=0.40",
            "counterfactual_window_remote_margin=0.02",
            "counterfactual_coarse_overlap_consensus=0.30",
            "counterfactual_pair_reference_count=8",
        ]);
        const result = adjudicateLocatorProposal(checkpoint, proposal);

        expect(result).toMatchObject({
            accepted: false,
            reason: "fallback_detached_locator_mode",
            overlapYears: 0,
        });
        expect(result.event.startYear).toBe(1795);
        expect(result.event.evidence.notes).toContain(
            "locator_proposed_window=1805-1817",
        );
    });

    it("allows a detached mode only when several independent channels are strong", () => {
        const checkpoint = event(1795, 1803);
        const proposal = event(1805, 1817, [
            "counterfactual_window_concentration=0.72",
            "counterfactual_window_remote_margin=0.11",
            "counterfactual_coarse_overlap_consensus=0.67",
            "counterfactual_coarse_model_margin=0.10",
            "counterfactual_pair_reference_count=8",
        ]);
        const result = adjudicateLocatorProposal(checkpoint, proposal);

        expect(result).toMatchObject({
            accepted: true,
            reason: "accepted_detached_strong_mode",
            detachedEvidenceStrong: true,
        });
        expect(result.event.startYear).toBe(1805);
    });

    it("accepts a detached locator mode that wins independent location families", () => {
        const notes = [
            "profile_boundary_year=1858",
            "partial_reference_vote_year=1850",
            "partial_reference_vote_gain=0.411920",
            "partial_exhaustive_vote_year=1850",
            "partial_exhaustive_vote_gain=0.543880",
            "counterfactual_window_concentration=0.30",
            "counterfactual_window_remote_margin=0.01",
            "counterfactual_pair_reference_count=2",
        ];
        const checkpoint = event(1855, 1863, notes);
        const proposal = event(1848, 1852, notes);
        const result = adjudicateLocatorProposal(checkpoint, proposal);

        expect(result.evidence).toMatchObject({
            proposedLocationFamilyCount: 2,
            checkpointLocationFamilyCount: 1,
            locationFamilyAdvantage: 1,
            operationLocationGain: 0.54388,
        });
        expect(result).toMatchObject({
            accepted: true,
            reason: "accepted_detached_strong_mode",
        });
        expect(result.event).toMatchObject({
            startYear: 1848,
            endYear: 1852,
        });
    });
});

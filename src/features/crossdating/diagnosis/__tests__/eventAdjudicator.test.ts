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
    topYear = Math.floor((startYear + endYear) / 2),
    structured = false,
): DiagnosisEvent => ({
    id: `partial-${startYear}-${endYear}`,
    seriesId: "TARGET",
    eventType: "partialMove",
    startYear,
    endYear,
    rankedYears: [{
        year: topYear,
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
        locationEvidence: structured ? [{
            source: "test_locator",
            startYear,
            endYear,
            topYear,
            referenceCount: 5,
            concentration: null,
            remoteMargin: null,
            calibrated: false,
        }] : undefined,
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

    it("keeps a structured checkpoint when an overlapping weak locator widens it and degrades Top1", () => {
        const sharedNotes = [
            "paired_breakpoint_year=1902",
            "local_raw_boundary_year=1902",
            "reference_vote_year=1901",
        ];
        const checkpoint = event(1899, 1905, sharedNotes, 1902, true);
        const proposal = event(1893, 1905, [
            ...sharedNotes,
            "counterfactual_window_concentration=0",
            "counterfactual_window_remote_margin=0",
            "counterfactual_coarse_overlap_consensus=0",
            "counterfactual_pair_reference_count=10",
        ], 1898, true);
        const result = adjudicateLocatorProposal(checkpoint, proposal);

        expect(result).toMatchObject({
            accepted: false,
            reason: "fallback_overlapping_precision_regression",
            precisionRegression: true,
        });
        expect(result.event).toMatchObject({
            startYear: 1899,
            endYear: 1905,
        });
        expect(result.event.rankedYears[0]?.year).toBe(1902);
    });

    it("allows a precision-changing overlapping proposal when calibrated channels dominate", () => {
        const checkpoint = event(1899, 1905, [], 1902, true);
        const proposal = event(1897, 1909, [
            "counterfactual_window_concentration=0.72",
            "counterfactual_window_remote_margin=0.11",
            "counterfactual_coarse_overlap_consensus=0.67",
            "counterfactual_coarse_model_margin=0.10",
            "counterfactual_pair_reference_count=8",
        ], 1904, true);
        const result = adjudicateLocatorProposal(checkpoint, proposal);

        expect(result).toMatchObject({
            accepted: true,
            reason: "accepted_overlapping_strong_mode",
            precisionRegression: true,
        });
        expect(result.event.rankedYears[0]?.year).toBe(1904);
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

    it("lets a concentrated structured locator replace an unstructured remote checkpoint", () => {
        const checkpoint = event(1609, 1617, [], 1613, false);
        const proposal = event(1582, 1594, [
            "counterfactual_coarse_overlap_consensus=0.54",
        ], 1582, true);
        proposal.evidence.locationEvidence = [{
            source: "full_interval_counterfactual_locator",
            startYear: 1582,
            endYear: 1594,
            topYear: 1582,
            referenceCount: 16,
            concentration: 0.63,
            remoteMargin: 1.96,
            calibrated: false,
        }];
        const result = adjudicateLocatorProposal(checkpoint, proposal);

        expect(result.evidence).toMatchObject({
            structuredCheckpoint: false,
            structuredProposal: true,
            pairReferenceCount: 16,
        });
        expect(result).toMatchObject({
            accepted: true,
            reason: "accepted_detached_strong_mode",
            detachedEvidenceStrong: true,
        });
        expect(result.event).toMatchObject({
            startYear: 1582,
            endYear: 1594,
        });
    });

    it("accepts a remote unit window when candidate, transition and endpoint posterior agree", () => {
        const checkpoint = event(1608, 1614, [], 1612, false);
        const proposal = event(1575, 1581, [
            "candidate_top_year=1580",
            "candidate_top_probability=0.633216",
            "candidate_top_margin=0.811073",
            "direct_transition_year=1579",
            "endpoint_residual_posterior_top_year=1580",
            "endpoint_residual_reference_count=24",
        ], 1580, false);
        const result = adjudicateLocatorProposal(checkpoint, proposal);

        expect(result.evidence).toMatchObject({
            candidateTopYear: 1580,
            directTransitionYear: 1579,
            endpointPosteriorTopYear: 1580,
            endpointReferenceCount: 24,
        });
        expect(result).toMatchObject({
            accepted: true,
            reason: "accepted_detached_strong_mode",
            detachedEvidenceStrong: true,
        });
        expect(result.event.rankedYears[0]?.year).toBe(1580);
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

import { describe, expect, it } from "vitest";
import { attachNearEventClusterReview } from "../nearEventClusterReview";
import type { DiagnosisEvent, DiagnosisReviewEventCheckpoint } from "../types";

const makeEvent = (notes: string[], sources: string[] = [
    "sequential_missing_staircase_head",
]): DiagnosisEvent => ({
    id: "event",
    seriesId: "TARGET",
    eventType: "missingRing",
    startYear: 1898,
    endYear: 1906,
    rankedYears: [{ year: 1904, rank: 1, score: 1, evidenceTags: [] }],
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: sources,
        score: 1,
        scoreMargin: 0.1,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.5,
        correlationGain: 0.3,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 80,
        candidateIds: [],
        notes,
    },
    alternativeTypes: [],
    seriesRange: { startYear: 1700, endYear: 2000 },
});

const finalCheckpoint = (event: DiagnosisEvent): DiagnosisReviewEventCheckpoint => ({
    stage: "final",
    authority: "selected",
    event,
});

describe("near event cluster review", () => {
    it("projects a structured three-step unit path into one non-executable narrow window", () => {
        const event = makeEvent([
            "sequential_missing_unit_event_years=1901,1905,1909",
        ]);
        const result = attachNearEventClusterReview([finalCheckpoint(event)], event);

        expect(result).toMatchObject({
            startYear: 1901,
            endYear: 1909,
            reviewOnly: true,
            nearEventCluster: {
                eventCount: 3,
                evidenceYears: [1901, 1905, 1909],
                operationTypes: ["missingRing"],
                source: "sequentialUnitPath",
            },
        });
        expect(result?.evidence.notes).toContain("near_event_cluster_non_executable=true");
    });

    it("does not merge distant serial events into a cluster window", () => {
        const event = makeEvent([
            "sequential_missing_unit_event_years=1860,1900,1940",
        ]);
        expect(attachNearEventClusterReview([finalCheckpoint(event)], event)).toBe(event);
    });

    it("uses independently completed mixed boundaries as cluster evidence", () => {
        const event = makeEvent([
            "completed_mixed_unit_type=falseRing",
            "completed_mixed_older_boundary=1900",
            "completed_mixed_newer_boundary=1907",
            "completed_mixed_source_segment_anchored=true",
        ], ["completed_partial_false_composition"]);
        const result = attachNearEventClusterReview([finalCheckpoint(event)], event);
        expect(result).not.toBeNull();
        if (!result) throw new Error("expected a cluster review event");

        expect(result.nearEventCluster).toEqual({
            kind: "nearEventCluster",
            eventCount: 2,
            evidenceYears: [1900, 1907],
            operationTypes: ["falseRing", "partialMove"],
            source: "completedMixedCorrection",
        });
        expect(result.endYear - result.startYear + 1).toBe(9);
    });

    it("does not split an exact bounded partial through an unanchored mixed alias", () => {
        const event = makeEvent([
            "completed_mixed_unit_type=falseRing",
            "completed_mixed_older_boundary=1900",
            "completed_mixed_newer_boundary=1907",
            "completed_mixed_source_segment_anchored=false",
        ], ["bounded_complete_lag_path", "completed_partial_false_composition"]);
        event.eventType = "partialMove";
        event.shiftYears = -6;
        event.shiftSide = "older";
        event.evidence.lagBefore = -6;
        event.evidence.lagAfter = 0;

        expect(attachNearEventClusterReview([finalCheckpoint(event)], event)).toBe(event);
    });

    it("projects a validated compressed staircase with older-boundary uncertainty", () => {
        const event = makeEvent([
            "explicit_staircase_missing_years=1695,1689",
        ], [
            "compressed_missing_staircase_projection",
            "explicit_partial_vs_missing_staircase",
        ]);
        event.seriesRange = { startYear: 1600, endYear: 2000 };
        const result = attachNearEventClusterReview([finalCheckpoint(event)], event);

        expect(result).toMatchObject({
            startYear: 1688,
            endYear: 1696,
            reviewOnly: true,
            nearEventCluster: {
                eventCount: 2,
                evidenceYears: [1689, 1695],
                operationTypes: ["missingRing"],
                source: "explicitUnitStaircase",
            },
        });
    });
});

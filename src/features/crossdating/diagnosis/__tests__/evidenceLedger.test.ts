import { describe, expect, it } from "vitest";
import {
    evidenceClaimsFor,
    evidenceLedgerFor,
    locationEvidenceFor,
    operationEvidenceFor,
    withEvidenceLedger,
} from "../evidenceLedger";
import type { DiagnosisEvent } from "../types";

const event = (): DiagnosisEvent => ({
    id: "TARGET-missing-1902",
    seriesId: "TARGET",
    eventType: "missingRing",
    startYear: 1899,
    endYear: 1905,
    rankedYears: [{
        year: 1902,
        rank: 1,
        score: 1,
        evidenceTags: [],
    }],
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: [
            "sequential_missing_staircase_head",
            "robust_per_reference_missing_staircase",
        ],
        score: 1.2,
        scoreMargin: 0.3,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.5,
        correlationGain: 0.3,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 80,
        candidateIds: ["candidate-1"],
        notes: [
            "paired_breakpoint_reference_count=7",
            "joint_year_operation_evidence=true",
            "decisive_joint_operation_fusion",
        ],
        locationEvidence: [{
            source: "paired_core_breakpoint",
            startYear: 1899,
            endYear: 1905,
            topYear: 1902,
            referenceCount: 7,
            concentration: null,
            remoteMargin: 0.08,
            calibrated: false,
        }],
    },
    alternativeTypes: [],
});

describe("diagnosis evidence ledger", () => {
    it("normalizes operation, lag, location, reference and presence evidence", () => {
        const input = event();
        const ledger = evidenceLedgerFor(input);

        expect(ledger.version).toBe(1);
        expect(operationEvidenceFor(input)).toContainEqual(expect.objectContaining({
            kind: "operation",
            operationType: "missingRing",
            lagBefore: -1,
            lagAfter: 0,
            normalizedGain: 0.3,
        }));
        expect(locationEvidenceFor(input)).toEqual([
            expect.objectContaining({
                kind: "location",
                startYear: 1899,
                endYear: 1905,
                topYear: 1902,
                referenceCount: 7,
            }),
        ]);
        expect(ledger.entries).toContainEqual(expect.objectContaining({
            kind: "reference",
            referenceCount: 7,
            samplePairs: 80,
        }));
        expect(ledger.entries).toContainEqual(expect.objectContaining({
            kind: "presence",
            score: 1.2,
            scoreMargin: 0.3,
        }));
    });

    it("converts legacy source tokens into typed semantic claims once", () => {
        expect([...evidenceClaimsFor(event())].sort()).toEqual([
            "explicit_missing_staircase",
            "independent_reference_staircase",
            "joint_operation",
        ]);
    });

    it("is append-only and idempotent across repeated normalization", () => {
        const once = withEvidenceLedger(event());
        const twice = withEvidenceLedger(once);

        expect(twice.evidence.ledger).toEqual(once.evidence.ledger);
        expect(twice.evidence.locationEvidence).toEqual(
            once.evidence.locationEvidence,
        );
    });
});

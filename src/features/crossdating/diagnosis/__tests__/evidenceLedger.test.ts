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

    it("records when a sequential staircase fully explains an earlier whole baseline", () => {
        const resolved = event();
        resolved.evidence.algorithmSources.push(
            "sequential_missing_exhausts_whole_baseline",
        );

        expect(evidenceClaimsFor(resolved)).toContain(
            "whole_baseline_exhausted_by_missing_staircase",
        );
    });

    it("records a hard-gated unit resolution at the newer endpoint", () => {
        const endpoint = event();
        endpoint.startYear = 1998;
        endpoint.endYear = 2004;
        endpoint.seriesRange = { startYear: 1800, endYear: 2004 };
        endpoint.evidence.algorithmSources.push(
            "newer_endpoint_unit_alias_of_global_lag",
            "newer_endpoint_unit_competitor_of_global_lag",
        );
        endpoint.evidence.notes.push("candidate_hard_gate_passed");

        expect(evidenceClaimsFor(endpoint)).toContain("endpoint_unit_resolution");

        endpoint.endYear = 1970;
        expect(evidenceClaimsFor(endpoint)).not.toContain("endpoint_unit_resolution");
    });

    it("records an independently localized terminal unit as a fixed-side resolution", () => {
        const frontier = event();
        frontier.evidence.algorithmSources = [
            "counterfactual_window_refinement",
            "direct_terminal_unit_frontier_checkpoint",
            "joint_event_counterfactual",
            "piecewise_lag_path",
        ];
        frontier.evidence.notes = [
            "nominal_boundary_year=1902",
            "profile_boundary_year=1902",
        ];

        expect(evidenceClaimsFor(frontier)).toContain("fixed_side_resolution");

        frontier.evidence.notes[1] = "profile_boundary_year=1901";
        expect(evidenceClaimsFor(frontier)).not.toContain("fixed_side_resolution");
    });

    it("records a whole baseline resolved by a long fixed-side path", () => {
        const whole = event();
        whole.eventType = "wholeSeriesMove";
        whole.shiftYears = 50;
        whole.evidence.notes.push(
            "candidate_hard_gate_passed",
            "whole_baseline_source=path_fixed_side_lag",
            "path_fixed_side_newer_context_years=170",
        );

        expect(evidenceClaimsFor(whole)).toContain("whole_path_fixed_baseline");

        whole.evidence.notes = whole.evidence.notes.map((note) => (
            note === "path_fixed_side_newer_context_years=170"
                ? "path_fixed_side_newer_context_years=49"
                : note
        ));
        expect(evidenceClaimsFor(whole)).not.toContain("whole_path_fixed_baseline");
    });

    it("records a shorter fixed-side baseline when the newest state independently agrees", () => {
        const whole = event();
        whole.eventType = "wholeSeriesMove";
        whole.shiftYears = -2;
        whole.evidence.notes.push(
            "candidate_hard_gate_passed",
            "whole_baseline_source=path_fixed_side_lag",
            "path_fixed_side_newer_context_years=24",
            "whole_state_newest_lag=-2",
            "whole_state_newer_edge_support_fraction=0.500000",
        );

        expect(evidenceClaimsFor(whole)).toContain("whole_path_fixed_baseline");

        whole.evidence.notes = whole.evidence.notes.map((note) => (
            note === "whole_state_newest_lag=-2"
                ? "whole_state_newest_lag=-4"
                : note
        ));
        expect(evidenceClaimsFor(whole)).not.toContain("whole_path_fixed_baseline");
    });

    it("records a whole baseline resolved by a stable recent tail", () => {
        const whole = event();
        whole.eventType = "wholeSeriesMove";
        whole.shiftYears = -4;
        whole.evidence.notes.push(
            "candidate_hard_gate_passed",
            "whole_baseline_source=recent_tail_lag",
            "recent_tail_lag=-4",
            "recent_tail_path_lag=-4",
            "recent_tail_support_count=4",
            "recent_tail_total_count=4",
            "recent_tail_median_r=0.82",
            "recent_tail_path_margin=9.4",
            "whole_state_newer_edge_support_fraction=1.0",
            "whole_state_support_fraction=0.57",
        );

        expect(evidenceClaimsFor(whole)).toContain("whole_recent_tail_baseline");

        whole.evidence.notes = whole.evidence.notes.map((note) => (
            note === "recent_tail_support_count=4"
                ? "recent_tail_support_count=2"
                : note
        ));
        expect(evidenceClaimsFor(whole)).not.toContain(
            "whole_recent_tail_baseline",
        );
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

import { describe, expect, it } from "vitest";
import { adjudicateJointEventHypotheses } from "../jointEventAdjudicator";
import type {
    DiagnosisEvent,
    DiagnosisReviewEventCheckpoint,
    DiagnosisReviewSourceStage,
} from "../types";

const event = (
    id: string,
    eventType: DiagnosisEvent["eventType"],
    startYear: number,
    endYear: number,
    topYear: number,
    score = 1,
): DiagnosisEvent => ({
    id,
    seriesId: "TARGET",
    eventType,
    startYear,
    endYear,
    rankedYears: [{ year: topYear, rank: 1, score: 1, evidenceTags: [] }],
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: [],
        score,
        scoreMargin: score / 10,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.4,
        correlationGain: 0.2,
        lagBefore: eventType === "falseRing" ? 1 : -1,
        lagAfter: 0,
        samplePairs: 80,
        candidateIds: [id],
        notes: [],
    },
    alternativeTypes: [],
    ...(eventType === "partialMove" ? {
        shiftYears: -6,
        shiftSide: "older" as const,
    } : {}),
});

const checkpoint = (
    stage: DiagnosisReviewSourceStage,
    candidate: DiagnosisEvent,
): DiagnosisReviewEventCheckpoint => ({ stage, event: candidate });

describe("joint event adjudicator", () => {
    it("uses cross-stage survival instead of incomparable raw event scores", () => {
        const stable = event("stable", "missingRing", 1899, 1905, 1902, 0.4);
        const remoteRawPeak = event("raw-peak", "missingRing", 1940, 1952, 1946, 99);
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", stable),
            checkpoint("detected", stable),
            checkpoint("fused", stable),
            checkpoint("retained", stable),
            checkpoint("displayed", stable),
            checkpoint("final", stable),
            checkpoint("candidate", remoteRawPeak),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            reason: "selected",
            sourceStage: "final",
            event: {
                eventType: "missingRing",
                startYear: 1899,
                endYear: 1905,
            },
        });
        expect(decision.event?.evidence.candidateIds).toEqual(["stable"]);
    });

    it("selects the unique hard-gated candidate supported by raw path and direct transition", () => {
        const correctCandidate = event(
            "path-candidate",
            "missingRing",
            1577,
            1583,
            1580,
        );
        correctCandidate.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
        ];
        correctCandidate.evidence.notes = ["candidate_hard_gate_passed"];
        const adjacentCandidate = event(
            "adjacent-candidate",
            "missingRing",
            1569,
            1575,
            1572,
        );
        adjacentCandidate.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
        ];
        adjacentCandidate.evidence.notes = ["candidate_hard_gate_passed"];
        const remoteFinal = event(
            "remote-final",
            "missingRing",
            1498,
            1506,
            1500,
        );
        remoteFinal.evidence.notes = [
            "raw_path_top_year=1578",
            "direct_transition_year=1577",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", correctCandidate),
            checkpoint("candidate", adjacentCandidate),
            checkpoint("detected", remoteFinal),
            checkpoint("displayed", remoteFinal),
            checkpoint("final", remoteFinal),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "candidate",
            event: {
                id: "path-candidate",
                startYear: 1577,
                endYear: 1583,
            },
        });
        expect(decision.event?.evidence.algorithmSources).toContain(
            "path_transition_candidate_authority",
        );
    });

    it("keeps an independently localized final mode over a remote path candidate", () => {
        const candidate = event(
            "path-candidate",
            "missingRing",
            1577,
            1583,
            1580,
        );
        candidate.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
        ];
        candidate.evidence.notes = ["candidate_hard_gate_passed"];
        const finalEvent = event(
            "calibrated-final",
            "missingRing",
            1498,
            1506,
            1500,
        );
        finalEvent.evidence.notes = [
            "raw_path_top_year=1578",
            "direct_transition_year=1577",
        ];
        finalEvent.evidence.locationEvidence = [{
            source: "calibrated-test",
            startYear: 1498,
            endYear: 1506,
            topYear: 1500,
            referenceCount: 8,
            concentration: 0.8,
            remoteMargin: 0.2,
            calibrated: true,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", candidate),
            checkpoint("final", finalEvent),
        ]);

        expect(decision.event).toMatchObject({
            id: "calibrated-final",
            startYear: 1498,
            endYear: 1506,
        });
    });

    it("does not promote a candidate when the path anchors disagree", () => {
        const candidate = event(
            "path-candidate",
            "missingRing",
            1577,
            1583,
            1580,
        );
        candidate.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
        ];
        candidate.evidence.notes = ["candidate_hard_gate_passed"];
        const finalEvent = event(
            "remote-final",
            "missingRing",
            1498,
            1506,
            1500,
        );
        finalEvent.evidence.notes = [
            "raw_path_top_year=1578",
            "direct_transition_year=1581",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", candidate),
            checkpoint("final", finalEvent),
        ]);

        expect(decision.event).toMatchObject({
            id: "remote-final",
            startYear: 1498,
            endYear: 1506,
        });
    });

    it("selects a unique hard-gated candidate whose window reaches the bark endpoint", () => {
        const endpointCandidate = event(
            "endpoint-candidate",
            "missingRing",
            1987,
            1993,
            1990,
        );
        endpointCandidate.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
        ];
        endpointCandidate.evidence.notes = ["candidate_hard_gate_passed"];
        endpointCandidate.evidence.lagBefore = 0;
        endpointCandidate.evidence.lagAfter = -1;
        endpointCandidate.seriesRange = { startYear: 1700, endYear: 1994 };
        const olderCandidate = event(
            "older-candidate",
            "missingRing",
            1975,
            1981,
            1978,
        );
        olderCandidate.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
        ];
        olderCandidate.evidence.notes = ["candidate_hard_gate_passed"];
        const remoteFinal = event(
            "remote-final",
            "missingRing",
            1784,
            1796,
            1795,
        );
        remoteFinal.seriesRange = { startYear: 1700, endYear: 1994 };

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", endpointCandidate),
            checkpoint("candidate", olderCandidate),
            checkpoint("final", remoteFinal),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "candidate",
            event: {
                id: "endpoint-candidate",
                startYear: 1987,
                endYear: 1993,
            },
        });
        expect(decision.event?.evidence.algorithmSources).toContain(
            "endpoint_candidate_location_authority",
        );
    });

    it("does not promote a remote candidate whose window stops short of the endpoint", () => {
        const candidate = event(
            "near-end-candidate",
            "missingRing",
            1985,
            1991,
            1988,
        );
        candidate.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
        ];
        candidate.evidence.notes = ["candidate_hard_gate_passed"];
        const remoteFinal = event(
            "remote-final",
            "missingRing",
            1784,
            1796,
            1795,
        );
        remoteFinal.seriesRange = { startYear: 1700, endYear: 1994 };

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", candidate),
            checkpoint("final", remoteFinal),
        ]);

        expect(decision.event).toMatchObject({
            id: "remote-final",
            startYear: 1784,
            endYear: 1796,
        });
    });

    it("keeps the persisted local window when a final-only nearby variant arrives later", () => {
        const persisted = event("persisted", "missingRing", 1899, 1905, 1902);
        const finalOnly = event("final-only", "missingRing", 1902, 1908, 1905);
        finalOnly.confidenceLevel = "high";
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", persisted),
            checkpoint("detected", persisted),
            checkpoint("fused", persisted),
            checkpoint("retained", persisted),
            checkpoint("displayed", persisted),
            checkpoint("final", persisted),
            checkpoint("final", finalOnly),
        ]);

        expect(decision.event).toMatchObject({
            startYear: 1899,
            endYear: 1905,
        });
    });

    it("does not asymmetrically narrow an unlocated sequential window below its support", () => {
        const supported = event("supported", "missingRing", 1612, 1618, 1615);
        supported.evidence.algorithmSources = ["piecewise_lag_path"];
        const narrowed = event("narrowed", "missingRing", 1614, 1618, 1616);
        narrowed.evidence.algorithmSources = ["sequential_missing_staircase_head"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", supported),
            checkpoint("final", narrowed),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "detected",
            event: { startYear: 1612, endYear: 1618, eventType: "missingRing" },
        });
    });

    it("keeps a calibrated final five-year sequential window", () => {
        const supported = event("supported", "missingRing", 1612, 1618, 1615);
        const calibrated = event("calibrated", "missingRing", 1614, 1618, 1616);
        calibrated.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        calibrated.evidence.locationEvidence = [{
            source: "calibrated-test",
            startYear: 1614,
            endYear: 1618,
            topYear: 1616,
            referenceCount: 8,
            concentration: 0.8,
            remoteMargin: 0.2,
            calibrated: true,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", supported),
            checkpoint("final", calibrated),
        ]);

        expect(decision.event).toMatchObject({ startYear: 1614, endYear: 1618 });
    });

    it("keeps a hard-gated bark endpoint candidate from weak older recentering", () => {
        const candidate = event("endpoint-candidate", "missingRing", 1996, 2002, 2002);
        candidate.seriesRange = { startYear: 1785, endYear: 2002 };
        candidate.evidence.algorithmSources = ["candidate_ranking", "local_edit_alignment"];
        candidate.evidence.notes = ["candidate_hard_gate_passed"];
        const recentered = event("endpoint-recentered", "missingRing", 1994, 2000, 2000);
        recentered.seriesRange = { startYear: 1785, endYear: 2002 };
        recentered.evidence.algorithmSources = [
            "newer_endpoint_unit_alias_of_global_lag",
            "counterfactual_window_refinement",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", candidate),
            checkpoint("final", recentered),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "candidate",
            event: { startYear: 1996, endYear: 2002, eventType: "missingRing" },
        });
    });

    it("keeps a protected candidate frontier when final synthesis returns to a remote plateau", () => {
        const checkpointEvent = event(
            "candidate-frontier",
            "missingRing",
            1969,
            1981,
            1977,
        );
        checkpointEvent.evidence.algorithmSources = ["candidate_frontier_checkpoint"];
        checkpointEvent.evidence.notes = ["candidate_hard_gate_passed"];
        checkpointEvent.evidence.lagBefore = -1;
        checkpointEvent.evidence.lagAfter = -1;
        const remoteFinal = event(
            "remote-final",
            "missingRing",
            1845,
            1851,
            1851,
        );
        remoteFinal.evidence.algorithmSources = [
            "decisive_joint_operation_fusion",
            "joint_year_operation_evidence",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("displayed", checkpointEvent),
            checkpoint("final", remoteFinal),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "displayed",
            event: {
                eventType: "missingRing",
                startYear: 1969,
                endYear: 1981,
            },
        });
    });

    it("keeps a hard-gated unit location that persisted from candidate through display", () => {
        const checkpointEvent = event(
            "candidate-frontier",
            "missingRing",
            1947,
            1953,
            1950,
        );
        checkpointEvent.evidence.algorithmSources = [
            "candidate_ranking",
            "cofecha_boundary_checkpoint",
        ];
        checkpointEvent.evidence.notes = ["candidate_hard_gate_passed"];
        // Segment lags describe the surrounding diagnostic blocks, not a unit transition.
        checkpointEvent.evidence.lagBefore = -1;
        checkpointEvent.evidence.lagAfter = -3;
        const relocatedFinal = event(
            "sequential-relocation",
            "missingRing",
            1936,
            1948,
            1942,
        );
        relocatedFinal.evidence.algorithmSources = ["sequential_missing_staircase_head"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", checkpointEvent),
            checkpoint("displayed", checkpointEvent),
            checkpoint("final", checkpointEvent),
            checkpoint("final", relocatedFinal),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                startYear: 1947,
                endYear: 1953,
            },
        });
    });

    it("does not admit a hard-gated unit location that never reached display", () => {
        const unreviewed = event(
            "unreviewed-candidate",
            "missingRing",
            1947,
            1953,
            1950,
        );
        unreviewed.evidence.algorithmSources = ["candidate_ranking"];
        unreviewed.evidence.notes = ["candidate_hard_gate_passed"];
        unreviewed.evidence.lagBefore = -1;
        unreviewed.evidence.lagAfter = -3;
        const finalEvent = event(
            "final",
            "missingRing",
            1936,
            1948,
            1942,
        );

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", unreviewed),
            checkpoint("final", finalEvent),
        ]);

        expect(decision.event).toMatchObject({
            startYear: 1936,
            endYear: 1948,
        });
    });

    it("uses cross-stage location persistence instead of operation claims to place a unit event", () => {
        const persisted = event("persisted", "missingRing", 1841, 1849, 1843);
        const relocated = event("relocated", "missingRing", 1852, 1856, 1854);
        relocated.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        const stages: DiagnosisReviewSourceStage[] = [
            "candidate", "detected", "fused", "retained", "displayed", "final",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            ...stages.map((stage) => checkpoint(stage, persisted)),
            checkpoint("final", relocated),
        ]);

        expect(decision.event).toMatchObject({
            startYear: 1841,
            endYear: 1849,
        });
    });

    it("lets independent final location evidence supersede a protected candidate frontier", () => {
        const checkpointEvent = event(
            "candidate-frontier",
            "missingRing",
            1969,
            1981,
            1977,
        );
        checkpointEvent.evidence.algorithmSources = ["candidate_frontier_checkpoint"];
        checkpointEvent.evidence.notes = ["candidate_hard_gate_passed"];
        checkpointEvent.evidence.lagBefore = -1;
        checkpointEvent.evidence.lagAfter = -1;
        const independentlyLocated = event(
            "independent-final",
            "missingRing",
            1845,
            1851,
            1851,
        );
        independentlyLocated.evidence.algorithmSources = [
            "sequential_missing_staircase_head",
            "robust_per_reference_missing_staircase",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("displayed", checkpointEvent),
            checkpoint("final", independentlyLocated),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                startYear: 1845,
                endYear: 1851,
            },
        });
    });

    it("refuses equally supported incompatible operations", () => {
        const missing = event("missing", "missingRing", 1899, 1905, 1902);
        const falseRing = event("false", "falseRing", 1899, 1905, 1902);
        const stages: DiagnosisReviewSourceStage[] = [
            "candidate", "detected", "fused", "retained",
        ];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            ...stages.map((stage) => checkpoint(stage, missing)),
            ...stages.map((stage) => checkpoint(stage, falseRing)),
        ]);

        expect(decision).toMatchObject({
            status: "refused",
            reason: "operation_conflict",
            event: null,
            operationMargin: 0,
        });
    });

    it("refuses equally supported remote modes of the same operation", () => {
        const older = event("older", "missingRing", 1799, 1805, 1802);
        const newer = event("newer", "missingRing", 1899, 1905, 1902);
        const stages: DiagnosisReviewSourceStage[] = [
            "candidate", "detected", "fused", "retained",
        ];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            ...stages.map((stage) => checkpoint(stage, older)),
            ...stages.map((stage) => checkpoint(stage, newer)),
        ]);

        expect(decision).toMatchObject({
            status: "refused",
            reason: "remote_mode_conflict",
            event: null,
            remoteModeMargin: 0,
        });
    });

    it("returns one complete immutable hypothesis and audits production agreement", () => {
        const selected = event("selected", "partialMove", 1899, 1905, 1902);
        const production = { ...selected, startYear: 1900, endYear: 1906 };
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("displayed", selected),
            checkpoint("final", selected),
        ], production);

        expect(decision).toMatchObject({
            status: "selected",
            productionAgreement: "same",
            productionExactMatch: false,
            event: {
                eventType: "partialMove",
                shiftYears: -6,
                shiftSide: "older",
                startYear: 1899,
                endYear: 1905,
            },
        });
        expect(decision.event?.evidence.candidateIds).toEqual(["selected"]);
        expect(decision.hypotheses).toHaveLength(1);
    });

    it("selects the newest final serial mode without treating older events as conflicts", () => {
        const olderPartial = event("older-partial", "partialMove", 1700, 1712, 1706);
        const olderFalse = event("older-false", "falseRing", 1790, 1798, 1794);
        const frontierFalse = event("frontier-false", "falseRing", 1810, 1818, 1814);
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("final", olderPartial),
            checkpoint("final", olderFalse),
            checkpoint("final", frontierFalse),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                eventType: "falseRing",
                startYear: 1810,
                endYear: 1818,
            },
        });
    });

    it("still refuses incompatible operations inside the same final frontier", () => {
        const missing = event("missing", "missingRing", 1899, 1905, 1902);
        const falseRing = event("false", "falseRing", 1900, 1906, 1903);
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("final", missing),
            checkpoint("final", falseRing),
        ]);

        expect(decision).toMatchObject({
            status: "refused",
            reason: "operation_conflict",
            event: null,
        });
    });

    it("lets a sequential head resolve an unverified whole alias", () => {
        const whole = event("whole", "wholeSeriesMove", 1600, 2000, 0);
        whole.shiftYears = -5;
        const genericHead = event("generic-head", "missingRing", 1899, 1905, 1902);
        genericHead.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("final", whole),
            checkpoint("final", genericHead),
        ]);

        expect(decision.event?.eventType).toBe("missingRing");
    });

    it("allows independent per-reference missing evidence to resolve a whole alias", () => {
        const whole = event("whole", "wholeSeriesMove", 1600, 2000, 0);
        whole.shiftYears = -5;
        const independent = event("independent", "missingRing", 1899, 1905, 1902);
        independent.evidence.algorithmSources = [
            "per_reference_intermediate_lag_consensus",
        ];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("final", whole),
            checkpoint("final", independent),
        ]);

        expect(decision.event?.eventType).toBe("missingRing");
    });

    it("retains an earlier terminal whole baseline when final synthesis drops it", () => {
        const whole = event("terminal-whole", "wholeSeriesMove", 1600, 2000, 0);
        whole.shiftYears = -5;
        whole.evidence.notes = [
            "whole_baseline_source=cofecha_terminal_lag",
            "cofecha_terminal_segments=3",
            "cofecha_terminal_consistency=1.000000",
        ];
        const genericHead = event("generic-head", "missingRing", 1899, 1905, 1902);
        genericHead.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", whole),
            checkpoint("final", genericHead),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "detected",
            event: { eventType: "wholeSeriesMove", shiftYears: -5 },
        });
    });

    it("applies a protected whole baseline before an exact local path", () => {
        const whole = event("terminal-whole", "wholeSeriesMove", 1600, 2000, 0);
        whole.shiftYears = -4;
        whole.evidence.notes = [
            "whole_baseline_source=cofecha_terminal_lag",
            "cofecha_terminal_segments=3",
            "cofecha_terminal_consistency=1.000000",
        ];
        const local = event("exact-local", "partialMove", 1910, 1918, 1914);
        local.shiftYears = -6;
        local.evidence.lagBefore = -6;
        local.evidence.lagAfter = 0;
        local.evidence.algorithmSources = ["cumulative_lag_path_frontier"];
        local.evidence.notes = [
            "cumulative_path_baseline_lag=-4",
            "cumulative_path_component_shift=-6",
            "cumulative_path_transition_count=2",
        ];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", whole),
            checkpoint("final", local),
        ]);

        expect(decision).toMatchObject({
            sourceStage: "detected",
            event: { eventType: "wholeSeriesMove", shiftYears: -4 },
        });
    });

    it("does not resurrect a terminal whole baseline already explained by a missing staircase", () => {
        const whole = event("terminal-whole", "wholeSeriesMove", 1600, 2000, 0);
        whole.shiftYears = -5;
        whole.evidence.notes = [
            "whole_baseline_source=cofecha_terminal_lag",
            "cofecha_terminal_segments=3",
            "cofecha_terminal_consistency=1.000000",
        ];
        const resolvedHead = event("resolved-head", "missingRing", 1899, 1905, 1902);
        resolvedHead.evidence.algorithmSources = [
            "sequential_missing_staircase_head",
            "sequential_missing_exhausts_whole_baseline",
        ];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", whole),
            checkpoint("final", resolvedHead),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: { eventType: "missingRing" },
        });
    });

    it("resolves a terminal unit whole alias only after fixed-side evidence exhausts it", () => {
        const whole = event("terminal-unit", "wholeSeriesMove", 1600, 2000, 0);
        whole.shiftYears = -1;
        whole.evidence.notes = [
            "whole_baseline_source=cofecha_terminal_lag",
            "cofecha_terminal_segments=3",
            "cofecha_terminal_consistency=1.000000",
        ];
        const endpoint = event("endpoint", "missingRing", 1994, 2000, 1999);
        endpoint.evidence.algorithmSources = [
            "sequential_missing_staircase_head",
            "sequential_missing_exhausts_whole_baseline",
        ];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", whole),
            checkpoint("final", endpoint),
        ]);

        expect(decision.event?.eventType).toBe("missingRing");
    });

    it("keeps the final baseline-exhausting endpoint window inside a persisted unit cluster", () => {
        const whole = event("terminal-unit", "wholeSeriesMove", 1768, 2002, 0);
        whole.shiftYears = -1;
        whole.evidence.notes = [
            "whole_baseline_source=cofecha_terminal_lag",
            "cofecha_terminal_segments=2",
            "cofecha_terminal_consistency=1.000000",
        ];
        const persisted = event("persisted-unit", "missingRing", 1995, 2001, 1997);
        persisted.evidence.notes = ["candidate_hard_gate_passed"];
        const resolved = event("resolved-endpoint", "missingRing", 1998, 2002, 2002);
        resolved.confidenceLevel = "high";
        resolved.evidence.algorithmSources = [
            "sequential_missing_staircase_head",
            "sequential_missing_exhausts_whole_baseline",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", persisted),
            checkpoint("detected", persisted),
            checkpoint("fused", persisted),
            checkpoint("retained", persisted),
            checkpoint("displayed", whole),
            checkpoint("displayed", persisted),
            checkpoint("final", persisted),
            checkpoint("final", resolved),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                id: "resolved-endpoint",
                eventType: "missingRing",
                startYear: 1998,
                endYear: 2002,
            },
        });
    });

    it("keeps a terminal unit whole but exposes a reviewed endpoint missing interpretation", () => {
        const whole = event("terminal-unit", "wholeSeriesMove", 1600, 2000, 0);
        whole.shiftYears = -1;
        whole.evidence.notes = [
            "whole_baseline_source=cofecha_terminal_lag",
            "cofecha_terminal_segments=3",
            "cofecha_terminal_consistency=1.000000",
        ];
        const endpoint = event("endpoint", "missingRing", 1994, 2000, 1999);
        endpoint.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", whole),
            checkpoint("final", endpoint),
        ]);

        expect(decision.event).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: -1,
            interpretationAmbiguity: {
                kind: "wholeSeriesMoveOrMissingRing",
                alternative: {
                    eventType: "missingRing",
                    startYear: 1994,
                    endYear: 2000,
                },
            },
        });
    });

    it("exposes a hard-gated near-bark candidate as the missing-ring interpretation", () => {
        const whole = event("terminal-unit", "wholeSeriesMove", 1732, 1994, 0);
        whole.shiftYears = -1;
        whole.evidence.notes = [
            "whole_baseline_source=cofecha_terminal_lag",
            "cofecha_terminal_segments=2",
            "cofecha_terminal_consistency=1.000000",
        ];
        const endpoint = event("endpoint-candidate", "missingRing", 1987, 1993, 1990);
        endpoint.evidence.algorithmSources = [
            "candidate_ranking",
            "cofecha_segment_lag",
            "local_edit_alignment",
            "segmented_diagnosis",
        ];
        endpoint.evidence.notes = ["candidate_hard_gate_passed"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", whole),
            checkpoint("candidate", endpoint),
            checkpoint("detected", whole),
            checkpoint("displayed", whole),
            checkpoint("final", whole),
        ]);

        expect(decision.event).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: -1,
            interpretationAmbiguity: {
                kind: "wholeSeriesMoveOrMissingRing",
                alternative: {
                    id: "endpoint-candidate",
                    eventType: "missingRing",
                    startYear: 1987,
                    endYear: 1993,
                },
            },
        });
    });

    it("does not expose a remote candidate as a bark-end missing interpretation", () => {
        const whole = event("terminal-unit", "wholeSeriesMove", 1732, 1994, 0);
        whole.shiftYears = -1;
        whole.evidence.notes = [
            "whole_baseline_source=cofecha_terminal_lag",
            "cofecha_terminal_segments=2",
            "cofecha_terminal_consistency=1.000000",
        ];
        const remote = event("remote-candidate", "missingRing", 1957, 1963, 1960);
        remote.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
        ];
        remote.evidence.notes = ["candidate_hard_gate_passed"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", remote),
            checkpoint("final", whole),
        ]);

        expect(decision.event).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: -1,
        });
        expect(decision.event?.interpretationAmbiguity).toBeUndefined();
    });

    it("selects a hard-gated endpoint unit hypothesis over its terminal -1 alias", () => {
        const whole = event("terminal-unit", "wholeSeriesMove", 1800, 2004, 0);
        whole.shiftYears = -1;
        whole.evidence.notes = [
            "whole_baseline_source=cofecha_terminal_lag",
            "cofecha_terminal_segments=3",
            "cofecha_terminal_consistency=1.000000",
        ];
        const endpoint = event("endpoint", "missingRing", 1998, 2004, 2002);
        endpoint.seriesRange = { startYear: 1800, endYear: 2004 };
        endpoint.evidence.algorithmSources = [
            "newer_endpoint_unit_alias_of_global_lag",
            "newer_endpoint_unit_competitor_of_global_lag",
        ];
        endpoint.evidence.notes = ["candidate_hard_gate_passed"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("displayed", whole),
            checkpoint("final", whole),
            checkpoint("final", endpoint),
        ]);

        expect(decision.event).toMatchObject({
            eventType: "missingRing",
            startYear: 1998,
            endYear: 2004,
        });
    });

    it("does not reinterpret a terminal whole from an unreviewed endpoint alias", () => {
        const whole = event("terminal-unit", "wholeSeriesMove", 1800, 2004, 0);
        whole.shiftYears = -1;
        whole.evidence.notes = [
            "whole_baseline_source=cofecha_terminal_lag",
            "cofecha_terminal_segments=3",
            "cofecha_terminal_consistency=1.000000",
        ];
        const endpoint = event("endpoint", "missingRing", 1998, 2004, 2002);
        endpoint.seriesRange = { startYear: 1800, endYear: 2004 };
        endpoint.evidence.algorithmSources = [
            "newer_endpoint_unit_alias_of_global_lag",
            "newer_endpoint_unit_competitor_of_global_lag",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("final", whole),
            checkpoint("final", endpoint),
        ]);

        expect(decision.event).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: -1,
        });
        expect(decision.event?.interpretationAmbiguity).toBeUndefined();
    });
});

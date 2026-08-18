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
    it("removes a positive whole-series hypothesis before operation adjudication", () => {
        const local = event("local", "missingRing", 1898, 1906, 1902);
        const positiveWhole = {
            ...event("positive-whole", "wholeSeriesMove", 1700, 2000, 2000, 99),
            shiftYears: 20,
        };
        positiveWhole.evidence.lagBefore = 20;
        positiveWhole.evidence.algorithmSources = ["dominant_whole_state_consensus"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", positiveWhole),
            checkpoint("displayed", positiveWhole),
            { ...checkpoint("final", positiveWhole), authority: "selected" },
            checkpoint("detected", local),
            checkpoint("displayed", local),
            { ...checkpoint("final", local), authority: "selected" },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            event: {
                id: "local",
                eventType: "missingRing",
            },
        });
        expect(decision.hypotheses).not.toContainEqual(expect.objectContaining({
            eventType: "wholeSeriesMove",
        }));
    });

    it("still allows an exact negative whole-series hypothesis", () => {
        const negativeWhole = {
            ...event("negative-whole", "wholeSeriesMove", 1700, 2000, 2000),
            shiftYears: -20,
        };
        negativeWhole.evidence.lagBefore = -20;

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", negativeWhole),
            { ...checkpoint("final", negativeWhole), authority: "selected" },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            event: {
                eventType: "wholeSeriesMove",
                shiftYears: -20,
            },
        });
    });

    it("establishes a durable path-fixed whole frame before an unresolved local aggregate", () => {
        const whole = {
            ...event("path-fixed-whole", "wholeSeriesMove", 1600, 2000, 2000),
            shiftYears: -11,
        };
        whole.evidence.notes = [
            "candidate_hard_gate_passed",
            "whole_baseline_source=path_fixed_side_lag",
            "path_fixed_side_lag=-11",
            "path_fixed_side_event_type=falseRing",
            "path_fixed_side_transition=-10->-11",
            "path_fixed_side_newer_context_years=158",
        ];
        const aggregate = event("aggregate-alias", "partialMove", 1819, 1831, 1828);
        aggregate.shiftYears = -10;
        aggregate.evidence.lagBefore = -10;
        aggregate.evidence.lagAfter = 0;
        aggregate.evidence.algorithmSources = ["bounded_complete_lag_path"];
        aggregate.evidence.notes = ["bounded_path_complete_hypothesis=true"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", whole),
            checkpoint("fused", whole),
            checkpoint("retained", whole),
            checkpoint("displayed", whole),
            { stage: "final", authority: "selected", event: aggregate },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            event: {
                id: "path-fixed-whole",
                eventType: "wholeSeriesMove",
                shiftYears: -11,
            },
        });
        expect(decision.event?.evidence.algorithmSources).toContain(
            "durable_whole_frame_priority",
        );
    });

    it("keeps an exact local transition that lands on a durable whole frame", () => {
        const whole = {
            ...event("path-fixed-whole", "wholeSeriesMove", 1600, 2000, 2000),
            shiftYears: -11,
        };
        whole.evidence.notes = [
            "candidate_hard_gate_passed",
            "whole_baseline_source=path_fixed_side_lag",
            "path_fixed_side_lag=-11",
            "path_fixed_side_event_type=falseRing",
            "path_fixed_side_transition=-10->-11",
            "path_fixed_side_newer_context_years=158",
        ];
        const local = event("bounded-false", "falseRing", 1819, 1831, 1825);
        local.evidence.lagBefore = -10;
        local.evidence.lagAfter = -11;
        local.evidence.algorithmSources = ["bounded_complete_lag_path"];
        local.evidence.notes = [
            "bounded_path_complete_hypothesis=true",
            "bounded_path_location_concentration=0.8",
            "bounded_path_runner_up_margin=0.4",
        ];
        local.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1819,
            endYear: 1831,
            topYear: 1825,
            referenceCount: 8,
            concentration: 0.8,
            remoteMargin: 0.4,
            calibrated: false,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", whole),
            checkpoint("fused", whole),
            checkpoint("retained", whole),
            checkpoint("displayed", whole),
            { stage: "final", authority: "supplemental", event: local },
            { stage: "final", authority: "selected", event: local },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            event: {
                id: "bounded-false",
                eventType: "falseRing",
            },
        });
    });

    it("uses a stronger global whole candidate over an unsupported off-by-one frame", () => {
        const pathFixed = {
            ...event("path-fixed-minus-10", "wholeSeriesMove", 1600, 2000, 2000),
            shiftYears: -10,
        };
        pathFixed.confidenceLevel = "medium";
        pathFixed.evidence.correlationGain = 0.07;
        pathFixed.evidence.notes = [
            "candidate_hard_gate_passed",
            "whole_baseline_source=path_fixed_side_lag",
            "path_fixed_side_lag=-10",
            "path_fixed_side_newer_context_years=83",
            "whole_state_support_fraction=0.000000",
        ];
        const global = {
            ...event("global-minus-11", "wholeSeriesMove", 1600, 2000, 2000),
            shiftYears: -11,
        };
        global.confidenceLevel = "high";
        global.evidence.correlationGain = 0.34;
        global.evidence.notes = [
            "candidate_hard_gate_passed",
            "whole_observed_dominant_lag=-11",
            "whole_state_support_fraction=0.583333",
            "whole_state_weighted_support_fraction=0.598883",
            "whole_state_newer_edge_support_fraction=1.000000",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", global),
            { stage: "final", authority: "selected", event: pathFixed },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "candidate",
            event: {
                id: "global-minus-11",
                eventType: "wholeSeriesMove",
                shiftYears: -11,
            },
        });
        expect(decision.event?.evidence.algorithmSources).toContain(
            "stronger_global_whole_candidate",
        );
    });

    it("allows a strongly supported whole candidate to correct a three-year path drift", () => {
        const pathFixed = {
            ...event("path-fixed-minus-47", "wholeSeriesMove", 1600, 2000, 2000),
            shiftYears: -47,
        };
        pathFixed.confidenceLevel = "low";
        pathFixed.evidence.correlationGain = -0.05;
        pathFixed.evidence.notes = [
            "candidate_hard_gate_passed",
            "whole_baseline_source=path_fixed_side_lag",
            "path_fixed_side_lag=-47",
            "path_fixed_side_newer_context_years=174",
            "whole_state_support_fraction=0.000000",
        ];
        const global = {
            ...event("global-minus-50", "wholeSeriesMove", 1600, 2000, 2000),
            shiftYears: -50,
        };
        global.confidenceLevel = "high";
        global.evidence.correlationGain = 0.53;
        global.evidence.notes = [
            "candidate_hard_gate_passed",
            "whole_observed_dominant_lag=-50",
            "whole_state_support_fraction=0.818182",
            "whole_state_weighted_support_fraction=0.839040",
            "whole_state_newer_edge_support_fraction=1.000000",
        ];

        expect(adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", global),
            { stage: "final", authority: "selected", event: pathFixed },
        ]).event).toMatchObject({ id: "global-minus-50", shiftYears: -50 });
    });

    it("establishes a strong standalone global whole frame before a cumulative local", () => {
        const whole = {
            ...event("standalone-minus-20", "wholeSeriesMove", 1600, 2000, 2000),
            shiftYears: -20,
        };
        whole.confidenceLevel = "high";
        whole.evidence.correlationGain = 0.3;
        whole.evidence.notes = [
            "candidate_hard_gate_passed",
            "whole_state_global_lag_matches_shift=true",
            "whole_state_newer_edge_support_fraction=1.000000",
            "whole_state_support_fraction=0.666667",
            "whole_state_weighted_support_fraction=0.658564",
        ];
        const cumulative = event("cumulative-missing", "missingRing", 1911, 1923, 1917);
        cumulative.evidence.algorithmSources = [
            "cumulative_sequential_missing_staircase",
            "sequential_missing_staircase_head",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", whole),
            { stage: "final", authority: "selected", event: cumulative },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "candidate",
            event: {
                id: "standalone-minus-20",
                eventType: "wholeSeriesMove",
                shiftYears: -20,
            },
        });
        expect(decision.event?.evidence.algorithmSources).toContain(
            "standalone_global_whole_frame",
        );
    });

    it("keeps a multi-transition path projected as one ordinary frontier event", () => {
        const frontier = event("frontier", "missingRing", 1898, 1906, 1904);
        frontier.seriesRange = { startYear: 1700, endYear: 2000 };
        frontier.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        frontier.evidence.notes = ["sequential_missing_unit_event_years=1901,1905,1909"];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            { ...checkpoint("final", frontier), authority: "selected" },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            reason: "selected",
            event: {
                id: "frontier",
                startYear: 1898,
                endYear: 1906,
                eventType: "missingRing",
            },
        });
        expect(decision.event).not.toHaveProperty("nearEventCluster");
    });

    it("restores a displaced sequential missing window around its validated head", () => {
        const frontier = event("displaced-head", "missingRing", 1798, 1810, 1804);
        frontier.seriesRange = { startYear: 1700, endYear: 2000 };
        frontier.evidence.algorithmSources = [
            "multi_event_frontier_location_consensus",
            "sequential_missing_staircase_head",
        ];
        frontier.evidence.notes = ["sequential_missing_head_year=1899"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { ...checkpoint("final", frontier), authority: "selected" },
        ]);

        expect(decision.event).toMatchObject({
            eventType: "missingRing",
            startYear: 1893,
            endYear: 1905,
        });
        expect(decision.event?.evidence.algorithmSources).toContain(
            "sequential_missing_head_window",
        );
    });

    it("keeps a nearby competing location anchor inside a sequential missing window", () => {
        const frontier = event("anchored-head", "missingRing", 1628, 1640, 1635);
        frontier.seriesRange = { startYear: 1500, endYear: 2000 };
        frontier.evidence.algorithmSources = [
            "multi_event_frontier_location_consensus",
            "sequential_missing_staircase_head",
        ];
        frontier.evidence.notes = [
            "sequential_missing_head_year=1625",
            "direct_transition_year=1635",
        ];

        expect(adjudicateJointEventHypotheses("TARGET", [
            { ...checkpoint("final", frontier), authority: "selected" },
        ]).event).toMatchObject({
            id: "anchored-head",
            startYear: 1628,
            endYear: 1640,
        });
    });

    it("uses a validated sequential head beyond the current newer edge", () => {
        const frontier = event("older-mode", "missingRing", 1556, 1568, 1565);
        frontier.seriesRange = { startYear: 1400, endYear: 2000 };
        frontier.evidence.algorithmSources = [
            "multi_event_frontier_location_consensus",
            "sequential_missing_staircase_head",
        ];
        frontier.evidence.notes = [
            "sequential_missing_head_year=1571",
            "multi_frontier_evidence_years=1558,1565",
        ];

        expect(adjudicateJointEventHypotheses("TARGET", [
            { ...checkpoint("final", frontier), authority: "selected" },
        ]).event).toMatchObject({
            startYear: 1565,
            endYear: 1577,
        });
    });

    it("does not discard a still newer competing anchor", () => {
        const frontier = event("newer-anchor", "missingRing", 1556, 1568, 1565);
        frontier.seriesRange = { startYear: 1400, endYear: 2000 };
        frontier.evidence.algorithmSources = [
            "multi_event_frontier_location_consensus",
            "sequential_missing_staircase_head",
        ];
        frontier.evidence.notes = [
            "sequential_missing_head_year=1571",
            "multi_frontier_evidence_years=1580",
        ];

        expect(adjudicateJointEventHypotheses("TARGET", [
            { ...checkpoint("final", frontier), authority: "selected" },
        ]).event).toMatchObject({
            id: "newer-anchor",
            startYear: 1556,
            endYear: 1568,
        });
    });

    it("keeps a selected multi-event consensus window ahead of supplemental locations", () => {
        const selected = event("selected-consensus", "falseRing", 1829, 1841, 1834);
        selected.evidence.algorithmSources = [
            "multi_event_frontier_location_consensus",
        ];
        selected.evidence.notes = [
            "multi_frontier_evidence_years=1833,1834,1837",
        ];
        const supplemental = event("supplemental", "falseRing", 1840, 1852, 1846, 99);
        supplemental.evidence.algorithmSources = ["bounded_complete_lag_path"];

        expect(adjudicateJointEventHypotheses("TARGET", [
            { ...checkpoint("final", selected), authority: "selected" },
            { ...checkpoint("final", supplemental), authority: "supplemental" },
        ])).toMatchObject({
            status: "selected",
            event: {
                id: "selected-consensus",
                startYear: 1829,
                endYear: 1841,
            },
        });
    });

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

    it("keeps an accepted final locator window from being rewritten by an older checkpoint", () => {
        const earlier = event("earlier", "missingRing", 1377, 1383, 1380);
        const located = event("located", "missingRing", 1380, 1392, 1390);
        located.evidence.algorithmSources = ["full_interval_counterfactual_locator"];
        located.evidence.notes = ["locator_adjudication=accepted_overlapping_mode"];
        located.evidence.locationEvidence = [{
            source: "full_interval_counterfactual_locator",
            startYear: 1380,
            endYear: 1392,
            topYear: 1390,
            referenceCount: 9,
            concentration: 0,
            remoteMargin: 1.48,
            calibrated: true,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", earlier),
            checkpoint("detected", earlier),
            checkpoint("fused", earlier),
            checkpoint("retained", earlier),
            checkpoint("displayed", earlier),
            checkpoint("final", located),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                id: "located",
                startYear: 1380,
                endYear: 1392,
            },
        });
    });

    it("keeps the persisted location when an accepted locator has no remote-mode margin", () => {
        const persisted = event("persisted", "missingRing", 1568, 1580, 1574);
        const weakLocator = event("weak-locator", "missingRing", 1579, 1591, 1591);
        weakLocator.evidence.algorithmSources = ["full_interval_counterfactual_locator"];
        weakLocator.evidence.notes = ["locator_adjudication=accepted_overlapping_mode"];
        weakLocator.evidence.locationEvidence = [{
            source: "full_interval_counterfactual_locator",
            startYear: 1579,
            endYear: 1591,
            topYear: 1591,
            referenceCount: 16,
            concentration: 0,
            remoteMargin: 0,
            calibrated: true,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", persisted),
            checkpoint("fused", persisted),
            checkpoint("retained", persisted),
            checkpoint("displayed", persisted),
            checkpoint("final", weakLocator),
        ]);

        expect(decision.event).toMatchObject({
            id: "persisted",
            startYear: 1568,
            endYear: 1580,
        });
    });

    it("keeps a candidate-backed calibrated locator when its remote margin is zero", () => {
        const persisted = event("persisted", "falseRing", 1536, 1548, 1542);
        const located = event("located", "falseRing", 1526, 1538, 1533);
        located.evidence.algorithmSources = [
            "candidate_ranking",
            "full_interval_counterfactual_locator",
            "local_edit_alignment",
        ];
        located.evidence.notes = ["locator_adjudication=accepted_overlapping_mode"];
        located.evidence.locationEvidence = [{
            source: "full_interval_counterfactual_locator",
            startYear: 1526,
            endYear: 1538,
            topYear: 1533,
            referenceCount: 16,
            concentration: 0.48,
            remoteMargin: 0,
            calibrated: true,
        }];

        expect(adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", persisted),
            checkpoint("fused", persisted),
            checkpoint("retained", persisted),
            checkpoint("displayed", persisted),
            { ...checkpoint("final", located), authority: "selected" },
            { ...checkpoint("final", persisted), authority: "supplemental" },
        ])).toMatchObject({
            event: {
                id: "located",
                startYear: 1526,
                endYear: 1538,
            },
        });
    });

    it("does not let an uncalibrated narrow locator replace a persisted partial window", () => {
        const persisted = event("persisted", "partialMove", 1781, 1789, 1785);
        const narrowLocator = event("narrow-locator", "partialMove", 1788, 1792, 1789);
        narrowLocator.evidence.algorithmSources = ["full_interval_counterfactual_locator"];
        narrowLocator.evidence.notes = ["locator_adjudication=accepted_overlapping_mode"];
        narrowLocator.evidence.locationEvidence = [{
            source: "full_interval_counterfactual_locator",
            startYear: 1788,
            endYear: 1792,
            topYear: 1789,
            referenceCount: 16,
            concentration: 0.31,
            remoteMargin: 0.44,
            calibrated: false,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", persisted),
            checkpoint("fused", persisted),
            checkpoint("retained", persisted),
            checkpoint("displayed", persisted),
            checkpoint("final", persisted),
            checkpoint("final", narrowLocator),
        ]);

        expect(decision.event).toMatchObject({
            id: "persisted",
            startYear: 1781,
            endYear: 1789,
        });
    });

    it("does not let a supplemental cumulative path replace a selected mixed frontier", () => {
        const cumulative = event("cumulative", "partialMove", 1823, 1835, 1829);
        cumulative.shiftYears = -7;
        cumulative.evidence.lagBefore = -7;
        cumulative.evidence.algorithmSources = ["bounded_complete_lag_path"];
        cumulative.evidence.notes = ["bounded_path_complete_hypothesis=true"];
        const partialFrontier = event("partial-frontier", "partialMove", 1830, 1836, 1833);
        partialFrontier.shiftYears = -6;
        partialFrontier.evidence.lagBefore = -6;
        partialFrontier.evidence.algorithmSources = [
            "completed_partial_missing_composition",
            "per_reference_completed_correction",
        ];
        partialFrontier.evidence.notes = ["completed_mixed_frontier_is_newest_event"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", cumulative),
            checkpoint("fused", cumulative),
            checkpoint("displayed", cumulative),
            { stage: "final", authority: "supplemental", event: cumulative },
            { stage: "final", authority: "selected", event: partialFrontier },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                id: "partial-frontier",
                eventType: "partialMove",
                shiftYears: -6,
                startYear: 1830,
                endYear: 1836,
            },
        });
    });

    it("uses an exact separated bounded chain instead of an unanchored aggregate rewrite", () => {
        const aggregate = event("aggregate", "partialMove", 1718, 1724, 1721);
        aggregate.shiftYears = -27;
        aggregate.evidence.lagBefore = -27;
        aggregate.evidence.algorithmSources = ["completed_partial_false_composition"];
        aggregate.evidence.notes = [
            "completed_mixed_frontier_is_newest_event",
            "completed_mixed_source_segment_anchored=false",
            "completed_mixed_cumulative_shift=-26",
        ];
        const older = event("older-component", "partialMove", 1675, 1687, 1681);
        older.shiftYears = -20;
        older.evidence.lagBefore = -26;
        older.evidence.lagAfter = -6;
        older.evidence.algorithmSources = ["bounded_complete_lag_path"];
        older.evidence.notes = ["bounded_path_complete_hypothesis=true"];
        const newer = event("newer-component", "partialMove", 1695, 1707, 1701);
        newer.shiftYears = -6;
        newer.evidence.lagBefore = -6;
        newer.evidence.lagAfter = 0;
        newer.evidence.algorithmSources = ["bounded_complete_lag_path"];
        newer.evidence.notes = ["bounded_path_complete_hypothesis=true"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: aggregate },
            { stage: "final", authority: "supplemental", event: older },
            { stage: "final", authority: "supplemental", event: newer },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            event: {
                id: "newer-component",
                eventType: "partialMove",
                shiftYears: -6,
            },
        });
    });

    it("uses the bark-side bounded component instead of a selected cumulative partial", () => {
        const aggregate = event("joint-aggregate", "partialMove", 1695, 1707, 1701);
        aggregate.shiftYears = -26;
        aggregate.evidence.lagBefore = -26;
        aggregate.evidence.lagAfter = 0;
        aggregate.evidence.algorithmSources = [
            "decisive_joint_operation_fusion",
            "joint_year_operation_evidence",
        ];
        const older = event("older-partial", "partialMove", 1669, 1681, 1675);
        older.shiftYears = -20;
        older.evidence.lagBefore = -26;
        older.evidence.lagAfter = -6;
        older.evidence.algorithmSources = ["bounded_complete_lag_path"];
        older.evidence.notes = ["bounded_path_complete_hypothesis=true"];
        const newer = event("newer-partial", "partialMove", 1699, 1711, 1705);
        newer.shiftYears = -6;
        newer.evidence.lagBefore = -6;
        newer.evidence.lagAfter = 0;
        newer.evidence.algorithmSources = ["bounded_complete_lag_path"];
        newer.evidence.notes = ["bounded_path_complete_hypothesis=true"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: aggregate },
            { stage: "final", authority: "supplemental", event: older },
            { stage: "final", authority: "supplemental", event: newer },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            event: {
                id: "newer-partial",
                eventType: "partialMove",
                shiftYears: -6,
            },
        });
        expect(decision.event?.evidence.algorithmSources).toContain(
            "exact_bounded_component_decomposition",
        );
        expect(decision.event?.evidence.notes).toContain(
            "aggregate_partial_decomposed_component_count=2",
        );
    });

    it("restores a concentrated exact partial after an unsupported path decomposition", () => {
        const decomposed = event("decomposed-minus-15", "partialMove", 1749, 1761, 1755);
        decomposed.shiftYears = -15;
        decomposed.evidence.lagBefore = -15;
        decomposed.evidence.algorithmSources = [
            "bounded_complete_lag_path",
            "stable_multiscale_bounded_path_frontier",
        ];
        decomposed.evidence.notes = [
            "bounded_path_complete_hypothesis=true",
            "stable_bounded_path_aggregate_shift=-20",
            "stable_bounded_path_suffix_shifts=-15,-20",
        ];
        const exact = event("exact-minus-20", "partialMove", 1731, 1743, 1737);
        exact.shiftYears = -20;
        exact.evidence.lagBefore = -20;
        exact.evidence.correlationGain = 0.54;
        exact.evidence.algorithmSources = [
            "candidate_grid_reference_partial_consensus",
            "per_reference_counterfactual_evidence",
        ];
        exact.evidence.notes = [
            "candidate_hard_gate_passed",
            "candidate_grid_partial_shift=-20",
            "candidate_grid_partial_family_margin=0.46",
            "candidate_grid_partial_shift_margin=0.37",
            "candidate_grid_partial_reference_count=12",
            "candidate_grid_partial_reference_peak_kernel5=0.62",
        ];

        expect(adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: decomposed },
            { stage: "final", authority: "supplemental", event: exact },
        ])).toMatchObject({
            status: "selected",
            event: { id: "exact-minus-20", shiftYears: -20 },
        });
    });

    it("does not recombine a path whose selected component repeats", () => {
        const frontier = event("repeated-minus-20", "partialMove", 1799, 1811, 1805);
        frontier.shiftYears = -20;
        frontier.evidence.lagBefore = -20;
        frontier.evidence.algorithmSources = [
            "bounded_complete_lag_path",
            "stable_multiscale_bounded_path_frontier",
        ];
        frontier.evidence.notes = [
            "bounded_path_complete_hypothesis=true",
            "stable_bounded_path_aggregate_shift=-46",
            "stable_bounded_path_suffix_shifts=-20,-26,-46",
        ];
        const aggregate = event("aggregate-minus-46", "partialMove", 1799, 1807, 1803);
        aggregate.shiftYears = -46;
        aggregate.evidence.lagBefore = -46;
        aggregate.evidence.correlationGain = 0.8;
        aggregate.evidence.algorithmSources = [
            "candidate_grid_reference_partial_consensus",
            "per_reference_counterfactual_evidence",
        ];
        aggregate.evidence.notes = [
            "candidate_hard_gate_passed",
            "candidate_grid_partial_shift=-46",
            "candidate_grid_partial_family_margin=0.5",
            "candidate_grid_partial_shift_margin=0.4",
            "candidate_grid_partial_reference_count=12",
            "candidate_grid_partial_reference_peak_kernel5=0.8",
        ];

        expect(adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: frontier },
            { stage: "final", authority: "supplemental", event: aggregate },
        ]).event).toMatchObject({ id: "repeated-minus-20", shiftYears: -20 });
    });

    it("keeps a strongly located terminal bounded partial over an unanchored composition", () => {
        const composition = event("unanchored-composition", "falseRing", 1893, 1905, 1899);
        composition.evidence.algorithmSources = [
            "completed_partial_false_composition",
        ];
        composition.evidence.notes = [
            "completed_mixed_frontier_is_newest_event",
            "completed_mixed_source_segment_anchored=false",
        ];
        const terminal = event("terminal-partial", "partialMove", 1884, 1896, 1890);
        terminal.shiftYears = -6;
        terminal.evidence.lagBefore = -6;
        terminal.evidence.algorithmSources = [
            "bounded_complete_lag_path",
            "joint_year_operation_evidence",
        ];
        terminal.evidence.notes = [
            "bounded_path_complete_hypothesis=true",
            "bounded_path_transition_gain=88.2",
            "bounded_path_runner_up_margin=3.6",
            "bounded_operation_location_remote_margin=0.038",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: composition },
            { stage: "final", authority: "supplemental", event: terminal },
        ]);

        expect(decision.event).toMatchObject({
            id: "terminal-partial",
            eventType: "partialMove",
            shiftYears: -6,
            startYear: 1884,
            endYear: 1896,
        });
    });

    it("aggregates compatible bounded evidence without replacing the selected locator window", () => {
        const located = event("located", "partialMove", 1743, 1749, 1747);
        located.shiftYears = -6;
        located.evidence.lagBefore = -6;
        located.evidence.samplePairs = 29;
        located.evidence.algorithmSources = ["full_interval_counterfactual_locator"];
        located.evidence.notes = ["locator_adjudication=accepted_overlapping_mode"];
        located.evidence.locationEvidence = [{
            source: "full_interval_counterfactual_locator",
            startYear: 1743,
            endYear: 1749,
            topYear: 1747,
            referenceCount: 12,
            concentration: 0.7,
            remoteMargin: 0.3,
            calibrated: true,
        }];
        const bounded = event("bounded", "partialMove", 1742, 1754, 1748);
        bounded.shiftYears = -6;
        bounded.evidence.lagBefore = -6;
        bounded.evidence.samplePairs = 500;
        bounded.evidence.algorithmSources = ["bounded_complete_lag_path"];
        bounded.evidence.notes = [
            "bounded_path_complete_hypothesis=true",
            "bounded_path_transition_gain=154",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: located },
            { stage: "final", authority: "supplemental", event: bounded },
        ]);

        expect(decision.event).toMatchObject({
            id: "located",
            startYear: 1743,
            endYear: 1749,
            evidence: { samplePairs: 500 },
        });
        expect(decision.event?.evidence.algorithmSources).toContain(
            "bounded_complete_lag_path",
        );
        expect(decision.event?.evidence.notes).toContain(
            "bounded_path_transition_gain=154",
        );
    });

    it("keeps a calibrated strong locator when its strength comes from local channels", () => {
        const located = event("located", "missingRing", 1769, 1781, 1781);
        located.evidence.algorithmSources = ["full_interval_counterfactual_locator"];
        located.evidence.notes = [
            "scan_top_year=1773",
            "direct_transition_year=1773",
            "unit_local_difference31_year=1773",
            "unit_local_whitened31_year=1773",
            "counterfactual_coarse_overlap_consensus=0.811926",
            "counterfactual_coarse_model_margin=0.520415",
            "locator_adjudication=accepted_overlapping_strong_mode",
            "locator_proposed_window=1769-1781",
        ];
        located.evidence.locationEvidence = [{
            source: "full_interval_counterfactual_locator",
            startYear: 1769,
            endYear: 1781,
            topYear: 1781,
            referenceCount: 16,
            concentration: 0,
            remoteMargin: 0,
            calibrated: true,
        }];
        const bounded = event("bounded", "missingRing", 1777, 1789, 1783);
        bounded.evidence.score = 93.69;
        bounded.evidence.scoreMargin = 5.57;
        bounded.evidence.algorithmSources = ["bounded_complete_lag_path"];
        bounded.evidence.notes = ["bounded_path_complete_hypothesis=true"];
        bounded.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1777,
            endYear: 1789,
            topYear: 1783,
            referenceCount: 32,
            concentration: 0.76,
            remoteMargin: 5.57,
            calibrated: false,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: located },
            { stage: "final", authority: "supplemental", event: bounded },
        ]);

        expect(decision.event).toMatchObject({
            id: "located",
            eventType: "missingRing",
            startYear: 1769,
            endYear: 1781,
        });
        expect(decision.event?.evidence.algorithmSources).toContain(
            "bounded_complete_lag_path",
        );
    });

    it("uses strong bounded location evidence when the selected final window is unsupported", () => {
        const unsupported = event("unsupported", "missingRing", 1744, 1756, 1756);
        unsupported.evidence.algorithmSources = ["full_interval_counterfactual_locator"];
        unsupported.evidence.locationEvidence = [{
            source: "full_interval_counterfactual_locator",
            startYear: 1744,
            endYear: 1756,
            topYear: 1756,
            referenceCount: 15,
            concentration: 0,
            remoteMargin: -0.28,
            calibrated: true,
        }];
        const bounded = event("bounded", "missingRing", 1754, 1766, 1760);
        bounded.evidence.algorithmSources = ["bounded_complete_lag_path"];
        bounded.evidence.notes = ["bounded_path_complete_hypothesis=true"];
        bounded.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1753,
            endYear: 1765,
            topYear: 1759,
            referenceCount: 28,
            concentration: 0.6,
            remoteMargin: 0.84,
            calibrated: false,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: unsupported },
            { stage: "final", authority: "supplemental", event: bounded },
        ]);

        expect(decision.event).toMatchObject({
            id: "bounded",
            startYear: 1754,
            endYear: 1766,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "bounded_complete_lag_path",
                    "full_interval_counterfactual_locator",
                ]),
            },
        });
    });

    it("keeps a strong selected bounded-path window over an earlier survival plateau", () => {
        const persisted = event("persisted", "missingRing", 1852, 1858, 1853);
        const bounded = event("selected-bounded", "missingRing", 1856, 1868, 1862);
        bounded.evidence.algorithmSources = [
            "bounded_complete_lag_path",
            "stable_multiscale_bounded_path_frontier",
        ];
        bounded.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1856,
            endYear: 1868,
            topYear: 1862,
            referenceCount: 28,
            concentration: 0.55,
            remoteMargin: 0.61,
            calibrated: false,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", persisted),
            checkpoint("fused", persisted),
            checkpoint("retained", persisted),
            checkpoint("displayed", persisted),
            { stage: "final", authority: "selected", event: bounded },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                id: "selected-bounded",
                startYear: 1856,
                endYear: 1868,
            },
        });
    });

    it("keeps a selected completed unit frontier over an older displayed unit window", () => {
        const displayed = event("displayed-unit", "missingRing", 1821, 1829, 1824);
        displayed.evidence.algorithmSources = ["reference_core_pair_voting"];
        const completed = event("completed-unit", "missingRing", 1827, 1835, 1831);
        completed.evidence.algorithmSources = [
            "completed_partial_missing_composition",
            "exhaustive_completed_partial_unit_adjudication",
            "per_reference_completed_correction",
        ];
        completed.evidence.notes = ["completed_mixed_frontier_is_newest_event"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", displayed),
            checkpoint("displayed", displayed),
            { stage: "final", authority: "selected", event: completed },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                id: "completed-unit",
                eventType: "missingRing",
                startYear: 1827,
                endYear: 1835,
            },
        });
    });

    it("keeps supplemental operations in conflict with an ordinary selected final", () => {
        const ordinaryPartial = event("ordinary-partial", "partialMove", 1622, 1634, 1628);
        ordinaryPartial.shiftYears = -54;
        ordinaryPartial.evidence.lagBefore = -54;
        const competingMissing = event("competing-missing", "missingRing", 1627, 1633, 1631);

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: ordinaryPartial },
            { stage: "final", authority: "supplemental", event: competingMissing },
        ]);

        expect(decision).toMatchObject({
            status: "refused",
            reason: "operation_conflict",
            event: null,
        });
    });

    it("does not let a supplemental bounded path change the selected final operation", () => {
        const selectedFalse = event("selected-false", "falseRing", 1156, 1164, 1160);
        selectedFalse.evidence.algorithmSources = [
            "candidate_ranking",
            "full_interval_counterfactual_locator",
            "local_edit_alignment",
        ];
        selectedFalse.evidence.notes = ["candidate_hard_gate_passed"];
        selectedFalse.evidence.locationEvidence = [{
            source: "full_interval_counterfactual_locator",
            startYear: 1156,
            endYear: 1164,
            topYear: 1160,
            referenceCount: 24,
            concentration: 0.88,
            remoteMargin: 0.8,
            calibrated: true,
        }];
        const cumulative = event("cumulative-partial", "partialMove", 1153, 1165, 1159);
        cumulative.shiftYears = -5;
        cumulative.evidence.lagBefore = -5;
        cumulative.evidence.algorithmSources = ["bounded_complete_lag_path"];
        cumulative.evidence.notes = ["bounded_path_complete_hypothesis=true"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", selectedFalse),
            checkpoint("displayed", selectedFalse),
            { stage: "final", authority: "selected", event: selectedFalse },
            { stage: "final", authority: "supplemental", event: cumulative },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                id: "selected-false",
                eventType: "falseRing",
                startYear: 1156,
                endYear: 1164,
            },
        });
    });

    it("keeps a selected location over a same-operation supplemental location", () => {
        const located = event("located", "partialMove", 1817, 1829, 1823);
        located.shiftYears = -20;
        located.evidence.lagBefore = -20;
        located.evidence.algorithmSources = ["full_interval_counterfactual_locator"];
        const fallback = event("fallback", "partialMove", 1810, 1822, 1816);
        fallback.shiftYears = -20;
        fallback.evidence.lagBefore = -20;
        fallback.evidence.algorithmSources = ["bounded_complete_lag_path"];
        fallback.evidence.notes = ["bounded_path_complete_hypothesis=true"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: located },
            { stage: "final", authority: "supplemental", event: fallback },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            event: {
                id: "located",
                startYear: 1817,
                endYear: 1829,
            },
        });
    });

    it("does not revive a remote bounded window after selecting an independent unit frontier", () => {
        const selected = event("selected-frontier", "missingRing", 1854, 1862, 1861);
        selected.evidence.algorithmSources = [
            "cumulative_sequential_missing_staircase",
            "sequential_missing_checkpoint_location",
            "sequential_missing_staircase_head",
        ];
        const remote = event("remote-bounded", "missingRing", 1814, 1826, 1820, 117);
        remote.evidence.algorithmSources = ["bounded_complete_lag_path"];
        remote.evidence.notes = ["bounded_path_complete_hypothesis=true"];
        remote.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1814,
            endYear: 1826,
            topYear: 1820,
            referenceCount: 55,
            concentration: 0.99,
            remoteMargin: 19,
            calibrated: false,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: selected },
            { stage: "final", authority: "supplemental", event: remote },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                id: "selected-frontier",
                startYear: 1854,
                endYear: 1862,
                rankedYears: [{ year: 1861 }],
            },
        });
    });

    it("keeps a candidate-anchored distant final ahead of a persisted adjacent platform", () => {
        const selected = event("candidate-frontier", "missingRing", 1974, 1980, 1977);
        selected.evidence.lagBefore = -1;
        selected.evidence.lagAfter = 0;
        selected.evidence.algorithmSources = [
            "candidate_anchored_distant_missing_frontier",
            "candidate_ranking",
            "cumulative_sequential_missing_staircase",
            "local_edit_alignment",
            "sequential_missing_staircase_head",
        ];
        selected.evidence.notes = [
            "distant_sequential_predecessor_year=1787",
            "distant_candidate_whole_correlation_advantage=0.011972",
        ];
        const adjacent = event("adjacent-platform", "missingRing", 1970, 1976, 1974);
        adjacent.evidence.lagBefore = -1;
        adjacent.evidence.lagAfter = 0;

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", adjacent),
            checkpoint("fused", adjacent),
            checkpoint("retained", adjacent),
            checkpoint("displayed", adjacent),
            checkpoint("final", selected),
        ]);

        expect(decision.event).toMatchObject({
            id: "candidate-frontier",
            eventType: "missingRing",
            startYear: 1974,
            endYear: 1980,
            rankedYears: [{ year: 1977, rank: 1 }],
        });
    });

    it("keeps a candidate-anchored positive staircase over a distant bounded mode", () => {
        const selected = event("sequential-false", "falseRing", 1847, 1859, 1853);
        selected.evidence.algorithmSources = [
            "candidate_anchored_positive_staircase",
            "positive_unit_staircase_direction",
            "sequential_false_staircase_head",
        ];
        selected.evidence.notes = [
            "sequential_false_path_start_lag=4",
            "sequential_false_transition_count=4",
            "sequential_false_candidate_depth=4",
            "sequential_false_gain_over_direct=2.4",
            "sequential_false_direction_master_margin=0.13",
        ];
        const remote = event("remote-bounded", "falseRing", 1889, 1901, 1895);
        remote.evidence.algorithmSources = ["bounded_complete_lag_path"];
        remote.evidence.notes = ["bounded_path_complete_hypothesis=true"];
        remote.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1889,
            endYear: 1901,
            topYear: 1895,
            referenceCount: 28,
            concentration: 0.99,
            remoteMargin: 4.5,
            calibrated: false,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: selected },
            { stage: "final", authority: "supplemental", event: remote },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                id: "sequential-false",
                eventType: "falseRing",
                startYear: 1847,
                endYear: 1859,
            },
        });
    });

    it("keeps the selected positive staircase inside an overlapping bounded cluster", () => {
        const selected = event("sequential-false-overlap", "falseRing", 1845, 1857, 1851);
        selected.evidence.algorithmSources = [
            "candidate_anchored_positive_staircase",
            "positive_unit_staircase_direction",
            "sequential_false_staircase_head",
        ];
        selected.evidence.notes = [
            "sequential_false_path_start_lag=3",
            "sequential_false_transition_count=3",
            "sequential_false_candidate_depth=3",
            "sequential_false_gain_over_direct=3.4",
            "sequential_false_direction_master_margin=0.04",
        ];
        const overlapping = event("bounded-overlap", "falseRing", 1833, 1845, 1839);
        overlapping.evidence.algorithmSources = ["bounded_complete_lag_path"];
        overlapping.evidence.notes = ["bounded_path_complete_hypothesis=true"];
        overlapping.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1833,
            endYear: 1845,
            topYear: 1839,
            referenceCount: 28,
            concentration: 0.99,
            remoteMargin: 5,
            calibrated: false,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: selected },
            { stage: "final", authority: "supplemental", event: overlapping },
        ]);

        expect(decision.event).toMatchObject({
            id: "sequential-false-overlap",
            startYear: 1845,
            endYear: 1857,
        });
    });

    it("keeps a stable terminal unit staircase over an older contaminated mode", () => {
        const selected = event("terminal-false", "falseRing", 1873, 1881, 1877);
        selected.evidence.algorithmSources = [
            "candidate_anchored_positive_staircase",
            "stable_terminal_unit_staircase_frontier",
        ];
        selected.evidence.notes = [
            "terminal_unit_staircase_depth=3",
            "terminal_unit_staircase_aggregate_shift=3",
            "terminal_unit_staircase_maximum_year_drift=1",
            "terminal_unit_staircase_stronger_gain=12",
            "terminal_unit_staircase_weaker_gain=10",
        ];
        const older = event("older-missing", "missingRing", 1858, 1870, 1864);
        older.evidence.algorithmSources = ["bounded_complete_lag_path"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: selected },
            { stage: "final", authority: "supplemental", event: older },
        ]);

        expect(decision.event).toMatchObject({
            id: "terminal-false",
            eventType: "falseRing",
            startYear: 1873,
            endYear: 1881,
        });
    });

    it("keeps a stable negative terminal unit staircase over an aggregate partial mode", () => {
        const selected = event("terminal-missing", "missingRing", 1873, 1881, 1877);
        selected.evidence.algorithmSources = [
            "candidate_anchored_negative_staircase",
            "stable_terminal_unit_staircase_frontier",
        ];
        selected.evidence.notes = [
            "terminal_unit_staircase_depth=3",
            "terminal_unit_staircase_aggregate_shift=-3",
            "terminal_unit_staircase_maximum_year_drift=1",
            "terminal_unit_staircase_stronger_gain=12",
            "terminal_unit_staircase_weaker_gain=10",
        ];
        const aggregate = event("aggregate-partial", "partialMove", 1858, 1870, 1864);
        aggregate.shiftYears = -3;
        aggregate.shiftSide = "older";
        aggregate.evidence.algorithmSources = ["bounded_complete_lag_path"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: selected },
            { stage: "final", authority: "supplemental", event: aggregate },
        ]);

        expect(decision.event).toMatchObject({
            id: "terminal-missing",
            eventType: "missingRing",
            startYear: 1873,
            endYear: 1881,
        });
    });

    it("keeps the validated final terminal frontier over an older displayed location", () => {
        const displayed = event("displayed-terminal-false", "falseRing", 1854, 1860, 1857);
        displayed.evidence.algorithmSources = ["candidate_anchored_positive_staircase"];
        const final = event("final-terminal-false", "falseRing", 1860, 1868, 1864);
        final.evidence.algorithmSources = [
            "candidate_anchored_positive_staircase",
            "stable_terminal_unit_staircase_frontier",
        ];
        final.evidence.notes = [
            "terminal_unit_staircase_depth=2",
            "terminal_unit_staircase_aggregate_shift=2",
            "terminal_unit_staircase_maximum_year_drift=1",
            "terminal_unit_staircase_stronger_gain=5",
            "terminal_unit_staircase_weaker_gain=3",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "displayed", authority: "selected", event: displayed },
            { stage: "final", authority: "selected", event: final },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                id: "final-terminal-false",
                eventType: "falseRing",
                startYear: 1860,
                endYear: 1868,
                rankedYears: [{ year: 1864 }],
            },
        });
    });

    it("ignores a local transition tied only to a positive whole-series baseline", () => {
        const whole = event("whole", "wholeSeriesMove", 866, 1135, 1135);
        whole.shiftYears = 4;
        whole.rankedYears = [];
        whole.evidence.lagBefore = 4;
        whole.evidence.lagAfter = 4;
        const zeroTerminal = event("zero-terminal", "falseRing", 1022, 1034, 1028);
        zeroTerminal.evidence.algorithmSources = [
            "candidate_anchored_positive_staircase",
            "positive_unit_staircase_direction",
            "sequential_false_staircase_head",
        ];
        zeroTerminal.evidence.notes = [
            "sequential_false_path_start_lag=4",
            "sequential_false_transition_count=4",
            "sequential_false_candidate_depth=4",
            "sequential_false_gain_over_direct=14",
            "sequential_false_direction_master_margin=0.1",
        ];
        const baselineCompatible = event(
            "baseline-compatible",
            "falseRing",
            1029,
            1041,
            1035,
        );
        baselineCompatible.evidence.lagBefore = 5;
        baselineCompatible.evidence.lagAfter = 4;
        baselineCompatible.evidence.algorithmSources = ["bounded_complete_lag_path"];
        baselineCompatible.evidence.notes = ["bounded_path_complete_hypothesis=true"];
        baselineCompatible.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1029,
            endYear: 1041,
            topYear: 1035,
            referenceCount: 45,
            concentration: 0.83,
            remoteMargin: 9,
            calibrated: false,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", whole),
            checkpoint("detected", whole),
            checkpoint("fused", whole),
            checkpoint("retained", whole),
            checkpoint("displayed", whole),
            { stage: "final", authority: "selected", event: zeroTerminal },
            { stage: "final", authority: "supplemental", event: baselineCompatible },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                id: "zero-terminal",
                eventType: "falseRing",
                startYear: 1022,
                endYear: 1034,
            },
        });
    });

    it("uses an overlapping independently localized window for a terminal unit operation", () => {
        const final = event("terminal-false", "falseRing", 1851, 1863, 1857);
        final.evidence.algorithmSources = [
            "candidate_anchored_positive_staircase",
            "stable_terminal_unit_staircase_frontier",
        ];
        final.evidence.notes = [
            "terminal_unit_staircase_depth=2",
            "terminal_unit_staircase_aggregate_shift=2",
            "terminal_unit_staircase_maximum_year_drift=1",
            "terminal_unit_staircase_stronger_gain=5",
            "terminal_unit_staircase_weaker_gain=3",
        ];
        const located = event("located-false", "falseRing", 1844, 1856, 1853);
        located.evidence.algorithmSources = ["full_interval_counterfactual_locator"];
        located.evidence.locationEvidence = [{
            source: "full_interval_counterfactual_locator",
            startYear: 1844,
            endYear: 1856,
            topYear: 1853,
            referenceCount: 16,
            concentration: 0.4,
            remoteMargin: 0,
            calibrated: true,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: final },
            { stage: "final", authority: "selected", event: located },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                eventType: "falseRing",
                startYear: 1844,
                endYear: 1856,
                rankedYears: [{ year: 1853 }],
                evidence: {
                    algorithmSources: expect.arrayContaining([
                        "stable_terminal_unit_staircase_frontier",
                        "terminal_unit_independent_location_projection",
                    ]),
                },
            },
        });
    });

    it("uses a hard-gated exact unit frontier to locate a terminal staircase", () => {
        const terminal = event("terminal-false", "falseRing", 1851, 1863, 1857);
        terminal.evidence.algorithmSources = [
            "candidate_anchored_positive_staircase",
            "stable_terminal_unit_staircase_frontier",
        ];
        terminal.evidence.notes = [
            "terminal_unit_staircase_depth=2",
            "terminal_unit_staircase_aggregate_shift=2",
            "terminal_unit_staircase_maximum_year_drift=1",
            "terminal_unit_staircase_stronger_gain=5",
            "terminal_unit_staircase_weaker_gain=3",
        ];
        const candidate = event("exact-frontier", "falseRing", 1847, 1853, 1850);
        candidate.evidence.algorithmSources = ["candidate_ranking"];
        candidate.evidence.notes = ["candidate_hard_gate_passed"];
        candidate.evidence.lagBefore = 2;
        candidate.evidence.lagAfter = 1;
        candidate.evidence.scoreMargin = 0.41;
        candidate.evidence.correlationGain = 0.04;

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", candidate),
            { ...checkpoint("final", terminal), authority: "selected" },
        ]);

        expect(decision.event).toMatchObject({
            eventType: "falseRing",
            startYear: 1847,
            endYear: 1853,
            rankedYears: [{ year: 1850 }],
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "stable_terminal_unit_staircase_frontier",
                    "terminal_unit_exact_unit_frontier_location",
                ]),
            },
        });
    });

    it("keeps the terminal boundary inside an exact-frontier location window", () => {
        const terminal = event("terminal-false", "falseRing", 1785, 1793, 1789);
        terminal.evidence.algorithmSources = [
            "candidate_anchored_positive_staircase",
            "stable_terminal_unit_staircase_frontier",
        ];
        terminal.evidence.notes = [
            "terminal_unit_staircase_depth=3",
            "terminal_unit_staircase_aggregate_shift=3",
            "terminal_unit_staircase_boundary_year=1789",
            "terminal_unit_staircase_maximum_year_drift=2",
            "terminal_unit_staircase_stronger_gain=5",
            "terminal_unit_staircase_weaker_gain=3",
        ];
        const candidate = event("exact-frontier", "falseRing", 1790, 1796, 1793);
        candidate.evidence.algorithmSources = ["candidate_ranking"];
        candidate.evidence.notes = ["candidate_hard_gate_passed"];
        candidate.evidence.lagBefore = 3;
        candidate.evidence.lagAfter = 2;
        candidate.evidence.scoreMargin = 0.41;
        candidate.evidence.correlationGain = 0.04;

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", candidate),
            { ...checkpoint("final", terminal), authority: "selected" },
        ]);

        expect(decision.event).toMatchObject({
            eventType: "falseRing",
            startYear: 1789,
            endYear: 1797,
            evidence: {
                notes: expect.arrayContaining([
                    "terminal_unit_location_boundary_union=1789-1797",
                ]),
            },
        });
    });

    it("does not let an unseparated unit candidate relocate a terminal staircase", () => {
        const terminal = event("terminal-false", "falseRing", 1766, 1774, 1770);
        terminal.evidence.algorithmSources = [
            "candidate_anchored_positive_staircase",
            "stable_terminal_unit_staircase_frontier",
        ];
        terminal.evidence.notes = [
            "terminal_unit_staircase_depth=3",
            "terminal_unit_staircase_aggregate_shift=3",
            "terminal_unit_staircase_maximum_year_drift=1",
            "terminal_unit_staircase_stronger_gain=5",
            "terminal_unit_staircase_weaker_gain=3",
        ];
        const candidate = event("flat-frontier", "falseRing", 1773, 1779, 1776);
        candidate.evidence.algorithmSources = ["candidate_ranking"];
        candidate.evidence.notes = ["candidate_hard_gate_passed"];
        candidate.evidence.lagBefore = 3;
        candidate.evidence.lagAfter = 2;
        candidate.evidence.scoreMargin = 0;
        candidate.evidence.correlationGain = 0.05;

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", candidate),
            { ...checkpoint("final", terminal), authority: "selected" },
        ]);

        expect(decision.event).toMatchObject({
            id: "terminal-false",
            startYear: 1766,
            endYear: 1774,
            rankedYears: [{ year: 1770 }],
        });
    });

    it("uses the highest-ranked older exact frontier on a flat terminal plateau", () => {
        const terminal = event("terminal-missing", "missingRing", 1802, 1810, 1806);
        terminal.evidence.algorithmSources = [
            "candidate_anchored_negative_staircase",
            "stable_terminal_unit_staircase_frontier",
        ];
        terminal.evidence.notes = [
            "terminal_unit_staircase_depth=4",
            "terminal_unit_staircase_aggregate_shift=-4",
            "terminal_unit_staircase_boundary_year=1806",
            "terminal_unit_staircase_maximum_year_drift=2",
            "terminal_unit_staircase_stronger_gain=17",
            "terminal_unit_staircase_weaker_gain=21",
        ];
        const older = event("older-exact", "missingRing", 1798, 1804, 1801, 4.06);
        older.evidence.algorithmSources = ["candidate_ranking"];
        older.evidence.notes = ["candidate_hard_gate_passed"];
        older.evidence.lagBefore = -4;
        older.evidence.lagAfter = -3;
        older.evidence.scoreMargin = 0;
        older.evidence.correlationGain = 0.01;
        const newer = event("newer-exact", "missingRing", 1805, 1811, 1808, 2.12);
        newer.evidence.algorithmSources = ["candidate_ranking"];
        newer.evidence.notes = ["candidate_hard_gate_passed"];
        newer.evidence.lagBefore = -4;
        newer.evidence.lagAfter = -3;
        newer.evidence.scoreMargin = 4.44;
        newer.evidence.correlationGain = 0.012;

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", older),
            checkpoint("candidate", newer),
            { ...checkpoint("final", terminal), authority: "selected" },
        ]);

        expect(decision.event).toMatchObject({
            eventType: "missingRing",
            startYear: 1798,
            endYear: 1806,
            evidence: {
                notes: expect.arrayContaining([
                    "terminal_unit_location_projected_top_year=1801",
                    "terminal_unit_location_boundary_union=1798-1806",
                ]),
            },
        });
    });

    it("does not shrink a low-concentration 13-year terminal window to a weak interior candidate", () => {
        const terminal = event("terminal-false", "falseRing", 1812, 1824, 1818);
        terminal.evidence.algorithmSources = [
            "candidate_anchored_positive_staircase",
            "stable_terminal_unit_staircase_frontier",
        ];
        terminal.evidence.notes = [
            "terminal_unit_staircase_depth=2",
            "terminal_unit_staircase_aggregate_shift=2",
            "terminal_unit_staircase_boundary_year=1818",
            "terminal_unit_staircase_maximum_year_drift=2",
            "terminal_unit_staircase_stronger_gain=81",
            "terminal_unit_staircase_weaker_gain=83",
        ];
        const candidate = event("weak-interior", "falseRing", 1814, 1820, 1817, -12.6);
        candidate.evidence.algorithmSources = ["candidate_ranking"];
        candidate.evidence.notes = ["candidate_hard_gate_passed"];
        candidate.evidence.lagBefore = 2;
        candidate.evidence.lagAfter = 1;
        candidate.evidence.scoreMargin = 0.13;
        candidate.evidence.correlationGain = 0.03;

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", candidate),
            { ...checkpoint("final", terminal), authority: "selected" },
        ]);

        expect(decision.event).toMatchObject({
            id: "terminal-false",
            startYear: 1812,
            endYear: 1824,
        });
    });

    it("uses a decisive equivalent partial hypothesis to locate a missing staircase", () => {
        const terminal = event("terminal-missing", "missingRing", 1814, 1822, 1818);
        terminal.evidence.algorithmSources = [
            "candidate_anchored_negative_staircase",
            "stable_terminal_unit_staircase_frontier",
        ];
        terminal.evidence.notes = [
            "terminal_unit_staircase_depth=2",
            "terminal_unit_staircase_aggregate_shift=-2",
            "terminal_unit_staircase_maximum_year_drift=1",
            "terminal_unit_staircase_stronger_gain=12",
            "terminal_unit_staircase_weaker_gain=10",
        ];
        const partial = event("equivalent-partial", "partialMove", 1811, 1819, 1812);
        partial.shiftYears = -2;
        partial.shiftSide = "older";
        partial.confidenceLevel = "high";
        partial.evidence.lagBefore = -2;
        partial.evidence.lagAfter = 0;
        partial.evidence.correlationGain = 0.42;
        partial.evidence.scoreMargin = 0.46;
        partial.evidence.algorithmSources = [
            "decisive_joint_operation_fusion",
            "full_interval_counterfactual_scan",
            "joint_year_operation_evidence",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("displayed", partial),
            { ...checkpoint("final", terminal), authority: "selected" },
        ]);

        expect(decision.event).toMatchObject({
            eventType: "missingRing",
            startYear: 1811,
            endYear: 1819,
            rankedYears: [{ year: 1812 }],
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "stable_terminal_unit_staircase_frontier",
                    "terminal_unit_workflow_equivalent_partial_location",
                ]),
            },
        });
        expect(decision.event).not.toHaveProperty("shiftYears");
    });

    it("does not rewrite an already direction-calibrated terminal window", () => {
        const terminal = event("terminal-missing", "missingRing", 1784, 1796, 1785);
        terminal.evidence.algorithmSources = [
            "candidate_anchored_negative_staircase",
            "stable_terminal_unit_staircase_frontier",
            "terminal_missing_ring_asymmetric_window",
        ];
        terminal.evidence.notes = [
            "terminal_unit_staircase_depth=3",
            "terminal_unit_staircase_aggregate_shift=-3",
            "terminal_unit_staircase_boundary_year=1786",
        ];
        const partial = event("equivalent-partial", "partialMove", 1781, 1789, 1784);
        partial.shiftYears = -3;
        partial.shiftSide = "older";
        partial.confidenceLevel = "high";
        partial.evidence.lagBefore = -3;
        partial.evidence.lagAfter = 0;
        partial.evidence.correlationGain = 0.42;
        partial.evidence.scoreMargin = 0.46;
        partial.evidence.algorithmSources = [
            "decisive_joint_operation_fusion",
            "full_interval_counterfactual_scan",
            "joint_year_operation_evidence",
        ];

        expect(adjudicateJointEventHypotheses("TARGET", [
            checkpoint("displayed", partial),
            { ...checkpoint("final", terminal), authority: "selected" },
        ]).event).toMatchObject({
            eventType: "missingRing",
            startYear: 1784,
            endYear: 1796,
        });
    });

    it("does not use a weak partial hypothesis as terminal unit location", () => {
        const terminal = event("terminal-missing", "missingRing", 1814, 1822, 1818);
        terminal.evidence.algorithmSources = [
            "candidate_anchored_negative_staircase",
            "stable_terminal_unit_staircase_frontier",
        ];
        terminal.evidence.notes = [
            "terminal_unit_staircase_depth=2",
            "terminal_unit_staircase_aggregate_shift=-2",
            "terminal_unit_staircase_maximum_year_drift=1",
            "terminal_unit_staircase_stronger_gain=12",
            "terminal_unit_staircase_weaker_gain=10",
        ];
        const partial = event("weak-partial", "partialMove", 1811, 1819, 1812);
        partial.shiftYears = -2;
        partial.shiftSide = "older";
        partial.confidenceLevel = "high";
        partial.evidence.lagBefore = -2;
        partial.evidence.lagAfter = 0;
        partial.evidence.correlationGain = 0.19;
        partial.evidence.scoreMargin = 0.19;
        partial.evidence.algorithmSources = [
            "decisive_joint_operation_fusion",
            "full_interval_counterfactual_scan",
            "joint_year_operation_evidence",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("displayed", partial),
            { ...checkpoint("final", terminal), authority: "selected" },
        ]);

        expect(decision.event).toMatchObject({
            id: "terminal-missing",
            startYear: 1814,
            endYear: 1822,
            rankedYears: [{ year: 1818 }],
        });
    });

    it("does not join strong terminal and partial evidence from distinct location modes", () => {
        const terminal = event("terminal-missing", "missingRing", 1883, 1895, 1889);
        terminal.evidence.algorithmSources = [
            "candidate_anchored_negative_staircase",
            "stable_terminal_unit_staircase_frontier",
        ];
        terminal.evidence.notes = [
            "terminal_unit_staircase_depth=2",
            "terminal_unit_staircase_aggregate_shift=-2",
            "terminal_unit_staircase_maximum_year_drift=2",
            "terminal_unit_staircase_stronger_gain=12",
            "terminal_unit_staircase_weaker_gain=10",
        ];
        const partial = event("remote-partial", "partialMove", 1875, 1883, 1879);
        partial.shiftYears = -2;
        partial.shiftSide = "older";
        partial.confidenceLevel = "high";
        partial.evidence.lagBefore = -2;
        partial.evidence.lagAfter = 0;
        partial.evidence.correlationGain = 0.58;
        partial.evidence.scoreMargin = 0.57;
        partial.evidence.algorithmSources = [
            "decisive_joint_operation_fusion",
            "full_interval_counterfactual_scan",
            "joint_year_operation_evidence",
        ];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("displayed", partial),
            { ...checkpoint("final", terminal), authority: "selected" },
        ]);

        expect(decision.event).toMatchObject({
            id: "terminal-missing",
            startYear: 1883,
            endYear: 1895,
            rankedYears: [{ year: 1889 }],
        });
    });

    it("uses a high-confidence bark-side COFECHA partial candidate inside the final mode", () => {
        const final = event("older-final-partial", "partialMove", 1836, 1848, 1842);
        final.shiftYears = -4;
        final.shiftSide = "older";
        final.evidence.lagBefore = -4;
        final.evidence.lagAfter = 0;
        final.interpretationAmbiguity = {
            kind: "missingRingsOrPartialMove",
            alternative: event("stale-missing-window", "missingRing", 1835, 1847, 1841),
            evidence: {
                missingRingCount: 4,
                cumulativeShiftYears: -4,
                missingYears: [],
                partialFirstFixedYear: 1842,
                normalizedCounterfactualGainDifference: 0,
                masterMargin: 0,
                referenceMedianMargin: 0,
                referenceCount: 10,
                missingReferenceSupport: 0,
                partialReferenceSupport: 0,
            },
        };
        const candidate = event("bark-side-cofecha-partial", "partialMove", 1846, 1854, 1850);
        candidate.shiftYears = -4;
        candidate.shiftSide = "older";
        candidate.confidenceLevel = "high";
        candidate.evidence.lagBefore = -4;
        candidate.evidence.lagAfter = 0;
        candidate.evidence.correlationGain = 0.31;
        candidate.evidence.algorithmSources = [
            "candidate_ranking",
            "cofecha_segment_lag",
            "segmented_diagnosis",
        ];
        candidate.evidence.notes = ["candidate_hard_gate_passed"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: final },
            { stage: "candidate", authority: "selected", event: candidate },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                eventType: "partialMove",
                shiftYears: -4,
                startYear: 1846,
                endYear: 1854,
                rankedYears: [{ year: 1850 }],
                interpretationAmbiguity: undefined,
                evidence: {
                    lagBefore: -4,
                    lagAfter: 0,
                    algorithmSources: expect.arrayContaining([
                        "cofecha_bark_side_partial_location",
                    ]),
                },
            },
        });
    });

    it("keeps a preserved missing interpretation on the final partial window", () => {
        const final = event("recentered-partial", "partialMove", 1532, 1544, 1536);
        final.shiftYears = -3;
        final.shiftSide = "older";
        final.evidence.lagBefore = -3;
        final.evidence.lagAfter = 0;
        const alternative = event("stale-missing", "missingRing", 1530, 1542, 1535);
        alternative.evidence.notes = [
            "interpretation_window=preserved_multi_event_consensus",
        ];
        final.interpretationAmbiguity = {
            kind: "missingRingsOrPartialMove",
            alternative,
            evidence: {
                missingRingCount: 3,
                cumulativeShiftYears: -3,
                missingYears: [],
                partialFirstFixedYear: 1536,
                normalizedCounterfactualGainDifference: 0,
                masterMargin: 0,
                referenceMedianMargin: 0,
                referenceCount: 10,
                missingReferenceSupport: 0,
                partialReferenceSupport: 0,
            },
        };

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: final },
        ]);

        expect(decision.event?.interpretationAmbiguity?.alternative).toMatchObject({
            eventType: "missingRing",
            startYear: 1532,
            endYear: 1544,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "shared_missing_partial_frontier_window",
                ]),
            },
        });
    });

    it("does not let a low-confidence bark-side partial candidate rewrite the final mode", () => {
        const final = event("kept-final-partial", "partialMove", 1836, 1848, 1842);
        final.shiftYears = -4;
        final.shiftSide = "older";
        final.evidence.lagBefore = -4;
        final.evidence.lagAfter = 0;
        const candidate = event("weak-bark-side-partial", "partialMove", 1846, 1854, 1850);
        candidate.shiftYears = -4;
        candidate.shiftSide = "older";
        candidate.confidenceLevel = "low";
        candidate.evidence.lagBefore = -4;
        candidate.evidence.lagAfter = 0;
        candidate.evidence.correlationGain = 0.31;
        candidate.evidence.algorithmSources = [
            "candidate_ranking",
            "cofecha_segment_lag",
        ];
        candidate.evidence.notes = ["candidate_hard_gate_passed"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: final },
            { stage: "candidate", authority: "selected", event: candidate },
        ]);

        expect(decision.event).toMatchObject({
            id: "kept-final-partial",
            startYear: 1836,
            endYear: 1848,
        });
    });

    it("does not replace an independently localized physical partial move", () => {
        const final = event("localized-final-partial", "partialMove", 1910, 1922, 1916);
        final.shiftYears = -6;
        final.shiftSide = "older";
        final.evidence.lagBefore = -6;
        final.evidence.lagAfter = 0;
        final.evidence.algorithmSources = [
            "negative_partial_multiview_consensus",
            "full_interval_counterfactual_locator",
        ];
        const candidate = event("newer-cofecha-partial", "partialMove", 1921, 1929, 1925);
        candidate.shiftYears = -6;
        candidate.shiftSide = "older";
        candidate.confidenceLevel = "high";
        candidate.evidence.lagBefore = -6;
        candidate.evidence.lagAfter = 0;
        candidate.evidence.correlationGain = 0.31;
        candidate.evidence.algorithmSources = [
            "candidate_ranking",
            "cofecha_segment_lag",
        ];
        candidate.evidence.notes = ["candidate_hard_gate_passed"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: final },
            { stage: "candidate", authority: "selected", event: candidate },
        ]);

        expect(decision.event).toMatchObject({
            id: "localized-final-partial",
            startYear: 1910,
            endYear: 1922,
            rankedYears: [{ year: 1916 }],
        });
    });

    it("does not replace a calibrated stable partial location", () => {
        const final = event("stable-final-partial", "partialMove", 1864, 1876, 1870);
        final.shiftYears = -6;
        final.shiftSide = "older";
        final.evidence.lagBefore = -6;
        final.evidence.lagAfter = 0;
        final.evidence.locationEvidence = [{
            source: "stable_partial_location_consensus",
            startYear: 1864,
            endYear: 1876,
            topYear: 1870,
            referenceCount: 12,
            concentration: 0.9,
            remoteMargin: null,
            calibrated: true,
        }];
        const candidate = event("newer-cofecha-partial", "partialMove", 1871, 1879, 1875);
        candidate.shiftYears = -6;
        candidate.shiftSide = "older";
        candidate.confidenceLevel = "high";
        candidate.evidence.lagBefore = -6;
        candidate.evidence.lagAfter = 0;
        candidate.evidence.correlationGain = 0.31;
        candidate.evidence.algorithmSources = [
            "candidate_ranking",
            "cofecha_segment_lag",
        ];
        candidate.evidence.notes = ["candidate_hard_gate_passed"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: final },
            { stage: "candidate", authority: "selected", event: candidate },
        ]);

        expect(decision.event).toMatchObject({
            id: "stable-final-partial",
            startYear: 1864,
            endYear: 1876,
            rankedYears: [{ year: 1870 }],
        });
    });

    it("keeps selected location authority when the supplemental window overlaps it", () => {
        const located = event("located-overlap", "partialMove", 1817, 1829, 1823);
        located.shiftYears = -20;
        located.evidence.lagBefore = -20;
        located.evidence.algorithmSources = ["full_interval_counterfactual_locator"];
        const fallback = event("fallback-overlap", "partialMove", 1810, 1822, 1816);
        fallback.shiftYears = -20;
        fallback.evidence.lagBefore = -20;
        fallback.evidence.score = 40;
        fallback.evidence.scoreMargin = 7;
        fallback.evidence.algorithmSources = ["bounded_complete_lag_path"];
        fallback.evidence.notes = ["bounded_path_complete_hypothesis=true"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: located },
            { stage: "final", authority: "supplemental", event: fallback },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            event: {
                id: "located-overlap",
                startYear: 1817,
                endYear: 1829,
            },
        });
    });

    it("keeps an accepted strong selected locator over a distant bounded plateau", () => {
        const located = event("located-strong", "partialMove", 1783, 1795, 1792);
        located.shiftYears = -6;
        located.evidence.lagBefore = -6;
        located.evidence.algorithmSources = [
            "full_interval_counterfactual_locator",
            "reference_core_voting",
        ];
        located.evidence.notes = [
            "locator_adjudication=accepted_overlapping_strong_mode",
        ];
        located.evidence.locationEvidence = [{
            source: "full_interval_counterfactual_locator",
            startYear: 1783,
            endYear: 1795,
            topYear: 1792,
            referenceCount: 16,
            concentration: 0.57,
            remoteMargin: 0.99,
            calibrated: false,
        }];
        const bounded = event("bounded-remote", "partialMove", 1803, 1815, 1809);
        bounded.shiftYears = -6;
        bounded.evidence.lagBefore = -6;
        bounded.evidence.algorithmSources = ["bounded_complete_lag_path"];
        bounded.evidence.notes = ["bounded_path_complete_hypothesis=true"];
        bounded.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1803,
            endYear: 1815,
            topYear: 1809,
            referenceCount: 34,
            concentration: 0.45,
            remoteMargin: 0.095,
            calibrated: false,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: located },
            { stage: "final", authority: "supplemental", event: bounded },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            event: {
                id: "located-strong",
                startYear: 1783,
                endYear: 1795,
                shiftYears: -6,
            },
        });
    });

    it("uses a matching bounded operation to corroborate the selected frontier", () => {
        const selected = event("selected-missing", "missingRing", 1973, 1985, 1979);
        selected.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        const boundedMissing = event("bounded-missing", "missingRing", 1947, 1959, 1953);
        boundedMissing.evidence.algorithmSources = ["bounded_complete_lag_path"];
        const boundedPartial = event("bounded-partial", "partialMove", 1861, 1873, 1867);
        boundedPartial.shiftYears = -3;
        boundedPartial.evidence.lagBefore = -3;
        boundedPartial.evidence.algorithmSources = ["bounded_complete_lag_path"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: selected },
            { stage: "final", authority: "supplemental", event: boundedMissing },
            { stage: "final", authority: "supplemental", event: boundedPartial },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            event: {
                id: "selected-missing",
                startYear: 1973,
                endYear: 1985,
            },
        });
    });

    it("does not let an unrelated newer bounded operation enter a corroborated mode", () => {
        const selected = event("selected-false", "falseRing", 1689, 1697, 1693);
        selected.evidence.notes = ["candidate_hard_gate_passed"];
        const boundedFalse = event("bounded-false", "falseRing", 1687, 1699, 1693);
        boundedFalse.evidence.algorithmSources = ["bounded_complete_lag_path"];
        boundedFalse.evidence.notes = ["bounded_path_complete_hypothesis=true"];
        boundedFalse.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1687,
            endYear: 1699,
            topYear: 1693,
            referenceCount: 20,
            concentration: 0.75,
            remoteMargin: 2,
            calibrated: false,
        }];
        const remoteMissing = event("remote-missing", "missingRing", 1821, 1833, 1827);
        remoteMissing.evidence.algorithmSources = ["bounded_complete_lag_path"];
        remoteMissing.evidence.notes = ["bounded_path_complete_hypothesis=true"];
        remoteMissing.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1821,
            endYear: 1833,
            topYear: 1827,
            referenceCount: 20,
            concentration: 0.81,
            remoteMargin: 9,
            calibrated: false,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: selected },
            { stage: "final", authority: "supplemental", event: boundedFalse },
            { stage: "final", authority: "supplemental", event: remoteMissing },
        ]);

        expect(decision.event).toMatchObject({
            eventType: "falseRing",
            startYear: 1687,
            endYear: 1699,
            rankedYears: [{ year: 1693 }],
        });
    });

    it("keeps a newer bounded frontier over an older selected mode of the same operation", () => {
        const selected = event("selected-old-mode", "missingRing", 1952, 1964, 1958);
        const bounded = event("bounded-new-frontier", "missingRing", 1969, 1981, 1975);
        bounded.evidence.algorithmSources = ["bounded_complete_lag_path"];
        bounded.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1969,
            endYear: 1981,
            topYear: 1975,
            referenceCount: 12,
            concentration: 0.8,
            remoteMargin: 0.2,
            calibrated: false,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: selected },
            { stage: "final", authority: "supplemental", event: bounded },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            event: {
                id: "bounded-new-frontier",
                startYear: 1969,
                endYear: 1981,
            },
        });
    });

    it("does not let a supplemental bounded path rewrite a selected operation", () => {
        const selected = event("selected-partial", "partialMove", 1773, 1785, 1779);
        selected.shiftYears = -20;
        selected.evidence.lagBefore = -20;
        const bounded = event("bounded-aggregate", "partialMove", 1936, 1948, 1942);
        bounded.shiftYears = -24;
        bounded.evidence.lagBefore = -24;
        bounded.evidence.algorithmSources = ["bounded_complete_lag_path"];
        bounded.evidence.notes = ["bounded_path_complete_hypothesis=true"];
        bounded.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1936,
            endYear: 1948,
            topYear: 1942,
            referenceCount: 13,
            concentration: 0.99,
            remoteMargin: 7,
            calibrated: false,
        }];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: selected },
            { stage: "final", authority: "supplemental", event: bounded },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            event: { id: "selected-partial", shiftYears: -20 },
        });
    });

    it("accepts a bounded local transition that lands on the selected whole baseline", () => {
        const whole = event("whole", "wholeSeriesMove", 1100, 1500, 1500);
        whole.shiftYears = -4;
        whole.rankedYears = [];
        whole.evidence.lagBefore = -4;
        whole.evidence.lagAfter = -4;
        const local = event("local", "partialMove", 1325, 1337, 1331);
        local.shiftYears = -20;
        local.evidence.lagBefore = -24;
        local.evidence.lagAfter = -4;
        local.evidence.algorithmSources = ["bounded_complete_lag_path"];
        local.evidence.notes = ["bounded_path_complete_hypothesis=true"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: whole },
            { stage: "final", authority: "supplemental", event: local },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            event: { id: "local", shiftYears: -20 },
        });
    });

    it("applies a dominant whole baseline before an unsupported bounded transition", () => {
        const whole = event("whole", "wholeSeriesMove", 1100, 1500, 1500);
        whole.shiftYears = -4;
        whole.rankedYears = [];
        whole.evidence.lagBefore = -4;
        whole.evidence.lagAfter = 0;
        whole.evidence.algorithmSources = ["dominant_whole_state_consensus"];
        const local = event("local", "partialMove", 1120, 1132, 1126);
        local.shiftYears = -73;
        local.evidence.lagBefore = -77;
        local.evidence.lagAfter = -4;
        local.evidence.correlationGain = 0.011;
        local.evidence.algorithmSources = ["bounded_complete_lag_path"];
        local.evidence.notes = ["bounded_path_complete_hypothesis=true"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            { stage: "final", authority: "selected", event: whole },
            { stage: "final", authority: "supplemental", event: local },
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            event: { id: "whole", eventType: "wholeSeriesMove", shiftYears: -4 },
        });
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

    it("promotes a reviewed missing frontier outside the bark ambiguity range", () => {
        const whole = event("terminal-unit", "wholeSeriesMove", 1600, 2000, 0);
        whole.shiftYears = -1;
        whole.evidence.notes = [
            "whole_baseline_source=bounded_constant_lag_path",
            "bounded_path_fixed_side_observed=false",
        ];
        const frontier = event("distant-frontier", "missingRing", 1973, 1979, 1977);
        frontier.evidence.lagBefore = -1;
        frontier.evidence.lagAfter = 0;
        frontier.evidence.algorithmSources = ["sequential_missing_staircase_head"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", whole),
            checkpoint("final", frontier),
        ]);

        expect(decision.event).toMatchObject({
            id: "distant-frontier",
            eventType: "missingRing",
            startYear: 1973,
            endYear: 1979,
        });
        expect(decision.event?.interpretationAmbiguity).toBeUndefined();
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
                    startYear: 1986,
                    endYear: 1994,
                },
            },
        });
        expect(
            decision.event?.interpretationAmbiguity?.alternative.rankedYears[0],
        ).toMatchObject({ year: 1990, rank: 1 });
    });

    it.each([-2, -3] as const)(
        "exposes one reviewed missing-ring step for a terminal %i-year whole shift",
        (shiftYears) => {
            const whole = event(`terminal-${Math.abs(shiftYears)}`, "wholeSeriesMove", 1732, 1994, 0);
            whole.shiftYears = shiftYears;
            whole.evidence.lagBefore = shiftYears;
            whole.evidence.notes = [
                "whole_baseline_source=cofecha_terminal_lag",
                "cofecha_terminal_segments=2",
                "cofecha_terminal_consistency=1.000000",
            ];
            const endpoint = event(`endpoint-${Math.abs(shiftYears)}`, "missingRing", 1987, 1993, 1990);
            endpoint.evidence.lagBefore = shiftYears;
            endpoint.evidence.lagAfter = shiftYears + 1;
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
                shiftYears,
                interpretationAmbiguity: {
                    kind: "wholeSeriesMoveOrMissingRing",
                    evidence: { wholeShiftYears: shiftYears },
                    alternative: {
                        id: endpoint.id,
                        eventType: "missingRing",
                    },
                },
            });
        },
    );

    it("shifts a thirteen-year endpoint review just enough to retain its local mode", () => {
        const whole = event("terminal-unit", "wholeSeriesMove", 1480, 1878, 0);
        whole.shiftYears = -1;
        whole.seriesRange = { startYear: 1480, endYear: 1878 };
        const local = event("local-endpoint-mode", "missingRing", 1861, 1867, 1864);
        local.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
            "segmented_diagnosis",
        ];
        local.evidence.notes = ["candidate_hard_gate_passed"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", local),
            checkpoint("final", whole),
        ]);
        const alternative = decision.event?.interpretationAmbiguity?.alternative;

        expect(alternative).toMatchObject({
            eventType: "missingRing",
            startYear: 1864,
            endYear: 1876,
        });
        expect(alternative?.rankedYears[0]).toMatchObject({ year: 1864, rank: 1 });
    });

    it("does not expose the missing-ring shortcut for a four-year whole shift", () => {
        const whole = event("terminal-4", "wholeSeriesMove", 1732, 1994, 0);
        whole.shiftYears = -4;
        whole.evidence.lagBefore = -4;
        const endpoint = event("endpoint-4", "missingRing", 1987, 1993, 1990);
        endpoint.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
        ];
        endpoint.evidence.notes = ["candidate_hard_gate_passed"];

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", endpoint),
            checkpoint("final", whole),
        ]);

        expect(decision.event).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: -4,
        });
        expect(decision.event?.interpretationAmbiguity).toBeUndefined();
    });

    it("ignores a remote candidate but retains a constrained bark-end missing review", () => {
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
            interpretationAmbiguity: {
                kind: "wholeSeriesMoveOrMissingRing",
                alternative: {
                    eventType: "missingRing",
                    startYear: 1982,
                    endYear: 1994,
                    reviewOnly: true,
                },
            },
        });
        expect(
            decision.event?.interpretationAmbiguity?.alternative.evidence.algorithmSources,
        ).toContain("synthetic_endpoint_missing_review");
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

    it("keeps a constrained missing review available for an unreviewed terminal alias", () => {
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
            interpretationAmbiguity: {
                kind: "wholeSeriesMoveOrMissingRing",
                alternative: {
                    eventType: "missingRing",
                    startYear: 1992,
                    endYear: 2004,
                    reviewOnly: true,
                },
            },
        });
    });

    it("synthesizes one endpoint missing review when a unit whole has no local candidate", () => {
        const whole = event("terminal-unit", "wholeSeriesMove", 1600, 2002, 0);
        whole.shiftYears = -1;
        whole.seriesRange = { startYear: 1600, endYear: 2002 };

        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("final", whole),
        ]);

        expect(decision.event).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: -1,
            interpretationAmbiguity: {
                kind: "wholeSeriesMoveOrMissingRing",
                alternative: {
                    eventType: "missingRing",
                    startYear: 1990,
                    endYear: 2002,
                    reviewOnly: true,
                },
            },
        });
    });
});

import { describe, expect, it } from "vitest";
import type { DiagnosisEvent } from "../types";
import {
    preservesStrongBoundedPathMode,
    projectCumulativePartialToValidatedUnitFrontier,
    projectMultiEventLocationConsensus,
    projectNegativeEventToCrossPenaltyEquivalentFrontier,
    projectUnsupportedLocationToStrongBoundedPath,
    projectUnitLocationFromIndependentConsensus,
    strongBoundedPathLocation,
    terminalFalseRingOlderPadding,
    terminalMissingRingNewerPadding,
} from "../locationAuthority";

const event = (overrides: Partial<NonNullable<DiagnosisEvent["evidence"]["locationEvidence"]>[number]> = {}): DiagnosisEvent => ({
    id: "bounded",
    seriesId: "A",
    eventType: "missingRing",
    startYear: 1885,
    endYear: 1897,
    rankedYears: [{ year: 1891, rank: 1, score: 1, evidenceTags: [] }],
    confidenceLevel: "high",
    evidence: {
        algorithmSources: ["bounded_complete_lag_path"],
        score: 10,
        scoreMargin: 1,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.6,
        correlationGain: 0.4,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 100,
        candidateIds: [],
        notes: [],
        locationEvidence: [{
            source: "bounded_complete_lag_path",
            startYear: 1885,
            endYear: 1897,
            topYear: 1891,
            referenceCount: 17,
            concentration: 0.89,
            remoteMargin: 7.5,
            calibrated: false,
            ...overrides,
        }],
    },
    alternativeTypes: [],
});

describe("strong bounded-path location authority", () => {
    it("rejects a downstream window that excludes a strong path mode", () => {
        const input = event();
        expect(strongBoundedPathLocation(input)?.topYear).toBe(1891);
        expect(preservesStrongBoundedPathMode(input, 1874, 1886)).toBe(false);
        expect(preservesStrongBoundedPathMode(input, 1885, 1897)).toBe(true);
    });

    it("allows a detached refinement when the path mode is diffuse", () => {
        const input = event({ concentration: 0.2 });
        expect(strongBoundedPathLocation(input)).toBeNull();
        expect(preservesStrongBoundedPathMode(input, 1874, 1886)).toBe(true);
    });

    it("restores a strong source window after an unsupported downstream rewrite", () => {
        const input = event();
        input.startYear = 1883;
        input.endYear = 1895;
        expect(projectUnsupportedLocationToStrongBoundedPath(input)).toMatchObject({
            startYear: 1885,
            endYear: 1897,
            rankedYears: expect.arrayContaining([
                expect.objectContaining({ year: 1891 }),
            ]),
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "strong_bounded_path_location_projection",
                ]),
            },
        });
    });
});

describe("multi-event frontier location consensus", () => {
    it("keeps a cumulative partial operation at a cross-penalty missing frontier", () => {
        const partial = event();
        partial.eventType = "partialMove";
        partial.shiftYears = -3;
        partial.shiftSide = "older";
        partial.startYear = 1600;
        partial.endYear = 1612;
        partial.rankedYears = [{ year: 1606, rank: 1, score: 4, evidenceTags: [] }];
        partial.evidence.lagBefore = -3;
        partial.evidence.lagAfter = 0;
        const missing = event();
        missing.startYear = 1612;
        missing.endYear = 1624;
        missing.rankedYears = [{ year: 1618, rank: 1, score: 8, evidenceTags: [] }];
        missing.evidence.lagBefore = -1;
        missing.evidence.lagAfter = 0;
        missing.evidence.notes = ["bounded_path_location_concentration=0.91"];
        const probe = (year: number) => ({
            transitionGain: 40,
            runnerUpMargin: 0.3,
            events: [{
                ...missing,
                rankedYears: [{ year, rank: 1, score: 8, evidenceTags: [] }],
            }],
        });

        expect(projectNegativeEventToCrossPenaltyEquivalentFrontier(
            partial,
            probe(1618),
            probe(1619),
            { startYear: 1400, endYear: 2000 },
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -3,
            startYear: 1614,
            endYear: 1626,
            rankedYears: expect.arrayContaining([
                expect.objectContaining({ year: 1620, rank: 1 }),
            ]),
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "cross_penalty_equivalent_frontier_location",
                ]),
            },
        });
    });

    it("does not let the same operation encoding become a second locator", () => {
        const partial = event();
        partial.eventType = "partialMove";
        partial.shiftYears = -6;
        partial.shiftSide = "older";
        partial.evidence.lagBefore = -6;
        partial.evidence.lagAfter = 0;
        const other = {
            ...partial,
            startYear: 1920,
            endYear: 1932,
            rankedYears: [{ year: 1926, rank: 1, score: 8, evidenceTags: [] }],
            evidence: {
                ...partial.evidence,
                notes: ["bounded_path_location_concentration=0.95"],
            },
        };
        const probe = {
            transitionGain: 50,
            runnerUpMargin: 0.5,
            events: [other],
        };

        expect(projectNegativeEventToCrossPenaltyEquivalentFrontier(
            partial,
            probe,
            probe,
            { startYear: 1400, endYear: 2000 },
        )).toBe(partial);
    });

    it("moves a calibrated cumulative partial to a newer independently verified unit frontier", () => {
        const partial = event({ calibrated: true });
        partial.eventType = "partialMove";
        partial.shiftYears = -3;
        partial.shiftSide = "older";
        partial.startYear = 1858;
        partial.endYear = 1870;
        partial.seriesRange = { startYear: 1602, endYear: 2000 };
        partial.rankedYears = [{ year: 1864, rank: 1, score: 4, evidenceTags: [] }];
        partial.evidence.lagBefore = -3;
        partial.evidence.lagAfter = 0;
        partial.evidence.notes.push(
            "stable_bounded_path_transition_count=4",
            "stable_bounded_path_all_transitions_partial=false",
        );
        const frontier = event();
        frontier.startYear = 1875;
        frontier.endYear = 1883;
        frontier.rankedYears = [{ year: 1879, rank: 1, score: 3, evidenceTags: [] }];
        frontier.evidence = {
            ...frontier.evidence,
            scoreMargin: 0.33,
            correlationGain: 0.08,
            samplePairs: 35,
            lagBefore: -1,
            lagAfter: 0,
            algorithmSources: [
                "collapsed_missing_staircase_head",
                "counterfactual_window_refinement",
                "local_counterfactual_raw_year",
                "piecewise_lag_path",
            ],
            notes: [
                "nominal_boundary_year=1879",
                "profile_boundary_year=1879",
                "scan_top_year=1879",
                "unit_local_raw31_year=1879",
                "unit_local_difference31_year=1879",
                "unit_local_whitened31_year=1879",
                "unit_local_multiScale_year=1879",
                "unit_local_pairMean31_year=1879",
            ],
        };

        const projected = projectCumulativePartialToValidatedUnitFrontier(
            partial,
            [frontier],
            { startYear: 1602, endYear: 2000 },
        );

        expect(projected).toMatchObject({
            eventType: "partialMove",
            shiftYears: -3,
            startYear: 1873,
            endYear: 1885,
            rankedYears: expect.arrayContaining([
                expect.objectContaining({ year: 1880, rank: 1 }),
            ]),
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "validated_newer_unit_frontier_location",
                ]),
                notes: expect.arrayContaining([
                    "validated_unit_frontier_missing_year=1879",
                    "validated_unit_frontier_first_fixed_year=1880",
                ]),
            },
        });
    });

    it("does not move a cumulative partial for a weak or boundary-inconsistent unit mode", () => {
        const partial = event();
        partial.eventType = "partialMove";
        partial.shiftYears = -3;
        partial.shiftSide = "older";
        partial.startYear = 1858;
        partial.endYear = 1870;
        partial.evidence.lagBefore = -3;
        partial.evidence.lagAfter = 0;
        partial.evidence.notes.push(
            "stable_bounded_path_transition_count=4",
            "stable_bounded_path_all_transitions_partial=false",
        );
        const weak = event();
        weak.startYear = 1875;
        weak.endYear = 1883;
        weak.rankedYears = [{ year: 1879, rank: 1, score: 3, evidenceTags: [] }];
        weak.evidence = {
            ...weak.evidence,
            lagBefore: -1,
            lagAfter: 0,
            algorithmSources: [
                "collapsed_missing_staircase_head",
                "counterfactual_window_refinement",
                "local_counterfactual_raw_year",
                "piecewise_lag_path",
            ],
            notes: [
                "nominal_boundary_year=1879",
                "profile_boundary_year=1878",
                "scan_top_year=1879",
            ],
        };

        expect(projectCumulativePartialToValidatedUnitFrontier(
            partial,
            [weak],
            { startYear: 1602, endYear: 2000 },
        )).toBe(partial);
        expect(projectCumulativePartialToValidatedUnitFrontier(
            partial,
            [{
                ...weak,
                evidence: {
                    ...weak.evidence,
                    notes: [
                        ...weak.evidence.notes.filter((note) => !note.startsWith(
                            "profile_boundary_year=",
                        )),
                        "profile_boundary_year=1879",
                        "unit_local_raw31_year=1879",
                        "unit_local_difference31_year=1879",
                        "unit_local_whitened31_year=1879",
                        "unit_local_multiScale_year=1879",
                        "unit_local_pairMean31_year=1879",
                    ],
                },
            }],
            { startYear: 1602, endYear: 2000 },
            true,
        )).toBe(partial);
    });

    it("does not rewrite an already calibrated current window", () => {
        const input = event({ calibrated: true });
        expect(projectMultiEventLocationConsensus(
            input,
            [1894, 1897],
            { startYear: 1400, endYear: 2000 },
            true,
        )).toBe(input);
    });

    it("centers one window between a current mode and a compact older evidence group", () => {
        const input = event();
        input.startYear = 1630;
        input.endYear = 1642;
        input.rankedYears = [{ year: 1636, rank: 1, score: 4, evidenceTags: [] }];

        expect(projectMultiEventLocationConsensus(
            input,
            [1616, 1620, 1621],
            { startYear: 1400, endYear: 2000 },
            true,
        )).toMatchObject({
            startYear: 1620,
            endYear: 1632,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "multi_event_frontier_location_consensus",
                ]),
            },
        });
    });

    it("keeps the stable terminal boundary inside an averaged multi-event window", () => {
        const input = event();
        input.eventType = "falseRing";
        input.startYear = 1876;
        input.endYear = 1884;
        input.rankedYears = [{ year: 1880, rank: 1, score: 4, evidenceTags: [] }];
        input.evidence.algorithmSources.push(
            "stable_terminal_unit_staircase_frontier",
        );
        input.evidence.notes.push("terminal_unit_staircase_boundary_year=1880");

        expect(projectMultiEventLocationConsensus(
            input,
            [1866, 1871],
            { startYear: 1400, endYear: 2000 },
            true,
        )).toMatchObject({
            eventType: "falseRing",
            startYear: 1868,
            endYear: 1880,
            evidence: {
                notes: expect.arrayContaining([
                    "multi_frontier_terminal_boundary_guard=1880",
                ]),
            },
        });
    });

    it("keeps more older-side context for a stable terminal false-ring boundary", () => {
        const input = event();
        input.eventType = "falseRing";
        input.startYear = 1863;
        input.endYear = 1871;
        input.rankedYears = [{ year: 1867, rank: 1, score: 4, evidenceTags: [] }];
        input.evidence.algorithmSources.push(
            "stable_terminal_unit_staircase_frontier",
        );
        input.evidence.notes.push(
            "terminal_unit_staircase_boundary_year=1867",
            "terminal_unit_staircase_transition_years=1854,1857,1865,1867",
            "terminal_unit_staircase_max_adjacent_gap_years=8",
        );
        expect(terminalFalseRingOlderPadding(input)).toBe(8);

        expect(projectMultiEventLocationConsensus(
            input,
            [1867],
            { startYear: 1400, endYear: 2000 },
            true,
        )).toMatchObject({
            startYear: 1859,
            endYear: 1871,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "terminal_false_ring_asymmetric_window",
                ]),
                notes: expect.arrayContaining([
                    "terminal_false_ring_older_padding=8",
                    "terminal_false_ring_newer_padding=4",
                ]),
            },
        });
    });

    it("keeps more newer-side context for a deep terminal missing-ring boundary", () => {
        const input = event();
        input.startYear = 1779;
        input.endYear = 1791;
        input.rankedYears = [{ year: 1786, rank: 1, score: 4, evidenceTags: [] }];
        input.evidence.algorithmSources.push(
            "stable_terminal_unit_staircase_frontier",
        );
        input.evidence.notes.push(
            "terminal_unit_staircase_boundary_year=1786",
            "terminal_unit_staircase_transition_years=1734,1765,1786",
            "terminal_unit_staircase_max_adjacent_gap_years=31",
        );
        expect(terminalMissingRingNewerPadding(input)).toBe(10);

        expect(projectMultiEventLocationConsensus(
            input,
            [1784, 1785, 1786],
            { startYear: 1400, endYear: 2000 },
            true,
        )).toMatchObject({
            startYear: 1784,
            endYear: 1796,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "terminal_missing_ring_asymmetric_window",
                ]),
                notes: expect.arrayContaining([
                    "terminal_missing_ring_older_padding=2",
                    "terminal_missing_ring_newer_padding=10",
                ]),
            },
        });
    });

    it("keeps the raw path boundary inside a cadence-calibrated terminal window", () => {
        const input = event();
        input.startYear = 1793;
        input.endYear = 1801;
        input.rankedYears = [{ year: 1797, rank: 1, score: 4, evidenceTags: [] }];
        input.evidence.algorithmSources.push(
            "stable_terminal_unit_staircase_frontier",
        );
        input.evidence.notes.push(
            "terminal_unit_staircase_boundary_year=1797",
            "terminal_unit_staircase_raw_boundary_year=1793",
            "terminal_unit_staircase_transition_years=1765,1776,1786,1793",
            "terminal_unit_staircase_max_adjacent_gap_years=11",
        );

        expect(projectMultiEventLocationConsensus(
            input,
            [1785, 1792, 1797],
            { startYear: 1400, endYear: 2000 },
            true,
            16,
            1792,
        )).toMatchObject({
            startYear: 1793,
            endYear: 1805,
            evidence: {
                notes: expect.arrayContaining([
                    "terminal_cadence_raw_boundary_guard=1793",
                ]),
            },
        });
    });

    it("chooses the newer compact mode instead of joining a distant older peak", () => {
        const input = event();
        input.startYear = 1863;
        input.endYear = 1875;
        input.rankedYears = [{ year: 1869, rank: 1, score: 4, evidenceTags: [] }];

        expect(projectMultiEventLocationConsensus(
            input,
            [1852, 1853, 1881],
            { startYear: 1400, endYear: 2000 },
            true,
        )).toMatchObject({
            startYear: 1869,
            endYear: 1881,
        });
    });

    it("does not average detached modes that cannot fit in one 13-year window", () => {
        const input = event();
        input.startYear = 1973;
        input.endYear = 1979;
        input.rankedYears = [{ year: 1977, rank: 1, score: 4, evidenceTags: [] }];
        input.evidence.notes.push(
            "distant_sequential_frontier_year=1977",
            "nominal_boundary_year=1977",
        );

        expect(projectMultiEventLocationConsensus(
            input,
            [1977, 1993],
            { startYear: 1597, endYear: 2000 },
            true,
            16,
        )).toBe(input);
    });

    it("keeps the selected event's direct frontier ahead of a weaker checkpoint", () => {
        const input = event();
        input.startYear = 1971;
        input.endYear = 1983;
        input.rankedYears = [{ year: 1977, rank: 1, score: 4, evidenceTags: [] }];
        input.evidence.notes.push(
            "sequential_missing_head_year=1977",
            "shared_zero_marker_year=1977",
        );

        const projected = projectMultiEventLocationConsensus(
            input,
            [1970, 1973, 1975, 1977],
            { startYear: 1597, endYear: 2000 },
            true,
            12,
            1975,
        );

        expect(projected).toMatchObject({ startYear: 1971, endYear: 1983 });
        expect(projected.rankedYears[0]?.year).toBe(1977);
    });

    it("anchors a cumulative mode to a validated bark-side unit frontier", () => {
        const input = event();
        input.eventType = "partialMove";
        input.shiftYears = -3;
        input.startYear = 1855;
        input.endYear = 1867;
        input.rankedYears = [{ year: 1865, rank: 1, score: 4, evidenceTags: [] }];

        expect(projectMultiEventLocationConsensus(
            input,
            [1865, 1875],
            { startYear: 1503, endYear: 2000 },
            true,
            16,
            1875,
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -3,
            startYear: 1869,
            endYear: 1881,
            rankedYears: expect.arrayContaining([
                expect.objectContaining({ year: 1875, rank: 1 }),
            ]),
            evidence: {
                notes: expect.arrayContaining([
                    "multi_frontier_validated_unit_anchor=1875",
                ]),
            },
        });
    });

    it("uses a 13-year window without moving a single unsupported mode", () => {
        const input = event();
        input.startYear = 1887;
        input.endYear = 1895;

        expect(projectMultiEventLocationConsensus(
            input,
            [],
            { startYear: 1400, endYear: 2000 },
            true,
        )).toBe(input);
        const terminal = {
            ...input,
            evidence: {
                ...input.evidence,
                algorithmSources: ["stable_terminal_unit_staircase_frontier"],
            },
        };
        expect(projectMultiEventLocationConsensus(
            terminal,
            [],
            { startYear: 1400, endYear: 2000 },
            true,
        )).toMatchObject({ startYear: 1885, endYear: 1897 });
        expect(projectMultiEventLocationConsensus(
            input,
            [],
            { startYear: 1400, endYear: 2000 },
            false,
        )).toBe(input);
    });
});

describe("independent unit location consensus", () => {
    const candidate = (type: "missingRing" | "falseRing", year: number): DiagnosisEvent => ({
        ...event(),
        id: `candidate-${type}-${year}`,
        eventType: type,
        startYear: year - 3,
        endYear: year + 3,
        rankedYears: Array.from({ length: 7 }, (_, index) => ({
            year: year - 3 + index,
            rank: Math.abs(index - 3) + 1,
            score: index === 3 ? 2 : 1 / (1 + Math.abs(index - 3)),
            evidenceTags: [],
        })).sort((left, right) => right.score - left.score),
        evidence: {
            ...event().evidence,
            algorithmSources: ["candidate_ranking"],
            score: 25,
            candidateIds: ["candidate"],
            notes: ["candidate_hard_gate_passed"],
            locationEvidence: [],
        },
    });

    it("projects a remote COFECHA mode to agreeing candidate and raw-path evidence", () => {
        const selected = event();
        selected.startYear = 1668;
        selected.endYear = 1676;
        selected.rankedYears = [{ year: 1670, rank: 1, score: 2, evidenceTags: [] }];
        const rawPath = event();
        rawPath.startYear = 1707;
        rawPath.endYear = 1713;
        rawPath.rankedYears = [{ year: 1711, rank: 1, score: 8, evidenceTags: [] }];
        rawPath.evidence.locationEvidence = [];
        const projected = projectUnitLocationFromIndependentConsensus(
            selected,
            [candidate("missingRing", 1709)],
            [rawPath],
            null,
            { startYear: 1400, endYear: 2000 },
        );
        expect(projected).toMatchObject({
            startYear: 1706,
            endYear: 1712,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "independent_unit_location_consensus",
                ]),
            },
        });
        expect(projected.startYear).toBeLessThanOrEqual(1710);
        expect(projected.endYear).toBeGreaterThanOrEqual(1710);
    });

    it("accepts candidate plus a high-margin full-interval operation without a raw path", () => {
        const selected = event();
        selected.startYear = 1834;
        selected.endYear = 1840;
        selected.rankedYears = [{ year: 1835, rank: 1, score: 2, evidenceTags: [] }];
        selected.evidence.locationEvidence = [];
        const projected = projectUnitLocationFromIndependentConsensus(
            selected,
            [candidate("missingRing", 1751)],
            [],
            {
                eventType: "missingRing",
                bestYear: 1750,
                score: 0.46,
                scoreMargin: 0.46,
            },
            { startYear: 1400, endYear: 2000 },
        );
        expect(projected.startYear).toBe(1748);
        expect(projected.endYear).toBe(1754);
    });

    it("does not let a low-confidence candidate and operation move a remote unit window", () => {
        const selected = event();
        selected.startYear = 1754;
        selected.endYear = 1759;
        selected.eventType = "falseRing";
        selected.evidence.locationEvidence = [];
        const weakCandidate = candidate("falseRing", 1697);
        weakCandidate.confidenceLevel = "low";
        expect(projectUnitLocationFromIndependentConsensus(
            selected,
            [weakCandidate],
            [],
            {
                eventType: "falseRing",
                bestYear: 1695,
                score: 0.4,
                scoreMargin: 0.2,
            },
            { startYear: 1400, endYear: 2000 },
        )).toMatchObject({
            startYear: 1754,
            endYear: 1760,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "selected_unit_window_width_normalization",
                ]),
            },
        });
    });

    it("restores a cross-channel candidate after a weak detached endpoint rewrite", () => {
        const selected = event();
        selected.eventType = "falseRing";
        selected.startYear = 883;
        selected.endYear = 895;
        selected.rankedYears = [{ year: 891, rank: 1, score: 3, evidenceTags: [] }];
        selected.evidence.locationEvidence = [];
        selected.evidence.notes = [
            "locator_adjudication=fallback_detached_locator_mode",
            "endpoint_residual_previous_range=1024-1032",
            "endpoint_residual_core_range=886-892",
            "endpoint_residual_reference_count=7",
            "unit_window_bestReference31_margin=0.085629",
            "unit_local_raw31_year=1026",
            "unit_local_difference31_year=1027",
            "unit_local_whitened31_year=1026",
            "unit_local_combo31_year=1029",
            "unit_local_combo41_year=1028",
            "unit_local_combo61_year=1030",
        ];
        const supportedCandidate = candidate("falseRing", 1029);
        supportedCandidate.confidenceLevel = "low";
        const projected = projectUnitLocationFromIndependentConsensus(
            selected,
            [supportedCandidate],
            [],
            null,
            { startYear: 800, endYear: 1300 },
        );
        expect(projected).toMatchObject({
            startYear: 1026,
            endYear: 1032,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "independent_unit_location_consensus",
                ]),
            },
        });
    });

    it("does not let candidate plus operation alone override a strong bounded path", () => {
        const selected = event({ topYear: 1355, startYear: 1349, endYear: 1361 });
        selected.eventType = "falseRing";
        selected.startYear = 1349;
        selected.endYear = 1361;
        selected.rankedYears = [{ year: 1355, rank: 1, score: 8, evidenceTags: [] }];
        const projected = projectUnitLocationFromIndependentConsensus(
            selected,
            [candidate("falseRing", 1272)],
            [],
            {
                eventType: "falseRing",
                bestYear: 1273,
                score: 0.4,
                scoreMargin: 0.2,
            },
            { startYear: 1100, endYear: 1600 },
        );
        expect(projected).toBe(selected);
    });

    it("does not grant location authority to an unsupported candidate", () => {
        const selected = event();
        const projected = projectUnitLocationFromIndependentConsensus(
            selected,
            [candidate("missingRing", 1751)],
            [],
            {
                eventType: "missingRing",
                bestYear: 1750,
                score: 0.03,
                scoreMargin: 0.01,
            },
            { startYear: 1400, endYear: 2000 },
        );
        expect(projected).toBe(selected);
    });

    it("keeps an allowed wider review window around the independent consensus", () => {
        const selected = event();
        selected.startYear = 1983;
        selected.endYear = 1995;
        selected.rankedYears = [{ year: 1989, rank: 1, score: 2, evidenceTags: [] }];
        const rawPath = event();
        rawPath.eventType = "falseRing";
        rawPath.startYear = 1717;
        rawPath.endYear = 1723;
        rawPath.rankedYears = [{ year: 1721, rank: 1, score: 8, evidenceTags: [] }];
        rawPath.evidence.locationEvidence = [];
        const projected = projectUnitLocationFromIndependentConsensus(
            { ...selected, eventType: "falseRing" },
            [candidate("falseRing", 1721)],
            [rawPath],
            null,
            { startYear: 1400, endYear: 2000 },
        );
        const widened = {
            ...projected,
            startYear: 1715,
            endYear: 1727,
        };
        expect(projectUnsupportedLocationToStrongBoundedPath(widened)).toBe(widened);
    });

    it("merges a nearby strong path into the same allowed consensus window", () => {
        const selected = event({ topYear: 1861, startYear: 1856, endYear: 1868 });
        selected.startYear = 1856;
        selected.endYear = 1868;
        selected.rankedYears = [{ year: 1861, rank: 1, score: 8, evidenceTags: [] }];
        const rawPath = event();
        rawPath.startYear = 1855;
        rawPath.endYear = 1861;
        rawPath.rankedYears = [{ year: 1858, rank: 1, score: 8, evidenceTags: [] }];
        rawPath.evidence.locationEvidence = [];
        const projected = projectUnitLocationFromIndependentConsensus(
            selected,
            [candidate("missingRing", 1856)],
            [rawPath],
            {
                eventType: "missingRing",
                bestYear: 1859,
                score: 0.4,
                scoreMargin: 0.2,
            },
            { startYear: 1400, endYear: 2000 },
        );
        expect(projected).toBe(selected);
        expect(projected.startYear).toBeLessThanOrEqual(1861);
        expect(projected.endYear).toBeGreaterThanOrEqual(1861);
    });

    it("does not recenter an independently supported year already inside the selected mode", () => {
        const selected = event({ topYear: 1874, startYear: 1869, endYear: 1877 });
        selected.startYear = 1869;
        selected.endYear = 1877;
        selected.rankedYears = [{ year: 1874, rank: 1, score: 8, evidenceTags: [] }];
        const rawPath = event();
        rawPath.startYear = 1872;
        rawPath.endYear = 1878;
        rawPath.rankedYears = [{ year: 1875, rank: 1, score: 8, evidenceTags: [] }];
        rawPath.evidence.locationEvidence = [];
        expect(projectUnitLocationFromIndependentConsensus(
            selected,
            [candidate("missingRing", 1875)],
            [rawPath],
            null,
            { startYear: 1600, endYear: 2000 },
        )).toBe(selected);
    });

    it("does not recenter overlapping modes when candidate Top1 sits just outside an edge", () => {
        const selected = event();
        selected.startYear = 1865;
        selected.endYear = 1873;
        selected.rankedYears = [{ year: 1868, rank: 1, score: 8, evidenceTags: [] }];
        const overlappingCandidate = candidate("missingRing", 1864);
        const rawPath = event();
        rawPath.rankedYears = [{ year: 1869, rank: 1, score: 8, evidenceTags: [] }];
        rawPath.evidence.locationEvidence = [];
        expect(projectUnitLocationFromIndependentConsensus(
            selected,
            [overlappingCandidate],
            [rawPath],
            null,
            { startYear: 1600, endYear: 2000 },
        )).toBe(selected);
    });

    it("keeps a compressed missing staircase frontier ahead of an older path mode", () => {
        const selected = event({ topYear: 1852, startYear: 1846, endYear: 1858 });
        selected.startYear = 1859;
        selected.endYear = 1871;
        selected.evidence.algorithmSources.push("compressed_missing_staircase_projection");
        expect(projectUnsupportedLocationToStrongBoundedPath(selected)).toBe(selected);
    });
});

import { describe, expect, it } from "vitest";
import type { DiagnosisEvent, SeriesCoreDiagnosis } from "../types";
import {
    allowStableBoundedPathFinalAuthority,
    candidateOperationIdentityCheckpoints,
    candidateDepthTerminalUnitPreemptsSeparatedPartial,
    hasIndependentStableFrontierOperationSupport,
    hasCompletedMixedCompositionLocation,
    hasNearbyLargerPartialCompositionSeed,
    hasHighConcentrationCrossPenaltyLocationAuthority,
    localLagAdvancesCrossPenaltyFrontier,
    hasAcceptedStrongLocatorWindow,
    hasStrongMixedPathPartialAuthority,
    maySequentialMissingPreemptStableJointFrontier,
    calibratedTerminalUnitStaircaseWindowWidth,
    hasIndependentPartialBoundaryAnchor,
    decisiveExactPartialRejectsWeakUnitComposition,
    hardCandidateMaySeedExhaustiveComposition,
    hasCandidateBackedSequentialFalseDirection,
    hasCompressedSequentialFalseDirection,
    hasCoherentSequentialFalseStaircase,
    hasMultipleCoherentLocalTransitions,
    isAuthoritativeWholeSeriesCheckpoint,
    isTerminalWholeBaselineEvent,
    partialMoveExplainsWholeSeriesCandidate,
    partialMoveSupportsSequentialMissingDepth,
    pathFixedWholeBaselinePreemptsLocalPath,
    prioritizeEndpointUnitAgainstWhole,
    rawCandidateMayRecenterSequentialMissing,
    unitEventUsesWholeSeriesBaseline,
    pruneUnanchoredUnitAlternativesToCandidatePartial,
    pruneLocalEventsDisconnectedFromWholeBaseline,
    projectSequentialUnitChainHead,
    recoverCandidateBackedPartialConsensus,
    recoverCandidateAnchoredRawPartialFrontier,
    recoverAggregatePartialUnitFrontier,
    projectUnitToDistantDynamicConsensus,
    projectUnitToStrongDynamicLocation,
    recoverStableBoundedLagPathFrontier,
    selectDirectTerminalUnitBeforeDerivedStablePartial,
    selectStaleReferenceNewestFixedSidePathFrontier,
    selectCandidateBackedStableTerminalUnit,
    selectHighConfidenceSeparatedTerminalUnitFrontier,
    selectCandidateAnchoredDistantMissingFrontier,
    selectDistantSequentialMissingFrontier,
    selectEndpointAggregatePartialFrontier,
    projectEndpointMissingFromCumulativeWholeAlias,
    selectAggregateAnchoredRegularizedPartialFrontier,
    selectOperationAnchoredRegularizedAggregatePartialFrontier,
    selectCandidateAnchoredStableBoundedLagPathFrontier,
    selectStableUnitPathLocationCheckpoints,
    selectCorroboratedUnitPathLocationCheckpoint,
    selectCumulativeLagPathFrontier,
    selectStableBoundedLagPathFrontier,
    selectConservativeStableBoundedLagPathFrontier,
    selectParsimoniousPartialOperationCheckpoint,
    selectCrossPenaltyTerminalNegativeClusterCheckpoint,
    selectSeparatedPartialComponentCheckpoint,
    selectRegularizedPartialOperationConsensus,
    selectRegularizedPartialConsensusCheckpoint,
    selectRepeatedPartialComponentCheckpoint,
    selectCrossPenaltyExactPartialCheckpoint,
    selectIndependentPartialLocationCheckpoint,
    selectTerminalOperationAnchoredPartialCheckpoint,
    selectCollapsedMissingFalsePartialCheckpoint,
    selectCrossPenaltyFalseRingFrontier,
    selectCandidateBackedCrossPenaltyUnitFrontier,
    hasSelfContainedPositiveUnitChainAuthority,
    selectSelfContainedPositiveUnitChainFrontier,
    selectCumulativeMissingWholeAliasFrontier,
    selectSplitRepeatedPartialComponentCheckpoint,
    stableFrontierHasRepeatedOperationSupport,
    selectLatentEndpointWholeFrame,
    selectUnobservedFixedSideWholeLag,
    selectCandidateBackedCumulativeUnitFrontier,
    reconcileCumulativeUnitOperationWithCompletedLocation,
    refineBoundedPathLocationWithOperation,
    selectWholeBaselineLagPathFrontier,
    resolveSequentialMissingPresentation,
    selectResidualSequentialMissingPathYear,
    sequentialFalseFrontierWindow,
    selectCumulativePartialFrontier,
    selectCompletedPartialFalseSeed,
    selectCompletedPartialMissingSeed,
    selectBoundedCompletedPartialUnitSeeds,
    selectExhaustiveCompletedPartialUnitComposition,
    supportsCompletedPartialUnitComposition,
    type ExhaustiveCompletedPartialUnitCandidate,
    shouldReplaceUnanchoredPartialWithReferencePulse,
    shouldPreferWholeSeriesAlias,
    shouldSuppressSelfWorseningCandidateFalseRing,
    hasDistinctConfirmedSequentialMissingMode,
    supportsConfirmedSequentialMissingPathAdvance,
    supportsConsensusAnchoredSequentialMissingStaircase,
    supportsCumulativeSequentialMissingStaircase,
    supportsMarkerAnchoredSequentialMissingStaircase,
    terminalCumulativeMissingExhaustsUnitWhole,
    supportsSequentialMissingDirectionOverride,
    supportsSequentialMissingReplacementOfPartial,
    pruneWholeSeriesPartialAliases,
    preservesSequentialFalseAsymmetricFrontierWindow,
    pruneUnsupportedFalseRingPathSupplements,
    preserveNewestCandidateUnitCheckpoint,
    retainDisplayedMissingHypothesesDuringSequentialRecovery,
    shouldPreserveCandidateBackedUnitFromRemoteSequentialHead,
    unitEventCompetesWithWholeAtNewerEndpoint,
    unitEventExplainsWholeSeriesCandidate,
    wholeSeriesEventIsLocalUnitAlias,
} from "../eventEnsemble";
import {
    boundedLagPathHasObservedFixedSide,
    type BoundedLagStateEventSet,
} from "../eventPath";
import type { JointCounterfactualOperationScore } from "../jointCounterfactualOperation";
import type { CompletedPartialMissingComposition } from "../discreteMissingStaircaseCompetition";

const falseRingEvent = (
    startYear: number,
    supported: boolean,
): DiagnosisEvent => ({
    id: `false-${startYear}`,
    seriesId: "TEST",
    eventType: "falseRing",
    startYear,
    endYear: startYear + 6,
    confidenceLevel: "medium",
    rankedYears: [],
    alternativeTypes: [],
    evidence: {
        score: 1,
        scoreMargin: 0.1,
        baselineCorrelation: 0.3,
        correctedCorrelation: 0.6,
        correlationGain: 0.3,
        lagBefore: 1,
        lagAfter: 0,
        samplePairs: 30,
        algorithmSources: ["piecewise_lag_path"],
        candidateIds: supported ? [`candidate-${startYear}`] : [],
        notes: supported ? ["counterfactual_candidate_support"] : [],
    },
});

const wholeSeriesEvent = (lag: number): DiagnosisEvent => ({
    ...falseRingEvent(1800, true),
    id: `whole-${lag}`,
    eventType: "wholeSeriesMove",
    startYear: 1800,
    endYear: 2023,
    evidence: {
        ...falseRingEvent(1800, true).evidence,
        lagBefore: lag,
        lagAfter: 0,
    },
});

const terminalWholeSeriesEvent = (lag: number): DiagnosisEvent => {
    const event = wholeSeriesEvent(lag);
    event.evidence.notes = [
        ...event.evidence.notes,
        "whole_baseline_source=cofecha_terminal_lag",
    ];
    return event;
};

const partialMoveEvent = (shiftYears: number, fixedSideLag = 0): DiagnosisEvent => ({
    ...falseRingEvent(1800, true),
    id: `partial-${shiftYears}-${fixedSideLag}`,
    eventType: "partialMove",
    shiftYears,
    shiftSide: "older",
    evidence: {
        ...falseRingEvent(1800, true).evidence,
        lagBefore: shiftYears + fixedSideLag,
        lagAfter: fixedSideLag,
    },
});

const candidatePartial = ({
    shiftYears,
    anchorYear,
    candidateId,
    source,
    observedLag = shiftYears,
    gain = 0.2,
}: {
    shiftYears: number;
    anchorYear: number;
    candidateId: string;
    source: "cofecha_segment_lag" | "segmented_diagnosis";
    observedLag?: number;
    gain?: number;
}): DiagnosisEvent => {
    const event = partialMoveEvent(shiftYears);
    event.startYear = anchorYear - 4;
    event.endYear = anchorYear + 4;
    event.rankedYears = [{
        year: anchorYear,
        rank: 1,
        score: 1,
        evidenceTags: [source],
    }];
    event.evidence.algorithmSources = [source, "candidate_ranking"];
    event.evidence.candidateIds = [candidateId];
    event.evidence.notes = ["candidate_hard_gate_passed"];
    event.evidence.lagBefore = observedLag;
    event.evidence.lagAfter = 0;
    event.evidence.correlationGain = gain;
    return event;
};

const candidateRecoveryDiagnosis = {
    targetTree: "TEST",
    targetRange: { startYear: 1800, endYear: 2020 },
} as SeriesCoreDiagnosis;

describe("calibratedTerminalUnitStaircaseWindowWidth", () => {
    const frontier = (
        eventCount: number,
        concentration: number,
        runnerUpMargin = 2,
    ) => {
        const representative = falseRingEvent(1880, true);
        representative.evidence.notes = [
            `bounded_path_runner_up_margin=${runnerUpMargin}`,
        ];
        representative.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1880,
            endYear: 1888,
            topYear: 1884,
            referenceCount: 20,
            concentration,
            remoteMargin: 1,
            calibrated: false,
        }];
        return {
            representative,
            eventCount,
            aggregateShiftYears: eventCount,
            boundaryYear: 1884,
            transitionYears: Array.from(
                { length: eventCount },
                (_, index) => 1884 - (eventCount - index - 1) * 8,
            ),
            maximumAdjacentTransitionGapYears: 8,
            maximumYearDrift: 2,
            strongerTransitionGain: 20,
            weakerTransitionGain: 18,
            olderContinuationAccepted: false,
        };
    };

    it("uses 13 years only for a diffuse two-step terminal staircase", () => {
        expect(calibratedTerminalUnitStaircaseWindowWidth(frontier(2, 0.69))).toBe(13);
        expect(calibratedTerminalUnitStaircaseWindowWidth(frontier(2, 0.7))).toBe(9);
        expect(calibratedTerminalUnitStaircaseWindowWidth(frontier(3, 0.4))).toBe(9);
        expect(calibratedTerminalUnitStaircaseWindowWidth(frontier(4, 0.96, 1.1))).toBe(13);
        expect(calibratedTerminalUnitStaircaseWindowWidth(frontier(4, 0.94, 1.1))).toBe(9);
        expect(calibratedTerminalUnitStaircaseWindowWidth(frontier(4, 0.96, 1.2))).toBe(9);
    });
});

describe("candidate-depth terminal unit operation priority", () => {
    it("lets a complete newer terminal unit chain preempt an unsupported older partial", () => {
        const terminal = falseRingEvent(1900, false);
        terminal.rankedYears = [{
            year: 1900,
            rank: 1,
            score: 1,
            evidenceTags: [],
        }];
        const partial = partialMoveEvent(-3);
        partial.rankedYears = [{
            year: 1873,
            rank: 1,
            score: 1,
            evidenceTags: [],
        }];

        expect(candidateDepthTerminalUnitPreemptsSeparatedPartial(
            terminal,
            4,
            partial,
            [4],
        )).toBe(true);
        expect(candidateDepthTerminalUnitPreemptsSeparatedPartial(
            terminal,
            4,
            partial,
            [4],
            true,
        )).toBe(false);
        partial.rankedYears[0].year = 1890;
        expect(candidateDepthTerminalUnitPreemptsSeparatedPartial(
            terminal,
            4,
            partial,
            [4],
        )).toBe(false);
    });
});

describe("sequential false-ring frontier window", () => {
    it("allocates exact depth-four uncertainty toward the older side", () => {
        expect(sequentialFalseFrontierWindow(
            1843,
            4,
            4,
            { startYear: 1600, endYear: 2000 },
        )).toEqual({
            startYear: 1833,
            endYear: 1845,
            asymmetric: true,
        });
        expect(sequentialFalseFrontierWindow(
            1843,
            3,
            3,
            { startYear: 1600, endYear: 2000 },
        )).toEqual({
            startYear: 1840,
            endYear: 1846,
            asymmetric: false,
        });

        const event = falseRingEvent(1840, false);
        event.evidence.algorithmSources.push(
            "sequential_false_asymmetric_frontier_window",
        );
        expect(preservesSequentialFalseAsymmetricFrontierWindow(event, false))
            .toBe(true);
        expect(preservesSequentialFalseAsymmetricFrontierWindow(event, true))
            .toBe(false);
    });
});

describe("selectDistantSequentialMissingFrontier", () => {
    const missingStep = (
        year: number,
        lagBefore: number,
        lagAfter: number,
    ): DiagnosisEvent => {
        const event = falseRingEvent(year - 3, true);
        event.id = `missing-${year}-${lagBefore}-${lagAfter}`;
        event.eventType = "missingRing";
        event.startYear = year - 3;
        event.endYear = year + 3;
        event.rankedYears = [{ year, rank: 1, score: 4, evidenceTags: [] }];
        event.evidence.score = 4;
        event.evidence.samplePairs = 40;
        event.evidence.lagBefore = lagBefore;
        event.evidence.lagAfter = lagAfter;
        event.evidence.algorithmSources = [
            "joint_event_counterfactual",
            "piecewise_lag_path",
        ];
        return event;
    };

    it("selects the bark-side unit from a well-separated -2 to zero chain", () => {
        const selected = selectDistantSequentialMissingFrontier([
            missingStep(1902, -2, -1),
            missingStep(1977, -1, 0),
        ], [], [-2], 2002, null);

        expect(selected).toMatchObject({
            eventType: "missingRing",
            startYear: 1974,
            endYear: 1980,
            rankedYears: [{ year: 1977, rank: 1 }],
        });
        expect(selected?.evidence.algorithmSources)
            .toContain("cumulative_sequential_missing_staircase");
    });

    it("allows a globally inconsistent whole alias but preserves a matching whole baseline", () => {
        const events = [
            missingStep(1902, -2, -1),
            missingStep(1977, -1, 0),
        ];
        const alias = wholeSeriesEvent(-1);
        alias.evidence.notes = [
            "path_fixed_side_event_type=partialMove",
            "whole_state_global_lag_matches_shift=false",
        ];
        const whole = wholeSeriesEvent(-2);
        whole.evidence.notes = ["whole_state_global_lag_matches_shift=true"];

        expect(selectDistantSequentialMissingFrontier(
            events,
            [],
            [-2],
            2002,
            alias,
        )?.rankedYears[0]?.year).toBe(1977);
        expect(selectDistantSequentialMissingFrontier(
            events,
            [],
            [-2],
            2002,
            whole,
        )).toBeNull();
    });

    it("allows a deep old-side whole alias when the newer edge returns through -1", () => {
        const events = [
            missingStep(1902, -2, -1),
            missingStep(1977, -1, 0),
        ];
        const cumulativeAlias = wholeSeriesEvent(-5);
        cumulativeAlias.evidence.notes = [
            "whole_state_global_lag_matches_shift=true",
            "whole_state_newer_edge_support_fraction=0.000000",
            "whole_state_newest_lag=-1",
        ];
        const stableWhole = wholeSeriesEvent(-5);
        stableWhole.evidence.notes = [
            "whole_state_global_lag_matches_shift=true",
            "whole_state_newer_edge_support_fraction=1.000000",
            "whole_state_newest_lag=-5",
        ];

        expect(selectDistantSequentialMissingFrontier(
            events,
            [],
            [-5],
            2002,
            cumulativeAlias,
        )?.rankedYears[0]?.year).toBe(1977);
        expect(selectDistantSequentialMissingFrontier(
            events,
            [],
            [-5],
            2002,
            stableWhole,
        )).toBeNull();
    });

    it("uses an independently located zero-return frontier when older steps are unresolved", () => {
        const cumulativeAlias = wholeSeriesEvent(-5);
        cumulativeAlias.evidence.notes = [
            "whole_state_global_lag_matches_shift=true",
            "whole_state_newer_edge_support_fraction=0.000000",
            "whole_state_newest_lag=-1",
        ];

        const selected = selectDistantSequentialMissingFrontier(
            [missingStep(1977, -1, 0)],
            [],
            [-5],
            2002,
            cumulativeAlias,
        );

        expect(selected?.rankedYears[0]?.year).toBe(1977);
        expect(selected?.evidence.notes)
            .toContain("distant_sequential_predecessor_year=unresolved");
        expect(selected?.evidence.notes)
            .toContain("distant_sequential_evidence_source=independent_zero_return_frontier");
    });

    it("does not promote a bark-near or incomplete unit chain", () => {
        const predecessor = missingStep(1902, -2, -1);
        const barkNear = missingStep(1990, -1, 0);
        const distant = missingStep(1977, -1, 0);

        expect(selectDistantSequentialMissingFrontier(
            [predecessor, barkNear],
            [],
            [-2],
            2002,
            null,
        )).toBeNull();
        expect(selectDistantSequentialMissingFrontier(
            [distant],
            [],
            [-2],
            2002,
            null,
        )).toBeNull();
    });

    it("recovers the chain from strong raw path transitions after fusion collapses it", () => {
        const frontier = missingStep(1976, -1, 0);
        const predecessor = missingStep(1902, -2, -1);
        [frontier, predecessor].forEach((event) => {
            event.evidence.algorithmSources = ["piecewise_lag_path"];
            event.evidence.score = 8;
            event.evidence.samplePairs = 74;
        });
        frontier.evidence.notes = [
            "nominal_boundary_year=1977",
            "profile_boundary_year=1977",
        ];
        frontier.rankedYears.push({
            year: 1977,
            rank: 2,
            score: 3.5,
            evidenceTags: ["piecewise_lag_path"],
        });
        const alias = wholeSeriesEvent(-1);
        alias.evidence.notes = [
            "path_fixed_side_event_type=missingRing",
            "whole_state_global_lag_matches_shift=false",
        ];

        const selected = selectDistantSequentialMissingFrontier(
            [alias],
            [frontier, predecessor],
            [-2],
            2002,
            alias,
        );

        expect(selected).toMatchObject({
            eventType: "missingRing",
            startYear: 1973,
            endYear: 1979,
        });
        expect(selected?.rankedYears[0]).toMatchObject({ year: 1977, rank: 1 });
        expect(selected?.evidence.algorithmSources)
            .toContain("raw_piecewise_sequential_missing_chain");
    });

    it("recovers a hard-gated distant candidate only when an older step completes the chain", () => {
        const candidate = missingStep(1977, -1, -1);
        candidate.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
            "propagation_pattern",
            "segmented_diagnosis",
        ];
        candidate.evidence.notes = ["candidate_hard_gate_passed"];
        candidate.evidence.score = 7;
        candidate.evidence.samplePairs = 50;
        candidate.evidence.correctedCorrelation = 0.36;
        const predecessor = missingStep(1786, -2, -1);
        predecessor.evidence.score = 3;
        const whole = wholeSeriesEvent(-1);
        whole.evidence.correctedCorrelation = 0.34;

        const selected = selectCandidateAnchoredDistantMissingFrontier(
            [candidate],
            [predecessor],
            2000,
            whole,
        );

        expect(selected).toMatchObject({
            eventType: "missingRing",
            startYear: 1974,
            endYear: 1980,
            evidence: { lagBefore: -1, lagAfter: 0 },
        });
        expect(selected?.evidence.algorithmSources)
            .toContain("candidate_anchored_distant_missing_frontier");
        expect(selectCandidateAnchoredDistantMissingFrontier(
            [candidate],
            [],
            2000,
            whole,
        )).toBeNull();
        whole.evidence.correctedCorrelation = 0.355;
        expect(selectCandidateAnchoredDistantMissingFrontier(
            [candidate],
            [predecessor],
            2000,
            whole,
        )).toBeNull();
    });
});

describe("selectEndpointAggregatePartialFrontier", () => {
    it("keeps a near-end aggregate partial when the competing whole has no newer-edge support", () => {
        const partial = partialMoveEvent(-4);
        partial.startYear = 1977;
        partial.endYear = 1985;
        partial.rankedYears = [{
            year: 1981,
            rank: 1,
            score: 1,
            evidenceTags: [],
        }];
        partial.evidence.algorithmSources = [
            "full_interval_counterfactual_scan",
            "joint_year_operation_evidence",
            "partial_move_preferred_over_global_lag",
        ];
        const whole = wholeSeriesEvent(-4);
        whole.shiftYears = -4;
        whole.evidence.notes = [
            "whole_state_newer_edge_support_fraction=0.000000",
            "whole_state_older_edge_support_fraction=1.000000",
        ];

        expect(selectEndpointAggregatePartialFrontier(
            [partial],
            whole,
            2000,
        )?.evidence.algorithmSources).toContain("endpoint_aggregate_partial_frontier");
        whole.evidence.notes = [
            "whole_state_newer_edge_support_fraction=1.000000",
            "whole_state_older_edge_support_fraction=1.000000",
        ];
        expect(selectEndpointAggregatePartialFrontier(
            [partial],
            whole,
            2000,
        )).toBeNull();
    });
});

describe("recoverCandidateAnchoredRawPartialFrontier", () => {
    const detached = (): DiagnosisEvent => {
        const event = partialMoveEvent(-2);
        event.startYear = 1556;
        event.endYear = 1564;
        event.rankedYears = [{
            year: 1560,
            rank: 1,
            score: 16,
            evidenceTags: ["full_interval_counterfactual_locator"],
        }];
        event.evidence.algorithmSources = [
            "piecewise_lag_path",
            "full_interval_counterfactual_locator",
        ];
        event.evidence.notes = [
            "partial_gap_raw31_year=1686",
            "counterfactual_coarse_current_candidate_consensus=false",
            "counterfactual_window_concentration=0.45",
            "counterfactual_window_remote_margin=0.025",
        ];
        event.evidence.samplePairs = 80;
        return event;
    };

    it("restores a weak detached -2 locator to the raw profile and candidate region", () => {
        const selected = recoverCandidateAnchoredRawPartialFrontier(
            detached(),
            [candidatePartial({
                shiftYears: -10,
                anchorYear: 1699,
                candidateId: "regional",
                source: "segmented_diagnosis",
            })],
            { startYear: 1440, endYear: 2000 },
        );

        expect(selected).toMatchObject({
            eventType: "partialMove",
            shiftYears: -2,
            startYear: 1680,
            endYear: 1692,
        });
        expect(selected?.rankedYears[0]).toMatchObject({ year: 1686, rank: 1 });
        expect(selected?.evidence.algorithmSources)
            .toContain("candidate_anchored_raw_partial_frontier");
    });

    it("keeps a detached raw profile internal without an independent regional candidate", () => {
        expect(recoverCandidateAnchoredRawPartialFrontier(
            detached(),
            [],
            { startYear: 1440, endYear: 2000 },
        )).toBeNull();
        const strong = detached();
        strong.evidence.notes = strong.evidence.notes.map((note) => (
            note.startsWith("counterfactual_window_concentration=")
                ? "counterfactual_window_concentration=0.8"
                : note
        ));
        expect(recoverCandidateAnchoredRawPartialFrontier(
            strong,
            [candidatePartial({
                shiftYears: -10,
                anchorYear: 1699,
                candidateId: "regional",
                source: "segmented_diagnosis",
            })],
            { startYear: 1440, endYear: 2000 },
        )).toBeNull();
    });
});

describe("selectCandidateBackedCumulativeUnitFrontier", () => {
    const cumulativePartial = (shiftYears: number, year: number): DiagnosisEvent => {
        const event = candidatePartial({
            shiftYears,
            anchorYear: year,
            candidateId: `partial-${shiftYears}-${year}`,
            source: "segmented_diagnosis",
        });
        event.evidence.algorithmSources.push("global_sliding_match", "propagation_pattern");
        return event;
    };
    const unit = (
        eventType: "missingRing" | "falseRing",
        year: number,
        lagBefore: number,
    ): DiagnosisEvent => {
        const event = falseRingEvent(year - 3, true);
        event.eventType = eventType;
        event.rankedYears = [{ year, rank: 1, score: 1, evidenceTags: [] }];
        event.evidence.algorithmSources = [
            "candidate_ranking",
            "cofecha_segment_lag",
            "local_edit_alignment",
            "segmented_diagnosis",
        ];
        event.evidence.candidateIds = [`${eventType}-a`, `${eventType}-b`];
        event.evidence.notes = ["candidate_hard_gate_passed"];
        event.evidence.correlationGain = 0.01;
        event.evidence.scoreMargin = 0.1;
        event.evidence.lagBefore = lagBefore;
        event.evidence.lagAfter = lagBefore + (eventType === "missingRing" ? 1 : -1);
        return event;
    };

    it("selects a newer missing boundary from a cumulative -21 partial state", () => {
        const selected = selectCandidateBackedCumulativeUnitFrontier([
            cumulativePartial(-21, 1839),
            unit("missingRing", 1871, -21),
        ]);

        expect(selected?.eventType).toBe("missingRing");
        expect(selected?.rankedYears[0]?.year).toBe(1871);
        expect(selected?.evidence.algorithmSources)
            .toContain("cumulative_unit_candidate_pair");
    });

    it("selects a newer false boundary from a cumulative -19 partial state", () => {
        const falseBoundary = unit("falseRing", 1834, -19);
        falseBoundary.evidence.scoreMargin = 0.015;
        const selected = selectCandidateBackedCumulativeUnitFrontier([
            cumulativePartial(-19, 1800),
            falseBoundary,
        ]);

        expect(selected?.eventType).toBe("falseRing");
        expect(selected?.rankedYears[0]?.year).toBe(1834);
    });

    it("rejects a nearby, older, or amplitude-inconsistent unit candidate", () => {
        const partial = cumulativePartial(-21, 1839);
        expect(selectCandidateBackedCumulativeUnitFrontier([
            partial,
            unit("missingRing", 1846, -21),
        ])).toBeNull();
        expect(selectCandidateBackedCumulativeUnitFrontier([
            partial,
            unit("missingRing", 1800, -21),
        ])).toBeNull();
        expect(selectCandidateBackedCumulativeUnitFrontier([
            partial,
            unit("missingRing", 1871, -20),
        ])).toBeNull();
    });

    it("uses a completed older partial location when the initial partial peak is inverted", () => {
        const completed = partialMoveEvent(-7);
        completed.startYear = 1804;
        completed.endYear = 1816;
        completed.rankedYears = [{ year: 1808, rank: 1, score: 2, evidenceTags: [] }];
        completed.evidence.algorithmSources = [
            "bounded_complete_lag_path",
            "per_reference_completed_correction",
        ];
        completed.evidence.notes = ["completed_mixed_frontier_type=partialMove"];

        const selected = selectCandidateBackedCumulativeUnitFrontier([
            cumulativePartial(-7, 1846),
            unit("missingRing", 1837, -7),
        ], completed);

        expect(selected?.eventType).toBe("missingRing");
        expect(selected?.rankedYears[0]?.year).toBe(1837);
        expect(selected?.evidence.notes)
            .toContain("cumulative_unit_pair_completed_separation=29");
    });

    it("accepts an exact false step backed by four local channels and ordered source segments", () => {
        const partial = cumulativePartial(-19, 1721);
        partial.evidence.notes.push(
            "candidate_source_segment_start=1651",
            "candidate_source_segment_end=1700",
        );
        const falseBoundary = unit("falseRing", 1709, -19);
        falseBoundary.evidence.algorithmSources = falseBoundary.evidence.algorithmSources
            .filter((source) => source !== "cofecha_segment_lag");
        falseBoundary.evidence.candidateIds = ["a", "b", "c", "d"];
        falseBoundary.evidence.correlationGain = -0.015;
        falseBoundary.evidence.scoreMargin = 0.08;
        falseBoundary.evidence.notes.push(
            "candidate_source_segment_start=1676",
            "candidate_source_segment_end=1725",
        );

        const selected = selectCandidateBackedCumulativeUnitFrontier([
            partial,
            falseBoundary,
        ]);

        expect(selected?.eventType).toBe("falseRing");
        expect(selected?.rankedYears[0]?.year).toBe(1709);
        expect(selected?.evidence.notes)
            .toContain("cumulative_unit_pair_source_segment_separation=25");
        expect(selected?.evidence.notes)
            .toContain("cumulative_unit_pair_independent_false_consensus=true");
    });

    it("rejects a local-only false step without four-channel or source-order support", () => {
        const partial = cumulativePartial(-19, 1721);
        partial.evidence.notes.push(
            "candidate_source_segment_start=1651",
            "candidate_source_segment_end=1700",
        );
        const falseBoundary = unit("falseRing", 1709, -19);
        falseBoundary.evidence.algorithmSources = falseBoundary.evidence.algorithmSources
            .filter((source) => source !== "cofecha_segment_lag");
        falseBoundary.evidence.candidateIds = ["a", "b", "c"];
        falseBoundary.evidence.correlationGain = -0.015;
        falseBoundary.evidence.scoreMargin = 0.08;
        falseBoundary.evidence.notes.push(
            "candidate_source_segment_start=1676",
            "candidate_source_segment_end=1725",
        );
        expect(selectCandidateBackedCumulativeUnitFrontier([
            partial,
            falseBoundary,
        ])).toBeNull();

        falseBoundary.evidence.candidateIds.push("d");
        falseBoundary.evidence.notes = falseBoundary.evidence.notes.filter((note) => (
            !note.startsWith("candidate_source_segment_")
        ));
        expect(selectCandidateBackedCumulativeUnitFrontier([
            partial,
            falseBoundary,
        ])).toBeNull();
    });

    it("uses completed correction for location without changing unit operation", () => {
        const selected = selectCandidateBackedCumulativeUnitFrontier([
            cumulativePartial(-19, 1800),
            unit("falseRing", 1834, -19),
        ]);
        const completed = partialMoveEvent(-19);
        completed.startYear = 1839;
        completed.endYear = 1845;
        completed.rankedYears = [{ year: 1842, rank: 1, score: 2, evidenceTags: [] }];
        completed.evidence.algorithmSources = [
            "bounded_complete_lag_path",
            "per_reference_completed_correction",
        ];
        completed.evidence.notes = [
            "completed_mixed_frontier_type=partialMove",
            "completed_mixed_frontier_is_newest_event",
        ];

        const reconciled = reconcileCumulativeUnitOperationWithCompletedLocation(
            selected,
            completed,
        );

        expect(reconciled?.eventType).toBe("falseRing");
        expect(reconciled?.startYear).toBe(1839);
        expect(reconciled?.endYear).toBe(1845);
        expect(reconciled?.rankedYears[0]?.year).toBe(1842);
        expect(reconciled?.evidence.algorithmSources)
            .toContain("completed_unit_location_reconciliation");
    });

    it("keeps the unit window when completed correction is a remote location mode", () => {
        const selected = selectCandidateBackedCumulativeUnitFrontier([
            cumulativePartial(-21, 1839),
            unit("missingRing", 1871, -21),
        ]);
        const completed = partialMoveEvent(-21);
        completed.startYear = 1885;
        completed.endYear = 1891;
        completed.rankedYears = [{ year: 1888, rank: 1, score: 2, evidenceTags: [] }];
        completed.evidence.algorithmSources = [
            "bounded_complete_lag_path",
            "per_reference_completed_correction",
        ];
        completed.evidence.notes = [
            "completed_mixed_frontier_type=partialMove",
            "completed_mixed_frontier_is_newest_event",
        ];

        const reconciled = reconcileCumulativeUnitOperationWithCompletedLocation(
            selected,
            completed,
        );

        expect(reconciled?.startYear).toBe(1868);
        expect(reconciled?.endYear).toBe(1874);
        expect(reconciled?.rankedYears[0]?.year).toBe(1871);
        expect(reconciled?.evidence.notes)
            .toContain("completed_unit_remote_location_rejected=1888");
    });
});

describe("sequential missing hypothesis retention", () => {
    const lagPathUnit = (lagBefore: number, year: number): DiagnosisEvent => {
        const event = falseRingEvent(year - 3, false);
        event.id = `path-${lagBefore}-${year}`;
        event.eventType = "missingRing";
        event.rankedYears = [{ year, rank: 1, score: 1, evidenceTags: [] }];
        event.evidence.algorithmSources = ["piecewise_lag_path"];
        event.evidence.lagBefore = lagBefore;
        event.evidence.lagAfter = lagBefore + 1;
        event.evidence.correlationGain = 0.2;
        event.evidence.samplePairs = 60;
        event.evidence.notes = [
            "mixed_reference_counterfactual_selected",
            ...(lagBefore === -1 ? ["partial_conditioned_unit_transition"] : []),
        ];
        return event;
    };

    it("keeps a displayed hard-gated missing window beside a later staircase hypothesis", () => {
        const displayed = candidatePartial({
            shiftYears: -1,
            anchorYear: 1902,
            candidateId: "candidate-1902",
            source: "cofecha_segment_lag",
        });
        displayed.eventType = "missingRing";
        displayed.startYear = 1899;
        displayed.endYear = 1905;
        displayed.rankedYears = [{
            year: 1902,
            rank: 1,
            score: 1,
            evidenceTags: [],
        }];
        const recovered = {
            ...displayed,
            id: "sequential-remote",
            startYear: 1920,
            endYear: 1932,
            rankedYears: [{
                year: 1926,
                rank: 1,
                score: 2,
                evidenceTags: [],
            }],
            evidence: {
                ...displayed.evidence,
                algorithmSources: ["sequential_missing_staircase_head"],
                candidateIds: [],
                notes: [],
            },
        };

        expect(retainDisplayedMissingHypothesesDuringSequentialRecovery(
            [displayed],
            recovered,
        ).map((event) => event.id)).toEqual([displayed.id]);
    });

    it("does not retain an unanchored path draft as a competing final hypothesis", () => {
        const unanchored = falseRingEvent(1900, false);
        unanchored.eventType = "missingRing";
        const recovered = {
            ...unanchored,
            id: "sequential",
            evidence: {
                ...unanchored.evidence,
                algorithmSources: ["sequential_missing_staircase_head"],
            },
        };

        expect(retainDisplayedMissingHypothesesDuringSequentialRecovery(
            [unanchored],
            recovered,
        )).toEqual([]);
    });

    it("retains only the head of a coherent partial-conditioned lag path", () => {
        const displayed = [
            lagPathUnit(-1, 1958),
            lagPathUnit(-2, 1931),
            lagPathUnit(-3, 1910),
            lagPathUnit(-4, 1805),
        ];
        const recovered = {
            ...lagPathUnit(-1, 1946),
            id: "sequential-relocation",
            evidence: {
                ...lagPathUnit(-1, 1946).evidence,
                algorithmSources: ["sequential_missing_staircase_head"],
                notes: [],
            },
        };

        expect(retainDisplayedMissingHypothesesDuringSequentialRecovery(
            displayed,
            recovered,
        ).map((event) => event.id)).toEqual([displayed[0].id]);
    });

    it("does not promote an incomplete partial-conditioned lag path", () => {
        const displayed = [
            lagPathUnit(-1, 1958),
            lagPathUnit(-2, 1931),
            lagPathUnit(-3, 1910),
        ];
        const recovered = {
            ...lagPathUnit(-1, 1946),
            id: "sequential-relocation",
            evidence: {
                ...lagPathUnit(-1, 1946).evidence,
                algorithmSources: ["sequential_missing_staircase_head"],
                notes: [],
            },
        };

        expect(retainDisplayedMissingHypothesesDuringSequentialRecovery(
            displayed,
            recovered,
        )).toEqual([]);
    });

});

describe("candidate operation identity checkpoints", () => {
    it("submits a normalized hard-gated false ring beside an unanchored staircase", () => {
        const selected = falseRingEvent(1800, false);
        selected.eventType = "missingRing";
        selected.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        const candidate = falseRingEvent(1870, false);
        candidate.rankedYears = [{
            year: 1873,
            rank: 1,
            score: 2,
            evidenceTags: [],
        }];
        candidate.evidence.algorithmSources = ["candidate_ranking"];
        candidate.evidence.notes = ["candidate_hard_gate_passed"];

        expect(candidateOperationIdentityCheckpoints(
            [selected],
            [candidate],
            { startYear: 1600, endYear: 2000 },
        )).toEqual([
            expect.objectContaining({
                eventType: "falseRing",
                startYear: 1867,
                endYear: 1879,
                evidence: expect.objectContaining({
                    algorithmSources: expect.arrayContaining([
                        "candidate_operation_identity_checkpoint",
                    ]),
                }),
            }),
        ]);
    });

    it("does not submit an opposite candidate without both operation gates", () => {
        const selected = falseRingEvent(1800, false);
        selected.eventType = "missingRing";
        selected.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        const candidate = falseRingEvent(1870, false);
        candidate.evidence.algorithmSources = ["candidate_ranking"];

        expect(candidateOperationIdentityCheckpoints(
            [selected],
            [candidate],
            { startYear: 1600, endYear: 2000 },
        )).toEqual([]);
    });
});

const verifiedPulse = (): DiagnosisEvent[] => ([
    {
        ...falseRingEvent(1900, false),
        id: "pulse-missing",
        eventType: "missingRing",
        evidence: {
            ...falseRingEvent(1900, false).evidence,
            algorithmSources: ["bounded_lag_pulse", "reference_core_pair_voting"],
        },
    },
    {
        ...falseRingEvent(1909, false),
        id: "pulse-false",
        evidence: {
            ...falseRingEvent(1909, false).evidence,
            algorithmSources: ["bounded_lag_pulse", "reference_core_pair_voting"],
        },
    },
]);

describe("shouldReplaceUnanchoredPartialWithReferencePulse", () => {
    it("lets a strictly verified cancelling pulse replace only an unanchored partial -2", () => {
        const unanchored = partialMoveEvent(-2);
        unanchored.evidence.candidateIds = [];
        unanchored.evidence.algorithmSources = ["piecewise_lag_path"];

        expect(shouldReplaceUnanchoredPartialWithReferencePulse(
            [unanchored],
            [],
            verifiedPulse(),
            false,
        )).toBe(true);
    });

    it("preserves candidate-backed, large-gap, unit-competing and whole-competing events", () => {
        const supported = partialMoveEvent(-2);
        const largeGap = partialMoveEvent(-4);
        largeGap.evidence.candidateIds = [];
        largeGap.evidence.algorithmSources = ["piecewise_lag_path"];
        const unanchored = partialMoveEvent(-2);
        unanchored.evidence.candidateIds = [];
        unanchored.evidence.algorithmSources = ["piecewise_lag_path"];

        expect(shouldReplaceUnanchoredPartialWithReferencePulse(
            [supported], [], verifiedPulse(), false,
        )).toBe(false);
        expect(shouldReplaceUnanchoredPartialWithReferencePulse(
            [largeGap], [], verifiedPulse(), false,
        )).toBe(false);
        expect(shouldReplaceUnanchoredPartialWithReferencePulse(
            [unanchored], [falseRingEvent(1909, true)], verifiedPulse(), false,
        )).toBe(false);
        expect(shouldReplaceUnanchoredPartialWithReferencePulse(
            [unanchored], [], verifiedPulse(), true,
        )).toBe(false);
    });
});

describe("recoverCandidateBackedPartialConsensus", () => {
    it("recovers the shared amplitude of independent COFECHA and segmented candidates", () => {
        const recovered = recoverCandidateBackedPartialConsensus([
            candidatePartial({
                shiftYears: -4,
                anchorYear: 1904,
                candidateId: "cofecha-partial",
                source: "cofecha_segment_lag",
            }),
            candidatePartial({
                shiftYears: -4,
                anchorYear: 1902,
                candidateId: "segmented-partial",
                source: "segmented_diagnosis",
            }),
        ], candidateRecoveryDiagnosis, 100);

        expect(recovered?.eventType).toBe("partialMove");
        expect(recovered?.shiftYears).toBe(-4);
        expect(recovered?.evidence.lagBefore).toBe(-4);
        expect(recovered?.evidence.lagAfter).toBe(0);
        expect(recovered?.evidence.algorithmSources)
            .toContain("candidate_backed_partial_consensus");
        expect(recovered?.evidence.notes)
            .toContain("partial_candidate_cofecha_anchors=1904");
    });

    it("uses a coherent COFECHA amplitude over an incoherent large-shift alternative", () => {
        const recovered = recoverCandidateBackedPartialConsensus([
            candidatePartial({
                shiftYears: -4,
                anchorYear: 1875,
                candidateId: "cofecha-partial",
                source: "cofecha_segment_lag",
                observedLag: -4,
            }),
            candidatePartial({
                shiftYears: -56,
                anchorYear: 1892,
                candidateId: "incoherent-partial",
                source: "segmented_diagnosis",
                observedLag: -4,
            }),
        ], candidateRecoveryDiagnosis, 100);

        expect(recovered?.shiftYears).toBe(-4);
        expect(recovered?.evidence.candidateIds).toEqual(["cofecha-partial"]);
        expect(recovered?.evidence.algorithmSources)
            .toContain("cofecha_backed_partial_over_incoherent_alternatives");
    });

    it("leaves -2 candidates to the explicit missing-staircase competition", () => {
        const recovered = recoverCandidateBackedPartialConsensus([
            candidatePartial({
                shiftYears: -2,
                anchorYear: 1904,
                candidateId: "cofecha-partial",
                source: "cofecha_segment_lag",
            }),
            candidatePartial({
                shiftYears: -2,
                anchorYear: 1902,
                candidateId: "segmented-partial",
                source: "segmented_diagnosis",
            }),
        ], candidateRecoveryDiagnosis, 100);

        expect(recovered).toBeNull();
    });
});

describe("supportsCompletedPartialUnitComposition", () => {
    const shortPlateau = () => ({
        unitEventType: "missingRing" as "missingRing" | "falseRing",
        cumulativeShiftYears: -7,
        partialShiftYears: -6,
        orientation: "missingThenPartial" as
            | "missingThenPartial"
            | "falseThenPartial",
        olderBoundaryYear: 1827,
        newerBoundaryYear: 1832,
        frontierEventType: "partialMove" as const,
        frontierYear: 1832,
        separationYears: 5,
        masterMargin: -0.024,
        referenceCount: 28,
        mixedReferenceSupport: 17,
        mixedReferenceSupportRatio: 17 / 28,
        referenceMedianMargin: 0.0026,
        referenceLowerQuartileMargin: -0.0138,
        orientationReferenceCount: 28,
        orientationReferenceSupport: 26,
        orientationReferenceSupportRatio: 26 / 28,
        orientationMedianMargin: 0.0295,
        orientationLowerQuartileMargin: 0.0085,
        masterOrientationMargin: -0.024,
        comparedWithMissingStaircase: false,
        sourceSegmentAnchored: false,
    });

    it("does not split a single partial from orientation evidence alone", () => {
        expect(supportsCompletedPartialUnitComposition(shortPlateau())).toBe(false);
    });

    it("keeps a strong short-plateau family refused when orientation is weak", () => {
        const weak = shortPlateau();
        weak.mixedReferenceSupport = 19;
        weak.mixedReferenceSupportRatio = 19 / 28;
        weak.referenceMedianMargin = 0.072;
        weak.referenceLowerQuartileMargin = -0.008;
        weak.orientationReferenceSupport = 23;
        weak.orientationReferenceSupportRatio = 23 / 28;

        expect(supportsCompletedPartialUnitComposition(weak)).toBe(false);
    });

    it("accepts a short plateau with strong orientation and family medians", () => {
        const supported = shortPlateau();
        supported.mixedReferenceSupport = 19;
        supported.mixedReferenceSupportRatio = 19 / 28;
        supported.referenceMedianMargin = 0.072;
        supported.referenceLowerQuartileMargin = -0.008;
        supported.orientationReferenceSupport = 24;
        supported.orientationReferenceSupportRatio = 24 / 28;
        supported.orientationMedianMargin = 0.056;
        supported.orientationLowerQuartileMargin = 0.025;

        expect(supportsCompletedPartialUnitComposition(supported)).toBe(true);
    });

    it("accepts a source-segment anchored false+partial family", () => {
        const supported = shortPlateau();
        supported.unitEventType = "falseRing";
        supported.orientation = "falseThenPartial";
        supported.mixedReferenceSupport = 19;
        supported.mixedReferenceSupportRatio = 19 / 28;
        supported.referenceMedianMargin = 0.133;
        supported.referenceLowerQuartileMargin = -0.022;
        supported.orientationReferenceSupport = 24;
        supported.orientationReferenceSupportRatio = 24 / 28;
        supported.orientationMedianMargin = 0.07;
        supported.orientationLowerQuartileMargin = 0.012;
        supported.sourceSegmentAnchored = true;

        expect(supportsCompletedPartialUnitComposition(supported)).toBe(true);
    });

    it("accepts a long mixed plateau with strong master and orientation evidence", () => {
        const supported = shortPlateau();
        supported.separationYears = 25;
        supported.masterMargin = 0.93;
        supported.mixedReferenceSupport = 14;
        supported.mixedReferenceSupportRatio = 14 / 27;
        supported.referenceCount = 27;
        supported.referenceMedianMargin = 0.012;
        supported.referenceLowerQuartileMargin = -0.23;
        supported.orientationReferenceSupport = 23;
        supported.orientationReferenceSupportRatio = 23 / 28;
        supported.orientationMedianMargin = 0.21;
        supported.orientationLowerQuartileMargin = 0.059;
        supported.masterOrientationMargin = 0.26;

        expect(supportsCompletedPartialUnitComposition(supported)).toBe(true);
    });
});

describe("hardCandidateMaySeedExhaustiveComposition", () => {
    const aggregate = (lagBefore: number, lagAfter: number): DiagnosisEvent => ({
        ...falseRingEvent(1800, true),
        id: "aggregate",
        eventType: "partialMove",
        shiftYears: lagBefore,
        shiftSide: "older",
        evidence: {
            ...falseRingEvent(1800, true).evidence,
            lagBefore,
            lagAfter,
            algorithmSources: [
                "candidate_ranking",
                "global_sliding_match",
                "propagation_pattern",
                "segmented_diagnosis",
            ],
            notes: ["candidate_hard_gate_passed"],
        },
    });

    it("opens the complete family search for a one-lag residual", () => {
        expect(hardCandidateMaySeedExhaustiveComposition(
            aggregate(-19, -20),
            [],
        )).toBe(true);
    });

    it("keeps a standalone complete partial on the fast path", () => {
        expect(hardCandidateMaySeedExhaustiveComposition(
            aggregate(-20, 0),
            [],
        )).toBe(false);
    });

    it("opens the search when a separated hard unit candidate exists", () => {
        const unit = falseRingEvent(1824, true);
        unit.evidence = {
            ...unit.evidence,
            correlationGain: 0.008,
            candidateIds: ["false-a", "false-b"],
            algorithmSources: [
                "candidate_ranking",
                "cofecha_segment_lag",
                "local_edit_alignment",
            ],
            notes: ["candidate_hard_gate_passed"],
        };
        expect(hardCandidateMaySeedExhaustiveComposition(
            aggregate(-5, 0),
            [unit],
        )).toBe(true);
    });

    it("does not use a unit companion to decompose a deep complete partial", () => {
        const unit = falseRingEvent(1824, true);
        unit.evidence = {
            ...unit.evidence,
            correlationGain: 0.008,
            candidateIds: ["false-a", "false-b"],
            algorithmSources: [
                "candidate_ranking",
                "cofecha_segment_lag",
                "local_edit_alignment",
            ],
            notes: ["candidate_hard_gate_passed"],
        };
        expect(hardCandidateMaySeedExhaustiveComposition(
            aggregate(-20, 0),
            [unit],
        )).toBe(false);
    });
});

describe("selectExhaustiveCompletedPartialUnitComposition", () => {
    const regionalEvidence = (overrides: Record<string, number | null> = {}) => ({
        startYear: 1794,
        endYear: 1818,
        rowCount: 25,
        bestYear: 1806,
        bestRawGain: 0.01,
        bestDifferenceGain: 0.01,
        topThreeDifferenceGain: 0.01,
        meanDifferenceGain: 0.005,
        bestCombinedGain: 0.01,
        topThreeCombinedGain: 0.01,
        bestSideStepYear: 1806,
        bestSideStepScore: 0.01,
        topThreeSideStepScore: 0.01,
        bestSideMinimumAdvantage: 0,
        bestCorrectedSideSupport: 0.1,
        differenceOutsideMargin: 0,
        sideStepOutsideMargin: 0,
        anchorYear: 1806,
        anchorDifferenceGain: 0.01,
        anchorCombinedGain: 0.01,
        anchorSideStepScore: 0.01,
        anchorSideMinimumAdvantage: 0,
        anchorCorrectedSideSupport: 0.1,
        anchorThreeDifferenceGain: 0.01,
        anchorFiveDifferenceGain: 0.01,
        anchorThreeCombinedGain: 0.01,
        anchorFiveCombinedGain: 0.01,
        anchorThreeSideStepScore: 0.01,
        anchorFiveSideStepScore: 0.01,
        ...overrides,
    });
    const mixedCandidate = (
        unitEventType: "missingRing" | "falseRing",
        rawOverrides: Record<string, number | string> = {},
        cofechaOverrides: Record<string, number | string> = {},
        regionalOverrides: Record<string, number | null> = {},
    ): ExhaustiveCompletedPartialUnitCandidate => {
        const orientation = unitEventType === "missingRing"
            ? "partialThenMissing"
            : "partialThenFalse";
        const base = {
            unitEventType,
            cumulativeShiftYears: unitEventType === "missingRing" ? -7 : -5,
            partialShiftYears: -6,
            orientation,
            olderBoundaryYear: 1800,
            newerBoundaryYear: 1806,
            frontierEventType: unitEventType,
            frontierYear: 1806,
            separationYears: 6,
            masterMargin: 0,
            referenceCount: 20,
            mixedReferenceSupport: 14,
            mixedReferenceSupportRatio: 0.7,
            referenceMedianMargin: 0.01,
            referenceLowerQuartileMargin: 0,
            orientationReferenceCount: 20,
            orientationReferenceSupport: 15,
            orientationReferenceSupportRatio: 0.75,
            orientationMedianMargin: 0.03,
            orientationLowerQuartileMargin: 0.005,
            masterOrientationMargin: 0,
            comparedWithMissingStaircase: false,
            sourceSegmentAnchored: false,
        };
        return {
            unitEventType,
            rawCompetition: { ...base, ...rawOverrides },
            cofechaCompetition: { ...base, ...cofechaOverrides },
            regionalEvidence: regionalEvidence(regionalOverrides),
        } as ExhaustiveCompletedPartialUnitCandidate;
    };

    it("uses a dominant completed COFECHA family when the raw view is diffuse", () => {
        const selected = selectExhaustiveCompletedPartialUnitComposition([
            mixedCandidate("missingRing", {}, {
                referenceMedianMargin: 0.055,
                referenceLowerQuartileMargin: 0.02,
                mixedReferenceSupportRatio: 0.8,
                orientationReferenceSupportRatio: 0.85,
                orientationMedianMargin: 0.06,
                orientationLowerQuartileMargin: 0.01,
            }),
            mixedCandidate("falseRing", {}, {
                referenceMedianMargin: 0.02,
            }),
        ], 1800, 1812);

        expect(selected).toMatchObject({
            unitEventType: "missingRing",
            reason: "cofecha_completed_family",
        });
    });

    it("uses sharp regional unit direction only with per-reference mixed support", () => {
        const selected = selectExhaustiveCompletedPartialUnitComposition([
            mixedCandidate("missingRing", {}, {}, {
                bestDifferenceGain: 0.03,
                bestSideStepScore: 0.08,
                bestSideMinimumAdvantage: 0.05,
            }),
            mixedCandidate("falseRing", {
                referenceMedianMargin: 0.02,
                mixedReferenceSupportRatio: 0.7,
                orientationReferenceSupportRatio: 0.75,
                orientationMedianMargin: 0.03,
            }, {}, {
                bestDifferenceGain: 0.07,
                bestSideStepScore: 0.15,
                bestSideMinimumAdvantage: 0.1,
            }),
        ], 1800, 1812);

        expect(selected).toMatchObject({
            unitEventType: "falseRing",
            reason: "regional_unit_direction",
        });
    });

    it("uses a separated regional unit boundary when the newer frontier is partial", () => {
        const selected = selectExhaustiveCompletedPartialUnitComposition([
            mixedCandidate("missingRing", {
                referenceMedianMargin: 0.03,
                mixedReferenceSupportRatio: 0.68,
                orientationReferenceSupportRatio: 0.75,
                orientationMedianMargin: 0.03,
            }, {
                frontierEventType: "partialMove",
                frontierYear: 1807,
                olderBoundaryYear: 1801,
                newerBoundaryYear: 1807,
                separationYears: 6,
            }, {
                bestYear: 1802,
                bestDifferenceGain: 0.06,
                bestSideStepYear: 1801,
                bestSideStepScore: 0.14,
                bestSideMinimumAdvantage: 0.09,
            }),
            mixedCandidate("falseRing", {}, {}, {
                bestDifferenceGain: 0.01,
                bestSideStepScore: 0.03,
            }),
        ], 1800, 1812);

        expect(selected).toMatchObject({
            unitEventType: "missingRing",
            reason: "regional_unit_direction",
            competition: {
                frontierEventType: "partialMove",
                partialShiftYears: -6,
            },
        });
    });

    it("does not split a single partial on a two-year synthetic plateau", () => {
        const selected = selectExhaustiveCompletedPartialUnitComposition([
            mixedCandidate("missingRing", {}, {
                frontierEventType: "partialMove",
                frontierYear: 1807,
                olderBoundaryYear: 1805,
                newerBoundaryYear: 1807,
                separationYears: 2,
                referenceMedianMargin: 0.06,
                referenceLowerQuartileMargin: 0.02,
                mixedReferenceSupportRatio: 0.8,
                orientationReferenceSupportRatio: 0.9,
                orientationMedianMargin: 0.09,
                orientationLowerQuartileMargin: 0.05,
            }),
            mixedCandidate("falseRing"),
        ], 1800, 1812);

        expect(selected).toBeNull();
    });

    it("does not let COFECHA alone split a three-year partial plateau", () => {
        const selected = selectExhaustiveCompletedPartialUnitComposition([
            mixedCandidate("missingRing", {}, {
                frontierEventType: "missingRing",
                frontierYear: 1807,
                olderBoundaryYear: 1804,
                newerBoundaryYear: 1807,
                separationYears: 3,
                referenceMedianMargin: 0.08,
                referenceLowerQuartileMargin: 0.05,
                mixedReferenceSupportRatio: 0.9,
                orientationReferenceSupportRatio: 0.9,
                orientationMedianMargin: 0.1,
                orientationLowerQuartileMargin: 0.05,
            }),
            mixedCandidate("falseRing"),
        ], 1800, 1812);

        expect(selected).toBeNull();
    });

    it("accepts a long separated partial frontier with decisive COFECHA support", () => {
        const selected = selectExhaustiveCompletedPartialUnitComposition([
            mixedCandidate("missingRing", {}, {
                frontierEventType: "partialMove",
                frontierYear: 1831,
                olderBoundaryYear: 1800,
                newerBoundaryYear: 1831,
                separationYears: 31,
                referenceMedianMargin: 0.5,
                referenceLowerQuartileMargin: 0.36,
                mixedReferenceSupportRatio: 1,
                orientationReferenceSupportRatio: 1,
                orientationMedianMargin: 0.22,
                orientationLowerQuartileMargin: 0.15,
            }),
            mixedCandidate("falseRing", {}, {
                frontierEventType: "partialMove",
                frontierYear: 1830,
                olderBoundaryYear: 1800,
                newerBoundaryYear: 1830,
                separationYears: 30,
                referenceMedianMargin: 0.2,
                referenceLowerQuartileMargin: 0,
                mixedReferenceSupportRatio: 0.62,
                orientationReferenceSupportRatio: 0.6,
                orientationMedianMargin: 0.02,
                orientationLowerQuartileMargin: 0,
            }),
        ], 1798, 1806);

        expect(selected).toMatchObject({
            unitEventType: "missingRing",
            reason: "cofecha_completed_family",
            competition: {
                frontierEventType: "partialMove",
                partialShiftYears: -6,
                separationYears: 31,
            },
        });
    });

    it("accepts a long partial frontier when fewer references support a decisive gain", () => {
        const selected = selectExhaustiveCompletedPartialUnitComposition([
            mixedCandidate("missingRing", {}, {
                frontierEventType: "missingRing",
                frontierYear: 1831,
                olderBoundaryYear: 1800,
                newerBoundaryYear: 1831,
                separationYears: 31,
                referenceMedianMargin: 0.138,
                referenceLowerQuartileMargin: 0.072,
                mixedReferenceSupportRatio: 0.84,
                orientationReferenceSupportRatio: 0.62,
                orientationMedianMargin: 0.033,
                orientationLowerQuartileMargin: -0.027,
            }),
            mixedCandidate("falseRing", {}, {
                frontierEventType: "partialMove",
                frontierYear: 1834,
                olderBoundaryYear: 1800,
                newerBoundaryYear: 1834,
                separationYears: 34,
                referenceMedianMargin: 0.357,
                referenceLowerQuartileMargin: 0,
                mixedReferenceSupportRatio: 0.62,
                orientationReferenceSupportRatio: 0.76,
                orientationMedianMargin: 0.151,
                orientationLowerQuartileMargin: 0.0002,
            }),
        ], 1798, 1806);

        expect(selected).toMatchObject({
            unitEventType: "falseRing",
            reason: "cofecha_completed_family",
            competition: {
                frontierEventType: "partialMove",
                partialShiftYears: -6,
                separationYears: 34,
            },
        });
    });

    it("uses a unique raw and COFECHA two-boundary consensus", () => {
        const selected = selectExhaustiveCompletedPartialUnitComposition([
            mixedCandidate("missingRing", {
                orientation: "missingThenPartial",
                frontierEventType: "partialMove",
                olderBoundaryYear: 1689,
                newerBoundaryYear: 1709,
                frontierYear: 1709,
                separationYears: 20,
                referenceCount: 24,
                mixedReferenceSupportRatio: 0.54,
                referenceMedianMargin: 0.012,
                referenceLowerQuartileMargin: 0,
                orientationReferenceSupportRatio: 0.64,
                orientationMedianMargin: 0.058,
            }, {
                orientation: "missingThenPartial",
                frontierEventType: "partialMove",
                olderBoundaryYear: 1686,
                newerBoundaryYear: 1715,
                frontierYear: 1715,
                separationYears: 29,
                referenceCount: 16,
                mixedReferenceSupportRatio: 0.94,
                referenceMedianMargin: 0.12,
                referenceLowerQuartileMargin: 0.066,
                orientationReferenceSupportRatio: 1,
                orientationMedianMargin: 0.26,
            }),
            mixedCandidate("falseRing", {
                orientation: "falseThenPartial",
                frontierEventType: "partialMove",
                olderBoundaryYear: 1672,
                newerBoundaryYear: 1676,
                frontierYear: 1676,
                separationYears: 4,
            }, {
                orientation: "falseThenPartial",
                frontierEventType: "partialMove",
                olderBoundaryYear: 1680,
                newerBoundaryYear: 1710,
                frontierYear: 1710,
                separationYears: 30,
                referenceMedianMargin: 0.08,
                referenceLowerQuartileMargin: 0.02,
                mixedReferenceSupportRatio: 0.85,
                orientationReferenceSupportRatio: 0.85,
                orientationMedianMargin: 0.09,
            }),
        ], 1670, 1682);

        expect(selected).toMatchObject({
            unitEventType: "missingRing",
            reason: "cross_view_boundary_consensus",
            competition: {
                frontierEventType: "partialMove",
                partialShiftYears: -6,
                olderBoundaryYear: 1686,
                newerBoundaryYear: 1715,
            },
        });
    });

    it("does not use cross-view consensus when both decompositions are coherent", () => {
        const coherent = (unitEventType: "missingRing" | "falseRing") => (
            mixedCandidate(unitEventType, {
                orientation: unitEventType === "missingRing"
                    ? "missingThenPartial"
                    : "falseThenPartial",
                frontierEventType: "partialMove",
                olderBoundaryYear: 1688,
                newerBoundaryYear: 1708,
                frontierYear: 1708,
                separationYears: 20,
                referenceCount: 20,
                mixedReferenceSupportRatio: 0.7,
                referenceMedianMargin: 0.02,
                referenceLowerQuartileMargin: 0,
                orientationReferenceSupportRatio: 0.75,
                orientationMedianMargin: 0.06,
            }, {
                orientation: unitEventType === "missingRing"
                    ? "missingThenPartial"
                    : "falseThenPartial",
                frontierEventType: "partialMove",
                olderBoundaryYear: 1686,
                newerBoundaryYear: 1712,
                frontierYear: 1712,
                separationYears: 26,
                referenceCount: 20,
                mixedReferenceSupportRatio: 0.9,
                referenceMedianMargin: 0.1,
                referenceLowerQuartileMargin: 0.04,
                orientationReferenceSupportRatio: 0.9,
                orientationMedianMargin: 0.12,
            })
        );

        expect(selectExhaustiveCompletedPartialUnitComposition([
            coherent("missingRing"),
            coherent("falseRing"),
        ], 1670, 1682)).toBeNull();
    });

    it("keeps two weak completed families refused", () => {
        expect(selectExhaustiveCompletedPartialUnitComposition([
            mixedCandidate("missingRing"),
            mixedCandidate("falseRing"),
        ], 1800, 1812)).toBeNull();
    });
});

describe("selectBoundedCompletedPartialUnitSeeds", () => {
    it("joins an exact -6 component to a bounded cumulative -7 transition", () => {
        const cumulative = partialMoveEvent(-7);
        cumulative.evidence.algorithmSources = ["bounded_complete_lag_path"];
        cumulative.evidence.candidateIds = [];
        cumulative.evidence.notes = [];
        const remote = partialMoveEvent(-73);
        remote.evidence.algorithmSources = ["bounded_complete_lag_path"];
        const component = candidatePartial({
            shiftYears: -6,
            anchorYear: 1880,
            candidateId: "partial-minus-six",
            source: "cofecha_segment_lag",
        });

        const seeds = selectBoundedCompletedPartialUnitSeeds(
            [cumulative, remote],
            [component],
        );

        expect(seeds).toHaveLength(1);
        expect(seeds[0].unitEventType).toBe("missingRing");
        expect(seeds[0].event.shiftYears).toBe(-7);
        expect(seeds[0].event.evidence.notes).toContain(
            "bounded_completed_mixed_component_shift=-6",
        );
    });

    it("uses a candidate-backed shifted unit transition as the intermediate state", () => {
        const cumulative = partialMoveEvent(-21);
        cumulative.evidence.algorithmSources = ["bounded_complete_lag_path"];
        cumulative.evidence.candidateIds = [];
        cumulative.evidence.notes = [];
        const missing = falseRingEvent(1877, true);
        missing.eventType = "missingRing";
        missing.rankedYears = [{ year: 1880, rank: 1, score: 1, evidenceTags: [] }];
        missing.evidence.lagBefore = -21;
        missing.evidence.lagAfter = -20;
        missing.evidence.scoreMargin = 0.5;
        missing.evidence.notes = ["candidate_hard_gate_passed"];

        const seeds = selectBoundedCompletedPartialUnitSeeds(
            [cumulative],
            [],
            [missing],
        );

        expect(seeds).toHaveLength(1);
        expect(seeds[0].unitEventType).toBe("missingRing");
        expect(seeds[0].event.evidence.notes).toContain(
            "bounded_completed_mixed_component_shift=-20",
        );
        expect(seeds[0].anchorYears).toContain(1880);
    });

    it("does not decompose a path that still contains a whole-series baseline", () => {
        expect(selectBoundedCompletedPartialUnitSeeds(
            [wholeSeriesEvent(4), partialMoveEvent(-7)],
            [candidatePartial({
                shiftYears: -6,
                anchorYear: 1880,
                candidateId: "partial-minus-six",
                source: "cofecha_segment_lag",
            })],
        )).toEqual([]);
    });
});

describe("decisiveExactPartialRejectsWeakUnitComposition", () => {
    const decisivePartial = (): DiagnosisEvent => {
        const event = partialMoveEvent(-20);
        event.evidence.algorithmSources = [
            "candidate_grid_reference_partial_consensus",
            "per_reference_counterfactual_evidence",
        ];
        event.evidence.notes = [
            "joint_operation_correction=-20",
            "candidate_grid_partial_shift=-20",
            "candidate_grid_partial_family_margin=0.399405",
            "candidate_grid_partial_shift_margin=0.296268",
            "candidate_grid_partial_reference_count=12",
            "candidate_grid_partial_reference_peak_kernel5=0.650806",
        ];
        return event;
    };
    const composition = (
        overrides: Partial<CompletedPartialMissingComposition> = {},
    ): CompletedPartialMissingComposition => ({
        unitEventType: "missingRing",
        cumulativeShiftYears: -20,
        partialShiftYears: -19,
        orientation: "missingThenPartial",
        olderBoundaryYear: 1604,
        newerBoundaryYear: 1616,
        frontierEventType: "partialMove",
        frontierYear: 1616,
        separationYears: 12,
        masterMargin: 0.21,
        referenceCount: 49,
        mixedReferenceSupport: 15,
        mixedReferenceSupportRatio: 15 / 49,
        referenceMedianMargin: -0.018,
        referenceLowerQuartileMargin: -0.052,
        orientationReferenceCount: 49,
        orientationReferenceSupport: 49,
        orientationReferenceSupportRatio: 1,
        orientationMedianMargin: 0.224,
        orientationLowerQuartileMargin: 0.19,
        masterOrientationMargin: 0.064,
        comparedWithMissingStaircase: false,
        sourceSegmentAnchored: false,
        ...overrides,
    });

    it("keeps a decisive exact partial over a weak one-year decomposition", () => {
        expect(decisiveExactPartialRejectsWeakUnitComposition(
            decisivePartial(),
            composition(),
        )).toBe(true);
    });

    it("still allows a mixed event with broad positive per-reference support", () => {
        expect(decisiveExactPartialRejectsWeakUnitComposition(
            decisivePartial(),
            composition({
                mixedReferenceSupport: 39,
                mixedReferenceSupportRatio: 39 / 49,
                referenceMedianMargin: 0.08,
                referenceLowerQuartileMargin: 0.01,
            }),
        )).toBe(false);
    });

    it("keeps a decisive complete path over an unanchored nearby amplitude split", () => {
        const event = partialMoveEvent(-20);
        event.evidence.algorithmSources = ["bounded_complete_lag_path"];
        event.evidence.notes = [
            "bounded_path_complete_hypothesis=true",
            "bounded_path_transition_gain=52.261950",
            "bounded_path_runner_up_margin=2.050237",
        ];

        expect(decisiveExactPartialRejectsWeakUnitComposition(
            event,
            composition({
                mixedReferenceSupport: 13,
                mixedReferenceSupportRatio: 13 / 17,
                referenceCount: 17,
                referenceMedianMargin: 0.069,
                referenceLowerQuartileMargin: 0.014,
                separationYears: 7,
            }),
        )).toBe(true);
    });

    it("does not suppress a completed path whose newest frontier is the unit event", () => {
        const event = partialMoveEvent(-21);
        event.evidence.algorithmSources = ["bounded_complete_lag_path"];
        event.evidence.notes = [
            "bounded_path_complete_hypothesis=true",
            "bounded_path_transition_gain=47.408924",
            "bounded_path_runner_up_margin=6.924264",
        ];

        expect(decisiveExactPartialRejectsWeakUnitComposition(
            event,
            composition({
                cumulativeShiftYears: -21,
                partialShiftYears: -20,
                orientation: "partialThenMissing",
                frontierEventType: "missingRing",
                separationYears: 5,
            }),
        )).toBe(false);
    });
});

describe("selectCompletedPartialMissingSeed", () => {
    it("uses a joint distribution corroborated by one fused COFECHA and segmented candidate", () => {
        const aggregate = partialMoveEvent(-7);
        aggregate.evidence.candidateIds = [];
        aggregate.evidence.notes = [];
        aggregate.evidence.algorithmSources = [
            "decisive_joint_operation_fusion",
            "full_interval_counterfactual_scan",
            "joint_year_operation_evidence",
        ];
        const corroborating = candidatePartial({
            shiftYears: -7,
            anchorYear: 1850,
            candidateId: "fused-operation-family",
            source: "cofecha_segment_lag",
        });
        corroborating.evidence.algorithmSources.push("segmented_diagnosis");

        const seed = selectCompletedPartialMissingSeed([aggregate], [corroborating]);

        expect(seed?.event.shiftYears).toBe(-7);
        expect(seed?.event.id).toBe(aggregate.id);
        expect(seed?.event.evidence.notes).toContain(
            "completed_mixed_seed=joint_distribution_dual_source_candidate",
        );
    });

    it("uses agreeing reference votes instead of a stale -2 path amplitude", () => {
        const stale = partialMoveEvent(-2);
        stale.evidence.candidateIds = [];
        stale.evidence.notes = [
            "partial_reference_vote_year=1917",
            "partial_reference_vote_shift=-7",
            "partial_reference_vote_gain=0.54",
            "partial_exhaustive_vote_year=1915",
            "partial_exhaustive_vote_shift=-7",
            "partial_exhaustive_vote_gain=0.71",
        ];
        const seed = selectCompletedPartialMissingSeed([stale], [
            candidatePartial({
                shiftYears: -9,
                anchorYear: 1950,
                candidateId: "hard-operation-family",
                source: "cofecha_segment_lag",
            }),
        ]);

        expect(seed?.event.shiftYears).toBe(-7);
        expect(seed?.event.evidence.lagBefore).toBe(-7);
        expect(seed?.event.evidence.lagAfter).toBe(0);
        expect(seed?.anchorYears).toEqual([1915, 1917]);
        expect(seed?.event.evidence.notes).toContain(
            "completed_mixed_seed=dual_partial_vote",
        );
    });

    it("uses two independent candidate anchors when one operation-consistent vote remains", () => {
        const stale = partialMoveEvent(-2);
        stale.evidence.candidateIds = [];
        stale.evidence.notes = [
            "partial_reference_vote_year=1763",
            "partial_reference_vote_shift=-98",
            "partial_reference_vote_gain=0.015",
            "partial_exhaustive_vote_year=1670",
            "partial_exhaustive_vote_shift=-7",
            "partial_exhaustive_vote_gain=0.10",
        ];
        const seed = selectCompletedPartialMissingSeed([stale], [
            candidatePartial({
                shiftYears: -7,
                anchorYear: 1675,
                candidateId: "cofecha-partial",
                source: "cofecha_segment_lag",
            }),
            candidatePartial({
                shiftYears: -7,
                anchorYear: 1644,
                candidateId: "segmented-partial",
                source: "segmented_diagnosis",
            }),
        ]);

        expect(seed?.event.shiftYears).toBe(-7);
        expect(seed?.event.rankedYears[0]?.year).toBe(1675);
        expect(seed?.anchorYears).toEqual([1644, 1670, 1675]);
        expect(seed?.event.evidence.notes).toContain(
            "completed_mixed_seed=candidate_consensus",
        );
    });

    it("recognizes cumulative and one-year-residual candidate amplitudes", () => {
        const stale = partialMoveEvent(-4);
        stale.evidence.candidateIds = [];
        stale.evidence.notes = [];
        const cumulative = candidatePartial({
            shiftYears: -7,
            anchorYear: 1791,
            candidateId: "cumulative-partial",
            source: "segmented_diagnosis",
        });
        cumulative.evidence.algorithmSources.push("global_sliding_match");
        const residual = candidatePartial({
            shiftYears: -6,
            anchorYear: 1825,
            candidateId: "residual-partial",
            source: "cofecha_segment_lag",
            observedLag: -7,
        });
        residual.evidence.lagAfter = -1;

        const seed = selectCompletedPartialMissingSeed(
            [stale],
            [residual, cumulative],
        );

        expect(seed?.event.shiftYears).toBe(-7);
        expect(seed?.anchorYears).toEqual([1791]);
        expect(seed?.event.evidence.notes).toContain(
            "completed_mixed_seed=unit_residual_pair",
        );
    });

    it("accepts one hard candidate backed by a strong nearby exhaustive vote", () => {
        const stale = partialMoveEvent(-2);
        stale.evidence.candidateIds = [];
        stale.evidence.notes = [
            "partial_exhaustive_vote_year=1780",
            "partial_exhaustive_vote_shift=-21",
            "partial_exhaustive_vote_gain=0.36",
        ];
        const seed = selectCompletedPartialMissingSeed([stale], [
            candidatePartial({
                shiftYears: -21,
                anchorYear: 1774,
                candidateId: "large-cumulative-partial",
                source: "segmented_diagnosis",
            }),
        ]);

        expect(seed?.event.shiftYears).toBe(-21);
        expect(seed?.anchorYears).toEqual([1774, 1780]);
        expect(seed?.event.evidence.notes).toContain(
            "completed_mixed_seed=single_vote_candidate",
        );
    });

    it("does not create a mixed seed without any hard-gated executable candidate", () => {
        const stale = partialMoveEvent(-2);
        stale.evidence.candidateIds = [];
        stale.evidence.notes = [
            "partial_reference_vote_year=1917",
            "partial_reference_vote_shift=-7",
            "partial_reference_vote_gain=0.54",
            "partial_exhaustive_vote_year=1915",
            "partial_exhaustive_vote_shift=-7",
            "partial_exhaustive_vote_gain=0.71",
        ];

        expect(selectCompletedPartialMissingSeed([stale], [])).toBeNull();
    });
});

describe("selectCompletedPartialFalseSeed", () => {
    it("recovers a source-segment partial hidden by a remote weak false mode", () => {
        const remoteFalse = falseRingEvent(1676, false);
        remoteFalse.evidence.algorithmSources = ["decisive_joint_operation_fusion"];
        remoteFalse.evidence.candidateIds = [];
        remoteFalse.evidence.scoreMargin = 0.01;
        remoteFalse.evidence.notes = ["joint_operation_selector_probability=0.56"];
        const cumulative = candidatePartial({
            shiftYears: -5,
            anchorYear: 1850,
            candidateId: "cofecha-cumulative",
            source: "cofecha_segment_lag",
        });
        cumulative.evidence.notes.push(
            "candidate_source_segment_start=1800",
            "candidate_source_segment_end=1849",
        );

        const seed = selectCompletedPartialFalseSeed([remoteFalse], [cumulative]);

        expect(seed?.event.id).toBe(cumulative.id);
        expect(seed?.event.shiftYears).toBe(-5);
        expect(seed?.anchorYears[0]).toBe(1800);
        expect(seed?.anchorYears[(seed?.anchorYears.length ?? 0) - 1]).toBe(1850);
        expect(seed?.event.evidence.notes).toContain(
            "completed_mixed_seed=source_segment_partial_over_remote_false",
        );
    });

    it("joins a full-interval cumulative result to a same-amplitude hard candidate", () => {
        const displayed = partialMoveEvent(-19);
        displayed.evidence.candidateIds = [];
        displayed.evidence.notes = [];
        displayed.evidence.algorithmSources = [
            "decisive_joint_operation_fusion",
            "full_interval_counterfactual_locator",
        ];
        const seed = selectCompletedPartialFalseSeed([displayed], [
            candidatePartial({
                shiftYears: -19,
                anchorYear: 1783,
                candidateId: "cumulative-partial",
                source: "segmented_diagnosis",
            }),
        ]);

        expect(seed?.event.shiftYears).toBe(-19);
        expect(seed?.event.evidence.candidateIds).toEqual(["cumulative-partial"]);
        expect(seed?.anchorYears).toEqual([1783]);
        expect(seed?.event.evidence.notes).toContain(
            "completed_mixed_seed=displayed_candidate_amplitude_consensus",
        );
    });

    it("rejects an amplitude mismatch or an unanchored displayed partial", () => {
        const displayed = partialMoveEvent(-19);
        displayed.evidence.candidateIds = [];
        displayed.evidence.notes = [];
        displayed.evidence.algorithmSources = [
            "decisive_joint_operation_fusion",
            "full_interval_counterfactual_locator",
        ];
        const wrongAmplitude = candidatePartial({
            shiftYears: -20,
            anchorYear: 1783,
            candidateId: "wrong-amplitude",
            source: "segmented_diagnosis",
        });

        expect(selectCompletedPartialFalseSeed([displayed], [wrongAmplitude]))
            .toBeNull();
        displayed.evidence.algorithmSources = ["joint_year_operation_evidence"];
        expect(selectCompletedPartialFalseSeed([displayed], [
            candidatePartial({
                shiftYears: -19,
                anchorYear: 1783,
                candidateId: "right-amplitude",
                source: "segmented_diagnosis",
            }),
        ])).toBeNull();
    });

    it("accepts an explicit hard false-ring frontier beside the cumulative result", () => {
        const displayed = partialMoveEvent(-19);
        displayed.evidence.candidateIds = [];
        displayed.evidence.notes = [];
        displayed.evidence.algorithmSources = [
            "decisive_joint_operation_fusion",
            "full_interval_counterfactual_locator",
        ];
        const explicitFalse = falseRingEvent(1904, true);
        explicitFalse.rankedYears = [{
            year: 1907,
            rank: 1,
            score: 1,
            evidenceTags: ["cofecha_segment_lag"],
        }];
        explicitFalse.evidence.lagBefore = 1;
        explicitFalse.evidence.lagAfter = 0;
        explicitFalse.evidence.notes = ["candidate_hard_gate_passed"];

        const seed = selectCompletedPartialFalseSeed([displayed], [explicitFalse]);

        expect(seed?.anchorYears).toEqual([1907]);
        expect(seed?.event.evidence.notes).toContain(
            "completed_mixed_seed=explicit_false_frontier_candidate",
        );
    });
});

describe("pruneWholeSeriesPartialAliases", () => {
    it("removes a global-lag alias when a local partial move returns to zero", () => {
        const whole = wholeSeriesEvent(-9);
        const partial = partialMoveEvent(-9);

        expect(partialMoveExplainsWholeSeriesCandidate(whole, partial)).toBe(true);
        const result = pruneWholeSeriesPartialAliases([whole, partial]);
        expect(result).toHaveLength(1);
        expect(result[0].eventType).toBe("partialMove");
        expect(result[0].evidence.algorithmSources)
            .toContain("partial_move_preferred_over_global_lag");
    });

    it("keeps a terminal whole baseline ahead of an unanchored joint-grid partial", () => {
        const whole = terminalWholeSeriesEvent(-4);
        const partial = partialMoveEvent(-4);
        partial.evidence.candidateIds = [];
        partial.evidence.algorithmSources = [
            "decisive_joint_operation_fusion",
            "joint_year_operation_evidence",
        ];

        expect(hasIndependentPartialBoundaryAnchor(partial)).toBe(false);
        expect(shouldPreferWholeSeriesAlias(whole, partial, 0.2)).toBe(true);
        expect(partialMoveExplainsWholeSeriesCandidate(whole, partial)).toBe(false);
        expect(pruneWholeSeriesPartialAliases([whole, partial]))
            .toMatchObject([{
                eventType: "wholeSeriesMove",
                evidence: {
                    algorithmSources: expect.arrayContaining([
                        "whole_series_preferred_over_partial_alias",
                    ]),
                    notes: expect.arrayContaining([
                        "partial_aliases_removed=1",
                    ]),
                },
            }]);
    });

    it("uses newer fixed-side evidence to arbitrate a non-terminal alias", () => {
        const whole = wholeSeriesEvent(-4);
        const partial = partialMoveEvent(-4);
        partial.evidence.candidateIds = [];
        partial.evidence.algorithmSources = ["joint_year_operation_evidence"];

        expect(shouldPreferWholeSeriesAlias(whole, partial, -0.2)).toBe(true);
        expect(shouldPreferWholeSeriesAlias(whole, partial, -0.02)).toBe(false);
        expect(partialMoveExplainsWholeSeriesCandidate(whole, partial, -0.02))
            .toBe(true);

        partial.evidence.candidateIds = ["verified-partial"];
        expect(shouldPreferWholeSeriesAlias(whole, partial, -0.2)).toBe(false);
    });

    it("arbitrates whole- and partial-preferred aliases in the same pass", () => {
        const terminalWhole = terminalWholeSeriesEvent(-4);
        const rejectedPartial = partialMoveEvent(-4);
        rejectedPartial.evidence.candidateIds = [];
        rejectedPartial.evidence.algorithmSources = ["joint_year_operation_evidence"];
        const localWholeAlias = wholeSeriesEvent(-3);
        const retainedPartial = partialMoveEvent(-3);

        expect(pruneWholeSeriesPartialAliases([
            terminalWhole,
            rejectedPartial,
            localWholeAlias,
            retainedPartial,
        ])).toMatchObject([
            { id: terminalWhole.id, eventType: "wholeSeriesMove" },
            { id: retainedPartial.id, eventType: "partialMove" },
        ]);
    });

    it("keeps a real whole-series baseline under a local partial move", () => {
        const whole = wholeSeriesEvent(2);
        const partial = partialMoveEvent(-4, 2);

        expect(partialMoveExplainsWholeSeriesCandidate(whole, partial)).toBe(false);
        expect(pruneWholeSeriesPartialAliases([whole, partial]))
            .toEqual([whole, partial]);
    });
});

describe("supportsSequentialMissingReplacementOfPartial", () => {
    it("rejects a short overfit staircase that barely beats one direct breakpoint", () => {
        expect(supportsSequentialMissingReplacementOfPartial({
            gainOverDirect: 7.9,
            transitionCount: 11,
            headRunYears: 29,
        })).toBe(false);
    });

    it("accepts either complexity-adjusted gain or a durable unit-lag run", () => {
        expect(supportsSequentialMissingReplacementOfPartial({
            gainOverDirect: 8,
            transitionCount: 11,
            headRunYears: 4,
        })).toBe(true);
        expect(supportsSequentialMissingReplacementOfPartial({
            gainOverDirect: 0.1,
            transitionCount: 11,
            headRunYears: 30,
        })).toBe(true);
    });
});

describe("supportsCumulativeSequentialMissingStaircase", () => {
    it("accepts a deep, clearly better sequence of one-year lag states", () => {
        expect(supportsCumulativeSequentialMissingStaircase({
            pathStartLag: -8,
            transitionCount: 8,
            gainOverDirect: 11.4,
            headMeanAdvantage: 0.021,
        })).toBe(true);
    });

    it("does not reinterpret shallow or weak physical gaps as missing-ring staircases", () => {
        expect(supportsCumulativeSequentialMissingStaircase({
            pathStartLag: -2,
            transitionCount: 2,
            gainOverDirect: 20,
            headMeanAdvantage: 0.2,
        })).toBe(false);
        expect(supportsCumulativeSequentialMissingStaircase({
            pathStartLag: -12,
            transitionCount: 12,
            gainOverDirect: 2,
            headMeanAdvantage: 0.2,
        })).toBe(false);
    });
});

describe("terminalCumulativeMissingExhaustsUnitWhole", () => {
    const head = {
        pathStartLag: -18,
        transitionCount: 18,
        gainOverDirect: 63,
        headMeanAdvantage: 0.21,
        year: 2001,
    };

    it("resolves the terminal -1 alias of a deep exact cumulative staircase", () => {
        expect(terminalCumulativeMissingExhaustsUnitWhole(head, -1, 2002)).toBe(true);
    });

    it("does not use endpoint proximity to rewrite a real whole-series baseline", () => {
        expect(terminalCumulativeMissingExhaustsUnitWhole({
            ...head,
            pathStartLag: -2,
            transitionCount: 2,
        }, -1, 2002)).toBe(false);
        expect(terminalCumulativeMissingExhaustsUnitWhole(head, -5, 2002)).toBe(false);
        expect(terminalCumulativeMissingExhaustsUnitWhole({
            ...head,
            year: 1980,
        }, -1, 2002)).toBe(false);
    });
});

describe("supportsMarkerAnchoredSequentialMissingStaircase", () => {
    it("accepts a slightly weaker deep staircase when another core anchors the year", () => {
        expect(supportsMarkerAnchoredSequentialMissingStaircase({
            pathStartLag: -12,
            transitionCount: 12,
            gainOverDirect: 7,
            headMeanAdvantage: 0.14,
            fixedTailMeanAdvantage: 0.1,
        }, 1)).toBe(true);
    });

    it("accepts a durable exact staircase at late serial-recovery frontiers", () => {
        expect(supportsMarkerAnchoredSequentialMissingStaircase({
            pathStartLag: -5,
            transitionCount: 5,
            gainOverDirect: 1.44,
            headMeanAdvantage: 0.055,
            fixedTailMeanAdvantage: 0.427,
        }, 6)).toBe(true);
        expect(supportsMarkerAnchoredSequentialMissingStaircase({
            pathStartLag: -11,
            transitionCount: 11,
            gainOverDirect: 7.91,
            headMeanAdvantage: -0.016,
            fixedTailMeanAdvantage: 0.398,
        }, 5)).toBe(true);
        expect(supportsMarkerAnchoredSequentialMissingStaircase({
            pathStartLag: -3,
            transitionCount: 3,
            gainOverDirect: 0.64,
            headMeanAdvantage: 0.015,
            fixedTailMeanAdvantage: 0.349,
        }, 30)).toBe(true);
        expect(supportsMarkerAnchoredSequentialMissingStaircase({
            pathStartLag: -4,
            transitionCount: 4,
            gainOverDirect: 1.32,
            headMeanAdvantage: 0.052,
            fixedTailMeanAdvantage: 0.421,
        }, 4)).toBe(true);
    });

    it("still rejects an unanchored or shallow gap", () => {
        const weak = {
            pathStartLag: -12,
            transitionCount: 12,
            gainOverDirect: 7,
            headMeanAdvantage: 0.14,
            fixedTailMeanAdvantage: 0.4,
        };
        expect(supportsMarkerAnchoredSequentialMissingStaircase(weak, 0)).toBe(false);
        expect(supportsMarkerAnchoredSequentialMissingStaircase({
            ...weak,
            pathStartLag: -2,
            transitionCount: 2,
        }, 20)).toBe(false);
    });

    it("requires an exact unit depth and stable fixed tail for a weak marker-backed path", () => {
        const weak = {
            pathStartLag: -5,
            transitionCount: 4,
            gainOverDirect: 1.5,
            headMeanAdvantage: 0.02,
            fixedTailMeanAdvantage: 0.4,
        };
        expect(supportsMarkerAnchoredSequentialMissingStaircase(weak, 6)).toBe(false);
        expect(supportsMarkerAnchoredSequentialMissingStaircase({
            ...weak,
            transitionCount: 5,
            fixedTailMeanAdvantage: 0.32,
        }, 6)).toBe(false);
        expect(supportsMarkerAnchoredSequentialMissingStaircase({
            ...weak,
            transitionCount: 5,
        }, 4)).toBe(false);
        expect(supportsMarkerAnchoredSequentialMissingStaircase({
            ...weak,
            transitionCount: 5,
            headMeanAdvantage: 0.049,
        }, 4)).toBe(false);
    });
});

describe("supportsConsensusAnchoredSequentialMissingStaircase", () => {
    const head = {
        year: 1778,
        pathStartLag: -3,
        transitionCount: 3,
        unitEventYears: [1776, 1777, 1778],
        headMeanAdvantage: 0.046,
        fixedTailMeanAdvantage: 0.299,
    };

    it("accepts one compact exact path at an overwhelming shared marker", () => {
        expect(supportsConsensusAnchoredSequentialMissingStaircase(
            head,
            34,
        )).toBe(true);
    });

    it("rejects weak markers, shallow paths and remote unit modes", () => {
        expect(supportsConsensusAnchoredSequentialMissingStaircase(head, 9)).toBe(false);
        expect(supportsConsensusAnchoredSequentialMissingStaircase({
            ...head,
            pathStartLag: -2,
            transitionCount: 2,
            unitEventYears: [1777, 1778],
        }, 34)).toBe(false);
        expect(supportsConsensusAnchoredSequentialMissingStaircase({
            ...head,
            unitEventYears: [1565, 1777, 1778],
        }, 34)).toBe(false);
    });
});

describe("supportsConfirmedSequentialMissingPathAdvance", () => {
    const head = {
        year: 1778,
        pathStartLag: -2,
        transitionCount: 2,
        unitEventYears: [1777, 1778],
        headRunYears: 1,
        gainOverDirect: -0.5,
        fixedTailMeanAdvantage: 0.3,
    };

    it("advances one exact local step after the anchored head was confirmed", () => {
        expect(supportsConfirmedSequentialMissingPathAdvance(
            head,
            [1778, 1845],
            34,
        )).toBe(true);
    });

    it("rejects untouched, weakly anchored or unstable paths", () => {
        expect(supportsConfirmedSequentialMissingPathAdvance(head, [], 34)).toBe(false);
        expect(supportsConfirmedSequentialMissingPathAdvance(head, [1778], 9)).toBe(false);
        expect(supportsConfirmedSequentialMissingPathAdvance({
            ...head,
            fixedTailMeanAdvantage: 0.27,
        }, [1778], 34)).toBe(false);
        expect(supportsConfirmedSequentialMissingPathAdvance({
            ...head,
            unitEventYears: [1750, 1778],
        }, [1778], 34)).toBe(false);
    });
});

describe("selectResidualSequentialMissingPathYear", () => {
    const head = {
        year: 1974,
        pathStartLag: -5,
        transitionCount: 5,
        unitEventYears: [1700, 1800, 1900, 1903, 1974],
        gainOverDirect: 12,
        fixedTailMeanAdvantage: 0.4,
    };

    it("skips a confirmed frontier footprint and centers the next path mode", () => {
        expect(selectResidualSequentialMissingPathYear(head, [1977])).toBe(1902);
    });

    it("rejects an unconfirmed, weak or unclustered residual path", () => {
        expect(selectResidualSequentialMissingPathYear(head, [])).toBeNull();
        expect(selectResidualSequentialMissingPathYear({
            ...head,
            gainOverDirect: 7.99,
        }, [1977])).toBeNull();
        expect(selectResidualSequentialMissingPathYear({
            ...head,
            unitEventYears: [1700, 1800, 1850, 1903, 1974],
        }, [1977])).toBeNull();
    });
});

describe("supportsSequentialMissingDirectionOverride", () => {
    it("does not reverse explicit false-ring evidence from shared reference zeros alone", () => {
        expect(supportsSequentialMissingDirectionOverride({
            hasOppositeUnitOnly: true,
            hasDetectedMissing: false,
            hasMissingCandidate: false,
            hasConfirmedTargetStaircase: false,
            sharedZeroSupport: 35,
        })).toBe(false);
    });

    it("still accepts target-specific missing evidence against the opposite unit direction", () => {
        expect(supportsSequentialMissingDirectionOverride({
            hasOppositeUnitOnly: true,
            hasDetectedMissing: false,
            hasMissingCandidate: true,
            hasConfirmedTargetStaircase: false,
            sharedZeroSupport: 0,
        })).toBe(true);
        expect(supportsSequentialMissingDirectionOverride({
            hasOppositeUnitOnly: true,
            hasDetectedMissing: false,
            hasMissingCandidate: false,
            hasConfirmedTargetStaircase: true,
            sharedZeroSupport: 0,
        })).toBe(true);
    });

    it("retains shared-zero localization when no opposite unit event exists", () => {
        expect(supportsSequentialMissingDirectionOverride({
            hasOppositeUnitOnly: false,
            hasDetectedMissing: false,
            hasMissingCandidate: false,
            hasConfirmedTargetStaircase: false,
            sharedZeroSupport: 10,
        })).toBe(true);
    });

    it("does not let an aggregate staircase reverse explicit false-ring steps", () => {
        expect(supportsSequentialMissingDirectionOverride({
            hasOppositeUnitOnly: true,
            hasDetectedMissing: false,
            hasMissingCandidate: false,
            hasConfirmedTargetStaircase: false,
            sharedZeroSupport: 12,
            hasCumulativeStaircase: true,
            hasMarkerAnchoredStaircase: true,
        })).toBe(false);
    });

    it("requires a current missing candidate to reverse an authoritative false ring", () => {
        expect(supportsSequentialMissingDirectionOverride({
            hasOppositeUnitOnly: true,
            hasAuthoritativeOppositeUnit: true,
            hasDetectedMissing: true,
            hasMissingCandidate: false,
            hasConfirmedTargetStaircase: true,
            sharedZeroSupport: 23,
            hasCumulativeStaircase: true,
            hasMarkerAnchoredStaircase: true,
        })).toBe(false);
        expect(supportsSequentialMissingDirectionOverride({
            hasOppositeUnitOnly: true,
            hasAuthoritativeOppositeUnit: true,
            hasDetectedMissing: false,
            hasMissingCandidate: true,
            hasConfirmedTargetStaircase: true,
            sharedZeroSupport: 23,
        })).toBe(true);
    });

    it("allows aggregate staircase evidence when no opposite unit step exists", () => {
        expect(supportsSequentialMissingDirectionOverride({
            hasOppositeUnitOnly: false,
            hasDetectedMissing: false,
            hasMissingCandidate: false,
            hasConfirmedTargetStaircase: false,
            sharedZeroSupport: 0,
            hasCumulativeStaircase: true,
        })).toBe(true);
    });
});

describe("hasCoherentSequentialFalseStaircase", () => {
    it("requires two adjacent positive false-ring states", () => {
        const newest = falseRingEvent(1900, true);
        const older = falseRingEvent(1870, true);
        older.evidence.lagBefore = 2;
        older.evidence.lagAfter = 1;

        expect(hasCoherentSequentialFalseStaircase([newest, older])).toBe(true);
    });

    it("rejects isolated and non-positive false-ring drafts", () => {
        const isolated = falseRingEvent(1900, true);
        const negative = falseRingEvent(1870, true);
        negative.evidence.lagBefore = -3;
        negative.evidence.lagAfter = -4;

        expect(hasCoherentSequentialFalseStaircase([isolated])).toBe(false);
        expect(hasCoherentSequentialFalseStaircase([isolated, negative])).toBe(false);
    });
});

describe("hasCandidateBackedSequentialFalseDirection", () => {
    it("accepts a direct unit path with independent candidate support", () => {
        const candidateBacked = falseRingEvent(1900, true);
        candidateBacked.evidence.algorithmSources.push("joint_event_counterfactual");
        candidateBacked.evidence.notes.push("counterfactual_candidate_support");

        expect(hasCandidateBackedSequentialFalseDirection([candidateBacked]))
            .toBe(true);
    });

    it("accepts a hard-gated candidate even without a piecewise path event", () => {
        const candidateBacked = falseRingEvent(1900, false);
        candidateBacked.evidence.algorithmSources = ["joint_event_counterfactual"];
        candidateBacked.evidence.notes = ["candidate_hard_gate_passed"];

        expect(hasCandidateBackedSequentialFalseDirection([candidateBacked]))
            .toBe(true);
    });

    it("accepts the production hard-gated candidate ranking path", () => {
        const candidateBacked = falseRingEvent(1900, false);
        candidateBacked.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
            "segmented_diagnosis",
        ];
        candidateBacked.evidence.notes = ["candidate_hard_gate_passed"];

        expect(hasCandidateBackedSequentialFalseDirection([candidateBacked]))
            .toBe(true);
    });

    it("interprets a false-ring step relative to a non-zero whole baseline", () => {
        const candidateBacked = falseRingEvent(1900, false);
        candidateBacked.evidence.lagBefore = -4;
        candidateBacked.evidence.lagAfter = -5;
        candidateBacked.evidence.algorithmSources = ["joint_event_counterfactual"];
        candidateBacked.evidence.notes = ["candidate_hard_gate_passed"];

        expect(hasCandidateBackedSequentialFalseDirection([candidateBacked]))
            .toBe(true);
    });

    it("keeps a production counterfactual false ring without a legacy joint source tag", () => {
        const candidateBacked = falseRingEvent(1900, true);
        candidateBacked.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
            "segmented_diagnosis",
            "piecewise_lag_path",
        ];
        candidateBacked.evidence.notes = ["counterfactual_candidate_support"];
        candidateBacked.evidence.scoreMargin = 0.02;

        expect(hasCandidateBackedSequentialFalseDirection([candidateBacked]))
            .toBe(true);
    });

    it("keeps a hard-gated false operation when cumulative history distorts its lag-after state", () => {
        const candidateBacked = falseRingEvent(1900, true);
        candidateBacked.evidence.lagBefore = 1;
        candidateBacked.evidence.lagAfter = -3;
        candidateBacked.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
            "segmented_diagnosis",
        ];
        candidateBacked.evidence.notes = ["candidate_hard_gate_passed"];

        expect(hasCandidateBackedSequentialFalseDirection([candidateBacked]))
            .toBe(true);
    });

    it("rejects a weak production false draft without margin or gain", () => {
        const candidateBacked = falseRingEvent(1900, true);
        candidateBacked.evidence.algorithmSources = [
            "candidate_ranking",
            "local_edit_alignment",
            "segmented_diagnosis",
        ];
        candidateBacked.evidence.notes = ["counterfactual_candidate_support"];
        candidateBacked.evidence.scoreMargin = 0.009;
        candidateBacked.evidence.correlationGain = 0.039;

        expect(hasCandidateBackedSequentialFalseDirection([candidateBacked]))
            .toBe(false);
    });

    it("rejects isolated joint and candidate aliases without cross-channel agreement", () => {
        const jointOnly = falseRingEvent(1900, false);
        jointOnly.evidence.algorithmSources.push("joint_event_counterfactual");
        const candidateOnly = falseRingEvent(1870, true);
        candidateOnly.evidence.notes.push("counterfactual_candidate_support");

        expect(hasCandidateBackedSequentialFalseDirection([jointOnly])).toBe(false);
        expect(hasCandidateBackedSequentialFalseDirection([candidateOnly])).toBe(false);
    });
});

describe("isAuthoritativeWholeSeriesCheckpoint", () => {
    const whole = (): DiagnosisEvent => ({
        ...falseRingEvent(1800, true),
        id: "whole",
        eventType: "wholeSeriesMove",
        startYear: 1600,
        endYear: 2000,
        shiftYears: 4,
        confidenceLevel: "high",
        evidence: {
            ...falseRingEvent(1800, true).evidence,
            score: 19,
            notes: [
                "candidate_hard_gate_passed",
                "cofecha_terminal_segments=2",
                "cofecha_terminal_consistency=1.000000",
                "cofecha_terminal_residual_lag=0",
                "whole_state_support_fraction=0.769231",
                "whole_state_global_lag_matches_shift=true",
            ],
        },
    });

    it("protects a globally consistent whole-series operation", () => {
        expect(isAuthoritativeWholeSeriesCheckpoint(whole())).toBe(true);
    });

    it("uses the fixed newer edge as the whole baseline when one local unit event shifts the global mode", () => {
        const mixed = whole();
        mixed.confidenceLevel = "low";
        mixed.evidence.correlationGain = 0.18;
        mixed.evidence.notes = [
            "candidate_hard_gate_passed",
            "cofecha_terminal_segments=3",
            "cofecha_terminal_consistency=1.000000",
            "cofecha_terminal_residual_lag=-1",
            "whole_state_support_fraction=0.333333",
            "whole_state_newer_edge_support_fraction=1.000000",
            "whole_state_newest_lag=4",
            "whole_state_global_lag_matches_shift=false",
        ];

        expect(isAuthoritativeWholeSeriesCheckpoint(mixed)).toBe(true);
    });

    it("does not protect a weak cumulative-lag alias", () => {
        const alias = whole();
        alias.evidence.score = -24;
        alias.evidence.notes = alias.evidence.notes.map((note) => (
            note === "whole_state_support_fraction=0.769231"
                ? "whole_state_support_fraction=0.055556"
                : note === "whole_state_global_lag_matches_shift=true"
                    ? "whole_state_global_lag_matches_shift=false"
                    : note
        ));
        expect(isAuthoritativeWholeSeriesCheckpoint(alias)).toBe(false);
    });

    it("accepts an exact, well-supported recent-tail whole baseline", () => {
        const recentTail = whole();
        recentTail.shiftYears = -4;
        recentTail.evidence.score = -1.3;
        recentTail.evidence.correlationGain = 0.2;
        recentTail.evidence.notes = [
            "candidate_hard_gate_passed",
            "whole_baseline_source=recent_tail_lag",
            "recent_tail_lag=-4",
            "recent_tail_path_lag=-4",
            "recent_tail_support_count=4",
            "recent_tail_total_count=4",
            "recent_tail_median_r=0.81",
            "recent_tail_path_margin=0.24",
            "whole_state_support_fraction=0.4",
            "whole_state_newer_edge_support_fraction=1",
        ];

        expect(isAuthoritativeWholeSeriesCheckpoint(recentTail)).toBe(true);
    });

    it("protects a unanimous -2 fixed tail when a middle event contaminates long segments", () => {
        const recentTail = whole();
        recentTail.shiftYears = -2;
        recentTail.evidence.score = -19;
        recentTail.evidence.correlationGain = 0.18;
        recentTail.evidence.notes = [
            "candidate_hard_gate_passed",
            "whole_baseline_source=recent_tail_lag",
            "recent_tail_lag=-2",
            "recent_tail_resolution_source=unanimous_recent_tail",
            "recent_tail_support_count=4",
            "recent_tail_total_count=4",
            "recent_tail_competing_support=0",
            "recent_tail_median_r=0.85",
            "recent_tail_path_lag=-2",
            "recent_tail_path_margin=6.49",
            "whole_state_support_fraction=0",
            "whole_state_newer_edge_support_fraction=0",
        ];

        expect(isAuthoritativeWholeSeriesCheckpoint(recentTail)).toBe(true);
    });

    it("rejects a recent-tail whole alias without broader state support", () => {
        const alias = whole();
        alias.shiftYears = -1;
        alias.evidence.score = -25;
        alias.evidence.correlationGain = 0.056;
        alias.evidence.notes = [
            "candidate_hard_gate_passed",
            "whole_baseline_source=recent_tail_lag",
            "recent_tail_lag=-1",
            "recent_tail_path_lag=-1",
            "recent_tail_support_count=4",
            "recent_tail_total_count=4",
            "recent_tail_median_r=0.63",
            "recent_tail_path_margin=8.2",
            "whole_state_support_fraction=0.055556",
            "whole_state_newer_edge_support_fraction=0.5",
        ];

        expect(isAuthoritativeWholeSeriesCheckpoint(alias)).toBe(false);
    });

    it("does not treat a local terminal alias as an independently supported whole baseline", () => {
        const alias = whole();
        alias.evidence.correlationGain = 0.2;
        alias.evidence.notes = [
            "candidate_hard_gate_passed",
            "cofecha_terminal_segments=3",
            "cofecha_terminal_consistency=1.000000",
            "cofecha_terminal_residual_lag=-1",
            "whole_state_support_fraction=0.333333",
            "whole_state_newer_edge_support_fraction=1.000000",
            "whole_state_newest_lag=0",
            "whole_state_global_lag_matches_shift=false",
        ];

        expect(isAuthoritativeWholeSeriesCheckpoint(alias)).toBe(false);
    });
});

describe("pathFixedWholeBaselinePreemptsLocalPath", () => {
    it("lets a validated fixed-side whole baseline establish the coordinate frame", () => {
        const whole = {
            ...wholeSeriesEvent(20),
            shiftYears: 20,
        };
        whole.evidence.notes = [
            ...whole.evidence.notes,
            "candidate_hard_gate_passed",
            "whole_baseline_source=path_fixed_side_lag",
            "path_fixed_side_newer_context_years=146",
        ];

        expect(pathFixedWholeBaselinePreemptsLocalPath(whole, [])).toBe(true);
    });

    it("does not give an ordinary whole candidate authority over local evidence", () => {
        const whole = {
            ...wholeSeriesEvent(20),
            shiftYears: 20,
        };

        expect(pathFixedWholeBaselinePreemptsLocalPath(whole, [])).toBe(false);
    });
});

describe("selectCumulativePartialFrontier", () => {
    it("keeps stable paths evidential during an all-flagged pairwise cold start", () => {
        expect(allowStableBoundedPathFinalAuthority(false)).toBe(true);
        expect(allowStableBoundedPathFinalAuthority(true)).toBe(false);
    });

    it("does not let a sequential missing staircase rewrite an authoritative operation family", () => {
        const missing = falseRingEvent(1900, true);
        missing.eventType = "missingRing";

        expect(maySequentialMissingPreemptStableJointFrontier(missing)).toBe(true);
        expect(maySequentialMissingPreemptStableJointFrontier(
            falseRingEvent(1900, true),
        )).toBe(false);
        expect(maySequentialMissingPreemptStableJointFrontier(
            partialMoveEvent(-6),
        )).toBe(false);
        expect(maySequentialMissingPreemptStableJointFrontier(
            falseRingEvent(1900, true),
            true,
            0,
        )).toBe(true);
        expect(maySequentialMissingPreemptStableJointFrontier(
            partialMoveEvent(-3),
            true,
            -6,
        )).toBe(true);
        expect(maySequentialMissingPreemptStableJointFrontier(
            partialMoveEvent(-6),
            true,
            -7,
        )).toBe(false);
        expect(maySequentialMissingPreemptStableJointFrontier(
            partialMoveEvent(-6),
            false,
        )).toBe(true);
        expect(maySequentialMissingPreemptStableJointFrontier(
            partialMoveEvent(-6),
            true,
            -74,
            true,
        )).toBe(false);
    });

    const candidate = (
        id: string,
        shiftYears: number,
        lagBefore: number,
        lagAfter: number,
        year: number,
    ): DiagnosisEvent => ({
        ...falseRingEvent(year, true),
        id,
        eventType: "partialMove",
        shiftYears,
        shiftSide: "older",
        rankedYears: [{ year, score: 1, rank: 1, evidenceTags: [] }],
        evidence: {
            ...falseRingEvent(year, true).evidence,
            lagBefore,
            lagAfter,
            notes: ["candidate_hard_gate_passed"],
        },
    });
    const operation = (
        shiftYears: number,
        bestYear: number,
    ): JointCounterfactualOperationScore => ({
        eventType: "partialMove",
        shiftYears,
        bestYear,
        bestRawGain: 0.05,
        bestDifferenceGain: 0.06,
        bestCombinedGain: 0.0575,
        topThreeDifferenceGain: 0.05,
        remoteDifferenceMargin: 0.03,
        sideStepBestYear: bestYear,
        bestSideStepScore: 0.1,
        topThreeSideStepScore: 0.09,
        bestSideMinimumAdvantage: 0.05,
        bestCorrectedSideSupport: 0.1,
        sideStepRemoteMargin: 0.03,
        baselineLag: 0,
        rows: [],
    });
    const pathEvent = (
        shiftYears: number,
        lagBefore: number,
        lagAfter: number,
        year: number,
        score = 8,
    ): DiagnosisEvent => {
        const event = candidate(`path-${year}`, shiftYears, lagBefore, lagAfter, year);
        return {
            ...event,
            evidence: {
                ...event.evidence,
                algorithmSources: ["piecewise_lag_path"],
                score,
                notes: [`lag transition ${lagBefore} -> ${lagAfter}`],
            },
        };
    };
    const boundedPath = (
        events: DiagnosisEvent[],
    ): BoundedLagStateEventSet => ({
        path: {
            runs: [],
            score: 20,
            bestConstantScore: 0,
            zeroLagScore: 0,
            transitionGain: 20,
            wholeLagGain: 0,
            runnerUpMargin: 1,
        },
        events,
    });

    it("requires independent operation evidence before a stable partial blocks a staircase", () => {
        const stable = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-20, -26, -6, 1748),
                pathEvent(-6, -6, 0, 1779),
            ]),
            boundedPath([
                pathEvent(-20, -26, -6, 1749),
                pathEvent(-6, -6, 0, 1780),
            ]),
        );
        const localPartial = partialMoveEvent(-6);
        localPartial.startYear = 1774;
        localPartial.endYear = 1782;
        localPartial.rankedYears = [{
            year: 1778,
            rank: 1,
            score: 1,
            evidenceTags: [],
        }];

        expect(hasIndependentStableFrontierOperationSupport(
            stable,
            stable?.event ?? null,
            [localPartial],
            [-26],
        )).toBe(true);
    });

    it("accepts an exact terminal partial from a mixed-direction complete path", () => {
        const missing = pathEvent(-1, -6, -5, 1835);
        missing.eventType = "missingRing";
        missing.shiftYears = undefined;
        missing.shiftSide = undefined;
        const falseRing = pathEvent(1, -5, -6, 1867);
        falseRing.eventType = "falseRing";
        falseRing.shiftYears = undefined;
        falseRing.shiftSide = undefined;
        const events = [
            pathEvent(-21, -27, -6, 1686),
            missing,
            falseRing,
            pathEvent(-6, -6, 0, 1896),
        ];
        const stable = selectStableBoundedLagPathFrontier(
            boundedPath(events),
            boundedPath(events),
        );
        const recovered = stable?.event ?? null;
        if (recovered) {
            recovered.evidence.scoreMargin = 0.5;
            recovered.evidence.correlationGain = 0.5;
            recovered.evidence.locationEvidence = [{
                source: "bounded_complete_lag_path",
                startYear: 1890,
                endYear: 1902,
                topYear: 1896,
                referenceCount: 12,
                concentration: 0.85,
                remoteMargin: 2,
                calibrated: false,
            }];
        }

        expect(hasIndependentStableFrontierOperationSupport(
            stable,
            recovered,
            [],
            [-6],
        )).toBe(true);
    });

    it("does not treat a same-direction compressed path as independent partial evidence", () => {
        const events = [
            pathEvent(-40, -42, -2, 1700),
            pathEvent(-2, -2, 0, 1852),
        ];
        const stable = selectStableBoundedLagPathFrontier(
            boundedPath(events),
            boundedPath(events),
        );
        const recovered = stable?.event ?? null;
        if (recovered) {
            recovered.evidence.scoreMargin = 0.5;
            recovered.evidence.correlationGain = 0.5;
            recovered.evidence.locationEvidence = [{
                source: "bounded_complete_lag_path",
                startYear: 1846,
                endYear: 1858,
                topYear: 1852,
                referenceCount: 12,
                concentration: 0.9,
                remoteMargin: 2,
                calibrated: false,
            }];
        }

        expect(hasIndependentStableFrontierOperationSupport(
            stable,
            recovered,
            [],
            [-2],
        )).toBe(false);
    });

    it("uses three-channel consensus to resolve adjacent partial amplitudes", () => {
        const stronger = boundedPath([pathEvent(-6, -6, 0, 1694)]);
        const regularized = boundedPath([pathEvent(-7, -7, 0, 1680)]);
        regularized.path.runnerUpMargin = 0.05;
        const rankedCandidate = candidate("ranked-partial", -5, -5, 0, 1678);
        rankedCandidate.evidence.algorithmSources = ["candidate_ranking"];

        const selected = selectRegularizedPartialOperationConsensus(
            stronger,
            regularized,
            [rankedCandidate],
        );

        expect(selected).toMatchObject({
            eventType: "partialMove",
            shiftYears: -6,
            evidence: { lagBefore: -6, lagAfter: 0 },
        });
        expect(selected?.rankedYears[0]?.year).toBe(1680);
        expect(selected?.evidence.algorithmSources).toContain(
            "regularized_partial_operation_consensus",
        );
    });

    it("rejects partial amplitude consensus without a nearby ranked candidate", () => {
        const stronger = boundedPath([pathEvent(-6, -6, 0, 1694)]);
        const regularized = boundedPath([pathEvent(-7, -7, 0, 1680)]);
        regularized.path.runnerUpMargin = 0.05;
        const remote = candidate("remote-partial", -5, -5, 0, 1600);
        remote.evidence.algorithmSources = ["candidate_ranking"];

        expect(selectRegularizedPartialOperationConsensus(
            stronger,
            regularized,
            [remote],
        )).toBeNull();
    });

    it("keeps a strongly regularized distant mixed frontier", () => {
        const missing = pathEvent(-1, -7, -6, 1817);
        missing.eventType = "missingRing";
        const partial = pathEvent(-6, -6, 0, 1849);

        const selected = selectConservativeStableBoundedLagPathFrontier(
            boundedPath([missing, partial]),
            boundedPath([missing, partial]),
        );

        expect(selected?.newestEvent.eventType).toBe("partialMove");
        expect(selected?.newestEvent.shiftYears).toBe(-6);
    });

    it("keeps a strongly regularized dense same-direction unit frontier", () => {
        const events = [1788, 1797, 1806, 1815].map((year, index) => {
            const event = pathEvent(1, 4 - index, 3 - index, year);
            event.eventType = "falseRing";
            event.shiftYears = undefined;
            return event;
        });

        const selected = selectConservativeStableBoundedLagPathFrontier(
            boundedPath(events),
            boundedPath(events),
        );

        expect(selected?.newestEvent.eventType).toBe("falseRing");
        expect(selected?.newestEvent.rankedYears[0]?.year).toBe(1815);
    });

    it("does not admit a dense mixed-operation path", () => {
        const missing = pathEvent(-1, 0, 1, 1806);
        missing.eventType = "missingRing";
        const falseRing = pathEvent(1, 1, 0, 1815);
        falseRing.eventType = "falseRing";
        falseRing.shiftYears = undefined;

        expect(selectConservativeStableBoundedLagPathFrontier(
            boundedPath([missing, falseRing]),
            boundedPath([missing, falseRing]),
        )).toBeNull();
    });

    it("rejects a local bounded breakpoint whose fixed side has no reference pairs", () => {
        const local = pathEvent(-50, -50, 0, 2006);
        const unsupported = boundedPath([local]);
        unsupported.path.runs = [
            {
                lag: -50,
                startYear: 1766,
                endYear: 2005,
                startIndex: 0,
                endIndex: 239,
                score: 120,
                samplePairs: 471,
            },
            {
                lag: 0,
                startYear: 2006,
                endYear: 2023,
                startIndex: 240,
                endIndex: 257,
                score: 0,
                samplePairs: 0,
            },
        ];

        expect(boundedLagPathHasObservedFixedSide(unsupported)).toBe(false);
        expect(selectStableBoundedLagPathFrontier(unsupported, unsupported)).toBeNull();

        unsupported.path.runs[1]!.samplePairs = 12;
        expect(boundedLagPathHasObservedFixedSide(unsupported)).toBe(true);
    });

    it("does not require a fixed-side breakpoint for a whole-only bounded frame", () => {
        const whole = wholeSeriesEvent(-50);
        const result = boundedPath([whole]);
        result.path.runs = [{
            lag: -50,
            startYear: 1766,
            endYear: 2023,
            startIndex: 0,
            endIndex: 257,
            score: 120,
            samplePairs: 471,
        }];

        expect(boundedLagPathHasObservedFixedSide(result)).toBe(true);
    });

    it("recovers a stable observed whole lag from an unobserved zero-lag tail", () => {
        const makePath = (boundaryYear: number): BoundedLagStateEventSet => {
            const terminalAlias = pathEvent(-50, -50, 0, boundaryYear);
            terminalAlias.evidence.algorithmSources = ["bounded_complete_lag_path"];
            const result = boundedPath([terminalAlias]);
            result.path.transitionGain = 30;
            result.path.runs = [
                {
                    lag: -50,
                    startYear: 1766,
                    endYear: boundaryYear - 1,
                    startIndex: 0,
                    endIndex: 239,
                    score: 120,
                    samplePairs: 471,
                },
                {
                    lag: 0,
                    startYear: boundaryYear,
                    endYear: 2023,
                    startIndex: 240,
                    endIndex: 257,
                    score: 0,
                    samplePairs: 0,
                },
            ];
            return result;
        };

        expect(selectUnobservedFixedSideWholeLag(
            makePath(2006),
            makePath(2007),
            new Set([-50]),
        )).toBe(-50);
        expect(selectUnobservedFixedSideWholeLag(
            makePath(2006),
            makePath(2007),
            new Set([-57]),
        )).toBeNull();
    });

    it("projects a stable bark-end partial alias into a latent whole frame", () => {
        const makePath = (drift: number): BoundedLagStateEventSet => {
            const endpoint = pathEvent(-50, -50, 0, 2048 + drift);
            endpoint.startYear = 2039 + drift;
            endpoint.endYear = 2051;
            endpoint.evidence.algorithmSources = ["bounded_complete_lag_path"];
            const local = pathEvent(-6, -56, -50, 1840 + drift);
            local.evidence.algorithmSources = ["bounded_complete_lag_path"];
            return boundedPath([endpoint, local]);
        };

        const selected = selectLatentEndpointWholeFrame(
            makePath(0),
            makePath(1),
            { startYear: 1584, endYear: 2051 },
        );

        expect(selected).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: -50,
            startYear: 1584,
            endYear: 2051,
            rankedYears: [],
            evidence: {
                lagBefore: -50,
                lagAfter: -50,
            },
        });
        expect(selected?.evidence.algorithmSources).toContain(
            "latent_whole_fixed_side_frame",
        );
        expect(selected?.evidence.notes).toContain(
            "latent_whole_support_type=partialMove",
        );
        expect(selected?.evidence.notes).toContain(
            "latent_whole_frame_source=endpoint_transition_alias",
        );
    });

    it("removes a bark-end unit alias before accepting an explicit whole state", () => {
        const makePath = (drift: number): BoundedLagStateEventSet => {
            const whole = wholeSeriesEvent(-21);
            whole.shiftYears = -21;
            whole.evidence.lagBefore = -21;
            whole.evidence.lagAfter = -21;
            const endpointFalse = falseRingEvent(2010, false);
            endpointFalse.endYear = 2022;
            endpointFalse.rankedYears = [{
                year: 2019 + drift,
                rank: 1,
                score: 1,
                evidenceTags: [],
            }];
            endpointFalse.evidence.lagBefore = -20;
            endpointFalse.evidence.lagAfter = -21;
            const localMissing = pathEvent(-1, -21, -20, 1839 + drift);
            return boundedPath([whole, endpointFalse, localMissing]);
        };

        expect(selectLatentEndpointWholeFrame(
            makePath(0),
            makePath(1),
            { startYear: 1580, endYear: 2022 },
        )).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: -20,
            evidence: {
                lagBefore: -20,
                lagAfter: -20,
            },
        });
    });

    it("keeps an explicit bounded whole frame ahead of its local transition", () => {
        const makePath = (drift: number): BoundedLagStateEventSet => {
            const whole = wholeSeriesEvent(-4);
            whole.shiftYears = -4;
            whole.evidence.lagBefore = -4;
            whole.evidence.lagAfter = -4;
            whole.evidence.algorithmSources = ["bounded_complete_lag_path"];
            const local = pathEvent(-20, -24, -4, 1730 + drift);
            local.evidence.algorithmSources = ["bounded_complete_lag_path"];
            return boundedPath([whole, local]);
        };

        expect(selectLatentEndpointWholeFrame(
            makePath(0),
            makePath(1),
            { startYear: 1474, endYear: 2004 },
        )).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: -4,
            startYear: 1474,
            endYear: 2004,
        });
    });

    it("does not invent a latent whole frame without a separated return transition", () => {
        const endpoint = pathEvent(-50, -50, 0, 2048);
        endpoint.startYear = 2039;
        endpoint.endYear = 2051;
        endpoint.evidence.algorithmSources = ["bounded_complete_lag_path"];

        expect(selectLatentEndpointWholeFrame(
            boundedPath([endpoint]),
            boundedPath([endpoint]),
            { startYear: 1584, endYear: 2051 },
        )).toBeNull();
    });

    it("does not reinterpret an interior physical partial as a whole frame", () => {
        const endpoint = pathEvent(-50, -50, 0, 1950);
        endpoint.startYear = 1944;
        endpoint.endYear = 1956;
        endpoint.evidence.algorithmSources = ["bounded_complete_lag_path"];
        const local = pathEvent(-6, -56, -50, 1840);

        expect(selectLatentEndpointWholeFrame(
            boundedPath([endpoint, local]),
            boundedPath([endpoint, local]),
            { startYear: 1584, endYear: 2051 },
        )).toBeNull();
    });

    it("selects a distant multiscale path frontier only when both penalties agree", () => {
        const penaltyOne = boundedPath([
            pathEvent(-20, -26, -6, 1750),
            pathEvent(-6, -6, 0, 1780),
        ]);
        const penaltyHalf = boundedPath([
            pathEvent(-20, -26, -6, 1751),
            pathEvent(-6, -6, 0, 1781),
        ]);

        const selected = selectStableBoundedLagPathFrontier(
            penaltyOne,
            penaltyHalf,
        );

        expect(selected).toMatchObject({
            aggregateShiftYears: -26,
            suffixAggregateShiftYears: [-6, -26],
            transitionCount: 2,
            allTransitionsPartial: true,
            baselineLag: 0,
            event: {
                eventType: "partialMove",
                shiftYears: -6,
            },
        });
        expect(selected?.event.rankedYears[0]?.year).toBe(1780);
    });

    it("keeps a strong newest partial ahead of a synthetic missing staircase", () => {
        const olderMissing = pathEvent(-1, -7, -6, 1829);
        olderMissing.eventType = "missingRing";
        olderMissing.shiftYears = undefined;
        const newestPartial = pathEvent(-6, -6, 0, 1859, 185);
        newestPartial.evidence.scoreMargin = 0.2;
        newestPartial.evidence.correlationGain = 0.53;
        newestPartial.evidence.samplePairs = 348;
        newestPartial.evidence.notes.push(
            "bounded_path_location_concentration=0.87",
        );
        const path = selectStableBoundedLagPathFrontier(
            boundedPath([olderMissing, newestPartial]),
            boundedPath([olderMissing, newestPartial]),
        );

        expect(hasStrongMixedPathPartialAuthority(path, path?.event ?? null))
            .toBe(true);

        const weak = path ? {
            ...path.event,
            evidence: {
                ...path.event.evidence,
                correlationGain: 0.1,
            },
        } : null;
        expect(hasStrongMixedPathPartialAuthority(path, weak)).toBe(false);
    });

    it("keeps a candidate-backed terminal unit ahead of its aggregate partial", () => {
        const oldestMissing = pathEvent(-1, -20, -19, 1801);
        oldestMissing.eventType = "missingRing";
        oldestMissing.shiftYears = undefined;
        const middlePartial = pathEvent(-20, -19, 1, 1825);
        const newestFalse = pathEvent(1, 1, 0, 1858, 80);
        newestFalse.eventType = "falseRing";
        newestFalse.shiftYears = undefined;
        newestFalse.evidence.scoreMargin = 2.5;
        newestFalse.evidence.correlationGain = 0.34;
        newestFalse.evidence.samplePairs = 233;
        const path = selectStableBoundedLagPathFrontier(
            boundedPath([oldestMissing, middlePartial, newestFalse]),
            boundedPath([oldestMissing, middlePartial, newestFalse]),
        );
        const aggregate = candidate("aggregate", -20, -20, 0, 1811);
        const falseCandidate = falseRingEvent(1856, true);
        falseCandidate.rankedYears = [{
            year: 1859,
            rank: 1,
            score: 1,
            evidenceTags: [],
        }];
        falseCandidate.evidence.notes.push("candidate_hard_gate_passed");

        expect(selectCandidateBackedStableTerminalUnit(
            path,
            aggregate,
            [falseCandidate],
        )).toMatchObject({
            eventType: "falseRing",
            startYear: 1856,
            endYear: 1862,
        });
    });

    it("admits an extended path when its newest transition has an independent candidate anchor", () => {
        const parsimonious = selectStableBoundedLagPathFrontier(
            boundedPath([
                {
                    ...pathEvent(-1, -6, -5, 1864),
                    eventType: "missingRing",
                    shiftYears: undefined,
                    shiftSide: undefined,
                },
                pathEvent(-5, -5, 0, 1912),
            ]),
            boundedPath([
                {
                    ...pathEvent(-1, -6, -5, 1865),
                    eventType: "missingRing",
                    shiftYears: undefined,
                    shiftSide: undefined,
                },
                pathEvent(-5, -5, 0, 1913),
            ]),
        );
        const extended = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-6, -5, 1, 1897),
                {
                    ...pathEvent(1, 1, 0, 1921),
                    eventType: "falseRing",
                    shiftYears: undefined,
                    shiftSide: undefined,
                },
            ]),
            boundedPath([
                pathEvent(-6, -5, 1, 1898),
                {
                    ...pathEvent(1, 1, 0, 1922),
                    eventType: "falseRing",
                    shiftYears: undefined,
                    shiftSide: undefined,
                },
            ]),
        );
        const falseCandidate = {
            ...falseRingEvent(1919, true),
            endYear: 1925,
        };

        expect(selectCandidateAnchoredStableBoundedLagPathFrontier(
            parsimonious,
            extended,
            [falseCandidate],
        )).toBe(extended);
    });

    it("keeps the parsimonious path when an extra segment has no closer candidate anchor", () => {
        const parsimonious = selectStableBoundedLagPathFrontier(
            boundedPath([
                {
                    ...pathEvent(-1, -6, -5, 1864),
                    eventType: "missingRing",
                    shiftYears: undefined,
                    shiftSide: undefined,
                },
                pathEvent(-5, -5, 0, 1912),
            ]),
            boundedPath([
                {
                    ...pathEvent(-1, -6, -5, 1865),
                    eventType: "missingRing",
                    shiftYears: undefined,
                    shiftSide: undefined,
                },
                pathEvent(-5, -5, 0, 1913),
            ]),
        );
        const extended = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-6, -5, 1, 1897),
                {
                    ...pathEvent(1, 1, 0, 1921),
                    eventType: "falseRing",
                    shiftYears: undefined,
                    shiftSide: undefined,
                },
            ]),
            boundedPath([
                pathEvent(-6, -5, 1, 1898),
                {
                    ...pathEvent(1, 1, 0, 1922),
                    eventType: "falseRing",
                    shiftYears: undefined,
                    shiftSide: undefined,
                },
            ]),
        );

        expect(selectCandidateAnchoredStableBoundedLagPathFrontier(
            parsimonious,
            extended,
            [],
        )).toBe(parsimonious);
    });

    it("recovers two regularized partial components only with an exact aggregate anchor", () => {
        const regularized = boundedPath([
            pathEvent(-6, -26, -20, 1793),
            pathEvent(-20, -20, 0, 1826),
        ]);
        const aggregate = {
            ...partialMoveEvent(-26),
            startYear: 1761,
            endYear: 1769,
        };

        expect(selectAggregateAnchoredRegularizedPartialFrontier(
            regularized,
            [aggregate],
        )).toMatchObject({
            aggregateShiftYears: -26,
            transitionCount: 2,
            event: { eventType: "partialMove", shiftYears: -20 },
        });
        expect(selectAggregateAnchoredRegularizedPartialFrontier(
            regularized,
            [{ ...aggregate, shiftYears: -25 }],
        )).toBeNull();
        expect(selectAggregateAnchoredRegularizedPartialFrontier(
            regularized,
            [{
                ...aggregate,
                evidence: { ...aggregate.evidence, candidateIds: [] },
            }],
        )).toBeNull();
    });

    it("keeps a direct regularized partial when a trusted operation explains a permissive split", () => {
        const falseTransition = {
            ...pathEvent(1, -19, -20, 1354),
            eventType: "falseRing" as const,
            shiftYears: undefined,
            shiftSide: undefined,
        };
        const regularized = boundedPath([
            pathEvent(-71, -90, -19, 1146),
            falseTransition,
            pathEvent(-20, -20, 0, 1386),
        ]);
        const permissive = boundedPath([
            pathEvent(-71, -90, -19, 1146),
            falseTransition,
            pathEvent(-11, -20, -9, 1386),
            pathEvent(-9, -9, 0, 1406),
        ]);

        const selected = selectOperationAnchoredRegularizedAggregatePartialFrontier(
            regularized,
            permissive,
            operation(-19, 1386),
        );

        expect(selected).toMatchObject({
            event: {
                eventType: "partialMove",
                shiftYears: -20,
                evidence: {
                    algorithmSources: expect.arrayContaining([
                        "operation_anchored_regularized_aggregate",
                    ]),
                },
            },
        });
        expect(selected?.event.rankedYears[0]?.year).toBe(1386);
    });

    it("does not collapse a permissive split without aggregate operation support", () => {
        const regularized = boundedPath([pathEvent(-20, -20, 0, 1386)]);
        const permissive = boundedPath([
            pathEvent(-11, -20, -9, 1386),
            pathEvent(-9, -9, 0, 1406),
        ]);
        expect(selectOperationAnchoredRegularizedAggregatePartialFrontier(
            regularized,
            permissive,
            operation(-6, 1386),
        )).toBeNull();
    });

    it("uses a parsimonious operation checkpoint when no stable component exists", () => {
        const strongerSingle = boundedPath([pathEvent(-20, -20, 0, 1823)]);
        const regularizedSingle = boundedPath([pathEvent(-20, -20, 0, 1824)]);

        const selected = selectParsimoniousPartialOperationCheckpoint(
            strongerSingle,
            regularizedSingle,
            operation(-20, 1822),
            [],
            null,
            { startYear: 1600, endYear: 2000 },
        );

        expect(selected).toMatchObject({
            eventType: "partialMove",
            shiftYears: -20,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "parsimonious_partial_operation_checkpoint",
                    "two_state_bounded_path_consensus",
                ]),
            },
        });
        expect(selected?.startYear).toBeLessThanOrEqual(1822);
        expect(selected?.endYear).toBeGreaterThanOrEqual(1823);
    });

    it("recovers a concentrated terminal unit from one separated complete path", () => {
        const olderPartial = pathEvent(-21, -20, 1, 1650, 30);
        const newestFalse = pathEvent(1, 1, 0, 1680, 30);
        newestFalse.eventType = "falseRing";
        newestFalse.shiftYears = undefined;
        newestFalse.shiftSide = undefined;
        newestFalse.evidence.notes = [
            "bounded_path_location_concentration=0.94",
            "bounded_path_older_sample_pairs=60",
            "bounded_path_newer_sample_pairs=600",
        ];
        const completePath = boundedPath([olderPartial, newestFalse]);
        completePath.path.transitionGain = 35;
        completePath.path.runnerUpMargin = 0.75;

        expect(selectHighConfidenceSeparatedTerminalUnitFrontier(
            completePath,
        )).toMatchObject({
            eventType: "falseRing",
            startYear: newestFalse.startYear,
            endYear: newestFalse.endYear,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "high_confidence_separated_terminal_unit_frontier",
                ]),
            },
        });
    });

    it("rejects a concentrated unit that belongs to a nearby mixed cluster", () => {
        const olderPartial = pathEvent(-21, -20, 1, 1672, 30);
        const newestFalse = pathEvent(1, 1, 0, 1680, 30);
        newestFalse.eventType = "falseRing";
        newestFalse.shiftYears = undefined;
        newestFalse.shiftSide = undefined;
        newestFalse.evidence.notes = [
            "bounded_path_location_concentration=0.99",
            "bounded_path_older_sample_pairs=100",
            "bounded_path_newer_sample_pairs=100",
        ];
        const completePath = boundedPath([olderPartial, newestFalse]);
        completePath.path.transitionGain = 40;
        completePath.path.runnerUpMargin = 1;

        expect(selectHighConfidenceSeparatedTerminalUnitFrontier(
            completePath,
        )).toBeNull();
    });

    it("preserves a decisive independent partial location over a broad path peak", () => {
        const broadPath = pathEvent(-6, -6, 0, 1798, 60);
        broadPath.evidence.algorithmSources = ["cross_penalty_exact_partial_frontier"];
        broadPath.evidence.notes.push("bounded_path_location_concentration=0.47");
        const proposal = candidate("joint-location", -6, -6, 0, 1779);
        proposal.startYear = 1775;
        proposal.endYear = 1783;
        proposal.evidence.algorithmSources = [
            "decisive_joint_operation_fusion",
            "full_interval_counterfactual_scan",
            "joint_year_operation_evidence",
        ];
        proposal.evidence.scoreMargin = 0.56;
        proposal.evidence.correlationGain = 0.61;
        proposal.evidence.samplePairs = 464;

        expect(selectIndependentPartialLocationCheckpoint(
            broadPath,
            [proposal],
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -6,
            startYear: 1775,
            endYear: 1783,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "independent_partial_location_checkpoint",
                ]),
            },
        });
    });

    it("keeps a concentrated exact path over a detached partial proposal", () => {
        const concentratedPath = pathEvent(-6, -6, 0, 1798, 60);
        concentratedPath.evidence.algorithmSources = [
            "cross_penalty_exact_partial_frontier",
        ];
        concentratedPath.evidence.notes.push("bounded_path_location_concentration=0.92");
        const proposal = candidate("joint-location", -6, -6, 0, 1779);
        proposal.evidence.algorithmSources = [
            "decisive_joint_operation_fusion",
            "full_interval_counterfactual_scan",
        ];
        proposal.evidence.scoreMargin = 0.8;
        proposal.evidence.correlationGain = 0.8;
        proposal.evidence.samplePairs = 400;

        expect(selectIndependentPartialLocationCheckpoint(
            concentratedPath,
            [proposal],
        )).toBeNull();
    });

    it("removes a separated older false ring from a net partial operation", () => {
        const olderFalse = pathEvent(1, -19, -20, 1776);
        olderFalse.eventType = "falseRing";
        olderFalse.shiftYears = undefined;
        olderFalse.shiftSide = undefined;
        const newerPartial = pathEvent(-20, -20, 0, 1805);

        expect(selectCrossPenaltyTerminalNegativeClusterCheckpoint(
            boundedPath([olderFalse, newerPartial]),
            boundedPath([olderFalse, newerPartial]),
            operation(-19, 1784),
            { startYear: 1500, endYear: 2000 },
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -20,
            startYear: 1799,
            endYear: 1811,
            evidence: {
                lagBefore: -20,
                lagAfter: 0,
                algorithmSources: expect.arrayContaining([
                    "cross_penalty_terminal_negative_cluster",
                ]),
            },
        });
    });

    it("aggregates a nearby split partial before a separated older false ring", () => {
        const olderFalse = pathEvent(1, -5, -6, 1826);
        olderFalse.eventType = "falseRing";
        olderFalse.shiftYears = undefined;
        olderFalse.shiftSide = undefined;
        const olderPartial = pathEvent(-2, -6, -4, 1851);
        const newerPartial = pathEvent(-4, -4, 0, 1857);

        expect(selectCrossPenaltyTerminalNegativeClusterCheckpoint(
            boundedPath([olderFalse, olderPartial, newerPartial]),
            boundedPath([olderFalse, olderPartial, newerPartial]),
            operation(-5, 1848),
            { startYear: 1500, endYear: 2000 },
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -6,
            startYear: 1848,
            endYear: 1860,
        });
    });

    it("removes a separated older missing ring from a net partial operation", () => {
        const olderMissing = pathEvent(-1, -7, -6, 1816);
        olderMissing.eventType = "missingRing";
        olderMissing.shiftYears = undefined;
        olderMissing.shiftSide = undefined;
        const strongerPartial = pathEvent(-6, -6, 0, 1844);
        const regularizedMissing = pathEvent(-1, -6, -5, 1841);
        regularizedMissing.eventType = "missingRing";
        regularizedMissing.shiftYears = undefined;
        regularizedMissing.shiftSide = undefined;
        const regularizedPartial = pathEvent(-5, -5, 0, 1844);

        expect(selectCrossPenaltyTerminalNegativeClusterCheckpoint(
            boundedPath([olderMissing, strongerPartial]),
            boundedPath([olderMissing, regularizedMissing, regularizedPartial]),
            operation(-7, 1829),
            { startYear: 1500, endYear: 2000 },
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -6,
            evidence: {
                notes: expect.arrayContaining([
                    "terminal_negative_cluster_separated_unit_shift=-1",
                ]),
            },
        });
    });

    it("does not enlarge an operation without the exact separated +1 net relation", () => {
        const olderFalse = pathEvent(1, -19, -20, 1776);
        olderFalse.eventType = "falseRing";
        olderFalse.shiftYears = undefined;
        olderFalse.shiftSide = undefined;
        const newerPartial = pathEvent(-20, -20, 0, 1805);

        expect(selectCrossPenaltyTerminalNegativeClusterCheckpoint(
            boundedPath([olderFalse, newerPartial]),
            boundedPath([olderFalse, newerPartial]),
            operation(-20, 1805),
            { startYear: 1500, endYear: 2000 },
        )).toBeNull();
    });

    it("keeps a direct operation over a two-component irregular decomposition", () => {
        const strongerSingle = boundedPath([pathEvent(-20, -20, 0, 1730)]);
        const regularizedSingle = boundedPath([pathEvent(-20, -20, 0, 1731)]);
        const decomposed = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-5, -20, -15, 1727),
                pathEvent(-15, -15, 0, 1749),
            ]),
            boundedPath([
                pathEvent(-5, -20, -15, 1728),
                pathEvent(-15, -15, 0, 1750),
            ]),
        );

        expect(selectParsimoniousPartialOperationCheckpoint(
            strongerSingle,
            regularizedSingle,
            operation(-20, 1731),
            [],
            decomposed,
            { startYear: 1500, endYear: 2000 },
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -20,
            evidence: {
                notes: expect.arrayContaining([
                    "parsimonious_partial_replaces_irregular_aggregate=true",
                ]),
            },
        });
    });

    it("does not collapse a repeated stable partial sequence into its cumulative shift", () => {
        const repeated = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-6, -12, -6, 1800),
                pathEvent(-6, -6, 0, 1840),
            ]),
            boundedPath([
                pathEvent(-6, -12, -6, 1801),
                pathEvent(-6, -6, 0, 1841),
            ]),
        );

        expect(stableFrontierHasRepeatedOperationSupport(repeated)).toBe(true);
        expect(selectParsimoniousPartialOperationCheckpoint(
            boundedPath([pathEvent(-12, -12, 0, 1820)]),
            boundedPath([pathEvent(-12, -12, 0, 1821)]),
            operation(-12, 1820),
            [],
            repeated,
            { startYear: 1600, endYear: 2000 },
        )).toBeNull();
        expect(recoverStableBoundedLagPathFrontier(
            repeated,
            [],
            [],
            { startYear: 1600, endYear: 2000 },
        )).toMatchObject({ eventType: "partialMove", shiftYears: -6 });
    });

    it("keeps the newest component of a stable distant partial chain", () => {
        const separated = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-20, -26, -6, 1700),
                pathEvent(-6, -6, 0, 1730),
            ]),
            boundedPath([
                pathEvent(-20, -26, -6, 1701),
                pathEvent(-6, -6, 0, 1731),
            ]),
        );

        expect(selectSeparatedPartialComponentCheckpoint(separated)).toMatchObject({
            eventType: "partialMove",
            shiftYears: -6,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "separated_partial_component_frontier",
                ]),
            },
        });
    });

    it("keeps a candidate-backed newest false ring when older mixed states change net lag", () => {
        const newestFalse = pathEvent(1, 1, 0, 1858, 80);
        newestFalse.eventType = "falseRing";
        newestFalse.shiftYears = undefined;
        newestFalse.shiftSide = undefined;
        const olderPartial = pathEvent(-20, -19, 1, 1828, 80);
        const olderMissing = pathEvent(-1, -20, -19, 1798, 80);
        olderMissing.eventType = "missingRing";
        olderMissing.shiftYears = undefined;
        olderMissing.shiftSide = undefined;
        const stronger = boundedPath([olderMissing, olderPartial, newestFalse]);
        stronger.path.runnerUpMargin = 0.15;
        const regularized = boundedPath([
            olderMissing,
            olderPartial,
            { ...newestFalse, rankedYears: [{
                year: 1859,
                rank: 1,
                score: 1,
                evidenceTags: [],
            }] },
        ]);
        regularized.path.runnerUpMargin = 0.8;
        const falseCandidate = falseRingEvent(1855, true);
        falseCandidate.rankedYears = [{
            year: 1854,
            rank: 1,
            score: 1,
            evidenceTags: [],
        }];
        falseCandidate.evidence.notes.push("candidate_hard_gate_passed");

        expect(selectCandidateBackedCrossPenaltyUnitFrontier(
            stronger,
            regularized,
            [falseCandidate],
        )).toMatchObject({
            eventType: "falseRing",
            startYear: 1855,
            endYear: 1861,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "candidate_backed_cross_penalty_unit_frontier",
                ]),
                lagBefore: 1,
                lagAfter: 0,
            },
        });
    });

    it("does not promote an unanchored near-path unit transition", () => {
        const newestFalse = pathEvent(1, 1, 0, 1858, 80);
        newestFalse.eventType = "falseRing";
        newestFalse.shiftYears = undefined;
        newestFalse.shiftSide = undefined;
        const olderPartial = pathEvent(-20, -19, 1, 1828, 80);

        expect(selectCandidateBackedCrossPenaltyUnitFrontier(
            boundedPath([olderPartial, newestFalse]),
            boundedPath([olderPartial, newestFalse]),
            [],
        )).toBeNull();
    });

    it("keeps the newest partial after a distant missing step in one negative chain", () => {
        const missing = (year: number): DiagnosisEvent => ({
            ...pathEvent(-1, -4, -3, year),
            eventType: "missingRing",
            shiftYears: undefined,
            shiftSide: undefined,
        });
        const separated = selectStableBoundedLagPathFrontier(
            boundedPath([
                missing(1700),
                pathEvent(-3, -3, 0, 1730),
            ]),
            boundedPath([
                missing(1701),
                pathEvent(-3, -3, 0, 1731),
            ]),
        );

        expect(selectSeparatedPartialComponentCheckpoint(separated)).toMatchObject({
            eventType: "partialMove",
            shiftYears: -3,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "separated_negative_component_frontier",
                ]),
            },
        });
    });

    it("does not treat a mixed-sign distant chain as one negative frontier", () => {
        const falseRing = (year: number): DiagnosisEvent => ({
            ...pathEvent(1, -2, -3, year),
            eventType: "falseRing",
            shiftYears: undefined,
            shiftSide: undefined,
        });
        const mixed = selectStableBoundedLagPathFrontier(
            boundedPath([
                falseRing(1700),
                pathEvent(-3, -3, 0, 1730),
            ]),
            boundedPath([
                falseRing(1701),
                pathEvent(-3, -3, 0, 1731),
            ]),
        );

        expect(selectSeparatedPartialComponentCheckpoint(mixed)).toBeNull();
    });

    it("leaves a compact split partial to the aggregate operation checkpoint", () => {
        const compact = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-5, -20, -15, 1700),
                pathEvent(-15, -15, 0, 1722),
            ]),
            boundedPath([
                pathEvent(-5, -20, -15, 1701),
                pathEvent(-15, -15, 0, 1723),
            ]),
        );

        expect(selectSeparatedPartialComponentCheckpoint(compact)).toBeNull();
    });

    it("projects the newest member of a repeated partial component from one conservative path", () => {
        const repeated = boundedPath([
            pathEvent(-6, -24, -18, 1617),
            pathEvent(-6, -18, -12, 1644),
            pathEvent(-12, -12, 0, 1702),
        ]);
        repeated.path.transitionGain = 41.59;
        repeated.path.runnerUpMargin = 0.57;

        expect(selectRepeatedPartialComponentCheckpoint([null, repeated])).toMatchObject({
            eventType: "partialMove",
            shiftYears: -6,
            rankedYears: [{ year: 1702 }],
            evidence: {
                lagBefore: -6,
                lagAfter: 0,
                algorithmSources: expect.arrayContaining([
                    "repeated_partial_component_frontier",
                ]),
                notes: expect.arrayContaining([
                    "repeated_partial_component_shift=-6",
                    "repeated_partial_component_count=2",
                    "repeated_partial_component_years=1617,1644",
                ]),
            },
        });
        expect(selectRepeatedPartialComponentCheckpoint([
            boundedPath([pathEvent(-40, -40, 0, 1702)]),
        ])).toBeNull();
    });

    it("recovers a repeated component when one copy is split into two nearby shifts", () => {
        const path = boundedPath([
            pathEvent(-9, -40, -31, 1820),
            pathEvent(-11, -31, -20, 1830),
            pathEvent(-20, -20, 0, 1846),
        ]);
        path.path.transitionGain = 47.09;
        path.path.runnerUpMargin = 0.15;

        expect(selectSplitRepeatedPartialComponentCheckpoint([path])).toMatchObject({
            eventType: "partialMove",
            shiftYears: -20,
            rankedYears: [{ year: 1846 }],
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "split_repeated_partial_component_frontier",
                ]),
                notes: expect.arrayContaining([
                    "split_repeated_component_shifts=-9,-11",
                ]),
            },
        });
    });

    it("keeps an exact terminal partial reproduced by two path penalties", () => {
        const stronger = boundedPath([
            pathEvent(-20, -20, 0, 1732),
            pathEvent(1, -19, -20, 1705),
        ]);
        stronger.path.transitionGain = 174.94;
        stronger.path.runnerUpMargin = 2.14;
        const regularized = boundedPath([
            pathEvent(-20, -20, 0, 1733),
            pathEvent(1, -19, -20, 1706),
        ]);
        regularized.path.transitionGain = 176.94;
        regularized.path.runnerUpMargin = 0.62;

        expect(selectCrossPenaltyExactPartialCheckpoint(
            stronger,
            regularized,
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -20,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "cross_penalty_exact_partial_frontier",
                ]),
            },
        });
        regularized.events[0].shiftYears = -19;
        regularized.events[0].evidence.lagBefore = -19;
        expect(selectCrossPenaltyExactPartialCheckpoint(
            stronger,
            regularized,
        )).toBeNull();

        const completed = partialMoveEvent(-2);
        completed.evidence.algorithmSources.push(
            "completed_partial_missing_composition",
        );
        expect(hasCompletedMixedCompositionLocation([completed])).toBe(true);
        expect(hasCompletedMixedCompositionLocation([partialMoveEvent(-2)]))
            .toBe(false);

        const exact = partialMoveEvent(-2);
        exact.rankedYears = [{ year: 1788, rank: 1, score: 1, evidenceTags: [] }];
        const nearbyAggregate = partialMoveEvent(-3);
        nearbyAggregate.rankedYears = [{
            year: 1784,
            rank: 1,
            score: 1,
            evidenceTags: [],
        }];
        expect(hasNearbyLargerPartialCompositionSeed([nearbyAggregate], exact))
            .toBe(true);
        nearbyAggregate.rankedYears[0].year = 1819;
        expect(hasNearbyLargerPartialCompositionSeed([nearbyAggregate], exact))
            .toBe(false);

        const located = partialMoveEvent(-20);
        located.rankedYears = [{ year: 1529, rank: 1, score: 1, evidenceTags: [] }];
        located.evidence.algorithmSources.push(
            "cross_penalty_exact_partial_frontier",
        );
        located.evidence.notes.push("bounded_path_location_concentration=0.94");
        expect(hasHighConcentrationCrossPenaltyLocationAuthority(located)).toBe(true);
        expect(localLagAdvancesCrossPenaltyFrontier(located, {
            eventCount: 3,
            evidenceYears: [1528, 1532, 1536],
            operationTypes: ["missingRing"],
            aggregateShiftYears: -20,
            locallyComplete: true,
            maximumYearDrift: 2,
        })).toBe(true);
    });

    it("uses an independently scored terminal operation to unmerge a later component", () => {
        const missingAt = (year: number): DiagnosisEvent => {
            const item = pathEvent(-1, -1, 0, year, 40);
            item.eventType = "missingRing";
            delete item.shiftYears;
            delete item.shiftSide;
            return item;
        };
        const stronger = boundedPath([
            pathEvent(-20, -46, -26, 1778, 40),
            pathEvent(-25, -26, -1, 1816, 40),
            missingAt(1835),
        ]);
        const regularized = boundedPath([
            pathEvent(-20, -46, -26, 1779, 40),
            pathEvent(-25, -26, -1, 1817, 40),
            missingAt(1836),
        ]);

        expect(selectTerminalOperationAnchoredPartialCheckpoint(
            stronger,
            regularized,
            [operation(-20, 1836)],
            { startYear: 1500, endYear: 2000 },
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -20,
            startYear: 1830,
            endYear: 1842,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "terminal_operation_anchored_partial_checkpoint",
                ]),
            },
        });
    });

    it("recovers a partial amplitude collapsed with a missing-false unit pair", () => {
        const missingAt = (year: number): DiagnosisEvent => {
            const item = pathEvent(-1, -20, -19, year, 80);
            item.eventType = "missingRing";
            delete item.shiftYears;
            delete item.shiftSide;
            return item;
        };
        const stronger = boundedPath([
            missingAt(1842),
            pathEvent(-8, -19, -11, 1877, 80),
            pathEvent(-11, -11, 0, 1896, 80),
        ]);
        const regularized = boundedPath([
            missingAt(1843),
            pathEvent(-8, -19, -11, 1878, 80),
            pathEvent(-11, -11, 0, 1897, 80),
        ]);
        const strongOperation = (
            eventType: "missingRing" | "falseRing" | "partialMove",
            shiftYears: number,
        ): JointCounterfactualOperationScore => ({
            ...operation(shiftYears, 1854),
            eventType,
            shiftYears,
            bestRawGain: 0.2,
            bestDifferenceGain: 0.3,
            bestCombinedGain: 0.25,
            topThreeDifferenceGain: 0.25,
        });

        expect(selectCollapsedMissingFalsePartialCheckpoint(
            stronger,
            regularized,
            [
                strongOperation("partialMove", -20),
                strongOperation("missingRing", -1),
                strongOperation("falseRing", 1),
            ],
            { startYear: 1500, endYear: 2000 },
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -20,
            startYear: 1892,
            endYear: 1904,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "collapsed_missing_false_partial_checkpoint",
                ]),
            },
        });
    });

    it("keeps a false-ring return to zero reproduced by two penalties", () => {
        const falseAt = (year: number): DiagnosisEvent => {
            const event = falseRingEvent(year, false);
            event.rankedYears = [{ year, rank: 1, score: 1, evidenceTags: [] }];
            event.evidence.algorithmSources = ["bounded_complete_lag_path"];
            event.evidence.lagBefore = 1;
            event.evidence.lagAfter = 0;
            return event;
        };
        const stronger = boundedPath([falseAt(1856)]);
        const strongerOlder = falseAt(1825);
        strongerOlder.evidence.lagBefore = 2;
        strongerOlder.evidence.lagAfter = 1;
        stronger.events.push(strongerOlder);
        stronger.path.transitionGain = 76;
        stronger.path.runnerUpMargin = 0.02;
        const regularized = boundedPath([falseAt(1857)]);
        const regularizedOlder = falseAt(1826);
        regularizedOlder.evidence.lagBefore = 2;
        regularizedOlder.evidence.lagAfter = 1;
        regularized.events.push(regularizedOlder);
        regularized.path.transitionGain = 80;
        regularized.path.runnerUpMargin = 0.75;

        expect(selectCrossPenaltyFalseRingFrontier(
            stronger,
            regularized,
        )).toMatchObject({
            eventType: "falseRing",
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "cross_penalty_false_ring_frontier",
                ]),
            },
        });
        regularized.events[0].evidence.lagBefore = -1;
        expect(selectCrossPenaltyFalseRingFrontier(
            stronger,
            regularized,
        )).toBeNull();

        const completeChain = (yearDrift: number): BoundedLagStateEventSet => {
            const events = Array.from({ length: 4 }, (_, index) => {
                const before = index + 1;
                const item = falseAt(1856 - index * 20 + yearDrift);
                item.evidence.lagBefore = before;
                item.evidence.lagAfter = before - 1;
                return item;
            });
            events[0].evidence.locationEvidence = [{
                source: "bounded_complete_lag_path",
                startYear: 1850 + yearDrift,
                endYear: 1862 + yearDrift,
                topYear: 1856 + yearDrift,
                referenceCount: 12,
                concentration: 0.7,
                remoteMargin: 1.1,
                calibrated: false,
            }];
            return boundedPath(events);
        };
        const completeStronger = completeChain(0);
        const completeRegularized = completeChain(1);
        expect(hasSelfContainedPositiveUnitChainAuthority(
            completeStronger,
            completeRegularized,
        )).toBe(true);
        completeStronger.path.runnerUpMargin = 3;
        expect(selectSelfContainedPositiveUnitChainFrontier(
            completeStronger,
        )).toMatchObject({
            eventType: "falseRing",
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "self_contained_positive_unit_chain_frontier",
                ]),
            },
        });
        completeRegularized.events.push(pathEvent(-2, -2, 0, 1700));
        expect(hasSelfContainedPositiveUnitChainAuthority(
            completeStronger,
            completeRegularized,
        )).toBe(false);
    });

    it("decomposes a compressed cumulative missing path before its whole-series alias", () => {
        const missingAt = (year: number): DiagnosisEvent => {
            const event = pathEvent(-1, -4, -3, year, 60);
            event.eventType = "missingRing";
            delete event.shiftYears;
            delete event.shiftSide;
            return event;
        };
        const compressedAt = (year: number): DiagnosisEvent => {
            const event = pathEvent(-3, -3, 0, year, 60);
            event.evidence.scoreMargin = 0.4;
            event.evidence.locationEvidence = [{
                source: "bounded_complete_lag_path",
                startYear: year - 6,
                endYear: year + 6,
                topYear: year,
                referenceCount: 20,
                concentration: 0.58,
                remoteMargin: 1.1,
                calibrated: false,
            }];
            return event;
        };
        const frontier = selectStableBoundedLagPathFrontier(
            boundedPath([missingAt(1607), compressedAt(1636)]),
            boundedPath([missingAt(1608), compressedAt(1637)]),
        );

        expect(selectCumulativeMissingWholeAliasFrontier(
            frontier,
            [-4],
            1751,
        )).toMatchObject({
            aggregateShiftYears: -4,
            event: {
                eventType: "partialMove",
                shiftYears: -3,
                rankedYears: [{ year: 1636 }],
                evidence: {
                    algorithmSources: expect.arrayContaining([
                        "compressed_cumulative_missing_alias_frontier",
                    ]),
                },
            },
        });
        expect(selectCumulativeMissingWholeAliasFrontier(
            frontier,
            [-11],
            1751,
        )).toBeNull();

        const unitAt = (lagBefore: number, year: number): DiagnosisEvent => {
            const event = pathEvent(-1, lagBefore, lagBefore + 1, year, 55);
            event.eventType = "missingRing";
            delete event.shiftYears;
            delete event.shiftSide;
            event.evidence.scoreMargin = 0.35;
            event.evidence.locationEvidence = [{
                source: "bounded_complete_lag_path",
                startYear: year - 6,
                endYear: year + 6,
                topYear: year,
                referenceCount: 20,
                concentration: 0.72,
                remoteMargin: 1.4,
                calibrated: false,
            }];
            return event;
        };
        const unitFrontier = selectStableBoundedLagPathFrontier(
            boundedPath([unitAt(-2, 1607), unitAt(-1, 1616)]),
            boundedPath([unitAt(-2, 1608), unitAt(-1, 1617)]),
            0,
            5,
        );
        expect(selectCumulativeMissingWholeAliasFrontier(
            unitFrontier,
            [-2],
            1751,
        )).toMatchObject({
            event: {
                eventType: "missingRing",
                rankedYears: [{ year: 1616 }],
                evidence: {
                    algorithmSources: expect.arrayContaining([
                        "cumulative_missing_whole_alias_frontier",
                    ]),
                },
            },
        });
    });

    it("leaves compact unit aggregates and adjacent partial-plus-unit amplitudes to serial recovery", () => {
        expect(selectParsimoniousPartialOperationCheckpoint(
            boundedPath([pathEvent(-4, -4, 0, 1820)]),
            boundedPath([pathEvent(-4, -4, 0, 1821)]),
            operation(-4, 1820),
            [],
            null,
            { startYear: 1600, endYear: 2000 },
        )).toBeNull();

        const olderMissing = {
            ...pathEvent(-1, -21, -20, 1780),
            eventType: "missingRing" as const,
            shiftYears: undefined,
            shiftSide: undefined,
        };
        const partialPlusUnit = selectStableBoundedLagPathFrontier(
            boundedPath([olderMissing, pathEvent(-20, -20, 0, 1820)]),
            boundedPath([{
                ...olderMissing,
                rankedYears: [{ year: 1781, rank: 1, score: 1, evidenceTags: [] }],
            }, pathEvent(-20, -20, 0, 1821)]),
        );
        expect(selectParsimoniousPartialOperationCheckpoint(
            boundedPath([pathEvent(-21, -21, 0, 1820)]),
            boundedPath([pathEvent(-21, -21, 0, 1821)]),
            operation(-21, 1820),
            [],
            partialPlusUnit,
            { startYear: 1600, endYear: 2000 },
        )).toBeNull();
    });

    it("lets regularized aggregate consensus replace only an irregular weak path", () => {
        const irregular = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-18, -20, -2, 1800),
                pathEvent(-2, -2, 0, 1840),
            ]),
            boundedPath([
                pathEvent(-18, -20, -2, 1801),
                pathEvent(-2, -2, 0, 1841),
            ]),
        );
        const consensus = partialMoveEvent(-20);
        consensus.evidence.algorithmSources.push("regularized_partial_operation_consensus");

        expect(selectRegularizedPartialConsensusCheckpoint(irregular, consensus))
            .toMatchObject({
                eventType: "partialMove",
                shiftYears: -20,
                evidence: {
                    algorithmSources: expect.arrayContaining([
                        "regularized_consensus_preempts_irregular_decomposition",
                    ]),
                },
            });

        const repeated = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-6, -12, -6, 1800),
                pathEvent(-6, -6, 0, 1840),
            ]),
            boundedPath([
                pathEvent(-6, -12, -6, 1801),
                pathEvent(-6, -6, 0, 1841),
            ]),
        );
        expect(selectRegularizedPartialConsensusCheckpoint(repeated, {
            ...consensus,
            shiftYears: -12,
        })).toBeNull();
    });

    it("keeps only multiscale-stable unit path locations as sequential checkpoints", () => {
        const located = (
            event: DiagnosisEvent,
            concentration: number,
            remoteMargin: number,
        ): DiagnosisEvent => ({
            ...event,
            evidence: {
                ...event.evidence,
                locationEvidence: [{
                    source: "bounded_complete_lag_path",
                    startYear: event.startYear,
                    endYear: event.endYear,
                    topYear: event.rankedYears[0]?.year ?? event.startYear,
                    referenceCount: 20,
                    concentration,
                    remoteMargin,
                    calibrated: false,
                }],
            },
        });
        const missing = located({
            ...pathEvent(-1, -1, 0, 1489),
            eventType: "missingRing",
            shiftYears: undefined,
            shiftSide: undefined,
        }, 0.77, 2.3);
        const unstableFalse = located({
            ...pathEvent(1, 1, 0, 1445),
            eventType: "falseRing",
            shiftYears: undefined,
            shiftSide: undefined,
        }, 0.28, 0.2);
        const intermediateMissing = located({
            ...pathEvent(-1, -2, -1, 1460),
            eventType: "missingRing",
            shiftYears: undefined,
            shiftSide: undefined,
        }, 0.81, 3.1);

        expect(selectStableUnitPathLocationCheckpoints(
            boundedPath([missing, unstableFalse, intermediateMissing]),
            boundedPath([
                { ...missing, rankedYears: [{ ...missing.rankedYears[0], year: 1490 }] },
                unstableFalse,
                intermediateMissing,
            ]),
        )).toEqual([missing]);
    });

    it("anchors a strong unit path only when an independent location agrees", () => {
        const located = (input: DiagnosisEvent): DiagnosisEvent => ({
            ...input,
            evidence: {
                ...input.evidence,
                algorithmSources: ["bounded_complete_lag_path"],
                locationEvidence: [{
                    source: "bounded_complete_lag_path",
                    startYear: input.startYear,
                    endYear: input.endYear,
                    topYear: input.rankedYears[0]?.year ?? input.startYear,
                    referenceCount: 20,
                    concentration: 0.91,
                    remoteMargin: 2.4,
                    calibrated: false,
                }],
            },
        });
        const missing = located({
            ...pathEvent(-1, -1, 0, 1875),
            eventType: "missingRing",
            shiftYears: undefined,
            shiftSide: undefined,
        });
        const independentPartial = {
            ...pathEvent(-99, -99, 0, 1875),
            evidence: {
                ...pathEvent(-99, -99, 0, 1875).evidence,
                algorithmSources: ["reference_core_voting"],
            },
        };

        expect(selectCorroboratedUnitPathLocationCheckpoint(
            [missing],
            [independentPartial],
        )).toBe(missing);
        expect(selectCorroboratedUnitPathLocationCheckpoint(
            [missing],
            [{ ...independentPartial, rankedYears: [{
                ...independentPartial.rankedYears[0],
                year: 1868,
            }] }],
        )).toBeNull();
    });

    it("rejects close, discontinuous, or penalty-unstable decompositions", () => {
        const separated = boundedPath([
            pathEvent(-20, -26, -6, 1750),
            pathEvent(-6, -6, 0, 1780),
        ]);
        expect(selectStableBoundedLagPathFrontier(separated, boundedPath([
            pathEvent(-20, -26, -6, 1750),
            pathEvent(-6, -6, 0, 1758),
        ]))).toBeNull();
        expect(selectStableBoundedLagPathFrontier(separated, boundedPath([
            pathEvent(-20, -26, -6, 1750),
            pathEvent(-6, -7, -1, 1780),
        ]))).toBeNull();
        expect(selectStableBoundedLagPathFrontier(separated, boundedPath([
            pathEvent(-19, -25, -6, 1750),
            pathEvent(-6, -6, 0, 1780),
        ]))).toBeNull();
    });

    it("keeps a supported non-zero whole baseline outside the local path", () => {
        const penaltyOne = boundedPath([
            pathEvent(-20, -30, -10, 1750),
            pathEvent(-6, -10, -4, 1780),
        ]);
        const penaltyHalf = boundedPath([
            pathEvent(-20, -30, -10, 1751),
            pathEvent(-6, -10, -4, 1781),
        ]);

        const selected = selectStableBoundedLagPathFrontier(
            penaltyOne,
            penaltyHalf,
            -4,
        );

        expect(selected).toMatchObject({
            aggregateShiftYears: -26,
            baselineLag: -4,
            event: { shiftYears: -6 },
        });
    });

    it("accepts a stable distant unit pulse that returns to its baseline", () => {
        const unitPathEvent = (
            eventType: "missingRing" | "falseRing",
            lagBefore: number,
            lagAfter: number,
            year: number,
        ): DiagnosisEvent => ({
            ...pathEvent(lagBefore - lagAfter, lagBefore, lagAfter, year),
            eventType,
            shiftYears: undefined,
            shiftSide: undefined,
        });
        const penaltyHalf = boundedPath([
            unitPathEvent("missingRing", 0, 1, 1750),
            unitPathEvent("falseRing", 1, 0, 1780),
        ]);
        const penaltyQuarter = boundedPath([
            unitPathEvent("missingRing", 0, 1, 1751),
            unitPathEvent("falseRing", 1, 0, 1781),
        ]);

        const selected = selectStableBoundedLagPathFrontier(
            penaltyHalf,
            penaltyQuarter,
            0,
            14,
            2,
            "0.5,0.25",
        );

        expect(selected).toMatchObject({
            aggregateShiftYears: 0,
            transitionCount: 2,
            event: { eventType: "falseRing" },
        });
        expect(selected?.event.evidence.notes).toContain(
            "stable_bounded_path_penalties=0.5,0.25",
        );
    });

    it("keeps the newest repeated unit transition even when an older location is sharper", () => {
        const localizedFalse = (
            year: number,
            lagBefore: number,
            lagAfter: number,
            concentration: number,
            remoteMargin: number,
        ): DiagnosisEvent => {
            const event = pathEvent(1, lagBefore, lagAfter, year);
            event.eventType = "falseRing";
            event.shiftYears = undefined;
            event.shiftSide = undefined;
            event.evidence.locationEvidence = [{
                source: "bounded_complete_lag_path",
                startYear: year - 6,
                endYear: year + 6,
                topYear: year,
                referenceCount: 12,
                concentration,
                remoteMargin,
                calibrated: false,
            }];
            return event;
        };
        const penaltyOne = boundedPath([
            localizedFalse(1766, 2, 1, 0.8, 2),
            localizedFalse(1823, 1, 0, 0.5, 0.4),
        ]);
        const penaltyHalf = boundedPath([
            localizedFalse(1767, 2, 1, 0.8, 2),
            localizedFalse(1824, 1, 0, 0.5, 0.4),
        ]);

        const selected = selectStableBoundedLagPathFrontier(
            penaltyOne,
            penaltyHalf,
        );

        expect(selected?.event.rankedYears[0]?.year).toBe(1823);
        expect(selected?.event.evidence.notes).toContain(
            "stable_bounded_path_selected_year=1823",
        );
    });

    it("preserves a newest unit transition backed by an independent candidate window", () => {
        const localizedFalse = (
            year: number,
            lagBefore: number,
            lagAfter: number,
            priority: number,
        ): DiagnosisEvent => {
            const event = pathEvent(1, lagBefore, lagAfter, year);
            event.eventType = "falseRing";
            event.shiftYears = undefined;
            event.shiftSide = undefined;
            event.evidence.locationEvidence = [{
                source: "bounded_complete_lag_path",
                startYear: year - 6,
                endYear: year + 6,
                topYear: year,
                referenceCount: 12,
                concentration: priority,
                remoteMargin: priority,
                calibrated: false,
            }];
            return event;
        };
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([
                localizedFalse(1766, 2, 1, 0.9),
                localizedFalse(1823, 1, 0, 0.3),
            ]),
            boundedPath([
                localizedFalse(1767, 2, 1, 0.9),
                localizedFalse(1824, 1, 0, 0.3),
            ]),
        );
        const candidateBackedNewest = falseRingEvent(1819, true);
        candidateBackedNewest.endYear = 1827;
        candidateBackedNewest.rankedYears = [{
            year: 1823,
            rank: 1,
            score: 1,
            evidenceTags: ["candidate_ranking"],
        }];
        candidateBackedNewest.evidence.algorithmSources = ["candidate_ranking"];

        const recovered = recoverStableBoundedLagPathFrontier(
            selected,
            [candidateBackedNewest],
            [],
        );

        expect(recovered?.rankedYears[0]?.year).toBe(1823);
        expect(recovered?.evidence.notes).toContain(
            "stable_bounded_path_selected_year=1823",
        );
        expect(recovered?.evidence.notes).toContain(
            "stable_bounded_path_component_lag_after=0",
        );
    });

    it("centers a stable unit window between path and supported operation evidence", () => {
        const unitEvent = (year: number): DiagnosisEvent => ({
            ...pathEvent(1, 1, 0, year),
            eventType: "falseRing",
            shiftYears: undefined,
            shiftSide: undefined,
        });
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-6, -5, 1, 1880),
                unitEvent(1916),
            ]),
            boundedPath([
                pathEvent(-6, -5, 1, 1881),
                unitEvent(1917),
            ]),
        );
        const falseOperation: JointCounterfactualOperationScore = {
            ...operation(1, 1925),
            eventType: "falseRing",
        };

        const recovered = recoverStableBoundedLagPathFrontier(
            selected,
            [],
            [falseOperation],
            { startYear: 1800, endYear: 2000 },
        );

        expect(recovered).toMatchObject({
            eventType: "falseRing",
            startYear: 1915,
            endYear: 1927,
        });
        expect(recovered?.rankedYears[0]?.year).toBe(1925);
        expect(recovered?.evidence.notes).toContain(
            "stable_bounded_path_calibrated_center=1921",
        );
        expect(recovered?.evidence.notes).toContain(
            "stable_bounded_path_component_lag_before=1",
        );
    });

    it("rejects an opposite-sign unit component without independent operation evidence", () => {
        const unitEvent = (year: number): DiagnosisEvent => ({
            ...pathEvent(1, 1, 0, year),
            eventType: "falseRing",
            shiftYears: undefined,
            shiftSide: undefined,
        });
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-3, -2, 1, 1840),
                unitEvent(1877),
            ]),
            boundedPath([
                pathEvent(-3, -2, 1, 1841),
                unitEvent(1878),
            ]),
        );

        expect(selected?.aggregateShiftYears).toBe(-2);
        expect(recoverStableBoundedLagPathFrontier(selected, [], []))
            .toBeNull();
    });

    it("preserves a sharply localized newest unit transition", () => {
        const localizedFalse = (
            year: number,
            lagBefore: number,
            lagAfter: number,
            concentration: number,
            remoteMargin: number,
        ): DiagnosisEvent => {
            const event = pathEvent(1, lagBefore, lagAfter, year);
            event.eventType = "falseRing";
            event.shiftYears = undefined;
            event.shiftSide = undefined;
            event.evidence.locationEvidence = [{
                source: "bounded_complete_lag_path",
                startYear: year - 6,
                endYear: year + 6,
                topYear: year,
                referenceCount: 12,
                concentration,
                remoteMargin,
                calibrated: false,
            }];
            return event;
        };
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([
                localizedFalse(1868, 2, 1, 0.99, 14),
                localizedFalse(1887, 1, 0, 0.93, 1),
            ]),
            boundedPath([
                localizedFalse(1869, 2, 1, 0.99, 14),
                localizedFalse(1888, 1, 0, 0.93, 1),
            ]),
        );

        expect(selected?.event.rankedYears[0]?.year).toBe(1887);
    });

    it("keeps structural partial transitions when the permissive path adds a reversible unit pulse", () => {
        const localizedPartial = (
            shiftYears: number,
            lagBefore: number,
            lagAfter: number,
            year: number,
            concentration: number,
            remoteMargin: number,
        ): DiagnosisEvent => {
            const event = pathEvent(shiftYears, lagBefore, lagAfter, year);
            event.evidence.algorithmSources = ["bounded_complete_lag_path"];
            event.evidence.locationEvidence = [{
                source: "bounded_complete_lag_path",
                startYear: year - 6,
                endYear: year + 6,
                topYear: year,
                referenceCount: 34,
                concentration,
                remoteMargin,
                calibrated: false,
            }];
            return event;
        };
        const unit = (
            eventType: "missingRing" | "falseRing",
            lagBefore: number,
            lagAfter: number,
            year: number,
        ): DiagnosisEvent => ({
            ...localizedPartial(lagBefore - lagAfter, lagBefore, lagAfter, year, 0.7, 1),
            eventType,
            shiftYears: undefined,
            shiftSide: undefined,
        });
        const older = localizedPartial(-22, -26, -4, 1769, 0.8, 2);
        const newer = localizedPartial(-4, -4, 0, 1841, 0.5, 0.3);
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([older, newer]),
            boundedPath([
                unit("falseRing", -26, -27, 1690),
                unit("missingRing", -27, -26, 1707),
                localizedPartial(-22, -26, -4, 1769, 0.8, 2),
                localizedPartial(-4, -4, 0, 1841, 0.5, 0.3),
            ]),
        );

        expect(selected).toMatchObject({
            structuralSubset: true,
            aggregateShiftYears: -26,
            transitionCount: 2,
            event: { eventType: "partialMove", shiftYears: -22 },
        });

        const aggregate = candidate("aggregate", -26, -26, 0, 1775);
        const cofechaComponent = candidate("cofecha-component", -6, -6, 0, 1825);
        cofechaComponent.evidence.algorithmSources = ["cofecha_segment_lag"];
        const recovered = recoverStableBoundedLagPathFrontier(
            selected,
            [aggregate],
            [operation(-26, 1775), operation(-20, 1511)],
            { startYear: 1495, endYear: 1964 },
            [cofechaComponent],
        );

        expect(recovered).toMatchObject({
            eventType: "partialMove",
            shiftYears: -20,
            startYear: 1764,
            endYear: 1776,
        });
        expect(recovered?.evidence.notes).toContain(
            "stable_bounded_path_component_calibrated_from_cofecha=-6",
        );
        expect(recovered?.evidence.notes).toContain(
            "stable_bounded_path_component_calibrated_shift=-20",
        );
    });

    it("does not turn a stable path into an unsupported large partial operation", () => {
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-10, -53, -43, 1450),
                pathEvent(-43, -43, 0, 1490),
            ]),
            boundedPath([
                pathEvent(-10, -53, -43, 1451),
                pathEvent(-43, -43, 0, 1491),
            ]),
        );

        expect(recoverStableBoundedLagPathFrontier(selected, [], [])).toBeNull();
        expect(recoverStableBoundedLagPathFrontier(
            selected,
            [],
            [operation(-43, 1490)],
        )).toMatchObject({ eventType: "partialMove", shiftYears: -43 });
    });

    it("keeps a directly localized terminal unit ahead of a path-only partial component", () => {
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-3, -5, -2, 1840),
                pathEvent(-2, -2, 0, 1900),
            ]),
            boundedPath([
                pathEvent(-3, -5, -2, 1841),
                pathEvent(-2, -2, 0, 1901),
            ]),
        );
        const stable = recoverStableBoundedLagPathFrontier(
            selected,
            [],
            [operation(-2, 1901)],
            { startYear: 1700, endYear: 2000 },
        );
        const directUnit: DiagnosisEvent = {
            ...falseRingEvent(1897, false),
            id: "direct-terminal-missing",
            eventType: "missingRing",
            startYear: 1897,
            endYear: 1905,
            rankedYears: [{ year: 1901, rank: 1, score: 2, evidenceTags: [] }],
            evidence: {
                ...falseRingEvent(1897, false).evidence,
                lagBefore: -1,
                lagAfter: 0,
                algorithmSources: [
                    "counterfactual_window_refinement",
                    "joint_event_counterfactual",
                    "local_counterfactual_raw_year",
                    "piecewise_lag_path",
                ],
                notes: ["mixed_reference_counterfactual_selected"],
            },
        };

        expect(selectDirectTerminalUnitBeforeDerivedStablePartial(
            selected,
            stable,
            [directUnit],
        )).toMatchObject({
            eventType: "missingRing",
            rankedYears: [{ year: 1901 }],
        });

        const independentPartial = candidatePartial({
            shiftYears: -2,
            anchorYear: 1901,
            candidateId: "physical-partial",
            source: "cofecha_segment_lag",
        });
        expect(selectDirectTerminalUnitBeforeDerivedStablePartial(
            selected,
            stable,
            [directUnit],
            [independentPartial],
        )).toBeNull();
    });

    it("keeps a newer independently localized unit ahead of an older stable path", () => {
        const olderTerminalOne = pathEvent(-1, -1, 0, 1902);
        olderTerminalOne.eventType = "missingRing";
        const olderTerminalHalf = pathEvent(-1, -1, 0, 1903);
        olderTerminalHalf.eventType = "missingRing";
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-10, -11, -1, 1810),
                olderTerminalOne,
            ]),
            boundedPath([
                pathEvent(-10, -11, -1, 1811),
                olderTerminalHalf,
            ]),
        );
        const stable = selected?.event ?? null;
        const newer = falseRingEvent(1974, false);
        newer.eventType = "missingRing";
        newer.startYear = 1973;
        newer.endYear = 1979;
        newer.rankedYears = [{ year: 1977, rank: 1, score: 3, evidenceTags: [] }];
        newer.evidence = {
            ...newer.evidence,
            score: 3,
            scoreMargin: 0.7,
            correlationGain: 0.4,
            samplePairs: 66,
            lagBefore: -1,
            lagAfter: 0,
            algorithmSources: [
                "counterfactual_window_refinement",
                "joint_event_counterfactual",
                "piecewise_lag_path",
            ],
            notes: [
                "nominal_boundary_year=1977",
                "profile_boundary_year=1977",
            ],
        };

        expect(selectDirectTerminalUnitBeforeDerivedStablePartial(
            selected,
            stable,
            [newer],
        )).toMatchObject({
            eventType: "missingRing",
            rankedYears: [{ year: 1977 }],
        });
        expect(selectDirectTerminalUnitBeforeDerivedStablePartial(
            selected,
            stable,
            [{
                ...newer,
                evidence: {
                    ...newer.evidence,
                    notes: ["nominal_boundary_year=1977", "profile_boundary_year=1976"],
                },
            }],
        )).toBeNull();
    });

    it("lets a stale master locate but not own a repeated older partial operation", () => {
        const olderPartial = partialMoveEvent(-3);
        olderPartial.startYear = 1895;
        olderPartial.endYear = 1907;
        olderPartial.rankedYears = [{ year: 1902, rank: 1, score: 5, evidenceTags: [] }];
        olderPartial.evidence = {
            ...olderPartial.evidence,
            algorithmSources: [
                "bounded_complete_lag_path",
                "repeated_partial_component_frontier",
            ],
        };
        const newestUnit = falseRingEvent(1974, false);
        newestUnit.eventType = "missingRing";
        newestUnit.startYear = 1973;
        newestUnit.endYear = 1979;
        newestUnit.rankedYears = [{ year: 1976, rank: 1, score: 3, evidenceTags: [] }];
        newestUnit.evidence = {
            ...newestUnit.evidence,
            scoreMargin: 0.12,
            correlationGain: 0.23,
            samplePairs: 58,
            lagBefore: -1,
            lagAfter: 0,
            algorithmSources: ["piecewise_lag_path"],
            notes: [
                "mixed_reference_counterfactual_selected",
                "nominal_boundary_year=1977",
                "profile_boundary_year=1977",
            ],
        };
        const olderTerminalOne = pathEvent(-1, -1, 0, 1902);
        olderTerminalOne.eventType = "missingRing";
        const olderTerminalHalf = pathEvent(-1, -1, 0, 1903);
        olderTerminalHalf.eventType = "missingRing";
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-10, -11, -1, 1810),
                olderTerminalOne,
            ]),
            boundedPath([
                pathEvent(-10, -11, -1, 1811),
                olderTerminalHalf,
            ]),
        );

        expect(selectDirectTerminalUnitBeforeDerivedStablePartial(
            selected,
            olderPartial,
            [newestUnit],
        )).toBeNull();
        expect(selectDirectTerminalUnitBeforeDerivedStablePartial(
            selected,
            olderPartial,
            [newestUnit],
            [],
            true,
        )).toMatchObject({
            eventType: "missingRing",
            startYear: 1973,
            endYear: 1979,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "stale_reference_terminal_unit_checkpoint",
                ]),
            },
        });
    });

    it("projects a bark-side unit event instead of a deep unsupported cumulative whole alias", () => {
        const alias = wholeSeriesEvent(-8);
        alias.shiftYears = -8;
        alias.seriesRange = { startYear: 1500, endYear: 2000 };
        alias.evidence.notes = [
            "candidate_hard_gate_passed",
            "whole_state_older_edge_support_fraction=1.000000",
            "whole_state_newer_edge_support_fraction=0.000000",
            "whole_state_newest_lag=-1",
        ];

        const projected = projectEndpointMissingFromCumulativeWholeAlias(alias, [-8]);
        expect(projected).toMatchObject({
            eventType: "missingRing",
            startYear: 1988,
            endYear: 2000,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "terminal_cumulative_missing_whole_alias_frontier",
                ]),
                notes: expect.arrayContaining([
                    "terminal_cumulative_alias_replaces_whole=true",
                ]),
            },
        });
        expect(projected?.rankedYears.map(({ year }) => year)).toContain(2000);
        expect(projectEndpointMissingFromCumulativeWholeAlias(alias, [-7])).toBeNull();
        alias.evidence.notes = alias.evidence.notes.map((note) => (
            note === "whole_state_newest_lag=-1" ? "whole_state_newest_lag=-8" : note
        ));
        expect(projectEndpointMissingFromCumulativeWholeAlias(alias, [-8])).toBeNull();
    });

    it("uses a newer current-data fixed-side path before an older stale-reference mode", () => {
        const selected = pathEvent(-3, -3, 0, 1862);
        selected.evidence.notes.push(
            "bounded_path_reference_view=raw",
            "bounded_path_fixed_side_observed=true",
            "bounded_path_location_concentration=0.969291",
        );
        const currentFrontier = pathEvent(-2, -2, 0, 1873);
        currentFrontier.startYear = 1867;
        currentFrontier.endYear = 1879;
        currentFrontier.evidence = {
            ...currentFrontier.evidence,
            algorithmSources: ["bounded_complete_lag_path"],
            scoreMargin: 8.2,
            correlationGain: 0.65,
            samplePairs: 270,
            notes: [
                "bounded_path_reference_view=raw",
                "bounded_path_fixed_side_observed=true",
                "bounded_path_location_concentration=0.961710",
            ],
        };

        expect(selectStaleReferenceNewestFixedSidePathFrontier(
            true,
            4,
            selected,
            [currentFrontier],
            false,
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -2,
            startYear: 1867,
            endYear: 1879,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "stale_reference_newest_fixed_side_path_frontier",
                ]),
            },
        });
        expect(selectStaleReferenceNewestFixedSidePathFrontier(
            true,
            4,
            null,
            [currentFrontier],
            false,
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -2,
            startYear: 1867,
            endYear: 1879,
            evidence: {
                notes: expect.arrayContaining([
                    "stale_reference_deferred_selected_year=none",
                ]),
            },
        });
        expect(selectStaleReferenceNewestFixedSidePathFrontier(
            true,
            4,
            selected,
            [currentFrontier],
            true,
        )).toBeNull();
        expect(selectStaleReferenceNewestFixedSidePathFrontier(
            false,
            4,
            selected,
            [currentFrontier],
            false,
        )).toBeNull();

        const detached = {
            ...currentFrontier,
            startYear: 1939,
            endYear: 1951,
            rankedYears: [{
                ...currentFrontier.rankedYears[0]!,
                year: 1945,
            }],
        };
        expect(selectStaleReferenceNewestFixedSidePathFrontier(
            true,
            4,
            selected,
            [detached],
            false,
        )).toBeNull();
    });

    it("uses a displayed cumulative operation to authorize the newest path component", () => {
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-6, -26, -20, 1749),
                pathEvent(-20, -20, 0, 1779),
            ]),
            boundedPath([
                pathEvent(-6, -26, -20, 1750),
                pathEvent(-20, -20, 0, 1780),
            ]),
        );
        const aggregate = candidate("aggregate", -26, -26, 0, 1756);

        expect(recoverStableBoundedLagPathFrontier(
            selected,
            [aggregate],
            [],
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -20,
            startYear: 1774,
            endYear: 1786,
        });
    });

    it("preserves an exact aggregate partial when it decisively beats a detached component", () => {
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-19, -100, -81, 1900),
                pathEvent(-81, -81, 0, 1960),
            ]),
            boundedPath([
                pathEvent(-19, -100, -81, 1901),
                pathEvent(-81, -81, 0, 1961),
            ]),
        );
        const aggregate = candidate("aggregate", -100, -100, 0, 1950);
        const componentOperation = operation(-81, 1931);
        componentOperation.sideStepBestYear = 1821;
        componentOperation.bestDifferenceGain = 0.058;
        componentOperation.bestCombinedGain = 0.022;
        componentOperation.topThreeDifferenceGain = 0.057;
        const aggregateOperation = operation(-100, 1950);
        aggregateOperation.sideStepBestYear = 1949;
        aggregateOperation.bestDifferenceGain = 0.639;
        aggregateOperation.bestCombinedGain = 0.629;
        aggregateOperation.topThreeDifferenceGain = 0.639;

        const recovered = recoverStableBoundedLagPathFrontier(
            selected,
            [aggregate],
            [componentOperation, aggregateOperation],
            { startYear: 1800, endYear: 2024 },
        );

        expect(recovered).toMatchObject({
            eventType: "partialMove",
            shiftYears: -100,
            evidence: { lagBefore: -100, lagAfter: 0 },
        });
        expect(recovered?.rankedYears[0]?.year).toBe(1950);
        expect(recovered?.evidence.notes).toContain(
            "stable_bounded_path_preserved_dominant_aggregate=-100",
        );
    });

    it("keeps a stable distant component when aggregate evidence is not absolute", () => {
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-6, -26, -20, 1750),
                pathEvent(-20, -20, 0, 1780),
            ]),
            boundedPath([
                pathEvent(-6, -26, -20, 1751),
                pathEvent(-20, -20, 0, 1781),
            ]),
        );
        const aggregate = candidate("aggregate", -26, -26, 0, 1765);
        const componentOperation = operation(-20, 1780);
        const aggregateOperation = operation(-26, 1765);
        aggregateOperation.bestDifferenceGain = 0.42;
        aggregateOperation.bestCombinedGain = 0.4;
        aggregateOperation.topThreeDifferenceGain = 0.41;

        expect(recoverStableBoundedLagPathFrontier(
            selected,
            [aggregate],
            [componentOperation, aggregateOperation],
        )).toMatchObject({ eventType: "partialMove", shiftYears: -20 });
    });

    it("recovers a newer unit event that exactly bridges an aggregate partial state", () => {
        const aggregate = candidate("aggregate", -19, -19, 0, 1768);
        aggregate.evidence.algorithmSources = [
            "decisive_joint_operation_fusion",
            "joint_year_operation_evidence",
        ];
        aggregate.evidence.scoreMargin = 0.5;
        const unit = falseRingEvent(1796, true);
        unit.rankedYears = [{ year: 1799, score: 1, rank: 1, evidenceTags: [] }];
        unit.evidence.lagBefore = -19;
        unit.evidence.lagAfter = -20;
        unit.evidence.notes = ["candidate_hard_gate_passed"];
        const aggregateOperation = operation(-19, 1768);
        aggregateOperation.bestDifferenceGain = 0.64;
        aggregateOperation.bestCombinedGain = 0.59;
        const unitOperation: JointCounterfactualOperationScore = {
            ...operation(1, 1795),
            eventType: "falseRing",
            shiftYears: 1,
            bestDifferenceGain: 0.16,
            bestCombinedGain: 0.14,
            topThreeDifferenceGain: 0.15,
        };

        const recovered = recoverAggregatePartialUnitFrontier(
            [aggregate],
            [unit],
            {
                operation: unitOperation,
                score: 0.13,
                scoreMargin: 0.1,
                shiftScoreMargin: null,
                probabilityLike: 0.9,
            },
            [aggregateOperation, unitOperation],
            { startYear: 1500, endYear: 1950 },
        );

        expect(recovered).toMatchObject({
            eventType: "falseRing",
            startYear: 1791,
            endYear: 1799,
            evidence: { lagBefore: -19, lagAfter: -20 },
        });
        expect(recovered?.rankedYears[0]?.year).toBe(1795);
        expect(recovered?.evidence.notes).toContain(
            "aggregate_partial_residual_shift=-20",
        );

        unit.evidence.lagAfter = -18;
        expect(recoverAggregatePartialUnitFrontier(
            [aggregate],
            [unit],
            {
                operation: unitOperation,
                score: 0.13,
                scoreMargin: 0.1,
                shiftScoreMargin: null,
                probabilityLike: 0.9,
            },
            [aggregateOperation, unitOperation],
            { startYear: 1500, endYear: 1950 },
        )).toBeNull();
    });

    it("re-centers a detached unit window from decisive same-operation evidence", () => {
        const missing = pathEvent(-1, -1, 0, 1872);
        missing.eventType = "missingRing";
        missing.shiftYears = undefined;
        missing.shiftSide = undefined;
        missing.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1852,
            endYear: 1864,
            topYear: 1858,
            referenceCount: 38,
            concentration: 0.8,
            remoteMargin: 2.6,
            calibrated: false,
        }];
        const selectedOperation = operation(-1, 1857);
        selectedOperation.eventType = "missingRing";

        expect(projectUnitToDistantDynamicConsensus(
            missing,
            {
                operation: selectedOperation,
                score: 0.56,
                scoreMargin: 0.44,
                shiftScoreMargin: null,
                probabilityLike: 0.9,
            },
            { startYear: 1500, endYear: 2000 },
        )).toMatchObject({
            eventType: "missingRing",
            startYear: 1851,
            endYear: 1863,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "distant_dynamic_unit_consensus",
                ]),
            },
        });
    });

    it("does not move a unit window to an uncorroborated distant dynamic mode", () => {
        const missing = pathEvent(-1, -1, 0, 1872);
        missing.eventType = "missingRing";
        missing.shiftYears = undefined;
        missing.shiftSide = undefined;
        missing.evidence.locationEvidence = [{
            source: "bounded_complete_lag_path",
            startYear: 1866,
            endYear: 1878,
            topYear: 1872,
            referenceCount: 24,
            concentration: 0.9,
            remoteMargin: 1,
            calibrated: false,
        }];
        const selectedOperation = operation(-1, 1750);
        selectedOperation.eventType = "missingRing";

        expect(projectUnitToDistantDynamicConsensus(
            missing,
            {
                operation: selectedOperation,
                score: 0.8,
                scoreMargin: 0.6,
                shiftScoreMargin: null,
                probabilityLike: 0.95,
            },
            { startYear: 1500, endYear: 2000 },
            [],
        )).toBe(missing);
    });

    it("accepts a distant dynamic mode anchored by an executable candidate year", () => {
        const missing = pathEvent(-1, -1, 0, 1872);
        missing.eventType = "missingRing";
        missing.shiftYears = undefined;
        missing.shiftSide = undefined;
        missing.evidence.candidateIds = [
            "TARGET:insertMissingYear::1857:1857:1600:1857::right",
        ];
        const selectedOperation = operation(-1, 1857);
        selectedOperation.eventType = "missingRing";

        expect(projectUnitToDistantDynamicConsensus(
            missing,
            {
                operation: selectedOperation,
                score: 0.56,
                scoreMargin: 0.44,
                shiftScoreMargin: null,
                probabilityLike: 0.9,
            },
            { startYear: 1500, endYear: 2000 },
        )).toMatchObject({
            startYear: 1851,
            endYear: 1863,
        });
    });

    it("accepts corroboration from a separate bounded event table", () => {
        const missing = pathEvent(-1, -1, 0, 1872);
        missing.eventType = "missingRing";
        missing.shiftYears = undefined;
        missing.shiftSide = undefined;
        missing.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        const bounded = pathEvent(-1, -1, 0, 1858);
        bounded.eventType = "missingRing";
        bounded.shiftYears = undefined;
        bounded.shiftSide = undefined;
        bounded.evidence.algorithmSources = ["bounded_complete_lag_path"];
        bounded.evidence.scoreMargin = 0.5;
        bounded.evidence.notes = ["bounded_path_location_concentration=0.8"];
        const selectedOperation = operation(-1, 1857);
        selectedOperation.eventType = "missingRing";

        expect(projectUnitToDistantDynamicConsensus(
            missing,
            {
                operation: selectedOperation,
                score: 0.56,
                scoreMargin: 0.44,
                shiftScoreMargin: null,
                probabilityLike: 0.9,
            },
            { startYear: 1500, endYear: 2000 },
            [bounded],
        )).toMatchObject({
            startYear: 1851,
            endYear: 1863,
        });
    });

    it("does not let an ordinary unit event borrow external corroboration", () => {
        const missing = pathEvent(-1, -1, 0, 1872);
        missing.eventType = "missingRing";
        missing.shiftYears = undefined;
        missing.shiftSide = undefined;
        missing.evidence.algorithmSources = ["segmented_diagnosis"];
        const bounded = pathEvent(-1, -1, 0, 1858);
        bounded.eventType = "missingRing";
        bounded.shiftYears = undefined;
        bounded.shiftSide = undefined;
        bounded.evidence.algorithmSources = ["bounded_complete_lag_path"];
        bounded.evidence.scoreMargin = 0.5;
        bounded.evidence.notes = ["bounded_path_location_concentration=0.8"];
        const selectedOperation = operation(-1, 1857);
        selectedOperation.eventType = "missingRing";

        expect(projectUnitToDistantDynamicConsensus(
            missing,
            {
                operation: selectedOperation,
                score: 0.56,
                scoreMargin: 0.44,
                shiftScoreMargin: null,
                probabilityLike: 0.9,
            },
            { startYear: 1500, endYear: 2000 },
            [bounded],
        )).toBe(missing);
    });

    it("uses a decisive same-operation unit scan as the final location", () => {
        const missing = pathEvent(-1, -1, 0, 1887);
        missing.eventType = "missingRing";
        missing.shiftYears = undefined;
        missing.shiftSide = undefined;
        const selectedOperation = operation(-1, 1883);
        selectedOperation.eventType = "missingRing";

        const projected = projectUnitToStrongDynamicLocation(
            missing,
            {
                operation: selectedOperation,
                score: 0.8,
                scoreMargin: 0.43,
                shiftScoreMargin: null,
                probabilityLike: 0.9,
            },
            { startYear: 1500, endYear: 2000 },
        );
        expect(projected).toMatchObject({
            eventType: "missingRing",
            startYear: 1877,
            endYear: 1889,
        });
        expect(projected.rankedYears[0]).toMatchObject({ year: 1883, rank: 1 });
        expect(projected.rankedYears).toHaveLength(13);
    });

    it("does not use a weak or opposite-operation dynamic location", () => {
        const missing = pathEvent(-1, -1, 0, 1887);
        missing.eventType = "missingRing";
        missing.shiftYears = undefined;
        missing.shiftSide = undefined;
        const selectedOperation = operation(-1, 1883);
        selectedOperation.eventType = "missingRing";
        const weak = {
            operation: selectedOperation,
            score: 0.24,
            scoreMargin: 0.2,
            shiftScoreMargin: null,
            probabilityLike: 0.8,
        };

        expect(projectUnitToStrongDynamicLocation(
            missing,
            weak,
            { startYear: 1500, endYear: 2000 },
        )).toBe(missing);
        weak.score = 0.3;
        weak.operation.eventType = "falseRing";
        expect(projectUnitToStrongDynamicLocation(
            missing,
            weak,
            { startYear: 1500, endYear: 2000 },
        )).toBe(missing);
    });

    it("decomposes a non-authoritative whole alias into stable partial components", () => {
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-20, -26, -6, 1346),
                pathEvent(-6, -6, 0, 1376),
            ]),
            boundedPath([
                pathEvent(-20, -26, -6, 1347),
                pathEvent(-6, -6, 0, 1377),
            ]),
        );
        const wholeAlias = candidate("whole-alias", -26, -26, -26, 1500);
        wholeAlias.eventType = "wholeSeriesMove";
        wholeAlias.rankedYears = [];

        expect(recoverStableBoundedLagPathFrontier(
            selected,
            [wholeAlias],
            [],
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -6,
        });
    });

    it("does not decompose a whole baseline through a mixed unit and partial path", () => {
        const unit = pathEvent(1, -3, -4, 1361);
        unit.eventType = "falseRing";
        unit.shiftYears = undefined;
        unit.shiftSide = undefined;
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([unit, pathEvent(-4, -4, 0, 1499)]),
            boundedPath([{ ...unit, rankedYears: [{
                ...unit.rankedYears[0]!,
                year: 1362,
            }] }, pathEvent(-4, -4, 0, 1500)]),
        );
        const whole = candidate("whole", -3, -3, -3, 1500);
        whole.eventType = "wholeSeriesMove";
        whole.rankedYears = [];

        expect(selected?.allTransitionsPartial).toBe(false);
        expect(recoverStableBoundedLagPathFrontier(selected, [whole], [])).toBeNull();
    });

    it("matches a displayed operation against a stable newest path suffix", () => {
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-78, -99, -21, 1786),
                {
                    ...pathEvent(-1, -21, -20, 1873),
                    eventType: "missingRing",
                    shiftYears: undefined,
                    shiftSide: undefined,
                },
                pathEvent(-20, -20, 0, 1901),
            ]),
            boundedPath([
                pathEvent(-78, -99, -21, 1787),
                {
                    ...pathEvent(-1, -21, -20, 1874),
                    eventType: "missingRing",
                    shiftYears: undefined,
                    shiftSide: undefined,
                },
                pathEvent(-20, -20, 0, 1902),
            ]),
        );
        const aggregate = candidate("aggregate", -21, -21, 0, 1898);

        expect(selected?.suffixAggregateShiftYears).toEqual([-20, -21, -99]);
        expect(recoverStableBoundedLagPathFrontier(
            selected,
            [aggregate],
            [],
        )).toMatchObject({ eventType: "partialMove", shiftYears: -20 });
    });

    it("centers a stable partial window over agreeing path and operation locations", () => {
        const selected = selectStableBoundedLagPathFrontier(
            boundedPath([
                pathEvent(-20, -26, -6, 1800),
                pathEvent(-6, -6, 0, 1840),
            ]),
            boundedPath([
                pathEvent(-20, -26, -6, 1801),
                pathEvent(-6, -6, 0, 1841),
            ]),
        );

        const recovered = recoverStableBoundedLagPathFrontier(
            selected,
            [],
            [operation(-6, 1832)],
            { startYear: 1700, endYear: 2000 },
        );

        expect(recovered).toMatchObject({
            startYear: 1830,
            endYear: 1842,
        });
        expect(recovered?.rankedYears[0]).toMatchObject({ year: 1832, rank: 1 });
    });

    it("returns the newer component of two independently separated partial steps", () => {
        const aggregate = candidate("aggregate", -26, -26, 0, 1772);
        const selected = selectCumulativePartialFrontier(
            aggregate,
            [
                candidate("newer", -6, -26, -20, 1800),
                candidate("older", -26, -26, -6, 1740),
            ],
            [operation(-6, 1777), operation(-20, 1755)],
        );

        expect(selected).toMatchObject({ shiftYears: -6 });
        expect(selected?.operation.bestYear).toBe(1777);
    });

    it("does not split two operation modes that are not spatially distinct", () => {
        const aggregate = candidate("aggregate", -26, -26, 0, 1772);
        expect(selectCumulativePartialFrontier(
            aggregate,
            [
                candidate("newer", -6, -26, -20, 1777),
                candidate("older", -26, -26, -6, 1770),
            ],
            [operation(-6, 1777), operation(-20, 1770)],
        )).toBeNull();
    });

    it("selects the newest operation from an exact two-step raw lag chain", () => {
        const aggregate = candidate("aggregate", -26, -26, 0, 1772);
        const selected = selectCumulativeLagPathFrontier(aggregate, [
            pathEvent(-6, -6, 0, 1818),
            pathEvent(-20, -26, -6, 1786),
        ]);

        expect(selected).toMatchObject({
            eventType: "partialMove",
            shiftYears: -6,
        });
        expect(selected?.rankedYears[0]?.year).toBe(1818);
    });

    it("accepts a moderately scored component when a distant raw chain closes exactly", () => {
        const aggregate = candidate("aggregate", -26, -26, 0, 1665);
        const older = pathEvent(-6, -26, -20, 1652);
        older.evidence.score = 4.046;
        const newer = pathEvent(-20, -20, 0, 1683);
        newer.evidence.score = 7.488;

        expect(selectCumulativeLagPathFrontier(
            aggregate,
            [older, newer],
            14,
            4,
        )).toMatchObject({
            eventType: "partialMove",
            shiftYears: -20,
        });
        expect(selectCumulativeLagPathFrontier(
            aggregate,
            [older, newer],
            14,
            4.1,
        )).toBeNull();
    });

    it("selects the newest operation from an exact four-step raw lag chain", () => {
        const aggregate = candidate("aggregate", -29, -29, 0, 1700);
        aggregate.evidence.notes.push("completed_mixed_cumulative_shift=-28");
        const selected = selectCumulativeLagPathFrontier(aggregate, [
            pathEvent(-20, -28, -8, 1700),
            pathEvent(-6, -8, -2, 1730),
            {
                ...falseRingEvent(1760, true),
                rankedYears: [{
                    year: 1760,
                    score: 7,
                    rank: 1,
                    evidenceTags: ["piecewise_lag_path"],
                }],
                evidence: {
                    ...falseRingEvent(1760, true).evidence,
                    algorithmSources: ["piecewise_lag_path"],
                    score: 7,
                    lagBefore: -2,
                    lagAfter: -3,
                },
            },
            pathEvent(-3, -3, 0, 1790),
        ]);

        expect(selected).toMatchObject({
            eventType: "partialMove",
            shiftYears: -3,
        });
        expect(selected?.rankedYears[0]?.year).toBe(1790);
        expect(selected?.evidence.notes).toContain(
            "exact_cumulative_path_transition_count=4",
        );
    });

    it("rejects a multi-step raw lag chain with a close or discontinuous transition", () => {
        const aggregate = candidate("aggregate", -27, -27, 0, 1700);
        expect(selectCumulativeLagPathFrontier(aggregate, [
            pathEvent(-20, -27, -7, 1700),
            pathEvent(-6, -7, -1, 1708),
            pathEvent(-1, -1, 0, 1740),
        ])).toBeNull();
        expect(selectCumulativeLagPathFrontier(aggregate, [
            pathEvent(-20, -27, -7, 1700),
            pathEvent(-6, -6, 0, 1730),
        ])).toBeNull();
    });

    it("selects a newer false ring instead of the aggregate negative partial shift", () => {
        const aggregate = candidate("aggregate", -19, -19, 0, 1772);
        const newerFalse = falseRingEvent(1771, true);
        const selected = selectCumulativeLagPathFrontier(aggregate, [
            pathEvent(-20, -19, 1, 1739),
            {
                ...newerFalse,
                rankedYears: [{
                    year: 1771,
                    score: 6.17,
                    rank: 1,
                    evidenceTags: ["piecewise_lag_path"],
                }],
                evidence: {
                    ...newerFalse.evidence,
                    algorithmSources: ["piecewise_lag_path"],
                    score: 6.17,
                    lagBefore: 1,
                    lagAfter: 0,
                },
            },
        ]);

        expect(selected).toMatchObject({ eventType: "falseRing" });
        expect(selected?.rankedYears[0]?.year).toBe(1771);
    });

    it("rejects a raw lag path that does not exactly explain the aggregate", () => {
        const aggregate = candidate("aggregate", -26, -26, 0, 1772);
        expect(selectCumulativeLagPathFrontier(aggregate, [
            pathEvent(-3, -26, -23, 1786),
            pathEvent(-20, -23, -3, 1818),
        ])).toBeNull();
    });

    it("selects the newest local event relative to a non-zero whole-series baseline", () => {
        const whole = { ...wholeSeriesEvent(4), shiftYears: 4 };
        const missing = falseRingEvent(1788, true);
        const selected = selectWholeBaselineLagPathFrontier(whole, [{
            ...missing,
            eventType: "missingRing",
            rankedYears: [{
                year: 1788,
                score: 7.48,
                rank: 1,
                evidenceTags: ["piecewise_lag_path"],
            }],
            evidence: {
                ...missing.evidence,
                score: 7.48,
                lagBefore: -3,
                lagAfter: -2,
            },
        },
            pathEvent(-6, -2, 4, 1819, 9.84),
        ]);

        expect(selected).toMatchObject({
            aggregateShiftYears: -7,
            event: {
                eventType: "partialMove",
                shiftYears: -6,
            },
        });
        expect(selected?.event.rankedYears[0]?.year).toBe(1819);
    });

    it("recovers one local unit event on top of a whole-series baseline", () => {
        const whole = { ...wholeSeriesEvent(4), shiftYears: 4 };
        const missing = falseRingEvent(1819, true);
        const selected = selectWholeBaselineLagPathFrontier(whole, [{
            ...missing,
            eventType: "missingRing",
            rankedYears: [{
                year: 1819,
                score: 8,
                rank: 1,
                evidenceTags: ["piecewise_lag_path"],
            }],
            evidence: {
                ...missing.evidence,
                algorithmSources: ["piecewise_lag_path"],
                score: 8,
                lagBefore: 3,
                lagAfter: 4,
            },
        }]);

        expect(selected).toMatchObject({
            aggregateShiftYears: -1,
            event: { eventType: "missingRing" },
        });
    });

    it("uses matching local operation evidence to refine a bounded component window", () => {
        const bounded = pathEvent(-6, -6, 0, 1701, 12);
        bounded.startYear = 1695;
        bounded.endYear = 1707;
        bounded.evidence.algorithmSources = ["bounded_complete_lag_path"];
        const matchingOperation = operation(-6, 1709);
        matchingOperation.eventType = "partialMove";
        matchingOperation.baselineLag = 0;
        matchingOperation.bestRawGain = 0.05;
        matchingOperation.bestDifferenceGain = 0.01;
        matchingOperation.remoteDifferenceMargin = 0.02;

        const refined = refineBoundedPathLocationWithOperation(
            bounded,
            [matchingOperation],
            { startYear: 1500, endYear: 1972 },
        );

        expect(refined).toMatchObject({ startYear: 1703, endYear: 1715 });
        expect(refined.rankedYears[0]).toMatchObject({ year: 1709, rank: 1 });
    });

    it("does not move a bounded window to a remote or mismatched-baseline operation peak", () => {
        const bounded = pathEvent(-6, -6, 0, 1701, 12);
        bounded.startYear = 1695;
        bounded.endYear = 1707;
        bounded.evidence.algorithmSources = ["bounded_complete_lag_path"];
        const remote = operation(-6, 1740);
        remote.eventType = "partialMove";
        remote.bestRawGain = 0.1;
        remote.remoteDifferenceMargin = 0.1;
        const wrongBaseline = { ...remote, bestYear: 1709, baselineLag: -6 };

        expect(refineBoundedPathLocationWithOperation(
            bounded,
            [remote],
            { startYear: 1500, endYear: 1972 },
        )).toBe(bounded);
        expect(refineBoundedPathLocationWithOperation(
            bounded,
            [wrongBaseline],
            { startYear: 1500, endYear: 1972 },
        )).toBe(bounded);
    });

    it("does not let a unit-operation plateau move an exact bounded transition by more than three years", () => {
        const bounded = pathEvent(-1, -1, 0, 1759, 12);
        bounded.eventType = "missingRing";
        bounded.startYear = 1753;
        bounded.endYear = 1765;
        bounded.evidence.algorithmSources = ["bounded_complete_lag_path"];
        const operationPeak = operation(-1, 1765);
        operationPeak.eventType = "missingRing";
        operationPeak.baselineLag = 0;
        operationPeak.bestRawGain = 0.1;
        operationPeak.remoteDifferenceMargin = 0.02;

        expect(refineBoundedPathLocationWithOperation(
            bounded,
            [operationPeak],
            { startYear: 1500, endYear: 1972 },
        )).toBe(bounded);
    });
});

describe("hasCompressedSequentialFalseDirection", () => {
    it("accepts a +1 unit frontier paired with a +2 range candidate", () => {
        expect(hasCompressedSequentialFalseDirection(
            [falseRingEvent(1900, false)],
            [{
                targetTree: "TEST",
                operationType: "SHIFT_RANGE",
                deltaYears: 2,
                suggestedLag: 2,
            }],
            "TEST",
        )).toBe(true);
    });

    it("rejects the same range candidate without a positive false frontier", () => {
        const negative = falseRingEvent(1900, false);
        negative.evidence.lagBefore = -3;
        negative.evidence.lagAfter = -2;
        expect(hasCompressedSequentialFalseDirection(
            [negative],
            [{
                targetTree: "TEST",
                operationType: "SHIFT_RANGE",
                deltaYears: 2,
                suggestedLag: 2,
            }],
            "TEST",
        )).toBe(false);
    });
});

describe("hasDistinctConfirmedSequentialMissingMode", () => {
    const weakHead = {
        year: 1863,
        transitionCount: 4,
        headRunYears: 19,
    };

    it("recovers a confirmed unit frontier distinct from the selected partial mode", () => {
        const selectedPartial = candidatePartial({
            shiftYears: -4,
            anchorYear: 1851,
            candidateId: "selected-partial",
            source: "cofecha_segment_lag",
        });
        const headCandidate = candidatePartial({
            shiftYears: -4,
            anchorYear: 1863,
            candidateId: "head-candidate",
            source: "segmented_diagnosis",
        });

        expect(hasDistinctConfirmedSequentialMissingMode(
            [selectedPartial],
            [headCandidate],
            weakHead,
            [1885, 1904, 1922],
        )).toBe(true);
    });

    it("does not use history to split one local partial-move mode", () => {
        const selectedPartial = candidatePartial({
            shiftYears: -4,
            anchorYear: 1855,
            candidateId: "selected-partial",
            source: "cofecha_segment_lag",
        });
        const headCandidate = candidatePartial({
            shiftYears: -4,
            anchorYear: 1863,
            candidateId: "head-candidate",
            source: "segmented_diagnosis",
        });

        expect(hasDistinctConfirmedSequentialMissingMode(
            [selectedPartial],
            [headCandidate],
            weakHead,
            [1885, 1904, 1922],
        )).toBe(false);
    });

    it("requires both prior confirmations and a depth-consistent head candidate", () => {
        const selectedPartial = candidatePartial({
            shiftYears: -4,
            anchorYear: 1851,
            candidateId: "selected-partial",
            source: "cofecha_segment_lag",
        });
        const wrongDepthCandidate = candidatePartial({
            shiftYears: -10,
            anchorYear: 1863,
            candidateId: "wrong-depth",
            source: "segmented_diagnosis",
        });
        const headCandidate = candidatePartial({
            shiftYears: -4,
            anchorYear: 1863,
            candidateId: "head-candidate",
            source: "segmented_diagnosis",
        });

        expect(hasDistinctConfirmedSequentialMissingMode(
            [selectedPartial],
            [wrongDepthCandidate],
            weakHead,
            [1885, 1904, 1922],
        )).toBe(false);
        expect(hasDistinctConfirmedSequentialMissingMode(
            [selectedPartial],
            [headCandidate],
            weakHead,
            [],
        )).toBe(false);
    });

    it("accepts a depth-consistent cumulative candidate within the calibrated 13-year mode", () => {
        const selectedPartial = candidatePartial({
            shiftYears: -6,
            anchorYear: 1724,
            candidateId: "selected-partial",
            source: "cofecha_segment_lag",
        });
        const cumulativeCandidate = candidatePartial({
            shiftYears: -6,
            anchorYear: 1725,
            candidateId: "cumulative-candidate",
            source: "segmented_diagnosis",
        });

        expect(hasDistinctConfirmedSequentialMissingMode(
            [selectedPartial],
            [cumulativeCandidate],
            { year: 1738, transitionCount: 9, headRunYears: 4 },
            [1748, 1767],
        )).toBe(true);
    });
});

describe("resolveSequentialMissingPresentation", () => {
    const head = (overrides: Partial<Parameters<
        typeof resolveSequentialMissingPresentation
    >[0]> = {}) => ({
        year: 1681,
        score: 10,
        directScore: 0,
        gainOverDirect: 10,
        transitionCount: 9,
        headRunYears: 12,
        headMeanAdvantage: 0.15,
        fixedTailMeanAdvantage: 0.3,
        pathStartLag: -9,
        unitEventYears: [1669, 1681],
        ...overrides,
    });

    it("centers a calibrated window across the fitted final unit-lag run", () => {
        expect(resolveSequentialMissingPresentation(
            head(),
            null,
            "local2",
        )).toMatchObject({
            selectedYear: 1681,
            windowCenterYear: 1676,
            width: 13,
        });
        expect(resolveSequentialMissingPresentation(
            head({
                year: 1739,
                transitionCount: 5,
                headRunYears: 9,
                headMeanAdvantage: 0.52,
                pathStartLag: -5,
                unitEventYears: [1730, 1739],
            }),
            null,
            "local2",
        )).toMatchObject({
            windowCenterYear: 1735,
            width: 9,
        });
    });

    it("keeps a nearby depth candidate as the center of a distinct cumulative mode", () => {
        expect(resolveSequentialMissingPresentation(
            head({
                year: 1738,
                transitionCount: 9,
                headRunYears: 4,
                headMeanAdvantage: 0.04,
                fixedTailMeanAdvantage: 0.41,
                unitEventYears: [1734, 1738],
            }),
            null,
            "local2",
            [1725],
            [1748, 1767],
        )).toMatchObject({
            selectedYear: 1732,
            windowCenterYear: 1732,
            width: 13,
        });
    });

    it("uses the difficult 13-year window for a deep unanchored staircase", () => {
        expect(resolveSequentialMissingPresentation(
            head({
                year: 1636,
                transitionCount: 4,
                headRunYears: 9,
                headMeanAdvantage: 0.36,
                fixedTailMeanAdvantage: 0.28,
                pathStartLag: -4,
                unitEventYears: [1574, 1583, 1627, 1636],
            }),
            null,
            "local2",
        )).toMatchObject({
            selectedYear: 1636,
            windowCenterYear: 1632,
            width: 13,
        });
    });

    it("does not let an unsupported newer raw partial peak recenter the lag head", () => {
        expect(rawCandidateMayRecenterSequentialMissing(1784, 1792)).toBe(false);
        expect(rawCandidateMayRecenterSequentialMissing(1784, 1786)).toBe(true);
        expect(rawCandidateMayRecenterSequentialMissing(1784, 1771)).toBe(true);
    });
});

describe("partialMoveSupportsSequentialMissingDepth", () => {
    it("requires a compressed partial gap to match the staircase depth", () => {
        const partial = partialMoveEvent(-5);

        expect(partialMoveSupportsSequentialMissingDepth(
            partial,
            { transitionCount: 5, headRunYears: 1 },
        )).toBe(true);
        expect(partialMoveSupportsSequentialMissingDepth(
            partial,
            { transitionCount: 6, headRunYears: 1 },
        )).toBe(true);
        expect(partialMoveSupportsSequentialMissingDepth(
            partialMoveEvent(-3),
            { transitionCount: 7, headRunYears: 3 },
        )).toBe(true);
        expect(partialMoveSupportsSequentialMissingDepth(
            partialMoveEvent(-3),
            { transitionCount: 7, headRunYears: 1 },
        )).toBe(false);
        expect(partialMoveSupportsSequentialMissingDepth(
            partial,
            { transitionCount: 12, headRunYears: 1 },
        )).toBe(false);
        expect(partialMoveSupportsSequentialMissingDepth(
            partial,
            { transitionCount: 24, headRunYears: 10 },
        )).toBe(false);
    });
});

describe("terminal whole baseline ordering", () => {
    it("retains a negative-score COFECHA baseline with coherent terminal support", () => {
        const whole = terminalWholeSeriesEvent(-4);
        whole.evidence.score = -13.65;
        whole.evidence.notes.push(
            "whole_baseline_source=cofecha_terminal_lag",
            "candidate_hard_gate_passed",
            "cofecha_terminal_segments=2",
            "cofecha_terminal_consistency=1.000000",
            "cofecha_terminal_matching_pattern_support=14.394954",
            "cofecha_terminal_opposing_pattern_support=0.000000",
            "whole_state_support_fraction=0.315789",
            "whole_state_newest_lag=-4",
            "whole_state_newer_edge_support_fraction=1.000000",
        );

        expect(isTerminalWholeBaselineEvent(whole)).toBe(true);
    });

    it("does not grant terminal authority to a negative-score whole alias", () => {
        const whole = terminalWholeSeriesEvent(-6);
        whole.evidence.score = -38.28;
        whole.evidence.notes.push(
            "whole_state_global_lag_matches_shift=false",
            "whole_state_newer_edge_support_fraction=0.000000",
        );

        expect(isTerminalWholeBaselineEvent(whole)).toBe(false);
        expect(pruneWholeSeriesPartialAliases([
            whole,
            partialMoveEvent(-6),
        ])).toMatchObject([{
            eventType: "partialMove",
            shiftYears: -6,
        }]);
    });

    it("does not collapse an independently verified whole baseline into a unit chain", () => {
        const whole = terminalWholeSeriesEvent(-1);
        const missing = falseRingEvent(1995, true);
        missing.eventType = "missingRing";
        missing.evidence.lagBefore = -1;
        missing.evidence.lagAfter = 0;
        const partial = partialMoveEvent(-2);

        expect(projectSequentialUnitChainHead([whole, missing, partial]))
            .toEqual([whole, missing, partial]);
    });

    it("keeps the terminal whole operation before a same-direction endpoint unit", () => {
        const whole = terminalWholeSeriesEvent(-1);
        const missing = falseRingEvent(1995, true);
        missing.eventType = "missingRing";
        missing.evidence.algorithmSources = ["series_endpoint_review_window"];
        missing.evidence.lagBefore = -1;
        missing.evidence.lagAfter = 0;

        expect(prioritizeEndpointUnitAgainstWhole([whole, missing]))
            .toEqual([whole, missing]);
    });

    it("retains endpoint-unit precedence for an unverified global-lag alias", () => {
        const whole = wholeSeriesEvent(-1);
        const missing = falseRingEvent(1995, true);
        missing.eventType = "missingRing";
        missing.evidence.algorithmSources = ["series_endpoint_review_window"];
        missing.evidence.lagBefore = -1;
        missing.evidence.lagAfter = 0;

        const prioritized = prioritizeEndpointUnitAgainstWhole([whole, missing]);
        expect(prioritized[0].id).toBe(missing.id);
        expect(prioritized[0].evidence.algorithmSources)
            .toContain("newer_endpoint_unit_preferred_over_global_lag");
    });
});

describe("pruneLocalEventsDisconnectedFromWholeBaseline", () => {
    it("removes a local fragment that cannot join the global lag state", () => {
        const whole = wholeSeriesEvent(-9);
        const disconnected = partialMoveEvent(-3, 3);

        expect(pruneLocalEventsDisconnectedFromWholeBaseline([
            whole,
            disconnected,
        ])).toMatchObject([{
            eventType: "wholeSeriesMove",
            evidence: {
                notes: expect.arrayContaining([
                    "disconnected_local_supplements_removed=1",
                ]),
            },
        }]);
    });

    it("keeps a local transition connected to a non-zero whole baseline", () => {
        const whole = wholeSeriesEvent(-9);
        const partial = partialMoveEvent(-4, -9);

        expect(pruneLocalEventsDisconnectedFromWholeBaseline([whole, partial]))
            .toEqual([whole, partial]);
    });
});

describe("pruneUnsupportedFalseRingPathSupplements", () => {
    it("removes a remote path-only duplicate when one event has edit support", () => {
        const supported = falseRingEvent(1900, true);
        const remotePathOnly = falseRingEvent(1700, false);

        expect(pruneUnsupportedFalseRingPathSupplements(
            [supported, remotePathOnly],
            true,
        )).toEqual([supported]);
    });

    it("preserves a multi-event path when no candidate operation can arbitrate", () => {
        const first = falseRingEvent(1700, false);
        const second = falseRingEvent(1900, false);

        expect(pruneUnsupportedFalseRingPathSupplements(
            [first, second],
            false,
        )).toEqual([first, second]);
    });
});

describe("shouldSuppressSelfWorseningCandidateFalseRing", () => {
    it("rejects a candidate-only deletion that worsens the negative lag", () => {
        const event = falseRingEvent(1858, true);
        event.evidence.correlationGain = -0.007;
        event.evidence.lagBefore = -2;
        event.evidence.lagAfter = -3;

        expect(shouldSuppressSelfWorseningCandidateFalseRing(event, false))
            .toBe(true);
    });

    it("keeps the same counterfactual when an independent false-ring path exists", () => {
        const event = falseRingEvent(1858, true);
        event.evidence.correlationGain = -0.007;
        event.evidence.lagBefore = -2;
        event.evidence.lagAfter = -3;

        expect(shouldSuppressSelfWorseningCandidateFalseRing(event, true))
            .toBe(false);
    });

    it("keeps a candidate that improves correlation or does not deepen negative lag", () => {
        const improving = falseRingEvent(1858, true);
        improving.evidence.correlationGain = 0.001;
        improving.evidence.lagBefore = -2;
        improving.evidence.lagAfter = -3;
        const stableDirection = falseRingEvent(1858, true);
        stableDirection.evidence.correlationGain = -0.001;
        stableDirection.evidence.lagBefore = 1;
        stableDirection.evidence.lagAfter = 0;

        expect(shouldSuppressSelfWorseningCandidateFalseRing(improving, false))
            .toBe(false);
        expect(shouldSuppressSelfWorseningCandidateFalseRing(stableDirection, false))
            .toBe(false);
    });
});

describe("wholeSeriesEventIsLocalUnitAlias", () => {
    it("rejects a global lag that the local unit transition returns to zero", () => {
        expect(wholeSeriesEventIsLocalUnitAlias(
            wholeSeriesEvent(1),
            [falseRingEvent(2014, true)],
        )).toBe(true);
    });

    it("keeps a true non-zero whole-series baseline under a local unit event", () => {
        const localOnWholeBaseline = falseRingEvent(2014, true);
        localOnWholeBaseline.evidence.lagBefore = 2;
        localOnWholeBaseline.evidence.lagAfter = 1;

        expect(wholeSeriesEventIsLocalUnitAlias(
            wholeSeriesEvent(1),
            [localOnWholeBaseline],
        )).toBe(false);
    });

    it("uses the executable whole shift instead of a locally biased dominant lag", () => {
        const whole = wholeSeriesEvent(-4);
        whole.shiftYears = -5;
        const localOnWholeBaseline = falseRingEvent(2014, true);
        localOnWholeBaseline.evidence.lagBefore = -4;
        localOnWholeBaseline.evidence.lagAfter = -5;

        expect(wholeSeriesEventIsLocalUnitAlias(
            whole,
            [localOnWholeBaseline],
        )).toBe(false);
        expect(pruneLocalEventsDisconnectedFromWholeBaseline([
            whole,
            localOnWholeBaseline,
        ])).toEqual([whole, localOnWholeBaseline]);
    });

    it("recognizes matching bounded-search metadata as one counterfactual explanation", () => {
        const whole = wholeSeriesEvent(-1);
        whole.evidence.lagAfter = -98;
        whole.evidence.score = 24.7;
        const local = falseRingEvent(2014, true);
        local.eventType = "missingRing";
        local.evidence.lagBefore = -1;
        local.evidence.lagAfter = -98;
        local.evidence.score = 24.3;

        expect(unitEventExplainsWholeSeriesCandidate(whole, local)).toBe(true);
    });

    it("prefers a competitive unit correction when only lag-after metadata differs", () => {
        const whole = wholeSeriesEvent(-1);
        whole.evidence.score = 26.6;
        const local = falseRingEvent(2014, true);
        local.eventType = "missingRing";
        local.evidence.lagBefore = -1;
        local.evidence.lagAfter = -1;
        local.evidence.score = 26;

        expect(unitEventExplainsWholeSeriesCandidate(whole, local)).toBe(true);
    });

    it("does not replace a materially stronger whole-series explanation", () => {
        const whole = wholeSeriesEvent(-1);
        whole.evidence.lagAfter = -98;
        whole.evidence.score = 24;
        const weakLocal = falseRingEvent(2014, true);
        weakLocal.eventType = "missingRing";
        weakLocal.evidence.lagBefore = -1;
        weakLocal.evidence.lagAfter = -98;
        weakLocal.evidence.score = 18;

        expect(unitEventExplainsWholeSeriesCandidate(whole, weakLocal)).toBe(false);
    });

    it("sends only a score-competitive matching unit event to endpoint arbitration", () => {
        const whole = wholeSeriesEvent(1);
        whole.evidence.score = 24;
        const competitive = falseRingEvent(1980, true);
        competitive.evidence.score = 18;
        competitive.evidence.lagAfter = 1;
        expect(unitEventCompetesWithWholeAtNewerEndpoint(
            whole,
            competitive,
        )).toBe(true);

        competitive.evidence.score = 17.9;
        expect(unitEventCompetesWithWholeAtNewerEndpoint(
            whole,
            competitive,
        )).toBe(false);
        competitive.evidence.score = 23;
        competitive.eventType = "missingRing";
        expect(unitEventCompetesWithWholeAtNewerEndpoint(
            whole,
            competitive,
        )).toBe(false);
    });
});

describe("projectSequentialUnitChainHead", () => {
    const partialEvent = (withStaircaseEvidence: boolean): DiagnosisEvent => ({
        ...falseRingEvent(1775, true),
        id: "partial-1775",
        eventType: "partialMove",
        endYear: 1783,
        rankedYears: [{
            year: 1779,
            rank: 1,
            score: 2,
            evidenceTags: ["negative_partial_multiview_consensus"],
        }],
        shiftYears: -2,
        shiftSide: "older",
        evidence: {
            ...falseRingEvent(1775, true).evidence,
            lagBefore: -2,
            lagAfter: 0,
            algorithmSources: withStaircaseEvidence
                ? ["piecewise_lag_path", "compressed_missing_staircase_evidence"]
                : ["piecewise_lag_path"],
        },
    });

    it("projects a supported compressed -2 jump to the newest missing ring", () => {
        const [projected] = projectSequentialUnitChainHead([
            partialEvent(true),
        ]);

        expect(projected.eventType).toBe("missingRing");
        expect(projected.rankedYears[0]?.year).toBe(1778);
        expect(projected.evidence.lagBefore).toBe(-1);
        expect(projected.evidence.lagAfter).toBe(0);
        expect(projected.shiftYears).toBeUndefined();
    });

    it("keeps an explicit staircase frontier ahead of the shifted aggregate top", () => {
        const partial = partialEvent(true);
        partial.seriesRange = { startYear: 1700, endYear: 1900 };
        partial.evidence.algorithmSources.push("explicit_partial_vs_missing_staircase");
        partial.evidence.notes.push("explicit_staircase_missing_years=1774,1782");

        const [projected] = projectSequentialUnitChainHead([partial]);

        expect(projected.rankedYears[0]?.year).toBe(1782);
        expect(1782 - projected.startYear).toBe(projected.endYear - 1782);
        expect(projected.endYear - projected.startYear)
            .toBe(partial.endYear - partial.startYear);
        expect(projected.evidence.notes).toContain(
            "compressed_missing_staircase_selected_year_source=explicit_staircase_newest_year",
        );
    });

    it("keeps a genuine -2 partial move without staircase evidence", () => {
        expect(projectSequentialUnitChainHead([
            partialEvent(false),
        ])[0]).toMatchObject({
            eventType: "partialMove",
            shiftYears: -2,
        });
    });

    it("does not project an exact candidate-backed partial through an unanchored unit path", () => {
        const partial = partialMoveEvent(-4);
        partial.evidence.algorithmSources = [
            "candidate_backed_partial_consensus",
            "cofecha_segment_lag",
        ];
        partial.evidence.candidateIds = ["partial-a", "partial-b"];
        const missing = falseRingEvent(1840, false);
        missing.eventType = "missingRing";
        missing.evidence.lagBefore = -1;
        missing.evidence.lagAfter = 0;

        expect(projectSequentialUnitChainHead([partial, missing]))
            .toEqual([partial, missing]);
    });

    it("allows an independently candidate-backed unit to head the deferred state", () => {
        const partial = partialMoveEvent(-4);
        const missing = falseRingEvent(1840, true);
        missing.eventType = "missingRing";
        missing.evidence.lagBefore = -1;
        missing.evidence.lagAfter = 0;

        const [projected] = projectSequentialUnitChainHead([partial, missing]);
        expect(projected.eventType).toBe("missingRing");
        expect(projected.evidence.algorithmSources)
            .toContain("sequential_unit_chain_projection");
    });

    it("keeps the projected missing year when Top1 is at the window edge", () => {
        const partial = partialEvent(true);
        partial.startYear = 1779;
        partial.endYear = 1787;

        const [projected] = projectSequentialUnitChainHead([partial]);

        expect(projected.startYear).toBe(1778);
        expect(projected.endYear).toBe(1786);
        expect(projected.rankedYears[0]?.year).toBe(1778);
    });
});

describe("remote sequential missing-head protection", () => {
    const missingAt = (
        year: number,
        candidateBacked: boolean,
    ): DiagnosisEvent => {
        const event = falseRingEvent(year - 3, candidateBacked);
        event.eventType = "missingRing";
        event.confidenceLevel = "high";
        event.rankedYears = [{
            year,
            rank: 1,
            score: 2,
            evidenceTags: ["candidate_ranking"],
        }];
        event.evidence.lagBefore = -1;
        event.evidence.lagAfter = 0;
        return event;
    };

    it("keeps a candidate-backed 1977 event when a path-only head jumps to 1994", () => {
        const detected = missingAt(1977, true);
        const candidate = missingAt(1977, true);

        expect(shouldPreserveCandidateBackedUnitFromRemoteSequentialHead(
            [detected],
            [candidate],
            1994,
        )).toBe(true);
    });

    it("allows the path head when an independent unit candidate supports its location", () => {
        const detected = missingAt(1977, true);
        const pathCandidate = missingAt(1993, true);

        expect(shouldPreserveCandidateBackedUnitFromRemoteSequentialHead(
            [detected],
            [pathCandidate],
            1994,
        )).toBe(false);
    });

    it("protects a low-confidence paired cold-start frontier from a remote path head", () => {
        const detected = missingAt(1902, true);
        detected.confidenceLevel = "low";
        detected.evidence.algorithmSources.push(
            "paired_core_cold_start_frontier",
        );

        expect(shouldPreserveCandidateBackedUnitFromRemoteSequentialHead(
            [detected],
            [missingAt(1789, true)],
            1851,
        )).toBe(true);
    });

    it("keeps the newest hard-gated unit candidate even without a COFECHA source", () => {
        const incumbent = missingAt(1851, false);
        const newer = missingAt(1977, true);
        newer.evidence.notes = ["candidate_hard_gate_passed"];
        newer.evidence.score = 16;
        const olderCofecha = missingAt(1900, true);
        olderCofecha.evidence.algorithmSources.push("cofecha_segment_lag");
        olderCofecha.evidence.notes = ["candidate_hard_gate_passed"];
        olderCofecha.evidence.score = 20;

        const [selected] = preserveNewestCandidateUnitCheckpoint(
            [incumbent],
            [olderCofecha, newer],
            true,
        );

        expect(selected.rankedYears[0]?.year).toBe(1977);
        expect(selected.evidence.algorithmSources)
            .toContain("candidate_frontier_checkpoint");
    });

    it("keeps independent frontier candidates disabled outside pairwise cold start", () => {
        const incumbent = missingAt(1851, false);
        const newer = missingAt(1977, true);
        newer.evidence.notes = ["candidate_hard_gate_passed"];
        const olderCofecha = missingAt(1900, true);
        olderCofecha.evidence.algorithmSources.push("cofecha_segment_lag");
        olderCofecha.evidence.notes = ["candidate_hard_gate_passed"];

        const [selected] = preserveNewestCandidateUnitCheckpoint(
            [incumbent],
            [olderCofecha, newer],
        );

        expect(selected.rankedYears[0]?.year).toBe(1900);
    });
});

describe("hasMultipleCoherentLocalTransitions", () => {
    it("protects a unit boundary from whole-interval relocation beside a partial transition", () => {
        const partial = partialMoveEvent(-2);
        partial.evidence.lagBefore = -2;
        partial.evidence.lagAfter = 0;
        partial.startYear = 1979;
        partial.endYear = 1987;
        const missing = falseRingEvent(1910, false);
        missing.eventType = "missingRing";
        missing.evidence.lagBefore = -3;
        missing.evidence.lagAfter = -2;

        expect(hasMultipleCoherentLocalTransitions([partial, missing])).toBe(true);
    });

    it("does not disable the single-event posterior for overlapping alternatives", () => {
        const partial = partialMoveEvent(-2);
        partial.evidence.lagBefore = -2;
        partial.evidence.lagAfter = 0;
        const missing = falseRingEvent(partial.startYear, false);
        missing.eventType = "missingRing";
        missing.evidence.lagBefore = -1;
        missing.evidence.lagAfter = 0;

        expect(hasMultipleCoherentLocalTransitions([partial, missing])).toBe(false);
    });

    it("keeps endpoint refinement available for a whole baseline plus one unit event", () => {
        const whole = partialMoveEvent(-5);
        whole.eventType = "wholeSeriesMove";
        const missing = falseRingEvent(1910, false);
        missing.eventType = "missingRing";
        missing.evidence.lagBefore = 4;
        missing.evidence.lagAfter = 5;

        expect(hasMultipleCoherentLocalTransitions([whole, missing])).toBe(false);
    });
});

describe("unitEventUsesWholeSeriesBaseline", () => {
    it("protects a missing-ring boundary whose fixed side is the whole-series lag", () => {
        const whole = partialMoveEvent(2);
        whole.eventType = "wholeSeriesMove";
        const missing = falseRingEvent(1881, false);
        missing.eventType = "missingRing";
        missing.evidence.lagBefore = 1;
        missing.evidence.lagAfter = 2;

        expect(unitEventUsesWholeSeriesBaseline(whole, missing)).toBe(true);
    });

    it("protects a missing-ring boundary when the whole baseline is the older path state", () => {
        const whole = partialMoveEvent(5);
        whole.eventType = "wholeSeriesMove";
        const missing = falseRingEvent(1881, false);
        missing.eventType = "missingRing";
        missing.evidence.lagBefore = 5;
        missing.evidence.lagAfter = 6;

        expect(unitEventUsesWholeSeriesBaseline(whole, missing)).toBe(true);
    });

    it("protects the opposite unit direction on the same non-zero baseline", () => {
        const whole = partialMoveEvent(-3);
        whole.eventType = "wholeSeriesMove";
        const falseRing = falseRingEvent(1881, false);
        falseRing.evidence.lagBefore = -2;
        falseRing.evidence.lagAfter = -3;

        expect(unitEventUsesWholeSeriesBaseline(whole, falseRing)).toBe(true);
    });

    it("leaves a disconnected unit hypothesis available for endpoint refinement", () => {
        const whole = partialMoveEvent(2);
        whole.eventType = "wholeSeriesMove";
        const missing = falseRingEvent(1881, false);
        missing.eventType = "missingRing";
        missing.evidence.lagBefore = -1;
        missing.evidence.lagAfter = 0;

        expect(unitEventUsesWholeSeriesBaseline(whole, missing)).toBe(false);
    });
});

describe("pruneUnanchoredUnitAlternativesToCandidatePartial", () => {
    it("removes a conditioned unit alias that returns to the same fixed lag", () => {
        const partial = partialMoveEvent(-4);
        partial.evidence.algorithmSources = ["candidate_backed_partial_consensus"];
        partial.evidence.candidateIds = ["partial-a", "partial-b"];
        const missing = falseRingEvent(1840, false);
        missing.eventType = "missingRing";
        missing.evidence.lagBefore = -1;
        missing.evidence.lagAfter = 0;
        missing.evidence.notes = ["partial_conditioned_unit_transition"];

        expect(pruneUnanchoredUnitAlternativesToCandidatePartial([
            missing,
            partial,
        ])).toEqual([partial]);
    });

    it("keeps an independently candidate-backed unit transition", () => {
        const partial = partialMoveEvent(-4);
        const missing = falseRingEvent(1840, true);
        missing.eventType = "missingRing";
        missing.evidence.lagBefore = -1;
        missing.evidence.lagAfter = 0;
        missing.evidence.notes.push("partial_conditioned_unit_transition");

        expect(pruneUnanchoredUnitAlternativesToCandidatePartial([
            missing,
            partial,
        ])).toEqual([missing, partial]);
    });
});

describe("accepted locator location authority", () => {
    it("marks a strong accepted locator window as immutable downstream", () => {
        const located = partialMoveEvent(-4);
        located.evidence.algorithmSources.push("full_interval_counterfactual_locator");
        located.evidence.notes.push(
            "locator_adjudication=accepted_detached_strong_mode",
        );

        expect(hasAcceptedStrongLocatorWindow(located)).toBe(true);
        expect(hasAcceptedStrongLocatorWindow(partialMoveEvent(-4))).toBe(false);
    });
});

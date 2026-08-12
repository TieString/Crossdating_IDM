import { describe, expect, it } from "vitest";
import type { DiagnosisEvent, SeriesCoreDiagnosis } from "../types";
import {
    hasIndependentPartialBoundaryAnchor,
    hasCandidateBackedSequentialFalseDirection,
    hasCompressedSequentialFalseDirection,
    hasCoherentSequentialFalseStaircase,
    hasMultipleCoherentLocalTransitions,
    isAuthoritativeWholeSeriesCheckpoint,
    partialMoveExplainsWholeSeriesCandidate,
    partialMoveSupportsSequentialMissingDepth,
    prioritizeEndpointUnitAgainstWhole,
    rawCandidateMayRecenterSequentialMissing,
    unitEventUsesWholeSeriesBaseline,
    pruneUnanchoredUnitAlternativesToCandidatePartial,
    pruneLocalEventsDisconnectedFromWholeBaseline,
    projectSequentialUnitChainHead,
    recoverCandidateBackedPartialConsensus,
    selectCumulativeLagPathFrontier,
    selectWholeBaselineLagPathFrontier,
    resolveSequentialMissingPresentation,
    selectCumulativePartialFrontier,
    selectCompletedPartialFalseSeed,
    selectCompletedPartialMissingSeed,
    selectBoundedCompletedPartialUnitSeeds,
    supportsCompletedPartialUnitComposition,
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
    pruneUnsupportedFalseRingPathSupplements,
    preserveNewestCandidateUnitCheckpoint,
    retainDisplayedMissingHypothesesDuringSequentialRecovery,
    shouldPreserveCandidateBackedUnitFromRemoteSequentialHead,
    unitEventCompetesWithWholeAtNewerEndpoint,
    unitEventExplainsWholeSeriesCandidate,
    wholeSeriesEventIsLocalUnitAlias,
} from "../eventEnsemble";
import type { JointCounterfactualOperationScore } from "../jointCounterfactualOperation";

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
            hasDetectedMissing: false,
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
});

describe("selectCumulativePartialFrontier", () => {
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

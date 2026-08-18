import { describe, expect, it } from "vitest";
import { getConfig } from "../config";
import type {
    CompletedPartialMissingComposition,
    CompletedPartialStaircaseCompetition,
    MissingStaircaseCompetition,
} from "../discreteMissingStaircaseCompetition";
import {
    attachMissingPartialInterpretation,
    evaluateCompletedPartialMissingInterpretation,
    evaluateExactSequentialMissingInterpretation,
    evaluateLocalizedTwoStepMissingInterpretation,
    evaluateMissingPartialInterpretationTie,
    attachUniversalPartialMissingWorkflow,
    promoteValidatedSequentialMissingInterpretation,
    makeMissingRingInterpretation,
    makePartialMoveInterpretation,
    synchronizePreservedMissingPartialWindow,
} from "../missingPartialInterpretation";
import { planDiagnosisEventEdit } from "../eventApply";
import { diagnoseSeriesCore } from "../segments";
import type { RwlSiteData } from "@/features/rwl/types";
import type { DiagnosisEvent } from "../types";

const gate = {
    missingReviewPassed: true,
    partialReviewPassed: true,
    hasIndependentWholeSeriesBaseline: false,
};

const smallCompetition = (
    overrides: Partial<MissingStaircaseCompetition> = {},
): MissingStaircaseCompetition => ({
    cumulativeShiftYears: -2,
    directFirstFixedYear: 1905,
    missingYears: [1904, 1901],
    missingSpanYears: 3,
    masterMargin: 0.012,
    globalMargin: 0.01,
    localMargin: 0.015,
    referenceSupport: 5,
    referenceCount: 10,
    referenceSupportRatio: 0.5,
    referenceMedianMargin: 0.004,
    referenceLowerQuartileMargin: -0.003,
    ...overrides,
});

const completedCompetition = (
    overrides: Partial<CompletedPartialStaircaseCompetition> = {},
): CompletedPartialStaircaseCompetition => ({
    familyShiftYears: -6,
    partialShiftYears: -6,
    partialFirstFixedYear: 1906,
    boundaryPriorYear: 1903,
    shiftSelectionSource: "completed_family_profile",
    missingYears: [1900, 1901, 1902, 1903, 1904, 1905],
    masterMargin: -0.016,
    totalReferenceCount: 10,
    ambiguousReferenceCount: 0,
    referenceCount: 10,
    staircaseReferenceSupport: 5,
    staircaseReferenceSupportRatio: 0.5,
    partialReferenceSupport: 5,
    partialReferenceSupportRatio: 0.5,
    referenceMedianMargin: -0.004,
    referenceLowerQuartileMargin: -0.012,
    referenceUpperQuartileMargin: 0.008,
    shiftProfiles: [],
    ...overrides,
});

const completedComposition = (
    overrides: Partial<CompletedPartialMissingComposition> = {},
): CompletedPartialMissingComposition => ({
    unitEventType: "missingRing",
    cumulativeShiftYears: -3,
    partialShiftYears: -2,
    orientation: "missingThenPartial",
    olderBoundaryYear: 1898,
    newerBoundaryYear: 1905,
    frontierEventType: "partialMove",
    frontierYear: 1905,
    separationYears: 7,
    masterMargin: 0.002,
    referenceCount: 48,
    mixedReferenceSupport: 43,
    mixedReferenceSupportRatio: 43 / 48,
    referenceMedianMargin: 0.12,
    referenceLowerQuartileMargin: 0.08,
    orientationReferenceCount: 46,
    orientationReferenceSupport: 45,
    orientationReferenceSupportRatio: 45 / 46,
    orientationMedianMargin: 0.14,
    orientationLowerQuartileMargin: 0.09,
    masterOrientationMargin: -0.07,
    comparedWithMissingStaircase: false,
    sourceSegmentAnchored: false,
    ...overrides,
});

const partialEvent = (): DiagnosisEvent => ({
    id: "partial",
    seriesId: "ABC01A",
    eventType: "partialMove",
    startYear: 1900,
    endYear: 1908,
    rankedYears: [{
        year: 1905,
        rank: 1,
        score: 1,
        evidenceTags: ["counterfactual"],
    }],
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: ["counterfactual"],
        score: 1,
        scoreMargin: 0.05,
        baselineCorrelation: 0.3,
        correctedCorrelation: 0.6,
        correlationGain: 0.3,
        lagBefore: -2,
        lagAfter: 0,
        samplePairs: 80,
        candidateIds: ["partial-candidate"],
        notes: ["candidate_hard_gate_passed"],
    },
    alternativeTypes: [],
    shiftYears: -2,
    shiftSide: "older",
    seriesRange: { startYear: 1800, endYear: 2000 },
});

const missingPartialAmbiguity = (event: DiagnosisEvent) => {
    const ambiguity = event.interpretationAmbiguity;
    if (!ambiguity || ambiguity.kind !== "missingRingsOrPartialMove") {
        throw new Error("expected missing/partial interpretation ambiguity");
    }
    return ambiguity;
};

const buildDeterministicMissingSite = (
    missingYears: number[],
    referenceCount = 12,
): { site: RwlSiteData; targetId: string } => {
    const targetId = "TARGETA";
    const correct = new Map<number, number>();
    let state = 0x12345678;
    for (let year = 1700; year <= 2000; year += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        correct.set(year, 250 + state % 1000);
    }
    const site: RwlSiteData = new Map();
    for (let index = 0; index < referenceCount; index += 1) {
        site.set(`REF${String(index).padStart(2, "0")}A`, new Map(
            Array.from(correct, ([year, width]) => [
                year,
                Math.max(1, width + ((year * (index + 3) + index * 17) % 17) - 8),
            ]),
        ));
    }
    const corrupted = new Map<number, number>();
    for (let year = 1700 + missingYears.length; year <= 2000; year += 1) {
        const cumulativeLag = -missingYears.filter((eventYear) => year <= eventYear).length;
        const value = correct.get(year + cumulativeLag);
        if (value !== undefined) corrupted.set(year, value);
    }
    site.set(targetId, corrupted);
    return { site, targetId };
};

describe("missing/partial interpretation tie", () => {
    it("accepts a balanced, local, independently reviewed -2 family tie", () => {
        const evidence = evaluateMissingPartialInterpretationTie(
            smallCompetition(),
            gate,
        );

        expect(evidence).toMatchObject({
            missingRingCount: 2,
            cumulativeShiftYears: -2,
            partialFirstFixedYear: 1905,
            referenceCount: 10,
            missingReferenceSupport: 5,
            partialReferenceSupport: 5,
        });
        expect(evidence?.normalizedCounterfactualGainDifference).toBeLessThan(1);
    });

    it("accepts a balanced completed -6 family without reducing it to -3", () => {
        const evidence = evaluateMissingPartialInterpretationTie(
            completedCompetition(),
            gate,
        );

        expect(evidence?.cumulativeShiftYears).toBe(-6);
        expect(evidence?.missingRingCount).toBe(6);
        expect(evidence?.partialFirstFixedYear).toBe(1906);
    });

    it.each([
        ["one-sided references", smallCompetition({
            referenceSupport: 8,
            referenceSupportRatio: 0.8,
        }), gate],
        ["inconsistent cumulative shift", smallCompetition({
            cumulativeShiftYears: -3,
        }), gate],
        ["distant missing mode", smallCompetition({
            missingYears: [1904, 1880],
            missingSpanYears: 24,
        }), gate],
        ["large standardized gain difference", smallCompetition({
            masterMargin: 0.09,
        }), gate],
        ["independent whole-series baseline", smallCompetition(), {
            ...gate,
            hasIndependentWholeSeriesBaseline: true,
        }],
        ["missing explanation below review gate", smallCompetition(), {
            ...gate,
            missingReviewPassed: false,
        }],
    ])("rejects %s", (_name, competition, currentGate) => {
        expect(evaluateMissingPartialInterpretationTie(
            competition as MissingStaircaseCompetition,
            currentGate,
        )).toBeNull();
    });

    it("builds two independently located event objects and keeps the alternative one level deep", () => {
        const evidence = evaluateMissingPartialInterpretationTie(
            smallCompetition(),
            gate,
        )!;
        const partial = partialEvent();
        const missing = makeMissingRingInterpretation(
            partial,
            evidence,
            partial.seriesRange!,
        );
        const relocatedPartial = makePartialMoveInterpretation(
            partial,
            evidence,
            partial.seriesRange!,
        );
        const primary = attachMissingPartialInterpretation(
            missing,
            relocatedPartial,
            evidence,
        );

        expect(missing.eventType).toBe("missingRing");
        expect(missing.rankedYears[0]?.year).toBe(1904);
        expect(relocatedPartial.eventType).toBe("partialMove");
        expect(relocatedPartial.shiftYears).toBe(-2);
        expect(relocatedPartial.rankedYears[0]?.year).toBe(1905);
        expect(planDiagnosisEventEdit(
            relocatedPartial,
            1905,
            1800,
            2000,
        )).toMatchObject({
            operationType: "SHIFT_RANGE",
            startYear: 1800,
            endYear: 1904,
            firstFixedYear: 1905,
            shiftYears: -2,
        });
        expect(primary.interpretationAmbiguity?.alternative.eventType).toBe(
            "partialMove",
        );
        expect(
            primary.interpretationAmbiguity?.alternative.interpretationAmbiguity,
        ).toBeUndefined();
    });

    it("exposes a nearby missing-ring interpretation for a validated mixed frontier", () => {
        const partial = partialEvent();
        const evidence = evaluateCompletedPartialMissingInterpretation(
            partial,
            completedComposition(),
            {
                compositionReviewPassed: true,
                hasIndependentWholeSeriesBaseline: false,
            },
        );

        expect(evidence).toMatchObject({
            interpretationBasis: "completedPartialMissingComposition",
            missingRingCount: 2,
            cumulativeShiftYears: -2,
            missingYears: [],
            partialFirstFixedYear: 1905,
            completedComposition: {
                separationYears: 7,
                mixedReferenceSupport: 43,
                orientationReferenceSupport: 45,
            },
        });
        const missing = makeMissingRingInterpretation(
            partial,
            evidence!,
            partial.seriesRange!,
        );
        expect(missing).toMatchObject({
            eventType: "missingRing",
            startYear: 1900,
            endYear: 1908,
        });
        expect(missing.rankedYears[0]?.year).toBe(1904);
        expect(missing.evidence.algorithmSources).toContain(
            "completed_partial_missing_interpretation",
        );
    });

    it.each([
        ["whole baseline", completedComposition(), true],
        ["distant composition", completedComposition({ separationYears: 14 }), false],
        ["false-first orientation", completedComposition({
            orientation: "partialThenMissing",
            frontierEventType: "missingRing",
        }), false],
    ])("does not expose the composition interpretation for %s", (
        _name,
        competition,
        hasIndependentWholeSeriesBaseline,
    ) => {
        expect(evaluateCompletedPartialMissingInterpretation(
            partialEvent(),
            competition as CompletedPartialMissingComposition,
            {
                compositionReviewPassed: true,
                hasIndependentWholeSeriesBaseline,
            },
        )).toBeNull();
    });

    it("keeps an exact nearby unit staircase as the secondary interpretation", () => {
        const partial = partialEvent();
        const evidence = evaluateExactSequentialMissingInterpretation(
            partial,
            smallCompetition({
                directFirstFixedYear: 1905,
                referenceSupport: 12,
                referenceCount: 53,
                referenceSupportRatio: 12 / 53,
                masterMargin: -0.046,
                referenceMedianMargin: -0.016,
            }),
            {
                year: 1909,
                score: 1,
                directScore: 0.8,
                gainOverDirect: 0.2,
                transitionCount: 2,
                headRunYears: 3,
                headMeanAdvantage: 0.031,
                fixedTailMeanAdvantage: 0.38,
                pathStartLag: -2,
                unitEventYears: [1906, 1909],
            },
            gate,
        );

        expect(evidence).toMatchObject({
            interpretationBasis: "exactSequentialStaircaseAlternative",
            missingRingCount: 2,
            cumulativeShiftYears: -2,
            missingYears: [1906, 1909],
            missingReferenceSupport: 12,
            partialReferenceSupport: 41,
        });
        expect(makeMissingRingInterpretation(
            partial,
            evidence!,
            partial.seriesRange!,
        ).rankedYears[0]?.year).toBe(1909);
    });

    it("keeps a locally decisive two-step staircase when the physical interpretation is tied", () => {
        const partial = partialEvent();
        partial.startYear = 1825;
        partial.endYear = 1837;
        partial.rankedYears = [{
            year: 1832,
            rank: 1,
            score: 1,
            evidenceTags: ["bounded_complete_lag_path"],
        }];
        const evidence = evaluateLocalizedTwoStepMissingInterpretation(
            partial,
            smallCompetition({
                masterMargin: 0.04,
                referenceMedianMargin: 0.009,
                referenceCount: 28,
                referenceSupport: 20,
                referenceSupportRatio: 20 / 28,
            }),
            {
                year: 1832,
                score: 1,
                directScore: 0.895,
                gainOverDirect: 0.105,
                transitionCount: 2,
                headRunYears: 4,
                headMeanAdvantage: 0.035,
                fixedTailMeanAdvantage: 0.084,
                pathStartLag: -2,
                unitEventYears: [1825, 1832],
            },
            {
                olderBoundaryYear: 1825,
                newerBoundaryYear: 1832,
                staircaseScore: 1,
                directScore: 0.898,
                staircaseGain: 0.102,
                middleMeanAdvantage: 0.093,
                middleSamplePairs: 30,
                referenceSupport: 26,
                referenceCount: 26,
                referenceMedianAdvantage: 0.067,
            },
            gate,
        );

        expect(evidence).toMatchObject({
            interpretationBasis: "localizedTwoStepStaircaseAlternative",
            missingRingCount: 2,
            cumulativeShiftYears: -2,
            missingYears: [1825, 1832],
            partialFirstFixedYear: 1832,
            referenceCount: 26,
            missingReferenceSupport: 26,
        });
        expect(makeMissingRingInterpretation(
            partial,
            evidence!,
            partial.seriesRange!,
        )).toMatchObject({
            eventType: "missingRing",
            startYear: 1826,
            endYear: 1838,
        });
    });

    it("rejects a localized two-step alternative without concentrated references", () => {
        const evidence = evaluateLocalizedTwoStepMissingInterpretation(
            partialEvent(),
            smallCompetition(),
            {
                year: 1905,
                score: 1,
                directScore: 0.9,
                gainOverDirect: 0.1,
                transitionCount: 2,
                headRunYears: 4,
                headMeanAdvantage: 0.05,
                fixedTailMeanAdvantage: 0.1,
                pathStartLag: -2,
                unitEventYears: [1900, 1905],
            },
            {
                olderBoundaryYear: 1900,
                newerBoundaryYear: 1905,
                staircaseScore: 1,
                directScore: 0.9,
                staircaseGain: 0.1,
                middleMeanAdvantage: 0.08,
                middleSamplePairs: 30,
                referenceSupport: 7,
                referenceCount: 10,
                referenceMedianAdvantage: 0.05,
            },
            gate,
        );

        expect(evidence).toBeNull();
    });

    it("keeps a tied cumulative -2 path behind a strong structured locator", () => {
        const partial = partialEvent();
        partial.startYear = 1582;
        partial.endYear = 1594;
        partial.seriesRange = { startYear: 1442, endYear: 1995 };
        partial.rankedYears = [{
            year: 1582,
            rank: 1,
            score: 1,
            evidenceTags: ["full_interval_counterfactual_locator"],
        }];
        partial.evidence.algorithmSources = ["full_interval_counterfactual_locator"];
        partial.evidence.notes = [
            "locator_adjudication=accepted_detached_strong_mode",
            "counterfactual_window_concentration=0.630811",
            "counterfactual_window_remote_margin=1.964287",
            "counterfactual_pair_reference_count=16",
        ];
        const evidence = evaluateExactSequentialMissingInterpretation(
            partial,
            smallCompetition({
                directFirstFixedYear: 1584,
                missingYears: [1583, 1582],
                missingSpanYears: 1,
                masterMargin: 0,
                referenceMedianMargin: 0,
                referenceSupport: 7,
                referenceCount: 55,
                referenceSupportRatio: 7 / 55,
            }),
            {
                year: 1581,
                score: 1,
                directScore: 1.48,
                gainOverDirect: -0.48,
                transitionCount: 2,
                headRunYears: 12,
                headMeanAdvantage: 0.001,
                fixedTailMeanAdvantage: 0.287,
                pathStartLag: -2,
                unitEventYears: [1569, 1581],
            },
            gate,
        );

        expect(evidence).toMatchObject({
            interpretationBasis: "structuredLocatorCumulativeLagAlternative",
            missingRingCount: 2,
            cumulativeShiftYears: -2,
            missingYears: [1569, 1581],
        });
        expect(makeMissingRingInterpretation(
            partial,
            evidence!,
            partial.seriesRange!,
        )).toMatchObject({
            eventType: "missingRing",
            startYear: 1575,
            endYear: 1587,
        });
    });

    it("rejects a weak or remotely located staircase alternative", () => {
        const partial = partialEvent();
        const competition = smallCompetition({
            referenceSupport: 7,
            referenceCount: 53,
            referenceSupportRatio: 7 / 53,
        });
        const head = {
            year: 1912,
            score: 1,
            directScore: 0.8,
            gainOverDirect: 0.2,
            transitionCount: 2,
            headRunYears: 3,
            headMeanAdvantage: 0.031,
            fixedTailMeanAdvantage: 0.38,
            pathStartLag: -2,
            unitEventYears: [1906, 1912],
        };

        expect(evaluateExactSequentialMissingInterpretation(
            partial,
            competition,
            head,
            gate,
        )).toBeNull();
    });

    it("always exposes one bark-side missing frontier for an automatic partial move", () => {
        const result = attachUniversalPartialMissingWorkflow(
            partialEvent(),
            null,
            new Map(),
        );

        expect(result.interpretationAmbiguity).toMatchObject({
            kind: "missingRingsOrPartialMove",
            evidence: {
                interpretationBasis: "virtualSequentialFrontier",
                cumulativeShiftYears: -2,
                missingRingCount: 2,
                countEvidence: "cumulativeLagOnly",
                frontierYear: 1904,
                frontierLocalization: "partialBoundaryFallback",
                virtualCountEvaluation: {
                    status: "skipped",
                    validatedSteps: 0,
                    years: [],
                },
            },
            alternative: {
                eventType: "missingRing",
            },
        });
        expect(result.interpretationAmbiguity?.alternative.rankedYears[0]).toMatchObject({
            year: 1904,
            rank: 1,
        });
        expect(result.interpretationAmbiguity?.alternative.evidence.notes).toContain(
            "missing_workflow_applies_one_frontier_event_only",
        );
        expect(result.interpretationAmbiguity?.alternative.evidence.notes).toContain(
            "missing_partial_virtual_count_status=skipped",
        );
    });

    it("promotes a validated unit frontier from a mixed cumulative path", () => {
        const partial = partialEvent();
        partial.evidence.notes.push("stable_bounded_path_all_transitions_partial=false");
        const attached = attachUniversalPartialMissingWorkflow(partial, null, new Map());
        const ambiguity = missingPartialAmbiguity(attached);
        const validated: DiagnosisEvent = {
            ...attached,
            interpretationAmbiguity: {
                ...ambiguity,
                alternative: {
                    ...ambiguity.alternative,
                    rankedYears: [{
                        year: 1907,
                        rank: 1,
                        score: 1,
                        evidenceTags: ["virtual_sequential_missing_frontier"],
                    }],
                },
                evidence: {
                    ...ambiguity.evidence,
                    frontierYear: 1907,
                    virtualCountEvaluation: {
                        status: "inconclusive",
                        validatedSteps: 1,
                        years: [1907],
                        minimumReferenceCount: 15,
                        minimumReferenceVoteRatio: 0.72,
                        minimumRawGain: 0.2,
                    },
                },
            },
        };

        const promoted = promoteValidatedSequentialMissingInterpretation(
            validated,
            false,
        );

        expect(promoted.eventType).toBe("missingRing");
        expect(promoted.rankedYears[0]?.year).toBe(1907);
        expect(promoted.interpretationAmbiguity?.alternative.eventType)
            .toBe("partialMove");
        expect(promoted.evidence.algorithmSources)
            .toContain("validated_sequential_missing_frontier_priority");
    });

    it("does not promote one virtual step for an otherwise physical partial move", () => {
        const attached = attachUniversalPartialMissingWorkflow(
            partialEvent(),
            null,
            new Map(),
        );
        const ambiguity = missingPartialAmbiguity(attached);
        const validated: DiagnosisEvent = {
            ...attached,
            interpretationAmbiguity: {
                ...ambiguity,
                alternative: {
                    ...ambiguity.alternative,
                    rankedYears: [{
                        year: 1907,
                        rank: 1,
                        score: 1,
                        evidenceTags: ["virtual_sequential_missing_frontier"],
                    }],
                },
                evidence: {
                    ...ambiguity.evidence,
                    virtualCountEvaluation: {
                        status: "inconclusive",
                        validatedSteps: 1,
                        years: [1907],
                        minimumReferenceCount: 15,
                        minimumReferenceVoteRatio: 0.72,
                        minimumRawGain: 0.2,
                    },
                },
            },
        };

        expect(promoteValidatedSequentialMissingInterpretation(validated, false))
            .toBe(validated);
        expect(promoteValidatedSequentialMissingInterpretation(validated, true).eventType)
            .toBe("missingRing");
    });

    it("keeps an already calibrated staircase without replacing it with virtual guesses", () => {
        const partial = partialEvent();
        const evidence = evaluateMissingPartialInterpretationTie(
            smallCompetition(),
            gate,
        )!;
        const alternative = makeMissingRingInterpretation(
            partial,
            evidence,
            partial.seriesRange!,
        );
        const attached = attachMissingPartialInterpretation(
            partial,
            alternative,
            evidence,
        );
        const result = attachUniversalPartialMissingWorkflow(
            attached,
            null,
            new Map(),
        );

        const ambiguity = missingPartialAmbiguity(result);
        expect(ambiguity.evidence).toMatchObject({
            countEvidence: "multiReferenceStaircase",
            missingYears: [1901, 1904],
        });
        expect(
            ambiguity.evidence.virtualCountEvaluation,
        ).toBeUndefined();
    });

    it("keeps the same review window when switching a multi-event partial to missing", () => {
        const partial = partialEvent();
        partial.startYear = 1898;
        partial.endYear = 1910;
        partial.evidence.algorithmSources.push(
            "multi_event_frontier_location_consensus",
        );
        const evidence = {
            ...evaluateMissingPartialInterpretationTie(smallCompetition(), gate)!,
            frontierYear: 1880,
        };

        expect(makeMissingRingInterpretation(
            partial,
            evidence,
            partial.seriesRange!,
        )).toMatchObject({
            startYear: 1898,
            endYear: 1910,
            evidence: {
                notes: expect.arrayContaining([
                    "interpretation_window=preserved_multi_event_consensus",
                ]),
            },
        });
    });

    it("keeps an accepted strong locator window when switching to missing", () => {
        const partial = partialEvent();
        partial.startYear = 988;
        partial.endYear = 1000;
        partial.shiftYears = -4;
        partial.evidence.lagBefore = -4;
        partial.evidence.algorithmSources.push(
            "full_interval_counterfactual_locator",
        );
        partial.evidence.notes.push(
            "locator_adjudication=accepted_detached_strong_mode",
        );
        const evidence = {
            interpretationBasis: "virtualSequentialFrontier" as const,
            missingRingCount: 4,
            cumulativeShiftYears: -4,
            missingYears: [],
            partialFirstFixedYear: 1000,
            normalizedCounterfactualGainDifference: 0,
            masterMargin: 0,
            referenceMedianMargin: 0,
            referenceCount: 2,
            missingReferenceSupport: 0,
            partialReferenceSupport: 0,
            frontierYear: 999,
        };

        expect(makeMissingRingInterpretation(
            partial,
            evidence,
            partial.seriesRange!,
        )).toMatchObject({
            startYear: 988,
            endYear: 1000,
            evidence: {
                notes: expect.arrayContaining([
                    "interpretation_window=preserved_multi_event_consensus",
                ]),
            },
        });
    });

    it("resynchronizes a preserved missing interpretation after final partial recentering", () => {
        const partial = partialEvent();
        partial.startYear = 1898;
        partial.endYear = 1910;
        partial.evidence.algorithmSources.push(
            "multi_event_frontier_location_consensus",
        );
        const evidence = {
            ...evaluateMissingPartialInterpretationTie(smallCompetition(), gate)!,
            frontierYear: 1904,
        };
        const attached = attachMissingPartialInterpretation(
            partial,
            makeMissingRingInterpretation(partial, evidence, partial.seriesRange!),
            evidence,
        );
        const recentered = {
            ...attached,
            startYear: 1900,
            endYear: 1912,
            rankedYears: [{
                year: 1906,
                rank: 1,
                score: 2,
                evidenceTags: ["stable_partial_rank_edge_guard"],
            }],
        };

        const synchronized = synchronizePreservedMissingPartialWindow(recentered);
        expect(synchronized.interpretationAmbiguity?.alternative).toMatchObject({
            startYear: 1900,
            endYear: 1912,
            evidence: {
                algorithmSources: expect.arrayContaining([
                    "shared_missing_partial_frontier_window",
                ]),
                notes: expect.arrayContaining([
                    "shared_interpretation_previous_window=1898-1910",
                    "shared_interpretation_final_window=1900-1912",
                ]),
            },
        });
        expect(synchronized.interpretationAmbiguity?.alternative.rankedYears)
            .toHaveLength(13);
    });

    it("does not overwrite an independently located missing interpretation", () => {
        const partial = partialEvent();
        const evidence = evaluateMissingPartialInterpretationTie(
            smallCompetition(),
            gate,
        )!;
        const alternative = makeMissingRingInterpretation(
            partial,
            evidence,
            partial.seriesRange!,
        );
        alternative.evidence.notes = alternative.evidence.notes.filter((note) => (
            note !== "interpretation_window=preserved_multi_event_consensus"
        ));
        const attached = attachMissingPartialInterpretation(partial, alternative, evidence);

        const result = synchronizePreservedMissingPartialWindow({
            ...attached,
            startYear: 1910,
            endYear: 1922,
        });
        expect(result.interpretationAmbiguity?.alternative).toMatchObject({
            startYear: alternative.startYear,
            endYear: alternative.endYear,
        });
        expect(result.interpretationAmbiguity?.alternative.evidence.algorithmSources)
            .not.toContain("shared_missing_partial_frontier_window");
    });

    it("confirms a nearby two-ring count only after both virtual corrections win independent reference votes", () => {
        const { site, targetId } = buildDeterministicMissingSite([1934, 1940]);
        const diagnosis = diagnoseSeriesCore(
            site,
            targetId,
            getConfig({ referenceConfig: null }),
        );
        expect(diagnosis).not.toBeNull();
        const partial = partialEvent();
        partial.seriesId = targetId;
        partial.startYear = 1930;
        partial.endYear = 1942;
        partial.rankedYears = [{
            year: 1941,
            rank: 1,
            score: 1,
            evidenceTags: ["bounded_complete_lag_path"],
        }];
        partial.seriesRange = diagnosis!.targetRange;

        const result = attachUniversalPartialMissingWorkflow(
            partial,
            diagnosis,
            site,
        );
        const ambiguity = missingPartialAmbiguity(result);

        expect(ambiguity.evidence.virtualCountEvaluation).toMatchObject({
            status: "confirmed",
            validatedSteps: 2,
            minimumReferenceCount: 12,
        });
        const virtualYears = ambiguity.evidence.virtualCountEvaluation?.years ?? [];
        expect(virtualYears[0]).toBe(1940);
        expect(Math.abs((virtualYears[1] ?? 0) - 1934)).toBeLessThanOrEqual(1);
        expect(ambiguity.evidence).toMatchObject({
            countEvidence: "multiReferenceStaircase",
            frontierYear: 1940,
        });
        expect(ambiguity.evidence.missingYears).toEqual(
            [...virtualYears].sort((left, right) => left - right),
        );
        expect(ambiguity.alternative.eventType).toBe("missingRing");
        expect(ambiguity.alternative.rankedYears[0]).toMatchObject({
            year: 1940,
            rank: 1,
        });
    });

    it("keeps cumulative-lag wording when virtual steps lack enough independent references", () => {
        const { site, targetId } = buildDeterministicMissingSite([1934, 1940], 4);
        const diagnosis = diagnoseSeriesCore(
            site,
            targetId,
            getConfig({ referenceConfig: null }),
        );
        expect(diagnosis).not.toBeNull();
        const partial = partialEvent();
        partial.seriesId = targetId;
        partial.startYear = 1930;
        partial.endYear = 1942;
        partial.rankedYears = [{
            year: 1941,
            rank: 1,
            score: 1,
            evidenceTags: ["bounded_complete_lag_path"],
        }];
        partial.seriesRange = diagnosis!.targetRange;

        const result = attachUniversalPartialMissingWorkflow(
            partial,
            diagnosis,
            site,
        );

        expect(result.interpretationAmbiguity?.evidence).toMatchObject({
            countEvidence: "cumulativeLagOnly",
            missingYears: [],
            frontierYear: 1940,
            frontierLocalization: "partialBoundaryFallback",
            virtualCountEvaluation: {
                status: "inconclusive",
                validatedSteps: 0,
            },
        });
        expect(result.interpretationAmbiguity?.alternative.rankedYears[0]?.year)
            .toBe(1940);
    });

    it("keeps one endpoint review window when an aggregate partial cannot resolve a unit frontier", () => {
        const { site, targetId } = buildDeterministicMissingSite([], 4);
        const diagnosis = diagnoseSeriesCore(
            site,
            targetId,
            getConfig({ referenceConfig: null }),
        );
        expect(diagnosis).not.toBeNull();
        const partial = partialEvent();
        partial.seriesId = targetId;
        partial.startYear = 1977;
        partial.endYear = 1985;
        partial.shiftYears = -4;
        partial.evidence.lagBefore = -4;
        partial.evidence.algorithmSources.push("endpoint_aggregate_partial_frontier");
        partial.rankedYears = [{
            year: 1981,
            rank: 1,
            score: 1,
            evidenceTags: ["endpoint_aggregate_partial_frontier"],
        }];
        partial.seriesRange = diagnosis!.targetRange;

        const result = attachUniversalPartialMissingWorkflow(
            partial,
            diagnosis,
            site,
        );
        const ambiguity = missingPartialAmbiguity(result);

        expect(ambiguity.evidence).toMatchObject({
            countEvidence: "cumulativeLagOnly",
            missingYears: [],
            frontierLocalization: "endpointAggregateReview",
        });
        expect(ambiguity.alternative).toMatchObject({
            eventType: "missingRing",
            startYear: 1986,
            endYear: 1998,
            reviewCoreRange: { startYear: 1986, endYear: 1998 },
            confidenceLevel: "low",
        });
        expect(ambiguity.alternative.rankedYears).toHaveLength(13);
        expect(ambiguity.alternative.evidence.algorithmSources)
            .toContain("endpoint_aggregate_missing_review");
    });
});

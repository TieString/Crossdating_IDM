import { describe, expect, it } from "vitest";
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
    evaluateSeparatedDenseStaircaseClusterInterpretation,
    makeMissingRingInterpretation,
    makePartialMoveInterpretation,
} from "../missingPartialInterpretation";
import { planDiagnosisEventEdit } from "../eventApply";
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

describe("missing/partial interpretation tie", () => {
    it("recognizes one isolated unit step followed by a unique dense partial cluster", () => {
        const evidence = evaluateSeparatedDenseStaircaseClusterInterpretation(
            completedCompetition({
                partialShiftYears: -7,
                partialFirstFixedYear: 1821,
                missingYears: [1787, 1816, 1818, 1820, 1821, 1823, 1824],
                referenceCount: 54,
                staircaseReferenceSupport: 54,
                partialReferenceSupport: 0,
            }),
            {
                year: 1826,
                score: 10,
                directScore: 0,
                gainOverDirect: 10,
                transitionCount: 7,
                headRunYears: 1,
                headMeanAdvantage: 0.1,
                fixedTailMeanAdvantage: 0.3,
                pathStartLag: -7,
                unitEventYears: [1789, 1818, 1820, 1822, 1823, 1825, 1826],
            },
            { partialReviewPassed: true, hasIndependentWholeSeriesBaseline: false },
        );

        expect(evidence).toMatchObject({
            interpretationBasis: "separatedDenseStaircaseClusterAlternative",
            missingRingCount: 6,
            cumulativeShiftYears: -6,
            partialFirstFixedYear: 1821,
            missingYears: [1818, 1820, 1822, 1823, 1825, 1826],
        });
    });

    it("rejects a candidate amplitude unrelated to both the dense and cumulative depths", () => {
        expect(evaluateSeparatedDenseStaircaseClusterInterpretation(
            completedCompetition({
                partialShiftYears: -4,
                partialFirstFixedYear: 1821,
                missingYears: [1787, 1816, 1818, 1820, 1821, 1823, 1824],
            }),
            {
                year: 1826,
                score: 10,
                directScore: 0,
                gainOverDirect: 10,
                transitionCount: 7,
                headRunYears: 1,
                headMeanAdvantage: 0.1,
                fixedTailMeanAdvantage: 0.3,
                pathStartLag: -7,
                unitEventYears: [1789, 1818, 1820, 1822, 1823, 1825, 1826],
            },
            { partialReviewPassed: true, hasIndependentWholeSeriesBaseline: false },
        )).toBeNull();
    });

    it.each([
        ["no separated mode", [1800, 1802, 1804, 1806, 1808, 1810, 1812]],
        ["two separated modes", [1760, 1780, 1818, 1820, 1822, 1824, 1826]],
        ["dense mode too wide", [1789, 1810, 1814, 1818, 1822, 1826, 1830]],
    ])("rejects dense-cluster interpretation for %s", (_name, unitEventYears) => {
        expect(evaluateSeparatedDenseStaircaseClusterInterpretation(
            completedCompetition({
                partialShiftYears: -6,
                partialFirstFixedYear: 1821,
                missingYears: unitEventYears,
            }),
            {
                year: unitEventYears[unitEventYears.length - 1]!,
                score: 10,
                directScore: 0,
                gainOverDirect: 10,
                transitionCount: unitEventYears.length,
                headRunYears: 1,
                headMeanAdvantage: 0.1,
                fixedTailMeanAdvantage: 0.3,
                pathStartLag: -unitEventYears.length,
                unitEventYears,
            },
            { partialReviewPassed: true, hasIndependentWholeSeriesBaseline: false },
        )).toBeNull();
    });

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
            startYear: 1901,
            endYear: 1909,
        });
        expect(missing.rankedYears[0]?.year).toBe(1905);
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
});

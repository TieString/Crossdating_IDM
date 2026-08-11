import { describe, expect, it } from "vitest";
import type {
    CompletedPartialMissingComposition,
    CompletedPartialStaircaseCompetition,
    MissingStaircaseCompetition,
} from "../discreteMissingStaircaseCompetition";
import {
    attachMissingPartialInterpretation,
    evaluateCompletedPartialMissingInterpretation,
    evaluateMissingPartialInterpretationTie,
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
});

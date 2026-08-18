import { describe, expect, it } from "vitest";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis/types";
import type { CapabilityTruth } from "../types";
import {
    countHumanAssistedFullEventSuggestions,
    countWorkflowSuggestionAttempts,
    matchWorkflowSuggestion,
    selectHumanRescueTruth,
} from "../workflowSuggestionMetric";

const event = (
    eventType: DiagnosisEvent["eventType"],
    shiftYears: number,
    startYear = 1898,
    endYear = 1906,
): DiagnosisEvent => ({
    id: `${eventType}-${shiftYears}`,
    seriesId: "TARGET",
    eventType,
    shiftYears,
    startYear,
    endYear,
    rankedYears: [{ year: 1902, rank: 1, score: 1, evidenceTags: ["test"] }],
    confidenceLevel: "high",
    evidence: {
        algorithmSources: ["test"],
        score: 1,
        scoreMargin: 1,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.7,
        correlationGain: 0.5,
        lagBefore: shiftYears,
        lagAfter: 0,
        samplePairs: 100,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
});

const truth = (
    eventType: CapabilityTruth["eventType"],
    shiftYears: number,
    year: number | null,
): CapabilityTruth => ({ truthId: "truth", eventType, shiftYears, year });

describe("frontier workflow suggestion metric", () => {
    it("requires an exact local operation and a covering unique window", () => {
        const localTruth = truth("missingRing", -1, 1902);

        expect(matchWorkflowSuggestion(
            event("missingRing", -1),
            null,
            [localTruth],
        )?.interpretation).toBe("primary");
        expect(matchWorkflowSuggestion(
            event("missingRing", -1, 1880, 1888),
            null,
            [localTruth],
        )).toBeNull();
        expect(matchWorkflowSuggestion(
            event("falseRing", 1),
            null,
            [localTruth],
        )).toBeNull();
    });

    it("accepts a validated local workflow-equivalent alternative", () => {
        const match = matchWorkflowSuggestion(
            event("partialMove", -3),
            event("missingRing", -1),
            [truth("missingRing", -1, 1902)],
        );

        expect(match?.interpretation).toBe("alternative");
        expect(match?.truth.eventType).toBe("missingRing");
    });

    it("counts only an exact negative primary whole-series move", () => {
        expect(matchWorkflowSuggestion(
            event("wholeSeriesMove", -20, 1700, 2000),
            null,
            [truth("wholeSeriesMove", -20, null)],
        )?.truth.shiftYears).toBe(-20);
        expect(matchWorkflowSuggestion(
            event("wholeSeriesMove", -11, 1700, 2000),
            null,
            [truth("wholeSeriesMove", -20, null)],
        )).toBeNull();
        expect(matchWorkflowSuggestion(
            event("wholeSeriesMove", 20, 1700, 2000),
            null,
            [truth("wholeSeriesMove", 20, null)],
        )).toBeNull();
        expect(matchWorkflowSuggestion(
            event("missingRing", -1),
            event("wholeSeriesMove", -20, 1700, 2000),
            [truth("wholeSeriesMove", -20, null)],
        )).toBeNull();
    });

    it("uses actual frontier attempts as the denominator", () => {
        expect(countWorkflowSuggestionAttempts([
            { workflowSuggestionCorrect: true },
            { workflowSuggestionCorrect: false },
            { workflowSuggestionCorrect: false },
        ])).toEqual({ numerator: 1, denominator: 3 });
    });

    it("selects only the current blocking truth for a human rescue", () => {
        const whole = truth("wholeSeriesMove", -20, null);
        const local = { ...truth("missingRing", -1, 1902), truthId: "local" };

        expect(selectHumanRescueTruth([whole, local], null, null)).toBe(whole);
        expect(selectHumanRescueTruth([whole, local], local, null)).toBe(local);
        expect(selectHumanRescueTruth([whole, local], null, local)).toBe(local);
        expect(selectHumanRescueTruth([], null, null)).toBeNull();
    });

    it("counts every truth once after human rescue without washing out the failure", () => {
        expect(countHumanAssistedFullEventSuggestions([
            {
                workflowSuggestionCorrect: true,
                diagnosedTruthId: "event-1",
                humanRescueApplied: false,
            },
            {
                workflowSuggestionCorrect: true,
                diagnosedTruthId: "event-2",
                humanRescueApplied: false,
            },
            {
                workflowSuggestionCorrect: false,
                diagnosedTruthId: "event-3",
                humanRescueApplied: true,
            },
            {
                workflowSuggestionCorrect: true,
                diagnosedTruthId: "event-4",
                humanRescueApplied: false,
            },
        ], 4)).toEqual({
            correctSuggestions: 3,
            humanRescues: 1,
            opportunities: 4,
            totalTruthEvents: 4,
        });
    });
});

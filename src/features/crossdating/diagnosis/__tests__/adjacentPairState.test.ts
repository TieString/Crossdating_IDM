import { describe, expect, it } from "vitest";
import {
    passesJointNecessityPairGate,
    passesLongPulsePairGate,
    passesUnhintedAdjacentPairGate,
} from "../eventEnsemble";
import { removeOverlappingEvents } from "../eventPath";
import type { AdjacentUnitPairVote } from "../eventReferenceVoting";
import type { DiagnosisEvent } from "../types";

const pulseEvent = (
    id: string,
    eventType: "missingRing" | "falseRing",
    startYear: number,
    endYear: number,
    lagBefore: number,
    lagAfter: number,
): DiagnosisEvent => ({
    id,
    seriesId: "A",
    eventType,
    startYear,
    endYear,
    rankedYears: [{
        year: Math.round((startYear + endYear) / 2),
        rank: 1,
        score: 1,
        evidenceTags: ["bounded_lag_pulse"],
    }],
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: ["bounded_lag_pulse"],
        score: 1,
        scoreMargin: 1,
        baselineCorrelation: 0,
        correctedCorrelation: 0.1,
        correlationGain: 0.1,
        lagBefore,
        lagAfter,
        samplePairs: 60,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
});

const vote = (
    overrides: Partial<AdjacentUnitPairVote> = {},
): AdjacentUnitPairVote => ({
    events: [],
    orientation: "missingThenFalse",
    olderYear: 1905,
    newerYear: 1913,
    gain: 0.102,
    remoteMargin: 0.134,
    referenceCount: 16,
    positiveReferenceFraction: 0.875,
    medianReferenceGain: 0.1,
    lowerQuartileReferenceGain: 0.058,
    masterRemoteMargin: 0.01,
    olderSingleGain: -0.09,
    newerSingleGain: -0.18,
    jointExcessGain: 0.35,
    ...overrides,
});

describe("adjacent cancelling event state", () => {
    it("retains both boundaries from one bounded pulse when review windows overlap", () => {
        const events = removeOverlappingEvents([
            pulseEvent(
                "diagnosis-event-A-pulse-0-older-missingRing-1905",
                "missingRing",
                1902,
                1908,
                0,
                1,
            ),
            pulseEvent(
                "diagnosis-event-A-pulse-0-newer-falseRing-1913",
                "falseRing",
                1908,
                1914,
                1,
                0,
            ),
        ]);

        expect(events).toHaveLength(2);
        expect(events.map((event) => event.eventType).sort()).toEqual([
            "falseRing",
            "missingRing",
        ]);
    });

    it("requires a complete, bounded and jointly necessary lag pulse", () => {
        expect(passesJointNecessityPairGate(vote(), vote(), 9)).toBe(true);
        expect(passesJointNecessityPairGate(
            vote({ orientation: "falseThenMissing" }),
            vote(),
            9,
        )).toBe(false);
        expect(passesJointNecessityPairGate(
            vote(),
            vote({ positiveReferenceFraction: 0.75 }),
            9,
        )).toBe(false);
        expect(passesJointNecessityPairGate(vote(), vote(), 15)).toBe(false);
    });

    it("allows unhinted recovery only with unanimous reference support", () => {
        expect(passesUnhintedAdjacentPairGate(vote({
            gain: 0.091,
            remoteMargin: 0.059,
            positiveReferenceFraction: 1,
            lowerQuartileReferenceGain: 0.063,
            jointExcessGain: 0.352,
        }))).toBe(true);
        expect(passesUnhintedAdjacentPairGate(vote({
            gain: 0.087,
            remoteMargin: 0.046,
            positiveReferenceFraction: 0.8125,
            lowerQuartileReferenceGain: 0.007,
            jointExcessGain: 0.301,
        }))).toBe(false);
    });

    it("accepts long pulses only with separated unanimous local reference evidence", () => {
        const global = vote({ gain: 0.016, remoteMargin: 0.005 });
        const localized = vote({
            gain: 0.23,
            remoteMargin: 0.08,
            referenceCount: 8,
            positiveReferenceFraction: 1,
            lowerQuartileReferenceGain: 0.18,
            jointExcessGain: 0.37,
        });

        expect(passesLongPulsePairGate(global, localized, 21)).toBe(true);
        expect(passesLongPulsePairGate(global, localized, 14)).toBe(false);
        expect(passesLongPulsePairGate(global, vote({
            ...localized,
            positiveReferenceFraction: 0.875,
        }), 21)).toBe(false);
        expect(passesLongPulsePairGate(global, vote({
            ...localized,
            lowerQuartileReferenceGain: -0.01,
        }), 21)).toBe(false);
    });
});

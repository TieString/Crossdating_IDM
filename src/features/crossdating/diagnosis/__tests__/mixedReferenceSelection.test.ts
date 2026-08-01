import { describe, expect, it } from "vitest";
import {
    pruneIncoherentPartialSupplements,
    shouldRunMixedReferencePass,
    shouldSelectMixedReferenceAlternative,
} from "../eventEnsemble";
import type { DiagnosisEventSetScore } from "../jointEventRefinement";
import type { DiagnosisEvent, DiagnosisEventType } from "../types";

const event = (
    eventType: DiagnosisEventType,
    score = 4,
): DiagnosisEvent => ({
    id: `${eventType}-${score}`,
    seriesId: "ABC01A",
    eventType,
    startYear: 1900,
    endYear: 1906,
    rankedYears: [],
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: ["piecewise_lag_path"],
        score,
        scoreMargin: 1,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.5,
        correlationGain: 0.3,
        lagBefore: eventType === "falseRing" ? 1 : -1,
        lagAfter: 0,
        samplePairs: 40,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
    ...(eventType === "partialMove"
        ? { shiftYears: -2, shiftSide: "older" as const }
        : {}),
});

const setScore = (
    score: number,
    localEventCount: number,
): DiagnosisEventSetScore => ({
    score,
    localEventCount,
    consistentLagChain: true,
    selectedYears: [],
});

const chainEvent = (
    id: string,
    eventType: DiagnosisEventType,
    startYear: number,
    lagBefore: number,
    lagAfter: number,
    algorithmSources: DiagnosisEvent["evidence"]["algorithmSources"] = [
        "piecewise_lag_path",
    ],
): DiagnosisEvent => ({
    ...event(eventType),
    id,
    startYear,
    endYear: startYear + 6,
    evidence: {
        ...event(eventType).evidence,
        algorithmSources,
        lagBefore,
        lagAfter,
    },
});

describe("mixed-reference event-set selection", () => {
    it("skips a second pass for an ordinary single local event", () => {
        expect(shouldRunMixedReferencePass([event("missingRing")])).toBe(false);
        expect(shouldRunMixedReferencePass([event("partialMove", 2)])).toBe(false);
    });

    it("runs a second pass for multi-event, whole-offset, and weak partial cases", () => {
        expect(shouldRunMixedReferencePass([
            event("missingRing"),
            event("falseRing"),
        ])).toBe(true);
        expect(shouldRunMixedReferencePass([event("wholeSeriesMove")])).toBe(true);
        expect(shouldRunMixedReferencePass([event("partialMove", 0.5)])).toBe(true);
    });

    it("requires both counterfactual improvement and a longer local chain", () => {
        const primary = [event("missingRing")];
        const alternate = [event("missingRing"), event("falseRing")];
        expect(shouldSelectMixedReferenceAlternative(
            primary,
            alternate,
            setScore(0.4, 1),
            setScore(0.43, 2),
        )).toBe(true);
        expect(shouldSelectMixedReferenceAlternative(
            primary,
            [event("falseRing")],
            setScore(0.4, 1),
            setScore(0.43, 1),
        )).toBe(false);
    });

    it("replaces a false whole offset with a supported local chain", () => {
        expect(shouldSelectMixedReferenceAlternative(
            [event("wholeSeriesMove"), event("falseRing")],
            [event("falseRing"), event("falseRing")],
            setScore(0.5, 1),
            setScore(0.48, 2),
        )).toBe(true);
    });

    it("expands only a genuinely weak singleton without a score gain", () => {
        expect(shouldSelectMixedReferenceAlternative(
            [event("partialMove", 0.4)],
            [event("missingRing", 3), event("falseRing", 2)],
            setScore(0.5, 1),
            setScore(0.5, 2),
        )).toBe(true);
        expect(shouldSelectMixedReferenceAlternative(
            [event("partialMove", 1.2)],
            [event("missingRing", 3), event("falseRing", 2)],
            setScore(0.5, 1),
            setScore(0.5, 2),
        )).toBe(false);
    });

    it("does not regrow a weak partial supplement removed from a coherent unit chain", () => {
        const primary = pruneIncoherentPartialSupplements([
            chainEvent("newer-missing", "missingRing", 1920, -1, 0),
            chainEvent("older-missing", "missingRing", 1870, -2, -1),
            chainEvent("conflicting-partial", "partialMove", 1820, 3, 2),
        ]);
        expect(primary.map((item) => item.id)).toEqual([
            "newer-missing",
            "older-missing",
        ]);
        expect(primary[0].evidence.notes).toContain(
            "incoherent_partial_supplements_removed=1",
        );
        expect(shouldSelectMixedReferenceAlternative(
            primary,
            [...primary, chainEvent("alternate-extra", "missingRing", 1800, -3, -2)],
            setScore(0.4, 2),
            setScore(0.5, 3),
        )).toBe(false);
    });

    it("retains partial events with independent breakpoint evidence", () => {
        const partial = chainEvent(
            "supported-partial",
            "partialMove",
            1820,
            3,
            2,
            ["local_corrected_raw_breakpoint"],
        );
        const result = pruneIncoherentPartialSupplements([
            chainEvent("newer-missing", "missingRing", 1920, -1, 0),
            chainEvent("older-missing", "missingRing", 1870, -2, -1),
            partial,
        ]);
        expect(result).toHaveLength(3);
        expect(result).toContain(partial);
    });

    it("does not prune a partial event when a whole-series move is present", () => {
        const events = [
            chainEvent("newer-missing", "missingRing", 1920, -1, 0),
            chainEvent("older-missing", "missingRing", 1870, -2, -1),
            chainEvent("conflicting-partial", "partialMove", 1820, 3, 2),
            chainEvent("whole", "wholeSeriesMove", 1750, -2, -2),
        ];
        expect(pruneIncoherentPartialSupplements(events)).toBe(events);
    });
});

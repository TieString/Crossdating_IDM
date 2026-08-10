import { describe, expect, it } from "vitest";
import {
    shouldPreferRemotePairedMissingFrontier,
    type PairedCoreBreakpoint,
} from "../pairedCoreBreakpoint";
import type { DiagnosisEvent } from "../types";

const missingEvent = (correlationGain: number | null): DiagnosisEvent => ({
    id: "missing-1778-1784",
    seriesId: "targetA",
    eventType: "missingRing",
    startYear: 1778,
    endYear: 1784,
    rankedYears: [{ year: 1781, rank: 1, score: 1, evidenceTags: [] }],
    confidenceLevel: "low",
    evidence: {
        algorithmSources: ["candidate_ranking"],
        score: 1,
        scoreMargin: 0,
        baselineCorrelation: 0.35,
        correctedCorrelation: correlationGain === null ? null : 0.35 + correlationGain,
        correlationGain,
        lagBefore: -1,
        lagAfter: 3,
        samplePairs: 50,
        candidateIds: ["candidate"],
        notes: ["candidate_hard_gate_passed"],
    },
    alternativeTypes: [],
});

const paired: PairedCoreBreakpoint = {
    year: 1902,
    score: -0.051,
    remoteMargin: 0.0051,
    referenceCount: 1,
};

describe("pairwise cold-start paired frontier", () => {
    it("accepts a newer paired breakpoint when the unstable master edit has no gain", () => {
        expect(shouldPreferRemotePairedMissingFrontier(
            missingEvent(-0.007),
            paired,
            1798,
            true,
        )).toBe(true);
    });

    it("stays disabled for normal references and positive-gain master edits", () => {
        expect(shouldPreferRemotePairedMissingFrontier(
            missingEvent(-0.007),
            paired,
            1798,
            false,
        )).toBe(false);
        expect(shouldPreferRemotePairedMissingFrontier(
            missingEvent(0.02),
            paired,
            1798,
            true,
        )).toBe(false);
    });
});

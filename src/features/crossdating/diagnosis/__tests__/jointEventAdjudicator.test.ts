import { describe, expect, it } from "vitest";
import { adjudicateJointEventHypotheses } from "../jointEventAdjudicator";
import type {
    DiagnosisEvent,
    DiagnosisReviewEventCheckpoint,
    DiagnosisReviewSourceStage,
} from "../types";

const event = (
    id: string,
    eventType: DiagnosisEvent["eventType"],
    startYear: number,
    endYear: number,
    topYear: number,
    score = 1,
): DiagnosisEvent => ({
    id,
    seriesId: "TARGET",
    eventType,
    startYear,
    endYear,
    rankedYears: [{ year: topYear, rank: 1, score: 1, evidenceTags: [] }],
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: [],
        score,
        scoreMargin: score / 10,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.4,
        correlationGain: 0.2,
        lagBefore: eventType === "falseRing" ? 1 : -1,
        lagAfter: 0,
        samplePairs: 80,
        candidateIds: [id],
        notes: [],
    },
    alternativeTypes: [],
    ...(eventType === "partialMove" ? {
        shiftYears: -6,
        shiftSide: "older" as const,
    } : {}),
});

const checkpoint = (
    stage: DiagnosisReviewSourceStage,
    candidate: DiagnosisEvent,
): DiagnosisReviewEventCheckpoint => ({ stage, event: candidate });

describe("joint event adjudicator", () => {
    it("uses cross-stage survival instead of incomparable raw event scores", () => {
        const stable = event("stable", "missingRing", 1899, 1905, 1902, 0.4);
        const remoteRawPeak = event("raw-peak", "missingRing", 1940, 1952, 1946, 99);
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("candidate", stable),
            checkpoint("detected", stable),
            checkpoint("fused", stable),
            checkpoint("retained", stable),
            checkpoint("displayed", stable),
            checkpoint("final", stable),
            checkpoint("candidate", remoteRawPeak),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            reason: "selected",
            sourceStage: "final",
            event: {
                eventType: "missingRing",
                startYear: 1899,
                endYear: 1905,
            },
        });
        expect(decision.event?.evidence.candidateIds).toEqual(["stable"]);
    });

    it("refuses equally supported incompatible operations", () => {
        const missing = event("missing", "missingRing", 1899, 1905, 1902);
        const falseRing = event("false", "falseRing", 1899, 1905, 1902);
        const stages: DiagnosisReviewSourceStage[] = [
            "candidate", "detected", "fused", "retained",
        ];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            ...stages.map((stage) => checkpoint(stage, missing)),
            ...stages.map((stage) => checkpoint(stage, falseRing)),
        ]);

        expect(decision).toMatchObject({
            status: "refused",
            reason: "operation_conflict",
            event: null,
            operationMargin: 0,
        });
    });

    it("refuses equally supported remote modes of the same operation", () => {
        const older = event("older", "missingRing", 1799, 1805, 1802);
        const newer = event("newer", "missingRing", 1899, 1905, 1902);
        const stages: DiagnosisReviewSourceStage[] = [
            "candidate", "detected", "fused", "retained",
        ];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            ...stages.map((stage) => checkpoint(stage, older)),
            ...stages.map((stage) => checkpoint(stage, newer)),
        ]);

        expect(decision).toMatchObject({
            status: "refused",
            reason: "remote_mode_conflict",
            event: null,
            remoteModeMargin: 0,
        });
    });

    it("returns one complete immutable hypothesis and audits production agreement", () => {
        const selected = event("selected", "partialMove", 1899, 1905, 1902);
        const production = { ...selected, startYear: 1900, endYear: 1906 };
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("displayed", selected),
            checkpoint("final", selected),
        ], production);

        expect(decision).toMatchObject({
            status: "selected",
            productionAgreement: "same",
            productionExactMatch: false,
            event: {
                eventType: "partialMove",
                shiftYears: -6,
                shiftSide: "older",
                startYear: 1899,
                endYear: 1905,
            },
        });
        expect(decision.event?.evidence.candidateIds).toEqual(["selected"]);
        expect(decision.hypotheses).toHaveLength(1);
    });

    it("selects the newest final serial mode without treating older events as conflicts", () => {
        const olderPartial = event("older-partial", "partialMove", 1700, 1712, 1706);
        const olderFalse = event("older-false", "falseRing", 1790, 1798, 1794);
        const frontierFalse = event("frontier-false", "falseRing", 1810, 1818, 1814);
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("final", olderPartial),
            checkpoint("final", olderFalse),
            checkpoint("final", frontierFalse),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: {
                eventType: "falseRing",
                startYear: 1810,
                endYear: 1818,
            },
        });
    });

    it("still refuses incompatible operations inside the same final frontier", () => {
        const missing = event("missing", "missingRing", 1899, 1905, 1902);
        const falseRing = event("false", "falseRing", 1900, 1906, 1903);
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("final", missing),
            checkpoint("final", falseRing),
        ]);

        expect(decision).toMatchObject({
            status: "refused",
            reason: "operation_conflict",
            event: null,
        });
    });

    it("lets a sequential head resolve an unverified whole alias", () => {
        const whole = event("whole", "wholeSeriesMove", 1600, 2000, 0);
        whole.shiftYears = -5;
        const genericHead = event("generic-head", "missingRing", 1899, 1905, 1902);
        genericHead.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("final", whole),
            checkpoint("final", genericHead),
        ]);

        expect(decision.event?.eventType).toBe("missingRing");
    });

    it("allows independent per-reference missing evidence to resolve a whole alias", () => {
        const whole = event("whole", "wholeSeriesMove", 1600, 2000, 0);
        whole.shiftYears = -5;
        const independent = event("independent", "missingRing", 1899, 1905, 1902);
        independent.evidence.algorithmSources = [
            "per_reference_intermediate_lag_consensus",
        ];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("final", whole),
            checkpoint("final", independent),
        ]);

        expect(decision.event?.eventType).toBe("missingRing");
    });

    it("retains an earlier terminal whole baseline when final synthesis drops it", () => {
        const whole = event("terminal-whole", "wholeSeriesMove", 1600, 2000, 0);
        whole.shiftYears = -5;
        whole.evidence.notes = [
            "whole_baseline_source=cofecha_terminal_lag",
            "cofecha_terminal_segments=3",
            "cofecha_terminal_consistency=1.000000",
        ];
        const genericHead = event("generic-head", "missingRing", 1899, 1905, 1902);
        genericHead.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", whole),
            checkpoint("final", genericHead),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "detected",
            event: { eventType: "wholeSeriesMove", shiftYears: -5 },
        });
    });

    it("does not resurrect a terminal whole baseline already explained by a missing staircase", () => {
        const whole = event("terminal-whole", "wholeSeriesMove", 1600, 2000, 0);
        whole.shiftYears = -5;
        whole.evidence.notes = [
            "whole_baseline_source=cofecha_terminal_lag",
            "cofecha_terminal_segments=3",
            "cofecha_terminal_consistency=1.000000",
        ];
        const resolvedHead = event("resolved-head", "missingRing", 1899, 1905, 1902);
        resolvedHead.evidence.algorithmSources = [
            "sequential_missing_staircase_head",
            "sequential_missing_exhausts_whole_baseline",
        ];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", whole),
            checkpoint("final", resolvedHead),
        ]);

        expect(decision).toMatchObject({
            status: "selected",
            sourceStage: "final",
            event: { eventType: "missingRing" },
        });
    });

    it("resolves a terminal unit whole alias with a matching newer-end staircase", () => {
        const whole = event("terminal-unit", "wholeSeriesMove", 1600, 2000, 0);
        whole.shiftYears = -1;
        whole.evidence.notes = [
            "whole_baseline_source=cofecha_terminal_lag",
            "cofecha_terminal_segments=3",
            "cofecha_terminal_consistency=1.000000",
        ];
        const endpoint = event("endpoint", "missingRing", 1994, 2000, 1999);
        endpoint.evidence.algorithmSources = ["sequential_missing_staircase_head"];
        const decision = adjudicateJointEventHypotheses("TARGET", [
            checkpoint("detected", whole),
            checkpoint("final", endpoint),
        ]);

        expect(decision.event?.eventType).toBe("missingRing");
    });
});

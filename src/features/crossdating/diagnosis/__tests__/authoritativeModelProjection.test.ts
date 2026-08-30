import { describe, expect, it } from "vitest";
import { applyAuthoritativeModelDecision } from "../authoritativeModelProjection";
import type {
    AuthoritativeDiagnosisDecision,
    CrossdatingDiagnosis,
    DiagnosisEvent,
} from "../types";

const event = (
    eventType: DiagnosisEvent["eventType"],
    shiftYears: number | undefined,
): DiagnosisEvent => ({
    id: `old:${eventType}`,
    seriesId: "TARGET",
    eventType,
    startYear: 1900,
    endYear: 1912,
    rankedYears: [{ year: 1906, rank: 1, score: 2, evidenceTags: [] }],
    confidenceLevel: "high",
    evidence: {
        algorithmSources: ["segmented_diagnosis"],
        score: 2,
        scoreMargin: 0.4,
        baselineCorrelation: 0.3,
        correctedCorrelation: 0.5,
        correlationGain: 0.2,
        lagBefore: shiftYears ?? -1,
        lagAfter: 0,
        samplePairs: 80,
        candidateIds: [],
        notes: [],
    },
    alternativeTypes: [],
    ...(shiftYears === undefined ? {} : { shiftYears }),
});

const diagnosis = (primary: DiagnosisEvent): CrossdatingDiagnosis => ({
    createdAt: "2026-08-31T00:00:00.000Z",
    seriesCount: 1,
    problemSegmentCount: 1,
    candidateCount: 0,
    eventCount: 1,
    segmentLength: 50,
    overlap: 25,
    lagRange: { min: -100, max: 10 },
    lowCorrelationThreshold: 0.3,
    summaries: [],
    segments: [],
    propagationPatterns: [],
    globalSlidingMatches: [],
    masterNarrowYears: [],
    events: [primary],
    reviewEvents: [primary],
    candidates: [],
});

const decision = (
    values: Partial<AuthoritativeDiagnosisDecision>,
): AuthoritativeDiagnosisDecision => ({
    schemaVersion: 1,
    modelVersion: "applied-residual-unified-v12",
    authority: "authoritative",
    status: "selected",
    eventType: "partialMove",
    shiftYears: -6,
    startYear: 1930,
    endYear: 1938,
    topYear: 1934,
    identityGroup: "runtime|partialMove|-6",
    refusalReason: null,
    ...values,
});

describe("authoritative model projection", () => {
    it("refuses a selected identity that has no executable model package", () => {
        const result = applyAuthoritativeModelDecision(
            diagnosis(event("wholeSeriesMove", -6)),
            decision({}),
            "TARGET",
        );
        expect(result.events).toEqual([]);
        expect(result.reviewEvents).toEqual([]);
        expect(result.authoritativeModelDecision).toMatchObject({
            status: "error",
            refusalReason: "online_executable_package_contract_mismatch",
        });
    });

    it("rejects a package whose location differs from the model decision", () => {
        const executable = event("partialMove", -6);
        executable.id = "online-package:TARGET:partialMove:-6:1934";
        executable.startYear = 1950;
        executable.endYear = 1954;
        executable.rankedYears = [{ year: 1952, rank: 1, score: 4, evidenceTags: [] }];
        const result = applyAuthoritativeModelDecision(
            diagnosis(event("partialMove", -6)),
            decision({ packageId: executable.id }),
            "TARGET",
            executable,
        );
        expect(result.events).toEqual([]);
        expect(result.authoritativeModelDecision).toMatchObject({
            status: "error",
            refusalReason: "online_executable_package_contract_mismatch",
        });
    });

    it("uses a self-contained model package without borrowing an old event template", () => {
        const executable = event("partialMove", -6);
        executable.id = "online-package:TARGET:partialMove:-6:1934";
        executable.startYear = 1930;
        executable.endYear = 1938;
        executable.rankedYears = [{
            year: 1934,
            rank: 1,
            score: 4,
            evidenceTags: ["online_unified_model"],
        }];
        executable.evidence.candidateIds = [];
        const result = applyAuthoritativeModelDecision(
            diagnosis(event("wholeSeriesMove", -6)),
            decision({ packageId: executable.id }),
            "TARGET",
            executable,
        );
        expect(result.events).toEqual([executable]);
        expect(result.events[0]?.evidence.candidateIds).toEqual([]);
        expect(result.authoritativeModelDecision).toMatchObject({
            status: "selected",
            packageId: executable.id,
        });
    });

    it.each(["refused", "error"] as const)(
        "does not fall back to the old answer when the model is %s",
        (status) => {
            const result = applyAuthoritativeModelDecision(
                diagnosis(event("missingRing", undefined)),
                decision({
                    status,
                    eventType: "noEvent",
                    shiftYears: 0,
                    startYear: null,
                    endYear: null,
                    topYear: null,
                    identityGroup: null,
                    refusalReason: "test",
                }),
                "TARGET",
            );
            expect(result.events).toEqual([]);
            expect(result.reviewEvents).toEqual([]);
            expect(result.authoritativeModelDecision?.status).toBe(status);
        },
    );
});

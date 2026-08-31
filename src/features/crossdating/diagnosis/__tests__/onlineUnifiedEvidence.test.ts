import { describe, expect, it } from "vitest";

import {
    buildOnlineUnifiedExecutablePackage,
    buildOnlineUnifiedLocationPackages,
    buildOnlineUnifiedOperationCandidates,
    type OnlineUnifiedEvidenceBundle,
    type OnlineUnifiedLocationPackage,
    type OnlineUnifiedOperationCandidate,
} from "../onlineUnifiedEvidence";
import type { DiagnosisEvent, DiagnosisEventEvidence } from "../types";

const bundle = (): OnlineUnifiedEvidenceBundle => ({
    schemaVersion: 1,
    evidenceVersion: "online-unified-evidence-v1",
    seriesId: "TARGET",
    targetRange: { startYear: 1800, endYear: 1900 },
    cofechaFlagged: true,
    referenceSourceCount: 8,
    minimumReferenceDepth: 4,
    medianReferenceDepth: 7,
    candidateCount: 3,
    candidateModeCount: 2,
    finalReason: "event_selected",
    pass: {},
    claims: [
        {
            claimId: "one",
            stage: "final",
            eventType: "missingRing",
            shiftYears: -1,
            startYear: 1848,
            endYear: 1854,
            topYear: 1851,
            confidence: "high",
            score: 2,
            scoreMargin: 0.4,
            lagBefore: -1,
            lagAfter: 0,
            samplePairs: 80,
            baselineCorrelation: 0.2,
            correctedCorrelation: 0.5,
            correlationGain: 0.3,
            algorithmSources: ["counterfactual"],
            notes: [],
            candidateIds: [],
        },
        {
            claimId: "two",
            stage: "locator",
            eventType: "missingRing",
            shiftYears: -1,
            startYear: 1850,
            endYear: 1862,
            topYear: 1857,
            confidence: "medium",
            score: 1.4,
            scoreMargin: 0.2,
            lagBefore: -1,
            lagAfter: 0,
            samplePairs: 64,
            baselineCorrelation: 0.25,
            correctedCorrelation: 0.43,
            correlationGain: 0.18,
            algorithmSources: ["locator"],
            notes: [],
            candidateIds: [],
        },
    ],
    operations: [{
        eventType: "missingRing",
        shiftYears: -1,
        bestYear: 1851,
        dynamicScore: 2,
        bestRawGain: 0.2,
        bestDifferenceGain: 0.3,
        bestCombinedGain: 0.4,
        topThreeDifferenceGain: 0.25,
        remoteDifferenceMargin: 0.1,
        baselineLag: 0,
    }],
    dynamicSelection: null,
    unitSelection: null,
    rawGlobalLag: 0,
    cofechaGlobalLag: 0,
});

describe("online unified location packages", () => {
    it("selects the same compact window as the exhaustive package path", () => {
        const evidence = bundle();
        const identity = { eventType: "missingRing" as const, shiftYears: -1 };
        const exhaustive = buildOnlineUnifiedLocationPackages(evidence, identity, {
            compactWindowPerYear: false,
        });
        const expected = [...new Set(exhaustive.map((row) => row.topYear))].map((year) => (
            exhaustive.filter((row) => row.topYear === year).sort((left, right) => (
                Number(right.features.claim_window_top_exact_count)
                    - Number(left.features.claim_window_top_exact_count)
                || Number(right.features.claim_window_exact_count)
                    - Number(left.features.claim_window_exact_count)
                || Number(right.features.claim_window_max_overlap_ratio)
                    - Number(left.features.claim_window_max_overlap_ratio)
                || right.width - left.width
                || Math.abs(Number(left.features.window_center_delta_top))
                    - Math.abs(Number(right.features.window_center_delta_top))
                || left.startYear - right.startYear
            ))[0]!.packageId
        ));
        const compact = buildOnlineUnifiedLocationPackages(evidence, identity)
            .map((row) => row.packageId);
        expect(compact).toEqual(expected);
    });
});

const eventEvidence = (
    lagBefore: number,
    source: string,
): DiagnosisEventEvidence => ({
    algorithmSources: [source],
    score: 2,
    scoreMargin: 0.2,
    baselineCorrelation: 0.2,
    correctedCorrelation: 0.5,
    correlationGain: 0.3,
    lagBefore,
    lagAfter: 0,
    samplePairs: 80,
    candidateIds: ["legacy-candidate"],
    notes: [],
});

describe("online unified executable interpretation packages", () => {
    it("keeps model candidates unchanged when runtime interpretation sources are present", () => {
        const evidence = bundle();
        const before = buildOnlineUnifiedOperationCandidates(evidence);
        evidence.eventSources = [{
            stage: "strict",
            event: {
                id: "runtime-source-only",
                seriesId: "TARGET",
                eventType: "missingRing",
                startYear: 1848,
                endYear: 1854,
                rankedYears: [{
                    year: 1851,
                    rank: 1,
                    score: 2,
                    evidenceTags: [],
                }],
                confidenceLevel: "high",
                evidence: eventEvidence(-1, "runtime-source-only"),
                alternativeTypes: [],
            },
        }];

        expect(buildOnlineUnifiedOperationCandidates(evidence)).toEqual(before);
    });

    it("keeps a validated whole to partial to missing chain inside the model package", () => {
        const missing: DiagnosisEvent = {
            id: "source-missing",
            seriesId: "TARGET",
            eventType: "missingRing",
            startYear: 1847,
            endYear: 1853,
            rankedYears: [{
                year: 1850,
                rank: 1,
                score: 1.8,
                evidenceTags: ["unit-frontier"],
            }],
            confidenceLevel: "medium",
            evidence: eventEvidence(-1, "sequential_missing_staircase_head"),
            alternativeTypes: [],
        };
        const partial: DiagnosisEvent = {
            id: "source-partial",
            seriesId: "TARGET",
            eventType: "partialMove",
            startYear: 1848,
            endYear: 1854,
            rankedYears: [{
                year: 1851,
                rank: 1,
                score: 2,
                evidenceTags: ["partial-frontier"],
            }],
            confidenceLevel: "high",
            evidence: eventEvidence(-3, "continuous_partial_gap_interpretation"),
            alternativeTypes: ["missingRing"],
            shiftYears: -3,
            shiftSide: "older",
            interpretationAmbiguity: {
                kind: "missingRingsOrPartialMove",
                alternative: missing,
                evidence: {
                    missingRingCount: 3,
                    cumulativeShiftYears: -3,
                    missingYears: [],
                    partialFirstFixedYear: 1851,
                    normalizedCounterfactualGainDifference: 0.02,
                    masterMargin: 0.01,
                    referenceMedianMargin: 0.01,
                    referenceCount: 8,
                    missingReferenceSupport: 4,
                    partialReferenceSupport: 4,
                    countEvidence: "cumulativeLagOnly",
                },
            },
        };
        const whole: DiagnosisEvent = {
            id: "source-whole",
            seriesId: "TARGET",
            eventType: "wholeSeriesMove",
            startYear: 1800,
            endYear: 1900,
            rankedYears: [],
            confidenceLevel: "high",
            evidence: eventEvidence(-3, "bounded_constant_lag_baseline"),
            alternativeTypes: ["partialMove"],
            shiftYears: -3,
            seriesRange: { startYear: 1800, endYear: 1900 },
            interpretationAmbiguity: {
                kind: "wholeSeriesMoveOrLocalEvent",
                alternative: partial,
                evidence: {
                    wholeShiftYears: -3,
                    localEventType: "partialMove",
                    localWindowWidth: 7,
                    localEvidenceSource: "diagnosed",
                    operationScoreMargin: 0.02,
                    finalEvidenceClaims: [],
                },
            },
        };
        const evidence = bundle();
        evidence.eventSources = [{ stage: "joint", event: whole }];
        const candidate: OnlineUnifiedOperationCandidate = {
            packageId: "online-operation:TARGET|wholeSeriesMove:-3",
            identityGroup: "TARGET|wholeSeriesMove:-3",
            eventType: "wholeSeriesMove",
            shiftYears: -3,
            features: {},
        };

        const executable = buildOnlineUnifiedExecutablePackage({
            bundle: evidence,
            candidate,
            score: 3,
            scoreMargin: 0.3,
        })?.event;
        const local = executable?.interpretationAmbiguity?.alternative;
        const unit = local?.interpretationAmbiguity?.alternative;

        expect(executable?.eventType).toBe("wholeSeriesMove");
        expect(executable?.shiftYears).toBe(-3);
        expect(local?.eventType).toBe("partialMove");
        expect(local?.shiftYears).toBe(-3);
        expect(unit?.eventType).toBe("missingRing");
        expect(executable?.evidence.candidateIds).toEqual([]);
        expect(local?.evidence.candidateIds).toEqual([]);
        expect(unit?.evidence.candidateIds).toEqual([]);
        expect(local?.id).toContain(candidate.packageId);
        expect(unit?.id).toContain(candidate.packageId);
    });

    it("always gives a selected partial move one iterative missing-ring review", () => {
        const evidence = bundle();
        evidence.eventSources = [];
        const candidate: OnlineUnifiedLocationPackage = {
            packageId: "online-location:TARGET|partialMove:-6:1851:7:1848",
            identityGroup: "TARGET|partialMove:-6",
            eventType: "partialMove",
            shiftYears: -6,
            startYear: 1848,
            endYear: 1854,
            topYear: 1851,
            width: 7,
            features: {},
        };

        const executable = buildOnlineUnifiedExecutablePackage({
            bundle: evidence,
            candidate,
            score: 3,
            scoreMargin: 0.3,
        })?.event;
        const missing = executable?.interpretationAmbiguity?.alternative;

        expect(executable?.eventType).toBe("partialMove");
        expect(missing?.eventType).toBe("missingRing");
        expect(missing?.evidence.lagBefore).toBe(-1);
        expect(missing?.evidence.lagAfter).toBe(0);
        expect(missing?.evidence.candidateIds).toEqual([]);
    });

    it("completes a whole-to-partial source package that did not yet include missing review", () => {
        const partial: DiagnosisEvent = {
            id: "source-partial-without-review",
            seriesId: "TARGET",
            eventType: "partialMove",
            startYear: 1848,
            endYear: 1854,
            rankedYears: [{
                year: 1851,
                rank: 1,
                score: 2,
                evidenceTags: ["partial-frontier"],
            }],
            confidenceLevel: "high",
            evidence: eventEvidence(-4, "whole_local_event_interpretation"),
            alternativeTypes: [],
            shiftYears: -4,
            shiftSide: "older",
        };
        const whole: DiagnosisEvent = {
            ...partial,
            id: "source-whole-with-partial-only",
            eventType: "wholeSeriesMove",
            startYear: 1800,
            endYear: 1900,
            rankedYears: [],
            shiftSide: undefined,
            interpretationAmbiguity: {
                kind: "wholeSeriesMoveOrLocalEvent",
                alternative: partial,
                evidence: {
                    wholeShiftYears: -4,
                    localEventType: "partialMove",
                    localWindowWidth: 7,
                    localEvidenceSource: "diagnosed",
                    operationScoreMargin: 0.02,
                    finalEvidenceClaims: [],
                },
            },
        };
        const evidence = bundle();
        evidence.eventSources = [{ stage: "joint", event: whole }];
        const candidate: OnlineUnifiedOperationCandidate = {
            packageId: "online-operation:TARGET|wholeSeriesMove:-4",
            identityGroup: "TARGET|wholeSeriesMove:-4",
            eventType: "wholeSeriesMove",
            shiftYears: -4,
            features: {},
        };

        const executable = buildOnlineUnifiedExecutablePackage({
            bundle: evidence,
            candidate,
            score: 3,
            scoreMargin: 0.3,
        })?.event;
        const local = executable?.interpretationAmbiguity?.alternative;
        const missing = local?.interpretationAmbiguity?.alternative;

        expect(local?.eventType).toBe("partialMove");
        expect(missing?.eventType).toBe("missingRing");
        expect(missing?.reviewOnly).toBe(true);
    });

    it("keeps an independently diagnosed local shift when the whole head chose another shift", () => {
        const missing: DiagnosisEvent = {
            id: "source-whole-missing-review",
            seriesId: "TARGET",
            eventType: "missingRing",
            startYear: 1847,
            endYear: 1859,
            rankedYears: [{
                year: 1853,
                rank: 1,
                score: 2,
                evidenceTags: ["unit-frontier"],
            }],
            confidenceLevel: "medium",
            evidence: eventEvidence(-1, "whole_missing_review"),
            alternativeTypes: [],
        };
        const whole: DiagnosisEvent = {
            ...missing,
            id: "source-whole-with-direct-missing",
            eventType: "wholeSeriesMove",
            startYear: 1800,
            endYear: 1900,
            rankedYears: [],
            shiftYears: -11,
            interpretationAmbiguity: {
                kind: "wholeSeriesMoveOrMissingRing",
                alternative: missing,
                evidence: {
                    wholeShiftYears: -11,
                    endpointDistanceYears: 40,
                    missingWindowWidth: 13,
                    operationScoreMargin: 0.02,
                    finalEvidenceClaims: [],
                },
            },
        };
        const partial: DiagnosisEvent = {
            id: "source-independent-partial",
            seriesId: "TARGET",
            eventType: "partialMove",
            startYear: 1848,
            endYear: 1860,
            rankedYears: [{
                year: 1854,
                rank: 1,
                score: 8,
                evidenceTags: ["bounded-path-frontier"],
            }],
            confidenceLevel: "high",
            evidence: eventEvidence(-41, "bounded_complete_lag_path"),
            alternativeTypes: [],
            shiftYears: -41,
            shiftSide: "older",
        };
        const evidence = bundle();
        evidence.eventSources = [
            { stage: "strict", event: whole },
            { stage: "strict", event: partial },
        ];
        const candidate: OnlineUnifiedOperationCandidate = {
            packageId: "online-operation:TARGET|wholeSeriesMove:-11",
            identityGroup: "TARGET|wholeSeriesMove:-11",
            eventType: "wholeSeriesMove",
            shiftYears: -11,
            features: {},
        };

        const executable = buildOnlineUnifiedExecutablePackage({
            bundle: evidence,
            candidate,
            score: 3,
            scoreMargin: 0.3,
        })?.event;
        const local = executable?.interpretationAmbiguity?.alternative;
        const unit = local?.interpretationAmbiguity?.alternative;

        expect(executable).toMatchObject({
            eventType: "wholeSeriesMove",
            shiftYears: -11,
            interpretationAmbiguity: {
                kind: "wholeSeriesMoveOrLocalEvent",
            },
        });
        expect(local).toMatchObject({
            eventType: "partialMove",
            shiftYears: -41,
            startYear: 1848,
            endYear: 1860,
        });
        expect(unit).toMatchObject({
            eventType: "missingRing",
            reviewOnly: true,
        });
    });

    it("always gives a selected whole move one local-event review", () => {
        const evidence = bundle();
        evidence.eventSources = [];
        const candidate: OnlineUnifiedOperationCandidate = {
            packageId: "online-operation:TARGET|wholeSeriesMove:-11",
            identityGroup: "TARGET|wholeSeriesMove:-11",
            eventType: "wholeSeriesMove",
            shiftYears: -11,
            features: {},
        };

        const executable = buildOnlineUnifiedExecutablePackage({
            bundle: evidence,
            candidate,
            score: 3,
            scoreMargin: 0.3,
        })?.event;
        const local = executable?.interpretationAmbiguity?.alternative;

        expect(executable?.eventType).toBe("wholeSeriesMove");
        expect(local?.eventType).toBe("missingRing");
        expect(local?.reviewOnly).toBe(true);
        expect(local?.evidence.candidateIds).toEqual([]);
    });
});

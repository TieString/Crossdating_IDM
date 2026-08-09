import { describe, expect, it } from "vitest";
import { getDisplayedDiagnosisEvents } from "../eventDisplay";
import { stabilizeDiagnosisAcrossEvidenceRefresh } from "../evidenceRefreshAdjudicator";
import type {
    CrossdatingDiagnosis,
    DiagnosisEvent,
    DiagnosisEventAuditSnapshot,
    DiagnosisEventType,
} from "../types";

const makeEvent = (
    eventType: DiagnosisEventType,
    startYear: number,
    endYear: number,
    options: {
        topYear?: number;
        shiftYears?: number;
        sources?: string[];
        notes?: string[];
        lagBefore?: number;
        lagAfter?: number;
    } = {},
): DiagnosisEvent => ({
    id: `${eventType}-${startYear}-${endYear}`,
    seriesId: "TARGET",
    eventType,
    startYear,
    endYear,
    rankedYears: [{
        year: options.topYear ?? Math.round((startYear + endYear) / 2),
        rank: 1,
        score: 1,
        evidenceTags: [],
    }],
    confidenceLevel: "medium",
    evidence: {
        algorithmSources: options.sources ?? ["piecewise_lag_path"],
        score: 1,
        scoreMargin: 0.2,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.6,
        correlationGain: 0.4,
        lagBefore: options.lagBefore ?? null,
        lagAfter: options.lagAfter ?? null,
        samplePairs: 60,
        candidateIds: [],
        notes: options.notes ?? [],
    },
    alternativeTypes: [],
    ...(options.shiftYears !== undefined
        ? { shiftYears: options.shiftYears, shiftSide: "older" as const }
        : {}),
});

const snapshot = (event: DiagnosisEvent): DiagnosisEventAuditSnapshot => ({
    eventType: event.eventType,
    startYear: event.startYear,
    endYear: event.endYear,
    topYear: event.rankedYears[0]?.year ?? null,
    shiftYears: event.shiftYears ?? null,
    confidenceLevel: event.confidenceLevel,
    score: event.evidence.score,
    scoreMargin: event.evidence.scoreMargin,
    lagBefore: event.evidence.lagBefore,
    lagAfter: event.evidence.lagAfter,
    samplePairs: event.evidence.samplePairs,
    baselineCorrelation: event.evidence.baselineCorrelation,
    correctedCorrelation: event.evidence.correctedCorrelation,
    correlationGain: event.evidence.correlationGain,
    algorithmSources: event.evidence.algorithmSources,
    notes: event.evidence.notes,
});

const diagnosis = (
    displayed: DiagnosisEvent | null,
    hypotheses: DiagnosisEvent[] = displayed ? [displayed] : [],
    detachedStrong = false,
): CrossdatingDiagnosis => ({
    createdAt: new Date().toISOString(),
    seriesCount: 1,
    problemSegmentCount: 1,
    candidateCount: 0,
    eventCount: displayed ? 1 : 0,
    segmentLength: 50,
    overlap: 25,
    lagRange: { min: -10, max: 10 },
    lowCorrelationThreshold: 0.32,
    summaries: [],
    segments: [],
    propagationPatterns: [],
    globalSlidingMatches: [],
    masterNarrowYears: [],
    events: displayed ? [displayed] : [],
    candidates: [],
    reviewEvents: displayed ? [displayed] : [],
    eventDecisionAudits: [{
        seriesId: "TARGET",
        targetRange: { startYear: 1700, endYear: 2000 },
        cofechaFlagged: true,
        referenceSourceCount: 20,
        minimumReferenceDepth: 10,
        medianReferenceDepth: 18,
        candidateCount: 0,
        candidateModeCount: hypotheses.length,
        candidates: [],
        pass: {
            selectedReferencePass: "primary",
            cofechaDiagnosisAvailable: true,
            candidateEventCount: 0,
            lagPathEventCount: hypotheses.length,
            rawLagPathEventCount: hypotheses.length,
            assembledEventCount: hypotheses.length,
            jointRefinedEventCount: hypotheses.length,
            referenceVotedEventCount: hypotheses.length,
            recoveredEventCount: hypotheses.length,
            finalEventCount: displayed ? 1 : 0,
        },
        candidateProjectedEvents: [],
        detectedBeforeFusion: hypotheses.map(snapshot),
        detectedAfterFusion: [],
        retainedAfterEndpointGuard: [],
        displayedBeforeLocator: [],
        finalEvents: displayed ? [snapshot(displayed)] : [],
        ...(detachedStrong && displayed ? {
            locatorDecisions: [{
                reason: "accepted_detached_strong_mode" as const,
                accepted: true,
                overlapYears: 0,
                centerDistanceYears: 20,
                operationContractValid: true,
                detachedEvidenceStrong: true,
                preLocatorEvent: snapshot(displayed),
                proposedEvent: snapshot(displayed),
                selectedEvent: snapshot(displayed),
            }],
        } : {}),
        automaticSemanticsRejectedCount: 0,
        finalReason: displayed ? "emitted" : "ensemble_gate_rejected",
    }],
});

describe("diagnosis evidence refresh adjudication", () => {
    it("retains a cross-supported missing ring over a fresh terminal whole alias", () => {
        const missing = makeEvent("missingRing", 1973, 1981, {
            topYear: 1977,
            lagBefore: -1,
            lagAfter: 0,
        });
        const whole = makeEvent("wholeSeriesMove", 1600, 2000, {
            shiftYears: -1,
            notes: ["whole_state_global_lag_matches_shift=false"],
        });
        const result = stabilizeDiagnosisAcrossEvidenceRefresh(
            diagnosis(missing),
            diagnosis(whole, [whole, missing]),
            "TARGET",
        );

        expect(result.decision).toMatchObject({
            selectedEvidence: "previous",
            reason: "previous_cross_supported_operation",
            operationChanged: true,
        });
        expect(getDisplayedDiagnosisEvents(result.diagnosis)[0]).toMatchObject({
            eventType: "missingRing",
            reviewOnly: true,
        });
    });

    it("accepts a fresh missing-ring staircase that decisively resolves a prior partial", () => {
        const partial = makeEvent("partialMove", 1797, 1809, {
            topYear: 1803,
            shiftYears: -2,
            lagBefore: -2,
            lagAfter: 0,
        });
        const missing = makeEvent("missingRing", 1800, 1806, {
            topYear: 1803,
            lagBefore: -1,
            lagAfter: 0,
            sources: [
                "explicit_partial_vs_missing_staircase",
                "robust_per_reference_missing_staircase",
                "sequential_missing_staircase_head",
            ],
        });
        const result = stabilizeDiagnosisAcrossEvidenceRefresh(
            diagnosis(partial, [partial, missing]),
            diagnosis(missing, [partial, missing]),
            "TARGET",
        );

        expect(result.decision).toMatchObject({
            selectedEvidence: "fresh",
            reason: "fresh_decisive_operation_evidence",
        });
        expect(getDisplayedDiagnosisEvents(result.diagnosis)[0].eventType)
            .toBe("missingRing");
    });

    it("does not turn a partial move into a missing ring on generic joint evidence alone", () => {
        const partial = makeEvent("partialMove", 1797, 1809, {
            topYear: 1803,
            shiftYears: -2,
            lagBefore: -2,
            lagAfter: 0,
        });
        const missing = makeEvent("missingRing", 1800, 1806, {
            topYear: 1803,
            lagBefore: -1,
            lagAfter: 0,
            sources: [
                "decisive_joint_operation_fusion",
                "joint_year_operation_evidence",
            ],
        });
        const result = stabilizeDiagnosisAcrossEvidenceRefresh(
            diagnosis(partial, [partial, missing]),
            diagnosis(missing, [partial, missing]),
            "TARGET",
        );

        expect(result.decision.reason).toBe("previous_operation_conflict_retained");
        expect(getDisplayedDiagnosisEvents(result.diagnosis)[0].eventType)
            .toBe("partialMove");
    });

    it("does not block a newly decisive true whole-series state", () => {
        const partial = makeEvent("partialMove", 1797, 1809, {
            shiftYears: -6,
        });
        const whole = makeEvent("wholeSeriesMove", 1600, 2000, {
            shiftYears: -6,
            notes: ["whole_state_global_lag_matches_shift=true"],
        });
        const result = stabilizeDiagnosisAcrossEvidenceRefresh(
            diagnosis(partial, [partial, whole]),
            diagnosis(whole, [partial, whole]),
            "TARGET",
        );

        expect(result.decision).toMatchObject({
            selectedEvidence: "fresh",
            reason: "fresh_decisive_operation_evidence",
        });
    });

    it("uses a compatible fresh refinement of the same event", () => {
        const previous = makeEvent("missingRing", 1971, 1979, { topYear: 1977 });
        const fresh = makeEvent("missingRing", 1973, 1981, { topYear: 1977 });
        const result = stabilizeDiagnosisAcrossEvidenceRefresh(
            diagnosis(previous),
            diagnosis(fresh),
            "TARGET",
        );

        expect(result.decision.reason).toBe("fresh_compatible_update");
        expect(getDisplayedDiagnosisEvents(result.diagnosis)[0].startYear).toBe(1973);
    });

    it("retains the previous window when fresh evidence jumps to an unsupported remote mode", () => {
        const previous = makeEvent("falseRing", 1800, 1808, { topYear: 1804 });
        const fresh = makeEvent("falseRing", 1840, 1848, { topYear: 1844 });
        const result = stabilizeDiagnosisAcrossEvidenceRefresh(
            diagnosis(previous),
            diagnosis(fresh),
            "TARGET",
        );

        expect(result.decision.reason).toBe("previous_detached_location_retained");
        expect(getDisplayedDiagnosisEvents(result.diagnosis)[0].rankedYears[0].year)
            .toBe(1804);
    });

    it("accepts a detached fresh window only when the locator recorded strong evidence", () => {
        const previous = makeEvent("falseRing", 1800, 1808, { topYear: 1804 });
        const fresh = makeEvent("falseRing", 1840, 1848, { topYear: 1844 });
        const result = stabilizeDiagnosisAcrossEvidenceRefresh(
            diagnosis(previous),
            diagnosis(fresh, [fresh], true),
            "TARGET",
        );

        expect(result.decision.reason).toBe("fresh_decisive_detached_location");
        expect(getDisplayedDiagnosisEvents(result.diagnosis)[0].rankedYears[0].year)
            .toBe(1844);
    });

    it("recovers a previous event when fresh review hides the same internal hypothesis", () => {
        const previous = makeEvent("missingRing", 1900, 1908, { topYear: 1904 });
        const result = stabilizeDiagnosisAcrossEvidenceRefresh(
            diagnosis(previous),
            diagnosis(null, [previous]),
            "TARGET",
        );

        expect(result.decision.reason).toBe("previous_supported_hidden_hypothesis");
        expect(getDisplayedDiagnosisEvents(result.diagnosis)[0].eventType)
            .toBe("missingRing");
    });

    it("does not keep a previous event when fresh evidence contains no matching hypothesis", () => {
        const previous = makeEvent("missingRing", 1900, 1908, { topYear: 1904 });
        const result = stabilizeDiagnosisAcrossEvidenceRefresh(
            diagnosis(previous),
            diagnosis(null, []),
            "TARGET",
        );

        expect(result.decision).toMatchObject({
            selectedEvidence: "fresh",
            reason: "fresh_no_supported_replacement",
        });
        expect(getDisplayedDiagnosisEvents(result.diagnosis)).toEqual([]);
    });
});

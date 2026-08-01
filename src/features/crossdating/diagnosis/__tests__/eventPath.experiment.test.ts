import { describe, expect, it } from "vitest";
import { getConfig } from "../config";
import { diagnoseCrossdating } from "../engine";
import { scanCounterfactualCandidates } from "../counterfactualEventScan";
import { makeDiagnosisEventsFromCandidates } from "../events";
import { scanPartialMoveCandidates } from "../partialMoveEventScan";
import { locateGlobalEditEvents } from "../globalEditAlignment";
import { locateLagPathEvents } from "../eventPath";
import { locateReturnToZeroEvents } from "../transitionScan";
import { cofechaStyleStandardize } from "../../reference";
import {
    compareDiagnosisCandidates,
    dedupeDiagnosisCandidates,
    rankDiagnosisCandidates,
} from "../candidateUtils";
import { diagnoseSeriesCore } from "../segments";
import type { DiagnosisCandidateOperation, DiagnosisEvent, DiagnosisEventType } from "../types";
import {
    buildLeaveOneOutMaster,
    buildSyntheticSite,
    createEndAnchoredFalseRingCase,
    createEndAnchoredMissingRingCase,
    createPartialRangeMoveCase,
    getEligibleSeriesForSyntheticTests,
    groupEligibleSeries,
    loadRdmFixture,
    pickExploratoryStrongSignalYear,
    sampleAcross,
    type RwlSeries,
} from "./rdmFixture";
import { matchDiagnosisEvents, type TruthEvent } from "./eventMetrics";

const fixture = loadRdmFixture();
const d = fixture.available ? describe : describe.skip;
const eligible = fixture.available ? getEligibleSeriesForSyntheticTests(fixture.series) : [];
const groups = groupEligibleSeries(eligible);
const targets = sampleAcross(
    groups.eligibleLongSeries.length >= 5 ? groups.eligibleLongSeries : eligible,
    5,
).slice(0, 12);

let latestCandidates: DiagnosisCandidateOperation[] = [];

type Aggregate = {
    cases: number;
    truths: number;
    predictions: number;
    matched: number;
    complete: number;
    widths: number[];
    ranks: number[];
};

const empty = (): Aggregate => ({
    cases: 0,
    truths: 0,
    predictions: 0,
    matched: 0,
    complete: 0,
    widths: [],
    ranks: [],
});

const add = (aggregate: Aggregate, truth: TruthEvent[], predictions: DiagnosisEvent[]) => {
    const result = matchDiagnosisEvents(truth, predictions);
    aggregate.cases += 1;
    aggregate.truths += result.truthCount;
    aggregate.predictions += result.predictionCount;
    aggregate.matched += result.matchedCount;
    aggregate.complete += result.completeCaseSuccess ? 1 : 0;
    aggregate.widths.push(...result.widths);
    aggregate.ranks.push(...result.ranks);
};

const summary = (aggregate: Aggregate) => ({
    cases: aggregate.cases,
    recall: aggregate.matched / Math.max(1, aggregate.truths),
    precision: aggregate.matched / Math.max(1, aggregate.predictions),
    complete: aggregate.complete / Math.max(1, aggregate.cases),
    predictions: aggregate.predictions,
    meanWidth: aggregate.widths.reduce((sum, value) => sum + value, 0) / Math.max(1, aggregate.widths.length),
    meanRank: aggregate.ranks.reduce((sum, value) => sum + value, 0) / Math.max(1, aggregate.ranks.length),
});

const markerYear = (series: RwlSeries): number | null => {
    const master = buildLeaveOneOutMaster(fixture.series, series.id);
    if (master.skipped) return null;
    return pickExploratoryStrongSignalYear(series, master.masterValuesByYear, {
        lo: series.startYear + 45,
        hi: series.endYear - 45,
    });
};

const locate = (series: RwlSeries, corrupted: Map<number, number>): DiagnosisEvent[] => {
    const built = buildSyntheticSite(fixture.series, series.id, corrupted);
    if (!built.site) return [];
    if (process.env.EVENT_METHOD === "deployed") {
        latestCandidates = [];
        return diagnoseCrossdating(built.site, { referenceConfig: null }).events
            .filter((event) => event.seriesId === series.id);
    }
    const effectiveConfig = getConfig({ referenceConfig: null });
    const cofechaPreprocess = (seriesValues: Map<number, number>) => new Map(
        cofechaStyleStandardize(seriesValues).map((point) => [point.year, point.value]),
    );
    const useCofechaCore = process.env.EVENT_METHOD === "cofecha-path"
        || process.env.EVENT_METHOD === "transition-scan"
        || process.env.EVENT_METHOD === "hybrid";
    const diagnosis = diagnoseSeriesCore(
        built.site,
        series.id,
        effectiveConfig,
        useCofechaCore ? cofechaPreprocess : undefined,
    );
    if (!diagnosis) return [];
    if (process.env.EVENT_METHOD === "cofecha-path") {
        latestCandidates = [];
        return locateLagPathEvents(diagnosis, built.site, {
            useCofechaStandardization: true,
            transitionPenaltyUnit: Number(process.env.PATH_UNIT_PENALTY ?? "7.5"),
            transitionPenaltyBig: Number(process.env.PATH_BIG_PENALTY ?? "9.5"),
            transitionPenaltyPerYear: Number(process.env.PATH_PER_YEAR ?? "1.5"),
            minTransitionGain: Number(process.env.PATH_MIN_GAIN ?? "2.5"),
            minRunYears: Number(process.env.PATH_MIN_RUN ?? "10"),
            missingBoundaryYearAdjustment: Number(process.env.PATH_MISSING_ADJUSTMENT
                ?? process.env.PATH_BOUNDARY_ADJUSTMENT ?? "0"),
            falseBoundaryYearAdjustment: Number(process.env.PATH_FALSE_ADJUSTMENT
                ?? process.env.PATH_BOUNDARY_ADJUSTMENT ?? "0"),
            partialBoundaryYearAdjustment: Number(process.env.PATH_PARTIAL_ADJUSTMENT
                ?? process.env.PATH_BOUNDARY_ADJUSTMENT ?? "0"),
        });
    }
    if (process.env.EVENT_METHOD === "transition-scan") {
        latestCandidates = [];
        const events = locateReturnToZeroEvents(diagnosis, {
            minGain: Number(process.env.TRANSITION_MIN_GAIN ?? "3"),
            minRunYears: Number(process.env.TRANSITION_MIN_RUN ?? "18"),
            rawWeight: Number(process.env.TRANSITION_RAW_WEIGHT ?? "0.3"),
            differenceWeight: Number(process.env.TRANSITION_DIFF_WEIGHT ?? "0.7"),
        });
        return process.env.TRANSITION_BEST_ONLY === "1"
            ? events.sort((a, b) => b.evidence.score - a.evidence.score).slice(0, 1)
            : events;
    }
    if (process.env.EVENT_METHOD === "hybrid") {
        latestCandidates = [];
        const deployed = diagnoseCrossdating(built.site, { referenceConfig: null }).events
            .filter((event) => event.seriesId === series.id);
        const path = locateLagPathEvents(diagnosis, built.site, {
            useCofechaStandardization: true,
            transitionPenaltyUnit: 9.5,
            transitionPenaltyBig: 11.5,
            minTransitionGain: 1,
        });
        const selector = process.env.HYBRID_SELECTOR ?? "union";
        if (selector !== "union") {
            const eventTypes: DiagnosisEventType[] = [
                "missingRing",
                "falseRing",
                "partialMove",
                "wholeSeriesMove",
            ];
            return eventTypes.flatMap((eventType) => {
                const pathMatches = path
                    .filter((event) => event.eventType === eventType)
                    .sort((a, b) => b.evidence.score - a.evidence.score);
                const deployedMatches = deployed
                    .filter((event) => event.eventType === eventType)
                    .sort((a, b) => b.evidence.score - a.evidence.score);
                if (selector === "path-first") {
                    return pathMatches[0] ? [pathMatches[0]] : deployedMatches[0] ? [deployedMatches[0]] : [];
                }
                if (selector === "candidate-first") {
                    return deployedMatches[0] ? [deployedMatches[0]] : pathMatches[0] ? [pathMatches[0]] : [];
                }
                if (selector === "partial-path") {
                    const preferred = eventType === "partialMove" ? pathMatches : deployedMatches;
                    const fallback = eventType === "partialMove" ? deployedMatches : pathMatches;
                    return preferred[0] ? [preferred[0]] : fallback[0] ? [fallback[0]] : [];
                }
                return [];
            });
        }
        const selected: DiagnosisEvent[] = [];
        [...path, ...deployed]
            .sort((a, b) => b.evidence.score - a.evidence.score)
            .forEach((event) => {
                const duplicate = selected.some((other) => (
                    other.eventType === event.eventType
                    && Math.max(other.startYear, event.startYear)
                        <= Math.min(other.endYear, event.endYear)
                ));
                if (!duplicate) selected.push(event);
            });
        return selected;
    }
    if (process.env.EVENT_METHOD === "global-align") {
        latestCandidates = [];
        return locateGlobalEditEvents(diagnosis, {
            gapPenalty: Number(process.env.ALIGN_GAP_PENALTY ?? "1.35"),
            minimumScoreGain: Number(process.env.ALIGN_MIN_GAIN ?? "1.5"),
            maximumEdits: Number(process.env.ALIGN_MAX_EDITS ?? "5"),
        });
    }
    if (process.env.EVENT_METHOD === "ensemble") {
        const deployed = diagnoseCrossdating(built.site, { referenceConfig: null });
        const ownDeployed = deployed.candidates.filter((candidate) => candidate.targetTree === series.id);
        const allowedOperations = new Set(ownDeployed.map((candidate) => candidate.operationType));
        const broad = scanCounterfactualCandidates(built.site, diagnosis, effectiveConfig)
            .filter((candidate) => allowedOperations.has(candidate.operationType))
            .filter((candidate) => {
                const beforeLag = candidate.evidence.evaluationDelta?.dominantLagBefore
                    ?? candidate.evidence.before.bestLag;
                const afterLag = candidate.evidence.evaluationDelta?.dominantLagAfter
                    ?? candidate.evidence.after.bestLag;
                if (candidate.operationType === "INSERT_MISSING_RING") {
                    return beforeLag === -1 && Math.abs(afterLag) < 1;
                }
                if (candidate.operationType === "DELETE_FALSE_RING") {
                    return beforeLag === 1 && Math.abs(afterLag) < 1;
                }
                return false;
            });
        latestCandidates = rankDiagnosisCandidates(dedupeDiagnosisCandidates([
            ...ownDeployed,
            ...broad,
        ])).sort(compareDiagnosisCandidates);
        const projected = makeDiagnosisEventsFromCandidates([diagnosis], latestCandidates);
        const bestLocalByType = new Map<DiagnosisEventType, DiagnosisEvent>();
        projected.forEach((event) => {
            if (event.eventType === "wholeSeriesMove" || event.eventType === "partialMove") return;
            const current = bestLocalByType.get(event.eventType);
            if (!current || event.evidence.score > current.evidence.score) {
                bestLocalByType.set(event.eventType, event);
            }
        });
        const local = Array.from(bestLocalByType.values());
        const moves = projected.filter((event) => (
            event.eventType === "wholeSeriesMove" || event.eventType === "partialMove"
        ));
        return [...local, ...moves];
    }
    if (process.env.EVENT_METHOD === "partial") {
        const maximumEvaluations = Number(process.env.PARTIAL_EVALS ?? "10");
        const minimumCompositeGain = Number(process.env.PARTIAL_GAIN ?? "0.025");
        const peaksPerShift = Number(process.env.PARTIAL_PEAKS ?? "2");
        const boundaryEvidenceWeight = Number(process.env.PARTIAL_BOUNDARY_WEIGHT ?? "0.55");
        const rawGainWeight = Number(process.env.PARTIAL_RAW_WEIGHT ?? "0.2");
        const firstDifferenceGainWeight = Number(process.env.PARTIAL_DIFF_WEIGHT ?? "0.25");
        const localReferenceCount = Number(process.env.PARTIAL_REFERENCE_COUNT ?? "5");
        const newerAnchorYears = Number(process.env.PARTIAL_ANCHOR_YEARS ?? "45");
        const maximumReturnedCandidates = Number(process.env.PARTIAL_RETURNED ?? "1");
        const splitEvidenceWeight = Number(process.env.PARTIAL_SPLIT_WEIGHT ?? "0");
        const cumulativeEvidenceWeight = Number(process.env.PARTIAL_CUMULATIVE_WEIGHT ?? "0");
        latestCandidates = scanPartialMoveCandidates(built.site, diagnosis, effectiveConfig, {
            maximumEvaluations,
            minimumCompositeGain,
            peaksPerShift,
            boundaryEvidenceWeight,
            rawGainWeight,
            firstDifferenceGainWeight,
            localReferenceCount,
            newerAnchorYears,
            maximumReturnedCandidates,
            splitEvidenceWeight,
            cumulativeEvidenceWeight,
        });
        return makeDiagnosisEventsFromCandidates([diagnosis], latestCandidates);
    }
    latestCandidates = scanCounterfactualCandidates(built.site, diagnosis, effectiveConfig);
    return makeDiagnosisEventsFromCandidates([diagnosis], latestCandidates);
};

d("piecewise-lag path experiment", () => {
    it("prints strict single-event and clean diagnostics", () => {
        const metrics: Record<Exclude<DiagnosisEventType, "wholeSeriesMove">, Aggregate> = {
            missingRing: empty(),
            falseRing: empty(),
            partialMove: empty(),
        };
        let cleanCases = 0;
        let cleanFalsePositives = 0;
        const examples: unknown[] = [];

        targets.forEach((series, index) => {
            const year = markerYear(series);
            if (year === null) return;

            const missing = createEndAnchoredMissingRingCase(series, year);
            const missingPredictions = locate(series, missing.corrupted);
            add(metrics.missingRing, [{
                id: `${series.id}-missing`, seriesId: series.id, eventType: "missingRing", year,
            }], missingPredictions);

            const falseRing = createEndAnchoredFalseRingCase(
                series,
                year,
                (["average", "moderate", "splitLike"] as const)[index % 3],
            );
            const falsePredictions = locate(series, falseRing.corrupted);
            add(metrics.falseRing, [{
                id: `${series.id}-false`, seriesId: series.id, eventType: "falseRing", year,
            }], falsePredictions);

            const gapYears = ([2, 3, 4, 5, 6, 8] as const)[index % 6];
            const partial = createPartialRangeMoveCase(series, year, gapYears);
            const partialPredictions = locate(series, partial.corrupted);
            const partialCandidateSnapshot = latestCandidates.map((candidate) => ({
                type: candidate.operationType,
                year: candidate.targetYear,
                score: candidate.score,
                strength: candidate.candidateStrength,
                before: candidate.evidence.evaluationDelta?.dominantLagBefore,
                after: candidate.evidence.evaluationDelta?.dominantLagAfter,
                bBefore: candidate.evidence.evaluationDelta?.bLikeCountBefore,
                bAfter: candidate.evidence.evaluationDelta?.bLikeCountAfter,
                lagRecovery: candidate.evidence.evaluationDelta?.lagRecoveryScore,
                wholeDelta: candidate.evidence.evaluationDelta?.wholeSeriesRDelta,
                localDelta: candidate.evidence.evaluationDelta?.localBoundaryRDelta,
                gates: candidate.evidence.evaluationDelta?.hardGatePassedConditions,
            }));
            add(metrics.partialMove, [{
                id: `${series.id}-partial`,
                seriesId: series.id,
                eventType: "partialMove",
                year,
                shiftYears: -gapYears,
                shiftSide: "older",
            }], partialPredictions);

            const cleanPredictions = locate(series, series.valuesByYear);
            cleanCases += 1;
            if (cleanPredictions.length > 0) cleanFalsePositives += 1;

            if (examples.length < 12) {
                examples.push({
                    seriesId: series.id,
                    year,
                    injectedShift: gapYears,
                    missing: missingPredictions.map((event) => ({
                        type: event.eventType,
                        range: [event.startYear, event.endYear],
                        score: event.evidence.score,
                        source: event.evidence.algorithmSources,
                    })),
                    falseRing: falsePredictions.map((event) => ({
                        type: event.eventType,
                        range: [event.startYear, event.endYear],
                        score: event.evidence.score,
                        source: event.evidence.algorithmSources,
                    })),
                    partial: partialPredictions.map((event) => ({
                        type: event.eventType,
                        range: [event.startYear, event.endYear],
                        shiftYears: event.shiftYears,
                        score: event.evidence.score,
                        lags: [event.evidence.lagBefore, event.evidence.lagAfter],
                    })),
                    partialCandidates: partialCandidateSnapshot,
                    clean: cleanPredictions.map((event) => ({
                        type: event.eventType,
                        range: [event.startYear, event.endYear],
                        score: event.evidence.score,
                        lags: [event.evidence.lagBefore, event.evidence.lagAfter],
                    })),
                });
            }
        });

        const report = {
            missingRing: summary(metrics.missingRing),
            falseRing: summary(metrics.falseRing),
            partialMove: summary(metrics.partialMove),
            clean: {
                cases: cleanCases,
                falsePositiveRate: cleanFalsePositives / Math.max(1, cleanCases),
            },
        };
        // eslint-disable-next-line no-console
        console.log(`EVENT_PATH_EXPERIMENT ${JSON.stringify(report)}`);
        // eslint-disable-next-line no-console
        console.log(`EVENT_PATH_EXAMPLES ${JSON.stringify(examples)}`);
        expect(targets.length).toBeGreaterThanOrEqual(5);
    });
});

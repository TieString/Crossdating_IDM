import { describe, expect, it } from "vitest";
import { getConfig } from "../config";
import { locateLagPathEvents } from "../eventPath";
import { verifyDiagnosisEvent } from "../eventVerification";
import { diagnoseSeriesCore } from "../segments";
import type { DiagnosisEvent, DiagnosisEventType } from "../types";
import { cofechaStyleStandardize } from "../../reference";
import {
    buildLeaveOneOutMaster,
    buildSyntheticSite,
    createEndAnchoredFalseRingCase,
    createEndAnchoredMissingRingCase,
    createPartialRangeMoveCase,
    getEligibleSeriesForSyntheticTests,
    loadDataFolder,
    pickExploratoryStrongSignalYear,
    sampleAcross,
    type RwlSeries,
} from "./rdmFixture";
import { matchDiagnosisEvents, type TruthEvent } from "./eventMetrics";
import { diagnoseTargetEvents } from "./targetDiagnosis";

const TRAIN_FOLDERS = ["EBD", "EBM", "RDM", "RDU"];
const TUNE_FOLDERS = ["EBU", "ZSD"];

let latestSourceComparison: { path: DiagnosisEvent[]; deployed: DiagnosisEvent[] } = {
    path: [],
    deployed: [],
};

type Aggregate = {
    cases: number;
    answeredCases: number;
    truths: number;
    predictions: number;
    matched: number;
    complete: number;
    widths: number[];
    ranks: number[];
    top1Exact: number;
    top1WithinOne: number;
    olderEdgeNearMisses: number;
    newerEdgeNearMisses: number;
    topYearErrors: number[];
};

const empty = (): Aggregate => ({
    cases: 0,
    answeredCases: 0,
    truths: 0,
    predictions: 0,
    matched: 0,
    complete: 0,
    widths: [],
    ranks: [],
    top1Exact: 0,
    top1WithinOne: 0,
    olderEdgeNearMisses: 0,
    newerEdgeNearMisses: 0,
    topYearErrors: [],
});

const add = (aggregate: Aggregate, truths: TruthEvent[], predictions: DiagnosisEvent[]) => {
    const result = matchDiagnosisEvents(truths, predictions);
    aggregate.cases += 1;
    aggregate.answeredCases += predictions.length > 0 ? 1 : 0;
    aggregate.truths += result.truthCount;
    aggregate.predictions += result.predictionCount;
    aggregate.matched += result.matchedCount;
    aggregate.complete += result.completeCaseSuccess ? 1 : 0;
    aggregate.widths.push(...result.widths);
    aggregate.ranks.push(...result.ranks);
    result.matches.forEach(({ truth, prediction }) => {
        const topYear = prediction.rankedYears[0]?.year;
        if (topYear === undefined) return;
        const error = topYear - truth.year;
        aggregate.topYearErrors.push(error);
        if (error === 0) aggregate.top1Exact += 1;
        if (Math.abs(error) <= 1) aggregate.top1WithinOne += 1;
    });
    result.missedTruthIds.forEach((truthId) => {
        const truth = truths.find((candidate) => candidate.id === truthId);
        if (!truth) return;
        const compatible = predictions.filter((prediction) => (
            prediction.seriesId === truth.seriesId
            && prediction.eventType === truth.eventType
            && (truth.eventType !== "partialMove"
                || (prediction.shiftYears === truth.shiftYears
                    && prediction.shiftSide === truth.shiftSide))
        ));
        if (compatible.some((prediction) => truth.year === prediction.startYear - 1)) {
            aggregate.olderEdgeNearMisses += 1;
        } else if (compatible.some((prediction) => truth.year === prediction.endYear + 1)) {
            aggregate.newerEdgeNearMisses += 1;
        }
    });
};

const quantile = (values: number[], p: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};

const summarize = (aggregate: Aggregate) => ({
    cases: aggregate.cases,
    responseRate: aggregate.answeredCases / Math.max(1, aggregate.cases),
    abstentionRate: 1 - aggregate.answeredCases / Math.max(1, aggregate.cases),
    recall: aggregate.matched / Math.max(1, aggregate.truths),
    precision: aggregate.matched / Math.max(1, aggregate.predictions),
    complete: aggregate.complete / Math.max(1, aggregate.cases),
    predictions: aggregate.predictions,
    medianWidth: quantile(aggregate.widths, 0.5),
    p90Width: quantile(aggregate.widths, 0.9),
    medianRank: quantile(aggregate.ranks, 0.5),
    top1ExactOverall: aggregate.top1Exact / Math.max(1, aggregate.truths),
    top1ExactCovered: aggregate.top1Exact / Math.max(1, aggregate.matched),
    top1WithinOneCovered: aggregate.top1WithinOne / Math.max(1, aggregate.matched),
    olderEdgeNearMisses: aggregate.olderEdgeNearMisses,
    newerEdgeNearMisses: aggregate.newerEdgeNearMisses,
    medianTopYearError: quantile(aggregate.topYearErrors, 0.5),
});

const eventSummary = (events: DiagnosisEvent[]) => events.map((event) => ({
    type: event.eventType,
    range: [event.startYear, event.endYear],
    shiftYears: event.shiftYears,
    score: event.evidence.score,
    topYear: event.rankedYears[0]?.year,
    rankedYears: event.rankedYears.map(({ year, rank, score }) => ({ year, rank, score })),
    lags: [event.evidence.lagBefore, event.evidence.lagAfter],
    source: event.evidence.algorithmSources,
    notes: event.evidence.notes,
}));

const rankingSummary = (truthYear: number, events: DiagnosisEvent[]) => events.map((event) => ({
    range: [event.startYear, event.endYear],
    topYear: event.rankedYears[0]?.year,
    truthRank: event.rankedYears.find((row) => row.year === truthYear)?.rank,
    sources: event.evidence.algorithmSources,
    refinement: event.evidence.notes.find((note) => note.startsWith("window_refinement=")),
    notes: event.evidence.notes,
}));

const markerYear = (
    allSeries: Map<string, RwlSeries>,
    series: RwlSeries,
): number | null => {
    const master = buildLeaveOneOutMaster(allSeries, series.id);
    if (master.skipped) return null;
    return pickExploratoryStrongSignalYear(series, master.masterValuesByYear, {
        lo: series.startYear + 45,
        hi: series.endYear - 45,
    });
};

const locate = (
    allSeries: Map<string, RwlSeries>,
    series: RwlSeries,
    corrupted: Map<number, number>,
): DiagnosisEvent[] => {
    const built = buildSyntheticSite(allSeries, series.id, corrupted);
    if (!built.site) return [];
    const site = built.site;
    const deployed = process.env.SITE_METHOD === "deployed"
        || process.env.SITE_METHOD === "hybrid"
        ? diagnoseTargetEvents(site, series.id, {
            enableMissingWindowRefinement: process.env.SITE_MISSING_REFINEMENT !== "0",
            enableReferenceVoting: process.env.SITE_REFERENCE_VOTING !== "0",
            eventPathConfig: {
                ...(process.env.SITE_MISSING_ADJUSTMENT === undefined ? {} : {
                    missingBoundaryYearAdjustment: Number(process.env.SITE_MISSING_ADJUSTMENT),
                }),
                robustMasterWeight: Number(process.env.PRODUCTION_ROBUST_MASTER_WEIGHT ?? "0"),
                individualMasterWeight: Number(process.env.PRODUCTION_INDIVIDUAL_MASTER_WEIGHT ?? "0"),
                ...(process.env.PRODUCTION_EXCLUDE_TRANSITION_DIFFERENCE === undefined ? {} : {
                    excludeTransitionDifferenceFromLocalization:
                        process.env.PRODUCTION_EXCLUDE_TRANSITION_DIFFERENCE === "1",
                }),
            },
        })
        : [];
    if (process.env.SITE_METHOD === "deployed") return deployed;
    const config = getConfig({ referenceConfig: null });
    const cofechaPreprocess = (values: Map<number, number>) => new Map(
        cofechaStyleStandardize(values).map((point) => [point.year, point.value]),
    );
    const diagnosis = diagnoseSeriesCore(site, series.id, config, cofechaPreprocess);
    if (!diagnosis) return [];
    let path = locateLagPathEvents(diagnosis, site, {
        useCofechaStandardization: true,
        robustMasterWeight: Number(process.env.PATH_ROBUST_MASTER_WEIGHT ?? "0"),
        individualMasterWeight: Number(process.env.PATH_INDIVIDUAL_MASTER_WEIGHT ?? "0"),
        transitionPenaltyUnit: Number(process.env.PATH_UNIT_PENALTY ?? "9.5"),
        transitionPenaltyBig: Number(process.env.PATH_BIG_PENALTY ?? "11.5"),
        transitionPenaltyPerYear: Number(process.env.PATH_PER_YEAR ?? "1.5"),
        minTransitionGain: Number(process.env.PATH_MIN_GAIN ?? "1"),
        minRunYears: Number(process.env.PATH_MIN_RUN ?? "10"),
        maxBoundaryRefinementYears: Number(process.env.PATH_MAX_REFINEMENT ?? "14"),
        enablePulseScan: process.env.PATH_PULSE_ENABLED === "1",
        minPulseGain: Number(process.env.PATH_PULSE_MIN_GAIN ?? "8"),
        pulseMarkerWeight: Number(process.env.PATH_PULSE_MARKER_WEIGHT ?? "0"),
        minPulseCombinedScore: Number(process.env.PATH_PULSE_MIN_COMBINED_SCORE ?? "-Infinity"),
        maxPulseCount: Number(process.env.PATH_PULSE_MAX_COUNT ?? "1"),
        missingBoundaryYearAdjustment: Number(process.env.PATH_MISSING_ADJUSTMENT
            ?? process.env.PATH_BOUNDARY_ADJUSTMENT ?? "0"),
        falseBoundaryYearAdjustment: Number(process.env.PATH_FALSE_ADJUSTMENT
            ?? process.env.PATH_BOUNDARY_ADJUSTMENT ?? "0"),
        partialBoundaryYearAdjustment: Number(process.env.PATH_PARTIAL_ADJUSTMENT
            ?? process.env.PATH_BOUNDARY_ADJUSTMENT ?? "0"),
    });
    const verificationMode = process.env.VERIFY_PATH_EVENTS;
    if (verificationMode) {
        const defaultDiagnosis = diagnoseSeriesCore(site, series.id, config);
        if (defaultDiagnosis) {
            path = path.filter((event) => {
                const shouldVerify = verificationMode === "all"
                    || (verificationMode === "partial" && event.eventType === "partialMove");
                return !shouldVerify
                    || verifyDiagnosisEvent(site, defaultDiagnosis, event, config).length > 0;
            });
        }
    }
    latestSourceComparison = { path, deployed };
    if (process.env.SITE_METHOD !== "hybrid") return path;

    const selector = process.env.HYBRID_SELECTOR ?? "intersection";
    if (selector === "union") return [...path, ...deployed];
    const eventTypes: DiagnosisEventType[] = ["missingRing", "falseRing", "partialMove", "wholeSeriesMove"];
    const selected = eventTypes.flatMap((eventType) => {
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
        const supported = pathMatches.find((event) => deployedMatches.some((candidate) => (
            Math.max(event.startYear, candidate.startYear - 6)
                <= Math.min(event.endYear, candidate.endYear + 6)
        )));
        if (selector === "production-prototype") {
            if (eventType === "missingRing") {
                return pathMatches[0] ? [pathMatches[0]] : deployedMatches[0] ? [deployedMatches[0]] : [];
            }
            if (eventType === "falseRing") {
                return pathMatches[0]
                    ? deployedMatches[0] ? [pathMatches[0]] : []
                    : deployedMatches[0] ? [deployedMatches[0]] : [];
            }
            if (eventType === "partialMove") return pathMatches;
            if (eventType === "wholeSeriesMove") {
                return path.some((event) => event.eventType === "partialMove")
                    ? []
                    : deployedMatches[0] ? [deployedMatches[0]] : [];
            }
        }
        if (supported) return [supported];
        return deployedMatches[0] ? [deployedMatches[0]] : [];
    });
    if (selector !== "production-prototype" || process.env.PRODUCTION_MERGE === "0") return selected;
    const merged: DiagnosisEvent[] = [];
    selected
        .sort((a, b) => {
            const pathA = a.evidence.algorithmSources.includes("piecewise_lag_path") ? 1 : 0;
            const pathB = b.evidence.algorithmSources.includes("piecewise_lag_path") ? 1 : 0;
            return pathB - pathA || b.evidence.score - a.evidence.score;
        })
        .forEach((event) => {
            const overlapping = merged.find((other) => (
                Math.max(event.startYear, other.startYear)
                    <= Math.min(event.endYear, other.endYear)
            ));
            if (!overlapping) {
                merged.push(event);
                return;
            }
            if (overlapping.eventType !== event.eventType) {
                overlapping.alternativeTypes = Array.from(new Set([
                    ...overlapping.alternativeTypes,
                    event.eventType,
                ]));
            }
        });
    return merged;
};

describe("piecewise-lag path site-split experiment", () => {
    it("reports training or tuning stations without touching the frozen holdout", () => {
        const requested = process.env.SITE_FOLDERS?.split(",").filter(Boolean);
        const split = process.env.SITE_SPLIT ?? "train";
        const folders = requested ?? (split === "tune" ? TUNE_FOLDERS : TRAIN_FOLDERS);
        const metrics: Record<Exclude<DiagnosisEventType, "wholeSeriesMove">, Aggregate> = {
            missingRing: empty(),
            falseRing: empty(),
            partialMove: empty(),
        };
        let cleanCases = 0;
        let cleanFalsePositives = 0;
        const byFolder: Record<string, { cases: number; cleanFalsePositives: number }> = {};
        const failures: unknown[] = [];
        const falseComparisons: unknown[] = [];
        const rankingCases: unknown[] = [];
        const missingCandidateRows: unknown[] = [];

        folders.forEach((folder, folderIndex) => {
            const loaded = loadDataFolder(folder);
            if (!loaded) return;
            const eligible = getEligibleSeriesForSyntheticTests(loaded.crossdated, {
                minLength: 120,
                minNonZero: 90,
                minSpan: 120,
            });
            const targets = sampleAcross(eligible, 2).slice(0, Number(process.env.SITE_TARGETS ?? "6"));
            byFolder[folder] = { cases: 0, cleanFalsePositives: 0 };
            targets.forEach((series, index) => {
                const year = markerYear(loaded.crossdated, series);
                if (year === null) return;
                byFolder[folder].cases += 1;

                const missing = createEndAnchoredMissingRingCase(series, year);
                const missingTruth: TruthEvent = {
                    id: `${folder}-${series.id}-missing`,
                    seriesId: series.id,
                    eventType: "missingRing",
                    year,
                };
                const missingPredictions = locate(loaded.crossdated, series, missing.corrupted);
                const rankedMissing = missingPredictions.find((event) => (
                    event.eventType === "missingRing"
                ));
                if (rankedMissing) {
                    const noteValue = (prefix: string): number | null => {
                        const note = rankedMissing.evidence.notes.find((value) => (
                            value.startsWith(prefix)
                        ));
                        if (!note) return null;
                        const value = Number(note.slice(prefix.length));
                        return Number.isFinite(value) ? value : null;
                    };
                    const candidateYear = noteValue("candidate_top_year=");
                    const topYear = rankedMissing.rankedYears[0]?.year;
                    missingCandidateRows.push({
                        folder,
                        seriesId: series.id,
                        truthYear: year,
                        currentError: topYear === undefined ? null : topYear - year,
                        candidateError: candidateYear === null ? null : candidateYear - year,
                        candidateDistance: candidateYear === null || topYear === undefined
                            ? null
                            : candidateYear - topYear,
                        candidateRank: candidateYear === null
                            ? null
                            : rankedMissing.rankedYears.find((row) => (
                                row.year === candidateYear
                            ))?.rank ?? null,
                        currentRankMargin: rankedMissing.rankedYears.length < 2
                            ? null
                            : rankedMissing.rankedYears[0].score
                                - rankedMissing.rankedYears[1].score,
                        candidateScore: noteValue("candidate_top_score="),
                        candidateProbability: noteValue("candidate_top_probability="),
                        candidateMargin: noteValue("candidate_top_margin="),
                        candidateConfidence: rankedMissing.evidence.notes
                            .find((value) => value.startsWith("candidate_top_confidence="))
                            ?.slice("candidate_top_confidence=".length) ?? null,
                        referenceVote: rankedMissing.evidence.algorithmSources
                            .includes("reference_core_voting"),
                    });
                }
                add(metrics.missingRing, [missingTruth], missingPredictions);
                rankingCases.push({
                    folder,
                    seriesId: series.id,
                    type: "missingRing",
                    year,
                    predictions: rankingSummary(year, missingPredictions.filter((event) => event.eventType === "missingRing")),
                });
                if (matchDiagnosisEvents([missingTruth], missingPredictions).matchedCount === 0) {
                    failures.push({ folder, seriesId: series.id, type: "missingRing", year, predictions: eventSummary(missingPredictions) });
                }

                const falseRing = createEndAnchoredFalseRingCase(
                    series,
                    year,
                    (["average", "moderate", "splitLike"] as const)[(folderIndex + index) % 3],
                );
                const falseTruth: TruthEvent = {
                    id: `${folder}-${series.id}-false`,
                    seriesId: series.id,
                    eventType: "falseRing",
                    year,
                };
                const falsePredictions = locate(loaded.crossdated, series, falseRing.corrupted);
                rankingCases.push({
                    folder,
                    seriesId: series.id,
                    type: "falseRing",
                    year,
                    predictions: rankingSummary(year, falsePredictions.filter((event) => event.eventType === "falseRing")),
                });
                if (process.env.PRINT_FALSE_COMPARISON === "1") {
                    falseComparisons.push({
                        folder,
                        seriesId: series.id,
                        year,
                        path: eventSummary(latestSourceComparison.path.filter((event) => event.eventType === "falseRing")),
                        deployed: eventSummary(latestSourceComparison.deployed.filter((event) => event.eventType === "falseRing")),
                    });
                }
                add(metrics.falseRing, [falseTruth], falsePredictions);
                if (matchDiagnosisEvents([falseTruth], falsePredictions).matchedCount === 0) {
                    failures.push({ folder, seriesId: series.id, type: "falseRing", year, predictions: eventSummary(falsePredictions) });
                }

                const gapYears = ([2, 3, 4, 5, 6, 8] as const)[
                    (folderIndex + index) % 6
                ];
                const partial = createPartialRangeMoveCase(series, year, gapYears);
                const partialTruth: TruthEvent = {
                    id: `${folder}-${series.id}-partial`,
                    seriesId: series.id,
                    eventType: "partialMove",
                    year,
                    shiftYears: -gapYears,
                    shiftSide: "older",
                };
                const partialPredictions = locate(loaded.crossdated, series, partial.corrupted);
                rankingCases.push({
                    folder,
                    seriesId: series.id,
                    type: "partialMove",
                    year,
                    injectedShift: gapYears,
                    predictions: rankingSummary(year, partialPredictions.filter((event) => event.eventType === "partialMove")),
                });
                add(metrics.partialMove, [partialTruth], partialPredictions);
                if (process.env.PRINT_SITE_FAILURES === "1"
                    && partialPredictions.length > 1) {
                    failures.push({
                        folder,
                        seriesId: series.id,
                        type: "partialMove-extra",
                        year,
                        injectedShift: gapYears,
                        predictions: eventSummary(partialPredictions),
                    });
                }
                if (matchDiagnosisEvents([partialTruth], partialPredictions).matchedCount === 0) {
                    failures.push({
                        folder,
                        seriesId: series.id,
                        type: "partialMove",
                        year,
                        injectedShift: gapYears,
                        predictions: eventSummary(partialPredictions),
                    });
                }

                const clean = locate(loaded.crossdated, series, series.valuesByYear);
                cleanCases += 1;
                if (clean.length > 0) {
                    cleanFalsePositives += 1;
                    byFolder[folder].cleanFalsePositives += 1;
                    failures.push({ folder, seriesId: series.id, type: "clean", predictions: eventSummary(clean) });
                }
            });
        });

        const report = {
            split,
            folders,
            missingRing: summarize(metrics.missingRing),
            falseRing: summarize(metrics.falseRing),
            partialMove: summarize(metrics.partialMove),
            clean: {
                cases: cleanCases,
                falsePositiveRate: cleanFalsePositives / Math.max(1, cleanCases),
            },
            byFolder,
        };
        // eslint-disable-next-line no-console
        console.log(`EVENT_PATH_SITE_EXPERIMENT ${JSON.stringify(report)}`);
        if (process.env.PRINT_SITE_FAILURES === "1") {
            // eslint-disable-next-line no-console
            console.log(`EVENT_PATH_SITE_FAILURES ${JSON.stringify(failures)}`);
        }
        if (process.env.PRINT_FALSE_COMPARISON === "1") {
            // eslint-disable-next-line no-console
            console.log(`EVENT_FALSE_COMPARISON ${JSON.stringify(falseComparisons)}`);
        }
        if (process.env.PRINT_SITE_RANKING_CASES === "1") {
            // eslint-disable-next-line no-console
            console.log(`EVENT_SITE_RANKING_CASES ${JSON.stringify(rankingCases)}`);
        }
        if (process.env.PRINT_SITE_CANDIDATE_ROWS === "1") {
            // eslint-disable-next-line no-console
            console.log(`EVENT_SITE_CANDIDATE_ROWS ${JSON.stringify(missingCandidateRows)}`);
        }
        expect(cleanCases).toBeGreaterThan(0);
    }, 180_000);
});

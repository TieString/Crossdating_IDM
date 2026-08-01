import { describe, expect, it } from "vitest";
import { getConfig } from "../config";
import { diagnoseLagPath } from "../eventPath";
import { INTERNAL_EVENT_PATH_CONFIG } from "../eventEnsemble";
import { scoreEditYearsInRegion, type EditYearScanEvidence } from "../rangeMove";
import type { DiagnosisEvent } from "../types";
import {
    buildLeaveOneOutMaster,
    buildSyntheticSite,
    createEndAnchoredFalseRingCase,
    createEndAnchoredMissingRingCase,
    getEligibleSeriesForSyntheticTests,
    loadDataFolder,
    pickExploratoryStrongSignalYear,
    sampleAcross,
    type RwlSeries,
} from "./rdmFixture";
import { diagnoseTargetBundle } from "./targetDiagnosis";

const TRAIN_FOLDERS = ["EBD", "EBM", "RDM", "RDU"];
const TUNE_FOLDERS = ["EBU", "ZSD"];

type PlacementResult = {
    folder: string;
    seriesId: string;
    eventType: "missingRing" | "falseRing";
    truthYear: number;
    original: [number, number] | null;
    pathTopYear: number | null;
    scanTopYear: number | null;
    scanTruthRank: number | null;
    eventScore: number | null;
    eventSources: string[];
    eventNotes: string[];
    candidateSupportCount: number;
    candidateYears: Array<{
        year: number;
        score: number;
        confidence: string;
        wholeDelta: number;
        localDelta: number;
        meanDelta: number;
        lagRecovery: number;
    }>;
    candidateCentered: [number, number] | null;
    candidateSelectors: Record<string, [number, number] | null>;
    rawPath: [number, number] | null;
    rawPathTopYear: number | null;
    scanTopEvidence: EditYearScanEvidence | null;
    scanBestInsideOriginal: EditYearScanEvidence | null;
    centered: [number, number] | null;
    mass: Record<string, [number, number] | null>;
};

const boundedWindow = (
    centerYear: number,
    width: number,
    minYear: number,
    maxYear: number,
): [number, number] => {
    let start = centerYear - Math.floor((width - 1) / 2);
    start = Math.max(minYear, Math.min(start, maxYear - width + 1));
    return [start, start + width - 1];
};

const massWindow = (
    rows: EditYearScanEvidence[],
    width: number,
    minYear: number,
    maxYear: number,
    temperature: number,
): [number, number] | null => {
    if (rows.length === 0) return null;
    const best = rows[0].quality;
    const weights = new Map(rows.map((row) => [
        row.year,
        Math.exp(Math.max(-30, (row.quality - best) / temperature)),
    ]));
    let selected: { range: [number, number]; mass: number } | null = null;
    for (let start = minYear; start <= maxYear - width + 1; start += 1) {
        let mass = 0;
        for (let year = start; year < start + width; year += 1) mass += weights.get(year) ?? 0;
        if (!selected || mass > selected.mass) selected = { range: [start, start + width - 1], mass };
    }
    return selected?.range ?? null;
};

const includes = (range: [number, number] | null, year: number): boolean => (
    range !== null && year >= range[0] && year <= range[1]
);

const edgeRefinedWindow = (result: PlacementResult): [number, number] | null => {
    if (!result.original || !result.centered || result.scanTopYear === null) return result.original;
    const outsideDistance = result.scanTopYear < result.original[0]
        ? result.original[0] - result.scanTopYear
        : result.scanTopYear > result.original[1]
            ? result.scanTopYear - result.original[1]
            : 0;
    return outsideDistance >= 1 && outsideDistance <= 4 ? result.centered : result.original;
};

const rawCandidateConsensusWindow = (result: PlacementResult): [number, number] | null => {
    const candidateYear = result.candidateYears[0]?.year;
    if (candidateYear === undefined || result.rawPathTopYear === null || !result.original) {
        return result.original;
    }
    if (Math.abs(candidateYear - result.rawPathTopYear) > 6) return result.original;
    const center = Math.floor((candidateYear + result.rawPathTopYear) / 2);
    return [center - 3, center + 3];
};

const gatedRawCandidateConsensusWindow = (result: PlacementResult): [number, number] | null => {
    const consensus = rawCandidateConsensusWindow(result);
    if (!consensus || !result.original) return result.original;
    const candidateScore = result.candidateYears[0]?.score ?? -Infinity;
    const originalCenter = Math.floor((result.original[0] + result.original[1]) / 2);
    const consensusCenter = Math.floor((consensus[0] + consensus[1]) / 2);
    return candidateScore >= 20 && Math.abs(consensusCenter - originalCenter) >= 5
        ? consensus
        : result.original;
};

const combinedWindow = (result: PlacementResult): [number, number] | null => {
    const consensus = gatedRawCandidateConsensusWindow(result);
    if (consensus !== result.original
        && (consensus?.[0] !== result.original?.[0] || consensus?.[1] !== result.original?.[1])) {
        return consensus;
    }
    return edgeRefinedWindow(result);
};

const directionalFalseWindow = (result: PlacementResult): [number, number] | null => {
    const consensus = gatedRawCandidateConsensusWindow(result);
    if (consensus && result.original
        && (consensus[0] !== result.original[0] || consensus[1] !== result.original[1])) {
        return consensus;
    }
    if (!result.original || !result.centered || result.scanTopYear === null) return result.original;
    const candidateYear = result.candidateYears[0]?.year;
    if (result.scanTopYear > result.original[1]) {
        const distance = result.scanTopYear - result.original[1];
        const corroborated = (candidateYear !== undefined && candidateYear > result.original[1])
            || (result.rawPathTopYear !== null && result.rawPathTopYear > result.original[1]);
        return distance <= 4 && corroborated ? result.centered : result.original;
    }
    if (result.scanTopYear < result.original[0]) {
        const distance = result.original[0] - result.scanTopYear;
        const corroborated = (candidateYear !== undefined && candidateYear < result.original[0])
            || (result.rawPathTopYear !== null && result.rawPathTopYear < result.original[0]);
        return distance <= 4 && corroborated ? result.centered : result.original;
    }
    return result.original;
};

const locateCase = (
    folder: string,
    allSeries: Map<string, RwlSeries>,
    series: RwlSeries,
    truthYear: number,
    eventType: "missingRing" | "falseRing",
    corrupted: Map<number, number>,
): PlacementResult => {
    const built = buildSyntheticSite(allSeries, series.id, corrupted);
    const site = built.site;
    if (!site) throw new Error(`could not build ${folder}/${series.id}`);
    const bundle = diagnoseTargetBundle(site, series.id);
    if (!bundle) throw new Error(`could not diagnose ${folder}/${series.id}`);
    const { diagnosis } = bundle;
    const event = bundle.events
        .filter((item) => item.eventType === eventType)
        .sort((a, b) => b.evidence.score - a.evidence.score)[0] as DiagnosisEvent | undefined;
    const rawEvent = diagnoseLagPath(diagnosis, site, {
        ...INTERNAL_EVENT_PATH_CONFIG,
        useCofechaStandardization: false,
    }).events
        .filter((item) => item.eventType === eventType)
        .sort((a, b) => b.evidence.score - a.evidence.score)[0];
    const minYear = diagnosis.targetRange.startYear + 2;
    const maxYear = diagnosis.targetRange.endYear - 2;
    const center = event?.rankedYears[0]?.year ?? truthYear;
    const radius = Number(process.env.REFINE_SEARCH_RADIUS ?? "14");
    const rows = event
        ? scoreEditYearsInRegion(
            diagnosis,
            eventType === "missingRing" ? "insert" : "delete",
            event.startYear - radius,
            event.endYear + radius,
            center,
            getConfig({ referenceConfig: null }),
        )
        : [];
    const centered = rows[0]
        ? boundedWindow(rows[0].year, 7, minYear, maxYear)
        : null;
    const mass = Object.fromEntries(
        [0.1, 0.2, 0.35, 0.5, 0.75, 1].map((temperature) => [
            temperature.toString(),
            massWindow(rows, 7, Math.max(minYear, event?.startYear ? event.startYear - radius : minYear),
                Math.min(maxYear, event?.endYear ? event.endYear + radius : maxYear), temperature),
        ]),
    );
    const candidateYears = bundle.candidates
        .filter((candidate) => (
            eventType === "missingRing"
                ? candidate.operationType === "INSERT_MISSING_RING"
                : candidate.operationType === "DELETE_FALSE_RING"
        ))
        .map((candidate) => ({
            year: candidate.targetYear ?? candidate.anchorYear,
            score: candidate.score,
            confidence: candidate.confidenceLevel,
            wholeDelta: candidate.evidence.evaluationDelta?.wholeSeriesRDelta ?? -Infinity,
            localDelta: candidate.evidence.evaluationDelta?.localBoundaryRDelta ?? -Infinity,
            meanDelta: candidate.evidence.evaluationDelta?.meanSegmentRDelta ?? -Infinity,
            lagRecovery: candidate.evidence.evaluationDelta?.lagRecoveryScore ?? -Infinity,
        }));
    const selectorWindow = (
        selector: (row: (typeof candidateYears)[number]) => number,
    ): [number, number] | null => {
        const best = [...candidateYears].sort((a, b) => selector(b) - selector(a))[0];
        return best ? boundedWindow(best.year, 7, minYear, maxYear) : null;
    };
    return {
        folder,
        seriesId: series.id,
        eventType,
        truthYear,
        original: event ? [event.startYear, event.endYear] : null,
        pathTopYear: event?.rankedYears[0]?.year ?? null,
        scanTopYear: rows[0]?.year ?? null,
        scanTruthRank: (() => {
            const index = rows.findIndex((row) => row.year === truthYear);
            return index >= 0 ? index + 1 : null;
        })(),
        eventScore: event?.evidence.score ?? null,
        eventSources: event?.evidence.algorithmSources ?? [],
        eventNotes: event?.evidence.notes ?? [],
        candidateSupportCount: event?.evidence.candidateIds.length ?? 0,
        candidateYears,
        candidateCentered: candidateYears[0]
            ? boundedWindow(candidateYears[0].year, 7, minYear, maxYear)
            : null,
        candidateSelectors: {
            score: selectorWindow((row) => row.score),
            whole: selectorWindow((row) => row.wholeDelta),
            local: selectorWindow((row) => row.localDelta),
            mean: selectorWindow((row) => row.meanDelta),
            lag: selectorWindow((row) => row.lagRecovery),
        },
        rawPath: rawEvent ? [rawEvent.startYear, rawEvent.endYear] : null,
        rawPathTopYear: rawEvent?.rankedYears[0]?.year ?? null,
        scanTopEvidence: rows[0] ?? null,
        scanBestInsideOriginal: event
            ? rows.find((row) => row.year >= event.startYear && row.year <= event.endYear) ?? null
            : null,
        centered,
        mass,
    };
};

describe("event-window counterfactual refinement experiment", () => {
    it("compares fixed path placement with edit-score placement", () => {
        const folders = process.env.REFINE_FOLDERS?.split(",").filter(Boolean)
            ?? (process.env.REFINE_SPLIT === "train" ? TRAIN_FOLDERS : TUNE_FOLDERS);
        const results: PlacementResult[] = [];
        folders.forEach((folder, folderIndex) => {
            const loaded = loadDataFolder(folder);
            if (!loaded) return;
            const eligible = getEligibleSeriesForSyntheticTests(loaded.crossdated, {
                minLength: 120,
                minNonZero: 90,
                minSpan: 120,
            });
            sampleAcross(eligible, 2)
                .slice(0, Number(process.env.REFINE_TARGETS ?? "6"))
                .forEach((series, index) => {
                    const master = buildLeaveOneOutMaster(loaded.crossdated, series.id);
                    if (master.skipped) return;
                    const year = pickExploratoryStrongSignalYear(series, master.masterValuesByYear, {
                        lo: series.startYear + 45,
                        hi: series.endYear - 45,
                    });
                    if (year === null) return;
                    const missing = createEndAnchoredMissingRingCase(series, year);
                    results.push(locateCase(
                        folder,
                        loaded.crossdated,
                        series,
                        year,
                        "missingRing",
                        missing.corrupted,
                    ));
                    const falseRing = createEndAnchoredFalseRingCase(
                        series,
                        year,
                        (["average", "moderate", "splitLike"] as const)[(folderIndex + index) % 3],
                    );
                    results.push(locateCase(
                        folder,
                        loaded.crossdated,
                        series,
                        year,
                        "falseRing",
                        falseRing.corrupted,
                    ));
                });
        });

        const summarize = (eventType: PlacementResult["eventType"]) => {
            const selected = results.filter((result) => result.eventType === eventType);
            const answered = selected.filter((result) => result.original !== null);
            return {
                cases: selected.length,
                answered: answered.length,
                originalHits: answered.filter((result) => includes(result.original, result.truthYear)).length,
                candidateHits: answered.filter((result) => includes(result.candidateCentered, result.truthYear)).length,
                candidateSelectorHits: Object.fromEntries(["score", "whole", "local", "mean", "lag"].map((selector) => [
                    selector,
                    answered.filter((result) => includes(result.candidateSelectors[selector], result.truthYear)).length,
                ])),
                rawPathHits: answered.filter((result) => includes(result.rawPath, result.truthYear)).length,
                rawCandidateConsensusHits: answered.filter((result) => (
                    includes(rawCandidateConsensusWindow(result), result.truthYear)
                )).length,
                gatedConsensusHits: answered.filter((result) => (
                    includes(gatedRawCandidateConsensusWindow(result), result.truthYear)
                )).length,
                combinedHits: answered.filter((result) => includes(combinedWindow(result), result.truthYear)).length,
                directionalFalseHits: answered.filter((result) => (
                    includes(directionalFalseWindow(result), result.truthYear)
                )).length,
                edgeRefinedHits: answered.filter((result) => includes(edgeRefinedWindow(result), result.truthYear)).length,
                centeredHits: answered.filter((result) => includes(result.centered, result.truthYear)).length,
                massHits: Object.fromEntries([0.1, 0.2, 0.35, 0.5, 0.75, 1].map((temperature) => [
                    temperature.toString(),
                    answered.filter((result) => includes(result.mass[temperature.toString()], result.truthYear)).length,
                ])),
            };
        };
        // eslint-disable-next-line no-console
        console.log(`EVENT_WINDOW_REFINEMENT ${JSON.stringify({
            folders,
            missing: summarize("missingRing"),
            falseRing: summarize("falseRing"),
            failures: results
                .filter((result) => !includes(result.original, result.truthYear))
                .map((result) => ({
                    folder: result.folder,
                    seriesId: result.seriesId,
                    eventType: result.eventType,
                    truthYear: result.truthYear,
                    original: result.original,
                    pathTopYear: result.pathTopYear,
                })),
            ...(process.env.PRINT_REFINE_CHANGES === "1" ? {
                appliedRefinements: results
                    .filter((result) => result.eventNotes.some((note) => (
                        note.startsWith("window_refinement=")
                    )))
                    .map((result) => ({
                        folder: result.folder,
                        seriesId: result.seriesId,
                        eventType: result.eventType,
                        truthYear: result.truthYear,
                        refined: result.original,
                        original: result.eventNotes.find((note) => note.startsWith("window_before=")),
                        reason: result.eventNotes.find((note) => note.startsWith("window_refinement=")),
                        scanTop: result.eventNotes.find((note) => note.startsWith("scan_top_year=")),
                        rawTop: result.eventNotes.find((note) => note.startsWith("raw_path_top_year=")),
                        candidateTop: result.eventNotes.find((note) => note.startsWith("candidate_top_year=")),
                        refinedHit: includes(result.original, result.truthYear),
                    })),
                strategyChanges: results
                    .filter((result) => (
                        includes(result.original, result.truthYear)
                            !== includes(rawCandidateConsensusWindow(result), result.truthYear)
                        || includes(result.original, result.truthYear)
                            !== includes(edgeRefinedWindow(result), result.truthYear)
                    ))
                    .map((result) => ({
                        folder: result.folder,
                        seriesId: result.seriesId,
                        eventType: result.eventType,
                        truthYear: result.truthYear,
                        original: result.original,
                        rawPath: result.rawPath,
                        candidateYear: result.candidateYears[0]?.year ?? null,
                        candidateScore: result.candidateYears[0]?.score ?? null,
                        consensus: rawCandidateConsensusWindow(result),
                        edgeRefined: edgeRefinedWindow(result),
                        originalHit: includes(result.original, result.truthYear),
                        consensusHit: includes(rawCandidateConsensusWindow(result), result.truthYear),
                        edgeRefinedHit: includes(edgeRefinedWindow(result), result.truthYear),
                    })),
            } : {}),
            ...(process.env.PRINT_REFINE_DETAILS === "1" ? {
                details: results
                    .filter((result) => (
                        includes(result.original, result.truthYear)
                            !== includes(result.centered, result.truthYear)
                        || includes(result.original, result.truthYear)
                            !== includes(result.candidateCentered, result.truthYear)
                        || includes(result.original, result.truthYear)
                            !== includes(rawCandidateConsensusWindow(result), result.truthYear)
                    ))
                    .map((result) => ({
                    ...result,
                    originalHit: includes(result.original, result.truthYear),
                    centeredHit: includes(result.centered, result.truthYear),
                    candidateHit: includes(result.candidateCentered, result.truthYear),
                    rawCandidateConsensus: rawCandidateConsensusWindow(result),
                    rawCandidateConsensusHit: includes(
                        rawCandidateConsensusWindow(result),
                        result.truthYear,
                    ),
                    massHit: includes(result.mass["0.35"], result.truthYear),
                    scanVsPath: result.scanTopYear !== null && result.pathTopYear !== null
                        ? result.scanTopYear - result.pathTopYear
                        : null,
                    })),
            } : {}),
        })}`);
        expect(results.length).toBeGreaterThan(0);
    }, 300_000);
});

/** Local counterfactual year scoring for one missing-ring or false-ring event. */
import {
    ar1WhitenSeries,
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import type { RwlSiteData } from "@/features/rwl/types";
import type {
    DiagnosisEvent,
    DiagnosisRankedYear,
    NumericSeries,
    SeriesCoreDiagnosis,
} from "./types";

export type UnitBreakpointScore = {
    year: number;
    raw31: number;
    difference31: number;
    whitened31: number;
    raw11: number;
    difference11: number;
    whitened11: number;
    combo11: number;
    combo21: number;
    combo31: number;
    combo41: number;
    combo61: number;
    multiScale: number;
    rawHuber11: number;
    rawHuber5: number;
    rawHuber7: number;
    rawHuber31: number;
    differenceHuber11: number;
    differenceHuber5: number;
    differenceHuber7: number;
    differenceHuber31: number;
    whitenedHuber11: number;
    whitenedHuber5: number;
    whitenedHuber7: number;
    whitenedHuber31: number;
    huberCombo5: number;
    huberCombo7: number;
    huberCombo11: number;
    huberCombo31: number;
    huberMultiScale: number;
    pairMean31: number;
    pairMedian31: number;
    pairTrimmed31: number;
    pairWeighted31: number;
    bestReference31: number;
    pairedCore31: number;
};

type UnitScoreKey = keyof Omit<UnitBreakpointScore, "year">;
type UnitNeighborScore = Pick<UnitBreakpointScore, "year" | "combo11">;

const UNIT_SCORE_KEYS: UnitScoreKey[] = [
    "raw31",
    "difference31",
    "whitened31",
    "combo31",
    "combo41",
    "combo61",
    "multiScale",
    "pairMean31",
    "pairMedian31",
    "pairTrimmed31",
    "pairWeighted31",
    "bestReference31",
    "pairedCore31",
];

type LocalReference = { data: NumericSeries; weight: number; pairedCore: boolean };

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return preprocessSeries(result);
};

const simulateMissingCorrection = (series: NumericSeries, year: number): NumericSeries => {
    const result = new Map<number, number>();
    series.forEach((value, sourceYear) => {
        result.set(sourceYear <= year ? sourceYear - 1 : sourceYear, value);
    });
    return result;
};

const simulateFalseCorrection = (series: NumericSeries, year: number): NumericSeries => {
    const result = new Map<number, number>();
    series.forEach((value, sourceYear) => {
        if (sourceYear !== year) {
            result.set(sourceYear < year ? sourceYear + 1 : sourceYear, value);
        }
    });
    return result;
};

const localCorrelation = (
    target: NumericSeries,
    master: NumericSeries,
    centerYear: number,
    width: number,
): number => {
    const half = Math.floor((width - 1) / 2);
    return correlationForSegment(
        target,
        master,
        centerYear - half,
        centerYear + half,
        0,
        Math.max(10, Math.floor(width * 0.5)),
).correlation ?? -1;
};

const shortCorrelation = (
    target: NumericSeries,
    master: NumericSeries,
    centerYear: number,
    width: number,
): number => {
    const half = Math.floor((width - 1) / 2);
    return correlationForSegment(
        target,
        master,
        centerYear - half,
        centerYear + half,
        0,
        Math.max(4, Math.floor(width * 0.6)),
    ).correlation ?? -1;
};

const huberLoss = (residual: number, transition = 1.5): number => {
    const absolute = Math.abs(residual);
    return absolute <= transition
        ? 0.5 * absolute * absolute
        : transition * (absolute - transition * 0.5);
};

const localHuberSimilarity = (
    target: NumericSeries,
    master: NumericSeries,
    centerYear: number,
    width: number,
): number => {
    const half = Math.floor((width - 1) / 2);
    let loss = 0;
    let pairs = 0;
    for (let year = centerYear - half; year <= centerYear + half; year += 1) {
        const targetValue = target.get(year);
        const masterValue = master.get(year);
        if (targetValue === undefined || masterValue === undefined) continue;
        loss += huberLoss(targetValue - masterValue);
        pairs += 1;
    }
    return pairs >= Math.max(4, Math.floor(width * 0.45)) ? -loss / pairs : -10;
};

const combined = (
    raw: NumericSeries,
    difference: NumericSeries,
    whitened: NumericSeries,
    master: NumericSeries,
    masterDifference: NumericSeries,
    masterWhitened: NumericSeries,
    year: number,
    width: number,
): number => (
    localCorrelation(raw, master, year, width) * 0.35
    + localCorrelation(difference, masterDifference, year, width) * 0.4
    + localCorrelation(whitened, masterWhitened, year, width) * 0.25
);

const mean = (values: number[]): number => (
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : -1
);

const median = (values: number[]): number => {
    if (values.length === 0) return -1;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

const localReferences = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
): LocalReference[] => {
    const target = preprocessSeries(diagnosis.rawTarget);
    const targetStem = diagnosis.targetTree.slice(0, -1).toLowerCase();
    return diagnosis.master.sourceTrees
        .map((tree) => {
            const data = preprocessSeries(toNumericSeries(siteData.get(tree)));
            const correlation = correlationForSegment(
                target,
                data,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
                0,
                30,
            ).correlation ?? -1;
            return {
                data,
                correlation,
                weight: Math.max(0, correlation) + 0.1,
                pairedCore: tree.slice(0, -1).toLowerCase() === targetStem,
            };
        })
        .filter((reference) => reference.correlation > -0.25)
        .sort((a, b) => b.correlation - a.correlation)
        .slice(0, 16);
};

const pairwiseLocalAggregates = (
    corrected: NumericSeries,
    references: LocalReference[],
    year: number,
): Pick<UnitBreakpointScore,
    | "pairMean31"
    | "pairMedian31"
    | "pairTrimmed31"
    | "pairWeighted31"
    | "bestReference31"
    | "pairedCore31"
> => {
    const rows = references
        .map((reference) => ({
            correlation: localCorrelation(corrected, reference.data, year, 31),
            weight: reference.weight,
            pairedCore: reference.pairedCore,
        }))
        .filter((row) => row.correlation > -1);
    const values = rows.map((row) => row.correlation).sort((a, b) => a - b);
    const trim = Math.floor(values.length * 0.2);
    const trimmed = values.slice(trim, Math.max(trim + 1, values.length - trim));
    const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
    const pairedValues = rows
        .filter((row) => row.pairedCore)
        .map((row) => row.correlation);
    return {
        pairMean31: mean(values),
        pairMedian31: median(values),
        pairTrimmed31: mean(trimmed),
        pairWeighted31: totalWeight > 0
            ? rows.reduce((sum, row) => sum + row.correlation * row.weight, 0) / totalWeight
            : mean(values),
        bestReference31: rows[0]?.correlation ?? -1,
        pairedCore31: mean(pairedValues),
    };
};

export const scoreUnitBoundaries = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
): UnitBreakpointScore[] => {
    if (event.eventType !== "missingRing" && event.eventType !== "falseRing") return [];
    const master = diagnosis.master.data;
    const masterDifference = firstDifferences(master);
    const masterWhitened = ar1WhitenSeries(master);
    const references = localReferences(diagnosis, siteData);
    const scores: UnitBreakpointScore[] = [];
    const scanStartYear = Math.max(
        diagnosis.targetRange.startYear + 30,
        event.startYear,
    );
    const scanEndYear = Math.min(
        diagnosis.targetRange.endYear - 30,
        event.endYear,
    );
    for (
        let year = scanStartYear;
        year <= scanEndYear;
        year += 1
    ) {
        const corrected = event.eventType === "missingRing"
            ? simulateMissingCorrection(diagnosis.rawTarget, year)
            : simulateFalseCorrection(diagnosis.rawTarget, year);
        const raw = preprocessSeries(corrected);
        const difference = firstDifferences(corrected);
        const whitened = ar1WhitenSeries(corrected);
        const raw31 = localCorrelation(raw, master, year, 31);
        const difference31 = localCorrelation(difference, masterDifference, year, 31);
        const whitened31 = localCorrelation(whitened, masterWhitened, year, 31);
        const raw11 = shortCorrelation(raw, master, year, 11);
        const difference11 = shortCorrelation(difference, masterDifference, year, 11);
        const whitened11 = shortCorrelation(whitened, masterWhitened, year, 11);
        const combo11 = raw11 * 0.35 + difference11 * 0.4 + whitened11 * 0.25;
        const combo21 = combined(
            raw,
            difference,
            whitened,
            master,
            masterDifference,
            masterWhitened,
            year,
            21,
        );
        const combo31 = raw31 * 0.35 + difference31 * 0.4 + whitened31 * 0.25;
        const combo41 = combined(
            raw,
            difference,
            whitened,
            master,
            masterDifference,
            masterWhitened,
            year,
            41,
        );
        const combo61 = combined(
            raw,
            difference,
            whitened,
            master,
            masterDifference,
            masterWhitened,
            year,
            61,
        );
        const rawHuber5 = localHuberSimilarity(raw, master, year, 5);
        const rawHuber7 = localHuberSimilarity(raw, master, year, 7);
        const rawHuber11 = localHuberSimilarity(raw, master, year, 11);
        const rawHuber31 = localHuberSimilarity(raw, master, year, 31);
        const differenceHuber5 = localHuberSimilarity(
            difference,
            masterDifference,
            year,
            5,
        );
        const differenceHuber7 = localHuberSimilarity(
            difference,
            masterDifference,
            year,
            7,
        );
        const differenceHuber11 = localHuberSimilarity(
            difference,
            masterDifference,
            year,
            11,
        );
        const differenceHuber31 = localHuberSimilarity(
            difference,
            masterDifference,
            year,
            31,
        );
        const whitenedHuber5 = localHuberSimilarity(
            whitened,
            masterWhitened,
            year,
            5,
        );
        const whitenedHuber7 = localHuberSimilarity(
            whitened,
            masterWhitened,
            year,
            7,
        );
        const whitenedHuber11 = localHuberSimilarity(
            whitened,
            masterWhitened,
            year,
            11,
        );
        const whitenedHuber31 = localHuberSimilarity(
            whitened,
            masterWhitened,
            year,
            31,
        );
        const huberCombo5 = rawHuber5 * 0.25
            + differenceHuber5 * 0.45
            + whitenedHuber5 * 0.3;
        const huberCombo7 = rawHuber7 * 0.25
            + differenceHuber7 * 0.45
            + whitenedHuber7 * 0.3;
        const huberCombo11 = rawHuber11 * 0.25
            + differenceHuber11 * 0.45
            + whitenedHuber11 * 0.3;
        const huberCombo31 = rawHuber31 * 0.25
            + differenceHuber31 * 0.45
            + whitenedHuber31 * 0.3;
        scores.push({
            year,
            raw31,
            difference31,
            whitened31,
            raw11,
            difference11,
            whitened11,
            combo11,
            combo21,
            combo31,
            combo41,
            combo61,
            multiScale: combo31 * 0.5 + combo41 * 0.3 + combo61 * 0.2,
            rawHuber5,
            rawHuber7,
            rawHuber11,
            rawHuber31,
            differenceHuber5,
            differenceHuber7,
            differenceHuber11,
            differenceHuber31,
            whitenedHuber5,
            whitenedHuber7,
            whitenedHuber11,
            whitenedHuber31,
            huberCombo5,
            huberCombo7,
            huberCombo11,
            huberCombo31,
            huberMultiScale: huberCombo11 * 0.65 + huberCombo31 * 0.35,
            ...pairwiseLocalAggregates(raw, references, year),
        });
    }
    return scores;
};

const top = (scores: UnitBreakpointScore[], key: UnitScoreKey): UnitBreakpointScore | null => (
    [...scores].sort((a, b) => b[key] - a[key] || b.year - a.year)[0] ?? null
);

const peakMargin = (
    scores: UnitBreakpointScore[],
    key: UnitScoreKey,
    exclusionYears = 1,
): { score: number; margin: number } | null => {
    const best = top(scores, key);
    if (!best) return null;
    const remote = scores
        .filter((row) => Math.abs(row.year - best.year) > exclusionYears)
        .sort((a, b) => b[key] - a[key] || b.year - a.year)[0];
    return {
        score: best[key],
        margin: best[key] - (remote?.[key] ?? best[key]),
    };
};

const noteRange = (
    event: DiagnosisEvent,
    prefix: string,
): { startYear: number; endYear: number } | null => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const match = note?.slice(prefix.length).match(/^(-?\d+)-(-?\d+)$/);
    return match
        ? { startYear: Number(match[1]), endYear: Number(match[2]) }
        : null;
};

const rerank = (
    event: DiagnosisEvent,
    window: { startYear: number; endYear: number },
    topYear: number,
    evidenceTag = "local_counterfactual_raw_year",
): DiagnosisRankedYear[] => {
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    return Array.from({ length: window.endYear - window.startYear + 1 }, (_, index) => {
        const year = window.startYear + index;
        const previous = prior.get(year);
        return {
            year,
            score: year === topYear
                ? 2
                : 1 / (1 + Math.abs(year - topYear))
                    + (previous && Number.isFinite(previous.score) ? previous.score * 1e-6 : 0),
            evidenceTags: Array.from(new Set([
                evidenceTag,
                ...(previous?.evidenceTags ?? []),
            ])).sort(),
        };
    })
        .sort((a, b) => b.score - a.score || b.year - a.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
};

export type MissingRingNeighborSelection = {
    year: number;
    scoreMargin: number;
    consensusMargin: number;
};

const standardizedUnitScores = (
    scores: UnitNeighborScore[],
): Map<number, number> => {
    const values = scores.map((row) => row.combo11);
    const center = mean(values);
    const variance = mean(values.map((value) => (value - center) ** 2));
    const scale = Math.sqrt(Math.max(0, variance)) || 1;
    return new Map(scores.map((row) => [
        row.year,
        (row.combo11 - center) / scale,
    ]));
};

const localUnitPeak = (
    scores: UnitNeighborScore[],
    values: Map<number, number>,
    currentTopYear: number,
): { year: number; margin: number } | null => {
    const ranked = scores
        .filter((row) => Math.abs(row.year - currentTopYear) <= 1)
        .map((row) => ({ year: row.year, score: values.get(row.year) ?? 0 }))
        .sort((left, right) => right.score - left.score || right.year - left.year);
    if (ranked.length < 2) return null;
    return {
        year: ranked[0].year,
        margin: ranked[0].score - ranked[1].score,
    };
};

/**
 * A one-ring boundary is intrinsically ambiguous by one calendar year. Move Top1 only
 * when the short corrected-correlation peak and independent breakpoint consensus select
 * the same immediate neighbour.
 */
export const selectMissingRingNeighborYear = (
    scores: UnitNeighborScore[],
    currentTopYear: number,
    directYear: number | null,
    pairedYear: number | null,
): MissingRingNeighborSelection | null => {
    if (scores.length < 2 || !scores.some((row) => row.year === currentTopYear)) return null;
    const scorePeak = localUnitPeak(
        scores,
        standardizedUnitScores(scores),
        currentTopYear,
    );
    if (!scorePeak || scorePeak.margin < 0.5 || scorePeak.year === currentTopYear) return null;

    const voters = [currentTopYear, directYear, pairedYear]
        .filter((year): year is number => year !== null)
        .sort((left, right) => left - right);
    const consensusYear = voters[Math.floor(voters.length / 2)] ?? currentTopYear;
    const consensusValues = new Map(scores.map((row) => [
        row.year,
        -Math.abs(row.year - consensusYear) / 8,
    ]));
    const consensusPeak = localUnitPeak(scores, consensusValues, currentTopYear);
    if (!consensusPeak
        || consensusPeak.year !== scorePeak.year
        || consensusPeak.year === currentTopYear) {
        return null;
    }
    return {
        year: scorePeak.year,
        scoreMargin: scorePeak.margin,
        consensusMargin: consensusPeak.margin,
    };
};

const noteYear = (
    event: DiagnosisEvent,
    prefix: string,
): number | null => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const year = Number(note?.slice(prefix.length));
    return Number.isFinite(year) ? year : null;
};

export const rerankMissingRingWithNeighborAgreement = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
): DiagnosisEvent => {
    if (event.eventType !== "missingRing"
        || event.evidence.algorithmSources.includes("paired_core_counterfactual_year")) {
        return event;
    }
    const currentTopYear = event.rankedYears[0]?.year
        ?? Math.round((event.startYear + event.endYear) / 2);
    const scores = scoreUnitBoundaries(event, diagnosis, siteData)
        .filter((row) => row.year >= event.startYear && row.year <= event.endYear);
    const selected = selectMissingRingNeighborYear(
        scores,
        currentTopYear,
        noteYear(event, "direct_transition_year="),
        noteYear(event, "paired_breakpoint_year="),
    );
    if (!selected) return event;
    const window = { startYear: event.startYear, endYear: event.endYear };
    return {
        ...event,
        id: `${event.id}-missing-neighbor-rank-${selected.year}`,
        rankedYears: rerank(
            event,
            window,
            selected.year,
            "unit_neighbor_agreement_ranker",
        ),
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "unit_neighbor_agreement_ranker",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                "year_ranking=unit_neighbor_agreement_ranker",
                `unit_neighbor_previous_top_year=${currentTopYear}`,
                `unit_neighbor_selected_year=${selected.year}`,
                `unit_neighbor_score_margin=${selected.scoreMargin.toFixed(6)}`,
                `unit_neighbor_consensus_margin=${selected.consensusMargin.toFixed(6)}`,
            ],
        },
    };
};

const edgeGuardWindow = (
    event: DiagnosisEvent,
    topYear: number,
    diagnosis: SeriesCoreDiagnosis,
    guardYears = 2,
): { startYear: number; endYear: number } => {
    const currentWidth = event.endYear - event.startYear + 1;
    const availableGuard = Math.max(0, 9 - currentWidth);
    const extension = Math.min(guardYears, availableGuard);
    if (extension === 0) {
        if (topYear === event.startYear && event.startYear > diagnosis.targetRange.startYear) {
            return { startYear: event.startYear - 1, endYear: event.endYear - 1 };
        }
        if (topYear === event.endYear && event.endYear < diagnosis.targetRange.endYear) {
            return { startYear: event.startYear + 1, endYear: event.endYear + 1 };
        }
        return { startYear: event.startYear, endYear: event.endYear };
    }
    if (topYear === event.startYear) {
        return {
            startYear: Math.max(diagnosis.targetRange.startYear, event.startYear - extension),
            endYear: event.endYear,
        };
    }
    if (topYear === event.endYear) {
        return {
            startYear: event.startYear,
            endYear: Math.min(diagnosis.targetRange.endYear, event.endYear + extension),
        };
    }
    return { startYear: event.startYear, endYear: event.endYear };
};

const sameWindow = (
    left: { startYear: number; endYear: number },
    right: { startYear: number; endYear: number },
): boolean => left.startYear === right.startYear && left.endYear === right.endYear;

export const addUnitEventRankEdgeGuard = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
): DiagnosisEvent => {
    if ((event.eventType !== "missingRing" && event.eventType !== "falseRing")
        || event.evidence.algorithmSources.includes("edge_rank_guard")) {
        return event;
    }
    const topYear = event.rankedYears[0]?.year;
    if (topYear === undefined) return event;
    const window = edgeGuardWindow(event, topYear, diagnosis);
    if (window.startYear === event.startYear && window.endYear === event.endYear) return event;
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const minimumScore = event.rankedYears.length > 0
        ? Math.min(...event.rankedYears.map((row) => row.score))
        : 0;
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return prior.get(year) ?? {
                year,
                rank: 0,
                score: minimumScore - 1,
                evidenceTags: ["edge_rank_guard"],
            };
        },
    )
        .sort((a, b) => b.score - a.score || a.year - b.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
    const existingLocations = event.locationAlternatives ?? [];
    const originalWidth = event.endYear - event.startYear + 1;
    const olderExtension = event.startYear - window.startYear;
    const newerExtension = window.endYear - event.endYear;
    const continuationStart = olderExtension > 0 && newerExtension === 0
        ? window.startYear - olderExtension
        : newerExtension > 0 && olderExtension === 0
            ? window.endYear + newerExtension - originalWidth + 1
            : null;
    const boundedContinuationStart = continuationStart === null
        ? null
        : Math.max(
            diagnosis.targetRange.startYear,
            Math.min(
                continuationStart,
                diagnosis.targetRange.endYear - originalWidth + 1,
            ),
        );
    const continuation = boundedContinuationStart !== null
        && existingLocations.length < 3
        ? {
            startYear: boundedContinuationStart,
            endYear: boundedContinuationStart + originalWidth - 1,
        }
        : null;
    const locationAlternatives = continuation
        && !sameWindow(continuation, window)
        && !sameWindow(continuation, event)
        && existingLocations.every((location) => !sameWindow(continuation, location))
        ? [
            ...existingLocations,
            {
                rank: existingLocations.length + 1,
                ...continuation,
                rankedYears: rerank(
                    event,
                    continuation,
                    topYear,
                    "continued_edge_guard_location",
                ),
                evidenceScore: event.evidence.score,
                scoreMargin: 0,
                algorithmSource: "continued_edge_guard_location",
            },
        ]
        : existingLocations;
    const addedContinuation = locationAlternatives.length > existingLocations.length;
    return {
        ...event,
        id: `${event.id}-edge-rank-guard-${window.startYear}-${window.endYear}`,
        ...window,
        rankedYears,
        ...(locationAlternatives.length > 0 ? { locationAlternatives } : {}),
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "edge_rank_guard",
                ...(addedContinuation ? ["continued_edge_guard_location"] : []),
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                "window_refinement=edge_rank_guard",
                `window_before=${event.startYear}-${event.endYear}`,
                ...(addedContinuation && continuation ? [
                    `location_option_${locationAlternatives.length}=${continuation.startYear}-${continuation.endYear}`,
                ] : []),
            ],
        },
    };
};

const evidenceEdgePrefixes = [
    "unit_local_difference31_year=",
    "unit_local_whitened31_year=",
    "unit_local_combo31_year=",
    "unit_local_combo41_year=",
    "unit_local_combo61_year=",
    "unit_local_multiScale_year=",
] as const;

export const addUnitEventEvidenceEdgeGuard = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
): DiagnosisEvent => {
    if ((event.eventType !== "missingRing" && event.eventType !== "falseRing")
        || event.evidence.algorithmSources.includes("edge_rank_guard")
        || event.evidence.algorithmSources.includes("long_pulse_consensus")) {
        return event;
    }
    const evidenceYears = evidenceEdgePrefixes
        .map((prefix) => {
            const note = [...event.evidence.notes]
                .reverse()
                .find((value) => value.startsWith(prefix));
            const year = Number(note?.slice(prefix.length));
            return Number.isFinite(year) ? year : null;
        })
        .filter((year): year is number => year !== null);
    const olderSupport = evidenceYears.filter((year) => year <= event.startYear).length;
    const newerSupport = evidenceYears.filter((year) => year >= event.endYear).length;
    if (Math.max(olderSupport, newerSupport) < 3 || olderSupport === newerSupport) return event;
    const direction = olderSupport > newerSupport ? -1 : 1;
    const width = event.endYear - event.startYear + 1;
    const availableWidth = Math.max(0, 9 - width);
    const extension = Math.min(2, availableWidth);
    const requested = direction < 0
        ? {
            startYear: event.startYear - (extension || 2),
            endYear: event.endYear - (extension ? 0 : 2),
        }
        : {
            startYear: event.startYear + (extension ? 0 : 2),
            endYear: event.endYear + (extension || 2),
        };
    const window = {
        startYear: Math.max(diagnosis.targetRange.startYear, requested.startYear),
        endYear: Math.min(diagnosis.targetRange.endYear, requested.endYear),
    };
    if (window.startYear === event.startYear && window.endYear === event.endYear) return event;
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const minimumScore = event.rankedYears.length > 0
        ? Math.min(...event.rankedYears.map((row) => row.score))
        : 0;
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return prior.get(year) ?? {
                year,
                rank: 0,
                score: minimumScore - 1,
                evidenceTags: ["evidence_edge_guard"],
            };
        },
    )
        .sort((a, b) => b.score - a.score || a.year - b.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...event,
        id: `${event.id}-evidence-edge-guard-${window.startYear}-${window.endYear}`,
        ...window,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "evidence_edge_guard",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                "window_refinement=evidence_edge_guard",
                `window_before=${event.startYear}-${event.endYear}`,
                `evidence_edge_support=${olderSupport}-${newerSupport}`,
            ],
        },
    };
};

export const refineUnitEventWithLocalEditScores = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
): DiagnosisEvent => {
    if (event.eventType !== "missingRing" && event.eventType !== "falseRing") return event;
    const scores = scoreUnitBoundaries(event, diagnosis, siteData);
    const windowScores = scores.filter((row) => (
        row.year >= event.startYear && row.year <= event.endYear
    ));
    const independentGuardCore = noteRange(event, "independent_guard_core=");
    const selectionScores = independentGuardCore
        ? windowScores.filter((row) => (
            row.year >= independentGuardCore.startYear
            && row.year <= independentGuardCore.endYear
        ))
        : windowScores;
    const keys = UNIT_SCORE_KEYS;
    const audited = {
        ...event,
        evidence: {
            ...event.evidence,
            notes: [
                ...event.evidence.notes,
                ...keys.map((key) => `unit_local_${key}_year=${top(scores, key)?.year ?? "none"}`),
                ...keys.map((key) => `unit_window_${key}_year=${top(windowScores, key)?.year ?? "none"}`),
                ...(["bestReference31", "pairedCore31"] as const).flatMap((key) => {
                    const peak = peakMargin(windowScores, key);
                    return peak ? [
                        `unit_window_${key}_score=${peak.score.toFixed(6)}`,
                        `unit_window_${key}_margin=${peak.margin.toFixed(6)}`,
                    ] : [];
                }),
            ],
        },
    };
    const rawPeak = top(selectionScores, "raw31");
    if (!rawPeak) return audited;
    const currentTop = event.rankedYears[0]?.year
        ?? Math.round((event.startYear + event.endYear) / 2);
    const bestReferencePeak = top(selectionScores, "bestReference31");
    const pairedCorePeak = top(selectionScores, "pairedCore31");
    const pairedEvidence = peakMargin(selectionScores, "pairedCore31");
    const pairedDistance = pairedCorePeak
        ? Math.abs(pairedCorePeak.year - currentTop)
        : 0;
    const pairedMarginGate = pairedDistance <= 1 ? 0.025 : 0.012;
    const usePairedCore = bestReferencePeak !== null
        && pairedCorePeak !== null
        && pairedEvidence !== null
        && pairedCorePeak.pairedCore31 > -0.5
        && bestReferencePeak.year === pairedCorePeak.year
        && pairedEvidence.margin >= pairedMarginGate;
    const window = { startYear: event.startYear, endYear: event.endYear };
    if (usePairedCore && pairedCorePeak) {
        const guardedWindow = edgeGuardWindow(event, pairedCorePeak.year, diagnosis);
        const guardedScores = scores.filter((row) => (
            row.year >= guardedWindow.startYear && row.year <= guardedWindow.endYear
        ));
        const guardedPeak = event.eventType === "falseRing"
            ? pairedCorePeak
            : top(guardedScores, "pairedCore31") ?? pairedCorePeak;
        const refined = {
            ...audited,
            id: `${event.id}-paired-core-${guardedWindow.startYear}-${guardedWindow.endYear}`,
            ...guardedWindow,
            rankedYears: rerank(
                event,
                guardedWindow,
                guardedPeak.year,
                "paired_core_counterfactual_year",
            ),
            evidence: {
                ...audited.evidence,
                algorithmSources: Array.from(new Set([
                    ...audited.evidence.algorithmSources,
                    "paired_core_counterfactual_year",
                ])).sort(),
                notes: [
                    ...audited.evidence.notes,
                    "year_ranking=paired_core_counterfactual_year",
                    `paired_core_selected_year=${guardedPeak.year}`,
                    `paired_core_selected_margin=${pairedEvidence.margin.toFixed(6)}`,
                    `paired_core_previous_top_year=${currentTop}`,
                    ...(guardedWindow.startYear === window.startYear
                        && guardedWindow.endYear === window.endYear
                        ? []
                        : [
                            "window_refinement=edge_rank_guard",
                            `window_before=${window.startYear}-${window.endYear}`,
                        ]),
                ],
            },
        } satisfies DiagnosisEvent;
        return refined;
    }
    const rawSupport = keys
        .filter((key) => key !== "raw31")
        .map((key) => top(scores, key)?.year ?? null)
        .filter((year) => year !== null && Math.abs(year - rawPeak.year) <= 1)
        .length;
    if (rawPeak.year < event.startYear || rawPeak.year > event.endYear) return audited;
    const guardedWindow = edgeGuardWindow(event, rawPeak.year, diagnosis);
    const guardedScores = scores.filter((row) => (
        row.year >= guardedWindow.startYear && row.year <= guardedWindow.endYear
    ));
    const guardedRawPeak = event.eventType === "falseRing"
        ? rawPeak
        : top(guardedScores, "raw31") ?? rawPeak;
    const refined = {
        ...audited,
        id: `${event.id}-local-raw-${guardedWindow.startYear}-${guardedWindow.endYear}`,
        ...guardedWindow,
        rankedYears: rerank(event, guardedWindow, guardedRawPeak.year),
        evidence: {
            ...audited.evidence,
            algorithmSources: Array.from(new Set([
                ...audited.evidence.algorithmSources,
                "local_counterfactual_raw_year",
            ])).sort(),
            notes: [
                ...audited.evidence.notes,
                "window_refinement=local_counterfactual_raw_year",
                `unit_local_raw_boundary_year=${guardedRawPeak.year}`,
                `unit_local_raw_boundary_support=${rawSupport}`,
                `unit_local_previous_top_year=${currentTop}`,
                ...(guardedWindow.startYear === window.startYear
                    && guardedWindow.endYear === window.endYear
                    ? []
                    : [
                        "window_refinement=edge_rank_guard",
                        `window_before=${window.startYear}-${window.endYear}`,
                    ]),
            ],
        },
    } satisfies DiagnosisEvent;
    return refined;
};

export const restoreUnitEventLocalYearRanking = (
    event: DiagnosisEvent,
): DiagnosisEvent => {
    if ((event.eventType !== "missingRing" && event.eventType !== "falseRing")
        || event.evidence.algorithmSources.includes("paired_core_counterfactual_year")) {
        return event;
    }
    const selectedNote = [...event.evidence.notes]
        .reverse()
        .find((note) => (
            note.startsWith("unit_local_raw_boundary_year=")
            || note.startsWith("unit_window_raw31_year=")
        ));
    const selectedYear = Number(selectedNote?.slice((selectedNote?.indexOf("=") ?? -1) + 1));
    if (!Number.isFinite(selectedYear)
        || selectedYear < event.startYear
        || selectedYear > event.endYear
        || event.rankedYears[0]?.year === selectedYear) {
        return event;
    }
    const window = { startYear: event.startYear, endYear: event.endYear };
    return {
        ...event,
        id: `${event.id}-final-local-raw-${selectedYear}`,
        rankedYears: rerank(event, window, selectedYear, "final_local_raw_year"),
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "final_local_raw_year",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                "year_ranking=final_local_raw_year",
                `final_local_raw_previous_top_year=${event.rankedYears[0]?.year ?? "none"}`,
                `final_local_raw_selected_year=${selectedYear}`,
            ],
        },
    };
};

export const addFalseRingUnscoredBoundaryGuard = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
): DiagnosisEvent => {
    if (event.eventType !== "falseRing"
        || event.endYear - event.startYear + 1 > 7
        || event.evidence.notes.some((note) => (
            note.startsWith("unit_window_raw31_year=")
            || note.startsWith("scan_top_year=")
        ))) {
        return event;
    }
    const window = {
        startYear: Math.max(diagnosis.targetRange.startYear, event.startYear - 1),
        endYear: Math.min(diagnosis.targetRange.endYear, event.endYear + 1),
    };
    if (window.startYear === event.startYear && window.endYear === event.endYear) return event;
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    const minimumScore = event.rankedYears.length > 0
        ? Math.min(...event.rankedYears.map((row) => row.score))
        : 0;
    const rankedYears = Array.from(
        { length: window.endYear - window.startYear + 1 },
        (_, index) => {
            const year = window.startYear + index;
            return prior.get(year) ?? {
                year,
                rank: 0,
                score: minimumScore - 1,
                evidenceTags: ["unscored_boundary_guard"],
            };
        },
    )
        .sort((a, b) => b.score - a.score || a.year - b.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
    return {
        ...event,
        id: `${event.id}-unscored-guard-${window.startYear}-${window.endYear}`,
        ...window,
        rankedYears,
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "unscored_boundary_guard",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                "window_refinement=unscored_boundary_guard",
                `window_before=${event.startYear}-${event.endYear}`,
            ],
        },
    };
};

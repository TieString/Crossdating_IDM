/** Exact structural refinement for an older-side move that overlaps the fixed newer side. */
import type {
    DiagnosisEvent,
    DiagnosisRankedYear,
    NumericSeries,
    SeriesCoreDiagnosis,
} from "./types";
import {
    ar1WhitenSeries,
    correlationForSegment,
    preprocessSeries,
} from "./series";
import { firstFixedYearFromLastMovedYear } from "./partialMoveSemantics";

export type RepeatedBlockBoundary = {
    year: number;
    blockLength: number;
    comparedValues: number;
};

export type GapBoundaryScore = {
    year: number;
    raw31: number;
    difference31: number;
    whitened31: number;
    combo31: number;
    combo41: number;
    combo61: number;
    multiScale: number;
};

const NEGATIVE_PARTIAL_BOUNDARY_CACHE = new WeakMap<
    SeriesCoreDiagnosis,
    Map<number, GapBoundaryScore[]>
>();

const positiveFinite = (value: number | undefined): value is number => (
    value !== undefined && Number.isFinite(value) && value > 0
);

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

const moveOlderSide = (
    series: NumericSeries,
    boundaryYear: number,
    shiftYears: number,
): NumericSeries => {
    const result = new Map<number, number>();
    series.forEach((value, year) => {
        result.set(year <= boundaryYear ? year + shiftYears : year, value);
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

const combinedLocalCorrelation = (
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

export const scoreNegativePartialMoveBoundaries = (
    diagnosis: SeriesCoreDiagnosis,
    shiftYears: number,
): GapBoundaryScore[] => {
    if (shiftYears >= -1) return [];
    const byShift = NEGATIVE_PARTIAL_BOUNDARY_CACHE.get(diagnosis) ?? new Map();
    const cached = byShift.get(shiftYears);
    if (cached) return cached;
    const scores: GapBoundaryScore[] = [];
    const master = diagnosis.master.data;
    const masterDifference = firstDifferences(master);
    const masterWhitened = ar1WhitenSeries(master);
    for (
        let lastMovedYear = diagnosis.targetRange.startYear + 15;
        lastMovedYear <= diagnosis.targetRange.endYear - 15;
        lastMovedYear += 1
    ) {
        const firstFixedYear = firstFixedYearFromLastMovedYear(lastMovedYear);
        const moved = moveOlderSide(
            diagnosis.rawTarget,
            lastMovedYear,
            shiftYears,
        );
        const raw = preprocessSeries(moved);
        const difference = firstDifferences(moved);
        const whitened = ar1WhitenSeries(moved);
        const raw31 = localCorrelation(raw, master, firstFixedYear, 31);
        const difference31 = localCorrelation(
            difference,
            masterDifference,
            firstFixedYear,
            31,
        );
        const whitened31 = localCorrelation(
            whitened,
            masterWhitened,
            firstFixedYear,
            31,
        );
        const combo31 = raw31 * 0.35 + difference31 * 0.4 + whitened31 * 0.25;
        const combo41 = combinedLocalCorrelation(
            raw,
            difference,
            whitened,
            master,
            masterDifference,
            masterWhitened,
            firstFixedYear,
            41,
        );
        const combo61 = combinedLocalCorrelation(
            raw,
            difference,
            whitened,
            master,
            masterDifference,
            masterWhitened,
            firstFixedYear,
            61,
        );
        scores.push({
            year: firstFixedYear,
            raw31,
            difference31,
            whitened31,
            combo31,
            combo41,
            combo61,
            multiScale: combo31 * 0.5 + combo41 * 0.3 + combo61 * 0.2,
        });
    }
    byShift.set(shiftYears, scores);
    NEGATIVE_PARTIAL_BOUNDARY_CACHE.set(diagnosis, byShift);
    return scores;
};

const topGapYear = (
    scores: GapBoundaryScore[],
    key: keyof Omit<GapBoundaryScore, "year">,
): number | null => [...scores]
    .sort((a, b) => b[key] - a[key] || b.year - a.year)[0]?.year ?? null;

const topGapScore = (
    scores: GapBoundaryScore[],
    key: keyof Omit<GapBoundaryScore, "year">,
): GapBoundaryScore | null => [...scores]
    .sort((a, b) => b[key] - a[key] || b.year - a.year)[0] ?? null;

/**
 * A positive correction of k years means the corrupted older-side suffix repeats the first
 * k fixed values on the newer side. Require one unique exact block across the complete core;
 * approximate matches are intentionally ignored because integer ring widths can coincide.
 */
export const findUniqueRepeatedBlockBoundary = (
    series: NumericSeries,
    shiftYears: number,
): RepeatedBlockBoundary | null => {
    const blockLength = Math.abs(Math.trunc(shiftYears));
    if (shiftYears <= 1 || blockLength < 2) return null;
    const years = Array.from(series.keys()).sort((a, b) => a - b);
    if (years.length < blockLength * 2 + 2) return null;
    const minimumYear = years[0] + blockLength - 1;
    const maximumYear = years[years.length - 1] - blockLength;
    const exact: RepeatedBlockBoundary[] = [];

    for (let year = minimumYear; year <= maximumYear; year += 1) {
        let comparedValues = 0;
        let matches = true;
        for (let index = 1; index <= blockLength; index += 1) {
            const older = series.get(year - blockLength + index);
            const newer = series.get(year + index);
            if (!positiveFinite(older) || !positiveFinite(newer) || older !== newer) {
                matches = false;
                break;
            }
            comparedValues += 1;
        }
        if (matches) exact.push({ year, blockLength, comparedValues });
    }
    return exact.length === 1 ? exact[0] : null;
};

const boundedWindow = (
    centerYear: number,
    width: number,
    diagnosis: SeriesCoreDiagnosis,
): { startYear: number; endYear: number } => {
    const available = diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1;
    const actualWidth = Math.max(1, Math.min(width, available));
    let startYear = centerYear - Math.floor((actualWidth - 1) / 2);
    startYear = Math.max(
        diagnosis.targetRange.startYear,
        Math.min(startYear, diagnosis.targetRange.endYear - actualWidth + 1),
    );
    return { startYear, endYear: startYear + actualWidth - 1 };
};

const rerank = (
    event: DiagnosisEvent,
    startYear: number,
    endYear: number,
    boundaryYear: number,
    evidenceTag = "unique_repeated_block_boundary",
): DiagnosisRankedYear[] => {
    const prior = new Map(event.rankedYears.map((row) => [row.year, row]));
    return Array.from({ length: endYear - startYear + 1 }, (_, index) => {
        const year = startYear + index;
        const previous = prior.get(year);
        return {
            year,
            score: year === boundaryYear
                ? 2
                : 1 / (1 + Math.abs(year - boundaryYear))
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

const mean = (values: number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

export type NegativePartialNeighborSelection = {
    year: number;
    rawMargin: number;
    comboMargin: number;
};

export type NegativePartialConsensusSelection = {
    year: number;
    support: number;
    distanceToWindow: number;
};

const NEGATIVE_PARTIAL_CONSENSUS_KEYS = [
    "difference31",
    "whitened31",
    "combo31",
    "combo41",
    "combo61",
    "multiScale",
] as const;

const distanceToWindow = (
    year: number,
    startYear: number,
    endYear: number,
): number => (
    year < startYear ? startYear - year : year > endYear ? year - endYear : 0
);

/**
 * Correlated views are only allowed to move a negative-partial window when at least three
 * peaks form the same local cluster and that cluster remains close to the path window.
 */
export const selectNegativePartialConsensusYear = (
    scores: GapBoundaryScore[],
    startYear: number,
    endYear: number,
    currentTopYear: number,
    maximumOutsideYears = 3,
): NegativePartialConsensusSelection | null => {
    const peakYears = NEGATIVE_PARTIAL_CONSENSUS_KEYS
        .map((key) => topGapYear(scores, key))
        .filter((year): year is number => year !== null);
    const candidates = Array.from(new Set(peakYears)).map((year) => {
        const cluster = peakYears
            .filter((candidate) => Math.abs(candidate - year) <= 1)
            .sort((a, b) => a - b);
        const representative = cluster[Math.floor((cluster.length - 1) / 2)];
        return {
            year: representative,
            support: cluster.length,
            distanceToWindow: distanceToWindow(representative, startYear, endYear),
        };
    });
    return candidates
        .filter((candidate) => (
            candidate.support >= 3
            && candidate.distanceToWindow <= maximumOutsideYears
        ))
        .sort((left, right) => (
            right.support - left.support
            || left.distanceToWindow - right.distanceToWindow
            || Math.abs(left.year - currentTopYear) - Math.abs(right.year - currentTopYear)
            || right.year - left.year
        ))[0] ?? null;
};

const standardizedScores = (
    scores: GapBoundaryScore[],
    key: keyof Omit<GapBoundaryScore, "year">,
): Map<number, number> => {
    const values = scores.map((row) => row[key]);
    const center = mean(values);
    const variance = mean(values.map((value) => (value - center) ** 2));
    const scale = Math.sqrt(Math.max(0, variance)) || 1;
    return new Map(scores.map((row) => [row.year, (row[key] - center) / scale]));
};

const localPeak = (
    scores: GapBoundaryScore[],
    normalized: Map<number, number>,
    currentTopYear: number,
    minimumMargin: number,
): { year: number; margin: number } | null => {
    const ranked = scores
        .filter((row) => Math.abs(row.year - currentTopYear) <= 1)
        .map((row) => ({ year: row.year, score: normalized.get(row.year) ?? 0 }))
        .sort((left, right) => right.score - left.score || right.year - left.year);
    if (ranked.length < 2) return null;
    const margin = ranked[0].score - ranked[1].score;
    return margin >= minimumMargin ? { year: ranked[0].year, margin } : null;
};

/**
 * Adjacent boundary candidates differ by one ring, so broad-window maxima can be remote
 * even when the immediate neighbour is better. Move Top1 by one year only when raw and
 * multi-scale corrected correlations independently select the same neighbour.
 */
export const selectNegativePartialNeighborYear = (
    scores: GapBoundaryScore[],
    currentTopYear: number,
): NegativePartialNeighborSelection | null => {
    if (scores.length < 2 || !scores.some((row) => row.year === currentTopYear)) return null;
    const raw = localPeak(
        scores,
        standardizedScores(scores, "raw31"),
        currentTopYear,
        0.1,
    );
    const combo = localPeak(
        scores,
        standardizedScores(scores, "combo41"),
        currentTopYear,
        0.05,
    );
    if (!raw || !combo || raw.year !== combo.year || raw.year === currentTopYear) return null;
    return {
        year: raw.year,
        rawMargin: raw.margin,
        comboMargin: combo.margin,
    };
};

const rerankNegativePartialWithNeighborAgreement = (
    event: DiagnosisEvent,
    allScores: GapBoundaryScore[],
): DiagnosisEvent => {
    const scores = allScores.filter((row) => (
        row.year >= event.startYear && row.year <= event.endYear
    ));
    if (event.eventType !== "partialMove" || scores.length < 2) return event;
    const currentTopYear = event.rankedYears[0]?.year
        ?? Math.round((event.startYear + event.endYear) / 2);
    const selected = selectNegativePartialNeighborYear(scores, currentTopYear);
    if (!selected) return event;
    return {
        ...event,
        id: `${event.id}-partial-neighbor-rank-${selected.year}`,
        rankedYears: rerank(
            event,
            event.startYear,
            event.endYear,
            selected.year,
            "partial_neighbor_agreement_ranker",
        ),
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "partial_neighbor_agreement_ranker",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                "year_ranking=partial_neighbor_agreement_ranker",
                `partial_neighbor_previous_top_year=${currentTopYear}`,
                `partial_neighbor_selected_year=${selected.year}`,
                `partial_neighbor_raw_margin=${selected.rawMargin.toFixed(6)}`,
                `partial_neighbor_combo_margin=${selected.comboMargin.toFixed(6)}`,
            ],
        },
    };
};

export const refinePartialMoveWithRepeatedBlock = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
    enableWindowRanking = true,
): DiagnosisEvent => {
    if (event.eventType !== "partialMove" || event.shiftSide !== "older") return event;
    if ((event.shiftYears ?? 0) < -1) {
        const gapScores = scoreNegativePartialMoveBoundaries(
            diagnosis,
            event.shiftYears ?? 0,
        );
        const gapNotes = ([
            "raw31",
            "difference31",
            "whitened31",
            "combo31",
            "combo41",
            "combo61",
            "multiScale",
        ] as const).map((key) => `partial_gap_${key}_year=${topGapYear(gapScores, key) ?? "none"}`);
        const audited = {
            ...event,
            evidence: {
                ...event.evidence,
                notes: [...event.evidence.notes, ...gapNotes],
            },
        };
        const rawPeak = topGapScore(gapScores, "raw31");
        const currentTop = event.rankedYears[0]?.year
            ?? Math.round((event.startYear + event.endYear) / 2);
        if (!rawPeak) {
            return enableWindowRanking
                ? rerankNegativePartialWithNeighborAgreement(audited, gapScores)
                : audited;
        }
        const otherPeakYears = ([
            "difference31",
            "whitened31",
            "combo31",
            "combo41",
            "combo61",
            "multiScale",
        ] as const).map((key) => topGapYear(gapScores, key));
        const consensus = selectNegativePartialConsensusYear(
            gapScores,
            event.startYear,
            event.endYear,
            currentTop,
        );
        if (consensus && consensus.year !== currentTop) {
            const width = event.endYear - event.startYear + 1;
            const window = boundedWindow(consensus.year, width, diagnosis);
            return {
                ...audited,
                id: `${event.id}-partial-consensus-${window.startYear}-${window.endYear}`,
                ...window,
                rankedYears: rerank(
                    event,
                    window.startYear,
                    window.endYear,
                    consensus.year,
                    "negative_partial_multiview_consensus",
                ),
                evidence: {
                    ...audited.evidence,
                    algorithmSources: Array.from(new Set([
                        ...audited.evidence.algorithmSources,
                        "negative_partial_multiview_consensus",
                    ])).sort(),
                    notes: [
                        ...audited.evidence.notes,
                        "window_refinement=negative_partial_multiview_consensus",
                        `partial_consensus_year=${consensus.year}`,
                        `partial_consensus_support=${consensus.support}`,
                        `partial_consensus_distance_to_window=${consensus.distanceToWindow}`,
                        `partial_consensus_previous_top_year=${currentTop}`,
                    ],
                },
            };
        }
        const rawSupport = otherPeakYears.filter((year) => (
            year !== null && Math.abs(year - rawPeak.year) <= 1
        )).length;
        const currentSupport = otherPeakYears.filter((year) => year === currentTop).length;
        const atScanEdge = rawPeak.year <= diagnosis.targetRange.startYear + 32
            || rawPeak.year >= diagnosis.targetRange.endYear - 32;
        const distance = Math.abs(rawPeak.year - currentTop);
        const keepCurrentNearbyConsensus = distance <= 1 && currentSupport >= 2;
        const acceptRemote = distance <= 15 || (distance <= 24 && rawSupport >= 3);
        if (atScanEdge || keepCurrentNearbyConsensus || !acceptRemote) {
            return enableWindowRanking
                ? rerankNegativePartialWithNeighborAgreement(audited, gapScores)
                : audited;
        }

        const width = event.endYear - event.startYear + 1;
        const window = boundedWindow(rawPeak.year, width, diagnosis);
        const refined = {
            ...audited,
            id: `${event.id}-local-raw-${window.startYear}-${window.endYear}`,
            ...window,
            rankedYears: rerank(
                event,
                window.startYear,
                window.endYear,
                rawPeak.year,
                "local_corrected_raw_breakpoint",
            ),
            evidence: {
                ...audited.evidence,
                algorithmSources: Array.from(new Set([
                    ...audited.evidence.algorithmSources,
                    "local_corrected_raw_breakpoint",
                ])).sort(),
                notes: [
                    ...audited.evidence.notes,
                    "window_refinement=local_corrected_raw_breakpoint",
                    `local_raw_boundary_year=${rawPeak.year}`,
                    `local_raw_boundary_support=${rawSupport}`,
                    `local_raw_previous_top_year=${currentTop}`,
                ],
            },
        } satisfies DiagnosisEvent;
        return enableWindowRanking
            ? rerankNegativePartialWithNeighborAgreement(refined, gapScores)
            : refined;
    }
    const boundary = findUniqueRepeatedBlockBoundary(
        diagnosis.rawTarget,
        event.shiftYears ?? 0,
    );
    if (!boundary) return event;
    // Keep the diagnostic span intact through event merging. The final presentation
    // pass can safely narrow this exact structural boundary without changing deduplication.
    const width = event.endYear - event.startYear + 1;
    const window = boundedWindow(boundary.year, width, diagnosis);
    return {
        ...event,
        id: `${event.id}-repeated-block-${window.startYear}-${window.endYear}`,
        ...window,
        rankedYears: rerank(event, window.startYear, window.endYear, boundary.year),
        evidence: {
            ...event.evidence,
            algorithmSources: Array.from(new Set([
                ...event.evidence.algorithmSources,
                "unique_repeated_block_boundary",
            ])).sort(),
            notes: [
                ...event.evidence.notes,
                "window_refinement=unique_repeated_block_boundary",
                `repeated_block_boundary_year=${boundary.year}`,
                `repeated_block_length=${boundary.blockLength}`,
            ],
        },
    };
};

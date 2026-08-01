/**
 * Reference-wise lag-transition consensus.
 *
 * Each reference series first scores every calendar boundary independently while marginalizing
 * its absolute lag. Per-reference profiles are rank-normalized before aggregation so a single
 * high-amplitude reference cannot dominate the location distribution.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import {
    ar1WhitenSeries,
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import {
    DEFAULT_MAX_PARTIAL_GAP_YEARS,
    getAutomaticEventShiftCandidates,
} from "./partialMoveSemantics";
import type { DiagnosisEventType, NumericSeries, SeriesCoreDiagnosis } from "./types";

export type ReferenceTransitionConsensusOptions = {
    correctionYears?: number[];
    minSideYears?: number;
    maxReferences?: number;
    baselineLagRadius?: number;
};

export type ReferenceTransitionConsensusRow = {
    year: number;
    correctionYears: number;
    eventType: DiagnosisEventType;
    referenceCount: number;
    rankMean: number;
    rankMedian: number;
    weightedRankMean: number;
    peakKernel5: number;
    peakKernel9: number;
    peakKernel13: number;
    windowVote25: number;
    weightedWindowVote25: number;
    positiveGainFraction: number;
    baselineModeFraction: number;
};

type PreparedViews = {
    raw: NumericSeries;
    difference: NumericSeries;
    whitened: NumericSeries;
};

type PreparedReference = PreparedViews & {
    weight: number;
};

type Prefix = {
    scores: number[];
    counts: number[];
};

type ReferenceProfileRow = {
    year: number;
    gain: number;
    rank: number;
    newerLag: number;
};

type ReferenceProfile = {
    weight: number;
    peakYear: number;
    windowStartYear: number;
    windowEndYear: number;
    rows: ReferenceProfileRow[];
};

const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
};

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = [...series.entries()].sort((a, b) => a[0] - b[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return preprocessSeries(result);
};

const prepareViews = (series: NumericSeries): PreparedViews => ({
    raw: preprocessSeries(series),
    difference: firstDifferences(series),
    whitened: ar1WhitenSeries(series),
});

const huberLoss = (residual: number, transition = 1.5): number => {
    const absolute = Math.abs(residual);
    return absolute <= transition
        ? 0.5 * residual * residual
        : transition * (absolute - transition * 0.5);
};

const emissionFor = (
    target: PreparedViews,
    reference: PreparedReference,
    year: number,
    lag: number,
): number | null => {
    const viewWeights = {
        raw: 0.25,
        difference: 0.4,
        whitened: 0.35,
    } as const;
    let score = 0;
    let weight = 0;
    (Object.keys(viewWeights) as Array<keyof typeof viewWeights>).forEach((view) => {
        const targetValue = target[view].get(year);
        const referenceValue = reference[view].get(year + lag);
        if (targetValue === undefined || referenceValue === undefined) return;
        score -= viewWeights[view] * huberLoss(targetValue - referenceValue);
        weight += viewWeights[view];
    });
    return weight >= 0.6 ? score / weight : null;
};

const percentileRanks = (values: number[]): number[] => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((a, b) => a.value - b.value || a.index - b.index);
    const result = new Array(values.length).fill(0);
    let start = 0;
    while (start < ordered.length) {
        let end = start + 1;
        while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1;
        const rank = ((start + end - 1) / 2) / Math.max(1, ordered.length - 1);
        for (let index = start; index < end; index += 1) {
            result[ordered[index].index] = rank;
        }
        start = end;
    }
    return result;
};

const range = (
    prefix: Prefix,
    startIndex: number,
    endIndex: number,
): { score: number; count: number } => {
    if (endIndex < startIndex) return { score: 0, count: 0 };
    return {
        score: prefix.scores[endIndex + 1] - prefix.scores[startIndex],
        count: prefix.counts[endIndex + 1] - prefix.counts[startIndex],
    };
};

const bestMassWindow = (
    rows: Array<{ year: number; rank: number }>,
    width: number,
): { startYear: number; endYear: number } => {
    let best = {
        startYear: rows[0].year,
        endYear: rows[0].year + width - 1,
        mass: Number.NEGATIVE_INFINITY,
    };
    for (let startIndex = 0; startIndex < rows.length; startIndex += 1) {
        const startYear = rows[startIndex].year;
        const endYear = startYear + width - 1;
        let mass = 0;
        for (let index = startIndex; index < rows.length; index += 1) {
            if (rows[index].year > endYear) break;
            mass += rows[index].rank;
        }
        if (mass > best.mass) best = { startYear, endYear, mass };
    }
    return best;
};

const scoreReferenceProfile = (
    target: PreparedViews,
    reference: PreparedReference,
    startYear: number,
    endYear: number,
    correctionYears: number,
    baselineLagRadius: number,
    minSideYears: number,
): ReferenceProfile | null => {
    const baselineLags = Array.from(
        { length: baselineLagRadius * 2 + 1 },
        (_, index) => index - baselineLagRadius,
    );
    const states = [...new Set(baselineLags.flatMap(
        (lag) => [lag, lag + correctionYears],
    ))].sort((a, b) => a - b);
    const years = Array.from(
        { length: endYear - startYear + 1 },
        (_, index) => startYear + index,
    );
    const emissions = new Map<number, Array<number | null>>(states.map((lag) => [
        lag,
        years.map((year) => emissionFor(target, reference, year, lag)),
    ]));
    const common = years.map((_, index) => (
        states.every((lag) => emissions.get(lag)?.[index] !== null)
    ));
    const prefixes = new Map<number, Prefix>(states.map((lag) => {
        const scores = [0];
        const counts = [0];
        emissions.get(lag)!.forEach((value, index) => {
            const usable = common[index] && value !== null;
            scores.push(scores[scores.length - 1] + (usable ? value : 0));
            counts.push(counts[counts.length - 1] + Number(usable));
        });
        return [lag, { scores, counts }];
    }));
    const lastIndex = years.length - 1;
    const nullScore = Math.max(...baselineLags.map(
        (lag) => range(prefixes.get(lag)!, 0, lastIndex).score,
    ));
    const rows: Array<Omit<ReferenceProfileRow, "rank">> = [];
    for (
        let boundaryIndex = minSideYears - 1;
        boundaryIndex <= lastIndex - minSideYears;
        boundaryIndex += 1
    ) {
        let best: { gain: number; newerLag: number } | null = null;
        for (const newerLag of baselineLags) {
            const olderLag = newerLag + correctionYears;
            const older = range(prefixes.get(olderLag)!, 0, boundaryIndex);
            const newer = range(prefixes.get(newerLag)!, boundaryIndex + 1, lastIndex);
            if (older.count < minSideYears || newer.count < minSideYears) continue;
            const gain = (
                older.score + newer.score - nullScore
            ) / Math.sqrt(Math.max(1, older.count + newer.count));
            if (!best || gain > best.gain) best = { gain, newerLag };
        }
        if (best) rows.push({ year: years[boundaryIndex], ...best });
    }
    if (rows.length < 15) return null;
    const ranks = percentileRanks(rows.map((row) => row.gain));
    const rankedRows = rows.map((row, index) => ({ ...row, rank: ranks[index] }));
    const peak = rankedRows.reduce(
        (best, row) => row.rank > best.rank ? row : best,
        rankedRows[0],
    );
    const window = bestMassWindow(rankedRows, 25);
    return {
        weight: reference.weight,
        peakYear: peak.year,
        windowStartYear: window.startYear,
        windowEndYear: window.endYear,
        rows: rankedRows,
    };
};

const eventTypeFor = (correctionYears: number): DiagnosisEventType => (
    Math.abs(correctionYears) > 1
        ? "partialMove"
        : correctionYears < 0
            ? "missingRing"
            : "falseRing"
);

export const scoreReferenceTransitionConsensus = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    options: ReferenceTransitionConsensusOptions = {},
): ReferenceTransitionConsensusRow[] => {
    const minSideYears = Math.max(8, Math.floor(options.minSideYears ?? 18));
    const correctionYears = options.correctionYears
        ?? getAutomaticEventShiftCandidates({
            maxPartialGapYears: DEFAULT_MAX_PARTIAL_GAP_YEARS,
            lagMin: -DEFAULT_MAX_PARTIAL_GAP_YEARS,
            seriesLength:
                diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
            minimumSideYears: minSideYears,
        });
    const maxReferences = Math.max(3, Math.floor(options.maxReferences ?? 20));
    const baselineLagRadius = Math.max(1, Math.floor(options.baselineLagRadius ?? 3));
    const target = prepareViews(diagnosis.rawTarget);
    const references: PreparedReference[] = diagnosis.master.sourceTrees
        .map((tree) => toNumericSeries(siteData.get(tree)))
        .filter((series) => series.size >= 40)
        .map((series) => {
            const views = prepareViews(series);
            const correlation = Array.from(
                { length: baselineLagRadius * 2 + 1 },
                (_, index) => index - baselineLagRadius,
            ).reduce((best, lag) => Math.max(
                best,
                correlationForSegment(
                    target.raw,
                    views.raw,
                    diagnosis.targetRange.startYear,
                    diagnosis.targetRange.endYear,
                    lag,
                    30,
                ).correlation ?? -1,
            ), -1);
            return {
                ...views,
                correlation,
                weight: Math.max(0.05, correlation + 0.15),
            };
        })
        .filter((reference) => reference.correlation > -0.1)
        .sort((a, b) => b.correlation - a.correlation)
        .slice(0, maxReferences);
    const result: ReferenceTransitionConsensusRow[] = [];
    correctionYears.forEach((correction) => {
        const profiles = references
            .map((reference) => scoreReferenceProfile(
                target,
                reference,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
                correction,
                baselineLagRadius,
                minSideYears,
            ))
            .filter((profile): profile is ReferenceProfile => profile !== null);
        if (profiles.length < 3) return;
        const rowsByReference = profiles.map((profile) => new Map(
            profile.rows.map((row) => [row.year, row]),
        ));
        for (
            let year = diagnosis.targetRange.startYear + minSideYears - 1;
            year <= diagnosis.targetRange.endYear - minSideYears;
            year += 1
        ) {
            const available = profiles.flatMap((profile, index) => {
                const row = rowsByReference[index].get(year);
                return row ? [{ profile, row }] : [];
            });
            if (available.length < 3) continue;
            const totalWeight = available.reduce(
                (sum, item) => sum + item.profile.weight,
                0,
            );
            const modeCounts = new Map<number, number>();
            available.forEach(({ row }) => {
                modeCounts.set(row.newerLag, (modeCounts.get(row.newerLag) ?? 0) + 1);
            });
            const kernel = (radius: number) => available.reduce((sum, item) => (
                sum + Math.exp(-0.5 * ((year - item.profile.peakYear) / radius) ** 2)
            ), 0) / available.length;
            result.push({
                year,
                correctionYears: correction,
                eventType: eventTypeFor(correction),
                referenceCount: available.length,
                rankMean: available.reduce((sum, item) => sum + item.row.rank, 0)
                    / available.length,
                rankMedian: median(available.map((item) => item.row.rank)),
                weightedRankMean: available.reduce(
                    (sum, item) => sum + item.row.rank * item.profile.weight,
                    0,
                ) / totalWeight,
                peakKernel5: kernel(2.5),
                peakKernel9: kernel(4.5),
                peakKernel13: kernel(6.5),
                windowVote25: available.filter((item) => (
                    year >= item.profile.windowStartYear
                    && year <= item.profile.windowEndYear
                )).length / available.length,
                weightedWindowVote25: available.reduce((sum, item) => (
                    sum + (
                        year >= item.profile.windowStartYear
                        && year <= item.profile.windowEndYear
                            ? item.profile.weight
                            : 0
                    )
                ), 0) / totalWeight,
                positiveGainFraction: available.filter((item) => item.row.gain > 0).length
                    / available.length,
                baselineModeFraction: Math.max(...modeCounts.values()) / available.length,
            });
        }
    });
    return result;
};

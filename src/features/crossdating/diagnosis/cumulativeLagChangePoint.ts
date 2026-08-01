import { cofechaStyleStandardize } from "../reference";
import {
    ar1WhitenSeries,
    correlationForSegment,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    DEFAULT_MAX_PARTIAL_GAP_YEARS,
    getAutomaticEventShiftCandidates,
} from "./partialMoveSemantics";
import type { NumericSeries, SeriesCoreDiagnosis } from "./types";

export type CumulativeLagChangePointScore = {
    year: number;
    olderLag: number;
    combinedCumulative: number;
    combinedCusum: number;
    combinedContrast: number;
    combinedLocal31: number;
    combinedLocal61: number;
    rawCumulative: number;
    rawCusum: number;
    rawContrast: number;
    differenceCumulative: number;
    differenceCusum: number;
    differenceContrast: number;
    whitenedCumulative: number;
    whitenedCusum: number;
    whitenedContrast: number;
    cofechaCumulative: number;
    cofechaCusum: number;
    cofechaContrast: number;
    referenceMedianCumulative: number;
    referenceMedianCusum: number;
    referenceMedianContrast: number;
    referenceMeanCumulative: number;
    referenceMeanCusum: number;
    referenceMeanContrast: number;
    referenceVoteCumulative: number;
    referenceVoteCusum: number;
    referenceVoteContrast: number;
};

export type CumulativeLagChangePointOptions = {
    lags?: number[];
    minSideYears?: number;
    siteData?: RwlSiteData;
};

type ViewName = "raw" | "difference" | "whitened" | "cofecha";

type View = {
    name: ViewName;
    target: NumericSeries;
    master: NumericSeries;
    weight: number;
};

type PreferenceRow = {
    year: number;
    value: number;
};

type Prefix = {
    years: number[];
    sums: number[];
    counts: number[];
};

type PreparedReference = {
    raw: NumericSeries;
    difference: NumericSeries;
    whitened: NumericSeries;
    weight: number;
};

type PreparedReferenceContext = {
    target: {
        raw: NumericSeries;
        difference: NumericSeries;
        whitened: NumericSeries;
    };
    references: PreparedReference[];
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

const cofechaPreprocess = (series: NumericSeries): NumericSeries => new Map(
    cofechaStyleStandardize(series).map((point) => [point.year, point.value]),
);

const viewsFor = (
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis | null,
): View[] => {
    const rawTarget = preprocessSeries(diagnosis.rawTarget);
    const rawMaster = preprocessSeries(diagnosis.master.data);
    const views: View[] = [
        {
            name: "raw",
            target: rawTarget,
            master: rawMaster,
            weight: 0.25,
        },
        {
            name: "difference",
            target: firstDifferences(diagnosis.rawTarget),
            master: firstDifferences(diagnosis.master.data),
            weight: 0.35,
        },
        {
            name: "whitened",
            target: ar1WhitenSeries(diagnosis.rawTarget),
            master: ar1WhitenSeries(diagnosis.master.data),
            weight: 0.25,
        },
    ];
    if (cofechaDiagnosis) {
        views.push({
            name: "cofecha",
            target: cofechaPreprocess(diagnosis.rawTarget),
            master: preprocessSeries(cofechaDiagnosis.master.data),
            weight: 0.15,
        });
    }
    const totalWeight = views.reduce((sum, view) => sum + view.weight, 0);
    return views.map((view) => ({ ...view, weight: view.weight / totalWeight }));
};

const huberLoss = (residual: number, transition = 1.5): number => {
    const absolute = Math.abs(residual);
    return absolute <= transition
        ? 0.5 * residual * residual
        : transition * (absolute - transition * 0.5);
};

const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
};

const preferenceRows = (
    view: View,
    diagnosis: SeriesCoreDiagnosis,
    olderLag: number,
): PreferenceRow[] => {
    const result: PreferenceRow[] = [];
    for (
        let year = diagnosis.targetRange.startYear;
        year <= diagnosis.targetRange.endYear;
        year += 1
    ) {
        const target = view.target.get(year);
        const zero = view.master.get(year);
        const shifted = view.master.get(year + olderLag);
        if (target === undefined || zero === undefined || shifted === undefined) continue;
        const zeroLoss = huberLoss(target - zero);
        const shiftedLoss = huberLoss(target - shifted);
        result.push({
            year,
            value: zeroLoss - shiftedLoss,
        });
    }
    return result;
};

const prepareReferenceContext = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData | undefined,
): PreparedReferenceContext | null => {
    if (!siteData) return null;
    const target = {
        raw: preprocessSeries(diagnosis.rawTarget),
        difference: firstDifferences(diagnosis.rawTarget),
        whitened: ar1WhitenSeries(diagnosis.rawTarget),
    };
    const referenceAlignmentLags = diagnosis.globalSlidingMatch.lagResults
        .map((row) => row.lag);
    const references: PreparedReference[] = diagnosis.master.sourceTrees
        .map((tree) => toNumericSeries(siteData.get(tree)))
        .filter((series) => series.size >= 30)
        .map((series) => {
            const raw = preprocessSeries(series);
            const bestCorrelation = referenceAlignmentLags.reduce(
                (best, lag) => Math.max(
                    best,
                    correlationForSegment(
                        target.raw,
                        raw,
                        diagnosis.targetRange.startYear,
                        diagnosis.targetRange.endYear,
                        lag,
                        30,
                    ).correlation ?? -1,
                ),
                -1,
            );
            return {
                raw,
                difference: firstDifferences(series),
                whitened: ar1WhitenSeries(series),
                correlation: bestCorrelation,
                weight: Math.max(0.05, bestCorrelation + 0.15),
            };
        })
        .filter((reference) => reference.correlation > -0.1)
        .sort((a, b) => b.correlation - a.correlation)
        .slice(0, 16);
    return { target, references };
};

const referencePreferenceRows = (
    context: PreparedReferenceContext | null,
    diagnosis: SeriesCoreDiagnosis,
    olderLag: number,
): {
    median: PreferenceRow[];
    mean: PreferenceRow[];
    vote: PreferenceRow[];
} => {
    if (!context) return { median: [], mean: [], vote: [] };
    const { target, references } = context;
    const medianRows: PreferenceRow[] = [];
    const meanRows: PreferenceRow[] = [];
    const voteRows: PreferenceRow[] = [];
    for (
        let year = diagnosis.targetRange.startYear;
        year <= diagnosis.targetRange.endYear;
        year += 1
    ) {
        const byReference = references.flatMap((reference) => {
            const preferences = ([
                ["raw", 0.25],
                ["difference", 0.4],
                ["whitened", 0.35],
            ] as const).flatMap(([view, weight]) => {
                const targetValue = target[view].get(year);
                const zero = reference[view].get(year);
                const shifted = reference[view].get(year + olderLag);
                if (targetValue === undefined || zero === undefined || shifted === undefined) {
                    return [];
                }
                return [{
                    value: huberLoss(targetValue - zero) - huberLoss(targetValue - shifted),
                    weight,
                }];
            });
            const totalWeight = preferences.reduce((sum, row) => sum + row.weight, 0);
            if (totalWeight === 0) return [];
            return [{
                value: preferences.reduce(
                    (sum, row) => sum + row.value * row.weight,
                    0,
                ) / totalWeight,
                weight: reference.weight,
            }];
        });
        if (byReference.length < 3) continue;
        medianRows.push({ year, value: median(byReference.map((row) => row.value)) });
        const referenceWeight = byReference.reduce((sum, row) => sum + row.weight, 0);
        meanRows.push({
            year,
            value: byReference.reduce(
                (sum, row) => sum + row.value * row.weight,
                0,
            ) / referenceWeight,
        });
        voteRows.push({
            year,
            value: byReference.reduce(
                (sum, row) => (
                    sum + (row.value > 0 ? row.weight : row.value < 0 ? -row.weight : 0)
                ),
                0,
            ) / referenceWeight,
        });
    }
    return { median: medianRows, mean: meanRows, vote: voteRows };
};

const prefixFor = (
    rows: PreferenceRow[],
    startYear: number,
    endYear: number,
): Prefix => {
    const byYear = new Map(rows.map((row) => [row.year, row.value]));
    const years: number[] = [];
    const sums = [0];
    const counts = [0];
    for (let year = startYear; year <= endYear; year += 1) {
        years.push(year);
        const value = byYear.get(year);
        sums.push(sums[sums.length - 1] + (value ?? 0));
        counts.push(counts[counts.length - 1] + Number(value !== undefined));
    }
    return { years, sums, counts };
};

const range = (
    prefix: Prefix,
    startYear: number,
    endYear: number,
): { sum: number; count: number; mean: number } => {
    const minimum = prefix.years[0];
    const maximum = prefix.years[prefix.years.length - 1];
    const boundedStart = Math.max(minimum, startYear);
    const boundedEnd = Math.min(maximum, endYear);
    if (boundedEnd < boundedStart) return { sum: 0, count: 0, mean: 0 };
    const startIndex = boundedStart - minimum;
    const endIndex = boundedEnd - minimum + 1;
    const sum = prefix.sums[endIndex] - prefix.sums[startIndex];
    const count = prefix.counts[endIndex] - prefix.counts[startIndex];
    return { sum, count, mean: count > 0 ? sum / count : 0 };
};

const viewScores = (
    prefix: Prefix,
    diagnosis: SeriesCoreDiagnosis,
    year: number,
): {
    cumulative: number;
    cusum: number;
    contrast: number;
    local31: number;
    local61: number;
} => {
    const older = range(prefix, diagnosis.targetRange.startYear, year);
    const newer = range(prefix, year + 1, diagnosis.targetRange.endYear);
    const local15Older = range(prefix, year - 14, year);
    const local15Newer = range(prefix, year + 1, year + 15);
    const local30Older = range(prefix, year - 29, year);
    const local30Newer = range(prefix, year + 1, year + 30);
    const effectiveSidePairs = older.count + newer.count > 0
        ? older.count * newer.count / (older.count + newer.count)
        : 0;
    return {
        cumulative: older.sum,
        cusum: (older.mean - newer.mean) * Math.sqrt(effectiveSidePairs),
        contrast: older.mean - newer.mean,
        local31: local15Older.mean - local15Newer.mean,
        local61: local30Older.mean - local30Newer.mean,
    };
};

export const scoreCumulativeLagChangePoints = (
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis | null = null,
    options: CumulativeLagChangePointOptions = {},
): CumulativeLagChangePointScore[] => {
    const minSideYears = options.minSideYears ?? 18;
    const lags = options.lags ?? getAutomaticEventShiftCandidates({
        maxPartialGapYears: DEFAULT_MAX_PARTIAL_GAP_YEARS,
        lagMin: -DEFAULT_MAX_PARTIAL_GAP_YEARS,
        seriesLength:
            diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
        minimumSideYears: minSideYears,
    });
    const views = viewsFor(diagnosis, cofechaDiagnosis);
    const referenceContext = prepareReferenceContext(diagnosis, options.siteData);
    const result: CumulativeLagChangePointScore[] = [];

    lags.forEach((olderLag) => {
        const byView = new Map(views.map((view) => [
            view.name,
            prefixFor(
                preferenceRows(view, diagnosis, olderLag),
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
            ),
        ]));
        const referenceRows = referencePreferenceRows(
            referenceContext,
            diagnosis,
            olderLag,
        );
        const referencePrefixes = {
            median: prefixFor(
                referenceRows.median,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
            ),
            mean: prefixFor(
                referenceRows.mean,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
            ),
            vote: prefixFor(
                referenceRows.vote,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
            ),
        };
        for (
            let year = diagnosis.targetRange.startYear + minSideYears;
            year <= diagnosis.targetRange.endYear - minSideYears;
            year += 1
        ) {
            const scores = new Map(views.map((view) => [
                view.name,
                viewScores(byView.get(view.name)!, diagnosis, year),
            ]));
            const combined = {
                cumulative: 0,
                cusum: 0,
                contrast: 0,
                local31: 0,
                local61: 0,
            };
            views.forEach((view) => {
                const score = scores.get(view.name)!;
                combined.cumulative += score.cumulative * view.weight;
                combined.cusum += score.cusum * view.weight;
                combined.contrast += score.contrast * view.weight;
                combined.local31 += score.local31 * view.weight;
                combined.local61 += score.local61 * view.weight;
            });
            const raw = scores.get("raw")!;
            const difference = scores.get("difference")!;
            const whitened = scores.get("whitened")!;
            const cofecha = scores.get("cofecha") ?? raw;
            const referenceMedian = viewScores(
                referencePrefixes.median,
                diagnosis,
                year,
            );
            const referenceMean = viewScores(
                referencePrefixes.mean,
                diagnosis,
                year,
            );
            const referenceVote = viewScores(
                referencePrefixes.vote,
                diagnosis,
                year,
            );
            result.push({
                year,
                olderLag,
                combinedCumulative: combined.cumulative,
                combinedCusum: combined.cusum,
                combinedContrast: combined.contrast,
                combinedLocal31: combined.local31,
                combinedLocal61: combined.local61,
                rawCumulative: raw.cumulative,
                rawCusum: raw.cusum,
                rawContrast: raw.contrast,
                differenceCumulative: difference.cumulative,
                differenceCusum: difference.cusum,
                differenceContrast: difference.contrast,
                whitenedCumulative: whitened.cumulative,
                whitenedCusum: whitened.cusum,
                whitenedContrast: whitened.contrast,
                cofechaCumulative: cofecha.cumulative,
                cofechaCusum: cofecha.cusum,
                cofechaContrast: cofecha.contrast,
                referenceMedianCumulative: referenceMedian.cumulative,
                referenceMedianCusum: referenceMedian.cusum,
                referenceMedianContrast: referenceMedian.contrast,
                referenceMeanCumulative: referenceMean.cumulative,
                referenceMeanCusum: referenceMean.cusum,
                referenceMeanContrast: referenceMean.contrast,
                referenceVoteCumulative: referenceVote.cumulative,
                referenceVoteCusum: referenceVote.cusum,
                referenceVoteContrast: referenceVote.contrast,
            });
        }
    });
    return result;
};

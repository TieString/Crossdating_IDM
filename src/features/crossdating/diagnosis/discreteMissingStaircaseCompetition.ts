/** Explicit competition between one continuous gap and several discrete missing rings. */
import { cofechaStyleStandardize } from "../reference";
import type { RwlSiteData } from "@/features/rwl/types";
import { ar1WhitenSeries, preprocessSeries, toNumericSeries } from "./series";
import type { DiagnosisEvent, NumericSeries, SeriesCoreDiagnosis } from "./types";

export type MissingStaircaseCompetition = {
    cumulativeShiftYears: -2 | -3;
    directFirstFixedYear: number;
    missingYears: number[];
    missingSpanYears: number;
    masterMargin: number;
    globalMargin: number;
    localMargin: number;
    referenceSupport: number;
    referenceCount: number;
    referenceSupportRatio: number;
    referenceMedianMargin: number;
    referenceLowerQuartileMargin: number;
};

export type LocalTwoStepStaircaseEvidence = {
    olderBoundaryYear: number;
    newerBoundaryYear: number;
    staircaseGain: number;
    middleMeanAdvantage: number;
    referenceSupport: number;
    referenceCount: number;
    referenceMedianAdvantage: number;
};

/**
 * Requires two independent views to prefer separated unit events. Adjacent unit inserts are
 * algebraically equivalent to one continuous gap and are deliberately not auto-split.
 */
export const supportsDiscreteMissingStaircase = (
    competition: MissingStaircaseCompetition | null,
    local: LocalTwoStepStaircaseEvidence | null,
): boolean => {
    if (!competition || !local || competition.cumulativeShiftYears !== -2) return false;
    const localSupportRatio = local.referenceSupport
        / Math.max(1, local.referenceCount);
    return local.newerBoundaryYear - local.olderBoundaryYear >= 2
        && local.staircaseGain >= -0.15
        && local.middleMeanAdvantage > 0
        && local.referenceCount >= 8
        && localSupportRatio >= 0.65
        && local.referenceMedianAdvantage >= 0.03
        && competition.missingSpanYears > 1
        && competition.referenceCount >= 8
        && competition.referenceSupportRatio >= 0.75
        && competition.referenceMedianMargin >= 0.03
        && competition.referenceLowerQuartileMargin >= -1e-9;
};

type Views = {
    raw: NumericSeries;
    difference: NumericSeries;
    whitened: NumericSeries;
};

type ScoredCorrection = {
    years: number[];
    firstFixedYear: number | null;
    corrected: NumericSeries;
    views: Views;
    globalScore: number;
    localScore: number;
    score: number;
};

const median = (values: number[]): number => {
    const sorted = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : sorted[middle] ?? 0;
};

const quantile = (values: number[], probability: number): number => {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) * probability)] ?? 0;
};

const firstDifferences = (series: NumericSeries): NumericSeries => {
    const entries = Array.from(series).sort((left, right) => left[0] - right[0]);
    const result = new Map<number, number>();
    for (let index = 1; index < entries.length; index += 1) {
        const [year, value] = entries[index];
        const [previousYear, previousValue] = entries[index - 1];
        if (year === previousYear + 1) result.set(year, value - previousValue);
    }
    return result;
};

const makeViews = (
    series: NumericSeries,
    useCofechaStandardization: boolean,
): Views => {
    const raw = useCofechaStandardization
        ? new Map(cofechaStyleStandardize(series).map((point) => [point.year, point.value]))
        : preprocessSeries(series);
    return {
        raw,
        difference: firstDifferences(raw),
        whitened: ar1WhitenSeries(raw),
    };
};

const correlation = (
    left: NumericSeries,
    right: NumericSeries,
    startYear: number,
    endYear: number,
    minimumPairs: number,
): number => {
    let count = 0;
    let sumLeft = 0;
    let sumRight = 0;
    let sumLeftSquared = 0;
    let sumRightSquared = 0;
    let sumProduct = 0;
    for (let year = startYear; year <= endYear; year += 1) {
        const leftValue = left.get(year);
        const rightValue = right.get(year);
        if (leftValue === undefined || rightValue === undefined) continue;
        count += 1;
        sumLeft += leftValue;
        sumRight += rightValue;
        sumLeftSquared += leftValue * leftValue;
        sumRightSquared += rightValue * rightValue;
        sumProduct += leftValue * rightValue;
    }
    if (count < minimumPairs) return -1;
    const numerator = sumProduct - sumLeft * sumRight / count;
    const leftVariance = sumLeftSquared - sumLeft * sumLeft / count;
    const rightVariance = sumRightSquared - sumRight * sumRight / count;
    const denominator = Math.sqrt(
        Math.max(0, leftVariance) * Math.max(0, rightVariance),
    );
    return denominator > 0 ? numerator / denominator : -1;
};

const scoreViews = (
    target: Views,
    reference: Views,
    startYear: number,
    endYear: number,
    minimumPairs: number,
): number => (
    correlation(target.raw, reference.raw, startYear, endYear, minimumPairs) * 0.25
    + correlation(
        target.difference,
        reference.difference,
        startYear,
        endYear,
        minimumPairs,
    ) * 0.45
    + correlation(
        target.whitened,
        reference.whitened,
        startYear,
        endYear,
        minimumPairs,
    ) * 0.30
);

const simulateMissingRing = (series: NumericSeries, year: number): NumericSeries => (
    new Map(Array.from(series, ([sourceYear, value]) => [
        sourceYear <= year ? sourceYear - 1 : sourceYear,
        value,
    ]))
);

const simulateMissingRings = (
    series: NumericSeries,
    years: number[],
): NumericSeries => years
    .slice()
    .sort((left, right) => right - left)
    .reduce(simulateMissingRing, new Map(series));

const simulatePartialMove = (
    series: NumericSeries,
    firstFixedYear: number,
    shiftYears: number,
): NumericSeries => new Map(Array.from(series, ([year, value]) => [
    year < firstFixedYear ? year + shiftYears : year,
    value,
]));

const combinations = (years: number[], count: number): number[][] => {
    const result: number[][] = [];
    const visit = (start: number, selected: number[]): void => {
        if (selected.length === count) {
            result.push(selected.slice().sort((left, right) => right - left));
            return;
        }
        for (
            let index = start;
            index <= years.length - (count - selected.length);
            index += 1
        ) {
            selected.push(years[index]);
            visit(index + 1, selected);
            selected.pop();
        }
    };
    visit(0, []);
    return result;
};

const scoreCorrection = (
    corrected: NumericSeries,
    masterViews: Views,
    useCofechaStandardization: boolean,
    fullRange: { startYear: number; endYear: number },
    localRange: { startYear: number; endYear: number },
): Omit<ScoredCorrection, "years" | "firstFixedYear"> => {
    const views = makeViews(corrected, useCofechaStandardization);
    const globalScore = scoreViews(
        views,
        masterViews,
        fullRange.startYear,
        fullRange.endYear,
        20,
    );
    const localScore = scoreViews(
        views,
        masterViews,
        localRange.startYear,
        localRange.endYear,
        6,
    );
    return {
        corrected,
        views,
        globalScore,
        localScore,
        score: globalScore * 0.35 + localScore * 0.65,
    };
};

export const comparePartialMoveWithMissingStaircase = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    event: DiagnosisEvent,
    useCofechaStandardization = true,
    headYear: number | null = null,
): MissingStaircaseCompetition | null => {
    if (
        event.eventType !== "partialMove"
        || (event.shiftYears !== -2 && event.shiftYears !== -3)
    ) return null;
    const cumulativeShiftYears = event.shiftYears;
    const missingCount = Math.abs(cumulativeShiftYears);
    const startYear = Math.max(
        diagnosis.targetRange.startYear + 8,
        event.startYear,
    );
    const endYear = Math.min(
        diagnosis.targetRange.endYear - 8,
        event.endYear,
    );
    if (endYear - startYear + 1 < missingCount) return null;
    const candidateYears = Array.from(
        { length: endYear - startYear + 1 },
        (_, index) => startYear + index,
    );
    const localRange = {
        startYear: Math.max(diagnosis.targetRange.startYear, startYear - 12),
        endYear: Math.min(diagnosis.targetRange.endYear, endYear + 12),
    };
    const masterViews: Views = {
        raw: diagnosis.master.data,
        difference: firstDifferences(diagnosis.master.data),
        whitened: ar1WhitenSeries(diagnosis.master.data),
    };
    const direct = candidateYears.map((firstFixedYear): ScoredCorrection => ({
        years: [],
        firstFixedYear,
        ...scoreCorrection(
            simulatePartialMove(
                diagnosis.rawTarget,
                firstFixedYear,
                cumulativeShiftYears,
            ),
            masterViews,
            useCofechaStandardization,
            diagnosis.targetRange,
            localRange,
        ),
    })).sort((left, right) => right.score - left.score)[0];
    const staircase = combinations(candidateYears, missingCount)
        .filter((years) => (
            headYear === null
            || Math.abs((years[0] ?? headYear) - headYear) <= 2
        ))
        .map((years): ScoredCorrection => ({
            years,
            firstFixedYear: null,
            ...scoreCorrection(
                simulateMissingRings(diagnosis.rawTarget, years),
                masterViews,
                useCofechaStandardization,
                diagnosis.targetRange,
                localRange,
            ),
        }))
        .sort((left, right) => right.score - left.score)[0];
    if (!direct || !staircase || direct.firstFixedYear === null) return null;

    const referenceMargins = diagnosis.master.sourceTrees.flatMap((tree) => {
        const rawReference = toNumericSeries(siteData.get(tree));
        if (rawReference.size === 0) return [];
        const referenceViews = makeViews(rawReference, useCofechaStandardization);
        const directGlobal = scoreViews(
            direct.views,
            referenceViews,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
            20,
        );
        const directLocal = scoreViews(
            direct.views,
            referenceViews,
            localRange.startYear,
            localRange.endYear,
            6,
        );
        const staircaseGlobal = scoreViews(
            staircase.views,
            referenceViews,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
            20,
        );
        const staircaseLocal = scoreViews(
            staircase.views,
            referenceViews,
            localRange.startYear,
            localRange.endYear,
            6,
        );
        return [(
            staircaseGlobal * 0.35 + staircaseLocal * 0.65
            - directGlobal * 0.35 - directLocal * 0.65
        )];
    });
    const referenceSupport = referenceMargins.filter((margin) => margin > 0).length;
    const missingYears = staircase.years.slice().sort((left, right) => right - left);
    return {
        cumulativeShiftYears,
        directFirstFixedYear: direct.firstFixedYear,
        missingYears,
        missingSpanYears: (missingYears[0] ?? 0)
            - (missingYears[missingYears.length - 1] ?? 0),
        masterMargin: staircase.score - direct.score,
        globalMargin: staircase.globalScore - direct.globalScore,
        localMargin: staircase.localScore - direct.localScore,
        referenceSupport,
        referenceCount: referenceMargins.length,
        referenceSupportRatio: referenceSupport / Math.max(1, referenceMargins.length),
        referenceMedianMargin: median(referenceMargins),
        referenceLowerQuartileMargin: quantile(referenceMargins, 0.25),
    };
};

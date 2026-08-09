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

export type TwoStepUnitDirectionCompetition = {
    falseYears: number[];
    missingYears: number[];
    masterMargin: number;
    referenceSupport: number;
    referenceCount: number;
    referenceSupportRatio: number;
    referenceMedianMargin: number;
    referenceLowerQuartileMargin: number;
};

const MAX_TWO_STEP_SEPARATION_YEARS = 17;
const MAX_HEAD_BOUNDARY_OFFSET_YEARS = 4;

export const supportsRobustMissingStaircaseCorrection = (
    competition: MissingStaircaseCompetition | null,
    local: LocalTwoStepStaircaseEvidence | null,
): boolean => Boolean(
    competition
        && local
        && competition.cumulativeShiftYears === -2
        && competition.referenceCount >= 8
        && competition.referenceSupportRatio >= 0.8
        && competition.referenceMedianMargin >= 0.02
        && competition.referenceLowerQuartileMargin >= 0.005
        && competition.missingSpanYears >= 4
        && local.newerBoundaryYear - local.olderBoundaryYear >= 4
        && local.staircaseGain > 0
        && local.middleMeanAdvantage > 0
);

/**
 * Requires two independent views to prefer separated unit events. Adjacent unit inserts are
 * algebraically equivalent to one continuous gap and are deliberately not auto-split.
 */
export const supportsDiscreteMissingStaircase = (
    competition: MissingStaircaseCompetition | null,
    local: LocalTwoStepStaircaseEvidence | null,
    options: { allowConfirmedHistoryRelaxation?: boolean } = {},
): boolean => {
    if (!competition || !local || competition.cumulativeShiftYears !== -2) return false;
    const localSupportRatio = local.referenceSupport
        / Math.max(1, local.referenceCount);
    const unanimousExplicitSupport = options.allowConfirmedHistoryRelaxation === true
        && competition.referenceMedianMargin >= 0.025
        && competition.masterMargin > 0
        && competition.localMargin > 0
        && competition.referenceLowerQuartileMargin > 0;
    const referenceMarginSupported = competition.referenceMedianMargin >= 0.03
        || unanimousExplicitSupport;
    const localGainSupported = local.staircaseGain >= -0.15
        || (unanimousExplicitSupport && local.staircaseGain >= -0.2);
    return local.newerBoundaryYear - local.olderBoundaryYear >= 2
        && localGainSupported
        && local.middleMeanAdvantage > 0
        && local.referenceCount >= 8
        && localSupportRatio >= 0.65
        && local.referenceMedianAdvantage >= 0.03
        && competition.missingSpanYears > 1
        && competition.referenceCount >= 8
        && competition.referenceSupportRatio >= 0.75
        && referenceMarginSupported
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
    // Missing-ring years use the displayed frame seen during bark-to-pith recovery. Applying the
    // newer correction first preserves the same year semantics as sequential user confirmation.
    .sort((left, right) => right - left)
    .reduce(simulateMissingRing, new Map(series));

const simulateFalseRing = (series: NumericSeries, year: number): NumericSeries => (
    new Map(Array.from(series).flatMap(([sourceYear, value]) => (
        sourceYear === year
            ? []
            : [[sourceYear < year ? sourceYear + 1 : sourceYear, value] as [number, number]]
    )))
);

const simulateFalseRings = (
    series: NumericSeries,
    years: number[],
): NumericSeries => years
    .slice()
    .sort((left, right) => left - right)
    .reduce(simulateFalseRing, new Map(series));

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

const twoStepPairsNearHead = (
    headYear: number,
    range: { startYear: number; endYear: number },
): number[][] => {
    const pairs: number[][] = [];
    for (let newerYear = headYear - 4; newerYear <= headYear + 4; newerYear += 1) {
        if (newerYear > range.endYear - 8) continue;
        for (let separation = 2; separation <= 25; separation += 1) {
            const olderYear = newerYear - separation;
            if (olderYear < range.startYear + 8) continue;
            pairs.push([newerYear, olderYear]);
        }
    }
    return pairs;
};

/**
 * Compares the completed two-edit states for opposite signed staircases. A single edit is not a
 * fair direction test while the second event remains unresolved, so every reference core votes
 * between its best retained two-delete and two-insert hypotheses.
 */
export const compareTwoStepUnitDirections = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    falseHeadYear: number,
    missingHeadYear: number,
    useCofechaStandardization = true,
): TwoStepUnitDirectionCompetition | null => {
    const falsePairs = twoStepPairsNearHead(falseHeadYear, diagnosis.targetRange);
    const missingPairs = twoStepPairsNearHead(missingHeadYear, diagnosis.targetRange);
    if (falsePairs.length === 0 || missingPairs.length === 0) return null;
    const localRange = {
        startYear: Math.max(
            diagnosis.targetRange.startYear,
            Math.min(falseHeadYear, missingHeadYear) - 30,
        ),
        endYear: Math.min(
            diagnosis.targetRange.endYear,
            Math.max(falseHeadYear, missingHeadYear) + 12,
        ),
    };
    const masterViews: Views = {
        raw: diagnosis.master.data,
        difference: firstDifferences(diagnosis.master.data),
        whitened: ar1WhitenSeries(diagnosis.master.data),
    };
    const scorePairs = (
        pairs: number[][],
        correction: (series: NumericSeries, years: number[]) => NumericSeries,
    ): ScoredCorrection[] => pairs.map((years): ScoredCorrection => ({
        years,
        firstFixedYear: null,
        ...scoreCorrection(
            correction(diagnosis.rawTarget, years),
            masterViews,
            useCofechaStandardization,
            diagnosis.targetRange,
            localRange,
        ),
    })).sort((left, right) => right.score - left.score).slice(0, 12);
    const falseCandidates = scorePairs(falsePairs, simulateFalseRings);
    const missingCandidates = scorePairs(missingPairs, simulateMissingRings);
    const selectedFalse = falseCandidates[0];
    const selectedMissing = missingCandidates[0];
    if (!selectedFalse || !selectedMissing) return null;
    const referenceMargins = diagnosis.master.sourceTrees.flatMap((tree) => {
        const rawReference = toNumericSeries(siteData.get(tree));
        if (rawReference.size === 0) return [];
        const reference = makeViews(rawReference, useCofechaStandardization);
        const scoreAgainstReference = (candidate: ScoredCorrection): number => (
            scoreViews(
                candidate.views,
                reference,
                diagnosis.targetRange.startYear,
                diagnosis.targetRange.endYear,
                20,
            ) * 0.6
            + scoreViews(
                candidate.views,
                reference,
                localRange.startYear,
                localRange.endYear,
                8,
            ) * 0.4
        );
        const bestFalse = Math.max(...falseCandidates.map(scoreAgainstReference));
        const bestMissing = Math.max(...missingCandidates.map(scoreAgainstReference));
        return Number.isFinite(bestFalse) && Number.isFinite(bestMissing)
            ? [bestFalse - bestMissing]
            : [];
    });
    const referenceSupport = referenceMargins.filter((margin) => margin > 0).length;
    return {
        falseYears: selectedFalse.years,
        missingYears: selectedMissing.years,
        masterMargin: selectedFalse.score - selectedMissing.score,
        referenceSupport,
        referenceCount: referenceMargins.length,
        referenceSupportRatio: referenceSupport / Math.max(1, referenceMargins.length),
        referenceMedianMargin: median(referenceMargins),
        referenceLowerQuartileMargin: quantile(referenceMargins, 0.25),
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

export const comparePartialMoveWithRobustMissingStaircase = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    event: DiagnosisEvent,
    useCofechaStandardization = true,
    headYear: number | null = null,
): MissingStaircaseCompetition | null => {
    if (
        event.eventType !== "partialMove"
        || event.shiftYears !== -2
    ) return null;
    const cumulativeShiftYears = event.shiftYears;
    const missingCount = Math.abs(cumulativeShiftYears);
    const directStartYear = Math.max(
        diagnosis.targetRange.startYear + 8,
        event.startYear,
    );
    const directEndYear = Math.min(
        diagnosis.targetRange.endYear - 8,
        event.endYear,
    );
    const staircaseStartYear = Math.max(
        diagnosis.targetRange.startYear + 8,
        event.startYear - MAX_TWO_STEP_SEPARATION_YEARS,
    );
    const staircaseEndYear = Math.min(
        diagnosis.targetRange.endYear - 8,
        event.endYear + MAX_HEAD_BOUNDARY_OFFSET_YEARS,
    );
    if (directEndYear < directStartYear
        || staircaseEndYear - staircaseStartYear + 1 < missingCount) return null;
    const directYears = Array.from(
        { length: directEndYear - directStartYear + 1 },
        (_, index) => directStartYear + index,
    );
    const staircaseYears = Array.from(
        { length: staircaseEndYear - staircaseStartYear + 1 },
        (_, index) => staircaseStartYear + index,
    );
    const localRange = {
        startYear: Math.max(diagnosis.targetRange.startYear, event.startYear - 12),
        endYear: Math.min(diagnosis.targetRange.endYear, event.endYear + 12),
    };
    const masterViews: Views = {
        raw: diagnosis.master.data,
        difference: firstDifferences(diagnosis.master.data),
        whitened: ar1WhitenSeries(diagnosis.master.data),
    };
    const directCandidates = directYears.map((firstFixedYear): ScoredCorrection => ({
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
    }));
    const direct = directCandidates.slice()
        .sort((left, right) => right.score - left.score)[0];
    const staircaseCandidates = combinations(staircaseYears, missingCount)
        .filter((years) => (
            headYear === null
            || Math.abs((years[0] ?? headYear) - headYear)
                <= MAX_HEAD_BOUNDARY_OFFSET_YEARS
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
        }));
    if (!direct || staircaseCandidates.length === 0 || direct.firstFixedYear === null) {
        return null;
    }

    const referenceViews = diagnosis.master.sourceTrees.flatMap((tree) => {
        const rawReference = toNumericSeries(siteData.get(tree));
        if (rawReference.size === 0) return [];
        return [makeViews(rawReference, useCofechaStandardization)];
    });
    const scoreAgainstReference = (candidate: ScoredCorrection, reference: Views): number => (
        scoreViews(
            candidate.views,
            reference,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
            20,
        ) * 0.35
        + scoreViews(
            candidate.views,
            reference,
            localRange.startYear,
            localRange.endYear,
            6,
        ) * 0.65
    );
    const bestDirectByReference = referenceViews.map((reference) => Math.max(
        ...directCandidates.map((candidate) => scoreAgainstReference(candidate, reference)),
    ));
    const robustStaircases = staircaseCandidates.map((candidate) => {
        const margins = referenceViews.map((reference, index) => (
            scoreAgainstReference(candidate, reference) - bestDirectByReference[index]
        ));
        return {
            candidate,
            margins,
            medianMargin: median(margins),
            lowerQuartileMargin: quantile(margins, 0.25),
            support: margins.filter((margin) => margin > 0).length,
        };
    }).sort((left, right) => (
        right.medianMargin - left.medianMargin
        || right.lowerQuartileMargin - left.lowerQuartileMargin
        || right.support - left.support
        || right.candidate.score - left.candidate.score
    ));
    const selectedStaircase = robustStaircases[0];
    if (!selectedStaircase) return null;
    const staircase = selectedStaircase.candidate;
    const referenceMargins = selectedStaircase.margins;
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

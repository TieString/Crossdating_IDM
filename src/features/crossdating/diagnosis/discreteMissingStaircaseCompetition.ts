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

export type CompletedPartialStaircaseCompetition = {
    familyShiftYears: number;
    partialShiftYears: number;
    partialFirstFixedYear: number;
    boundaryPriorYear: number;
    shiftSelectionSource: "cofecha_segment_lag" | "completed_family_profile";
    missingYears: number[];
    masterMargin: number;
    totalReferenceCount: number;
    ambiguousReferenceCount: number;
    referenceCount: number;
    staircaseReferenceSupport: number;
    staircaseReferenceSupportRatio: number;
    partialReferenceSupport: number;
    partialReferenceSupportRatio: number;
    referenceMedianMargin: number;
    referenceLowerQuartileMargin: number;
    referenceUpperQuartileMargin: number;
    shiftProfiles: Array<{
        shiftYears: number;
        referenceCount: number;
        partialReferenceSupport: number;
        partialReferenceSupportRatio: number;
        referenceMedianMargin: number;
        referenceUpperQuartileMargin: number;
        masterScore: number;
    }>;
};

type CompletedPartialUnitEventType = "missingRing" | "falseRing";
type CompletedPartialUnitOrientation = "missingThenPartial"
    | "partialThenMissing"
    | "falseThenPartial"
    | "partialThenFalse";

type CompletedPartialUnitComposition = {
    unitEventType: CompletedPartialUnitEventType;
    cumulativeShiftYears: number;
    partialShiftYears: number;
    orientation: CompletedPartialUnitOrientation;
    olderBoundaryYear: number;
    newerBoundaryYear: number;
    frontierEventType: CompletedPartialUnitEventType | "partialMove";
    frontierYear: number;
    separationYears: number;
    masterMargin: number;
    referenceCount: number;
    mixedReferenceSupport: number;
    mixedReferenceSupportRatio: number;
    referenceMedianMargin: number;
    referenceLowerQuartileMargin: number;
    orientationReferenceCount: number;
    orientationReferenceSupport: number;
    orientationReferenceSupportRatio: number;
    orientationMedianMargin: number;
    orientationLowerQuartileMargin: number;
    masterOrientationMargin: number;
    comparedWithMissingStaircase: boolean;
};

export type CompletedPartialMissingComposition = CompletedPartialUnitComposition & {
    unitEventType: "missingRing";
    orientation: "missingThenPartial" | "partialThenMissing";
    frontierEventType: "missingRing" | "partialMove";
};

export type CompletedPartialFalseComposition = CompletedPartialUnitComposition & {
    unitEventType: "falseRing";
    orientation: "falseThenPartial" | "partialThenFalse";
    frontierEventType: "falseRing" | "partialMove";
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
 * Lets overwhelming per-reference evidence survive a one-year boundary wobble after rebuilding
 * the COFECHA master. This is intentionally much stricter than the normal staircase gate because
 * there is no shared-zero or unit-candidate anchor to distinguish it from one physical -2 gap.
 */
export const supportsDecisiveUnanchoredMissingStaircase = (
    competition: MissingStaircaseCompetition | null,
    local: LocalTwoStepStaircaseEvidence | null,
): boolean => Boolean(
    competition
        && local
        && competition.cumulativeShiftYears === -2
        && competition.missingSpanYears >= 3
        && competition.referenceCount >= 8
        && competition.referenceSupportRatio >= 0.9
        && competition.referenceMedianMargin >= 0.05
        && competition.referenceLowerQuartileMargin >= 0.02
        && local.newerBoundaryYear - local.olderBoundaryYear >= 3
        && local.staircaseGain > 0
        && local.middleMeanAdvantage >= 0.1
        && local.referenceCount >= 8
        && local.referenceSupport / Math.max(1, local.referenceCount) >= 0.85
        && local.referenceMedianAdvantage >= 0.1
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
    shiftYears?: number;
    corrected: NumericSeries;
    views: Views;
    globalScore: number;
    localScore: number;
    score: number;
};

type CompletionComparisonCorrection = ScoredCorrection & {
    comparisonRange: { startYear: number; endYear: number };
};

type MixedPartialUnitCorrection = CompletionComparisonCorrection & {
    orientation: CompletedPartialUnitOrientation;
    olderBoundaryYear: number;
    newerBoundaryYear: number;
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

/**
 * Compares two complete explanations of the same cumulative negative lag: one continuous
 * partial move versus every unit insertion implied by the monotone lag path. Comparing a
 * single insertion while the remaining staircase is unresolved is not a fair family test.
 */
export const compareCompletedPartialWithMissingStaircase = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    candidateEvents: readonly DiagnosisEvent[],
    pathMissingYears: readonly number[],
    useCofechaStandardization = true,
): CompletedPartialStaircaseCompetition | null => {
    const range = diagnosis.targetRange;
    const eligiblePartials = candidateEvents.flatMap((event) => {
        const firstFixedYear = event.rankedYears.slice().sort(
            (left, right) => left.rank - right.rank,
        )[0]?.year;
        if (
            event.eventType !== "partialMove"
            || event.shiftSide !== "older"
            || (event.shiftYears ?? 0) > -4
            || !Number.isInteger(firstFixedYear)
            || event.evidence.candidateIds.length === 0
            || !event.evidence.notes.includes("candidate_hard_gate_passed")
        ) return [];
        return [{
            shiftYears: event.shiftYears!,
            firstFixedYear: firstFixedYear!,
            cofechaBacked: event.evidence.algorithmSources.includes(
                "cofecha_segment_lag",
            ),
        }];
    });
    const missingYears = Array.from(new Set(pathMissingYears))
        .sort((left, right) => left - right);
    if (eligiblePartials.length === 0 || missingYears.length < 2) return null;
    const directYears = new Set<number>();
    const pathSearchStart = Math.max(
        range.startYear + 8,
        missingYears[0] - 8,
    );
    const pathSearchEnd = Math.min(
        range.endYear - 8,
        missingYears[missingYears.length - 1] + 8,
    );
    for (let year = pathSearchStart; year <= pathSearchEnd; year += 1) {
        directYears.add(year);
    }
    eligiblePartials.forEach(({ firstFixedYear }) => {
        for (let offset = -2; offset <= 2; offset += 1) {
            const year = firstFixedYear + offset;
            if (year >= range.startYear + 8 && year <= range.endYear - 8) {
                directYears.add(year);
            }
        }
    });
    const partialShifts = Array.from(new Set(
        eligiblePartials.map((row) => row.shiftYears),
    ));
    const partialHypotheses = partialShifts.flatMap((shiftYears) => (
        Array.from(directYears).map((firstFixedYear) => ({
            shiftYears,
            firstFixedYear,
        }))
    ));
    const staircaseHypotheses = Array.from({ length: 5 }, (_, index) => {
        const offset = index - 2;
        return missingYears.map((year) => year + offset);
    }).filter((years) => years.every((year) => (
        year >= range.startYear + 8 && year <= range.endYear - 8
    )));
    if (staircaseHypotheses.length === 0) return null;

    const hypothesisYears = [
        ...partialHypotheses.map((row) => row.firstFixedYear),
        ...staircaseHypotheses.flat(),
    ];
    const localRange = {
        startYear: Math.max(range.startYear, Math.min(...hypothesisYears) - 16),
        endYear: Math.min(range.endYear, Math.max(...hypothesisYears) + 16),
    };
    const masterViews: Views = {
        raw: diagnosis.master.data,
        difference: firstDifferences(diagnosis.master.data),
        whitened: ar1WhitenSeries(diagnosis.master.data),
    };
    const directCandidates = partialHypotheses.map((hypothesis): ScoredCorrection => ({
        years: [],
        firstFixedYear: hypothesis.firstFixedYear,
        shiftYears: hypothesis.shiftYears,
        ...scoreCorrection(
            simulatePartialMove(
                diagnosis.rawTarget,
                hypothesis.firstFixedYear,
                hypothesis.shiftYears,
            ),
            masterViews,
            useCofechaStandardization,
            range,
            localRange,
        ),
    })).sort((left, right) => right.score - left.score);
    const staircaseCandidates = staircaseHypotheses.map((years): ScoredCorrection => ({
        years,
        firstFixedYear: null,
        ...scoreCorrection(
            simulateMissingRings(diagnosis.rawTarget, years),
            masterViews,
            useCofechaStandardization,
            range,
            localRange,
        ),
    })).sort((left, right) => right.score - left.score);
    const selectedStaircase = staircaseCandidates[0];
    if (!selectedStaircase) {
        return null;
    }

    const scoreAgainstReference = (
        candidate: ScoredCorrection,
        reference: Views,
    ): number => scoreViews(
        candidate.views,
        reference,
        range.startYear,
        range.endYear,
        20,
    ) * 0.35 + scoreViews(
        candidate.views,
        reference,
        localRange.startYear,
        localRange.endYear,
        6,
    ) * 0.65;
    const referenceViews = diagnosis.master.sourceTrees.flatMap((tree) => {
        const rawReference = toNumericSeries(siteData.get(tree));
        if (rawReference.size === 0) return [];
        return [makeViews(rawReference, useCofechaStandardization)];
    });
    const referenceScoreCache = new Map<ScoredCorrection, number[]>();
    const referenceScoresFor = (candidate: ScoredCorrection): number[] => {
        const cached = referenceScoreCache.get(candidate);
        if (cached) return cached;
        const scores = referenceViews.map((reference) => (
            scoreAgainstReference(candidate, reference)
        ));
        referenceScoreCache.set(candidate, scores);
        return scores;
    };
    const staircaseScores = referenceViews.map((_reference, index) => Math.max(
        ...staircaseCandidates.map((candidate) => (
            referenceScoresFor(candidate)[index]
        )),
    ));
    const INFORMATIVE_MARGIN = 1e-9;
    const shiftProfiles = partialShifts.flatMap((shiftYears) => {
        const candidatesForShift = directCandidates.filter(
            (candidate) => candidate.shiftYears === shiftYears,
        );
        if (candidatesForShift.length === 0) return [];
        const allMargins = referenceViews.map((_reference, index) => {
            const bestDirect = Math.max(...candidatesForShift.map((candidate) => (
                referenceScoresFor(candidate)[index]
            )));
            return staircaseScores[index] - bestDirect;
        }).filter(Number.isFinite);
        const margins = allMargins.filter(
            (margin) => Math.abs(margin) > INFORMATIVE_MARGIN,
        );
        if (margins.length === 0) return [];
        const partialSupport = margins.filter((margin) => margin < 0).length;
        return [{
            shiftYears,
            candidates: candidatesForShift,
            margins,
            medianMargin: median(margins),
            upperQuartileMargin: quantile(margins, 0.75),
            partialSupportRatio: partialSupport / margins.length,
            masterScore: Math.max(...candidatesForShift.map((candidate) => candidate.score)),
        }];
    }).sort((left, right) => (
        left.medianMargin - right.medianMargin
        || left.upperQuartileMargin - right.upperQuartileMargin
        || right.partialSupportRatio - left.partialSupportRatio
        || right.margins.length - left.margins.length
        || right.masterScore - left.masterScore
    ));
    const familyShift = shiftProfiles[0];
    if (!familyShift) return null;
    const cofechaShifts = Array.from(new Set(
        eligiblePartials
            .filter((row) => row.cofechaBacked)
            .map((row) => row.shiftYears),
    ));
    const cofechaShift = cofechaShifts.length === 1
        ? shiftProfiles.find((profile) => profile.shiftYears === cofechaShifts[0])
        : undefined;
    const selectedShift = cofechaShift ?? familyShift;
    const boundaryEvidenceCount = Math.min(
        Math.abs(selectedShift.shiftYears),
        missingYears.length,
    );
    const boundaryEvidenceYears = missingYears.slice(-boundaryEvidenceCount);
    const boundaryPriorYear = Math.round(median(boundaryEvidenceYears));
    const boundaryCandidates = selectedShift.candidates.filter((candidate) => (
        candidate.firstFixedYear !== null
        && Math.abs(candidate.firstFixedYear - boundaryPriorYear) <= 2
    ));

    const directProfiles = (
        boundaryCandidates.length > 0 ? boundaryCandidates : selectedShift.candidates
    ).map((candidate) => {
        const margins = referenceViews.map((_reference, index) => (
            staircaseScores[index] - referenceScoresFor(candidate)[index]
        )).filter((margin) => (
            Number.isFinite(margin) && Math.abs(margin) > INFORMATIVE_MARGIN
        ));
        const partialSupport = margins.filter((margin) => margin < 0).length;
        return {
            candidate,
            margins,
            medianMargin: median(margins),
            upperQuartileMargin: quantile(margins, 0.75),
            partialSupportRatio: partialSupport / Math.max(1, margins.length),
        };
    }).sort((left, right) => (
        left.medianMargin - right.medianMargin
        || left.upperQuartileMargin - right.upperQuartileMargin
        || right.partialSupportRatio - left.partialSupportRatio
        || right.margins.length - left.margins.length
        || right.candidate.score - left.candidate.score
    ));
    const selectedDirect = directProfiles[0]?.candidate;
    if (!selectedDirect || selectedDirect.firstFixedYear === null) return null;

    const referenceMargins = familyShift.margins;
    const staircaseReferenceSupport = referenceMargins.filter(
        (margin) => margin > 0,
    ).length;
    const partialReferenceSupport = referenceMargins.filter(
        (margin) => margin < 0,
    ).length;
    return {
        familyShiftYears: familyShift.shiftYears,
        partialShiftYears: selectedShift.shiftYears,
        partialFirstFixedYear: selectedDirect.firstFixedYear,
        boundaryPriorYear,
        shiftSelectionSource: cofechaShift
            ? "cofecha_segment_lag"
            : "completed_family_profile",
        missingYears: selectedStaircase.years.slice().sort((left, right) => left - right),
        masterMargin: selectedStaircase.score - selectedDirect.score,
        totalReferenceCount: referenceViews.length,
        ambiguousReferenceCount: referenceViews.length - referenceMargins.length,
        referenceCount: referenceMargins.length,
        staircaseReferenceSupport,
        staircaseReferenceSupportRatio:
            staircaseReferenceSupport / Math.max(1, referenceMargins.length),
        partialReferenceSupport,
        partialReferenceSupportRatio:
            partialReferenceSupport / Math.max(1, referenceMargins.length),
        referenceMedianMargin: median(referenceMargins),
        referenceLowerQuartileMargin: quantile(referenceMargins, 0.25),
        referenceUpperQuartileMargin: quantile(referenceMargins, 0.75),
        shiftProfiles: shiftProfiles.map((profile) => ({
            shiftYears: profile.shiftYears,
            referenceCount: profile.margins.length,
            partialReferenceSupport: profile.margins.filter(
                (margin) => margin < 0,
            ).length,
            partialReferenceSupportRatio: profile.partialSupportRatio,
            referenceMedianMargin: profile.medianMargin,
            referenceUpperQuartileMargin: profile.upperQuartileMargin,
            masterScore: profile.masterScore,
        })),
    };
};

const simulatePartialUnitComposition = (
    series: NumericSeries,
    unitEventType: CompletedPartialUnitEventType,
    orientation: CompletedPartialUnitOrientation,
    olderBoundaryYear: number,
    newerBoundaryYear: number,
    partialShiftYears: number,
): NumericSeries => {
    const simulateUnit = unitEventType === "missingRing"
        ? simulateMissingRing
        : simulateFalseRing;
    const unitShiftYears = unitEventType === "missingRing" ? -1 : 1;
    const unitThenPartial = orientation === "missingThenPartial"
        || orientation === "falseThenPartial";
    if (unitThenPartial) {
        const afterPartial = simulatePartialMove(
            series,
            newerBoundaryYear,
            partialShiftYears,
        );
        return simulateUnit(
            afterPartial,
            olderBoundaryYear + partialShiftYears,
        );
    }
    const afterUnit = simulateUnit(series, newerBoundaryYear);
    return simulatePartialMove(
        afterUnit,
        olderBoundaryYear + unitShiftYears,
        partialShiftYears,
    );
};

/**
 * Compares complete corrections when a cumulative negative lag may contain one physical gap and
 * one unit ring edit. The two event orders have different middle states, so the winning family
 * also identifies which operation is the newer, currently executable frontier.
 */
const compareCompletedPartialWithSingleUnit = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    event: DiagnosisEvent,
    pathMissingYears: readonly number[] = [],
    useCofechaStandardization = true,
    additionalAnchorYears: readonly number[] = [],
    unitEventType: CompletedPartialUnitEventType,
): CompletedPartialUnitComposition | null => {
    const cumulativeShiftYears = event.shiftYears;
    if (
        event.eventType !== "partialMove"
        || event.shiftSide !== "older"
        || !Number.isInteger(cumulativeShiftYears)
        || cumulativeShiftYears! > -3
        || event.evidence.candidateIds.length === 0
        || !event.evidence.notes.includes("candidate_hard_gate_passed")
    ) return null;
    const unitShiftYears = unitEventType === "missingRing" ? -1 : 1;
    const partialShiftYears = cumulativeShiftYears! - unitShiftYears;
    if (partialShiftYears > -2) return null;

    const orientations: readonly CompletedPartialUnitOrientation[] = unitEventType
        === "missingRing"
        ? ["missingThenPartial", "partialThenMissing"]
        : ["falseThenPartial", "partialThenFalse"];

    const range = diagnosis.targetRange;
    const minimumBoundaryYear = range.startYear + 12;
    const maximumBoundaryYear = range.endYear - 12;
    if (maximumBoundaryYear <= minimumBoundaryYear) return null;
    const topYear = event.rankedYears.slice().sort(
        (left, right) => left.rank - right.rank,
    )[0]?.year ?? Math.round((event.startYear + event.endYear) / 2);
    const anchorYears = new Set<number>();
    for (
        let year = Math.max(minimumBoundaryYear, event.startYear);
        year <= Math.min(maximumBoundaryYear, event.endYear);
        year += 1
    ) anchorYears.add(year);
    for (let offset = -4; offset <= 4; offset += 1) {
        const year = topYear + offset;
        if (year >= minimumBoundaryYear && year <= maximumBoundaryYear) {
            anchorYears.add(year);
        }
    }
    additionalAnchorYears.forEach((anchorYear) => {
        if (!Number.isInteger(anchorYear)) return;
        for (let offset = -4; offset <= 4; offset += 1) {
            const year = anchorYear + offset;
            if (year >= minimumBoundaryYear && year <= maximumBoundaryYear) {
                anchorYears.add(year);
            }
        }
    });
    if (anchorYears.size === 0) return null;

    const boundaryPairs = new Map<string, {
        olderBoundaryYear: number;
        newerBoundaryYear: number;
    }>();
    const addBoundaryPair = (olderBoundaryYear: number, newerBoundaryYear: number): void => {
        if (olderBoundaryYear < minimumBoundaryYear
            || newerBoundaryYear > maximumBoundaryYear
            || newerBoundaryYear - olderBoundaryYear < 2
            || newerBoundaryYear - olderBoundaryYear > 25) return;
        boundaryPairs.set(`${olderBoundaryYear}:${newerBoundaryYear}`, {
            olderBoundaryYear,
            newerBoundaryYear,
        });
    };
    anchorYears.forEach((anchorYear) => {
        for (let separationYears = 2; separationYears <= 25; separationYears += 1) {
            addBoundaryPair(anchorYear, anchorYear + separationYears);
            addBoundaryPair(anchorYear - separationYears, anchorYear);
        }
    });
    if (boundaryPairs.size === 0) return null;

    const directYears = new Set<number>();
    for (
        let year = Math.max(minimumBoundaryYear, event.startYear - 4);
        year <= Math.min(maximumBoundaryYear, event.endYear + 4);
        year += 1
    ) directYears.add(year);
    boundaryPairs.forEach(({ olderBoundaryYear, newerBoundaryYear }) => {
        directYears.add(olderBoundaryYear);
        directYears.add(newerBoundaryYear);
    });
    const comparisonRange = (
        startYear: number,
        endYear: number,
        paddingYears: number,
    ): { startYear: number; endYear: number } => ({
        startYear: Math.max(range.startYear, startYear - paddingYears),
        endYear: Math.min(range.endYear, endYear + paddingYears),
    });
    const masterViews: Views = {
        raw: diagnosis.master.data,
        difference: firstDifferences(diagnosis.master.data),
        whitened: ar1WhitenSeries(diagnosis.master.data),
    };
    const directCandidates = Array.from(directYears).map(
        (firstFixedYear): CompletionComparisonCorrection => {
            const localRange = comparisonRange(firstFixedYear, firstFixedYear, 16);
            return {
            years: [],
            firstFixedYear,
            shiftYears: cumulativeShiftYears!,
            comparisonRange: localRange,
            ...scoreCorrection(
                simulatePartialMove(
                    diagnosis.rawTarget,
                    firstFixedYear,
                    cumulativeShiftYears!,
                ),
                masterViews,
                useCofechaStandardization,
                range,
                localRange,
            ),
            };
        },
    ).sort((left, right) => right.score - left.score).slice(0, 24);
    const mixedCandidates = Array.from(boundaryPairs.values()).flatMap((pair) => (
        orientations.map(
            (orientation): MixedPartialUnitCorrection => {
                const localRange = comparisonRange(
                    pair.olderBoundaryYear,
                    pair.newerBoundaryYear,
                    8,
                );
                const unitThenPartial = orientation === "missingThenPartial"
                    || orientation === "falseThenPartial";
                return {
                years: [],
                firstFixedYear: unitThenPartial
                    ? pair.newerBoundaryYear
                    : pair.olderBoundaryYear,
                shiftYears: partialShiftYears,
                orientation,
                ...pair,
                comparisonRange: localRange,
                ...scoreCorrection(
                    simulatePartialUnitComposition(
                        diagnosis.rawTarget,
                        unitEventType,
                        orientation,
                        pair.olderBoundaryYear,
                        pair.newerBoundaryYear,
                        partialShiftYears,
                    ),
                    masterViews,
                    useCofechaStandardization,
                    range,
                    localRange,
                ),
                };
            },
        )
    )).sort((left, right) => right.score - left.score);
    const retainedMixed = orientations
        .flatMap((orientation) => mixedCandidates.filter((candidate) => (
            candidate.orientation === orientation
        )).slice(0, 24));
    if (directCandidates.length === 0 || retainedMixed.length === 0) return null;

    const uniquePathMissingYears = Array.from(new Set(pathMissingYears))
        .sort((left, right) => left - right);
    const canCompareMissingStaircase = unitEventType === "missingRing"
        && uniquePathMissingYears.length
        === Math.abs(cumulativeShiftYears!);
    const missingStaircaseCandidates = canCompareMissingStaircase
        ? Array.from({ length: 5 }, (_, index) => (
            uniquePathMissingYears.map((year) => year + index - 2)
        )).filter((years) => years.every((year) => (
            year >= minimumBoundaryYear && year <= maximumBoundaryYear
        ))).map((years): CompletionComparisonCorrection => {
            const localRange = comparisonRange(
                Math.min(...years),
                Math.max(...years),
                8,
            );
            return {
            years,
            firstFixedYear: null,
            comparisonRange: localRange,
            ...scoreCorrection(
                simulateMissingRings(diagnosis.rawTarget, years),
                masterViews,
                useCofechaStandardization,
                range,
                localRange,
            ),
            };
        }).sort((left, right) => right.score - left.score)
        : [];
    const competingCandidates = [
        ...directCandidates,
        ...missingStaircaseCandidates,
    ];
    const referenceViews = diagnosis.master.sourceTrees.flatMap((tree) => {
        const rawReference = toNumericSeries(siteData.get(tree));
        if (rawReference.size === 0) return [];
        return [makeViews(rawReference, useCofechaStandardization)];
    });
    if (referenceViews.length === 0) return null;
    const scoreAgainstReference = (
        candidate: CompletionComparisonCorrection,
        reference: Views,
    ): number => scoreViews(
        candidate.views,
        reference,
        range.startYear,
        range.endYear,
        20,
    ) * 0.35 + scoreViews(
        candidate.views,
        reference,
        candidate.comparisonRange.startYear,
        candidate.comparisonRange.endYear,
        6,
    ) * 0.65;
    const referenceScoreCache = new Map<CompletionComparisonCorrection, number[]>();
    const referenceScoresFor = (
        candidate: CompletionComparisonCorrection,
    ): number[] => {
        const cached = referenceScoreCache.get(candidate);
        if (cached) return cached;
        const scores = referenceViews.map((reference) => (
            scoreAgainstReference(candidate, reference)
        ));
        referenceScoreCache.set(candidate, scores);
        return scores;
    };
    const competingScores = referenceViews.map((_reference, index) => Math.max(
        ...competingCandidates.map((candidate) => referenceScoresFor(candidate)[index]),
    ));
    const INFORMATIVE_MARGIN = 1e-9;
    const profiles = retainedMixed.map((candidate) => {
        const margins = referenceViews.map((_reference, index) => (
            referenceScoresFor(candidate)[index] - competingScores[index]
        )).filter((margin) => (
            Number.isFinite(margin) && Math.abs(margin) > INFORMATIVE_MARGIN
        ));
        return {
            candidate,
            margins,
            support: margins.filter((margin) => margin > 0).length,
            medianMargin: median(margins),
            lowerQuartileMargin: quantile(margins, 0.25),
        };
    });
    const bestByOrientation = orientations
        .flatMap((orientation) => profiles.filter((profile) => (
            profile.candidate.orientation === orientation
            && profile.margins.length > 0
        )).sort((left, right) => (
            right.medianMargin - left.medianMargin
            || right.lowerQuartileMargin - left.lowerQuartileMargin
            || right.support - left.support
            || right.candidate.score - left.candidate.score
        )).slice(0, 1));
    const selected = bestByOrientation.slice().sort((left, right) => (
        right.medianMargin - left.medianMargin
        || right.lowerQuartileMargin - left.lowerQuartileMargin
        || right.support - left.support
        || right.candidate.score - left.candidate.score
    ))[0];
    if (!selected) return null;
    const otherOrientation = orientations.find(
        (orientation) => orientation !== selected.candidate.orientation,
    );
    if (!otherOrientation) return null;
    const selectedOrientationCandidates = retainedMixed.filter((candidate) => (
        candidate.orientation === selected.candidate.orientation
    ));
    const otherOrientationCandidates = retainedMixed.filter((candidate) => (
        candidate.orientation === otherOrientation
    ));
    const orientationMargins = referenceViews.map((_reference, index) => (
        Math.max(...selectedOrientationCandidates.map((candidate) => (
            referenceScoresFor(candidate)[index]
        ))) - Math.max(...otherOrientationCandidates.map((candidate) => (
            referenceScoresFor(candidate)[index]
        )))
    )).filter((margin) => (
        Number.isFinite(margin) && Math.abs(margin) > INFORMATIVE_MARGIN
    ));
    const orientationReferenceSupport = orientationMargins.filter(
        (margin) => margin > 0,
    ).length;
    const bestCompetingMasterScore = Math.max(
        ...competingCandidates.map((candidate) => candidate.score),
    );
    const bestOtherOrientationMasterScore = Math.max(
        ...otherOrientationCandidates.map((candidate) => candidate.score),
    );
    const candidate = selected.candidate;
    const unitThenPartial = candidate.orientation === "missingThenPartial"
        || candidate.orientation === "falseThenPartial";
    return {
        unitEventType,
        cumulativeShiftYears: cumulativeShiftYears!,
        partialShiftYears,
        orientation: candidate.orientation,
        olderBoundaryYear: candidate.olderBoundaryYear,
        newerBoundaryYear: candidate.newerBoundaryYear,
        frontierEventType: unitThenPartial
            ? "partialMove"
            : unitEventType,
        frontierYear: candidate.newerBoundaryYear,
        separationYears: candidate.newerBoundaryYear - candidate.olderBoundaryYear,
        masterMargin: candidate.score - bestCompetingMasterScore,
        referenceCount: selected.margins.length,
        mixedReferenceSupport: selected.support,
        mixedReferenceSupportRatio: selected.support
            / Math.max(1, selected.margins.length),
        referenceMedianMargin: selected.medianMargin,
        referenceLowerQuartileMargin: selected.lowerQuartileMargin,
        orientationReferenceCount: orientationMargins.length,
        orientationReferenceSupport,
        orientationReferenceSupportRatio: orientationReferenceSupport
            / Math.max(1, orientationMargins.length),
        orientationMedianMargin: median(orientationMargins),
        orientationLowerQuartileMargin: quantile(orientationMargins, 0.25),
        masterOrientationMargin: candidate.score - bestOtherOrientationMasterScore,
        comparedWithMissingStaircase: missingStaircaseCandidates.length > 0,
    };
};

export const compareCompletedPartialWithSingleMissing = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    event: DiagnosisEvent,
    pathMissingYears: readonly number[] = [],
    useCofechaStandardization = true,
    additionalAnchorYears: readonly number[] = [],
): CompletedPartialMissingComposition | null => compareCompletedPartialWithSingleUnit(
    diagnosis,
    siteData,
    event,
    pathMissingYears,
    useCofechaStandardization,
    additionalAnchorYears,
    "missingRing",
) as CompletedPartialMissingComposition | null;

export const compareCompletedPartialWithSingleFalse = (
    diagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    event: DiagnosisEvent,
    useCofechaStandardization = true,
    additionalAnchorYears: readonly number[] = [],
): CompletedPartialFalseComposition | null => compareCompletedPartialWithSingleUnit(
    diagnosis,
    siteData,
    event,
    [],
    useCofechaStandardization,
    additionalAnchorYears,
    "falseRing",
) as CompletedPartialFalseComposition | null;

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

/**
 * Full-interval counterfactual locator for an already accepted diagnosis event.
 *
 * Multiple independent mechanisms may propose internal 25-year search hypotheses. Cross-signal
 * support selects one coarse region, then an event-specific profile selects one local mode and
 * the narrowest calibrated 5/7/9/13-year review window. Internal alternatives stay private.
 */
import type { RwlSiteData } from "@/features/rwl/types";
import { scoreBoundaryLocalCounterfactual } from "./boundaryLocalCounterfactual";
import { selectCalibratedEventWindow } from "./calibratedEventWindow";
import { scoreFalseRingCoarseCounterfactual } from "./falseRingCoarseCounterfactual";
import { scoreMissingRingCoarseCounterfactual } from "./missingRingCoarseCounterfactual";
import { rankUnitEventWindows } from "./unitEventWindowRanker";
import { selectUnitEventShortWindow } from "./unitEventShortWindowSelector";
import { rankUnitEventYears } from "./unitEventYearRanking";
import { scoreUnitEventLocalCorrectionRanks } from "./unitEventLocalCorrectionRanking";
import { scoreUnitEventExactYearEvidence } from "./unitEventExactYearEvidence";
import { selectUnitEventCoarseWindow } from "./unitEventCoarseWindowSelector";
import {
    scoreCumulativeLagChangePoints,
    type CumulativeLagChangePointScore,
} from "./cumulativeLagChangePoint";
import {
    type EventPathConfig,
    type LagPathCache,
    scoreLagTransitionHypotheses,
} from "./eventPath";
import { getJointCounterfactualOperationScores } from "./jointCounterfactualOperation";
import { scorePerReferenceCounterfactualEvidence } from "./perReferenceCounterfactualEvidence";
import { scoreNegativePartialMoveBoundaries } from "./partialBreakpointRefinement";
import { scoreReferenceTransitionConsensus } from "./referenceTransitionConsensus";
import { scorePiecewiseChangePoints } from "./piecewiseChangePoint";
import { scoreFullIntervalShiftEvidence } from "./fullIntervalUnitEditEvidence";
import { ar1WhitenSeries } from "./series";
import {
    firstFixedYearFromLastMovedYear,
    isNegativePartialShift,
} from "./partialMoveSemantics";
import type {
    DiagnosisEvent,
    DiagnosisRankedYear,
    SeriesCoreDiagnosis,
} from "./types";

type ProfileName =
    | "rawFull"
    | "differenceFull"
    | "whitenedFull"
    | "comboFull"
    | "jointOperationMargin"
    | "sideStepScore"
    | "sideMinimumAdvantage"
    | "correctedSideSupport"
    | "piecewiseCombinedObjective"
    | "cumulativeCombined"
    | "cumulativeCombinedCusum"
    | "cumulativeCombinedContrast"
    | "cumulativeDifference"
    | "cumulativeDifferenceCusum"
    | "cumulativeDifferenceContrast"
    | "cumulativeRawCusum"
    | "cumulativeRawContrast"
    | "cumulativeWhitenedCusum"
    | "cumulativeWhitenedContrast"
    | "cumulativeCofechaCusum"
    | "cumulativeCofechaContrast"
    | "cumulativeLocal31"
    | "cumulativeLocal61"
    | "cumulativeReferenceMedian"
    | "cumulativeReferenceMedianCusum"
    | "cumulativeReferenceMedianContrast"
    | "cumulativeReferenceMean"
    | "cumulativeReferenceMeanCusum"
    | "cumulativeReferenceMeanContrast"
    | "cumulativeReferenceVote"
    | "cumulativeReferenceVoteCusum"
    | "cumulativeReferenceVoteContrast"
    | "transitionSplitGain"
    | "pairDifferenceWeighted"
    | "pairWhitenedMean"
    | "pairPeakKernel5"
    | "pairPeakKernel9"
    | `partialBoundary:${
        | "raw31"
        | "difference31"
        | "whitened31"
        | "combo31"
        | "combo41"
        | "combo61"
        | "multiScale"
    }`
    | `boundaryLocal:${
        | "olderAdvantage3"
        | "newerAdvantage3"
        | "stepMinimum3"
        | "stepMean3"
        | "olderAdvantage5"
        | "newerAdvantage5"
        | "stepMinimum5"
        | "stepMean5"
        | "olderAdvantage9"
        | "newerAdvantage9"
        | "stepMinimum9"
        | "stepMean9"
    }`
    | "reference:rankMean"
    | "reference:rankMedian"
    | "reference:weightedRankMean"
    | "reference:peakKernel5"
    | "reference:peakKernel9"
    | "reference:peakKernel13"
    | "reference:windowVote25"
    | "reference:weightedWindowVote25";

type ProfileRow = {
    year: number;
    value: number;
};

type InternalWindow = {
    startYear: number;
    endYear: number;
    source: string;
};

type CandidateStatistic = "mean" | "max" | "center" | "contrast";

type CandidateMember = {
    profile: ProfileName;
    statistic: CandidateStatistic;
};

export type CounterfactualEventLocatorResult = {
    event: DiagnosisEvent;
    correctionYears: number;
    coarseWindow: { startYear: number; endYear: number };
    coarseSource: string;
    internalCandidateCount: number;
};

export type CounterfactualLocatorAuditRow = {
    eventType: DiagnosisEvent["eventType"];
    correctionYears: number;
    years: number[];
    profileNames: string[];
    ranks: Record<string, number[]>;
    unitCounterfactualRows?: Array<{
        year: number;
        profiles: Record<string, number>;
    }>;
    candidates: Array<InternalWindow & {
        aggregateScore: number;
        overlapConsensus: number;
    }>;
    coarseDensitySelectedIndex: number;
    coarseRuleSelectedIndex: number;
    coarseSelectedIndex: number;
    coarseModelSelectedIndex?: number;
    coarseModelScore?: number;
    coarseModelMargin?: number;
    coarseModelScores?: Array<{ index: number; score: number }>;
    coarseCandidateCounterfactuals?: Array<{
        candidateIndex: number;
        source: string;
        scoreWindow: { startYear: number; endYear: number };
        rows: Array<{
            year: number;
            profiles: Record<string, number>;
        }>;
    }>;
    coarseWindow: { startYear: number; endYear: number };
    coarseSource: string;
    finalWindow: { startYear: number; endYear: number };
    currentPrimaryYear?: number;
    currentWindow: { startYear: number; endYear: number };
    selectedOperation: {
        bestYear: number;
        bestRawGain: number;
        bestDifferenceGain: number;
        bestCombinedGain: number;
        topThreeDifferenceGain: number;
        remoteDifferenceMargin: number;
        sideStepBestYear: number;
        bestSideStepScore: number;
        topThreeSideStepScore: number;
        bestSideMinimumAdvantage: number;
        bestCorrectedSideSupport: number;
        sideStepRemoteMargin: number;
    } | null;
    calibratedWidth?: number;
    calibrationRule?: string;
    modeWindow?: { startYear: number; endYear: number };
    learnedWindow?: { startYear: number; endYear: number };
    prePointModeWindow?: { startYear: number; endYear: number };
    preFalseCurrentAnchorModeWindow?: { startYear: number; endYear: number };
    preDirectModeWindow?: { startYear: number; endYear: number };
    learnedRecommendedWidth?: number;
    windowCenteringRule?: string;
    widthSelectionRule?: string;
    widthFallbackRule?: string;
    learnedWindowScore?: number;
    learnedWindowMargin?: number;
    learnedWindowRemoteMargin?: number;
    nineYearSafety?: number;
    nineYearSafetyThreshold?: number;
};

type CounterfactualLocatorAuditObserver = (
    row: CounterfactualLocatorAuditRow,
) => void;

export type CounterfactualLocatorAuditOptions = {
    includeCoarseCandidateCounterfactuals?: boolean;
};

let auditObserver: CounterfactualLocatorAuditObserver | null = null;
let auditOptions: CounterfactualLocatorAuditOptions = {};

/**
 * Test-only observation point for full locator evidence. The default browser path has no
 * observer, and the returned disposer prevents benchmark runs from leaking state.
 */
export const observeCounterfactualLocator = (
    observer: CounterfactualLocatorAuditObserver,
    options: CounterfactualLocatorAuditOptions = {},
): (() => void) => {
    const previous = auditObserver;
    const previousOptions = auditOptions;
    auditObserver = observer;
    auditOptions = options;
    return () => {
        if (auditObserver === observer) {
            auditObserver = previous;
            auditOptions = previousOptions;
        }
    };
};

const REFERENCE_WINDOW_FEATURES = [
    "rankMean",
    "rankMedian",
    "weightedRankMean",
    "peakKernel5",
    "peakKernel9",
    "peakKernel13",
    "windowVote25",
    "weightedWindowVote25",
] as const;

const percentileRanks = (values: number[]): number[] => {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const result = new Array(values.length).fill(0);
    let start = 0;
    while (start < ordered.length) {
        let end = start + 1;
        while (end < ordered.length && ordered[end].value === ordered[start].value) {
            end += 1;
        }
        const rank = ((start + end - 1) / 2) / Math.max(1, ordered.length - 1);
        for (let index = start; index < end; index += 1) {
            result[ordered[index].index] = rank;
        }
        start = end;
    }
    return result;
};

const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const ordered = values.slice().sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2
        ? ordered[middle]
        : (ordered[middle - 1] + ordered[middle]) / 2;
};

const robustPositive = (values: number[]): number[] => {
    const center = median(values);
    const scale = median(values.map((value) => Math.abs(value - center)))
        * 1.4826 || 1e-9;
    return values.map((value) => (
        Math.max(0, Math.min(8, (value - center) / scale))
    ));
};

const boundedWindow = (
    startYear: number,
    width: number,
    minimumYear: number,
    maximumYear: number,
): { startYear: number; endYear: number } => {
    const safeWidth = Math.max(1, Math.min(width, maximumYear - minimumYear + 1));
    const boundedStart = Math.max(
        minimumYear,
        Math.min(startYear, maximumYear - safeWidth + 1),
    );
    return {
        startYear: boundedStart,
        endYear: boundedStart + safeWidth - 1,
    };
};

const windowOverlapRatio = (
    left: Pick<InternalWindow, "startYear" | "endYear">,
    right: Pick<InternalWindow, "startYear" | "endYear">,
): number => {
    const intersection = Math.max(
        0,
        Math.min(left.endYear, right.endYear)
            - Math.max(left.startYear, right.startYear)
            + 1,
    );
    const union = Math.max(left.endYear, right.endYear)
        - Math.min(left.startYear, right.startYear)
        + 1;
    return union > 0 ? intersection / union : 0;
};

const windowContainsYear = (
    window: Pick<InternalWindow, "startYear" | "endYear">,
    year: number,
): boolean => year >= window.startYear && year <= window.endYear;

const coarseCandidateFamily = (source: string): string => {
    if (source === "current_event") return "current";
    if (source === "joint_counterfactual_operation") return "joint";
    if (source === "lag_transition") return "transition";
    if (source.startsWith("profile:")) return "profile";
    if (source.startsWith("reference_transition:")) return "reference";
    return "other";
};

const FALSE_RING_CURRENT_MODE_MINIMUM_CANDIDATE_MARGIN = 0.1;

/**
 * Reference features are highly correlated, so each evidence family contributes one mean vote.
 * This keeps a large reference family from outvoting an independent lag-transition hypothesis.
 */
export const selectFalseRingCoarseCandidateIndex = (
    candidates: readonly Pick<
        InternalWindow,
        "startYear" | "endYear" | "source"
    >[],
): number => {
    if (candidates.length === 0) return 0;
    const bandwidth = 2;
    const groups = new Map<string, number[]>();
    candidates.forEach((candidate, index) => {
        const family = coarseCandidateFamily(candidate.source);
        const group = groups.get(family) ?? [];
        group.push(index);
        groups.set(family, group);
    });
    const scores = candidates.map((candidate) => {
        const candidateCenter = (
            candidate.startYear + candidate.endYear
        ) / 2;
        let density = 0;
        groups.forEach((indexes, family) => {
            const familyVote = indexes.reduce((sum, index) => {
                const other = candidates[index];
                const otherCenter = (
                    other.startYear + other.endYear
                ) / 2;
                return sum + Math.exp(
                    -0.5 * (
                        (candidateCenter - otherCenter) / bandwidth
                    ) ** 2,
                );
            }, 0) / Math.max(1, indexes.length);
            const weight = family === "current"
                ? 0.25
                : family === "reference"
                    ? 0.5
                    : 1;
            density += familyVote * weight;
        });
        return density + (
            coarseCandidateFamily(candidate.source) === "transition"
                ? 0.25
                : 0
        );
    });
    return candidates.reduce((best, candidate, index) => {
        const difference = scores[index] - scores[best];
        if (difference > 1e-9) return index;
        if (difference < -1e-9) return best;
        const candidateCenter = (
            candidate.startYear + candidate.endYear
        ) / 2;
        const bestCenter = (
            candidates[best].startYear + candidates[best].endYear
        ) / 2;
        return candidateCenter > bestCenter ? index : best;
    }, 0);
};

/**
 * A remote transition peak must not displace a false-ring mode that is independently
 * supported by both the current event and the executable delete-year candidate.
 */
export const selectCorroboratedFalseRingCurrentCandidateIndex = (input: {
    candidates: readonly Pick<
        InternalWindow,
        "startYear" | "endYear" | "source"
    >[];
    selectedIndex: number;
    currentPrimaryYear?: number;
    candidateTopYear?: number;
    candidateTopMargin?: number;
}): number => {
    const selected = input.candidates[input.selectedIndex];
    if (
        !selected
        || input.currentPrimaryYear === undefined
        || input.candidateTopYear === undefined
        || input.candidateTopMargin === undefined
        || input.candidateTopMargin
            < FALSE_RING_CURRENT_MODE_MINIMUM_CANDIDATE_MARGIN
        || Math.abs(
            input.currentPrimaryYear - input.candidateTopYear,
        ) > 6
        || windowContainsYear(selected, input.currentPrimaryYear)
        || windowContainsYear(selected, input.candidateTopYear)
    ) return input.selectedIndex;
    const currentIndex = input.candidates.findIndex((candidate) => (
        candidate.source === "current_event"
        && windowContainsYear(candidate, input.currentPrimaryYear!)
        && windowContainsYear(candidate, input.candidateTopYear!)
    ));
    return currentIndex >= 0 ? currentIndex : input.selectedIndex;
};

export const selectCounterfactualCoarseCandidateIndex = (
    candidates: readonly Pick<InternalWindow, "startYear" | "endYear">[],
    aggregateScores: readonly number[],
    overlapConsensusWeight = 0,
): { index: number; overlapConsensus: number[] } => {
    const overlapConsensus = candidates.map((candidate) => (
        candidates.reduce(
            (sum, other) => sum + windowOverlapRatio(candidate, other),
            0,
        ) / Math.max(1, candidates.length)
    ));
    const epsilon = 1e-9;
    const index = candidates.reduce((best, _, candidateIndex) => {
        const scoreDifference =
            (
                (aggregateScores[candidateIndex] ?? 0)
                + overlapConsensus[candidateIndex] * overlapConsensusWeight
            )
            - (
                (aggregateScores[best] ?? 0)
                + overlapConsensus[best] * overlapConsensusWeight
            );
        if (scoreDifference > epsilon) return candidateIndex;
        if (scoreDifference < -epsilon) return best;
        const consensusDifference =
            overlapConsensus[candidateIndex] - overlapConsensus[best];
        return consensusDifference > epsilon ? candidateIndex : best;
    }, 0);
    return { index, overlapConsensus };
};

const bestMassWindow = (
    rows: ProfileRow[],
    width: number,
    minimumYear: number,
    maximumYear: number,
): { startYear: number; endYear: number } | null => {
    if (rows.length === 0) return null;
    let best: { startYear: number; endYear: number; score: number } | null = null;
    rows.forEach((row) => {
        const window = boundedWindow(
            row.year,
            width,
            minimumYear,
            maximumYear,
        );
        let score = 0;
        let count = 0;
        for (let index = 0; index < rows.length; index += 1) {
            if (rows[index].year < window.startYear) continue;
            if (rows[index].year > window.endYear) break;
            score += rows[index].value;
            count += 1;
        }
        const normalized = score / Math.sqrt(Math.max(1, count));
        if (!best || normalized > best.score) {
            best = { ...window, score: normalized };
        }
    });
    return best;
};

const correctionFor = (event: DiagnosisEvent): number | null => {
    if (event.eventType === "missingRing") return -1;
    if (event.eventType === "falseRing") return 1;
    if (event.eventType !== "partialMove") return null;
    const evidenceCorrection = event.evidence.lagBefore !== null
        && event.evidence.lagAfter !== null
        ? event.evidence.lagBefore - event.evidence.lagAfter
        : null;
    const correction = event.shiftYears ?? evidenceCorrection;
    return correction !== null
        && isNegativePartialShift(correction)
        ? correction
        : null;
};

const valueForCumulative = (
    row: CumulativeLagChangePointScore,
    profile: ProfileName,
): number => {
    if (profile === "cumulativeCombined") return row.combinedCumulative;
    if (profile === "cumulativeCombinedCusum") return row.combinedCusum;
    if (profile === "cumulativeCombinedContrast") return row.combinedContrast;
    if (profile === "cumulativeDifference") return row.differenceCumulative;
    if (profile === "cumulativeDifferenceCusum") return row.differenceCusum;
    if (profile === "cumulativeDifferenceContrast") {
        return row.differenceContrast;
    }
    if (profile === "cumulativeRawCusum") return row.rawCusum;
    if (profile === "cumulativeRawContrast") return row.rawContrast;
    if (profile === "cumulativeWhitenedCusum") return row.whitenedCusum;
    if (profile === "cumulativeWhitenedContrast") {
        return row.whitenedContrast;
    }
    if (profile === "cumulativeCofechaCusum") return row.cofechaCusum;
    if (profile === "cumulativeCofechaContrast") return row.cofechaContrast;
    if (profile === "cumulativeLocal31") return row.combinedLocal31;
    if (profile === "cumulativeLocal61") return row.combinedLocal61;
    if (profile === "cumulativeReferenceMedian") {
        return row.referenceMedianCumulative;
    }
    if (profile === "cumulativeReferenceMedianCusum") {
        return row.referenceMedianCusum;
    }
    if (profile === "cumulativeReferenceMedianContrast") {
        return row.referenceMedianContrast;
    }
    if (profile === "cumulativeReferenceMean") return row.referenceMeanCumulative;
    if (profile === "cumulativeReferenceMeanCusum") return row.referenceMeanCusum;
    if (profile === "cumulativeReferenceMeanContrast") {
        return row.referenceMeanContrast;
    }
    if (profile === "cumulativeReferenceVote") return row.referenceVoteCumulative;
    if (profile === "cumulativeReferenceVoteCusum") return row.referenceVoteCusum;
    if (profile === "cumulativeReferenceVoteContrast") {
        return row.referenceVoteContrast;
    }
    return 0;
};

const candidateSupport = (
    years: number[],
    ranks: Map<ProfileName, number[]>,
    candidate: InternalWindow,
    member: CandidateMember,
): number => {
    const rows = years.map((year, index) => ({
        year,
        value: ranks.get(member.profile)?.[index] ?? 0,
    }));
    const inside = rows.filter((row) => (
        row.year >= candidate.startYear && row.year <= candidate.endYear
    ));
    const outside = rows.filter((row) => (
        row.year < candidate.startYear || row.year > candidate.endYear
    ));
    const mean = (items: ProfileRow[]) => items.reduce(
        (sum, row) => sum + row.value,
        0,
    ) / Math.max(1, items.length);
    if (member.statistic === "max") {
        return Math.max(0, ...inside.map((row) => row.value));
    }
    if (member.statistic === "contrast") return mean(inside) - mean(outside);
    if (member.statistic === "center") {
        const center = (candidate.startYear + candidate.endYear) / 2;
        return rows.reduce((best, row) => (
            Math.abs(row.year - center) < Math.abs(best.year - center)
                ? row
                : best
        ), rows[0])?.value ?? 0;
    }
    return mean(inside);
};

const coarseMembersFor = (event: DiagnosisEvent): CandidateMember[] => {
    if (event.eventType === "missingRing") {
        return [
            { profile: "cumulativeReferenceMean", statistic: "mean" },
            { profile: "cumulativeReferenceVote", statistic: "center" },
        ];
    }
    if (event.eventType === "falseRing") {
        return [
            { profile: "differenceFull", statistic: "contrast" },
            { profile: "piecewiseCombinedObjective", statistic: "max" },
            { profile: "cumulativeDifference", statistic: "center" },
        ];
    }
    return [
        { profile: "differenceFull", statistic: "center" },
        { profile: "comboFull", statistic: "center" },
        { profile: "transitionSplitGain", statistic: "center" },
        { profile: "cumulativeReferenceMedian", statistic: "mean" },
    ];
};

export const refineEventWithCounterfactualLocator = (
    event: DiagnosisEvent,
    diagnosis: SeriesCoreDiagnosis,
    cofechaDiagnosis: SeriesCoreDiagnosis,
    siteData: RwlSiteData,
    eventPathConfig: Partial<EventPathConfig>,
    pathCache?: LagPathCache,
    fixedSideBaselineLag = 0,
): CounterfactualEventLocatorResult | null => {
    const correctionYears = correctionFor(event);
    if (correctionYears === null) return null;
    const publicYear = (year: number): number => (
        event.eventType === "partialMove"
            ? firstFixedYearFromLastMovedYear(year)
            : year
    );
    const edgeYears = 15;
    const years = [...diagnosis.rawTarget.keys()]
        .filter((year) => (
            year >= diagnosis.targetRange.startYear + edgeYears
            && year <= diagnosis.targetRange.endYear - edgeYears
        ))
        .sort((left, right) => left - right);
    if (years.length < 25) return null;

    const cumulativeRows = scoreCumulativeLagChangePoints(
        diagnosis,
        cofechaDiagnosis,
        { lags: [correctionYears], siteData },
    ).filter((row) => row.olderLag === correctionYears);
    const cumulativeProfiles: ProfileName[] = [
        "cumulativeCombined",
        "cumulativeCombinedCusum",
        "cumulativeCombinedContrast",
        "cumulativeDifference",
        "cumulativeDifferenceCusum",
        "cumulativeDifferenceContrast",
        "cumulativeRawCusum",
        "cumulativeRawContrast",
        "cumulativeWhitenedCusum",
        "cumulativeWhitenedContrast",
        "cumulativeCofechaCusum",
        "cumulativeCofechaContrast",
        "cumulativeLocal31",
        "cumulativeLocal61",
        "cumulativeReferenceMedian",
        "cumulativeReferenceMedianCusum",
        "cumulativeReferenceMedianContrast",
        "cumulativeReferenceMean",
        "cumulativeReferenceMeanCusum",
        "cumulativeReferenceMeanContrast",
        "cumulativeReferenceVote",
        "cumulativeReferenceVoteCusum",
        "cumulativeReferenceVoteContrast",
    ];
    const values = new Map<ProfileName, Map<number, number>>();
    cumulativeProfiles.forEach((profile) => {
        values.set(
            profile,
            new Map(cumulativeRows.map((row) => [
                publicYear(row.year),
                valueForCumulative(row, profile),
            ])),
        );
    });

    const piecewiseRows = scorePiecewiseChangePoints(
        diagnosis,
        cofechaDiagnosis,
        { lags: [correctionYears] },
    ).filter((row) => row.olderLag === correctionYears);
    values.set(
        "piecewiseCombinedObjective",
        new Map(piecewiseRows.map((row) => [
            publicYear(row.year),
            row.combinedObjective,
        ])),
    );

    const transition = scoreLagTransitionHypotheses(
        cofechaDiagnosis,
        siteData,
        eventPathConfig,
        pathCache,
    );
    const transitionRows = transition.hypotheses.find(
        (hypothesis) => hypothesis.correctionYears === correctionYears,
    )?.rows ?? [];
    values.set(
        "transitionSplitGain",
        new Map(transitionRows.map((row) => [
            publicYear(row.year),
            row.splitGain,
        ])),
    );

    const jointOperations = getJointCounterfactualOperationScores(
        diagnosis,
        edgeYears,
        eventPathConfig.maxPartialGapYears,
        fixedSideBaselineLag,
    );
    const selectedOperation = jointOperations.find(
        (operation) => operation.shiftYears === correctionYears,
    );
    const alternativeDifferenceByYear = new Map<number, number>();
    jointOperations
        .filter((operation) => operation.shiftYears !== correctionYears)
        .forEach((operation) => operation.rows.forEach((row) => {
            alternativeDifferenceByYear.set(
                row.year,
                Math.max(
                    alternativeDifferenceByYear.get(row.year) ?? -Infinity,
                    row.differenceGain,
                ),
            );
        }));
    values.set(
        "rawFull",
        new Map(selectedOperation?.rows.map(
            (row) => [row.year, row.rawCorrelation],
        ) ?? []),
    );
    values.set(
        "differenceFull",
        new Map(selectedOperation?.rows.map(
            (row) => [row.year, row.differenceCorrelation],
        ) ?? []),
    );
    values.set(
        "comboFull",
        new Map(selectedOperation?.rows.map(
            (row) => [row.year, row.combinedCorrelation],
        ) ?? []),
    );
    const whitenedDiagnosis: SeriesCoreDiagnosis = {
        ...diagnosis,
        rawTarget: ar1WhitenSeries(diagnosis.rawTarget),
    };
    const whitenedRows = selectedOperation
        ? scoreFullIntervalShiftEvidence(
            whitenedDiagnosis,
            correctionYears,
            edgeYears,
            ar1WhitenSeries(diagnosis.master.data),
            selectedOperation.baselineLag,
        )
        : [];
    values.set(
        "whitenedFull",
        new Map(whitenedRows.map((row) => [
            publicYear(row.year),
            row.rawCorrelation,
        ])),
    );
    values.set(
        "jointOperationMargin",
        new Map(selectedOperation?.rows.map((row) => [
            row.year,
            row.differenceGain
                - (alternativeDifferenceByYear.get(row.year) ?? row.differenceGain),
        ]) ?? []),
    );
    values.set(
        "sideStepScore",
        new Map(selectedOperation?.rows.map((row) => [
            row.year,
            row.sideStepScore,
        ]) ?? []),
    );
    values.set(
        "sideMinimumAdvantage",
        new Map(selectedOperation?.rows.map((row) => [
            row.year,
            row.sideMinimumAdvantage,
        ]) ?? []),
    );
    values.set(
        "correctedSideSupport",
        new Map(selectedOperation?.rows.map((row) => [
            row.year,
            row.correctedSideSupport,
        ]) ?? []),
    );
    if (event.eventType === "partialMove") {
        const boundaryRows = scoreNegativePartialMoveBoundaries(
            diagnosis,
            correctionYears,
        );
        ([
            "raw31",
            "difference31",
            "whitened31",
            "combo31",
            "combo41",
            "combo61",
            "multiScale",
        ] as const).forEach((profile) => {
            values.set(
                `partialBoundary:${profile}`,
                new Map(boundaryRows.map((row) => [
                    row.year,
                    row[profile],
                ])),
            );
        });
        const boundaryLocalRows = scoreBoundaryLocalCounterfactual(
            diagnosis,
            correctionYears,
        );
        ([
            "olderAdvantage3",
            "newerAdvantage3",
            "stepMinimum3",
            "stepMean3",
            "olderAdvantage5",
            "newerAdvantage5",
            "stepMinimum5",
            "stepMean5",
            "olderAdvantage9",
            "newerAdvantage9",
            "stepMinimum9",
            "stepMean9",
        ] as const).forEach((profile) => {
            values.set(
                `boundaryLocal:${profile}`,
                new Map(boundaryLocalRows.map((row) => [
                    row.year,
                    row[profile],
                ])),
            );
        });
    }

    const pairRows = scorePerReferenceCounterfactualEvidence(
        diagnosis,
        siteData,
        correctionYears,
        {
            edgeYears,
            baselineLagCenter: selectedOperation?.baselineLag ?? 0,
        },
    );
    values.set(
        "pairDifferenceWeighted",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.differenceWeighted,
        ])),
    );
    values.set(
        "pairWhitenedMean",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.whitenedMean,
        ])),
    );
    values.set(
        "pairPeakKernel5",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.peakKernel5,
        ])),
    );
    values.set(
        "pairPeakKernel9",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.peakKernel9,
        ])),
    );
    const referenceRows = scoreReferenceTransitionConsensus(
        cofechaDiagnosis,
        siteData,
        { correctionYears: [correctionYears] },
    );
    REFERENCE_WINDOW_FEATURES.forEach((feature) => {
        values.set(
            `reference:${feature}`,
            new Map(referenceRows.map((row) => [
                publicYear(row.year),
                row[feature],
            ])),
        );
    });

    const ranks = new Map<ProfileName, number[]>();
    values.forEach((profile, name) => {
        ranks.set(
            name,
            percentileRanks(years.map((year) => profile.get(year) ?? 0)),
        );
    });

    const minimumYear = diagnosis.targetRange.startYear;
    const maximumYear = diagnosis.targetRange.endYear;
    const baseProfile = event.eventType === "missingRing"
        ? "cumulativeCombined"
        : event.eventType === "falseRing"
            ? "differenceFull"
            : "cumulativeReferenceMean";
    const baseWindow = bestMassWindow(
        years.map((year, index) => ({
            year,
            value: ranks.get(baseProfile)?.[index] ?? 0,
        })),
        25,
        minimumYear,
        maximumYear,
    );
    if (!baseWindow) return null;
    const internalCandidates: InternalWindow[] = [{
        ...baseWindow,
        source: `profile:${baseProfile}`,
    }];
    if (selectedOperation) {
        internalCandidates.push({
            ...boundedWindow(
                selectedOperation.bestYear - 12,
                25,
                minimumYear,
                maximumYear,
            ),
            source: "joint_counterfactual_operation",
        });
    }
    if (transitionRows.length > 0) {
        const transitionMass = robustPositive(
            transitionRows.map((row) => row.splitGain),
        );
        const window = bestMassWindow(
            transitionRows.map((row, index) => ({
                year: publicYear(row.year),
                value: transitionMass[index],
            })),
            25,
            minimumYear,
            maximumYear,
        );
        if (window) internalCandidates.push({ ...window, source: "lag_transition" });
    }
    REFERENCE_WINDOW_FEATURES.forEach((feature) => {
        const window = bestMassWindow(
            referenceRows.map((row) => ({
                year: publicYear(row.year),
                value: row[feature],
            })),
            25,
            minimumYear,
            maximumYear,
        );
        if (window) {
            internalCandidates.push({
                ...window,
                source: `reference_transition:${feature}`,
            });
        }
    });
    const currentPrimaryYear = event.rankedYears
        .slice()
        .sort((left, right) => left.rank - right.rank)[0]?.year;
    if (currentPrimaryYear !== undefined) {
        internalCandidates.push({
            ...boundedWindow(
                currentPrimaryYear - 12,
                25,
                minimumYear,
                maximumYear,
            ),
            source: "current_event",
        });
    }
    const uniqueCandidates = [...new Map(internalCandidates.map((candidate) => [
        `${candidate.startYear}:${candidate.endYear}`,
        candidate,
    ])).values()];
    const coarseMembers = coarseMembersFor(event);
    const aggregate = new Array(uniqueCandidates.length).fill(0);
    coarseMembers.forEach((member) => {
        const memberRanks = percentileRanks(uniqueCandidates.map((candidate) => (
            candidateSupport(years, ranks, candidate, member)
        )));
        memberRanks.forEach((rank, index) => {
            aggregate[index] += rank / coarseMembers.length;
        });
    });
    const coarseSelection = selectCounterfactualCoarseCandidateIndex(
        uniqueCandidates,
        aggregate,
        event.eventType === "partialMove" ? 1 / 3 : 0,
    );
    const rankerCandidates = uniqueCandidates.map((candidate, index) => ({
        ...candidate,
        aggregateScore: aggregate[index] ?? 0,
        overlapConsensus:
            coarseSelection.overlapConsensus[index] ?? 0,
    }));
    const unitEventType = (
        event.eventType === "missingRing"
        || event.eventType === "falseRing"
    ) ? event.eventType : null;
    const densitySelectedIndex = event.eventType === "falseRing"
        ? selectFalseRingCoarseCandidateIndex(uniqueCandidates)
        : coarseSelection.index;
    const candidateTopYear = Number(event.evidence.notes.find((note) => (
        note.startsWith("candidate_top_year=")
    ))?.slice("candidate_top_year=".length));
    const candidateTopMargin = Number(event.evidence.notes.find((note) => (
        note.startsWith("candidate_top_margin=")
    ))?.slice("candidate_top_margin=".length));
    const ruleSelectedIndex = event.eventType === "falseRing"
        ? selectCorroboratedFalseRingCurrentCandidateIndex({
                candidates: uniqueCandidates,
                selectedIndex: densitySelectedIndex,
                currentPrimaryYear,
                ...(Number.isFinite(candidateTopYear)
                    ? { candidateTopYear }
                    : {}),
                ...(Number.isFinite(candidateTopMargin)
                    ? { candidateTopMargin }
                    : {}),
            })
        : densitySelectedIndex;
    const learnedCoarseSelection = unitEventType
        ? selectUnitEventCoarseWindow({
                eventType: unitEventType,
                years,
                ranks,
                candidates: rankerCandidates,
                currentPrimaryYear,
                ...(selectedOperation ? {
                    operationEvidence: {
                        bestYear: selectedOperation.bestYear,
                        sideStepBestYear: selectedOperation.sideStepBestYear,
                    },
                } : {}),
            })
        : null;
    const selectedIndex = learnedCoarseSelection?.index ?? ruleSelectedIndex;
    const corroboratedFalseRingModeCenterYear = (
        !learnedCoarseSelection
        &&
        event.eventType === "falseRing"
        && selectedIndex !== densitySelectedIndex
        && currentPrimaryYear !== undefined
        && Number.isFinite(candidateTopYear)
    )
        ? currentPrimaryYear
        : undefined;
    const aggregateSelected = uniqueCandidates[selectedIndex];
    const operationAlignedCandidate = !learnedCoarseSelection && (
        event.eventType === "missingRing"
        || event.eventType === "falseRing"
    )
        && selectedOperation
        && currentPrimaryYear !== undefined
        && Math.abs(
            selectedOperation.bestYear - currentPrimaryYear,
        ) <= 1
        && (
            !windowContainsYear(
                aggregateSelected,
                selectedOperation.bestYear,
            )
            || !windowContainsYear(
                aggregateSelected,
                currentPrimaryYear,
            )
        )
        ? uniqueCandidates.find(
            (candidate) => (
                candidate.source === "joint_counterfactual_operation"
            ),
        )
        : undefined;
    const selected = operationAlignedCandidate
        ?? (
            event.eventType === "partialMove"
            && (selectedOperation?.topThreeDifferenceGain ?? 0) < 0
                ? uniqueCandidates.find(
                    (candidate) => candidate.source === "current_event",
                ) ?? aggregateSelected
                : aggregateSelected
        );
    const expansion = event.eventType === "falseRing"
        ? 2
        : event.eventType === "partialMove"
            ? 2
            : 0;
    const selectedCoarseWindow = boundedWindow(
        selected.startYear - expansion,
        25 + expansion * 2,
        minimumYear,
        maximumYear,
    );
    const lagTransitionCandidate = event.eventType === "missingRing"
        ? uniqueCandidates.find((candidate) => (
                candidate.source === "lag_transition"
            ))
        : undefined;
    const lagOverlapYears = lagTransitionCandidate
        ? Math.max(
                0,
                Math.min(
                    selectedCoarseWindow.endYear,
                    lagTransitionCandidate.endYear,
                )
                    - Math.max(
                            selectedCoarseWindow.startYear,
                            lagTransitionCandidate.startYear,
                        )
                    + 1,
            )
        : 0;
    const lagUnionStart = Math.max(
        minimumYear,
        Math.min(
            selectedCoarseWindow.startYear,
            lagTransitionCandidate?.startYear
                ?? selectedCoarseWindow.startYear,
        ),
    );
    const lagUnionEnd = Math.min(
        maximumYear,
        Math.max(
            selectedCoarseWindow.endYear,
            lagTransitionCandidate?.endYear
                ?? selectedCoarseWindow.endYear,
        ),
    );
    const coarseWindow = (
        lagTransitionCandidate
        && lagOverlapYears >= 5
        && lagUnionEnd - lagUnionStart + 1 <= 45
    )
        ? { startYear: lagUnionStart, endYear: lagUnionEnd }
        : selectedCoarseWindow;
    if (event.eventType === "wholeSeriesMove") return null;
    const missingCounterfactualRows = unitEventType === "missingRing"
        ? scoreMissingRingCoarseCounterfactual(
                diagnosis,
                siteData,
                coarseWindow,
            )
        : undefined;
    const falseCounterfactualRows = unitEventType === "falseRing"
        ? scoreFalseRingCoarseCounterfactual(
                diagnosis,
                siteData,
                coarseWindow,
            )
        : undefined;
    const learnedUnitWindow = unitEventType
        ? rankUnitEventWindows({
                eventType: unitEventType,
                years,
                ranks,
                internalCandidates: rankerCandidates,
                currentPrimaryYear,
                coarseWindow,
                ...(corroboratedFalseRingModeCenterYear === undefined
                    ? {}
                    : { corroboratedFalseRingModeCenterYear }),
                missingCounterfactualRows,
                falseCounterfactualRows,
                ...(selectedOperation ? {
                    operationEvidence: {
                        bestYear: selectedOperation.bestYear,
                        bestRawGain: selectedOperation.bestRawGain,
                        bestDifferenceGain:
                            selectedOperation.bestDifferenceGain,
                        bestCombinedGain:
                            selectedOperation.bestCombinedGain,
                        topThreeDifferenceGain:
                            selectedOperation.topThreeDifferenceGain,
                        remoteDifferenceMargin:
                            selectedOperation.remoteDifferenceMargin,
                        sideStepBestYear:
                            selectedOperation.sideStepBestYear,
                        bestSideStepScore:
                            selectedOperation.bestSideStepScore,
                        topThreeSideStepScore:
                            selectedOperation.topThreeSideStepScore,
                        bestSideMinimumAdvantage:
                            selectedOperation.bestSideMinimumAdvantage,
                        bestCorrectedSideSupport:
                            selectedOperation.bestCorrectedSideSupport,
                        sideStepRemoteMargin:
                            selectedOperation.sideStepRemoteMargin,
                    },
                } : {}),
            })
        : null;
    const collectCandidateCounterfactuals = Boolean(
        unitEventType
        && auditOptions.includeCoarseCandidateCounterfactuals,
    );
    const unitCandidateCounterfactualContexts = collectCandidateCounterfactuals
        ? rankerCandidates.map((candidate, candidateIndex) => {
                const scoreWindow = boundedWindow(
                    candidate.startYear - expansion,
                    25 + expansion * 2,
                    minimumYear,
                    maximumYear,
                );
                const rows = unitEventType === "missingRing"
                    ? scoreMissingRingCoarseCounterfactual(
                            diagnosis,
                            siteData,
                            scoreWindow,
                        )
                    : scoreFalseRingCoarseCounterfactual(
                            diagnosis,
                            siteData,
                            scoreWindow,
                        );
                return {
                    candidateIndex,
                    source: candidate.source,
                    scoreWindow,
                    rows: rows.map((row) => ({
                        year: row.year,
                        profiles: Object.fromEntries(
                            Object.entries(row.profiles),
                        ),
                    })),
                };
            })
        : undefined;
    const independentCalibratedWindow = selectCalibratedEventWindow({
                eventType: event.eventType,
                years,
                ranks: ranks as ReadonlyMap<string, readonly number[]>,
                coarseWindow,
                internalCandidates: uniqueCandidates,
                currentPrimaryYear,
                ...(selectedOperation ? {
                    operationEvidence: {
                        bestYear: selectedOperation.bestYear,
                        remoteDifferenceMargin:
                            selectedOperation.remoteDifferenceMargin,
                        sideStepBestYear:
                            selectedOperation.sideStepBestYear,
                        sideStepRemoteMargin:
                            selectedOperation.sideStepRemoteMargin,
                    },
                } : {}),
                ...(event.eventType === "partialMove"
                    && fixedSideBaselineLag !== 0
                    && selectedOperation
                    && selectedOperation.topThreeDifferenceGain >= 0.2
                    && selectedOperation.remoteDifferenceMargin >= 0.01
                    ? { decisiveYear: selectedOperation.bestYear }
                    : {}),
            });
    const shortUnitWindow = (
        unitEventType
        && learnedUnitWindow
        && independentCalibratedWindow
    ) ? selectUnitEventShortWindow({
            eventType: unitEventType,
            learnedWindow: learnedUnitWindow,
            independentWindow: independentCalibratedWindow,
            currentPrimaryYear,
            ...(selectedOperation
                ? { operationEvidence: selectedOperation }
                : {}),
        }) : null;
    const calibratedWindow = learnedUnitWindow
        ? null
        : independentCalibratedWindow;
    if (!learnedUnitWindow && !calibratedWindow) return null;
    const finalWindow = shortUnitWindow?.window
        ?? learnedUnitWindow?.window
        ?? calibratedWindow!.window;
    const finalCalibratedWidth = shortUnitWindow?.recommendedWidth
        ?? learnedUnitWindow?.recommendedWidth
        ?? calibratedWindow?.width;
    const finalCalibrationRule = shortUnitWindow
        ? `unit_event_short_window_${shortUnitWindow.rule}`
        : learnedUnitWindow
            ? `unit_event_window_ranker_${learnedUnitWindow.recommendedWidth}`
            : calibratedWindow?.calibrationRule;
    const finalYears = Array.from(
        {
            length:
                finalWindow.endYear - finalWindow.startYear + 1,
        },
        (_, index) => finalWindow.startYear + index,
    );
    const scoreByYear = calibratedWindow?.scoreByYear
        ?? new Map(finalYears.map((year) => [year, 0]));
    const localCorrectionRanking = event.eventType === "missingRing"
        ? scoreUnitEventLocalCorrectionRanks(
            diagnosis,
            event.eventType,
            finalYears,
        )
        : null;
    const exactYearEvidence = (
        event.eventType === "missingRing"
        || event.eventType === "falseRing"
    ) ? scoreUnitEventExactYearEvidence(
            diagnosis,
            siteData,
            event.eventType,
            finalYears,
        ) : null;
    const unitYearRanking = (
        event.eventType === "missingRing"
        || event.eventType === "falseRing"
    ) ? rankUnitEventYears({
            eventType: event.eventType,
            years: finalYears,
            allYears: years,
            ranks,
            ...(currentPrimaryYear === undefined
                ? {}
                : { currentPrimaryYear }),
            ...(selectedOperation ? {
                operationEvidence: {
                    bestYear: selectedOperation.bestYear,
                    sideStepBestYear: selectedOperation.sideStepBestYear,
                },
            } : {}),
            ...(localCorrectionRanking ? { localCorrectionRanking } : {}),
            ...(exactYearEvidence ? { exactYearEvidence } : {}),
        }) : null;
    const rankingScoreByYear = unitYearRanking?.scoreByYear ?? scoreByYear;
    const scoredValues = [...rankingScoreByYear.values()];
    const minimumScore = scoredValues.length > 0
        ? Math.min(...scoredValues)
        : 0;
    const rankedYears: DiagnosisRankedYear[] = Array.from(
        {
            length:
                finalWindow.endYear - finalWindow.startYear + 1,
        },
        (_, index) => {
            const year = finalWindow.startYear + index;
            const isJointBest = event.eventType === "partialMove"
                && selectedOperation?.bestYear === year;
            const jointBestBonus = isJointBest && selectedOperation
                ? Math.max(
                    0,
                    Math.min(
                        0.75,
                        (
                            selectedOperation.remoteDifferenceMargin - 0.015
                        ) / 0.055 * 0.75,
                    ),
                )
                : 0;
            return {
                year,
                rank: 0,
                score:
                    (rankingScoreByYear.get(year) ?? minimumScore - 1)
                    + jointBestBonus,
                evidenceTags: [
                    "full_interval_counterfactual_locator",
                    ...(unitYearRanking
                        ? ["unit_event_year_consensus"]
                        : []),
                    ...(isJointBest
                        ? ["joint_operation_best_year"]
                        : []),
                ],
            };
        },
    )
        .sort((left, right) => right.score - left.score || right.year - left.year)
        .map((row, index) => ({ ...row, rank: index + 1 }));
    auditObserver?.({
        eventType: event.eventType,
        correctionYears,
        years: [...years],
        profileNames: [...ranks.keys()],
        ranks: Object.fromEntries(
            [...ranks.entries()].map(([name, profile]) => [name, [...profile]]),
        ),
        ...(
            missingCounterfactualRows ?? falseCounterfactualRows
                ? {
                        unitCounterfactualRows: (
                            missingCounterfactualRows
                            ?? falseCounterfactualRows
                            ?? []
                        ).map((row) => ({
                            year: row.year,
                            profiles: Object.fromEntries(
                                Object.entries(row.profiles),
                            ),
                        })),
                    }
                : {}
        ),
        candidates: rankerCandidates,
        coarseDensitySelectedIndex: densitySelectedIndex,
        coarseRuleSelectedIndex: ruleSelectedIndex,
        coarseSelectedIndex: selectedIndex,
        ...(learnedCoarseSelection ? {
            coarseModelSelectedIndex: learnedCoarseSelection.index,
            coarseModelScore: learnedCoarseSelection.score,
            coarseModelMargin: learnedCoarseSelection.margin,
            coarseModelScores: learnedCoarseSelection.scoredCandidates.map(
                (candidate) => ({ ...candidate }),
            ),
        } : {}),
        ...(auditOptions.includeCoarseCandidateCounterfactuals
            && unitCandidateCounterfactualContexts
            ? {
                    coarseCandidateCounterfactuals:
                        unitCandidateCounterfactualContexts,
                }
            : {}),
        coarseWindow,
        coarseSource: selected.source,
        finalWindow,
        calibratedWidth: finalCalibratedWidth,
        calibrationRule: finalCalibrationRule,
        modeWindow: learnedUnitWindow?.modeWindow
            ?? calibratedWindow?.modeWindow,
        ...(learnedUnitWindow ? {
            learnedWindow: learnedUnitWindow.window,
            prePointModeWindow: learnedUnitWindow.prePointModeWindow,
            preFalseCurrentAnchorModeWindow:
                learnedUnitWindow.preFalseCurrentAnchorModeWindow,
            preDirectModeWindow: learnedUnitWindow.preDirectModeWindow,
            learnedRecommendedWidth: learnedUnitWindow.recommendedWidth,
            windowCenteringRule: learnedUnitWindow.windowCenteringRule,
            widthSelectionRule: learnedUnitWindow.widthSelectionRule,
            widthFallbackRule: learnedUnitWindow.widthFallbackRule,
            learnedWindowScore: learnedUnitWindow.score,
            learnedWindowMargin: learnedUnitWindow.margin,
            learnedWindowRemoteMargin: learnedUnitWindow.remoteMargin,
            nineYearSafety: learnedUnitWindow.nineYearSafety,
            nineYearSafetyThreshold:
                learnedUnitWindow.widthThreshold,
        } : {}),
        ...(currentPrimaryYear === undefined ? {} : { currentPrimaryYear }),
        currentWindow: {
            startYear: event.startYear,
            endYear: event.endYear,
        },
        selectedOperation: selectedOperation ? {
            bestYear: selectedOperation.bestYear,
            bestRawGain: selectedOperation.bestRawGain,
            bestDifferenceGain: selectedOperation.bestDifferenceGain,
            bestCombinedGain: selectedOperation.bestCombinedGain,
            topThreeDifferenceGain: selectedOperation.topThreeDifferenceGain,
            remoteDifferenceMargin: selectedOperation.remoteDifferenceMargin,
            sideStepBestYear: selectedOperation.sideStepBestYear,
            bestSideStepScore: selectedOperation.bestSideStepScore,
            topThreeSideStepScore:
                selectedOperation.topThreeSideStepScore,
            bestSideMinimumAdvantage:
                selectedOperation.bestSideMinimumAdvantage,
            bestCorrectedSideSupport:
                selectedOperation.bestCorrectedSideSupport,
            sideStepRemoteMargin:
                selectedOperation.sideStepRemoteMargin,
        } : null,
    });
    const reviewCoreStart = Math.max(event.startYear, finalWindow.startYear);
    const reviewCoreEnd = Math.min(event.endYear, finalWindow.endYear);
    return {
        correctionYears,
        coarseWindow,
        coarseSource: selected.source,
        internalCandidateCount: uniqueCandidates.length,
        event: {
            ...event,
            ...finalWindow,
            rankedYears,
            reviewCoreRange: reviewCoreStart <= reviewCoreEnd
                ? { startYear: reviewCoreStart, endYear: reviewCoreEnd }
                : undefined,
            evidence: {
                ...event.evidence,
                algorithmSources: Array.from(new Set([
                    ...event.evidence.algorithmSources,
                    "full_interval_counterfactual_locator",
                ])).sort(),
                notes: [
                    ...event.evidence.notes,
                    `counterfactual_correction_years=${correctionYears}`,
                    `counterfactual_coarse_window=${coarseWindow.startYear}-${coarseWindow.endYear}`,
                    `counterfactual_coarse_source=${selected.source}`,
                    `counterfactual_coarse_current_candidate_consensus=${
                        corroboratedFalseRingModeCenterYear !== undefined
                    }`,
                    `counterfactual_coarse_overlap_consensus=${
                        (
                            coarseSelection.overlapConsensus[selectedIndex]
                            ?? 0
                        ).toFixed(6)
                    }`,
                    `counterfactual_coarse_model_applied=${
                        learnedCoarseSelection !== null
                    }`,
                    ...(learnedCoarseSelection ? [
                        `counterfactual_coarse_model_score=${
                            learnedCoarseSelection.score.toFixed(6)
                        }`,
                        `counterfactual_coarse_model_margin=${
                            learnedCoarseSelection.margin.toFixed(6)
                        }`,
                    ] : []),
                    `counterfactual_internal_candidates=${uniqueCandidates.length}`,
                    `counterfactual_main_window=${finalWindow.startYear}-${finalWindow.endYear}`,
                    `counterfactual_main_window_width=${
                        finalWindow.endYear - finalWindow.startYear + 1
                    }`,
                    `counterfactual_mode_window=${
                        (
                            learnedUnitWindow?.modeWindow
                            ?? calibratedWindow!.modeWindow
                        ).startYear
                    }-${
                        (
                            learnedUnitWindow?.modeWindow
                            ?? calibratedWindow!.modeWindow
                        ).endYear
                    }`,
                    `counterfactual_window_calibration_rule=${
                        finalCalibrationRule
                    }`,
                    `counterfactual_window_profiles=${
                        learnedUnitWindow
                            ? "unit_event_window_ranker_v1"
                            : calibratedWindow!.profileNames.join(",")
                    }`,
                    ...(learnedUnitWindow ? [
                        `counterfactual_window_centering_rule=${
                            learnedUnitWindow.windowCenteringRule
                        }`,
                        `counterfactual_width_fallback_rule=${
                            learnedUnitWindow.widthFallbackRule
                        }`,
                        `counterfactual_width_selection_rule=${
                            learnedUnitWindow.widthSelectionRule
                        }`,
                        `counterfactual_window_rank_score=${
                            learnedUnitWindow.score.toFixed(6)
                        }`,
                        `counterfactual_window_rank_margin=${
                            learnedUnitWindow.margin.toFixed(6)
                        }`,
                        `counterfactual_window_rank_remote_margin=${
                            learnedUnitWindow.remoteMargin.toFixed(6)
                        }`,
                        `counterfactual_nine_year_safety=${
                            learnedUnitWindow.nineYearSafety.toFixed(6)
                        }`,
                        `counterfactual_nine_year_threshold=${
                            learnedUnitWindow.widthThreshold.toFixed(6)
                        }`,
                    ] : []),
                    ...(shortUnitWindow ? [
                        `counterfactual_short_window_rule=${
                            shortUnitWindow.rule
                        }`,
                        `counterfactual_short_window_independent_rule=${
                            independentCalibratedWindow!.calibrationRule
                        }`,
                    ] : []),
                    ...(unitYearRanking ? [
                        `counterfactual_ranking_profiles=${
                            unitYearRanking.profileNames.join(",")
                        }`,
                    ] : []),
                    `counterfactual_window_concentration=${
                        (
                            learnedUnitWindow?.nineYearSafety
                            ?? calibratedWindow!.concentration
                        ).toFixed(6)
                    }`,
                    `counterfactual_window_remote_margin=${
                        (
                            learnedUnitWindow?.remoteMargin
                            ?? calibratedWindow!.remoteMargin
                        ).toFixed(6)
                    }`,
                    `counterfactual_pair_reference_count=${
                        Math.max(0, ...pairRows.map((row) => row.referenceCount))
                    }`,
                ],
            },
        },
    };
};

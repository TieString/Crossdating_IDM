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
import {
    selectFalseRingDirectConsensusRecenter,
    selectFalseRingMergeOlderRecenter,
} from "./falseRingPhysicalRecenter";
import { scoreMissingRingCoarseCounterfactual } from "./missingRingCoarseCounterfactual";
import {
    selectMissingRingPhysicalRecenter,
    type MissingRingPhysicalRecenterRule,
} from "./missingRingPhysicalRecenter";
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
    | "localSideOlderAdvantage11"
    | "localSideNewerAdvantage11"
    | "localSideStepScore11"
    | "localSideOlderAdvantage21"
    | "localSideNewerAdvantage21"
    | "localSideStepScore21"
    | "localSideOlderAdvantage31"
    | "localSideNewerAdvantage31"
    | "localSideStepScore31"
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
    | "pairDifferenceGainWeighted"
    | "pairWhitenedMean"
    | "pairPositiveSideStepFraction"
    | "pairPeakKernel5"
    | "pairPeakKernel9"
    | "pairLagStepWeighted"
    | "pairLagStepMedian"
    | "pairLagStepPositiveFraction"
    | "pairLagStepPeakKernel5"
    | "pairLagStepPeakKernel9"
    | "pairFixedLagStepWeighted"
    | "pairFixedLagStepMedian"
    | "pairFixedLagStepPositiveFraction"
    | "pairFixedLagStepPeakKernel5"
    | "pairFixedLagStepPeakKernel9"
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
    unitExactYearProfiles?: Record<string, number[]>;
    unitLocalCorrectionRanks?: number[];
    unitFinalYearScores?: number[];
    unitPreEventPolicyScores?: number[];
    unitYearRankingProfileNames?: string[];
    candidates: Array<InternalWindow & {
        aggregateScore: number;
        overlapConsensus: number;
    }>;
    coarseDensitySelectedIndex: number;
    coarseRuleSelectedIndex: number;
    coarseSelectedIndex: number;
    coarseModelSelectedIndex?: number;
    coarseRecoveryRule?: "missing_remote_side_consensus";
    coarseModelScore?: number;
    coarseModelMargin?: number;
    coarseModelScores?: Array<{ index: number; score: number }>;
    missingPhysicalRecenterRule?: MissingRingPhysicalRecenterRule;
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

export type LocalConsensusBoundaryShift = {
    window: { startYear: number; endYear: number };
    centerYear: number;
    supportCount: number;
    shiftYears: number;
};

export const selectLocalConsensusBoundaryShift = (input: {
    window: { startYear: number; endYear: number };
    evidenceYears: Array<number | null | undefined>;
    anchorYear?: number;
    minimumYear: number;
    maximumYear: number;
}): LocalConsensusBoundaryShift | null => {
    const evidenceYears = input.evidenceYears.filter(
        (year): year is number => Number.isInteger(year),
    );
    if (evidenceYears.length < 3) return null;
    // Calendar-year hypotheses are discrete. The lower median also counters the
    // measured tendency for unit-event windows to drift toward newer years.
    const centerYear = Math.floor(median(evidenceYears));
    const supportCount = evidenceYears.filter(
        (year) => Math.abs(year - centerYear) <= 5,
    ).length;
    if (supportCount < 3) return null;
    if (
        input.anchorYear !== undefined
        && Math.abs(input.anchorYear - centerYear) > 5
    ) return null;
    const distance = centerYear < input.window.startYear
        ? input.window.startYear - centerYear
        : centerYear > input.window.endYear
            ? centerYear - input.window.endYear
            : 0;
    if (distance < 1 || distance > 6) return null;
    const shiftYears = centerYear < input.window.startYear
        ? -distance
        : distance;
    const width = input.window.endYear - input.window.startYear + 1;
    const window = boundedWindow(
        input.window.startYear + shiftYears,
        width,
        input.minimumYear,
        input.maximumYear,
    );
    if (window.startYear === input.window.startYear) return null;
    return {
        window,
        centerYear,
        supportCount,
        shiftYears: window.startYear - input.window.startYear,
    };
};

const evidenceNoteYear = (
    event: DiagnosisEvent,
    prefix: string,
): number | null => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const year = Number(note?.slice(prefix.length));
    return Number.isInteger(year) ? year : null;
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

const evidenceNoteNumber = (
    event: DiagnosisEvent,
    prefix: string,
): number | undefined => {
    const note = [...event.evidence.notes]
        .reverse()
        .find((value) => value.startsWith(prefix));
    const value = Number(note?.slice(prefix.length));
    return Number.isFinite(value) ? value : undefined;
};

type PartialMoveLocalConsensusRecenter = {
    window: { startYear: number; endYear: number };
    centerYear: number;
    supportCount: number;
    consensusKind: "local_votes" | "multiview_votes" | "reference_core";
    discardedWindow: { startYear: number; endYear: number };
};

/**
 * A diffuse full-interval profile may drift onto the newer-side plateau even when the
 * pre-locator breakpoint, local raw residual, and per-reference votes agree locally.
 * Keep the already calibrated local window only when operation-consistent channels agree,
 * the default 13-year mode retains at most a short tail, and it excludes their center.
 */
export const selectPartialMoveLocalConsensusRecenter = (input: {
    event: DiagnosisEvent;
    correctionYears: number;
    proposedWindow: { startYear: number; endYear: number };
    calibrationRule: string | undefined;
}): PartialMoveLocalConsensusRecenter | null => {
    const { event, correctionYears, proposedWindow } = input;
    if (
        event.eventType !== "partialMove"
        || input.calibrationRule !== "calibrated_default_13"
        || event.shiftYears !== correctionYears
        || event.evidence.lagBefore !== correctionYears
        || event.evidence.lagAfter !== 0
    ) return null;

    const currentWidth = event.endYear - event.startYear + 1;
    if (![5, 7, 9, 13].includes(currentWidth)) return null;
    const overlapYears = Math.max(
        0,
        Math.min(event.endYear, proposedWindow.endYear)
            - Math.max(event.startYear, proposedWindow.startYear)
            + 1,
    );
    if (overlapYears > 3) return null;
    const currentPrimaryYear = event.rankedYears
        .slice()
        .sort((left, right) => left.rank - right.rank)[0]?.year;
    if (currentPrimaryYear === undefined) return null;

    const finish = (
        evidenceAnchors: Array<{ family: string; year: number }>,
        consensusKind: PartialMoveLocalConsensusRecenter["consensusKind"],
        minimumFamilySupport: number,
    ): PartialMoveLocalConsensusRecenter | null => {
        const clusters = evidenceAnchors.map((anchor) => ({
            anchor,
            members: evidenceAnchors.filter((candidate) => (
                Math.abs(candidate.year - anchor.year) <= 3
            )),
        })).sort((left, right) => (
            right.members.length - left.members.length
            || Math.abs(left.anchor.year - currentPrimaryYear)
                - Math.abs(right.anchor.year - currentPrimaryYear)
        ));
        const members = clusters[0]?.members ?? [];
        if (members.length < minimumFamilySupport) return null;
        const evidenceYears = members.map((anchor) => anchor.year);
        if (evidenceYears.some((year) => (
            year < event.startYear - 1 || year > event.endYear + 1
        ))) return null;
        const centerYear = Math.floor(median(evidenceYears));
        if (
            centerYear >= proposedWindow.startYear - 1
            && centerYear <= proposedWindow.endYear + 1
        ) return null;
        return {
            window: { startYear: event.startYear, endYear: event.endYear },
            centerYear,
            supportCount: evidenceYears.length,
            consensusKind,
            discardedWindow: { ...proposedWindow },
        };
    };

    const sources = new Set(event.evidence.algorithmSources);
    const referenceCoreYear = evidenceNoteNumber(event, "reference_vote_year=");
    const referencePartialYear = evidenceNoteNumber(
        event,
        "reference_partialMove_peak_year=",
    );
    const referenceCoreGain = Math.max(
        evidenceNoteNumber(event, "reference_vote_gain=")
            ?? Number.NEGATIVE_INFINITY,
        event.evidence.correlationGain ?? Number.NEGATIVE_INFINITY,
    );
    const referenceCoreMargin = evidenceNoteNumber(
        event,
        "reference_vote_remote_margin=",
    ) ?? Number.NEGATIVE_INFINITY;
    const referencePartialGain = evidenceNoteNumber(
        event,
        "reference_partialMove_peak_gain=",
    ) ?? referenceCoreGain;
    const referenceAlternativeGain = Math.max(
        evidenceNoteNumber(event, "reference_missingRing_peak_gain=")
            ?? Number.NEGATIVE_INFINITY,
        evidenceNoteNumber(event, "reference_falseRing_peak_gain=")
            ?? Number.NEGATIVE_INFINITY,
    );
    if (
        sources.has("reference_core_voting")
        && referenceCoreYear === currentPrimaryYear
        && referencePartialYear === currentPrimaryYear
        && referenceCoreGain >= 0.05
        && (
            referenceCoreMargin >= 0.01
            || referencePartialGain - referenceAlternativeGain >= 0.05
        )
    ) {
        return finish(
            [
                { family: "current", year: currentPrimaryYear },
                { family: "reference_core", year: referenceCoreYear },
                { family: "reference_partial", year: referencePartialYear },
            ],
            "reference_core",
            3,
        );
    }

    const consistentVoteYear = (
        prefix: "partial_reference_vote" | "partial_exhaustive_vote",
    ): number | undefined => {
        const year = evidenceNoteNumber(event, `${prefix}_year=`);
        const shift = evidenceNoteNumber(event, `${prefix}_shift=`);
        const gain = evidenceNoteNumber(event, `${prefix}_gain=`);
        return Number.isInteger(year)
            && shift === correctionYears
            && (gain ?? Number.NEGATIVE_INFINITY) >= 0.05
            ? year
            : undefined;
    };
    const referenceVoteYear = consistentVoteYear("partial_reference_vote");
    const exhaustiveVoteYear = consistentVoteYear("partial_exhaustive_vote");
    const localBoundaryYear = evidenceNoteNumber(event, "local_raw_boundary_year=");
    const localBoundarySupport = evidenceNoteNumber(
        event,
        "local_raw_boundary_support=",
    ) ?? 0;
    const multiviewYear = evidenceNoteNumber(event, "partial_consensus_year=");
    const multiviewSupport = evidenceNoteNumber(
        event,
        "partial_consensus_support=",
    ) ?? 0;
    const localBoundarySupported = sources.has("local_corrected_raw_breakpoint")
        && localBoundaryYear !== undefined
        && localBoundarySupport >= 2;
    const multiviewSupported = sources.has("negative_partial_multiview_consensus")
        && multiviewYear !== undefined
        && multiviewSupport >= 3;
    const boundaryProfileYears = [
        "partial_gap_raw31_year=",
        "partial_gap_difference31_year=",
        "partial_gap_whitened31_year=",
        "partial_gap_combo31_year=",
        "partial_gap_combo41_year=",
        "partial_gap_combo61_year=",
        "partial_gap_multiScale_year=",
    ].flatMap((prefix) => {
        const year = evidenceNoteNumber(event, prefix);
        return year === undefined ? [] : [year];
    });
    const boundaryProfileCenter = boundaryProfileYears.length > 0
        ? Math.floor(median(boundaryProfileYears))
        : undefined;
    const boundaryProfileSupported = boundaryProfileCenter !== undefined
        && boundaryProfileYears.filter((year) => (
            Math.abs(year - boundaryProfileCenter) <= 3
        )).length >= 4;
    if (
        !sources.has("piecewise_lag_path")
        || (!localBoundarySupported
            && !multiviewSupported
            && !boundaryProfileSupported)
    ) return null;

    const evidenceAnchors = [{ family: "current", year: currentPrimaryYear }];
    if (localBoundarySupported) {
        evidenceAnchors.push({ family: "local_raw", year: localBoundaryYear! });
    }
    if (multiviewSupported) {
        evidenceAnchors.push({ family: "multiview", year: multiviewYear! });
    }
    if (boundaryProfileSupported) {
        evidenceAnchors.push({
            family: "boundary_profiles",
            year: boundaryProfileCenter!,
        });
    }
    if (referenceVoteYear !== undefined) {
        evidenceAnchors.push({ family: "reference_vote", year: referenceVoteYear });
    }
    if (exhaustiveVoteYear !== undefined) {
        evidenceAnchors.push({ family: "exhaustive_vote", year: exhaustiveVoteYear });
    }
    return finish(
        evidenceAnchors,
        multiviewSupported ? "multiview_votes" : "local_votes",
        4,
    );
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
    const partialReferenceVoteYear = evidenceNoteNumber(
        event,
        "partial_reference_vote_year=",
    );
    const decisivePartialBoundaryYear = event.eventType === "partialMove"
        && selectedOperation
        && partialReferenceVoteYear === selectedOperation.sideStepBestYear
        && Math.abs(
            selectedOperation.sideStepBestYear - selectedOperation.bestYear,
        ) <= 2
        && selectedOperation.sideStepRemoteMargin >= 0.04
        && selectedOperation.bestSideMinimumAdvantage >= 0.08
        && selectedOperation.bestCorrectedSideSupport >= 0.12
        ? selectedOperation.sideStepBestYear
        : undefined;
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
    ([
        "localSideOlderAdvantage11",
        "localSideNewerAdvantage11",
        "localSideStepScore11",
        "localSideOlderAdvantage21",
        "localSideNewerAdvantage21",
        "localSideStepScore21",
        "localSideOlderAdvantage31",
        "localSideNewerAdvantage31",
        "localSideStepScore31",
    ] as const).forEach((profile) => {
        values.set(
            profile,
            new Map(selectedOperation?.rows.map((row) => [
                row.year,
                row[profile],
            ]) ?? []),
        );
    });
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
        "pairDifferenceGainWeighted",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.differenceGainWeighted,
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
        "pairPositiveSideStepFraction",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.positiveSideStepFraction,
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
    values.set(
        "pairLagStepWeighted",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.lagStepWeighted,
        ])),
    );
    values.set(
        "pairLagStepMedian",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.lagStepMedian,
        ])),
    );
    values.set(
        "pairLagStepPositiveFraction",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.lagStepPositiveFraction,
        ])),
    );
    values.set(
        "pairLagStepPeakKernel5",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.lagStepPeakKernel5,
        ])),
    );
    values.set(
        "pairLagStepPeakKernel9",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.lagStepPeakKernel9,
        ])),
    );
    values.set(
        "pairFixedLagStepWeighted",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.fixedLagStepWeighted,
        ])),
    );
    values.set(
        "pairFixedLagStepMedian",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.fixedLagStepMedian,
        ])),
    );
    values.set(
        "pairFixedLagStepPositiveFraction",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.fixedLagStepPositiveFraction,
        ])),
    );
    values.set(
        "pairFixedLagStepPeakKernel5",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.fixedLagStepPeakKernel5,
        ])),
    );
    values.set(
        "pairFixedLagStepPeakKernel9",
        new Map(pairRows.map((row) => [
            publicYear(row.year),
            row.fixedLagStepPeakKernel9,
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
    const cofechaPartialAnchors = event.evidence.notes
        .find((note) => note.startsWith("partial_candidate_cofecha_anchors="))
        ?.slice("partial_candidate_cofecha_anchors=".length)
        .split(",")
        .filter((token) => token.length > 0)
        .map(Number)
        .filter((year) => Number.isInteger(year)) ?? [];
    const candidateBackedModePriorYear = event.eventType === "partialMove"
        && currentPrimaryYear !== undefined
        && cofechaPartialAnchors.length > 0
        ? Math.round((
            currentPrimaryYear
            + cofechaPartialAnchors.reduce((sum, year) => sum + year, 0)
                / cofechaPartialAnchors.length
        ) / 2)
        : undefined;
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
                        bestDifferenceGain:
                            selectedOperation.bestDifferenceGain,
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
                coarseSource: selected.source,
                ...(learnedCoarseSelection?.recoveryRule ? {
                    coarseRecoveryRule: learnedCoarseSelection.recoveryRule,
                } : {}),
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
                candidateBackedModePriorYear,
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
                ...(decisivePartialBoundaryYear !== undefined
                    ? { decisiveYear: decisivePartialBoundaryYear }
                    : event.eventType === "partialMove"
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
        && (
            independentCalibratedWindow
            || event.evidence.algorithmSources.includes(
                "subtle_false_ring_empty_recovery",
            )
        )
    ) ? selectUnitEventShortWindow({
            eventType: unitEventType,
            learnedWindow: learnedUnitWindow,
            ...(independentCalibratedWindow
                ? { independentWindow: independentCalibratedWindow }
                : {}),
            subtleFalseRingRecovery: event.evidence.algorithmSources.includes(
                "subtle_false_ring_empty_recovery",
            ),
            currentPrimaryYear,
            years,
            ranks: ranks as ReadonlyMap<string, readonly number[]>,
            ...(selectedOperation
                ? { operationEvidence: selectedOperation }
                : {}),
        }) : null;
    const calibratedWindow = learnedUnitWindow
        ? null
        : independentCalibratedWindow;
    if (!learnedUnitWindow && !calibratedWindow) return null;
    let finalWindow = shortUnitWindow?.window
        ?? learnedUnitWindow?.window
        ?? calibratedWindow!.window;
    let finalCalibratedWidth = shortUnitWindow?.recommendedWidth
        ?? learnedUnitWindow?.recommendedWidth
        ?? calibratedWindow?.width;
    const preliminaryCalibrationRule = shortUnitWindow
        ? `unit_event_short_window_${shortUnitWindow.rule}`
        : learnedUnitWindow
            ? `unit_event_window_ranker_${learnedUnitWindow.recommendedWidth}`
            : calibratedWindow?.calibrationRule;
    const missingPhysicalRecenter = unitEventType === "missingRing"
        && missingCounterfactualRows
        && learnedUnitWindow
        ? selectMissingRingPhysicalRecenter({
                years,
                ranks: ranks as ReadonlyMap<string, readonly number[]>,
                currentWindow: finalWindow,
                coarseWindow,
                coarseSource: selected.source,
                candidates: rankerCandidates,
                ...(preliminaryCalibrationRule
                    ? { calibrationRule: preliminaryCalibrationRule }
                    : {}),
                windowCenteringRule:
                    learnedUnitWindow.windowCenteringRule,
                learnedWindowMargin: learnedUnitWindow.margin,
                learnedWindowRemoteMargin: learnedUnitWindow.remoteMargin,
                nineYearSafety: learnedUnitWindow.nineYearSafety,
                nineYearSafetyThreshold: learnedUnitWindow.widthThreshold,
                ...(learnedCoarseSelection
                    ? { coarseModelMargin: learnedCoarseSelection.margin }
                    : {}),
                ...(selectedOperation
                    ? { operationEvidence: selectedOperation }
                    : {}),
                counterfactualRows: missingCounterfactualRows,
            })
        : null;
    if (missingPhysicalRecenter) {
        finalWindow = missingPhysicalRecenter.window;
        finalCalibratedWidth =
            finalWindow.endYear - finalWindow.startYear + 1;
    }
    const physicalFalseRingRecenter = unitEventType === "falseRing"
        && falseCounterfactualRows
        ? selectFalseRingMergeOlderRecenter(
                falseCounterfactualRows,
                finalWindow,
            )
        : null;
    if (physicalFalseRingRecenter) {
        finalWindow = physicalFalseRingRecenter.window;
    }
    const directFalseRingRecenter = unitEventType === "falseRing"
        && falseCounterfactualRows
        && !physicalFalseRingRecenter
        ? selectFalseRingDirectConsensusRecenter(
                falseCounterfactualRows,
                finalWindow,
                [
                    currentPrimaryYear,
                    selectedOperation?.bestYear,
                    selectedOperation?.sideStepBestYear,
                ],
            )
        : null;
    if (directFalseRingRecenter) {
        finalWindow = directFalseRingRecenter.window;
    }
    const partialLocalConsensusRecenter = event.eventType === "partialMove"
        ? selectPartialMoveLocalConsensusRecenter({
                event,
                correctionYears,
                proposedWindow: finalWindow,
                calibrationRule: preliminaryCalibrationRule,
            })
        : null;
    if (partialLocalConsensusRecenter) {
        finalWindow = partialLocalConsensusRecenter.window;
        finalCalibratedWidth = finalWindow.endYear - finalWindow.startYear + 1;
    }
    const localConsensusBoundaryShift = unitEventType
        ? selectLocalConsensusBoundaryShift({
                window: finalWindow,
                evidenceYears: [
                    currentPrimaryYear,
                    evidenceNoteYear(event, "scan_top_year="),
                    evidenceNoteYear(event, "candidate_top_year="),
                    evidenceNoteYear(event, "paired_breakpoint_year="),
                ],
                ...(currentPrimaryYear === undefined
                    ? {}
                    : { anchorYear: currentPrimaryYear }),
                minimumYear,
                maximumYear,
            })
        : null;
    if (localConsensusBoundaryShift) {
        finalWindow = localConsensusBoundaryShift.window;
    }
    const finalCalibrationRule = partialLocalConsensusRecenter
        ? "partial_local_consensus_recenter"
        : missingPhysicalRecenter
            ? `unit_event_missing_${missingPhysicalRecenter.rule}`
            : physicalFalseRingRecenter
            ? "unit_event_false_merge_older_physical_recenter"
            : directFalseRingRecenter
                ? "unit_event_false_direct_consensus_recenter"
                : localConsensusBoundaryShift
                    ? "unit_event_local_consensus_boundary_shift"
                    : preliminaryCalibrationRule;
    const finalYears = Array.from(
        {
            length:
                finalWindow.endYear - finalWindow.startYear + 1,
        },
        (_, index) => finalWindow.startYear + index,
    );
    const usesModeRankingWindow = !localConsensusBoundaryShift
        && !missingPhysicalRecenter
        && !physicalFalseRingRecenter
        && !directFalseRingRecenter && (
        shortUnitWindow?.rule === "missing_concentrated_profile_9"
        || shortUnitWindow?.rule === "false_concentrated_profile_9"
        || shortUnitWindow?.rule === "false_subtle_empty_recovery_9"
    );
    const unitRankingWindow = usesModeRankingWindow
        ? learnedUnitWindow!.modeWindow
        : finalWindow;
    const unitRankingYears = Array.from(
        {
            length:
                unitRankingWindow.endYear - unitRankingWindow.startYear + 1,
        },
        (_, index) => unitRankingWindow.startYear + index,
    );
    const scoreByYear = calibratedWindow?.scoreByYear
        ?? new Map(finalYears.map((year) => [year, 0]));
    const localCorrectionRanking = event.eventType === "missingRing"
        ? scoreUnitEventLocalCorrectionRanks(
            diagnosis,
            event.eventType,
            unitRankingYears,
        )
        : null;
    const exactYearEvidence = (
        event.eventType === "missingRing"
        || event.eventType === "falseRing"
        ) ? scoreUnitEventExactYearEvidence(
            diagnosis,
            siteData,
            event.eventType,
            unitRankingYears,
            auditObserver !== null,
        ) : null;
    const unitYearRanking = (
        event.eventType === "missingRing"
        || event.eventType === "falseRing"
    ) ? rankUnitEventYears({
            eventType: event.eventType,
            years: unitRankingYears,
            fixedWindowYears: finalYears,
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
            ...(falseCounterfactualRows ? { falseCounterfactualRows } : {}),
        }) : null;
    const localPartialScoreByYear = partialLocalConsensusRecenter
        ? new Map(event.rankedYears.map((row) => [row.year, row.score]))
        : null;
    const rankingScoreByYear = unitYearRanking?.scoreByYear
        ?? localPartialScoreByYear
        ?? scoreByYear;
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
            const partialRankingYear = decisivePartialBoundaryYear
                ?? selectedOperation?.bestYear;
            const isJointBest = event.eventType === "partialMove"
                && partialLocalConsensusRecenter === null
                && partialRankingYear === year;
            const rankingRemoteMargin = decisivePartialBoundaryYear !== undefined
                ? selectedOperation?.sideStepRemoteMargin ?? 0
                : selectedOperation?.remoteDifferenceMargin ?? 0;
            const jointBestBonus = isJointBest && selectedOperation
                ? Math.max(
                    0,
                    Math.min(
                        0.75,
                        (
                            rankingRemoteMargin - 0.015
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
                    ...(partialLocalConsensusRecenter
                        ? ["partial_local_consensus_ranking"]
                        : []),
                    ...(isJointBest
                        ? ["joint_operation_best_year"]
                        : []),
                    ...(decisivePartialBoundaryYear === year
                        ? ["partial_side_step_boundary"]
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
        ...(unitYearRanking?.preEventPolicyScoreByYear ? {
            unitPreEventPolicyScores: finalYears.map(
                (year) => unitYearRanking.preEventPolicyScoreByYear?.get(year)
                    ?? 0,
            ),
            unitYearRankingProfileNames: [...unitYearRanking.profileNames],
        } : {}),
        ...(exactYearEvidence?.diagnosticProfiles ? {
            unitExactYearProfiles: Object.fromEntries(
                [...exactYearEvidence.diagnosticProfiles.entries()].map(
                    ([name, scores]) => [
                        name,
                        finalYears.map((year) => scores.get(year) ?? -1),
                    ],
                ),
            ),
        } : {}),
        ...(localCorrectionRanking ? {
            unitLocalCorrectionRanks: finalYears.map(
                (year) => localCorrectionRanking.rankByYear.get(year) ?? 0,
            ),
        } : {}),
        ...(unitYearRanking ? {
            unitFinalYearScores: finalYears.map(
                (year) => unitYearRanking.scoreByYear.get(year) ?? 0,
            ),
        } : {}),
        candidates: rankerCandidates,
        coarseDensitySelectedIndex: densitySelectedIndex,
        coarseRuleSelectedIndex: ruleSelectedIndex,
        coarseSelectedIndex: selectedIndex,
        ...(learnedCoarseSelection ? {
            coarseModelSelectedIndex: learnedCoarseSelection.modelIndex,
            ...(learnedCoarseSelection.recoveryRule ? {
                coarseRecoveryRule: learnedCoarseSelection.recoveryRule,
            } : {}),
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
        ...(missingPhysicalRecenter ? {
            missingPhysicalRecenterRule: missingPhysicalRecenter.rule,
        } : {}),
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
            windowCenteringRule: missingPhysicalRecenter
                ? `missing_physical_recenter_${missingPhysicalRecenter.rule}`
                : physicalFalseRingRecenter
                    ? "false_merge_older_physical_recenter"
                    : directFalseRingRecenter
                        ? "false_direct_consensus_recenter"
                        : learnedUnitWindow.windowCenteringRule,
            widthSelectionRule: missingPhysicalRecenter
                ? `missing_physical_recenter_${missingPhysicalRecenter.rule}`
                : physicalFalseRingRecenter
                    ? "false_merge_older_physical_recenter"
                    : directFalseRingRecenter
                        ? "false_direct_consensus_recenter"
                        : learnedUnitWindow.widthSelectionRule,
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
                    ...(missingPhysicalRecenter
                        ? ["missing_ring_physical_recenter"]
                        : []),
                    ...(physicalFalseRingRecenter
                        ? ["false_ring_merge_older_physical_recenter"]
                        : []),
                    ...(directFalseRingRecenter
                        ? ["false_ring_direct_consensus_recenter"]
                        : []),
                    ...(localConsensusBoundaryShift
                        ? ["local_consensus_boundary_shift"]
                        : []),
                    ...(partialLocalConsensusRecenter
                        ? ["partial_local_consensus_recenter"]
                        : []),
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
                    ...(decisivePartialBoundaryYear === undefined ? [] : [
                        `partial_side_step_decisive_year=${decisivePartialBoundaryYear}`,
                        `partial_side_step_remote_margin=${
                            selectedOperation!.sideStepRemoteMargin.toFixed(6)
                        }`,
                        `partial_side_step_reference_vote_year=${
                            partialReferenceVoteYear
                        }`,
                    ]),
                    `counterfactual_main_window=${finalWindow.startYear}-${finalWindow.endYear}`,
                    `counterfactual_main_window_width=${
                        finalWindow.endYear - finalWindow.startYear + 1
                    }`,
                    ...(missingPhysicalRecenter ? [
                        `missing_physical_recenter_rule=${
                            missingPhysicalRecenter.rule
                        }`,
                        `missing_physical_recenter_support_count=${
                            missingPhysicalRecenter.supportCount
                        }`,
                    ] : []),
                    ...(physicalFalseRingRecenter ? [
                        `false_merge_older_advantage=${
                            physicalFalseRingRecenter.mergeAdvantage.toFixed(6)
                        }`,
                        `false_merge_older_remote_margin=${
                            physicalFalseRingRecenter.remoteMargin.toFixed(6)
                        }`,
                    ] : []),
                    ...(directFalseRingRecenter ? [
                        `false_direct_consensus_candidate_year=${
                            directFalseRingRecenter.candidateYear
                        }`,
                        `false_direct_consensus_count=${
                            directFalseRingRecenter.consensusCount
                        }`,
                        `false_direct_consensus_anchor_count=${
                            directFalseRingRecenter.anchorCount
                        }`,
                        `false_direct_consensus_shift_years=${
                            directFalseRingRecenter.shiftYears
                        }`,
                    ] : []),
                    ...(localConsensusBoundaryShift ? [
                        `local_consensus_boundary_center_year=${
                            localConsensusBoundaryShift.centerYear
                        }`,
                        `local_consensus_boundary_support_count=${
                            localConsensusBoundaryShift.supportCount
                        }`,
                        `local_consensus_boundary_shift_years=${
                            localConsensusBoundaryShift.shiftYears
                        }`,
                    ] : []),
                    ...(partialLocalConsensusRecenter ? [
                        `partial_local_consensus_center_year=${
                            partialLocalConsensusRecenter.centerYear
                        }`,
                        `partial_local_consensus_support_count=${
                            partialLocalConsensusRecenter.supportCount
                        }`,
                        `partial_local_consensus_kind=${
                            partialLocalConsensusRecenter.consensusKind
                        }`,
                        `partial_local_consensus_discarded_window=${
                            partialLocalConsensusRecenter.discardedWindow.startYear
                        }-${
                            partialLocalConsensusRecenter.discardedWindow.endYear
                        }`,
                    ] : []),
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

/**
 * Compares every supported local edit on one full-interval counterfactual scale.
 *
 * Each correction is scanned in linear time. The result remains evidence only: event presence
 * and operation selection apply their own calibrated gates before exposing a suggestion.
 */
import {
    createFullIntervalShiftEvidenceContext,
    scoreFullIntervalBaselineEvidence,
    scoreFullIntervalShiftEvidence,
    type FullIntervalUnitEditEvidenceRow,
} from "./fullIntervalUnitEditEvidence";
import { correlationForSegment } from "./series";
import {
    DEFAULT_MAX_PARTIAL_GAP_YEARS,
    firstFixedYearFromLastMovedYear,
    getAutomaticEventShiftCandidates,
    isNegativePartialShift,
} from "./partialMoveSemantics";
import type { DiagnosisEventType, SeriesCoreDiagnosis } from "./types";

type RecoverableEventType = Exclude<DiagnosisEventType, "wholeSeriesMove">;

export type JointCounterfactualOperationScore = {
    eventType: RecoverableEventType;
    shiftYears: number;
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
    baselineLag: number;
    rows: Array<FullIntervalUnitEditEvidenceRow & {
        rawGain: number;
        differenceGain: number;
        combinedGain: number;
    }>;
};

const CACHE = new WeakMap<
    SeriesCoreDiagnosis,
    Map<string, JointCounterfactualOperationScore[]>
>();

const eventTypeFor = (shiftYears: number): RecoverableEventType | null => (
    shiftYears === -1
        ? "missingRing"
        : shiftYears === 1
            ? "falseRing"
            : isNegativePartialShift(shiftYears)
                ? "partialMove"
                : null
);

const mean = (values: number[]): number => values.reduce(
    (sum, value) => sum + value,
    0,
) / Math.max(1, values.length);

const estimateFixedSideLag = (
    diagnosis: SeriesCoreDiagnosis,
    minimumPairs: number,
): number => {
    const startYear = Math.max(
        diagnosis.targetRange.startYear,
        diagnosis.targetRange.endYear - 47,
    );
    return diagnosis.globalSlidingMatch.lagResults
        .map((row) => ({
            lag: row.lag,
            ...correlationForSegment(
                diagnosis.rawTarget,
                diagnosis.master.data,
                startYear,
                diagnosis.targetRange.endYear,
                row.lag,
                minimumPairs,
            ),
        }))
        .filter((row) => row.correlation !== null)
        .sort((left, right) => (
            (right.correlation ?? -1) - (left.correlation ?? -1)
            || right.samplePairs - left.samplePairs
            || Math.abs(left.lag) - Math.abs(right.lag)
        ))[0]?.lag ?? diagnosis.globalSlidingMatch.bestGlobalLag;
};

export const scoreJointCounterfactualOperations = (
    diagnosis: SeriesCoreDiagnosis,
    edgeYears = 20,
    corrections: readonly number[] = getAutomaticEventShiftCandidates({
        maxPartialGapYears: DEFAULT_MAX_PARTIAL_GAP_YEARS,
        lagMin: -DEFAULT_MAX_PARTIAL_GAP_YEARS,
        seriesLength:
            diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
        minimumSideYears: edgeYears,
    }),
    baselineLag = estimateFixedSideLag(diagnosis, Math.max(8, edgeYears)),
): JointCounterfactualOperationScore[] => {
    const sharedEvidence = createFullIntervalShiftEvidenceContext(
        diagnosis,
        diagnosis.master.data,
        baselineLag,
    );
    const baseline = scoreFullIntervalBaselineEvidence(
        diagnosis,
        diagnosis.master.data,
        baselineLag,
    );
    const minimumRawPairs = Math.floor(baseline.samplePairs * 0.8);
    const minimumDifferencePairs = Math.floor(baseline.differencePairs * 0.8);
    return corrections.flatMap((shiftYears): JointCounterfactualOperationScore[] => {
        const eventType = eventTypeFor(shiftYears);
        if (eventType === null) return [];
        const rows = scoreFullIntervalShiftEvidence(
            diagnosis,
            shiftYears,
            edgeYears,
            diagnosis.master.data,
            baselineLag,
            sharedEvidence,
        ).filter((row) => (
            row.samplePairs >= minimumRawPairs
            && row.differencePairs >= minimumDifferencePairs
        )).map((row) => {
            const rawGain = row.rawCorrelation - baseline.rawCorrelation;
            const differenceGain =
                row.differenceCorrelation - baseline.differenceCorrelation;
            return {
                ...row,
                rawGain,
                differenceGain,
                combinedGain: rawGain * 0.25 + differenceGain * 0.75,
            };
        }).map((row) => eventType === "partialMove"
            ? {
                ...row,
                year: firstFixedYearFromLastMovedYear(row.year),
            }
            : row);
        if (rows.length === 0) return [];
        const ranked = [...rows].sort((left, right) => (
            right.differenceGain - left.differenceGain
            || right.combinedGain - left.combinedGain
            || right.year - left.year
        ));
        const best = ranked[0];
        const remote = ranked.find((row) => Math.abs(row.year - best.year) > 17);
        const sideRanked = rows
            .filter((row) => Number.isFinite(row.sideStepScore))
            .sort((left, right) => (
                right.sideStepScore - left.sideStepScore
                || right.sideMinimumAdvantage - left.sideMinimumAdvantage
                || right.correctedSideSupport - left.correctedSideSupport
                || right.year - left.year
            ));
        const sideBest = sideRanked[0] ?? best;
        const sideRemote = sideRanked.find(
            (row) => Math.abs(row.year - sideBest.year) > 17,
        );
        return [{
            eventType,
            shiftYears,
            baselineLag,
            bestYear: best.year,
            bestRawGain: best.rawGain,
            bestDifferenceGain: best.differenceGain,
            bestCombinedGain: best.combinedGain,
            topThreeDifferenceGain: mean(
                ranked.slice(0, 3).map((row) => row.differenceGain),
            ),
            remoteDifferenceMargin:
                best.differenceGain - (remote?.differenceGain ?? best.differenceGain),
            sideStepBestYear: sideBest.year,
            bestSideStepScore: sideBest.sideStepScore,
            topThreeSideStepScore: mean(
                sideRanked.slice(0, 3).map((row) => row.sideStepScore),
            ),
            bestSideMinimumAdvantage: sideBest.sideMinimumAdvantage,
            bestCorrectedSideSupport: sideBest.correctedSideSupport,
            sideStepRemoteMargin:
                sideBest.sideStepScore
                - (sideRemote?.sideStepScore ?? sideBest.sideStepScore),
            rows,
        }];
    });
};

/**
 * One diagnosis pass may ask the operation selector and the locator for the same six scans.
 * Keep that linear-time evidence on the diagnosis object instead of rebuilding it twice.
 */
export const getJointCounterfactualOperationScores = (
    diagnosis: SeriesCoreDiagnosis,
    edgeYears = 15,
    maxPartialGapYears = DEFAULT_MAX_PARTIAL_GAP_YEARS,
    baselineLag?: number,
): JointCounterfactualOperationScore[] => {
    const byEdge = CACHE.get(diagnosis) ?? new Map();
    const cacheKey = `${edgeYears}:${maxPartialGapYears}:${
        baselineLag === undefined ? "estimated" : baselineLag
    }`;
    const cached = byEdge.get(cacheKey);
    if (cached) return cached;
    const corrections = getAutomaticEventShiftCandidates({
        maxPartialGapYears,
        lagMin: -maxPartialGapYears,
        seriesLength:
            diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
        minimumSideYears: edgeYears,
    });
    const scores = scoreJointCounterfactualOperations(
        diagnosis,
        edgeYears,
        corrections,
        baselineLag,
    );
    byEdge.set(cacheKey, scores);
    CACHE.set(diagnosis, byEdge);
    return scores;
};

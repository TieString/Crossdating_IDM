/** Counterfactual scan for a bounded older-side integer move. */
import type { RwlSiteData } from "@/features/rwl/types";
import { CrossdateConfig } from "./config";
import { compareDiagnosisCandidates, rankDiagnosisCandidates } from "./candidateUtils";
import { evaluateDraft } from "./evaluation";
import { firstDifferenceCorrelation, wholeSeriesCorrelation } from "./evaluationMetrics";
import { makeDiagnosisEventsFromCandidates } from "./events";
import { scoreFullIntervalShiftEvidence } from "./fullIntervalUnitEditEvidence";
import {
    firstFixedYearFromLastMovedYear,
    getAutomaticPartialShiftCandidates,
    isAutomaticPartialShift,
} from "./partialMoveSemantics";
import { getSegmentNearYear, makePartialRangeEvidence, missingRangeForMove } from "./rangeMove";
import {
    ar1WhitenSeries,
    correlationForSegment,
    getRangeForSeries,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import type {
    CandidateDraft,
    DiagnosisCandidateOperation,
    DiagnosisEvent,
    EffectiveDiagnosisConfig,
    SeriesCoreDiagnosis,
} from "./types";

export type PartialMoveEventScanConfig = {
    shifts: number[];
    minStableSideYears: number;
    minimumCompositeGain: number;
    peaksPerShift: number;
    maximumEvaluations: number;
    maximumReturnedCandidates: number;
    minimumCandidateScore: number;
    rawGainWeight: number;
    firstDifferenceGainWeight: number;
    boundaryEvidenceWeight: number;
    splitEvidenceWeight: number;
    cumulativeEvidenceWeight: number;
    localReferenceCount: number;
    newerAnchorYears: number;
};

export const DEFAULT_PARTIAL_MOVE_EVENT_SCAN_CONFIG: PartialMoveEventScanConfig = {
    shifts: getAutomaticPartialShiftCandidates({
        maxPartialGapYears: CrossdateConfig.maxPartialGapYears,
        lagMin: CrossdateConfig.lagMin,
    }),
    minStableSideYears: 18,
    minimumCompositeGain: 0.08,
    peaksPerShift: 2,
    maximumEvaluations: 10,
    maximumReturnedCandidates: 1,
    minimumCandidateScore: CrossdateConfig.evaluationV2.acceptanceThreshold,
    rawGainWeight: 0.2,
    firstDifferenceGainWeight: 0.25,
    boundaryEvidenceWeight: 0.55,
    splitEvidenceWeight: 0,
    cumulativeEvidenceWeight: 0,
    localReferenceCount: 5,
    newerAnchorYears: 45,
};

type ScoredMove = {
    boundaryYear: number;
    shiftYears: number;
    compositeGain: number;
    rawGain: number;
    firstDifferenceGain: number;
    boundaryEvidence: number;
};

const correlation = (
    target: Map<number, number>,
    master: Map<number, number>,
    startYear: number,
    endYear: number,
    lag: number,
    minPairs: number,
): number => correlationForSegment(
    target,
    master,
    startYear,
    endYear,
    lag,
    minPairs,
).correlation ?? -0.25;

const boundaryAlignmentEvidence = (
    target: Map<number, number>,
    master: Map<number, number>,
    boundaryYear: number,
    shiftYears: number,
    minPairs: number,
): number => {
    const widths = [18, 26, 38];
    const scores = widths.map((width) => {
        const olderStart = boundaryYear - width + 1;
        const newerEnd = boundaryYear + width;
        const olderShift = correlation(target, master, olderStart, boundaryYear, shiftYears, minPairs);
        const olderZero = correlation(target, master, olderStart, boundaryYear, 0, minPairs);
        const newerZero = correlation(target, master, boundaryYear + 1, newerEnd, 0, minPairs);
        const newerShift = correlation(target, master, boundaryYear + 1, newerEnd, shiftYears, minPairs);
        const support = Math.min(olderShift, newerZero);
        const contrast = (olderShift - olderZero) + (newerZero - newerShift);
        return support + contrast * 0.6;
    });
    return scores.reduce((sum, score) => sum + score, 0) / scores.length;
};

const splitAlignmentEvidence = (
    target: Map<number, number>,
    master: Map<number, number>,
    startYear: number,
    endYear: number,
    boundaryYear: number,
    shiftYears: number,
    minPairs: number,
): number => {
    const measure = (from: number, to: number, lag: number) => correlationForSegment(
        target,
        master,
        from,
        to,
        lag,
        minPairs,
    );
    const olderShift = measure(startYear, boundaryYear, shiftYears);
    const olderZero = measure(startYear, boundaryYear, 0);
    const newerZero = measure(boundaryYear + 1, endYear, 0);
    const newerShift = measure(boundaryYear + 1, endYear, shiftYears);
    if (olderShift.correlation === null || newerZero.correlation === null) return -1;
    const olderWeight = olderShift.samplePairs;
    const newerWeight = newerZero.samplePairs;
    const totalWeight = Math.max(1, olderWeight + newerWeight);
    const alignment = (
        olderShift.correlation * olderWeight
        + newerZero.correlation * newerWeight
    ) / totalWeight;
    const contrast = (
        (olderShift.correlation - (olderZero.correlation ?? 0)) * olderWeight
        + (newerZero.correlation - (newerShift.correlation ?? 0)) * newerWeight
    ) / totalWeight;
    return alignment + contrast * 0.7;
};

const clipped = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

const cumulativeTransitionEvidence = (
    target: Map<number, number>,
    master: Map<number, number>,
    startYear: number,
    boundaryYear: number,
    shiftYears: number,
): number => {
    let score = 0;
    let pairs = 0;
    for (let year = startYear; year <= boundaryYear; year += 1) {
        const targetValue = target.get(year);
        const shifted = master.get(year + shiftYears);
        const zero = master.get(year);
        if (targetValue === undefined || shifted === undefined || zero === undefined) continue;
        score += clipped(targetValue * (shifted - zero), 4);
        pairs += 1;
    }
    return pairs > 0 ? score : -1;
};

const buildNewerAnchoredMaster = (
    siteData: RwlSiteData,
    diagnosis: SeriesCoreDiagnosis,
    referenceCount: number,
    newerAnchorYears: number,
): Map<number, number> => {
    const target = preprocessSeries(diagnosis.rawTarget);
    const anchorStart = Math.max(
        diagnosis.targetRange.startYear,
        diagnosis.targetRange.endYear - newerAnchorYears + 1,
    );
    const references = diagnosis.master.sourceTrees
        .map((tree) => {
            const values = preprocessSeries(toNumericSeries(siteData.get(tree)));
            const alignment = correlationForSegment(
                target,
                values,
                anchorStart,
                diagnosis.targetRange.endYear,
                0,
                12,
            );
            return { values, correlation: alignment.correlation ?? -1 };
        })
        .filter((reference) => reference.correlation > 0)
        .sort((a, b) => b.correlation - a.correlation)
        .slice(0, Math.max(1, referenceCount));
    if (references.length === 0) return diagnosis.master.data;

    const sums = new Map<number, number>();
    const weights = new Map<number, number>();
    references.forEach((reference) => {
        const weight = (reference.correlation + 0.1) ** 2;
        reference.values.forEach((value, year) => {
            sums.set(year, (sums.get(year) ?? 0) + value * weight);
            weights.set(year, (weights.get(year) ?? 0) + weight);
        });
    });
    const master = new Map<number, number>();
    sums.forEach((sum, year) => {
        const weight = weights.get(year) ?? 0;
        if (weight > 0) master.set(year, sum / weight);
    });
    return master.size >= 30 ? preprocessSeries(master) : diagnosis.master.data;
};

const selectSeparatedPeaks = (
    values: ScoredMove[],
    count: number,
): ScoredMove[] => {
    const selected: ScoredMove[] = [];
    [...values]
        .sort((a, b) => b.compositeGain - a.compositeGain || b.boundaryYear - a.boundaryYear)
        .forEach((candidate) => {
            if (selected.length >= count) return;
            if (selected.some((other) => Math.abs(other.boundaryYear - candidate.boundaryYear) <= 8)) return;
            selected.push(candidate);
        });
    return selected;
};

const makeDraft = (
    diagnosis: SeriesCoreDiagnosis,
    scored: ScoredMove,
): CandidateDraft | null => {
    const sourceSegment = getSegmentNearYear(diagnosis.segments, scored.boundaryYear);
    if (!sourceSegment) return null;
    const selectedRange = {
        startYear: diagnosis.targetRange.startYear,
        endYear: scored.boundaryYear,
    };
    return {
        targetTree: diagnosis.targetTree,
        operationType: "SHIFT_RANGE",
        candidateType: "batchMoveYears",
        mode: "partialRangeMove",
        anchorYear: firstFixedYearFromLastMovedYear(scored.boundaryYear),
        selectedRange,
        missingRange: missingRangeForMove(selectedRange, scored.shiftYears),
        deltaYears: scored.shiftYears,
        sourceSegment,
        algorithmSource: ["segmented_diagnosis", "global_sliding_match"],
        recallSourceTags: [
            "counterfactual_partial_move_scan",
            `composite_gain:${scored.compositeGain.toFixed(4)}`,
        ],
        partialRangeMoveEvidence: makePartialRangeEvidence(
            diagnosis,
            selectedRange,
            scored.shiftYears,
        ),
    };
};

export const scanPartialMoveCandidates = (
    siteData: RwlSiteData,
    diagnosis: SeriesCoreDiagnosis,
    effectiveConfig: EffectiveDiagnosisConfig,
    overrides: Partial<PartialMoveEventScanConfig> = {},
): DiagnosisCandidateOperation[] => {
    const baseConfig = { ...DEFAULT_PARTIAL_MOVE_EVENT_SCAN_CONFIG, ...overrides };
    const shifts = (
        overrides.shifts
        ?? getAutomaticPartialShiftCandidates({
            maxPartialGapYears: effectiveConfig.maxPartialGapYears,
            lagMin: effectiveConfig.lagMin,
            seriesLength:
                diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
            minimumSideYears: baseConfig.minStableSideYears,
        })
    ).filter((shiftYears) => isAutomaticPartialShift(shiftYears, {
        maxPartialGapYears: effectiveConfig.maxPartialGapYears,
        lagMin: effectiveConfig.lagMin,
        seriesLength:
            diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
        minimumSideYears: baseConfig.minStableSideYears,
    }));
    const config = { ...baseConfig, shifts };
    const target = preprocessSeries(diagnosis.rawTarget);
    const localMaster = buildNewerAnchoredMaster(
        siteData,
        diagnosis,
        config.localReferenceCount,
        config.newerAnchorYears,
    );
    const whitenedTarget = ar1WhitenSeries(diagnosis.rawTarget);
    const whitenedMaster = ar1WhitenSeries(localMaster);
    const range = getRangeForSeries(target);
    if (!range) return [];
    const baseRaw = wholeSeriesCorrelation(
        target,
        localMaster,
        effectiveConfig.minPairsForCorrelation,
    );
    const baseDifference = firstDifferenceCorrelation(
        target,
        localMaster,
        range.startYear,
        range.endYear,
        effectiveConfig.minPairsForCorrelation,
    ) ?? 0;

    const byShift = new Map<number, ScoredMove[]>();
    config.shifts.forEach((shiftYears) => {
        const values: ScoredMove[] = [];
        const fullIntervalByBoundary = new Map(
            scoreFullIntervalShiftEvidence(
                diagnosis,
                shiftYears,
                config.minStableSideYears,
                localMaster,
            ).map((row) => [row.year, row]),
        );
        const minimumBoundary = diagnosis.targetRange.startYear + config.minStableSideYears - 1;
        const maximumBoundary = diagnosis.targetRange.endYear - config.minStableSideYears;
        for (let boundaryYear = minimumBoundary; boundaryYear <= maximumBoundary; boundaryYear += 1) {
            const fullInterval = fullIntervalByBoundary.get(boundaryYear);
            if (!fullInterval) continue;
            const rawGain = fullInterval.rawCorrelation - baseRaw;
            const firstDifferenceGain =
                fullInterval.differenceCorrelation - baseDifference;
            const rawBoundaryEvidence = boundaryAlignmentEvidence(
                target,
                localMaster,
                boundaryYear,
                shiftYears,
                Math.max(6, effectiveConfig.minPairsForCorrelation - 2),
            );
            const whitenedBoundaryEvidence = boundaryAlignmentEvidence(
                whitenedTarget,
                whitenedMaster,
                boundaryYear,
                shiftYears,
                Math.max(6, effectiveConfig.minPairsForCorrelation - 2),
            );
            const boundaryEvidence = rawBoundaryEvidence * 0.4 + whitenedBoundaryEvidence * 0.6;
            const splitEvidence = config.splitEvidenceWeight === 0
                ? 0
                : splitAlignmentEvidence(
                    target,
                    localMaster,
                    diagnosis.targetRange.startYear,
                    diagnosis.targetRange.endYear,
                    boundaryYear,
                    shiftYears,
                    effectiveConfig.minPairsForCorrelation,
                ) * 0.4
                    + splitAlignmentEvidence(
                        whitenedTarget,
                        whitenedMaster,
                        diagnosis.targetRange.startYear,
                        diagnosis.targetRange.endYear,
                        boundaryYear,
                        shiftYears,
                        effectiveConfig.minPairsForCorrelation,
                    ) * 0.6;
            const cumulativeEvidence = config.cumulativeEvidenceWeight === 0
                ? 0
                : cumulativeTransitionEvidence(
                    target,
                    localMaster,
                    diagnosis.targetRange.startYear,
                    boundaryYear,
                    shiftYears,
                ) * 0.4
                    + cumulativeTransitionEvidence(
                        whitenedTarget,
                        whitenedMaster,
                        diagnosis.targetRange.startYear,
                        boundaryYear,
                        shiftYears,
                    ) * 0.6;
            const compositeGain = rawGain * config.rawGainWeight
                + firstDifferenceGain * config.firstDifferenceGainWeight
                + boundaryEvidence * config.boundaryEvidenceWeight
                + splitEvidence * config.splitEvidenceWeight
                + cumulativeEvidence * config.cumulativeEvidenceWeight;
            if (compositeGain >= config.minimumCompositeGain) {
                values.push({
                    boundaryYear,
                    shiftYears,
                    compositeGain,
                    rawGain,
                    firstDifferenceGain,
                    boundaryEvidence,
                });
            }
        }
        byShift.set(shiftYears, values);
    });

    const peaks = Array.from(byShift.values())
        .flatMap((values) => selectSeparatedPeaks(values, config.peaksPerShift))
        .sort((a, b) => b.compositeGain - a.compositeGain)
        .slice(0, config.maximumEvaluations);
    const evaluated = peaks
        .map((peak) => {
            const draft = makeDraft(diagnosis, peak);
            if (!draft) return null;
            const candidate = evaluateDraft(siteData, diagnosis, draft, effectiveConfig, null);
            if (!candidate || candidate.score < config.minimumCandidateScore
                || candidate.candidateStrength !== "strong") return null;
            const baselineLag = candidate.evidence.evaluationDelta?.dominantLagBefore
                ?? candidate.evidence.before.bestLag;
            if (Math.abs(baselineLag) < 2 || Math.sign(baselineLag) !== Math.sign(peak.shiftYears)) {
                return null;
            }
            return candidate;
        })
        .filter((candidate): candidate is DiagnosisCandidateOperation => candidate !== null);
    return rankDiagnosisCandidates(evaluated)
        .sort(compareDiagnosisCandidates)
        .slice(0, config.maximumReturnedCandidates);
};

export const scanPartialMoveEvents = (
    siteData: RwlSiteData,
    diagnosis: SeriesCoreDiagnosis,
    effectiveConfig: EffectiveDiagnosisConfig,
    overrides: Partial<PartialMoveEventScanConfig> = {},
): DiagnosisEvent[] => makeDiagnosisEventsFromCandidates(
    [diagnosis],
    scanPartialMoveCandidates(siteData, diagnosis, effectiveConfig, overrides),
);

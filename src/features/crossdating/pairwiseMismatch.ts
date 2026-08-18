/**
 * Explicit two-line mismatch analysis for the chart.
 *
 * This is intentionally separate from the multi-reference production diagnosis. It answers a
 * narrower question: does the target switch from lag 0 on the newer side to one stable non-zero
 * lag on the older side, and where is that boundary? The resulting boundary is projected into the
 * existing DiagnosisEvent contract so review, preview, and editing keep one UI and operation path.
 */
import {
    deleteYearWithMode,
    insertMissingYearAtSide,
    moveSeriesTailByOffset,
} from "@/features/rwl/edit";
import type { RwlTreeData } from "@/features/rwl/types";
import { stopMarker } from "@/shared/constants";
import { cofechaStyleStandardize } from "./reference";
import { adaptiveImprovementThreshold, correlationForSegment } from "./diagnosis/series";
import { runGlobalSlidingMatch } from "./diagnosis/sliding";
import type {
    DiagnosisConfidence,
    DiagnosisEvent,
    DiagnosisEventType,
    NumericSeries,
} from "./diagnosis/types";

export type PairwiseMismatchStatus =
    | "mismatch"
    | "aligned"
    | "whole-shift"
    | "ambiguous"
    | "insufficient-overlap";

export type PairwiseMismatchAnalysis = {
    status: PairwiseMismatchStatus;
    targetTree: string;
    comparatorId: string;
    comparatorLabel: string;
    comparatorKind: "series" | "reference";
    comparatorDepth: number;
    overlapRange: { startYear: number; endYear: number } | null;
    overlapYears: number;
    globalLag: number;
    currentCorrelation: number | null;
    bestCorrelation: number | null;
    event: DiagnosisEvent | null;
    summary: string;
    detail: string;
};

export type PairwiseMismatchInput = {
    targetTree: string;
    targetData: RwlTreeData;
    comparatorId: string;
    comparatorLabel: string;
    comparatorData: RwlTreeData;
    comparatorKind: "series" | "reference";
    /** Statistical source depth. A derived reference remains one visible line but can have n > 1. */
    comparatorDepth?: number;
};

type CorrelationRow = {
    correlation: number | null;
    samplePairs: number;
};

type BoundaryCandidate = {
    year: number;
    lag: number;
    olderShifted: CorrelationRow;
    olderZero: CorrelationRow;
    newerZero: CorrelationRow;
    newerShifted: CorrelationRow;
    olderGain: number;
    newerGain: number;
    score: number;
};

type CorrectionScore = {
    year: number;
    correlation: number | null;
    score: number;
    boundary?: BoundaryCandidate;
};

const LAG_RADIUS = 10;
const MINIMUM_TOTAL_OVERLAP = 45;
const MINIMUM_OLDER_PAIRS = 24;
const MINIMUM_NEWER_PAIRS = 6;
const MINIMUM_VALID_CORRELATION = 0.2;
const MINIMUM_CORRECTION_GAIN = 0.015;
const REVIEW_WINDOW_WIDTH = 7;

const isUsableWidth = (value: number | null | undefined): value is number => (
    typeof value === "number"
    && Number.isFinite(value)
    && value > 0
    && value !== stopMarker.value
);

const numericSeries = (data: RwlTreeData): NumericSeries => new Map(
    cofechaStyleStandardize(new Map(Array.from(data).filter((entry): entry is [number, number] => (
        isUsableWidth(entry[1])
    )))).map((point) => [point.year, point.value]),
);

const rangeFor = (series: NumericSeries): { startYear: number; endYear: number } | null => {
    const years = Array.from(series.keys());
    if (years.length === 0) return null;
    return { startYear: Math.min(...years), endYear: Math.max(...years) };
};

const overlapFor = (
    target: NumericSeries,
    comparator: NumericSeries,
): { startYear: number; endYear: number } | null => {
    const targetRange = rangeFor(target);
    const comparatorRange = rangeFor(comparator);
    if (!targetRange || !comparatorRange) return null;
    const startYear = Math.max(targetRange.startYear, comparatorRange.startYear);
    const endYear = Math.min(targetRange.endYear, comparatorRange.endYear);
    return startYear <= endYear ? { startYear, endYear } : null;
};

const correlation = (
    target: NumericSeries,
    comparator: NumericSeries,
    startYear: number,
    endYear: number,
    lag: number,
    minimumPairs: number,
): CorrelationRow => correlationForSegment(
    target,
    comparator,
    startYear,
    endYear,
    lag,
    minimumPairs,
);

const correlationValue = (row: CorrelationRow): number => row.correlation ?? -1;

const boundaryCandidates = (
    target: NumericSeries,
    comparator: NumericSeries,
    overlap: { startYear: number; endYear: number },
): BoundaryCandidate[] => {
    const rows: BoundaryCandidate[] = [];
    const firstBoundary = overlap.startYear + MINIMUM_OLDER_PAIRS - 1;
    const lastBoundary = overlap.endYear - MINIMUM_NEWER_PAIRS;

    for (let year = firstBoundary; year <= lastBoundary; year += 1) {
        const olderZero = correlation(
            target,
            comparator,
            overlap.startYear,
            year,
            0,
            MINIMUM_OLDER_PAIRS,
        );
        const newerZero = correlation(
            target,
            comparator,
            year + 1,
            overlap.endYear,
            0,
            MINIMUM_NEWER_PAIRS,
        );
        if (olderZero.correlation === null || newerZero.correlation === null) continue;

        for (let lag = -LAG_RADIUS; lag <= LAG_RADIUS; lag += 1) {
            if (lag === 0) continue;
            const olderShifted = correlation(
                target,
                comparator,
                overlap.startYear,
                year,
                lag,
                MINIMUM_OLDER_PAIRS,
            );
            const newerShifted = correlation(
                target,
                comparator,
                year + 1,
                overlap.endYear,
                lag,
                MINIMUM_NEWER_PAIRS,
            );
            if (olderShifted.correlation === null || newerShifted.correlation === null) continue;

            const olderGain = correlationValue(olderShifted) - correlationValue(olderZero);
            const newerGain = correlationValue(newerZero) - correlationValue(newerShifted);
            const olderThreshold = adaptiveImprovementThreshold(olderShifted.samplePairs);
            const newerThreshold = adaptiveImprovementThreshold(newerZero.samplePairs);
            if (
                correlationValue(olderShifted) < MINIMUM_VALID_CORRELATION
                || correlationValue(newerZero) < MINIMUM_VALID_CORRELATION
                || olderGain < olderThreshold
                || newerGain < newerThreshold
            ) continue;

            const balance = Math.min(olderGain, newerGain);
            const evidence = Math.max(0, correlationValue(olderShifted))
                + Math.max(0, correlationValue(newerZero));
            const newerSupport = Math.min(1, newerZero.samplePairs / 24);
            rows.push({
                year,
                lag,
                olderShifted,
                olderZero,
                newerZero,
                newerShifted,
                olderGain,
                newerGain,
                // Minimum-side gain prevents a long older side from drowning weak newer evidence.
                score: balance * (1.4 + newerSupport)
                    + (olderGain + newerGain) * 0.45
                    + evidence * 0.15
                    + newerSupport * 0.12,
            });
        }
    }

    return rows.sort((left, right) => (
        right.score - left.score
        || right.year - left.year
        || Math.abs(left.lag) - Math.abs(right.lag)
    ));
};

const applyCorrection = (
    data: RwlTreeData,
    targetRange: { startYear: number; endYear: number },
    year: number,
    lag: number,
): RwlTreeData | null => {
    if (lag === -1) return insertMissingYearAtSide(data, year, "right");
    if (lag === 1) return deleteYearWithMode(data, year, "direct", "right");
    if (lag < -1 && year > targetRange.startYear) {
        return moveSeriesTailByOffset(data, targetRange.startYear, year - 1, lag);
    }
    // Positive multi-year changes need several false-ring decisions and are not one safe edit.
    return null;
};

const eventTypeForLag = (lag: number): DiagnosisEventType | null => {
    if (lag === -1) return "missingRing";
    if (lag === 1) return "falseRing";
    if (lag < -1) return "partialMove";
    return null;
};

const confidenceFor = (
    candidate: BoundaryCandidate,
    correlationGain: number,
    comparatorDepth: number,
): DiagnosisConfidence => {
    const minimumSideGain = Math.min(candidate.olderGain, candidate.newerGain);
    if (comparatorDepth >= 3 && minimumSideGain >= 0.24 && correlationGain >= 0.08) {
        return "high";
    }
    if (minimumSideGain >= 0.16 && correlationGain >= 0.03) return "medium";
    return "low";
};

const summaryForLag = (lag: number) => (
    lag < 0
        ? `较老侧相对向新年份错开 ${Math.abs(lag)} 年`
        : `较老侧相对向老年份错开 ${Math.abs(lag)} 年`
);

const emptyResult = (
    input: PairwiseMismatchInput,
    extras: Pick<
        PairwiseMismatchAnalysis,
        | "status"
        | "overlapRange"
        | "overlapYears"
        | "globalLag"
        | "currentCorrelation"
        | "bestCorrelation"
        | "summary"
        | "detail"
    >,
): PairwiseMismatchAnalysis => ({
    targetTree: input.targetTree,
    comparatorId: input.comparatorId,
    comparatorLabel: input.comparatorLabel,
    comparatorKind: input.comparatorKind,
    comparatorDepth: Math.max(1, Math.round(input.comparatorDepth ?? 1)),
    event: null,
    ...extras,
});

export const analyzePairwiseMismatch = (
    input: PairwiseMismatchInput,
): PairwiseMismatchAnalysis => {
    const target = numericSeries(input.targetData);
    const comparator = numericSeries(input.comparatorData);
    const overlap = overlapFor(target, comparator);
    const comparatorDepth = Math.max(1, Math.round(input.comparatorDepth ?? 1));
    if (!overlap) {
        return emptyResult(input, {
            status: "insufficient-overlap",
            overlapRange: null,
            overlapYears: 0,
            globalLag: 0,
            currentCorrelation: null,
            bestCorrelation: null,
            summary: "两条折线没有可比较的重叠年份",
            detail: "请改选存在共同年份的两条折线。",
        });
    }

    const zero = correlation(target, comparator, overlap.startYear, overlap.endYear, 0, 3);
    if (zero.samplePairs < MINIMUM_TOTAL_OVERLAP) {
        return emptyResult(input, {
            status: "insufficient-overlap",
            overlapRange: overlap,
            overlapYears: zero.samplePairs,
            globalLag: 0,
            currentCorrelation: zero.correlation,
            bestCorrelation: null,
            summary: `共同有效年份只有 ${zero.samplePairs} 年`,
            detail: `至少需要 ${MINIMUM_TOTAL_OVERLAP} 个共同有效年份才能判断持续错配。`,
        });
    }

    const global = runGlobalSlidingMatch(target, comparator, {
        seriesId: input.targetTree,
        lagMin: -LAG_RADIUS,
        lagMax: LAG_RADIUS,
        minOverlap: MINIMUM_TOTAL_OVERLAP,
    });
    const candidates = boundaryCandidates(target, comparator, overlap);
    const targetRange = rangeFor(target);
    const baselineCorrelation = zero.correlation;

    if (candidates.length > 0 && targetRange) {
        const leading = candidates[0];
        const operationType = eventTypeForLag(leading.lag);
        if (operationType) {
            const boundaryCorrections: CorrectionScore[] = [];
            candidates.filter((candidate) => candidate.lag === leading.lag)
                .slice(0, 80)
                .forEach((boundary) => {
                    const corrected = applyCorrection(
                        input.targetData,
                        targetRange,
                        boundary.year,
                        leading.lag,
                    );
                    if (!corrected) return;
                    const correctedSeries = numericSeries(corrected);
                    const measured = correlation(
                        correctedSeries,
                        comparator,
                        overlap.startYear,
                        overlap.endYear,
                        0,
                        MINIMUM_TOTAL_OVERLAP,
                    );
                    boundaryCorrections.push({
                        year: boundary.year,
                        correlation: measured.correlation,
                        score: correlationValue(measured) + boundary.score * 0.04,
                        boundary,
                    });
                });
            boundaryCorrections.sort((left, right) => right.score - left.score || right.year - left.year);
            const selected = boundaryCorrections[0];
            const selectedBoundary = selected?.boundary ?? leading;
            const correctedCorrelation = selected?.correlation ?? null;
            const correlationGain = correctedCorrelation === null || baselineCorrelation === null
                ? 0
                : correctedCorrelation - baselineCorrelation;

            if (selected && correlationGain >= MINIMUM_CORRECTION_GAIN) {
                const correctionRows: CorrectionScore[] = [];
                const scanStart = Math.max(targetRange.startYear + 1, selected.year - 6);
                const scanEnd = Math.min(targetRange.endYear - 1, selected.year + 6);
                for (let year = scanStart; year <= scanEnd; year += 1) {
                    const corrected = applyCorrection(
                        input.targetData,
                        targetRange,
                        year,
                        selectedBoundary.lag,
                    );
                    if (!corrected) continue;
                    const correctedSeries = numericSeries(corrected);
                    const measured = correlation(
                        correctedSeries,
                        comparator,
                        overlap.startYear,
                        overlap.endYear,
                        0,
                        MINIMUM_TOTAL_OVERLAP,
                    );
                    const boundary = candidates.find((row) => (
                        row.year === year && row.lag === selectedBoundary.lag
                    ));
                    correctionRows.push({
                        year,
                        correlation: measured.correlation,
                        score: correlationValue(measured)
                            + (boundary?.score ?? selectedBoundary.score) * 0.04,
                        boundary,
                    });
                }
                correctionRows.sort((left, right) => (
                    right.score - left.score || right.year - left.year
                ));
                const refined = correctionRows[0] ?? selected;
                const half = Math.floor(REVIEW_WINDOW_WIDTH / 2);
                let eventStart = refined.year - half;
                eventStart = Math.max(
                    targetRange.startYear,
                    Math.min(eventStart, targetRange.endYear - REVIEW_WINDOW_WIDTH + 1),
                );
                const eventEnd = Math.min(targetRange.endYear, eventStart + REVIEW_WINDOW_WIDTH - 1);
                const windowScores = correctionRows
                    .filter((row) => row.year >= eventStart && row.year <= eventEnd);
                const scoreByYear = new Map(windowScores.map((row) => [row.year, row.score]));
                const fallbackScore = refined.score;
                const rankedYears = Array.from(
                    { length: eventEnd - eventStart + 1 },
                    (_, index) => eventStart + index,
                ).map((year) => ({
                    year,
                    score: scoreByYear.get(year) ?? fallbackScore - Math.abs(year - refined.year) * 0.05,
                    evidenceTags: year === refined.year
                        ? ["pairwise_mismatch", "counterfactual_operation_verification"]
                        : ["within_event_window"],
                })).sort((left, right) => right.score - left.score || right.year - left.year)
                    .map((row, index) => ({ ...row, rank: index + 1 }));
                const secondScore = correctionRows[1]?.score ?? refined.score;
                const finalCorrectedCorrelation = refined.correlation ?? correctedCorrelation;
                const finalCorrelationGain = finalCorrectedCorrelation === null || baselineCorrelation === null
                    ? 0
                    : finalCorrectedCorrelation - baselineCorrelation;
                const confidenceLevel = confidenceFor(
                    selectedBoundary,
                    finalCorrelationGain,
                    comparatorDepth,
                );
                const event: DiagnosisEvent = {
                    id: `pairwise-${input.targetTree}-${input.comparatorId}-${operationType}-${eventStart}-${eventEnd}`,
                    seriesId: input.targetTree,
                    eventType: operationType,
                    startYear: eventStart,
                    endYear: eventEnd,
                    rankedYears,
                    confidenceLevel,
                    evidence: {
                        algorithmSources: [
                            "pairwise_mismatch",
                            "segmented_lag_path",
                            "counterfactual_operation_verification",
                        ],
                        score: selectedBoundary.score,
                        scoreMargin: refined.score - secondScore,
                        baselineCorrelation,
                        correctedCorrelation: finalCorrectedCorrelation,
                        correlationGain: finalCorrelationGain,
                        lagBefore: selectedBoundary.lag,
                        lagAfter: 0,
                        samplePairs: zero.samplePairs,
                        candidateIds: [],
                        notes: [
                            `pairwise_target=${input.targetTree}`,
                            `pairwise_comparator=${input.comparatorId}`,
                            `pairwise_comparator_depth=${comparatorDepth}`,
                            `pairwise_older_gain=${selectedBoundary.olderGain.toFixed(6)}`,
                            `pairwise_newer_gain=${selectedBoundary.newerGain.toFixed(6)}`,
                            `profile_boundary_year=${selectedBoundary.year}`,
                            `scan_top_year=${refined.year}`,
                            `candidate_top_year=${refined.year}`,
                        ],
                    },
                    alternativeTypes: [],
                    seriesRange: { ...targetRange },
                    ...(operationType === "partialMove" ? {
                        shiftYears: selectedBoundary.lag,
                        shiftSide: "older" as const,
                    } : {}),
                };
                return {
                    status: "mismatch",
                    targetTree: input.targetTree,
                    comparatorId: input.comparatorId,
                    comparatorLabel: input.comparatorLabel,
                    comparatorKind: input.comparatorKind,
                    comparatorDepth,
                    overlapRange: overlap,
                    overlapYears: zero.samplePairs,
                    globalLag: global.bestGlobalLag,
                    currentCorrelation: baselineCorrelation,
                    bestCorrelation: global.bestGlobalR,
                    event,
                    summary: `约从 ${refined.year} 年向更老年份一侧开始错配`,
                    detail: `${summaryForLag(selectedBoundary.lag)}；已生成一个定年建议窗口供复核。`,
                };
            }
        }
    }

    const globalGain = global.bestGlobalR === null || global.currentR === null
        ? 0
        : global.bestGlobalR - global.currentR;
    const globalThreshold = adaptiveImprovementThreshold(global.overlapYears);
    if (
        global.bestGlobalLag !== 0
        && global.bestGlobalR !== null
        && global.bestGlobalR >= MINIMUM_VALID_CORRELATION
        && globalGain >= globalThreshold
    ) {
        return emptyResult(input, {
            status: "whole-shift",
            overlapRange: overlap,
            overlapYears: zero.samplePairs,
            globalLag: global.bestGlobalLag,
            currentCorrelation: global.currentR,
            bestCorrelation: global.bestGlobalR,
            summary: `整个重叠区相对偏移 ${Math.abs(global.bestGlobalLag)} 年`,
            detail: "较新端也没有稳定的 lag 0 区域，因此无法可靠定位错配开始年份。",
        });
    }

    if (
        global.currentR !== null
        && global.currentR >= MINIMUM_VALID_CORRELATION
        && (global.bestGlobalLag === 0 || globalGain < globalThreshold)
    ) {
        return emptyResult(input, {
            status: "aligned",
            overlapRange: overlap,
            overlapYears: zero.samplePairs,
            globalLag: global.bestGlobalLag,
            currentCorrelation: global.currentR,
            bestCorrelation: global.bestGlobalR,
            summary: "未检测到持续的年份错配",
            detail: "两条折线在重叠年份内没有形成可信的非零 lag 转移。",
        });
    }

    return emptyResult(input, {
        status: "ambiguous",
        overlapRange: overlap,
        overlapYears: zero.samplePairs,
        globalLag: global.bestGlobalLag,
        currentCorrelation: global.currentR,
        bestCorrelation: global.bestGlobalR,
        summary: "相关性发生变化，但不足以判定年份错配",
        detail: "没有同时满足较老侧偏移、较新侧 lag 0 和编辑后改善三项证据。",
    });
};

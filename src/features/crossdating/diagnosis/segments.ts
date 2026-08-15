/**
 * 分段诊断与单条序列的核心诊断。
 * 这里负责窗口切分后的 lag 搜索、A/B-like 标记、传播模式识别，以及单条序列摘要。
 */
import { CrossdateConfig } from "./config";
import { classifySegment } from "./classification";
import { runGlobalSlidingMatch } from "./sliding";
import {
    buildScoringMaster,
    adaptiveImprovementThreshold,
    adaptiveLowCorrelationThreshold,
    correlationForSegment,
    createSegmentsForSeries,
    fisherZ,
    getRangeForSeries,
    preprocessSeries,
    tLikeFromR,
    toNumericSeries,
    type SeriesPreprocessCache,
} from "./series";
import type {
    EffectiveDiagnosisConfig,
    NumericSeries,
    PropagationAffectedSide,
    PropagationPattern,
    PropagationPatternType,
    SegmentDiagnosis,
    SeriesCoreDiagnosis,
    SeriesDiagnosisSummary,
    ScoringMaster,
    YearRange,
} from "./types";
import type { RwlSiteData } from "@/features/rwl/types";

const scanSegment = (
    targetTree: string,
    target: NumericSeries,
    master: NumericSeries,
    segment: YearRange,
    config: EffectiveDiagnosisConfig,
    wholeSeriesLag: number,
): SegmentDiagnosis => {
    const current = correlationForSegment(
        target,
        master,
        segment.startYear,
        segment.endYear,
        0,
        config.minPairsForCorrelation,
    );
    // effectiveN 以 lag=0 的基线重叠年数为准，作为自适应阈值的样本量。
    const effectiveN = current.samplePairs;
    let bestLag = 0;
    let bestCorrelation = current.correlation;
    let bestPairs = current.samplePairs;

    for (let lag = config.lagMin; lag <= config.lagMax; lag += 1) {
        const result = correlationForSegment(
            target,
            master,
            segment.startYear,
            segment.endYear,
            lag,
            config.minPairsForCorrelation,
        );
        if (result.correlation !== null && (bestCorrelation === null || result.correlation > bestCorrelation)) {
            bestLag = lag;
            bestCorrelation = result.correlation;
            bestPairs = result.samplePairs;
        }
    }

    const r0 = current.correlation;
    const bestR = bestCorrelation;
    const rImprovement = bestR === null ? 0 : bestR - (r0 ?? -1);
    const t0 = tLikeFromR(r0, effectiveN);
    const bestT = tLikeFromR(bestR, bestPairs);
    const tImprovement = bestT - t0;
    const fisherZ0 = fisherZ(r0);
    const fisherZBest = fisherZ(bestR);
    const fisherZImprovement = fisherZBest - fisherZ0;

    const wholeSeriesMatch = correlationForSegment(
        target,
        master,
        segment.startYear,
        segment.endYear,
        wholeSeriesLag,
        config.minPairsForCorrelation,
    );
    const wholeSeriesR = wholeSeriesMatch.correlation;
    const wholeSeriesRImprovement = wholeSeriesR === null
        ? 0
        : wholeSeriesR - (r0 ?? -1);
    const wholeSeriesEffectiveN = Math.max(effectiveN, wholeSeriesMatch.samplePairs);
    const competitiveWithLocalBest = wholeSeriesR !== null
        && (bestR === null || wholeSeriesR >= bestR - 0.02);
    const independentlyImproves = wholeSeriesR !== null
        && (r0 === null
            ? wholeSeriesR >= adaptiveLowCorrelationThreshold(wholeSeriesEffectiveN)
            : wholeSeriesRImprovement >= adaptiveImprovementThreshold(wholeSeriesEffectiveN));
    const wholeSeriesLagProbe = {
        lag: wholeSeriesLag,
        correlation: wholeSeriesR,
        samplePairs: wholeSeriesMatch.samplePairs,
        rImprovement: wholeSeriesRImprovement,
        competitiveWithLocalBest,
        supportsLag: bestLag === wholeSeriesLag
            || (wholeSeriesLag !== 0 && competitiveWithLocalBest && independentlyImproves),
    };

    const { classification, confidence, reason } = classifySegment(
        { effectiveN, r0, bestLag, bestR, rImprovement, t0, bestT, tImprovement },
        CrossdateConfig.adaptiveClassification,
    );

    return {
        targetTree,
        seriesId: targetTree,
        startYear: segment.startYear,
        endYear: segment.endYear,
        r0,
        bestLag,
        bestR,
        flag: classification,
        sampleSize: bestPairs,
        currentCorrelation: r0,
        bestCorrelation: bestR,
        samplePairs: bestPairs,
        flagged: classification !== "none",
        reason,
        effectiveN,
        t0,
        bestT,
        tImprovement,
        rImprovement,
        fisherZ0,
        fisherZBest,
        fisherZImprovement,
        classification,
        confidence,
        wholeSeriesLagProbe,
    };
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * 改进 1：传播模式按 lag 符号聚类，而不要求相邻窗口 bestLag 完全相同。
 *
 * 规则：
 * - 只合并 B_like、bestLag != 0 的窗口；
 * - 相邻（或重叠）且 bestLag 同号的窗口进入同一个 group，允许轻微抖动
 *   （[-1,-1,-2,-1] 合并为 dominantLag = -1）；
 * - dominantLag 用绝对票数最多的 lag；
 * - lagConsistency = dominantLag 出现次数 / group 内窗口数；
 * - 至少连续两个 B_like 窗口才形成 pattern；
 * - 正负号混杂的相邻区域被符号切分后各自不足 2 个窗口，从而不输出，
 *   等价于“标记 ambiguous / 不输出 propagation”。
 */
export const detectPropagationPatterns = (
    targetTree: string,
    segments: SegmentDiagnosis[],
    targetRange: YearRange,
): PropagationPattern[] => {
    const bLikeSegments = segments
        .filter((segment) => segment.flag === "B_like" && segment.bestLag !== 0)
        .sort((a, b) => a.startYear - b.startYear);

    const patterns: PropagationPattern[] = [];
    let cluster: SegmentDiagnosis[] = [];

    const flushCluster = () => {
        if (cluster.length < CrossdateConfig.minPropagationSegments) {
            cluster = [];
            return;
        }

        const votes = new Map<number, number>();
        cluster.forEach((segment) => {
            votes.set(segment.bestLag, (votes.get(segment.bestLag) ?? 0) + 1);
        });
        const dominantLag = Array.from(votes.entries())
            .sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]))[0][0];
        const lagConsistency = (votes.get(dominantLag) ?? 0) / cluster.length;
        const lagVotes: Record<number, number> = {};
        votes.forEach((count, lag) => {
            lagVotes[lag] = count;
        });

        const affectedStart = Math.min(...cluster.map((segment) => segment.startYear));
        const affectedEnd = Math.max(...cluster.map((segment) => segment.endYear));
        const ratio = cluster.length / Math.max(1, segments.length);
        const newerNormalExists = segments.some((segment) => (
            segment.startYear > affectedEnd
            && segment.flag !== "B_like"
        ));
        const absLag = Math.abs(dominantLag);
        // 分类规则遵循 spec：dominantLag=-1 → 缺轮，+1 → 伪轮，|lag|>1 → 整条/部分移动。
        // 均匀 ±1 偏移会被判为缺/伪轮，但 makeGlobalSlidingDrafts 同时会从整体滑动匹配
        // 生成 wholeSeriesMove 候选，故整条移动仍能被覆盖。
        const patternType: PropagationPatternType = absLag === 1
            ? dominantLag < 0
                ? "possibleMissingYear"
                : "possibleFalseYear"
            : absLag > 1 && ratio >= 0.6
                ? "possibleWholeSeriesMove"
                : newerNormalExists
                    ? "possiblePartialRangeMove"
                    : "possibleWholeSeriesMove";
        const affectedSide: PropagationAffectedSide = patternType === "possibleWholeSeriesMove"
            ? "whole"
            : "older";

        const meanSegConfidence = cluster.reduce((sum, segment) => sum + segment.confidence, 0) / cluster.length;
        // lagConsistency 偏低时降低 confidence，但不直接丢弃（仍生成候选，交给 evaluation hard gate）。
        const confidence = clamp01(meanSegConfidence * (0.5 + 0.5 * lagConsistency));

        patterns.push({
            seriesId: targetTree,
            targetTree,
            lag: dominantLag,
            dominantLag,
            lagConsistency,
            lagVotes,
            affectedSegments: cluster.map((segment) => ({
                startYear: segment.startYear,
                endYear: segment.endYear,
                flag: segment.flag,
            })),
            newerBoundaryYear: Math.min(targetRange.endYear, affectedEnd),
            olderBoundaryYear: Math.max(targetRange.startYear, affectedStart),
            patternType,
            affectedSide,
            fixedSide: "newer",
            confidence,
            ambiguous: false,
            priority: cluster.length * 10 + Math.round(ratio * 10) + absLag + Math.round(confidence * 5),
        });
        cluster = [];
    };

    bLikeSegments.forEach((segment) => {
        const previous = cluster[cluster.length - 1];
        const adjacent = previous ? segment.startYear <= previous.endYear + 1 : true;
        const sameSign = previous ? Math.sign(previous.bestLag) === Math.sign(segment.bestLag) : true;
        if (!previous || (adjacent && sameSign)) {
            cluster.push(segment);
            return;
        }
        flushCluster();
        cluster.push(segment);
    });
    flushCluster();

    return patterns.sort((a, b) => b.priority - a.priority);
};

const summarizeSegments = (segments: SegmentDiagnosis[]) => {
    const unresolvedA = segments.filter((segment) => segment.flag === "A_like").length;
    const unresolvedB = segments.filter((segment) => segment.flag === "B_like").length;
    return { unresolvedA, unresolvedB };
};

export const diagnoseSeriesCore = (
    siteData: RwlSiteData,
    targetTree: string,
    config: EffectiveDiagnosisConfig,
    preprocess: (series: NumericSeries) => NumericSeries = preprocessSeries,
    preprocessCache?: SeriesPreprocessCache,
    masterOverride?: ScoringMaster,
): SeriesCoreDiagnosis | null => {
    const rawTarget = toNumericSeries(siteData.get(targetTree));
    const targetRange = getRangeForSeries(rawTarget);
    if (!targetRange) return null;

    const master = masterOverride ?? buildScoringMaster(
        siteData,
        targetTree,
        config.referenceConfig,
        preprocess,
        preprocessCache,
    );
    if (master.data.size === 0) return null;

    const target = preprocess(rawTarget);
    const globalSlidingMatch = runGlobalSlidingMatch(target, master.data, {
        seriesId: targetTree,
        lagMin: config.globalLagMin,
        lagMax: config.globalLagMax,
        minOverlap: config.minGlobalOverlap,
    });
    const segments = createSegmentsForSeries(target, config.segmentLength, config.overlap)
        .map((segment) => scanSegment(
            targetTree,
            target,
            master.data,
            segment,
            config,
            globalSlidingMatch.bestGlobalLag,
        ));
    const propagationPatterns = detectPropagationPatterns(targetTree, segments, targetRange);
    const { unresolvedA, unresolvedB } = summarizeSegments(segments);

    return {
        targetTree,
        rawTarget,
        targetRange,
        master,
        segments,
        globalSlidingMatch,
        propagationPatterns,
        unresolvedA,
        unresolvedB,
    };
};

export const createSeriesSummary = (
    diagnosis: SeriesCoreDiagnosis,
    candidateCount: number,
    eventCount: number = 0,
): SeriesDiagnosisSummary => {
    const validCorrelations = diagnosis.segments
        .map((segment) => segment.r0)
        .filter((value): value is number => value !== null);
    const flaggedSegments = diagnosis.segments.filter((segment) => segment.flagged);
    const lagVotes = flaggedSegments.reduce((votes, segment) => {
        if (segment.bestLag !== 0) {
            votes.set(segment.bestLag, (votes.get(segment.bestLag) ?? 0) + 1);
        }
        return votes;
    }, new Map<number, number>());
    const bestLagSuggestion = Array.from(lagVotes.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;

    return {
        tree: diagnosis.targetTree,
        seriesId: diagnosis.targetTree,
        segmentCount: diagnosis.segments.length,
        flaggedSegmentCount: flaggedSegments.length,
        unresolvedA: diagnosis.unresolvedA,
        unresolvedB: diagnosis.unresolvedB,
        bestLagSuggestion,
        meanCorrelation: validCorrelations.length
            ? validCorrelations.reduce((sum, value) => sum + value, 0) / validCorrelations.length
            : null,
        worstCorrelation: validCorrelations.length ? Math.min(...validCorrelations) : null,
        candidateCount,
        eventCount,
        propagationPatternCount: diagnosis.propagationPatterns.length,
    };
};

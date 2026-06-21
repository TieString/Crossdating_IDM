/**
 * 分段诊断与单条序列的核心诊断。
 * 这里负责窗口切分后的 lag 搜索、A/B-like 标记、传播模式识别，以及单条序列摘要。
 */
import { CrossdateConfig } from "./config";
import { runGlobalSlidingMatch } from "./sliding";
import {
    buildScoringMaster,
    correlationForSegment,
    createSegmentsForSeries,
    getRangeForSeries,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import type {
    EffectiveDiagnosisConfig,
    NumericSeries,
    PropagationPattern,
    PropagationPatternType,
    SegmentDiagnosis,
    SegmentDiagnosisFlag,
    SeriesCoreDiagnosis,
    SeriesDiagnosisSummary,
    YearRange,
} from "./types";
import type { RwlSiteData } from "@/features/rwl/types";

const scanSegment = (
    targetTree: string,
    target: NumericSeries,
    master: NumericSeries,
    segment: YearRange,
    config: EffectiveDiagnosisConfig,
): SegmentDiagnosis => {
    const current = correlationForSegment(
        target,
        master,
        segment.startYear,
        segment.endYear,
        0,
        config.minPairsForCorrelation,
    );
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

    const improvement = bestCorrelation === null ? 0 : bestCorrelation - (current.correlation ?? -1);
    const lowCorrelation = current.correlation !== null && current.correlation < config.lowCorrelationThreshold;
    const lagLooksBetter = bestLag !== 0 && improvement >= config.lagImprovementThreshold;
    const weakEvidence = current.samplePairs < config.minPairsForCorrelation;
    const flag: SegmentDiagnosisFlag = weakEvidence
        ? "none"
        : lagLooksBetter
            ? "B_like"
            : lowCorrelation
                ? "A_like"
                : "none";
    const reason = weakEvidence
        ? "样本对不足，暂不判定"
        : flag === "B_like"
            ? `B-like：lag ${bestLag > 0 ? "+" : ""}${bestLag} 相关更高`
            : flag === "A_like"
                ? "A-like：当前分段相关偏低，未发现更好的整体 lag"
                : "未发现明显问题";

    return {
        targetTree,
        seriesId: targetTree,
        startYear: segment.startYear,
        endYear: segment.endYear,
        r0: current.correlation,
        bestLag,
        bestR: bestCorrelation,
        flag,
        sampleSize: bestPairs,
        currentCorrelation: current.correlation,
        bestCorrelation,
        samplePairs: bestPairs,
        flagged: flag !== "none",
        reason,
    };
};

const detectPropagationPatterns = (
    targetTree: string,
    segments: SegmentDiagnosis[],
    targetRange: YearRange,
): PropagationPattern[] => {
    const lagGroups = new Map<number, SegmentDiagnosis[]>();

    segments.forEach((segment) => {
        if (segment.flag !== "B_like" || segment.bestLag === 0) return;
        const group = lagGroups.get(segment.bestLag);
        if (group) {
            group.push(segment);
        } else {
            lagGroups.set(segment.bestLag, [segment]);
        }
    });

    const patterns: PropagationPattern[] = [];

    lagGroups.forEach((group, lag) => {
        const sorted = [...group].sort((a, b) => a.startYear - b.startYear);
        let cluster: SegmentDiagnosis[] = [];
        const flushCluster = () => {
            if (cluster.length < CrossdateConfig.minPropagationSegments) {
                cluster = [];
                return;
            }

            const affectedStart = Math.min(...cluster.map((segment) => segment.startYear));
            const affectedEnd = Math.max(...cluster.map((segment) => segment.endYear));
            const ratio = cluster.length / Math.max(1, segments.length);
            const newerNormalExists = segments.some((segment) => (
                segment.startYear > affectedEnd
                && segment.flag !== "B_like"
            ));
            const absLag = Math.abs(lag);
            const patternType: PropagationPatternType = absLag === 1
                ? lag < 0
                    ? "possibleMissingYear"
                    : "possibleFalseYear"
                : absLag > 1 && ratio >= 0.6
                    ? "possibleWholeSeriesMove"
                    : newerNormalExists
                        ? "possiblePartialRangeMove"
                        : "possibleWholeSeriesMove";

            patterns.push({
                seriesId: targetTree,
                targetTree,
                lag,
                affectedSegments: cluster.map((segment) => ({
                    startYear: segment.startYear,
                    endYear: segment.endYear,
                    flag: segment.flag,
                })),
                newerBoundaryYear: Math.min(targetRange.endYear, affectedEnd),
                olderBoundaryYear: Math.max(targetRange.startYear, affectedStart),
                patternType,
                priority: cluster.length * 10 + Math.round(ratio * 10) + absLag,
            });
            cluster = [];
        };

        sorted.forEach((segment) => {
            const previous = cluster[cluster.length - 1];
            if (!previous || segment.startYear <= previous.endYear + 1) {
                cluster.push(segment);
                return;
            }

            flushCluster();
            cluster.push(segment);
        });
        flushCluster();
    });

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
): SeriesCoreDiagnosis | null => {
    const rawTarget = toNumericSeries(siteData.get(targetTree));
    const targetRange = getRangeForSeries(rawTarget);
    if (!targetRange) return null;

    const master = buildScoringMaster(siteData, targetTree, config.referenceConfig);
    if (master.data.size === 0) return null;

    const target = preprocessSeries(rawTarget);
    const segments = createSegmentsForSeries(target, config.segmentLength, config.overlap)
        .map((segment) => scanSegment(targetTree, target, master.data, segment, config));
    const globalSlidingMatch = runGlobalSlidingMatch(target, master.data, {
        seriesId: targetTree,
        lagMin: config.globalLagMin,
        lagMax: config.globalLagMax,
        minOverlap: config.minGlobalOverlap,
    });
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
        propagationPatternCount: diagnosis.propagationPatterns.length,
    };
};

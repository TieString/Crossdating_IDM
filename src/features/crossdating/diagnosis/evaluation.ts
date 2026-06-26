/**
 * 候选模拟与证据评分。
 * 这里会临时应用候选、重新诊断目标序列，并生成 before/after evidence 与 score。
 */
import {
    deleteYearWithMode,
    insertMissingYearAtSide,
    moveSeriesTailByOffset,
} from "@/features/rwl/edit";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import { CrossdateConfig } from "./config";
import { diagnoseSeriesCore } from "./segments";
import { cloneSiteData, preprocessSeries } from "./series";
import { getLagSupportingSegments } from "./rangeMove";
import { uniqueAlgorithmSources } from "./candidateUtils";
import {
    boundaryAlignmentSharpness,
    countByFlag,
    dominantPatternLag,
    firstDifferenceCorrelation,
    localBoundaryCorrelation,
    localGlk,
    meanAbsLag,
    meanSegmentR,
    wholeSeriesCorrelation,
} from "./evaluationMetrics";
import { getCofechaEvidenceForYear, type CofechaHints } from "./cofechaHints";
import type {
    CandidateDraft,
    CandidateEvaluationDelta,
    CandidateEvidence,
    CandidateMetrics,
    CandidateStrength,
    DeleteFalseYearEvidence,
    DiagnosisCandidateOperation,
    DiagnosisConfidence,
    EffectiveDiagnosisConfig,
    SegmentDiagnosis,
    SeriesCoreDiagnosis,
    YearRange,
} from "./types";

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));
const clamp01 = (value: number): number => clamp(value, 0, 1);

const applyDraftToTree = (
    treeData: RwlTreeData,
    draft: CandidateDraft,
): RwlTreeData | null => {
    if (draft.operationType === "INSERT_MISSING_RING" && draft.targetYear !== undefined && draft.side) {
        return insertMissingYearAtSide(treeData, draft.targetYear, draft.side);
    }

    if (draft.operationType === "DELETE_FALSE_RING" && draft.targetYear !== undefined && draft.side) {
        return deleteYearWithMode(treeData, draft.targetYear, "direct", draft.side);
    }

    if (draft.operationType === "SHIFT_RANGE" && draft.selectedRange && draft.deltaYears) {
        return moveSeriesTailByOffset(
            treeData,
            draft.selectedRange.startYear,
            draft.selectedRange.endYear,
            draft.deltaYears,
        );
    }

    return null;
};

const applyDraftToSiteData = (
    siteData: RwlSiteData,
    draft: CandidateDraft,
): RwlSiteData | null => {
    const treeData = siteData.get(draft.targetTree);
    if (!treeData) return null;

    const updatedTree = applyDraftToTree(treeData, draft);
    if (!updatedTree) return null;

    const next = cloneSiteData(siteData);
    next.set(draft.targetTree, updatedTree);
    return next;
};

const overlapRange = (a: YearRange, b: YearRange): boolean => (
    a.startYear <= b.endYear && b.startYear <= a.endYear
);

const metricsFromSegments = (
    segments: SegmentDiagnosis[],
    fallback: SeriesCoreDiagnosis,
): CandidateMetrics => {
    const usable = segments.length > 0 ? segments : fallback.segments;
    const correlations = usable
        .map((segment) => segment.r0)
        .filter((value): value is number => value !== null);
    const bestCorrelations = usable
        .map((segment) => segment.bestR)
        .filter((value): value is number => value !== null);
    const lagVotes = usable.reduce((votes, segment) => {
        if (segment.bestLag !== 0) {
            votes.set(segment.bestLag, (votes.get(segment.bestLag) ?? 0) + 1);
        }
        return votes;
    }, new Map<number, number>());
    const [bestLag = 0] = Array.from(lagVotes.entries()).sort((a, b) => b[1] - a[1])[0] ?? [];
    const representative = usable.slice().sort((a, b) => (
        Number(b.flag === "B_like") - Number(a.flag === "B_like")
        || Number(b.flag === "A_like") - Number(a.flag === "A_like")
        || Math.abs(b.bestLag) - Math.abs(a.bestLag)
    ))[0];

    return {
        r0: correlations.length
            ? correlations.reduce((sum, value) => sum + value, 0) / correlations.length
            : null,
        bestLag,
        bestR: bestCorrelations.length
            ? bestCorrelations.reduce((sum, value) => sum + value, 0) / bestCorrelations.length
            : null,
        flag: representative?.flag ?? "none",
        unresolvedA: fallback.unresolvedA,
        unresolvedB: fallback.unresolvedB,
        problemSegmentCount: fallback.unresolvedA + fallback.unresolvedB,
    };
};

const getAffectedRange = (draft: CandidateDraft): YearRange => {
    if (draft.selectedRange) return draft.selectedRange;
    if (draft.targetYear !== undefined) {
        return { startYear: draft.targetYear, endYear: draft.targetYear };
    }
    return {
        startYear: draft.sourceSegment.startYear,
        endYear: draft.sourceSegment.endYear,
    };
};

const getNarrowYearBonus = (
    diagnosis: SeriesCoreDiagnosis,
    draft: CandidateDraft,
    config: EffectiveDiagnosisConfig,
): number => {
    if (draft.operationType !== "INSERT_MISSING_RING") return 0;
    const year = draft.targetYear ?? draft.anchorYear;
    const value = diagnosis.master.data.get(year);
    if (value === undefined) return 0;
    if (value <= config.strongNarrowYearThreshold) return 2;
    if (value <= config.narrowYearThreshold) return 1;
    const nearbyValues: number[] = [];
    for (let nearbyYear = year - 3; nearbyYear <= year + 3; nearbyYear += 1) {
        const nearbyValue = diagnosis.master.data.get(nearbyYear);
        if (nearbyValue !== undefined) {
            nearbyValues.push(nearbyValue);
        }
    }
    if (nearbyValues.length >= 3) {
        const localMean = nearbyValues.reduce((sum, nearbyValue) => sum + nearbyValue, 0) / nearbyValues.length;
        const localVariance = nearbyValues.reduce((sum, nearbyValue) => sum + (nearbyValue - localMean) ** 2, 0) / nearbyValues.length;
        const localSd = Math.sqrt(localVariance);
        const localMinimum = Math.min(...nearbyValues);
        if (value === localMinimum && value <= localMean - localSd * 0.5) return 0.5;
    }
    if (value > 0) return -0.5;
    return 0;
};

const confidenceForScore = (
    score: number,
    evidence: CandidateEvidence,
): DiagnosisConfidence => {
    if (score >= 3 || evidence.resolvedSegmentCount >= 3) return "high";
    if (score >= 1 || evidence.resolvedSegmentCount >= 1 || evidence.deltaR0 > 0.08) return "medium";
    return "low";
};

const formatRange = (range: YearRange | undefined): string => (
    range ? `${range.startYear}-${range.endYear}` : "-"
);

export const labelForDraft = (draft: CandidateDraft): string => {
    if (draft.operationType === "INSERT_MISSING_RING") return "插入缺轮";
    if (draft.operationType === "DELETE_FALSE_RING") return "删除伪轮";
    const delta = draft.deltaYears ?? 0;
    return `${draft.mode === "wholeSeriesMove" ? "整条移动" : "分段移动"} ${delta > 0 ? "+" : ""}${delta} 年`;
};

const formatR = (value: number | null | undefined): string => (
    value === null || value === undefined ? "-" : value.toFixed(3)
);

const formatLag = (value: number | null): string => (value === null ? "—" : `${value}`);

/**
 * 候选解释：明确操作类型、固定侧/受影响侧，并给出 before/after 诊断变化。
 */
const buildEvidenceExplanation = (
    draft: CandidateDraft,
    delta: CandidateEvaluationDelta,
    editYear: number,
    cofechaHintScore: number,
): string => {
    const diag = `编辑后 B-like 问题段 ${delta.bLikeCountBefore} → ${delta.bLikeCountAfter}`
        + `，dominantLag ${formatLag(delta.dominantLagBefore)} → ${formatLag(delta.dominantLagAfter)}`
        + `，整体相关 ${formatR(delta.wholeSeriesRBefore)} → ${formatR(delta.wholeSeriesRAfter)}`;
    const propagationNote = delta.propagationResolved
        ? "；传播模式已消失"
        : delta.propagationWeakened
            ? "；传播模式减弱"
            : "";
    const cofechaNote = cofechaHintScore > 0
        ? `；COFECHA 在 ${editYear} 附近给出异常提示`
        : "";

    if (draft.operationType === "INSERT_MISSING_RING") {
        return `建议在 ${editYear} 年插入缺轮 0。固定较新一侧不变，${editYear} 年以前整体偏移一年。${diag}${propagationNote}${cofechaNote}`;
    }
    if (draft.operationType === "DELETE_FALSE_RING") {
        return `建议删除 ${editYear} 年的疑似伪轮。固定较新一侧不变，${editYear} 年以前整体偏移一年。${diag}${propagationNote}${cofechaNote}`;
    }
    const moveLabel = draft.mode === "wholeSeriesMove" ? "整条序列" : "较老一侧";
    return `${moveLabel} ${formatRange(draft.selectedRange)} 移动 ${draft.deltaYears} 年。${diag}${propagationNote}`;
};

export const evaluateDraft = (
    siteData: RwlSiteData,
    beforeDiagnosis: SeriesCoreDiagnosis,
    draft: CandidateDraft,
    config: EffectiveDiagnosisConfig,
    cofechaHints?: CofechaHints | null,
): DiagnosisCandidateOperation | null => {
    const nextData = applyDraftToSiteData(siteData, draft);
    if (!nextData) return null;

    const afterDiagnosis = diagnoseSeriesCore(nextData, draft.targetTree, config);
    if (!afterDiagnosis) return null;

    const affectedRange = getAffectedRange(draft);
    const beforeAffected = beforeDiagnosis.segments.filter((segment) => (
        overlapRange(affectedRange, segment)
        || draft.sourcePattern?.affectedSegments.some((affected) => (
            affected.startYear === segment.startYear && affected.endYear === segment.endYear
        ))
    ));
    const afterAffected = afterDiagnosis.segments.filter((segment) => overlapRange(affectedRange, segment));
    const before = metricsFromSegments(beforeAffected, beforeDiagnosis);
    const after = metricsFromSegments(afterAffected, afterDiagnosis);
    const resolvedSegmentCount = Math.max(0, before.problemSegmentCount - after.problemSegmentCount);
    const propagationResolutionBonus = draft.sourcePattern
        ? Math.max(0, draft.sourcePattern.affectedSegments.length - after.unresolvedB)
        : 0;
    const narrowYearBonus = getNarrowYearBonus(beforeDiagnosis, draft, config);
    const gapPenalty = draft.operationType === "SHIFT_RANGE"
        ? 0
        : Math.max(0, Math.abs((draft.targetYear ?? draft.anchorYear) - draft.anchorYear) * 0.05);
    const movePenalty = draft.operationType === "SHIFT_RANGE"
        ? Math.abs(draft.deltaYears ?? 0) * 0.08
        : 0;
    const affectedSegments = beforeAffected.map((segment) => {
        const afterSegment = afterAffected.find((candidate) => (
            overlapRange(segment, candidate)
        ));
        return {
            startYear: segment.startYear,
            endYear: segment.endYear,
            beforeLag: segment.bestLag,
            afterLag: afterSegment?.bestLag ?? 0,
        };
    });
    const algorithmSource = uniqueAlgorithmSources([
        ...(draft.algorithmSource ?? ["segmented_diagnosis"]),
        draft.sourcePattern ? "propagation_pattern" : undefined,
        draft.globalSlidingMatch ? "global_sliding_match" : undefined,
        draft.localEditAlignment ? "local_edit_alignment" : undefined,
    ]);
    const globalSliding = draft.globalSlidingMatch
        ? {
            beforeR: draft.globalSlidingMatch.currentR,
            afterR: afterDiagnosis.globalSlidingMatch.currentR,
            bestGlobalLag: draft.globalSlidingMatch.bestGlobalLag,
            bestGlobalTLike: draft.globalSlidingMatch.bestGlobalTLike,
            overlapYears: draft.globalSlidingMatch.overlapYears,
            currentOverlapYears: draft.globalSlidingMatch.currentOverlapYears,
            supportingSegmentCount: getLagSupportingSegments(
                beforeDiagnosis.segments,
                draft.globalSlidingMatch.bestGlobalLag,
            ).length,
        }
        : undefined;
    const partialRangeMove = draft.partialRangeMoveEvidence
        ? {
            ...draft.partialRangeMoveEvidence,
            afterUnresolvedA: afterDiagnosis.unresolvedA,
            afterUnresolvedB: afterDiagnosis.unresolvedB,
        }
        : undefined;
    // ── 改进 3/4：基于整条 before/after 重诊断计算硬证据 delta ──
    const evalCfg = CrossdateConfig.evaluationV2;
    const radius = evalCfg.localWindowRadius;
    const masterData = beforeDiagnosis.master.data;
    const beforeTarget = preprocessSeries(beforeDiagnosis.rawTarget);
    const afterTarget = preprocessSeries(afterDiagnosis.rawTarget);
    const editYear = draft.targetYear
        ?? (draft.selectedRange ? draft.selectedRange.endYear : draft.anchorYear);

    const meanSegmentRBefore = meanSegmentR(beforeDiagnosis.segments);
    const meanSegmentRAfter = meanSegmentR(afterDiagnosis.segments);
    const bLikeCountBefore = countByFlag(beforeDiagnosis.segments, "B_like");
    const bLikeCountAfter = countByFlag(afterDiagnosis.segments, "B_like");
    const aLikeCountBefore = countByFlag(beforeDiagnosis.segments, "A_like");
    const aLikeCountAfter = countByFlag(afterDiagnosis.segments, "A_like");
    const propagationCountBefore = beforeDiagnosis.propagationPatterns.length;
    const propagationCountAfter = afterDiagnosis.propagationPatterns.length;
    const dominantLagBefore = dominantPatternLag(beforeDiagnosis.propagationPatterns);
    const dominantLagAfter = dominantPatternLag(afterDiagnosis.propagationPatterns);
    const wholeSeriesRBefore = wholeSeriesCorrelation(beforeTarget, masterData, config.minPairsForCorrelation);
    const wholeSeriesRAfter = wholeSeriesCorrelation(afterTarget, masterData, config.minPairsForCorrelation);
    // 整条一阶差分相关（高通，对“是否完全对齐”敏感）：
    // 用编辑后的绝对值奖励“完整对齐”，避免只对齐强信号老区、却留下未对齐段的候选得高分。
    const afterRange = afterDiagnosis.targetRange;
    const firstDiffWholeAfter = firstDifferenceCorrelation(
        afterTarget,
        masterData,
        afterRange.startYear,
        afterRange.endYear,
        config.minPairsForCorrelation,
    ) ?? 0;
    const localBoundaryRBefore = localBoundaryCorrelation(beforeTarget, masterData, editYear, radius, config.minPairsForCorrelation);
    const localBoundaryRAfter = localBoundaryCorrelation(afterTarget, masterData, editYear, radius, config.minPairsForCorrelation);
    const localGlkBefore = localGlk(beforeTarget, masterData, editYear, radius);
    const localGlkAfter = localGlk(afterTarget, masterData, editYear, radius);

    const bLikeResolvedCount = Math.max(0, bLikeCountBefore - bLikeCountAfter);
    const propagationResolved = propagationCountAfter < propagationCountBefore;
    const propagationWeakened = (
        dominantLagBefore !== null
        && (dominantLagAfter === null || Math.abs(dominantLagAfter) < Math.abs(dominantLagBefore))
    );
    const meanAbsLagBefore = meanAbsLag(beforeDiagnosis.segments);
    const meanAbsLagAfter = meanAbsLag(afterDiagnosis.segments);
    const lagRecoveryScore = meanAbsLagBefore > 0
        ? clamp01((meanAbsLagBefore - meanAbsLagAfter) / meanAbsLagBefore)
        : 0;
    const wholeSeriesRDelta = wholeSeriesRAfter - wholeSeriesRBefore;
    const localBoundaryRDelta = (localBoundaryRBefore !== null && localBoundaryRAfter !== null)
        ? localBoundaryRAfter - localBoundaryRBefore
        : null;
    const localGlkDelta = (localGlkBefore !== null && localGlkAfter !== null)
        ? localGlkAfter - localGlkBefore
        : null;

    // 新增更强问题：编辑后在之前 clean（无 B-like）区域出现高置信 B-like 段。
    const beforeBLikeSegments = beforeDiagnosis.segments.filter((segment) => segment.flag === "B_like");
    const introducedNewStrongProblem = afterDiagnosis.segments.some((segment) => (
        segment.flag === "B_like"
        && segment.confidence >= 0.5
        && !beforeBLikeSegments.some((before) => overlapRange(before, segment))
    ));

    // Hard gate：至少满足 minHardGateConditions 项才允许进入最终候选。
    const hardGateConditions = [
        meanSegmentRAfter > meanSegmentRBefore,
        bLikeCountAfter < bLikeCountBefore,
        propagationResolved || propagationWeakened,
        lagRecoveryScore > 0,
        wholeSeriesRAfter >= wholeSeriesRBefore - evalCfg.wholeSeriesRTolerance,
        localBoundaryRDelta !== null && localBoundaryRDelta > 0,
        !introducedNewStrongProblem,
    ];
    const hardGatePassedConditions = hardGateConditions.filter(Boolean).length;
    const hardGatePassed = hardGatePassedConditions >= evalCfg.minHardGateConditions;

    const evaluationDelta: CandidateEvaluationDelta = {
        meanSegmentRBefore,
        meanSegmentRAfter,
        meanSegmentRDelta: meanSegmentRAfter - meanSegmentRBefore,
        bLikeCountBefore,
        bLikeCountAfter,
        bLikeResolvedCount,
        aLikeCountBefore,
        aLikeCountAfter,
        propagationCountBefore,
        propagationCountAfter,
        propagationResolved,
        propagationWeakened,
        dominantLagBefore,
        dominantLagAfter,
        lagRecoveryScore,
        wholeSeriesRBefore,
        wholeSeriesRAfter,
        wholeSeriesRDelta,
        localBoundaryRBefore,
        localBoundaryRAfter,
        localBoundaryRDelta,
        localGlkBefore,
        localGlkAfter,
        localGlkDelta,
        introducedNewStrongProblem,
        hardGatePassedConditions,
        hardGatePassed,
    };

    // Hard gate 未通过：通常丢弃；但若 HMM 边界后验很高（强证据），保留为 weak 候选用于 top5
    // 复查（不会被自动推荐，分数封顶）。这就是 weak-candidate 保护，用于召回而不牺牲 clean 假阳性。
    const rerankCfg = CrossdateConfig.bayesian.rerank;
    const bayesianPosterior = draft.bayesianPosterior ?? 0;
    const isWeakProtected = !hardGatePassed
        && bayesianPosterior >= rerankCfg.weakHmmPosteriorFloor
        && !introducedNewStrongProblem;
    if (!hardGatePassed && !isWeakProtected) return null;
    const candidateStrength: CandidateStrength = hardGatePassed ? "strong" : "weak";

    const deleteEvidence: DeleteFalseYearEvidence | undefined = draft.operationType === "DELETE_FALSE_RING"
        ? {
            candidateYear: editYear,
            boundaryDistance: Math.abs(editYear - draft.anchorYear),
            beforeBLikeCount: bLikeCountBefore,
            afterBLikeCount: bLikeCountAfter,
            bLikeResolvedCount,
            beforeDominantLag: dominantLagBefore,
            afterDominantLag: dominantLagAfter,
            lagMovedTowardZero: dominantLagBefore !== null
                && (dominantLagAfter === null || Math.abs(dominantLagAfter) < Math.abs(dominantLagBefore)),
            beforeWholeSeriesR: wholeSeriesRBefore,
            afterWholeSeriesR: wholeSeriesRAfter,
            beforeLocalR: localBoundaryRBefore,
            afterLocalR: localBoundaryRAfter,
            beforeLocalGlk: localGlkBefore,
            afterLocalGlk: localGlkAfter,
            introducedNewPropagation: introducedNewStrongProblem,
        }
        : undefined;

    const cofechaHintScore = cofechaHints
        ? Math.min(1, getCofechaEvidenceForYear(cofechaHints, editYear, draft.targetTree))
        : 0;

    const evidenceBase: Omit<CandidateEvidence, "explanation"> = {
        before,
        after,
        deltaR0: (after.r0 ?? -1) - (before.r0 ?? -1),
        deltaBestR: (after.bestR ?? -1) - (before.bestR ?? -1),
        resolvedSegmentCount,
        propagationResolutionBonus,
        narrowYearBonus,
        gapPenalty,
        movePenalty,
        affectedYears: affectedRange,
        affectedSegments,
        selectedRange: draft.selectedRange,
        missingRange: draft.missingRange,
        deltaYears: draft.deltaYears,
        deletedValue: draft.operationType === "DELETE_FALSE_RING" && draft.targetYear !== undefined
            ? siteData.get(draft.targetTree)?.get(draft.targetYear) ?? null
            : undefined,
        algorithmSource,
        globalSliding,
        localEditAlignment: draft.localEditAlignment,
        partialRangeMove,
        evaluationDelta,
        deleteEvidence,
        cofechaHintScore,
        bayesianPosterior,
        bayesianSupportScales: draft.bayesianSupportScales,
        recallSourceTags: draft.recallSourceTags,
        candidateStrength,
    };
    const evidence: CandidateEvidence = {
        ...evidenceBase,
        explanation: buildEvidenceExplanation(draft, evaluationDelta, editYear, cofechaHintScore),
    };

    // ── 新评分公式（局部边界改进只在 hard gate 通过后计入，权重 ×1.5）──
    const w = evalCfg.weights;
    const normalizedSegmentImprovement = clamp(evaluationDelta.meanSegmentRDelta / 0.10, -2, 2);
    const propagationResolutionScore = clamp(
        (propagationResolved ? 1 : 0)
        + (propagationWeakened ? 0.5 : 0)
        + (bLikeCountBefore > 0 ? bLikeResolvedCount / bLikeCountBefore : 0),
        0,
        2,
    );
    const wholeSeriesImprovementScore = clamp(wholeSeriesRDelta / 0.10, -2, 2);
    const localBoundaryImprovementScore = localBoundaryRDelta !== null
        ? clamp(localBoundaryRDelta / 0.10, 0, 2)
        : 0;
    const localGlkImprovementScore = localGlkDelta !== null ? clamp(localGlkDelta / 0.10, -1, 1) : 0;
    const narrowRingEvidence = clamp01(narrowYearBonus / 2);
    const editCount = draft.localEditAlignment ? Math.max(0, draft.localEditAlignment.edits.length - 1) : 0;
    const editCountPenalty = clamp(editCount, 0, 2);
    const distanceFromBoundaryPenalty = draft.operationType === "SHIFT_RANGE"
        ? 0
        : clamp(Math.abs(editYear - draft.anchorYear) * 0.05, 0, 1);
    const rangeMoveDistancePenalty = draft.operationType === "SHIFT_RANGE"
        ? clamp(Math.abs(draft.deltaYears ?? 0) * 0.1, 0, 1)
        : 0;
    // 删除伪轮的边界对齐锐度：把真值顶到 top1。insert 不在 eval 叠加锐度——其 argmax 有偏移，
    // 任何权重都会把排名带偏（实测降 top1/whole）；insert 精确定位由 prescan 完成。
    const boundarySharpness = draft.operationType === "DELETE_FALSE_RING"
        ? Math.max(0, boundaryAlignmentSharpness(beforeTarget, masterData, editYear, 1))
        : 0;
    // 缺轮专用较新侧错位带判别（见 config newerSideInsertAlignment）：插得过老(Y'<真值)会在
    // 紧邻候选较新侧 (Y',真值] 留下未修正的错位带，该带在编辑后偏好 lag-1（仍 +1 错位）；
    // 真值年较新侧完全对齐、偏好 lag0。用“较新侧短窗 lag0 一阶差分相关 − lag-1 相关”的对比区分，
    // 真值得正、太老候选得负。仅 insert，对整条移动序列其较新侧本就错位、拿不到此奖励。
    const newerSideInsertAlignment = (() => {
        if (draft.operationType !== "INSERT_MISSING_RING") return 0;
        const W = 12;
        const minPairs = 5;
        // 要求两侧窗口完整落在序列内：排除近端点 insert（整条移动的近末端 insert 较新侧窗超出序列、
        // 会白拿较老侧奖励盖过 wholeMove）。真实缺轮年都距端点≥15 年，窗 W=12 完整，不受影响。
        if (editYear - W < afterRange.startYear || editYear + W > afterRange.endYear) return 0;
        // 较新侧应偏好 lag0（太老候选在此留 lag-1 错位带）。
        const newer0 = firstDifferenceCorrelation(afterTarget, masterData, editYear + 1, editYear + W, minPairs, 0);
        const newerBack = firstDifferenceCorrelation(afterTarget, masterData, editYear + 1, editYear + W, minPairs, -1);
        // 较老侧应偏好 lag0（太新候选过校正、在此留 lag+1 错位带）。
        const older0 = firstDifferenceCorrelation(afterTarget, masterData, editYear - W, editYear - 1, minPairs, 0);
        const olderFwd = firstDifferenceCorrelation(afterTarget, masterData, editYear - W, editYear - 1, minPairs, 1);
        // 要求两侧都有足够数据：否则近末端 insert（较新侧过短）会白拿单侧较老奖励、盖过整条移动。
        if (newer0 === null || newerBack === null || older0 === null || olderFwd === null) return 0;
        const newerContrast = newer0 - newerBack;
        const olderContrast = older0 - olderFwd;
        // 较新侧门控：较新侧仍偏好移位(lag-1)= 整条移动残留/插得过老，直接不奖励（保住 wholeMove）。
        if (newerContrast < -0.05) return 0;
        // 通过门控后两侧求和：较新侧正区分太老，较老侧正区分太新（过校正），真值年两侧都正、净分最高。
        return Math.max(0, newerContrast + olderContrast);
    })();

    // HMM 边界后验与多源召回证据（重排信号）：把贝叶斯强支持的候选适度上提。
    const recallSourceCount = draft.recallSourceTags ? new Set(draft.recallSourceTags).size : 0;
    const baseScore = (
        w.segmentImprovement * normalizedSegmentImprovement
        + w.propagationResolution * propagationResolutionScore
        + w.lagRecovery * lagRecoveryScore
        + w.wholeSeriesImprovement * wholeSeriesImprovementScore
        + w.afterFirstDiffAlignment * Math.max(0, firstDiffWholeAfter)
        - w.residualProblem * bLikeCountAfter
        + w.boundarySharpness * boundarySharpness
        + w.newerSideInsertAlignment * newerSideInsertAlignment
        + rerankCfg.wHmmBoundaryPosterior * bayesianPosterior
        + rerankCfg.wRecallSourceCount * Math.min(1, recallSourceCount / 3)
        + w.localBoundaryImprovement * localBoundaryImprovementScore
        + w.localGlkImprovement * localGlkImprovementScore
        + w.narrowRingEvidence * narrowRingEvidence
        + w.cofechaHintEvidence * cofechaHintScore
        - w.newProblemPenalty * (introducedNewStrongProblem ? 1 : 0)
        - w.editCountPenalty * editCountPenalty
        - w.distanceFromBoundaryPenalty * distanceFromBoundaryPenalty
        - w.rangeMoveDistancePenalty * rangeMoveDistancePenalty
    );
    // weak 候选分数封顶，保证不超过 strong 候选自动占据 top1。
    const score = candidateStrength === "weak"
        ? Math.min(baseScore, rerankCfg.weakScoreCap)
        : baseScore;

    const id = [
        draft.targetTree,
        draft.candidateType,
        draft.mode ?? "",
        draft.anchorYear,
        draft.targetYear ?? "",
        draft.selectedRange?.startYear ?? "",
        draft.selectedRange?.endYear ?? "",
        draft.deltaYears ?? "",
        draft.side ?? "",
    ].join(":");

    return {
        id,
        targetTree: draft.targetTree,
        seriesId: draft.targetTree,
        operationType: draft.operationType,
        candidateType: draft.candidateType,
        mode: draft.mode,
        status: "suggested",
        segmentStartYear: draft.sourceSegment.startYear,
        segmentEndYear: draft.sourceSegment.endYear,
        anchorYear: draft.anchorYear,
        targetYear: draft.targetYear,
        selectedRange: draft.selectedRange,
        missingRange: draft.missingRange,
        deltaYears: draft.deltaYears,
        suggestedLag: draft.deltaYears ?? draft.sourceSegment.bestLag,
        currentCorrelation: before.r0,
        expectedCorrelation: after.r0,
        delta: evidence.deltaR0,
        score,
        candidateScore: score,
        probabilityLike: 0,
        rank: 0,
        confidence: confidenceForScore(score, evidence),
        confidenceLevel: confidenceForScore(score, evidence),
        candidateStrength,
        ambiguous: false,
        lowConfidence: false,
        algorithmSource,
        side: draft.side,
        shift: draft.deltaYears,
        label: labelForDraft(draft),
        reason: evidence.explanation,
        evidence,
    };
};

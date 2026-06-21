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
import { cloneSiteData } from "./series";
import { getLagSupportingSegments } from "./rangeMove";
import { uniqueAlgorithmSources } from "./candidateUtils";
import type {
    CandidateDraft,
    CandidateEvidence,
    CandidateMetrics,
    DiagnosisCandidateOperation,
    DiagnosisConfidence,
    EffectiveDiagnosisConfig,
    SegmentDiagnosis,
    SeriesCoreDiagnosis,
    YearRange,
} from "./types";

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

const buildEvidenceExplanation = (
    draft: CandidateDraft,
    evidence: Omit<CandidateEvidence, "explanation">,
): string => {
    if (draft.operationType === "INSERT_MISSING_RING") {
        return `在 ${draft.targetYear} 插入 width=0；问题段 ${evidence.before.problemSegmentCount} → ${evidence.after.problemSegmentCount}，bestLag ${evidence.before.bestLag} → ${evidence.after.bestLag}`;
    }
    if (draft.operationType === "DELETE_FALSE_RING") {
        return `删除 ${draft.targetYear} 的疑似伪轮；问题段 ${evidence.before.problemSegmentCount} → ${evidence.after.problemSegmentCount}，deletedValue=${evidence.deletedValue ?? "-"}`;
    }
    return `${draft.mode === "wholeSeriesMove" ? "整条序列" : "较老一侧"} ${formatRange(draft.selectedRange)} 移动 ${draft.deltaYears} 年；unresolved A/B ${evidence.before.unresolvedA}/${evidence.before.unresolvedB} → ${evidence.after.unresolvedA}/${evidence.after.unresolvedB}`;
};

export const evaluateDraft = (
    siteData: RwlSiteData,
    beforeDiagnosis: SeriesCoreDiagnosis,
    draft: CandidateDraft,
    config: EffectiveDiagnosisConfig,
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
    };
    const evidence: CandidateEvidence = {
        ...evidenceBase,
        explanation: buildEvidenceExplanation(draft, evidenceBase),
    };
    const baseScore = (
        CrossdateConfig.scoringWeights.correlationGain * evidence.deltaR0
        + CrossdateConfig.scoringWeights.flagResolution * evidence.resolvedSegmentCount
        + CrossdateConfig.scoringWeights.propagation * evidence.propagationResolutionBonus
        + CrossdateConfig.scoringWeights.narrowYear * evidence.narrowYearBonus
        - CrossdateConfig.scoringWeights.gapPenalty * evidence.gapPenalty
        - CrossdateConfig.scoringWeights.movePenalty * evidence.movePenalty
    );
    const globalSlidingBonus = evidence.globalSliding
        ? Math.max(0, (evidence.globalSliding.afterR ?? -1) - (evidence.globalSliding.beforeR ?? -1)) * 4
            + Math.min(2, Math.max(0, (evidence.globalSliding.bestGlobalTLike ?? 0) / 5))
            + Math.min(1.5, evidence.globalSliding.supportingSegmentCount * 0.4)
        : 0;
    const localEditBonus = evidence.localEditAlignment
        ? (
            evidence.localEditAlignment.method === "banded_edit_dp" ? 0.6 : 0.15
        ) + Math.min(1, Math.max(0, evidence.localEditAlignment.pathScore / 40))
        : 0;
    const partialRangeBonus = evidence.partialRangeMove
        ? Math.max(0, evidence.partialRangeMove.beforeUnresolvedB - evidence.partialRangeMove.afterUnresolvedB) * 0.5
        : 0;
    const score = baseScore + globalSlidingBonus + localEditBonus + partialRangeBonus;

    if (
        score <= -0.75
        && evidence.resolvedSegmentCount === 0
        && evidence.propagationResolutionBonus === 0
        && evidence.deltaR0 <= 0
    ) {
        return null;
    }

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

/**
 * 候选结果工具。
 * 这里负责候选来源去重、排序、相对置信度、可执行性和 stale/batch 状态处理。
 */
import { CrossdateConfig } from "./config";
import type {
    CandidateAlgorithmSource,
    CandidateRankingConfidence,
    DiagnosisBatchSelection,
    DiagnosisCandidateOperation,
    DiagnosisConfidence,
    DiagnosisEvent,
} from "./types";

export const uniqueAlgorithmSources = (
    sources: Array<CandidateAlgorithmSource | undefined>,
): CandidateAlgorithmSource[] => Array.from(new Set(sources.filter((source): source is CandidateAlgorithmSource => Boolean(source))));

const getCandidateEffectKey = (candidate: DiagnosisCandidateOperation): string => {
    if (candidate.operationType === "SHIFT_RANGE") {
        return [
            candidate.targetTree,
            candidate.candidateType,
            candidate.mode,
            candidate.selectedRange?.startYear,
            candidate.selectedRange?.endYear,
            candidate.deltaYears,
        ].join(":");
    }

    return [
        candidate.targetTree,
        candidate.candidateType,
        candidate.targetYear,
        candidate.side,
    ].join(":");
};

export const compareDiagnosisCandidates = (
    a: DiagnosisCandidateOperation,
    b: DiagnosisCandidateOperation,
) => {
    const statusPriority = Number(a.status !== "suggested") - Number(b.status !== "suggested");
    if (statusPriority !== 0) return statusPriority;

    if (a.rank > 0 && b.rank > 0 && a.rank !== b.rank) {
        return a.rank - b.rank;
    }

    const confidenceOrder = { high: 0, medium: 1, low: 2 };
    const confidencePriority = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
    if (confidencePriority !== 0) return confidencePriority;

    const scorePriority = b.score - a.score;
    if (scorePriority !== 0) return scorePriority;

    const resolvedPriority = b.evidence.resolvedSegmentCount - a.evidence.resolvedSegmentCount;
    if (resolvedPriority !== 0) return resolvedPriority;

    return a.targetTree.localeCompare(b.targetTree)
        || a.segmentStartYear - b.segmentStartYear
        || (a.targetYear ?? a.anchorYear) - (b.targetYear ?? b.anchorYear)
        || a.candidateType.localeCompare(b.candidateType);
};

export const rankDiagnosisCandidates = (
    candidates: DiagnosisCandidateOperation[],
): DiagnosisCandidateOperation[] => {
    if (candidates.length === 0) return [];

    const sorted = [...candidates].sort((a, b) => (
        b.score - a.score
        || b.evidence.resolvedSegmentCount - a.evidence.resolvedSegmentCount
        || a.targetTree.localeCompare(b.targetTree)
        || a.segmentStartYear - b.segmentStartYear
    ));
    const temperature = Math.max(0.001, CrossdateConfig.candidateRanking.softmaxTemperature);
    const maxScore = Math.max(...sorted.map((candidate) => candidate.score));
    const weights = sorted.map((candidate) => Math.exp((candidate.score - maxScore) / temperature));
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0) || 1;
    const probabilities = weights.map((weight) => weight / weightSum);
    const topProbability = probabilities[0] ?? 0;
    const secondProbability = probabilities[1] ?? 0;
    const ambiguousTop = sorted.length > 1
        && topProbability - secondProbability <= CrossdateConfig.candidateRanking.ambiguousProbabilityGap;
    const lowConfidenceSet = maxScore <= CrossdateConfig.candidateRanking.lowConfidenceMaxScore
        || topProbability <= CrossdateConfig.candidateRanking.lowConfidenceMaxProbability;

    return sorted.map((candidate, index) => {
        const probabilityLike = probabilities[index] ?? 0;
        const rank = index + 1;
        const ambiguous = ambiguousTop && rank <= 2;
        const lowConfidence = lowConfidenceSet || probabilityLike <= CrossdateConfig.candidateRanking.lowConfidenceMaxProbability * 0.5;
        const confidenceLevel: CandidateRankingConfidence = lowConfidence
            ? "low"
            : ambiguous
                ? "ambiguous"
                : probabilityLike >= CrossdateConfig.candidateRanking.highConfidenceMinProbability
                    ? "high"
                    : probabilityLike >= CrossdateConfig.candidateRanking.mediumConfidenceMinProbability
                        ? "medium"
                        : "low";
        const confidence: DiagnosisConfidence = confidenceLevel === "ambiguous"
            ? "medium"
            : confidenceLevel;
        const algorithmSource = uniqueAlgorithmSources([
            ...candidate.algorithmSource,
            ...candidate.evidence.algorithmSource,
            "candidate_ranking",
        ]);

        return {
            ...candidate,
            candidateScore: candidate.score,
            probabilityLike,
            rank,
            confidence,
            confidenceLevel,
            ambiguous,
            lowConfidence,
            algorithmSource,
            rankingMethod: "score_softmax_mvp",
            evidence: {
                ...candidate.evidence,
                algorithmSource,
                rankingMethod: "score_softmax_mvp",
                probabilityLike,
                rank,
                confidenceLevel,
                ambiguous,
                lowConfidence,
            },
        };
    });
};

export const dedupeDiagnosisCandidates = (
    candidates: DiagnosisCandidateOperation[],
): DiagnosisCandidateOperation[] => {
    const bestByEffect = new Map<string, DiagnosisCandidateOperation>();

    candidates.forEach((candidate) => {
        const key = getCandidateEffectKey(candidate);
        const current = bestByEffect.get(key);
        if (!current || compareDiagnosisCandidates(candidate, current) < 0) {
            bestByEffect.set(key, candidate);
        }
    });

    return Array.from(bestByEffect.values());
};

export const getDiagnosisCandidateLabel = (candidate: DiagnosisCandidateOperation): string => {
    if (candidate.label) return candidate.label;
    if (candidate.operationType === "INSERT_MISSING_RING") return "????";
    if (candidate.operationType === "DELETE_FALSE_RING") return "????";
    if (candidate.operationType === "SHIFT_RANGE") {
        const delta = candidate.deltaYears ?? candidate.shift ?? candidate.suggestedLag;
        return `???? ${delta > 0 ? "+" : ""}${delta} ?`;
    }
    return "????";
};

export const isActionableDiagnosisCandidate = (candidate: DiagnosisCandidateOperation): boolean => {
    if (candidate.status !== "suggested") return false;
    if (candidate.operationType === "SHIFT_RANGE") {
        return Boolean(candidate.selectedRange) && Boolean(candidate.deltaYears);
    }
    if (candidate.operationType === "INSERT_MISSING_RING" || candidate.operationType === "DELETE_FALSE_RING") {
        return candidate.targetYear !== undefined && Boolean(candidate.side);
    }
    return false;
};

export const markCandidatesStale = (
    candidates: DiagnosisCandidateOperation[],
): DiagnosisCandidateOperation[] => (
    candidates.map((candidate) => ({ ...candidate, status: "stale" as const }))
);

export const markDiagnosisEventsStale = (
    events: DiagnosisEvent[],
): DiagnosisEvent[] => (
    events.map((event) => ({
        ...event,
        stale: true,
        interpretationAmbiguity: event.interpretationAmbiguity ? {
            ...event.interpretationAmbiguity,
            alternative: {
                ...event.interpretationAmbiguity.alternative,
                interpretationAmbiguity: undefined,
                stale: true,
            },
        } : undefined,
    }))
);

export const selectSafeDiagnosisCandidateBatch = (
    candidates: DiagnosisCandidateOperation[],
): DiagnosisBatchSelection => {
    const actionable = candidates.filter(isActionableDiagnosisCandidate).sort(compareDiagnosisCandidates);
    const selected = actionable.slice(0, 1);
    const selectedIds = new Set(selected.map((candidate) => candidate.id));
    const skipped = candidates
        .filter((candidate) => !selectedIds.has(candidate.id))
        .map((candidate) => ({
            candidateId: candidate.id,
            targetTree: candidate.targetTree,
            label: getDiagnosisCandidateLabel(candidate),
            status: "skipped" as const,
            reason: "MVP ??????????????????????????",
        }));

    return { selected, skipped };
};

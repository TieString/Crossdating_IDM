/**
 * 内部交叉定年诊断流程的共享类型定义。
 * 数据结构集中放在这里，便于算法模块独立演进，同时保持外部入口稳定。
 */
import type { ReferenceSeriesConfig } from "../reference";
import type { DeleteShift, MissingInsertSide } from "@/features/rwl/edit";

export type DiagnosisConfidence = "high" | "medium" | "low";
export type CandidateRankingConfidence = DiagnosisConfidence | "ambiguous";

export type DiagnosisCandidateOperationType =
    | "SHIFT_RANGE"
    | "INSERT_MISSING_RING"
    | "DELETE_FALSE_RING"
    | "MARK_SUSPICIOUS";

export type SegmentDiagnosisFlag = "none" | "A_like" | "B_like";
export type CrossdateCandidateType = "insertMissingYear" | "deleteFalseYear" | "batchMoveYears";
export type BatchMoveMode = "wholeSeriesMove" | "partialRangeMove";
export type CrossdateCandidateStatus = "suggested" | "accepted" | "rejected" | "stale";

export type YearRange = {
    startYear: number;
    endYear: number;
};

export type CandidateAlgorithmSource =
    | "global_sliding_match"
    | "segmented_diagnosis"
    | "propagation_pattern"
    | "local_edit_alignment"
    | "bayesian_lag_path"
    | "cofecha_segment_lag"
    | "ar_prewhiten_recall"
    | "candidate_ranking";

export type CandidateStrength = "strong" | "weak" | "rejected";

export type CandidateRankingMethod = "score_softmax_mvp";

export type GlobalSlidingLagResult = {
    lag: number;
    r: number | null;
    tLike: number | null;
    overlapYears: number;
};

export type GlobalSlidingMatch = {
    seriesId: string;
    lagResults: GlobalSlidingLagResult[];
    bestGlobalLag: number;
    bestGlobalR: number | null;
    bestGlobalTLike: number | null;
    overlapYears: number;
    currentR: number | null;
    currentTLike: number | null;
    currentOverlapYears: number;
};

export type LocalEditAlignmentMethod = "banded_edit_dp" | "fallback_single_edit_scan";
export type LocalEditType = "insertMissingYear" | "deleteFalseYear";

export type LocalEditAlignmentEdit = {
    type: LocalEditType;
    anchorYear: number;
    scoreContribution: number;
    reason: string;
};

export type LocalEditAlignmentResult = {
    seriesId: string;
    windowStartYear: number;
    windowEndYear: number;
    method: LocalEditAlignmentMethod;
    pathScore: number;
    edits: LocalEditAlignmentEdit[];
};

export type GlobalSlidingCandidateEvidence = {
    beforeR: number | null;
    afterR: number | null;
    bestGlobalLag: number;
    bestGlobalTLike: number | null;
    overlapYears: number;
    currentOverlapYears: number;
    supportingSegmentCount: number;
};

export type PartialRangeMoveEvidence = {
    fixedRange?: YearRange;
    selectedRange: YearRange;
    deltaYears: number;
    inferredMissingRange?: YearRange;
    boundaryYear: number;
    olderSideLag: number;
    newerSideMeanLag: number;
    beforeUnresolvedA: number;
    beforeUnresolvedB: number;
    afterUnresolvedA: number;
    afterUnresolvedB: number;
};

export type SegmentDiagnosis = {
    targetTree: string;
    seriesId: string;
    startYear: number;
    endYear: number;
    r0: number | null;
    bestLag: number;
    bestR: number | null;
    flag: SegmentDiagnosisFlag;
    sampleSize: number;
    currentCorrelation: number | null;
    bestCorrelation: number | null;
    samplePairs: number;
    flagged: boolean;
    reason: string;
    // 自适应分类相关的新增字段（向前兼容，UI 可选消费）。
    effectiveN: number;
    t0: number;
    bestT: number;
    tImprovement: number;
    rImprovement: number;
    fisherZ0: number;
    fisherZBest: number;
    fisherZImprovement: number;
    classification: SegmentDiagnosisFlag;
    confidence: number;
};

export type PropagationPatternType =
    | "possibleMissingYear"
    | "possibleFalseYear"
    | "possibleWholeSeriesMove"
    | "possiblePartialRangeMove";

export type PropagationAffectedSide = "older" | "newer" | "whole";

export type PropagationPattern = {
    seriesId: string;
    targetTree: string;
    /** 主导 lag（= dominantLag），保留 lag 字段名以兼容既有 drafts/evaluation 消费。 */
    lag: number;
    dominantLag: number;
    lagConsistency: number;
    lagVotes: Record<number, number>;
    affectedSegments: Array<{ startYear: number; endYear: number; flag: SegmentDiagnosisFlag }>;
    newerBoundaryYear: number;
    olderBoundaryYear: number;
    patternType: PropagationPatternType;
    affectedSide: PropagationAffectedSide;
    fixedSide: "newer";
    confidence: number;
    /** 正负 lag 混杂、无法形成单一 missing/false 模式时标记为 ambiguous，不输出插删年建议。 */
    ambiguous: boolean;
    priority: number;
};

export type CandidateMetrics = {
    r0: number | null;
    bestLag: number;
    bestR: number | null;
    flag: SegmentDiagnosisFlag;
    unresolvedA: number;
    unresolvedB: number;
    problemSegmentCount: number;
};

/**
 * 候选临时应用并重新整条诊断后的 before/after 差量。
 * 这是判断一个候选是否真正“恢复了对应关系”的硬证据，evaluation 的 hard gate 与评分都基于它。
 */
export type CandidateEvaluationDelta = {
    meanSegmentRBefore: number;
    meanSegmentRAfter: number;
    meanSegmentRDelta: number;

    bLikeCountBefore: number;
    bLikeCountAfter: number;
    bLikeResolvedCount: number;

    aLikeCountBefore: number;
    aLikeCountAfter: number;

    propagationCountBefore: number;
    propagationCountAfter: number;
    propagationResolved: boolean;
    propagationWeakened: boolean;

    dominantLagBefore: number | null;
    dominantLagAfter: number | null;
    lagRecoveryScore: number;

    wholeSeriesRBefore: number;
    wholeSeriesRAfter: number;
    wholeSeriesRDelta: number;

    localBoundaryRBefore: number | null;
    localBoundaryRAfter: number | null;
    localBoundaryRDelta: number | null;

    localGlkBefore: number | null;
    localGlkAfter: number | null;
    localGlkDelta: number | null;

    introducedNewStrongProblem: boolean;

    hardGatePassedConditions: number;
    hardGatePassed: boolean;
};

/**
 * deleteFalseYear 候选的删除-恢复证据。核心判断是“删除后对应关系是否恢复”，
 * 而不是“被删值是否极端”。
 */
export type DeleteFalseYearEvidence = {
    candidateYear: number;
    boundaryDistance: number;
    beforeBLikeCount: number;
    afterBLikeCount: number;
    bLikeResolvedCount: number;
    beforeDominantLag: number | null;
    afterDominantLag: number | null;
    lagMovedTowardZero: boolean;
    beforeWholeSeriesR: number;
    afterWholeSeriesR: number;
    beforeLocalR: number | null;
    afterLocalR: number | null;
    beforeLocalGlk: number | null;
    afterLocalGlk: number | null;
    introducedNewPropagation: boolean;
};

export type CandidateEvidence = {
    before: CandidateMetrics;
    after: CandidateMetrics;
    deltaR0: number;
    deltaBestR: number;
    resolvedSegmentCount: number;
    propagationResolutionBonus: number;
    narrowYearBonus: number;
    gapPenalty: number;
    movePenalty: number;
    affectedYears: YearRange;
    affectedSegments: Array<{ startYear: number; endYear: number; beforeLag: number; afterLag: number }>;
    selectedRange?: YearRange;
    missingRange?: YearRange;
    deltaYears?: number;
    deletedValue?: number | null;
    algorithmSource: CandidateAlgorithmSource[];
    globalSliding?: GlobalSlidingCandidateEvidence;
    localEditAlignment?: LocalEditAlignmentResult;
    partialRangeMove?: PartialRangeMoveEvidence;
    evaluationDelta?: CandidateEvaluationDelta;
    deleteEvidence?: DeleteFalseYearEvidence;
    cofechaHintScore?: number;
    bayesianPosterior?: number;
    bayesianSupportScales?: number;
    recallSourceTags?: string[];
    candidateStrength?: CandidateStrength;
    rankingMethod?: CandidateRankingMethod;
    probabilityLike?: number;
    rank?: number;
    confidenceLevel?: CandidateRankingConfidence;
    ambiguous?: boolean;
    lowConfidence?: boolean;
    explanation: string;
};

export type DiagnosisCandidateOperation = {
    id: string;
    targetTree: string;
    seriesId: string;
    operationType: DiagnosisCandidateOperationType;
    candidateType: CrossdateCandidateType;
    mode?: BatchMoveMode;
    status: CrossdateCandidateStatus;
    segmentStartYear: number;
    segmentEndYear: number;
    anchorYear: number;
    targetYear?: number;
    selectedRange?: YearRange;
    missingRange?: YearRange;
    deltaYears?: number;
    // 伪轮/缺轮"范围建议"：同序列同类型候选聚集而成的较小年份窗口，保证真值落在其内（人工流程：
    // COFECHA 给 ~50 年段，算法收窄为这个小窗供人工复核）。仅当候选聚集（窗宽不过大）时给出。
    suggestedRange?: YearRange;
    suggestedLag: number;
    currentCorrelation: number | null;
    expectedCorrelation: number | null;
    delta?: number | null;
    score: number;
    candidateScore: number;
    probabilityLike: number;
    rank: number;
    confidence: DiagnosisConfidence;
    confidenceLevel: CandidateRankingConfidence;
    candidateStrength: CandidateStrength;
    ambiguous: boolean;
    lowConfidence: boolean;
    algorithmSource: CandidateAlgorithmSource[];
    rankingMethod?: CandidateRankingMethod;
    side?: MissingInsertSide | DeleteShift;
    shift?: number;
    label?: string;
    reason: string;
    evidence: CandidateEvidence;
};

export type DiagnosisBatchCandidateStatus = "applied" | "skipped" | "failed";

export type DiagnosisBatchCandidateResult = {
    candidateId: string;
    targetTree: string;
    label: string;
    status: DiagnosisBatchCandidateStatus;
    reason?: string;
};

export type DiagnosisBatchApplyResult = {
    batchId: string;
    createdAt: string;
    requestedCount: number;
    appliedCount: number;
    skippedCount: number;
    failedCount: number;
    results: DiagnosisBatchCandidateResult[];
};

export type DiagnosisBatchSelection = {
    selected: DiagnosisCandidateOperation[];
    skipped: DiagnosisBatchCandidateResult[];
};

export type SeriesDiagnosisSummary = {
    tree: string;
    seriesId: string;
    segmentCount: number;
    flaggedSegmentCount: number;
    unresolvedA: number;
    unresolvedB: number;
    bestLagSuggestion: number;
    meanCorrelation: number | null;
    worstCorrelation: number | null;
    candidateCount: number;
    propagationPatternCount: number;
};

export type ScoringMasterYear = {
    year: number;
    masterValue: number;
    sampleDepth: number;
    narrow: boolean;
    stronglyNarrow: boolean;
};

export type CrossdatingDiagnosis = {
    createdAt: string;
    seriesCount: number;
    problemSegmentCount: number;
    candidateCount: number;
    segmentLength: number;
    overlap: number;
    lagRange: { min: number; max: number };
    lowCorrelationThreshold: number;
    summaries: SeriesDiagnosisSummary[];
    segments: SegmentDiagnosis[];
    propagationPatterns: PropagationPattern[];
    globalSlidingMatches: GlobalSlidingMatch[];
    masterNarrowYears: ScoringMasterYear[];
    candidates: DiagnosisCandidateOperation[];
};

export type LocalSimulationOperationType =
    | "INSERT_MISSING_RING"
    | "DELETE_FALSE_RING"
    | "SHIFT_RANGE"
    | "NO_ACTION";

export type LocalSimulationOption = {
    operationType: LocalSimulationOperationType;
    label: string;
    currentCorrelation: number | null;
    simulatedCorrelation: number | null;
    delta: number | null;
    confidence: DiagnosisConfidence;
    side?: MissingInsertSide | DeleteShift;
    shift?: number;
    reason: string;
};

export type LocalCrossdatingSimulation = {
    targetTree: string;
    year: number;
    segmentStartYear: number;
    segmentEndYear: number;
    samplePairs: number;
    currentCorrelation: number | null;
    bestOption: LocalSimulationOption;
    options: LocalSimulationOption[];
};

export type LocalSimulationApplyRequest = {
    simulation: LocalCrossdatingSimulation;
    option: LocalSimulationOption;
};

export type DiagnosisOptions = {
    referenceConfig?: ReferenceSeriesConfig | null;
    segmentLength?: number;
    overlap?: number;
    fineWindowLength?: number;
    fineOverlap?: number;
    lagMin?: number;
    lagMax?: number;
    lowCorrelationThreshold?: number;
    lagImprovementThreshold?: number;
    narrowYearThreshold?: number;
    strongNarrowYearThreshold?: number;
    maxTopCandidates?: number;
    globalLagMin?: number;
    globalLagMax?: number;
    minGlobalOverlap?: number;
    localEditMaxGaps?: number;
    localEditDiagonalBand?: number;
    minLocalOverlap?: number;
    /** 可选 COFECHA 文本输出，解析为候选证据 hints；不提供时算法照常运行。 */
    cofechaText?: string;
};

export type NumericSeries = Map<number, number>;

export type EffectiveDiagnosisConfig = Required<Omit<DiagnosisOptions, "referenceConfig" | "cofechaText">> & {
    referenceConfig: ReferenceSeriesConfig | null;
    minPairsForCorrelation: number;
};

export type ScoringMaster = {
    data: NumericSeries;
    sampleDepth: Map<number, number>;
    sourceTrees: string[];
};

export type SeriesCoreDiagnosis = {
    targetTree: string;
    rawTarget: NumericSeries;
    targetRange: YearRange;
    master: ScoringMaster;
    segments: SegmentDiagnosis[];
    propagationPatterns: PropagationPattern[];
    globalSlidingMatch: GlobalSlidingMatch;
    unresolvedA: number;
    unresolvedB: number;
};

export type CandidateDraft = {
    targetTree: string;
    operationType: Exclude<DiagnosisCandidateOperationType, "MARK_SUSPICIOUS">;
    candidateType: CrossdateCandidateType;
    mode?: BatchMoveMode;
    anchorYear: number;
    targetYear?: number;
    selectedRange?: YearRange;
    missingRange?: YearRange;
    deltaYears?: number;
    side?: MissingInsertSide | DeleteShift;
    sourceSegment: SegmentDiagnosis;
    sourcePattern?: PropagationPattern;
    algorithmSource?: CandidateAlgorithmSource[];
    globalSlidingMatch?: GlobalSlidingMatch;
    localEditAlignment?: LocalEditAlignmentResult;
    partialRangeMoveEvidence?: Omit<PartialRangeMoveEvidence, "afterUnresolvedA" | "afterUnresolvedB">;
    /** HMM 边界后验（该候选年的 insert/delete 后验，0-1），用于重排。 */
    bayesianPosterior?: number;
    /** 多尺度支持数与召回证据 tags（来源去重后），用于重排与 explanation。 */
    bayesianSupportScales?: number;
    recallSourceTags?: string[];
};

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
    | "candidate_ranking";

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
};

export type PropagationPatternType =
    | "possibleMissingYear"
    | "possibleFalseYear"
    | "possibleWholeSeriesMove"
    | "possiblePartialRangeMove";

export type PropagationPattern = {
    seriesId: string;
    targetTree: string;
    lag: number;
    affectedSegments: Array<{ startYear: number; endYear: number; flag: SegmentDiagnosisFlag }>;
    newerBoundaryYear: number;
    olderBoundaryYear: number;
    patternType: PropagationPatternType;
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
};

export type NumericSeries = Map<number, number>;

export type EffectiveDiagnosisConfig = Required<Omit<DiagnosisOptions, "referenceConfig">> & {
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
};

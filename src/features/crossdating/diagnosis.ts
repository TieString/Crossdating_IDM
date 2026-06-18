import { buildReferenceSeries, type ReferenceSeriesConfig } from "./reference";
import {
    deleteYearWithMode,
    insertMissingYearAtSide,
    moveSeriesTailByOffset,
    type DeleteShift,
    type MissingInsertSide,
} from "@/features/rwl/edit";
import { stopMarker } from "@/shared/constants";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";

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

type NumericSeries = Map<number, number>;

type EffectiveDiagnosisConfig = Required<Omit<DiagnosisOptions, "referenceConfig">> & {
    referenceConfig: ReferenceSeriesConfig | null;
    minPairsForCorrelation: number;
};

type ScoringMaster = {
    data: NumericSeries;
    sampleDepth: Map<number, number>;
    sourceTrees: string[];
};

type SeriesCoreDiagnosis = {
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

type CandidateDraft = {
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

export const CrossdateConfig = {
    windowLength: 50,
    overlap: 25,
    fineWindowLength: 30,
    fineOverlap: 15,
    lagMin: -10,
    lagMax: 10,
    lowCorrelationThreshold: 0.32,
    bestLagImprovementThreshold: 0.08,
    narrowYearThreshold: -1.0,
    strongNarrowYearThreshold: -1.5,
    maxTopCandidates: 5,
    minPairsForCorrelation: 8,
    minPropagationSegments: 2,
    globalLagMin: -50,
    globalLagMax: 50,
    minGlobalOverlap: 25,
    globalRImprovementThreshold: 0.08,
    globalMinTLike: 3.5,
    globalSupportRatio: 0.45,
    localEditAlignment: {
        maxGaps: 2,
        insertPenalty: 1.0,
        deletePenalty: 1.0,
        excessiveEditPenalty: 2.0,
        narrowYearBonus: 0.4,
        strongNarrowYearBonus: 0.8,
        diagonalBand: 3,
        minLocalOverlap: 20,
    },
    candidateRanking: {
        softmaxTemperature: 1.0,
        highConfidenceMinProbability: 0.7,
        mediumConfidenceMinProbability: 0.45,
        ambiguousProbabilityGap: 0.15,
        lowConfidenceMaxProbability: 0.4,
        lowConfidenceMaxScore: 0.75,
    },
    scoringWeights: {
        correlationGain: 7,
        flagResolution: 1.6,
        propagation: 1.2,
        narrowYear: 0.8,
        gapPenalty: 0.35,
        movePenalty: 0.28,
    },
} as const;

const isUsableWidth = (value: number | null | undefined): value is number => (
    typeof value === "number"
    && Number.isFinite(value)
    && value > 0
    && value !== stopMarker.value
);

const getConfig = (options: DiagnosisOptions): EffectiveDiagnosisConfig => {
    const segmentLength = Math.max(10, Math.floor(options.segmentLength ?? CrossdateConfig.windowLength));
    const overlap = Math.max(0, Math.min(segmentLength - 1, Math.floor(options.overlap ?? CrossdateConfig.overlap)));
    const fineWindowLength = Math.max(10, Math.floor(options.fineWindowLength ?? CrossdateConfig.fineWindowLength));
    const fineOverlap = Math.max(0, Math.min(fineWindowLength - 1, Math.floor(options.fineOverlap ?? CrossdateConfig.fineOverlap)));

    return {
        referenceConfig: options.referenceConfig ?? null,
        segmentLength,
        overlap,
        fineWindowLength,
        fineOverlap,
        lagMin: Math.floor(options.lagMin ?? CrossdateConfig.lagMin),
        lagMax: Math.floor(options.lagMax ?? CrossdateConfig.lagMax),
        lowCorrelationThreshold: options.lowCorrelationThreshold ?? CrossdateConfig.lowCorrelationThreshold,
        lagImprovementThreshold: options.lagImprovementThreshold ?? CrossdateConfig.bestLagImprovementThreshold,
        narrowYearThreshold: options.narrowYearThreshold ?? CrossdateConfig.narrowYearThreshold,
        strongNarrowYearThreshold: options.strongNarrowYearThreshold ?? CrossdateConfig.strongNarrowYearThreshold,
        maxTopCandidates: Math.max(1, Math.floor(options.maxTopCandidates ?? CrossdateConfig.maxTopCandidates)),
        globalLagMin: Math.floor(options.globalLagMin ?? CrossdateConfig.globalLagMin),
        globalLagMax: Math.floor(options.globalLagMax ?? CrossdateConfig.globalLagMax),
        minGlobalOverlap: Math.max(3, Math.floor(options.minGlobalOverlap ?? CrossdateConfig.minGlobalOverlap)),
        localEditMaxGaps: Math.max(1, Math.floor(options.localEditMaxGaps ?? CrossdateConfig.localEditAlignment.maxGaps)),
        localEditDiagonalBand: Math.max(1, Math.floor(options.localEditDiagonalBand ?? CrossdateConfig.localEditAlignment.diagonalBand)),
        minLocalOverlap: Math.max(3, Math.floor(options.minLocalOverlap ?? CrossdateConfig.localEditAlignment.minLocalOverlap)),
        minPairsForCorrelation: CrossdateConfig.minPairsForCorrelation,
    };
};

const toNumericSeries = (treeData: RwlTreeData | undefined): NumericSeries => {
    const result = new Map<number, number>();
    treeData?.forEach((value, year) => {
        if (isUsableWidth(value)) {
            result.set(year, value);
        }
    });
    return result;
};

const zScoreSeries = (series: NumericSeries): NumericSeries => {
    const values = Array.from(series.values());
    if (values.length === 0) return new Map();

    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const sd = Math.sqrt(variance);

    if (!Number.isFinite(sd) || sd === 0) {
        return new Map(Array.from(series.keys()).map((year) => [year, 0]));
    }

    return new Map(Array.from(series.entries()).map(([year, value]) => [year, (value - mean) / sd]));
};

const preprocessSeries = (series: NumericSeries): NumericSeries => zScoreSeries(series);

const getRangeForSeries = (series: NumericSeries): YearRange | null => {
    const years = Array.from(series.keys()).sort((a, b) => a - b);
    if (years.length === 0) return null;
    return { startYear: years[0], endYear: years[years.length - 1] };
};

const cloneSiteData = (siteData: RwlSiteData): RwlSiteData => {
    const next = new Map<string, RwlTreeData>();
    siteData.forEach((treeData, tree) => {
        next.set(tree, new Map(treeData));
    });
    return next;
};

const pearson = (pairs: Array<[number, number]>, minPairs: number): number | null => {
    if (pairs.length < minPairs) return null;

    const meanA = pairs.reduce((sum, [a]) => sum + a, 0) / pairs.length;
    const meanB = pairs.reduce((sum, [, b]) => sum + b, 0) / pairs.length;
    let numerator = 0;
    let denominatorA = 0;
    let denominatorB = 0;

    pairs.forEach(([a, b]) => {
        const da = a - meanA;
        const db = b - meanB;
        numerator += da * db;
        denominatorA += da * da;
        denominatorB += db * db;
    });

    const denominator = Math.sqrt(denominatorA * denominatorB);
    if (!Number.isFinite(denominator) || denominator === 0) return null;
    return numerator / denominator;
};

const tLikeForCorrelation = (r: number | null, overlapYears: number): number | null => {
    if (r === null || overlapYears < 3) return null;
    const bounded = Math.max(-0.999999, Math.min(0.999999, r));
    const denominator = 1 - bounded * bounded;
    if (!Number.isFinite(denominator) || denominator <= 0) return null;
    return bounded * Math.sqrt((overlapYears - 2) / denominator);
};

const correlationForSegment = (
    target: NumericSeries,
    master: NumericSeries,
    startYear: number,
    endYear: number,
    lag: number,
    minPairs: number,
) => {
    const pairs: Array<[number, number]> = [];

    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const masterValue = master.get(year + lag);
        if (targetValue !== undefined && masterValue !== undefined) {
            pairs.push([targetValue, masterValue]);
        }
    }

    return {
        correlation: pearson(pairs, minPairs),
        samplePairs: pairs.length,
    };
};

type SlidingMatchOptions = {
    seriesId?: string;
    lagMin?: number;
    lagMax?: number;
    minOverlap?: number;
};

const compareSlidingLagResults = (
    a: GlobalSlidingLagResult,
    b: GlobalSlidingLagResult,
): number => {
    const aScore = a.tLike ?? (a.r ?? -Infinity);
    const bScore = b.tLike ?? (b.r ?? -Infinity);
    if (bScore !== aScore) return bScore - aScore;
    if (b.overlapYears !== a.overlapYears) return b.overlapYears - a.overlapYears;
    return Math.abs(a.lag) - Math.abs(b.lag);
};

export function runGlobalSlidingMatch(
    targetSeries: Map<number, number>,
    masterChronology: Map<number, number>,
    options: SlidingMatchOptions = {},
): GlobalSlidingMatch {
    const lagMin = Math.floor(options.lagMin ?? CrossdateConfig.globalLagMin);
    const lagMax = Math.floor(options.lagMax ?? CrossdateConfig.globalLagMax);
    const minOverlap = Math.max(3, Math.floor(options.minOverlap ?? CrossdateConfig.minGlobalOverlap));
    const [startLag, endLag] = lagMin <= lagMax ? [lagMin, lagMax] : [lagMax, lagMin];
    const lagResults: GlobalSlidingLagResult[] = [];

    for (let lag = startLag; lag <= endLag; lag += 1) {
        const pairs: Array<[number, number]> = [];
        targetSeries.forEach((targetValue, year) => {
            const masterValue = masterChronology.get(year + lag);
            if (masterValue !== undefined) {
                pairs.push([targetValue, masterValue]);
            }
        });
        const r = pearson(pairs, minOverlap);
        lagResults.push({
            lag,
            r,
            tLike: tLikeForCorrelation(r, pairs.length),
            overlapYears: pairs.length,
        });
    }

    const current = lagResults.find((result) => result.lag === 0) ?? {
        lag: 0,
        r: null,
        tLike: null,
        overlapYears: 0,
    };
    const best = lagResults
        .filter((result) => result.r !== null)
        .sort(compareSlidingLagResults)[0]
        ?? current;

    return {
        seriesId: options.seriesId ?? "",
        lagResults,
        bestGlobalLag: best.lag,
        bestGlobalR: best.r,
        bestGlobalTLike: best.tLike,
        overlapYears: best.overlapYears,
        currentR: current.r,
        currentTLike: current.tLike,
        currentOverlapYears: current.overlapYears,
    };
}

const filterSeriesByRange = (
    series: NumericSeries,
    range: YearRange,
): NumericSeries => {
    const filtered = new Map<number, number>();
    series.forEach((value, year) => {
        if (year >= range.startYear && year <= range.endYear) {
            filtered.set(year, value);
        }
    });
    return filtered;
};

const createSegmentsForSeries = (
    series: NumericSeries,
    segmentLength: number,
    overlap: number,
) => {
    const range = getRangeForSeries(series);
    if (!range) return [];

    const step = Math.max(1, segmentLength - overlap);
    const minLength = Math.max(10, Math.floor(segmentLength * 0.6));
    const segments: YearRange[] = [];

    for (let startYear = range.startYear; startYear <= range.endYear; startYear += step) {
        const endYear = Math.min(startYear + segmentLength - 1, range.endYear);
        if (endYear - startYear + 1 >= minLength) {
            segments.push({ startYear, endYear });
        }
        if (endYear === range.endYear) break;
    }

    return segments;
};

const getReferenceSourceTrees = (
    siteData: RwlSiteData,
    targetTree: string | null,
    referenceConfig: ReferenceSeriesConfig | null,
) => {
    if (referenceConfig) {
        const selected = referenceConfig.selectedTrees.filter((tree) => siteData.has(tree) && tree !== targetTree);
        if (selected.length > 0) return selected;
    }

    return Array.from(siteData.keys()).filter((tree) => tree !== targetTree);
};

const buildScoringMaster = (
    siteData: RwlSiteData,
    targetTree: string | null,
    referenceConfig: ReferenceSeriesConfig | null,
): ScoringMaster => {
    const sourceTrees = getReferenceSourceTrees(siteData, targetTree, referenceConfig);
    const valuesByYear = new Map<number, number[]>();

    sourceTrees.forEach((tree) => {
        preprocessSeries(toNumericSeries(siteData.get(tree))).forEach((value, year) => {
            const values = valuesByYear.get(year);
            if (values) {
                values.push(value);
            } else {
                valuesByYear.set(year, [value]);
            }
        });
    });

    const data = new Map<number, number>();
    const sampleDepth = new Map<number, number>();

    Array.from(valuesByYear.entries()).sort((a, b) => a[0] - b[0]).forEach(([year, values]) => {
        sampleDepth.set(year, values.length);
        if (values.length > 0) {
            data.set(year, values.reduce((sum, value) => sum + value, 0) / values.length);
        }
    });

    return { data, sampleDepth, sourceTrees };
};

const buildMasterNarrowYears = (
    siteData: RwlSiteData,
    referenceConfig: ReferenceSeriesConfig | null,
    config: EffectiveDiagnosisConfig,
): ScoringMasterYear[] => {
    const visualReference = buildReferenceSeries(siteData, referenceConfig);
    const master = visualReference
        ? {
            data: preprocessSeries(visualReference.data),
            sampleDepth: visualReference.sampleDepth,
        }
        : buildScoringMaster(siteData, null, null);

    return Array.from(master.data.entries())
        .map(([year, masterValue]) => ({
            year,
            masterValue,
            sampleDepth: master.sampleDepth.get(year) ?? 0,
            narrow: masterValue <= config.narrowYearThreshold,
            stronglyNarrow: masterValue <= config.strongNarrowYearThreshold,
        }))
        .filter((year) => year.narrow)
        .sort((a, b) => a.year - b.year);
};

type LocalEditAlignmentOptions = {
    maxGaps?: number;
    insertPenalty?: number;
    deletePenalty?: number;
    excessiveEditPenalty?: number;
    narrowYearBonus?: number;
    strongNarrowYearBonus?: number;
    diagonalBand?: number;
    minLocalOverlap?: number;
    narrowYearThreshold?: number;
    strongNarrowYearThreshold?: number;
};

type LocalDpState = {
    score: number;
    edits: LocalEditAlignmentEdit[];
};

const localEditOptionsWithDefaults = (
    options: LocalEditAlignmentOptions,
) => ({
    ...CrossdateConfig.localEditAlignment,
    ...options,
});

const localSimilarityScore = (targetValue: number, masterValue: number): number => (
    1 - Math.min(3, Math.abs(targetValue - masterValue))
);

const getMasterNarrowBonus = (
    masterValue: number | undefined,
    options: ReturnType<typeof localEditOptionsWithDefaults>,
): number => {
    if (masterValue === undefined) return 0;
    const narrowThreshold = options.narrowYearThreshold ?? CrossdateConfig.narrowYearThreshold;
    const strongThreshold = options.strongNarrowYearThreshold ?? CrossdateConfig.strongNarrowYearThreshold;
    if (masterValue <= strongThreshold) return options.strongNarrowYearBonus;
    if (masterValue <= narrowThreshold) return options.narrowYearBonus;
    if (masterValue > 0) return -options.narrowYearBonus * 0.5;
    return 0;
};

const shouldKeepLocalState = (
    current: LocalDpState | undefined,
    candidate: LocalDpState,
): boolean => (
    !current
    || candidate.score > current.score
    || (
        candidate.score === current.score
        && candidate.edits.length < current.edits.length
    )
);

const localDpKey = (i: number, j: number, gapCount: number): string => `${i}:${j}:${gapCount}`;

export function runLocalEditAlignment(
    seriesId: string,
    targetSeries: Map<number, number>,
    masterChronology: Map<number, number>,
    window: YearRange,
    options: LocalEditAlignmentOptions = {},
): LocalEditAlignmentResult | null {
    const effective = localEditOptionsWithDefaults(options);
    const targetEntries = Array.from(targetSeries.entries())
        .filter(([year]) => year >= window.startYear && year <= window.endYear)
        .sort((a, b) => a[0] - b[0]);
    const masterEntries = Array.from(masterChronology.entries())
        .filter(([year]) => year >= window.startYear && year <= window.endYear)
        .sort((a, b) => a[0] - b[0]);

    if (
        targetEntries.length < effective.minLocalOverlap
        || masterEntries.length < effective.minLocalOverlap
    ) {
        return null;
    }

    const states = new Map<string, LocalDpState>();
    states.set(localDpKey(0, 0, 0), { score: 0, edits: [] });

    const update = (i: number, j: number, gapCount: number, candidate: LocalDpState) => {
        const key = localDpKey(i, j, gapCount);
        const current = states.get(key);
        if (shouldKeepLocalState(current, candidate)) {
            states.set(key, candidate);
        }
    };

    for (let i = 0; i <= targetEntries.length; i += 1) {
        for (let j = 0; j <= masterEntries.length; j += 1) {
            for (let gapCount = 0; gapCount <= effective.maxGaps; gapCount += 1) {
                const state = states.get(localDpKey(i, j, gapCount));
                if (!state) continue;

                if (i < targetEntries.length && j < masterEntries.length) {
                    const diagonalDistance = Math.abs(i - j);
                    if (diagonalDistance <= effective.diagonalBand + gapCount) {
                        const [, targetValue] = targetEntries[i];
                        const [, masterValue] = masterEntries[j];
                        update(i + 1, j + 1, gapCount, {
                            score: state.score + localSimilarityScore(targetValue, masterValue),
                            edits: state.edits,
                        });
                    }
                }

                if (j < masterEntries.length && gapCount < effective.maxGaps) {
                    const diagonalDistance = Math.abs(i - (j + 1));
                    if (diagonalDistance <= effective.diagonalBand + gapCount + 1) {
                        const [anchorYear, masterValue] = masterEntries[j];
                        const contribution = -effective.insertPenalty + getMasterNarrowBonus(masterValue, effective);
                        update(i, j + 1, gapCount + 1, {
                            score: state.score + contribution,
                            edits: [
                                ...state.edits,
                                {
                                    type: "insertMissingYear",
                                    anchorYear,
                                    scoreContribution: contribution,
                                    reason: masterValue <= (effective.strongNarrowYearThreshold ?? CrossdateConfig.strongNarrowYearThreshold)
                                        ? "strong narrow-year prior"
                                        : masterValue <= (effective.narrowYearThreshold ?? CrossdateConfig.narrowYearThreshold)
                                            ? "narrow-year prior"
                                            : "gap in target path",
                                },
                            ],
                        });
                    }
                }

                if (i < targetEntries.length && gapCount < effective.maxGaps) {
                    const diagonalDistance = Math.abs((i + 1) - j);
                    if (diagonalDistance <= effective.diagonalBand + gapCount + 1) {
                        const [anchorYear] = targetEntries[i];
                        const contribution = -effective.deletePenalty;
                        update(i + 1, j, gapCount + 1, {
                            score: state.score + contribution,
                            edits: [
                                ...state.edits,
                                {
                                    type: "deleteFalseYear",
                                    anchorYear,
                                    scoreContribution: contribution,
                                    reason: "extra target ring in banded path",
                                },
                            ],
                        });
                    }
                }
            }
        }
    }

    const terminalStates = Array.from(states.entries())
        .filter(([key, state]) => {
            const [i, j] = key.split(":").map(Number);
            return i === targetEntries.length && j === masterEntries.length && state.edits.length > 0;
        })
        .map(([, state]) => state)
        .sort((a, b) => (
            b.score - a.score
            || a.edits.length - b.edits.length
        ));
    const best = terminalStates[0];
    if (!best) return null;

    const excessiveEditPenalty = Math.max(0, best.edits.length - 1) * effective.excessiveEditPenalty;
    return {
        seriesId,
        windowStartYear: window.startYear,
        windowEndYear: window.endYear,
        method: "banded_edit_dp",
        pathScore: best.score - excessiveEditPenalty,
        edits: best.edits,
    };
}

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

const diagnoseSeriesCore = (
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

const nearestExistingYear = (
    years: number[],
    targetYear: number,
    minYear: number,
    maxYear: number,
): number | null => {
    let bestYear: number | null = null;
    let bestDistance = Infinity;

    years.forEach((year) => {
        if (year < minYear || year > maxYear) return;
        const distance = Math.abs(year - targetYear);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestYear = year;
        }
    });

    return bestYear;
};

const getSegmentNearYear = (
    segments: SegmentDiagnosis[],
    year: number,
): SegmentDiagnosis | null => (
    segments.find((segment) => year >= segment.startYear && year <= segment.endYear)
    ?? segments.slice().sort((a, b) => (
        Math.abs(((a.startYear + a.endYear) / 2) - year)
        - Math.abs(((b.startYear + b.endYear) / 2) - year)
    ))[0]
    ?? null
);

const missingRangeForMove = (
    selectedRange: YearRange,
    deltaYears: number,
): YearRange | undefined => {
    if (deltaYears < 0) {
        return {
            startYear: selectedRange.endYear + deltaYears + 1,
            endYear: selectedRange.endYear,
        };
    }
    if (deltaYears > 0) {
        return {
            startYear: selectedRange.endYear + 1,
            endYear: selectedRange.endYear + deltaYears,
        };
    }
    return undefined;
};

const pickSingleYearAnchor = (
    diagnosis: SeriesCoreDiagnosis,
    pattern: PropagationPattern,
    fallbackYear: number,
    config: EffectiveDiagnosisConfig,
): number => {
    const existingYears = Array.from(diagnosis.rawTarget.keys())
        .filter((year) => year >= pattern.olderBoundaryYear && year <= pattern.newerBoundaryYear);
    if (existingYears.length === 0) return fallbackYear;

    const narrowCandidate = existingYears
        .map((year) => ({ year, masterValue: diagnosis.master.data.get(year) }))
        .filter((entry): entry is { year: number; masterValue: number } => entry.masterValue !== undefined)
        .filter((entry) => entry.masterValue <= config.narrowYearThreshold)
        .sort((a, b) => (
            Math.abs(a.year - fallbackYear) - Math.abs(b.year - fallbackYear)
            || a.masterValue - b.masterValue
        ))[0];

    if (narrowCandidate) {
        return narrowCandidate.year;
    }

    return nearestExistingYear(
        existingYears,
        fallbackYear,
        pattern.olderBoundaryYear,
        pattern.newerBoundaryYear,
    ) ?? fallbackYear;
};

const uniqueAlgorithmSources = (
    sources: Array<CandidateAlgorithmSource | undefined>,
): CandidateAlgorithmSource[] => Array.from(new Set(sources.filter((source): source is CandidateAlgorithmSource => Boolean(source))));

const getLagSupportingSegments = (
    segments: SegmentDiagnosis[],
    lag: number,
): SegmentDiagnosis[] => (
    segments.filter((segment) => segment.flag === "B_like" && segment.bestLag === lag)
);

const getMeanLag = (segments: SegmentDiagnosis[]): number => {
    if (segments.length === 0) return 0;
    return segments.reduce((sum, segment) => sum + segment.bestLag, 0) / segments.length;
};

const getRepresentativeSegmentForLag = (
    diagnosis: SeriesCoreDiagnosis,
    lag: number,
): SegmentDiagnosis | null => (
    getLagSupportingSegments(diagnosis.segments, lag)
        .sort((a, b) => b.samplePairs - a.samplePairs)[0]
    ?? getSegmentNearYear(diagnosis.segments, diagnosis.targetRange.endYear)
);

const localEditTypeForLag = (lag: number): LocalEditType | null => {
    if (lag < 0) return "insertMissingYear";
    if (lag > 0) return "deleteFalseYear";
    return null;
};

const operationForLocalEdit = (
    editType: LocalEditType,
): Pick<CandidateDraft, "operationType" | "candidateType"> => (
    editType === "insertMissingYear"
        ? { operationType: "INSERT_MISSING_RING", candidateType: "insertMissingYear" }
        : { operationType: "DELETE_FALSE_RING", candidateType: "deleteFalseYear" }
);

const createFallbackLocalEditAlignment = (
    diagnosis: SeriesCoreDiagnosis,
    segment: SegmentDiagnosis,
    editType: LocalEditType,
    anchorYear: number,
): LocalEditAlignmentResult => ({
    seriesId: diagnosis.targetTree,
    windowStartYear: segment.startYear,
    windowEndYear: segment.endYear,
    method: "fallback_single_edit_scan",
    pathScore: 0,
    edits: [{
        type: editType,
        anchorYear,
        scoreContribution: 0,
        reason: "single-edit scan fallback from segmented lag",
    }],
});

const getLocalEditAlignmentForSegment = (
    diagnosis: SeriesCoreDiagnosis,
    segment: SegmentDiagnosis,
    editType: LocalEditType,
    fallbackYear: number,
    config: EffectiveDiagnosisConfig,
): { alignment: LocalEditAlignmentResult; edit: LocalEditAlignmentEdit } => {
    const target = preprocessSeries(diagnosis.rawTarget);
    const alignment = runLocalEditAlignment(
        diagnosis.targetTree,
        target,
        diagnosis.master.data,
        { startYear: segment.startYear, endYear: segment.endYear },
        {
            maxGaps: config.localEditMaxGaps,
            diagonalBand: config.localEditDiagonalBand,
            minLocalOverlap: config.minLocalOverlap,
            narrowYearThreshold: config.narrowYearThreshold,
            strongNarrowYearThreshold: config.strongNarrowYearThreshold,
        },
    );
    const edit = alignment?.edits
        .filter((candidate) => candidate.type === editType)
        .sort((a, b) => (
            b.scoreContribution - a.scoreContribution
            || Math.abs(a.anchorYear - fallbackYear) - Math.abs(b.anchorYear - fallbackYear)
        ))[0];

    if (alignment && edit) {
        return { alignment, edit };
    }

    const fallback = createFallbackLocalEditAlignment(diagnosis, segment, editType, fallbackYear);
    return { alignment: fallback, edit: fallback.edits[0] };
};

const createLocalEditDraft = (
    diagnosis: SeriesCoreDiagnosis,
    segment: SegmentDiagnosis,
    editType: LocalEditType,
    anchorYear: number,
    alignment: LocalEditAlignmentResult,
    sourcePattern?: PropagationPattern,
): CandidateDraft => {
    const operation = operationForLocalEdit(editType);
    return {
        targetTree: diagnosis.targetTree,
        ...operation,
        anchorYear,
        targetYear: anchorYear,
        selectedRange: { startYear: diagnosis.targetRange.startYear, endYear: anchorYear },
        missingRange: editType === "insertMissingYear"
            ? { startYear: anchorYear, endYear: anchorYear }
            : undefined,
        side: "right",
        sourceSegment: segment,
        sourcePattern,
        localEditAlignment: alignment,
        algorithmSource: uniqueAlgorithmSources([
            "segmented_diagnosis",
            sourcePattern ? "propagation_pattern" : undefined,
            "local_edit_alignment",
        ]),
    };
};

const runSlidingMatchForRange = (
    diagnosis: SeriesCoreDiagnosis,
    range: YearRange,
    config: EffectiveDiagnosisConfig,
): GlobalSlidingMatch => (
    runGlobalSlidingMatch(
        filterSeriesByRange(preprocessSeries(diagnosis.rawTarget), range),
        diagnosis.master.data,
        {
            seriesId: diagnosis.targetTree,
            lagMin: config.globalLagMin,
            lagMax: config.globalLagMax,
            minOverlap: Math.max(config.minLocalOverlap, CrossdateConfig.localEditAlignment.minLocalOverlap),
        },
    )
);

const makePartialRangeEvidence = (
    diagnosis: SeriesCoreDiagnosis,
    selectedRange: YearRange,
    deltaYears: number,
): Omit<PartialRangeMoveEvidence, "afterUnresolvedA" | "afterUnresolvedB"> => {
    const fixedRange = selectedRange.endYear < diagnosis.targetRange.endYear
        ? { startYear: selectedRange.endYear + 1, endYear: diagnosis.targetRange.endYear }
        : undefined;
    const newerSegments = fixedRange
        ? diagnosis.segments.filter((segment) => overlapRange(fixedRange, segment))
        : [];

    return {
        fixedRange,
        selectedRange,
        deltaYears,
        inferredMissingRange: missingRangeForMove(selectedRange, deltaYears),
        boundaryYear: selectedRange.endYear,
        olderSideLag: deltaYears,
        newerSideMeanLag: getMeanLag(newerSegments),
        beforeUnresolvedA: diagnosis.unresolvedA,
        beforeUnresolvedB: diagnosis.unresolvedB,
    };
};

const moveNumericRangeByOffset = (
    series: NumericSeries,
    selectedRange: YearRange,
    deltaYears: number,
): NumericSeries => {
    const next = new Map<number, number>();
    series.forEach((value, year) => {
        if (year < selectedRange.startYear || year > selectedRange.endYear) {
            next.set(year, value);
        }
    });
    series.forEach((value, year) => {
        if (year >= selectedRange.startYear && year <= selectedRange.endYear) {
            next.set(year + deltaYears, value);
        }
    });
    return new Map(Array.from(next.entries()).sort((a, b) => a[0] - b[0]));
};

const refinePartialSelectedRange = (
    diagnosis: SeriesCoreDiagnosis,
    initialRange: YearRange,
    deltaYears: number,
    config: EffectiveDiagnosisConfig,
): YearRange => {
    if (deltaYears === 0) return initialRange;

    const years = Array.from(diagnosis.rawTarget.keys()).sort((a, b) => a - b);
    const radius = Math.max(Math.abs(deltaYears) * 2, config.overlap, 8);
    const candidateEndYears = years.filter((year) => (
        year >= initialRange.endYear - radius
        && year <= initialRange.endYear + radius
        && year >= initialRange.startYear
        && year < diagnosis.targetRange.endYear
    ));
    if (candidateEndYears.length === 0) return initialRange;

    const scored = candidateEndYears
        .map((endYear) => {
            const selectedRange = { startYear: initialRange.startYear, endYear };
            const moved = preprocessSeries(moveNumericRangeByOffset(diagnosis.rawTarget, selectedRange, deltaYears));
            const movedRange = {
                startYear: selectedRange.startYear + deltaYears,
                endYear: selectedRange.endYear + deltaYears,
            };
            const older = correlationForSegment(
                moved,
                diagnosis.master.data,
                movedRange.startYear,
                movedRange.endYear,
                0,
                config.minPairsForCorrelation,
            );
            const fixed = correlationForSegment(
                moved,
                diagnosis.master.data,
                endYear + 1,
                diagnosis.targetRange.endYear,
                0,
                config.minPairsForCorrelation,
            );
            const olderScore = older.correlation ?? -1;
            const fixedScore = fixed.correlation ?? 0;
            return {
                endYear,
                score: olderScore + fixedScore * 0.25 - Math.abs(endYear - initialRange.endYear) * 0.001,
            };
        })
        .sort((a, b) => b.score - a.score || Math.abs(a.endYear - initialRange.endYear) - Math.abs(b.endYear - initialRange.endYear));
    const best = scored[0];
    return best ? { ...initialRange, endYear: best.endYear } : initialRange;
};

const extendPartialBoundaryByPointFit = (
    diagnosis: SeriesCoreDiagnosis,
    selectedRange: YearRange,
    deltaYears: number,
): YearRange => {
    if (deltaYears === 0 || selectedRange.endYear >= diagnosis.targetRange.endYear) return selectedRange;

    const target = preprocessSeries(diagnosis.rawTarget);
    const maxExtension = Math.max(2, Math.abs(deltaYears));
    let endYear = selectedRange.endYear;

    for (let nextYear = selectedRange.endYear + 1; nextYear <= selectedRange.endYear + maxExtension; nextYear += 1) {
        if (nextYear >= diagnosis.targetRange.endYear) break;
        const targetValue = target.get(nextYear);
        const fixedMasterValue = diagnosis.master.data.get(nextYear);
        const shiftedMasterValue = diagnosis.master.data.get(nextYear + deltaYears);
        if (targetValue === undefined || shiftedMasterValue === undefined) break;

        const fixedDistance = fixedMasterValue === undefined
            ? Infinity
            : Math.abs(targetValue - fixedMasterValue);
        const shiftedDistance = Math.abs(targetValue - shiftedMasterValue);
        if (shiftedDistance + 0.05 < fixedDistance) {
            endYear = nextYear;
            continue;
        }
        break;
    }

    return { ...selectedRange, endYear };
};

const makeGlobalSlidingDrafts = (
    diagnosis: SeriesCoreDiagnosis,
): CandidateDraft[] => {
    const match = diagnosis.globalSlidingMatch;
    if (match.bestGlobalLag === 0 || match.bestGlobalR === null) return [];

    const currentR = match.currentR ?? -1;
    const globalImprovement = match.bestGlobalR - currentR;
    const supportingSegments = getLagSupportingSegments(diagnosis.segments, match.bestGlobalLag);
    const supportRatio = supportingSegments.length / Math.max(1, diagnosis.segments.length);
    const strongGlobalT = (match.bestGlobalTLike ?? 0) >= CrossdateConfig.globalMinTLike;
    const clearImprovement = globalImprovement >= CrossdateConfig.globalRImprovementThreshold;
    const enoughSupport = supportRatio >= CrossdateConfig.globalSupportRatio
        || supportingSegments.length >= CrossdateConfig.minPropagationSegments;

    if (
        match.overlapYears < CrossdateConfig.minGlobalOverlap
        || (!clearImprovement && !enoughSupport)
        || (!strongGlobalT && !clearImprovement)
    ) {
        return [];
    }

    const sourceSegment = getRepresentativeSegmentForLag(diagnosis, match.bestGlobalLag);
    if (!sourceSegment) return [];

    return [{
        targetTree: diagnosis.targetTree,
        operationType: "SHIFT_RANGE",
        candidateType: "batchMoveYears",
        mode: "wholeSeriesMove",
        anchorYear: diagnosis.targetRange.endYear,
        selectedRange: { ...diagnosis.targetRange },
        deltaYears: match.bestGlobalLag,
        sourceSegment,
        globalSlidingMatch: match,
        algorithmSource: ["global_sliding_match", "segmented_diagnosis"],
    }];
};

const makePatternDrafts = (
    diagnosis: SeriesCoreDiagnosis,
    config: EffectiveDiagnosisConfig,
): CandidateDraft[] => {
    const drafts: CandidateDraft[] = [];
    const years = Array.from(diagnosis.rawTarget.keys()).sort((a, b) => a - b);

    diagnosis.propagationPatterns.forEach((pattern) => {
        const sourceSegment = getSegmentNearYear(diagnosis.segments, pattern.newerBoundaryYear);
        if (!sourceSegment) return;

        const fallbackAnchorYear = nearestExistingYear(
            years,
            pattern.newerBoundaryYear,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
        );
        if (fallbackAnchorYear === null) return;
        const anchorYear = pattern.patternType === "possibleMissingYear" || pattern.patternType === "possibleFalseYear"
            ? pickSingleYearAnchor(diagnosis, pattern, fallbackAnchorYear, config)
            : fallbackAnchorYear;

        if (pattern.patternType === "possibleMissingYear" && pattern.lag < 0) {
            const { alignment, edit } = getLocalEditAlignmentForSegment(
                diagnosis,
                sourceSegment,
                "insertMissingYear",
                anchorYear,
                config,
            );
            drafts.push(createLocalEditDraft(diagnosis, sourceSegment, "insertMissingYear", edit.anchorYear, alignment, pattern));
            return;
        }

        if (pattern.patternType === "possibleFalseYear" && pattern.lag > 0) {
            const { alignment, edit } = getLocalEditAlignmentForSegment(
                diagnosis,
                sourceSegment,
                "deleteFalseYear",
                anchorYear,
                config,
            );
            drafts.push(createLocalEditDraft(diagnosis, sourceSegment, "deleteFalseYear", edit.anchorYear, alignment, pattern));
            return;
        }

        const initialSelectedRange = pattern.patternType === "possibleWholeSeriesMove"
            ? { ...diagnosis.targetRange }
            : { startYear: diagnosis.targetRange.startYear, endYear: anchorYear };
        const localSliding = pattern.patternType === "possiblePartialRangeMove"
            ? runSlidingMatchForRange(diagnosis, initialSelectedRange, config)
            : null;
        const localImprovement = localSliding?.bestGlobalR === null
            ? 0
            : (localSliding?.bestGlobalR ?? -1) - (localSliding?.currentR ?? -1);
        const deltaYears = localSliding
            && localSliding.bestGlobalLag !== 0
            && Math.sign(localSliding.bestGlobalLag) === Math.sign(pattern.lag)
            && (
                localImprovement >= CrossdateConfig.globalRImprovementThreshold
                || (localSliding.bestGlobalTLike ?? 0) >= CrossdateConfig.globalMinTLike
            )
            ? localSliding.bestGlobalLag
            : pattern.lag;
        const selectedRange = pattern.patternType === "possiblePartialRangeMove"
            ? extendPartialBoundaryByPointFit(
                diagnosis,
                refinePartialSelectedRange(diagnosis, initialSelectedRange, deltaYears, config),
                deltaYears,
            )
            : initialSelectedRange;

        drafts.push({
            targetTree: diagnosis.targetTree,
            operationType: "SHIFT_RANGE",
            candidateType: "batchMoveYears",
            mode: pattern.patternType === "possibleWholeSeriesMove" ? "wholeSeriesMove" : "partialRangeMove",
            anchorYear,
            selectedRange,
            missingRange: pattern.patternType === "possiblePartialRangeMove"
                ? missingRangeForMove(selectedRange, deltaYears)
                : undefined,
            deltaYears,
            sourceSegment,
            sourcePattern: pattern,
            algorithmSource: uniqueAlgorithmSources([
                "segmented_diagnosis",
                "propagation_pattern",
                pattern.patternType === "possiblePartialRangeMove" ? "global_sliding_match" : undefined,
            ]),
            partialRangeMoveEvidence: pattern.patternType === "possiblePartialRangeMove"
                ? makePartialRangeEvidence(diagnosis, selectedRange, deltaYears)
                : undefined,
        });
    });

    return drafts;
};

const makeSegmentDrafts = (
    diagnosis: SeriesCoreDiagnosis,
    config: EffectiveDiagnosisConfig,
): CandidateDraft[] => {
    const drafts: CandidateDraft[] = [];
    const patternCoveredSegments = new Set<string>();
    const years = Array.from(diagnosis.rawTarget.keys()).sort((a, b) => a - b);

    diagnosis.propagationPatterns.forEach((pattern) => {
        pattern.affectedSegments.forEach((segment) => {
            patternCoveredSegments.add(`${segment.startYear}:${segment.endYear}`);
        });
    });

    diagnosis.segments.forEach((segment) => {
        if (!segment.flagged || patternCoveredSegments.has(`${segment.startYear}:${segment.endYear}`)) return;
        if (segment.flag !== "B_like" || segment.bestLag === 0) return;

        const midpoint = Math.round((segment.startYear + segment.endYear) / 2);
        const anchorYear = nearestExistingYear(years, midpoint, segment.startYear, segment.endYear);
        if (anchorYear === null) return;

        const editType = Math.abs(segment.bestLag) === 1 ? localEditTypeForLag(segment.bestLag) : null;
        if (editType) {
            const { alignment, edit } = getLocalEditAlignmentForSegment(
                diagnosis,
                segment,
                editType,
                anchorYear,
                config,
            );
            drafts.push(createLocalEditDraft(diagnosis, segment, editType, edit.anchorYear, alignment));
            return;
        }

        const initialSelectedRange = {
            startYear: diagnosis.targetRange.startYear,
            endYear: Math.min(diagnosis.targetRange.endYear, segment.endYear),
        };
        const selectedRange = extendPartialBoundaryByPointFit(
            diagnosis,
            refinePartialSelectedRange(diagnosis, initialSelectedRange, segment.bestLag, config),
            segment.bestLag,
        );
        drafts.push({
            targetTree: diagnosis.targetTree,
            operationType: "SHIFT_RANGE",
            candidateType: "batchMoveYears",
            mode: "partialRangeMove",
            anchorYear,
            selectedRange,
            missingRange: missingRangeForMove(selectedRange, segment.bestLag),
            deltaYears: segment.bestLag,
            sourceSegment: segment,
            algorithmSource: ["segmented_diagnosis"],
            partialRangeMoveEvidence: makePartialRangeEvidence(diagnosis, selectedRange, segment.bestLag),
        });
    });

    return drafts;
};

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

const labelForDraft = (draft: CandidateDraft): string => {
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

const evaluateDraft = (
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

const compareDiagnosisCandidates = (
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

const dedupeDiagnosisCandidates = (
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
    if (candidate.operationType === "INSERT_MISSING_RING") return "插入缺轮";
    if (candidate.operationType === "DELETE_FALSE_RING") return "删除伪轮";
    if (candidate.operationType === "SHIFT_RANGE") {
        const delta = candidate.deltaYears ?? candidate.shift ?? candidate.suggestedLag;
        return `批量移动 ${delta > 0 ? "+" : ""}${delta} 年`;
    }
    return "标记可疑";
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
            reason: "MVP 每次只允许接受一个自动候选；应用后请重新诊断再继续。",
        }));

    return { selected, skipped };
};

const createSeriesSummary = (
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

export function diagnoseCrossdating(
    siteData: RwlSiteData,
    options: DiagnosisOptions = {},
): CrossdatingDiagnosis {
    const config = getConfig(options);
    const treeCodes = Array.from(siteData.keys());
    const seriesDiagnoses = treeCodes
        .map((tree) => diagnoseSeriesCore(siteData, tree, config))
        .filter((diagnosis): diagnosis is SeriesCoreDiagnosis => diagnosis !== null);
    const segments = seriesDiagnoses.flatMap((diagnosis) => diagnosis.segments);
    const propagationPatterns = seriesDiagnoses.flatMap((diagnosis) => diagnosis.propagationPatterns);
    const globalSlidingMatches = seriesDiagnoses.map((diagnosis) => diagnosis.globalSlidingMatch);
    const candidateDrafts = seriesDiagnoses.flatMap((diagnosis) => [
        ...makeGlobalSlidingDrafts(diagnosis),
        ...makePatternDrafts(diagnosis, config),
        ...makeSegmentDrafts(diagnosis, config),
    ]);
    const candidates = rankDiagnosisCandidates(dedupeDiagnosisCandidates(
        candidateDrafts
            .map((draft) => {
                const before = seriesDiagnoses.find((diagnosis) => diagnosis.targetTree === draft.targetTree);
                return before ? evaluateDraft(siteData, before, draft, config) : null;
            })
            .filter((candidate): candidate is DiagnosisCandidateOperation => candidate !== null),
    ))
        .sort(compareDiagnosisCandidates)
        .slice(0, config.maxTopCandidates);
    const candidateCountByTree = candidates.reduce((counts, candidate) => {
        counts.set(candidate.targetTree, (counts.get(candidate.targetTree) ?? 0) + 1);
        return counts;
    }, new Map<string, number>());

    return {
        createdAt: new Date().toISOString(),
        seriesCount: treeCodes.length,
        problemSegmentCount: segments.filter((segment) => segment.flagged).length,
        candidateCount: candidates.length,
        segmentLength: config.segmentLength,
        overlap: config.overlap,
        lagRange: { min: config.lagMin, max: config.lagMax },
        lowCorrelationThreshold: config.lowCorrelationThreshold,
        summaries: seriesDiagnoses.map((diagnosis) => createSeriesSummary(
            diagnosis,
            candidateCountByTree.get(diagnosis.targetTree) ?? 0,
        )),
        segments,
        propagationPatterns,
        globalSlidingMatches,
        masterNarrowYears: buildMasterNarrowYears(siteData, config.referenceConfig, config),
        candidates,
    };
}

const createLocalSimulationOption = (
    operationType: LocalSimulationOperationType,
    label: string,
    currentCorrelation: number | null,
    simulatedCorrelation: number | null,
    reason: string,
    extra: Pick<LocalSimulationOption, "side" | "shift"> = {},
): LocalSimulationOption => {
    const delta = simulatedCorrelation === null ? null : simulatedCorrelation - (currentCorrelation ?? -1);
    const confidence: DiagnosisConfidence = delta === null || delta < 0.08
        ? "low"
        : delta >= 0.25
            ? "high"
            : "medium";

    return {
        operationType,
        label,
        currentCorrelation,
        simulatedCorrelation,
        delta,
        confidence,
        reason,
        ...extra,
    };
};

export function simulateLocalCrossdating(
    siteData: RwlSiteData,
    targetTree: string,
    year: number,
    options: DiagnosisOptions = {},
): LocalCrossdatingSimulation | null {
    const config = getConfig(options);
    const treeData = siteData.get(targetTree);
    if (!treeData) return null;

    const rawTarget = toNumericSeries(treeData);
    const targetRange = getRangeForSeries(rawTarget);
    if (!targetRange) return null;

    const master = buildScoringMaster(siteData, targetTree, config.referenceConfig);
    if (master.data.size === 0) return null;

    const halfWindow = Math.floor(config.fineWindowLength / 2);
    const segmentStartYear = Math.max(targetRange.startYear, year - halfWindow);
    const segmentEndYear = Math.min(targetRange.endYear, segmentStartYear + config.fineWindowLength - 1);
    const measure = (nextTreeData: RwlTreeData) => correlationForSegment(
        preprocessSeries(toNumericSeries(nextTreeData)),
        master.data,
        segmentStartYear,
        segmentEndYear,
        0,
        config.minPairsForCorrelation,
    );
    const current = measure(treeData);
    const simulatedOptions = [
        createLocalSimulationOption(
            "INSERT_MISSING_RING",
            "插入缺轮",
            current.correlation,
            measure(insertMissingYearAtSide(treeData, year, "right")).correlation,
            "点击候选按钮生成正式 evidence；此处仅保留兼容接口。",
            { side: "right" },
        ),
        createLocalSimulationOption(
            "DELETE_FALSE_RING",
            "删除伪轮",
            current.correlation,
            measure(deleteYearWithMode(treeData, year, "direct", "right")).correlation,
            "点击候选按钮生成正式 evidence；此处仅保留兼容接口。",
            { side: "right" },
        ),
        createLocalSimulationOption(
            "SHIFT_RANGE",
            "分段移动 -1 年",
            current.correlation,
            measure(moveSeriesTailByOffset(treeData, targetRange.startYear, year, -1)).correlation,
            "点击候选按钮生成正式 evidence；此处仅保留兼容接口。",
            { shift: -1 },
        ),
    ];
    const bestOption = simulatedOptions
        .filter((option) => option.simulatedCorrelation !== null)
        .sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity))[0]
        ?? createLocalSimulationOption(
            "NO_ACTION",
            "暂无建议",
            current.correlation,
            current.correlation,
            "样本对不足或无明显改善",
        );

    return {
        targetTree,
        year,
        segmentStartYear,
        segmentEndYear,
        samplePairs: current.samplePairs,
        currentCorrelation: current.correlation,
        bestOption,
        options: simulatedOptions,
    };
}

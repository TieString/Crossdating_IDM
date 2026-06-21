/**
 * 内部交叉定年诊断流程的可调默认参数。
 * 调整窗口、阈值或评分权重时，优先改这里，再考虑算法实现。
 */
import type { DiagnosisOptions, EffectiveDiagnosisConfig } from "./types";

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

export const getConfig = (options: DiagnosisOptions): EffectiveDiagnosisConfig => {
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

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
    // 自适应 A-like / B-like 判定阈值（与 effectiveN 联动的部分见 series.ts 的 adaptive* 函数）。
    adaptiveClassification: {
        minValidYears: 8,
        minTImprovement: 0.6,
        minAcceptableBestR: 0.25,
    },
    globalLagMin: -100,
    globalLagMax: 100,
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
    // 改进 3/4：基于整条 before/after 重诊断的评分。局部窗口质量降权，
    // 且只有通过 hard gate 后才计入局部边界改进，避免局部相关单独把候选推上榜。
    evaluationV2: {
        // hard gate：候选必须满足至少 minHardGateConditions 项才允许进入最终候选区。
        minHardGateConditions: 3,
        wholeSeriesRTolerance: 0.02,
        localWindowRadius: 20,
        weights: {
            segmentImprovement: 3.0,
            propagationResolution: 3.0,
            lagRecovery: 2.5,
            wholeSeriesImprovement: 2.0,
            // 编辑后绝对一致性：整条一阶差分相关（高通）奖励“完整对齐”，
            // 残留 B-like 惩罚未对齐段，这是区分“真实编辑年”与“只对齐强信号老区”的关键。
            afterFirstDiffAlignment: 8.0,
            residualProblem: 2.0,
            // 单年插/删的边界对齐锐度（逐点分类）：把 prescan 已送进 top5 的真实编辑年
            // 在最终排名里也顶到 top1（精确到 ±1）。
            boundarySharpness: 3.0,
            // 缺轮专用：编辑后“较新侧 [Y+1,Y+W] lag0 一阶差分对齐”。插得过老(Y'<真值)会在
            // (Y',真值] 留下未修正的错位带紧贴候选较新侧→对齐低；真值年较新侧完全对齐→高。
            // 专治真实数据中“真值在 top5 但被更老的错误候选挤出 top1”的排序泄漏。
            newerSideInsertAlignment: 3.0,
            localBoundaryImprovement: 0.6,
            localGlkImprovement: 1.0,
            narrowRingEvidence: 0.8,
            // COFECHA 年级证据（[B] 最降相关年 / [C] 年际异常 / [E] 离群年）：实测真值年并不可靠落在这些
            // 异常年上，权重调高(3.0)反而降 top1——保持 0.8 作辅助证据，不主导。
            cofechaHintEvidence: 0.8,
            newProblemPenalty: 1.2,
            editCountPenalty: 0.8,
            distanceFromBoundaryPenalty: 0.4,
            rangeMoveDistancePenalty: 0.3,
        },
        // 进入“强建议”需要的最低分（用于 clean-series 假阳性控制与 UI 接受阈值）。
        acceptanceThreshold: 1.0,
    },
    // 范围建议最大窗宽（年）：同序列同类型候选聚集且跨度 <= 此值时，标注 suggestedRange 供人工复核。
    // 实测真实单伪轮的 top5 候选跨度中位 ~7 年；超过此宽度说明候选分散、不给"小范围"承诺（避免范围太大失去意义）。
    suggestedRangeMaxWidth: 20,
    // AR(1) 预白化兜底召回（COFECHA 优先；无 COFECHA 输出时用 AR 去自相关补缺轮召回）。
    // 默认关闭：AR 对 clean 噪声过敏感，实测会引入 clean 假阳性（0→0.08）并轻微伤部分移动召回，
    // 违反 clean 假阳性硬约束；且生产中每次保存都会自动生成 COFECHA .OUT（COFECHA 路径始终可用），
    // 故兜底极少触发。能力已实现（makeArRecallInsertDrafts + series.ar1WhitenSeries），可在需要时开启。
    arRecallFallback: {
        enabled: false,
    },
    // COFECHA-like 贝叶斯段级 lag 路径：多尺度分段 → 每段 lag 后验 → HMM 推断累计 offset
    // 状态路径（状态跳变=插/删边界）→ forward-backward 边界后验 → 候选召回扩展 → 重排。
    bayesian: {
        // 默认关闭把贝叶斯召回并入候选池：经 RDM 实测，并入会稀释 ±1 精排（缺轮 top1 0.50→0.33）
        // 并引入 clean 假阳性（0→0.08），违反 clean 假阳性硬约束。模块本身已实现并单元测试，
        // 作为段级 lag 诊断 / COFECHA 辅助模式能力保留，可在提供 COFECHA 文本等场景按需启用。
        enableRecallInjection: false,
        lagRange: [-10, 10] as [number, number],
        scales: [30, 50, 70],
        stepByScale: { 30: 10, 50: 10, 70: 15 } as Record<number, number>,
        minEffectiveNByScale: { 30: 12, 50: 20, 70: 30 } as Record<number, number>,
        scaleWeights: { 30: 0.8, 50: 1.0, 70: 0.9 } as Record<number, number>,
        // lag correlations → likelihood/posterior 的 softmax。
        likelihood: {
            temperature: 0.45,
            wR: 1.0,
            wT: 0.15,
            wImprovement: 1.5,
            minPosteriorFloor: 1e-6,
            invalidPenalty: 2.0,
        },
        // HMM 状态范围与转移先验（log 概率）。处理方向 newer→older。
        hmm: {
            maxState: 3,
            logStay: Math.log(0.96),
            logStep1: Math.log(0.02), // ±1（单个 insert/delete 边界）
            logStepBig: Math.log(0.002), // |delta|>1（仅 whole/partial move）
            reverseWithinYears: 30,
            reversePenalty: Math.log(0.3),
            transitionCountPenalty: Math.log(0.6),
        },
        // 边界 → 候选召回扩展。
        recall: {
            boundaryWindow: 3, // boundaryYear ± window 全枚举（保守，避免稀释 ±1 精度）
            boundaryWindowWide: 6, // recall 不足时扩到 ±6
            insertPosteriorFloor: 0.30,
            deletePosteriorFloor: 0.30,
            maxBoundariesPerType: 4,
            maxCandidatesPerType: 8,
            multiScaleFuseWindow: 5,
            // 删年召回默认关闭：伪轮额外值位置模糊，HMM 删年边界偏移大，并入会稀释删年精排。
            enableDeleteRecall: false,
        },
        // 重排权重（保留 hard gate；新增 HMM/recall 证据）。
        rerank: {
            wCounterfactual: 4.0,
            wHmmBoundaryPosterior: 0.5,
            wPropagationResolved: 2.5,
            wLagRecovery: 2.0,
            wWholeSeriesDelta: 1.5,
            wSegmentLagLikelihoodGain: 1.2,
            wLocalBoundaryDelta: 1.0,
            wGlk: 0.8,
            wCofechaHint: 0.8,
            wRecallSourceCount: 0.3,
            wNarrowOrAnomaly: 0.6,
            wBoundarySharpness: 3.0, // 逐点边界锐度，精确到 ±1
            wNewProblemPenalty: 1.2,
            wEditPenalty: 0.8,
            wDistancePenalty: 0.4,
            // weak（HMM 后验高但 hard gate 不足）允许进入 top5/复查，但分数封顶不超过 strong。
            weakHmmPosteriorFloor: 0.25,
            weakScoreCap: 0.95,
        },
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

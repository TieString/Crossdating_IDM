/**
 * 诊断候选草案生成。
 * 这里把整体滑动、传播模式和分段异常翻译成可模拟的插入、删除或移动候选。
 */
import { CrossdateConfig } from "./config";
import { runLocalEditAlignment } from "./localEditAlignment";
import { ar1WhitenSeries, correlationForSegment, preprocessSeries } from "./series";
import { diagnoseSeriesCore } from "./segments";
import { uniqueAlgorithmSources } from "./candidateUtils";
import {
    extendPartialBoundaryByPointFit,
    getLagSupportingSegments,
    getRepresentativeSegmentForLag,
    getSegmentNearYear,
    makePartialRangeEvidence,
    missingRangeForMove,
    nearestExistingYear,
    pickSingleYearAnchor,
    pickTopSingleYearAnchors,
    prescanEditYearsInRegion,
    refinePartialSelectedRange,
    runSlidingMatchForRange,
} from "./rangeMove";
import {
    getCofechaTerminalLagEstimate,
    getNewestFlaggedCofechaSegment,
    type CofechaHints,
} from "./cofechaHints";
import {
    isAutomaticPartialShift,
    partialMoveBreakpoint,
} from "./partialMoveSemantics";
import type { RwlSiteData } from "@/features/rwl/types";
import type {
    CandidateDraft,
    EffectiveDiagnosisConfig,
    LocalEditAlignmentEdit,
    LocalEditAlignmentResult,
    LocalEditType,
    PropagationPattern,
    SegmentDiagnosis,
    SeriesCoreDiagnosis,
} from "./types";

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

export const makeGlobalSlidingDrafts = (
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

/**
 * A -2/-3 whole lag can be the unresolved sum of nearby missing rings. The ordinary
 * propagation drafts may disappear once short adjacent transitions blur into one
 * constant segmented lag, so retain a small bark-side one-ring counterfactual scan.
 * Every draft still passes the normal before/after hard gate; this only restores recall.
 */
export const makeIterativeEndpointMissingDrafts = (
    diagnosis: SeriesCoreDiagnosis,
    config: EffectiveDiagnosisConfig,
): CandidateDraft[] => {
    const globalLag = diagnosis.globalSlidingMatch.bestGlobalLag;
    if ((globalLag !== -2 && globalLag !== -3)
        || makeGlobalSlidingDrafts(diagnosis).length === 0) return [];

    const endpointSpan = Math.max(30, Math.floor(config.segmentLength * 0.75));
    const startYear = Math.max(
        diagnosis.targetRange.startYear + 2,
        diagnosis.targetRange.endYear - endpointSpan,
    );
    const endYear = diagnosis.targetRange.endYear - 2;
    const anchorYears = prescanEditYearsInRegion(
        diagnosis,
        "insert",
        startYear,
        endYear,
        endYear,
        config,
        8,
    );

    return anchorYears.flatMap((anchorYear) => {
        const sourceSegment = getSegmentNearYear(diagnosis.segments, anchorYear);
        if (!sourceSegment) return [];
        const { alignment } = getLocalEditAlignmentForSegment(
            diagnosis,
            sourceSegment,
            "insertMissingYear",
            anchorYear,
            config,
        );
        const draft = createLocalEditDraft(
            diagnosis,
            sourceSegment,
            "insertMissingYear",
            anchorYear,
            alignment,
        );
        return [{
            ...draft,
            recallSourceTags: [
                "iterative_endpoint_missing_review",
                `iterative_whole_lag:${globalLag}`,
            ],
        }];
    });
};

export const terminalResidualPatternSupport = (
    patterns: PropagationPattern[],
    terminalLag: number,
    residualLag: number,
): { matching: number; opposing: number } => patterns.reduce((support, pattern) => {
    const relativeLag = pattern.dominantLag - terminalLag;
    const weight = pattern.affectedSegments.length * Math.max(0.1, pattern.confidence);
    if (Math.sign(relativeLag) === Math.sign(residualLag)) support.matching += weight;
    if (relativeLag !== 0 && Math.sign(relativeLag) !== Math.sign(residualLag)) {
        support.opposing += weight;
    }
    return support;
}, { matching: 0, opposing: 0 });

/**
 * Generate the executable whole baseline represented by reliable COFECHA rows at the newer end.
 * This is intentionally a draft, not a direct event: the proposed shift must still pass the same
 * full before/after evaluation as every other whole-series candidate.
 */
export const makeCofechaTerminalWholeDrafts = (
    diagnosis: SeriesCoreDiagnosis,
    config: EffectiveDiagnosisConfig,
    cofechaHints: CofechaHints | null,
): CandidateDraft[] => {
    if (!cofechaHints) return [];
    const endpointOptions = {
        maxUnmatchedTailYears: Math.max(
            4,
            Math.min(12, Math.floor(config.segmentLength / 4)),
        ),
    };
    const repeatedTerminal = getCofechaTerminalLagEstimate(
        cofechaHints,
        diagnosis.targetTree,
        diagnosis.targetRange.endYear,
        {
            ...endpointOptions,
            minimumSegments: 2,
        },
    );
    const terminal = repeatedTerminal ?? getCofechaTerminalLagEstimate(
        cofechaHints,
        diagnosis.targetTree,
        diagnosis.targetRange.endYear,
        {
            ...endpointOptions,
            minEndpointStarredR: 0.45,
            minimumEndpointLagAdvantage: 0.2,
            minimumSegments: 1,
        },
    );
    if (!terminal) return [];
    const residualLag = diagnosis.globalSlidingMatch.bestGlobalLag - terminal.lag;
    const patternSupport = terminalResidualPatternSupport(
        diagnosis.propagationPatterns,
        terminal.lag,
        residualLag,
    );
    // Overlapping endpoint segments can all cross the same recent local event. If their implied
    // unit residual points one way while the local lag path has stronger support in the opposite
    // direction, the endpoint state is not an independent whole baseline.
    if (
        Math.abs(residualLag) === 1
        && patternSupport.opposing > patternSupport.matching
    ) return [];
    const sourceSegment = getSegmentNearYear(
        diagnosis.segments,
        terminal.terminalEndYear,
    ) ?? getRepresentativeSegmentForLag(diagnosis, terminal.lag);
    if (!sourceSegment) return [];
    return [{
        targetTree: diagnosis.targetTree,
        operationType: "SHIFT_RANGE",
        candidateType: "batchMoveYears",
        mode: "wholeSeriesMove",
        anchorYear: diagnosis.targetRange.endYear,
        selectedRange: { ...diagnosis.targetRange },
        deltaYears: terminal.lag,
        sourceSegment,
        algorithmSource: uniqueAlgorithmSources([
            "cofecha_segment_lag",
            "segmented_diagnosis",
        ]),
        recallSourceTags: [
            "cofecha_terminal_whole_baseline",
            `cofecha_terminal_mode:${repeatedTerminal ? "repeated" : "single_advantage"}`,
            `cofecha_terminal_lag:${terminal.lag}`,
            `cofecha_terminal_segments:${terminal.segmentCount}`,
            `cofecha_terminal_consistency:${terminal.consistency.toFixed(6)}`,
            `cofecha_terminal_unmatched_tail:${terminal.unmatchedTailYears}`,
            `cofecha_terminal_residual_lag:${residualLag}`,
            `cofecha_terminal_matching_pattern_support:${patternSupport.matching.toFixed(6)}`,
            `cofecha_terminal_opposing_pattern_support:${patternSupport.opposing.toFixed(6)}`,
        ],
    }];
};

export const makePatternDrafts = (
    diagnosis: SeriesCoreDiagnosis,
    config: EffectiveDiagnosisConfig,
): CandidateDraft[] => {
    const drafts: CandidateDraft[] = [];
    const years = Array.from(diagnosis.rawTarget.keys()).sort((a, b) => a - b);

    diagnosis.propagationPatterns.forEach((pattern) => {
        if (pattern.ambiguous) return;
        const sourceSegment = getSegmentNearYear(diagnosis.segments, pattern.newerBoundaryYear);
        if (!sourceSegment) return;

        const fallbackAnchorYear = nearestExistingYear(
            years,
            pattern.newerBoundaryYear,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
        );
        if (fallbackAnchorYear === null) return;
        if (pattern.patternType === "possibleMissingYear" && pattern.lag < 0) {
            // 生成多个插年候选（top 3），交给 evaluation 排名。
            const anchorYears = pickTopSingleYearAnchors(diagnosis, pattern, fallbackAnchorYear, config, 5);
            anchorYears.forEach((candidateYear) => {
                // 锚年用预扫描（模拟端锚编辑 + 整条相关）选出的真实边界年；
                // 局部 DP 对齐仅作为支持证据，不覆盖锚年。
                const { alignment } = getLocalEditAlignmentForSegment(
                    diagnosis, sourceSegment, "insertMissingYear", candidateYear, config,
                );
                drafts.push(createLocalEditDraft(
                    diagnosis, sourceSegment, "insertMissingYear", candidateYear, alignment, pattern,
                ));
            });
            return;
        }

        if (pattern.patternType === "possibleFalseYear" && pattern.lag > 0) {
            // 生成多个删年候选，交给 evaluation 排名。
            const anchorYears = pickTopSingleYearAnchors(diagnosis, pattern, fallbackAnchorYear, config, 5);
            anchorYears.forEach((candidateYear) => {
                const { alignment } = getLocalEditAlignmentForSegment(
                    diagnosis, sourceSegment, "deleteFalseYear", candidateYear, config,
                );
                drafts.push(createLocalEditDraft(
                    diagnosis, sourceSegment, "deleteFalseYear", candidateYear, alignment, pattern,
                ));
            });
            return;
        }

        const anchorYear = pattern.patternType === "possibleMissingYear" || pattern.patternType === "possibleFalseYear"
            ? pickSingleYearAnchor(diagnosis, pattern, fallbackAnchorYear, config)
            : fallbackAnchorYear;

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

/** Distinguishes a long physical gap from a misleading COFECHA unit-lag segment. */
export const shouldSuppressAliasedCofechaUnitDraft = ({
    regionLagMagnitude,
    globalLag,
    globalGain,
    newerAtZero,
    newerAtGlobal,
}: {
    regionLagMagnitude: number;
    globalLag: number;
    globalGain: number;
    newerAtZero: number | null;
    newerAtGlobal: number | null;
}): boolean => (
    regionLagMagnitude === 1
    && globalLag <= -2
    && globalGain >= 0.08
    && newerAtZero !== null
    && (newerAtGlobal === null || newerAtZero - newerAtGlobal >= 0.12)
);

/**
 * COFECHA [A] 段级 lag 表驱动的候选生成（人工定年流程的核心：参考 COFECHA 输出，从最新 flagged 段处理）。
 *
 * 当用户提供 COFECHA 输出（cofechaText）时，COFECHA 已用样条+AR+log 给出极干净的段级 lag——
 * 真缺/伪轮在"最新 flagged 段"（highLag -1=缺轮 / +1=伪轮）。幅度不小于 2 的负 lag
 * 表示较老侧连续缺测，必须保留其完整幅度并转成 partialRangeMove，不能压成一个缺轮。
 * 这里直接用该段确定**区域和编辑类型**，
 * 在区域内用锐利 prescan 取多候选（topN）。这解决了内部分段在弱相关区检测不到真区域的召回问题
 * （伪轮 top5 区域召回尤其受益）。候选仍走统一 z-score evaluation 排序，clean 假阳性由 hard gate 控。
 */
export const makeCofechaDrivenDrafts = (
    diagnosis: SeriesCoreDiagnosis,
    config: EffectiveDiagnosisConfig,
    cofechaHints: CofechaHints | null,
): CandidateDraft[] => {
    if (!cofechaHints) return [];
    const region = getNewestFlaggedCofechaSegment(cofechaHints, diagnosis.targetTree);
    if (!region) return [];

    if (region.lag === 1) {
        const global = diagnosis.globalSlidingMatch;
        const seriesLength = diagnosis.targetRange.endYear
            - diagnosis.targetRange.startYear + 1;
        const newerContextYears = Math.min(
            32,
            Math.max(18, Math.floor(seriesLength / 4)),
        );
        const newerStartYear = Math.max(
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear - newerContextYears + 1,
        );
        const minimumPairs = Math.max(10, Math.floor(newerContextYears * 0.65));
        const newerAtZero = correlationForSegment(
            diagnosis.rawTarget,
            diagnosis.master.data,
            newerStartYear,
            diagnosis.targetRange.endYear,
            0,
            minimumPairs,
        ).correlation;
        const newerAtGlobal = correlationForSegment(
            diagnosis.rawTarget,
            diagnosis.master.data,
            newerStartYear,
            diagnosis.targetRange.endYear,
            global.bestGlobalLag,
            minimumPairs,
        ).correlation;
        const globalGain = global.bestGlobalR === null || global.currentR === null
            ? 0
            : global.bestGlobalR - global.currentR;
        // COFECHA only searches +/-10 years. For a long physical gap it can report a unit lag
        // inside one 50-year segment even though the older side has a much larger offset. When
        // the newest side is demonstrably still at lag zero, keep the dynamic -2..-100 search
        // authoritative instead of injecting a contradictory missing/false-ring draft.
        if (shouldSuppressAliasedCofechaUnitDraft({
            regionLagMagnitude: region.lag,
            globalLag: global.bestGlobalLag,
            globalGain,
            newerAtZero,
            newerAtGlobal,
        })) {
            return [];
        }
    }

    if (region.lag >= 2) {
        // 自动 partialMove 只有物理缺失对应的负向移动；正向大 lag 不转换为自动编辑。
        if (region.editType !== "insert") return [];
        const shiftYears = -region.lag;
        if (!isAutomaticPartialShift(shiftYears, {
            maxPartialGapYears: config.maxPartialGapYears,
            lagMin: config.lagMin,
            seriesLength:
                diagnosis.targetRange.endYear - diagnosis.targetRange.startYear + 1,
        })) return [];

        const breakpoint = partialMoveBreakpoint(
            region.endYear + 1,
            diagnosis.targetRange.startYear,
            diagnosis.targetRange.endYear,
            shiftYears,
        );
        if (!breakpoint) return [];
        const sourceSegment = getSegmentNearYear(
            diagnosis.segments,
            breakpoint.lastMovedYear,
        );
        if (!sourceSegment) return [];

        return [{
            targetTree: diagnosis.targetTree,
            operationType: "SHIFT_RANGE",
            candidateType: "batchMoveYears",
            mode: "partialRangeMove",
            anchorYear: breakpoint.firstFixedYear,
            selectedRange: breakpoint.movedRange,
            missingRange: breakpoint.missingRange,
            deltaYears: shiftYears,
            sourceSegment,
            algorithmSource: uniqueAlgorithmSources([
                "cofecha_segment_lag",
                "segmented_diagnosis",
            ]),
            recallSourceTags: [
                `cofecha_partial_shift:${shiftYears}`,
                `cofecha_first_fixed_year:${breakpoint.firstFixedYear}`,
            ],
            partialRangeMoveEvidence: makePartialRangeEvidence(
                diagnosis,
                breakpoint.movedRange,
                shiftYears,
            ),
        }];
    }

    const editType: LocalEditType = region.editType === "insert" ? "insertMissingYear" : "deleteFalseYear";
    const editKind = region.editType;
    // 真编辑点常在最新 flagged 段的较新边界附近；区域向较新延伸半个段长以覆盖边界年。
    const regionStart = Math.max(diagnosis.targetRange.startYear, region.startYear - 2);
    const regionEnd = Math.min(diagnosis.targetRange.endYear, region.endYear + Math.floor(config.segmentLength / 2));
    const boundaryYear = Math.min(diagnosis.targetRange.endYear, region.endYear);

    // topN=3：实测最佳平衡（真实 COFECHA 基准）——缺轮 top5 0.70→0.73/top1 0.48→0.52、伪轮 top5 0.58→0.67；
    // 取更多(6)会稀释伪轮 top1，取更少(2)会丢失缺轮 top5 增益。
    const sharpYears = prescanEditYearsInRegion(diagnosis, editKind, regionStart, regionEnd, boundaryYear, config, 3);
    if (sharpYears.length === 0) return [];

    const sourceSegment = getSegmentNearYear(diagnosis.segments, boundaryYear);
    if (!sourceSegment) return [];

    return sharpYears.map((candidateYear) => {
        const { alignment } = getLocalEditAlignmentForSegment(diagnosis, sourceSegment, editType, candidateYear, config);
        const draft = createLocalEditDraft(diagnosis, sourceSegment, editType, candidateYear, alignment);
        return {
            ...draft,
            algorithmSource: uniqueAlgorithmSources([...(draft.algorithmSource ?? []), "cofecha_segment_lag"]),
        };
    });
};

/**
 * AR(1) 预白化兜底召回（仅在没有 COFECHA 输出时启用；COFECHA 优先）。
 *
 * 用 AR 预白化重跑一遍段级诊断（去自相关、锐化缺轮区域检测，实测真实缺轮 top5 0.70→0.80），
 * 仅取其 **缺轮(INSERT)** 候选年——AR 对伪轮/整条/低频信号有害，故不取 delete/move。
 * 这些候选仍交回统一的 z-score evaluation 排序与 hard gate（clean 假阳性、false/whole 由 z-score 保护）。
 * 删年/整条仍走主 z-score 管线。
 */
export const makeArRecallInsertDrafts = (
    siteData: RwlSiteData,
    primaryDiagnosis: SeriesCoreDiagnosis,
    config: EffectiveDiagnosisConfig,
): CandidateDraft[] => {
    // 门控：若主（z-score）诊断已显示整条/部分移动信号，则不加 AR 缺轮候选——AR 缺轮会与
    // whole/partial 候选竞争并盖过真值（实测 whole 1.00→0.75、partial 掉档）。AR 只在“纯局部缺轮”场景补召回。
    const hasMovePattern = primaryDiagnosis.propagationPatterns.some((pattern) => (
        pattern.patternType === "possibleWholeSeriesMove" || pattern.patternType === "possiblePartialRangeMove"
    ));
    const globalMatch = primaryDiagnosis.globalSlidingMatch;
    const hasGlobalMove = globalMatch.bestGlobalLag !== 0
        && (globalMatch.bestGlobalTLike ?? 0) >= CrossdateConfig.globalMinTLike;
    if (hasMovePattern || hasGlobalMove) return [];

    const arDiagnosis = diagnoseSeriesCore(siteData, primaryDiagnosis.targetTree, config, ar1WhitenSeries);
    if (!arDiagnosis) return [];
    // AR 诊断里若出现整条/部分移动迹象，同样跳过（避免把整条移动错判成多个缺轮插入）。
    if (arDiagnosis.propagationPatterns.some((pattern) => (
        pattern.patternType === "possibleWholeSeriesMove" || pattern.patternType === "possiblePartialRangeMove"
    ))) {
        return [];
    }
    return [...makePatternDrafts(arDiagnosis, config), ...makeSegmentDrafts(arDiagnosis, config)]
        .filter((draft) => draft.operationType === "INSERT_MISSING_RING")
        .map((draft) => ({
            ...draft,
            algorithmSource: uniqueAlgorithmSources([...(draft.algorithmSource ?? []), "ar_prewhiten_recall"]),
        }));
};

export const makeSegmentDrafts = (
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
            // 单个（未被传播模式覆盖的）B-like lag±1 段也可能是缺/伪轮边界——
            // 不再用段中点（常偏离真值），改用区域内锐利 prescan 选精确年（多候选交给 evaluation 精排）。
            const editKind = editType === "insertMissingYear" ? "insert" : "delete";
            const regionStart = segment.startYear - 2;
            const regionEnd = Math.min(diagnosis.targetRange.endYear, segment.endYear + config.segmentLength);
            const sharpYears = prescanEditYearsInRegion(
                diagnosis, editKind, regionStart, regionEnd, segment.endYear, config, 6,
            );
            const anchorYears = sharpYears.length > 0 ? sharpYears : [anchorYear];
            anchorYears.forEach((candidateYear) => {
                const { alignment } = getLocalEditAlignmentForSegment(
                    diagnosis, segment, editType, candidateYear, config,
                );
                drafts.push(createLocalEditDraft(diagnosis, segment, editType, candidateYear, alignment));
            });
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

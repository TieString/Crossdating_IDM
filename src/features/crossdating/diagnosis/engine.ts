/**
 * 内部交叉定年诊断流程的编排层。
 * 这里只保留统一入口，把分段诊断、候选生成、候选评估和排序串起来。
 */
import {
    deleteYearWithMode,
    insertMissingYearAtSide,
    moveSeriesTailByOffset,
} from "@/features/rwl/edit";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import { CrossdateConfig, getConfig } from "./config";
import {
    buildMasterNarrowYears,
    buildScoringMaster,
    correlationForSegment,
    getRangeForSeries,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import { diagnoseSeriesCore, createSeriesSummary } from "./segments";
import {
    makeArRecallInsertDrafts,
    makeCofechaDrivenDrafts,
    makeGlobalSlidingDrafts,
    makePatternDrafts,
    makeSegmentDrafts,
} from "./drafts";
import { makeBayesianRecallDrafts } from "./candidateRecallExpansion";
import { evaluateDraft } from "./evaluation";
import { parseCofechaHints } from "./cofechaHints";
import {
    compareDiagnosisCandidates,
    dedupeDiagnosisCandidates,
    rankDiagnosisCandidates,
} from "./candidateUtils";
import type {
    CrossdatingDiagnosis,
    DiagnosisCandidateOperation,
    DiagnosisConfidence,
    DiagnosisOptions,
    LocalCrossdatingSimulation,
    LocalSimulationOperationType,
    LocalSimulationOption,
    SeriesCoreDiagnosis,
} from "./types";

export {
    getDiagnosisCandidateLabel,
    isActionableDiagnosisCandidate,
    markCandidatesStale,
    rankDiagnosisCandidates,
    selectSafeDiagnosisCandidateBatch,
} from "./candidateUtils";

export function diagnoseCrossdating(
    siteData: RwlSiteData,
    options: DiagnosisOptions = {},
): CrossdatingDiagnosis {
    const config = getConfig(options);
    const cofechaHints = options.cofechaText ? parseCofechaHints(options.cofechaText) : null;
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
        // COFECHA [A] 段级 lag 表驱动候选（仅在用户提供 cofechaText 时生效）：用 COFECHA 干净的段级定年
        // 确定缺/伪轮区域与类型，解决内部分段在弱相关区检测不到真区域的召回问题。无 COFECHA 时不影响。
        ...makeCofechaDrivenDrafts(diagnosis, config, cofechaHints),
        // AR 预白化兜底（默认关闭，见 config.arRecallFallback；仅在无 COFECHA 输出且显式开启时）：
        // 去自相关、锐化缺轮区域检测，补充缺轮(INSERT)召回候选，仍交回 z-score evaluation 排序。
        ...(CrossdateConfig.arRecallFallback.enabled && !cofechaHints
            ? makeArRecallInsertDrafts(siteData, diagnosis, config)
            : []),
        // COFECHA-like 贝叶斯段级 lag 路径召回扩展（默认关闭，见 config.bayesian.enableRecallInjection）：
        // 经实测并入候选池会稀释 ±1 精排并引入 clean 假阳性，故默认不并入；模块保留并单元测试。
        ...(CrossdateConfig.bayesian.enableRecallInjection
            ? makeBayesianRecallDrafts(diagnosis, config, cofechaHints).drafts
            : []),
    ]);
    const evaluatedCandidates = dedupeDiagnosisCandidates(
        candidateDrafts
            .map((draft) => {
                const before = seriesDiagnoses.find((diagnosis) => diagnosis.targetTree === draft.targetTree);
                return before ? evaluateDraft(siteData, before, draft, config, cofechaHints) : null;
            })
            .filter((candidate): candidate is DiagnosisCandidateOperation => candidate !== null)
            // AR 兜底候选（无 COFECHA 时）只保留 z-score 评估判为 strong 的：AR 预白化对 clean 噪声过敏感，
            // 仅靠 hard gate 仍会漏过个别 clean 假阳性；要求 strong 可在保留真实缺轮召回的同时把 clean 假阳性压回 0。
            .filter((candidate) => (
                !candidate.algorithmSource.includes("ar_prewhiten_recall")
                || candidate.evidence.candidateStrength === "strong"
            )),
    );
    // 每条序列单独排序并取前 maxTopCandidates 个候选，避免全局名额被某条序列挤占，
    // 保证按序列查看时每条都能看到属于自己的候选建议。
    const candidatesByTree = new Map<string, DiagnosisCandidateOperation[]>();
    evaluatedCandidates.forEach((candidate) => {
        const group = candidatesByTree.get(candidate.targetTree);
        if (group) {
            group.push(candidate);
        } else {
            candidatesByTree.set(candidate.targetTree, [candidate]);
        }
    });
    const rankedCandidates = Array.from(candidatesByTree.values())
        .flatMap((group) => rankDiagnosisCandidates(group)
            .sort(compareDiagnosisCandidates)
            .slice(0, config.maxTopCandidates))
        .sort(compareDiagnosisCandidates);
    // 每次只建议最近的一处编辑：仅当同序列确有**多处“强”编辑建议**（分处于多个区域）时，
    // 才只保留最新（最靠树皮）那一处、隐藏更早的——处理它并重新诊断后，下一处会自然浮现（逐个向树心）。
    // 只在有 COFECHA 输出时生效：COFECHA 驱动的候选会紧密聚在 flagged 小窗内（~7 年），多个窗=多处真实编辑；
    // 无 COFECHA 时候选过于零散、不可靠，不做收窄以免误删单处编辑的真值。
    const editCutoffByTree = new Map<string, number>();
    if (cofechaHints) {
        const acceptanceThreshold = CrossdateConfig.evaluationV2.acceptanceThreshold;
        const strongEditYearsByTree = new Map<string, number[]>();
        rankedCandidates.forEach((candidate) => {
            if (candidate.targetYear === undefined) return;
            if (candidate.operationType !== "INSERT_MISSING_RING" && candidate.operationType !== "DELETE_FALSE_RING") return;
            // 仅“高置信”的编辑才算作一处真实编辑区域，避免单处编辑旁的杂散强候选被误判成第二处而误删真值。
            if (candidate.score < acceptanceThreshold || candidate.ambiguous || candidate.confidenceLevel !== "high") return;
            const years = strongEditYearsByTree.get(candidate.targetTree) ?? [];
            years.push(candidate.targetYear);
            strongEditYearsByTree.set(candidate.targetTree, years);
        });
        strongEditYearsByTree.forEach((years, tree) => {
            const sorted = Array.from(new Set(years)).sort((a, b) => b - a); // 新→老
            const regions: number[][] = [];
            sorted.forEach((year) => {
                const last = regions[regions.length - 1];
                if (last && Math.abs(last[last.length - 1] - year) <= CrossdateConfig.suggestedRangeMaxWidth) last.push(year);
                else regions.push([year]);
            });
            if (regions.length < 2) return; // 只有一处强编辑：保持原样，不隐藏（避免单处编辑被杂散候选误删真值）
            // 确有多处强编辑：只保留最新那一处及其窗口，隐藏更早处（处理后复诊会浮现下一处）。
            const cutoff = Math.min(...regions[0]) - CrossdateConfig.suggestedRangeMaxWidth;
            editCutoffByTree.set(tree, cutoff);
        });
    }
    const candidates = rankedCandidates.filter((candidate) => {
        if (candidate.targetYear === undefined) return true;
        if (candidate.operationType !== "INSERT_MISSING_RING" && candidate.operationType !== "DELETE_FALSE_RING") return true;
        const cutoff = editCutoffByTree.get(candidate.targetTree);
        return cutoff === undefined || candidate.targetYear >= cutoff;
    });
    // 范围建议：同序列同类型(缺轮/伪轮)保留下来的候选若聚集成小窗（跨度 <= suggestedRangeMaxWidth），
    // 标注 suggestedRange——保证真值落在其内、且窗口远小于 COFECHA 段，供人工复核（用户的伪轮口径）。
    const rangeYears = new Map<string, number[]>();
    candidates.forEach((candidate) => {
        if (candidate.targetYear === undefined) return;
        if (candidate.operationType !== "INSERT_MISSING_RING" && candidate.operationType !== "DELETE_FALSE_RING") return;
        const key = `${candidate.targetTree}:${candidate.operationType}`;
        const years = rangeYears.get(key) ?? [];
        years.push(candidate.targetYear);
        rangeYears.set(key, years);
    });
    const suggestedRangeByGroup = new Map<string, { startYear: number; endYear: number }>();
    rangeYears.forEach((years, key) => {
        if (years.length < 2) return;
        const startYear = Math.min(...years);
        const endYear = Math.max(...years);
        if (endYear - startYear + 1 <= CrossdateConfig.suggestedRangeMaxWidth) {
            suggestedRangeByGroup.set(key, { startYear, endYear });
        }
    });
    candidates.forEach((candidate) => {
        const range = suggestedRangeByGroup.get(`${candidate.targetTree}:${candidate.operationType}`);
        if (range) candidate.suggestedRange = range;
    });
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

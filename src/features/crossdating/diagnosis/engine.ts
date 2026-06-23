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
import { getConfig } from "./config";
import {
    buildMasterNarrowYears,
    buildScoringMaster,
    correlationForSegment,
    getRangeForSeries,
    preprocessSeries,
    toNumericSeries,
} from "./series";
import { diagnoseSeriesCore, createSeriesSummary } from "./segments";
import { makeGlobalSlidingDrafts, makePatternDrafts, makeSegmentDrafts } from "./drafts";
import { evaluateDraft } from "./evaluation";
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
    const evaluatedCandidates = dedupeDiagnosisCandidates(
        candidateDrafts
            .map((draft) => {
                const before = seriesDiagnoses.find((diagnosis) => diagnosis.targetTree === draft.targetTree);
                return before ? evaluateDraft(siteData, before, draft, config) : null;
            })
            .filter((candidate): candidate is DiagnosisCandidateOperation => candidate !== null),
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
    const candidates = Array.from(candidatesByTree.values())
        .flatMap((group) => rankDiagnosisCandidates(group)
            .sort(compareDiagnosisCandidates)
            .slice(0, config.maxTopCandidates))
        .sort(compareDiagnosisCandidates);
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

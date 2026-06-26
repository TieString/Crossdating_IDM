/**
 * 候选召回扩展。
 *
 * 把 HMM 边界后验、master 窄轮、target 局部异常、COFECHA hints 等多源证据
 * 转成插/删年候选草案（带 bayesianPosterior 与证据 tags），目标是把真实位置可靠地
 * 送进候选集（top5 recall）。本阶段不过度过滤——交给后续 evaluation/rerank 裁汰。
 */
import { CrossdateConfig } from "./config";
import { preprocessSeries } from "./series";
import { getSegmentNearYear, prescanEditYearsInRegion } from "./rangeMove";
import { uniqueAlgorithmSources } from "./candidateUtils";
import { inferBayesianBoundaries, type BayesianBoundaryResult, type BayesianPipelineParams } from "./boundaryPosterior";
import { getCofechaEvidenceForYear, type CofechaHints } from "./cofechaHints";
import type {
    CandidateDraft,
    EffectiveDiagnosisConfig,
    LocalEditType,
    SeriesCoreDiagnosis,
} from "./types";

export const buildBayesianPipelineParams = (): BayesianPipelineParams => {
    const b = CrossdateConfig.bayesian;
    return {
        table: {
            lagRange: [...b.lagRange] as [number, number],
            scales: [...b.scales],
            stepByScale: b.stepByScale,
            minEffectiveNByScale: b.minEffectiveNByScale,
            minPairs: CrossdateConfig.minPairsForCorrelation,
        },
        likelihood: b.likelihood,
        hmm: {
            maxState: b.hmm.maxState,
            logStay: b.hmm.logStay,
            logStep1: b.hmm.logStep1,
            logStepBig: b.hmm.logStepBig,
            minObsLogProb: Math.log(1e-6),
        },
        scaleWeights: b.scaleWeights,
        fuseWindow: b.recall.multiScaleFuseWindow,
        minObsLogProb: Math.log(1e-6),
    };
};

const operationFor = (editType: LocalEditType): Pick<CandidateDraft, "operationType" | "candidateType"> => (
    editType === "insertMissingYear"
        ? { operationType: "INSERT_MISSING_RING", candidateType: "insertMissingYear" }
        : { operationType: "DELETE_FALSE_RING", candidateType: "deleteFalseYear" }
);

const makeDraft = (
    diagnosis: SeriesCoreDiagnosis,
    editType: LocalEditType,
    year: number,
    bayesianPosterior: number,
    supportScales: number,
    tags: string[],
): CandidateDraft | null => {
    const segment = getSegmentNearYear(diagnosis.segments, year);
    if (!segment) return null;
    return {
        targetTree: diagnosis.targetTree,
        ...operationFor(editType),
        anchorYear: year,
        targetYear: year,
        selectedRange: { startYear: diagnosis.targetRange.startYear, endYear: year },
        missingRange: editType === "insertMissingYear" ? { startYear: year, endYear: year } : undefined,
        side: "right",
        sourceSegment: segment,
        bayesianPosterior,
        bayesianSupportScales: supportScales,
        recallSourceTags: tags,
        algorithmSource: uniqueAlgorithmSources(["bayesian_lag_path", "segmented_diagnosis"]),
    };
};

/**
 * 计算 master 局部窄轮年（指针年）集合：master 值比邻域明显偏窄。
 */
const masterNarrowYearsInRange = (
    diagnosis: SeriesCoreDiagnosis,
    start: number,
    end: number,
): Set<number> => {
    const result = new Set<number>();
    const master = diagnosis.master.data;
    for (let y = start; y <= end; y += 1) {
        const v = master.get(y);
        if (v === undefined) continue;
        const neighbors: number[] = [];
        for (let d = -3; d <= 3; d += 1) {
            if (d === 0) continue;
            const nv = master.get(y + d);
            if (nv !== undefined) neighbors.push(nv);
        }
        if (neighbors.length < 3) continue;
        const mean = neighbors.reduce((s, x) => s + x, 0) / neighbors.length;
        if (mean - v >= 0.8) result.add(y); // 比邻域窄 0.8 个标准化单位
    }
    return result;
};

export type BayesianRecallResult = {
    drafts: CandidateDraft[];
    boundaryResult: BayesianBoundaryResult;
};

/**
 * 从 HMM 边界 + 多源证据生成插/删年候选草案。
 */
export const makeBayesianRecallDrafts = (
    diagnosis: SeriesCoreDiagnosis,
    config: EffectiveDiagnosisConfig,
    cofechaHints?: CofechaHints | null,
): BayesianRecallResult => {
    const params = buildBayesianPipelineParams();
    const boundaryResult = inferBayesianBoundaries(
        {
            targetId: diagnosis.targetTree,
            target: preprocessSeries(diagnosis.rawTarget),
            master: diagnosis.master.data,
            range: diagnosis.targetRange,
        },
        params,
    );
    const recall = CrossdateConfig.bayesian.recall;
    const drafts: CandidateDraft[] = [];
    const seen = new Set<string>();

    const addCandidate = (editType: LocalEditType, year: number, posterior: number, supportScales: number, tags: string[]) => {
        if (year <= diagnosis.targetRange.startYear + 1 || year >= diagnosis.targetRange.endYear - 1) return;
        const key = `${editType}:${year}`;
        if (seen.has(key)) return;
        seen.add(key);
        const draft = makeDraft(diagnosis, editType, year, posterior, supportScales, tags);
        if (draft) drafts.push(draft);
    };

    // 关键：HMM 边界只给出“区域”，区域内用同一锐利 prescan 挑精确年（少量，避免枚举稀释精排）。
    const expandBoundaries = (editType: LocalEditType, floor: number) => {
        const isInsert = editType === "insertMissingYear";
        const boundaries = boundaryResult.boundaries
            .filter((b) => (isInsert ? b.insertPosterior : b.deletePosterior) >= floor)
            .slice(0, recall.maxBoundariesPerType);
        boundaries.forEach((b) => {
            const posterior = isInsert ? b.insertPosterior : b.deletePosterior;
            const window = recall.boundaryWindow;
            const narrow = isInsert ? masterNarrowYearsInRange(diagnosis, b.year - window, b.year + window) : new Set<number>();
            // 区域内锐利预扫描 → top-2 精确年。
            const sharpYears = prescanEditYearsInRegion(
                diagnosis,
                isInsert ? "insert" : "delete",
                b.year - window,
                b.year + window,
                b.year,
                config,
                2,
            );
            // master 窄轮（指针）年也作为候选——真实缺轮常落在窄轮年。
            const narrowYears = isInsert ? Array.from(narrow) : [];
            const candidateYears = Array.from(new Set([...sharpYears, ...narrowYears]));
            candidateYears.forEach((y) => {
                const tags = ["hmmBoundary"];
                if (b.supportScales.length >= 2) tags.push("multiScale");
                if (isInsert && narrow.has(y)) tags.push("masterNarrow");
                if (cofechaHints && getCofechaEvidenceForYear(cofechaHints, y) > 0) tags.push("cofecha");
                addCandidate(editType, y, posterior, b.supportScales.length, tags);
            });
        });
    };

    expandBoundaries("insertMissingYear", recall.insertPosteriorFloor);
    if (CrossdateConfig.bayesian.recall.enableDeleteRecall) {
        expandBoundaries("deleteFalseYear", recall.deletePosteriorFloor);
    }

    return { drafts, boundaryResult };
};

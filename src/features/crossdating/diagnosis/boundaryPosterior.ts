/**
 * 多尺度边界后验融合 + 贝叶斯流程编排。
 *
 * 各尺度（30/50/70）独立跑 HMM 得到边界后验，再按年份邻近（±fuseWindow）加权融合：
 * 多个尺度在同一边界 ±5 年内支持同一类型 → confidence 提升。
 * 同时导出整条 offset 后验（whole-series move 可能性）。
 */
import { computeSegmentLagTable, type SegmentLagTableParams } from "./segmentLagTable";
import { convertLagTableToLikelihood, type LagLikelihoodParams, type SegmentLagLikelihoodRow } from "./segmentLagLikelihood";
import { runHmmForScale, type HmmParams, type ScaleBoundaryPosterior } from "./bayesianLagPath";
import type { NumericSeries, YearRange } from "./types";

export type MultiScaleBoundaryPosterior = {
    year: number;
    insertPosterior: number;
    deletePosterior: number;
    supportScales: number[];
    scalePosteriors: Record<number, ScaleBoundaryPosterior>;
    confidence: number;
};

export type BayesianBoundaryResult = {
    targetId: string;
    boundaries: MultiScaleBoundaryPosterior[];
    wholeSeriesLagPosterior: Record<number, number>;
    likelihoodRowsByScale: Record<number, SegmentLagLikelihoodRow[]>;
    averageLagEntropy: number;
};

export type BayesianPipelineParams = {
    table: SegmentLagTableParams;
    likelihood: LagLikelihoodParams;
    hmm: HmmParams;
    scaleWeights: Record<number, number>;
    fuseWindow: number;
    minObsLogProb: number;
};

export type BayesianPipelineInput = {
    targetId: string;
    target: NumericSeries; // z-score
    master: NumericSeries; // z-score
    range: YearRange;
};

const accumulate = (
    map: Map<number, { insert: number; delete: number; weight: number; scales: Set<number>; scalePost: Map<number, ScaleBoundaryPosterior> }>,
    boundary: ScaleBoundaryPosterior,
    scaleWeight: number,
    fuseWindow: number,
    rangeStart: number,
    rangeEnd: number,
): void => {
    for (let d = -fuseWindow; d <= fuseWindow; d += 1) {
        const year = boundary.boundaryYear + d;
        if (year < rangeStart || year > rangeEnd) continue;
        const proximity = 1 - Math.abs(d) / (fuseWindow + 1);
        const w = scaleWeight * proximity;
        const entry = map.get(year) ?? { insert: 0, delete: 0, weight: 0, scales: new Set<number>(), scalePost: new Map() };
        entry.insert += boundary.insertPosterior * w;
        entry.delete += boundary.deletePosterior * w;
        entry.weight += w;
        if (boundary.insertPosterior >= 0.1 || boundary.deletePosterior >= 0.1) {
            entry.scales.add(boundary.scale);
            const existing = entry.scalePost.get(boundary.scale);
            if (!existing || Math.max(boundary.insertPosterior, boundary.deletePosterior)
                > Math.max(existing.insertPosterior, existing.deletePosterior)) {
                entry.scalePost.set(boundary.scale, boundary);
            }
        }
        map.set(year, entry);
    }
};

export const inferBayesianBoundaries = (
    input: BayesianPipelineInput,
    params: BayesianPipelineParams,
): BayesianBoundaryResult => {
    const table = computeSegmentLagTable(input, params.table);
    const allLikelihoodRows = convertLagTableToLikelihood(table, params.likelihood);
    const likelihoodRowsByScale: Record<number, SegmentLagLikelihoodRow[]> = {};
    params.table.scales.forEach((scale) => {
        likelihoodRowsByScale[scale] = allLikelihoodRows
            .filter((row) => row.scale === scale)
            .sort((a, b) => b.centerYear - a.centerYear); // newer→older
    });

    const fuseMap = new Map<number, { insert: number; delete: number; weight: number; scales: Set<number>; scalePost: Map<number, ScaleBoundaryPosterior> }>();
    const wholeAccum: Record<number, { sum: number; weight: number }> = {};
    let entropySum = 0;
    let entropyCount = 0;

    params.table.scales.forEach((scale) => {
        const rows = likelihoodRowsByScale[scale];
        const result = runHmmForScale(input.targetId, scale, rows, params.hmm);
        if (!result) return;
        const scaleWeight = params.scaleWeights[scale] ?? 1.0;
        result.boundaryPosteriors.forEach((b) => accumulate(fuseMap, b, scaleWeight, params.fuseWindow, input.range.startYear, input.range.endYear));
        Object.entries(result.wholeSeriesLagPosterior).forEach(([lag, p]) => {
            const k = Number(lag);
            const acc = wholeAccum[k] ?? { sum: 0, weight: 0 };
            acc.sum += p * scaleWeight;
            acc.weight += scaleWeight;
            wholeAccum[k] = acc;
        });
        entropySum += result.diagnostics.averageLagEntropy * scaleWeight;
        entropyCount += scaleWeight;
    });

    const boundaries: MultiScaleBoundaryPosterior[] = Array.from(fuseMap.entries())
        .map(([year, entry]) => {
            const norm = entry.weight > 0 ? entry.weight : 1;
            const insertPosterior = entry.insert / norm;
            const deletePosterior = entry.delete / norm;
            const supportScales = Array.from(entry.scales).sort((a, b) => a - b);
            const scalePosteriors: Record<number, ScaleBoundaryPosterior> = {};
            entry.scalePost.forEach((v, k) => { scalePosteriors[k] = v; });
            // 多尺度一致支持 → confidence 提升。
            const confidence = Math.max(insertPosterior, deletePosterior) * (1 + 0.25 * Math.max(0, supportScales.length - 1));
            return { year, insertPosterior, deletePosterior, supportScales, scalePosteriors, confidence };
        })
        .sort((a, b) => b.confidence - a.confidence);

    const wholeSeriesLagPosterior: Record<number, number> = {};
    let wholeTotal = 0;
    Object.entries(wholeAccum).forEach(([lag, acc]) => {
        const v = acc.weight > 0 ? acc.sum / acc.weight : 0;
        wholeSeriesLagPosterior[Number(lag)] = v;
        wholeTotal += v;
    });
    if (wholeTotal > 0) {
        Object.keys(wholeSeriesLagPosterior).forEach((k) => { wholeSeriesLagPosterior[Number(k)] /= wholeTotal; });
    }

    return {
        targetId: input.targetId,
        boundaries,
        wholeSeriesLagPosterior,
        likelihoodRowsByScale,
        averageLagEntropy: entropyCount > 0 ? entropySum / entropyCount : 0,
    };
};

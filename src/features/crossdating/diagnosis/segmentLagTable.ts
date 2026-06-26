/**
 * 多尺度 COFECHA-like 段级 lag 相关表。
 *
 * 对目标序列按多个窗口尺度（默认 30/50/70 年）滑动切段，每段计算 lag -10..+10 的完整
 * 相关表（不只取 bestLag），为后续“lag 后验 → HMM 累计 offset 路径推断”提供观测。
 *
 * lag 定义沿用项目约定：target[year] ↔ master[year + lag]。
 * lag < 0：较老侧可能缺轮（insertMissingYear）；lag > 0：较老侧可能多轮（deleteFalseYear）。
 */
import { correlationForSegment, fisherZ, tLikeFromR } from "./series";
import type { NumericSeries, YearRange } from "./types";

export type SegmentLagCorrelation = {
    lag: number;
    r: number | null;
    tLike: number;
    effectiveN: number;
    fisherZ: number;
};

export type SegmentLagTableRow = {
    scale: number;
    step: number;
    startYear: number;
    endYear: number;
    centerYear: number;
    effectiveNAtLag0: number;
    correlations: SegmentLagCorrelation[];
    bestLag: number;
    bestR: number | null;
    bestT: number;
    r0: number | null;
    t0: number;
    rImprovement: number;
    tImprovement: number;
};

export type MultiScaleSegmentLagTable = {
    targetId: string;
    rows: SegmentLagTableRow[];
    lagRange: [number, number];
    scales: number[];
};

export type SegmentLagTableInput = {
    targetId: string;
    target: NumericSeries; // z-score 预处理后的目标
    master: NumericSeries; // z-score 预处理后的 master
    range: YearRange;
};

export type SegmentLagTableParams = {
    lagRange: [number, number];
    scales: number[];
    stepByScale: Record<number, number>;
    minEffectiveNByScale: Record<number, number>;
    minPairs: number;
};

const computeRow = (
    target: NumericSeries,
    master: NumericSeries,
    scale: number,
    step: number,
    startYear: number,
    endYear: number,
    lagMin: number,
    lagMax: number,
    minEffectiveN: number,
): SegmentLagTableRow | null => {
    const base = correlationForSegment(target, master, startYear, endYear, 0, 1);
    const effectiveNAtLag0 = base.samplePairs;
    if (effectiveNAtLag0 < minEffectiveN) return null;

    const correlations: SegmentLagCorrelation[] = [];
    let bestLag = 0;
    let bestR: number | null = base.correlation;
    let bestT = tLikeFromR(base.correlation, effectiveNAtLag0);

    for (let lag = lagMin; lag <= lagMax; lag += 1) {
        const { correlation, samplePairs } = correlationForSegment(target, master, startYear, endYear, lag, 1);
        const r = correlation !== null && Number.isFinite(correlation) ? correlation : null;
        const tLike = tLikeFromR(r, samplePairs);
        correlations.push({ lag, r, tLike, effectiveN: samplePairs, fisherZ: fisherZ(r) });
        if (r !== null && (bestR === null || r > bestR)) {
            bestR = r;
            bestLag = lag;
            bestT = tLike;
        }
    }

    const r0 = base.correlation;
    const t0 = tLikeFromR(r0, effectiveNAtLag0);
    return {
        scale,
        step,
        startYear,
        endYear,
        centerYear: Math.round((startYear + endYear) / 2),
        effectiveNAtLag0,
        correlations,
        bestLag,
        bestR,
        bestT,
        r0,
        t0,
        rImprovement: bestR === null ? 0 : bestR - (r0 ?? -1),
        tImprovement: bestT - t0,
    };
};

export const computeSegmentLagTable = (
    input: SegmentLagTableInput,
    params: SegmentLagTableParams,
): MultiScaleSegmentLagTable => {
    const [lagMin, lagMax] = params.lagRange;
    const rows: SegmentLagTableRow[] = [];

    params.scales.forEach((scale) => {
        const step = Math.max(1, params.stepByScale[scale] ?? Math.floor(scale / 3));
        const minEffectiveN = params.minEffectiveNByScale[scale] ?? Math.floor(scale * 0.4);
        const minLength = Math.max(10, Math.floor(scale * 0.6));
        for (let startYear = input.range.startYear; startYear <= input.range.endYear; startYear += step) {
            const endYear = Math.min(startYear + scale - 1, input.range.endYear);
            if (endYear - startYear + 1 >= minLength) {
                const row = computeRow(
                    input.target,
                    input.master,
                    scale,
                    step,
                    startYear,
                    endYear,
                    lagMin,
                    lagMax,
                    minEffectiveN,
                );
                if (row) rows.push(row);
            }
            if (endYear === input.range.endYear) break;
        }
    });

    return { targetId: input.targetId, rows, lagRange: params.lagRange, scales: params.scales };
};

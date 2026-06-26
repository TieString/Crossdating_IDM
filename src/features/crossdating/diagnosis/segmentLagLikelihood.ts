/**
 * 段级 lag 相关 → lag 后验（likelihood）。
 *
 * 把每段的 lag 相关表转成每个 lag 的概率质量（softmax），而不是硬取 bestLag。
 * 这是 HMM 观测似然的来源：让“这一段在 master 中对应哪个 offset”成为概率分布，
 * 弱信号段自然变平、强信号段集中，从而联合多段做稳健的累计 offset 推断。
 */
import { fisherZ } from "./series";
import type {
    MultiScaleSegmentLagTable,
    SegmentLagTableRow,
} from "./segmentLagTable";

export type SegmentLagLikelihoodRow = SegmentLagTableRow & {
    likelihoodByLag: Record<number, number>;
    posteriorByLag: Record<number, number>;
    bestLagPosterior: number;
    lagEntropy: number;
    lagConcentration: number;
};

export type LagLikelihoodParams = {
    temperature: number;
    wR: number;
    wT: number;
    wImprovement: number;
    minPosteriorFloor: number;
    invalidPenalty: number;
};

const lagScore = (
    r: number | null,
    tLike: number,
    effectiveN: number,
    r0: number | null,
    params: LagLikelihoodParams,
): number => {
    if (r === null || !Number.isFinite(r)) return -params.invalidPenalty * 4;
    const z = fisherZ(r);
    const nWeight = Math.sqrt(Math.max(effectiveN - 3, 1));
    return params.wR * z * nWeight
        + params.wT * tLike
        + params.wImprovement * Math.max(0, r - (r0 ?? -1));
};

const softmaxToPosterior = (
    scores: Map<number, number>,
    temperature: number,
    floor: number,
): Record<number, number> => {
    const temp = Math.max(0.05, temperature);
    const maxScore = Math.max(...scores.values());
    let sum = 0;
    const weights = new Map<number, number>();
    scores.forEach((score, lag) => {
        const w = Math.exp((score - maxScore) / temp);
        weights.set(lag, w);
        sum += w;
    });
    const denom = sum > 0 ? sum : 1;
    const posterior: Record<number, number> = {};
    weights.forEach((w, lag) => {
        posterior[lag] = Math.max(floor, w / denom);
    });
    // 重新归一（floor 之后）。
    const total = Object.values(posterior).reduce((s, v) => s + v, 0) || 1;
    Object.keys(posterior).forEach((k) => {
        posterior[Number(k)] /= total;
    });
    return posterior;
};

const entropyOf = (posterior: Record<number, number>): number => {
    let h = 0;
    Object.values(posterior).forEach((p) => {
        if (p > 0) h -= p * Math.log(p);
    });
    return h;
};

export const convertLagTableToLikelihood = (
    table: MultiScaleSegmentLagTable,
    params: LagLikelihoodParams,
): SegmentLagLikelihoodRow[] => table.rows.map((row) => {
    const scores = new Map<number, number>();
    const likelihoodByLag: Record<number, number> = {};
    row.correlations.forEach((c) => {
        const score = lagScore(c.r, c.tLike, c.effectiveN, row.r0, params);
        scores.set(c.lag, score);
        likelihoodByLag[c.lag] = score;
    });
    const posteriorByLag = softmaxToPosterior(scores, params.temperature, params.minPosteriorFloor);
    let bestLagPosterior = 0;
    Object.values(posteriorByLag).forEach((p) => {
        if (p > bestLagPosterior) bestLagPosterior = p;
    });
    const lagEntropy = entropyOf(posteriorByLag);
    return {
        ...row,
        likelihoodByLag,
        posteriorByLag,
        bestLagPosterior,
        lagEntropy,
        lagConcentration: bestLagPosterior,
    };
});

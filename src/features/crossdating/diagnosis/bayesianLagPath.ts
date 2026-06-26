/**
 * 贝叶斯 / HMM 累计 offset 状态路径推断。
 *
 * 把多段的 lag 后验作为观测，推断整条序列沿时间方向的“隐藏累计 offset 状态路径”。
 * 处理方向 newer→older（与项目固定 endYear 的编辑约定一致）：状态从最新端的 0 出发，
 * 每遇到一个缺轮边界 -1、伪轮边界 +1。状态路径的跳变即插/删边界。
 *
 * - Viterbi → MAP 路径（最可能的 offset 序列）。
 * - Forward-backward → 每个边界处 insert/delete/no-change/move 的后验概率（用于候选召回）。
 *
 * 仅依赖标准对数概率运算，确定性，无随机。
 */
import type { SegmentLagLikelihoodRow } from "./segmentLagLikelihood";

export type HmmParams = {
    maxState: number;
    logStay: number;
    logStep1: number;
    logStepBig: number;
    minObsLogProb: number;
};

export type LagPathState = {
    segmentIndex: number;
    centerYear: number;
    stateLag: number;
    logPosterior: number;
};

export type LagTransitionKind = "none" | "insertMissingYear" | "deleteFalseYear" | "multiYearMove";

export type LagTransition = {
    fromLag: number;
    toLag: number;
    delta: number;
    kind: LagTransitionKind;
    boundaryYearEstimate: number;
    logProbability: number;
};

export type ScaleBoundaryPosterior = {
    boundaryYear: number;
    scale: number;
    insertPosterior: number;
    deletePosterior: number;
    noChangePosterior: number;
    movePosterior: number;
    dominantTransition: "insertMissingYear" | "deleteFalseYear" | "none" | "move";
    confidence: number;
    supportingSegments: SegmentLagLikelihoodRow[];
};

export type BayesianLagPathResult = {
    targetId: string;
    scale: number;
    mapPath: LagPathState[];
    transitions: LagTransition[];
    boundaryPosteriors: ScaleBoundaryPosterior[];
    wholeSeriesLagPosterior: Record<number, number>;
    diagnostics: {
        segmentCount: number;
        stateRange: [number, number];
        averageLagEntropy: number;
        averageLagConcentration: number;
    };
};

const NEG_INF = -1e9;

const logSumExp = (values: number[]): number => {
    let max = NEG_INF;
    for (const v of values) if (v > max) max = v;
    if (max === NEG_INF) return NEG_INF;
    let sum = 0;
    for (const v of values) sum += Math.exp(v - max);
    return max + Math.log(sum);
};

const transitionLogProb = (delta: number, params: HmmParams): number => {
    const abs = Math.abs(delta);
    if (abs === 0) return params.logStay;
    if (abs === 1) return params.logStep1;
    return params.logStepBig;
};

const boundaryKind = (delta: number): LagTransitionKind => {
    if (delta === 0) return "none";
    if (delta === -1) return "insertMissingYear";
    if (delta === 1) return "deleteFalseYear";
    return "multiYearMove";
};

/**
 * 对单一尺度的段序列（已按 centerYear 降序，即 newer→older）运行 HMM。
 */
export const runHmmForScale = (
    targetId: string,
    scale: number,
    rowsNewerToOlder: SegmentLagLikelihoodRow[],
    params: HmmParams,
): BayesianLagPathResult | null => {
    const T = rowsNewerToOlder.length;
    if (T < 2) return null;
    const states: number[] = [];
    for (let s = -params.maxState; s <= params.maxState; s += 1) states.push(s);
    const S = states.length;

    // 观测对数似然：emission[t][k] = log posteriorByLag[state k]。
    const emission: number[][] = rowsNewerToOlder.map((row) => states.map((k) => {
        const p = row.posteriorByLag[k] ?? 0;
        return p > 0 ? Math.log(p) : params.minObsLogProb;
    }));

    // 初始：最新端先验偏向 state 0（newest 端假定已对齐）。
    const initLog: number[] = states.map((k) => (k === 0 ? Math.log(0.6) : Math.log(0.4 / (S - 1))));

    // ── Viterbi ──
    const vlog: number[][] = Array.from({ length: T }, () => new Array(S).fill(NEG_INF));
    const back: number[][] = Array.from({ length: T }, () => new Array(S).fill(0));
    for (let j = 0; j < S; j += 1) vlog[0][j] = initLog[j] + emission[0][j];
    for (let t = 1; t < T; t += 1) {
        for (let j = 0; j < S; j += 1) {
            let best = NEG_INF;
            let bestI = 0;
            for (let i = 0; i < S; i += 1) {
                const cand = vlog[t - 1][i] + transitionLogProb(states[j] - states[i], params);
                if (cand > best) {
                    best = cand;
                    bestI = i;
                }
            }
            vlog[t][j] = best + emission[t][j];
            back[t][j] = bestI;
        }
    }
    let lastBest = NEG_INF;
    let lastState = 0;
    for (let j = 0; j < S; j += 1) {
        if (vlog[T - 1][j] > lastBest) {
            lastBest = vlog[T - 1][j];
            lastState = j;
        }
    }
    const pathStateIdx = new Array(T).fill(0);
    pathStateIdx[T - 1] = lastState;
    for (let t = T - 1; t > 0; t -= 1) pathStateIdx[t - 1] = back[t][pathStateIdx[t]];
    const mapPath: LagPathState[] = rowsNewerToOlder.map((row, t) => ({
        segmentIndex: t,
        centerYear: row.centerYear,
        stateLag: states[pathStateIdx[t]],
        logPosterior: vlog[t][pathStateIdx[t]],
    }));

    // ── Forward-backward（对数域）──
    const fwd: number[][] = Array.from({ length: T }, () => new Array(S).fill(NEG_INF));
    const bwd: number[][] = Array.from({ length: T }, () => new Array(S).fill(NEG_INF));
    for (let j = 0; j < S; j += 1) fwd[0][j] = initLog[j] + emission[0][j];
    for (let t = 1; t < T; t += 1) {
        for (let j = 0; j < S; j += 1) {
            const terms: number[] = [];
            for (let i = 0; i < S; i += 1) {
                terms.push(fwd[t - 1][i] + transitionLogProb(states[j] - states[i], params));
            }
            fwd[t][j] = logSumExp(terms) + emission[t][j];
        }
    }
    for (let j = 0; j < S; j += 1) bwd[T - 1][j] = 0;
    for (let t = T - 2; t >= 0; t -= 1) {
        for (let i = 0; i < S; i += 1) {
            const terms: number[] = [];
            for (let j = 0; j < S; j += 1) {
                terms.push(transitionLogProb(states[j] - states[i], params) + emission[t + 1][j] + bwd[t + 1][j]);
            }
            bwd[t][i] = logSumExp(terms);
        }
    }
    const logZ = logSumExp(fwd[T - 1].slice());

    // 整条 offset 后验（用最新端 state 的边缘分布近似整条移动可能性）。
    const wholeSeriesLagPosterior: Record<number, number> = {};
    states.forEach((s, j) => {
        const gamma = Math.exp(fwd[T - 1][j] + bwd[T - 1][j] - logZ);
        wholeSeriesLagPosterior[s] = gamma;
    });

    // 边界 transition 后验：boundary 在 segment t（newer）与 t+1（older）之间。
    const boundaryPosteriors: ScaleBoundaryPosterior[] = [];
    const transitions: LagTransition[] = [];
    for (let t = 0; t < T - 1; t += 1) {
        let insertP = 0;
        let deleteP = 0;
        let stayP = 0;
        let moveP = 0;
        let bestXi = NEG_INF;
        let bestDelta = 0;
        let bestFrom = 0;
        for (let i = 0; i < S; i += 1) {
            for (let j = 0; j < S; j += 1) {
                const delta = states[j] - states[i];
                const xi = Math.exp(
                    fwd[t][i] + transitionLogProb(delta, params) + emission[t + 1][j] + bwd[t + 1][j] - logZ,
                );
                if (delta === 0) stayP += xi;
                else if (delta === -1) insertP += xi;
                else if (delta === 1) deleteP += xi;
                else moveP += xi;
                if (fwd[t][i] + transitionLogProb(delta, params) + emission[t + 1][j] + bwd[t + 1][j] - logZ > bestXi) {
                    bestXi = fwd[t][i] + transitionLogProb(delta, params) + emission[t + 1][j] + bwd[t + 1][j] - logZ;
                    bestDelta = delta;
                    bestFrom = states[i];
                }
            }
        }
        const total = insertP + deleteP + stayP + moveP || 1;
        insertP /= total;
        deleteP /= total;
        stayP /= total;
        moveP /= total;
        const boundaryYear = Math.round((rowsNewerToOlder[t].centerYear + rowsNewerToOlder[t + 1].centerYear) / 2);
        const dominant = Math.max(insertP, deleteP, stayP, moveP);
        const dominantTransition = dominant === insertP
            ? "insertMissingYear"
            : dominant === deleteP
                ? "deleteFalseYear"
                : dominant === moveP
                    ? "move"
                    : "none";
        boundaryPosteriors.push({
            boundaryYear,
            scale,
            insertPosterior: insertP,
            deletePosterior: deleteP,
            noChangePosterior: stayP,
            movePosterior: moveP,
            dominantTransition,
            confidence: dominant,
            supportingSegments: [rowsNewerToOlder[t], rowsNewerToOlder[t + 1]],
        });
        if (bestDelta !== 0) {
            transitions.push({
                fromLag: bestFrom,
                toLag: bestFrom + bestDelta,
                delta: bestDelta,
                kind: boundaryKind(bestDelta),
                boundaryYearEstimate: boundaryYear,
                logProbability: bestXi,
            });
        }
    }

    const avgEntropy = rowsNewerToOlder.reduce((s, r) => s + r.lagEntropy, 0) / T;
    const avgConcentration = rowsNewerToOlder.reduce((s, r) => s + r.lagConcentration, 0) / T;

    return {
        targetId,
        scale,
        mapPath,
        transitions,
        boundaryPosteriors,
        wholeSeriesLagPosterior,
        diagnostics: {
            segmentCount: T,
            stateRange: [-params.maxState, params.maxState],
            averageLagEntropy: avgEntropy,
            averageLagConcentration: avgConcentration,
        },
    };
};

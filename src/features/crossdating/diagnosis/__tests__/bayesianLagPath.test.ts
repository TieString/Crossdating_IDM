/**
 * HMM lag-path 单元测试（文档测试 2-6）。
 * 用合成段后验直接驱动 HMM，验证缺/伪轮/整条移动的路径与边界后验。
 */
import { describe, expect, it } from "vitest";
import { runHmmForScale, type HmmParams } from "../bayesianLagPath";
import type { SegmentLagLikelihoodRow } from "../segmentLagLikelihood";

const hmmParams: HmmParams = {
    maxState: 3,
    logStay: Math.log(0.96),
    logStep1: Math.log(0.02),
    logStepBig: Math.log(0.002),
    minObsLogProb: Math.log(1e-6),
};

// 构造一个在指定 lag 上强支持的段后验。
let center = 2000;
const makeRow = (supportLag: number, strength = 0.85): SegmentLagLikelihoodRow => {
    const startYear = center - 25;
    const endYear = center + 24;
    const c = center;
    center -= 25; // 越来越老
    const posteriorByLag: Record<number, number> = {};
    const rest = (1 - strength) / 6;
    for (let lag = -3; lag <= 3; lag += 1) posteriorByLag[lag] = lag === supportLag ? strength : rest;
    return {
        scale: 50, step: 25, startYear, endYear, centerYear: c, effectiveNAtLag0: 40,
        correlations: [], bestLag: supportLag, bestR: 0.6, bestT: 4, r0: 0.4, t0: 2,
        rImprovement: 0.2, tImprovement: 2,
        likelihoodByLag: {}, posteriorByLag, bestLagPosterior: strength, lagEntropy: 0.5, lagConcentration: strength,
    };
};

const reset = () => { center = 2000; };

describe("HMM lag path", () => {
    it("测试4：较新侧 lag0、较老侧 lag-1 → 识别 insertMissingYear 边界", () => {
        reset();
        // newer→older：3 段 lag0，再 4 段 lag-1
        const rows = [makeRow(0), makeRow(0), makeRow(0), makeRow(-1), makeRow(-1), makeRow(-1), makeRow(-1)];
        const result = runHmmForScale("T", 50, rows, hmmParams)!;
        expect(result).not.toBeNull();
        // MAP 路径出现 0 → -1
        const lags = result.mapPath.map((p) => p.stateLag);
        expect(lags.slice(0, 3).every((l) => l === 0)).toBe(true);
        expect(lags.slice(3).every((l) => l === -1)).toBe(true);
        // 边界 insert 后验高、dominant = insertMissingYear
        const insertBoundary = result.boundaryPosteriors.find((b) => b.dominantTransition === "insertMissingYear");
        expect(insertBoundary).toBeDefined();
        expect(insertBoundary!.insertPosterior).toBeGreaterThan(0.5);
    });

    it("测试5：较老侧 lag+1 → 识别 deleteFalseYear 边界", () => {
        reset();
        const rows = [makeRow(0), makeRow(0), makeRow(0), makeRow(1), makeRow(1), makeRow(1), makeRow(1)];
        const result = runHmmForScale("T", 50, rows, hmmParams)!;
        const deleteBoundary = result.boundaryPosteriors.find((b) => b.dominantTransition === "deleteFalseYear");
        expect(deleteBoundary).toBeDefined();
        expect(deleteBoundary!.deletePosterior).toBeGreaterThan(0.5);
    });

    it("测试6：所有段 lag+1（整条移动）→ wholeSeriesLagPosterior[+1] 高", () => {
        reset();
        const rows = [makeRow(1), makeRow(1), makeRow(1), makeRow(1), makeRow(1)];
        const result = runHmmForScale("T", 50, rows, hmmParams)!;
        expect(result.wholeSeriesLagPosterior[1]).toBeGreaterThan(result.wholeSeriesLagPosterior[0] ?? 0);
    });

    it("符号正确性：delta=-1 对应 insert、delta=+1 对应 delete（防符号反转）", () => {
        reset();
        const rows = [makeRow(0), makeRow(0), makeRow(0), makeRow(-1), makeRow(-1), makeRow(-1)];
        const result = runHmmForScale("T", 50, rows, hmmParams)!;
        const t = result.transitions.find((tr) => tr.delta === -1);
        expect(t?.kind).toBe("insertMissingYear");
        // 不应出现 delete 主导边界
        const del = result.boundaryPosteriors.find((b) => b.dominantTransition === "deleteFalseYear");
        expect(del).toBeUndefined();
    });
});

/**
 * 段级 lag likelihood / posterior 单元测试（文档测试 2、3）。
 */
import { describe, expect, it } from "vitest";
import { convertLagTableToLikelihood } from "../segmentLagLikelihood";
import { fisherZ, tLikeFromR } from "../series";
import type { MultiScaleSegmentLagTable, SegmentLagTableRow } from "../segmentLagTable";

const makeRow = (rByLag: Record<number, number>): SegmentLagTableRow => {
    const correlations = [] as SegmentLagTableRow["correlations"];
    let bestLag = 0;
    let bestR: number | null = null;
    for (let lag = -10; lag <= 10; lag += 1) {
        const r = rByLag[lag] ?? null;
        correlations.push({ lag, r, tLike: tLikeFromR(r, 40), effectiveN: 40, fisherZ: fisherZ(r) });
        if (r !== null && (bestR === null || r > bestR)) { bestR = r; bestLag = lag; }
    }
    const r0 = rByLag[0] ?? null;
    return {
        scale: 50, step: 25, startYear: 1900, endYear: 1949, centerYear: 1925, effectiveNAtLag0: 40,
        correlations, bestLag, bestR, bestT: tLikeFromR(bestR, 40), r0, t0: tLikeFromR(r0, 40),
        rImprovement: (bestR ?? 0) - (r0 ?? 0), tImprovement: 0,
    };
};

const tableOf = (row: SegmentLagTableRow): MultiScaleSegmentLagTable => ({
    targetId: "T", rows: [row], lagRange: [-10, 10], scales: [50],
});

const params = {
    temperature: 0.45, wR: 1.0, wT: 0.15, wImprovement: 1.5, minPosteriorFloor: 1e-6, invalidPenalty: 2.0,
};

describe("convertLagTableToLikelihood", () => {
    it("测试2：lag -1 显著最优 → posterior[-1] 最大且高、entropy 低", () => {
        const row = makeRow({ [-1]: 0.70, 0: 0.20, 1: -0.10 });
        const [out] = convertLagTableToLikelihood(tableOf(row), params);
        const entries = Object.entries(out.posteriorByLag).map(([k, v]) => [Number(k), v] as const);
        const max = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
        expect(max[0]).toBe(-1);
        expect(out.posteriorByLag[-1]).toBeGreaterThan(0.7);
        expect(out.bestLagPosterior).toBeGreaterThan(0.7);
        // 与平坦分布 log(21) 相比应明显更低。
        expect(out.lagEntropy).toBeLessThan(Math.log(21) * 0.6);
    });

    it("测试3：弱差异 → posterior 不过度集中、confidence 低", () => {
        const row = makeRow({ [-1]: 0.42, 0: 0.40, 1: 0.39 });
        const [out] = convertLagTableToLikelihood(tableOf(row), params);
        expect(out.bestLagPosterior).toBeLessThan(0.5);
        expect(out.lagConcentration).toBeLessThan(0.5);
    });

    it("退化输入（全 null）不崩溃", () => {
        const row = makeRow({});
        const [out] = convertLagTableToLikelihood(tableOf(row), params);
        expect(Number.isFinite(out.lagEntropy)).toBe(true);
        const sum = Object.values(out.posteriorByLag).reduce((s, v) => s + v, 0);
        expect(sum).toBeCloseTo(1, 3);
    });
});

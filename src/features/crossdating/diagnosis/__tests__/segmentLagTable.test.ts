/**
 * 多尺度段级 lag table 单元测试（文档测试 1）。
 */
import { describe, expect, it } from "vitest";
import { computeSegmentLagTable, type SegmentLagTableParams } from "../segmentLagTable";
import { preprocessSeries } from "../series";
import type { NumericSeries } from "../types";

// 构造 master（确定性伪随机），target = master 向较新偏移 1 年（target[y]=master[y-1]）
// → 最优 lag = -1（target[y] ↔ master[y-1]）。
const buildPair = (): { target: NumericSeries; master: NumericSeries } => {
    const master = new Map<number, number>();
    for (let y = 1800; y <= 2000; y += 1) {
        const v = Math.sin(y * 0.7) * 100 + Math.sin(y * 0.23) * 60 + ((y * 9301 + 49297) % 233) - 116;
        master.set(y, 500 + v);
    }
    const target = new Map<number, number>();
    for (let y = 1801; y <= 2000; y += 1) {
        target.set(y, master.get(y - 1)!); // 偏移：target[y] = master[y-1]
    }
    return { target: preprocessSeries(target), master: preprocessSeries(master) };
};

const params: SegmentLagTableParams = {
    lagRange: [-10, 10],
    scales: [50],
    stepByScale: { 50: 25 },
    minEffectiveNByScale: { 50: 20 },
    minPairs: 8,
};

describe("computeSegmentLagTable", () => {
    const { target, master } = buildPair();
    const table = computeSegmentLagTable(
        { targetId: "T", target, master, range: { startYear: 1801, endYear: 2000 } },
        params,
    );

    it("每段保留完整 lag -10..+10 分布", () => {
        expect(table.rows.length).toBeGreaterThan(0);
        table.rows.forEach((row) => {
            const lags = row.correlations.map((c) => c.lag);
            expect(Math.min(...lags)).toBe(-10);
            expect(Math.max(...lags)).toBe(10);
            expect(row.correlations.length).toBe(21);
        });
    });

    it("bestLag = -1（target[y] ↔ master[y-1]）", () => {
        table.rows.forEach((row) => {
            expect(row.bestLag).toBe(-1);
            expect(row.bestR ?? 0).toBeGreaterThan(0.9);
        });
    });

    it("r0/effectiveN 合理", () => {
        table.rows.forEach((row) => {
            expect(row.effectiveNAtLag0).toBeGreaterThanOrEqual(20);
            expect(row.bestR ?? 0).toBeGreaterThan(row.r0 ?? -1);
        });
    });
});

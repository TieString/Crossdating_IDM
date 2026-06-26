/**
 * 改进 2 单元测试：A-like / B-like 自适应阈值（effectiveN + tLike）。
 */
import { describe, expect, it } from "vitest";
import { classifySegment, type SegmentClassificationInput } from "../classification";
import {
    adaptiveImprovementThreshold,
    adaptiveLowCorrelationThreshold,
    fisherZ,
    pearsonR,
    tLikeFromR,
} from "../series";
import { CrossdateConfig } from "../config";

const params = CrossdateConfig.adaptiveClassification;

const classify = (input: Partial<SegmentClassificationInput> & { effectiveN: number }) => {
    const r0 = input.r0 ?? 0.2;
    const bestR = input.bestR ?? 0.6;
    const bestLag = input.bestLag ?? -1;
    const rImprovement = input.rImprovement ?? (bestR - (r0 ?? 0));
    const t0 = input.t0 ?? tLikeFromR(r0, input.effectiveN);
    const bestT = input.bestT ?? tLikeFromR(bestR, input.effectiveN);
    return classifySegment(
        {
            effectiveN: input.effectiveN,
            r0,
            bestLag,
            bestR,
            rImprovement,
            t0,
            bestT,
            tImprovement: input.tImprovement ?? bestT - t0,
        },
        params,
    );
};

describe("数学工具", () => {
    it("pearsonR 对完全相关返回 ~1，对反相关返回 ~-1", () => {
        expect(pearsonR([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1, 5);
        expect(pearsonR([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])).toBeCloseTo(-1, 5);
    });

    it("tLikeFromR 对退化输入安全返回 0", () => {
        expect(tLikeFromR(null, 50)).toBe(0);
        expect(tLikeFromR(0.5, 2)).toBe(0);
        expect(tLikeFromR(1, 50)).toBeGreaterThan(0);
        expect(Number.isFinite(tLikeFromR(0.999999999, 50))).toBe(true);
    });

    it("fisherZ 单调且对 |r|→1 有界", () => {
        expect(fisherZ(0)).toBeCloseTo(0, 5);
        expect(fisherZ(0.5)).toBeGreaterThan(0);
        expect(Number.isFinite(fisherZ(1))).toBe(true);
        expect(Number.isFinite(fisherZ(-1))).toBe(true);
    });

    it("自适应阈值随 effectiveN 收紧", () => {
        expect(adaptiveLowCorrelationThreshold(45)).toBe(0.32);
        expect(adaptiveLowCorrelationThreshold(30)).toBe(0.36);
        expect(adaptiveLowCorrelationThreshold(18)).toBe(0.42);
        expect(adaptiveLowCorrelationThreshold(10)).toBe(0.50);
        expect(adaptiveImprovementThreshold(45)).toBe(0.08);
        expect(adaptiveImprovementThreshold(10)).toBe(0.18);
    });
});

describe("classifySegment 自适应分类", () => {
    it("测试4a：effectiveN=8 小样本 + 弱改进 → 不判为 B_like", () => {
        const result = classify({
            effectiveN: 8,
            r0: 0.25,
            bestR: 0.36,
            bestLag: -1,
            rImprovement: 0.11,
        });
        expect(result.classification).not.toBe("B_like");
    });

    it("测试4b：effectiveN=45 大样本 + 明显改进 → B_like", () => {
        const result = classify({
            effectiveN: 45,
            r0: 0.25,
            bestR: 0.40,
            bestLag: -1,
            rImprovement: 0.15,
        });
        expect(result.classification).toBe("B_like");
        expect(result.confidence).toBeGreaterThan(0);
    });

    it("测试5：r0/bestR 都低、lag 无显著改善 → A_like，不生成插删", () => {
        const result = classify({
            effectiveN: 50,
            r0: 0.10,
            bestR: 0.14,
            bestLag: -3,
            rImprovement: 0.04,
        });
        expect(result.classification).toBe("A_like");
    });

    it("effectiveN < minValidYears → none, confidence 0", () => {
        const result = classify({ effectiveN: 5, r0: 0.1, bestR: 0.5, bestLag: -1, rImprovement: 0.4 });
        expect(result.classification).toBe("none");
        expect(result.confidence).toBe(0);
    });

    it("bestLag=0 永远不是 B_like", () => {
        const result = classify({ effectiveN: 50, r0: 0.5, bestR: 0.55, bestLag: 0, rImprovement: 0.05 });
        expect(result.classification).not.toBe("B_like");
    });
});

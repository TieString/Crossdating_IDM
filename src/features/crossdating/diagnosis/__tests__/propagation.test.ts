/**
 * 改进 1 单元测试：传播模式按 dominantLag / 符号聚类合并。
 */
import { describe, expect, it } from "vitest";
import { detectPropagationPatterns } from "../segments";
import type { SegmentDiagnosis, SegmentDiagnosisFlag, YearRange } from "../types";

let yearCursor = 1800;

const makeSegment = (
    bestLag: number,
    flag: SegmentDiagnosisFlag = "B_like",
    span = 30,
): SegmentDiagnosis => {
    const startYear = yearCursor;
    const endYear = startYear + span - 1;
    yearCursor = endYear + 1; // 相邻（adjacent）窗口
    return {
        targetTree: "T",
        seriesId: "T",
        startYear,
        endYear,
        r0: 0.2,
        bestLag,
        bestR: 0.6,
        flag,
        sampleSize: span,
        currentCorrelation: 0.2,
        bestCorrelation: 0.6,
        samplePairs: span,
        flagged: flag !== "none",
        reason: "",
        effectiveN: span,
        t0: 1,
        bestT: 4,
        tImprovement: 3,
        rImprovement: 0.4,
        fisherZ0: 0.2,
        fisherZBest: 0.7,
        fisherZImprovement: 0.5,
        classification: flag,
        confidence: 0.6,
    };
};

const reset = (start = 1800) => {
    yearCursor = start;
};

const range = (segments: SegmentDiagnosis[]): YearRange => ({
    startYear: segments[0].startYear,
    endYear: segments[segments.length - 1].endYear,
});

describe("detectPropagationPatterns / dominantLag", () => {
    it("测试1：[-1,-1,-2,-1] 合并为 dominantLag=-1, possibleMissingYear", () => {
        reset();
        const segments = [makeSegment(-1), makeSegment(-1), makeSegment(-2), makeSegment(-1)];
        const patterns = detectPropagationPatterns("T", segments, range(segments));

        expect(patterns).toHaveLength(1);
        const [pattern] = patterns;
        expect(pattern.dominantLag).toBe(-1);
        expect(pattern.lagConsistency).toBeCloseTo(0.75, 5);
        expect(pattern.patternType).toBe("possibleMissingYear");
        expect(pattern.confidence).toBeGreaterThan(0);
        expect(pattern.lagVotes[-1]).toBe(3);
        expect(pattern.lagVotes[-2]).toBe(1);
    });

    it("测试1b：[+1,+1,+2,+1] 合并为 dominantLag=+1, possibleFalseYear", () => {
        reset();
        const segments = [makeSegment(1), makeSegment(1), makeSegment(2), makeSegment(1)];
        const patterns = detectPropagationPatterns("T", segments, range(segments));

        expect(patterns).toHaveLength(1);
        expect(patterns[0].dominantLag).toBe(1);
        expect(patterns[0].patternType).toBe("possibleFalseYear");
        expect(patterns[0].lagConsistency).toBeCloseTo(0.75, 5);
    });

    it("测试2：正负 lag 混杂 [-1,+1,-1] 不形成 missing/false 传播", () => {
        reset();
        const segments = [makeSegment(-1), makeSegment(1), makeSegment(-1)];
        const patterns = detectPropagationPatterns("T", segments, range(segments));

        // 符号被切分后各 cluster 不足 2 个窗口 → 不输出（等价 ambiguous，不给插删年建议）。
        expect(patterns.every((p) => p.patternType !== "possibleMissingYear" && p.patternType !== "possibleFalseYear")).toBe(true);
        expect(patterns).toHaveLength(0);
    });

    it("测试3：孤立单个 B-like 不形成传播", () => {
        reset();
        const segments = [makeSegment(-1)];
        const patterns = detectPropagationPatterns("T", segments, range(segments));
        expect(patterns).toHaveLength(0);
    });

    it("abs(dominantLag)>1 且覆盖大部分区域 → possibleWholeSeriesMove", () => {
        reset();
        const segments = [makeSegment(-3), makeSegment(-3), makeSegment(-2)];
        const patterns = detectPropagationPatterns("T", segments, range(segments));
        expect(patterns).toHaveLength(1);
        expect(patterns[0].patternType).toBe("possibleWholeSeriesMove");
        expect(Math.abs(patterns[0].dominantLag)).toBeGreaterThan(1);
    });
});

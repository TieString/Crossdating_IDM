/**
 * 评估度量工具。
 * 这里把整条 before/after 重诊断的结果浓缩成 evaluation hard gate 与评分所需的标量：
 * 平均分段相关、A/B-like 计数、主导传播 lag、整条相关、局部边界相关、局部 GLK。
 */
import { correlationForSegment, pearson } from "./series";
import type {
    NumericSeries,
    PropagationPattern,
    SegmentDiagnosis,
} from "./types";

export const meanSegmentR = (segments: SegmentDiagnosis[]): number => {
    const values = segments
        .map((segment) => segment.r0)
        .filter((value): value is number => value !== null);
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
};

export const countByFlag = (
    segments: SegmentDiagnosis[],
    flag: "A_like" | "B_like",
): number => segments.filter((segment) => segment.flag === flag).length;

/**
 * 取最强传播模式（按 priority 排序的第一个）的 dominantLag，没有则返回 null。
 */
export const dominantPatternLag = (patterns: PropagationPattern[]): number | null => {
    if (patterns.length === 0) return null;
    const strongest = patterns.slice().sort((a, b) => b.priority - a.priority)[0];
    return strongest.dominantLag;
};

/**
 * 编辑年附近的局部窗口相关（lag = 0），针对“边界是否对齐”。
 */
export const localBoundaryCorrelation = (
    target: NumericSeries,
    master: NumericSeries,
    year: number,
    radius: number,
    minPairs: number,
): number | null => {
    const { correlation } = correlationForSegment(
        target,
        master,
        year - radius,
        year + radius,
        0,
        Math.min(minPairs, Math.max(3, Math.floor(radius))),
    );
    return correlation;
};

/**
 * GLK-like 局部一致度：逐年变化的符号一致比例。
 * sign(target[y+1]-target[y]) == sign(master[y+1]-master[y]) 的比例。
 * 比较对数不足时返回 null。
 */
export const localGlk = (
    target: NumericSeries,
    master: NumericSeries,
    year: number,
    radius: number,
    minComparisons: number = 6,
): number | null => {
    let agreements = 0;
    let total = 0;
    for (let y = year - radius; y < year + radius; y += 1) {
        const t0 = target.get(y);
        const t1 = target.get(y + 1);
        const m0 = master.get(y);
        const m1 = master.get(y + 1);
        if (t0 === undefined || t1 === undefined || m0 === undefined || m1 === undefined) continue;
        const st = Math.sign(t1 - t0);
        const sm = Math.sign(m1 - m0);
        if (st === 0 || sm === 0) continue;
        total += 1;
        if (st === sm) agreements += 1;
    }
    if (total < minComparisons) return null;
    return agreements / total;
};

/**
 * 一阶差分相关：对 target 与 master 各取逐年差值后再求 Pearson。
 *
 * 树轮宽度序列自相关高，整体偏移 1 年时 Pearson 相关几乎不变（判别力极弱）；
 * 取一阶差分相当于高通滤波，去除低频自相关，对“错位一年”高度敏感——
 * 这是精确定位缺轮/伪轮年份的关键信号（与 COFECHA 思路一致）。
 */
export const firstDifferenceCorrelation = (
    target: NumericSeries,
    master: NumericSeries,
    startYear: number,
    endYear: number,
    minPairs: number,
    lag = 0,
): number | null => {
    const pairs: Array<[number, number]> = [];
    for (let year = startYear + 1; year <= endYear; year += 1) {
        const t1 = target.get(year);
        const t0 = target.get(year - 1);
        const m1 = master.get(year + lag);
        const m0 = master.get(year - 1 + lag);
        if (t1 === undefined || t0 === undefined || m1 === undefined || m0 === undefined) continue;
        pairs.push([t1 - t0, m1 - m0]);
    }
    return pearson(pairs, Math.max(3, Math.min(minPairs, pairs.length)));
};

/**
 * 编辑年处的边界对齐锐度（逐点分类）：较老侧每点应更接近 master 的移位位置(year+shiftLag)、
 * 较新侧每点应更接近 lag0 位置(year)。真实编辑年两侧一致率都最高，是 ±1 精确定位的锐利信号。
 * 返回 (olderFrac-0.5)+(newerFrac-0.5) ∈ [-1,1]。target 应为 z-score 后的“编辑前”序列。
 */
export const boundaryAlignmentSharpness = (
    target: NumericSeries,
    master: NumericSeries,
    boundaryYear: number,
    shiftLag: number,
    halfWindow = 15,
): number => {
    let olderTotal = 0;
    let olderShiftPref = 0;
    for (let y = boundaryYear - halfWindow; y <= boundaryYear - 1; y += 1) {
        const t = target.get(y);
        const mAligned = master.get(y);
        const mShifted = master.get(y + shiftLag);
        if (t === undefined || mAligned === undefined || mShifted === undefined) continue;
        olderTotal += 1;
        if (Math.abs(t - mShifted) < Math.abs(t - mAligned)) olderShiftPref += 1;
    }
    let newerTotal = 0;
    let newerAlignPref = 0;
    for (let y = boundaryYear + 1; y <= boundaryYear + halfWindow; y += 1) {
        const t = target.get(y);
        const mAligned = master.get(y);
        const mShifted = master.get(y + shiftLag);
        if (t === undefined || mAligned === undefined || mShifted === undefined) continue;
        newerTotal += 1;
        if (Math.abs(t - mAligned) < Math.abs(t - mShifted)) newerAlignPref += 1;
    }
    if (olderTotal < 5 || newerTotal < 5) return 0;
    return (olderShiftPref / olderTotal - 0.5) + (newerAlignPref / newerTotal - 0.5);
};

export const meanAbsLag = (segments: SegmentDiagnosis[]): number => {
    const bLike = segments.filter((segment) => segment.flag === "B_like" && segment.bestLag !== 0);
    if (bLike.length === 0) return 0;
    return bLike.reduce((sum, segment) => sum + Math.abs(segment.bestLag), 0) / bLike.length;
};

/**
 * 整条序列在 lag=0 下与 master 的相关（whole-series r）。
 * 直接用并行年份配对，避免依赖 globalSlidingMatch 的缓存口径。
 */
export const wholeSeriesCorrelation = (
    target: NumericSeries,
    master: NumericSeries,
    minPairs: number,
): number => {
    const pairs: Array<[number, number]> = [];
    target.forEach((value, year) => {
        const masterValue = master.get(year);
        if (masterValue !== undefined) {
            pairs.push([value, masterValue]);
        }
    });
    return pearson(pairs, minPairs) ?? 0;
};

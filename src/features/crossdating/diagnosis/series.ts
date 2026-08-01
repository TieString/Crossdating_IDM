/**
 * 诊断算法使用的数值序列基础工具。
 * 这里负责宽度过滤、z-score 标准化、相关计算、窗口切分和派生 master chronology 构建。
 */
import { buildReferenceSeries, type ReferenceSeriesConfig } from "../reference";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import { stopMarker } from "@/shared/constants";
import type { EffectiveDiagnosisConfig, NumericSeries, ScoringMaster, ScoringMasterYear, YearRange } from "./types";

export type SeriesPreprocess = (series: NumericSeries) => NumericSeries;
export type SeriesPreprocessCache = Map<SeriesPreprocess, WeakMap<RwlTreeData, NumericSeries>>;

export const createSeriesPreprocessCache = (): SeriesPreprocessCache => new Map();

const isUsableWidth = (value: number | null | undefined): value is number => (
    typeof value === "number"
    && Number.isFinite(value)
    && value > 0
    && value !== stopMarker.value
);

export const toNumericSeries = (treeData: RwlTreeData | undefined): NumericSeries => {
    const result = new Map<number, number>();
    treeData?.forEach((value, year) => {
        if (isUsableWidth(value)) {
            result.set(year, value);
        }
    });
    return result;
};

const zScoreSeries = (series: NumericSeries): NumericSeries => {
    const values = Array.from(series.values());
    if (values.length === 0) return new Map();

    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const sd = Math.sqrt(variance);

    if (!Number.isFinite(sd) || sd === 0) {
        return new Map(Array.from(series.keys()).map((year) => [year, 0]));
    }

    return new Map(Array.from(series.entries()).map(([year, value]) => [year, (value - mean) / sd]));
};

export const preprocessSeries = (series: NumericSeries): NumericSeries => zScoreSeries(series);

const preprocessTree = (
    treeData: RwlTreeData | undefined,
    preprocess: SeriesPreprocess,
    cache: SeriesPreprocessCache | undefined,
): NumericSeries => {
    if (!treeData) return new Map();
    if (!cache) return preprocess(toNumericSeries(treeData));
    let byTree = cache.get(preprocess);
    if (!byTree) {
        byTree = new WeakMap();
        cache.set(preprocess, byTree);
    }
    const existing = byTree.get(treeData);
    if (existing) return existing;
    const result = preprocess(toNumericSeries(treeData));
    byTree.set(treeData, result);
    return result;
};

/**
 * AR(1) 预白化（COFECHA 标准做法之一）：拟合 lag-1 自相关系数 phi，取残差 v[t]-phi*v[t-1] 再 z-score。
 * 树轮宽度自相关高（整体偏移 1 年时 Pearson 几乎不变，定位 ±1 极难）；AR 残差去除自相关，
 * 使段级 lag/缺轮区域检测更锐利（实测真实缺轮 top5 0.70→0.80）。比固定系数=1 的一阶差分更温和。
 * 仅在相邻年（无缺口）处取残差。用作**无 COFECHA 输出时的缺轮召回兜底预处理**（COFECHA 优先）。
 */
export const ar1WhitenSeries = (series: NumericSeries): NumericSeries => {
    const sorted = Array.from(series.entries()).sort((a, b) => a[0] - b[0]);
    if (sorted.length < 4) return zScoreSeries(series);
    const vals = sorted.map((e) => e[1]);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    let num = 0;
    let den = 0;
    for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i][0] === sorted[i - 1][0] + 1) {
            num += (sorted[i][1] - mean) * (sorted[i - 1][1] - mean);
        }
    }
    vals.forEach((v) => { den += (v - mean) ** 2; });
    const phi = den > 0 ? Math.max(0, Math.min(0.9, num / den)) : 0;
    const resid = new Map<number, number>();
    for (let i = 1; i < sorted.length; i += 1) {
        const [year, value] = sorted[i];
        if (sorted[i][0] === sorted[i - 1][0] + 1) {
            resid.set(year, value - phi * sorted[i - 1][1]);
        }
    }
    return resid.size >= 3 ? zScoreSeries(resid) : zScoreSeries(series);
};

export const getRangeForSeries = (series: NumericSeries): YearRange | null => {
    const years = Array.from(series.keys()).sort((a, b) => a - b);
    if (years.length === 0) return null;
    return { startYear: years[0], endYear: years[years.length - 1] };
};

export const cloneSiteData = (siteData: RwlSiteData): RwlSiteData => {
    const next = new Map<string, RwlTreeData>();
    siteData.forEach((treeData, tree) => {
        next.set(tree, new Map(treeData));
    });
    return next;
};

export const pearson = (pairs: Array<[number, number]>, minPairs: number): number | null => {
    if (pairs.length < minPairs) return null;

    const meanA = pairs.reduce((sum, [a]) => sum + a, 0) / pairs.length;
    const meanB = pairs.reduce((sum, [, b]) => sum + b, 0) / pairs.length;
    let numerator = 0;
    let denominatorA = 0;
    let denominatorB = 0;

    pairs.forEach(([a, b]) => {
        const da = a - meanA;
        const db = b - meanB;
        numerator += da * db;
        denominatorA += da * da;
        denominatorB += db * db;
    });

    const denominator = Math.sqrt(denominatorA * denominatorB);
    if (!Number.isFinite(denominator) || denominator === 0) return null;
    return numerator / denominator;
};

export const tLikeForCorrelation = (r: number | null, overlapYears: number): number | null => {
    if (r === null || overlapYears < 3) return null;
    const bounded = Math.max(-0.999999, Math.min(0.999999, r));
    const denominator = 1 - bounded * bounded;
    if (!Number.isFinite(denominator) || denominator <= 0) return null;
    return bounded * Math.sqrt((overlapYears - 2) / denominator);
};

/**
 * 两组等长数组的 Pearson 相关系数。
 * 与 pearson(pairs) 等价，但接受并行数组并对 NaN / 长度不一致做防御。
 * 返回 null 表示无法计算（样本不足、方差为 0、出现非有限值）。
 */
export const pearsonR = (x: number[], y: number[]): number | null => {
    const n = Math.min(x.length, y.length);
    if (n < 3) return null;
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < n; i += 1) {
        const a = x[i];
        const b = y[i];
        if (Number.isFinite(a) && Number.isFinite(b)) {
            pairs.push([a, b]);
        }
    }
    return pearson(pairs, 3);
};

/**
 * 由相关系数 r 与样本量 n 计算 t-like 统计量。
 * t = r * sqrt((n - 2) / (1 - r^2))。
 * 对 n <= 2、|r| 接近 ±1、方差为 0、NaN/Infinity 做防御，无法计算时返回 0
 * （tLike 用于比较改进幅度，0 表示“无证据”，比 null 更便于做差值运算）。
 */
export const tLikeFromR = (r: number | null, n: number): number => {
    if (r === null || !Number.isFinite(r) || n <= 2) return 0;
    const bounded = Math.max(-0.999999, Math.min(0.999999, r));
    const denominator = 1 - bounded * bounded;
    if (!Number.isFinite(denominator) || denominator <= 0) return 0;
    const t = bounded * Math.sqrt((n - 2) / denominator);
    return Number.isFinite(t) ? t : 0;
};

/**
 * Fisher z 变换：z = 0.5 * ln((1 + r) / (1 - r))。
 * 用于在比较相关性改进时获得方差稳定的尺度。对 |r| 接近 1 做夹紧。
 */
export const fisherZ = (r: number | null): number => {
    if (r === null || !Number.isFinite(r)) return 0;
    const bounded = Math.max(-0.999999, Math.min(0.999999, r));
    const z = 0.5 * Math.log((1 + bounded) / (1 - bounded));
    return Number.isFinite(z) ? z : 0;
};

/**
 * 随有效样本量自适应的“低相关阈值”。
 * 小样本窗口的 r 噪声更大，阈值更宽松（更高）以避免误判 A-like。
 */
export const adaptiveLowCorrelationThreshold = (effectiveN: number): number => {
    if (effectiveN >= 40) return 0.32;
    if (effectiveN >= 25) return 0.36;
    if (effectiveN >= 15) return 0.42;
    return 0.50;
};

/**
 * 随有效样本量自适应的“最小 r 改进阈值”。
 * 小样本下需要更大的改进幅度才认为 lag 移动是真信号。
 */
export const adaptiveImprovementThreshold = (effectiveN: number): number => {
    if (effectiveN >= 40) return 0.08;
    if (effectiveN >= 25) return 0.10;
    if (effectiveN >= 15) return 0.14;
    return 0.18;
};

export const correlationForSegment = (
    target: NumericSeries,
    master: NumericSeries,
    startYear: number,
    endYear: number,
    lag: number,
    minPairs: number,
) => {
    let samplePairs = 0;
    let targetSum = 0;
    let masterSum = 0;

    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const masterValue = master.get(year + lag);
        if (targetValue !== undefined && masterValue !== undefined) {
            samplePairs += 1;
            targetSum += targetValue;
            masterSum += masterValue;
        }
    }

    if (samplePairs < minPairs) {
        return { correlation: null, samplePairs };
    }

    const targetMean = targetSum / samplePairs;
    const masterMean = masterSum / samplePairs;
    let numerator = 0;
    let targetDenominator = 0;
    let masterDenominator = 0;
    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const masterValue = master.get(year + lag);
        if (targetValue === undefined || masterValue === undefined) continue;
        const targetDelta = targetValue - targetMean;
        const masterDelta = masterValue - masterMean;
        numerator += targetDelta * masterDelta;
        targetDenominator += targetDelta * targetDelta;
        masterDenominator += masterDelta * masterDelta;
    }

    const denominator = Math.sqrt(targetDenominator * masterDenominator);
    const correlation = Number.isFinite(denominator) && denominator !== 0
        ? numerator / denominator
        : null;

    return {
        correlation,
        samplePairs,
    };
};

export const filterSeriesByRange = (
    series: NumericSeries,
    range: YearRange,
): NumericSeries => {
    const filtered = new Map<number, number>();
    series.forEach((value, year) => {
        if (year >= range.startYear && year <= range.endYear) {
            filtered.set(year, value);
        }
    });
    return filtered;
};

export const createSegmentsForSeries = (
    series: NumericSeries,
    segmentLength: number,
    overlap: number,
) => {
    const range = getRangeForSeries(series);
    if (!range) return [];

    const step = Math.max(1, segmentLength - overlap);
    const minLength = Math.max(10, Math.floor(segmentLength * 0.6));
    const segments: YearRange[] = [];

    for (let startYear = range.startYear; startYear <= range.endYear; startYear += step) {
        const endYear = Math.min(startYear + segmentLength - 1, range.endYear);
        if (endYear - startYear + 1 >= minLength) {
            segments.push({ startYear, endYear });
        }
        if (endYear === range.endYear) break;
    }

    return segments;
};

const getReferenceSourceTrees = (
    siteData: RwlSiteData,
    targetTree: string | null,
    referenceConfig: ReferenceSeriesConfig | null,
) => {
    if (referenceConfig) {
        const selected = referenceConfig.selectedTrees.filter((tree) => siteData.has(tree) && tree !== targetTree);
        if (selected.length > 0) return selected;
    }

    return Array.from(siteData.keys()).filter((tree) => tree !== targetTree);
};

export const buildScoringMaster = (
    siteData: RwlSiteData,
    targetTree: string | null,
    referenceConfig: ReferenceSeriesConfig | null,
    preprocess: SeriesPreprocess = preprocessSeries,
    preprocessCache?: SeriesPreprocessCache,
): ScoringMaster => {
    if (referenceConfig?.mode === "dynamic" && referenceConfig.cofechaPassReference) {
        const data = new Map<number, number>();
        const sampleDepth = new Map<number, number>();

        referenceConfig.cofechaPassReference.points.forEach((point) => {
            data.set(point.year, point.value);
            sampleDepth.set(point.year, point.replication);
        });

        return {
            data: preprocess(data),
            sampleDepth,
            sourceTrees: referenceConfig.selectedTrees.filter((tree) => siteData.has(tree) && tree !== targetTree),
        };
    }

    const sourceTrees = getReferenceSourceTrees(siteData, targetTree, referenceConfig);

    // 相关性加权 chronology：参考质量允许一个很小的整体 lag。目标中一旦存在缺轮或局部
    // 移动，固定 lag=0 会把真正相关的参考降权，恰好削弱待检测事件附近的 master。
    // 权重只用于选择参考质量；chronology 本身仍严格按原日历年聚合，不会被整体平移。
    // targetTree 为空（如可视化窄轮）时退回等权平均。
    const targetZ = targetTree
        ? preprocessTree(siteData.get(targetTree), preprocess, preprocessCache)
        : null;
    const refWeight = (refZ: NumericSeries): number => {
        if (!targetZ) return 1;
        let bestR: number | null = null;
        for (let lag = -3; lag <= 3; lag += 1) {
            const pairs: Array<[number, number]> = [];
            targetZ.forEach((value, year) => {
                const referenceValue = refZ.get(year + lag);
                if (referenceValue !== undefined) pairs.push([value, referenceValue]);
            });
            const r = pearson(pairs, 20);
            if (r !== null && (bestR === null || r > bestR)) bestR = r;
        }
        if (bestR === null) return 0.1; // 重叠不足：保留较小权重
        // 温和线性加权：高相关树（同株姊妹岩芯）权重大，低相关树降权但不至于消失。
        return Math.max(0, bestR) + 0.15;
    };

    const weightedSumByYear = new Map<number, number>();
    const weightByYear = new Map<number, number>();
    const countByYear = new Map<number, number>();

    sourceTrees.forEach((tree) => {
        const refZ = preprocessTree(siteData.get(tree), preprocess, preprocessCache);
        const w = refWeight(refZ);
        refZ.forEach((value, year) => {
            weightedSumByYear.set(year, (weightedSumByYear.get(year) ?? 0) + value * w);
            weightByYear.set(year, (weightByYear.get(year) ?? 0) + w);
            countByYear.set(year, (countByYear.get(year) ?? 0) + 1);
        });
    });

    const data = new Map<number, number>();
    const sampleDepth = new Map<number, number>();

    Array.from(weightedSumByYear.entries()).sort((a, b) => a[0] - b[0]).forEach(([year, weightedSum]) => {
        const w = weightByYear.get(year) ?? 0;
        sampleDepth.set(year, countByYear.get(year) ?? 0);
        if (w > 0) {
            data.set(year, weightedSum / w);
        }
    });

    return { data, sampleDepth, sourceTrees };
};

export const buildMasterNarrowYears = (
    siteData: RwlSiteData,
    referenceConfig: ReferenceSeriesConfig | null,
    config: EffectiveDiagnosisConfig,
): ScoringMasterYear[] => {
    const visualReference = buildReferenceSeries(siteData, referenceConfig);
    const master = visualReference
        ? {
            data: preprocessSeries(visualReference.data),
            sampleDepth: visualReference.sampleDepth,
        }
        : buildScoringMaster(siteData, null, null);

    return Array.from(master.data.entries())
        .map(([year, masterValue]) => ({
            year,
            masterValue,
            sampleDepth: master.sampleDepth.get(year) ?? 0,
            narrow: masterValue <= config.narrowYearThreshold,
            stronglyNarrow: masterValue <= config.strongNarrowYearThreshold,
        }))
        .filter((year) => year.narrow)
        .sort((a, b) => a.year - b.year);
};

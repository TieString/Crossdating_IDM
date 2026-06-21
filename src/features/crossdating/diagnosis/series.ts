/**
 * 诊断算法使用的数值序列基础工具。
 * 这里负责宽度过滤、z-score 标准化、相关计算、窗口切分和派生 master chronology 构建。
 */
import { buildReferenceSeries, type ReferenceSeriesConfig } from "../reference";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import { stopMarker } from "@/shared/constants";
import type { EffectiveDiagnosisConfig, NumericSeries, ScoringMaster, ScoringMasterYear, YearRange } from "./types";

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

export const correlationForSegment = (
    target: NumericSeries,
    master: NumericSeries,
    startYear: number,
    endYear: number,
    lag: number,
    minPairs: number,
) => {
    const pairs: Array<[number, number]> = [];

    for (let year = startYear; year <= endYear; year += 1) {
        const targetValue = target.get(year);
        const masterValue = master.get(year + lag);
        if (targetValue !== undefined && masterValue !== undefined) {
            pairs.push([targetValue, masterValue]);
        }
    }

    return {
        correlation: pearson(pairs, minPairs),
        samplePairs: pairs.length,
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
): ScoringMaster => {
    if (referenceConfig?.mode === "dynamic" && referenceConfig.cofechaPassReference) {
        const data = new Map<number, number>();
        const sampleDepth = new Map<number, number>();

        referenceConfig.cofechaPassReference.points.forEach((point) => {
            data.set(point.year, point.value);
            sampleDepth.set(point.year, point.replication);
        });

        return {
            data: preprocessSeries(data),
            sampleDepth,
            sourceTrees: referenceConfig.selectedTrees.filter((tree) => siteData.has(tree) && tree !== targetTree),
        };
    }

    const sourceTrees = getReferenceSourceTrees(siteData, targetTree, referenceConfig);
    const valuesByYear = new Map<number, number[]>();

    sourceTrees.forEach((tree) => {
        preprocessSeries(toNumericSeries(siteData.get(tree))).forEach((value, year) => {
            const values = valuesByYear.get(year);
            if (values) {
                values.push(value);
            } else {
                valuesByYear.set(year, [value]);
            }
        });
    });

    const data = new Map<number, number>();
    const sampleDepth = new Map<number, number>();

    Array.from(valuesByYear.entries()).sort((a, b) => a[0] - b[0]).forEach(([year, values]) => {
        sampleDepth.set(year, values.length);
        if (values.length > 0) {
            data.set(year, values.reduce((sum, value) => sum + value, 0) / values.length);
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

import { stopMarker } from "@/shared/constants";
import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import { normalizeCofechaSeriesId } from "@/features/cofecha/seriesId";
import {
    COFECHA_REFERENCE_DEFAULT_OPTIONS as COFECHA_JS_REFERENCE_DEFAULT_OPTIONS,
    cofechaStyleStandardize as cofechaJsStyleStandardize,
    type CofechaReferenceOptions as CofechaJsReferenceOptions,
    type IndexedPoint as CofechaJsIndexedPoint,
} from "cofecha-js";

export const REFERENCE_SERIES_LABEL = "Reference / Master-like series";
export const COFECHA_PASS_REFERENCE_LABEL = "COFECHA-pass 参考序列";
export const REFERENCE_SERIES_ID = "__crossdating_reference__";

export type ReferenceSeriesMethod = "mean";
export type ReferenceSeriesMode = "manual" | "dynamic";

export type SeriesStatus =
    | "anchor_pass"
    | "candidate_flagged"
    | "unknown";

export type CofechaPart6Classification = {
    cofechaRunId: string;
    anchorPassIds: string[];
    candidateFlaggedIds: string[];
    flaggedAIds: string[];
    allSeriesIds: string[];
};

export type CofechaReferenceOptions = CofechaJsReferenceOptions;
export type IndexedPoint = CofechaJsIndexedPoint;

export type CofechaReferencePoint = {
    year: number;
    value: number;
    replication: number;
    sd: number;
    se: number;
    weight: number;
};

export type CofechaPassReference = {
    id: string;
    source: "cofecha_pass_anchor" | "cofecha_master_series" | "pairwise_bootstrap";
    cofechaRunId: string;
    includedSeriesIds: string[];
    candidateSeriesIds: string[];
    options: CofechaReferenceOptions;
    points: CofechaReferencePoint[];
    summary: {
        includedCount: number;
        candidateCount: number;
        startYear: number | null;
        endYear: number | null;
        meanReplication: number | null;
        minReplication: number | null;
        maxReplication: number | null;
    };
};

export type OffsetCheckInput = {
    targetSeriesId: string;
    targetSeries: RwlTreeData;
    reference: CofechaPassReference;
    offsetRange: {
        min: number;
        max: number;
    };
};

export type OffsetCheckTargetSet = {
    candidateSeriesIds: string[];
    reference: CofechaPassReference;
};

export type ReferenceSeriesConfig = {
    selectedTrees: string[];
    minSampleDepth: number;
    method: ReferenceSeriesMethod;
    updatedAt: string;
    mode?: ReferenceSeriesMode;
    cofechaRunId?: string;
    rwlHash?: string;
    isStale?: boolean;
    classification?: CofechaPart6Classification;
    cofechaPassReference?: CofechaPassReference | null;
    unavailableReason?: string;
};

export type ReferenceSeries = {
    label: string;
    data: Map<number, number>;
    sampleDepth: Map<number, number>;
    selectedTrees: string[];
    minSampleDepth: number;
    method: ReferenceSeriesMethod;
    updatedAt: string;
    pointCount: number;
    mode: ReferenceSeriesMode;
    isStale: boolean;
    cofechaRunId?: string;
    candidateSeriesIds?: string[];
    sdByYear?: Map<number, number>;
    seByYear?: Map<number, number>;
    weightByYear?: Map<number, number>;
    summary?: CofechaPassReference["summary"];
};

const DEFAULT_MIN_SAMPLE_DEPTH = 2;
const MIN_COFECHA_PASS_ANCHOR_COUNT = 5;

// COFECHA 默认参考序列参数。
// 这些值对应 COFECHA 手册里的默认流程：
// 1. 32 年刚度的 cubic smoothing spline；
// 2. 在 32 年波长处保留 50% 频率响应；
// 3. 启用 autoregressive modeling 去除 persistence；
// 4. 启用 log transform，但不默认 first difference；
// 5. absent ring / 0 值默认不进入 master chronology。
export const COFECHA_REFERENCE_DEFAULT_OPTIONS: CofechaReferenceOptions = {
    ...COFECHA_JS_REFERENCE_DEFAULT_OPTIONS,
    minReplication: 3,
    targetReplication: 10,
};

const isUsableWidth = (
    value: number | null | undefined,
    options: Pick<CofechaReferenceOptions, "omitAbsentRingsFromMaster"> = COFECHA_REFERENCE_DEFAULT_OPTIONS,
): value is number => (
    typeof value === "number"
    && Number.isFinite(value)
    && (value > 0 || (!options.omitAbsentRingsFromMaster && value === 0))
    && value !== stopMarker.value
);

const mean = (values: readonly number[]) => (
    values.reduce((sum, value) => sum + value, 0) / values.length
);

const standardDeviation = (values: readonly number[]) => {
    if (values.length <= 1) return 0;
    const avg = mean(values);
    const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
};

export function createReferenceSeriesConfig(selectedTrees: string[]): ReferenceSeriesConfig | null {
    const uniqueTrees = Array.from(new Set(selectedTrees.filter(Boolean)));
    if (uniqueTrees.length === 0) {
        return null;
    }

    return {
        selectedTrees: uniqueTrees,
        minSampleDepth: DEFAULT_MIN_SAMPLE_DEPTH,
        method: "mean",
        mode: "manual",
        updatedAt: new Date().toISOString(),
    };
}

export function classifyCofechaPart6Series(
    allSeriesIds: readonly string[],
    flaggedAIds: Iterable<string>,
    cofechaRunId: string,
): CofechaPart6Classification {
    const uniqueAllSeriesIds = Array.from(new Set(allSeriesIds.filter(Boolean)));
    const flaggedSet = new Set(Array.from(flaggedAIds, normalizeCofechaSeriesId));
    const flaggedAIdSet = new Set<string>();
    const anchorPassIds: string[] = [];
    const candidateFlaggedIds: string[] = [];

    uniqueAllSeriesIds.forEach((seriesId) => {
        if (flaggedSet.has(normalizeCofechaSeriesId(seriesId))) {
            candidateFlaggedIds.push(seriesId);
            flaggedAIdSet.add(seriesId);
        } else {
            anchorPassIds.push(seriesId);
        }
    });

    return {
        cofechaRunId,
        anchorPassIds,
        candidateFlaggedIds,
        flaggedAIds: Array.from(flaggedAIdSet),
        allSeriesIds: uniqueAllSeriesIds,
    };
}

export function cofechaStyleStandardize(
    series: RwlTreeData,
    options: CofechaReferenceOptions = COFECHA_REFERENCE_DEFAULT_OPTIONS,
): IndexedPoint[] {
    const withoutStopMarker = new Map(Array.from(series.entries()).filter(([, value]) => (
        value !== stopMarker.value
    )));
    return cofechaJsStyleStandardize(withoutStopMarker, options);
}

export function buildCofechaPassReference(
    siteData: RwlSiteData,
    classification: CofechaPart6Classification,
    options: CofechaReferenceOptions = COFECHA_REFERENCE_DEFAULT_OPTIONS,
): CofechaPassReference | null {
    if (classification.anchorPassIds.length < MIN_COFECHA_PASS_ANCHOR_COUNT) {
        return null;
    }

    const valuesByYear = new Map<number, number[]>();

    // 只把 COFECHA PART 6 中没有 A flag 的样芯放入 reference。
    // 有 A flag 的 candidate_flagged 序列保留给后续 offset 检查，
    // 不能反过来参与构造检查它自己的参考序列。
    classification.anchorPassIds.forEach((seriesId) => {
        const series = siteData.get(seriesId);
        if (!series) return;

        cofechaStyleStandardize(series, options).forEach((point) => {
            const values = valuesByYear.get(point.year);
            if (values) {
                values.push(point.value);
            } else {
                valuesByYear.set(point.year, [point.value]);
            }
        });
    });

    const rawMasterPoints: Array<{ year: number; values: number[]; value: number }> = [];

    Array.from(valuesByYear.entries()).sort((a, b) => a[0] - b[0]).forEach(([year, values]) => {
        if (values.length < options.minReplication) return;
        rawMasterPoints.push({
            year,
            value: mean(values),
            values,
        });
    });

    const masterValues = rawMasterPoints.map((point) => point.value);
    const masterMean = masterValues.length > 0 ? mean(masterValues) : 0;
    const masterSd = standardDeviation(masterValues);
    const standardizer = masterSd > 0 ? masterSd : 1;

    // Step 5: accumulated series / counter series
    // 上面 rawMasterPoints 已完成 COFECHA 的 accumulator / counter 逻辑：
    // 每年把所有转换后样芯值累加，再除以该年的 replication 得到算术平均。
    //
    // Step 6: Part 3 residual master standardization
    // COFECHA PART 3 输出的 master dating series 是 mean=0、sd=1 的 residual chronology。
    // 所以最终 reference value 必须是标准化后的 R(t)，不是 raw width，也不是 mean≈1 的 index。
    //
    // Part 3's master dating series is a residual chronology standardized to
    // mean 0 and sd 1. Keep per-year sd/se in that same final scale so tooltip
    // evidence and future Bayesian checks do not mix transformed units.
    const points: CofechaReferencePoint[] = rawMasterPoints.map((point) => {
        const sd = standardDeviation(point.values) / standardizer;
        return {
            year: point.year,
            value: (point.value - masterMean) / standardizer,
            replication: point.values.length,
            sd,
            se: sd / Math.sqrt(point.values.length),
            weight: Math.min(1, point.values.length / options.targetReplication),
        };
    });

    const replications = points.map((point) => point.replication);

    return {
        id: `cofecha-pass-reference-${classification.cofechaRunId}`,
        source: "cofecha_pass_anchor",
        cofechaRunId: classification.cofechaRunId,
        includedSeriesIds: classification.anchorPassIds,
        candidateSeriesIds: classification.candidateFlaggedIds,
        options,
        points,
        summary: {
            includedCount: classification.anchorPassIds.length,
            candidateCount: classification.candidateFlaggedIds.length,
            startYear: points[0]?.year ?? null,
            endYear: points[points.length - 1]?.year ?? null,
            meanReplication: replications.length > 0 ? mean(replications) : null,
            minReplication: replications.length > 0 ? Math.min(...replications) : null,
            maxReplication: replications.length > 0 ? Math.max(...replications) : null,
        },
    };
}

export function createCofechaPassReferenceConfig(params: {
    siteData: RwlSiteData;
    flaggedAIds: Iterable<string>;
    cofechaRunId: string;
    rwlHash: string;
    options?: CofechaReferenceOptions;
}): ReferenceSeriesConfig {
    const classification = classifyCofechaPart6Series(
        Array.from(params.siteData.keys()),
        params.flaggedAIds,
        params.cofechaRunId,
    );
    const options = params.options ?? COFECHA_REFERENCE_DEFAULT_OPTIONS;
    const cofechaPassReference = buildCofechaPassReference(params.siteData, classification, options);

    return {
        selectedTrees: classification.anchorPassIds,
        minSampleDepth: options.minReplication,
        method: "mean",
        mode: "dynamic",
        updatedAt: new Date().toISOString(),
        cofechaRunId: params.cofechaRunId,
        rwlHash: params.rwlHash,
        isStale: false,
        classification,
        cofechaPassReference,
        unavailableReason: cofechaPassReference
            ? undefined
            : "COFECHA 无 A 样芯数量不足，无法生成稳定参考序列。",
    };
}

export function createCofechaMasterReferenceConfig(params: {
    siteData: RwlSiteData;
    flaggedAIds: Iterable<string>;
    cofechaRunId: string;
    rwlHash: string;
    masterDatingSeries: Map<number, number>;
    options?: CofechaReferenceOptions;
}): ReferenceSeriesConfig {
    const classification = classifyCofechaPart6Series(
        Array.from(params.siteData.keys()),
        params.flaggedAIds,
        params.cofechaRunId,
    );
    const options = params.options ?? COFECHA_REFERENCE_DEFAULT_OPTIONS;
    const sortedMasterEntries = Array.from(params.masterDatingSeries.entries())
        .filter((entry): entry is [number, number] => (
            Number.isFinite(entry[0]) && Number.isFinite(entry[1])
        ))
        .sort((a, b) => a[0] - b[0]);

    const replicationForYear = (year: number) => (
        classification.allSeriesIds.reduce((count, seriesId) => {
            const value = params.siteData.get(seriesId)?.get(year);
            return isUsableWidth(value, options) ? count + 1 : count;
        }, 0)
    );

    const points: CofechaReferencePoint[] = sortedMasterEntries.map(([year, value]) => {
        const replication = replicationForYear(year);
        return {
            year,
            value,
            replication,
            sd: 0,
            se: 0,
            weight: Math.min(1, replication / options.targetReplication),
        };
    });
    const replications = points.map((point) => point.replication);
    const cofechaPassReference: CofechaPassReference | null = points.length > 0
        ? {
            id: `cofecha-master-reference-${params.cofechaRunId}`,
            source: "cofecha_master_series",
            cofechaRunId: params.cofechaRunId,
            includedSeriesIds: classification.allSeriesIds,
            candidateSeriesIds: classification.candidateFlaggedIds,
            options,
            points,
            summary: {
                includedCount: classification.allSeriesIds.length,
                candidateCount: classification.candidateFlaggedIds.length,
                startYear: points[0]?.year ?? null,
                endYear: points[points.length - 1]?.year ?? null,
                meanReplication: replications.length > 0 ? mean(replications) : null,
                minReplication: replications.length > 0 ? Math.min(...replications) : null,
                maxReplication: replications.length > 0 ? Math.max(...replications) : null,
            },
        }
        : null;

    return {
        selectedTrees: classification.allSeriesIds,
        minSampleDepth: options.minReplication,
        method: "mean",
        mode: "dynamic",
        updatedAt: new Date().toISOString(),
        cofechaRunId: params.cofechaRunId,
        rwlHash: params.rwlHash,
        isStale: false,
        classification,
        cofechaPassReference,
        unavailableReason: cofechaPassReference
            ? undefined
            : "COFECHA master series 为空，无法生成临时参考序列。",
    };
}

export function getOffsetCheckTargetSet(config: ReferenceSeriesConfig | null | undefined): OffsetCheckTargetSet | null {
    if (!config?.cofechaPassReference || !config.classification) return null;
    return {
        candidateSeriesIds: config.classification.candidateFlaggedIds,
        reference: config.cofechaPassReference,
    };
}

export function normalizeReferenceSeriesConfig(
    config: ReferenceSeriesConfig | null | undefined,
    siteData: RwlSiteData,
): ReferenceSeriesConfig | null {
    if (!config || !Array.isArray(config.selectedTrees)) {
        return null;
    }

    const mode: ReferenceSeriesMode = config.mode === "dynamic" ? "dynamic" : "manual";
    const selectedTrees = Array.from(new Set(
        config.selectedTrees.filter((tree) => siteData.has(tree)),
    ));

    if (mode === "manual" && selectedTrees.length === 0) {
        return null;
    }

    const classification = config.classification
        ? {
            ...config.classification,
            allSeriesIds: config.classification.allSeriesIds.filter((tree) => siteData.has(tree)),
            anchorPassIds: config.classification.anchorPassIds.filter((tree) => siteData.has(tree)),
            candidateFlaggedIds: config.classification.candidateFlaggedIds.filter((tree) => siteData.has(tree)),
            flaggedAIds: config.classification.flaggedAIds.filter((tree) => siteData.has(tree)),
        }
        : undefined;

    return {
        selectedTrees,
        minSampleDepth: Math.max(1, Math.floor(config.minSampleDepth || DEFAULT_MIN_SAMPLE_DEPTH)),
        method: config.method === "mean" ? "mean" : "mean",
        mode,
        updatedAt: config.updatedAt || new Date().toISOString(),
        cofechaRunId: config.cofechaRunId,
        rwlHash: config.rwlHash,
        isStale: Boolean(config.isStale),
        classification,
        cofechaPassReference: config.cofechaPassReference ?? null,
        unavailableReason: config.unavailableReason,
    };
}

function buildManualReferenceSeries(siteData: RwlSiteData, normalized: ReferenceSeriesConfig): ReferenceSeries | null {
    const years = new Set<number>();
    normalized.selectedTrees.forEach((tree) => {
        siteData.get(tree)?.forEach((value, year) => {
            if (isUsableWidth(value)) {
                years.add(year);
            }
        });
    });

    const data = new Map<number, number>();
    const sampleDepth = new Map<number, number>();

    Array.from(years).sort((a, b) => a - b).forEach((year) => {
        const values: number[] = [];

        normalized.selectedTrees.forEach((tree) => {
            const value = siteData.get(tree)?.get(year);
            if (isUsableWidth(value)) {
                values.push(value);
            }
        });

        sampleDepth.set(year, values.length);
        if (values.length >= normalized.minSampleDepth) {
            data.set(year, mean(values));
        }
    });

    return {
        label: REFERENCE_SERIES_LABEL,
        data,
        sampleDepth,
        selectedTrees: normalized.selectedTrees,
        minSampleDepth: normalized.minSampleDepth,
        method: normalized.method,
        updatedAt: normalized.updatedAt,
        pointCount: data.size,
        mode: "manual",
        isStale: false,
    };
}

function buildDynamicReferenceSeries(normalized: ReferenceSeriesConfig): ReferenceSeries | null {
    const reference = normalized.cofechaPassReference;
    if (!reference || reference.points.length === 0) {
        return null;
    }

    const data = new Map<number, number>();
    const sampleDepth = new Map<number, number>();
    const sdByYear = new Map<number, number>();
    const seByYear = new Map<number, number>();
    const weightByYear = new Map<number, number>();

    reference.points.forEach((point) => {
        data.set(point.year, point.value);
        sampleDepth.set(point.year, point.replication);
        sdByYear.set(point.year, point.sd);
        seByYear.set(point.year, point.se);
        weightByYear.set(point.year, point.weight);
    });

    return {
        label: reference.source === "cofecha_master_series" ? "COFECHA master series" : COFECHA_PASS_REFERENCE_LABEL,
        data,
        sampleDepth,
        selectedTrees: normalized.selectedTrees,
        minSampleDepth: normalized.minSampleDepth,
        method: normalized.method,
        updatedAt: normalized.updatedAt,
        pointCount: data.size,
        mode: "dynamic",
        isStale: Boolean(normalized.isStale),
        cofechaRunId: normalized.cofechaRunId,
        candidateSeriesIds: reference.candidateSeriesIds,
        sdByYear,
        seByYear,
        weightByYear,
        summary: reference.summary,
    };
}

export function buildReferenceSeries(
    siteData: RwlSiteData,
    config: ReferenceSeriesConfig | null | undefined,
): ReferenceSeries | null {
    const normalized = normalizeReferenceSeriesConfig(config, siteData);
    if (!normalized) {
        return null;
    }

    if (normalized.mode === "dynamic") {
        return buildDynamicReferenceSeries(normalized);
    }

    return buildManualReferenceSeries(siteData, normalized);
}

export function hashRwlSiteData(siteData: RwlSiteData): string {
    let hash = 2166136261;
    const update = (text: string) => {
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
    };

    Array.from(siteData.entries()).sort(([a], [b]) => a.localeCompare(b)).forEach(([tree, treeData]) => {
        update(tree);
        Array.from(treeData.entries()).sort((a, b) => a[0] - b[0]).forEach(([year, value]) => {
            update(`${year}:${value ?? "null"};`);
        });
    });

    return (hash >>> 0).toString(16);
}

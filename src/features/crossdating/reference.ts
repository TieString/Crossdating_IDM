import { stopMarker } from "@/shared/constants";
import type { RwlSiteData } from "@/features/rwl/types";

export const REFERENCE_SERIES_LABEL = "Reference / Master-like series";
export const REFERENCE_SERIES_ID = "__crossdating_reference__";

export type ReferenceSeriesMethod = "mean";

export type ReferenceSeriesConfig = {
    selectedTrees: string[];
    minSampleDepth: number;
    method: ReferenceSeriesMethod;
    updatedAt: string;
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
};

const DEFAULT_MIN_SAMPLE_DEPTH = 2;

const isUsableWidth = (value: number | null | undefined): value is number => (
    typeof value === "number"
    && Number.isFinite(value)
    && value > 0
    && value !== stopMarker.value
);

export function createReferenceSeriesConfig(selectedTrees: string[]): ReferenceSeriesConfig | null {
    const uniqueTrees = Array.from(new Set(selectedTrees.filter(Boolean)));
    if (uniqueTrees.length === 0) {
        return null;
    }

    return {
        selectedTrees: uniqueTrees,
        minSampleDepth: DEFAULT_MIN_SAMPLE_DEPTH,
        method: "mean",
        updatedAt: new Date().toISOString(),
    };
}

export function normalizeReferenceSeriesConfig(
    config: ReferenceSeriesConfig | null | undefined,
    siteData: RwlSiteData,
): ReferenceSeriesConfig | null {
    if (!config || !Array.isArray(config.selectedTrees)) {
        return null;
    }

    const selectedTrees = Array.from(new Set(
        config.selectedTrees.filter((tree) => siteData.has(tree)),
    ));

    if (selectedTrees.length === 0) {
        return null;
    }

    return {
        selectedTrees,
        minSampleDepth: Math.max(1, Math.floor(config.minSampleDepth || DEFAULT_MIN_SAMPLE_DEPTH)),
        method: config.method === "mean" ? "mean" : "mean",
        updatedAt: config.updatedAt || new Date().toISOString(),
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
            data.set(
                year,
                values.reduce((sum, value) => sum + value, 0) / values.length,
            );
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
    };
}

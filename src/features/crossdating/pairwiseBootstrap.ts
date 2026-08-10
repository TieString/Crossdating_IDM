import type { RwlSiteData } from "@/features/rwl/types";
import {
    classifyCofechaPart6Series,
    cofechaStyleStandardize,
    createCofechaPassReferenceConfig,
    type ReferenceSeriesConfig,
} from "./reference";

const PAIRWISE_MIN_OVERLAP = 50;
const PAIRWISE_LAG_RADIUS = 10;
const PAIRWISE_MIN_ZERO_LAG_CORRELATION = 0.3;
const PAIRWISE_MAX_ZERO_LAG_DEFICIT = 0.03;

const pearsonAtLag = (
    left: ReadonlyMap<number, number>,
    right: ReadonlyMap<number, number>,
    lag: number,
): number | null => {
    let count = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    left.forEach((x, year) => {
        const y = right.get(year + lag);
        if (y === undefined) return;
        count += 1;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
    });
    if (count < PAIRWISE_MIN_OVERLAP) return null;
    const numerator = sxy - sx * sy / count;
    const denominator = Math.sqrt(
        Math.max(0, sxx - sx * sx / count)
        * Math.max(0, syy - sy * sy / count),
    );
    return denominator > 0 ? numerator / denominator : null;
};

const standardizedSiteSeries = (siteData: RwlSiteData) => Array.from(
    siteData,
    ([seriesId, data]) => ({
        seriesId,
        residual: new Map(cofechaStyleStandardize(new Map(Array.from(data).flatMap(
            ([year, value]) => typeof value === "number"
                ? [[year, value] as [number, number]]
                : [],
        ))).map((point) => [point.year, point.value])),
    }),
).filter((row) => row.residual.size >= PAIRWISE_MIN_OVERLAP);

/** Selects the largest connected group whose pairwise best lag remains effectively zero. */
export const selectPairwiseBootstrapCluster = (siteData: RwlSiteData): string[] => {
    const series = standardizedSiteSeries(siteData);
    const adjacency = new Map(series.map((row) => [row.seriesId, new Set<string>()]));
    for (let leftIndex = 0; leftIndex < series.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < series.length; rightIndex += 1) {
            const left = series[leftIndex];
            const right = series[rightIndex];
            let bestCorrelation = -Infinity;
            let zeroCorrelation: number | null = null;
            for (let lag = -PAIRWISE_LAG_RADIUS; lag <= PAIRWISE_LAG_RADIUS; lag += 1) {
                const correlation = pearsonAtLag(left.residual, right.residual, lag);
                if (correlation === null) continue;
                bestCorrelation = Math.max(bestCorrelation, correlation);
                if (lag === 0) zeroCorrelation = correlation;
            }
            if (zeroCorrelation === null
                || zeroCorrelation < PAIRWISE_MIN_ZERO_LAG_CORRELATION
                || bestCorrelation - zeroCorrelation > PAIRWISE_MAX_ZERO_LAG_DEFICIT) {
                continue;
            }
            adjacency.get(left.seriesId)?.add(right.seriesId);
            adjacency.get(right.seriesId)?.add(left.seriesId);
        }
    }

    const visited = new Set<string>();
    const components: string[][] = [];
    adjacency.forEach((_, start) => {
        if (visited.has(start)) return;
        const queue = [start];
        const component: string[] = [];
        visited.add(start);
        while (queue.length > 0) {
            const current = queue.shift()!;
            component.push(current);
            adjacency.get(current)?.forEach((neighbor) => {
                if (visited.has(neighbor)) return;
                visited.add(neighbor);
                queue.push(neighbor);
            });
        }
        components.push(component);
    });
    return components.sort((left, right) => (
        right.length - left.length || left[0].localeCompare(right[0])
    ))[0] ?? [];
};

export const createPairwiseBootstrapReferenceConfig = (params: {
    siteData: RwlSiteData;
    flaggedAIds: Iterable<string>;
    cofechaRunId: string;
    rwlHash: string;
}): ReferenceSeriesConfig | null => {
    const clusterIds = selectPairwiseBootstrapCluster(params.siteData);
    const clusterSet = new Set(clusterIds);
    const allSeriesIds = Array.from(params.siteData.keys());
    const base = createCofechaPassReferenceConfig({
        siteData: params.siteData,
        flaggedAIds: allSeriesIds.filter((seriesId) => !clusterSet.has(seriesId)),
        cofechaRunId: params.cofechaRunId,
        rwlHash: params.rwlHash,
    });
    if (!base.cofechaPassReference) return null;

    const originalClassification = classifyCofechaPart6Series(
        allSeriesIds,
        params.flaggedAIds,
        params.cofechaRunId,
    );
    return {
        ...base,
        selectedTrees: clusterIds,
        classification: {
            ...originalClassification,
            anchorPassIds: clusterIds,
        },
        cofechaPassReference: {
            ...base.cofechaPassReference,
            source: "pairwise_bootstrap",
            candidateSeriesIds: originalClassification.candidateFlaggedIds,
        },
        unavailableReason: undefined,
    };
};

/** Rebuilds the temporary chronology once per diagnosis so an anchor never validates itself. */
export const createPairwiseBootstrapTargetReferenceConfig = (
    siteData: RwlSiteData,
    config: ReferenceSeriesConfig | null,
    targetTree: string | undefined,
): ReferenceSeriesConfig | null => {
    if (!targetTree
        || config?.cofechaPassReference?.source !== "pairwise_bootstrap"
        || !config.classification) {
        return config;
    }
    const includedSeriesIds = config.selectedTrees.filter((seriesId) => seriesId !== targetTree);
    const includedSet = new Set(includedSeriesIds);
    const targetConfig = createCofechaPassReferenceConfig({
        siteData,
        flaggedAIds: Array.from(siteData.keys()).filter((seriesId) => !includedSet.has(seriesId)),
        cofechaRunId: `${config.cofechaRunId ?? "pairwise-bootstrap"}-${targetTree}`,
        rwlHash: config.rwlHash ?? "",
    });
    if (!targetConfig.cofechaPassReference) return config;
    return {
        ...targetConfig,
        selectedTrees: includedSeriesIds,
        classification: {
            ...config.classification,
            anchorPassIds: includedSeriesIds,
        },
        cofechaPassReference: {
            ...targetConfig.cofechaPassReference,
            source: "pairwise_bootstrap",
            candidateSeriesIds: config.classification.candidateFlaggedIds,
        },
        unavailableReason: undefined,
    };
};

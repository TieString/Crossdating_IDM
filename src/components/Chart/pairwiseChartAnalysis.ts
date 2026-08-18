import type { RwlSiteData, RwlTreeData } from "@/features/rwl/types";
import {
    buildReferenceSeries,
    createReferenceSeriesConfig,
    type ReferenceSeries,
    type ReferenceSeriesConfig,
} from "@/features/crossdating/reference";

const SYNTHETIC_REFERENCE_ID = "__pairwise_chart_reference__";

export type PairwiseChartAnalysisContext = {
    targetTree: string;
    comparatorId: string;
    comparatorLabel: string;
    comparatorKind: "series" | "reference";
    comparatorDepth: number;
    siteData: RwlSiteData;
    referenceConfig: ReferenceSeriesConfig;
    usedLeaveOneOutReference: boolean;
};

export type PairwiseChartAnalysisAvailability = {
    lineCount: number;
    context: PairwiseChartAnalysisContext | null;
    reason: string;
};

const median = (values: readonly number[]): number => {
    if (values.length === 0) return 1;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
};

const referenceDepthForTarget = (
    target: RwlTreeData,
    reference: ReferenceSeries,
): number => Math.max(1, Math.round(median(Array.from(reference.data.keys()).flatMap((year) => (
    target.has(year) ? [reference.sampleDepth.get(year) ?? 1] : []
)))));

const syntheticReferenceId = (siteData: RwlSiteData): string => {
    let id = SYNTHETIC_REFERENCE_ID;
    let suffix = 1;
    while (siteData.has(id)) {
        id = `${SYNTHETIC_REFERENCE_ID}_${suffix}`;
        suffix += 1;
    }
    return id;
};

const manualConfig = (selectedTrees: string[]): ReferenceSeriesConfig => ({
    ...createReferenceSeriesConfig(selectedTrees)!,
    minSampleDepth: 1,
});

export const resolvePairwiseChartAnalysis = (params: {
    fullData: RwlSiteData;
    visibleTreeIds: readonly string[];
    highlightedTreeId: string | null;
    referenceSeries: ReferenceSeries | null;
    referenceConfig: ReferenceSeriesConfig | null;
}): PairwiseChartAnalysisAvailability => {
    const visibleTreeIds = Array.from(new Set(
        params.visibleTreeIds.filter((tree) => params.fullData.has(tree)),
    ));
    const hasReferenceLine = Boolean(params.referenceSeries?.data.size);
    const lineCount = visibleTreeIds.length + (hasReferenceLine ? 1 : 0);
    if (lineCount !== 2) {
        return {
            lineCount,
            context: null,
            reason: lineCount < 2
                ? "请选择两条折线；参考序列也计为一条。"
                : "双线分析只在图表恰好显示两条折线时可用。",
        };
    }

    if (hasReferenceLine) {
        if (visibleTreeIds.length !== 1 || !params.referenceSeries) {
            return { lineCount, context: null, reason: "参考序列模式下需要再选择一条待检样芯。" };
        }
        const targetTree = visibleTreeIds[0];
        const targetData = params.fullData.get(targetTree);
        if (!targetData) return { lineCount, context: null, reason: "待检样芯数据不可用。" };

        let comparison = params.referenceSeries;
        let usedLeaveOneOutReference = false;
        if (
            comparison.mode === "manual"
            && comparison.selectedTrees.includes(targetTree)
        ) {
            const leaveOneOutTrees = comparison.selectedTrees.filter((tree) => tree !== targetTree);
            if (leaveOneOutTrees.length === 0) {
                return {
                    lineCount,
                    context: null,
                    reason: "当前参考序列只包含待检样芯，无法进行独立比较。",
                };
            }
            const leaveOneOutReference = buildReferenceSeries(
                params.fullData,
                manualConfig(leaveOneOutTrees),
            );
            if (!leaveOneOutReference || leaveOneOutReference.data.size === 0) {
                return {
                    lineCount,
                    context: null,
                    reason: "排除待检样芯后，参考序列没有足够的有效数据。",
                };
            }
            comparison = leaveOneOutReference;
            usedLeaveOneOutReference = true;
        }
        if (comparison.data.size === 0) {
            return { lineCount, context: null, reason: "参考序列没有可比较的有效数据。" };
        }

        const comparatorId = syntheticReferenceId(params.fullData);
        const siteData: RwlSiteData = new Map([
            [targetTree, new Map(targetData)],
            [comparatorId, new Map(comparison.data)],
        ]);
        return {
            lineCount,
            reason: "",
            context: {
                targetTree,
                comparatorId,
                comparatorLabel: usedLeaveOneOutReference
                    ? "参考序列（已排除待检样芯）"
                    : comparison.label,
                comparatorKind: "reference",
                comparatorDepth: referenceDepthForTarget(targetData, comparison),
                siteData,
                referenceConfig: manualConfig([comparatorId]),
                usedLeaveOneOutReference,
            },
        };
    }

    const targetTree = params.highlightedTreeId;
    if (!targetTree || !visibleTreeIds.includes(targetTree)) {
        return {
            lineCount,
            context: null,
            reason: "请先点击一条折线，将其设为待检对象。",
        };
    }
    const comparatorId = visibleTreeIds.find((tree) => tree !== targetTree);
    const targetData = params.fullData.get(targetTree);
    const comparatorData = comparatorId ? params.fullData.get(comparatorId) : undefined;
    if (!comparatorId || !targetData || !comparatorData) {
        return { lineCount, context: null, reason: "双线数据不可用。" };
    }

    return {
        lineCount,
        reason: "",
        context: {
            targetTree,
            comparatorId,
            comparatorLabel: comparatorId,
            comparatorKind: "series",
            comparatorDepth: 1,
            siteData: new Map([
                [targetTree, new Map(targetData)],
                [comparatorId, new Map(comparatorData)],
            ]),
            referenceConfig: manualConfig([comparatorId]),
            usedLeaveOneOutReference: false,
        },
    };
};

import { describe, expect, it } from "vitest";
import type { RwlSiteData } from "@/features/rwl/types";
import {
    buildReferenceSeries,
    createReferenceSeriesConfig,
} from "@/features/crossdating/reference";
import { resolvePairwiseChartAnalysis } from "./pairwiseChartAnalysis";

const data: RwlSiteData = new Map([
    ["A", new Map([[1900, 100], [1901, 120], [1902, 90]])],
    ["B", new Map([[1900, 110], [1901, 125], [1902, 95]])],
    ["C", new Map([[1900, 105], [1901, 115], [1902, 100]])],
]);

describe("pairwise chart analysis selection", () => {
    it("requires a highlighted target for two ordinary series", () => {
        const unresolved = resolvePairwiseChartAnalysis({
            fullData: data,
            visibleTreeIds: ["A", "B"],
            highlightedTreeId: null,
            referenceSeries: null,
            referenceConfig: null,
        });
        expect(unresolved.context).toBeNull();
        expect(unresolved.reason).toContain("点击一条折线");

        const resolved = resolvePairwiseChartAnalysis({
            fullData: data,
            visibleTreeIds: ["A", "B"],
            highlightedTreeId: "B",
            referenceSeries: null,
            referenceConfig: null,
        });
        expect(resolved.context).toMatchObject({
            targetTree: "B",
            comparatorId: "A",
            comparatorKind: "series",
        });
    });

    it("counts a reference as one line and rebuilds it without the target", () => {
        const referenceConfig = {
            ...createReferenceSeriesConfig(["A", "B", "C"])!,
            minSampleDepth: 1,
        };
        const referenceSeries = buildReferenceSeries(data, referenceConfig)!;
        const resolved = resolvePairwiseChartAnalysis({
            fullData: data,
            visibleTreeIds: ["A"],
            highlightedTreeId: null,
            referenceSeries,
            referenceConfig,
        });

        expect(resolved.lineCount).toBe(2);
        expect(resolved.context).toMatchObject({
            targetTree: "A",
            comparatorKind: "reference",
            usedLeaveOneOutReference: true,
        });
        expect(resolved.context?.comparatorLabel).toContain("已排除待检样芯");
        expect(resolved.context?.referenceConfig.selectedTrees).toHaveLength(1);
    });

    it("disables analysis when more than two lines are visible", () => {
        const resolved = resolvePairwiseChartAnalysis({
            fullData: data,
            visibleTreeIds: ["A", "B", "C"],
            highlightedTreeId: "A",
            referenceSeries: null,
            referenceConfig: null,
        });
        expect(resolved.lineCount).toBe(3);
        expect(resolved.context).toBeNull();
    });
});


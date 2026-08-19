import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TreeChartManager } from "@/components/Chart/TreeChartManager";
import { LineChartEmptySkeleton } from "./HomePanelComponents";

vi.mock("chartjs-plugin-zoom", () => ({ default: { id: "zoom" } }));
vi.mock("chartjs-plugin-crosshair", () => ({ default: { id: "crosshair" } }));

describe("home panel empty and loading states", () => {
    it("keeps the loading chart structure without drawing simulated lines", () => {
        const markup = renderToStaticMarkup(createElement(LineChartEmptySkeleton));

        expect(markup).not.toContain("<polyline");
        expect(markup).not.toContain("<svg");
    });

    it("renders fixed chart controls and otherwise stays blank without an open file", () => {
        const markup = renderToStaticMarkup(createElement(TreeChartManager, {
            fullData: new Map(),
        }));

        expect(markup).toContain(">全选</button>");
        expect(markup).toContain("placeholder=\"搜索序列\"");
        expect(markup).toContain(">参考</button>");
        expect(markup).toContain(">重置</button>");
        expect(markup).toContain("0 / 0");
        expect(markup).not.toContain("未选择序列");
        expect(markup).not.toContain("无匹配结果");
        expect(markup).not.toContain("<canvas");
    });

    it("reuses the reference button as the counted clear action", () => {
        const fullData = new Map([
            ["A", new Map([[2000, 100], [2001, 120]])],
            ["B", new Map([[2000, 80], [2001, 110]])],
        ]);
        const markup = renderToStaticMarkup(createElement(TreeChartManager, {
            fullData,
            referenceConfig: {
                selectedTrees: ["A", "B"],
                minSampleDepth: 2,
                method: "mean",
                mode: "manual",
                updatedAt: "2026-08-18T00:00:00.000Z",
            },
        }));

        expect(markup).toContain("清除参考(2)");
        expect(markup).not.toContain("手动参考 2 条");
        expect(markup).not.toContain("点 2");
    });

    it("shows controlled chart offsets as pending save work", () => {
        const markup = renderToStaticMarkup(createElement(TreeChartManager, {
            fullData: new Map([["A", new Map([[2000, 100], [2001, 120]])]]),
            selectedTrees: ["A"],
            treeOffsets: new Map([["A", -1]]),
        }));

        expect(markup).toContain("当前手动偏移 -1 年");
        expect(markup).toContain("保存时应用 1");
        expect(markup).toContain(">重置</button>");
    });
});

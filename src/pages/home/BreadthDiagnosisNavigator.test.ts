import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BreadthDiagnosisNavigator } from "./BreadthDiagnosisNavigator";
import type { BreadthDiagnosisSuggestion } from "./breadthDiagnosis";

const makeSuggestion = (seriesId: string, order: number): BreadthDiagnosisSuggestion => ({
    fingerprint: `${seriesId}:missingRing:1898:1902:1900:none`,
    eventId: `${seriesId}-event`,
    seriesId,
    eventType: "missingRing",
    startYear: 1898,
    endYear: 1902,
    topYear: 1900,
    confidenceLevel: "medium",
    reviewOnly: true,
    firstSeenAt: order * 1000,
    firstSeenOrder: order,
});

describe("BreadthDiagnosisNavigator", () => {
    it("shows scan progress and only the first three FIFO review rows", () => {
        const html = renderToStaticMarkup(createElement(BreadthDiagnosisNavigator, {
            navigator: {
                status: "scanning",
                scannedCount: 18,
                totalCount: 55,
                suggestions: [
                    makeSuggestion("mon142", 1),
                    makeSuggestion("mon271", 2),
                    makeSuggestion("mtr741", 3),
                    makeSuggestion("mtr841", 4),
                ],
            },
            onSelectSuggestion: () => undefined,
        }));

        expect(html).toContain("待复核序列");
        expect(html).toContain("全文件后台扫描 18 / 55");
        expect(html).toContain("mon142");
        expect(html).toContain("mtr741");
        expect(html).not.toContain("mtr841");
        expect(html).toContain("还有 1 条");
        expect(html).toContain("可能缺轮");
        expect(html).toContain("role=\"progressbar\"");
    });

    it("distinguishes stale and completed-empty states", () => {
        const staleHtml = renderToStaticMarkup(createElement(BreadthDiagnosisNavigator, {
            navigator: {
                status: "stale",
                scannedCount: 0,
                totalCount: 55,
                suggestions: [],
            },
            onSelectSuggestion: () => undefined,
        }));
        const completeHtml = renderToStaticMarkup(createElement(BreadthDiagnosisNavigator, {
            navigator: {
                status: "complete",
                scannedCount: 55,
                totalCount: 55,
                suggestions: [],
            },
            onSelectSuggestion: () => undefined,
        }));

        expect(staleHtml).toContain("数据有变化，保存后重新扫描");
        expect(staleHtml).not.toContain("role=\"progressbar\"");
        expect(completeHtml).toContain("暂未发现其他复核窗口");
    });
});

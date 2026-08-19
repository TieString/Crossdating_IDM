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
    priority: {
        reliabilityTier: 5,
        frontierRatio: 0.8,
        sharedOverlapYears: 50,
        weightedReferenceOverlap: 120,
        newerEndDistanceYears: 10,
        windowWidth: 5,
        evidenceMargin: 0.2,
        correlationGain: 0.1,
    },
    firstSeenAt: order * 1000,
    firstSeenOrder: order,
});

describe("BreadthDiagnosisNavigator", () => {
    it("renders all priority rows inside a fixed two-row scroll viewport", () => {
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
            scanAvailable: true,
            onRunScan: () => undefined,
            onSelectSuggestion: () => undefined,
        }));

        expect(html).toContain("待复核序列");
        expect(html).toContain("后台扫描 18 / 55");
        expect(html).toContain("mon142");
        expect(html).toContain("mtr741");
        expect(html).toContain("mtr841");
        expect(html).toContain("data-visible-rows=\"2\"");
        expect(html).toContain("待复核序列滚动列表");
        expect(html).not.toContain("还有 1 条");
        expect(html).toContain("可能缺轮");
        expect(html).toContain("高可信 · 前沿");
        expect(html).toContain("预计可重新对齐约 50 个重叠年");
        expect(html).toContain("role=\"progressbar\"");
        expect(html).toContain(">扫描中</button>");
        expect(html).toContain("disabled");
        expect(html).not.toContain("A 标记");
        expect(html).not.toContain("PART 6");
    });

    it("distinguishes stale and completed-empty states", () => {
        const staleHtml = renderToStaticMarkup(createElement(BreadthDiagnosisNavigator, {
            navigator: {
                status: "stale",
                scannedCount: 0,
                totalCount: 55,
                suggestions: [],
            },
            scanAvailable: true,
            onRunScan: () => undefined,
            onSelectSuggestion: () => undefined,
        }));
        const completeHtml = renderToStaticMarkup(createElement(BreadthDiagnosisNavigator, {
            navigator: {
                status: "complete",
                scannedCount: 55,
                totalCount: 55,
                suggestions: [],
            },
            scanAvailable: true,
            onRunScan: () => undefined,
            onSelectSuggestion: () => undefined,
        }));

        expect(staleHtml).toContain("扫描结果已过期，点击重新扫描");
        expect(staleHtml).toContain(">扫描</button>");
        expect(staleHtml).not.toContain("disabled");
        expect(staleHtml).not.toContain("role=\"progressbar\"");
        expect(completeHtml).toContain("暂未发现复核窗口");
        expect(completeHtml).toContain(">重新扫描</button>");
    });

    it("labels a selected-series pause as paused instead of scanning", () => {
        const html = renderToStaticMarkup(createElement(BreadthDiagnosisNavigator, {
            navigator: {
                status: "paused",
                pauseReason: "selected-diagnosis",
                scannedCount: 2,
                totalCount: 5,
                suggestions: [],
            },
            scanAvailable: true,
            onRunScan: () => undefined,
            onSelectSuggestion: () => undefined,
        }));

        expect(html).toContain("当前序列诊断优先，后台扫描已暂停");
        expect(html).toContain(">已暂停</button>");
        expect(html).not.toContain(">扫描中</button>");
    });

    it("waits for the automatic COFECHA reference instead of offering LOO scanning", () => {
        const html = renderToStaticMarkup(createElement(BreadthDiagnosisNavigator, {
            navigator: {
                status: "stale",
                scannedCount: 0,
                totalCount: 55,
                suggestions: [],
            },
            scanAvailable: false,
            onRunScan: () => undefined,
            onSelectSuggestion: () => undefined,
        }));

        expect(html).toContain("等待 COFECHA 自动参考");
        expect(html).toContain("disabled");
    });

    it("disables scanning when the latest COFECHA result contains no A-marked series", () => {
        const html = renderToStaticMarkup(createElement(BreadthDiagnosisNavigator, {
            navigator: {
                status: "complete",
                scannedCount: 0,
                totalCount: 0,
                suggestions: [],
            },
            scanAvailable: true,
            onRunScan: () => undefined,
            onSelectSuggestion: () => undefined,
        }));

        expect(html).toContain("当前没有待扫描序列");
        expect(html).toContain("disabled");
    });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CurrentEventRankerSession } from "@/pages/home/useCurrentEventRanker";
import { CurrentEventSuggestionPanel } from "./CurrentEventSuggestionPanel";

const noop = () => undefined;

describe("CurrentEventSuggestionPanel dual-gate states", () => {
  it("renders range-only advice without exact-year candidates or confirmation actions", () => {
    const session: CurrentEventRankerSession = {
      modelId: "current-event-adaptive-range-v1",
      status: "range_advice",
      requestId: "range-only-1",
      context: {
        rwlPath: String.raw`D:\data\sample.rwl`,
        targetSeriesId: "ABC01A",
        sourceHash: "saved-hash",
      },
      confirmedYears: [],
      result: {
        status: "range_advice",
        reasonCode: "YEAR_RELIABILITY_BELOW_THRESHOLD",
        message: "事件范围可供重点检查，但精确年份证据不足",
        eventRange: {
          startYear: 1880,
          endYear: 1894,
          centerYear: 1887,
          width: 15,
          scope: "newest_unresolved_event",
          localizerScore: 2.4,
          baseCenterRank: 4,
          candidateCenterCount: 120,
          scoreSemantics: "相对范围分，不是概率",
          adaptive: true,
          shrunk: false,
          windowPolicy: "local_score_mass",
          maxEnvelopeStart: 1880,
          maxEnvelopeEnd: 1894,
          evidencePeak: 0.2,
          evidenceMass: 0.8,
        },
        suggestions: [],
        rangeReliability: {
          accepted: true,
          score: 0.8,
          threshold: 0.33853178198144895,
          semantics: "范围门分数，不是概率",
          independentFromYearGate: true,
        },
        yearReliability: {
          accepted: false,
          score: 0.5,
          threshold: 0.6697964597119709,
          semantics: "年份门分数，不是概率",
        },
      },
      error: null,
      staleReason: null,
    };

    const html = renderToStaticMarkup(createElement(CurrentEventSuggestionPanel, {
      session,
      models: [{
        id: session.modelId,
        displayName: "双门控自适应范围 V1.3",
        description: "范围门与年份门独立判断",
        bundleVersion: "current-event-adaptive-range-gate-v1.3.0",
        yearFeatureCount: 251,
        rangeFeatureCount: 70,
        rangeReliabilityFeatureCount: 109,
        singleEventRange: true,
        adaptiveEventRange: true,
        deploymentVersion: null,
        routeVersion: null,
        operationScope: ["insert_missing"],
        existingZeroPolicy: "preserve",
        topK: 5,
        rangeRadius: 1,
        maxConfirmations: 6,
        manualOnly: false,
        diagnosticOnly: true,
        automaticWriteback: false,
        isDefault: false,
      }],
      activeModelId: session.modelId,
      modelCatalogError: null,
      targetSeriesId: "ABC01A",
      isFileModified: false,
      onAnalyze: noop,
      onConfirmYear: noop,
      onUndoConfirmation: noop,
      onApplyConfirmedYears: noop,
      onCancel: noop,
      onRetry: noop,
      onFocusSuggestion: noop,
      onSelectModel: noop,
    }));

    expect(html).toContain("仅范围可复核");
    expect(html).toContain("1880–1894");
    expect(html).toContain("范围可供重点检查，但精确年份证据不足");
    expect(html).toContain("本轮不会显示或允许确认年份 Top5");
    expect(html).not.toContain("<article");
    expect(html).not.toContain("确认 1887");
  });

  it("renders the manual-only RRF route as exact Top5 centers with ±3 evidence", () => {
    const session: CurrentEventRankerSession = {
      modelId: "current-event-missing-rrf-v1",
      status: "advice",
      requestId: "rrf-1",
      context: {
        rwlPath: String.raw`D:\data\sample.rwl`,
        targetSeriesId: "PAN35B",
        sourceHash: "saved-hash",
      },
      confirmedYears: [],
      result: {
        status: "advice",
        message: "请由专家复核",
        routeVersion: "missing-current-event-rrf0-range3-v1",
        operationScope: "insert_missing",
        suggestions: [{
          rank: 1,
          centerYear: 1896,
          rangeStart: 1893,
          rangeEnd: 1899,
          rankingScore: 1.5,
          evidence: {
            pathRank: 1,
            noneRank: 2,
            inferredLatestPathBase: -2,
          },
        }],
        reliability: {
          accepted: true,
          score: 0.9036,
          threshold: 0.6697964597119709,
          semantics: "本轮可靠性，不是年份概率",
        },
      },
      error: null,
      staleReason: null,
    };
    const html = renderToStaticMarkup(createElement(CurrentEventSuggestionPanel, {
      session,
      models: [{
        id: session.modelId,
        displayName: "缺轮逐轮建议：双基准 RRF V1",
        description: "仅用于专家主动调用的缺轮逐轮路线",
        bundleVersion: "current-event-range-v1.0.0",
        deploymentVersion: "current-event-rrf-deployment-candidate-v1",
        routeVersion: "missing-current-event-rrf0-range3-v1",
        operationScope: ["insert_missing"],
        existingZeroPolicy: "remove",
        topK: 5,
        rangeRadius: 3,
        maxConfirmations: 6,
        manualOnly: true,
        yearFeatureCount: 251,
        rangeFeatureCount: null,
        rangeReliabilityFeatureCount: null,
        singleEventRange: false,
        adaptiveEventRange: false,
        diagnosticOnly: true,
        automaticWriteback: false,
        isDefault: false,
      }],
      activeModelId: session.modelId,
      modelCatalogError: null,
      targetSeriesId: "PAN35B",
      isFileModified: false,
      onAnalyze: noop,
      onConfirmYear: noop,
      onUndoConfirmation: noop,
      onApplyConfirmedYears: noop,
      onCancel: noop,
      onRetry: noop,
      onFocusSuggestion: noop,
      onSelectModel: noop,
    }));

    expect(html).toContain("仅专家主动调用");
    expect(html).toContain("建议范围 1893–1899");
    expect(html).toContain("RRF 融合分");
    expect(html).toContain("latest-path rank #1");
    expect(html).toContain("无归一化 rank #2");
    expect(html).toContain("本轮可靠性估计");
    expect(html).not.toContain("唯一事件范围");
  });
});

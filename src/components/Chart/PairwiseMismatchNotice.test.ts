import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PairwiseMismatchAnalysis } from "@/features/crossdating/pairwiseMismatch";
import { PairwiseMismatchNotice } from "./PairwiseMismatchNotice";

const analysis: PairwiseMismatchAnalysis = {
  status: "mismatch",
  targetTree: "PAIR01",
  comparatorId: "PAIR02",
  comparatorLabel: "PAIR02",
  comparatorKind: "series",
  comparatorDepth: 1,
  overlapRange: { startYear: 1800, endYear: 2020 },
  overlapYears: 220,
  globalLag: -1,
  currentCorrelation: 0.12,
  bestCorrelation: 0.61,
  summary: "约从 1994 年向更老年份一侧开始错配",
  detail: "较老侧相对向新年份错开 1 年；已生成一个定年建议窗口供复核。",
  event: {
    id: "pairwise-event",
    seriesId: "PAIR01",
    eventType: "missingRing",
    startYear: 1991,
    endYear: 1997,
    rankedYears: [{ year: 1994, rank: 1, score: 1, evidenceTags: ["pairwise_mismatch"] }],
    confidenceLevel: "medium",
    evidence: {
      algorithmSources: ["pairwise_mismatch", "segmented_lag_path"],
      score: 1,
      scoreMargin: 0.2,
      baselineCorrelation: 0.12,
      correctedCorrelation: 0.61,
      correlationGain: 0.49,
      lagBefore: -1,
      lagAfter: 0,
      samplePairs: 220,
      candidateIds: [],
      notes: ["profile_boundary_year=1994", "scan_top_year=1994"],
    },
    alternativeTypes: [],
  },
};

describe("PairwiseMismatchNotice", () => {
  it("reuses the dating-suggestion surface for a pairwise event", () => {
    const html = renderToStaticMarkup(createElement(PairwiseMismatchNotice, {
      analysis,
      onFocusEvent: () => undefined,
      onApplyEvent: () => true,
      onDismiss: () => undefined,
    }));

    expect(html).toContain("双线分析");
    expect(html).toContain("单样芯相对证据");
    expect(html).toContain("约从 1994 年");
    expect(html).toContain("aria-label=\"定年建议\"");
    expect(html).toContain("可能缺轮");
    expect(html).toContain("应用");
  });

  it("renders a restrained status when no edit event is available", () => {
    const html = renderToStaticMarkup(createElement(PairwiseMismatchNotice, {
      analysis: {
        ...analysis,
        status: "whole-shift",
        event: null,
        summary: "整个重叠区相对偏移 2 年",
        detail: "无法可靠定位错配开始年份。",
        globalLag: -2,
      },
      onDismiss: () => undefined,
    }));

    expect(html).toContain("整个重叠区相对偏移 2 年");
    expect(html).toContain("无法可靠定位错配开始年份");
    expect(html).not.toContain("aria-label=\"定年建议\"");
  });
});


import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis";
import {
  DiagnosisEventPanel,
  selectDiagnosisEventInterpretation,
} from "./DiagnosisEventPanel";

describe("DiagnosisEventPanel", () => {
  it("renders only the current event-level diagnosis surface", () => {
    const event: DiagnosisEvent = {
      id: "event-1",
      seriesId: "ABC01A",
      eventType: "missingRing",
      startYear: 1880,
      endYear: 1886,
      rankedYears: [{ year: 1883, rank: 1, score: 2.1, evidenceTags: ["piecewise_lag_path"] }],
      confidenceLevel: "high",
      evidence: {
        algorithmSources: ["piecewise_lag_path"],
        score: 2.1,
        scoreMargin: 0.4,
        baselineCorrelation: 0.31,
        correctedCorrelation: 0.62,
        correlationGain: 0.31,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 38,
        candidateIds: ["legacy-candidate-1"],
        notes: [],
      },
      alternativeTypes: [],
    };

    const html = renderToStaticMarkup(createElement(DiagnosisEventPanel, { events: [event] }));

    expect(html).toContain("JS 事件级诊断");
    expect(html).toContain("可能缺轮");
    expect(html).toContain("1880-1886");
    expect(html).toContain("#1 1883");
    expect(html).toContain("事件置信 高");
    expect(html).toContain("年份证据 不足");
    expect(html).toContain("不代表首选年份正确概率");
    expect(html).not.toContain("通过编辑验证的候选");
    expect(html).not.toContain("legacy-candidate-1");
    expect(html).not.toContain("查看并确认所选年份的编辑操作");
    expect(html).not.toContain("忽略");
  });

  it("offers every year in the partial-move main window as a breakpoint", () => {
    const event: DiagnosisEvent = {
      id: "event-apply",
      seriesId: "ABC01A",
      eventType: "partialMove",
      startYear: 1880,
      endYear: 1882,
      rankedYears: [
        { year: 1881, rank: 1, score: 2.1, evidenceTags: ["piecewise_lag_path"] },
        { year: 1880, rank: 2, score: 1.8, evidenceTags: ["piecewise_lag_path"] },
      ],
      confidenceLevel: "high",
      shiftYears: -2,
      shiftSide: "older",
      evidence: {
        algorithmSources: ["piecewise_lag_path"],
        score: 2.1,
        scoreMargin: 0.4,
        baselineCorrelation: 0.31,
        correctedCorrelation: 0.62,
        correlationGain: 0.31,
        lagBefore: 2,
        lagAfter: 0,
        samplePairs: 38,
        candidateIds: [],
        notes: [
          "profile_boundary_year=1881",
          "scan_top_year=1881",
          "candidate_top_year=1882",
        ],
      },
      alternativeTypes: [],
    };

    const html = renderToStaticMarkup(createElement(DiagnosisEventPanel, {
      events: [event],
      onApplyEvent: () => true,
    }));

    expect(html).toContain("断点选项");
    expect(html).toContain("#1 1881");
    expect(html).toContain("#2 1880");
    expect(html).toContain("选择断点 1882");
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("aria-pressed=\"false\"");
    expect(html).toContain("较老侧向老年份移动 2 年");
    expect(html).toContain("年份证据 较一致");
    expect(html).toContain("应用");
    expect(html).not.toContain("确认应用");
    expect(html).not.toContain("role=\"alert\"");
    expect(html).not.toContain("查看并确认所选年份的编辑操作");
  });

  it("renders only the main window when legacy location alternatives are present", () => {
    const event: DiagnosisEvent = {
      id: "event-alternatives",
      seriesId: "ABC01A",
      eventType: "missingRing",
      startYear: 1900,
      endYear: 1906,
      rankedYears: [{ year: 1903, rank: 1, score: 5, evidenceTags: [] }],
      confidenceLevel: "medium",
      evidence: {
        algorithmSources: ["piecewise_lag_path"],
        score: 5,
        scoreMargin: 1,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.6,
        correlationGain: 0.4,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 40,
        candidateIds: [],
        notes: [],
      },
      alternativeTypes: [],
      locationAlternatives: [{
        rank: 1,
        startYear: 1870,
        endYear: 1876,
        rankedYears: [{
          year: 1873,
          rank: 1,
          score: 4,
          evidenceTags: ["cumulative_lag_change_point"],
        }],
        evidenceScore: 4,
        scoreMargin: 1,
        algorithmSource: "cumulative_lag_change_point",
      }],
    };

    const html = renderToStaticMarkup(createElement(DiagnosisEventPanel, {
      events: [event],
    }));

    expect(html).toContain("1900-1906（7 年）");
    expect(html).not.toContain("1870-1876");
    expect(html).not.toContain("备选");
    expect(html).not.toContain("候选问题窗口");
  });

  it("renders only the primary operation when legacy operation alternatives are present", () => {
    const alternative: DiagnosisEvent = {
      id: "event-operation-false",
      seriesId: "ABC01A",
      eventType: "falseRing",
      startYear: 1930,
      endYear: 1936,
      rankedYears: [{ year: 1933, rank: 1, score: 0.2, evidenceTags: [] }],
      confidenceLevel: "low",
      evidence: {
        algorithmSources: ["counterfactual_operation_verification"],
        score: 0.2,
        scoreMargin: 0.03,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.4,
        correlationGain: 0.2,
        lagBefore: 1,
        lagAfter: 0,
        samplePairs: 40,
        candidateIds: [],
        notes: [],
      },
      alternativeTypes: [],
    };
    const partialAlternative: DiagnosisEvent = {
      ...alternative,
      id: "event-operation-partial",
      eventType: "partialMove",
      startYear: 1960,
      endYear: 1968,
      rankedYears: [{ year: 1964, rank: 1, score: 0.18, evidenceTags: [] }],
      shiftYears: -2,
      shiftSide: "older",
      evidence: {
        ...alternative.evidence,
        score: 0.18,
        lagBefore: -2,
      },
    };
    const primary: DiagnosisEvent = {
      ...alternative,
      id: "event-operation-missing",
      eventType: "missingRing",
      startYear: 1900,
      endYear: 1906,
      rankedYears: [{ year: 1903, rank: 1, score: 0.3, evidenceTags: [] }],
      confidenceLevel: "medium",
      evidence: {
        ...alternative.evidence,
        score: 0.3,
        lagBefore: -1,
      },
      operationAlternatives: [alternative, partialAlternative],
    };

    const html = renderToStaticMarkup(createElement(DiagnosisEventPanel, {
      events: [primary],
      onApplyEvent: () => true,
    }));

    expect(html).toContain("可能缺轮");
    expect(html).not.toContain("可能伪轮");
    expect(html).not.toContain("可能局部移动");
    expect(html).not.toContain("候选编辑操作");
    expect(html).not.toContain("role=\"tab\"");
    expect(html).toContain("在 1903 年插入缺轮");
    expect(html).not.toContain("确认应用");
    expect(html).not.toContain("查看并确认所选年份的编辑操作");
  });

  it("shows one constrained interpretation switch without rendering a candidate list", () => {
    const partial: DiagnosisEvent = {
      id: "partial-interpretation",
      seriesId: "ABC01A",
      eventType: "partialMove",
      startYear: 1901,
      endYear: 1907,
      rankedYears: [{ year: 1905, rank: 1, score: 0.2, evidenceTags: [] }],
      confidenceLevel: "medium",
      shiftYears: -2,
      shiftSide: "older",
      evidence: {
        algorithmSources: ["continuous_partial_gap_interpretation"],
        score: 0.2,
        scoreMargin: 0.01,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.5,
        correlationGain: 0.3,
        lagBefore: -2,
        lagAfter: 0,
        samplePairs: 40,
        candidateIds: ["partial"],
        notes: [],
      },
      alternativeTypes: [],
    };
    const primary: DiagnosisEvent = {
      ...partial,
      id: "missing-primary",
      eventType: "missingRing",
      startYear: 1900,
      endYear: 1906,
      rankedYears: [{ year: 1904, rank: 1, score: 0.21, evidenceTags: [] }],
      shiftYears: undefined,
      shiftSide: undefined,
      evidence: {
        ...partial.evidence,
        algorithmSources: ["discrete_missing_staircase_interpretation"],
        lagBefore: -1,
      },
      interpretationAmbiguity: {
        kind: "missingRingsOrPartialMove",
        alternative: partial,
        evidence: {
          missingRingCount: 2,
          cumulativeShiftYears: -2,
          missingYears: [1901, 1904],
          partialFirstFixedYear: 1905,
          normalizedCounterfactualGainDifference: 0.4,
          masterMargin: 0.01,
          referenceMedianMargin: 0.005,
          referenceCount: 10,
          missingReferenceSupport: 5,
          partialReferenceSupport: 5,
        },
      },
    };

    const html = renderToStaticMarkup(createElement(DiagnosisEventPanel, {
      events: [primary],
      onApplyEvent: () => true,
    }));

    expect(html).toContain("可能缺轮");
    expect(html).toContain("预计包含 2 个缺轮事件");
    expect(html).toContain("按连续缺段处理");
    expect(html).toContain("缺轮/连续缺段参考芯支持 5/5");
    expect(html).not.toContain("可能局部移动");
    expect(html).not.toContain("1901-1907（7 年）");
    expect(html).not.toContain("role=\"tab\"");
    expect(html).not.toContain("候选编辑操作");
    expect(selectDiagnosisEventInterpretation(primary, "alternative")).toBe(partial);
    expect(selectDiagnosisEventInterpretation(primary, "primary")).toBe(primary);
  });

  it("labels the reverse switch as iterative missing-ring review", () => {
    const missing: DiagnosisEvent = {
      id: "missing-interpretation",
      seriesId: "ABC01A",
      eventType: "missingRing",
      startYear: 1900,
      endYear: 1906,
      rankedYears: [{ year: 1904, rank: 1, score: 0.2, evidenceTags: [] }],
      confidenceLevel: "medium",
      evidence: {
        algorithmSources: ["discrete_missing_staircase_interpretation"],
        score: 0.2,
        scoreMargin: 0.01,
        baselineCorrelation: 0.2,
        correctedCorrelation: 0.5,
        correlationGain: 0.3,
        lagBefore: -1,
        lagAfter: 0,
        samplePairs: 40,
        candidateIds: [],
        notes: [],
      },
      alternativeTypes: [],
    };
    const primary: DiagnosisEvent = {
      ...missing,
      id: "partial-primary",
      eventType: "partialMove",
      startYear: 1901,
      endYear: 1907,
      rankedYears: [{ year: 1905, rank: 1, score: 0.2, evidenceTags: [] }],
      shiftYears: -2,
      shiftSide: "older",
      evidence: { ...missing.evidence, lagBefore: -2 },
      interpretationAmbiguity: {
        kind: "missingRingsOrPartialMove",
        alternative: missing,
        evidence: {
          missingRingCount: 2,
          cumulativeShiftYears: -2,
          missingYears: [1901, 1904],
          partialFirstFixedYear: 1905,
          normalizedCounterfactualGainDifference: 0.4,
          masterMargin: -0.01,
          referenceMedianMargin: -0.005,
          referenceCount: 10,
          missingReferenceSupport: 5,
          partialReferenceSupport: 5,
        },
      },
    };

    const html = renderToStaticMarkup(createElement(DiagnosisEventPanel, {
      events: [primary],
    }));

    expect(html).toContain("可能局部移动");
    expect(html).toContain("按 2 个缺轮逐轮复核");
    expect(html).not.toContain("可能缺轮");
    expect(html).not.toContain("1900-1906（7 年）");
  });
});

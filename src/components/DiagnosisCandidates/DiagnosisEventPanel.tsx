import { useEffect, useState, type CSSProperties } from "react";
import type {
  DiagnosisEvent,
  DiagnosisEventType,
} from "@/features/crossdating/diagnosis";

type Props = {
  events: DiagnosisEvent[];
  onFocusEvent?: (event: DiagnosisEvent, selectedYear?: number) => void;
  onApplyEvent?: (event: DiagnosisEvent, selectedYear: number) => boolean | void;
};

const buttonStyle: CSSProperties = {
  fontSize: 12,
  padding: "3px 8px",
  borderRadius: 5,
  cursor: "pointer",
  border: "1px solid #79a87d",
  background: "#fff",
  color: "#315d36",
  fontWeight: 500,
  lineHeight: 1.4,
  boxShadow: "none",
};

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "#f4f4f4",
  color: "#c0c0c0",
  cursor: "default",
  borderColor: "#e4e4e4",
};

const applyButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: "#397342",
  background: "#397342",
  color: "#fff",
};

const interpretationButtonStyle: CSSProperties = {
  ...buttonStyle,
  padding: "2px 7px",
  borderColor: "#8da68e",
  background: "#f8fbf7",
  color: "#315d36",
};

const eventTypeLabels: Record<DiagnosisEventType, string> = {
  missingRing: "可能缺轮",
  falseRing: "可能伪轮",
  partialMove: "可能局部移动",
  wholeSeriesMove: "可能整体移动",
};

const confidenceLabels = { high: "高", medium: "中", low: "低" } as const;

const yearEvidenceFamilies = [
  ["profile_boundary_year=", "nominal_boundary_year="],
  ["scan_top_year="],
  ["raw_path_top_year="],
  ["candidate_top_year="],
  ["direct_transition_year="],
  ["paired_breakpoint_year="],
  ["reference_vote_year=", "partial_reference_vote_year="],
  [
    "unit_local_raw_boundary_year=",
    "unit_window_raw31_year=",
    "local_raw_boundary_year=",
    "repeated_block_boundary_year=",
  ],
] as const;

const noteNumber = (notes: readonly string[], prefixes: readonly string[]) => {
  for (const prefix of prefixes) {
    const note = [...notes].reverse().find((value) => value.startsWith(prefix));
    const value = Number(note?.slice(prefix.length));
    if (Number.isFinite(value)) return value;
  }
  return null;
};

const yearEvidenceLabel = (event: DiagnosisEvent) => {
  const topYear = event.rankedYears[0]?.year;
  if (topYear === undefined) return "不足";
  const evidenceYears = yearEvidenceFamilies
    .map((prefixes) => noteNumber(event.evidence.notes, prefixes))
    .filter((year): year is number => year !== null);
  if (evidenceYears.length === 0) return "不足";
  const nearby = evidenceYears.filter((year) => Math.abs(year - topYear) <= 1).length;
  const spread = Math.max(...evidenceYears) - Math.min(...evidenceYears);
  if (nearby >= 3 && spread <= 3) return "较一致";
  if (nearby >= 2) return "一般";
  return "分散";
};

const formatCorrelation = (value: number | null) => (
  value === null ? "-" : value.toFixed(2)
);

const formatAlgorithmSource = (sources: readonly string[]) => {
  const labels: Record<string, string> = {
    global_sliding_match: "global",
    segmented_diagnosis: "segmented",
    propagation_pattern: "propagation",
    local_edit_alignment: "edit",
    cofecha_segment_lag: "cofecha",
    ar_prewhiten_recall: "ar",
    bayesian_lag_path: "bayes",
    piecewise_lag_path: "lag path",
    dense_lag_profile: "dense lag",
    segmented_lag_path: "segmented lag",
    candidate_ranking: "ranking",
  };
  return sources.map((source) => labels[source] ?? source).join(" + ");
};

const applyPreview = (event: DiagnosisEvent, selectedYear: number) => {
  if (event.eventType === "missingRing") {
    return `在 ${selectedYear} 年插入缺轮，并将该年及较老侧统一向老年份移动 1 年。`;
  }
  if (event.eventType === "falseRing") {
    return `删除 ${selectedYear} 年，并将较老侧统一向新年份移动 1 年。`;
  }
  if (event.eventType === "partialMove" && event.shiftYears) {
    const lastMovedYear = selectedYear - 1;
    const movedStartYear = event.seriesRange?.startYear;
    const gapStartYear = selectedYear + event.shiftYears;
    return [
      `断点 ${selectedYear}；${selectedYear} 年起保持不动。`,
      `${movedStartYear === undefined ? "较老侧" : `${movedStartYear}-${lastMovedYear} 年`}向老年份移动 ${Math.abs(event.shiftYears)} 年。`,
      `移动后 ${gapStartYear}-${lastMovedYear} 年为空白。`,
    ].join(" ");
  }
  return "按已验证的整体移动候选应用整条序列。";
};

type InterpretationSelection = "primary" | "alternative";

export const selectDiagnosisEventInterpretation = (
  event: DiagnosisEvent,
  selection: InterpretationSelection,
): DiagnosisEvent => (
  selection === "alternative" && event.interpretationAmbiguity
    ? event.interpretationAmbiguity.alternative
    : event
);

export function DiagnosisEventPanel({ events, onFocusEvent, onApplyEvent }: Props) {
  const [selectedInterpretations, setSelectedInterpretations] = useState<
    Record<string, InterpretationSelection>
  >({});

  useEffect(() => {
    const currentPrimaryIds = new Set(events.map((event) => event.id));
    setSelectedInterpretations((previous) => Object.fromEntries(
      Object.entries(previous).filter(([eventId]) => currentPrimaryIds.has(eventId)),
    ));
  }, [events]);

  if (events.length === 0) {
    return (
      <div style={{ padding: "8px 6px", color: "#8a8a8a", fontSize: 12 }}>
        该序列暂无事件级诊断建议
      </div>
    );
  }

  return (
    <section
      aria-label="JS 事件级诊断"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 7,
        border: "1px solid #cbdcc9",
        borderRadius: 6,
        background: "#f8fcf7",
        fontFamily: "Segoe UI, system-ui, sans-serif",
        fontSize: 11,
        color: "#315d36",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ fontSize: 12, color: "#234d28" }}>JS 事件级诊断</strong>
        <span>复核事件 {events.length}</span>
      </div>

      {events.map((event) => {
        const interpretationSelection = selectedInterpretations[event.id] ?? "primary";
        const selectedEvent = selectDiagnosisEventInterpretation(
          event,
          interpretationSelection,
        );
        const interpretation = event.interpretationAmbiguity;
        const width = selectedEvent.endYear - selectedEvent.startYear + 1;
        const rankedYears = [...selectedEvent.rankedYears]
          .filter((row, index, rows) => (
            row.year >= selectedEvent.startYear
            && row.year <= selectedEvent.endYear
            && rows.findIndex((candidate) => candidate.year === row.year) === index
          ))
          .sort((a, b) => a.rank - b.rank);
        const preferredYear = rankedYears[0]?.year;
        const selectedYear = preferredYear
          ?? Math.round((selectedEvent.startYear + selectedEvent.endYear) / 2);
        const isWholeSeriesMove = selectedEvent.eventType === "wholeSeriesMove";
        const shiftText = selectedEvent.eventType === "partialMove" && selectedEvent.shiftYears
          ? ` · 较老侧向老年份移动 ${Math.abs(selectedEvent.shiftYears)} 年`
          : "";
        const wholeShiftText = isWholeSeriesMove && selectedEvent.shiftYears
          ? `整条序列向${selectedEvent.shiftYears < 0 ? "老" : "新"}年份移动 ${Math.abs(selectedEvent.shiftYears)} 年`
          : "整条序列位移";
        const yearEvidence = yearEvidenceLabel(selectedEvent);
        const retainedAcrossEvidenceRefresh = selectedEvent.evidence.algorithmSources
          .includes("evidence_refresh_adjudicator");
        const missingPartialEvidence = interpretation?.kind === "missingRingsOrPartialMove"
          ? interpretation.evidence
          : null;
        const hasCalibratedMissingCount = missingPartialEvidence?.countEvidence
          === "multiReferenceStaircase";

        return (
          <article
            key={event.id}
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) auto",
              alignItems: "start",
              gap: 6,
              padding: "6px 7px",
              border: "1px solid #bfd7c0",
              borderRadius: 5,
              background: "#fff",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 5 }}>
                <strong style={{ color: "#234d28" }}>
                  {eventTypeLabels[selectedEvent.eventType]}
                </strong>
                <span>
                  {isWholeSeriesMove
                    ? wholeShiftText
                    : `${selectedEvent.startYear}-${selectedEvent.endYear}（${width} 年）`}
                </span>
                <span
                  title="表示事件级证据强度，不代表首选年份正确概率"
                  style={{ fontSize: 10, fontWeight: 700 }}
                >
                  事件置信 {confidenceLabels[selectedEvent.confidenceLevel]}
                </span>
                {!isWholeSeriesMove ? (
                  <span
                    title="表示不同定位证据是否聚集，不是该年份的正确概率"
                    style={{ fontSize: 10, fontWeight: 700 }}
                  >
                    年份证据 {yearEvidence}
                  </span>
                ) : null}
                {retainedAcrossEvidenceRefresh ? (
                  <span
                    title="working 数据没有变化；保存后新 COFECHA 与保存前内部假设冲突，当前保留两边都支持的原复核事件。"
                    style={{ fontSize: 10, fontWeight: 700, color: "#8a5a18" }}
                  >
                    保存后证据冲突 · 保留原复核
                  </span>
                ) : null}
              </div>

              {!isWholeSeriesMove ? (
                <div style={{ marginTop: 4 }}>
                  Top1 {selectedYear}
                </div>
              ) : null}

              <div style={{ marginTop: 4 }}>
                lag {selectedEvent.evidence.lagBefore ?? "-"} → {selectedEvent.evidence.lagAfter ?? "-"}
                {shiftText}
              </div>
              {selectedEvent.eventType === "partialMove" && selectedEvent.shiftYears ? (
                <div style={{ marginTop: 2, color: "#45694a" }}>
                  断点 {selectedYear} · {selectedYear} 年起保持不动 · 移动后{" "}
                  {selectedYear + selectedEvent.shiftYears}-{selectedYear - 1} 年为空白
                </div>
              ) : null}
              {interpretation ? (
                <div
                  title={interpretation.kind === "wholeSeriesMoveOrMissingRing"
                    ? `树皮端距窗口 ${interpretation.evidence.endpointDistanceYears} 年；整体/缺轮操作分差 ${
                      interpretation.evidence.operationScoreMargin?.toFixed(2) ?? "-"
                    }`
                    : interpretation.evidence.interpretationBasis
                      === "completedPartialMissingComposition"
                      ? `复合校正支持 ${
                        interpretation.evidence.completedComposition?.mixedReferenceSupport ?? "-"
                      }/${
                        interpretation.evidence.completedComposition?.mixedReferenceCount ?? "-"
                      }；事件顺序支持 ${
                        interpretation.evidence.completedComposition?.orientationReferenceSupport ?? "-"
                      }/${
                        interpretation.evidence.completedComposition?.orientationReferenceCount ?? "-"
                      }`
                    : interpretation.evidence.interpretationBasis
                      === "exactSequentialStaircaseAlternative"
                      ? `精确单位阶梯支持 ${
                        interpretation.evidence.missingReferenceSupport
                      }/${interpretation.evidence.referenceCount}；连续缺段支持 ${
                        interpretation.evidence.partialReferenceSupport
                      }/${interpretation.evidence.referenceCount}`
                    : interpretation.evidence.interpretationBasis
                      === "structuredLocatorCumulativeLagAlternative"
                      ? `结构化定位已确认同一区域；累计位移对应 ${
                        interpretation.evidence.missingRingCount
                      } 个缺轮，连续缺段与逐轮缺轮收益接近`
                    : `完整反事实收益差 ${
                      interpretation.evidence.normalizedCounterfactualGainDifference.toFixed(2)
                    }；缺轮/连续缺段参考芯支持 ${
                      interpretation.evidence.missingReferenceSupport
                    }/${interpretation.evidence.partialReferenceSupport}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 5,
                    marginTop: 5,
                    paddingTop: 5,
                    borderTop: "1px solid #e0ebe0",
                    color: "#45694a",
                  }}
                >
                  <span>
                    {interpretation.kind === "wholeSeriesMoveOrMissingRing"
                      ? selectedEvent.eventType === "wholeSeriesMove"
                        ? "树皮端整体移动与一个缺轮的证据接近；也可能是缺轮，需结合样本确认。"
                        : "当前按树皮端缺轮窗口复核；内部证据也允许整条序列移动 1 年的解释。"
                      : selectedEvent.eventType === "missingRing"
                        ? hasCalibratedMissingCount
                          ? `附近可能还有 ${Math.max(0, interpretation.evidence.missingRingCount - 1)} 个同方向缺轮事件；当前只复核最靠树皮侧的一处。`
                          : "当前只复核最靠树皮侧的一个缺轮；应用后重新诊断其余累计 lag。"
                        : hasCalibratedMissingCount
                          ? `多参考芯支持该区域累计约 ${interpretation.evidence.missingRingCount} 次同方向单位转移；实体样芯决定按连续缺段还是逐轮缺轮复核。`
                          : `累计 lag 差约 ${Math.abs(interpretation.evidence.cumulativeShiftYears)} 年；具体缺轮数量尚未独立确认。`}
                  </span>
                  <button
                    type="button"
                    disabled={event.stale === true}
                    title={interpretation.kind === "wholeSeriesMoveOrMissingRing"
                      ? selectedEvent.eventType === "wholeSeriesMove"
                        ? "切换到算法已独立验证的树皮端缺轮窗口，仅改变复核解释"
                        : "返回算法保留的整条序列移动解释"
                      : selectedEvent.eventType === "missingRing"
                        ? "实体样芯存在断裂、腐朽或连续缺段证据时返回局部移动解释"
                        : "实体样芯完整、未见断裂时，切换到单个前沿缺轮复核"}
                    onClick={() => {
                      const nextSelection: InterpretationSelection = interpretationSelection
                        === "primary" ? "alternative" : "primary";
                      const nextEvent = selectDiagnosisEventInterpretation(event, nextSelection);
                      setSelectedInterpretations((previous) => ({
                        ...previous,
                        [event.id]: nextSelection,
                      }));
                      const nextYear = [...nextEvent.rankedYears]
                        .sort((left, right) => left.rank - right.rank)[0]?.year;
                      onFocusEvent?.(nextEvent, nextYear);
                    }}
                    style={event.stale ? disabledButtonStyle : interpretationButtonStyle}
                  >
                    {interpretation.kind === "wholeSeriesMoveOrMissingRing"
                      ? selectedEvent.eventType === "wholeSeriesMove"
                        ? "按可能缺轮复核"
                        : "返回整体移动解释"
                      : selectedEvent.eventType === "missingRing"
                        ? "存在断裂，返回局部移动解释"
                        : "未见断裂，按缺轮逐轮复核"}
                  </button>
                </div>
              ) : null}
              <div style={{ marginTop: 2, color: "#56745a" }}>
                r {formatCorrelation(selectedEvent.evidence.baselineCorrelation)} → {formatCorrelation(selectedEvent.evidence.correctedCorrelation)}
                {" · "}来源 {formatAlgorithmSource(selectedEvent.evidence.algorithmSources) || "-"}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button
                type="button"
                disabled={!onFocusEvent}
                title={isWholeSeriesMove ? "定位整条序列" : `定位到 Top1 年份 ${selectedYear}`}
                onClick={() => onFocusEvent?.(selectedEvent, selectedYear)}
                style={onFocusEvent ? buttonStyle : disabledButtonStyle}
              >
                定位
              </button>
              {onApplyEvent ? (
                <button
                  type="button"
                  disabled={Boolean(selectedEvent.stale ?? event.stale)}
                  title={applyPreview(selectedEvent, selectedYear)}
                  onClick={() => onApplyEvent(selectedEvent, selectedYear)}
                  style={(selectedEvent.stale || event.stale)
                    ? disabledButtonStyle
                    : applyButtonStyle}
                >
                  应用
                </button>
              ) : null}
            </div>

          </article>
        );
      })}
    </section>
  );
}

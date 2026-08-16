import { useEffect, useState } from "react";
import type {
  DiagnosisEvent,
  DiagnosisEventType,
} from "@/features/crossdating/diagnosis";
import style from "./DiagnosisEventPanel.module.css";

type Props = {
  events: DiagnosisEvent[];
  onFocusEvent?: (event: DiagnosisEvent, selectedYear?: number) => void;
  onApplyEvent?: (event: DiagnosisEvent, selectedYear: number) => boolean | void;
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

type SelectableEventYear = {
  year: number;
  rank: number | null;
};

export const selectableEventYears = (event: DiagnosisEvent): SelectableEventYear[] => {
  if (event.eventType === "wholeSeriesMove") return [];
  const rankedYears = [...event.rankedYears]
    .filter((row, index, rows) => (
      row.year >= event.startYear
      && row.year <= event.endYear
      && rows.findIndex((candidate) => candidate.year === row.year) === index
    ))
    .sort((left, right) => left.rank - right.rank)
    .map((row) => ({ year: row.year, rank: row.rank }));
  const rankedYearSet = new Set(rankedYears.map((row) => row.year));
  const unrankedYears = Array.from(
    { length: Math.max(0, event.endYear - event.startYear + 1) },
    (_, index) => event.startYear + index,
  )
    .filter((year) => !rankedYearSet.has(year))
    .map((year) => ({ year, rank: null }));
  return [...rankedYears, ...unrankedYears];
};

const defaultSelectedYear = (
  event: DiagnosisEvent,
  selectableYears: SelectableEventYear[],
) => selectableYears.find((row) => row.rank === 1)?.year
  ?? selectableYears[0]?.year
  ?? Math.round((event.startYear + event.endYear) / 2);

const yearOptionLabel = (row: SelectableEventYear) => row.rank === null
  ? `${row.year}`
  : `#${row.rank} ${row.year}`;

export function DiagnosisEventPanel({ events, onFocusEvent, onApplyEvent }: Props) {
  const [selectedYears, setSelectedYears] = useState<Record<string, number>>({});
  const [selectedInterpretations, setSelectedInterpretations] = useState<
    Record<string, InterpretationSelection>
  >({});

  useEffect(() => {
    const currentIds = new Set(events.flatMap((event) => [
      event.id,
      ...(event.interpretationAmbiguity
        ? [event.interpretationAmbiguity.alternative.id]
        : []),
    ]));
    setSelectedYears((previous) => Object.fromEntries(
      Object.entries(previous).filter(([eventId]) => currentIds.has(eventId)),
    ));
    const currentPrimaryIds = new Set(events.map((event) => event.id));
    setSelectedInterpretations((previous) => Object.fromEntries(
      Object.entries(previous).filter(([eventId]) => currentPrimaryIds.has(eventId)),
    ));
  }, [events]);

  if (events.length === 0) {
    return (
      <div className={style.empty}>
        该序列暂无事件级诊断建议
      </div>
    );
  }

  return (
    <section
      aria-label="定年建议"
      className={style.panel}
    >
      {events.map((event) => {
        const interpretationSelection = selectedInterpretations[event.id] ?? "primary";
        const selectedEvent = selectDiagnosisEventInterpretation(
          event,
          interpretationSelection,
        );
        const interpretation = event.interpretationAmbiguity;
        const wholeMissingReviewCount = interpretation?.kind === "wholeSeriesMoveOrMissingRing"
          ? Math.abs(interpretation.evidence.wholeShiftYears)
          : 1;
        const wholeMissingRemainingCount = Math.max(0, wholeMissingReviewCount - 1);
        const width = selectedEvent.endYear - selectedEvent.startYear + 1;
        const isWholeSeriesMove = selectedEvent.eventType === "wholeSeriesMove";
        const selectableYears = selectableEventYears(selectedEvent);
        const savedYear = selectedYears[selectedEvent.id];
        const selectedYear = savedYear !== undefined
          && selectableYears.some((row) => row.year === savedYear)
          ? savedYear
          : defaultSelectedYear(selectedEvent, selectableYears);
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
            className={style.suggestion}
          >
            <div className={style.body}>
              <div className={style.heading}>
                <strong className={style.eventType}>
                  {eventTypeLabels[selectedEvent.eventType]}
                </strong>
                <span className={style.range}>
                  {isWholeSeriesMove
                    ? wholeShiftText
                    : `${selectedEvent.startYear}–${selectedEvent.endYear} · ${width} 年`}
                </span>
                <span className={style.metadata}>
                  <span
                    title="表示事件级证据强度，不代表首选年份正确概率"
                  >
                    置信度 {confidenceLabels[selectedEvent.confidenceLevel]}
                  </span>
                  {!isWholeSeriesMove ? (
                    <span title="表示不同定位证据是否聚集，不是该年份的正确概率">
                      年份证据 {yearEvidence}
                    </span>
                  ) : null}
                </span>
                {retainedAcrossEvidenceRefresh ? (
                  <span
                    title="working 数据没有变化；保存后新 COFECHA 与保存前内部假设冲突，当前保留两边都支持的原复核事件。"
                    className={style.warning}
                  >
                    保存后证据冲突 · 保留原复核
                  </span>
                ) : null}
              </div>

              {selectableYears.length > 0 ? (
                <div
                  title={selectableYears.map(yearOptionLabel).join(" · ")}
                  className={style.yearSelector}
                >
                  <span className={style.yearLabel}>
                    {selectedEvent.eventType === "partialMove" ? "断点年份" : "复核年份"}
                  </span>
                  <div className={style.yearOptions}>
                    {selectableYears.map((row) => {
                      const selected = row.year === selectedYear;
                      return (
                        <button
                          type="button"
                          key={row.year}
                          aria-pressed={selected}
                          title={selectedEvent.eventType === "partialMove"
                            ? `选择断点 ${row.year}；${row.year} 年起保持不动`
                            : `选择年份 ${row.year} 作为应用边界`}
                          onClick={() => {
                            setSelectedYears((previous) => ({
                              ...previous,
                              [selectedEvent.id]: row.year,
                            }));
                            onFocusEvent?.(selectedEvent, row.year);
                          }}
                          className={[
                            style.yearButton,
                            row.rank !== null ? style.yearButtonRanked : "",
                            selected ? style.yearButtonActive : "",
                          ].filter(Boolean).join(" ")}
                        >
                          {yearOptionLabel(row)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <div className={style.metricLine}>
                lag {selectedEvent.evidence.lagBefore ?? "-"} → {selectedEvent.evidence.lagAfter ?? "-"}
                {shiftText}
              </div>
              {selectedEvent.eventType === "partialMove" && selectedEvent.shiftYears ? (
                <div className={style.detailLine}>
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
                  className={style.interpretation}
                >
                  <span>
                    {interpretation.kind === "wholeSeriesMoveOrMissingRing"
                      ? selectedEvent.eventType === "wholeSeriesMove"
                        ? wholeMissingReviewCount === 1
                          ? "树皮端整体移动与一个缺轮的证据接近；也可能是缺轮，需结合样本确认。"
                          : `整体移动 ${wholeMissingReviewCount} 年也可能由多个缺轮逐步累积；先复核一个已定位缺轮，应用后重新诊断。`
                        : wholeMissingReviewCount === 1
                          ? "当前按树皮端缺轮窗口复核；内部证据也允许整条序列移动 1 年的解释。"
                          : `当前只复核一个已定位缺轮；若应用，预计仍剩约 ${wholeMissingRemainingCount} 年累计偏移，随后会重新诊断。`
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
                        ? wholeMissingReviewCount === 1
                          ? "切换到算法已独立验证的树皮端缺轮窗口，仅改变复核解释"
                          : `切换到算法已独立验证的缺轮窗口；本次只复核第 1 个，应用后重新诊断剩余约 ${wholeMissingRemainingCount} 年偏移`
                        : `返回算法保留的整条序列移动 ${wholeMissingReviewCount} 年解释`
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
                      const nextSelectableYears = selectableEventYears(nextEvent);
                      const savedNextYear = selectedYears[nextEvent.id];
                      const nextYear = savedNextYear !== undefined
                        && nextSelectableYears.some((row) => row.year === savedNextYear)
                        ? savedNextYear
                        : defaultSelectedYear(nextEvent, nextSelectableYears);
                      onFocusEvent?.(nextEvent, nextYear);
                    }}
                    className={`${style.interpretationButton} ${event.stale ? style.disabledButton : ""}`}
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
              <div className={style.correlationRow}>
                <span>
                  相关性 r {formatCorrelation(selectedEvent.evidence.baselineCorrelation)} → {formatCorrelation(selectedEvent.evidence.correctedCorrelation)}
                </span>
                <details className={style.evidenceDetails}>
                  <summary>诊断依据</summary>
                  <div className={style.evidenceText}>
                    {formatAlgorithmSource(selectedEvent.evidence.algorithmSources) || "暂无来源信息"}
                  </div>
                </details>
              </div>
            </div>

            <div className={style.actions}>
              <button
                type="button"
                disabled={!onFocusEvent}
                title={isWholeSeriesMove ? "定位整条序列" : `定位到所选年份 ${selectedYear}`}
                onClick={() => onFocusEvent?.(selectedEvent, selectedYear)}
                className={`${style.button} ${style.secondaryButton} ${!onFocusEvent ? style.disabledButton : ""}`}
              >
                定位
              </button>
              {onApplyEvent ? (
                <button
                  type="button"
                  disabled={Boolean(selectedEvent.stale ?? event.stale)}
                  title={applyPreview(selectedEvent, selectedYear)}
                  onClick={() => onApplyEvent(selectedEvent, selectedYear)}
                  className={`${style.button} ${style.primaryButton} ${selectedEvent.stale || event.stale ? style.disabledButton : ""}`}
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

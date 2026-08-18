import { useEffect, useState } from "react";
import type {
  DiagnosisEvent,
  DiagnosisEventType,
} from "@/features/crossdating/diagnosis";
import style from "./DiagnosisEventPanel.module.css";

type Props = {
  events: DiagnosisEvent[];
  /** Shared chart/panel selection; also selects the matching constrained interpretation. */
  selectedEventId?: string | null;
  selectedReviewYear?: number | null;
  onFocusEvent?: (event: DiagnosisEvent, selectedYear?: number) => void;
  onApplyEvent?: (event: DiagnosisEvent, selectedYear: number) => boolean | void;
  onDismiss?: () => void;
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
    pairwise_mismatch: "双线错配",
    counterfactual_operation_verification: "反事实编辑",
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

export function DiagnosisEventPanel({
  events,
  selectedEventId = null,
  selectedReviewYear = null,
  onFocusEvent,
  onApplyEvent,
  onDismiss,
}: Props) {
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
      {events.map((event, eventIndex) => {
        const controlledInterpretation = selectedEventId === event.id
          ? "primary"
          : selectedEventId === event.interpretationAmbiguity?.alternative.id
            ? "alternative"
            : null;
        const interpretationSelection = controlledInterpretation
          ?? selectedInterpretations[event.id]
          ?? "primary";
        const selectedEvent = selectDiagnosisEventInterpretation(
          event,
          interpretationSelection,
        );
        const interpretation = event.interpretationAmbiguity;
        const wholeLocalInterpretation = interpretation?.kind === "wholeSeriesMoveOrMissingRing"
          || interpretation?.kind === "wholeSeriesMoveOrLocalEvent"
          ? interpretation
          : null;
        const width = selectedEvent.endYear - selectedEvent.startYear + 1;
        const isWholeSeriesMove = selectedEvent.eventType === "wholeSeriesMove";
        const selectableYears = selectableEventYears(selectedEvent);
        const controlledYear = selectedEvent.id === selectedEventId
          ? selectedReviewYear
          : null;
        const savedYear = controlledYear ?? selectedYears[selectedEvent.id];
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
                  title={wholeLocalInterpretation
                    ? `整体移动 ${Math.abs(wholeLocalInterpretation.evidence.wholeShiftYears)} 年；局部复核操作分差 ${
                      wholeLocalInterpretation.evidence.operationScoreMargin?.toFixed(2) ?? "-"
                    }`
                    : missingPartialEvidence!.interpretationBasis
                      === "completedPartialMissingComposition"
                      ? `复合校正支持 ${
                        missingPartialEvidence!.completedComposition?.mixedReferenceSupport ?? "-"
                      }/${
                        missingPartialEvidence!.completedComposition?.mixedReferenceCount ?? "-"
                      }；事件顺序支持 ${
                        missingPartialEvidence!.completedComposition?.orientationReferenceSupport ?? "-"
                      }/${
                        missingPartialEvidence!.completedComposition?.orientationReferenceCount ?? "-"
                      }`
                    : missingPartialEvidence!.interpretationBasis
                      === "exactSequentialStaircaseAlternative"
                      ? `精确单位阶梯支持 ${
                        missingPartialEvidence!.missingReferenceSupport
                      }/${missingPartialEvidence!.referenceCount}；连续缺段支持 ${
                        missingPartialEvidence!.partialReferenceSupport
                      }/${missingPartialEvidence!.referenceCount}`
                    : missingPartialEvidence!.interpretationBasis
                      === "structuredLocatorCumulativeLagAlternative"
                      ? `结构化定位已确认同一区域；累计位移对应 ${
                        missingPartialEvidence!.missingRingCount
                      } 个缺轮，连续缺段与逐轮缺轮收益接近`
                      : `完整反事实收益差 ${
                        missingPartialEvidence!.normalizedCounterfactualGainDifference.toFixed(2)
                      }；缺轮/连续缺段参考芯支持 ${
                        missingPartialEvidence!.missingReferenceSupport
                      }/${missingPartialEvidence!.partialReferenceSupport}`}
                  className={style.interpretation}
                >
                  <span>
                    {wholeLocalInterpretation
                      ? selectedEvent.eventType === "wholeSeriesMove"
                        ? "若树皮年或采样年已确认，可排除整条序列移动，重新检查局部缺轮、伪轮或连续缺段。"
                        : `当前按${eventTypeLabels[selectedEvent.eventType]}窗口复核；切换只改变解释和预览，可随时恢复整体移动解释。`
                        : selectedEvent.eventType === "missingRing"
                        ? hasCalibratedMissingCount
                          ? `附近可能还有 ${Math.max(0, missingPartialEvidence!.missingRingCount - 1)} 个同方向缺轮事件；当前只复核最靠树皮侧的一处。`
                          : "当前只复核最靠树皮侧的一个缺轮；应用后重新诊断其余累计 lag。"
                        : hasCalibratedMissingCount
                          ? `多参考芯支持该区域累计约 ${missingPartialEvidence!.missingRingCount} 次同方向单位转移；实体样芯决定按连续缺段还是逐轮缺轮复核。`
                          : `累计 lag 差约 ${Math.abs(missingPartialEvidence!.cumulativeShiftYears)} 年；具体缺轮数量尚未独立确认。`}
                  </span>
                  <button
                    type="button"
                    disabled={event.stale === true}
                    title={wholeLocalInterpretation
                      ? selectedEvent.eventType === "wholeSeriesMove"
                        ? "若树皮年或采样年已确认，排除整体移动并复核当前最强局部事件"
                        : "恢复算法保留的整体移动解释"
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
                    {wholeLocalInterpretation
                      ? selectedEvent.eventType === "wholeSeriesMove"
                        ? "排除整体移动，复核局部事件"
                        : "恢复整体移动解释"
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
              {eventIndex === 0 && onDismiss ? (
                <button
                  type="button"
                  aria-label="暂时关闭本次定年建议"
                  title="暂时关闭本次定年建议；下次编辑后自动恢复"
                  onClick={onDismiss}
                  className={style.closeButton}
                >
                  ×
                </button>
              ) : null}
            </div>

          </article>
        );
      })}
    </section>
  );
}

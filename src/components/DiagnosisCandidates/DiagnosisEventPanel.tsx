import { t } from '@/i18n/core';
import { useLocale } from '@/i18n/react';
import { useEffect, useState } from "react";
import {
  diagnosisEventInterpretationChain,
  type DiagnosisEvent,
  type DiagnosisEventType,
} from "@/features/crossdating/diagnosis";
import style from "./DiagnosisEventPanel.module.css";

type Props = {
  events: DiagnosisEvent[];
  /** Shared chart/panel selection; also selects the matching constrained interpretation. */
  selectedEventId?: string | null;
  selectedReviewYear?: number | null;
  onFocusEvent?: (event: DiagnosisEvent, selectedYear?: number) => void;
  onInterpretationChange?: (event: DiagnosisEvent, selectedYear?: number) => void;
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
  if (topYear === undefined) return t("不足");
  const evidenceYears = yearEvidenceFamilies
    .map((prefixes) => noteNumber(event.evidence.notes, prefixes))
    .filter((year): year is number => year !== null);
  if (evidenceYears.length === 0) return t("不足");
  const nearby = evidenceYears.filter((year) => Math.abs(year - topYear) <= 1).length;
  const spread = Math.max(...evidenceYears) - Math.min(...evidenceYears);
  if (nearby >= 3 && spread <= 3) return t("较一致");
  if (nearby >= 2) return t("一般");
  return t("分散");
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
    pairwise_mismatch: t("双线错配"),
    counterfactual_operation_verification: t("反事实编辑"),
  };
  return sources.map((source) => labels[source] ?? source).join(" + ");
};

const applyPreview = (event: DiagnosisEvent, selectedYear: number) => {
  if (event.eventType === "missingRing") {
    return t("在 {0} 年插入缺轮，并将该年及较老侧统一向老年份移动 1 年。", [selectedYear]);
  }
  if (event.eventType === "falseRing") {
    return t("删除 {0} 年，并将较老侧统一向新年份移动 1 年。", [selectedYear]);
  }
  if (event.eventType === "partialMove" && event.shiftYears) {
    const lastMovedYear = selectedYear - 1;
    const movedStartYear = event.seriesRange?.startYear;
    const gapStartYear = selectedYear + event.shiftYears;
    return [
      t("断点 {0}；{1} 年起保持不动。", [selectedYear, selectedYear]),
      t("{0}向老年份移动 {1} 年。", [movedStartYear === undefined ? t("较老侧") : t("{0}-{1} 年", [movedStartYear, lastMovedYear]), Math.abs(event.shiftYears)]),
      t("移动后 {0}-{1} 年为空白。", [gapStartYear, lastMovedYear]),
    ].join(" ");
  }
  return t("按已验证的整体移动候选应用整条序列。");
};

type InterpretationSelection = "primary" | "alternative";
type EventSelectionHandler = (event: DiagnosisEvent, selectedYear?: number) => void;

export const dispatchDiagnosisInterpretationChange = (
  event: DiagnosisEvent,
  selectedYear: number,
  onInterpretationChange?: EventSelectionHandler,
  onFocusEvent?: EventSelectionHandler,
) => {
  (onInterpretationChange ?? onFocusEvent)?.(event, selectedYear);
};

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
  onInterpretationChange,
  onApplyEvent,
  onDismiss,
}: Props) {
    useLocale();
  const [selectedYears, setSelectedYears] = useState<Record<string, number>>({});
  const [selectedInterpretationIds, setSelectedInterpretationIds] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    const currentIds = new Set(events.flatMap((event) => (
      diagnosisEventInterpretationChain(event).map((interpretation) => interpretation.id)
    )));
    setSelectedYears((previous) => Object.fromEntries(
      Object.entries(previous).filter(([eventId]) => currentIds.has(eventId)),
    ));
    const currentPrimaryIds = new Set(events.map((event) => event.id));
    setSelectedInterpretationIds((previous) => Object.fromEntries(
      Object.entries(previous).filter(([eventId]) => currentPrimaryIds.has(eventId)),
    ));
  }, [events]);

  if (events.length === 0) {
    return (
      <div className={style.empty}>
        {t("该序列暂无事件级诊断建议")}</div>
    );
  }

  return (
    <section
      aria-label={t("定年建议")}
      className={style.panel}
    >
      {events.map((event, eventIndex) => {
        const interpretationChain = diagnosisEventInterpretationChain(event);
        const controlledInterpretation = selectedEventId === null
          ? null
          : interpretationChain.find((candidate) => candidate.id === selectedEventId) ?? null;
        const lockedInterpretation = interpretationChain.find((candidate) => (
            candidate.id === selectedInterpretationIds[event.id]
          )) ?? null;
        const selectedEvent = lockedInterpretation
          ?? controlledInterpretation
          ?? event;
        const selectedInterpretationIndex = interpretationChain.findIndex((candidate) => candidate.id === selectedEvent.id);
        const previousInterpretation = selectedInterpretationIndex > 0
          ? interpretationChain[selectedInterpretationIndex - 1] ?? null
          : null;
        const rootInterpretation = event.interpretationAmbiguity;
        const sequentialInterpretation = selectedEvent.interpretationAmbiguity?.kind
          === "sequentialOperationRecovery"
          ? selectedEvent.interpretationAmbiguity
          : null;
        const wholeLocalInterpretation = rootInterpretation?.kind === "wholeSeriesMoveOrMissingRing"
          || rootInterpretation?.kind === "wholeSeriesMoveOrLocalEvent"
          ? rootInterpretation
          : null;
        const missingPartialInterpretation = selectedEvent.eventType === "partialMove"
          && selectedEvent.interpretationAmbiguity?.kind === "missingRingsOrPartialMove"
          ? selectedEvent.interpretationAmbiguity
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
        const activateInterpretation = (nextEvent: DiagnosisEvent) => {
          setSelectedInterpretationIds((previous) => ({
            ...previous,
            [event.id]: nextEvent.id,
          }));
          const nextSelectableYears = selectableEventYears(nextEvent);
          const savedNextYear = selectedYears[nextEvent.id];
          const nextYear = savedNextYear !== undefined
            && nextSelectableYears.some((row) => row.year === savedNextYear)
            ? savedNextYear
            : defaultSelectedYear(nextEvent, nextSelectableYears);
          dispatchDiagnosisInterpretationChange(
            nextEvent,
            nextYear,
            onInterpretationChange,
            onFocusEvent,
          );
        };
        const shiftText = selectedEvent.eventType === "partialMove" && selectedEvent.shiftYears
          ? t(" · 较老侧向老年份移动 {0} 年", [Math.abs(selectedEvent.shiftYears)])
          : "";
        const wholeShiftText = isWholeSeriesMove && selectedEvent.shiftYears
          ? t("整条序列向{0}年份移动 {1} 年", [selectedEvent.shiftYears < 0 ? t("老") : t("新"), Math.abs(selectedEvent.shiftYears)])
          : t("整条序列位移");
        const yearEvidence = yearEvidenceLabel(selectedEvent);
        const missingPartialEvidence = missingPartialInterpretation?.evidence ?? null;
        const hasCalibratedMissingCount = missingPartialEvidence?.countEvidence
          === "multiReferenceStaircase";
        const missingPartialTarget = missingPartialInterpretation?.alternative ?? null;
        const missingPartialRestoreTarget = previousInterpretation?.eventType === "partialMove"
          && previousInterpretation.interpretationAmbiguity?.kind === "missingRingsOrPartialMove"
          && previousInterpretation.interpretationAmbiguity.alternative.id === selectedEvent.id
          ? previousInterpretation
          : null;
        const reviewingWholePrimary = wholeLocalInterpretation !== null
          && selectedEvent.id === event.id;
        const wholeInterpretationTarget = wholeLocalInterpretation && reviewingWholePrimary
          ? wholeLocalInterpretation.alternative
          : null;
        const wholeInterpretationRestoreTarget = previousInterpretation?.eventType === "wholeSeriesMove"
          && wholeLocalInterpretation?.alternative.id === selectedEvent.id
          ? previousInterpretation
          : null;
        const missingPartialTitle = missingPartialEvidence
          ? missingPartialEvidence.interpretationBasis === "frozenConditionalMissingReview"
            ? t("若样芯未见断裂，使用同一冻结证据独立复核缺轮；不会重新选择其他操作。")
            : missingPartialEvidence.interpretationBasis === "completedPartialMissingComposition"
            ? t("复合校正支持 {0}/{1}；事件顺序支持 {2}/{3}", [missingPartialEvidence.completedComposition?.mixedReferenceSupport ?? "-", missingPartialEvidence.completedComposition?.mixedReferenceCount ?? "-", missingPartialEvidence.completedComposition?.orientationReferenceSupport ?? "-", missingPartialEvidence.completedComposition?.orientationReferenceCount ?? "-"])
            : missingPartialEvidence.interpretationBasis === "exactSequentialStaircaseAlternative"
              ? t("精确单位阶梯支持 {0}/{1}；连续缺段支持 {2}/{3}", [missingPartialEvidence.missingReferenceSupport, missingPartialEvidence.referenceCount, missingPartialEvidence.partialReferenceSupport, missingPartialEvidence.referenceCount])
              : missingPartialEvidence.interpretationBasis
                === "structuredLocatorCumulativeLagAlternative"
                ? t("结构化定位已确认同一区域；累计位移对应 {0} 个缺轮，连续缺段与逐轮缺轮收益接近", [missingPartialEvidence.missingRingCount])
                : t("完整反事实收益差 {0}；缺轮/连续缺段参考芯支持 {1}/{2}", [missingPartialEvidence.normalizedCounterfactualGainDifference.toFixed(2), missingPartialEvidence.missingReferenceSupport, missingPartialEvidence.partialReferenceSupport])
          : null;
        const wholeInterpretationTitle = wholeLocalInterpretation
          ? t("整体移动 {0} 年；局部复核操作分差 {1}", [Math.abs(wholeLocalInterpretation.evidence.wholeShiftYears), wholeLocalInterpretation.evidence.operationScoreMargin?.toFixed(2) ?? "-"])
          : null;
        const interpretationTitle = (
          sequentialInterpretation
            ? t("统一模型交互恢复第 {0} 步", [sequentialInterpretation.evidence.attempt])
            : reviewingWholePrimary
            ? wholeInterpretationTitle
            : missingPartialTitle ?? wholeInterpretationTitle
        ) ?? undefined;
        const interpretationDescription = sequentialInterpretation
          ? sequentialInterpretation.evidence.reason === "bark-check"
            ? t("若实体样芯确认存在树皮，可排除整体移动并继续复核局部移动。")
            : t("若实体样芯未见断裂或连续缺段，可排除局部移动并继续复核单位事件。")
          : reviewingWholePrimary
          ? t("若实体样芯确认存在树皮，可排除整体移动，并在同一冻结证据中选择分数最高的唯一局部操作。")
            : missingPartialEvidence
            ? selectedEvent.eventType === "missingRing"
              ? hasCalibratedMissingCount
                ? t("附近可能还有 {0} 个同方向缺轮事件；当前只复核最靠树皮侧的一处。", [Math.max(
                  0,
                  missingPartialEvidence.missingRingCount - 1,
                )])
                : t("当前只复核最靠树皮侧的一个缺轮；应用后重新诊断其余累计 lag。")
              : hasCalibratedMissingCount
                ? t("多参考芯支持该区域累计约 {0} 次同方向单位转移；实体样芯决定按连续缺段还是逐轮缺轮复核。", [missingPartialEvidence.missingRingCount])
                : t("累计 lag 差约 {0} 年；具体缺轮数量尚未独立确认。", [Math.abs(
                  missingPartialEvidence.cumulativeShiftYears,
                )])
            : missingPartialRestoreTarget
              ? t("当前按缺轮窗口复核；可恢复同一冻结证据中的局部移动解释。")
            : wholeLocalInterpretation
              ? t("当前按{0}窗口复核；可恢复上一步解释，应用或编辑后将重建状态。", [eventTypeLabels[selectedEvent.eventType]])
              : null;

        return (
          <article
            key={event.id}
            className={style.suggestion}
          >
            <div className={style.body}>
              <div className={style.heading}>
                <strong className={style.eventType}>
                  {t(eventTypeLabels[selectedEvent.eventType])}
                </strong>
                <span className={style.range}>
                  {isWholeSeriesMove
                    ? wholeShiftText
                    : t("{0}–{1} · {2} 年", [selectedEvent.startYear, selectedEvent.endYear, width])}
                </span>
                <span className={style.metadata}>
                  <span
                    title={t("表示事件级证据强度，不代表首选年份正确概率")}
                  >
                    {t("置信度 ")}{t(confidenceLabels[selectedEvent.confidenceLevel])}
                  </span>
                  {!isWholeSeriesMove ? (
                    <span title={t("表示不同定位证据是否聚集，不是该年份的正确概率")}>
                      {t("年份证据 ")}{yearEvidence}
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
                    {selectedEvent.eventType === "partialMove" ? t("断点年份") : t("复核年份")}
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
                            ? t("选择断点 {0}；{1} 年起保持不动", [row.year, row.year])
                            : t("选择年份 {0} 作为应用边界", [row.year])}
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
                  {t("断点 ")}{selectedYear} · {selectedYear} {t(" 年起保持不动 · 移动后")}{" "}
                  {selectedYear + selectedEvent.shiftYears}-{selectedYear - 1} {t(" 年为空白")}</div>
              ) : null}
              {interpretationDescription ? (
                <div
                  title={interpretationTitle}
                  className={style.interpretation}
                >
                  <span>{interpretationDescription}</span>
                  {sequentialInterpretation ? (
                    <button
                      type="button"
                      disabled={event.stale === true}
                      title={sequentialInterpretation.evidence.reason === "bark-check"
                        ? t("实体样芯存在树皮时排除整体移动")
                        : t("实体样芯未见断裂或连续缺段时排除局部移动")}
                      onClick={() => activateInterpretation(sequentialInterpretation.alternative)}
                      className={`${style.interpretationButton} ${event.stale ? style.disabledButton : ""}`}
                    >
                      {sequentialInterpretation.evidence.reason === "bark-check"
                        ? t("确认有树皮，继续局部复核")
                        : t("未见断裂，继续单位事件复核")}
                    </button>
                  ) : null}
                  {missingPartialTarget ? (
                    <button
                      type="button"
                      disabled={event.stale === true}
                      title={t("实体样芯未见断裂时，在同一证据状态上切换到前沿缺轮复核")}
                      onClick={() => activateInterpretation(missingPartialTarget)}
                      className={`${style.interpretationButton} ${event.stale ? style.disabledButton : ""}`}
                    >
                      {t("以缺轮形式复核")}</button>
                  ) : null}
                  {missingPartialRestoreTarget ? (
                    <button
                      type="button"
                      disabled={event.stale === true}
                      title={t("恢复同一冻结证据中的局部移动解释")}
                      onClick={() => activateInterpretation(missingPartialRestoreTarget)}
                      className={`${style.interpretationButton} ${event.stale ? style.disabledButton : ""}`}
                    >
                      {t("恢复局部移动解释")}</button>
                  ) : null}
                  {wholeInterpretationTarget ? (
                    <button
                      type="button"
                      disabled={event.stale === true}
                      title={t("实体样芯存在树皮时，排除整体移动并使用同状态统一局部选择器复核")}
                      onClick={() => activateInterpretation(wholeInterpretationTarget)}
                      className={`${style.interpretationButton} ${event.stale ? style.disabledButton : ""}`}
                    >
                      {t("以局部事件复核")}</button>
                  ) : null}
                  {wholeInterpretationRestoreTarget ? (
                    <button
                      type="button"
                      disabled={event.stale === true}
                      title={t("恢复同一冻结证据中的整体移动解释")}
                      onClick={() => activateInterpretation(wholeInterpretationRestoreTarget)}
                      className={`${style.interpretationButton} ${event.stale ? style.disabledButton : ""}`}
                    >
                      {t("恢复整体移动解释")}</button>
                  ) : null}
                </div>
              ) : null}
              <div className={style.correlationRow}>
                <span>
                  {t("相关性 r ")}{formatCorrelation(selectedEvent.evidence.baselineCorrelation)} → {formatCorrelation(selectedEvent.evidence.correctedCorrelation)}
                </span>
                <details className={style.evidenceDetails}>
                  <summary>{t("诊断依据")}</summary>
                  <div className={style.evidenceText}>
                    {formatAlgorithmSource(selectedEvent.evidence.algorithmSources) || t("暂无来源信息")}
                  </div>
                </details>
              </div>
            </div>

            <div className={style.actions}>
              <button
                type="button"
                disabled={!onFocusEvent}
                title={isWholeSeriesMove ? t("定位整条序列") : t("定位到所选年份 {0}", [selectedYear])}
                onClick={() => onFocusEvent?.(selectedEvent, selectedYear)}
                className={`${style.button} ${style.secondaryButton} ${!onFocusEvent ? style.disabledButton : ""}`}
              >
                {t("定位")}</button>
              {onApplyEvent ? (
                <button
                  type="button"
                  disabled={Boolean(selectedEvent.stale ?? event.stale)}
                  title={applyPreview(selectedEvent, selectedYear)}
                  onClick={() => onApplyEvent(selectedEvent, selectedYear)}
                  className={`${style.button} ${style.primaryButton} ${selectedEvent.stale || event.stale ? style.disabledButton : ""}`}
                >
                  {t("应用")}</button>
              ) : null}
              {eventIndex === 0 && onDismiss ? (
                <button
                  type="button"
                  aria-label={t("暂时关闭本次定年建议")}
                  title={t("暂时关闭本次定年建议；下次编辑后自动恢复")}
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

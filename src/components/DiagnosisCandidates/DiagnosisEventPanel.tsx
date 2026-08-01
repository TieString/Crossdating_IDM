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

const yearButtonStyle: CSSProperties = {
  appearance: "none",
  padding: "1px 4px",
  borderRadius: 3,
  border: "1px solid #d4e4d2",
  background: "#fff",
  color: "#315d36",
  cursor: "pointer",
  font: "inherit",
  lineHeight: 1.4,
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

export function DiagnosisEventPanel({ events, onFocusEvent, onApplyEvent }: Props) {
  const [selectedYears, setSelectedYears] = useState<Record<string, number>>({});
  const [confirmingEventId, setConfirmingEventId] = useState<string | null>(null);

  useEffect(() => {
    const currentIds = new Set(events.map((event) => event.id));
    setSelectedYears((previous) => Object.fromEntries(
      Object.entries(previous).filter(([eventId]) => currentIds.has(eventId)),
    ));
    setConfirmingEventId((previous) => previous && currentIds.has(previous) ? previous : null);
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
        const selectedEvent = event;
        const width = selectedEvent.endYear - selectedEvent.startYear + 1;
        const preferredYear = selectedEvent.rankedYears[0]?.year;
        const savedYear = selectedYears[event.id];
        const selectedYear = selectedEvent.eventType === "partialMove"
          ? preferredYear
            ?? Math.round((selectedEvent.startYear + selectedEvent.endYear) / 2)
          : savedYear !== undefined
          && selectedEvent.rankedYears.some((row) => row.year === savedYear)
          ? savedYear
          : preferredYear
            ?? Math.round((selectedEvent.startYear + selectedEvent.endYear) / 2);
        const rankedYears = [...selectedEvent.rankedYears].sort((a, b) => a.rank - b.rank);
        const shiftText = selectedEvent.eventType === "partialMove" && selectedEvent.shiftYears
          ? ` · 较老侧向老年份移动 ${Math.abs(selectedEvent.shiftYears)} 年`
          : "";
        const yearEvidence = yearEvidenceLabel(selectedEvent);

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
                <strong style={{ color: "#234d28" }}>{eventTypeLabels[selectedEvent.eventType]}</strong>
                <span>
                  {selectedEvent.startYear}-{selectedEvent.endYear}（{width} 年）
                </span>
                <span
                  title="表示事件级证据强度，不代表首选年份正确概率"
                  style={{ fontSize: 10, fontWeight: 700 }}
                >
                  事件置信 {confidenceLabels[selectedEvent.confidenceLevel]}
                </span>
                <span
                  title="表示不同定位证据是否聚集，不是该年份的正确概率"
                  style={{ fontSize: 10, fontWeight: 700 }}
                >
                  年份证据 {yearEvidence}
                </span>
              </div>

              {selectedEvent.eventType === "partialMove" && preferredYear !== undefined ? (
                <div
                  title={`${preferredYear} 年起保持不动`}
                  style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}
                >
                  <span>首选断点</span>
                  <strong>{preferredYear}</strong>
                </div>
              ) : rankedYears.length > 0 ? (
                <div
                  title={rankedYears.map((row) => `#${row.rank} ${row.year}`).join(" · ")}
                  style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, marginTop: 4 }}
                >
                  <span>{selectedEvent.eventType === "partialMove" ? "优先断点" : "优先年份"}</span>
                  {rankedYears.map((row) => {
                    const selected = row.year === selectedYear;
                    return (
                      <button
                        type="button"
                        key={row.year}
                        aria-pressed={selected}
                        title={selectedEvent.eventType === "partialMove"
                          ? `选择断点 ${row.year}；${row.year} 年起保持不动`
                          : `选择 ${row.year} 年作为应用边界`}
                        onClick={() => {
                          setSelectedYears((previous) => ({
                            ...previous,
                            [event.id]: row.year,
                          }));
                          setConfirmingEventId(null);
                        }}
                        style={{
                          ...yearButtonStyle,
                          borderColor: selected ? "#397342" : "#d4e4d2",
                          background: selected ? "#dcefdc" : "#fff",
                          fontWeight: row.rank === 1 || selected ? 700 : 500,
                        }}
                      >
                        #{row.rank} {row.year}
                      </button>
                    );
                  })}
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
              <div style={{ marginTop: 2, color: "#56745a" }}>
                r {formatCorrelation(selectedEvent.evidence.baselineCorrelation)} → {formatCorrelation(selectedEvent.evidence.correctedCorrelation)}
                {" · "}来源 {formatAlgorithmSource(selectedEvent.evidence.algorithmSources) || "-"}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <button
                type="button"
                disabled={!onFocusEvent}
                title={`定位到已选年份 ${selectedYear}`}
                onClick={() => onFocusEvent?.(selectedEvent, selectedYear)}
                style={onFocusEvent ? buttonStyle : disabledButtonStyle}
              >
                定位
              </button>
              {onApplyEvent ? (
                <button
                type="button"
                disabled={selectedEvent.stale ?? event.stale}
                title="查看并确认所选年份的编辑操作"
                onClick={() => setConfirmingEventId(event.id)}
                style={(selectedEvent.stale ?? event.stale) ? disabledButtonStyle : applyButtonStyle}
                >
                  应用
                </button>
              ) : null}
            </div>

            {confirmingEventId === event.id ? (
              <div
                role="alert"
                style={{
                  gridColumn: "1 / -1",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  paddingTop: 6,
                  borderTop: "1px solid #dbe8da",
                }}
              >
                <span>{applyPreview(selectedEvent, selectedYear)}</span>
                <div style={{ display: "flex", flexShrink: 0, gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => setConfirmingEventId(null)}
                    style={buttonStyle}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const applied = onApplyEvent?.(selectedEvent, selectedYear);
                      if (applied !== false) setConfirmingEventId(null);
                    }}
                    style={applyButtonStyle}
                  >
                    确认应用
                  </button>
                </div>
              </div>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}

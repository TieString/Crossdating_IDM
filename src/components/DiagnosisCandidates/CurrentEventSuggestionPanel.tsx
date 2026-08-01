import { useEffect, useMemo, useState } from "react";
import type {
  CurrentEventModelDescriptor,
  CurrentEventSuggestion,
  CurrentEventTransportError,
} from "@/services/currentEventRanker/types";
import type { CurrentEventRankerSession } from "@/pages/home/useCurrentEventRanker";
import style from "./CurrentEventSuggestionPanel.module.css";

type Props = {
  session: CurrentEventRankerSession;
  models: CurrentEventModelDescriptor[];
  activeModelId: string;
  modelCatalogError: CurrentEventTransportError | null;
  targetSeriesId: string;
  isFileModified: boolean;
  onAnalyze: () => void;
  onConfirmYear: (year: number) => void;
  onUndoConfirmation: () => void;
  onApplyConfirmedYears: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onFocusSuggestion: (suggestion: CurrentEventSuggestion) => void;
  onSelectModel: (modelId: string) => void;
};

const statusLabels: Record<CurrentEventRankerSession["status"], string> = {
  idle: "待分析",
  running: "分析中",
  advice: "可供复核",
  range_advice: "仅范围可复核",
  insufficient: "证据不足",
  stale: "结果已过期",
  cancelled: "已取消",
  error: "运行异常",
};

const statusClasses: Record<CurrentEventRankerSession["status"], string> = {
  idle: style.statusIdle,
  running: style.statusRunning,
  advice: style.statusAdvice,
  range_advice: style.statusRangeAdvice,
  insufficient: style.statusInsufficient,
  stale: style.statusStale,
  cancelled: style.statusCancelled,
  error: style.statusError,
};

const formatMetric = (value: number | null | undefined, digits = 3) => (
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—"
);

const rangeYears = (suggestion: CurrentEventSuggestion) => {
  const years: number[] = [];
  for (let year = suggestion.rangeStart; year <= suggestion.rangeEnd; year += 1) {
    years.push(year);
  }
  return years;
};

export function CurrentEventSuggestionPanel({
  session,
  models,
  activeModelId,
  modelCatalogError,
  targetSeriesId,
  isFileModified,
  onAnalyze,
  onConfirmYear,
  onUndoConfirmation,
  onApplyConfirmedYears,
  onCancel,
  onRetry,
  onFocusSuggestion,
  onSelectModel,
}: Props) {
  const suggestions = session.result?.suggestions ?? [];
  const eventRange = session.result?.eventRange ?? null;
  const activeModel = models.find((model) => model.id === activeModelId);
  const isRrfRoute = activeModel?.routeVersion === "missing-current-event-rrf0-range3-v1";
  const [selectedYears, setSelectedYears] = useState<Record<number, number>>({});

  useEffect(() => {
    setSelectedYears(Object.fromEntries(
      suggestions.map((suggestion) => [suggestion.rank, suggestion.centerYear]),
    ));
  }, [session.requestId, session.result]);

  const roundLabel = session.result?.state?.roundIndex
    ?? session.confirmedYears.length + 1;
  const confirmedSet = useMemo(
    () => new Set(session.confirmedYears),
    [session.confirmedYears],
  );
  const canUseDiskState = !isFileModified;
  const canApplyConfirmed = session.confirmedYears.length > 0
    && session.status !== "running"
    && session.status !== "stale";
  const rangeReliability = session.result?.rangeReliability;
  const yearReliability = session.result?.yearReliability ?? session.result?.reliability;
  const maxConfirmations = activeModel?.maxConfirmations ?? 6;
  const eventRangeCard = eventRange ? (
    <div className={style.eventRangeCard} aria-label="唯一最新未修复事件范围">
      <div className={style.eventRangeHeader}>
        <span>
          {eventRange.adaptive
            ? eventRange.shrunk
              ? "优先检查唯一事件范围 · 证据集中，已自动缩窄"
              : "优先检查唯一事件范围 · 使用最大证据包络"
            : "优先检查唯一事件范围"}
        </span>
        <strong>{eventRange.startYear}–{eventRange.endYear}</strong>
      </div>
      <div className={style.eventRangeMetrics}>
        <span>中心 {eventRange.centerYear}</span>
        <span>宽度 {eventRange.width} 年</span>
        <span>范围排序分 {formatMetric(eventRange.localizerScore, 4)}</span>
        <span>基础中心 rank #{eventRange.baseCenterRank}</span>
        {rangeReliability ? (
          <span>
            范围门 {formatMetric(rangeReliability.score)} / {formatMetric(rangeReliability.threshold)}
          </span>
        ) : null}
        {eventRange.maxEnvelopeStart !== undefined
          && eventRange.maxEnvelopeEnd !== undefined ? (
            <span>
              最大包络 {eventRange.maxEnvelopeStart}–{eventRange.maxEnvelopeEnd}
            </span>
          ) : null}
      </div>
      <div className={style.eventRangeHint}>
        {session.status === "range_advice"
          ? "范围门已通过；精确年份门未通过。本轮不会显示或允许确认年份 Top5。"
          : "15 年是最大宽度而非固定宽度。下方仍是精确年份 Top5，不是五个事件范围；范围外年份可能因原始年份证据较强而保留。"}
      </div>
    </div>
  ) : null;

  return (
    <section className={style.panel} aria-label="Current-event 诊断模型建议">
      <div className={style.header}>
        <div className={style.headerMain}>
          <span className={style.modelBadge}>Current-event V1</span>
          <strong className={style.title}>{targetSeriesId}</strong>
        </div>
        <span
          className={`${style.statusBadge} ${statusClasses[session.status]}`}
          role="status"
          aria-live="polite"
        >
          {statusLabels[session.status]}
        </span>
      </div>

      <div className={style.modelSelectorBox}>
        <label className={style.modelSelectorLabel} htmlFor="current-event-model-select">
          诊断模型
        </label>
        <select
          id="current-event-model-select"
          className={style.modelSelect}
          value={activeModelId}
          disabled={models.length === 0}
          onChange={(event) => onSelectModel(event.target.value)}
        >
          {models.length === 0 ? (
            <option value={activeModelId}>正在读取模型目录…</option>
          ) : models.map((model) => (
            <option key={model.id} value={model.id}>{model.displayName}</option>
          ))}
        </select>
        <div className={style.modelDescription}>
          {activeModel?.description ?? "模型目录加载后可在这里切换；切换不会修改 RWL。"}
          {activeModel ? (
            <span>
              版本 {activeModel.bundleVersion} · 年份特征 {activeModel.yearFeatureCount}
              {activeModel.rangeFeatureCount ? ` · 范围特征 ${activeModel.rangeFeatureCount}` : ""}
              {activeModel.rangeReliabilityFeatureCount
                ? ` · 范围门特征 ${activeModel.rangeReliabilityFeatureCount}`
                : ""}
              {activeModel.adaptiveEventRange ? " · 证据自适应范围" : ""}
              {activeModel.deploymentVersion ? ` · 部署 ${activeModel.deploymentVersion}` : ""}
              {activeModel.routeVersion ? ` · 路线 ${activeModel.routeVersion}` : ""}
              {` · ${activeModel.existingZeroPolicy}/${activeModel.topK}/${activeModel.rangeRadius}`}
              {activeModel.manualOnly ? " · 仅专家主动调用" : " · 保存后旁路调用"}
              {activeModel.diagnosticOnly && !activeModel.automaticWriteback
                ? " · 仅诊断/不自动写回"
                : ""}
            </span>
          ) : null}
        </div>
        {modelCatalogError ? (
          <div className={style.modelCatalogError} role="alert">
            模型目录读取失败：{modelCatalogError.message}
          </div>
        ) : null}
      </div>

      {session.confirmedYears.length > 0 ? (
        <div className={style.confirmationBox}>
          <div className={style.confirmationHeader}>
            <strong>本次会话已确认 {session.confirmedYears.length}/{maxConfirmations}</strong>
            <button
              type="button"
              className={style.secondaryButton}
              disabled={session.status === "running"}
              onClick={onUndoConfirmation}
            >
              撤回上一轮
            </button>
          </div>
          <div className={style.confirmedYears}>
            {session.confirmedYears.map((year) => (
              <span className={style.confirmedYear} key={year}>{year}</span>
            ))}
          </div>
          <div className={style.actions}>
            <button
              type="button"
              className={style.primaryButton}
              disabled={!canApplyConfirmed}
              onClick={onApplyConfirmedYears}
            >
              {isRrfRoute ? "按确认结果重建当前序列" : "应用到当前 RWL 工作区"}
            </button>
          </div>
          {isRrfRoute ? (
            <div className={style.rebuildWarning}>
              应用时会先按模型契约移除该序列全部既有 0 标记，再按新到旧顺序重建本会话确认年份；操作仍只进入工作区，不会自动保存。
            </div>
          ) : null}
        </div>
      ) : null}

      {session.status === "idle" ? (
        <div className={style.notice}>
          <strong>
            {activeModel?.manualOnly
              ? "专家主动分析选中的单条序列"
              : "保存后自动分析选中的单条序列"}
          </strong>
          {activeModel?.manualOnly
            ? "该路线不会因保存自动启动，也没有验证任意 RWL 的自动筛查或最终一轮自动停止。请先保存当前数据，再由专家主动开始。"
            : "模型读取磁盘上的 RWL；也可以在文件未修改时手动开始。分析在后台运行，不阻塞保存。"}
          <div className={style.actions}>
            <button
              type="button"
              className={style.primaryButton}
              disabled={!canUseDiskState}
              onClick={onAnalyze}
            >
              分析当前序列
            </button>
          </div>
        </div>
      ) : null}

      {session.status === "running" ? (
        <div className={style.runningBox}>
          <div className={style.statusRow}>
            <span className={style.spinner} aria-hidden="true" />
            <strong>正在计算模型建议</strong>
          </div>
          <div>模型在旁路进程中运行；可以继续查看数据，迟到的旧请求会自动丢弃。</div>
          <div className={style.actions}>
            <button type="button" className={style.secondaryButton} onClick={onCancel}>
              取消显示
            </button>
          </div>
        </div>
      ) : null}

      {session.status === "stale" || session.status === "cancelled" ? (
        <div className={style.staleBox}>
          <strong>{session.staleReason ?? "当前结果已不再对应工作区数据。"}</strong>
          <div>
            {canUseDiskState
              ? "可重新分析磁盘上的当前文件。"
              : "工作区存在未保存修改，请先保存后再分析。"}
          </div>
          <div className={style.actions}>
            <button
              type="button"
              className={style.primaryButton}
              disabled={!canUseDiskState}
              onClick={onAnalyze}
            >
              重新分析
            </button>
          </div>
        </div>
      ) : null}

      {session.status === "error" ? (
        <div className={style.errorBox} role="alert">
          <strong>{session.error?.code ?? "UNKNOWN_ERROR"}</strong>
          <div>{session.error?.message ?? "Current-event 旁路调用失败"}</div>
          <div className={style.actions}>
            <button
              type="button"
              className={style.primaryButton}
              disabled={!canUseDiskState || session.error?.retryable === false}
              onClick={session.context ? onRetry : onAnalyze}
            >
              重试
            </button>
          </div>
        </div>
      ) : null}

      {session.status === "insufficient" ? (
        <div className={style.insufficientBox}>
          <strong>本轮不输出可采纳年份</strong>
          <div>{session.result?.message}</div>
          <div>
            原因：{session.result?.reasonCode ?? "EVIDENCE_INSUFFICIENT"}。这属于模型正常拒答，不是进程故障。
          </div>
          {isRrfRoute ? (
            <div>拒答只表示当前 Top5 证据不足，不表示所有缺轮已经修复，也不会自动补入旧结果。</div>
          ) : null}
          <div className={style.actions}>
            <button type="button" className={style.secondaryButton} onClick={onRetry}>
              再次分析
            </button>
          </div>
        </div>
      ) : null}

      {session.status === "advice" || session.status === "range_advice"
        ? eventRangeCard
        : null}

      {session.status === "range_advice" ? (
        <div className={style.rangeAdviceBox}>
          <strong>范围可供重点检查，但精确年份证据不足</strong>
          <div>{session.result?.message}</div>
          {yearReliability ? (
            <div>
              精确年份门 {formatMetric(yearReliability.score)}
              {" / "}
              阈值 {formatMetric(yearReliability.threshold)}，因此不展示 Top5。
            </div>
          ) : null}
          <div>
            原因：{session.result?.reasonCode ?? "YEAR_RELIABILITY_BELOW_THRESHOLD"}。范围排序分和门控分均不是概率。
          </div>
          <div className={style.actions}>
            <button type="button" className={style.secondaryButton} onClick={onRetry}>
              再次分析
            </button>
          </div>
        </div>
      ) : null}

      {session.status === "advice" ? (
        <>
          <div className={style.notice}>
            <strong>
              Top {suggestions.length} · 第 {session.result?.state?.roundIndex ?? roundLabel} 轮
            </strong>
            {session.result?.message}
            {yearReliability ? (
              <div>
                {isRrfRoute ? "本轮可靠性估计" : "精确年份门"} {yearReliability.score.toFixed(3)}
                {" / "}
                阈值 {yearReliability.threshold.toFixed(3)}
              </div>
            ) : null}
          </div>

          <div className={style.candidateList}>
            {/* 服务端数组和 rank 是最终次序；范围软提升后不得按 rankingScore 重排。 */}
            {suggestions.map((suggestion) => {
              const selectedYear = eventRange
                ? suggestion.centerYear
                : selectedYears[suggestion.rank] ?? suggestion.centerYear;
              const evidence = suggestion.evidence;
              const alreadyConfirmed = confirmedSet.has(selectedYear);
              return (
                <article
                  key={`${session.requestId}-${suggestion.rank}-${suggestion.centerYear}`}
                  className={style.candidate}
                  onMouseEnter={() => onFocusSuggestion(suggestion)}
                  onFocus={() => onFocusSuggestion(suggestion)}
                >
                  <span className={style.rankBadge}>#{suggestion.rank}</span>
                  <div className={style.candidateBody}>
                    <div className={style.candidateHeader}>
                      <strong className={style.centerYear}>{suggestion.centerYear}</strong>
                      {!eventRange ? (
                        <span className={style.range}>
                          建议范围 {suggestion.rangeStart}–{suggestion.rangeEnd}
                        </span>
                      ) : suggestion.rangePromoted ? (
                        <span className={style.rangePromoted}>范围证据提升</span>
                      ) : (
                        <span className={style.baseRank}>基础 rank #{suggestion.baseRank ?? "—"}</span>
                      )}
                      <span className={style.score}>
                        {isRrfRoute ? "RRF 融合分" : "排序分"} {formatMetric(suggestion.rankingScore, 4)}
                      </span>
                    </div>
                    <div className={style.metricRow}>
                      {isRrfRoute ? (
                        <>
                          <span>latest-path rank #{evidence?.pathRank ?? "—"}</span>
                          <span>无归一化 rank #{evidence?.noneRank ?? "—"}</span>
                          <span>latest-path base {evidence?.inferredLatestPathBase ?? "—"}</span>
                        </>
                      ) : (
                        <>
                          <span>整段 Δr {formatMetric(evidence?.wholeSeriesCorrelationDelta)}</span>
                          <span>局部 Δr21 {formatMetric(evidence?.localCorrelationDelta21)}</span>
                          <span>GLK Δ21 {formatMetric(evidence?.localGlkDelta21)}</span>
                          <span>master 窄轮 {formatMetric(evidence?.masterNarrownessScore)}</span>
                        </>
                      )}
                    </div>
                    {!eventRange ? (
                      <div
                        className={style.yearChoices}
                        role="group"
                        aria-label={`候选 ${suggestion.rank} 的精确年份`}
                      >
                        <span className={style.yearLabel}>精确年份</span>
                        {rangeYears(suggestion).map((year) => (
                          <button
                            type="button"
                            key={year}
                            className={`${style.yearButton} ${selectedYear === year ? style.yearButtonActive : ""}`}
                            aria-pressed={selectedYear === year}
                            onClick={() => {
                              setSelectedYears((previous) => ({ ...previous, [suggestion.rank]: year }));
                              onFocusSuggestion({ ...suggestion, centerYear: year });
                            }}
                          >
                            {year}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className={style.exactYearHint}>
                        精确年份建议 · 基础年份 rank #{suggestion.baseRank ?? "—"}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className={`${style.primaryButton} ${style.candidateAction}`}
                    disabled={alreadyConfirmed || session.confirmedYears.length >= maxConfirmations}
                    onClick={() => onConfirmYear(selectedYear)}
                  >
                    {alreadyConfirmed ? "已确认" : `确认 ${selectedYear}，下一轮`}
                  </button>
                </article>
              );
            })}
          </div>
        </>
      ) : null}

      <div className={style.footer}>
        <strong>诊断模型，不会自动修改 RWL。</strong>
        {" "}{isRrfRoute
          ? "RRF 融合分不是概率，reliability.score 也只是本轮 Top5 的冻结可靠性估计；该路线仅支持缺轮插入，不负责整体移动、局部移动、伪轮、自动筛查或自动完成。"
          : "排序分只用于本轮候选的相对次序，不是概率；完整数据重训没有新的无偏测试指标。"}
      </div>
    </section>
  );
}

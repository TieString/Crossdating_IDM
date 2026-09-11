import { t, localizeMessage } from '@/i18n/core';
import { useLocale } from '@/i18n/react';
import { DiagnosisEventPanel } from "@/components/DiagnosisCandidates/DiagnosisEventPanel";
import type { DiagnosisEvent } from "@/features/crossdating/diagnosis";
import type { PairwiseMismatchAnalysis } from "@/features/crossdating/pairwiseMismatch";
import style from "./PairwiseMismatchNotice.module.css";

type Props = {
  analysis: PairwiseMismatchAnalysis;
  onFocusEvent?: (event: DiagnosisEvent, selectedYear?: number) => void;
  onApplyEvent?: (event: DiagnosisEvent, selectedYear: number) => boolean | void;
  onDismiss: () => void;
};

const formatCorrelation = (value: number | null) => value === null ? "-" : value.toFixed(2);

export function PairwiseMismatchNotice({
  analysis,
  onFocusEvent,
  onApplyEvent,
  onDismiss,
}: Props) {
    useLocale();
  return (
    <div className={style.notice} aria-label={t("双线错配分析")}>
      <div className={style.header}>
        <strong className={style.title}>{t("双线分析")}</strong>
        <span className={style.pair}>
          {analysis.targetTree} {t(" 对 ")}{analysis.comparatorKind === "reference" ? localizeMessage(analysis.comparatorLabel) : analysis.comparatorLabel}
        </span>
        <span className={style.meta}>
          {analysis.comparatorKind === "reference"
            ? t("参考深度 n≈{0}", [analysis.comparatorDepth])
            : t("单样芯相对证据")}
        </span>
        {analysis.event ? <span className={style.meta}>{localizeMessage(analysis.summary)}</span> : null}
        <button
          type="button"
          className={style.close}
          aria-label={t("关闭双线分析结果")}
          title={t("关闭双线分析结果")}
          onClick={onDismiss}
        >
          ×
        </button>
      </div>

      {analysis.event ? (
        <DiagnosisEventPanel
          events={[analysis.event]}
          onFocusEvent={onFocusEvent}
          onApplyEvent={onApplyEvent}
        />
      ) : (
        <div className={style.status}>
          <div>
            <div className={style.summary}>{localizeMessage(analysis.summary)}</div>
            <div className={style.detail}>{localizeMessage(analysis.detail)}</div>
          </div>
          <div className={style.metrics}>
            r {formatCorrelation(analysis.currentCorrelation)}
            {analysis.bestCorrelation === null
              ? ""
              : ` → ${formatCorrelation(analysis.bestCorrelation)}`}
            {analysis.globalLag === 0 ? "" : ` · lag ${analysis.globalLag}`}
          </div>
        </div>
      )}
    </div>
  );
}

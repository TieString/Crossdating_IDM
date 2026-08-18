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
  return (
    <div className={style.notice} aria-label="双线错配分析">
      <div className={style.header}>
        <strong className={style.title}>双线分析</strong>
        <span className={style.pair}>
          {analysis.targetTree} 对 {analysis.comparatorLabel}
        </span>
        <span className={style.meta}>
          {analysis.comparatorKind === "reference"
            ? `参考深度 n≈${analysis.comparatorDepth}`
            : "单样芯相对证据"}
        </span>
        {analysis.event ? <span className={style.meta}>{analysis.summary}</span> : null}
        <button
          type="button"
          className={style.close}
          aria-label="关闭双线分析结果"
          title="关闭双线分析结果"
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
            <div className={style.summary}>{analysis.summary}</div>
            <div className={style.detail}>{analysis.detail}</div>
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

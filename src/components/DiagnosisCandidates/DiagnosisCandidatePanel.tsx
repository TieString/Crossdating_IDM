import React, { useCallback, useMemo, useState } from 'react'
import {
  getDiagnosisCandidateLabel,
  isActionableDiagnosisCandidate,
  type DiagnosisBatchApplyResult,
  type DiagnosisCandidateOperation,
} from '@/features/crossdating/diagnosis'

// 单条序列的候选建议面板。
// 从折线图模块抽离出来，现在挂在 potential-problems 模块里，只展示传入的（已按序列过滤的）候选。
// 组件自身只负责展示与“在当前视图忽略”，不直接改写数据——应用候选由 onApplyDiagnosisCandidate 上抛。

type Props = {
  candidates: DiagnosisCandidateOperation[]
  diagnosisBatchResult?: DiagnosisBatchApplyResult | null
  onApplyDiagnosisCandidate?: (candidate: DiagnosisCandidateOperation) => void
}

const btnBase: React.CSSProperties = {
  fontSize: 12, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
  border: '1px solid #d0d0d0', background: '#fff', color: '#444',
  fontWeight: 500, lineHeight: 1.4, boxShadow: 'none',
}
const btnDisabled: React.CSSProperties = {
  ...btnBase, background: '#f4f4f4', color: '#c0c0c0', cursor: 'default', border: '1px solid #e4e4e4',
}

const formatCorrelation = (value: number | null) => (
  value === null ? '-' : value.toFixed(2)
)

const formatProbabilityLike = (value: number | undefined) => (
  typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '-'
)

const formatAlgorithmSource = (sources: DiagnosisCandidateOperation['algorithmSource']) => {
  const labels: Record<string, string> = {
    global_sliding_match: 'global',
    segmented_diagnosis: 'segmented',
    propagation_pattern: 'propagation',
    local_edit_alignment: 'edit',
    cofecha_segment_lag: 'cofecha',
    ar_prewhiten_recall: 'ar',
    bayesian_lag_path: 'bayes',
    candidate_ranking: 'ranking',
  }
  return sources.map((source) => labels[source] ?? source).join(' + ')
}

const formatShortBatchId = (batchId: string) => {
  const parts = batchId.split('-')
  return parts.length >= 2 ? parts.slice(-2).join('-') : batchId.slice(-12)
}

export function DiagnosisCandidatePanel({
  candidates,
  diagnosisBatchResult = null,
  onApplyDiagnosisCandidate,
}: Props) {
  const [rejectedCandidateIds, setRejectedCandidateIds] = useState<string[]>([])

  const isCandidateApplicable = useCallback((candidate: DiagnosisCandidateOperation) => {
    if (!onApplyDiagnosisCandidate) return false
    return isActionableDiagnosisCandidate(candidate)
  }, [onApplyDiagnosisCandidate])

  const applicableCandidateCount = useMemo(() => (
    candidates.filter(isCandidateApplicable).length
  ), [candidates, isCandidateApplicable])

  if (candidates.length === 0) {
    return (
      <div style={{
        padding: '8px 6px',
        color: '#8a8a8a',
        fontFamily: 'Segoe UI, system-ui, sans-serif',
        fontSize: 12,
        fontStyle: 'italic',
      }}>
        该序列暂无候选建议
      </div>
    )
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      padding: 7,
      border: '1px solid #e2d4c2',
      borderRadius: 6,
      background: '#fffaf3',
      fontFamily: 'Segoe UI, system-ui, sans-serif',
      fontSize: 11,
      color: '#59402a',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <strong style={{ fontSize: 12, color: '#4c321e' }}>候选检查</strong>
        <span>{candidates.length} 条 · 可执行 {applicableCandidateCount}</span>
      </div>
      {diagnosisBatchResult ? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          padding: '5px 6px',
          border: `1px solid ${diagnosisBatchResult.failedCount > 0 ? '#e7b5a1' : '#c8d7c8'}`,
          borderRadius: 5,
          background: diagnosisBatchResult.failedCount > 0 ? '#fff7f3' : '#f5fbf5',
          color: diagnosisBatchResult.failedCount > 0 ? '#7e351e' : '#2f5d35',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
            <strong style={{ fontSize: 11 }}>最近应用 {formatShortBatchId(diagnosisBatchResult.batchId)}</strong>
            <span>
              应用 {diagnosisBatchResult.appliedCount} · 跳过 {diagnosisBatchResult.skippedCount} · 失败 {diagnosisBatchResult.failedCount}
            </span>
          </div>
          {diagnosisBatchResult.results
            .filter((result) => result.reason)
            .slice(0, 2)
            .map((result) => (
              <span key={result.candidateId} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {result.targetTree} · {result.label}: {result.reason}
              </span>
            ))}
        </div>
      ) : null}
      {candidates.map((candidate) => {
        const rejected = rejectedCandidateIds.includes(candidate.id)
        const canApply = Boolean(onApplyDiagnosisCandidate) && isCandidateApplicable(candidate) && !rejected
        const candidateYear = candidate.targetYear !== undefined ? ` · ${candidate.targetYear}` : ''
        const candidateDelta = candidate.delta !== undefined && candidate.delta !== null
          ? ` (${candidate.delta >= 0 ? '+' : ''}${candidate.delta.toFixed(2)})`
          : ''
        const evidence = candidate.evidence
        const confidenceLevel = candidate.confidenceLevel ?? candidate.confidence
        const confidenceStyle = confidenceLevel === 'high'
          ? { background: '#f6d6c8', color: '#8f2d18' }
          : confidenceLevel === 'medium'
            ? { background: '#f7e5bd', color: '#6e5010' }
            : confidenceLevel === 'ambiguous'
              ? { background: '#efe4f5', color: '#65407a' }
              : { background: '#eef0f3', color: '#5f6d7c' }
        const algorithmSource = formatAlgorithmSource(candidate.algorithmSource ?? evidence.algorithmSource ?? [])
        const warningLabel = candidate.ambiguous ? '歧义' : candidate.lowConfidence ? '低置信' : null
        return (
          <div
            key={candidate.id}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto auto',
              gap: 6,
              alignItems: 'start',
              padding: '5px 6px',
              borderRadius: 5,
              background: rejected ? '#f6f6f6' : '#fff',
              border: '1px solid #efdfcc',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#352417' }}>
                  {candidate.targetTree}
                </strong>
                <span style={{
                  flex: '0 0 auto',
                  padding: '1px 5px',
                  borderRadius: 9,
                  ...confidenceStyle,
                  fontSize: 10,
                  fontWeight: 700,
                }}>
                  {confidenceLevel}
                </span>
                {candidate.rank ? <span style={{ fontSize: 10, color: '#8a6b4c' }}>#{candidate.rank}</span> : null}
                {warningLabel ? <span style={{ fontSize: 10, color: '#7a4a2f' }}>{warningLabel}</span> : null}
                {rejected ? (
                  <span style={{ fontSize: 10, color: '#777' }}>已忽略</span>
                ) : null}
              </div>
              <div style={{ marginTop: 2, color: '#6f5a45', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {candidate.segmentStartYear}-{candidate.segmentEndYear}{candidateYear} · {getDiagnosisCandidateLabel(candidate)} · r {formatCorrelation(candidate.currentCorrelation)} → {formatCorrelation(candidate.expectedCorrelation)}{candidateDelta}
              </div>
              {candidate.suggestedRange ? (
                <div style={{
                  marginTop: 3,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: '#eef5ec',
                  border: '1px solid #c8ddc4',
                  color: '#356b3a',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  建议范围 {candidate.suggestedRange.startYear}–{candidate.suggestedRange.endYear}
                  （{candidate.operationType === 'DELETE_FALSE_RING' ? '伪轮' : candidate.operationType === 'INSERT_MISSING_RING' ? '缺轮' : '编辑'}应在此 {candidate.suggestedRange.endYear - candidate.suggestedRange.startYear + 1} 年内）
                </div>
              ) : null}
              <div style={{ marginTop: 3, color: '#765b40', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '2px 8px' }}>
                <span>A/B {evidence.before.unresolvedA}/{evidence.before.unresolvedB} → {evidence.after.unresolvedA}/{evidence.after.unresolvedB}</span>
                <span>bestLag {evidence.before.bestLag} → {evidence.after.bestLag}</span>
                <span>score {(candidate.candidateScore ?? candidate.score).toFixed(2)}</span>
                <span>相对置信 {formatProbabilityLike(candidate.probabilityLike)}</span>
                <span>置信 {confidenceLevel}</span>
                <span title={algorithmSource}>来源 {algorithmSource || '-'}</span>
                {candidate.mode ? <span>模式 {candidate.mode}</span> : <span>类型 {candidate.candidateType}</span>}
                {candidate.selectedRange ? <span>范围 {candidate.selectedRange.startYear}-{candidate.selectedRange.endYear}</span> : <span>anchor {candidate.anchorYear}</span>}
                {candidate.missingRange ? <span>缺测 {candidate.missingRange.startYear}-{candidate.missingRange.endYear}</span> : null}
                {candidate.deltaYears ? <span>delta {candidate.deltaYears > 0 ? '+' : ''}{candidate.deltaYears}</span> : null}
                {evidence.localEditAlignment ? <span>edit {evidence.localEditAlignment.method}</span> : null}
                {evidence.globalSliding ? <span>global t {formatCorrelation(evidence.globalSliding.bestGlobalTLike)}</span> : null}
              </div>
              <div style={{ marginTop: 3, color: '#8a6b4c', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {evidence.explanation}
              </div>
            </div>
            <button
              type="button"
              disabled={!canApply}
              title={canApply ? candidate.reason : '当前候选仅供检查，暂无可直接应用的编辑操作'}
              onClick={() => onApplyDiagnosisCandidate?.(candidate)}
              style={canApply ? { ...btnBase, borderColor: '#b86b33', color: '#8a3b12' } : btnDisabled}
            >
              应用
            </button>
            <button
              type="button"
              disabled={rejected}
              title={rejected ? '该候选已在当前视图中忽略' : '仅在当前视图中忽略，不修改数据'}
              onClick={() => setRejectedCandidateIds((previous) => previous.includes(candidate.id) ? previous : [...previous, candidate.id])}
              style={rejected ? btnDisabled : btnBase}
            >
              忽略
            </button>
          </div>
        )
      })}
    </div>
  )
}

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { ChartZoomWindow, MultiLineChart, colorPalette } from './MultiLineChart.tsx'
import { FloatingScrollArea } from '@/components/FloatingScrollArea/FloatingScrollArea'
import {
  buildReferenceSeries,
  createReferenceSeriesConfig,
  type ReferenceSeriesConfig,
} from '@/features/crossdating/reference'
import {
  getDiagnosisCandidateLabel,
  isActionableDiagnosisCandidate,
  selectSafeDiagnosisCandidateBatch,
  simulateLocalCrossdating,
  type CrossdatingDiagnosis,
  type DiagnosisBatchApplyResult,
  type DiagnosisCandidateOperation,
  type LocalCrossdatingSimulation,
  type LocalSimulationApplyRequest,
} from '@/features/crossdating/diagnosis'
import { RwlSiteData } from '@/features/rwl'
import type { DeleteMode, DeleteShift, MissingInsertSide } from '@/features/rwl/edit'
import { stopMarker } from '@/shared/constants'

// 树种图表管理器。
// 这个组件负责把当前 RWL 数据拆成”可选树种列表 + 选中后的多折线图”两部分：
// 1. 上方按钮区负责树种选择；
// 2. 下方交给 MultiLineChart 渲染具体曲线。
// 它本身不改写原始数据，只做筛选和展示。

type Props = {
  fullData: RwlSiteData
  variant?: 'panel' | 'expanded'
  referenceConfig?: ReferenceSeriesConfig | null
  diagnosis?: CrossdatingDiagnosis
  diagnosisBatchResult?: DiagnosisBatchApplyResult | null
  onReferenceConfigChange?: (config: ReferenceSeriesConfig | null) => void
  onApplyDiagnosisCandidate?: (candidate: DiagnosisCandidateOperation) => void
  onApplyDiagnosisCandidateBatch?: (candidates: DiagnosisCandidateOperation[]) => void
  onApplyLocalSimulation?: (request: LocalSimulationApplyRequest) => void
  onInsertMissingYearAtSide?: (tree: string, year: number, side: MissingInsertSide) => void
  onDeleteYearWithMode?: (tree: string, year: number, mode: DeleteMode, shift?: DeleteShift) => void
  onDeleteSeries?: (tree: string) => void
}

const HOVER_SIMULATION_DELAY_MS = 120

function TreeChartManagerBase({
  fullData,
  variant = 'panel',
  referenceConfig = null,
  diagnosis,
  diagnosisBatchResult = null,
  onReferenceConfigChange,
  onApplyDiagnosisCandidate,
  onApplyDiagnosisCandidateBatch,
  onApplyLocalSimulation,
  onInsertMissingYearAtSide,
  onDeleteYearWithMode,
  onDeleteSeries,
}: Props) {
  const [selectedTrees, setSelectedTrees] = useState<string[]>([])
  const [isReferenceMode, setIsReferenceMode] = useState(false)
  const [referenceDraftTrees, setReferenceDraftTrees] = useState<string[]>([])
  const [highlightedTreeCode, setHighlightedTreeCode] = useState<string | null>(null)
  const [treeOffsets, setTreeOffsets] = useState<Map<string, number>>(new Map())
  const [zoomWindow, setZoomWindow] = useState<ChartZoomWindow>(null)
  const [hoverTarget, setHoverTarget] = useState<{ tree: string; year: number } | null>(null)
  const [hoverSimulation, setHoverSimulation] = useState<LocalCrossdatingSimulation | null>(null)
  const [search, setSearch] = useState('')
  const [selectedBatchCandidateIds, setSelectedBatchCandidateIds] = useState<string[]>([])

  useEffect(() => {
    setSelectedTrees((previous) => previous.filter((treeCode) => fullData.has(treeCode)))
    setReferenceDraftTrees((previous) => previous.filter((treeCode) => fullData.has(treeCode)))
  }, [fullData])

  useEffect(() => {
    if (!isReferenceMode) {
      setReferenceDraftTrees(referenceConfig?.selectedTrees ?? [])
    }
  }, [isReferenceMode, referenceConfig])

  useEffect(() => {
    setTreeOffsets((previous) => {
      const next = new Map<string, number>()

      previous.forEach((offset, treeCode) => {
        if (fullData.has(treeCode)) {
          next.set(treeCode, offset)
        }
      })

      if (next.size !== previous.size) {
        return next
      }

      for (const [treeCode, offset] of previous.entries()) {
        if (next.get(treeCode) !== offset) {
          return next
        }
      }

      return previous
    })
  }, [fullData])

  useEffect(() => {
    setHighlightedTreeCode((previous) => (
      previous && selectedTrees.includes(previous) ? previous : null
    ))

    if (selectedTrees.length === 0) {
      setZoomWindow(null)
    }
  }, [selectedTrees])

  const toggleTree = (treeCode: string) => {
    if (isReferenceMode) {
      setReferenceDraftTrees(prev =>
        prev.includes(treeCode)
          ? prev.filter(code => code !== treeCode)
          : [...prev, treeCode]
      )
      return
    }

    setSelectedTrees(prev =>
      prev.includes(treeCode)
        ? prev.filter(code => code !== treeCode)
        : [...prev, treeCode]
    )
  }

  const shiftHighlightedTree = useCallback((treeCode: string, direction: -1 | 1) => {
    setTreeOffsets((previous) => {
      const next = new Map(previous)
      next.set(treeCode, (next.get(treeCode) ?? 0) + direction)
      return next
    })
  }, [])

  const visibleTrees = useMemo(() => (
    isReferenceMode
      ? Array.from(new Set([...selectedTrees, ...referenceDraftTrees]))
      : selectedTrees
  ), [isReferenceMode, referenceDraftTrees, selectedTrees])

  const referenceSeries = useMemo(() => (
    buildReferenceSeries(fullData, referenceConfig)
  ), [fullData, referenceConfig])

  const referenceSourceSet = useMemo(() => (
    new Set(referenceConfig?.selectedTrees ?? [])
  ), [referenceConfig])

  const diagnosisByTree = useMemo(() => (
    new Map((diagnosis?.summaries ?? []).map((summary) => [summary.tree, summary]))
  ), [diagnosis])

  const filteredData = useMemo(() => {
    const nextData = new Map<string, Map<number, number>>()

    visibleTrees.forEach(treeCode => {
      const treeData = fullData.get(treeCode)
      if (treeData) {
        const numericData = new Map<number, number>()
        const yearOffset = treeOffsets.get(treeCode) ?? 0

        treeData.forEach((value, year) => {
          if (typeof value !== "number" || value <= 0 || value === stopMarker.value) {
            return
          }

          numericData.set(year + yearOffset, value)
        })

        if (numericData.size > 0) {
          nextData.set(treeCode, numericData)
        }
      }
    })

    return nextData
  }, [fullData, treeOffsets, visibleTrees])

  const allTreeCodes = useMemo(() => Array.from(fullData.keys()), [fullData])
  const filteredTreeCodes = useMemo(() =>
    search.trim() === '' ? allTreeCodes : allTreeCodes.filter(c => c.toLowerCase().includes(search.toLowerCase())),
    [allTreeCodes, search]
  )
  const activeSelection = isReferenceMode ? referenceDraftTrees : selectedTrees
  const allSelected = allTreeCodes.length > 0 && activeSelection.length === allTreeCodes.length
  const isExpanded = variant === 'expanded'

  const selectedStats = useMemo(() => {
    let pointCount = 0
    let minYear = Number.POSITIVE_INFINITY
    let maxYear = Number.NEGATIVE_INFINITY

    activeSelection.forEach(treeCode => {
      const treeData = fullData.get(treeCode)
      treeData?.forEach((value, year) => {
        if (typeof value !== 'number' || value <= 0 || value === stopMarker.value) return
        pointCount += 1
        minYear = Math.min(minYear, year)
        maxYear = Math.max(maxYear, year)
      })
    })

    return {
      pointCount,
      yearSpan: Number.isFinite(minYear) && Number.isFinite(maxYear) ? `${minYear}-${maxYear}` : '-',
    }
  }, [activeSelection, fullData])

  const selectedDiagnosisStats = useMemo(() => {
    let flaggedSegmentCount = 0
    let candidateCount = 0

    activeSelection.forEach((treeCode) => {
      const summary = diagnosisByTree.get(treeCode)
      flaggedSegmentCount += summary?.flaggedSegmentCount ?? 0
      candidateCount += summary?.candidateCount ?? 0
    })

    return { flaggedSegmentCount, candidateCount }
  }, [activeSelection, diagnosisByTree])

  useEffect(() => {
    if (!hoverTarget) {
      setHoverSimulation(null)
      return
    }

    setHoverSimulation((previous) => (
      previous?.targetTree === hoverTarget.tree && previous.year === hoverTarget.year
        ? previous
        : null
    ))

    let cancelled = false
    const timer = window.setTimeout(() => {
      const nextSimulation = simulateLocalCrossdating(fullData, hoverTarget.tree, hoverTarget.year, { referenceConfig })
      if (!cancelled) {
        setHoverSimulation(nextSimulation)
      }
    }, HOVER_SIMULATION_DELAY_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [fullData, hoverTarget, referenceConfig])

  const visibleDiagnosisCandidates = useMemo(() => {
    const candidates = diagnosis?.candidates ?? []
    const selectionSet = new Set(activeSelection)
    const scoped = selectionSet.size > 0
      ? candidates.filter((candidate) => selectionSet.has(candidate.targetTree))
      : candidates
    return scoped.slice(0, isExpanded ? 8 : 3)
  }, [activeSelection, diagnosis, isExpanded])

  const visibleFlaggedDiagnosisSegments = useMemo(() => {
    const visibleTreeSet = new Set(visibleTrees)
    if (!diagnosis || visibleTreeSet.size === 0) return []

    return diagnosis.segments
      .filter((segment) => segment.flagged && visibleTreeSet.has(segment.targetTree))
      .sort((a, b) => {
        const lagPriority = Number(b.bestLag !== 0) - Number(a.bestLag !== 0)
        if (lagPriority !== 0) return lagPriority
        return (a.currentCorrelation ?? 1) - (b.currentCorrelation ?? 1)
      })
      .slice(0, isExpanded ? 36 : 18)
  }, [diagnosis, isExpanded, visibleTrees])

  const selectLongestTrees = useCallback(() => {
    const longest = allTreeCodes
      .map(treeCode => {
        let pointCount = 0
        fullData.get(treeCode)?.forEach((value) => {
          if (typeof value === 'number' && value > 0 && value !== stopMarker.value) {
            pointCount += 1
          }
        })
        return { treeCode, pointCount }
      })
      .sort((a, b) => b.pointCount - a.pointCount)
      .slice(0, Math.min(10, allTreeCodes.length))
      .map(({ treeCode }) => treeCode)

    if (isReferenceMode) {
      setReferenceDraftTrees(longest)
    } else {
      setSelectedTrees(longest)
    }
  }, [allTreeCodes, fullData, isReferenceMode])

  const invertSelection = useCallback(() => {
    const inverted = allTreeCodes.filter(treeCode => !activeSelection.includes(treeCode))
    if (isReferenceMode) {
      setReferenceDraftTrees(inverted)
    } else {
      setSelectedTrees(inverted)
    }
  }, [activeSelection, allTreeCodes, isReferenceMode])

  const resetChartView = useCallback(() => {
    setTreeOffsets(new Map())
    setZoomWindow(null)
  }, [])

  const handleHoverTargetChange = useCallback((target: { tree: string; year: number } | null) => {
    setHoverTarget((previous) => {
      if (!target && !previous) return previous
      if (target && previous && target.tree === previous.tree && target.year === previous.year) return previous
      return target
    })
  }, [])

  const beginReferenceSelection = useCallback(() => {
    setReferenceDraftTrees(referenceConfig?.selectedTrees.length ? referenceConfig.selectedTrees : selectedTrees)
    setIsReferenceMode(true)
  }, [referenceConfig, selectedTrees])

  const cancelReferenceSelection = useCallback(() => {
    setReferenceDraftTrees(referenceConfig?.selectedTrees ?? [])
    setIsReferenceMode(false)
  }, [referenceConfig])

  const applyReferenceSelection = useCallback(() => {
    const nextConfig = createReferenceSeriesConfig(referenceDraftTrees)
    onReferenceConfigChange?.(nextConfig)
    setReferenceDraftTrees(nextConfig?.selectedTrees ?? [])
    setIsReferenceMode(false)
  }, [onReferenceConfigChange, referenceDraftTrees])

  const clearReferenceSelection = useCallback(() => {
    onReferenceConfigChange?.(null)
    setReferenceDraftTrees([])
    setIsReferenceMode(false)
  }, [onReferenceConfigChange])

  const seriesColorMap = useMemo(() => {
    const map = new Map<string, string>()
    let idx = 0
    filteredData.forEach((_, treeCode) => {
      map.set(treeCode, colorPalette[idx % colorPalette.length])
      idx++
    })
    return map
  }, [filteredData])

  const btnBase: React.CSSProperties = {
    fontSize: 12, padding: '4px 12px', borderRadius: 5, cursor: 'pointer',
    border: '1px solid #d0d0d0', background: '#fff', color: '#444',
    fontWeight: 500, letterSpacing: 0, transition: 'background 0.12s, color 0.12s',
    lineHeight: 1.4,boxShadow: 'none',
  }
  const btnDisabled: React.CSSProperties = {
    ...btnBase, background: '#f4f4f4', color: '#c0c0c0', cursor: 'default', border: '1px solid #e4e4e4',
  }

  const formatCorrelation = (value: number | null) => (
    value === null ? '-' : value.toFixed(2)
  )

  const formatShortBatchId = (batchId: string) => {
    const parts = batchId.split('-')
    return parts.length >= 2 ? parts.slice(-2).join('-') : batchId.slice(-12)
  }

  const isCandidateApplicable = useCallback((candidate: DiagnosisCandidateOperation) => {
    if (!onApplyDiagnosisCandidate && !onApplyDiagnosisCandidateBatch) return false
    return isActionableDiagnosisCandidate(candidate)
  }, [onApplyDiagnosisCandidate, onApplyDiagnosisCandidateBatch])

  const applicableCandidateCount = useMemo(() => (
    (diagnosis?.candidates ?? []).filter(isCandidateApplicable).length
  ), [diagnosis, isCandidateApplicable])

  const visibleActionableCandidates = useMemo(() => (
    visibleDiagnosisCandidates.filter(isCandidateApplicable)
  ), [isCandidateApplicable, visibleDiagnosisCandidates])

  const safeVisibleActionableCandidates = useMemo(() => (
    selectSafeDiagnosisCandidateBatch(visibleActionableCandidates).selected
  ), [visibleActionableCandidates])

  const safeVisibleActionableCandidateIds = useMemo(() => (
    new Set(safeVisibleActionableCandidates.map((candidate) => candidate.id))
  ), [safeVisibleActionableCandidates])

  const safeVisibleActionableCandidateSignature = safeVisibleActionableCandidates.map((candidate) => candidate.id).join('|')

  useEffect(() => {
    setSelectedBatchCandidateIds(safeVisibleActionableCandidates.map((candidate) => candidate.id))
  }, [safeVisibleActionableCandidateSignature])

  const selectedBatchCandidates = useMemo(() => {
    const selectedIds = new Set(selectedBatchCandidateIds)
    return visibleActionableCandidates.filter((candidate) => selectedIds.has(candidate.id))
  }, [selectedBatchCandidateIds, visibleActionableCandidates])

  const toggleBatchCandidate = useCallback((candidateId: string) => {
    setSelectedBatchCandidateIds((previous) => (
      previous.includes(candidateId)
        ? previous.filter((id) => id !== candidateId)
        : [...previous, candidateId]
    ))
  }, [])

  const selectAllVisibleBatchCandidates = useCallback(() => {
    setSelectedBatchCandidateIds(safeVisibleActionableCandidates.map((candidate) => candidate.id))
  }, [safeVisibleActionableCandidates])

  const clearVisibleBatchCandidates = useCallback(() => {
    setSelectedBatchCandidateIds([])
  }, [])

  const applySelectedBatchCandidates = useCallback(() => {
    if (selectedBatchCandidates.length === 0) return
    onApplyDiagnosisCandidateBatch?.(selectedBatchCandidates)
  }, [onApplyDiagnosisCandidateBatch, selectedBatchCandidates])

  const candidatePanel = diagnosis && visibleDiagnosisCandidates.length > 0 ? (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      marginBottom: 8,
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
        <span>{visibleDiagnosisCandidates.length} / {diagnosis.candidateCount} · 可执行 {applicableCandidateCount}</span>
      </div>
      {onApplyDiagnosisCandidateBatch && visibleActionableCandidates.length > 1 ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto auto auto',
          gap: 6,
          alignItems: 'center',
          padding: '4px 6px',
          border: '1px solid #ead7b6',
          borderRadius: 5,
          background: '#fffdf7',
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#6f5312' }}>
            已选 {selectedBatchCandidates.length} / 推荐 {safeVisibleActionableCandidates.length}
          </span>
          <button
            type="button"
            onClick={selectAllVisibleBatchCandidates}
            style={{ ...btnBase, padding: '2px 7px', fontSize: 11 }}
          >
            全选
          </button>
          <button
            type="button"
            onClick={clearVisibleBatchCandidates}
            style={{ ...btnBase, padding: '2px 7px', fontSize: 11 }}
          >
            清空
          </button>
          <button
            type="button"
            disabled={selectedBatchCandidates.length === 0}
            title={selectedBatchCandidates.length === 0 ? '先勾选要应用的候选' : '同一批次每条序列只应用一个候选，其余会记录为跳过'}
            onClick={applySelectedBatchCandidates}
            style={selectedBatchCandidates.length === 0
              ? { ...btnDisabled, padding: '2px 7px', fontSize: 11 }
              : { ...btnBase, padding: '2px 7px', fontSize: 11, borderColor: '#9a6a13', color: '#6f5312', fontWeight: 650 }}
          >
            应用已选
          </button>
        </div>
      ) : null}
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
            <strong style={{ fontSize: 11 }}>批次 {formatShortBatchId(diagnosisBatchResult.batchId)}</strong>
            <span>
              请求 {diagnosisBatchResult.requestedCount} · 应用 {diagnosisBatchResult.appliedCount} · 跳过 {diagnosisBatchResult.skippedCount} · 失败 {diagnosisBatchResult.failedCount}
            </span>
          </div>
          {diagnosisBatchResult.appliedCount > 0 ? (
            <span style={{ color: '#4f6b4c' }}>可在操作日志中按批次整批回滚。</span>
          ) : null}
          {diagnosisBatchResult.results
            .filter((result) => result.status !== 'applied' && result.reason)
            .slice(0, 2)
            .map((result) => (
              <span key={result.candidateId} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {result.targetTree} · {result.label}: {result.reason}
              </span>
            ))}
        </div>
      ) : null}
      {visibleDiagnosisCandidates.map((candidate) => {
        const canApply = Boolean(onApplyDiagnosisCandidate) && isCandidateApplicable(candidate)
        const canBatchSelect = Boolean(onApplyDiagnosisCandidateBatch) && isCandidateApplicable(candidate)
        const batchSelected = selectedBatchCandidateIds.includes(candidate.id)
        const batchRecommended = safeVisibleActionableCandidateIds.has(candidate.id)
        const candidateYear = candidate.targetYear !== undefined ? ` · ${candidate.targetYear}` : ''
        const candidateDelta = candidate.delta !== undefined && candidate.delta !== null
          ? ` (${candidate.delta >= 0 ? '+' : ''}${candidate.delta.toFixed(2)})`
          : ''
        return (
          <div
            key={candidate.id}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              gap: 6,
              alignItems: 'center',
              padding: '5px 6px',
              borderRadius: 5,
              background: '#fff',
              border: '1px solid #efdfcc',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                {canBatchSelect ? (
                  <input
                    type="checkbox"
                    checked={batchSelected}
                    title={batchRecommended ? '纳入批量应用' : '同一序列已有更高优先级候选；批量应用时会跳过冲突项'}
                    onChange={() => toggleBatchCandidate(candidate.id)}
                    style={{ flex: '0 0 auto', margin: 0 }}
                  />
                ) : null}
                <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#352417' }}>
                  {candidate.targetTree}
                </strong>
                <span style={{
                  flex: '0 0 auto',
                  padding: '1px 5px',
                  borderRadius: 9,
                  background: candidate.confidence === 'high' ? '#f6d6c8' : candidate.confidence === 'medium' ? '#f7e5bd' : '#eef0f3',
                  color: candidate.confidence === 'high' ? '#8f2d18' : candidate.confidence === 'medium' ? '#6e5010' : '#5f6d7c',
                  fontSize: 10,
                  fontWeight: 700,
                }}>
                  {candidate.confidence}
                </span>
              </div>
              <div style={{ marginTop: 2, color: '#6f5a45', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {candidate.segmentStartYear}-{candidate.segmentEndYear}{candidateYear} · {getDiagnosisCandidateLabel(candidate)} · r {formatCorrelation(candidate.currentCorrelation)} → {formatCorrelation(candidate.expectedCorrelation)}{candidateDelta}
              </div>
            </div>
            <button
              type="button"
              disabled={!canApply}
              title={canApply ? candidate.reason : '当前候选仅供检查，暂无可直接应用的编辑操作'}
              onClick={() => onApplyDiagnosisCandidate?.(candidate)}
              style={canApply ? { ...btnBase, padding: '3px 8px', borderColor: '#b86b33', color: '#8a3b12' } : { ...btnDisabled, padding: '3px 8px' }}
            >
              应用
            </button>
          </div>
        )
      })}
    </div>
  ) : null

  const canApplyHoverSimulation = Boolean(
    hoverSimulation
    && hoverSimulation.bestOption.operationType !== 'NO_ACTION'
    && hoverSimulation.bestOption.delta !== null
    && hoverSimulation.bestOption.delta > 0
    && onApplyLocalSimulation
  )

  const hoverSimulationPanel = hoverSimulation ? (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 5,
      marginBottom: 8,
      padding: 7,
      border: '1px solid #d7e1ec',
      borderRadius: 6,
      background: '#f7fbff',
      color: '#28445f',
      fontFamily: 'Segoe UI, system-ui, sans-serif',
      fontSize: 11,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        <strong style={{ fontSize: 12, color: '#1f344b' }}>悬停模拟</strong>
        <span>{hoverSimulation.targetTree} · {hoverSimulation.year}</span>
      </div>
      <div style={{ color: '#52677e' }}>
        {hoverSimulation.segmentStartYear}-{hoverSimulation.segmentEndYear} · r {formatCorrelation(hoverSimulation.bestOption.currentCorrelation)} → {formatCorrelation(hoverSimulation.bestOption.simulatedCorrelation)}
        {hoverSimulation.bestOption.delta !== null ? ` (${hoverSimulation.bestOption.delta >= 0 ? '+' : ''}${hoverSimulation.bestOption.delta.toFixed(2)})` : ''}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 6, alignItems: 'center' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {hoverSimulation.bestOption.label} · {hoverSimulation.bestOption.confidence}
        </span>
        <button
          type="button"
          disabled={!canApplyHoverSimulation}
          title={canApplyHoverSimulation ? hoverSimulation.bestOption.reason : '没有正向改善或当前建议不可应用'}
          onClick={() => hoverSimulation && onApplyLocalSimulation?.({
            simulation: hoverSimulation,
            option: hoverSimulation.bestOption,
          })}
          style={canApplyHoverSimulation ? { ...btnBase, padding: '3px 8px', borderColor: '#2e6da4', color: '#23527c' } : { ...btnDisabled, padding: '3px 8px' }}
        >
          应用
        </button>
      </div>
    </div>
  ) : null

  const chartNode = filteredData.size > 0 || referenceSeries ? (
    <MultiLineChart
      data={filteredData}
      sampleSizeData={fullData}
      referenceSeries={referenceSeries}
      diagnosisSegments={visibleFlaggedDiagnosisSegments}
      hoverSimulation={hoverSimulation}
      highlightedTreeCode={highlightedTreeCode}
      onHighlightedTreeCodeChange={setHighlightedTreeCode}
      onHoverTargetChange={handleHoverTargetChange}
      zoomWindow={zoomWindow}
      onZoomWindowChange={setZoomWindow}
      onShiftHighlightedTree={shiftHighlightedTree}
      onInsertMissingYearAtSide={onInsertMissingYearAtSide}
      onDeleteYearWithMode={onDeleteYearWithMode}
      onDeleteSeries={onDeleteSeries}
    />
  ) : (
    <div style={{
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#8a94a3',
      fontFamily: 'Segoe UI, system-ui, sans-serif',
      fontSize: 13,
    }}>
      {isReferenceMode ? '选择参考序列' : '未选择序列'}
    </div>
  )

  const picker = (
    <>
      <div style={{
        display: 'flex',
        flexWrap: isExpanded ? 'wrap' : 'nowrap',
        alignItems: 'center',
        gap: 6,
        marginBottom: 6,
      }}>
        <button onClick={() => isReferenceMode ? setReferenceDraftTrees(allTreeCodes) : setSelectedTrees(allTreeCodes)} disabled={allSelected}
          style={allSelected ? btnDisabled : btnBase}>全选</button>
        <button onClick={() => isReferenceMode ? setReferenceDraftTrees([]) : setSelectedTrees([])} disabled={activeSelection.length === 0}
          style={activeSelection.length === 0 ? btnDisabled : btnBase}>全不选</button>
        {isExpanded ? (
          <>
            <button onClick={invertSelection} disabled={allTreeCodes.length === 0}
              style={allTreeCodes.length === 0 ? btnDisabled : btnBase}>反选</button>
            <button onClick={selectLongestTrees} disabled={allTreeCodes.length === 0}
              style={allTreeCodes.length === 0 ? btnDisabled : btnBase}>最长10条</button>
          </>
        ) : null}

        <div style={{ flex: 1, minWidth: isExpanded ? 180 : 0, position: 'relative', display: 'flex', alignItems: 'center' }}>
          <svg style={{ position: 'absolute', left: 8, pointerEvents: 'none', color: '#aaa' }}
            width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="22" y2="22" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索序列"
            style={{
              width: '100%', fontSize: 12, padding: '4px 8px 4px 26px',
              border: '1px solid #d0d0d0', borderRadius: 5, outline: 'none',
              background: '#fff', color: '#333', lineHeight: 1.4,
              boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.05)',
            }}
          />
        </div>
        {isReferenceMode ? (
          <>
            <button onClick={applyReferenceSelection} disabled={referenceDraftTrees.length === 0}
              style={referenceDraftTrees.length === 0 ? btnDisabled : { ...btnBase, borderColor: '#111827', color: '#111827', fontWeight: 650 }}>生成参考</button>
            <button onClick={cancelReferenceSelection} style={btnBase}>取消</button>
          </>
        ) : (
          <button onClick={beginReferenceSelection} disabled={allTreeCodes.length === 0}
            style={allTreeCodes.length === 0 ? btnDisabled : referenceSeries ? { ...btnBase, borderColor: '#111827', color: '#111827', fontWeight: 650 } : btnBase}>参考</button>
        )}
        {referenceSeries ? (
          <button onClick={clearReferenceSelection} style={btnBase}>关闭参考</button>
        ) : null}
        <span style={{
          fontSize: 11, color: '#fff', background: '#2e6da4',
          borderRadius: 10, padding: '1px 8px', fontWeight: 600, whiteSpace: 'nowrap',
        }}>
          {isReferenceMode ? `${referenceDraftTrees.length} 参考` : `${selectedTrees.length} / ${allTreeCodes.length}`}
        </span>
        {diagnosis ? (
          <span
            title="内部轻量诊断：problem segments / candidates"
            style={{
              fontSize: 11,
              color: diagnosis.problemSegmentCount > 0 ? '#7a2e0e' : '#236344',
              background: diagnosis.problemSegmentCount > 0 ? '#fff3e4' : '#e9f6ef',
              border: `1px solid ${diagnosis.problemSegmentCount > 0 ? '#f2c79a' : '#b7dec7'}`,
              borderRadius: 10,
              padding: '1px 8px',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            诊断 {diagnosis.problemSegmentCount} / {diagnosis.candidateCount}
          </span>
        ) : null}
      </div>

      {isExpanded ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 6,
          marginBottom: 8,
          color: '#5f6d7c',
          fontFamily: 'Segoe UI, system-ui, sans-serif',
          fontSize: 12,
          lineHeight: 1.25,
        }}>
          <span>观测 {selectedStats.pointCount}</span>
          <span>跨度 {selectedStats.yearSpan}</span>
          <span>匹配 {filteredTreeCodes.length}</span>
          <span>偏移 {treeOffsets.size}</span>
          <span>问题段 {selectedDiagnosisStats.flaggedSegmentCount}</span>
          <span>候选 {selectedDiagnosisStats.candidateCount}</span>
        </div>
      ) : null}

      {candidatePanel}
      {hoverSimulationPanel}

      <FloatingScrollArea
        viewportStyle={{
        flex: isExpanded ? '1 1 auto' : '0 0 auto',
        maxHeight: isExpanded ? 'none' : 76,
        minHeight: isExpanded ? 0 : undefined,
        border: '1px solid #e8e8e8',
        borderRadius: 6,
        background: '#f8f9fa',
      }}
        style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignContent: 'flex-start',
        padding: '4px 5px',
        gap: 4,
      }}>
        {filteredTreeCodes.length === 0
          ? <span style={{ fontSize: 12, color: '#bbb', padding: '4px 6px', fontStyle: 'italic' }}>无匹配结果</span>
          : filteredTreeCodes.map(treeCode => {
            const checked = selectedTrees.includes(treeCode)
            const referenceChecked = referenceDraftTrees.includes(treeCode)
            const activeChecked = isReferenceMode ? referenceChecked : checked
            const isReferenceSource = referenceSourceSet.has(treeCode)
            const diagnosisSummary = diagnosisByTree.get(treeCode)
            const seriesColor = seriesColorMap.get(treeCode)
            return (
              <button
                key={treeCode}
                onClick={() => toggleTree(treeCode)}
                style={{
                  fontSize: 11, padding: '2px 9px', borderRadius: 6,
                  border: activeChecked ? `1px solid ${isReferenceMode ? '#111827' : '#2e6da4'}` : isReferenceSource ? '1px dashed #111827' : '1px solid #d8d8d8',
                  background: isReferenceSource && !activeChecked ? '#f3f4f6' : '#fff',
                  color: activeChecked ? (isReferenceMode ? '#111827' : '#2e6da4') : '#555',
                  cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
                  boxShadow: activeChecked ? '0 1px 3px rgba(17,24,39,0.14)' : '0 1px 2px rgba(0,0,0,0.04)',
                  transition: 'all 0.12s',
                  lineHeight: 1.6,
                  position: 'relative',
                }}
              >
                {treeCode}
                {diagnosisSummary && diagnosisSummary.flaggedSegmentCount > 0 ? (
                  <span
                    title={`${diagnosisSummary.flaggedSegmentCount} 个诊断问题段`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minWidth: 15,
                      height: 15,
                      marginLeft: 5,
                      padding: '0 3px',
                      borderRadius: 8,
                      background: '#ffe8d5',
                      color: '#8a3b12',
                      fontSize: 9,
                      fontWeight: 700,
                      lineHeight: 1,
                    }}
                  >
                    !{diagnosisSummary.flaggedSegmentCount}
                  </span>
                ) : null}
                {activeChecked && (
                  <span style={{ position: 'absolute', bottom: 2, left: 5, right: 5, height: 2, borderRadius: 1, background: isReferenceMode ? '#111827' : seriesColor }} />
                )}
              </button>
            )
          })
        }
      </FloatingScrollArea>
    </>
  )

  if (isExpanded) {
    return (
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(260px, 330px) minmax(0, 1fr)',
        gap: 12,
        minHeight: 0,
        height: '100%',
        padding: 12,
        boxSizing: 'border-box',
      }}>
        <aside style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
          padding: 10,
          border: '1px solid #d9e0ea',
          borderRadius: 6,
          background: '#fff',
          boxSizing: 'border-box',
        }}>
          {picker}
        </aside>

        <section style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
          border: '1px solid #d9e0ea',
          borderRadius: 6,
          background: '#fff',
          boxSizing: 'border-box',
          overflow: 'hidden',
        }}>
          <div style={{
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '8px 10px',
            borderBottom: '1px solid #e3e8ef',
            fontFamily: 'Segoe UI, system-ui, sans-serif',
            fontSize: 12,
            color: '#5f6d7c',
          }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {highlightedTreeCode ? `高亮 ${highlightedTreeCode}` : '未高亮'}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto' }}>
              <button onClick={() => highlightedTreeCode && shiftHighlightedTree(highlightedTreeCode, -1)}
                disabled={!highlightedTreeCode} style={!highlightedTreeCode ? btnDisabled : btnBase}>←</button>
              <button onClick={() => highlightedTreeCode && shiftHighlightedTree(highlightedTreeCode, 1)}
                disabled={!highlightedTreeCode} style={!highlightedTreeCode ? btnDisabled : btnBase}>→</button>
              <button onClick={resetChartView} style={btnBase}>重置视图</button>
            </div>
          </div>
          <div style={{ flex: '1 1 auto', minHeight: 0, padding: 10, boxSizing: 'border-box' }}>
            {chartNode}
          </div>
        </section>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ flex: '0 0 auto', marginBottom: 10 }}>
        {picker}
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        {chartNode}
      </div>
    </div>
  )
}

export const TreeChartManager = memo(TreeChartManagerBase)

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChartZoomWindow, MultiLineChart, colorPalette } from './MultiLineChart.tsx'
import { FloatingScrollArea } from '@/components/FloatingScrollArea/FloatingScrollArea'
import {
  buildReferenceSeries,
  createReferenceSeriesConfig,
  type ReferenceSeriesConfig,
} from '@/features/crossdating/reference'
import {
  type CrossdatingDiagnosis,
  type DiagnosisBatchApplyResult,
  type DiagnosisCandidateOperation,
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

// 面板模式下序列选择器可上下拖拽改变高度，配置持久化到 localStorage。
const PICKER_HEIGHT_STORAGE_KEY = 'crossdating.chartPickerHeight.v1'
const PICKER_MIN_HEIGHT = 44
const PICKER_MAX_HEIGHT = 360
const PICKER_DEFAULT_HEIGHT = 76

const clampPickerHeight = (value: number) => (
  Math.min(Math.max(value, PICKER_MIN_HEIGHT), PICKER_MAX_HEIGHT)
)

const readStoredPickerHeight = () => {
  if (typeof window === 'undefined') return PICKER_DEFAULT_HEIGHT
  const raw = window.localStorage.getItem(PICKER_HEIGHT_STORAGE_KEY)
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN
  return Number.isFinite(parsed) ? clampPickerHeight(parsed) : PICKER_DEFAULT_HEIGHT
}

type Props = {
  fullData: RwlSiteData
  variant?: 'panel' | 'expanded'
  showPersistentTooltip?: boolean
  referenceConfig?: ReferenceSeriesConfig | null
  dynamicReferenceConfig?: ReferenceSeriesConfig | null
  diagnosis?: CrossdatingDiagnosis
  diagnosisBatchResult?: DiagnosisBatchApplyResult | null
  onReferenceConfigChange?: (config: ReferenceSeriesConfig | null) => void
  onResetReferenceToDynamic?: () => void
  onApplyDiagnosisCandidate?: (candidate: DiagnosisCandidateOperation) => void
  onApplyDiagnosisCandidateBatch?: (candidates: DiagnosisCandidateOperation[]) => void
  onApplyLocalSimulation?: (request: LocalSimulationApplyRequest) => void
  onInsertMissingYearAtSide?: (tree: string, year: number, side: MissingInsertSide) => void
  onDeleteYearWithMode?: (tree: string, year: number, mode: DeleteMode, shift?: DeleteShift) => void
  onDeleteSeries?: (tree: string) => void
}

function TreeChartManagerBase({
  fullData,
  variant = 'panel',
  showPersistentTooltip = false,
  referenceConfig = null,
  dynamicReferenceConfig = null,
  diagnosis,
  onReferenceConfigChange,
  onResetReferenceToDynamic: _onResetReferenceToDynamic,
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
  const [search, setSearch] = useState('')
  const [showDynamicReference, setShowDynamicReference] = useState(false)
  const [pickerHeight, setPickerHeight] = useState<number>(readStoredPickerHeight)
  const [isResizingPicker, setIsResizingPicker] = useState(false)
  const pickerHeightRef = useRef(pickerHeight)

  useEffect(() => {
    pickerHeightRef.current = pickerHeight
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PICKER_HEIGHT_STORAGE_KEY, String(pickerHeight))
    }
  }, [pickerHeight])

  const startPickerResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()

    const startY = event.clientY
    const startHeight = pickerHeightRef.current
    const originalUserSelect = document.body.style.userSelect
    const originalCursor = document.body.style.cursor

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setPickerHeight(clampPickerHeight(startHeight + (moveEvent.clientY - startY)))
    }

    const finishResize = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishResize)
      window.removeEventListener('pointercancel', finishResize)
      document.body.style.userSelect = originalUserSelect
      document.body.style.cursor = originalCursor
      setIsResizingPicker(false)
    }

    setIsResizingPicker(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'row-resize'

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishResize)
    window.addEventListener('pointercancel', finishResize)
  }, [])

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
  const allTreeCodes = useMemo(() => Array.from(fullData.keys()), [fullData])

  const referenceSeries = useMemo(() => (
    referenceConfig?.mode === 'dynamic' ? null : buildReferenceSeries(fullData, referenceConfig)
  ), [fullData, referenceConfig])

  const dynamicReferenceSeries = useMemo(() => (
    dynamicReferenceConfig?.mode === 'dynamic' ? buildReferenceSeries(fullData, dynamicReferenceConfig) : null
  ), [dynamicReferenceConfig, fullData])

  const referenceSourceSet = useMemo(() => (
    new Set(referenceConfig?.selectedTrees ?? [])
  ), [referenceConfig])
  const dynamicReferenceSummary = dynamicReferenceSeries?.summary
  const dynamicReferenceStatusLabel = useMemo(() => {
    if (!dynamicReferenceConfig) return null
    const total = dynamicReferenceConfig.classification?.allSeriesIds.length ?? allTreeCodes.length
    const anchorCount = dynamicReferenceConfig.classification?.anchorPassIds.length ?? dynamicReferenceConfig.selectedTrees.length
    const candidateCount = dynamicReferenceConfig.classification?.candidateFlaggedIds.length ?? 0
    const stale = dynamicReferenceConfig.isStale ? ' stale' : ''
    const invalid = dynamicReferenceConfig.unavailableReason ? ` ${dynamicReferenceConfig.unavailableReason}` : ''
    const range = dynamicReferenceSummary?.startYear != null && dynamicReferenceSummary.endYear != null
      ? ` ${dynamicReferenceSummary.startYear}-${dynamicReferenceSummary.endYear}`
      : ''
    const replication = dynamicReferenceSummary?.meanReplication != null
      ? ` mean n=${dynamicReferenceSummary.meanReplication.toFixed(1)}`
      : ''
    return `COFECHA-pass algorithm reference ${anchorCount} / ${total}; candidates ${candidateCount}${range}${replication}${stale}${invalid}`
  }, [allTreeCodes.length, dynamicReferenceConfig, dynamicReferenceSummary])
  const referenceSummary = referenceSeries?.summary
  const referenceStatusLabel = useMemo(() => {
    if (referenceConfig?.mode === 'dynamic') {
      const total = referenceConfig.classification?.allSeriesIds.length ?? allTreeCodes.length
      const anchorCount = referenceConfig.classification?.anchorPassIds.length ?? referenceConfig.selectedTrees.length
      const candidateCount = referenceConfig.classification?.candidateFlaggedIds.length ?? 0
      const stale = referenceConfig.isStale ? ' · 参考序列过期' : ''
      const invalid = referenceConfig.unavailableReason ? ` · ${referenceConfig.unavailableReason}` : ''
      const range = referenceSummary?.startYear != null && referenceSummary.endYear != null
        ? ` · ${referenceSummary.startYear}-${referenceSummary.endYear}`
        : ''
      const replication = referenceSummary?.meanReplication != null
        ? ` · 平均 n=${referenceSummary.meanReplication.toFixed(1)}`
        : ''
      return `COFECHA 无 A 参考组 ${anchorCount} / ${total} · 待检查 ${candidateCount}${range}${replication}${stale}${invalid}`
    }
    if (referenceSeries) {
      return `手动参考 ${referenceSeries.selectedTrees.length} 条 · 点 ${referenceSeries.pointCount}`
    }
    return null
  }, [allTreeCodes.length, referenceConfig, referenceSeries, referenceSummary])

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

  // 收集每条折线中插入的缺失年轮（0 值）所在年份。这些 0 值被 filteredData 过滤掉，
  // 在折线上表现为断点，交给图表用绿色竖线标记。
  const missingRingYears = useMemo(() => {
    const result = new Map<string, number[]>()

    visibleTrees.forEach(treeCode => {
      const treeData = fullData.get(treeCode)
      if (!treeData) return
      const yearOffset = treeOffsets.get(treeCode) ?? 0
      const years: number[] = []

      treeData.forEach((value, year) => {
        if (value === 0) years.push(year + yearOffset)
      })

      if (years.length > 0) result.set(treeCode, years)
    })

    return result
  }, [fullData, treeOffsets, visibleTrees])

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


  const chartNode = filteredData.size > 0 || referenceSeries || (showDynamicReference && dynamicReferenceSeries) ? (
    <MultiLineChart
      data={filteredData}
      missingRingYears={missingRingYears}
      sampleSizeData={fullData}
      referenceSeries={referenceSeries}
      dynamicReferenceSeries={dynamicReferenceSeries}
      showDynamicReference={showDynamicReference}
      showPersistentTooltip={showPersistentTooltip}
      highlightedTreeCode={highlightedTreeCode}
      onHighlightedTreeCodeChange={setHighlightedTreeCode}
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
            <button onClick={applyReferenceSelection} disabled={referenceDraftTrees.length === 0} title='在下方选择多个序列进行平均'
              style={referenceDraftTrees.length === 0 ? btnDisabled : { ...btnBase, borderColor: '#111827', color: '#111827', fontWeight: 650 }}>生成参考</button>
            <button onClick={cancelReferenceSelection} style={btnBase}>取消</button>
          </>
        ) : (
          <button onClick={beginReferenceSelection} disabled={allTreeCodes.length === 0}
            style={allTreeCodes.length === 0 ? btnDisabled : referenceSeries ? { ...btnBase, borderColor: '#111827', color: '#111827', fontWeight: 650 } : btnBase}>参考</button>
        )}
        {referenceSeries ? (
          <button onClick={clearReferenceSelection} style={btnBase}>清除参考</button>
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
        {diagnosis && diagnosis.masterNarrowYears.length > 0 ? (
          <span
            title={diagnosis.masterNarrowYears.slice(0, 12).map((item) => `${item.year} (${item.masterValue.toFixed(2)}, n=${item.sampleDepth})`).join(' · ')}
            style={{
              fontSize: 11,
              color: '#244a63',
              background: '#eef7fc',
              border: '1px solid #c9dfeb',
              borderRadius: 10,
              padding: '1px 8px',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            窄年 {diagnosis.masterNarrowYears.length}
          </span>
        ) : null}
      </div>

      {referenceStatusLabel ? (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          alignItems: 'center',
          marginBottom: 7,
          color: referenceConfig?.isStale ? '#7a2e0e' : '#374151',
          fontFamily: 'Segoe UI, system-ui, sans-serif',
          fontSize: 11,
          lineHeight: 1.35,
        }}>
          <span style={{
            border: `1px solid ${referenceConfig?.isStale ? '#f2c79a' : '#cfd7e2'}`,
            borderRadius: 10,
            padding: '1px 8px',
            background: referenceConfig?.isStale ? '#fff3e4' : '#f8fafc',
            fontWeight: 650,
          }}>
            {referenceStatusLabel}
          </span>
          {referenceSummary?.minReplication != null ? (
            <span style={{ color: '#6b7280' }}>最低 n={referenceSummary.minReplication}</span>
          ) : null}
        </div>
      ) : null}

      {dynamicReferenceStatusLabel ? (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          alignItems: 'center',
          marginBottom: 7,
          color: dynamicReferenceConfig?.isStale ? '#7a2e0e' : '#236344',
          fontFamily: 'Segoe UI, system-ui, sans-serif',
          fontSize: 11,
          lineHeight: 1.35,
        }}>
          <span style={{
            border: `1px solid ${dynamicReferenceConfig?.isStale ? '#f2c79a' : '#b7dec7'}`,
            borderRadius: 10,
            padding: '1px 8px',
            background: dynamicReferenceConfig?.isStale ? '#fff3e4' : '#e9f6ef',
            fontWeight: 650,
          }}>
            {dynamicReferenceStatusLabel}
          </span>
          {dynamicReferenceSeries ? (
            <label
              title="显示/隐藏 COFECHA-pass 动态参考序列"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '1px 8px',
                border: '1px solid #b7dec7',
                borderRadius: 10,
                background: showDynamicReference ? '#e9f6ef' : '#fff',
                color: '#236344',
                fontFamily: 'Segoe UI, system-ui, sans-serif',
                fontSize: 11,
                fontWeight: 650,
                lineHeight: 1.35,
                cursor: 'pointer',
                userSelect: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              <input
                type="checkbox"
                checked={showDynamicReference}
                onChange={(event) => setShowDynamicReference(event.target.checked)}
                style={{ width: 12, height: 12, margin: 0, accentColor: '#236344' }}
              />
              <span
                aria-hidden="true"
                style={{ width: 22, height: 0, borderTop: '2px dashed rgba(35, 99, 68, 0.9)' }}
              />
              <span>COFECHA-pass</span>
            </label>
          ) : null}
          {dynamicReferenceSummary?.minReplication != null ? (
            <span style={{ color: '#6b7280' }}>min n={dynamicReferenceSummary.minReplication}</span>
          ) : null}
        </div>
      ) : null}

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

      <FloatingScrollArea
        viewportStyle={{
        flex: isExpanded ? '1 1 auto' : '0 0 auto',
        height: isExpanded ? undefined : pickerHeight,
        maxHeight: isExpanded ? 'none' : undefined,
        minHeight: isExpanded ? 0 : undefined,
        border: '1px solid #eceff3',
        borderRadius: 6,
        background: '#ffffff',
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

      {isExpanded ? null : (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整序列选择器高度"
          title="上下拖动调整序列选择器高度"
          onPointerDown={startPickerResize}
          style={{
            flex: '0 0 auto',
            height: 9,
            marginTop: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'row-resize',
            touchAction: 'none',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 40,
              height: 3,
              borderRadius: 2,
              background: isResizingPicker ? '#94a3b4' : '#d4d9e0',
              transition: 'background 0.12s',
            }}
          />
        </div>
      )}
    </>
  )

  if (isExpanded) {
    return (
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(260px, 330px) minmax(0, 1fr)',
        gap: 0,
        minHeight: 0,
        height: '100%',
        boxSizing: 'border-box',
      }}>
        <aside style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
          padding: 14,
          borderRight: '1px solid #eceff3',
          background: '#fafbfc',
          boxSizing: 'border-box',
        }}>
          {picker}
        </aside>

        <section style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
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
            padding: '10px 14px',
            borderBottom: '1px solid #eef1f4',
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

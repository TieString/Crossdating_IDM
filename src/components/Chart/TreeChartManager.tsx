import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChartZoomWindow, MultiLineChart, colorPalette, type ChartDiagnosisEventRange } from './MultiLineChart.tsx'
import { PairwiseMismatchNotice } from './PairwiseMismatchNotice'
import {
  resolvePairwiseChartAnalysis,
  type PairwiseChartAnalysisContext,
} from './pairwiseChartAnalysis'
import { FloatingScrollArea } from '@/components/FloatingScrollArea/FloatingScrollArea'
import {
  buildReferenceSeries,
  createReferenceSeriesConfig,
  type ReferenceSeriesConfig,
} from '@/features/crossdating/reference'
import {
    getDisplayedDiagnosisEvents,
    projectActiveDiagnosisEventInterpretation,
    refreshActiveDiagnosisEventInterpretation,
    simulateDiagnosisEventPreview,
    tryApplyLocalCrossdatingOption,
  type CrossdatingDiagnosis,
  type DiagnosisBatchApplyResult,
  type DiagnosisCandidateOperation,
  type DiagnosisEvent,
  type LocalCrossdatingSimulation,
  type LocalSimulationApplyRequest,
  type LocalSimulationOption,
} from '@/features/crossdating/diagnosis'
import { RwlSiteData } from '@/features/rwl'
import type { DeleteMode, DeleteShift, MissingInsertSide } from '@/features/rwl/edit'
import { stopMarker } from '@/shared/constants'
import { normalizeCofechaSeriesId } from '@/features/cofecha/seriesId'
import {
  analyzePairwiseMismatch,
  type PairwiseMismatchAnalysis,
} from '@/features/crossdating/pairwiseMismatch'
import type { ChartJumpTarget } from './chartNavigation'
import { buildStableSeriesColorMap } from './seriesColors'
import {
  createOlderSidePartialMovePlan,
  createWholeSeriesMovePlan,
  type WholeSeriesMoveDirection,
} from '@/components/WidthContainer/manualMovePlan'

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
  try {
    const raw = window.localStorage.getItem(PICKER_HEIGHT_STORAGE_KEY)
    const parsed = raw ? Number.parseFloat(raw) : Number.NaN
    return Number.isFinite(parsed) ? clampPickerHeight(parsed) : PICKER_DEFAULT_HEIGHT
  } catch {
    return PICKER_DEFAULT_HEIGHT
  }
}

const getEditableTreeYearRange = (treeData: Map<number, number | null> | undefined): [number, number] | null => {
  if (!treeData) return null
  let startYear: number | undefined
  let endYear: number | undefined

  treeData.forEach((value, year) => {
    if (value === stopMarker.value) return
    startYear = startYear === undefined ? year : Math.min(startYear, year)
    endYear = endYear === undefined ? year : Math.max(endYear, year)
  })

  return startYear !== undefined && endYear !== undefined ? [startYear, endYear] : null
}

const localOptionKey = (option: LocalSimulationOption | null) => (
  option
    ? `${option.operationType}:${option.side ?? ''}:${option.shift ?? ''}`
    : ''
)

type PairwiseChartRun = {
  analysis: PairwiseMismatchAnalysis
  context: PairwiseChartAnalysisContext
}

type Props = {
  fullData: RwlSiteData
  variant?: 'panel' | 'expanded'
  showPersistentTooltip?: boolean
  selectedTrees?: readonly string[]
  treeOffsets?: ReadonlyMap<string, number>
  focusedTree?: string | null
  jumpTarget?: ChartJumpTarget | null
  referenceConfig?: ReferenceSeriesConfig | null
  dynamicReferenceConfig?: ReferenceSeriesConfig | null
  diagnosis?: CrossdatingDiagnosis
  activeDiagnosisEvent?: DiagnosisEvent | null
  diagnosisBatchResult?: DiagnosisBatchApplyResult | null
  onReferenceConfigChange?: (config: ReferenceSeriesConfig | null) => void
  onApplyDiagnosisCandidate?: (candidate: DiagnosisCandidateOperation) => void
  onApplyDiagnosisCandidateBatch?: (candidates: DiagnosisCandidateOperation[]) => void
  onApplyLocalSimulation?: (request: LocalSimulationApplyRequest) => void
  onInsertMissingYearAtSide?: (tree: string, year: number, side: MissingInsertSide) => void
  onDeleteYearWithMode?: (tree: string, year: number, mode: DeleteMode, shift?: DeleteShift) => void
  onMoveSeriesTailByOffset?: (tree: string, selectedStartYear: number, selectedEndYear: number, yearOffset: number) => void
  onDeleteSeries?: (tree: string) => void
  onSelectedTreesChange?: (trees: string[]) => void
  onTreeOffsetsChange?: (offsets: Map<string, number>) => void
  onLocateWidth?: (tree: string, year: number) => void
  onEditAsText?: (tree: string) => void
  onJumpToCofecha?: (tree: string) => void
  onDiagnosisPreviewChange?: (event: DiagnosisEvent, year: number) => void
  cofechaPart6Trees?: readonly string[]
}

function TreeChartManagerBase({
  fullData,
  variant = 'panel',
  showPersistentTooltip = false,
  selectedTrees: controlledSelectedTrees,
  treeOffsets: controlledTreeOffsets,
  focusedTree: controlledFocusedTree,
  jumpTarget = null,
  referenceConfig = null,
  dynamicReferenceConfig = null,
  diagnosis,
  activeDiagnosisEvent = null,
  onApplyLocalSimulation,
  onReferenceConfigChange,
  onInsertMissingYearAtSide,
  onDeleteYearWithMode,
  onMoveSeriesTailByOffset,
  onDeleteSeries,
  onSelectedTreesChange,
  onTreeOffsetsChange,
  onLocateWidth,
  onEditAsText,
  onJumpToCofecha,
  onDiagnosisPreviewChange,
  cofechaPart6Trees,
}: Props) {
  const [localSelectedTrees, setLocalSelectedTrees] = useState<string[]>([])
  const [isReferenceMode, setIsReferenceMode] = useState(false)
  const [referenceDraftTrees, setReferenceDraftTrees] = useState<string[]>([])
  const [highlightedTreeCode, setHighlightedTreeCode] = useState<string | null>(controlledFocusedTree ?? null)
  const [localTreeOffsets, setLocalTreeOffsets] = useState<Map<string, number>>(new Map())
  const [zoomWindow, setZoomWindow] = useState<ChartZoomWindow>(null)
  const [search, setSearch] = useState('')
  const [pickerHeight, setPickerHeight] = useState<number>(readStoredPickerHeight)
  const [isResizingPicker, setIsResizingPicker] = useState(false)
  const [localSimulation, setLocalSimulation] = useState<LocalCrossdatingSimulation | null>(null)
  const [selectedLocalOption, setSelectedLocalOption] = useState<LocalSimulationOption | null>(null)
  const [isConfirmingLocalApply, setIsConfirmingLocalApply] = useState(false)
  const [pairwiseRun, setPairwiseRun] = useState<PairwiseChartRun | null>(null)
  const [isPairwiseAnalyzing, setIsPairwiseAnalyzing] = useState(false)
  const [pairwiseError, setPairwiseError] = useState<string | null>(null)
  const pickerHeightRef = useRef(pickerHeight)
  const pairwiseRequestIdRef = useRef(0)
  const selectedTrees = controlledSelectedTrees === undefined
    ? localSelectedTrees
    : controlledSelectedTrees
  const treeOffsets = controlledTreeOffsets ?? localTreeOffsets
  const selectedTreesRef = useRef(selectedTrees)
  const treeOffsetsRef = useRef(treeOffsets)
  const controlledTreeOffsetsRef = useRef(controlledTreeOffsets)
  const onTreeOffsetsChangeRef = useRef(onTreeOffsetsChange)
  const handledJumpIdRef = useRef<number | null>(null)
  const handledDiagnosisPreviewJumpIdRef = useRef<number | null>(null)
  const diagnosisEvents = useMemo(() => getDisplayedDiagnosisEvents(diagnosis), [diagnosis])
  const resolvedActiveDiagnosisEvent = useMemo(() => (
    refreshActiveDiagnosisEventInterpretation(diagnosisEvents, activeDiagnosisEvent)
  ), [activeDiagnosisEvent, diagnosisEvents])
  const projectedDiagnosisEvents = useMemo(() => (
    projectActiveDiagnosisEventInterpretation(diagnosisEvents, resolvedActiveDiagnosisEvent)
  ), [diagnosisEvents, resolvedActiveDiagnosisEvent])
  const chartDiagnosisEvents = useMemo(() => (
    pairwiseRun
      ? pairwiseRun.analysis.event ? [pairwiseRun.analysis.event] : []
      : projectedDiagnosisEvents
  ), [pairwiseRun, projectedDiagnosisEvents])

  useEffect(() => {
    selectedTreesRef.current = selectedTrees
  }, [selectedTrees])

  useEffect(() => {
    treeOffsetsRef.current = treeOffsets
    controlledTreeOffsetsRef.current = controlledTreeOffsets
    onTreeOffsetsChangeRef.current = onTreeOffsetsChange
  }, [controlledTreeOffsets, onTreeOffsetsChange, treeOffsets])

  const setTreeOffsets = useCallback((
    update: Map<string, number> | ((previous: Map<string, number>) => Map<string, number>),
  ) => {
    const previous = new Map(treeOffsetsRef.current)
    const next = typeof update === 'function' ? update(previous) : update
    if (
      next === previous
      || (
        next.size === previous.size
        && Array.from(next.entries()).every(([tree, offset]) => previous.get(tree) === offset)
      )
    ) return
    treeOffsetsRef.current = next
    if (controlledTreeOffsetsRef.current === undefined) setLocalTreeOffsets(next)
    onTreeOffsetsChangeRef.current?.(new Map(next))
  }, [])

  const updateSelectedTrees = useCallback((nextTrees: string[]) => {
    const uniqueTrees = Array.from(new Set(nextTrees))
    selectedTreesRef.current = uniqueTrees
    if (controlledSelectedTrees === undefined) {
      setLocalSelectedTrees(uniqueTrees)
    }
    onSelectedTreesChange?.(uniqueTrees)
  }, [controlledSelectedTrees, onSelectedTreesChange])

  useEffect(() => {
    if (controlledFocusedTree !== undefined) {
      setHighlightedTreeCode(controlledFocusedTree)
    }
  }, [controlledFocusedTree])

  useEffect(() => {
    if (!jumpTarget || handledJumpIdRef.current === jumpTarget.id) return
    if (!fullData.has(jumpTarget.tree)) return

    handledJumpIdRef.current = jumpTarget.id
    if (!selectedTreesRef.current.includes(jumpTarget.tree)) {
      updateSelectedTrees([...selectedTreesRef.current, jumpTarget.tree])
    }
    if (highlightedTreeCode !== jumpTarget.tree) {
      setHighlightedTreeCode(jumpTarget.tree)
    }
  }, [fullData, highlightedTreeCode, jumpTarget, updateSelectedTrees])

  useEffect(() => {
    pickerHeightRef.current = pickerHeight
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(PICKER_HEIGHT_STORAGE_KEY, String(pickerHeight))
      } catch (error) {
        console.warn('保存折线图序列选择器高度失败:', error)
      }
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
    if (controlledSelectedTrees === undefined) {
      const filteredSelection = selectedTreesRef.current.filter((treeCode) => fullData.has(treeCode))
      if (
        filteredSelection.length !== selectedTreesRef.current.length
        || filteredSelection.some((treeCode, index) => treeCode !== selectedTreesRef.current[index])
      ) {
        updateSelectedTrees(filteredSelection)
      }
    }
    setReferenceDraftTrees((previous) => previous.filter((treeCode) => fullData.has(treeCode)))
  }, [controlledSelectedTrees, fullData, updateSelectedTrees])

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
  }, [fullData, setTreeOffsets])

  useEffect(() => {
    if (highlightedTreeCode && !selectedTrees.includes(highlightedTreeCode)) {
      setHighlightedTreeCode(null)
    }
  }, [highlightedTreeCode, selectedTrees])

  const toggleTree = (treeCode: string) => {
    if (isReferenceMode) {
      setReferenceDraftTrees(prev =>
        prev.includes(treeCode)
          ? prev.filter(code => code !== treeCode)
          : [...prev, treeCode]
      )
      return
    }

    const previous = selectedTreesRef.current
    const next = previous.includes(treeCode)
      ? previous.filter(code => code !== treeCode)
      : [...previous, treeCode]
    updateSelectedTrees(next)
  }

  const shiftHighlightedTree = useCallback((treeCode: string, direction: -1 | 1) => {
    setTreeOffsets((previous) => {
      const next = new Map(previous)
      const offset = (next.get(treeCode) ?? 0) + direction
      if (offset === 0) {
        next.delete(treeCode)
      } else {
        next.set(treeCode, offset)
      }
      return next
    })
  }, [setTreeOffsets])

  const visibleTrees = useMemo(() => (
    isReferenceMode
      ? Array.from(new Set([...selectedTrees, ...referenceDraftTrees]))
      : selectedTrees
  ), [isReferenceMode, referenceDraftTrees, selectedTrees])
  const allTreeCodes = useMemo(() => Array.from(fullData.keys()), [fullData])

  const clearLocalSimulation = useCallback(() => {
    setLocalSimulation(null)
    setSelectedLocalOption(null)
    setIsConfirmingLocalApply(false)
  }, [])

  const clearTreeOffset = useCallback((treeCode: string) => {
    setTreeOffsets((previous) => {
      if (!previous.has(treeCode)) return previous
      const next = new Map(previous)
      next.delete(treeCode)
      return next
    })
  }, [setTreeOffsets])

  const handleMoveWholeSeries = useCallback((
    tree: string,
    direction: WholeSeriesMoveDirection,
    yearCount: number,
  ) => {
    const range = getEditableTreeYearRange(fullData.get(tree))
    if (!range || !onMoveSeriesTailByOffset) return
    const plan = createWholeSeriesMovePlan(range[0], range[1], direction, yearCount)
    if (!plan) return

    onMoveSeriesTailByOffset(tree, plan.selectedStartYear, plan.selectedEndYear, plan.yearOffset)
    clearTreeOffset(tree)
  }, [clearTreeOffset, fullData, onMoveSeriesTailByOffset])

  const handleMoveOlderSide = useCallback((tree: string, firstFixedYear: number, yearCount: number) => {
    const range = getEditableTreeYearRange(fullData.get(tree))
    if (!range || !onMoveSeriesTailByOffset) return
    const sourceFirstFixedYear = firstFixedYear - (treeOffsets.get(tree) ?? 0)
    const plan = createOlderSidePartialMovePlan(range[0], range[1], sourceFirstFixedYear, yearCount)
    if (!plan) {
      window.alert(`断点年份必须位于 ${range[0] + 1} 至 ${range[1]}；断点年及较新侧保持不动。`)
      return
    }

    onMoveSeriesTailByOffset(tree, plan.selectedStartYear, plan.selectedEndYear, plan.yearOffset)
    clearTreeOffset(tree)
  }, [clearTreeOffset, fullData, onMoveSeriesTailByOffset, treeOffsets])

  const createDiagnosisEventSimulation = useCallback((
    event: DiagnosisEvent,
    previewYear: number,
  ) => {
    const pairwiseContext = pairwiseRun?.analysis.event?.id === event.id
      ? pairwiseRun.context
      : null
    const simulation = simulateDiagnosisEventPreview(
      pairwiseContext?.siteData ?? fullData,
      event,
      {
      referenceConfig: pairwiseContext?.referenceConfig ?? referenceConfig,
      previewYear,
      },
    )
    return simulation ? {
      ...simulation,
      displayYear: simulation.year + (treeOffsets.get(event.seriesId) ?? 0),
    } : null
  }, [fullData, pairwiseRun, referenceConfig, treeOffsets])

  const previewDiagnosisEvent = useCallback((
    event: DiagnosisEvent,
    previewYear: number,
  ) => {
    const simulation = createDiagnosisEventSimulation(event, previewYear)
    if (!simulation) {
      clearLocalSimulation()
      return
    }

    setLocalSimulation(simulation)
    setSelectedLocalOption(simulation.bestOption)
    setIsConfirmingLocalApply(false)
  }, [clearLocalSimulation, createDiagnosisEventSimulation])

  const handleLinePointClick = useCallback((target: { tree: string; year: number }) => {
    const sourceYear = target.year - (treeOffsets.get(target.tree) ?? 0)
    const matchingEvent = chartDiagnosisEvents
      .filter((event) => (
        !event.stale
        && event.seriesId === target.tree
        && event.eventType !== 'wholeSeriesMove'
        && sourceYear >= event.startYear
        && sourceYear <= event.endYear
      ))
      .sort((left, right) => {
        const leftDistance = Math.abs((left.rankedYears[0]?.year ?? sourceYear) - sourceYear)
        const rightDistance = Math.abs((right.rankedYears[0]?.year ?? sourceYear) - sourceYear)
        return leftDistance - rightDistance || right.evidence.score - left.evidence.score
      })[0]
    if (!matchingEvent) {
      clearLocalSimulation()
      return
    }
    previewDiagnosisEvent(matchingEvent, sourceYear)
    if (pairwiseRun?.analysis.event?.id !== matchingEvent.id) {
      onDiagnosisPreviewChange?.(matchingEvent, sourceYear)
    }
  }, [
    chartDiagnosisEvents,
    clearLocalSimulation,
    onDiagnosisPreviewChange,
    pairwiseRun,
    previewDiagnosisEvent,
    treeOffsets,
  ])

  useEffect(() => {
    if (
      !jumpTarget?.diagnosisPreviewEventId
      || handledDiagnosisPreviewJumpIdRef.current === jumpTarget.id
    ) {
      return
    }
    const requestedEvent = projectedDiagnosisEvents.find((event) => (
      !event.stale
      && event.id === jumpTarget.diagnosisPreviewEventId
      && event.seriesId === jumpTarget.tree
      && event.eventType !== 'wholeSeriesMove'
    ))
    if (!requestedEvent) return

    handledDiagnosisPreviewJumpIdRef.current = jumpTarget.id
    previewDiagnosisEvent(requestedEvent, jumpTarget.year)
  }, [jumpTarget, previewDiagnosisEvent, projectedDiagnosisEvents])

  useEffect(() => {
    if (localSimulation && !visibleTrees.includes(localSimulation.targetTree)) {
      clearLocalSimulation()
    }
  }, [clearLocalSimulation, localSimulation, visibleTrees])

  useEffect(() => {
    const sourceEventId = localSimulation?.sourceEventId
    if (
      sourceEventId
      && !chartDiagnosisEvents.some((event) => event.id === sourceEventId)
    ) {
      clearLocalSimulation()
    }
  }, [chartDiagnosisEvents, clearLocalSimulation, localSimulation?.sourceEventId])

  const localPreviewTreeData = useMemo(() => {
    if (
      !localSimulation
      || !selectedLocalOption
      || selectedLocalOption.operationType === 'NO_ACTION'
    ) {
      return null
    }
    const treeData = fullData.get(localSimulation.targetTree)
    if (!treeData) return null
    const previewData = tryApplyLocalCrossdatingOption(
      treeData,
      localSimulation,
      selectedLocalOption,
    )
    if (!previewData) return null
    return {
      tree: localSimulation.targetTree,
      data: previewData,
    }
  }, [fullData, localSimulation, selectedLocalOption])

  useEffect(() => {
    if (
      localSimulation
      && selectedLocalOption
      && selectedLocalOption.operationType !== 'NO_ACTION'
      && fullData.has(localSimulation.targetTree)
      && !localPreviewTreeData
    ) {
      clearLocalSimulation()
    }
  }, [clearLocalSimulation, fullData, localPreviewTreeData, localSimulation, selectedLocalOption])

  const referenceSeries = useMemo(() => (
    referenceConfig?.mode === 'dynamic' ? null : buildReferenceSeries(fullData, referenceConfig)
  ), [fullData, referenceConfig])

  const referenceSourceSet = useMemo(() => (
    new Set(referenceConfig?.selectedTrees ?? [])
  ), [referenceConfig])
  const cofechaClassification = dynamicReferenceConfig?.classification
    ?? referenceConfig?.classification
  const cofechaFlaggedSourceSet = useMemo(() => new Set(
    (cofechaClassification?.candidateFlaggedIds ?? [])
      .map(normalizeCofechaSeriesId),
  ), [cofechaClassification])
  const cofechaNoATrees = useMemo(() => {
    const anchorSet = new Set(
      (cofechaClassification?.anchorPassIds ?? []).map(normalizeCofechaSeriesId),
    )
    return allTreeCodes.filter((treeCode) => anchorSet.has(normalizeCofechaSeriesId(treeCode)))
  }, [allTreeCodes, cofechaClassification])
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
    return null
  }, [allTreeCodes.length, referenceConfig, referenceSummary])

  const diagnosisEventCountByTree = useMemo(() => {
    const counts = new Map<string, number>()
    chartDiagnosisEvents.forEach((event) => {
      if (event.stale) return
      counts.set(event.seriesId, (counts.get(event.seriesId) ?? 0) + 1)
    })
    return counts
  }, [chartDiagnosisEvents])

  const filteredData = useMemo(() => {
    const nextData = new Map<string, Map<number, number>>()

    visibleTrees.forEach(treeCode => {
      const treeData = localPreviewTreeData?.tree === treeCode
        ? localPreviewTreeData.data
        : fullData.get(treeCode)
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
  }, [fullData, localPreviewTreeData, treeOffsets, visibleTrees])

  const pairwiseVisibleTreeIds = useMemo(() => visibleTrees.filter((treeCode) => {
    const treeData = fullData.get(treeCode)
    if (!treeData) return false
    return Array.from(treeData.values()).some((value) => (
      typeof value === 'number' && value > 0 && value !== stopMarker.value
    ))
  }), [fullData, visibleTrees])

  const pairwiseAvailability = useMemo(() => resolvePairwiseChartAnalysis({
    fullData,
    visibleTreeIds: pairwiseVisibleTreeIds,
    highlightedTreeId: highlightedTreeCode,
    referenceSeries,
    referenceConfig,
  }), [
    fullData,
    highlightedTreeCode,
    pairwiseVisibleTreeIds,
    referenceConfig,
    referenceSeries,
  ])

  useEffect(() => {
    pairwiseRequestIdRef.current += 1
    setPairwiseRun(null)
    setIsPairwiseAnalyzing(false)
    setPairwiseError(null)
  }, [
    fullData,
    pairwiseAvailability.context?.comparatorId,
    pairwiseAvailability.context?.targetTree,
    pairwiseAvailability.lineCount,
    referenceSeries,
  ])

  const runPairwiseAnalysis = useCallback(() => {
    const context = pairwiseAvailability.context
    if (!context || isPairwiseAnalyzing) return
    const targetData = context.siteData.get(context.targetTree)
    const comparatorData = context.siteData.get(context.comparatorId)
    if (!targetData || !comparatorData) return

    const requestId = ++pairwiseRequestIdRef.current
    setIsPairwiseAnalyzing(true)
    setPairwiseError(null)
    setPairwiseRun(null)
    window.setTimeout(() => {
      if (requestId !== pairwiseRequestIdRef.current) return
      try {
        const analysis = analyzePairwiseMismatch({
          targetTree: context.targetTree,
          targetData,
          comparatorId: context.comparatorId,
          comparatorLabel: context.comparatorLabel,
          comparatorData,
          comparatorKind: context.comparatorKind,
          comparatorDepth: context.comparatorDepth,
        })
        if (requestId !== pairwiseRequestIdRef.current) return
        setPairwiseRun({ analysis, context })
      } catch (error) {
        if (requestId !== pairwiseRequestIdRef.current) return
        const message = error instanceof Error ? error.message : String(error)
        console.warn('双线错配分析失败:', error)
        setPairwiseError(message)
      } finally {
        if (requestId === pairwiseRequestIdRef.current) {
          setIsPairwiseAnalyzing(false)
        }
      }
    }, 0)
  }, [isPairwiseAnalyzing, pairwiseAvailability.context])

  const dismissPairwiseAnalysis = useCallback(() => {
    pairwiseRequestIdRef.current += 1
    setPairwiseRun(null)
    setIsPairwiseAnalyzing(false)
    setPairwiseError(null)
    if (localSimulation?.sourceEventId?.startsWith('pairwise-')) {
      clearLocalSimulation()
    }
  }, [clearLocalSimulation, localSimulation?.sourceEventId])

  const focusPairwiseEvent = useCallback((event: DiagnosisEvent, selectedYear?: number) => {
    const year = selectedYear ?? event.rankedYears[0]?.year
    if (year === undefined) return
    previewDiagnosisEvent(event, year)
  }, [previewDiagnosisEvent])

  const applyPairwiseEvent = useCallback((event: DiagnosisEvent, selectedYear: number) => {
    if (!onApplyLocalSimulation) return false
    const simulation = createDiagnosisEventSimulation(event, selectedYear)
    if (!simulation || simulation.bestOption.operationType === 'NO_ACTION') return false
    onApplyLocalSimulation({ simulation, option: simulation.bestOption })
    setPairwiseRun(null)
    clearLocalSimulation()
    return true
  }, [clearLocalSimulation, createDiagnosisEventSimulation, onApplyLocalSimulation])

  // 收集每条折线中插入的缺失年轮（0 值）所在年份。这些 0 值被 filteredData 过滤掉，
  // 在折线上表现为断点，交给图表用绿色竖线标记。
  const missingRingYears = useMemo(() => {
    const result = new Map<string, number[]>()

    visibleTrees.forEach(treeCode => {
      const treeData = localPreviewTreeData?.tree === treeCode
        ? localPreviewTreeData.data
        : fullData.get(treeCode)
      if (!treeData) return
      const yearOffset = treeOffsets.get(treeCode) ?? 0
      const years: number[] = []

      treeData.forEach((value, year) => {
        if (value === 0) years.push(year + yearOffset)
      })

      if (years.length > 0) result.set(treeCode, years)
    })

    return result
  }, [fullData, localPreviewTreeData, treeOffsets, visibleTrees])

  const diagnosisEventRanges = useMemo<ChartDiagnosisEventRange[]>(() => (
    chartDiagnosisEvents.flatMap((event) => {
      if (
        event.stale
        || event.eventType === 'wholeSeriesMove'
        || !visibleTrees.includes(event.seriesId)
      ) {
        return []
      }
      const yearOffset = treeOffsets.get(event.seriesId) ?? 0
      return [{
        id: event.id,
        tree: event.seriesId,
        eventType: event.eventType,
        startYear: event.startYear + yearOffset,
        endYear: event.endYear + yearOffset,
      }]
    })
  ), [chartDiagnosisEvents, treeOffsets, visibleTrees])

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
    let eventCount = 0

    activeSelection.forEach((treeCode) => {
      eventCount += diagnosisEventCountByTree.get(treeCode) ?? 0
    })

    return { eventCount }
  }, [activeSelection, diagnosisEventCountByTree])

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
      updateSelectedTrees(longest)
    }
  }, [allTreeCodes, fullData, isReferenceMode, updateSelectedTrees])

  const invertSelection = useCallback(() => {
    const inverted = allTreeCodes.filter(treeCode => !activeSelection.includes(treeCode))
    if (isReferenceMode) {
      setReferenceDraftTrees(inverted)
    } else {
      updateSelectedTrees(inverted)
    }
  }, [activeSelection, allTreeCodes, isReferenceMode, updateSelectedTrees])

  const resetChartView = useCallback(() => {
    setTreeOffsets(new Map())
  }, [setTreeOffsets])

  const beginReferenceSelection = useCallback(() => {
    setReferenceDraftTrees(referenceConfig?.selectedTrees.length ? referenceConfig.selectedTrees : Array.from(selectedTrees))
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

  const selectCofechaNoATrees = useCallback(() => {
    setReferenceDraftTrees(cofechaNoATrees)
  }, [cofechaNoATrees])

  const seriesColorMap = useMemo(
    () => buildStableSeriesColorMap(allTreeCodes, colorPalette),
    [allTreeCodes],
  )

  const btnBase: React.CSSProperties = {
    fontSize: 12, padding: '4px 12px', borderRadius: 5, cursor: 'pointer',
    border: '1px solid #d0d0d0', background: '#fff', color: '#444',
    fontWeight: 500, letterSpacing: 0, transition: 'background 0.12s, color 0.12s',
    lineHeight: 1.4,boxShadow: 'none',
  }
  const btnDisabled: React.CSSProperties = {
    ...btnBase, background: '#f4f4f4', color: '#c0c0c0', cursor: 'default', border: '1px solid #e4e4e4',
  }
  const pairwiseButtonDisabled = isReferenceMode
    || isPairwiseAnalyzing
    || pairwiseAvailability.context === null
  const pairwiseButtonTitle = isReferenceMode
    ? '请先完成或取消参考序列选择'
    : pairwiseAvailability.context
      ? `比较 ${pairwiseAvailability.context.targetTree} 与 ${pairwiseAvailability.context.comparatorLabel}，定位持续错配的起点`
      : pairwiseAvailability.reason

  const matchingLocalEvent = localSimulation
    ? chartDiagnosisEvents.find((event) => (
      !event.stale
      && event.seriesId === localSimulation.targetTree
      && (localSimulation.sourceEventId
        ? event.id === localSimulation.sourceEventId
        : localSimulation.year >= event.startYear
          && localSimulation.year <= event.endYear)
    ))
    : undefined
  const displayedReviewEvent = pairwiseRun ? pairwiseRun.analysis.event : resolvedActiveDiagnosisEvent
  const activeReviewLabel = displayedReviewEvent
    ? displayedReviewEvent.eventType === 'wholeSeriesMove'
      ? `${displayedReviewEvent.seriesId} · 整体移动 ${displayedReviewEvent.shiftYears ?? 0} 年`
      : `${displayedReviewEvent.seriesId} · 复核窗口 ${displayedReviewEvent.startYear}-${displayedReviewEvent.endYear}`
    : null
  const localYearStatus = !matchingLocalEvent
    ? '诊断事件'
    : matchingLocalEvent.eventType === 'partialMove' ? '已选断点' : '已选复核年份'
  const selectedOptionIsRecommended = !!selectedLocalOption
    && localSimulation?.bestOption.operationType !== 'NO_ACTION'
    && localOptionKey(selectedLocalOption) === localOptionKey(localSimulation?.bestOption ?? null)
  const formatLocalCorrelation = (value: number | null) => (
    value === null ? '-' : value.toFixed(2)
  )
  const localApplyDescription = localSimulation && selectedLocalOption
    ? selectedLocalOption.operationType === 'INSERT_MISSING_RING'
      ? `${localSimulation.year} 年插入缺轮，较老侧左移 1 年`
      : selectedLocalOption.operationType === 'DELETE_FALSE_RING'
        ? `${localSimulation.year} 年删除伪轮，较老侧右移 1 年`
        : selectedLocalOption.operationType === 'SHIFT_RANGE'
          ? `${localSimulation.selectedStartYear}-${localSimulation.selectedEndYear} 年移动 ${selectedLocalOption.shift && selectedLocalOption.shift > 0 ? '+' : ''}${selectedLocalOption.shift ?? 0} 年`
          : '保持原状'
    : ''

  const applySelectedLocalSimulation = () => {
    if (
      !localSimulation
      || !selectedLocalOption
      || selectedLocalOption.operationType === 'NO_ACTION'
      || !onApplyLocalSimulation
    ) {
      return
    }
    const request = {
      simulation: localSimulation,
      option: selectedLocalOption,
    }
    // Remove the preview before the editor synchronously publishes changed working data.
    clearLocalSimulation()
    onApplyLocalSimulation(request)
  }

  const chartNode = filteredData.size > 0 || referenceSeries ? (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
      minHeight: 0,
      height: '100%',
      fontFamily: 'Segoe UI, system-ui, sans-serif',
    }}>
      <div
        role="toolbar"
        aria-label="建议预览"
        style={{
          flex: '0 0 auto',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
          minHeight: 31,
          padding: '4px 7px',
          borderBottom: '1px solid #e5e7eb',
          background: localSimulation ? '#f7faf8' : '#fafafa',
          color: '#374151',
          fontSize: 11,
          lineHeight: 1.3,
        }}
      >
        <strong style={{ color: '#24352a', fontSize: 12 }}>建议预览</strong>
        {!localSimulation || !selectedLocalOption ? (
          <span style={{ color: activeReviewLabel ? '#315d36' : '#7b8490', fontWeight: activeReviewLabel ? 650 : 400 }}>
            {activeReviewLabel ?? '未预览建议'}
          </span>
        ) : (
          <>
            <span style={{ fontWeight: 650 }}>
              {localSimulation.targetTree} · {localSimulation.displayYear}
            </span>
            <span
              title={matchingLocalEvent
                ? `当前年份位于 ${matchingLocalEvent.startYear}-${matchingLocalEvent.endYear} 诊断窗口`
                : '当前预览未关联有效诊断事件'}
              style={{
                padding: '1px 6px',
                border: '1px solid #cbd5cf',
                borderRadius: 8,
                background: '#fff',
                color: matchingLocalEvent ? '#315d36' : '#697386',
                fontWeight: 650,
              }}
            >
              {localYearStatus}
            </span>
            <span
              title={selectedLocalOption.reason}
              style={{
                padding: '2px 7px',
                border: '1px solid #397342',
                borderRadius: 5,
                background: '#dcefdc',
                color: '#244d2b',
                fontWeight: 700,
              }}
            >
              {selectedLocalOption.label}
            </span>
            {matchingLocalEvent ? (
              <span
                title={`证据分 ${matchingLocalEvent.evidence.score.toFixed(3)}；来源 ${matchingLocalEvent.evidence.algorithmSources.join('、') || '-'}`}
                style={{ color: '#45694a', fontWeight: 650 }}
              >
                置信 {matchingLocalEvent.confidenceLevel === 'high'
                  ? '高'
                  : matchingLocalEvent.confidenceLevel === 'medium'
                    ? '中'
                    : '低'}
              </span>
            ) : null}
            <span
              title="相关性变化是最终事件的反事实预览证据，不是正确概率"
              style={{ color: selectedOptionIsRecommended ? '#315d36' : '#667084' }}
            >
              r {formatLocalCorrelation(selectedLocalOption.currentCorrelation)}
              {' → '}
              {formatLocalCorrelation(selectedLocalOption.simulatedCorrelation)}
              {selectedLocalOption.delta === null
                ? ''
                : ` (${selectedLocalOption.delta >= 0 ? '+' : ''}${selectedLocalOption.delta.toFixed(2)})`}
            </span>
            {localSimulation.bestOption.operationType === 'NO_ACTION' ? (
              <span style={{ color: '#8a5a21' }}>算法未发现明确改善</span>
            ) : null}
            <span style={{ flex: '1 1 auto' }} />
            {isConfirmingLocalApply ? (
              <>
                <span style={{ color: '#7a2e0e', fontWeight: 650 }}>{localApplyDescription}</span>
                <button
                  type="button"
                  onClick={() => setIsConfirmingLocalApply(false)}
                  style={{ ...btnBase, padding: '2px 8px', fontSize: 11 }}
                >
                  返回
                </button>
                <button
                  type="button"
                  onClick={applySelectedLocalSimulation}
                  style={{
                    ...btnBase,
                    padding: '2px 8px',
                    fontSize: 11,
                    borderColor: '#397342',
                    background: '#397342',
                    color: '#fff',
                    fontWeight: 700,
                  }}
                >
                  确认应用
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={clearLocalSimulation}
                  style={{ ...btnBase, padding: '2px 8px', fontSize: 11 }}
                >
                  取消预览
                </button>
                <button
                  type="button"
                  disabled={!onApplyLocalSimulation || selectedLocalOption.operationType === 'NO_ACTION'}
                  onClick={() => setIsConfirmingLocalApply(true)}
                  style={!onApplyLocalSimulation || selectedLocalOption.operationType === 'NO_ACTION'
                    ? { ...btnDisabled, padding: '2px 8px', fontSize: 11 }
                    : {
                      ...btnBase,
                      padding: '2px 8px',
                      fontSize: 11,
                      borderColor: '#397342',
                      color: '#315d36',
                      fontWeight: 700,
                    }}
                >
                  应用
                </button>
              </>
            )}
          </>
        )}
      </div>
      {pairwiseRun ? (
        <PairwiseMismatchNotice
          analysis={pairwiseRun.analysis}
          onFocusEvent={focusPairwiseEvent}
          onApplyEvent={onApplyLocalSimulation ? applyPairwiseEvent : undefined}
          onDismiss={dismissPairwiseAnalysis}
        />
      ) : pairwiseError ? (
        <div style={{
          flex: '0 0 auto',
          padding: '8px 10px',
          borderBottom: '1px solid #ead9d4',
          background: '#fff9f7',
          color: '#8a3b2f',
          fontFamily: 'Segoe UI, Microsoft YaHei, system-ui, sans-serif',
          fontSize: 12,
        }}>
          双线分析失败：{pairwiseError}
        </div>
      ) : null}
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        <MultiLineChart
          data={filteredData}
          seriesColors={seriesColorMap}
          diagnosisEventRanges={diagnosisEventRanges}
          missingRingYears={missingRingYears}
          sampleSizeData={fullData}
          referenceSeries={referenceSeries}
          showPersistentTooltip={showPersistentTooltip}
          hoverSimulation={localSimulation && selectedLocalOption
            ? { ...localSimulation, bestOption: selectedLocalOption }
            : localSimulation}
          highlightedTreeCode={highlightedTreeCode}
          onHighlightedTreeCodeChange={setHighlightedTreeCode}
          onLinePointClick={handleLinePointClick}
          onJumpToWidth={onLocateWidth}
          onEditAsText={onEditAsText}
          onJumpToCofecha={onJumpToCofecha}
          cofechaPart6Trees={cofechaPart6Trees}
          jumpTarget={jumpTarget && visibleTrees.includes(jumpTarget.tree) ? jumpTarget : null}
          zoomWindow={zoomWindow}
          onZoomWindowChange={setZoomWindow}
          onShiftHighlightedTree={shiftHighlightedTree}
          onInsertMissingYearAtSide={onInsertMissingYearAtSide}
          onDeleteYearWithMode={onDeleteYearWithMode}
          onMoveWholeSeries={handleMoveWholeSeries}
          onMoveOlderSide={handleMoveOlderSide}
          onDeleteSeries={onDeleteSeries}
        />
      </div>
    </div>
  ) : allTreeCodes.length === 0 ? null : (
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
        <button onClick={() => isReferenceMode ? setReferenceDraftTrees(allTreeCodes) : updateSelectedTrees(allTreeCodes)} disabled={allSelected}
          style={allSelected ? btnDisabled : btnBase}>全选</button>
        <button onClick={() => {
          if (isReferenceMode) {
            setReferenceDraftTrees([])
          } else {
            updateSelectedTrees([])
          }
        }} disabled={activeSelection.length === 0}
          style={activeSelection.length === 0 ? btnDisabled : btnBase}>全不选</button>
        {isReferenceMode ? (
          <button
            onClick={selectCofechaNoATrees}
            disabled={cofechaNoATrees.length === 0}
            title={cofechaClassification
              ? dynamicReferenceConfig?.cofechaPassReference?.source === 'pairwise_bootstrap'
                ? '选择冷启动时样芯间 lag=0 最大相互一致簇中的全部序列'
                : `${dynamicReferenceConfig?.isStale ? '基于最近一次已过期的 COFECHA 结果；' : ''}选择 PART 6 中没有 A 标记的全部序列`
              : '请先运行 COFECHA，以获得 PART 6 A 标记分类'}
            style={cofechaNoATrees.length === 0 ? btnDisabled : {
              ...btnBase,
              borderColor: '#b7dec7',
              color: '#236344',
              fontWeight: 650,
            }}
          >
            可靠序列{cofechaClassification ? ` (${cofechaNoATrees.length})` : ''}
          </button>
        ) : null}
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
          <button
            onClick={referenceSeries ? clearReferenceSelection : beginReferenceSelection}
            disabled={allTreeCodes.length === 0}
            title={referenceSeries ? "清除当前手动参考" : "选择多个可靠序列生成手动参考"}
            style={allTreeCodes.length === 0 ? btnDisabled : referenceSeries ? { ...btnBase, borderColor: '#111827', color: '#111827', fontWeight: 650 } : btnBase}
          >
            {referenceSeries ? `清除参考(${referenceSeries.selectedTrees.length})` : '参考'}
          </button>
        )}
        <button
          type="button"
          onClick={runPairwiseAnalysis}
          disabled={pairwiseButtonDisabled}
          title={pairwiseError ? `上次分析失败：${pairwiseError}` : pairwiseButtonTitle}
          aria-pressed={pairwiseRun !== null}
          style={pairwiseButtonDisabled ? btnDisabled : pairwiseRun ? {
            ...btnBase,
            border: '1px solid #8fa397',
            background: '#eaf3ed',
            color: '#244d37',
            fontWeight: 650,
          } : btnBase}
        >
          {isPairwiseAnalyzing ? '分析中…' : '双线分析'}
        </button>
        <button
          type="button"
          onClick={resetChartView}
          disabled={treeOffsets.size === 0}
          title="清除所有折线的手动年份偏移"
          style={treeOffsets.size === 0 ? btnDisabled : btnBase}
        >
          重置
        </button>
        <span style={{
          fontSize: 11, color: '#fff', background: '#2e6da4',
          borderRadius: 10, padding: '1px 8px', fontWeight: 600, whiteSpace: 'nowrap',
        }}>
          {isReferenceMode ? `${referenceDraftTrees.length} 参考` : `${selectedTrees.length} / ${allTreeCodes.length}`}
        </span>
        {treeOffsets.size > 0 ? (
          <span style={{
            fontSize: 11,
            color: '#7a4b0f',
            background: '#fff3e4',
            border: '1px solid #f2c79a',
            borderRadius: 10,
            padding: '1px 8px',
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}>
            保存时应用 {treeOffsets.size}
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
          <span>事件窗口 {selectedDiagnosisStats.eventCount}</span>
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
          ? allTreeCodes.length === 0
            ? null
            : <span style={{ fontSize: 12, color: '#bbb', padding: '4px 6px', fontStyle: 'italic' }}>无匹配结果</span>
          : filteredTreeCodes.map(treeCode => {
            const checked = selectedTrees.includes(treeCode)
            const referenceChecked = referenceDraftTrees.includes(treeCode)
            const activeChecked = isReferenceMode ? referenceChecked : checked
            const isReferenceSource = referenceSourceSet.has(treeCode)
            const isCofechaFlagged = cofechaFlaggedSourceSet.has(normalizeCofechaSeriesId(treeCode))
            const yearOffset = treeOffsets.get(treeCode) ?? 0
            const seriesColor = seriesColorMap.get(treeCode)
            return (
              <button
                key={treeCode}
                onClick={() => toggleTree(treeCode)}
                title={yearOffset === 0
                  ? treeCode
                  : `${treeCode} 当前手动偏移 ${yearOffset > 0 ? '+' : ''}${yearOffset} 年`}
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
                {yearOffset < 0 ? (
                  <span style={{ marginRight: 4, color: '#8a3b12', fontWeight: 750 }}>{yearOffset}</span>
                ) : null}
                <span>{treeCode}</span>
                {yearOffset > 0 ? (
                  <span style={{ marginLeft: 4, color: '#236344', fontWeight: 750 }}>+{yearOffset}</span>
                ) : null}
                {isCofechaFlagged ? (
                  <span
                    title="COFECHA PART 6 [A] flagged"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minWidth: 15,
                      height: 15,
                      marginLeft: 5,
                      padding: '0 3px',
                      borderRadius: 8,
                      background: '#fee2e2',
                      color: '#991b1b',
                      fontSize: 9,
                      fontWeight: 800,
                      lineHeight: 1,
                    }}
                  >
                    A
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
              <button
                onClick={resetChartView}
                disabled={treeOffsets.size === 0}
                style={treeOffsets.size === 0 ? btnDisabled : btnBase}
              >
                重置
              </button>
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

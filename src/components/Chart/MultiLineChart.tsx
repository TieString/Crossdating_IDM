import { Line } from 'react-chartjs-2'
import crosshairPlugin from 'chartjs-plugin-crosshair'
import zoomPlugin from 'chartjs-plugin-zoom'
import {
  Chart as ChartJS,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Title,
  Tooltip,
  Legend,
  ChartOptions,
  ChartData,
  Chart as ChartJSInstance,
  Plugin,
} from 'chart.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import WidthGridContextMenu from '@/components/WidthContainer/WidthGridContextMenu'
import type { WholeSeriesMoveDirection } from '@/components/WidthContainer/manualMovePlan'
import type { DiagnosisEventType, LocalCrossdatingSimulation } from '@/features/crossdating/diagnosis'
import type { ReferenceSeries } from '@/features/crossdating/reference'
import { REFERENCE_SERIES_LABEL } from '@/features/crossdating/reference'
import type { DeleteMode, DeleteShift, MissingInsertSide } from '@/features/rwl/edit'
import { normalizeCofechaSeriesId } from '@/features/cofecha/seriesId'
import { stopMarker } from '@/shared/constants'
import { centerChartViewportOnYear, type ChartJumpTarget } from './chartNavigation'

ChartJS.register(
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Title,
  Tooltip,
  Legend,
  zoomPlugin,
  crosshairPlugin
)

declare module 'chart.js' {
  interface PluginOptionsByType<TType> {
    crosshair?: {
      line?: {
        color?: string
        width?: number
        dashPattern?: number[]
        zIndex?: number
      }
      sync?: {
        enabled?: boolean
        group?: number
        suppressTooltips?: boolean
      }
      zoom?: {
        enabled?: boolean
      }
      snap?: {
        enabled?: boolean
      }
    }
  }
}

const FONT = "12px 'Arial', 'Helvetica', sans-serif"
const FONT_BOLD = "bold 12px 'Arial', 'Helvetica', sans-serif"
const LINE_H = 18
const PAD = 10
const SWATCH_W = 20
const SWATCH_H = 2
const SWATCH_GAP = 6
const COL_GAP = 16
const MAX_LABEL_CHARS = 12
const TOOLTIP_MAX_SERIES = 35
const Y_AXIS_WIDTH = 60
const SAMPLE_SIZE_AXIS_WIDTH = 44   // 显示样本量时在右侧为其 Y 轴预留的宽度
const X_AXIS_HEIGHT = 38    //底部x轴区域
const CHART_AREA_RIGHT_PADDING = 2
const MIN_CHART_AREA_WIDTH = 120
const GRID_MAJOR_COLOR = '#d9d9d9'
const GRID_MINOR_COLOR = '#cfcfcf'
const GRID_MINOR_DASH = [1, 4]
const X_GRID_MAJOR_YEAR_STEP = 5
const Y_GRID_MINOR_DIVISIONS = 5
const MIN_MINOR_GRID_SPACING_PX = 8
const X_TICK_LABEL_GAP_PX = 14
const X_TICK_TARGET_SPACING_PX = 58
const X_AXIS_TICK_LENGTH = 7
const X_AXIS_LABEL_Y_OFFSET = 10
const X_AXIS_TITLE_Y_OFFSET = 25    // x轴标题相对于x轴底部的垂直偏移
const X_AXIS_VIEW_PADDING_RATIO = 0.02   // 两端留白年数占数据跨度的比例，避免折线端点贴在 Y 轴上
const X_AXIS_MIN_PADDING_YEARS = 2       // 两端留白的最少年数
const NICE_YEAR_STEPS = [1, 2, 5, 10, 15, 20, 25, 50, 100, 200]
const LINE_HIT_THRESHOLD_PX = 5   // 鼠标距离折线小于5px时点击选择该折线
const HOVER_LINE_HIT_THRESHOLD_PX = 10
const SAMPLE_SIZE_AXIS_ID = 'sampleSize'
const DYNAMIC_REFERENCE_AXIS_ID = 'dynamicReference'
const SAMPLE_SIZE_LABEL = '样本量'
const SAMPLE_SIZE_COLOR = 'rgba(104, 110, 120, 0.62)'
const MANUAL_REFERENCE_COLOR = '#dc2626'
const DYNAMIC_REFERENCE_LABEL = 'COFECHA-pass'
const DYNAMIC_REFERENCE_COLOR = 'rgba(35, 99, 68, 0.9)'
const MISSING_RING_COLOR = '#2ecc71'

export type ChartDiagnosisEventRange = {
  id: string
  tree: string
  eventType: Exclude<DiagnosisEventType, 'wholeSeriesMove'>
  startYear: number
  endYear: number
}

const DIAGNOSIS_EVENT_COLORS: Record<ChartDiagnosisEventRange['eventType'], { fill: string; stroke: string }> = {
  missingRing: { fill: 'rgba(54, 137, 69, 0.12)', stroke: 'rgba(54, 137, 69, 0.58)' },
  falseRing: { fill: 'rgba(191, 105, 34, 0.11)', stroke: 'rgba(170, 80, 20, 0.58)' },
  partialMove: { fill: 'rgba(47, 105, 168, 0.10)', stroke: 'rgba(47, 105, 168, 0.55)' },
}

// Y 轴视觉缩放（Shift + 滚轮）：只缩放 Y 轴显示范围，不改变原始数据/年份/算法结果。
// 倍率 M = 基准范围 / 当前显示范围；每档 ±0.1，限制在 [MIN, MAX]。
// 下限为 1（只放大，不缩到比数据范围更大），保证显示窗口始终落在 [yMin, yMax] 内、与上下平移边界一致。
const Y_VISUAL_SCALE_MIN = 1
const Y_VISUAL_SCALE_MAX = 8
const Y_VISUAL_SCALE_STEP = 0.1

function formatVisualScale(scale: number) {
  return scale % 1 === 0 ? `${scale}` : scale.toFixed(scale < 10 ? 1 : 0)
}

type XAxisLabel = {
  index: number
  label: string
  tickX: number
  textX: number
  left: number
  right: number
  align: CanvasTextAlign
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1)
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// 返回 dataIndex 附近用于命中检测的折线段（用索引对表示）。
// 紧邻两段与原逻辑一致（端点为 null 由调用方跳过）；仅当该列本身是缺口（缺失年轮）时，
// 额外补一段跨过缺口、连接两侧最近有效点的桥接段，使绿色桥接线也能被点击/悬停命中。
// 不向端点方向远距离延伸，避免在折线端点附近误命中（否则会抢占放置标记线的空白点击）。
function lineSegmentsNearIndex(data: Array<number | null | unknown>, index: number): [number, number][] {
  const segments: [number, number][] = []

  if (index - 1 >= 0) segments.push([index - 1, index])
  if (index + 1 < data.length) segments.push([index, index + 1])

  if (data[index] == null) {
    let left = index - 1
    while (left >= 0 && data[left] == null) left--
    let right = index + 1
    while (right < data.length && data[right] == null) right++
    if (left >= 0 && right < data.length) segments.push([left, right])
  }

  return segments
}

function getNiceYearStep(rawStep: number) {
  const normalizedStep = Math.max(1, rawStep)
  return NICE_YEAR_STEPS.find((step) => step >= normalizedStep) ?? NICE_YEAR_STEPS[NICE_YEAR_STEPS.length - 1]
}

function drawGridLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  lineWidth: number,
  dash: number[] = []
) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.lineCap = dash.length > 0 ? 'round' : 'butt'
  ctx.setLineDash(dash)
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  ctx.restore()
}

function makeXAxisLabel(
  ctx: CanvasRenderingContext2D,
  chartArea: ChartJSInstance<'line'>['chartArea'],
  index: number,
  label: string,
  tickX: number
): XAxisLabel {
  const width = ctx.measureText(label).width
  const textX = clamp(tickX, chartArea.left + width / 2, chartArea.right - width / 2)
  const align: CanvasTextAlign = 'center'
  const left =
    textX - width / 2
  const right =
    textX + width / 2

  return { index, label, tickX, textX, left, right, align }
}

function getVisibleXAxisLabels(chart: ChartJSInstance<'line'>): XAxisLabel[] {
  const { chartArea, ctx, data, scales } = chart
  const xScale = scales.x
  const labels = data.labels ?? []
  if (!xScale || labels.length === 0 || chartArea.right <= chartArea.left) return []

  const firstIndex = clamp(Math.ceil(Number(xScale.min)), 0, labels.length - 1)
  const lastIndex = clamp(Math.floor(Number(xScale.max)), 0, labels.length - 1)
  if (firstIndex > lastIndex) return []

  const firstYear = Number(labels[firstIndex])
  const lastYear = Number(labels[lastIndex])
  if (!Number.isFinite(firstYear) || !Number.isFinite(lastYear)) return []

  const maxLabelCount = Math.max(2, Math.floor((chartArea.right - chartArea.left) / X_TICK_TARGET_SPACING_PX))
  const yearStep = getNiceYearStep(Math.abs(lastYear - firstYear) / maxLabelCount)
  const candidateIndexes = new Set<number>()

  for (let index = firstIndex; index <= lastIndex; index++) {
    const year = Number(labels[index])
    if (Number.isFinite(year) && year % yearStep === 0) {
      candidateIndexes.add(index)
    }
  }

  if (candidateIndexes.size === 0) {
    candidateIndexes.add(firstIndex)
    if (firstIndex !== lastIndex) {
      candidateIndexes.add(lastIndex)
    }
  }

  ctx.save()
  ctx.font = `13px ${CHART_FONT_FAMILY}`

  const candidates = Array.from(candidateIndexes)
    .sort((a, b) => a - b)
    .map((index) => {
      const label = String(labels[index])
      const x = xScale.getPixelForValue(index)
      return makeXAxisLabel(ctx, chartArea, index, label, x)
    })

  ctx.restore()

  const accepted: XAxisLabel[] = []

  candidates.forEach((candidate) => {
    const previous = accepted[accepted.length - 1]
    if (!previous || candidate.left >= previous.right + X_TICK_LABEL_GAP_PX) {
      accepted.push(candidate)
    }
  })

  return accepted
}

const fixedChartAreaPlugin: Plugin<'line'> = {
  id: 'fixedChartArea',
  afterLayout(chart) {
    const { chartArea, scales, width } = chart
    const sampleSizeScale = scales[SAMPLE_SIZE_AXIS_ID]
    const showSampleAxis = Boolean(sampleSizeScale?.options.display)
    const rightMargin = SAMPLE_SIZE_AXIS_WIDTH
    const right = Math.max(0, width - rightMargin)
    const left = Math.min(Y_AXIS_WIDTH, Math.max(0, right - MIN_CHART_AREA_WIDTH))
    const chartAreaWidth = right - left

    chartArea.left = left
    chartArea.right = right
    chartArea.width = chartAreaWidth

    const xScale = scales.x
    if (xScale) {
      xScale.left = left
      xScale.right = right
      xScale.width = chartAreaWidth
      xScale.configure()
    }

    const yScale = scales.y
    if (yScale) {
      yScale.left = 0
      yScale.right = left
      yScale.width = left
      yScale.top = chartArea.top
      yScale.bottom = chartArea.bottom
      yScale.height = chartArea.bottom - chartArea.top
      yScale.configure()
    }

    if (sampleSizeScale) {
      sampleSizeScale.left = right
      sampleSizeScale.right = showSampleAxis ? Math.max(right, width - CHART_AREA_RIGHT_PADDING) : right
      sampleSizeScale.width = sampleSizeScale.right - sampleSizeScale.left
      sampleSizeScale.top = chartArea.top
      sampleSizeScale.bottom = chartArea.bottom
      sampleSizeScale.height = chartArea.bottom - chartArea.top
      sampleSizeScale.configure()
    }
  }
}

const referenceGridPlugin: Plugin<'line'> = {
  id: 'referenceGrid',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, data, scales } = chart
    const xScale = scales.x
    const yScale = scales.y
    if (!xScale || !yScale) return

    const labels = data.labels ?? []
    const xMin = Math.max(0, Math.floor(Number(xScale.min)) - 1)
    const xMax = Math.min(labels.length - 1, Math.ceil(Number(xScale.max)) + 1)
    const nextPixel = xMin < labels.length - 1 ? xScale.getPixelForValue(xMin + 1) : null
    const minorXSpacing = nextPixel == null ? 0 : Math.abs(nextPixel - xScale.getPixelForValue(xMin))
    const drawMinorX = minorXSpacing >= MIN_MINOR_GRID_SPACING_PX

    ctx.save()
    ctx.beginPath()
    ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top)
    ctx.clip()

    for (let index = xMin; index <= xMax; index++) {
      const label = labels[index]
      const year = Number(label)
      if (!Number.isFinite(year)) continue

      const x = xScale.getPixelForValue(index)
      if (x < chartArea.left || x > chartArea.right) continue

      const isMajor = year % X_GRID_MAJOR_YEAR_STEP === 0
      if (isMajor) {
        drawGridLine(ctx, x, chartArea.top, x, chartArea.bottom, GRID_MAJOR_COLOR, 1)
      } else if (drawMinorX) {
        drawGridLine(ctx, x, chartArea.top, x, chartArea.bottom, GRID_MINOR_COLOR, 1, GRID_MINOR_DASH)
      }
    }

    const majorYValues = yScale.ticks
      .map((tick) => Number(tick.value))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b)

    for (let i = 0; i < majorYValues.length - 1; i++) {
      const start = majorYValues[i]
      const end = majorYValues[i + 1]
      const step = (end - start) / Y_GRID_MINOR_DIVISIONS

      for (let j = 1; j < Y_GRID_MINOR_DIVISIONS; j++) {
        const y = yScale.getPixelForValue(start + step * j)
        if (y < chartArea.top || y > chartArea.bottom) continue
        drawGridLine(ctx, chartArea.left, y, chartArea.right, y, GRID_MINOR_COLOR, 1, GRID_MINOR_DASH)
      }
    }

    majorYValues.forEach((value) => {
      const y = yScale.getPixelForValue(value)
      if (y < chartArea.top || y > chartArea.bottom) return
      drawGridLine(ctx, chartArea.left, y, chartArea.right, y, GRID_MAJOR_COLOR, 1)
    })

    ctx.restore()
  }
}

const xAxisLabelsPlugin: Plugin<'line'> = {
  id: 'xAxisLabels',
  afterDraw(chart) {
    const { ctx, chartArea } = chart
    const labels = getVisibleXAxisLabels(chart)
    if (labels.length === 0) return

    ctx.save()
    ctx.strokeStyle = '#111'
    ctx.fillStyle = '#333'
    ctx.lineWidth = 1.5
    ctx.font = `13px ${CHART_FONT_FAMILY}`
    ctx.textBaseline = 'top'

    labels.forEach((label) => {
      drawGridLine(ctx, label.tickX, chartArea.bottom, label.tickX, chartArea.bottom - X_AXIS_TICK_LENGTH, '#111', 2)

      ctx.textAlign = label.align
      ctx.fillText(label.label, label.textX, chartArea.bottom + X_AXIS_LABEL_Y_OFFSET)
    })

    ctx.fillStyle = '#222'
    ctx.font = `bold 15px ${CHART_FONT_FAMILY}`
    ctx.textAlign = 'center'
    ctx.fillText('Years', (chartArea.left + chartArea.right) / 2, chartArea.bottom + X_AXIS_TITLE_Y_OFFSET)
    ctx.restore()
  }
}

const chartBoxBorderPlugin: Plugin<'line'> = {
  id: 'chartBoxBorder',
  afterDraw(chart) {
    const { ctx, chartArea } = chart
    ctx.save()
    ctx.strokeStyle = '#111111'
    ctx.lineWidth = 1.5
    ctx.strokeRect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top)
    ctx.restore()
  }
}

type DiagnosisEventBandsState = {
  ranges: readonly ChartDiagnosisEventRange[]
  highlightedTree: string | null
}

function makeDiagnosisEventBandsPlugin(): Plugin<'line'> & DiagnosisEventBandsState {
  return {
    id: 'diagnosisEventBands',
    ranges: [],
    highlightedTree: null,

    beforeDatasetsDraw(chart) {
      const visibleRanges = this.highlightedTree
        ? this.ranges.filter((range) => range.tree === this.highlightedTree)
        : this.ranges
      if (visibleRanges.length === 0) return

      const { ctx, chartArea, data, scales } = chart
      const xScale = scales.x
      if (!xScale) return
      const yearToIndex = new Map<number, number>()
      data.labels?.forEach((label, index) => yearToIndex.set(Number(label), index))

      ctx.save()
      ctx.beginPath()
      ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top)
      ctx.clip()

      visibleRanges.forEach((range) => {
        const startIndex = yearToIndex.get(range.startYear)
        const endIndex = yearToIndex.get(range.endYear)
        if (startIndex === undefined || endIndex === undefined) return
        const startX = xScale.getPixelForValue(startIndex)
        const endX = xScale.getPixelForValue(endIndex)
        const previousX = startIndex > 0 ? xScale.getPixelForValue(startIndex - 1) : startX
        const nextX = endIndex < (data.labels?.length ?? 0) - 1
          ? xScale.getPixelForValue(endIndex + 1)
          : endX
        const left = startIndex > 0 ? (previousX + startX) / 2 : chartArea.left
        const right = endIndex < (data.labels?.length ?? 0) - 1
          ? (endX + nextX) / 2
          : chartArea.right
        const colors = DIAGNOSIS_EVENT_COLORS[range.eventType]

        ctx.fillStyle = colors.fill
        ctx.fillRect(left, chartArea.top, Math.max(1, right - left), chartArea.bottom - chartArea.top)
        ctx.strokeStyle = colors.stroke
        ctx.lineWidth = 1
        ctx.setLineDash([4, 3])
        ctx.strokeRect(left, chartArea.top, Math.max(1, right - left), chartArea.bottom - chartArea.top)
      })

      ctx.restore()
    },
  }
}

// 持久化 tooltip 插件：在 canvas 上手绘，鼠标离开后保持显示。
// 超过 MAX_ROWS_SINGLE_COL 行时自动切换为双列布局。
export function makePersistentTooltipPlugin(): Plugin<'line'> & { activeIndex: number | null } {
  return {
    id: 'persistentTooltip',
    activeIndex: null,

    afterEvent(chart, args) {
      const e = args.event
      if (e.type === 'mousemove' && e.x != null) {
        const xScale = chart.scales['x']
        const idx = xScale.getValueForPixel(e.x)
        if (idx != null && idx >= 0 && idx < chart.data.labels!.length) {
          this.activeIndex = Math.round(idx)
          chart.draw()
        }
      }
    },

    afterDraw(chart) {
      const idx = this.activeIndex
      if (idx == null) return
      if (chart.data.datasets.length > TOOLTIP_MAX_SERIES) return

      const { ctx, data, chartArea } = chart
      const label = data.labels?.[idx] as string | undefined
      if (!label) return

      // 收集当前索引下所有有效数据行
      type Row = { color: string; name: string; value: string }
      const rows: Row[] = []
      data.datasets.forEach((ds) => {
        if (ds.yAxisID === SAMPLE_SIZE_AXIS_ID) return
        const raw = ds.data[idx]
        if (raw == null) return
        const referenceMeta = ds as {
          referenceDepth?: Array<number | null>
          referenceSd?: Array<number | null>
          referenceSe?: Array<number | null>
          referenceActual?: Array<number | null>
          referenceDisplayScaled?: boolean
          referenceMode?: ReferenceSeries['mode']
        }
        const referenceDepth = referenceMeta.referenceDepth?.[idx]
        const referenceSd = referenceMeta.referenceSd?.[idx]
        const referenceSe = referenceMeta.referenceSe?.[idx]
        const referenceActual = referenceMeta.referenceActual?.[idx]
        const value = typeof raw === 'number'
          ? referenceMeta.referenceMode === 'dynamic'
            ? `${(referenceActual ?? raw).toFixed(3)}${referenceDepth != null ? ` (n=${referenceDepth}` : ''}${referenceSd != null ? `, sd=${referenceSd.toFixed(3)}` : ''}${referenceSe != null ? `, se=${referenceSe.toFixed(3)}` : ''}${referenceDepth != null ? ')' : ''}${referenceMeta.referenceDisplayScaled ? ' · 已按宽度轴缩放显示' : ''}`
            : `${Math.round(raw)}${referenceDepth != null ? ` (n=${referenceDepth})` : ''}`
          : String(raw)
        const name = (ds.label ?? '').slice(0, MAX_LABEL_CHARS)
        const color = ds.borderColor as string
        rows.push({ color, name, value })
      })
      if (rows.length === 0) return

      const preferredY = chartArea.top + 8
      const availableRowH = Math.max(LINE_H, chartArea.bottom - preferredY - 4 - PAD - LINE_H - 4 - PAD)
      const maxRowsPerCol = Math.floor(availableRowH / LINE_H)
      // 基于总序列数计算列数，避免悬停不同年份时列数变化导致宽度跳动
      const colCount = Math.max(1, Math.ceil(chart.data.datasets.length / maxRowsPerCol))
      const rowsPerCol = Math.ceil(rows.length / colCount)

      // 测量每列最宽的 label + value
      ctx.save()
      ctx.font = FONT_BOLD
      const valueReservedW = ctx.measureText('0000').width
      ctx.font = FONT
      let colWidth = 0
      rows.forEach(r => {
        const nameW = ctx.measureText(`${r.name}  `).width
        ctx.font = FONT_BOLD
        const valueW = Math.max(ctx.measureText(r.value).width, valueReservedW)
        ctx.font = FONT
        const w = nameW + valueW
        if (w > colWidth) colWidth = w
      })
      const contentW = SWATCH_W + SWATCH_GAP + colWidth
      const totalW = PAD * 2 + contentW * colCount + COL_GAP * (colCount - 1)

      ctx.font = FONT_BOLD
      const titleW = ctx.measureText(label).width
      const boxW = Math.max(totalW, titleW + PAD * 2)
      const boxH = PAD + LINE_H + 4 + rowsPerCol * LINE_H + PAD

      const x = chartArea.right - boxW - 8
      const tooltipY = Math.max(chartArea.top + 4, Math.min(preferredY, chartArea.bottom - boxH - 4))

      // 白色背景框
      ctx.fillStyle = 'rgba(255,255,255,0.95)'
      ctx.strokeStyle = '#aaaaaa'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(x, tooltipY, boxW, boxH, 3)
      ctx.fill()
      ctx.stroke()

      // 标题（年份）
      ctx.fillStyle = '#111111'
      ctx.font = FONT_BOLD
      ctx.textBaseline = 'top'
      ctx.fillText(label, x + PAD, tooltipY + PAD)

      // 分隔线
      const divY = tooltipY + PAD + LINE_H + 2
      ctx.strokeStyle = '#dddddd'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x + PAD, divY)
      ctx.lineTo(x + boxW - PAD, divY)
      ctx.stroke()

      // 数据行
      ctx.font = FONT
      rows.forEach((row, i) => {
        const col = colCount > 1 ? Math.floor(i / rowsPerCol) : 0
        const rowInCol = colCount > 1 ? i % rowsPerCol : i
        const rx = x + PAD + col * (contentW + COL_GAP)
        const ry = divY + 4 + rowInCol * LINE_H

        // 色块
        ctx.fillStyle = row.color
        ctx.fillRect(rx, ry + (LINE_H - SWATCH_H) / 2, SWATCH_W, SWATCH_H)

        // label
        ctx.fillStyle = '#333333'
        ctx.textBaseline = 'top'
        ctx.fillText(row.name, rx + SWATCH_W + SWATCH_GAP, ry)

        // value（右对齐到该列末）
        ctx.fillStyle = '#111111'
        ctx.font = FONT_BOLD
        const valueX = rx + contentW
        ctx.textAlign = 'right'
        ctx.fillText(row.value, valueX, ry)
        ctx.textAlign = 'left'
        ctx.font = FONT
      })

      ctx.restore()
    }
  }
}

function makeMarkerLinesPlugin(): Plugin<'line'> & { markerYear: number | null } {
  return {
    id: 'markerLines',
    markerYear: null,

    afterDatasetsDraw(chart) {
      if (this.markerYear == null) return
      const { ctx, chartArea, data, scales } = chart
      const xScale = scales.x
      if (!xScale) return
      const markerIndex = data.labels?.findIndex((label) => Number(label) === this.markerYear) ?? -1
      if (markerIndex < 0) return

      const x = xScale.getPixelForValue(markerIndex)
      ctx.save()
      ctx.beginPath()
      ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top)
      ctx.clip()
      ctx.strokeStyle = '#444444'
      ctx.lineWidth = 1.5
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(x, chartArea.top)
      ctx.lineTo(x, chartArea.bottom)
      ctx.stroke()
      ctx.restore()
    },

    afterDraw(chart) {
      if (this.markerYear == null) return
      const { ctx, chartArea, scales, data } = chart
      const xScale = scales.x
      if (!xScale) return
      const markerIndex = data.labels?.findIndex((label) => Number(label) === this.markerYear) ?? -1
      if (markerIndex < 0) return

      const label = data.labels?.[markerIndex] as string | undefined
      if (!label) return

      const x = xScale.getPixelForValue(markerIndex)
      ctx.save()
      ctx.font = `bold 13px ${CHART_FONT_FAMILY}`
      const metrics = ctx.measureText(label)
      const padX = 6
      const padY = 3
      const pillW = metrics.width + padX * 2
      const pillH = 13 + padY * 2
      const pillX = clamp(x - pillW / 2, chartArea.left, chartArea.right - pillW)
      const pillY = chartArea.top - pillH - 4

      ctx.fillStyle = '#444444'
      ctx.beginPath()
      ctx.roundRect(pillX, pillY, pillW, pillH, 3)
      ctx.fill()

      ctx.fillStyle = '#ffffff'
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'center'
      ctx.fillText(label, pillX + pillW / 2, pillY + (pillH + metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2)
      ctx.restore()
    }
  }
}

// 缺失年轮（插入的 0 值）标记插件：0 宽度的年份不在折线上绘制（表现为断点），
// 用绿色线段跨过该断点、连接断点两侧的相邻点，使其落在对应折线的高度上，
// 从而清楚标识是哪条折线的缺失年轮。高亮某条折线时，其它折线的标记会变淡。
type MissingRingState = {
  byTree: ReadonlyMap<string, readonly number[]>
  highlightedTree: string | null
  enabled: boolean
}

function makeMissingRingLinesPlugin(): Plugin<'line'> & MissingRingState {
  return {
    id: 'missingRingLines',
    byTree: new Map(),
    highlightedTree: null,
    enabled: true,

    afterDatasetsDraw(chart) {
      if (!this.enabled || this.byTree.size === 0) return
      const { ctx, chartArea, data, scales } = chart
      const xScale = scales.x
      const yScale = scales.y
      if (!xScale || !yScale) return

      const labels = data.labels ?? []
      const yearToIndex = new Map<number, number>()
      labels.forEach((label, index) => yearToIndex.set(Number(label), index))

      ctx.save()
      ctx.beginPath()
      ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top)
      ctx.clip()
      ctx.lineWidth = 2
      ctx.setLineDash([])

      data.datasets.forEach((ds) => {
        const years = this.byTree.get(ds.label ?? '')
        if (!years) return
        const isDim = this.highlightedTree != null && ds.label !== this.highlightedTree
        ctx.strokeStyle = isDim ? MISSING_RING_COLOR + '55' : MISSING_RING_COLOR

        years.forEach((year) => {
          const idx = yearToIndex.get(year)
          if (idx == null) return

          // 向两侧寻找最近的有效相邻点（连续缺轮时可能不止相邻一格）。
          let left = idx - 1
          while (left >= 0 && ds.data[left] == null) left--
          let right = idx + 1
          while (right < ds.data.length && ds.data[right] == null) right++

          const leftValue = ds.data[left]
          const rightValue = ds.data[right]

          if (left >= 0 && right < ds.data.length && leftValue != null && rightValue != null) {
            // 用绿色线段跨过断点连接两侧的点。
            ctx.beginPath()
            ctx.moveTo(xScale.getPixelForValue(left), yScale.getPixelForValue(leftValue as number))
            ctx.lineTo(xScale.getPixelForValue(right), yScale.getPixelForValue(rightValue as number))
            ctx.stroke()
          } else {
            // 折线端点处缺轮、无法连接时，退化为一条短竖线标记。
            const x = xScale.getPixelForValue(idx)
            if (x < chartArea.left || x > chartArea.right) return
            ctx.beginPath()
            ctx.moveTo(x, chartArea.top)
            ctx.lineTo(x, chartArea.bottom)
            ctx.stroke()
          }
        })
      })

      ctx.restore()
    }
  }
}

// 左上角年份指示插件：鼠标悬停时在图表左上角显示当前年份，样式与 tooltip 年份一致。
function makeYearIndicatorPlugin(): Plugin<'line'> & { activeIndex: number | null } {
  return {
    id: 'yearIndicator',
    activeIndex: null,

    afterEvent(chart, args) {
      const e = args.event
      if (e.type === 'mousemove' && e.x != null) {
        const xScale = chart.scales['x']
        const idx = xScale.getValueForPixel(e.x)
        if (idx != null && idx >= 0 && idx < chart.data.labels!.length) {
          this.activeIndex = Math.round(idx)
          chart.draw()
        }
      }
    },

    afterDraw(chart) {
      const idx = this.activeIndex
      if (idx == null) return

      const { ctx, data, chartArea } = chart
      const label = data.labels?.[idx] as string | undefined
      if (!label) return

      ctx.save()
      ctx.font = FONT_BOLD
      ctx.fillStyle = '#111111'
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      ctx.fillText(label, chartArea.left + 6, chartArea.top + 6)
      ctx.restore()
    }
  }
}

type Props = {
  data: Map<string, Map<number, number>>
  seriesColors?: ReadonlyMap<string, string>
  diagnosisEventRanges?: readonly ChartDiagnosisEventRange[]
  missingRingYears?: ReadonlyMap<string, readonly number[]>
  sampleSizeData?: ReadonlyMap<string, ReadonlyMap<number, number | null>>
  referenceSeries?: ReferenceSeries | null
  dynamicReferenceSeries?: ReferenceSeries | null
  showDynamicReference?: boolean
  showPersistentTooltip?: boolean
  hoverSimulation?: LocalCrossdatingSimulation | null
  highlightedTreeCode?: string | null
  onHighlightedTreeCodeChange?: (treeCode: string | null) => void
  onLinePointClick?: (target: { tree: string; year: number }) => void
  onHoverTargetChange?: (target: { tree: string; year: number } | null) => void
  onJumpToWidth?: (tree: string, year: number) => void
  onEditAsText?: (tree: string) => void
  onJumpToCofecha?: (tree: string) => void
  cofechaPart6Trees?: readonly string[]
  jumpTarget?: ChartJumpTarget | null
  zoomWindow?: { min: number; max: number } | null
  onZoomWindowChange?: (zoomWindow: { min: number; max: number } | null) => void
  onShiftHighlightedTree?: (treeCode: string, direction: -1 | 1) => void
  onInsertMissingYearAtSide?: (tree: string, year: number, side: MissingInsertSide) => void
  onDeleteYearWithMode?: (tree: string, year: number, mode: DeleteMode, shift?: DeleteShift) => void
  onMoveWholeSeries: (tree: string, direction: WholeSeriesMoveDirection, yearCount: number) => void
  onMoveOlderSide: (tree: string, firstFixedYear: number, yearCount: number) => void
  onDeleteSeries?: (tree: string) => void
}

export type ChartZoomWindow = {
  min: number
  max: number
} | null

export const colorPalette = [
  '#2563eb', '#2e6da4', '#27825a', '#7d3c98', '#b9621e',
  '#1a7a7a', '#7a4a1e', '#4a3a8a', '#6a7a2a', '#0088a9',
  '#2a5a7a', '#7a2a5a', '#3a6a2a', '#5b5bd6', '#2a4a8a',
  '#6a5a1e', '#3a2a6a', '#5a7a3a', '#39796b', '#2a6a5a',
]

const CHART_FONT_FAMILY = "'Arial', 'Helvetica', sans-serif"

export function MultiLineChart({
  data,
  seriesColors,
  diagnosisEventRanges = [],
  missingRingYears,
  sampleSizeData,
  referenceSeries,
  dynamicReferenceSeries,
  showDynamicReference = false,
  showPersistentTooltip = false,
  hoverSimulation,
  highlightedTreeCode = null,
  onHighlightedTreeCodeChange,
  onLinePointClick,
  onHoverTargetChange,
  onJumpToWidth,
  onEditAsText,
  onJumpToCofecha,
  cofechaPart6Trees = [],
  jumpTarget = null,
  zoomWindow = null,
  onZoomWindowChange,
  onShiftHighlightedTree,
  onInsertMissingYearAtSide,
  onDeleteYearWithMode,
  onMoveWholeSeries,
  onMoveOlderSide,
  onDeleteSeries,
}: Props) {
  const chartRef = useRef<ChartJSInstance<'line'> | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const isDragged = useRef(false)
  // Y 轴视觉缩放窗口（Shift + 滚轮）：仅改变 Y 轴显示范围，不改原始数据/年份/算法结果。null 表示自动范围。
  const [yViewWindow, setYViewWindow] = useState<{ min: number; max: number } | null>(null)
  const tooltipPlugin = useMemo(() => makePersistentTooltipPlugin(), [])
  const yearIndicatorPlugin = useMemo(() => makeYearIndicatorPlugin(), [])
  const markerLinesPlugin = useMemo(() => makeMarkerLinesPlugin(), [])
  const missingRingLinesPlugin = useMemo(() => makeMissingRingLinesPlugin(), [])
  const diagnosisEventBandsPlugin = useMemo(() => makeDiagnosisEventBandsPlugin(), [])
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tree: string; year: number } | null>(null)
  const [hoverPoint, setHoverPoint] = useState<{ x: number; y: number; tree: string; year: number } | null>(null)
  const [showSampleSize, setShowSampleSize] = useState(true)
  const [lineHoverable, setLineHoverable] = useState(false)
  const treeCodes = useMemo(() => Array.from(data.keys()), [data])
  const cofechaPart6TreeSet = useMemo(() => new Set(
    cofechaPart6Trees.map(normalizeCofechaSeriesId),
  ), [cofechaPart6Trees])
  const highlightedIndex = highlightedTreeCode ? treeCodes.indexOf(highlightedTreeCode) : -1
  const visibleDynamicReferenceSeries = showDynamicReference ? dynamicReferenceSeries : null

  const emitZoomWindow = useCallback((chart: ChartJSInstance<'line'> | ChartJS | null = chartRef.current) => {
    if (!chart || !onZoomWindowChange) return
    const scale = chart.scales['x']
    const min = Number(scale.min)
    const max = Number(scale.max)

    // 图表已处于目标缩放状态，标记跳过回传引起的二次套用。
    skipZoomRestoreRef.current = true

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      onZoomWindowChange(null)
      return
    }

    onZoomWindowChange({ min, max })
  }, [onZoomWindowChange])

  // 汇总所有年份，用作图表横轴。
  const allYears = useMemo(() => {
    let minYear = Infinity
    let maxYear = -Infinity
    data.forEach(yearMap => {
      yearMap.forEach((_, year) => {
        if (year < minYear) minYear = year
        if (year > maxYear) maxYear = year
      })
    })
    referenceSeries?.data.forEach((_, year) => {
      if (year < minYear) minYear = year
      if (year > maxYear) maxYear = year
    })
    visibleDynamicReferenceSeries?.data.forEach((_, year) => {
      if (year < minYear) minYear = year
      if (year > maxYear) maxYear = year
    })
    if (jumpTarget && Number.isFinite(jumpTarget.year)) {
      if (jumpTarget.year < minYear) minYear = jumpTarget.year
      if (jumpTarget.year > maxYear) maxYear = jumpTarget.year
    }
    if (!Number.isFinite(minYear)) return []
    // 两端各扩展若干空年份，使折线端点不贴在 Y 轴上（这些年份无数据，取值为 null）
    const pad = Math.max(
      X_AXIS_MIN_PADDING_YEARS,
      Math.round((maxYear - minYear) * X_AXIS_VIEW_PADDING_RATIO),
    )
    const years: number[] = []
    for (let y = minYear - pad; y <= maxYear + pad; y++) years.push(y)
    return years
  }, [data, jumpTarget, referenceSeries, visibleDynamicReferenceSeries])

  const sampleSize = useMemo(() => {
    let max = 0
    const coverageData = sampleSizeData ?? data
    const counts = allYears.map((year) => {
      let count = 0
      coverageData.forEach((yearMap) => {
        const value = yearMap.get(year)
        if (
          typeof value === 'number'
          && Number.isFinite(value)
          && value >= 0
          && value !== stopMarker.value
        ) {
          count += 1
        }
      })
      if (count > max) max = count
      return count
    })

    return { counts, max }
  }, [allYears, data, sampleSizeData])

  const referenceDisplayData = useMemo(() => (
    referenceSeries?.data ?? null
  ), [referenceSeries])
  const hasWidthAxisData = data.size > 0 || Boolean(referenceDisplayData?.size)
  const dynamicReferenceUsesWidthAxis = Boolean(visibleDynamicReferenceSeries && !hasWidthAxisData)

  // 构造 Chart.js datasets。
  const datasets: ChartData<'line'>['datasets'] = useMemo(() => {
    const nextDatasets: ChartData<'line'>['datasets'] = []
    let colorIndex = 0

    data.forEach((yearMap, treeCode) => {
      const yData = allYears.map(year => yearMap.get(year) ?? null)
      const color = seriesColors?.get(treeCode) ?? colorPalette[colorIndex % colorPalette.length]
      const isHighlighted = colorIndex === highlightedIndex
      const transparentColor = color + '99'
      nextDatasets.push({
        label: treeCode,
        data: yData,
        borderColor: highlightedIndex === -1 || isHighlighted ? color : transparentColor,
        backgroundColor: color,
        fill: false,
        borderWidth: highlightedIndex === -1 || isHighlighted ? 2 : 1,
        tension: 0.008,
        cubicInterpolationMode: 'default',
        pointRadius: 0,
        pointHoverRadius: 2,
        pointHitRadius: 8,
      })
      colorIndex++
    })

    if (referenceSeries && referenceSeries.data.size > 0) {
      nextDatasets.push({
        label: referenceSeries.label,
        data: allYears.map(year => referenceDisplayData?.get(year) ?? referenceSeries.data.get(year) ?? null),
        borderColor: MANUAL_REFERENCE_COLOR,
        backgroundColor: MANUAL_REFERENCE_COLOR,
        fill: false,
        borderWidth: 3.25,
        spanGaps: false,
        tension: 0.008,
        cubicInterpolationMode: 'default',
        pointRadius: 0,
        pointHoverRadius: 0,
        pointHitRadius: 0,
        order: -20,
        referenceDepth: allYears.map(year => referenceSeries.sampleDepth.get(year) ?? null),
        referenceSd: allYears.map(year => referenceSeries.sdByYear?.get(year) ?? null),
        referenceSe: allYears.map(year => referenceSeries.seByYear?.get(year) ?? null),
        referenceActual: allYears.map(year => referenceSeries.data.get(year) ?? null),
        referenceDisplayScaled: referenceSeries.mode === 'dynamic' && referenceDisplayData !== referenceSeries.data,
        referenceMode: referenceSeries.mode,
        isReferenceDataset: true,
      } as ChartData<'line'>['datasets'][number] & {
        referenceDepth: Array<number | null>
        referenceSd: Array<number | null>
        referenceSe: Array<number | null>
        referenceActual: Array<number | null>
        referenceDisplayScaled: boolean
        referenceMode: ReferenceSeries['mode']
        isReferenceDataset: boolean
      })
    }

    if (visibleDynamicReferenceSeries && visibleDynamicReferenceSeries.data.size > 0) {
      nextDatasets.push({
        label: DYNAMIC_REFERENCE_LABEL,
        data: allYears.map(year => visibleDynamicReferenceSeries.data.get(year) ?? null),
        yAxisID: dynamicReferenceUsesWidthAxis ? undefined : DYNAMIC_REFERENCE_AXIS_ID,
        borderColor: DYNAMIC_REFERENCE_COLOR,
        backgroundColor: DYNAMIC_REFERENCE_COLOR,
        fill: false,
        borderWidth: 2,
        borderDash: [6, 4],
        spanGaps: false,
        tension: 0.008,
        cubicInterpolationMode: 'default',
        pointRadius: 0,
        pointHoverRadius: 0,
        pointHitRadius: 0,
        order: -15,
        referenceDepth: allYears.map(year => visibleDynamicReferenceSeries.sampleDepth.get(year) ?? null),
        referenceSd: allYears.map(year => visibleDynamicReferenceSeries.sdByYear?.get(year) ?? null),
        referenceSe: allYears.map(year => visibleDynamicReferenceSeries.seByYear?.get(year) ?? null),
        referenceActual: allYears.map(year => visibleDynamicReferenceSeries.data.get(year) ?? null),
        referenceDisplayScaled: false,
        referenceMode: visibleDynamicReferenceSeries.mode,
        isReferenceDataset: true,
      } as ChartData<'line'>['datasets'][number] & {
        referenceDepth: Array<number | null>
        referenceSd: Array<number | null>
        referenceSe: Array<number | null>
        referenceActual: Array<number | null>
        referenceDisplayScaled: boolean
        referenceMode: ReferenceSeries['mode']
        isReferenceDataset: boolean
      })
    }

    if (showSampleSize && sampleSize.counts.length > 0) {
      nextDatasets.push({
        label: SAMPLE_SIZE_LABEL,
        data: sampleSize.counts,
        yAxisID: SAMPLE_SIZE_AXIS_ID,
        borderColor: SAMPLE_SIZE_COLOR,
        backgroundColor: SAMPLE_SIZE_COLOR,
        fill: false,
        borderWidth: 1.25,
        borderDash: [6, 5],
        tension: 0,
        pointRadius: 0,
        pointHoverRadius: 0,
        pointHitRadius: 0,
        order: 10,
      })
    }

    return nextDatasets
  }, [allYears, data, dynamicReferenceUsesWidthAxis, highlightedIndex, referenceDisplayData, referenceSeries, sampleSize, seriesColors, showSampleSize, visibleDynamicReferenceSeries])

  // 记忆化 chartData，避免每次渲染（含鼠标移动）都生成新引用导致 react-chartjs-2 重复 update 卡顿。
  const chartData: ChartData<'line'> = useMemo(() => ({
    labels: allYears.map(year => year.toString()),
    datasets
  }), [allYears, datasets])

  // 将缺失年轮状态同步给插件，并触发重绘。
  useEffect(() => {
    missingRingLinesPlugin.byTree = missingRingYears ?? new Map()
    missingRingLinesPlugin.highlightedTree = highlightedTreeCode
    chartRef.current?.draw()
  }, [missingRingLinesPlugin, missingRingYears, highlightedTreeCode])

  useEffect(() => {
    diagnosisEventBandsPlugin.ranges = diagnosisEventRanges
    diagnosisEventBandsPlugin.highlightedTree = highlightedTreeCode
    chartRef.current?.draw()
  }, [diagnosisEventBandsPlugin, diagnosisEventRanges, highlightedTreeCode])

  // 键盘左右键移动当前高亮折线。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
      if (direction === 0) return

      if (!highlightedTreeCode || !data.has(highlightedTreeCode)) return

      emitZoomWindow()
      onShiftHighlightedTree?.(highlightedTreeCode, direction)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [data, emitZoomWindow, highlightedTreeCode, onShiftHighlightedTree])

  const zoomWindowRef = useRef(zoomWindow)
  useEffect(() => { zoomWindowRef.current = zoomWindow }, [zoomWindow])
  // 标记「本次 zoomWindow 变化来自图表自身缩放/平移回传」，避免再把窗口重新套回图表造成来回跳动。
  const skipZoomRestoreRef = useRef(false)
  const handledJumpIdRef = useRef<number | null>(null)

  // 数据/系列变化后，按当前缩放窗口恢复 X 轴范围。
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const scale = chart.scales['x']
    const win = zoomWindowRef.current
    scale.options.min = win?.min
    scale.options.max = win?.max
    chart.update('none')
  }, [datasets, allYears])

  // 外部修改缩放窗口（例如重置）时应用到图表；忽略由缩放/平移自身回传引起的变化。
  useEffect(() => {
    if (skipZoomRestoreRef.current) {
      skipZoomRestoreRef.current = false
      return
    }
    const chart = chartRef.current
    if (!chart) return

    const scale = chart.scales['x']
    scale.options.min = zoomWindow?.min
    scale.options.max = zoomWindow?.max
    chart.update('none')
  }, [zoomWindow])

  // 外部跳转给出的是日历年份；在拥有完整标签列表的图表层换算为 CategoryScale 索引窗口。
  useEffect(() => {
    if (
      !jumpTarget
      || handledJumpIdRef.current === jumpTarget.id
      || !onZoomWindowChange
    ) {
      return
    }

    const nextWindow = centerChartViewportOnYear(
      jumpTarget.year,
      allYears,
    )
    if (!nextWindow) return

    handledJumpIdRef.current = jumpTarget.id
    markerLinesPlugin.markerYear = jumpTarget.year
    zoomWindowRef.current = nextWindow
    skipZoomRestoreRef.current = false
    onZoomWindowChange(nextWindow)

    const chart = chartRef.current
    const scale = chart?.scales['x']
    if (chart && scale) {
      scale.options.min = nextWindow.min
      scale.options.max = nextWindow.max
      chart.update('none')
    }
  }, [allYears, jumpTarget, markerLinesPlugin, onZoomWindowChange])

  // 根据当前数据计算 Y 轴范围，给曲线留出上下边距。
  const [yMin, yMax] = useMemo(() => {
    let globalMin = Number.POSITIVE_INFINITY
    let globalMax = Number.NEGATIVE_INFINITY
    data.forEach(yearMap => {
      yearMap.forEach(value => {
        if (typeof value === 'number' && !isNaN(value)) {
          if (value < globalMin) globalMin = value
          if (value > globalMax) globalMax = value
        }
      })
    })
    referenceDisplayData?.forEach(value => {
      if (typeof value === 'number' && !isNaN(value)) {
        if (value < globalMin) globalMin = value
        if (value > globalMax) globalMax = value
      }
    })
    if (dynamicReferenceUsesWidthAxis) {
      visibleDynamicReferenceSeries?.data.forEach(value => {
        if (typeof value === 'number' && !isNaN(value)) {
          if (value < globalMin) globalMin = value
          if (value > globalMax) globalMax = value
        }
      })
    }
    if (!Number.isFinite(globalMin) || !Number.isFinite(globalMax)) {
      return [0, 1]
    }
    const yMargin = globalMax === globalMin
      ? Math.max(1, Math.abs(globalMax) * 0.1)
      : (globalMax - globalMin) * 0.1
    return [globalMin - yMargin, globalMax + yMargin]
  }, [data, dynamicReferenceUsesWidthAxis, referenceDisplayData, visibleDynamicReferenceSeries])

  // Y 轴视觉缩放窗口应用到图表（仅改 Y 轴 min/max，不动 X 轴范围，不改原始数据）。
  // 用命令式方式设置，避免把 yViewWindow 放进 memo 化的 options 而重建 options、连带重置 X 缩放。
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const yScale = chart.scales['y']
    yScale.options.min = yViewWindow?.min ?? yMin
    yScale.options.max = yViewWindow?.max ?? yMax
    chart.update('none')
  }, [yViewWindow, yMin, yMax])

  const emitZoomWindowRef = useRef(emitZoomWindow)
  useEffect(() => { emitZoomWindowRef.current = emitZoomWindow }, [emitZoomWindow])

  // 拖动平移后把图表当前 Y 范围同步回 yViewWindow（接近基准范围则视为未缩放 = null）。
  const syncYViewWindowRef = useRef<(chart: ChartJSInstance<'line'> | ChartJS) => void>(() => {})
  useEffect(() => {
    syncYViewWindowRef.current = (chart) => {
      const yScale = chart.scales['y']
      const min = Number(yScale.min)
      const max = Number(yScale.max)
      if (!Number.isFinite(min) || !Number.isFinite(max)) return
      const eps = Math.max(1e-9, (yMax - yMin) * 1e-4)
      if (Math.abs(min - yMin) <= eps && Math.abs(max - yMax) <= eps) {
        setYViewWindow(null)
      } else {
        setYViewWindow({ min, max })
      }
    }
  }, [yMin, yMax])

  const chartOptions: ChartOptions<'line'> = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    layout: {
      // 固定 chartArea 四边距，防止轴尺寸重算时边框抖动
      autoPadding: false,
      padding: { top: 25, right: 2, bottom: 0, left: 0 },
    },
    interaction: {
      mode: 'index',
      intersect: false
    },
    plugins: {
      crosshair: {
        line: { color: '#aaa', width: 1, dashPattern: [4, 4] },
        sync: { enabled: false },
        zoom: { enabled: false }
      },
      zoom: {
        limits: {
          x: {
            min: 0,
            max: Math.max(allYears.length - 1, 0),
            minRange: 1,
          },
          // Y 平移限制在数据范围内：未放大时无可平移空间，放大后只能在 [yMin, yMax] 内上下拖动。
          y: {
            min: yMin,
            max: yMax,
          },
          // 次级 Y 轴（样本量 / 动态参考）锁定在各自原始范围，'xy' 平移时不随主轴上下移动。
          [SAMPLE_SIZE_AXIS_ID]: {
            min: 'original',
            max: 'original',
          },
          [DYNAMIC_REFERENCE_AXIS_ID]: {
            min: 'original',
            max: 'original',
          },
        },
        pan: {
          enabled: true,
          // 'xy'：拖动可同时左右（X）与上下（Y）平移，与 PAST 一致；Y 仅在放大后有可移动空间。
          mode: 'xy',
          onPanStart: () => {
            isDragged.current = true;
            return undefined;
          },
          onPanComplete: ({ chart }) => {
            emitZoomWindowRef.current(chart)
            syncYViewWindowRef.current(chart)
          }
        },
        zoom: {
          wheel: { enabled: true },
          pinch: { enabled: true },
          mode: 'x',
          onZoomComplete: ({ chart }) => { emitZoomWindowRef.current(chart) }
        }
      },
      tooltip: { enabled: false },
      legend: {
        display: false,
        position: 'top',
        align: 'start',
        labels: {
          boxWidth: 32,
          boxHeight: 2,
          padding: 12,
          font: { family: CHART_FONT_FAMILY, size: 12, weight: 'bold' },
          color: '#222',
          usePointStyle: false,
        },
      }
    },
    scales: {
      x: {
        display: true,
        afterFit(scale) { scale.height = X_AXIS_HEIGHT },
        border: { display: true, color: '#111', width: 1.5 },
        grid: {
          drawOnChartArea: false,
          drawTicks: false,
          tickColor: '#111',
          tickLength: 7,
          color: GRID_MAJOR_COLOR,
          lineWidth: 1,
        },
        ticks: {
          display: false,
          font: { family: CHART_FONT_FAMILY, size: 13 },
          color: '#333',
          maxRotation: 0,
          padding: 6,
        },
        title: {
          display: false,
          text: 'Years',
          font: { family: CHART_FONT_FAMILY, size: 15, weight: 'bold' },
          color: '#222',
          padding: { top: 6 },
        },
      },
      y: {
        display: true,
        min: yMin,
        max: yMax,
        afterFit(scale) { scale.width = Y_AXIS_WIDTH },
        border: { display: true, color: '#111', width: 1.5 },
        grid: {
          drawOnChartArea: false,
          drawTicks: false,
          tickColor: '#111',
          tickLength: 7,
          color: GRID_MAJOR_COLOR,
          lineWidth: 1
        },
        ticks: {
          font: { family: CHART_FONT_FAMILY, size: 12 },
          color: '#333',
          padding: 6,
          callback: (value) => Math.round(Number(value)).toLocaleString(),
        },
        title: {
          display: true,
          text: dynamicReferenceUsesWidthAxis ? 'COFECHA-pass reference' : 'Ring width (mm)',
          font: { family: CHART_FONT_FAMILY, size: 13, weight: 'bold' },
          color: '#222',
          padding: { bottom: 6 },
        },
      },
      [SAMPLE_SIZE_AXIS_ID]: {
        type: 'linear',
        axis: 'y',
        display: showSampleSize,
        position: 'right',
        min: 0,
        max: Math.max(2, sampleSize.max + 1),
        afterFit(scale) { scale.width = SAMPLE_SIZE_AXIS_WIDTH - CHART_AREA_RIGHT_PADDING },
        border: { display: true, color: '#111', width: 1.5 },
        grid: {
          drawOnChartArea: false,
          drawTicks: false,
          tickColor: '#111',
          tickLength: 7,
          color: GRID_MAJOR_COLOR,
          lineWidth: 1,
        },
        ticks: {
          font: { family: CHART_FONT_FAMILY, size: 12 },
          color: '#333',
          padding: 6,
          callback: (value) => Math.round(Number(value)).toLocaleString(),
        },
        title: {
          display: true,
          text: 'Sample depth (n)',
          font: { family: CHART_FONT_FAMILY, size: 13, weight: 'bold' },
          color: '#222',
          padding: { bottom: 6 },
        },
      },
      [DYNAMIC_REFERENCE_AXIS_ID]: {
        type: 'linear',
        axis: 'y',
        display: false,
        position: 'right',
        grid: {
          drawOnChartArea: false,
          drawTicks: false,
        },
        ticks: {
          display: false,
        },
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [allYears.length, dynamicReferenceUsesWidthAxis, sampleSize.max, yMin, yMax, showSampleSize])

  // 点击折线时切换高亮，并保存当前缩放状态。
  const getClosestTreeAtPoint = useCallback((
    event: React.MouseEvent,
    chart: ChartJS<'line'>,
    thresholdPx: number,
  ) => {
    const rect = chart.canvas.getBoundingClientRect()
    const pointerX = event.clientX - rect.left
    const pointerY = event.clientY - rect.top
    const { chartArea } = chart

    if (
      pointerX < chartArea.left
      || pointerX > chartArea.right
      || pointerY < chartArea.top
      || pointerY > chartArea.bottom
    ) {
      return null
    }

    const elements = chart.getElementsAtEventForMode(
      event.nativeEvent,
      'index',
      { intersect: false },
      false
    )
    if (elements.length === 0) return null

    const dataIndex = elements[0].index
    const yScale = chart.scales['y']
    const xScale = chart.scales['x']
    let closestIndex = -1
    let closestDist = thresholdPx

    chart.data.datasets.forEach((ds, index) => {
      if (ds.yAxisID === SAMPLE_SIZE_AXIS_ID || (ds as { isReferenceDataset?: boolean }).isReferenceDataset || ds.label === REFERENCE_SERIES_LABEL) return

      for (const [idxA, idxB] of lineSegmentsNearIndex(ds.data, dataIndex)) {
        const valA = ds.data[idxA]
        const valB = ds.data[idxB]
        if (valA == null || valB == null) continue
        const ax = xScale.getPixelForValue(idxA)
        const ay = yScale.getPixelForValue(valA as number)
        const bx = xScale.getPixelForValue(idxB)
        const by = yScale.getPixelForValue(valB as number)
        const dist = distToSegment(pointerX, pointerY, ax, ay, bx, by)
        if (dist < closestDist) {
          closestDist = dist
          closestIndex = index
        }
      }
    })

    const year = allYears[dataIndex]
    const tree = treeCodes[closestIndex]
    return closestIndex >= 0 && tree && year != null ? { tree, year } : null
  }, [allYears, treeCodes])

  // Shift + 滚轮：缩放整条 Y 轴的显示范围（不改原始数据/年份/算法结果，X 轴范围保持不变）。
  // 以鼠标所在的 Y 值为锚点：向上滚动放大 Y 轴（缩小显示范围），向下滚动缩小 Y 轴（扩大显示范围）。
  // 用原生非被动监听并在捕获阶段拦截，避免触发 chartjs-plugin-zoom 的横轴 wheel 缩放与页面滚动。
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const baseRange = yMax - yMin
    if (!(baseRange > 0)) return

    const handleWheel = (event: WheelEvent) => {
      if (!event.shiftKey) return
      const chart = chartRef.current
      if (!chart) return

      const rect = chart.canvas.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const { chartArea } = chart
      if (x < chartArea.left || x > chartArea.right || y < chartArea.top || y > chartArea.bottom) return

      event.preventDefault()
      event.stopPropagation()

      const yScale = chart.scales['y']
      const curMin = Number(yScale.min)
      const curMax = Number(yScale.max)
      const anchor = yScale.getValueForPixel(y)
      if (!Number.isFinite(curMin) || !Number.isFinite(curMax) || anchor == null || !Number.isFinite(anchor)) return

      const curRange = curMax - curMin
      if (!(curRange > 0)) return

      // 当前倍率 M 落在 0.1 网格上（始终从 1 起步并按 ±0.1 步进）；向上滚动放大（M+），向下缩小（M-）。
      const curM = baseRange / curRange
      const nextM = clamp(
        Math.round((curM + (event.deltaY < 0 ? Y_VISUAL_SCALE_STEP : -Y_VISUAL_SCALE_STEP)) * 10) / 10,
        Y_VISUAL_SCALE_MIN,
        Y_VISUAL_SCALE_MAX,
      )
      if (nextM === curM) return

      // 回到 1.0 倍时复位为自动范围。
      if (Math.abs(nextM - 1) < 1e-6) {
        setYViewWindow(null)
        return
      }

      // 保持锚点像素位置不变地按 M 缩放上下边界（ratio = 新范围 / 当前范围 = curM / nextM）。
      const ratio = curM / nextM
      const nextMin = Number((anchor - (anchor - curMin) * ratio).toFixed(6))
      const nextMax = Number((anchor + (curMax - anchor) * ratio).toFixed(6))
      if (nextMax <= nextMin) return
      setYViewWindow({ min: nextMin, max: nextMax })
    }

    container.addEventListener('wheel', handleWheel, { passive: false, capture: true })
    return () => container.removeEventListener('wheel', handleWheel, { capture: true })
  }, [yMin, yMax])

  const handleLineChartClick = (
    event: unknown,
    chart: ChartJS<'line'> | null,
  ) => {
    if (!chart) return
    if (isDragged.current) {
      isDragged.current = false
      return
    }
    emitZoomWindow(chart)

    const rect = chart.canvas.getBoundingClientRect()
    const clickX = (event as React.MouseEvent).clientX - rect.left
    const clickY = (event as React.MouseEvent).clientY - rect.top

    if (!Number.isFinite(clickY)) {
      onHighlightedTreeCodeChange?.(null)
      return
    }

    const { chartArea } = chart
    const xScale = chart.scales['x']
    if (clickX < chartArea.left || clickX > chartArea.right || !xScale) {
      onHighlightedTreeCodeChange?.(null)
      return
    }

    const rawIndex = xScale.getValueForPixel(clickX)
    if (rawIndex == null || !Number.isFinite(rawIndex)) {
      onHighlightedTreeCodeChange?.(null)
      return
    }

    // 直接从横轴解析点击年份，使当前列没有折线点时仍可使用年份标记线。
    const dataIndex = Math.round(clamp(rawIndex, 0, (chart.data.labels?.length ?? 1) - 1))
    const yScale = chart.scales['y']
    let closestIndex = -1
    let closestDist = LINE_HIT_THRESHOLD_PX

    chart.data.datasets.forEach((ds, i) => {
      if (ds.yAxisID === SAMPLE_SIZE_AXIS_ID || (ds as { isReferenceDataset?: boolean }).isReferenceDataset || ds.label === REFERENCE_SERIES_LABEL) return

      for (const [idxA, idxB] of lineSegmentsNearIndex(ds.data, dataIndex)) {
        const valA = ds.data[idxA]
        const valB = ds.data[idxB]
        if (valA == null || valB == null) continue
        const ax = xScale.getPixelForValue(idxA)
        const ay = yScale.getPixelForValue(valA as number)
        const bx = xScale.getPixelForValue(idxB)
        const by = yScale.getPixelForValue(valB as number)
        const dist = distToSegment(clickX, clickY, ax, ay, bx, by)
        if (dist < closestDist) {
          closestDist = dist
          closestIndex = i
        }
      }
    })

    if (closestIndex >= 0) {
      // 命中折线：高亮并固定这个日历年，交给上层生成非破坏性局部预览。
      const tree = chart.data.datasets[closestIndex]?.label
      const year = allYears[dataIndex]
      if (typeof tree === 'string' && data.has(tree)) {
        onHighlightedTreeCodeChange?.(tree)
        if (year !== undefined) onLinePointClick?.({ tree, year })
      } else {
        onHighlightedTreeCodeChange?.(null)
      }
    } else {
      // 未命中折线：切换标记线，清除高亮
      onHighlightedTreeCodeChange?.(null)
      const markerYear = allYears[dataIndex]
      if (markerYear !== undefined) {
        markerLinesPlugin.markerYear = markerLinesPlugin.markerYear === markerYear ? null : markerYear
        chart.draw()
      }
    }
  }

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (!chartRef.current) return

    const chart = chartRef.current
    const nearbyTarget = getClosestTreeAtPoint(e, chart, HOVER_LINE_HIT_THRESHOLD_PX)
    const rect = chart.canvas.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top

    const { chartArea } = chart
    if (mouseX < chartArea.left || mouseX > chartArea.right ||
        mouseY < chartArea.top || mouseY > chartArea.bottom) return

    const xScale = chart.scales['x']
    const rawIdx = xScale.getValueForPixel(mouseX)
    if (rawIdx == null || !Number.isFinite(rawIdx)) return

    const yearIndex = Math.round(clamp(rawIdx, 0, allYears.length - 1))
    const tree = nearbyTarget?.tree ?? highlightedTreeCode
    const year = nearbyTarget?.year ?? allYears[yearIndex]
    if (!tree || year == null) return

    // 右键靠近折线时先在图表内部选中它，无需预先左键高亮。
    if (nearbyTarget) {
      onHighlightedTreeCodeChange?.(nearbyTarget.tree)
      onLinePointClick?.(nearbyTarget)
    }

    // 只有真正打开图表菜单时才阻止冒泡；空白区域仍可使用外层面板菜单。
    e.stopPropagation()

    setContextMenu({ x: e.clientX, y: e.clientY, tree, year })
  }

  const handleChartMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const chart = chartRef.current
    if (!chart) return

    const target = getClosestTreeAtPoint(event, chart, HOVER_LINE_HIT_THRESHOLD_PX)
    setLineHoverable(!!target)
    if (!target) {
      setHoverPoint(null)
      onHoverTargetChange?.(null)
      return
    }

    const containerRect = event.currentTarget.getBoundingClientRect()
    setHoverPoint({
      ...target,
      x: event.clientX - containerRect.left,
      y: event.clientY - containerRect.top,
    })
    onHoverTargetChange?.(target)
  }

  const handleChartMouseLeave = () => {
    setHoverPoint(null)
    setLineHoverable(false)
    onHoverTargetChange?.(null)
  }

  const formatSimulationCorrelation = (value: number | null) => (
    value === null ? '-' : value.toFixed(2)
  )

  const simulationTooltip = hoverPoint
    && hoverSimulation
    && hoverSimulation.targetTree === hoverPoint.tree
    && hoverSimulation.displayYear === hoverPoint.year ? (
    <div
      style={{
        position: 'absolute',
        zIndex: 4,
        left: hoverPoint.x > 280 ? hoverPoint.x - 270 : hoverPoint.x + 14,
        top: hoverPoint.y > 168 ? hoverPoint.y - 156 : hoverPoint.y + 14,
        width: 256,
        padding: '8px 10px',
        border: '1px solid #c9d3df',
        borderRadius: 5,
        background: 'rgba(255,255,255,0.97)',
        boxShadow: '0 8px 24px rgba(15,23,42,0.16)',
        color: '#172033',
        fontFamily: CHART_FONT_FAMILY,
        fontSize: 12,
        lineHeight: 1.35,
        pointerEvents: 'none',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
        <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {hoverSimulation.targetTree} · {hoverSimulation.displayYear}
        </strong>
        <span style={{ color: '#667084', flex: '0 0 auto' }}>
          n={hoverSimulation.samplePairs}
        </span>
      </div>
      <div style={{ color: '#4b5c72', marginBottom: 5 }}>
        r {formatSimulationCorrelation(hoverSimulation.currentCorrelation)}
        {' · '}
        {hoverSimulation.segmentStartYear}-{hoverSimulation.segmentEndYear}
      </div>
      <div style={{ color: '#111827', fontWeight: 650, marginBottom: 4 }}>
        {hoverSimulation.bestOption.label}
      </div>
      <div style={{ color: '#5b6b7f' }}>
        r {formatSimulationCorrelation(hoverSimulation.bestOption.currentCorrelation)}
        {' → '}
        {formatSimulationCorrelation(hoverSimulation.bestOption.simulatedCorrelation)}
        {hoverSimulation.bestOption.delta !== null ? ` (${hoverSimulation.bestOption.delta >= 0 ? '+' : ''}${hoverSimulation.bestOption.delta.toFixed(2)})` : ''}
      </div>
      <div style={{
        display: 'inline-flex',
        marginTop: 6,
        padding: '1px 6px',
        borderRadius: 10,
        background: hoverSimulation.bestOption.confidence === 'high' ? '#f6d6c8' : hoverSimulation.bestOption.confidence === 'medium' ? '#f7e5bd' : '#eef0f3',
        color: hoverSimulation.bestOption.confidence === 'high' ? '#8f2d18' : hoverSimulation.bestOption.confidence === 'medium' ? '#6e5010' : '#5f6d7c',
        fontSize: 11,
        fontWeight: 700,
      }}>
        {hoverSimulation.bestOption.confidence}
      </div>
    </div>
  ) : null

  // 视觉提示：当前 Y 轴视觉放大倍率 = 基准范围 / 当前显示范围（自动范围时为 1，仅提示不可交互）。
  const yVisualMagnification = yViewWindow && yMax > yMin
    ? (yMax - yMin) / (yViewWindow.max - yViewWindow.min)
    : 1

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', height: '100%', minHeight: 0, background: '#fff', cursor: lineHoverable ? 'pointer' : 'default' }}
      onContextMenu={handleContextMenu}
      onMouseMove={handleChartMouseMove}
      onMouseLeave={handleChartMouseLeave}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: SAMPLE_SIZE_AXIS_WIDTH - 1,
          zIndex: 2,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 4,
        }}
        onContextMenu={(event) => event.stopPropagation()}
      >
        <label
          title="样本量曲线"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 7px',
            border: '1px solid rgba(210,210,210,0.85)',
            borderRadius: 4,
            background: 'rgba(255,255,255,0.88)',
            color: '#555',
            fontFamily: CHART_FONT_FAMILY,
            fontSize: 11,
            lineHeight: 1.4,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={showSampleSize}
            aria-label="显示样本量曲线"
            onChange={(event) => setShowSampleSize(event.target.checked)}
            style={{
              width: 12,
              height: 12,
              margin: 0,
              accentColor: '#777',
              cursor: 'pointer',
            }}
          />
          <span
            aria-hidden="true"
            style={{
              width: 24,
              height: 0,
              borderTop: `2px dashed ${SAMPLE_SIZE_COLOR}`,
            }}
          />
          <span>{SAMPLE_SIZE_LABEL}</span>
        </label>
        {yViewWindow && (
          <div
            title="Shift + 滚轮缩放 Y 轴显示范围（双击图表外或继续向反方向滚动可复位）"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 8px',
              border: '1px solid rgba(210,210,210,0.85)',
              borderRadius: 4,
              background: 'rgba(255,255,255,0.88)',
              fontFamily: CHART_FONT_FAMILY,
              fontSize: 11,
              lineHeight: 1.4,
              color: '#222',
              fontWeight: 'bold',
              userSelect: 'none',
            }}
          >
            Y×{formatVisualScale(yVisualMagnification)}
          </div>
        )}
      </div>
      <Line
        ref={chartRef}
        data={chartData}
        options={chartOptions}
        plugins={[fixedChartAreaPlugin, referenceGridPlugin, diagnosisEventBandsPlugin, markerLinesPlugin, missingRingLinesPlugin, chartBoxBorderPlugin, xAxisLabelsPlugin, ...(showPersistentTooltip ? [tooltipPlugin] : []), yearIndicatorPlugin]}
        onClick={(event) =>
          handleLineChartClick(event, chartRef.current)
        }
      />
      {contextMenu && (
        <WidthGridContextMenu
          open={true}
          x={contextMenu.x}
          y={contextMenu.y}
          tree={contextMenu.tree}
          defaultYear={contextMenu.year}
          onInsert={(tree, year, side) => {
            onInsertMissingYearAtSide?.(tree, year, side)
            setContextMenu(null)
          }}
          onDelete={(tree, year, mode, shift) => {
            onDeleteYearWithMode?.(tree, year, mode, shift)
            setContextMenu(null)
          }}
          onMoveWholeSeries={onMoveWholeSeries}
          onMoveOlderSide={onMoveOlderSide}
          onDeleteSeries={(tree) => {
            onDeleteSeries?.(tree)
            setContextMenu(null)
          }}
          onJumpToWidth={onJumpToWidth}
          onEditAsText={onEditAsText}
          onJumpToCofecha={onJumpToCofecha}
          canJumpToCofecha={cofechaPart6TreeSet.has(normalizeCofechaSeriesId(contextMenu.tree))}
          onClose={() => setContextMenu(null)}
        />
      )}
      {simulationTooltip}
    </div>
  )
}

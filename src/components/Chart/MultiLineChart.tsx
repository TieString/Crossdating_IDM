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
import WidthGridContextMenu from '@/components/WidthContainer/WidthGridContextMenu/WidthGridContextMenu'
import type { DeleteMode, DeleteShift, MissingInsertSide } from '@/features/rwl/edit'
import { stopMarker } from '@/shared/constants'

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
const TOOLTIP_MAX_SERIES = 15
const Y_AXIS_WIDTH = 60
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
const NICE_YEAR_STEPS = [1, 2, 5, 10, 15, 20, 25, 50, 100, 200]
const LINE_HIT_THRESHOLD_PX = 5   // 鼠标距离折线小于5px时点击选择该折线
const SAMPLE_SIZE_AXIS_ID = 'sampleSize'
const SAMPLE_SIZE_LABEL = '样本量'
const SAMPLE_SIZE_COLOR = 'rgba(104, 110, 120, 0.62)'

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
    const right = Math.max(0, width - CHART_AREA_RIGHT_PADDING)
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

    const sampleSizeScale = scales[SAMPLE_SIZE_AXIS_ID]
    if (sampleSizeScale) {
      sampleSizeScale.left = right
      sampleSizeScale.right = right
      sampleSizeScale.width = 0
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
        const value = typeof raw === 'number' ? Math.round(raw).toString() : String(raw)
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

function makeMarkerLinesPlugin(): Plugin<'line'> & { markerIndex: number | null } {
  return {
    id: 'markerLines',
    markerIndex: null,

    afterDatasetsDraw(chart) {
      if (this.markerIndex == null) return
      const { ctx, chartArea, scales } = chart
      const xScale = scales.x
      if (!xScale) return

      const x = xScale.getPixelForValue(this.markerIndex)
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
      if (this.markerIndex == null) return
      const { ctx, chartArea, scales, data } = chart
      const xScale = scales.x
      if (!xScale) return

      const label = data.labels?.[this.markerIndex] as string | undefined
      if (!label) return

      const x = xScale.getPixelForValue(this.markerIndex)
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
  sampleSizeData?: ReadonlyMap<string, ReadonlyMap<number, number | null>>
  highlightedTreeCode?: string | null
  onHighlightedTreeCodeChange?: (treeCode: string | null) => void
  zoomWindow?: { min: number; max: number } | null
  onZoomWindowChange?: (zoomWindow: { min: number; max: number } | null) => void
  onShiftHighlightedTree?: (treeCode: string, direction: -1 | 1) => void
  onInsertMissingYearAtSide?: (tree: string, year: number, side: MissingInsertSide) => void
  onDeleteYearWithMode?: (tree: string, year: number, mode: DeleteMode, shift?: DeleteShift) => void
  onDeleteSeries?: (tree: string) => void
}

export type ChartZoomWindow = {
  min: number
  max: number
} | null

export const colorPalette = [
  '#c0392b', '#2e6da4', '#27825a', '#7d3c98', '#b9621e',
  '#1a7a7a', '#7a4a1e', '#4a3a8a', '#6a7a2a', '#a03050',
  '#2a5a7a', '#7a2a5a', '#3a6a2a', '#8a3a2a', '#2a4a8a',
  '#6a5a1e', '#3a2a6a', '#5a7a3a', '#6a2a3a', '#2a6a5a',
]

const CHART_FONT_FAMILY = "'Arial', 'Helvetica', sans-serif"

export function MultiLineChart({
  data,
  sampleSizeData,
  highlightedTreeCode = null,
  onHighlightedTreeCodeChange,
  zoomWindow = null,
  onZoomWindowChange,
  onShiftHighlightedTree,
  onInsertMissingYearAtSide,
  onDeleteYearWithMode,
  onDeleteSeries,
}: Props) {
  const chartRef = useRef<ChartJSInstance<'line'> | null>(null)
  const isDragged = useRef(false)
  // const tooltipPlugin = useMemo(() => makePersistentTooltipPlugin(), []) // 暂时屏蔽，恢复时加回 plugins 数组
  const yearIndicatorPlugin = useMemo(() => makeYearIndicatorPlugin(), [])
  const markerLinesPlugin = useMemo(() => makeMarkerLinesPlugin(), [])
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tree: string; year: number } | null>(null)
  const [showSampleSize, setShowSampleSize] = useState(true)
  const treeCodes = useMemo(() => Array.from(data.keys()), [data])
  const highlightedIndex = highlightedTreeCode ? treeCodes.indexOf(highlightedTreeCode) : -1

  const emitZoomWindow = useCallback((chart: ChartJSInstance<'line'> | ChartJS | null = chartRef.current) => {
    if (!chart || !onZoomWindowChange) return
    const scale = chart.scales['x']
    const min = Number(scale.min)
    const max = Number(scale.max)

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
    if (!Number.isFinite(minYear)) return []
    const years: number[] = []
    for (let y = minYear; y <= maxYear; y++) years.push(y)
    return years
  }, [data])

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
          && value > 0
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

  // 构造 Chart.js datasets。
  const datasets: ChartData<'line'>['datasets'] = useMemo(() => {
    const nextDatasets: ChartData<'line'>['datasets'] = []
    let colorIndex = 0

    data.forEach((yearMap, treeCode) => {
      const yData = allYears.map(year => yearMap.get(year) ?? null)
      const color = colorPalette[colorIndex % colorPalette.length]
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
  }, [allYears, data, highlightedIndex, sampleSize, showSampleSize])

  const chartData: ChartData<'line'> = {
    labels: allYears.map(year => year.toString()),
    datasets
  }

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

  // 数据变更后恢复缩放状态。
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    const scale = chart.scales['x']
    scale.options.min = zoomWindow?.min
    scale.options.max = zoomWindow?.max
    chart.update('none')
  }, [chartData, highlightedTreeCode, zoomWindow])

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
    const yMargin = (globalMax - globalMin) * 0.1
    return [globalMin - yMargin, globalMax + yMargin]
  }, [data])

  const emitZoomWindowRef = useRef(emitZoomWindow)
  useEffect(() => { emitZoomWindowRef.current = emitZoomWindow }, [emitZoomWindow])

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
        },
        pan: {
          enabled: true,
          mode: 'x',
          onPanStart: () => {
            isDragged.current = true;
            return undefined;
          },
          onPanComplete: ({ chart }) => { emitZoomWindowRef.current(chart) }
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
          text: 'Ring width (mm)',
          font: { family: CHART_FONT_FAMILY, size: 13, weight: 'bold' },
          color: '#222',
          padding: { bottom: 6 },
        },
      },
      [SAMPLE_SIZE_AXIS_ID]: {
        type: 'linear',
        axis: 'y',
        display: false,
        position: 'right',
        min: 0,
        max: Math.max(2, sampleSize.max + 1),
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
  }), [allYears.length, sampleSize.max, yMin, yMax])

  // 点击折线时切换高亮，并保存当前缩放状态。
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

    // 先判断是否命中折线
    const elements = chart.getElementsAtEventForMode(
      event as unknown as MouseEvent,
      'index',
      { intersect: false },
      false
    )
    if (elements.length === 0) {
      onHighlightedTreeCodeChange?.(null)
      return
    }

    const dataIndex = elements[0].index
    const yScale = chart.scales['y']
    let closestIndex = -1
    let closestDist = LINE_HIT_THRESHOLD_PX
    const xScale = chart.scales['x']

    chart.data.datasets.forEach((ds, i) => {
      if (ds.yAxisID === SAMPLE_SIZE_AXIS_ID) return

      for (const [idxA, idxB] of [[dataIndex - 1, dataIndex], [dataIndex, dataIndex + 1]] as [number, number][]) {
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
      // 命中折线：只高亮，不动标记线
      onHighlightedTreeCodeChange?.(treeCodes[closestIndex] ?? null)
    } else {
      // 未命中折线：切换标记线，清除高亮
      onHighlightedTreeCodeChange?.(null)
      const { chartArea } = chart
      if (clickX >= chartArea.left && clickX <= chartArea.right) {
        const xScale = chart.scales['x']
        const rawIdx = xScale.getValueForPixel(clickX)
        if (rawIdx != null && Number.isFinite(rawIdx)) {
          const idx = Math.round(clamp(rawIdx, 0, (chart.data.labels?.length ?? 1) - 1))
          markerLinesPlugin.markerIndex = markerLinesPlugin.markerIndex === idx ? null : idx
          chart.draw()
        }
      }
    }
  }

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (!highlightedTreeCode || !chartRef.current) return

    const chart = chartRef.current
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
    const year = allYears[yearIndex]
    if (year == null) return

    setContextMenu({ x: e.clientX, y: e.clientY, tree: highlightedTreeCode, year })
  }

  return (
    <div
      style={{ position: 'relative', height: '100%', minHeight: 0, background: '#fff' }}
      onContextMenu={handleContextMenu}
    >
      <label
        title="显示/隐藏样本量曲线"
        style={{
          position: 'absolute',
          top: 2,
          right: 8,
          zIndex: 2,
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
        onContextMenu={(event) => event.stopPropagation()}
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
      <Line
        ref={chartRef}
        data={chartData}
        options={chartOptions}
        plugins={[fixedChartAreaPlugin, referenceGridPlugin, markerLinesPlugin, chartBoxBorderPlugin, xAxisLabelsPlugin, /* tooltipPlugin, */ yearIndicatorPlugin]}
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
          onDeleteSeries={(tree) => {
            onDeleteSeries?.(tree)
            setContextMenu(null)
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

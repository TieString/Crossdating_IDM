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
import { useCallback, useEffect, useMemo, useRef } from 'react'

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
const MAX_ROWS_SINGLE_COL = 8
const MAX_LABEL_CHARS = 12
const Y_AXIS_WIDTH = 72
const X_AXIS_HEIGHT = 58
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
const X_AXIS_TITLE_Y_OFFSET = 36
const NICE_YEAR_STEPS = [1, 2, 5, 10, 15, 20, 25, 50, 100, 200]
const LINE_HIT_THRESHOLD_PX = 20

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
function makePersistentTooltipPlugin(): Plugin<'line'> & { activeIndex: number | null } {
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

      const { ctx, data, chartArea } = chart
      const label = data.labels?.[idx] as string | undefined
      if (!label) return

      // 收集当前索引下所有有效数据行
      type Row = { color: string; name: string; value: string }
      const rows: Row[] = []
      data.datasets.forEach((ds) => {
        const raw = ds.data[idx]
        if (raw == null) return
        const value = typeof raw === 'number' ? Math.round(raw).toString() : String(raw)
        const name = (ds.label ?? '').slice(0, MAX_LABEL_CHARS)
        const color = ds.borderColor as string
        rows.push({ color, name, value })
      })
      if (rows.length === 0) return

      const useTwoCols = rows.length > MAX_ROWS_SINGLE_COL
      const colCount = useTwoCols ? 2 : 1
      const rowsPerCol = useTwoCols ? Math.ceil(rows.length / 2) : rows.length

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
      const y = chartArea.top + 8

      // 白色背景框
      ctx.fillStyle = 'rgba(255,255,255,0.95)'
      ctx.strokeStyle = '#aaaaaa'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(x, y, boxW, boxH, 3)
      ctx.fill()
      ctx.stroke()

      // 标题（年份）
      ctx.fillStyle = '#111111'
      ctx.font = FONT_BOLD
      ctx.textBaseline = 'top'
      ctx.fillText(label, x + PAD, y + PAD)

      // 分隔线
      const divY = y + PAD + LINE_H + 2
      ctx.strokeStyle = '#dddddd'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x + PAD, divY)
      ctx.lineTo(x + boxW - PAD, divY)
      ctx.stroke()

      // 数据行
      ctx.font = FONT
      rows.forEach((row, i) => {
        const col = useTwoCols ? Math.floor(i / rowsPerCol) : 0
        const rowInCol = useTwoCols ? i % rowsPerCol : i
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

type Props = {
  data: Map<string, Map<number, number>>
  highlightedTreeCode?: string | null
  onHighlightedTreeCodeChange?: (treeCode: string | null) => void
  zoomWindow?: { min: number; max: number } | null
  onZoomWindowChange?: (zoomWindow: { min: number; max: number } | null) => void
  onShiftHighlightedTree?: (treeCode: string, direction: -1 | 1) => void
}

export type ChartZoomWindow = {
  min: number
  max: number
} | null

const colorPalette = [
  '#c0392b', '#2e6da4', '#27825a', '#7d3c98', '#b9621e',
  '#1a7a7a', '#7a4a1e', '#4a3a8a', '#6a7a2a', '#a03050',
  '#2a5a7a', '#7a2a5a', '#3a6a2a', '#8a3a2a', '#2a4a8a',
  '#6a5a1e', '#3a2a6a', '#5a7a3a', '#6a2a3a', '#2a6a5a',
]

const CHART_FONT_FAMILY = "'Arial', 'Helvetica', sans-serif"

export function MultiLineChart({
  data,
  highlightedTreeCode = null,
  onHighlightedTreeCodeChange,
  zoomWindow = null,
  onZoomWindowChange,
  onShiftHighlightedTree
}: Props) {
  const chartRef = useRef<ChartJSInstance<'line'> | null>(null)
  const isDragged = useRef(false)
  const tooltipPlugin = useMemo(() => makePersistentTooltipPlugin(), [])
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
    const allYearsSet = new Set<number>()
    data.forEach(yearMap => {
      yearMap.forEach((_, year) => allYearsSet.add(year))
    })
    return Array.from(allYearsSet).sort((a, b) => a - b)
  }, [data])

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
        borderWidth: highlightedIndex === -1 || isHighlighted ? 2.5 : 1.5,
        tension: 0.008,
        cubicInterpolationMode: 'default',
        pointRadius: 0,
        pointHoverRadius: 2,
        pointHitRadius: 8,
      })
      colorIndex++
    })

    return nextDatasets
  }, [allYears, data, highlightedIndex])

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
      padding: { top: 2, right: 2, bottom: 0, left: 0 },
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
          onPanStart: () => { isDragged.current = true },
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
        },
        title: {
          display: true,
          text: 'Ring width (mm)',
          font: { family: CHART_FONT_FAMILY, size: 13, weight: 'bold' },
          color: '#222',
          padding: { bottom: 6 },
        },
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [allYears.length, yMin, yMax])

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
    const clickY = (event as React.MouseEvent).clientY - rect.top
    if (!Number.isFinite(clickY)) {
      onHighlightedTreeCodeChange?.(null)
      return
    }

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

    chart.data.datasets.forEach((ds, i) => {
      const value = ds.data[dataIndex]
      if (value == null) return
      const yPixel = yScale.getPixelForValue(value as number)
      const dist = Math.abs(yPixel - clickY)
      if (dist < closestDist) {
        closestDist = dist
        closestIndex = i
      }
    })

    if (closestIndex >= 0) {
      onHighlightedTreeCodeChange?.(treeCodes[closestIndex] ?? null)
    } else {
      onHighlightedTreeCodeChange?.(null)
    }
  }

  return (
    <div style={{ position: 'relative', height: '100%', minHeight: 0, background: '#fff' }}>
      <Line
        ref={chartRef}
        data={chartData}
        options={chartOptions}
        plugins={[fixedChartAreaPlugin, referenceGridPlugin, chartBoxBorderPlugin, xAxisLabelsPlugin, tooltipPlugin]}
        onClick={(event) =>
          handleLineChartClick(event, chartRef.current)
        }
      />
    </div>
  )
}

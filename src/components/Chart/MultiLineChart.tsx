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
  Chart as ChartJSInstance
} from 'chart.js'
import { useCallback, useEffect, useMemo, useRef } from 'react'

// 多折线图组件。
// 输入是已经筛选好的树种年份数据，组件负责：
// 1. 清洗和整理数据；
// 2. 构造 Chart.js 所需的 datasets；
// 3. 处理高亮、缩放、平移和键盘微调交互。
// 这个组件只关注图表展示，不关心文件读取或 RWL 解析。

// 注册插件
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
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231',
  '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe',
  '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000',
  '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080'
]

export function MultiLineChart({
  data,
  highlightedTreeCode = null,
  onHighlightedTreeCodeChange,
  zoomWindow = null,
  onZoomWindowChange,
  onShiftHighlightedTree
}: Props) {
  const chartRef = useRef<ChartJSInstance<'line'> | null>(null)
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
      const transparentColor = color + '66'
      nextDatasets.push({
        label: treeCode,
        data: yData,
        borderColor: highlightedIndex === -1 || isHighlighted ? color : transparentColor,
        backgroundColor: color,
        fill: false,
        borderWidth: 2,
        tension: 0,     // 贝塞尔曲线张力参数，0为直线，配合 cubicInterpolationMode 使用  
        cubicInterpolationMode: 'default', // 保持默认直线插值（配合 tension: 0）
        pointRadius: 2,
        pointHoverRadius: 4
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
  const yMin = globalMin - yMargin
  const yMax = globalMax + yMargin

  const chartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: {
      mode: 'index',
      intersect: false
    },
    plugins: {
      crosshair: {
        line: { color: '#999', width: 1 },
        sync: { enabled: false },
        zoom: { enabled: false }
      },
      zoom: {
        pan: {
          enabled: true,
          mode: 'x',
          onPanComplete: ({ chart }) => {
            emitZoomWindow(chart)
          }
        },
        zoom: {
          wheel: { enabled: true },
          pinch: { enabled: true },
          mode: 'x',
          onZoomComplete: ({ chart }) => {
            emitZoomWindow(chart)
          }
        }
      },
      tooltip: {
        enabled: true,
        position: "average",
        caretPadding: 30,   // 越大离点越远
        padding: 8,        // tooltip 内边距

      },
      legend: {
        position: 'top'
      }
    },
    scales: {
      x: {
        display: true,
        grid: {
          drawOnChartArea: true,
          drawTicks: true,
          color: '#e0e0e0'
        }
      },
      y: {
        display: true,
        min: yMin,
        max: yMax,
        grid: {
          color: '#e0e0e0'
        }
      }
    }
  }

  // 点击折线时切换高亮，并保存当前缩放状态。
  const handleLineChartClick = (
    event: unknown,
    chart: ChartJS<'line'> | null,
  ) => {
    if (!chart) return
    emitZoomWindow(chart)
    const elements = chart.getElementsAtEventForMode(
      event as unknown as MouseEvent,
      'dataset',
      { intersect: false },
      false
    )
    if (elements.length > 0) {
      const index = elements[0].datasetIndex
      onHighlightedTreeCodeChange?.(treeCodes[index] ?? null)
    } else {
      onHighlightedTreeCodeChange?.(null)
    }
  }

  return (
    <div style={{ position: 'relative', height: '100%', minHeight: 0 }}>
      <Line
        ref={chartRef}
        data={chartData}
        options={chartOptions}
        onClick={(event) =>
          handleLineChartClick(event, chartRef.current)
        }
      />
    </div>
  )
}

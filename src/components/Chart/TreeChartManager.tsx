import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { ChartZoomWindow, MultiLineChart } from './MultiLineChart.tsx'
import { RwlSiteData } from '@/features/rwl'

// 树种图表管理器。
// 这个组件负责把当前 RWL 数据拆成“可选树种列表 + 选中后的多折线图”两部分：
// 1. 上方按钮区负责树种选择；
// 2. 下方交给 MultiLineChart 渲染具体曲线。
// 它本身不改写原始数据，只做筛选和展示。

type Props = {
  fullData: RwlSiteData
}

function TreeChartManagerBase({ fullData }: Props) {
  const [selectedTrees, setSelectedTrees] = useState<string[]>([])
  const [highlightedTreeCode, setHighlightedTreeCode] = useState<string | null>(null)
  const [treeOffsets, setTreeOffsets] = useState<Map<string, number>>(new Map())
  const [zoomWindow, setZoomWindow] = useState<ChartZoomWindow>(null)

  useEffect(() => {
    setSelectedTrees((previous) => previous.filter((treeCode) => fullData.has(treeCode)))
  }, [fullData])

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

  const filteredData = useMemo(() => {
    const nextData = new Map<string, Map<number, number>>()

    selectedTrees.forEach(treeCode => {
      const treeData = fullData.get(treeCode)
      if (treeData) {
        const numericData = new Map<number, number>()
        const sortedYears = Array.from(treeData.keys()).sort((a, b) => a - b)
        if (sortedYears.length < 2) {
          return
        }

        const trimmedYears = sortedYears.slice(0, -1)
        const yearOffset = treeOffsets.get(treeCode) ?? 0
        trimmedYears.forEach((year) => {
          const value = treeData.get(year)
          if (value !== undefined && value !== null) {
            numericData.set(year + yearOffset, value)
          }
        })

        if (numericData.size > 0) {
          nextData.set(treeCode, numericData)
        }
      }
    })

    return nextData
  }, [fullData, selectedTrees, treeOffsets])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ position: 'relative', marginBottom: '1rem', flex: '0 0 auto' }}>
        {/* 顶部渐变遮罩 */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 20,
          background: 'linear-gradient(to bottom, white, rgba(255,255,255,0))',
          zIndex: 1,
          pointerEvents: 'none'
        }} />

        {/* 滚动区域 */}
        <div style={{
          height: 70,
          overflowY: 'scroll',
          overflowX: 'hidden',
          paddingTop: 8,
          paddingBottom: 8
        }}>
          {Array.from(fullData.keys()).map(treeCode => (
            <button
              key={treeCode}
              onClick={() => toggleTree(treeCode)}
              style={{
                marginRight: 4,
                backgroundColor: selectedTrees.includes(treeCode) ? '#90caf9' : '#eee',
                border: '1px solid #ccc',
                padding: '4px 8px',
                borderRadius: 4,
                cursor: 'pointer',
                marginLeft: 4,
                marginTop: 2,
                marginBottom: 2,
              }}
            >
              {treeCode}
            </button>
          ))}
        </div>

        {/* 底部渐变遮罩 */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 20,
          background: 'linear-gradient(to top, white, rgba(255,255,255,0))',
          zIndex: 1,
          pointerEvents: 'none'
        }} />
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        {filteredData.size > 0 ? (
          <MultiLineChart
            data={filteredData}
            highlightedTreeCode={highlightedTreeCode}
            onHighlightedTreeCodeChange={setHighlightedTreeCode}
            zoomWindow={zoomWindow}
            onZoomWindowChange={setZoomWindow}
            onShiftHighlightedTree={shiftHighlightedTree}
          />
        ) : null}
      </div>
    </div>
  )
}

export const TreeChartManager = memo(TreeChartManagerBase)

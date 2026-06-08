import React, { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { ChartZoomWindow, MultiLineChart, colorPalette } from './MultiLineChart.tsx'
import { RwlSiteData } from '@/features/rwl'
import type { DeleteMode, MissingInsertSide } from '@/features/rwl/edit'
import { stopMarker } from '@/shared/constants'

// 树种图表管理器。
// 这个组件负责把当前 RWL 数据拆成”可选树种列表 + 选中后的多折线图”两部分：
// 1. 上方按钮区负责树种选择；
// 2. 下方交给 MultiLineChart 渲染具体曲线。
// 它本身不改写原始数据，只做筛选和展示。

type Props = {
  fullData: RwlSiteData
  onInsertMissingYearAtSide?: (tree: string, year: number, side: MissingInsertSide) => void
  onDeleteYearWithMode?: (tree: string, year: number, mode: DeleteMode) => void
  onDeleteSeries?: (tree: string) => void
}

function TreeChartManagerBase({ fullData, onInsertMissingYearAtSide, onDeleteYearWithMode, onDeleteSeries }: Props) {
  const [selectedTrees, setSelectedTrees] = useState<string[]>([])
  const [highlightedTreeCode, setHighlightedTreeCode] = useState<string | null>(null)
  const [treeOffsets, setTreeOffsets] = useState<Map<string, number>>(new Map())
  const [zoomWindow, setZoomWindow] = useState<ChartZoomWindow>(null)
  const [search, setSearch] = useState('')

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
  }, [fullData, selectedTrees, treeOffsets])

  const allTreeCodes = useMemo(() => Array.from(fullData.keys()), [fullData])
  const filteredTreeCodes = useMemo(() =>
    search.trim() === '' ? allTreeCodes : allTreeCodes.filter(c => c.toLowerCase().includes(search.toLowerCase())),
    [allTreeCodes, search]
  )
  const allSelected = selectedTrees.length === allTreeCodes.length

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
    fontWeight: 500, letterSpacing: 0.2, transition: 'background 0.12s, color 0.12s',
    lineHeight: 1.4,boxShadow: 'none',
  }
  const btnDisabled: React.CSSProperties = {
    ...btnBase, background: '#f4f4f4', color: '#c0c0c0', cursor: 'default', border: '1px solid #e4e4e4',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* 顶部选择面板 */}
      <div style={{ flex: '0 0 auto', marginBottom: 10 }}>
        {/* 工具栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <button onClick={() => setSelectedTrees(allTreeCodes)} disabled={allSelected}
            style={allSelected ? btnDisabled : btnBase}>全选</button>
          <button onClick={() => setSelectedTrees([])} disabled={selectedTrees.length === 0}
            style={selectedTrees.length === 0 ? btnDisabled : btnBase}>全不选</button>

          {/* 搜索框 */}
          <div style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', alignItems: 'center' }}>
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

          <span style={{
            fontSize: 11, color: '#fff', background: '#2e6da4',
            borderRadius: 10, padding: '1px 8px', fontWeight: 600, whiteSpace: 'nowrap',
          }}>
            {selectedTrees.length} / {allTreeCodes.length}
          </span>
        </div>

        {/* pill 标签列表 */}
        <div style={{
          maxHeight: 76, overflowY: 'auto',
          border: '1px solid #e8e8e8', borderRadius: 6,
          background: '#f8f9fa',
          display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start',
          padding: '4px 5px', gap: 4,
        }}>
          {filteredTreeCodes.length === 0
            ? <span style={{ fontSize: 12, color: '#bbb', padding: '4px 6px', fontStyle: 'italic' }}>无匹配结果</span>
            : filteredTreeCodes.map(treeCode => {
              const checked = selectedTrees.includes(treeCode)
              const seriesColor = seriesColorMap.get(treeCode)
              return (
                <button
                  key={treeCode}
                  onClick={() => toggleTree(treeCode)}
                  style={{
                    fontSize: 11, padding: '2px 9px', borderRadius: 6,
                    border: checked ? '1px solid #2e6da4' : '1px solid #d8d8d8',
                    background: '#fff',
                    color: checked ? '#2e6da4' : '#555',
                    cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
                    // fontWeight: checked ? 600 : 400,
                    boxShadow: checked ? '0 1px 3px rgba(46,109,164,0.15)' : '0 1px 2px rgba(0,0,0,0.04)',
                    transition: 'all 0.12s',
                    lineHeight: 1.6,
                    position: 'relative',
                  }}
                >
                  {treeCode}
                  {checked && seriesColor && (
                    <span style={{ position: 'absolute', bottom: 2, left: 5, right: 5, height: 2, borderRadius: 1, background: seriesColor }} />
                  )}
                </button>
              )
            })
          }
        </div>
      </div>

      {/* 图表区 */}
      <div style={{ flex: '1 1 auto', minHeight: 0 }}>
        {filteredData.size > 0 ? (
          <MultiLineChart
            data={filteredData}
            sampleSizeData={fullData}
            highlightedTreeCode={highlightedTreeCode}
            onHighlightedTreeCodeChange={setHighlightedTreeCode}
            zoomWindow={zoomWindow}
            onZoomWindowChange={setZoomWindow}
            onShiftHighlightedTree={shiftHighlightedTree}
            onInsertMissingYearAtSide={onInsertMissingYearAtSide}
            onDeleteYearWithMode={onDeleteYearWithMode}
            onDeleteSeries={onDeleteSeries}
          />
        ) : null}
      </div>
    </div>
  )
}

export const TreeChartManager = memo(TreeChartManagerBase)

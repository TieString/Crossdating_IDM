import { useState } from 'react'
import { MultiLineChart } from './MultiLineChart.tsx'
import { RwlSiteData } from '@/features/rwl'

// 树种图表管理器。
// 这个组件负责把当前 RWL 数据拆成“可选树种列表 + 选中后的多折线图”两部分：
// 1. 上方按钮区负责树种选择；
// 2. 下方交给 MultiLineChart 渲染具体曲线。
// 它本身不改写原始数据，只做筛选和展示。

type Props = {
  fullData: RwlSiteData
}

export function TreeChartManager({ fullData }: Props) {
  const [selectedTrees, setSelectedTrees] = useState<string[]>([])

  const toggleTree = (treeCode: string) => {
    setSelectedTrees(prev =>
      prev.includes(treeCode)
        ? prev.filter(code => code !== treeCode)
        : [...prev, treeCode]
    )
  }

  const filteredData = new Map<string, Map<number, number>>()
  selectedTrees.forEach(treeCode => {
    const treeData = fullData.get(treeCode)
    if (treeData) {
      const numericData = new Map<number, number>()
      treeData.forEach((value, year) => {
        if (value !== null) {
          numericData.set(year, value)
        }
      })
      filteredData.set(treeCode, numericData)
    }
  })

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
          <MultiLineChart data={filteredData} />
        ) : null}
      </div>
    </div>
  )
}

import { describe, expect, it } from 'vitest'
import { buildStableSeriesColorMap } from '../seriesColors'

describe('stable chart series colours', () => {
  it('keeps remaining series colours when an earlier selection is removed', () => {
    const colors = buildStableSeriesColorMap(
      ['A', 'B', 'C'],
      ['red', 'blue', 'green'],
    )

    expect(['A', 'B', 'C'].map((id) => colors.get(id))).toEqual([
      'red',
      'blue',
      'green',
    ])
    expect(['B', 'C'].map((id) => colors.get(id))).toEqual([
      'blue',
      'green',
    ])
  })

  it('uses the same deterministic assignment for duplicate input ids', () => {
    const colors = buildStableSeriesColorMap(
      ['A', 'A', 'B'],
      ['red', 'blue'],
    )

    expect(Array.from(colors.entries())).toEqual([
      ['A', 'red'],
      ['B', 'blue'],
    ])
  })
})

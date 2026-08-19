import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SERIES_COLOR_PALETTE,
  buildStableSeriesColorMap,
} from '../seriesColors'

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

  it('keeps the seed palette visibly separated and reserves reference red', () => {
    const rgb = (color: string) => [1, 3, 5].map((offset) => (
      Number.parseInt(color.slice(offset, offset + 2), 16)
    ))
    const distances = DEFAULT_SERIES_COLOR_PALETTE.flatMap((left, leftIndex) => (
      DEFAULT_SERIES_COLOR_PALETTE.slice(leftIndex + 1).map((right) => {
        const leftRgb = rgb(left)
        const rightRgb = rgb(right)
        return Math.hypot(...leftRgb.map((channel, index) => channel - rightRgb[index]))
      })
    ))

    expect(new Set(DEFAULT_SERIES_COLOR_PALETTE).size).toBe(DEFAULT_SERIES_COLOR_PALETTE.length)
    expect(Math.min(...distances)).toBeGreaterThanOrEqual(40)
    expect(DEFAULT_SERIES_COLOR_PALETTE).not.toContain('#dc2626')
  })

  it('extends to large series collections without cycling or recolouring earlier ids', () => {
    const firstIds = Array.from({ length: 80 }, (_, index) => `S${index}`)
    const allIds = Array.from({ length: 256 }, (_, index) => `S${index}`)
    const firstColors = buildStableSeriesColorMap(firstIds)
    const allColors = buildStableSeriesColorMap(allIds)

    expect(allColors.size).toBe(allIds.length)
    expect(new Set(allColors.values()).size).toBe(allIds.length)
    expect(firstIds.map((id) => allColors.get(id))).toEqual(
      firstIds.map((id) => firstColors.get(id)),
    )
    expect(allColors.get(`S${DEFAULT_SERIES_COLOR_PALETTE.length}`))
      .not.toBe(DEFAULT_SERIES_COLOR_PALETTE[0])
  })
})

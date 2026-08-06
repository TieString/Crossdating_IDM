/**
 * Assigns colours from the complete series order, not the current selection order.
 * Removing or re-adding a selected series therefore cannot recolour the others.
 */
export function buildStableSeriesColorMap(
  seriesIds: readonly string[],
  palette: readonly string[],
): Map<string, string> {
  const colors = new Map<string, string>()
  if (palette.length === 0) return colors

  seriesIds.forEach((seriesId) => {
    if (colors.has(seriesId)) return
    colors.set(seriesId, palette[colors.size % palette.length])
  })
  return colors
}

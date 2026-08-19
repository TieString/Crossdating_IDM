/**
 * Perceptually separated seed colours for the series users are most likely to
 * inspect together. Red remains reserved for the manual reference series.
 */
export const DEFAULT_SERIES_COLOR_PALETTE = [
  '#2563eb', '#18aa18', '#e9680c', '#333333', '#e90c8d',
  '#7d7412', '#1f99d6', '#c40ce9', '#279b7e', '#6b1d72',
  '#0c0ce9', '#7d3e12', '#070788', '#123e7d', '#2b721d',
  '#a954d4', '#126b7d', '#e90cc4', '#c47a31', '#880752',
] as const

type Rgb = [number, number, number]
type Oklab = [number, number, number]

const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949
const GENERATED_HUE_START = 20
const GENERATED_HUE_SPAN = 320
const GENERATED_COLOR_SEARCH_SIZE = 64
const GENERATED_SATURATIONS = [88, 68, 78, 58] as const
const GENERATED_LIGHTNESSES = [48, 38, 54, 31] as const
const MINIMUM_WHITE_CONTRAST = 3

const hslToRgb = (hue: number, saturationPercent: number, lightnessPercent: number): Rgb => {
  const saturation = saturationPercent / 100
  const lightness = lightnessPercent / 100
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const intermediate = chroma * (1 - Math.abs((hue / 60) % 2 - 1))
  const offset = lightness - chroma / 2
  const prime: Rgb = hue < 60
    ? [chroma, intermediate, 0]
    : hue < 120
      ? [intermediate, chroma, 0]
      : hue < 180
        ? [0, chroma, intermediate]
        : hue < 240
          ? [0, intermediate, chroma]
          : hue < 300
            ? [intermediate, 0, chroma]
            : [chroma, 0, intermediate]

  return prime.map((channel) => Math.round((channel + offset) * 255)) as Rgb
}

const rgbToHex = (rgb: Rgb) => (
  `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
)

const parseHexColor = (color: string): Rgb | null => {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  if (!match) return null
  return [0, 2, 4].map((offset) => (
    Number.parseInt(match[1].slice(offset, offset + 2), 16)
  )) as Rgb
}

const srgbToLinear = (channel: number) => {
  const normalized = channel / 255
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4
}

const relativeLuminance = (rgb: Rgb) => {
  const [red, green, blue] = rgb.map(srgbToLinear)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

const contrastAgainstWhite = (rgb: Rgb) => 1.05 / (relativeLuminance(rgb) + 0.05)

const rgbToOklab = (rgb: Rgb): Oklab => {
  const [red, green, blue] = rgb.map(srgbToLinear)
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue)
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue)
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

const squaredOklabDistance = (left: Oklab, right: Oklab) => (
  (left[0] - right[0]) ** 2
  + (left[1] - right[1]) ** 2
  + (left[2] - right[2]) ** 2
)

const generatedColorCandidate = (index: number) => {
  const hueFraction = ((index + 1) * GOLDEN_RATIO_CONJUGATE) % 1
  const hue = GENERATED_HUE_START + hueFraction * GENERATED_HUE_SPAN
  const saturation = GENERATED_SATURATIONS[index % GENERATED_SATURATIONS.length]
  let lightness = GENERATED_LIGHTNESSES[
    Math.floor(index / GENERATED_SATURATIONS.length) % GENERATED_LIGHTNESSES.length
  ]
  let rgb = hslToRgb(hue, saturation, lightness)

  while (contrastAgainstWhite(rgb) < MINIMUM_WHITE_CONTRAST && lightness > 24) {
    lightness -= 2
    rgb = hslToRgb(hue, saturation, lightness)
  }

  return { color: rgbToHex(rgb), oklab: rgbToOklab(rgb) }
}

/**
 * Assigns colours from the complete series order, not the current selection order.
 * Removing or re-adding a selected series therefore cannot recolour the others.
 * When the seed palette is exhausted, a deterministic low-discrepancy candidate
 * stream is extended by maximum OKLab distance instead of cycling back to colour 1.
 */
export function buildStableSeriesColorMap(
  seriesIds: readonly string[],
  palette: readonly string[] = DEFAULT_SERIES_COLOR_PALETTE,
): Map<string, string> {
  const colors = new Map<string, string>()
  const usedColors = new Set<string>()
  const usedOklab: Oklab[] = []
  let generatedCandidateIndex = 0

  seriesIds.forEach((seriesId) => {
    if (colors.has(seriesId)) return

    const paletteColor = colors.size < palette.length ? palette[colors.size] : undefined
    let color = paletteColor
    const paletteRgb = paletteColor ? parseHexColor(paletteColor) : null
    let selectedOklab = paletteRgb ? rgbToOklab(paletteRgb) : null

    if (!color || usedColors.has(color.toLowerCase())) {
      let best: { color: string; oklab: Oklab; minimumDistance: number } | null = null
      let evaluated = 0

      while (evaluated < GENERATED_COLOR_SEARCH_SIZE) {
        const candidate = generatedColorCandidate(generatedCandidateIndex)
        generatedCandidateIndex += 1
        if (usedColors.has(candidate.color)) continue
        evaluated += 1

        let minimumDistance = Number.POSITIVE_INFINITY
        for (const existing of usedOklab) {
          minimumDistance = Math.min(
            minimumDistance,
            squaredOklabDistance(candidate.oklab, existing),
          )
        }
        if (!best || minimumDistance > best.minimumDistance) {
          best = { ...candidate, minimumDistance }
        }
      }

      if (!best) return
      color = best.color
      selectedOklab = best.oklab
    }

    colors.set(seriesId, color)
    usedColors.add(color.toLowerCase())
    if (selectedOklab) usedOklab.push(selectedOklab)
  })
  return colors
}

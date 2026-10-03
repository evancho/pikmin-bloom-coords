/** One horizontal sample through a phone screenshot. */
export type CaptionRow = {
  y: number
  r: number
  g: number
  b: number
  contrast: number
}

/**
 * Pikmin Bloom postcard captions sit on a flat blue panel under the photo.
 * Status-bar blue is brighter; the caption panel is darker.
 */
export function isPostcardBlue(r: number, g: number, b: number): boolean {
  return b > r + 18 && b > 110 && b < 220 && g < b + 8 && r < 180
}

/**
 * Vertical band that contains the postcard's title / address lines.
 * Returns null when the screenshot does not look like that blue card.
 */
export function captionBandFromRows(
  rows: CaptionRow[],
  imageHeight: number,
): { y: number; height: number } | null {
  if (rows.length < 8 || imageHeight < 1) return null

  const blue = rows.map((row) => isPostcardBlue(row.r, row.g, row.b))
  const runs: Array<{ start: number; end: number }> = []
  let i = 0
  while (i < rows.length) {
    if (!blue[i]) {
      i += 1
      continue
    }
    let last = i
    let gapPx = 0
    let j = i
    while (j < rows.length) {
      if (blue[j]) {
        last = j
        gapPx = 0
      } else {
        const prevY = rows[Math.max(0, j - 1)]!.y
        gapPx += rows[j]!.y - prevY
        if (gapPx > 12) break
      }
      j += 1
    }
    runs.push({ start: i, end: last })
    i = last + 1
  }

  let best: { start: number; end: number; text: number[] } | null = null
  for (const run of runs) {
    const text: number[] = []
    for (let k = run.start; k <= run.end; k += 1) {
      if (rows[k]!.contrast > 6) text.push(k)
    }
    if (text.length < 2) continue
    if (!best || text.length > best.text.length) best = { ...run, text }
  }
  if (!best) return null

  const yBlue = rows[best.start]!.y
  const yText1 = rows[best.text[best.text.length - 1]!]!.y
  const padBot = Math.round(imageHeight * 0.02)
  const y0 = yBlue
  const y1 = Math.min(rows[best.end]!.y, yText1 + padBot)
  if (y1 - y0 < 40) return null
  return { y: y0, height: y1 - y0 }
}

/** Mean color and horizontal contrast for one image row. */
export function measureRow(
  pixels: Uint8ClampedArray,
  width: number,
  y: number,
  x0: number,
  x1: number,
): CaptionRow {
  let diff = 0
  let steps = 0
  let prev = -1
  let rs = 0
  let gs = 0
  let bs = 0
  let count = 0
  const row = y * width
  for (let x = x0; x < x1; x += 2) {
    const i = (row + x) * 4
    const r = pixels[i] ?? 0
    const g = pixels[i + 1] ?? 0
    const b = pixels[i + 2] ?? 0
    const lum = (r * 3 + g * 6 + b) / 10
    if (prev >= 0) {
      diff += Math.abs(lum - prev)
      steps += 1
    }
    prev = lum
    rs += r
    gs += g
    bs += b
    count += 1
  }
  const n = Math.max(count, 1)
  return {
    y,
    r: rs / n,
    g: gs / n,
    b: bs / n,
    contrast: diff / Math.max(steps, 1),
  }
}

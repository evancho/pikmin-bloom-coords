/** One horizontal sample through a phone screenshot. */
export type CaptionRow = {
  y: number
  r: number
  g: number
  b: number
  contrast: number
}

export type CaptionBand = {
  y: number
  height: number
  /** Row indices (into the sampled rows array) that look like text. */
  textRowIndexes: number[]
}

/**
 * Pikmin Bloom postcard captions sit on a flat blue or purple panel under the photo.
 * Status-bar chrome is brighter; the caption panel is darker.
 */
export function isPostcardBlue(r: number, g: number, b: number): boolean {
  // Classic teal/blue caption
  if (b > r + 18 && b > 110 && b < 220 && g < b + 8 && r < 180) return true
  // Night / event purple caption (e.g. Konvent Plasy / Kaldfjord card)
  if (b > 90 && r > 35 && g + 25 < b && r < b + 10 && g < 90) return true
  return false
}

/**
 * Vertical band that contains the postcard's title / address lines.
 * Returns null when the screenshot does not look like that blue/purple card.
 *
 * Prefers a flat caption panel (low background contrast with sparse text rows)
 * over photo regions that happen to match blue/purple (e.g. sky) where almost
 * every row looks "textured".
 */
export function captionBandFromRows(
  rows: CaptionRow[],
  imageHeight: number,
): CaptionBand | null {
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

  type ScoredRun = {
    start: number
    end: number
    text: number[]
    textRatio: number
    flatShare: number
    score: number
  }

  const scored: ScoredRun[] = []
  for (const run of runs) {
    const len = run.end - run.start + 1
    if (len < 3) continue
    const text: number[] = []
    let flat = 0
    for (let k = run.start; k <= run.end; k += 1) {
      const c = rows[k]!.contrast
      if (c > 4) text.push(k)
      if (c < 1) flat += 1
    }
    if (text.length < 2) continue
    const textRatio = text.length / len
    const flatShare = flat / len
    // Photo sky / water: almost every row is textured → skip.
    if (textRatio > 0.5) continue
    // Caption cards have a flat purple/blue field between sparse glyph rows.
    let score = text.length * 2 + flatShare * 20
    // Prefer bands in the lower half of the screenshot (under the photo).
    const midY = (rows[run.start]!.y + rows[run.end]!.y) / 2
    if (midY > imageHeight * 0.45) score += 8
    scored.push({ ...run, text, textRatio, flatShare, score })
  }
  if (!scored.length) return null
  scored.sort((a, b) => b.score - a.score || b.text.length - a.text.length)
  const best = scored[0]!

  // Start at the first flat row that is still above the title. A flat row
  // after the title is the gap between lines, not the top of the card.
  let startIdx = best.start
  const firstText = best.text[0]!
  for (let k = best.start; k <= firstText; k += 1) {
    if (rows[k]!.contrast < 1) {
      startIdx = k
      break
    }
  }
  // End at last text row + ~1% of image height — do not stretch into the
  // page chrome / snow fringe below the caption card.
  const lastTextIdx = best.text[best.text.length - 1]!
  const padBot = Math.max(8, Math.round(imageHeight * 0.01))
  const y0 = Math.max(0, rows[startIdx]!.y)
  const y1 = Math.min(imageHeight, rows[lastTextIdx]!.y + padBot)
  if (y1 - y0 < 40) return null

  // Remap text indexes relative to the returned band's absolute rows.
  const textRowIndexes = best.text
    .map((idx) => idx - startIdx)
    .filter((idx) => idx >= 0)

  return { y: y0, height: y1 - y0, textRowIndexes }
}

/**
 * Split a caption band into title (first text cluster) and address/footer
 * (remaining text clusters) using contrast spikes inside the cropped panel.
 */
export function captionLineBandsFromRows(
  rows: CaptionRow[],
): { title: { y: number; height: number } | null; footer: { y: number; height: number } | null } {
  if (rows.length < 4) return { title: null, footer: null }
  const textIdx: number[] = []
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]!.contrast > 4) textIdx.push(i)
  }
  if (!textIdx.length) return { title: null, footer: null }

  // Cluster consecutive text rows (gap > 3 samples → new cluster).
  const clusters: Array<{ start: number; end: number }> = []
  let cs = textIdx[0]!
  let ce = textIdx[0]!
  for (let i = 1; i < textIdx.length; i += 1) {
    const idx = textIdx[i]!
    if (idx - ce <= 3) {
      ce = idx
    } else {
      clusters.push({ start: cs, end: ce })
      cs = idx
      ce = idx
    }
  }
  clusters.push({ start: cs, end: ce })

  const pad = 4
  const toBand = (c: { start: number; end: number }) => {
    const y0 = Math.max(0, rows[c.start]!.y - pad)
    const y1 = rows[c.end]!.y + pad
    return { y: y0, height: Math.max(12, y1 - y0) }
  }

  const title = clusters[0] ? toBand(clusters[0]) : null
  const footer =
    clusters.length >= 2
      ? (() => {
          const first = clusters[1]!
          const last = clusters[clusters.length - 1]!
          const y0 = Math.max(0, rows[first.start]!.y - pad)
          const y1 = rows[last.end]!.y + pad
          return { y: y0, height: Math.max(12, y1 - y0) }
        })()
      : null

  return { title, footer }
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

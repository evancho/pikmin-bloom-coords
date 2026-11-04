/** Shared canvas image helpers for OCR preprocessing (browser only). */

export async function blobToImageData(
  image: Blob,
): Promise<{ data: ImageData; width: number; height: number } | null> {
  if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') {
    return null
  }
  const bitmap = await createImageBitmap(image)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    bitmap.close()
    return null
  }
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { data, width: canvas.width, height: canvas.height }
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas toBlob failed'))),
      'image/png',
    )
  })
}

/** Otsu threshold on inverted luminance (white glyphs → dark ink). */
export function otsuThreshold(lums: Uint8Array): number {
  const hist = new Array<number>(256).fill(0)
  for (let i = 0; i < lums.length; i += 1) hist[lums[i]!]! += 1
  const total = lums.length
  let sum = 0
  for (let i = 0; i < 256; i += 1) sum += i * hist[i]!
  let sumB = 0
  let wB = 0
  let max = 0
  let threshold = 127
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t]!
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]!
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > max) {
      max = between
      threshold = t
    }
  }
  return threshold
}

/**
 * Invert white-on-dark caption text and apply Otsu binarization.
 * Falls back to a mild contrast stretch when canvas APIs are missing.
 */
export async function enhanceForLatinOcr(image: Blob): Promise<Blob> {
  const loaded = await blobToImageData(image)
  if (!loaded) return image
  const { data, width, height } = loaded
  const lums = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < data.data.length; i += 4, p += 1) {
    const r = data.data[i] ?? 0
    const g = data.data[i + 1] ?? 0
    const b = data.data[i + 2] ?? 0
    // Invert so white glyphs become dark.
    lums[p] = Math.max(
      0,
      Math.min(255, Math.round(255 - (r * 0.299 + g * 0.587 + b * 0.114))),
    )
  }
  const thr = otsuThreshold(lums)
  for (let i = 0, p = 0; i < data.data.length; i += 4, p += 1) {
    const v = (lums[p] ?? 0) > thr ? 255 : 0
    data.data[i] = v
    data.data[i + 1] = v
    data.data[i + 2] = v
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return image
  ctx.putImageData(data, 0, 0)
  return canvasToPng(canvas)
}

/**
 * Postcard captions are light glyphs on a blue/purple field.
 * Invert, then stretch, so Tesseract sees dark text on white.
 */
export async function enhanceForCjkOcr(image: Blob): Promise<Blob> {
  const loaded = await blobToImageData(image)
  if (!loaded) return image
  const { data, width, height } = loaded
  let min = 255
  let max = 0
  const lums = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < data.data.length; i += 4, p += 1) {
    const r = data.data[i] ?? 0
    const g = data.data[i + 1] ?? 0
    const b = data.data[i + 2] ?? 0
    const lum = 255 - Math.round(r * 0.299 + g * 0.587 + b * 0.114)
    lums[p] = lum
    if (lum < min) min = lum
    if (lum > max) max = lum
  }
  const span = Math.max(1, max - min)
  for (let i = 0, p = 0; i < data.data.length; i += 4, p += 1) {
    const v = Math.round(((lums[p]! - min) / span) * 255)
    data.data[i] = v
    data.data[i + 1] = v
    data.data[i + 2] = v
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return image
  ctx.putImageData(data, 0, 0)
  return canvasToPng(canvas)
}

/** Scale so typical glyph height is ~targetPx (default 36). */
export async function scaleToGlyphHeight(
  image: Blob,
  estimatedGlyphPx: number,
  targetPx = 36,
  minScale = 1.2,
): Promise<Blob> {
  if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') {
    return image
  }
  const glyph = Math.max(8, estimatedGlyphPx)
  const scale = Math.min(3.5, Math.max(minScale, targetPx / glyph))
  if (Math.abs(scale - 1) < 0.15) return image
  const bitmap = await createImageBitmap(image)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return image
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvasToPng(canvas)
}

export async function cropRect(
  image: Blob | ImageBitmap,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  scale = 1,
): Promise<Blob> {
  const bitmap =
    image instanceof Blob ? await createImageBitmap(image) : image
  const owns = image instanceof Blob
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    if (owns) bitmap.close()
    throw new Error('2d context unavailable')
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  if (owns) bitmap.close()
  return canvasToPng(canvas)
}

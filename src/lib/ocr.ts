import { createWorker, PSM, type Worker } from 'tesseract.js'
import { captionBandFromRows, measureRow } from './captionCrop'

let workerPromise: Promise<Worker> | null = null
let activeLangs = ''

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker(['jpn', 'eng'])
      activeLangs = 'jpn+eng'
      await worker.setParameters({
        preserve_interword_spaces: '1',
      })
      return worker
    })()
  }
  return workerPromise
}

async function withLang(langs: string, pageSegMode: PSM): Promise<Worker> {
  const worker = await getWorker()
  if (activeLangs !== langs) {
    await worker.reinitialize(langs)
    activeLangs = langs
  }
  await worker.setParameters({
    preserve_interword_spaces: '1',
    tessedit_pageseg_mode: pageSegMode,
  })
  return worker
}

export type OcrMode = 'postcard' | 'full'

async function imageBlob(image: File | Blob | string): Promise<Blob> {
  if (typeof image === 'string') {
    const res = await fetch(image)
    return res.blob()
  }
  return image
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas toBlob failed'))),
      'image/png',
    )
  })
}

/**
 * Crop the blue caption under the postcard photo and scale it up.
 * Falls back to the middle of the screen when that panel isn't found.
 */
async function cropForPostcard(image: File | Blob | string): Promise<Blob> {
  if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') {
    return imageBlob(image)
  }

  const blob = await imageBlob(image)
  const bitmap = await createImageBitmap(blob)
  const w = bitmap.width
  const h = bitmap.height

  const sample = document.createElement('canvas')
  sample.width = w
  sample.height = h
  const sampleCtx = sample.getContext('2d', { willReadFrequently: true })
  if (!sampleCtx) {
    bitmap.close()
    return blob
  }
  sampleCtx.drawImage(bitmap, 0, 0)
  const x0 = Math.floor(w * 0.1)
  const x1 = Math.floor(w * 0.9)
  const yStart = Math.floor(h * 0.28)
  const yEnd = Math.floor(h * 0.82)
  const region = sampleCtx.getImageData(0, 0, w, h)
  const rows = []
  for (let y = yStart; y < yEnd; y += 2) {
    rows.push(measureRow(region.data, w, y, x0, x1))
  }
  const band = captionBandFromRows(rows, h)

  const sx = Math.floor(w * 0.07)
  const sw = Math.floor(w * 0.86)
  let sy: number
  let sh: number
  let scale = 1
  if (band) {
    sy = band.y
    sh = band.height
    scale = 2
  } else {
    sy = Math.floor(h * 0.12)
    sh = Math.floor(h * 0.62)
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sw * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return blob
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvasToPng(canvas)
}

export async function recognizeText(
  image: File | Blob | string,
  onProgress?: (pct: number) => void,
  mode: OcrMode = 'postcard',
): Promise<string> {
  onProgress?.(15)
  let target: Blob | File | string = image
  if (mode === 'postcard') {
    try {
      target = await cropForPostcard(image)
    } catch {
      target = image
    }
  }
  onProgress?.(40)

  // One combined jpn+eng pass misreads Latin titles as kana. On the caption
  // crop, read Japanese and English separately and let the parser choose.
  if (mode === 'postcard') {
    const jpnWorker = await withLang('jpn', PSM.SINGLE_BLOCK)
    const jpn = await jpnWorker.recognize(target)
    onProgress?.(70)
    const engWorker = await withLang('eng', PSM.SINGLE_BLOCK)
    const eng = await engWorker.recognize(target)
    onProgress?.(100)
    // Keep the passes separate so a longer Japanese misread of the same
    // Latin title cannot outrank the English pass.
    return `---eng---\n${eng.data.text ?? ''}\n---jpn---\n${jpn.data.text ?? ''}`
  }

  const worker = await withLang('jpn+eng', PSM.AUTO)
  const result = await worker.recognize(target)
  onProgress?.(100)
  return result.data.text ?? ''
}

/** OCR several screenshots (postcard crop for first, full frame for rest/maps). */
export async function recognizeMany(
  images: Array<File | Blob>,
  onProgress?: (pct: number) => void,
): Promise<string[]> {
  const out: string[] = []
  const n = images.length
  for (let i = 0; i < n; i++) {
    const mode: OcrMode = i === 0 ? 'postcard' : 'full'
    const text = await recognizeText(images[i]!, (p) => {
      const base = (i / n) * 100
      onProgress?.(Math.round(base + p / n))
    }, mode)
    out.push(text)
  }
  return out
}

export async function terminateOcr(): Promise<void> {
  if (!workerPromise) return
  const w = await workerPromise
  await w.terminate()
  workerPromise = null
  activeLangs = ''
}

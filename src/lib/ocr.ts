import { createWorker, PSM, type Worker } from 'tesseract.js'
import { captionBandFromRows, measureRow } from './captionCrop'

let workerPromise: Promise<Worker> | null = null
let activeLangs = ''

const LATIN_WHITELIST =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÁÄÅÆÇÉÍÐÑÓÖØÚÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿĀāĂăĄąĆćĈĉĊċČčĎďĐđĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦħĨĩĪīĬĭĮįİıĲĳĴĵĶķĸĹĺĻļĽľĿŀŁłŃńŅņŇňŉŊŋŌōŎŏŐőŒœŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŦŧŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽž -'’."

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

async function withLang(
  langs: string,
  pageSegMode: PSM,
  extra: Record<string, string> = {},
): Promise<Worker> {
  const worker = await getWorker()
  if (activeLangs !== langs) {
    await worker.reinitialize(langs)
    activeLangs = langs
  }
  await worker.setParameters({
    preserve_interword_spaces: '1',
    tessedit_pageseg_mode: pageSegMode,
    // Clear any previous whitelist when not provided.
    tessedit_char_whitelist: '',
    ...extra,
  })
  return worker
}

export type OcrMode = 'postcard' | 'full'

/** User-selectable OCR language bias. Auto still runs eng+jpn. */
export type OcrLangPref = 'auto' | 'ja' | 'en'

export const OCR_LANG_STORAGE_KEY = 'bloom-pin-ocr-lang'

export function loadOcrLangPref(): OcrLangPref {
  try {
    const v = localStorage.getItem(OCR_LANG_STORAGE_KEY)
    if (v === 'ja' || v === 'en' || v === 'auto') return v
  } catch {
    /* ignore */
  }
  return 'auto'
}

export function saveOcrLangPref(pref: OcrLangPref): void {
  try {
    localStorage.setItem(OCR_LANG_STORAGE_KEY, pref)
  } catch {
    /* ignore */
  }
}

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
 * Crop the blue/purple caption under the postcard photo and scale it up.
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

/** White-on-dark postcard text → dark-on-light for Tesseract English. */
async function enhanceForLatinOcr(image: Blob): Promise<Blob> {
  if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') {
    return image
  }
  const bitmap = await createImageBitmap(image)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    bitmap.close()
    return image
  }
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[i + 2] ?? 0
    // Invert luminance and stretch contrast so white glyphs become dark ink.
    let lum = 255 - (r * 0.299 + g * 0.587 + b * 0.114)
    lum = Math.max(0, Math.min(255, (lum - 40) * 1.55))
    data[i] = lum
    data[i + 1] = lum
    data[i + 2] = lum
  }
  ctx.putImageData(new ImageData(data, width, height), 0, 0)
  return canvasToPng(canvas)
}

/** Top of the caption is the bold place name — OCR it as a single line. */
async function cropTitleLine(image: Blob): Promise<Blob> {
  if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') {
    return image
  }
  const bitmap = await createImageBitmap(image)
  const w = bitmap.width
  const h = bitmap.height
  const sy = Math.floor(h * 0.08)
  const sh = Math.max(24, Math.floor(h * 0.28))
  const canvas = document.createElement('canvas')
  const scale = 1.5
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return image
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, sy, w, sh, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvasToPng(canvas)
}

/** Bottom of the caption often holds "In X bei der Kirche" / distance lines. */
async function cropFooterLines(image: Blob): Promise<Blob> {
  if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') {
    return image
  }
  const bitmap = await createImageBitmap(image)
  const w = bitmap.width
  const h = bitmap.height
  const sy = Math.floor(h * 0.45)
  const sh = Math.max(24, h - sy)
  const canvas = document.createElement('canvas')
  const scale = 2
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(sh * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return image
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, sy, w, sh, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvasToPng(canvas)
}

export async function recognizeText(
  image: File | Blob | string,
  onProgress?: (pct: number) => void,
  mode: OcrMode = 'postcard',
  langPref: OcrLangPref = 'auto',
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
  onProgress?.(35)

  // One combined jpn+eng pass misreads Latin titles as kana. On the caption
  // crop, read Japanese and English separately and let the parser choose.
  if (mode === 'postcard') {
    const caption = target instanceof Blob ? target : await imageBlob(target)
    // ja: still run eng so distance lines like "Kyoto Fushimi Ward" survive;
    // the parser (langPref) decides whether Latin titles may beat Japanese.
    const runEng = true
    const runJpn = langPref !== 'en'
    let engText = ''
    let jpnText = ''

    if (runEng) {
      const latinReady = await enhanceForLatinOcr(caption)
      const titleBand = await cropTitleLine(latinReady)
      const footerBand = await cropFooterLines(latinReady)

      // English-only / auto: OCR the bold title line. Japanese-priority skips
      // this pass — eng single-line often invents junk like "an vere…".
      let engTitleText = ''
      if (langPref !== 'ja') {
        const engTitleWorker = await withLang('eng', PSM.SINGLE_LINE, {
          tessedit_char_whitelist: LATIN_WHITELIST,
        })
        const engTitle = await engTitleWorker.recognize(titleBand)
        engTitleText = engTitle.data.text ?? ''
      }
      onProgress?.(runJpn ? 45 : 55)

      const engFullWorker = await withLang('eng', PSM.SINGLE_BLOCK, {
        // Keep digits for the distance line; still block ampersand noise.
        tessedit_char_whitelist: LATIN_WHITELIST + '0123456789,:/：',
      })
      const engFull = await engFullWorker.recognize(latinReady)
      onProgress?.(runJpn ? 60 : 80)

      const engFooterWorker = await withLang('eng', PSM.SINGLE_BLOCK, {
        tessedit_char_whitelist: LATIN_WHITELIST + '0123456789,:/：',
      })
      const engFooter = await engFooterWorker.recognize(footerBand)
      engText = [engTitleText, engFull.data.text, engFooter.data.text]
        .filter(Boolean)
        .join('\n')
    }

    if (runJpn) {
      onProgress?.(runEng ? 80 : 55)
      const jpnWorker = await withLang('jpn', PSM.SINGLE_BLOCK)
      const jpn = await jpnWorker.recognize(caption)
      jpnText = jpn.data.text ?? ''
    }

    if (langPref === 'en' && !jpnText) {
      jpnText = engText
    }

    onProgress?.(100)
    return `---eng---\n${engText}\n---jpn---\n${jpnText}`
  }

  const mapLangs =
    langPref === 'ja' ? 'jpn' : langPref === 'en' ? 'eng' : 'jpn+eng'
  const worker = await withLang(mapLangs, PSM.AUTO)
  const result = await worker.recognize(target)
  onProgress?.(100)
  return result.data.text ?? ''
}

/** OCR several screenshots (postcard crop for first, full frame for rest/maps). */
export async function recognizeMany(
  images: Array<File | Blob>,
  onProgress?: (pct: number) => void,
  langPref: OcrLangPref = 'auto',
): Promise<string[]> {
  const out: string[] = []
  const n = images.length
  for (let i = 0; i < n; i++) {
    const mode: OcrMode = i === 0 ? 'postcard' : 'full'
    const text = await recognizeText(
      images[i]!,
      (p) => {
        const base = (i / n) * 100
        onProgress?.(Math.round(base + p / n))
      },
      mode,
      langPref,
    )
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

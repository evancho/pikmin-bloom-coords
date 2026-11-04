import { createWorker, PSM, type Worker } from 'tesseract.js'
import {
  captionBandFromRows,
  captionLineBandsFromRows,
  measureRow,
} from './captionCrop'
import {
  cropRect,
  enhanceForCjkOcr,
  enhanceForLatinOcr,
  scaleToGlyphHeight,
} from './imageEnhance'

type WorkerSlot = {
  langs: string
  worker: Worker | null
  loading: Promise<Worker> | null
}

const slots: Record<string, WorkerSlot> = {
  eng: { langs: 'eng', worker: null, loading: null },
  jpn: { langs: 'jpn', worker: null, loading: null },
  nor: { langs: 'nor', worker: null, loading: null },
  'eng+nor': { langs: 'eng+nor', worker: null, loading: null },
  chi: { langs: 'chi_tra+chi_sim', worker: null, loading: null },
}

const LATIN_WHITELIST =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÁÄÅÆÇÉÍÐÑÓÖØÚÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿĀāĂăĄąĆćĈĉĊċČčĎďĐđĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦħĨĩĪīĬĭĮįİıĲĳĴĵĶķĸĹĺĻļĽľĿŀŁłŃńŅņŇňŉŊŋŌōŎŏŐőŒœŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŦŧŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽž -'’."

const MIN_WORD_CONFIDENCE = 40

async function getLangWorker(key: keyof typeof slots): Promise<Worker> {
  const slot = slots[key]!
  if (slot.worker) return slot.worker
  if (!slot.loading) {
    slot.loading = (async () => {
      const langs = slot.langs.includes('+')
        ? slot.langs.split('+')
        : [slot.langs]
      const worker = await createWorker(langs)
      await worker.setParameters({ preserve_interword_spaces: '1' })
      slot.worker = worker
      return worker
    })()
  }
  return slot.loading
}

async function recognizeWith(
  key: keyof typeof slots,
  image: Blob,
  pageSegMode: PSM,
  extra: Record<string, string> = {},
): Promise<{ text: string; confidence: number }> {
  const worker = await getLangWorker(key)
  await worker.setParameters({
    preserve_interword_spaces: '1',
    tessedit_pageseg_mode: pageSegMode,
    tessedit_char_whitelist: '',
    ...extra,
  })
  const result = await worker.recognize(image)
  // tesseract.js v7: words live under blocks → paragraphs → lines.
  const words: Array<{ text: string; confidence: number }> = []
  for (const block of result.data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          words.push({ text: w.text, confidence: w.confidence })
        }
      }
    }
  }
  const confs = words
    .map((w) => w.confidence)
    .filter((c): c is number => typeof c === 'number' && Number.isFinite(c))
  const mean =
    confs.length > 0
      ? confs.reduce((a, b) => a + b, 0) / confs.length
      : (result.data.confidence ?? 0)
  // Drop very-low-confidence tokens from the searchable string.
  let text = result.data.text ?? ''
  if (words.length) {
    const kept = words
      .filter((w) => (w.confidence ?? 0) >= MIN_WORD_CONFIDENCE)
      .map((w) => w.text)
      .filter(Boolean)
    if (kept.length) text = kept.join(' ')
  }
  return { text, confidence: mean }
}

export type OcrMode = 'postcard' | 'full'

/** User-selectable OCR language bias. Auto still runs eng+jpn. */
export type OcrLangPref = 'auto' | 'ja' | 'en' | 'zh'

export const OCR_LANG_STORAGE_KEY = 'bloom-pin-ocr-lang'

export function loadOcrLangPref(): OcrLangPref {
  try {
    const v = localStorage.getItem(OCR_LANG_STORAGE_KEY)
    if (v === 'ja' || v === 'en' || v === 'zh' || v === 'auto') return v
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

type PostcardCrop = {
  caption: Blob
  titleBand: Blob | null
  footerBand: Blob | null
  glyphPx: number
}

async function cropPostcardParts(
  image: File | Blob | string,
): Promise<PostcardCrop> {
  const blob = await imageBlob(image)
  if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') {
    return { caption: blob, titleBand: null, footerBand: null, glyphPx: 18 }
  }

  const bitmap = await createImageBitmap(blob)
  const w = bitmap.width
  const h = bitmap.height
  const sample = document.createElement('canvas')
  sample.width = w
  sample.height = h
  const sampleCtx = sample.getContext('2d', { willReadFrequently: true })
  if (!sampleCtx) {
    bitmap.close()
    return { caption: blob, titleBand: null, footerBand: null, glyphPx: 18 }
  }
  sampleCtx.drawImage(bitmap, 0, 0)
  const x0 = Math.floor(w * 0.1)
  const x1 = Math.floor(w * 0.9)
  // Include lower purple cards (Kaldfjord ~0.72–0.84 of frame).
  const yStart = Math.floor(h * 0.25)
  const yEnd = Math.floor(h * 0.92)
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
  if (band) {
    sy = band.y
    sh = band.height
  } else {
    sy = Math.floor(h * 0.45)
    sh = Math.floor(h * 0.35)
  }

  const caption = await cropRect(bitmap, sx, sy, sw, sh, 1)

  // Re-measure inside the caption crop for title / footer line bands.
  const capBitmap = await createImageBitmap(caption)
  const capCanvas = document.createElement('canvas')
  capCanvas.width = capBitmap.width
  capCanvas.height = capBitmap.height
  const capCtx = capCanvas.getContext('2d', { willReadFrequently: true })
  let titleBand: Blob | null = null
  let footerBand: Blob | null = null
  let glyphPx = Math.max(12, Math.round(capBitmap.height * 0.12))
  if (capCtx) {
    capCtx.drawImage(capBitmap, 0, 0)
    const capData = capCtx.getImageData(0, 0, capBitmap.width, capBitmap.height)
    const capRows = []
    for (let y = 0; y < capBitmap.height; y += 2) {
      capRows.push(
        measureRow(capData.data, capBitmap.width, y, 0, capBitmap.width),
      )
    }
    const lines = captionLineBandsFromRows(capRows)
    if (lines.title) {
      glyphPx = Math.max(10, lines.title.height)
      titleBand = await cropRect(
        capBitmap,
        0,
        lines.title.y,
        capBitmap.width,
        lines.title.height,
        1,
      )
    }
    if (lines.footer) {
      footerBand = await cropRect(
        capBitmap,
        0,
        lines.footer.y,
        capBitmap.width,
        lines.footer.height,
        1,
      )
    }
  }
  capBitmap.close()
  bitmap.close()
  return { caption, titleBand, footerBand, glyphPx }
}

/** Crop status bar + bottom tab bar from a Bloom map screenshot. */
async function cropMapContent(image: File | Blob | string): Promise<Blob> {
  const blob = await imageBlob(image)
  if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') {
    return blob
  }
  const bitmap = await createImageBitmap(blob)
  const w = bitmap.width
  const h = bitmap.height
  const sy = Math.floor(h * 0.08)
  const sh = Math.floor(h * 0.78)
  const out = await cropRect(bitmap, 0, sy, w, sh, 1)
  bitmap.close()
  return out
}

function voteTexts(parts: Array<{ text: string; confidence: number }>): string {
  const scored = parts
    .map((p) => ({
      text: (p.text ?? '').replace(/\s+/g, ' ').trim(),
      confidence: p.confidence,
    }))
    .filter((p) => p.text.length >= 2)
  if (!scored.length) return ''
  scored.sort(
    (a, b) =>
      b.confidence - a.confidence || b.text.length - a.text.length,
  )
  // Prefer a string that appears in more than one pass.
  const counts = new Map<string, { n: number; conf: number }>()
  for (const s of scored) {
    const key = s.text.toLowerCase()
    const cur = counts.get(key) ?? { n: 0, conf: 0 }
    cur.n += 1
    cur.conf = Math.max(cur.conf, s.confidence)
    counts.set(key, cur)
  }
  let bestKey = scored[0]!.text
  let bestScore = -1
  for (const [key, v] of counts) {
    const score = v.n * 10 + v.conf
    if (score > bestScore) {
      bestScore = score
      bestKey = scored.find((s) => s.text.toLowerCase() === key)?.text ?? key
    }
  }
  return bestKey
}

export async function recognizeText(
  image: File | Blob | string,
  onProgress?: (pct: number) => void,
  mode: OcrMode = 'postcard',
  langPref: OcrLangPref = 'auto',
): Promise<string> {
  onProgress?.(10)

  if (mode === 'postcard') {
    const parts = await cropPostcardParts(image)
    onProgress?.(25)
    const runCjk = langPref !== 'en'
    let engText = ''
    let jpnText = ''
    let chiText = ''

    const latinCaption = await enhanceForLatinOcr(parts.caption)
    const scaledCaption = await scaleToGlyphHeight(
      latinCaption,
      parts.glyphPx,
      36,
    )
    onProgress?.(35)

    const engVotes: Array<{ text: string; confidence: number }> = []

    if (parts.titleBand && (langPref === 'auto' || langPref === 'en')) {
      const titleEnh = await enhanceForLatinOcr(parts.titleBand)
      const titleScaled = await scaleToGlyphHeight(titleEnh, parts.glyphPx, 38)
      const titleHit = await recognizeWith('eng', titleScaled, PSM.SINGLE_LINE, {
        tessedit_char_whitelist: LATIN_WHITELIST,
      })
      engVotes.push(titleHit)
    }

    const fullHit = await recognizeWith('eng', scaledCaption, PSM.SINGLE_BLOCK, {
      tessedit_char_whitelist: LATIN_WHITELIST + '0123456789,:/：',
    })
    engVotes.push(fullHit)
    onProgress?.(50)

    if (parts.footerBand) {
      const footEnh = await enhanceForLatinOcr(parts.footerBand)
      const footScaled = await scaleToGlyphHeight(
        footEnh,
        Math.max(10, parts.glyphPx * 0.7),
        34,
      )
      // Norwegian ø etc. — eng alone often fails on "Kvaløya".
      const footNor = await recognizeWith(
        'eng+nor',
        footScaled,
        PSM.SINGLE_BLOCK,
        { tessedit_char_whitelist: LATIN_WHITELIST + '0123456789,:/：' },
      )
      engVotes.push(footNor)
      const footEng = await recognizeWith('eng', footScaled, PSM.SINGLE_BLOCK, {
        tessedit_char_whitelist: LATIN_WHITELIST + '0123456789,:/：',
      })
      engVotes.push(footEng)
    }
    onProgress?.(65)

    const votedTitle = voteTexts(engVotes)
    engText = [votedTitle, ...engVotes.map((v) => v.text)]
      .filter(Boolean)
      .join('\n')

    if (runCjk) {
      onProgress?.(75)
      const cjkReady = await enhanceForCjkOcr(parts.caption)
      const cjkScaled = await scaleToGlyphHeight(cjkReady, parts.glyphPx, 34)
      const cjkVotes: Array<{ text: string; confidence: number }> = []
      if (parts.titleBand) {
        const titleCjk = await enhanceForCjkOcr(parts.titleBand)
        const titleScaled = await scaleToGlyphHeight(
          titleCjk,
          parts.glyphPx,
          36,
        )
        if (langPref === 'zh') {
          cjkVotes.push(
            await recognizeWith('chi', titleScaled, PSM.SINGLE_LINE),
          )
        } else {
          cjkVotes.push(
            await recognizeWith('jpn', titleScaled, PSM.SINGLE_LINE),
          )
        }
      }
      if (langPref === 'zh') {
        cjkVotes.push(await recognizeWith('chi', cjkScaled, PSM.SINGLE_BLOCK))
        chiText = [voteTexts(cjkVotes), ...cjkVotes.map((v) => v.text)]
          .filter(Boolean)
          .join('\n')
      } else {
        cjkVotes.push(await recognizeWith('jpn', cjkScaled, PSM.SINGLE_BLOCK))
        if (parts.footerBand) {
          const footCjk = await enhanceForCjkOcr(parts.footerBand)
          const footScaled = await scaleToGlyphHeight(
            footCjk,
            Math.max(10, parts.glyphPx * 0.7),
            32,
          )
          cjkVotes.push(
            await recognizeWith('jpn', footScaled, PSM.SINGLE_BLOCK),
          )
        }
        jpnText = [voteTexts(cjkVotes), ...cjkVotes.map((v) => v.text)]
          .filter(Boolean)
          .join('\n')
        // Consensus: if jpn also produces Latin-looking title, keep it.
        if (/[A-Za-zÀ-ÿ]{4,}/.test(jpnText)) {
          engText = `${engText}\n${jpnText}`
        }
      }
    }

    if (langPref === 'en' && !jpnText) jpnText = engText
    if (langPref === 'zh' && chiText && !jpnText) jpnText = chiText

    onProgress?.(100)
    return `---eng---\n${engText}\n---jpn---\n${jpnText}\n---chi---\n${chiText}`
  }

  // Map / full-frame: crop chrome, scale, sparse text.
  onProgress?.(30)
  let target = await imageBlob(image)
  try {
    target = await cropMapContent(image)
  } catch {
    /* keep full */
  }
  const mapScaled = await scaleToGlyphHeight(target, 14, 32)
  onProgress?.(55)

  const mapKey: keyof typeof slots =
    langPref === 'ja'
      ? 'jpn'
      : langPref === 'zh'
        ? 'chi'
        : langPref === 'en'
          ? 'eng'
          : 'eng'
  const mapHit = await recognizeWith(
    mapKey,
    mapScaled,
    // Sparse labels on a pale map.
    PSM.SPARSE_TEXT,
  )
  onProgress?.(85)
  let mapText = mapHit.text
  // fi/fj OCR confusion for Nordic place names (Kaldfjord ↔ Kaldiford).
  if (/\bfi\b|[A-Za-z]fi[a-z]/i.test(mapText)) {
    mapText = `${mapText}\n${mapText.replace(/fi/gi, 'fj')}`
  }
  if (/\bfj\b|[A-Za-z]fj[a-z]/i.test(mapText)) {
    mapText = `${mapText}\n${mapText.replace(/fj/gi, 'fi')}`
  }
  onProgress?.(100)
  return `---eng---\n${mapText}\n---jpn---\n${mapText}\n---chi---\n`
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
  for (const key of Object.keys(slots) as Array<keyof typeof slots>) {
    const slot = slots[key]!
    if (slot.worker) {
      await slot.worker.terminate()
      slot.worker = null
      slot.loading = null
    }
  }
}

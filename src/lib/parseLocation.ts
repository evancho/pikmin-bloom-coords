import type { ParsedLocation } from '../types'

/** Remove spurious spaces Tesseract inserts between CJK characters. */
export function normalizeOcrText(raw: string): string {
  let s = raw.replace(/\r\n/g, '\n')
  for (let i = 0; i < 8; i++) {
    const next = s.replace(
      /([\u3040-\u30ff\u3400-\u9fff\uff00-\uffef])[ \t\u3000]+(?=[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef])/g,
      '$1',
    )
    if (next === s) break
    s = next
  }
  s = s
    .replace(/[・･‥]/g, '：')
    .replace(/[：:]{2,}/g, '：')
    .replace(/[|｜]/g, ' ')
  return s
}

const UI_NOISE =
  /^(記錄|记录|皮克敏|花苗|探險|探险|明信片|探險|記録)$/

function cleanLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

function hasCjk(s: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(s)
}

function looksLikeAddress(s: string): boolean {
  return /[都道府県市区町村]|大字|字|町|村|市|区|縣|県/.test(s)
}

function looksLikeClock(s: string): boolean {
  return /^\d{1,2}:\d{2}/.test(s)
}

function isUiChrome(s: string): boolean {
  if (UI_NOISE.test(s)) return true
  if (looksLikeClock(s)) return true
  if (/^\d+%$/.test(s)) return true
  if (/^(距離|距离|Distance)/i.test(s) && !looksLikeAddress(s)) return true
  return false
}

function extractAddressFromDistanceLine(line: string): string | null {
  const m = line.match(
    /(?:距離|距离|Distance)\s*[:：]?\s*[\d,，.]+\s*m?\s*(.+)$/i,
  )
  if (!m) return null
  const rest = cleanLine(m[1])
  return rest.length >= 2 ? rest : null
}

function scoreTitle(line: string): number {
  let score = 0
  if (/神社|寺|駅|站|公園|滝|瀧|城|橋|港|山|湖|館|堂|宮|院|塔/.test(line)) {
    score += 5
  }
  if (line.length <= 12) score += 2
  if (line.length <= 6) score += 1
  if (looksLikeAddress(line)) score -= 5
  if (/。/.test(line)) score -= 5
  if (isUiChrome(line)) score -= 10
  // Reject pure OCR garbage with latin/symbols dominant
  const cjk = (line.match(/[\u3040-\u30ff\u3400-\u9fff]/g) ?? []).length
  if (cjk < line.replace(/\s/g, '').length * 0.6) score -= 3
  return score
}

function extractFalls(text: string): string[] {
  const found = new Set<string>()
  const re = /([一-龯ぁ-んァ-ン]{1,8}[滝瀧])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    found.add(m[1])
    if (/暁風の滝/.test(m[1])) found.add('暁嵐の滝')
  }
  return [...found]
}

/**
 * Pull title / address / description hints from Pikmin Bloom OCR text.
 */
export function parseLocationFromOcr(rawText: string): ParsedLocation {
  const normalized = normalizeOcrText(rawText)
  const lines = normalized
    .split('\n')
    .map(cleanLine)
    .filter((l) => l.length > 0)

  let title: string | null = null
  let address: string | null = null
  let description: string | null = null

  for (const line of lines) {
    const after = extractAddressFromDistanceLine(line)
    if (after) {
      address = after
      continue
    }
  }

  const cjkLines = lines.filter(
    (l) =>
      hasCjk(l) &&
      !isUiChrome(l) &&
      !/^[0-9:%.\s]+$/.test(l) &&
      l.length >= 2 &&
      l.length <= 60,
  )

  const ranked = [...cjkLines].sort((a, b) => scoreTitle(b) - scoreTitle(a))
  title = ranked.find((l) => scoreTitle(l) > 0) ?? null

  if (!address) {
    address = cjkLines.find((l) => looksLikeAddress(l)) ?? null
  }
  if (address) {
    address = cleanLine(
      address.replace(/^(?:距離|距离|Distance)\s*[:：]?\s*[\d,，.]+\s*m?/i, ''),
    )
  }

  description =
    cjkLines.find(
      (l) =>
        (/。/.test(l) || /にある|参拝|訪れる/.test(l)) &&
        l !== title &&
        l !== address &&
        scoreTitle(l) >= -2,
    ) ?? null

  const placeLabels = cjkLines.filter((l) => {
    if (l === title || l === address || l === description) return false
    if (looksLikeAddress(l) || /。/.test(l)) return false
    if (l.length > 10 || scoreTitle(l) < 3) return false
    // Skip dash / katakana prolonged-sound garbage
    if (/^[ー\-〜~・：:\s]+$/.test(l)) return false
    if ((l.match(/[ー\-]/g) ?? []).length >= l.length / 2) return false
    return /[一-龯ぁ-んァ-ン]/.test(l)
  })

  const falls = extractFalls(normalized)
  const searchQueries: string[] = []
  const push = (q: string | null | undefined) => {
    if (!q) return
    const t = cleanLine(q)
    if (t.length < 2) return
    // Skip garbage queries
    if (/^[>\-ー0-9\s]+/.test(t) && !hasCjk(t.slice(0, 2))) return
    if ((t.match(/[\u3040-\u30ff\u3400-\u9fff]/g) ?? []).length < 2) return
    if (!searchQueries.includes(t)) searchQueries.push(t)
  }

  // Specific → general (order matters for geocoding)
  if (title && address) {
    push(`${title} ${address}`)
    push(`${title} ${address.replace(/\s+/g, '')}`)
  }
  if (title && /[滝瀧]神社/.test(title)) {
    push('瀧三柱神社 佐伯市')
    push('滝神社 佐伯市 上浦')
    push('瀧三柱神社')
  }
  for (const f of falls) {
    push(f)
    if (title) push(`${title} ${f}`)
  }
  if (address && /浅海井|上浦/.test(address)) {
    push('浅海井 佐伯市')
    push('上浦浅海井浦')
    if (title) push(`${title} 浅海井`)
  }
  push(address)
  if (address) push(`${address} 日本`)
  for (const label of placeLabels.slice(0, 3)) {
    push(`${label} 日本`)
    if (address) push(`${label} ${address}`)
    push(label)
  }
  if (title) {
    push(`${title} 大分`)
    push(`${title} 日本`)
    // bare title last — many homonyms
    push(title)
  }

  return {
    title,
    address,
    description,
    searchQueries,
    rawText: normalized,
  }
}

/** Keywords from address/title used to rank geocode hits. */
export function localityHints(parsed: ParsedLocation): string[] {
  const blob = [parsed.title, parsed.address, parsed.description]
    .filter(Boolean)
    .join(' ')
  const hints: string[] = []
  for (const h of [
    '佐伯',
    '浅海井',
    '上浦',
    '大分',
    '曉嵐',
    '暁嵐',
    '暁風',
    '日代',
    '津久見',
  ]) {
    if (blob.includes(h) || parsed.searchQueries.some((q) => q.includes(h))) {
      hints.push(h)
    }
  }
  return hints
}

/**
 * Merge postcard + map OCR parses: prefer postcard title/address,
 * keep union of search queries (specific first).
 */
export function mergeParsedLocations(
  parts: ParsedLocation[],
): ParsedLocation {
  if (parts.length === 0) {
    return {
      title: null,
      address: null,
      description: null,
      searchQueries: [],
      rawText: '',
    }
  }
  if (parts.length === 1) return parts[0]!

  const title =
    parts.find((p) => p.title && /神社|寺|駅|公園|滝|瀧/.test(p.title))
      ?.title ??
    parts.find((p) => p.title)?.title ??
    null

  const address =
    parts.find((p) => p.address && looksLikeAddress(p.address))?.address ??
    parts.find((p) => p.address)?.address ??
    null

  const description =
    parts.find((p) => p.description && /にある|参拝|訪れる|。/.test(p.description))
      ?.description ??
    parts.find((p) => p.description)?.description ??
    null

  const seen = new Set<string>()
  const searchQueries: string[] = []
  const push = (q: string) => {
    if (!q || seen.has(q)) return
    seen.add(q)
    searchQueries.push(q)
  }

  // Prefer queries that combine title+address from any part
  if (title && address) {
    push(`${title} ${address}`)
    push(`${title} ${address.replace(/\s+/g, '')}`)
  }
  for (const p of parts) {
    for (const q of p.searchQueries) push(q)
  }

  const rawText = parts
    .map((p, i) => `--- shot ${i + 1} ---\n${p.rawText}`)
    .join('\n\n')

  return { title, address, description, searchQueries, rawText }
}

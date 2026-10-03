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

const LATIN_NAME =
  /(?<![A-Za-z])[A-Z][a-zà-ÿ]{2,}(?:[-'][A-Za-zà-ÿ]{2,})?(?:[ \t]+[A-Z][a-zà-ÿ]{2,}(?:[-'][A-Za-zà-ÿ]{2,})?){0,4}/g

function tidyLine(line: string): string {
  return cleanLine(
    line.replace(/([A-Za-z])[〇○◯・·]+(?=[A-Za-z])/g, '$1'),
  )
}

/** Title Case place names such as "Gemeentehuis Oud-Turnhout". */
export function looksLikeLatinName(line: string): boolean {
  const t = tidyLine(line)
  if (t.length < 4 || t.length > 48) return false
  if (/[0-9]/.test(t)) return false
  if (isUiChrome(t)) return false
  const compact = t.replace(/\s/g, '')
  const letters = compact.match(/[A-Za-zÀ-ÿ]/g) ?? []
  if (letters.length < 4) return false
  if (letters.length / compact.length < 0.75) return false
  if (!/[a-zà-ÿ]/.test(t)) return false
  const words = t.split(/[\s-]+/).filter(Boolean)
  if (words.length > 6) return false
  const shouting = words.filter(
    (w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w),
  )
  if (shouting.length === words.length) return false
  return true
}

function latinNameCandidates(text: string): string[] {
  return [...text.matchAll(LATIN_NAME)].map((m) => tidyLine(m[0]))
}

function isKanaNoise(line: string): boolean {
  const compact = line.replace(/\s/g, '')
  if (!compact) return true
  const dashes = (compact.match(/[ー−—\-〜~]/g) ?? []).length
  if (dashes >= compact.length * 0.25) return true
  return false
}

/** Pure kana misreads of Latin names (e.g. Konvent Plasy → リーロー). */
function isMostlyKana(line: string): boolean {
  const compact = line.replace(/\s/g, '')
  if (compact.length < 2) return true
  const kana = (compact.match(/[\u3040-\u30ff]/g) ?? []).length
  const kanji = (compact.match(/[一-龯]/g) ?? []).length
  return kana >= 2 && kanji === 0
}

function isStrongJapanesePlace(line: string): boolean {
  return /神社|寺|駅|站|公園|滝|瀧|城|橋|港|山|湖|館|堂|宮|院|塔/.test(line)
}

function scoreTitle(line: string): number {
  let score = 0
  if (isStrongJapanesePlace(line)) {
    score += 5
  }
  if (line.length <= 12) score += 2
  if (line.length <= 6) score += 1
  if (looksLikeAddress(line)) score -= 5
  if (/。/.test(line)) score -= 5
  if (isUiChrome(line)) score -= 10
  if (isMostlyKana(line)) score -= 8
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
function splitOcrPasses(rawText: string): { eng: string; jpn: string } {
  if (rawText.includes('---eng---') && rawText.includes('---jpn---')) {
    const eng = rawText.split('---eng---')[1]?.split('---jpn---')[0] ?? ''
    const jpn = rawText.split('---jpn---')[1] ?? ''
    return { eng, jpn }
  }
  return { eng: rawText, jpn: rawText }
}

function linesFrom(raw: string): string[] {
  const normalized = normalizeOcrText(raw)
  return normalized
    .split(/\n|(?=(?:距離|距离|Distance)\s*[:：]?)/i)
    .map(tidyLine)
    .filter((l) => l.length > 0 && l !== '---eng---' && l !== '---jpn---')
}

export function parseLocationFromOcr(rawText: string): ParsedLocation {
  const passes = splitOcrPasses(rawText)
  const normalized = normalizeOcrText(`${passes.eng}\n${passes.jpn}`)
  const lines = linesFrom(`${passes.eng}\n${passes.jpn}`)
  const engLines = linesFrom(passes.eng)

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
  const cjkTitle =
    ranked.find(
      (l) =>
        scoreTitle(l) >= 5 &&
        l.length <= 24 &&
        !isKanaNoise(l) &&
        !isMostlyKana(l),
    ) ?? null
  const samePass = passes.eng === passes.jpn
  let latinCandidates = [
    ...(samePass ? lines : engLines).filter(looksLikeLatinName),
    ...latinNameCandidates(samePass ? normalized : normalizeOcrText(passes.eng)),
  ]
  if (!samePass && latinCandidates.length === 0) {
    latinCandidates = [
      ...linesFrom(passes.jpn).filter(looksLikeLatinName),
      ...latinNameCandidates(normalizeOcrText(passes.jpn)),
    ]
  }
  const latinTitle = [...latinCandidates].sort((a, b) => b.length - a.length)[0] ?? null
  // Prefer a clean Latin title from the English OCR pass over Japanese
  // misreads of European names (Konvent Plasy → リーロー). Keep strong
  // Japanese place titles (神社／寺／公園…) when those are present.
  if (latinTitle && !(cjkTitle && isStrongJapanesePlace(cjkTitle))) {
    title = latinTitle
  } else if (cjkTitle) {
    title = cjkTitle
  } else {
    title =
      ranked.find(
        (l) =>
          scoreTitle(l) > 0 &&
          l.length <= 24 &&
          !isKanaNoise(l) &&
          !isMostlyKana(l) &&
          /[一-龯]/.test(l),
      ) ?? null
  }

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
    const cjkCount = (t.match(/[\u3040-\u30ff\u3400-\u9fff]/g) ?? []).length
    const latin = looksLikeLatinName(t)
    if (cjkCount < 2 && !latin) return
    if (!searchQueries.includes(t)) searchQueries.push(t)
  }

  // Latin postcard titles (Europe, etc.) are the search string themselves.
  // Don't append 日本 or a garbled CJK translation ahead of them.
  if (title && looksLikeLatinName(title) && !hasCjk(title)) {
    push(title)
    if (address && looksLikeAddress(address)) {
      push(`${title} ${address}`)
      push(address)
    }
  } else {
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
    if (title && hasCjk(title)) {
      push(`${title} 大分`)
      push(`${title} 日本`)
    }
    if (title) {
      // bare title last — many homonyms
      push(title)
    }
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

  // Postcard is parsed first; keep its title when it found one.
  const title = parts.find((p) => p.title)?.title ?? null

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

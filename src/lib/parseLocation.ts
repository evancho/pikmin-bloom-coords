import type { ParsedLocation } from '../types'
import { expandPlaceQueries } from './geocode'

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
    /(?:距離|距离|Distance)\s*[:：]?\s*[\d,，.?]+\s*m?\s*(.+)$/i,
  )
  if (!m) {
    // English OCR often mangles 距離 into noise but keeps "123m Place".
    const eng = line.match(
      /(?:^|[^\d])(?:[\d?]{1,3}[,，]?){1,4}\d{2,}\s*m\s*([A-Za-zÀ-ÿ].+)$/i,
    )
    if (!eng) return null
    return tidyAddressFragment(eng[1])
  }
  return tidyAddressFragment(m[1])
}

function tidyAddressFragment(raw: string | undefined): string | null {
  if (!raw) return null
  let rest = cleanLine(
    raw
      .replace(/^[?\d,.\s]*m\s*/i, '')
      .replace(/^(?:距離|距离|Distance)\s*[:：]?\s*[\d,，.?]+\s*m?/i, ''),
  )
  // Drop pure OCR junk ("?.082,818m") with no real place tokens.
  if (!rest) return null
  if (/^[\d?,.\sm]+$/i.test(rest)) return null
  if (rest.length < 2) return null
  // Collapse duplicated locality tokens from OCR ("Plasy Plasy" → "Plasy").
  const parts = rest.split(/\s+/).filter(Boolean)
  const uniq: string[] = []
  for (const p of parts) {
    if (!uniq.some((u) => u.toLowerCase() === p.toLowerCase())) uniq.push(p)
  }
  rest = uniq.join(' ')
  return rest.length >= 2 ? rest : null
}

const LATIN_NAME =
  /(?<![A-Za-zÀ-ÿ])[A-ZÀ-Ý][a-zà-ÿā-ž]{2,}(?:[-'][A-Za-zà-ÿā-ž]{2,})?(?:[ \t]+[A-ZÀ-Ý][a-zà-ÿā-ž]{2,}(?:[-'][A-Za-zà-ÿā-ž]{2,})?){0,4}/g

function tidyLine(line: string): string {
  return cleanLine(
    line.replace(/([A-Za-z])[〇○◯・·]+(?=[A-Za-z])/g, '$1'),
  )
}

/** Title Case place names such as "Gemeentehuis Oud-Turnhout". */
export function looksLikeLatinName(line: string): boolean {
  const t = tidyLine(line).replace(/\.+$/, '')
  if (t.length < 4 || t.length > 48) return false
  if (/[0-9]/.test(t)) return false
  // Ampersand / symbols are almost always OCR noise (Klášter → Kl&ster).
  if (/[&@#%^*_+=<>{}[\]|\\]/.test(t)) return false
  if (isUiChrome(t)) return false
  const compact = t.replace(/\s/g, '')
  const letters = compact.match(/[A-Za-zÀ-ÿĀ-ž]/g) ?? []
  if (letters.length < 4) return false
  if (letters.length / compact.length < 0.75) return false
  if (!/[a-zà-ÿā-ž]/.test(t)) return false
  const words = t.split(/[\s-]+/).filter(Boolean)
  // Bloom postcard titles are almost always multi-word ("Konvent Plasy").
  // A lone leftover token after OCR noise ("Plasy" from "Kl&ster Plasy") is not enough.
  if (words.length < 2 || words.length > 6) return false
  const shouting = words.filter(
    (w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w),
  )
  if (shouting.length === words.length) return false
  return true
}

function latinNameCandidates(text: string): string[] {
  return [...text.matchAll(LATIN_NAME)]
    .map((m) => tidyLine(m[0]).replace(/\.+$/, ''))
    .filter(looksLikeLatinName)
}

/**
 * Postcard titles are the first large Latin line. Prefer that over a longer
 * subtitle like "Klášter Plasy." that English OCR often mangles.
 */
export function scoreLatinTitle(line: string, indexInEngLines: number): number {
  const t = tidyLine(line).replace(/\.+$/, '')
  let score = 0
  score += Math.max(0, 16 - indexInEngLines * 5)
  if (/[.。]$/.test(tidyLine(line))) score -= 5
  if (/[&@#%^*_+=]/.test(line)) score -= 12
  const words = t.split(/[\s-]+/).filter(Boolean)
  if (words.length >= 2 && words.length <= 4) score += 4
  if (
    words.every((w) => /^[A-ZÀ-Ý][a-zà-ÿā-ž'’-]+$/.test(w))
  ) {
    score += 3
  }
  // Mild length preference among clean early titles only.
  score += Math.min(t.length, 28) * 0.05
  return score
}

function pickBestLatinTitle(engLines: string[], extras: string[]): string | null {
  const scored: Array<{ line: string; score: number }> = []
  engLines.forEach((line, i) => {
    if (!looksLikeLatinName(line)) return
    scored.push({
      line: tidyLine(line).replace(/\.+$/, ''),
      score: scoreLatinTitle(line, i),
    })
  })
  for (const line of extras) {
    if (!looksLikeLatinName(line)) continue
    // Regex extras have no line index — treat as weaker than the first OCR line.
    scored.push({
      line: tidyLine(line).replace(/\.+$/, ''),
      score: scoreLatinTitle(line, 2),
    })
  }
  scored.sort((a, b) => b.score - a.score || b.line.length - a.line.length)
  return scored[0]?.line ?? null
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
  const latinSourceLines = samePass ? lines : engLines
  let latinTitle = pickBestLatinTitle(
    latinSourceLines,
    latinNameCandidates(samePass ? normalized : normalizeOcrText(passes.eng)),
  )
  if (!latinTitle && !samePass) {
    latinTitle = pickBestLatinTitle(
      linesFrom(passes.jpn),
      latinNameCandidates(normalizeOcrText(passes.jpn)),
    )
  }
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
    address = tidyAddressFragment(
      address.replace(/^(?:距離|距离|Distance)\s*[:：]?\s*[\d,，.?]+\s*m?/i, ''),
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
    // Allow synonym expansions like "monastery Plasy" / "Klášter Plasy".
    const landmarkQuery =
      /^(monastery|abbey|convent|castle|church|museum|klášter)\b/i.test(t) ||
      /\b(monastery|abbey|convent|castle|church)\s*$/i.test(t) ||
      /^Klášter\b/i.test(t)
    if (cjkCount < 2 && !latin && !landmarkQuery) return
    if (!searchQueries.includes(t)) searchQueries.push(t)
  }

  // Latin postcard titles (Europe, etc.) are the search string themselves.
  // Don't append 日本 or a garbled CJK translation ahead of them.
  if (title && looksLikeLatinName(title) && !hasCjk(title)) {
    for (const q of expandPlaceQueries(title, address)) push(q)
    // Recover OCR-mangled local names (Kl&ster Plasy → Klaster / Klášter Plasy)
    // as extra queries; they often match OSM landmarks better than "Konvent …".
    for (const line of engLines) {
      if (!/[&@]/.test(line)) continue
      const repairedA = tidyLine(line).replace(/&/g, 'a').replace(/\.+$/, '')
      const repairedAcute = tidyLine(line).replace(/&/g, 'á').replace(/\.+$/, '')
      if (looksLikeLatinName(repairedA)) push(repairedA)
      if (repairedAcute !== repairedA && /[A-Za-zÁá]/.test(repairedAcute)) {
        push(repairedAcute)
      }
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
  // Latin locality token from the title ("Plasy" in "Konvent Plasy").
  if (parsed.title && looksLikeLatinName(parsed.title)) {
    const parts = parsed.title.split(/\s+/).filter(Boolean)
    if (parts.length >= 2) {
      const last = parts[parts.length - 1]!
      if (last.length >= 3 && !hints.includes(last)) hints.push(last)
    }
  }
  if (parsed.address && /^[A-Za-zÀ-ÿ]/.test(parsed.address)) {
    const token = parsed.address.split(/\s+/)[0]!
    if (token.length >= 3 && !hints.includes(token)) hints.push(token)
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

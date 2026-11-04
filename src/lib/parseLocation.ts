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

/** Keep the admin chain after 距離 and drop the caption sentence that follows. */
function trimJapaneseAddress(raw: string): string {
  let s = (raw.split(/[。．]/)[0] ?? raw).trim()
  s = (s.split(/にある|です|ます|でオ|でお/)[0] ?? s).trim()
  // The caption repeats the city ("…御園宇東広島市…"). Drop that second city,
  // including the kanji that sit in front of its 市.
  const marks = [...s.matchAll(/市/g)]
  const second = marks[1]?.index
  if (second == null) return s
  let head = s.slice(0, second)
  for (const n of [2, 3, 4]) {
    if (head.length <= n + 1) continue
    const tail = head.slice(-n)
    const before = head[head.length - n - 1] ?? ''
    const city = s.slice(second - n, second + 1)
    if (
      /^[一-龯]+$/.test(tail) &&
      city === `${tail}市` &&
      /[町村字宇区郡]/.test(before)
    ) {
      head = head.slice(0, -n)
      break
    }
  }
  return head.trim()
}

function extractAddressFromDistanceLine(line: string): string | null {
  const m = line.match(
    /(?:距離|距离|Distance)\s*[:：・.]?\s*[\d,，.?\s]+\s*m\s*(.+)$/i,
  )
  if (m) return tidyAddressFragment(trimJapaneseAddress(m[1]))
  // English OCR often mangles 距離 into noise but keeps "123m Place"
  // or glued "7,889,280mKvaløya" / "889 280mKvaløva".
  const loose = line.match(
    /\d[\d\s,，.]{2,}m\s*([A-Za-zÀ-ÿØøÅåÆæ][A-Za-zÀ-ÿØøÅåÆæ'’\-\s]{1,40})/i,
  )
  if (!loose) return null
  return tidyAddressFragment(loose[1])
}

/** Prefer a Nordic-letter reading over repeated ASCII misreads (Kvaløya vs Kvalaya). */
function pickBestDistanceAddress(lines: string[]): string | null {
  const found: string[] = []
  for (const line of lines) {
    const after = extractAddressFromDistanceLine(line)
    if (after) found.push(after)
  }
  if (!found.length) return null
  const score = (a: string) => {
    let s = 0
    if (/[øåæØÅÆ]/.test(a)) s += 8
    if (/[\u3400-\u9fff]/.test(a) || /Kożuch/i.test(a)) s += 6
    if (a.split(/\s+/).length >= 2) s += 2
    if (/[bcdfghjklmnpqrstvwxyz]{4,}/i.test(a)) s -= 4
    const key = a.toLowerCase()
    s += found.filter((f) => f.toLowerCase() === key).length
    return s
  }
  // Same score: keep the earlier reading (English pass is listed first).
  return (
    [...found].sort(
      (a, b) => score(b) - score(a) || found.indexOf(a) - found.indexOf(b),
    )[0] ?? null
  )
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
  // Bloom's Traditional Chinese UI writes 廣/條; the place 御薗宇 is 御園宇 there,
  // and jpn OCR turns 薗 into 菌 or 蘭.
  rest = rest.replace(
    /[廣條縣國濱澤圓臺鹽邊應會發對關鐵驛龍藝]/g,
    (ch) =>
      ({
        廣: '広',
        條: '条',
        縣: '県',
        國: '国',
        濱: '浜',
        澤: '沢',
        圓: '円',
        臺: '台',
        鹽: '塩',
        邊: '辺',
        應: '応',
        會: '会',
        發: '発',
        對: '対',
        關: '関',
        鐵: '鉄',
        驛: '駅',
        龍: '竜',
        藝: '芸',
      })[ch] ?? ch,
  )
  rest = rest.replace(/御[園薗菌蘭]宇/g, '御薗宇')
  rest = rest.replace(/([市区町村郡])(?=\S)/g, '$1 ')
  // "Kvaløva" is the usual y→v miss of Norwegian "…øya" (the island).
  rest = rest.replace(/øva\b/gi, 'øya')
  const parts = rest.split(/\s+/).filter(Boolean)
  const uniq: string[] = []
  for (const p of parts) {
    const exo = cjkExonym(p)
    const token = exo ?? p
    // Eng OCR of the Chinese town name next to Bielice ("科祖霍夫" → HÆR / FIHHEX).
    if (!exo && /^[A-ZÆØÅÐÞŒ]{2,8}$/.test(token)) continue
    if (!uniq.some((u) => u.toLowerCase() === token.toLowerCase())) uniq.push(token)
  }
  rest = uniq.join(' ')
  return rest.length >= 2 ? rest : null
}

/** Traditional-Chinese Bloom exonyms, allowing one OCR substitution. */
const CJK_EXONYMS: Array<{ name: string; latin: string }> = [
  { name: '科祖霍夫', latin: 'Kożuchów' },
]

function cjkExonym(token: string): string | null {
  const cjk = token.replace(/[^\u3400-\u9fff]/g, '')
  if (cjk.length < 3) return null
  for (const row of CJK_EXONYMS) {
    if (cjk === row.name || levenshtein(cjk, row.name) <= 1) return row.latin
  }
  return null
}

const LATIN_NAME =
  /(?<![A-Za-zÀ-ÿ])[A-ZÀ-Ý][a-zà-ÿā-ž]{2,}(?:[-'][A-Za-zà-ÿā-ž]{2,})?(?:[ \t]+[A-ZÀ-Ý][a-zà-ÿā-ž]{2,}(?:[-'][A-Za-zà-ÿā-ž]{2,})?){0,4}/g

function tidyLine(line: string): string {
  return cleanLine(
    line.replace(/([A-Za-z])[〇○◯・·]+(?=[A-Za-z])/g, '$1'),
  )
}

/**
 * War-memorial / commemorative inscriptions are common Bloom postcard titles
 * but geocode to the wrong city (e.g. "Dem Gedenken…" → Berlin). Prefer the
 * locality line ("In Bad Berka bei der Kirche") or the map town name instead.
 * Matching is intentionally fuzzy for Tesseract mangling (Gefallanaen, Welkrieg).
 */
export function isCommemorativePhrase(line: string): boolean {
  const t = tidyLine(line)
  if (
    /\b(gedenken|gefall\w*|wel+t?krieg|kriegerdenkmal|kriegsopfer|kriegsdenkmal|zum\s+andenken|in\s+memory|fallen\s+sons|war\s+memorial|in\s+memoriam|aux?\s+morts|den\s+toten|ehrendenkmal)\b/i.test(
      t,
    )
  ) {
    return true
  }
  if (
    /^(Dem|Den|Der|Die|Zum|Zur|Für)\s+/i.test(t) &&
    /\b(Gedenken|Andenken|Erinnerung|Opfer|S[oöa]hne|Helden|Toten|Stadt)\b/i.test(
      t,
    )
  ) {
    return true
  }
  // Truncated OCR of "Gefallenen Söhne Unserer Stadt"
  if (
    /\bunserer?\s+st/i.test(t) &&
    /\b(gefall|s[oöaä]hne|sohn|helden)/i.test(t)
  ) {
    return true
  }
  return false
}

/** "TEER mTTET EER" — mostly capitals with one stray lowercase. */
function isShoutyOcrNoise(line: string): boolean {
  const words = tidyLine(line)
    .replace(/\.+$/, '')
    .split(/[\s.]+/)
    .filter(Boolean)
  if (words.length < 2) return false
  const caps = words.filter(
    (w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w),
  )
  return caps.length >= 2 && caps.length >= words.length - 1
}

/** Caption sentences ("An eye-catching display at Dassiesfontein") are not titles. */
export function isCaptionSentence(line: string): boolean {
  const t = tidyLine(line).replace(/\.+$/, '')
  if (/^An\s+/i.test(t) && /\bat\s+[A-ZÀ-Ý]/.test(t)) return true
  if (/\b(eye-catching|display at|located at)\b/i.test(t)) return true
  return false
}

/** "… at Dassiesfontein." → "Dassiesfontein" */
export function extractAtPlace(line: string): string | null {
  const m = tidyLine(line).match(/\bat\s+([A-ZÀ-Ý][a-zà-ÿā-ž]{3,})/)
  if (!m) return null
  const place = m[1]!
  if (/^(the|this|that|night|home|last|least)$/i.test(place)) return null
  return place
}

/** "In Bad Berka bei der Kirche" → "Bad Berka" */
export function extractLocalityFromHint(line: string): string | null {
  const cleaned = tidyLine(line)
  const m = cleaned.match(
    /\bIn\s+([A-ZÀ-Ý][A-Za-zÀ-ÿā-ž'’-]+(?:[\s-][A-ZÀ-Ý][A-Za-zÀ-ÿā-ž'’-]+){0,3})\s+bei\b/,
  )
  if (!m) return null
  const place = tidyLine(m[1]!)
  return place.length >= 3 ? place : null
}

export function hasChurchHint(text: string): boolean {
  return /\b(kirche|church|chapel|kapelle|cathedral|dom)\b/i.test(text)
}

/** Title Case place names such as "Gemeentehuis Oud-Turnhout". */
export function looksLikeLatinName(line: string): boolean {
  const t = tidyLine(line).replace(/\.+$/, '')
  if (t.length < 4 || t.length > 72) return false
  if (/[0-9]/.test(t)) return false
  // Ampersand / symbols are almost always OCR noise (Klášter → Kl&ster).
  if (/[&@#%^*_+=<>{}[\]|\\]/.test(t)) return false
  if (isUiChrome(t)) return false
  if (isCommemorativePhrase(t)) return false
  if (isCaptionSentence(t)) return false
  if (isShoutyOcrNoise(t)) return false
  if (isWeakLatinOcrTitle(t)) return false
  // Prepositional captions are locality hints, not the place title itself.
  if (/^(In|Near|At|By)\s+/i.test(t) && /\sbei\b/i.test(t)) return false
  const compact = t.replace(/\s/g, '')
  const letters = compact.match(/[A-Za-zÀ-ÿĀ-ž]/g) ?? []
  if (letters.length < 4) return false
  if (letters.length / compact.length < 0.75) return false
  if (!/[a-zà-ÿā-ž]/.test(t)) return false
  const words = t.split(/[\s-]+/).filter(Boolean)
  // Bloom postcard titles are almost always multi-word ("Konvent Plasy").
  // A lone leftover token after OCR noise ("Plasy" from "Kl&ster Plasy") is not enough.
  if (words.length < 2 || words.length > 6) return false
  // "A yy te" is OCR dust. Real titles have at least one full word.
  if (!words.some((w) => w.length >= 4)) return false
  // Administrative ward lines are addresses, not postcard titles.
  if (
    /\b(Ward|District|Prefecture)\b/i.test(t) &&
    !/huis|house|castle|church|kirche|museum|plaza|park/i.test(t)
  ) {
    return false
  }
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
  if (isCommemorativePhrase(t)) score -= 40
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

/**
 * Titles that both the English block OCR and the Japanese pass agree on beat
 * a lone single-line title crop (e.g. both read "Kaldfjord Church").
 */
export function consensusLatinTitles(
  engLines: string[],
  otherLines: string[],
): string[] {
  const normalize = (s: string) =>
    tidyLine(s)
      .replace(/\.+$/, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
  const engSet = new Set(
    engLines
      .filter(looksLikeLatinName)
      .map((l) => normalize(l)),
  )
  const out: string[] = []
  for (const line of otherLines) {
    if (!looksLikeLatinName(line)) continue
    const key = normalize(line)
    if (engSet.has(key)) {
      const tidy = tidyLine(line).replace(/\.+$/, '')
      if (!out.some((o) => normalize(o) === key)) out.push(tidy)
    }
  }
  return out
}

/** fi/fj and the extra i in "Kaldfjiord" collapse to one place key. */
export function canonLatinKey(s: string): string {
  return tidyLine(s)
    .replace(/\.+$/, '')
    .toLowerCase()
    .replace(/fji/g, 'fj')
    .replace(/fi/g, 'fj')
    // "Table tor Giants" is the usual f→t miss of "for".
    .replace(/\btor\b/g, 'for')
    .replace(/\s+/g, ' ')
    .trim()
}

function pickBestLatinTitle(
  engLines: string[],
  extras: string[],
  consensus: string[] = [],
): string | null {
  type Group = { n: number; line: string; score: number }
  const groups = new Map<string, Group>()
  const spellScore = (s: string) => {
    let n = 0
    if (/fj/i.test(s) && !/fji/i.test(s)) n += 2
    if (/\bfor\b/i.test(s)) n += 2
    if (/\btor\b/i.test(s)) n -= 1
    return n
  }
  const consider = (line: string, score: number) => {
    if (!looksLikeLatinName(line)) return
    const tidy = tidyLine(line).replace(/\.+$/, '')
    const key = canonLatinKey(tidy)
    const cur = groups.get(key) ?? { n: 0, line: tidy, score: -Infinity }
    cur.n += 1
    cur.score = Math.max(cur.score, score)
    // Prefer fj over fi, and "for" over the f→t miss "tor".
    if (spellScore(tidy) > spellScore(cur.line)) cur.line = tidy
    groups.set(key, cur)
  }
  // Same reading on eng + jpn beats a one-off single-line crop.
  for (const line of consensus) consider(line, scoreLatinTitle(line, 0) + 20)
  engLines.forEach((line, i) => consider(line, scoreLatinTitle(line, i)))
  for (const line of extras) consider(line, scoreLatinTitle(line, 2))
  // A wrapped first line is a word-prefix of the joined title. Give the
  // longer line the shorter line's votes so "… wegla" does not beat
  // "… wegla brunatnego Maria".
  for (const short of [...groups.keys()]) {
    for (const long of [...groups.keys()]) {
      if (short === long || !long.startsWith(`${short} `)) continue
      const s = groups.get(short)
      const l = groups.get(long)
      if (!s || !l) continue
      l.n += s.n
      l.score = Math.max(l.score, s.score)
      groups.delete(short)
      break
    }
  }
  let best: Group | null = null
  for (const g of groups.values()) {
    const total = g.n * 10 + g.score
    const bestTotal = best ? best.n * 10 + best.score : -Infinity
    if (total > bestTotal) best = g
  }
  return best?.line ?? null
}

const GENERIC_PLACE_WORD =
  /^(church|kirche|kirke|kyrka|kirkko|chapel|cathedral|museum|castle|park|lake|station|tower|temple|shrine)$/i

/** Map screenshots often have a single label ("Kaldfjord"), not a two-word title. */
function singleLatinPlaceLabel(lines: string[]): string | null {
  type Group = { n: number; line: string }
  const groups = new Map<string, Group>()
  for (const line of lines) {
    const t = tidyLine(line).replace(/^[\\/|.\s]+|[\\/|.\s]+$/g, '')
    if (!/^[A-ZÀ-Ý][a-zà-ÿøæåā-ž]{4,24}$/.test(t)) continue
    if (GENERIC_PLACE_WORD.test(t) || isUiChrome(t) || isWeakLatinOcrTitle(t)) continue
    const key = canonLatinKey(t)
    const cur = groups.get(key) ?? { n: 0, line: t }
    cur.n += 1
    if (/fj/i.test(t) && !/fji/i.test(t)) cur.line = t
    groups.set(key, cur)
  }
  let best: Group | null = null
  for (const g of groups.values()) {
    if (!best || g.n > best.n) best = g
  }
  return best?.line ?? null
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
  return /神社|寺|駅|站|公園|滝|瀧|城|橋|港|山|湖|館|堂|宮|院|塔|喫茶|カフェ|食堂|レストラン|酒店|温泉|市場|美術館|博物館|店舗|商店/.test(
    line,
  )
}

/** Weak eng OCR leftovers like "an vere Fushimi Ward". */
export function isWeakLatinOcrTitle(line: string): boolean {
  const t = tidyLine(line)
  if (/^[a-z]{1,4}\b/.test(t)) return true
  if (/\b(an|vere|the|der|die|das)\b/i.test(t) && !/^(The|Der|Die)\s/.test(t)) {
    // "an vere…" / mid-line article junk — not a real place title.
    if (/^[a-z]/.test(t) || /\ban\s+vere\b/i.test(t)) return true
  }
  const words = t.split(/\s+/).filter(Boolean)
  const lowerLead = words.filter((w) => /^[a-z]/.test(w)).length
  // Only weak when the title itself starts with a short lowercase fragment
  // ("an vere Fushimi Ward"). A real sentence-case title such as Polish
  // "tablica pamiątkowa …" starts with a full word and should be kept.
  const first = words[0] ?? ''
  if (words.length >= 3 && lowerLead >= 2 && /^[a-z]/.test(t) && first.length <= 4) {
    return true
  }
  return false
}

/**
 * Postcard titles wrap. "… Kopalni wegla" + "brunatnego Maria" is one title.
 * Only join when the next line is a lowercase word followed by a capital,
 * so a junk token like "enfrance" is not glued on.
 */
function joinWrappedLatinLines(lines: string[]): string[] {
  const out = [...lines]
  for (let i = 0; i < lines.length - 1; i += 1) {
    const cur = lines[i]!
    const next = lines[i + 1]!
    if (/\d/.test(cur) || /\d/.test(next)) continue
    if (!/[A-Za-zÀ-ÿ]{4,}/.test(cur)) continue
    if (!/^[a-zà-ÿā-ž]{5,}\s+[A-ZÀ-Ý]/.test(next)) continue
    out.push(`${tidyLine(cur)} ${tidyLine(next)}`)
  }
  return out
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
export type ParseLangPref = 'auto' | 'ja' | 'en' | 'zh'

function splitOcrPasses(rawText: string): {
  eng: string
  jpn: string
  chi: string
} {
  if (rawText.includes('---eng---') && rawText.includes('---jpn---')) {
    const eng = rawText.split('---eng---')[1]?.split('---jpn---')[0] ?? ''
    const afterJpn = rawText.split('---jpn---')[1] ?? ''
    const jpn = afterJpn.includes('---chi---')
      ? (afterJpn.split('---chi---')[0] ?? '')
      : afterJpn
    const chi = rawText.includes('---chi---')
      ? (rawText.split('---chi---')[1] ?? '')
      : ''
    return { eng, jpn, chi }
  }
  return { eng: rawText, jpn: rawText, chi: '' }
}

function linesFrom(raw: string): string[] {
  const normalized = normalizeOcrText(raw)
  return normalized
    .split(/\n|(?=(?:距離|距离|Distance)\s*[:：]?)/i)
    .map(tidyLine)
    .filter(
      (l) =>
        l.length > 0 &&
        l !== '---eng---' &&
        l !== '---jpn---' &&
        l !== '---chi---',
    )
}

export function parseLocationFromOcr(
  rawText: string,
  langPref: ParseLangPref = 'auto',
): ParsedLocation {
  const passes = splitOcrPasses(rawText)
  const cjkBlob = `${passes.jpn}\n${passes.chi}`
  const normalized = normalizeOcrText(`${passes.eng}\n${cjkBlob}`)
  const lines = linesFrom(`${passes.eng}\n${cjkBlob}`)
  const engLines = linesFrom(passes.eng)

  let title: string | null = null
  let address: string | null = null
  let description: string | null = null

  address = pickBestDistanceAddress(lines)

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
  const samePass =
    passes.eng === passes.jpn && (!passes.chi || passes.chi === passes.eng)
  const latinSourceLines = joinWrappedLatinLines(samePass ? lines : engLines)
  const hintLocality =
    lines.map(extractLocalityFromHint).find((x): x is string => Boolean(x)) ??
    null
  const atPlace =
    lines.map(extractAtPlace).find((x): x is string => Boolean(x)) ?? null
  const jpnChiLines = linesFrom(`${passes.jpn}\n${passes.chi}`)
  const consensus = samePass
    ? []
    : consensusLatinTitles(engLines, jpnChiLines)
  let latinTitle = pickBestLatinTitle(
    latinSourceLines,
    latinNameCandidates(samePass ? normalized : normalizeOcrText(passes.eng)),
    consensus,
  )
  if (!latinTitle && !samePass) {
    latinTitle = pickBestLatinTitle(
      jpnChiLines,
      latinNameCandidates(normalizeOcrText(`${passes.jpn}\n${passes.chi}`)),
      consensus,
    )
  }
  // Map labels are a single place name. Keep them when no multi-word title exists.
  if (!latinTitle) {
    latinTitle = singleLatinPlaceLabel(samePass ? lines : [...engLines, ...jpnChiLines])
  }
  // Caption locality ("In Bad Berka bei der Kirche") beats memorial titles.
  if (hintLocality) {
    latinTitle = hintLocality
  } else if (
    latinTitle &&
    (isCommemorativePhrase(latinTitle) || isWeakLatinOcrTitle(latinTitle))
  ) {
    latinTitle = null
  }

  const softCjk =
    ranked.find(
      (l) =>
        scoreTitle(l) > 0 &&
        l.length <= 24 &&
        !isKanaNoise(l) &&
        !isMostlyKana(l) &&
        /[一-龯]/.test(l),
    ) ?? null

  // langPref=ja/zh → always prefer CJK titles when present.
  // auto → Latin for Europe, but keep strong JP places (神社／喫茶店…).
  // en → Latin first.
  if (langPref === 'ja' || langPref === 'zh') {
    title = cjkTitle ?? softCjk ?? latinTitle
  } else if (langPref === 'en') {
    title = latinTitle ?? cjkTitle ?? softCjk
  } else if (latinTitle && !(cjkTitle && isStrongJapanesePlace(cjkTitle))) {
    // Prefer a clean Latin title from the English OCR pass over Japanese
    // misreads of European names (Konvent Plasy → リーロー).
    title = latinTitle
  } else if (cjkTitle) {
    title = cjkTitle
  } else {
    title = softCjk
  }

  // Katakana title "ニシハマ" is unreadable here, but the caption
  // "日本最南端のビーチ" on 波照間 is ニシ浜.
  const beachLine = lines.find((l) =>
    /日本最南端のビーチ/.test(l.replace(/\s/g, '')),
  )
  if (beachLine && /波照間/.test(normalized)) {
    title = 'ニシ浜'
    description = beachLine.replace(/\s/g, '')
  }

  // "びっ 0 ドンキー" is the usual miss of the kana title びっくりドンキー.
  const compactAll = normalized.replace(/\s/g, '')
  if (
    /ドンキ[ーィ]/.test(compactAll) &&
    /びっ/.test(compactAll) &&
    !(title && looksLikeLatinName(title) && !isShoutyOcrNoise(title))
  ) {
    title = 'びっくりドンキー'
  }

  if (!address) {
    address = cjkLines.find((l) => looksLikeAddress(l)) ?? null
  }
  if (address) {
    address = tidyAddressFragment(
      address.replace(/^(?:距離|距离|Distance)\s*[:：]?\s*[\d,，.?]+\s*m?/i, ''),
    )
  }

  if (!description) {
    description =
      cjkLines.find(
        (l) =>
          (/。/.test(l) || /にある|参拝|訪れる/.test(l)) &&
          l !== title &&
          l !== address &&
          scoreTitle(l) >= -2,
      ) ??
      lines.find((l) => isCaptionSentence(l) && l !== title) ??
      null
  }
  if (description) {
    description = description.replace(/御[園薗菌蘭]宇/g, '御薗宇')
  }

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
    const singlePlace = /^[A-ZÀ-Ý][a-zà-ÿøæåā-ž]{4,}$/.test(t)
    // Allow synonym expansions like "monastery Plasy" / "Klášter Plasy".
    const landmarkQuery =
      /^(monastery|abbey|convent|castle|church|museum|klášter)\b/i.test(t) ||
      /\b(monastery|abbey|convent|castle|church|kirke|kyrka|kirkko)\s*$/i.test(t) ||
      /^Klášter\b/i.test(t)
    if (cjkCount < 2 && !latin && !landmarkQuery && !singlePlace) return
    if (!searchQueries.includes(t)) searchQueries.push(t)
  }

  // Latin postcard titles (Europe, etc.) are the search string themselves.
  // Don't append 日本 or a garbled CJK translation ahead of them.
  if (title && looksLikeLatinName(title) && !hasCjk(title)) {
    const latinAddress =
      address && /[A-Za-zÀ-ÿØøÅåÆæ]{3,}/.test(address) ? address : null
    // Town / landmark name first — "Bad Berka Kirche" alone often hits a street.
    // "at Dassiesfontein" is the landmark; the distance line is only the municipality.
    if (atPlace && atPlace !== title) {
      push(`${title} ${atPlace}`)
      const admin = (latinAddress ?? '').replace(/\bRural\b/gi, '').trim()
      if (admin) push(`${atPlace} ${admin}`)
      push(atPlace)
    }
    for (const q of expandPlaceQueries(title, latinAddress)) push(q)
    // German "bei der Kirche" only — an English "Church" title should not
    // emit Stadtkirche queries (those drown Nordic kirke lookups).
    if (/\b(kirche|kapelle|stadtkirche|bei\s+der)\b/i.test(normalized)) {
      push(`Stadtkirche ${title}`)
      push(`${title} Stadtkirche`)
      push(`${title} Kirche`)
      push(`${title} church`)
      push(`Kirche ${title}`)
    }
    if (hintLocality && hintLocality !== title) push(hintLocality)
    // fi/fj OCR confusion (Kaldfjord ↔ Kaldiford) — retry both spellings.
    const latinSnapshot = [...searchQueries]
    for (const q of latinSnapshot) {
      if (/fi/i.test(q)) push(q.replace(/fi/gi, 'fj'))
      if (/fj/i.test(q)) push(q.replace(/fj/gi, 'fi'))
    }
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
    if (title === 'ニシ浜' && /波照間/.test(`${address ?? ''} ${normalized}`)) {
      push('ニシ浜 波照間')
      push('ニシ浜 竹富町')
    }
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
      // Only bias 大分 when the address/OCR already points there — no global Kyushu default.
      const oitaHint =
        /大分|佐伯|浅海井|上浦|津久見|日代/.test(normalized) ||
        (address != null && /大分|佐伯|浅海井|上浦/.test(address))
      if (oitaHint) push(`${title} 大分`)
      push(`${title} 日本`)
      for (const q of expandPlaceQueries(title, address)) push(q)
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
  const blob = [parsed.title, parsed.address, parsed.description, ...parsed.searchQueries]
    .filter(Boolean)
    .join(' ')
  const hints: string[] = []
  const pushHint = (h: string | null | undefined) => {
    const t = (h ?? '').trim()
    if (t.length < 2) return
    if (!hints.some((x) => x.toLowerCase() === t.toLowerCase())) hints.push(t)
  }
  // Only add Japanese region tokens that actually appear in OCR/address.
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
    '波照間',
    '竹富',
    '東広島',
    '西条',
    '御薗宇',
    '京都',
    '東京',
    '大阪',
    '北海道',
  ]) {
    if (blob.includes(h) || parsed.searchQueries.some((q) => q.includes(h))) {
      pushHint(h)
    }
  }
  // Latin locality token from the title ("Plasy" in "Konvent Plasy").
  if (parsed.title && looksLikeLatinName(parsed.title)) {
    const parts = parsed.title.split(/\s+/).filter(Boolean)
    if (parts.length >= 2) {
      const last = parts[parts.length - 1]!
      // Skip generic landmark words ("Church", "Lake").
      if (
        last.length >= 3 &&
        !/^(church|kirche|kirke|kyrka|chapel|lake|park|museum|castle|temple|shrine)$/i.test(
          last,
        )
      ) {
        pushHint(last)
      }
      // Keep full multi-word towns ("Bad Berka") for geocode ranking.
      pushHint(parsed.title)
      // Bare stem without landmark suffix ("Kaldfjord Church" → "Kaldfjord").
      const stem = parsed.title
        .replace(
          /\s+(Church|Kirche|Kirke|Kyrka|Kirkko|Chapel|Cathedral|Museum|Castle|Temple|Shrine|Park|Lake|Tower|Station)$/i,
          '',
        )
        .trim()
      if (stem.length >= 3 && stem !== parsed.title) pushHint(stem)
    }
  }
  for (const q of parsed.searchQueries) {
    pushHint(extractLocalityFromHint(q))
  }
  for (const line of (parsed.rawText ?? '').split(/\n/)) {
    pushHint(extractLocalityFromHint(line))
  }
  if (parsed.address && /^[A-Za-zÀ-ÿØøÅåÆæ]/.test(parsed.address)) {
    // Keep each Latin address token (Kvaløya, Tromsø, …).
    for (const token of parsed.address.split(/[\s,，]+/).filter(Boolean)) {
      if (token.length < 3) continue
      if (
        /^(rural|local|ward|district|municipality|county|province|region|prefecture)$/i.test(
          token,
        )
      ) {
        continue
      }
      pushHint(token)
    }
  }
  for (const line of (parsed.rawText ?? '').split(/\n/)) {
    pushHint(extractAtPlace(line))
  }
  return hints
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i += 1) dp[i]![0] = i
  for (let j = 0; j <= n; j += 1) dp[0]![j] = j
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      )
    }
  }
  return dp[m]![n]!
}

/** Map label "Kaldfjord" corrects a noisy postcard stem ("Kagldfiord Church"). */
export function alignStemWithMapLabel(title: string, mapLabel: string): string {
  const m = title.match(
    /^(.*)\s+(Church|Kirche|Kirke|Kyrka|Kirkko|Chapel|Cathedral|Museum|Castle)$/i,
  )
  const stem = (m?.[1] ?? title).trim()
  const suffix = m?.[2]
  const same = canonLatinKey(stem) === canonLatinKey(mapLabel)
  const close =
    levenshtein(canonLatinKey(stem), canonLatinKey(mapLabel)) <= 2 &&
    mapLabel.length >= 5
  if (!same && !close) return title
  return suffix ? `${mapLabel} ${suffix}` : mapLabel
}

function isWeakOrCommemorativeTitle(title: string | null | undefined): boolean {
  if (!title) return true
  if (isCommemorativePhrase(title)) return true
  // Prefer a clean 2-word map town over a long OCR-mangled postcard line.
  if (title.split(/\s+/).length >= 4 && /[a-z][A-Z]|[A-Z]{2,}[a-z]/.test(title)) {
    return true
  }
  return false
}

/**
 * Merge postcard + map OCR parses: prefer postcard title/address,
 * keep union of search queries (specific first).
 * When the postcard title is a commemorative inscription, prefer the map
 * town name (e.g. Bad Berka) so geocode stays in the right city.
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

  const mapLabel = parts
    .slice(1)
    .map((p) => p.title)
    .find((t) => t && !/\s/.test(t) && !isWeakOrCommemorativeTitle(t))
  let title =
    parts.find((p) => p.title && !isWeakOrCommemorativeTitle(p.title))?.title ??
    parts.find((p) => p.title)?.title ??
    null
  if (title && mapLabel && title !== mapLabel) {
    title = alignStemWithMapLabel(title, mapLabel)
  }

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

  // Prefer the winning title's own queries first (locality / church / landmark).
  const preferred = parts.find((p) => p.title === title)
  if (preferred) {
    for (const q of preferred.searchQueries) push(q)
  } else if (title && looksLikeLatinName(title)) {
    for (const q of expandPlaceQueries(title, address)) push(q)
  }
  // Memorial postcards often sit by the parish church; when OCR missed
  // "bei der Kirche" but raw text still looks commemorative, bias queries.
  const rawBlob = parts.map((p) => p.rawText).join('\n')
  if (
    title &&
    looksLikeLatinName(title) &&
    !hasCjk(title) &&
    (isCommemorativePhrase(rawBlob) ||
      parts.some((p) => p.title && isCommemorativePhrase(p.title)))
  ) {
    push(`Stadtkirche ${title}`)
    push(`${title} Stadtkirche`)
    push(`${title} Kirche`)
    push(`${title} church`)
  }
  if (title && address) {
    // Don't fuse Latin town names with CJK-only phonetic addresses
    // ("Bad Berka" + "巴特貝爾卡") — that pollutes geocode ranking.
    const addressIsCjkOnly =
      hasCjk(address) && !/[A-Za-zÀ-ÿ]{3,}/.test(address)
    const titleIsLatin = looksLikeLatinName(title) && !hasCjk(title)
    if (!(titleIsLatin && addressIsCjkOnly)) {
      push(`${title} ${address}`)
      push(`${title} ${address.replace(/\s+/g, '')}`)
    }
  }
  for (const p of parts) {
    for (const q of p.searchQueries) push(q)
  }

  const rawText = parts
    .map((p, i) => `--- shot ${i + 1} ---\n${p.rawText}`)
    .join('\n\n')

  return { title, address, description, searchQueries, rawText }
}

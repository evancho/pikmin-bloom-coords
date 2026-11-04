import type { GeocodeCandidate, GeocodePrecision } from '../types'
import { formatCoords, normalizeJapanish } from './coords'

type OpenMeteoResult = {
  results?: Array<{
    name: string
    latitude: number
    longitude: number
    country?: string
    admin1?: string
    admin2?: string
    rank?: number
  }>
}

type PhotonFeature = {
  geometry: { coordinates: [number, number] }
  properties: {
    name?: string
    street?: string
    city?: string
    state?: string
    country?: string
    osm_key?: string
    osm_value?: string
    type?: string
  }
}

type NominatimResult = {
  display_name: string
  lat: string
  lon: string
  importance?: number
  class?: string
  type?: string
}

export type RankedGeocodeCandidate = GeocodeCandidate & {
  className?: string
  typeName?: string
}

/** Rough admin-region ballpark derived from OCR locality hints (not hard-coded to one prefecture). */
export type RegionBias = {
  /** Prefer results inside this box (south, north, west, east). */
  viewbox?: { south: number; north: number; west: number; east: number }
  /** ISO country codes for Nominatim (comma-separated). */
  countrycodes?: string
  label: string
}

const JP_LANDMARK_SUFFIX =
  /(神社|寺|城|公園|駅|站|橋|塔|温泉|溫泉|島|山|湖|滝|瀧|港|美術館|博物館|市場)$/

/** Known admin regions → soft viewbox (only applied when the hint appears in OCR). */
const REGION_BOXES: Array<{
  match: RegExp
  label: string
  viewbox: { south: number; north: number; west: number; east: number }
  countrycodes?: string
}> = [
  {
    match: /大分|佐伯|浅海井|上浦|津久見/,
    label: 'oita',
    viewbox: { south: 32.5, north: 34.0, west: 131.0, east: 132.5 },
    countrycodes: 'jp',
  },
  {
    match: /京都|Kyoto/i,
    label: 'kyoto',
    viewbox: { south: 34.7, north: 35.4, west: 135.5, east: 136.1 },
    countrycodes: 'jp',
  },
  {
    match: /Kożuch|Kozuchow|科祖/,
    label: 'kozuchow',
    viewbox: { south: 51.55, north: 51.9, west: 15.4, east: 15.9 },
    countrycodes: 'pl',
  },
  {
    match: /Troms[øo]|Kval[øo]ya|Kald(?:fj|fi)ord/i,
    label: 'tromso',
    viewbox: { south: 69.0, north: 70.2, west: 17.5, east: 20.5 },
    countrycodes: 'no',
  },
  {
    match: /Bad\s*Berka|Thüringen|Thuringia/i,
    label: 'thuringia',
    viewbox: { south: 50.5, north: 51.3, west: 10.5, east: 12.0 },
    countrycodes: 'de',
  },
  {
    match: /Plasy|Plze[nň]/i,
    label: 'plzen',
    viewbox: { south: 49.5, north: 50.2, west: 12.8, east: 13.8 },
    countrycodes: 'cz',
  },
]

export function regionBiasFromHints(hints: string[]): RegionBias | null {
  const blob = hints.join(' ')
  for (const r of REGION_BOXES) {
    if (r.match.test(blob)) {
      return {
        viewbox: r.viewbox,
        countrycodes: r.countrycodes,
        label: r.label,
      }
    }
  }
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(blob)) {
    return {
      viewbox: { south: 24, north: 46, west: 122, east: 154 },
      countrycodes: 'jp',
      label: 'japan',
    }
  }
  return null
}

function displayFromMeteo(
  r: NonNullable<OpenMeteoResult['results']>[number],
): string {
  return [r.name, r.admin2, r.admin1, r.country].filter(Boolean).join(', ')
}

function displayFromPhoton(f: PhotonFeature): string {
  const p = f.properties
  return [p.name, p.street, p.city, p.state, p.country].filter(Boolean).join(', ')
}

/** Japanese place names stay biased to Japan; Latin names search worldwide. */
export function queryPrefersJapan(query: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(query)
}

export function inferPrecision(
  className?: string,
  typeName?: string,
): GeocodePrecision {
  const c = (className ?? '').toLowerCase()
  const t = (typeName ?? '').toLowerCase()
  const key = `${c}/${t}`
  if (
    /place_of_worship|cathedral|chapel|church|temple|shrine|monastery|castle|palace|museum|attraction|ruins|memorial|monument|tower|bridge|artwork|viewpoint|zoo|theme_park/.test(
      key,
    )
  ) {
    return 'landmark'
  }
  if (t === 'house' || t === 'housenumber' || c === 'building') return 'housenumber'
  if (c === 'highway' || t === 'street' || t === 'residential') return 'street'
  if (
    c === 'place' ||
    /city|town|village|hamlet|municipality|suburb|neighbourhood|locality|county|state/.test(
      t,
    )
  ) {
    return 'locality'
  }
  // Open-Meteo and similar town-center hits.
  if (c === 'place' && t === 'locality') return 'locality'
  return 'unknown'
}

/**
 * Expand a Latin / Japanese postcard title into geocoder-friendly queries.
 * "Kaldfjord Church" alone often hits Church Lane (Guernsey); Nordic kirke +
 * locality combos recover the real parish church.
 */
export function expandPlaceQueries(
  title: string,
  address?: string | null,
): string[] {
  const out: string[] = []
  const push = (q: string | null | undefined) => {
    const t = (q ?? '').replace(/\s+/g, ' ').trim()
    if (t.length < 2) return
    if (!out.includes(t)) out.push(t)
  }

  const locality = (address ?? '').trim()
  push(title)

  // Japanese landmark stem + locality (神社／寺／城…).
  if (JP_LANDMARK_SUFFIX.test(title)) {
    const stem = title.replace(JP_LANDMARK_SUFFIX, '').trim()
    if (stem.length >= 1) {
      push(stem)
      if (locality) {
        push(`${title} ${locality}`)
        push(`${stem} ${locality}`)
      }
    }
  }

  const m = title.match(
    /^(Konvent|Convent|Kloster|Klášter|Abbey|Monastery|Castle|Schloss|Palais|Palace|Church|Chapel|Cathedral|Museum|Basilica|Temple|Shrine|Tower|Station|Airport|Kirche|Kirke|Kyrka|Kirkko)\s+(.+)$/i,
  )
  const trailing = title.match(
    /^(.+?)\s+(Church|Chapel|Cathedral|Kirche|Kirke|Kyrka|Kirkko|Museum|Castle|Temple|Shrine|Tower|Station)$/i,
  )

  if (m) {
    const kind = m[1]!.toLowerCase()
    const rest = m[2]!.trim()
    if (/konvent|convent|kloster|klášter|monastery|abbey|basilica/.test(kind)) {
      push(`Klášter ${rest}`)
      push(`monastery ${rest}`)
      push(`abbey ${rest}`)
      push(`convent ${rest}`)
      push(`${rest} monastery`)
      push(`${rest} abbey`)
      if (locality) {
        push(`Klášter ${rest} ${locality}`)
        push(`monastery ${rest} ${locality}`)
      }
    } else if (/castle|schloss|palais|palace/.test(kind)) {
      push(`castle ${rest}`)
      push(`${rest} castle`)
      push(`Schloss ${rest}`)
    } else if (/church|chapel|cathedral|kirche|kirke|kyrka|kirkko|temple|shrine/.test(kind)) {
      push(`church ${rest}`)
      push(`${rest} church`)
      push(`${rest} kirke`)
      push(`${rest} kyrka`)
      push(`${rest} kirkko`)
      push(`${rest} Kirche`)
      if (locality) {
        push(`${rest} kirke ${locality}`)
        push(`${rest} church ${locality}`)
        push(`${title} ${locality}`)
      }
    } else if (/museum/.test(kind)) {
      push(`museum ${rest}`)
    } else {
      push(`${kind} ${rest}`)
      push(`${rest} ${kind}`)
    }
  } else if (trailing) {
    const rest = trailing[1]!.trim()
    const kind = trailing[2]!.toLowerCase()
    push(rest)
    if (/church|chapel|cathedral|kirche|kirke|kyrka|kirkko/.test(kind)) {
      // Nordic parish churches are often tagged "… kirke" in OSM.
      push(`${rest} kirke`)
      push(`${rest} kyrka`)
      push(`${rest} kirkko`)
      push(`${rest} Kirche`)
      push(`${rest} church`)
      if (locality) {
        push(`${rest} kirke ${locality}`)
        push(`${title} ${locality}`)
        push(`${rest} ${locality}`)
      }
    } else {
      push(`${rest} ${kind}`)
      if (locality) push(`${rest} ${locality}`)
    }
  }

  if (locality) {
    push(`${title} ${locality}`)
    if (locality.toLowerCase() !== title.toLowerCase()) push(locality)
  }

  return out
}

/** Prefer real landmarks over incidental OSM nodes (info boards, etc.). */
export function poiTypeScore(className?: string, typeName?: string): number {
  const c = (className ?? '').toLowerCase()
  const t = (typeName ?? '').toLowerCase()
  const key = `${c}/${t}`
  if (
    /monastery|place_of_worship|cathedral|chapel|church|temple|shrine|castle|palace|museum|attraction|ruins|memorial|monument|tower|bridge|airport|university|zoo|theme_park|artwork|viewpoint/.test(
      key,
    )
  ) {
    return 10
  }
  if (c === 'tourism' || c === 'historic') return 7
  if (c === 'place' && /city|town|village|hamlet|municipality|suburb|neighbourhood/.test(t))
    return 6
  // Train stations named after the town often outrank the town center; keep mild.
  if ((c === 'railway' || c === 'public_transport') && /station|halt|stop/.test(t))
    return 2
  if (c === 'amenity' && !/parking|toilets|bench|waste|atm/.test(t)) return 5
  if (c === 'building' || c === 'leisure') return 3
  if (c === 'boundary' || t === 'administrative') return 1
  if (c === 'information' || t === 'board' || t === 'guidepost') return -8
  // Street names containing "Kirche"/"Church" must not beat the actual church.
  if (c === 'highway' || c === 'shop') return -6
  return 0
}

export function nameMatchScore(displayName: string, query: string): number {
  const d = displayName.toLowerCase()
  const tokens = query
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2)
  if (!tokens.length) return 0
  let score = 0
  const head = d.slice(0, 100)
  for (const token of tokens) {
    if (head.includes(token)) score += 3
    else if (d.includes(token)) score += 1
  }
  if (tokens.every((t) => head.includes(t))) score += 4
  return score
}

/** How well display_name agrees with postcard locality tokens. */
export function localityConsistencyScore(
  displayName: string,
  localityHints: string[],
): number {
  if (!localityHints.length) return 0
  const d = displayName.toLowerCase()
  let score = 0
  let matched = 0
  for (const h of localityHints) {
    const token = h.toLowerCase()
    if (token.length < 3) continue
    // Skip generic landmark words used as hints.
    if (
      /^(church|kirche|kirke|kyrka|chapel|museum|castle|temple|shrine|park|lake)$/.test(
        token,
      )
    ) {
      continue
    }
    if (d.includes(token)) {
      matched += 1
      score += 8
    }
  }
  if (localityHints.length >= 1 && matched === 0) {
    // Address/locality was parsed but result is elsewhere — heavy penalty.
    const hasPlaceHint = localityHints.some(
      (h) =>
        h.length >= 4 &&
        !/^(church|kirche|kirke|Konvent|monastery)$/i.test(h),
    )
    if (hasPlaceHint) score -= 18
  }
  return score
}

export function inViewbox(
  lat: number,
  lng: number,
  box: { south: number; north: number; west: number; east: number },
): boolean {
  return lat >= box.south && lat <= box.north && lng >= box.west && lng <= box.east
}

export function scoreGeocodeCandidate(
  candidate: RankedGeocodeCandidate,
  query: string,
  localityHints: string[] = [],
  region: RegionBias | null = null,
): number {
  let score = (candidate.importance ?? 0) * 10
  score += poiTypeScore(candidate.className, candidate.typeName)
  score += nameMatchScore(candidate.displayName, query)
  score += localityConsistencyScore(candidate.displayName, localityHints)
  for (const h of localityHints) {
    if (candidate.displayName.includes(h)) score += 2
  }
  // Soft region preference from OCR-derived bias (replaces hard-coded Kyushu bump).
  if (region?.viewbox) {
    if (inViewbox(candidate.lat, candidate.lng, region.viewbox)) score += 6
    else score -= 4
  }
  // Street that only matches because of the word "Church"/"Lane".
  const c = (candidate.className ?? '').toLowerCase()
  if (
    (c === 'highway' || c === 'shop') &&
    /\b(church|kirche|lane|street|road)\b/i.test(candidate.displayName) &&
    !localityHints.some((h) =>
      candidate.displayName.toLowerCase().includes(h.toLowerCase()),
    )
  ) {
    score -= 20
  }
  return score
}

/** Prefer same-origin proxy (dev/preview) so Nominatim gets a User-Agent. */
function nominatimBase(): string {
  if (typeof window !== 'undefined') return '/api/nominatim'
  return 'https://nominatim.openstreetmap.org'
}

const memoryCache = new Map<
  string,
  { at: number; hits: RankedGeocodeCandidate[] }
>()
const CACHE_TTL_MS = 1000 * 60 * 60 * 6
const IDB_CACHE_KEY = 'bloom-pin-geocode-cache-v1'

async function readIdbCache(
  key: string,
): Promise<RankedGeocodeCandidate[] | null> {
  if (typeof indexedDB === 'undefined') return null
  try {
    const db = await openCacheDb()
    return await new Promise((resolve) => {
      const tx = db.transaction('geocode', 'readonly')
      const req = tx.objectStore('geocode').get(key)
      req.onsuccess = () => {
        const row = req.result as
          | { at: number; hits: RankedGeocodeCandidate[] }
          | undefined
        if (!row || Date.now() - row.at > CACHE_TTL_MS) resolve(null)
        else resolve(row.hits)
      }
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function writeIdbCache(
  key: string,
  hits: RankedGeocodeCandidate[],
): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    const db = await openCacheDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction('geocode', 'readwrite')
      tx.objectStore('geocode').put({ at: Date.now(), hits }, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch {
    /* ignore */
  }
}

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_CACHE_KEY, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('geocode')) {
        db.createObjectStore('geocode')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function attachPrecision(
  hits: RankedGeocodeCandidate[],
): RankedGeocodeCandidate[] {
  return hits.map((h) => ({
    ...h,
    precision: h.precision ?? inferPrecision(h.className, h.typeName),
  }))
}

async function geocodeNominatim(
  query: string,
  signal?: AbortSignal,
  region: RegionBias | null = null,
): Promise<RankedGeocodeCandidate[]> {
  const url = new URL(`${nominatimBase()}/search`)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '8')
  if (queryPrefersJapan(query)) {
    url.searchParams.set('countrycodes', 'jp')
  } else if (region?.countrycodes) {
    // Soft preference only — do not set bounded=1 so out-of-box hits remain.
    url.searchParams.set('countrycodes', region.countrycodes)
  }
  if (region?.viewbox) {
    const { west, north, east, south } = region.viewbox
    url.searchParams.set(
      'viewbox',
      `${west},${north},${east},${south}`,
    )
  }

  const headers: HeadersInit = { Accept: 'application/json' }
  if (typeof window === 'undefined') {
    headers['User-Agent'] = 'BloomPin/1.3 (Pikmin Bloom coords helper; github.com/evancho/pikmin-bloom-coords)'
  }

  const res = await fetch(url.toString(), { signal, headers })
  if (!res.ok) throw new Error(`Nominatim ${res.status}`)
  const data = (await res.json()) as NominatimResult[]
  return attachPrecision(
    (data ?? []).map((row) => {
      const raw = normalizeJapanish({
        lat: Number(row.lat),
        lng: Number(row.lon),
      })
      return {
        displayName: row.display_name,
        lat: raw.lat,
        lng: raw.lng,
        importance: row.importance,
        className: row.class,
        typeName: row.type,
      }
    }),
  )
}

async function geocodePhoton(
  query: string,
  signal?: AbortSignal,
  region: RegionBias | null = null,
): Promise<RankedGeocodeCandidate[]> {
  const url = new URL('https://photon.komoot.io/api/')
  url.searchParams.set('q', query)
  url.searchParams.set('limit', '8')
  url.searchParams.set('lang', 'default')
  if (queryPrefersJapan(query)) {
    url.searchParams.set('bbox', '122,24,154,46')
  } else if (region?.viewbox) {
    const { west, south, east, north } = region.viewbox
    url.searchParams.set('bbox', `${west},${south},${east},${north}`)
  }

  const res = await fetch(url.toString(), { signal })
  if (!res.ok) throw new Error(`Photon ${res.status}`)
  const data = (await res.json()) as { features: PhotonFeature[] }
  return attachPrecision(
    (data.features ?? []).map((f) => {
      const [lng, lat] = f.geometry.coordinates
      const raw = normalizeJapanish({ lat, lng })
      const p = f.properties
      return {
        displayName: displayFromPhoton(f) || query,
        lat: raw.lat,
        lng: raw.lng,
        className: p.osm_key,
        typeName: p.osm_value ?? p.type,
      }
    }),
  )
}

async function geocodeOpenMeteo(
  query: string,
  signal?: AbortSignal,
): Promise<RankedGeocodeCandidate[]> {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
  url.searchParams.set('name', query)
  const japanese = queryPrefersJapan(query)
  url.searchParams.set('count', '5')
  url.searchParams.set('language', japanese ? 'ja' : 'en')
  url.searchParams.set('format', 'json')

  const res = await fetch(url.toString(), { signal })
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`)
  const data = (await res.json()) as OpenMeteoResult
  return attachPrecision(
    (data.results ?? [])
      .filter(
        (r) =>
          !japanese ||
          !r.country ||
          r.country === 'Japan' ||
          r.country === '日本',
      )
      .map((r) => {
        const raw = normalizeJapanish({ lat: r.latitude, lng: r.longitude })
        return {
          displayName: displayFromMeteo(r),
          lat: raw.lat,
          lng: raw.lng,
          importance: r.rank,
          className: 'place',
          typeName: 'locality',
          precision: 'locality' as GeocodePrecision,
        }
      }),
  )
}

let lastNominatimAt = 0

async function throttleNominatim(): Promise<void> {
  const gap = 1100
  const wait = Math.max(0, lastNominatimAt + gap - Date.now())
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastNominatimAt = Date.now()
}

export async function geocodeQuery(
  query: string,
  signal?: AbortSignal,
  region: RegionBias | null = null,
): Promise<RankedGeocodeCandidate[]> {
  const cacheKey = `${query}|${region?.label ?? ''}`
  const mem = memoryCache.get(cacheKey)
  if (mem && Date.now() - mem.at < CACHE_TTL_MS) return mem.hits
  const idbHits = await readIdbCache(cacheKey)
  if (idbHits?.length) {
    memoryCache.set(cacheKey, { at: Date.now(), hits: idbHits })
    return idbHits
  }

  // Always merge Nominatim + Photon + Open-Meteo (JP and Latin alike).
  const merged: RankedGeocodeCandidate[] = []
  const seen = new Set<string>()
  const pushAll = (hits: RankedGeocodeCandidate[]) => {
    for (const h of hits) {
      const key = `${formatCoords(h.lat, h.lng)}|${h.displayName}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(h)
    }
  }

  try {
    await throttleNominatim()
    pushAll(await geocodeNominatim(query, signal, region))
  } catch (e) {
    if (signal?.aborted) throw e
  }
  try {
    pushAll(await geocodePhoton(query, signal, region))
  } catch (e) {
    if (signal?.aborted) throw e
  }
  try {
    pushAll(await geocodeOpenMeteo(query, signal))
  } catch (e) {
    if (signal?.aborted) throw e
  }

  memoryCache.set(cacheKey, { at: Date.now(), hits: merged })
  void writeIdbCache(cacheKey, merged)
  return merged
}

/** Mark candidates far from the OCR region ballpark as suspicious. */
export function markSuspicious(
  candidates: RankedGeocodeCandidate[],
  region: RegionBias | null,
  localityHints: string[],
): RankedGeocodeCandidate[] {
  if (!candidates.length) return candidates
  // Prefer the median of high-scoring in-region hits as a sanity anchor.
  const anchored = candidates.filter((c) => {
    if (region?.viewbox) return inViewbox(c.lat, c.lng, region.viewbox)
    return localityConsistencyScore(c.displayName, localityHints) > 0
  })
  const anchor = anchored[0] ?? null
  return candidates.map((c) => {
    let suspicious = false
    if (region?.viewbox && !inViewbox(c.lat, c.lng, region.viewbox)) {
      suspicious = true
    }
    if (
      anchor &&
      haversineKm(anchor.lat, anchor.lng, c.lat, c.lng) > 250 &&
      localityConsistencyScore(c.displayName, localityHints) <= 0
    ) {
      suspicious = true
    }
    return { ...c, suspicious }
  })
}

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

export function scoreAgainstQueries(
  candidate: RankedGeocodeCandidate,
  queries: string[],
  localityHints: string[],
  region: RegionBias | null = null,
): number {
  let best = scoreGeocodeCandidate(
    candidate,
    queries[0] ?? '',
    localityHints,
    region,
  )
  for (const q of queries) {
    best = Math.max(
      best,
      scoreGeocodeCandidate(candidate, q, localityHints, region),
    )
  }
  return best
}

export async function geocodeBest(
  queries: string[],
  signal?: AbortSignal,
  localityHints: string[] = [],
): Promise<{ candidates: GeocodeCandidate[]; usedQuery: string | null }> {
  const seen = new Set<string>()
  const all: RankedGeocodeCandidate[] = []
  let usedQuery: string | null = null
  const cleanedQueries = queries.map((q) => q.trim()).filter(Boolean)
  const region = regionBiasFromHints([
    ...localityHints,
    ...cleanedQueries,
  ])

  for (const q of cleanedQueries) {
    try {
      const hits = await geocodeQuery(q, signal, region)
      if (hits.length && !usedQuery) usedQuery = q
      for (const h of hits) {
        const key = formatCoords(h.lat, h.lng)
        if (seen.has(key)) {
          const existing = all.find((c) => formatCoords(c.lat, c.lng) === key)
          if (
            existing &&
            scoreAgainstQueries(h, cleanedQueries, localityHints, region) >
              scoreAgainstQueries(
                existing,
                cleanedQueries,
                localityHints,
                region,
              )
          ) {
            existing.displayName = h.displayName
            existing.importance = h.importance
            existing.className = h.className
            existing.typeName = h.typeName
            existing.precision = h.precision
          }
          continue
        }
        seen.add(key)
        all.push(h)
      }
      const hasLandmark = all.some(
        (c) =>
          poiTypeScore(c.className, c.typeName) >= 7 &&
          scoreAgainstQueries(c, cleanedQueries, localityHints, region) >= 12,
      )
      if (hasLandmark) {
        usedQuery =
          cleanedQueries.find((q) =>
            all.some(
              (c) =>
                poiTypeScore(c.className, c.typeName) >= 7 &&
                nameMatchScore(c.displayName, q) >= 4,
            ),
          ) ?? usedQuery
        break
      }
      const hasLocal = all.some((c) =>
        localityHints.some((h) => c.displayName.includes(h)),
      )
      if (queryPrefersJapan(q) && hasLocal && all.length >= 2) break
      if (all.length >= 14) break
    } catch (err) {
      if (signal?.aborted) throw err
    }
  }

  all.sort(
    (a, b) =>
      scoreAgainstQueries(b, cleanedQueries, localityHints, region) -
      scoreAgainstQueries(a, cleanedQueries, localityHints, region),
  )

  const ranked = markSuspicious(all, region, localityHints)
  // Do not auto-prefer a suspicious out-of-region street over an in-region hit.
  ranked.sort((a, b) => {
    const sa = scoreAgainstQueries(a, cleanedQueries, localityHints, region)
    const sb = scoreAgainstQueries(b, cleanedQueries, localityHints, region)
    if (Boolean(a.suspicious) !== Boolean(b.suspicious)) {
      return a.suspicious ? 1 : -1
    }
    return sb - sa
  })

  const top = ranked[0]
  if (top && poiTypeScore(top.className, top.typeName) >= 7) {
    usedQuery =
      cleanedQueries.find((q) => nameMatchScore(top.displayName, q) >= 4) ??
      usedQuery
  }

  return {
    candidates: ranked.slice(0, 6).map(
      ({ className: _c, typeName: _t, ...rest }) => rest,
    ),
    usedQuery,
  }
}

export function mapUrl(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`
}

export function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`
}

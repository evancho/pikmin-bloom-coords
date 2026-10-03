import type { GeocodeCandidate } from '../types'
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

/**
 * Expand a Latin postcard title into geocoder-friendly landmark queries.
 * "Konvent Plasy" alone often hits an info board; "Klášter Plasy" / "monastery Plasy" hits the building.
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

  const m = title.match(
    /^(Konvent|Convent|Kloster|Klášter|Abbey|Monastery|Castle|Schloss|Palais|Palace|Church|Chapel|Cathedral|Museum|Basilica|Temple|Shrine|Tower|Station|Airport)\s+(.+)$/i,
  )
  if (m) {
    const kind = m[1]!.toLowerCase()
    const rest = m[2]!.trim()
    // Landmark synonyms first — these usually match the OSM amenity better
    // than the raw postcard title (e.g. Konvent → Klášter / monastery).
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
    } else if (/church|chapel|cathedral|temple|shrine/.test(kind)) {
      push(`church ${rest}`)
      push(`${rest} church`)
    } else if (/museum/.test(kind)) {
      push(`museum ${rest}`)
    } else {
      push(`${kind} ${rest}`)
      push(`${rest} ${kind}`)
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
    /monastery|place_of_worship|cathedral|chapel|church|temple|shrine|castle|palace|museum|attraction|ruins|memorial|monument|tower|bridge|station|airport|university|zoo|theme_park|artwork|viewpoint/.test(
      key,
    )
  ) {
    return 10
  }
  if (c === 'tourism' || c === 'historic') return 7
  if (c === 'amenity' && !/parking|toilets|bench|waste|atm/.test(t)) return 5
  if (c === 'building' || c === 'leisure') return 3
  if (c === 'boundary' || t === 'administrative') return 1
  if (c === 'information' || t === 'board' || t === 'guidepost') return -8
  if (c === 'highway' || c === 'shop') return -2
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

export function scoreGeocodeCandidate(
  candidate: RankedGeocodeCandidate,
  query: string,
  localityHints: string[] = [],
): number {
  let score = (candidate.importance ?? 0) * 10
  score += poiTypeScore(candidate.className, candidate.typeName)
  score += nameMatchScore(candidate.displayName, query)
  for (const h of localityHints) {
    if (candidate.displayName.includes(h)) score += 5
  }
  return score
}

/** Prefer same-origin proxy (dev/preview) so Nominatim gets a User-Agent. */
function nominatimBase(): string {
  if (typeof window !== 'undefined') return '/api/nominatim'
  return 'https://nominatim.openstreetmap.org'
}

async function geocodeNominatim(
  query: string,
  signal?: AbortSignal,
): Promise<RankedGeocodeCandidate[]> {
  const url = new URL(`${nominatimBase()}/search`)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '8')
  if (queryPrefersJapan(query)) url.searchParams.set('countrycodes', 'jp')

  const headers: HeadersInit = { Accept: 'application/json' }
  if (typeof window === 'undefined') {
    headers['User-Agent'] = 'BloomPin/1.0 (Pikmin Bloom coords helper)'
  }

  const res = await fetch(url.toString(), { signal, headers })
  if (!res.ok) throw new Error(`Nominatim ${res.status}`)
  const data = (await res.json()) as NominatimResult[]
  return (data ?? []).map((row) => {
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
  })
}

async function geocodePhoton(
  query: string,
  signal?: AbortSignal,
): Promise<RankedGeocodeCandidate[]> {
  const url = new URL('https://photon.komoot.io/api/')
  url.searchParams.set('q', query)
  url.searchParams.set('limit', '8')
  url.searchParams.set('lang', 'default')
  if (queryPrefersJapan(query)) url.searchParams.set('bbox', '122,24,154,46')

  const res = await fetch(url.toString(), { signal })
  if (!res.ok) throw new Error(`Photon ${res.status}`)
  const data = (await res.json()) as { features: PhotonFeature[] }
  return (data.features ?? []).map((f) => {
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
  })
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
  return (data.results ?? [])
    .filter(
      (r) =>
        !japanese || !r.country || r.country === 'Japan' || r.country === '日本',
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
      }
    })
}

export async function geocodeQuery(
  query: string,
  signal?: AbortSignal,
): Promise<RankedGeocodeCandidate[]> {
  const providers = [geocodeNominatim, geocodePhoton, geocodeOpenMeteo]
  // Worldwide Latin names: merge providers so a weak Nominatim info-board
  // hit does not hide a better Photon/OSM monastery result from another query.
  // Japanese stays first-success to keep the old low-latency path.
  if (queryPrefersJapan(query)) {
    for (const provider of providers) {
      try {
        const hits = await provider(query, signal)
        if (hits.length) return hits
      } catch (e) {
        if (signal?.aborted) throw e
      }
    }
    return []
  }

  const merged: RankedGeocodeCandidate[] = []
  const seen = new Set<string>()
  for (const provider of providers) {
    try {
      const hits = await provider(query, signal)
      for (const h of hits) {
        const key = `${formatCoords(h.lat, h.lng)}|${h.displayName}`
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(h)
      }
    } catch (e) {
      if (signal?.aborted) throw e
    }
  }
  return merged
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

  for (const q of cleanedQueries) {
    try {
      const hits = await geocodeQuery(q, signal)
      if (hits.length && !usedQuery) usedQuery = q
      for (const h of hits) {
        const key = formatCoords(h.lat, h.lng)
        if (seen.has(key)) {
          const existing = all.find((c) => formatCoords(c.lat, c.lng) === key)
          if (
            existing &&
            scoreAgainstQueries(h, cleanedQueries, localityHints) >
              scoreAgainstQueries(existing, cleanedQueries, localityHints)
          ) {
            existing.displayName = h.displayName
            existing.importance = h.importance
            existing.className = h.className
            existing.typeName = h.typeName
          }
          continue
        }
        seen.add(key)
        all.push(h)
      }
      const hasLandmark = all.some(
        (c) =>
          poiTypeScore(c.className, c.typeName) >= 7 &&
          scoreAgainstQueries(c, cleanedQueries, localityHints) >= 12,
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
      // Japanese path: stop once we have enough locality hits.
      if (queryPrefersJapan(q) && hasLocal && all.length >= 2) break
      if (all.length >= 14) break
    } catch (err) {
      if (signal?.aborted) throw err
    }
  }

  all.sort(
    (a, b) =>
      scoreAgainstQueries(b, cleanedQueries, localityHints) -
      scoreAgainstQueries(a, cleanedQueries, localityHints),
  )

  // Prefer a landmark-bearing query as the reported usedQuery.
  const top = all[0]
  if (top && poiTypeScore(top.className, top.typeName) >= 7) {
    usedQuery =
      cleanedQueries.find((q) => nameMatchScore(top.displayName, q) >= 4) ??
      usedQuery
  }

  return {
    candidates: all.slice(0, 6).map(({ className: _c, typeName: _t, ...rest }) => rest),
    usedQuery,
  }
}

function scoreAgainstQueries(
  candidate: RankedGeocodeCandidate,
  queries: string[],
  localityHints: string[],
): number {
  let best = scoreGeocodeCandidate(candidate, queries[0] ?? '', localityHints)
  for (const q of queries) {
    best = Math.max(best, scoreGeocodeCandidate(candidate, q, localityHints))
  }
  // Prefer Kyushu / Oita ballpark when hints mention 佐伯/大分
  if (
    localityHints.some((h) => h === '佐伯' || h === '大分' || h === '浅海井')
  ) {
    if (
      candidate.lat > 32.5 &&
      candidate.lat < 34 &&
      candidate.lng > 131 &&
      candidate.lng < 132.5
    ) {
      best += 3
    }
  }
  return best
}

export function mapUrl(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`
}

export function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`
}

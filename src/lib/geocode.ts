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
    osm_value?: string
  }
}

type NominatimResult = {
  display_name: string
  lat: string
  lon: string
  importance?: number
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

/** Prefer same-origin proxy (dev/preview) so Nominatim gets a User-Agent. */
function nominatimBase(): string {
  if (typeof window !== 'undefined') return '/api/nominatim'
  return 'https://nominatim.openstreetmap.org'
}

async function geocodeNominatim(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeCandidate[]> {
  const url = new URL(`${nominatimBase()}/search`)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '5')
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
    }
  })
}

async function geocodePhoton(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeCandidate[]> {
  const url = new URL('https://photon.komoot.io/api/')
  url.searchParams.set('q', query)
  url.searchParams.set('limit', '5')
  url.searchParams.set('lang', 'default')
  if (queryPrefersJapan(query)) url.searchParams.set('bbox', '122,24,154,46')

  const res = await fetch(url.toString(), { signal })
  if (!res.ok) throw new Error(`Photon ${res.status}`)
  const data = (await res.json()) as { features: PhotonFeature[] }
  return (data.features ?? []).map((f) => {
    const [lng, lat] = f.geometry.coordinates
    const raw = normalizeJapanish({ lat, lng })
    return {
      displayName: displayFromPhoton(f) || query,
      lat: raw.lat,
      lng: raw.lng,
    }
  })
}

async function geocodeOpenMeteo(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeCandidate[]> {
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
      }
    })
}

export async function geocodeQuery(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeCandidate[]> {
  const providers = [geocodeNominatim, geocodePhoton, geocodeOpenMeteo]
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

export async function geocodeBest(
  queries: string[],
  signal?: AbortSignal,
  localityHints: string[] = [],
): Promise<{ candidates: GeocodeCandidate[]; usedQuery: string | null }> {
  const seen = new Set<string>()
  const all: GeocodeCandidate[] = []
  let usedQuery: string | null = null

  for (const q of queries) {
    if (!q.trim()) continue
    try {
      const hits = await geocodeQuery(q, signal)
      if (hits.length && !usedQuery) usedQuery = q
      for (const h of hits) {
        const key = formatCoords(h.lat, h.lng)
        if (seen.has(key)) continue
        seen.add(key)
        all.push(h)
      }
      // Keep searching until we have a locality-matching hit or enough options
      const hasLocal = all.some((c) =>
        localityHints.some((h) => c.displayName.includes(h)),
      )
      if (hasLocal && all.length >= 2) break
      if (all.length >= 8) break
    } catch (err) {
      if (signal?.aborted) throw err
    }
  }

  all.sort((a, b) => {
    const score = (c: GeocodeCandidate) => {
      let s = c.importance ?? 0
      for (const h of localityHints) {
        if (c.displayName.includes(h)) s += 5
      }
      // Prefer Kyushu / Oita ballpark when hints mention 佐伯/大分
      if (
        localityHints.some((h) => h === '佐伯' || h === '大分' || h === '浅海井')
      ) {
        if (c.lat > 32.5 && c.lat < 34 && c.lng > 131 && c.lng < 132.5) s += 3
      }
      return s
    }
    return score(b) - score(a)
  })

  return { candidates: all.slice(0, 6), usedQuery }
}

export function mapUrl(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`
}

export function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { geocodeBest, geocodeQuery } from './geocode'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('geocodeQuery merge (mocked fetch)', () => {
  it('merges Japanese Nominatim + Photon + Open-Meteo hits', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('nominatim') || url.includes('/api/nominatim')) {
        return jsonResponse([
          {
            display_name: '滝神社, 佐伯市, 大分県, 日本',
            lat: '33.041594',
            lon: '131.919253',
            importance: 0.4,
            class: 'amenity',
            type: 'place_of_worship',
          },
        ])
      }
      if (url.includes('photon.komoot.io')) {
        return jsonResponse({
          features: [
            {
              geometry: { coordinates: [131.92, 33.042] },
              properties: {
                name: '滝神社',
                city: '佐伯市',
                state: '大分県',
                country: 'Japan',
                osm_key: 'amenity',
                osm_value: 'place_of_worship',
              },
            },
          ],
        })
      }
      if (url.includes('open-meteo.com')) {
        return jsonResponse({
          results: [
            {
              name: '佐伯',
              latitude: 32.96,
              longitude: 131.9,
              country: 'Japan',
              admin1: 'Oita',
              rank: 0.3,
            },
          ],
        })
      }
      return jsonResponse([], 404)
    })
    vi.stubGlobal('fetch', fetchMock)

    const hits = await geocodeQuery('滝神社 佐伯市')
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits.some((h) => h.precision === 'landmark')).toBe(true)
    expect(hits.some((h) => h.precision === 'locality')).toBe(true)
    // All three providers should have been called (JP no longer first-success-only).
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('ranks Kaldfjord / Tromsø above Guernsey Church Lane', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('nominatim') || url.includes('/api/nominatim')) {
        return jsonResponse([
          {
            display_name: 'Church Lane, St Peter Port, Guernsey',
            lat: '49.455',
            lon: '-2.536',
            importance: 0.55,
            class: 'highway',
            type: 'residential',
          },
          {
            display_name: 'Kvaløy kirke, Kaldfjord, Tromsø, Troms, Norge',
            lat: '69.6806',
            lon: '18.7442',
            importance: 0.35,
            class: 'amenity',
            type: 'place_of_worship',
          },
        ])
      }
      if (url.includes('photon.komoot.io') || url.includes('open-meteo.com')) {
        return jsonResponse(url.includes('photon') ? { features: [] } : { results: [] })
      }
      return jsonResponse([])
    })
    vi.stubGlobal('fetch', fetchMock)

    const { candidates } = await geocodeBest(
      ['Kaldfjord kirke', 'Kaldfjord Church Kvaløya', 'Kaldfjord Church'],
      undefined,
      ['Kvaløya', 'Kaldfjord', 'Tromsø'],
    )
    expect(candidates.length).toBeGreaterThan(0)
    const best = candidates.find((c) => !c.suspicious) ?? candidates[0]!
    expect(best.lat).toBeCloseTo(69.6806, 2)
    expect(best.lng).toBeCloseTo(18.7442, 2)
    expect(best.displayName).toMatch(/Troms|Kval|Kaldfjord/i)
    expect(best.displayName).not.toMatch(/Guernsey/i)
  })
})

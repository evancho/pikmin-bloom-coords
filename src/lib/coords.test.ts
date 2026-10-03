import { describe, expect, it } from 'vitest'
import { captionBandFromRows, type CaptionRow } from './captionCrop'
import { formatCoords, parseCoordsText } from './coords'
import {
  expandPlaceQueries,
  nameMatchScore,
  poiTypeScore,
  queryPrefersJapan,
  scoreGeocodeCandidate,
} from './geocode'
import {
  extractLocalityFromHint,
  isCommemorativePhrase,
  mergeParsedLocations,
  parseLocationFromOcr,
} from './parseLocation'

describe('coords', () => {
  it('formats latitude, longitude', () => {
    expect(formatCoords(34.700393, 137.783065)).toBe('34.700393, 137.783065')
  })

  it('parses fullwidth comma', () => {
    expect(parseCoordsText('33.041594，131.919253')).toEqual({
      lat: 33.041594,
      lng: 131.919253,
    })
  })

  it('rejects invalid ranges', () => {
    expect(parseCoordsText('99, 137')).toBeNull()
  })
})

describe('parseLocationFromOcr', () => {
  it('extracts postcard title and address', () => {
    const text = `
滝神社
距離：1,600,188m 佐伯市 上浦大字浅海井浦
暁嵐の滝にある神社。地元の人も多く参拝に訪れる。
`
    const parsed = parseLocationFromOcr(text)
    expect(parsed.title).toBe('滝神社')
    expect(parsed.address).toContain('佐伯市')
    expect(parsed.searchQueries.some((q) => q.includes('滝神社'))).toBe(true)
  })

  it('joins spaced CJK from noisy OCR', () => {
    const text = `
3:47
滝 神 社
距離 ・ 1,600,188m 佐 伯 市 上 浦 大 字 浅海 井 浦
暁 嵐 の 滝 に ある 神社 。
`
    const parsed = parseLocationFromOcr(text)
    expect(parsed.title).toBe('滝神社')
    expect(parsed.address).toMatch(/佐伯市/)
    expect(parsed.searchQueries).toContain('瀧三柱神社 佐伯市')
  })

  it('uses a Latin postcard title instead of a long kana string', () => {
    const parsed = parseLocationFromOcr(`
導ゲンーンージン全計
: まま時 2
Gemeentehuis Oud-Turnhout
距離：9,578,863m Dorp 舊蒂倫豪特
Gemeentehuis
`)
    expect(parsed.title).toBe('Gemeentehuis Oud-Turnhout')
    expect(parsed.title!.length).toBeLessThan(40)
    expect(parsed.searchQueries[0]).toBe('Gemeentehuis Oud-Turnhout')
    expect(parsed.searchQueries.some((q) => q.includes('大分'))).toBe(false)
  })

  it('prefers Konvent Plasy over a mangled Kl&ster subtitle', () => {
    const parsed = parseLocationFromOcr(`---eng---
Konvent Plasy
EERE © 9,575,818mPlasy Plasy
Kl&ster Plasy.
---jpn---
リーロー
距離：9,575,818m
`)
    expect(parsed.title).toBe('Konvent Plasy')
    expect(parsed.title).not.toContain('&')
  })

  it('rejects Latin OCR lines that contain ampersand noise', () => {
    const parsed = parseLocationFromOcr(`---eng---
Kl&ster Plasy.
---jpn---
`)
    expect(parsed.title).toBeNull()
  })

  it('prefers Konvent Plasy over a Japanese kana misread', () => {
    const parsed = parseLocationFromOcr(`---eng---
Konvent Plasy
Distance: 8,412m Plasy
---jpn---
リーロー
距離：8,412m
`)
    expect(parsed.title).toBe('Konvent Plasy')
    expect(parsed.title).not.toMatch(/[ァ-ンー]/)
  })

  it('never keeps a pure-kana OCR title', () => {
    const parsed = parseLocationFromOcr(`
リーロー
距離：1,234m
`)
    expect(parsed.title).toBeNull()
  })

  it('prefers the English pass over a longer Japanese misread', () => {
    const parsed = parseLocationFromOcr(`---eng---
Gemeentehuis Oud-Turnhout
Gemeentehuis
---jpn---
Gemeenitehuis Oud-Turnhout
距離：9,578,863m Dorp 舊蒂倫豪特
`)
    expect(parsed.title).toBe('Gemeentehuis Oud-Turnhout')
  })

  it('pulls a Latin place name out of one fused OCR line', () => {
    const parsed = parseLocationFromOcr(
      'まま時 2Gemeentehuis Oud-Turnhout距離：9,578,863mDorp 舊蒂倫豪特',
    )
    expect(parsed.title).toBe('Gemeentehuis Oud-Turnhout')
  })

  it('prefers a Japanese shrine title over English OCR noise', () => {
    const parsed = parseLocationFromOcr(`
EERE BER
滝神社
距離：1,600,188m 佐伯市 上浦大字浅海井浦
暁嵐の滝にある神社。
`)
    expect(parsed.title).toBe('滝神社')
    expect(parsed.searchQueries).toContain('瀧三柱神社 佐伯市')
  })

  it('merges postcard + map parses', () => {
    const postcard = parseLocationFromOcr(`
滝神社
距離：1,600,188m 佐伯市 上浦大字浅海井浦
暁嵐の滝にある神社。
`)
    const map = parseLocationFromOcr(`
日代
浅海井
`)
    const merged = mergeParsedLocations([postcard, map])
    expect(merged.title).toBe('滝神社')
    expect(merged.address).toContain('佐伯市')
    expect(merged.searchQueries.some((q) => q.includes('浅海井'))).toBe(true)
  })

  it('rejects German commemorative inscriptions as titles', () => {
    expect(isCommemorativePhrase('Dem Gedenken Der Im Weltkrieg')).toBe(true)
    expect(isCommemorativePhrase('Gefallenen Söhne Unserer Stadt')).toBe(true)
    expect(isCommemorativePhrase('Konvent Plasy')).toBe(false)
    expect(extractLocalityFromHint('In Bad Berka bei der Kirche')).toBe(
      'Bad Berka',
    )
  })

  it('prefers Bad Berka locality over a war-memorial postcard title', () => {
    const postcard = parseLocationFromOcr(`---eng---
Dem Gedenken Der Im Weltkrieg
Gefallenen Söhne Unserer Stadt
距離：9,159,440m 巴特貝爾卡 巴德貝爾卡
In Bad Berka bei der Kirche
---jpn---
距離：9,159,440m 巴特貝爾卡 巴德貝爾卡
`)
    expect(postcard.title).toBe('Bad Berka')
    expect(postcard.title).not.toMatch(/Gedenken|Weltkrieg/i)
    expect(postcard.searchQueries[0]).toMatch(/Bad Berka.*Kirche|Kirche.*Bad Berka/i)
    expect(postcard.searchQueries).toContain('Bad Berka')

    const map = parseLocationFromOcr(`---eng---
Bad Berka
---jpn---
`)
    expect(map.title).toBe('Bad Berka')

    const merged = mergeParsedLocations([postcard, map])
    expect(merged.title).toBe('Bad Berka')
    expect(merged.searchQueries.some((q) => /Gedenken|Weltkrieg/i.test(q))).toBe(
      false,
    )
  })

  it('uses map town when postcard title is only commemorative', () => {
    const postcard = parseLocationFromOcr(`---eng---
Dem Gedenken Der Im Weltkrieg
Gefallenen Söhne Unserer Stadt
---jpn---
`)
    const map = parseLocationFromOcr(`---eng---
Bad Berka
---jpn---
`)
    // Postcard alone may have no usable title once memorials are rejected.
    expect(postcard.title == null || postcard.title === 'Bad Berka').toBe(true)
    const merged = mergeParsedLocations([
      { ...postcard, title: 'Dem Gedenken Der Im Weltkrieg' },
      map,
    ])
    expect(merged.title).toBe('Bad Berka')
  })
})

describe('caption band', () => {
  it('keeps the blue caption and drops the photo', () => {
    const rows: CaptionRow[] = []
    for (let y = 400; y < 900; y += 2) {
      rows.push({ y, r: 120, g: 100, b: 80, contrast: 4 })
    }
    for (let y = 900; y < 980; y += 2) {
      rows.push({ y, r: 40, g: 100, b: 150, contrast: 0.2 })
    }
    for (let y = 980; y < 1020; y += 2) {
      rows.push({ y, r: 90, g: 140, b: 170, contrast: 14 })
    }
    for (let y = 1020; y < 1080; y += 2) {
      rows.push({ y, r: 40, g: 100, b: 150, contrast: 0.2 })
    }
    for (let y = 1080; y < 1140; y += 2) {
      rows.push({ y, r: 80, g: 140, b: 170, contrast: 12 })
    }
    for (let y = 1200; y < 1500; y += 2) {
      rows.push({ y, r: 80, g: 170, b: 80, contrast: 2 })
    }
    const band = captionBandFromRows(rows, 2000)
    expect(band).not.toBeNull()
    expect(band!.y).toBeGreaterThanOrEqual(900)
    expect(band!.y).toBeLessThan(980)
    expect(band!.y + band!.height).toBeGreaterThan(1100)
    expect(band!.y + band!.height).toBeLessThan(1250)
  })
})

describe('geocode scope', () => {
  it('limits Japanese queries to Japan and lets Latin names search worldwide', () => {
    expect(queryPrefersJapan('滝神社 佐伯市')).toBe(true)
    expect(queryPrefersJapan('Gemeentehuis Oud-Turnhout')).toBe(false)
  })

  it('expands Konvent titles into monastery landmark queries', () => {
    const qs = expandPlaceQueries('Konvent Plasy', 'Plasy')
    expect(qs[0]).toBe('Konvent Plasy')
    expect(qs).toContain('Klášter Plasy')
    expect(qs).toContain('monastery Plasy')
    expect(qs).toContain('Plasy')
  })

  it('scores monasteries above information boards', () => {
    const board = scoreGeocodeCandidate(
      {
        displayName: 'Jak vodník ochránil konvent, Plasy, Česko',
        lat: 49.932882,
        lng: 13.386732,
        importance: 0.0001,
        className: 'information',
        typeName: 'board',
      },
      'Konvent Plasy',
      ['Plasy'],
    )
    const monastery = scoreGeocodeCandidate(
      {
        displayName: 'Klášter Plasy, Plzeňská, Plasy, Česko',
        lat: 49.935769,
        lng: 13.390775,
        importance: 0.39,
        className: 'amenity',
        typeName: 'monastery',
      },
      'Klášter Plasy',
      ['Plasy'],
    )
    expect(poiTypeScore('amenity', 'monastery')).toBeGreaterThan(
      poiTypeScore('information', 'board'),
    )
    expect(monastery).toBeGreaterThan(board)
    expect(nameMatchScore('Klášter Plasy, Plasy', 'Klášter Plasy')).toBeGreaterThan(5)
  })
})

describe('latin geocode queries from OCR', () => {
  it('includes Klášter / monastery queries for Konvent Plasy', () => {
    const parsed = parseLocationFromOcr(`---eng---
Konvent Plasy
EERE © 9,575,818mPlasy Plasy
Kl&ster Plasy.
---jpn---
`)
    expect(parsed.title).toBe('Konvent Plasy')
    expect(parsed.searchQueries).toContain('Konvent Plasy')
    expect(parsed.searchQueries).toContain('Klášter Plasy')
    expect(parsed.searchQueries).toContain('monastery Plasy')
    expect(parsed.searchQueries.some((q) => /Klaster|Klášter/i.test(q))).toBe(
      true,
    )
  })
})

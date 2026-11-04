import { describe, expect, it } from 'vitest'
import { captionBandFromRows, type CaptionRow } from './captionCrop'
import { formatCoords, parseCoordsText } from './coords'
import { otsuThreshold } from './imageEnhance'
import {
  expandPlaceQueries,
  inferPrecision,
  localityConsistencyScore,
  markSuspicious,
  nameMatchScore,
  poiTypeScore,
  queryPrefersJapan,
  regionBiasFromHints,
  scoreAgainstQueries,
  scoreGeocodeCandidate,
} from './geocode'
import {
  consensusLatinTitles,
  extractLocalityFromHint,
  isCommemorativePhrase,
  isWeakLatinOcrTitle,
  localityHints,
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

  it('keeps an English title with lowercase common nouns (La Salle Lake)', () => {
    // Real OCR output from a BC postcard: the old lowerLead rule rejected
    // "La Salle Lake recreation area" as noise and fell back to the region
    // fragment "Fort George" from the distance line.
    const parsed = parseLocationFromOcr(`---eng---
La Salle Lake recreation area
enfrance

PERE - 9,498,709mFraser-Fort George

La Salle ake Log aalmereg.s o smal 20-
ete camnnriREE RES EEE 1 AH An
---jpn---
のオ 可サリルク05 まっ 店 でし リーの 二記1た せ ジーン本
La Salle Lake recreation qreg
enifraqnce
距離 ・ の498,709mFraser-Fort George
La Salle 人語導導に 20-
---chi---
`)
    expect(parsed.title).toBe('La Salle Lake recreation area')
    expect(parsed.address).toContain('Fraser-Fort George')
    expect(parsed.searchQueries[0]).toBe('La Salle Lake recreation area')
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
    expect(isCommemorativePhrase('Gefallanaen SAhne Unserer St')).toBe(true)
    expect(isCommemorativePhrase('Dem Gedenken Der Im Welkrieg')).toBe(true)
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
    expect(postcard.searchQueries[0]).toBe('Bad Berka')
    expect(postcard.searchQueries).toContain('Stadtkirche Bad Berka')
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
    expect(merged.searchQueries).toContain('Stadtkirche Bad Berka')
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
    expect(band!.y).toBeGreaterThanOrEqual(860)
    expect(band!.y).toBeLessThan(980)
    // End near the last text row — do not stretch into unrelated chrome.
    expect(band!.y + band!.height).toBeGreaterThan(1100)
    expect(band!.y + band!.height).toBeLessThan(1200)
  })

  it('prefers the purple caption card over textured blue sky (Kaldfjord)', () => {
    const rows: CaptionRow[] = []
    // Photo sky: blue-ish, almost every row textured → must be skipped.
    for (let y = 708; y < 1024; y += 2) {
      rows.push({ y, r: 76, g: 109, b: 157, contrast: 8 })
    }
    // Snow / building mid section
    for (let y = 1024; y < 1450; y += 2) {
      rows.push({ y, r: 200, g: 200, b: 205, contrast: 3 })
    }
    // Purple caption card: flat field + sparse text rows
    for (let y = 1450; y < 1670; y += 2) {
      const isText =
        (y >= 1470 && y < 1510) || (y >= 1540 && y < 1580) || (y >= 1610 && y < 1640)
      rows.push({
        y,
        r: 53,
        g: 37,
        b: 113,
        contrast: isText ? 12 : 0.2,
      })
    }
    // Page chrome below
    for (let y = 1670; y < 1940; y += 2) {
      rows.push({ y, r: 40, g: 30, b: 90, contrast: 0.1 })
    }
    const band = captionBandFromRows(rows, 2000)
    expect(band).not.toBeNull()
    expect(band!.y).toBeGreaterThanOrEqual(1440)
    expect(band!.y).toBeLessThan(1480)
    expect(band!.y + band!.height).toBeGreaterThan(1620)
    expect(band!.y + band!.height).toBeLessThan(1700)
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

  it('ranks town centers and churches above railway stations', () => {
    expect(poiTypeScore('place', 'town')).toBeGreaterThan(
      poiTypeScore('railway', 'station'),
    )
    expect(poiTypeScore('amenity', 'place_of_worship')).toBeGreaterThan(
      poiTypeScore('railway', 'station'),
    )
    expect(poiTypeScore('highway', 'service')).toBeLessThan(0)
  })
})

describe('japanese postcard titles', () => {
  it('rejects weak English OCR junk like an vere Fushimi Ward', () => {
    expect(isWeakLatinOcrTitle('an vere Fushimi Ward')).toBe(true)
    expect(isWeakLatinOcrTitle('Kyoto Fushimi Ward')).toBe(false)
    expect(isWeakLatinOcrTitle('Konvent Plasy')).toBe(false)
    expect(isWeakLatinOcrTitle('La Salle Lake recreation area')).toBe(false)
  })

  it('prefers 喫茶店リゲル over eng OCR ward junk in auto mode', () => {
    const parsed = parseLocationFromOcr(`---eng---
an vere Fushimi Ward
距離：8,067,158m Kyoto Fushimi Ward
---jpn---
喫茶店リゲル
距離：8,067,158m Kyoto Fushimi Ward
昔からある純喫茶。
`)
    expect(parsed.title).toBe('喫茶店リゲル')
    expect(parsed.address).toMatch(/Fushimi|Kyoto/i)
  })

  it('ja preference keeps Japanese titles even without shop keywords', () => {
    const parsed = parseLocationFromOcr(
      `---eng---
Kyoto Somewhere
---jpn---
青い屋根の家
`,
      'ja',
    )
    expect(parsed.title).toBe('青い屋根の家')
  })

  it('zh preference keeps Chinese CJK titles over Latin OCR', () => {
    const parsed = parseLocationFromOcr(
      `---eng---
an vere Fushimi Ward
---jpn---
---chi---
巴特貝爾卡咖啡店
距離：1,234m
`,
      'zh',
    )
    expect(parsed.title).toMatch(/巴特貝爾卡|咖啡/)
  })

  it('en preference keeps Latin landmark titles', () => {
    const parsed = parseLocationFromOcr(
      `---eng---
Konvent Plasy
---jpn---
リーロー
`,
      'en',
    )
    expect(parsed.title).toBe('Konvent Plasy')
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

describe('Kaldfjord Church postcard OCR/parse', () => {
  const kaldfjordOcr = `---eng---
Kaldfjord Church
7,889,280mKvaløya
Kaldfjord Church
距離：7,889,280mKvaløya
---jpn---
Kaldfjord Church
距離：7,889,280mKvaløya
---chi---
`

  it('splits glued distance+place and keeps Kaldfjord Church title', () => {
    const parsed = parseLocationFromOcr(kaldfjordOcr)
    expect(parsed.title).toBe('Kaldfjord Church')
    expect(parsed.address).toMatch(/Kval[øo]ya/i)
    expect(parsed.searchQueries).toContain('Kaldfjord kirke')
    expect(parsed.searchQueries.some((q) => /Kval/i.test(q))).toBe(true)
  })

  it('keeps Kaldfjord Church from the real postcard+map OCR dump', () => {
    // Captured from the two screenshots (eng misreads fj as fi; jpn inserts g).
    const postcard = parseLocationFromOcr(`---eng---
Kaldfiord Church
Kaldfiord Church
Kaldfjord Church
PERE  7,889,280mKvalgya
fått : / 889 280mKvaløva
PEE. / 889 280mKvalgyva
---jpn---
Kagldfiord Church
Kagldfiord Church
Kaldfjiord Church
距離: 7,889,280mKvalgya
距離 7.889.280mKvalaya
---chi---
`)
    const map = parseLocationFromOcr(`---eng---
Kaldfjord
xX
Kaldfiord
---jpn---
Kaldfjord
---chi---
`)
    expect(postcard.title).toBe('Kaldfjord Church')
    expect(postcard.address).toBe('Kvaløya')
    expect(postcard.searchQueries).toContain('Kaldfjord kirke')
    expect(postcard.searchQueries.some((q) => /Stadtkirche/i.test(q))).toBe(false)
    expect(map.title).toBe('Kaldfjord')
    const merged = mergeParsedLocations([postcard, map])
    expect(merged.title).toBe('Kaldfjord Church')
    expect(merged.address).toBe('Kvaløya')
    expect(merged.searchQueries[0]).toMatch(/Kaldfjord/)
  })

  it('prefers eng+jpn consensus title over a weaker single-line guess', () => {
    expect(
      consensusLatinTitles(
        ['Koldlord Church', 'Kaldfjord Church'],
        ['Kaldfjord Church'],
      ),
    ).toContain('Kaldfjord Church')
    const parsed = parseLocationFromOcr(`---eng---
Koldlord Church
Kaldfjord Church
---jpn---
Kaldfjord Church
`)
    expect(parsed.title).toBe('Kaldfjord Church')
  })
})

describe('imageEnhance', () => {
  it('computes an Otsu threshold that separates dark and light peaks', () => {
    const lums = new Uint8Array(1000)
    for (let i = 0; i < 500; i += 1) lums[i] = 30
    for (let i = 500; i < 1000; i += 1) lums[i] = 200
    const thr = otsuThreshold(lums)
    expect(thr).toBeGreaterThanOrEqual(30)
    expect(thr).toBeLessThan(200)
    // Binarization with > thr keeps the two classes apart.
    expect(30 > thr).toBe(false)
    expect(200 > thr).toBe(true)
  })
})

describe('geocode precision and Kaldfjord ranking', () => {
  it('expands Nordic kirke queries and locality combos', () => {
    const qs = expandPlaceQueries('Kaldfjord Church', 'Kvaløya')
    expect(qs).toContain('Kaldfjord kirke')
    expect(qs).toContain('Kaldfjord Church Kvaløya')
    expect(qs).toContain('Kaldfjord')
  })

  it('ranks Tromsø / Kvaløy church above Guernsey Church Lane', () => {
    const hints = localityHints(
      parseLocationFromOcr(`---eng---
Kaldfjord Church
距離：7,889,280mKvaløya
---jpn---
Kaldfjord Church
`),
    )
    expect(hints.some((h) => /Kval/i.test(h))).toBe(true)
    const region = regionBiasFromHints(hints)
    expect(region?.label).toBe('tromso')

    const guernsey = {
      displayName: 'Church Lane, St Peter Port, Guernsey',
      lat: 49.455,
      lng: -2.536,
      importance: 0.4,
      className: 'highway',
      typeName: 'residential',
    }
    const kvaloy = {
      displayName: 'Kvaløy kirke, Kaldfjord, Tromsø, Troms, Norge',
      lat: 69.6806,
      lng: 18.7442,
      importance: 0.35,
      className: 'amenity',
      typeName: 'place_of_worship',
    }
    const queries = expandPlaceQueries('Kaldfjord Church', 'Kvaløya')
    expect(
      scoreAgainstQueries(kvaloy, queries, hints, region),
    ).toBeGreaterThan(scoreAgainstQueries(guernsey, queries, hints, region))
  })

  it('does not boost Kyushu for unrelated Latin places', () => {
    expect(regionBiasFromHints(['Kaldfjord', 'Kvaløya'])?.label).not.toBe(
      'oita',
    )
    const plasyRegion = regionBiasFromHints(['Plasy'])
    const inPlasy = scoreGeocodeCandidate(
      {
        displayName: 'Klášter Plasy, Plasy, Česko',
        lat: 49.935,
        lng: 13.39,
        importance: 0.5,
        className: 'amenity',
        typeName: 'monastery',
      },
      'Klášter Plasy',
      ['Plasy'],
      plasyRegion,
    )
    const oitaHit = scoreGeocodeCandidate(
      {
        displayName: 'Somewhere, 大分県, Japan',
        lat: 33.2,
        lng: 131.6,
        importance: 0.5,
        className: 'place',
        typeName: 'city',
      },
      'Klášter Plasy',
      ['Plasy'],
      plasyRegion,
    )
    expect(inPlasy).toBeGreaterThan(oitaHit)
    expect(
      regionBiasFromHints(['Gemeentehuis', 'Oud-Turnhout'])?.label,
    ).not.toBe('oita')
  })

  it('marks Open-Meteo-style hits as locality precision', () => {
    expect(inferPrecision('place', 'locality')).toBe('locality')
    expect(inferPrecision('amenity', 'place_of_worship')).toBe('landmark')
    expect(inferPrecision('highway', 'residential')).toBe('street')
  })

  it('flags far-away candidates as suspicious', () => {
    const region = regionBiasFromHints(['Kaldfjord', 'Kvaløya', 'Tromsø'])
    const marked = markSuspicious(
      [
        {
          displayName: 'Kvaløy kirke, Tromsø, Norge',
          lat: 69.6806,
          lng: 18.7442,
          className: 'amenity',
          typeName: 'place_of_worship',
        },
        {
          displayName: 'Church Lane, Guernsey',
          lat: 49.455,
          lng: -2.536,
          className: 'highway',
          typeName: 'residential',
        },
      ],
      region,
      ['Kvaløya', 'Tromsø', 'Kaldfjord'],
    )
    expect(marked[0]?.suspicious).toBeFalsy()
    expect(marked[1]?.suspicious).toBe(true)
  })

  it('penalizes display_name that lacks parsed locality', () => {
    expect(
      localityConsistencyScore('Church Lane, Guernsey', [
        'Kvaløya',
        'Kaldfjord',
      ]),
    ).toBeLessThan(0)
    expect(
      localityConsistencyScore('Kvaløy kirke, Kaldfjord, Tromsø', [
        'Kvaløya',
        'Kaldfjord',
      ]),
    ).toBeGreaterThan(0)
  })
})

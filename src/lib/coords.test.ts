import { describe, expect, it } from 'vitest'
import { formatCoords, parseCoordsText } from './coords'
import { parseLocationFromOcr } from './parseLocation'

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
})

import { describe, expect, it } from 'vitest'
import {
  buildSyncPayload,
  parseSyncPayload,
  SYNC_FORMAT,
} from './sync'
import type { ArchiveItem } from '../types'

const sample = (id: string, updatedAt: number): ArchiveItem => ({
  id,
  createdAt: updatedAt,
  updatedAt,
  imageDataUrl: 'data:image/png;base64,aa',
  title: '滝神社',
  address: '佐伯市',
  coordsText: '33.041594, 131.919253',
  lat: 33.041594,
  lng: 131.919253,
  favorited: true,
  notes: '',
  ocrText: '',
})

describe('sync payload', () => {
  it('round-trips format', () => {
    const payload = buildSyncPayload([sample('a', 1)])
    expect(payload.format).toBe(SYNC_FORMAT)
    const again = parseSyncPayload(JSON.parse(JSON.stringify(payload)))
    expect(again.items).toHaveLength(1)
    expect(again.items[0]?.title).toBe('滝神社')
  })

  it('rejects foreign json', () => {
    expect(() => parseSyncPayload({ format: 'other', items: [] })).toThrow(
      /不是 Bloom Pin/,
    )
  })
})

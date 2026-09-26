import type { ArchiveItem } from '../types'
import { listArchive, saveArchiveItem } from './storage'

export const SYNC_FORMAT = 'bloom-pin-archive' as const
export const SYNC_VERSION = 1 as const

export type SyncPayload = {
  format: typeof SYNC_FORMAT
  version: typeof SYNC_VERSION
  exportedAt: number
  items: ArchiveItem[]
}

export function buildSyncPayload(items: ArchiveItem[]): SyncPayload {
  return {
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    exportedAt: Date.now(),
    items,
  }
}

export function parseSyncPayload(raw: unknown): SyncPayload {
  if (!raw || typeof raw !== 'object') {
    throw new Error('同步檔格式不正確')
  }
  const obj = raw as Record<string, unknown>
  if (obj.format !== SYNC_FORMAT) {
    throw new Error('這不是 Bloom Pin 同步檔')
  }
  if (!Array.isArray(obj.items)) {
    throw new Error('同步檔缺少 items')
  }
  return {
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    exportedAt: typeof obj.exportedAt === 'number' ? obj.exportedAt : Date.now(),
    items: obj.items as ArchiveItem[],
  }
}

/** Merge by id: keep the newer updatedAt; prefer favorited if equal. */
export async function mergeSyncPayload(
  payload: SyncPayload,
): Promise<{ added: number; updated: number; unchanged: number }> {
  const existing = await listArchive()
  const byId = new Map(existing.map((i) => [i.id, i]))
  let added = 0
  let updated = 0
  let unchanged = 0

  for (const incoming of payload.items) {
    if (!incoming?.id) continue
    const cur = byId.get(incoming.id)
    if (!cur) {
      await saveArchiveItem(incoming)
      added += 1
      continue
    }
    if (incoming.updatedAt > cur.updatedAt) {
      await saveArchiveItem(incoming)
      updated += 1
    } else if (
      incoming.updatedAt === cur.updatedAt &&
      incoming.favorited &&
      !cur.favorited
    ) {
      await saveArchiveItem({ ...cur, favorited: true })
      updated += 1
    } else {
      unchanged += 1
    }
  }

  return { added, updated, unchanged }
}

export async function exportSyncFile(): Promise<void> {
  const items = await listArchive()
  const payload = buildSyncPayload(items)
  const blob = new Blob([JSON.stringify(payload)], {
    type: 'application/json',
  })
  const name = `bloom-pin-sync-${new Date().toISOString().slice(0, 10)}.json`

  // Prefer Web Share with file when available (great on mobile)
  const file = new File([blob], name, { type: 'application/json' })
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean
    share?: (data: ShareData) => Promise<void>
  }
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({
        files: [file],
        title: 'Bloom Pin 同步檔',
        text: '匯入到另一台手機的 Bloom Pin，即可共用愛心歸檔',
      })
      return
    } catch (err) {
      // user cancelled or share failed → fall through to download
      if (err instanceof DOMException && err.name === 'AbortError') return
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export async function importSyncFile(file: File): Promise<{
  added: number
  updated: number
  unchanged: number
}> {
  const text = await file.text()
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('無法解析 JSON 同步檔')
  }
  const payload = parseSyncPayload(raw)
  return mergeSyncPayload(payload)
}

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { ArchiveItem } from '../types'

interface BloomPinDb extends DBSchema {
  archive: {
    key: string
    value: ArchiveItem
    indexes: { 'by-updated': number }
  }
}

const DB_NAME = 'bloom-pin'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<BloomPinDb>> | null = null

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<BloomPinDb>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore('archive', { keyPath: 'id' })
        store.createIndex('by-updated', 'updatedAt')
      },
    })
  }
  return dbPromise
}

export async function listArchive(): Promise<ArchiveItem[]> {
  const db = await getDb()
  const items = await db.getAllFromIndex('archive', 'by-updated')
  return items.reverse()
}

export async function getArchiveItem(id: string): Promise<ArchiveItem | undefined> {
  const db = await getDb()
  return db.get('archive', id)
}

export async function saveArchiveItem(item: ArchiveItem): Promise<void> {
  const db = await getDb()
  await db.put('archive', item)
}

export async function deleteArchiveItem(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('archive', id)
}

export function newId(): string {
  return crypto.randomUUID()
}

export function fileToDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

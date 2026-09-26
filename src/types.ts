export type GeocodeCandidate = {
  displayName: string
  lat: number
  lng: number
  importance?: number
}

export type ParsedLocation = {
  title: string | null
  address: string | null
  description: string | null
  searchQueries: string[]
  rawText: string
}

export type ArchiveItem = {
  id: string
  createdAt: number
  updatedAt: number
  /** Primary / first screenshot (kept for older sync files). */
  imageDataUrl: string
  /** All screenshots for this pin (postcard + map, etc.). */
  imageDataUrls?: string[]
  title: string
  address: string
  coordsText: string
  lat: number | null
  lng: number | null
  favorited: boolean
  notes: string
  ocrText: string
}

export type WorkItem = {
  imageDataUrls: string[]
  title: string
  address: string
  description: string
  coordsText: string
  lat: number | null
  lng: number | null
  ocrText: string
  candidates: GeocodeCandidate[]
  status: 'idle' | 'ocr' | 'geocode' | 'ready' | 'error'
  statusMessage: string
}

/** Normalize archive item images (legacy single + new multi). */
export function archiveImages(item: Pick<ArchiveItem, 'imageDataUrl' | 'imageDataUrls'>): string[] {
  if (item.imageDataUrls?.length) return item.imageDataUrls
  return item.imageDataUrl ? [item.imageDataUrl] : []
}

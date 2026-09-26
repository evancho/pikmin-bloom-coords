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
  imageDataUrl: string
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
  imageDataUrl: string
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

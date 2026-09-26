/** Format as "Latitude, Longitude" with up to 6 decimal places. */
export function formatCoords(lat: number, lng: number): string {
  return `${formatNum(lat)}, ${formatNum(lng)}`
}

function formatNum(n: number): string {
  return Number(n.toFixed(6)).toString()
}

export type CoordPair = {
  lat: number
  lng: number
}

const COORD_RE =
  /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/

export function parseCoordsText(text: string): CoordPair | null {
  const m = text.trim().match(COORD_RE)
  if (!m) return null
  const lat = Number(m[1])
  const lng = Number(m[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

export function isValidCoordsText(text: string): boolean {
  return parseCoordsText(text) !== null
}

/** Prefer Japan-range order when values look swapped. */
export function normalizeJapanish(pair: CoordPair): CoordPair {
  const { lat, lng } = pair
  const latLooksJp = lat >= 24 && lat <= 46
  const lngLooksJp = lng >= 122 && lng <= 154
  if (latLooksJp && lngLooksJp) return pair
  const swappedLatLooksJp = lng >= 24 && lng <= 46
  const swappedLngLooksJp = lat >= 122 && lat <= 154
  if (swappedLatLooksJp && swappedLngLooksJp) {
    return { lat: lng, lng: lat }
  }
  return pair
}

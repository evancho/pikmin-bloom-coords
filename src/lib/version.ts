/** Shown in UI and written to version.json at build time. */
export const APP_BUILD = 'v1.2.7-update'

export type RemoteVersion = {
  build: string
}

/** Fetch the deployed build id, bypassing HTTP + SW caches when possible. */
export async function fetchRemoteBuild(
  signal?: AbortSignal,
): Promise<string | null> {
  const base = import.meta.env.BASE_URL || '/'
  const url = `${base}version.json?t=${Date.now()}`
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal,
      headers: { 'Cache-Control': 'no-cache' },
    })
    if (!res.ok) return null
    const data = (await res.json()) as RemoteVersion
    return typeof data.build === 'string' ? data.build : null
  } catch {
    return null
  }
}

/** Drop service workers + Cache Storage so the next load gets Pages fresh. */
export async function hardRefreshFromServer(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.unregister()))
    }
  } catch {
    /* ignore */
  }
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    /* ignore */
  }
  const url = new URL(window.location.href)
  url.searchParams.set('_bp', String(Date.now()))
  window.location.replace(url.toString())
}

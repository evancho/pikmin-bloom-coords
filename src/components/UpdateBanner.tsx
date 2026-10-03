import { useCallback, useEffect, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { APP_BUILD, fetchRemoteBuild, hardRefreshFromServer } from '../lib/version'

const UPDATE_CHECK_MS = 5 * 60 * 1000

let updateChecksBound = false

/** iOS Safari often skips background SW checks; poll + focus re-check. */
function bindUpdateChecks(registration: ServiceWorkerRegistration) {
  if (updateChecksBound) return
  updateChecksBound = true
  const check = () => {
    void registration.update().catch(() => {})
  }
  // Immediate + short follow-up (GitHub Pages CDN max-age=600 on sw.js).
  check()
  window.setTimeout(check, 3_000)
  window.setTimeout(check, 15_000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
  window.addEventListener('focus', check)
  window.setInterval(check, UPDATE_CHECK_MS)
}

export function UpdateBanner() {
  const [updating, setUpdating] = useState(false)
  const [remoteBuild, setRemoteBuild] = useState<string | null>(null)
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swScriptUrl, registration) {
      if (!registration) return
      bindUpdateChecks(registration)
    },
  })

  const versionMismatch = Boolean(remoteBuild && remoteBuild !== APP_BUILD)
  const showBanner = needRefresh || versionMismatch

  const refreshRemote = useCallback(async () => {
    const build = await fetchRemoteBuild()
    setRemoteBuild(build)
    return build
  }, [])

  useEffect(() => {
    void refreshRemote()
    const id = window.setInterval(() => void refreshRemote(), UPDATE_CHECK_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshRemote()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [refreshRemote])

  useEffect(() => {
    if (!showBanner) return
    document.body.classList.add('has-update-banner')
    return () => {
      document.body.classList.remove('has-update-banner')
    }
  }, [showBanner])

  async function applyUpdate() {
    setUpdating(true)
    try {
      if (needRefresh) {
        await updateServiceWorker(true)
        // If SW activation stalls (common on iOS), hard-refresh as fallback.
        window.setTimeout(() => {
          void hardRefreshFromServer()
        }, 2_500)
      } else {
        await hardRefreshFromServer()
      }
    } catch {
      await hardRefreshFromServer()
    }
  }

  if (!showBanner) return null

  return (
    <div className="update-banner" id="update-banner" role="status">
      <span>
        有新版本可用
        {remoteBuild ? `（${remoteBuild}）` : ''}
      </span>
      <button
        type="button"
        className="btn"
        disabled={updating}
        onClick={() => {
          void applyUpdate()
        }}
      >
        重新載入
      </button>
    </div>
  )
}

/** Manual escape hatch when Safari SW update never prompts. */
export function CheckUpdateButton() {
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState('')

  return (
    <span className="check-update">
      <button
        type="button"
        className="linkish"
        disabled={checking}
        onClick={() => {
          void (async () => {
            setChecking(true)
            setMessage('')
            try {
              const regs = await navigator.serviceWorker?.getRegistrations()
              await Promise.all(
                (regs ?? []).map((r) => r.update().catch(() => {})),
              )
            } catch {
              /* ignore */
            }
            const build = await fetchRemoteBuild()
            if (!build) setMessage('無法檢查')
            else if (build === APP_BUILD) setMessage('已是最新')
            else {
              setMessage(`發現 ${build}`)
              // Automatically hard-refresh when remote is newer.
              await hardRefreshFromServer()
              return
            }
            setChecking(false)
            window.setTimeout(() => setMessage(''), 4_000)
          })()
        }}
      >
        {checking ? '檢查中…' : '檢查更新'}
      </button>
      {message ? <span className="check-update-msg">{message}</span> : null}
    </span>
  )
}

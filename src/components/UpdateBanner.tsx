import { useEffect, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

const UPDATE_CHECK_MS = 60 * 60 * 1000

let updateChecksBound = false

/** iOS home-screen PWAs often skip background update checks. */
function bindUpdateChecks(registration: ServiceWorkerRegistration) {
  if (updateChecksBound) return
  updateChecksBound = true
  const check = () => {
    void registration.update().catch(() => {})
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
  window.addEventListener('focus', check)
  window.setInterval(check, UPDATE_CHECK_MS)
}

export function UpdateBanner() {
  const [updating, setUpdating] = useState(false)
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swScriptUrl, registration) {
      if (!swScriptUrl || !registration) return
      bindUpdateChecks(registration)
    },
  })

  useEffect(() => {
    if (!needRefresh) return
    document.body.classList.add('has-update-banner')
    return () => {
      document.body.classList.remove('has-update-banner')
    }
  }, [needRefresh])

  if (!needRefresh) return null

  return (
    <div className="update-banner" id="update-banner" role="status">
      <span>有新版本可用</span>
      <button
        type="button"
        className="btn"
        disabled={updating}
        onClick={() => {
          setUpdating(true)
          // Activates the waiting worker; the plugin reloads after it controls the page.
          void updateServiceWorker(true)
        }}
      >
        重新載入
      </button>
    </div>
  )
}

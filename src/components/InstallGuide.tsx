import { useEffect, useMemo, useRef, useState } from 'react'

type Platform = 'ios' | 'android' | 'desktop'

function detectPlatform(): Platform {
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'desktop'
}

function isStandalone(): boolean {
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    nav.standalone === true
  )
}

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function InstallGuide({
  onExport,
  onImportFile,
  syncMessage,
}: {
  onExport: () => Promise<void>
  onImportFile: (file: File) => Promise<void>
  syncMessage: string
}) {
  const platform = useMemo(() => detectPlatform(), [])
  const [installed, setInstalled] = useState(false)
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  )
  const [open, setOpen] = useState(true)
  const importRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setInstalled(isStandalone())
    const onBip = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onBip)
    return () => window.removeEventListener('beforeinstallprompt', onBip)
  }, [])

  async function installAndroid() {
    if (!deferred) return
    await deferred.prompt()
    await deferred.userChoice
    setDeferred(null)
    setInstalled(isStandalone())
  }

  return (
    <section className="install-card rise">
      <button
        type="button"
        className="install-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>加到手機主畫面 · 同步喜好</span>
        <span aria-hidden>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="install-body">
          {installed ? (
            <p className="install-ok">已以 App 模式開啟（主畫面捷徑）。</p>
          ) : platform === 'ios' ? (
            <ol className="install-steps">
              <li>
                用 <strong>Safari</strong> 打開本頁（Chrome 無法加到主畫面）
              </li>
              <li>
                點底部分享鈕 <strong>分享</strong>
              </li>
              <li>
                選 <strong>加入主畫面</strong> → 新增
              </li>
            </ol>
          ) : platform === 'android' ? (
            <div className="install-steps-wrap">
              {deferred ? (
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => void installAndroid()}
                >
                  安裝 Bloom Pin
                </button>
              ) : (
                <ol className="install-steps">
                  <li>用 Chrome 打開本頁</li>
                  <li>
                    選單 ⋮ → <strong>安裝應用程式</strong>／加到主畫面
                  </li>
                </ol>
              )}
            </div>
          ) : (
            <p className="install-note">
              手機用瀏覽器打開同一個網址後，依系統提示「加到主畫面／安裝應用程式」。
            </p>
          )}

          <div className="sync-box">
            <h3>iPhone ↔ Android 共用愛心歸檔</h3>
            <p>
              兩邊都安裝後，用同一個同步檔互通喜好：匯出 → 存到 Google Drive／檔案
              App → 在另一台匯入（會合併，不會整份覆蓋）。
            </p>
            <div className="coord-actions">
              <button
                type="button"
                className="btn secondary"
                onClick={() => void onExport()}
              >
                匯出同步檔
              </button>
              <button
                type="button"
                className="btn ghost"
                onClick={() => importRef.current?.click()}
              >
                匯入同步檔
              </button>
              <input
                ref={importRef}
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void onImportFile(f)
                  e.target.value = ''
                }}
              />
            </div>
            {syncMessage && <p className="sync-msg">{syncMessage}</p>}
          </div>
        </div>
      )}
    </section>
  )
}

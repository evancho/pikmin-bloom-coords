import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { InstallGuide } from './components/InstallGuide'
import { UpdateBanner } from './components/UpdateBanner'
import { formatCoords, isValidCoordsText, parseCoordsText } from './lib/coords'
import { geocodeBest, googleMapsUrl, mapUrl } from './lib/geocode'
import { recognizeMany } from './lib/ocr'
import {
  localityHints,
  mergeParsedLocations,
  parseLocationFromOcr,
} from './lib/parseLocation'
import {
  deleteArchiveItem,
  fileToDataUrl,
  listArchive,
  newId,
  saveArchiveItem,
} from './lib/storage'
import { exportSyncFile, importSyncFile } from './lib/sync'
import type { ArchiveItem, GeocodeCandidate, WorkItem } from './types'
import { archiveImages } from './types'

type Tab = 'work' | 'archive'

/** App build shown in UI so iOS users can confirm they got the update. */
export const APP_BUILD = 'v1.2.1-latin-ocr'

const emptyWork = (): WorkItem => ({
  imageDataUrls: [],
  title: '',
  address: '',
  description: '',
  coordsText: '',
  lat: null,
  lng: null,
  ocrText: '',
  candidates: [],
  status: 'idle',
  statusMessage: '',
})

type ShotSlots = {
  postcard: File | null
  map: File | null
}

function slotsToFiles(slots: ShotSlots): File[] {
  return [slots.postcard, slots.map].filter((f): f is File => f != null)
}

export default function App() {
  const [tab, setTab] = useState<Tab>('work')
  const [work, setWork] = useState<WorkItem>(emptyWork)
  const [archive, setArchive] = useState<ArchiveItem[]>([])
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [heartBurst, setHeartBurst] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const [slots, setSlots] = useState<ShotSlots>({ postcard: null, map: null })
  const abortRef = useRef<AbortController | null>(null)
  const postcardInputRef = useRef<HTMLInputElement>(null)
  const mapInputRef = useRef<HTMLInputElement>(null)
  const slotsRef = useRef<ShotSlots>({ postcard: null, map: null })

  const refreshArchive = useCallback(async () => {
    setArchive(await listArchive())
  }, [])

  useEffect(() => {
    void refreshArchive()
  }, [refreshArchive])

  const runPipeline = useCallback(async (nextSlots: ShotSlots) => {
    const files = slotsToFiles(nextSlots)
    slotsRef.current = nextSlots
    setSlots(nextSlots)

    if (!files.length) {
      abortRef.current?.abort()
      setWork(emptyWork())
      setBusy(false)
      return
    }

    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setBusy(true)
    setTab('work')
    setCopied(false)

    const dataUrls = await Promise.all(files.map((f) => fileToDataUrl(f)))
    // Keep UI aligned with slots: postcard then map (empty slot omitted from urls list
    // but we also store parallel labeled previews via slotPreview below)
    setWork({
      ...emptyWork(),
      imageDataUrls: dataUrls,
      status: 'ocr',
      statusMessage:
        files.length > 1
          ? '正在辨識明信片＋地圖兩張截圖…'
          : nextSlots.map
            ? '正在辨識地圖截圖…'
            : '正在辨識明信片截圖…',
    })

    try {
      const texts = await recognizeMany(files)
      if (ac.signal.aborted) return

      const parts = texts.map((t) => parseLocationFromOcr(t))
      const parsed = mergeParsedLocations(parts)
      setWork((w) => ({
        ...w,
        title: parsed.title ?? '',
        address: parsed.address ?? '',
        description: parsed.description ?? '',
        ocrText: parsed.rawText,
        status: 'geocode',
        statusMessage: '正在查詢座標…',
      }))

      const { candidates } = await geocodeBest(
        parsed.searchQueries,
        ac.signal,
        localityHints(parsed),
      )
      if (ac.signal.aborted) return

      const best = candidates[0]
      setWork((w) => ({
        ...w,
        candidates,
        lat: best?.lat ?? null,
        lng: best?.lng ?? null,
        coordsText: best ? formatCoords(best.lat, best.lng) : '',
        status: 'ready',
        statusMessage: best
          ? `已用 ${files.length} 張截圖找到 ${candidates.length} 個候選，可編輯後歸檔`
          : '找不到自動座標，請手動輸入 緯度, 經度',
      }))
    } catch (err) {
      if (ac.signal.aborted) return
      const msg = err instanceof Error ? err.message : '處理失敗'
      setWork((w) => ({
        ...w,
        status: 'error',
        statusMessage: msg,
      }))
    } finally {
      if (!ac.signal.aborted) setBusy(false)
    }
  }, [])

  const assignSlot = useCallback(
    (which: keyof ShotSlots, file: File | null) => {
      const next = { ...slotsRef.current, [which]: file }
      void runPipeline(next)
    },
    [runPipeline],
  )

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const files: File[] = []
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) files.push(file)
        }
      }
      if (!files.length) return
      e.preventDefault()
      // Fill empty slots in order: postcard → map
      const next = { ...slotsRef.current }
      for (const f of files) {
        if (!next.postcard) next.postcard = f
        else if (!next.map) next.map = f
        else break
      }
      void runPipeline(next)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [runPipeline])

  const favoritedCount = useMemo(
    () => archive.filter((a) => a.favorited).length,
    [archive],
  )

  const mapPreview = useMemo(() => {
    if (!slots.map) return ''
    if (slots.postcard) return work.imageDataUrls[1] ?? ''
    return work.imageDataUrls[0] ?? ''
  }, [slots.postcard, slots.map, work.imageDataUrls])

  const postcardSrc = slots.postcard ? (work.imageDataUrls[0] ?? '') : ''

  function onCoordsChange(value: string) {
    const parsed = parseCoordsText(value)
    setWork((w) => ({
      ...w,
      coordsText: value,
      lat: parsed?.lat ?? null,
      lng: parsed?.lng ?? null,
    }))
  }

  function pickCandidate(c: GeocodeCandidate) {
    setWork((w) => ({
      ...w,
      lat: c.lat,
      lng: c.lng,
      coordsText: formatCoords(c.lat, c.lng),
      statusMessage: `已選：${c.displayName}`,
    }))
  }

  async function manualGeocode() {
    const q = [work.title, work.address].filter(Boolean).join(' ').trim()
    if (!q) {
      setWork((w) => ({
        ...w,
        statusMessage: '請先填地點名稱或地址',
      }))
      return
    }
    setBusy(true)
    setWork((w) => ({
      ...w,
      status: 'geocode',
      statusMessage: '重新查詢座標…',
    }))
    try {
      const queries = [
        q,
        `${work.title} ${work.address}`.trim(),
        `${work.title} 日本`,
        work.address,
      ].filter(Boolean)
      const { candidates } = await geocodeBest(
        queries,
        undefined,
        localityHints({
          title: work.title,
          address: work.address,
          description: work.description,
          searchQueries: queries,
          rawText: work.ocrText,
        }),
      )
      const best = candidates[0]
      setWork((w) => ({
        ...w,
        candidates,
        lat: best?.lat ?? w.lat,
        lng: best?.lng ?? w.lng,
        coordsText: best ? formatCoords(best.lat, best.lng) : w.coordsText,
        status: 'ready',
        statusMessage: best
          ? `已更新為 ${formatCoords(best.lat, best.lng)}`
          : '仍找不到，請手動輸入座標',
      }))
    } catch (err) {
      setWork((w) => ({
        ...w,
        status: 'error',
        statusMessage: err instanceof Error ? err.message : '查詢失敗',
      }))
    } finally {
      setBusy(false)
    }
  }

  async function saveToArchive(favorited: boolean) {
    if (!work.imageDataUrls.length) return
    if (work.coordsText && !isValidCoordsText(work.coordsText)) {
      setWork((w) => ({
        ...w,
        statusMessage: '座標格式需為：緯度, 經度（例如 34.700393, 137.783065）',
      }))
      return
    }
    const now = Date.now()
    const item: ArchiveItem = {
      id: newId(),
      createdAt: now,
      updatedAt: now,
      imageDataUrl: work.imageDataUrls[0]!,
      imageDataUrls: work.imageDataUrls,
      title: work.title || '未命名地點',
      address: work.address,
      coordsText: work.coordsText,
      lat: work.lat,
      lng: work.lng,
      favorited,
      notes: work.description,
      ocrText: work.ocrText,
    }
    await saveArchiveItem(item)
    await refreshArchive()
    if (favorited) {
      setHeartBurst(true)
      window.setTimeout(() => setHeartBurst(false), 450)
    }
    setWork((w) => ({
      ...w,
      statusMessage: favorited ? '已加入愛心歸檔' : '已儲存到歸檔',
    }))
  }

  async function copyCoords() {
    if (!work.coordsText) return
    await navigator.clipboard.writeText(work.coordsText.trim())
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  async function updateArchiveField(
    id: string,
    patch: Partial<ArchiveItem>,
  ) {
    const current = archive.find((a) => a.id === id)
    if (!current) return
    let next = { ...current, ...patch, updatedAt: Date.now() }
    if (patch.coordsText !== undefined) {
      const p = parseCoordsText(patch.coordsText)
      next = {
        ...next,
        lat: p?.lat ?? null,
        lng: p?.lng ?? null,
      }
    }
    await saveArchiveItem(next)
    await refreshArchive()
  }

  async function removeArchive(id: string) {
    await deleteArchiveItem(id)
    await refreshArchive()
  }

  async function handleExportSync() {
    try {
      await exportSyncFile()
      setSyncMessage('已匯出同步檔。請存到 Google Drive／檔案，再到另一台匯入。')
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : '匯出失敗')
    }
  }

  async function handleImportSync(file: File) {
    try {
      const r = await importSyncFile(file)
      await refreshArchive()
      setSyncMessage(
        `匯入完成：新增 ${r.added}、更新 ${r.updated}、略過 ${r.unchanged}`,
      )
      setTab('archive')
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : '匯入失敗')
    }
  }

  const hearts = archive.filter((a) => a.favorited)
  const others = archive.filter((a) => !a.favorited)
  const hasAnyShot = Boolean(slots.postcard || slots.map)

  return (
    <>
      <UpdateBanner />
      <div className="app">
      <header className="hero">
        <p className="eyebrow">Pikmin Bloom · {APP_BUILD}</p>
        <h1 className="brand">Bloom Pin</h1>
        <p className="tagline">
          分開選「明信片」與「地圖」兩張截圖（iPhone 適用），合併後找座標並愛心歸檔。
        </p>
      </header>

      <nav className="tabs" aria-label="主要分頁">
        <button
          type="button"
          className={tab === 'work' ? 'tab active' : 'tab'}
          onClick={() => setTab('work')}
        >
          辨識
        </button>
        <button
          type="button"
          className={tab === 'archive' ? 'tab active' : 'tab'}
          onClick={() => setTab('archive')}
        >
          歸檔{archive.length ? ` (${archive.length})` : ''}
        </button>
      </nav>

      <InstallGuide
        onExport={handleExportSync}
        onImportFile={handleImportSync}
        syncMessage={syncMessage}
      />

      {tab === 'work' ? (
        <main className="panel rise">
          <p className="slots-hint">
            iPhone 請各點一次選圖（不要依賴一次多選）。兩格都選完會自動合併辨識。
          </p>

          <div className={`slot-grid ${busy ? 'busy' : ''}`}>
            <input
              ref={postcardInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                assignSlot('postcard', f)
                e.target.value = ''
              }}
            />
            <input
              ref={mapInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                assignSlot('map', f)
                e.target.value = ''
              }}
            />

            <div
              className={`slot-card ${slots.postcard ? 'filled' : ''}`}
              role="button"
              tabIndex={busy ? -1 : 0}
              onClick={() => {
                if (!busy) postcardInputRef.current?.click()
              }}
              onKeyDown={(e) => {
                if (busy) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  postcardInputRef.current?.click()
                }
              }}
            >
              {postcardSrc ? (
                <img src={postcardSrc} alt="明信片截圖" />
              ) : (
                <span className="slot-empty">
                  <strong>① 明信片</strong>
                  <em>點這裡選詳情截圖</em>
                </span>
              )}
              <span className="slot-label">
                明信片
                {slots.postcard && (
                  <button
                    type="button"
                    className="shot-remove"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation()
                      assignSlot('postcard', null)
                    }}
                  >
                    清除
                  </button>
                )}
              </span>
            </div>

            <div
              className={`slot-card ${slots.map ? 'filled' : ''}`}
              role="button"
              tabIndex={busy ? -1 : 0}
              onClick={() => {
                if (!busy) mapInputRef.current?.click()
              }}
              onKeyDown={(e) => {
                if (busy) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  mapInputRef.current?.click()
                }
              }}
            >
              {mapPreview ? (
                <img src={mapPreview} alt="地圖截圖" />
              ) : (
                <span className="slot-empty">
                  <strong>② 地圖</strong>
                  <em>點這裡選地圖截圖</em>
                </span>
              )}
              <span className="slot-label">
                地圖
                {slots.map && (
                  <button
                    type="button"
                    className="shot-remove"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation()
                      assignSlot('map', null)
                    }}
                  >
                    清除
                  </button>
                )}
              </span>
            </div>
          </div>

          {work.status !== 'idle' && (
            <p className={`status ${work.status}`} aria-live="polite">
              {busy && <span className="dot" />}
              {work.statusMessage}
            </p>
          )}

          {hasAnyShot && (
            <section className="editor rise">
              <label className="field">
                <span>地點名稱</span>
                <input
                  value={work.title}
                  onChange={(e) =>
                    setWork((w) => ({ ...w, title: e.target.value }))
                  }
                  placeholder="例如：滝神社"
                />
              </label>
              <label className="field">
                <span>地址／區域</span>
                <input
                  value={work.address}
                  onChange={(e) =>
                    setWork((w) => ({ ...w, address: e.target.value }))
                  }
                  placeholder="例如：佐伯市 上浦大字浅海井浦"
                />
              </label>

              <div className="coord-block">
                <label className="field">
                  <span>座標（緯度, 經度）</span>
                  <input
                    className={
                      work.coordsText && !isValidCoordsText(work.coordsText)
                        ? 'invalid'
                        : ''
                    }
                    value={work.coordsText}
                    onChange={(e) => onCoordsChange(e.target.value)}
                    placeholder="34.700393, 137.783065"
                    spellCheck={false}
                  />
                </label>
                <div className="coord-actions">
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={
                      !work.coordsText || !isValidCoordsText(work.coordsText)
                    }
                    onClick={() => void copyCoords()}
                  >
                    {copied ? '已複製' : '複製座標'}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    onClick={() => void manualGeocode()}
                  >
                    依名稱重查
                  </button>
                  {work.lat != null && work.lng != null && (
                    <>
                      <a
                        className="btn ghost linkish"
                        href={mapUrl(work.lat, work.lng)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        OSM
                      </a>
                      <a
                        className="btn ghost linkish"
                        href={googleMapsUrl(work.lat, work.lng)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Google
                      </a>
                    </>
                  )}
                </div>
              </div>

              {work.candidates.length > 0 && (
                <div className="candidates">
                  <h2>候選位置</h2>
                  <ul>
                    {work.candidates.map((c) => (
                      <li key={`${c.lat},${c.lng}`}>
                        <button type="button" onClick={() => pickCandidate(c)}>
                          <strong>{formatCoords(c.lat, c.lng)}</strong>
                          <span>{c.displayName}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {work.ocrText && (
                <details className="ocr-raw">
                  <summary>OCR 原文（各張合併）</summary>
                  <pre>{work.ocrText}</pre>
                </details>
              )}

              <div className="save-row">
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy || !work.imageDataUrls.length}
                  onClick={() => void saveToArchive(false)}
                >
                  儲存歸檔
                </button>
                <button
                  type="button"
                  className={`btn heart ${heartBurst ? 'burst' : ''}`}
                  disabled={busy || !work.imageDataUrls.length}
                  onClick={() => void saveToArchive(true)}
                  aria-label="愛心歸檔"
                >
                  ♥ 愛心歸檔
                </button>
              </div>
            </section>
          )}
        </main>
      ) : (
        <main className="panel archive rise">
          {archive.length === 0 ? (
            <p className="empty">還沒有歸檔。辨識截圖後按愛心或儲存即可。</p>
          ) : (
            <>
              {hearts.length > 0 && (
                <section>
                  <h2 className="section-title">♥ 愛心</h2>
                  <div className="cards">
                    {hearts.map((item) => (
                      <ArchiveCard
                        key={item.id}
                        item={item}
                        onChange={updateArchiveField}
                        onDelete={removeArchive}
                      />
                    ))}
                  </div>
                </section>
              )}
              {others.length > 0 && (
                <section>
                  <h2 className="section-title">全部歸檔</h2>
                  <div className="cards">
                    {others.map((item) => (
                      <ArchiveCard
                        key={item.id}
                        item={item}
                        onChange={updateArchiveField}
                        onDelete={removeArchive}
                      />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
          <p className="hint-foot">
            本機歸檔（IndexedDB）。要跨 iPhone／Android 請用上方「匯出／匯入同步檔」。愛心數：
            {favoritedCount}
          </p>
        </main>
      )}
      </div>
    </>
  )
}

function ArchiveCard({
  item,
  onChange,
  onDelete,
}: {
  item: ArchiveItem
  onChange: (id: string, patch: Partial<ArchiveItem>) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [coords, setCoords] = useState(item.coordsText)
  const [shot, setShot] = useState(0)
  const valid = !coords || isValidCoordsText(coords)
  const images = archiveImages(item)

  useEffect(() => {
    setCoords(item.coordsText)
    setShot(0)
  }, [item.coordsText, item.id])

  return (
    <article className="card">
      <div className="card-shots">
        <img src={images[shot] ?? item.imageDataUrl} alt={item.title} />
        {images.length > 1 && (
          <div className="card-shot-dots">
            {images.map((_, i) => (
              <button
                key={i}
                type="button"
                className={i === shot ? 'on' : ''}
                aria-label={`顯示截圖 ${i + 1}`}
                onClick={() => setShot(i)}
              />
            ))}
          </div>
        )}
      </div>
      <div className="card-body">
        <div className="card-top">
          <input
            className="title-input"
            value={item.title}
            onChange={(e) => void onChange(item.id, { title: e.target.value })}
          />
          <button
            type="button"
            className={`icon-heart ${item.favorited ? 'on' : ''}`}
            aria-label={item.favorited ? '取消愛心' : '加愛心'}
            onClick={() =>
              void onChange(item.id, { favorited: !item.favorited })
            }
          >
            ♥
          </button>
        </div>
        <input
          className="addr-input"
          value={item.address}
          placeholder="地址"
          onChange={(e) => void onChange(item.id, { address: e.target.value })}
        />
        <label className="field compact">
          <span>座標</span>
          <input
            className={valid ? '' : 'invalid'}
            value={coords}
            onChange={(e) => setCoords(e.target.value)}
            onBlur={() => {
              if (coords !== item.coordsText && valid) {
                void onChange(item.id, { coordsText: coords })
              }
            }}
            placeholder="34.700393, 137.783065"
            spellCheck={false}
          />
        </label>
        <div className="card-actions">
          {item.lat != null && item.lng != null && (
            <a
              href={googleMapsUrl(item.lat, item.lng)}
              target="_blank"
              rel="noreferrer"
            >
              在地圖開啟
            </a>
          )}
          <button
            type="button"
            className="danger"
            onClick={() => {
              if (confirm('刪除此歸檔？')) void onDelete(item.id)
            }}
          >
            刪除
          </button>
        </div>
      </div>
    </article>
  )
}

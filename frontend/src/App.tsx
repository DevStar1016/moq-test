import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Ad = {
  id: string
  title: string
  original_filename: string
  storage_path: string
  url: string
  size_bytes: number
  created_at_ms: number
}

const UploadIcon = () => (
  <svg className="btnIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
)
const RefreshIcon = () => (
  <svg className="btnIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
  </svg>
)
const VideoIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="23 7 16 12 23 17 23 7" />
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
  </svg>
)
const PlayCircle = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none" />
  </svg>
)
const EyeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)
const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4h6v2" />
  </svg>
)

const ADStormBadge = () => (
  <span className="adstormBadge">
    <span className="adstormAd">AD</span>
    <span className="adstormText">St</span>
    <span className="adstormAccent">o</span>
    <span className="adstormText">rm</span>
  </span>
)

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function App() {
  const inputRef = useRef<HTMLInputElement | null>(null)

  const [uploading, setUploading]       = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [lastUploaded, setLastUploaded] = useState<Ad | null>(null)
  const [previewAd, setPreviewAd]       = useState<Ad | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Ad | null>(null)
  const [deletingId, setDeletingId]     = useState<string | null>(null)

  const [ads, setAds]               = useState<Ad[]>([])
  const [loadingAds, setLoadingAds] = useState(false)

  const [moqReady, setMoqReady]   = useState(false)
  const [moqError, setMoqError]   = useState<string | null>(null)
  const [moqUrl, setMoqUrl]       = useState('https://relay.example.com/anon')
  const [moqName, setMoqName]     = useState('room/alice')
  const moqInitOnce               = useRef(false)

  const totalBytes = useMemo(
    () => ads.reduce((sum, i) => sum + (i.size_bytes || 0), 0),
    [ads],
  )

  useEffect(() => {
    if (moqInitOnce.current) return
    moqInitOnce.current = true
    ;(async () => {
      try {
        setMoqError(null)
        const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<unknown>
        await dynamicImport('https://cdn.jsdelivr.net/npm/@moq/watch/element.js/+esm')
        await dynamicImport('https://cdn.jsdelivr.net/npm/@moq/watch/ui/index.js/+esm')
        setMoqReady(true)
      } catch (e) {
        setMoqError(e instanceof Error ? e.message : 'Failed to load MoQ player')
        setMoqReady(false)
      }
    })()
  }, [])

  async function refreshAds() {
    setLoadingAds(true)
    setError(null)
    try {
      const r = await fetch('/api/ads')
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`)
      setAds((await r.json()) as Ad[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load ads')
    } finally {
      setLoadingAds(false)
    }
  }

  async function uploadSelectedFile(file: File) {
    setUploading(true)
    setError(null)
    setLastUploaded(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r    = await fetch('/api/ads', { method: 'POST', body: fd })
      const data = (await r.json()) as { error?: string } & Partial<Ad>
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setLastUploaded(data as Ad)
      if (inputRef.current) inputRef.current.value = ''
      void refreshAds()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function confirmDeleteAd(ad: Ad) {
    setDeletingId(ad.id)
    setError(null)
    try {
      const r = await fetch(`/api/ads/${encodeURIComponent(ad.id)}`, { method: 'DELETE' })
      if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`)
      if (previewAd?.id === ad.id) setPreviewAd(null)
      setDeleteTarget(null)
      void refreshAds()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete ad')
    } finally {
      setDeletingId(null)
    }
  }

  useEffect(() => { void refreshAds() }, [])

  const moqBadgeClass = moqReady ? 'ready' : moqError ? 'failed' : 'loading'
  const moqBadgeText  = moqReady ? 'Ready' : moqError ? 'Failed' : 'Loading…'

  return (
    <div className="page">

      <header className="header">
        <div className="headerBrand">
          <ADStormBadge />
          <div className="headerDivider" />
          <div>
            <div className="title">Ads MP4 Manager</div>
            <div className="subtitle">Upload MP4 ads &amp; monitor live streams</div>
          </div>
        </div>
        <div className="headerMeta" aria-label="Upload summary">
          <div className="pill">
            <span className="pillLabel">Ads</span>
            <span className="pillValue">{ads.length}</span>
          </div>
          <div className="pill">
            <span className="pillLabel">Storage</span>
            <span className="pillValue">
              {(totalBytes / 1024 / 1024).toFixed(totalBytes === 0 ? 0 : 2)} MB
            </span>
          </div>
        </div>
      </header>

      {error && (
        <section className="card" aria-label="Error">
          <div className="alert">{error}</div>
        </section>
      )}

      <section className="card moqMain" aria-label="MoQ player">
        <div className="cardHeader">
          <h2 className="cardTitle">
            <span className={`statusDot ${moqReady ? 'blue' : 'orange'}`} />
            MoQ Player
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <ADStormBadge />
            <span className={`cardBadge ${moqBadgeClass}`}>{moqBadgeText}</span>
          </div>
        </div>

        {moqError && <div className="alert" style={{ marginBottom: 14 }}>{moqError}</div>}

        <div className="formRow">
          <div className="fieldGroup">
            <label className="label">Relay URL</label>
            <input
              className="input"
              value={moqUrl}
              onChange={(e) => setMoqUrl(e.currentTarget.value)}
              placeholder="https://relay.example.com/anon"
            />
          </div>
          <div className="fieldGroup">
            <label className="label">Broadcast name</label>
            <input
              className="input"
              value={moqName}
              onChange={(e) => setMoqName(e.currentTarget.value)}
              placeholder="room/alice"
            />
          </div>
        </div>

        <div className=" moqBoxMain" aria-label="MoQ player container">
          {moqReady ? (
            createElement(
              'moq-watch-ui', null,
              createElement(
                'moq-watch',
                { url: moqUrl, name: moqName },
                createElement('canvas', { className: 'moqCanvas' }),
              ),
            )
          ) : (
            <div className="empty">
              <div className="emptyIcon"><PlayCircle /></div>
              <p className="emptyTitle">No Stream URL</p>
              <p className="emptySubtitle">Enter a relay URL above to start playback</p>
            </div>
          )}
        </div>
      </section>


      <section className="card" aria-label="Ads list">

        <div className="cardHeader">
          <h2 className="cardTitle">
            <span className="statusDot blue" />
            Ads Library
          </h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className={`cardBadge ${ads.length ? 'ready' : 'loading'}`}>
              {ads.length} file{ads.length !== 1 ? 's' : ''}
            </span>
            <div className="actions">
              <input
                ref={inputRef}
                className="fileInput"
                type="file"
                accept="video/mp4,.mp4"
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0]
                  if (f) void uploadSelectedFile(f)
                }}
              />
              <button
                type="button"
                className="button upload"
                onClick={() => inputRef.current?.click()}
                disabled={uploading}
              >
                <UploadIcon />
                {uploading ? 'Uploading…' : 'Upload MP4'}
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => void refreshAds()}
                disabled={loadingAds}
              >
                <RefreshIcon />
                {loadingAds ? 'Loading…' : 'Refresh'}
              </button>
            </div>
          </div>
        </div>

        {lastUploaded && (
          <div className="success" style={{ marginBottom: 14 }}>
            <div className="successTitle">✓ Uploaded successfully</div>
            <div className="successMeta">{lastUploaded.title}</div>
          </div>
        )}

        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 36 }}></th>
                <th>Ad name</th>
                <th>Size</th>
                <th>Created at</th>
                <th className="tableActions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {ads.length === 0 ? (
                <tr>
                  <td className="tableEmptyCell" colSpan={5}>
                    <div className="empty emptyInTable">
                      <div className="emptyIcon"><VideoIcon /></div>
                      <p className="emptyTitle">No ads yet</p>
                      <p className="emptySubtitle">Upload an MP4 to see it here.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                ads.map((a, idx) => (
                  <tr key={a.id}>
                    <td className="tableIndex">{idx + 1}</td>
                    <td className="tableName" title={a.title}>
                      <div className="tableNameInner">
                        <span className="tableNameDot" />
                        {a.title}
                      </div>
                    </td>
                    <td className="tableSize">
                      <span className="sizePill">{formatBytes(a.size_bytes)}</span>
                    </td>
                    <td className="tableCreated">{new Date(a.created_at_ms).toLocaleString()}</td>
                    <td className="tableActions">
                      <div className="actionGroup">
                        <button
                          type="button"
                          className="iconButton iconButtonView"
                          title="Preview"
                          onClick={() => setPreviewAd(a)}
                        >
                          <EyeIcon />
                        </button>
                        <a
                          className="iconButton iconButtonDownload"
                          href={a.url}
                          download={a.original_filename}
                          title="Download"
                        >
                          <DownloadIcon />
                        </a>
                        <button
                          type="button"
                          className="iconButton iconButtonDelete"
                          title="Delete"
                          onClick={() => setDeleteTarget(a)}
                          disabled={deletingId === a.id}
                        >
                          {deletingId === a.id
                            ? <span className="deleteSpinner" />
                            : <TrashIcon />
                          }
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {previewAd && (
        <div
          className="modalBackdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Ad preview"
          onClick={() => setPreviewAd(null)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">{previewAd.title}</div>
              <button type="button" className="linkButton" onClick={() => setPreviewAd(null)}>
                Close
              </button>
            </div>
            <video className="video" controls src={previewAd.url} />
            <div className="meta">
              <div><strong>File</strong>: {previewAd.original_filename}</div>
              <div><strong>Size</strong>: {formatBytes(previewAd.size_bytes)}</div>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div
          className="modalBackdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Delete ad"
          onClick={() => setDeleteTarget(null)}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div className="modalTitle">Delete ad</div>
              <button type="button" className="linkButton" onClick={() => setDeleteTarget(null)}>
                Close
              </button>
            </div>
            <div className="meta">
              <div>This will permanently delete the file from disk.</div>
              <div style={{ marginTop: 8 }}>
                <strong>{deleteTarget.title}</strong>
              </div>
            </div>
            <div className="modalActions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDeleteTarget(null)}
                disabled={deletingId === deleteTarget.id}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button upload"
                onClick={() => void confirmDeleteAd(deleteTarget)}
                disabled={deletingId === deleteTarget.id}
              >
                {deletingId === deleteTarget.id ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

export default App
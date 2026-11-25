import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PdfError, type OutlineItem, type SearchHit } from './engine/pdfium'
import { EngineClient, type DocHandle } from './viewer/client'
import { Organize } from './viewer/Organize'
import { PageCanvas } from './viewer/PageCanvas'
import type { Edit } from './viewer/protocol'
import { saveCopy } from './viewer/platform'
import { printDocument } from './viewer/print'

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const THUMB_WIDTH = 120
const PAGE_GAP = 16

type Fit = 'width' | 'page' | null

function describeError(err: unknown): string {
  if (err instanceof PdfError) {
    switch (err.code) {
      case 'format':
      case 'file':
        return 'This file is damaged or is not a PDF.'
      case 'crash':
        return 'The PDF engine hit an internal error on this file. It has been restarted; please try another file.'
      default:
        return err.message
    }
  }
  return err instanceof Error ? err.message : String(err)
}

export default function App() {
  const [engine] = useState(() => new EngineClient())
  const [doc, setDoc] = useState<DocHandle | null>(null)
  const [locked, setLocked] = useState<{ name: string; bytes: Uint8Array; wrong: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState<Fit>('width')
  const [currentPage, setCurrentPage] = useState(0)
  const [sidebar, setSidebar] = useState<'pages' | 'outline'>('pages')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [activeHit, setActiveHit] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [mode, setMode] = useState<'view' | 'organize'>('view')
  /** doc.version at the last open or save; anything newer is unsaved. */
  const [savedVersion, setSavedVersion] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const searchBox = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  // Close the old document when another file replaces it or the app unmounts.
  // Edits hand back a new handle for the same document, which must stay open.
  const docId = doc?.id
  const docRef = useRef(doc)
  docRef.current = doc
  useEffect(() => {
    const opened = docRef.current
    return () => opened?.close()
  }, [docId])

  const dirty = !!doc && doc.version !== savedVersion

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const handleEngineError = useCallback((err: unknown) => {
    setError(describeError(err))
    // The worker restarts PDFium by itself after a crash; the open document is gone.
    if (err instanceof PdfError && err.code === 'crash') setDoc(null)
  }, [])

  const openBytes = useCallback(
    async (name: string, bytes: Uint8Array, password = '') => {
      setBusy('Opening…')
      try {
        const next = await engine.open(bytes, password)
        setError(null)
        setLocked(null)
        setFile({ name, bytes })
        setDoc(next)
        setSavedVersion(next.version)
        setHits([])
        setQuery('')
        setCurrentPage(0)
        setFit('width')
        scroller.current?.scrollTo({ top: 0 })
      } catch (err) {
        if (err instanceof PdfError && err.code === 'password') setLocked({ name, bytes, wrong: password !== '' })
        else handleEngineError(err)
      } finally {
        setBusy(null)
      }
    },
    [engine, handleEngineError],
  )

  const openFile = useCallback(
    async (f: File) => openBytes(f.name, new Uint8Array(await f.arrayBuffer())),
    [openBytes],
  )

  const outline: OutlineItem[] = doc?.outline ?? []

  // Fit modes recompute the zoom from the widest page and the scroller size.
  useEffect(() => {
    const el = scroller.current
    if (!doc || !fit || !el) return
    const apply = () => {
      const first = doc.sizes[0]
      if (!first) return
      const availW = el.clientWidth - 2 * PAGE_GAP
      const availH = el.clientHeight - 2 * PAGE_GAP
      const z = fit === 'width' ? availW / first.width : Math.min(availW / first.width, availH / first.height)
      setZoom(Math.max(0.1, Math.min(4, z)))
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [doc, fit])

  const scrollToPage = useCallback((pageIndex: number) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${pageIndex}"]`)
    el?.scrollIntoView({ block: 'start' })
  }, [])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const pages = el.querySelectorAll<HTMLElement>('.page')
    const mid = el.scrollTop + el.clientHeight / 3
    let found = 0
    for (const p of pages) {
      if (p.offsetTop <= mid) found = Number(p.dataset.page)
      else break
    }
    setCurrentPage(found)
  }, [])

  const stepZoom = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > zoom + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001)
    if (next) {
      setFit(null)
      setZoom(next)
    }
  }

  const runSearch = async (q: string) => {
    if (!doc) return
    setBusy('Searching…')
    try {
      const found = q.trim() ? await doc.search(q.trim()) : []
      setHits(found)
      setActiveHit(0)
      if (found[0]) scrollToPage(found[0].pageIndex)
    } catch (err) {
      handleEngineError(err)
    } finally {
      setBusy(null)
    }
  }

  const gotoHit = (dir: 1 | -1) => {
    if (!hits.length) return
    const next = (activeHit + dir + hits.length) % hits.length
    setActiveHit(next)
    scrollToPage(hits[next].pageIndex)
  }

  const applyEdit = useCallback(
    async (edit: Edit) => {
      if (!doc) throw new Error('No document is open')
      const next = await doc.edit(edit)
      setDoc(next)
      setHits([])
      return next
    },
    [doc],
  )

  const undo = async () => {
    if (!doc || doc.undoDepth === 0 || busy) return
    try {
      setDoc(await doc.undo())
      setHits([])
    } catch (err) {
      handleEngineError(err)
    }
  }

  const saveFile = useCallback(
    (name: string, bytes: Uint8Array) => saveCopy(name, bytes),
    [],
  )

  const download = async () => {
    if (!file || !doc) return
    try {
      if (!dirty) return await saveCopy(file.name, file.bytes)
      setBusy('Saving…')
      const version = doc.version
      if (await saveCopy(file.name, await doc.save())) setSavedVersion(version)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(null)
    }
  }

  const print = async () => {
    if (!doc || busy) return
    try {
      await printDocument(doc, (done, total) => setBusy(`Preparing page ${done} of ${total} for printing…`))
    } catch (err) {
      handleEngineError(err)
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key === 'f' && doc) {
        e.preventDefault()
        searchBox.current?.focus()
        searchBox.current?.select()
      } else if (mod && e.key === 'p' && doc) {
        e.preventDefault()
        void print()
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && doc) {
        if ((e.target as HTMLElement).tagName === 'INPUT') return
        e.preventDefault()
        void undo()
      } else if (mod && e.key === 's' && doc) {
        e.preventDefault()
        void download()
      } else if (mod && e.key === 'o') {
        e.preventDefault()
        fileInput.current?.click()
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        stepZoom(1)
      } else if (mod && e.key === '-') {
        e.preventDefault()
        stepZoom(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const hitsByPage = useMemo(() => {
    const map = new Map<number, SearchHit[]>()
    for (const h of hits) map.set(h.pageIndex, [...(map.get(h.pageIndex) ?? []), h])
    return map
  }, [hits])

  const pages = doc ? Array.from({ length: doc.pageCount }, (_, i) => i) : []
  const current = hits[activeHit]

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer.files[0]
        if (f) void openFile(f)
      }}
    >
      <header className="toolbar">
        <strong className="brand">PDF Pro</strong>
        <button onClick={() => fileInput.current?.click()}>Open</button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void openFile(f)
            e.target.value = ''
          }}
        />
        <button onClick={() => void download()} disabled={!file || !!busy}>
          Save a copy
        </button>
        <button onClick={() => void print()} disabled={!doc || !!busy}>
          Print
        </button>
        <span className="filename" title={file?.name}>
          {file?.name}
          {dirty && <span className="dirty"> · edited</span>}
        </span>
        {doc && (
          <span className="modes" role="tablist">
            <button role="tab" aria-selected={mode === 'view'} onClick={() => setMode('view')}>
              Read
            </button>
            <button role="tab" aria-selected={mode === 'organize'} onClick={() => setMode('organize')}>
              Organize pages
            </button>
            <button onClick={() => void undo()} disabled={!doc.undoDepth || !!busy} title="Undo (Ctrl+Z)">
              Undo
            </button>
          </span>
        )}
        {doc && mode === 'view' && (
          <>
            <span className="pager">
              Page{' '}
              <input
                aria-label="Page number"
                key={currentPage}
                defaultValue={currentPage + 1}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  const n = Number((e.target as HTMLInputElement).value)
                  if (n >= 1 && n <= doc.pageCount) scrollToPage(n - 1)
                }}
              />{' '}
              of {doc.pageCount}
            </span>
            <span className="zoom">
              <button onClick={() => stepZoom(-1)} aria-label="Zoom out">
                −
              </button>
              <span className="zoom-value">{Math.round(zoom * 100)}%</span>
              <button onClick={() => stepZoom(1)} aria-label="Zoom in">
                +
              </button>
              <button className={fit === 'width' ? 'on' : ''} onClick={() => setFit('width')}>
                Fit width
              </button>
              <button className={fit === 'page' ? 'on' : ''} onClick={() => setFit('page')}>
                Fit page
              </button>
            </span>
            <span className="search">
              <input
                ref={searchBox}
                type="search"
                placeholder="Find in document"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  if (hits.length && query.trim() === (e.currentTarget.dataset.last ?? '')) gotoHit(e.shiftKey ? -1 : 1)
                  else {
                    e.currentTarget.dataset.last = query.trim()
                    void runSearch(query)
                  }
                }}
              />
              {hits.length > 0 && (
                <>
                  <span className="count">
                    {activeHit + 1} of {hits.length >= 1000 ? '1000+' : hits.length}
                  </span>
                  <button onClick={() => gotoHit(-1)} aria-label="Previous match">
                    ↑
                  </button>
                  <button onClick={() => gotoHit(1)} aria-label="Next match">
                    ↓
                  </button>
                </>
              )}
            </span>
          </>
        )}
      </header>

      {busy && (
        <div className="status" role="status">
          {busy}
        </div>
      )}

      {locked && (
        <form
          className="unlock"
          onSubmit={(e) => {
            e.preventDefault()
            const pw = new FormData(e.currentTarget).get('password')
            void openBytes(locked.name, locked.bytes, String(pw ?? ''))
          }}
        >
          <label>
            {locked.wrong ? 'Wrong password. Try again' : `“${locked.name}” is password-protected`}:{' '}
            <input name="password" type="password" autoFocus autoComplete="off" aria-invalid={locked.wrong} />
          </label>
          <button type="submit">Open</button>
          <button type="button" onClick={() => setLocked(null)}>
            Cancel
          </button>
        </form>
      )}

      {error && (
        <div className="error" role="alert">
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {doc && mode === 'organize' && (
        <Organize
          doc={doc}
          onEdit={applyEdit}
          onSaveFile={saveFile}
          baseName={(file?.name ?? 'document').replace(/\.pdf$/i, '')}
          onError={handleEngineError}
          onOpenPage={(i) => {
            setMode('view')
            requestAnimationFrame(() => scrollToPage(i))
          }}
        />
      )}

      <div className="body" hidden={mode === 'organize' && !!doc}>
        {doc && (
          <aside className="sidebar">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={sidebar === 'pages'} onClick={() => setSidebar('pages')}>
                Pages
              </button>
              <button
                role="tab"
                aria-selected={sidebar === 'outline'}
                onClick={() => setSidebar('outline')}
                disabled={outline.length === 0}
              >
                Bookmarks
              </button>
            </div>
            {sidebar === 'pages' ? (
              <div className="thumbs">
                {pages.map((i) => (
                  <button key={i} className={i === currentPage ? 'thumb on' : 'thumb'} onClick={() => scrollToPage(i)}>
                    <PageCanvas
                      doc={doc}
                      pageIndex={i}
                      zoom={THUMB_WIDTH / doc.sizes[i].width}
                      className="thumb-page"
                      onError={handleEngineError}
                    />
                    <span>{i + 1}</span>
                  </button>
                ))}
              </div>
            ) : (
              <Outline items={outline} onPick={scrollToPage} />
            )}
          </aside>
        )}

        <main ref={scroller} className="pages" onScroll={onScroll}>
          {!doc && (
            <div className={dragging ? 'empty drag' : 'empty'}>
              <p>Drop a PDF here, or</p>
              <button onClick={() => fileInput.current?.click()}>Open a PDF</button>
              <p className="hint">Files stay on your device. Nothing is uploaded.</p>
            </div>
          )}
          {doc &&
            pages.map((i) => (
              <PageCanvas
                key={i}
                doc={doc}
                pageIndex={i}
                zoom={zoom}
                className="page"
                highlights={hitsByPage.get(i)?.filter((h) => h !== current).flatMap((h) => h.rects)}
                activeHighlight={current?.pageIndex === i ? current.rects : undefined}
                onError={handleEngineError}
              />
            ))}
        </main>
      </div>
    </div>
  )
}

function Outline({ items, onPick }: { items: OutlineItem[]; onPick: (page: number) => void }) {
  return (
    <ul className="outline">
      {items.map((item, i) => (
        <li key={i}>
          <button disabled={item.pageIndex === null} onClick={() => item.pageIndex !== null && onPick(item.pageIndex)}>
            {item.title || 'Untitled'}
          </button>
          {item.children.length > 0 && <Outline items={item.children} onPick={onPick} />}
        </li>
      ))}
    </ul>
  )
}

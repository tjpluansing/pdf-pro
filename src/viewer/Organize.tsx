import { useEffect, useRef, useState } from 'react'
import { PdfError } from '../engine/pdfium'
import type { DocHandle } from './client'
import { PageCanvas } from './PageCanvas'
import type { Edit } from './protocol'

const THUMB_WIDTH = 150

interface Props {
  doc: DocHandle
  /** Applies an edit and swaps in the new handle, which it also returns. */
  onEdit: (edit: Edit) => Promise<DocHandle>
  /** Saves bytes as a new file the user names. */
  onSaveFile: (name: string, bytes: Uint8Array) => Promise<unknown>
  baseName: string
  onError: (err: unknown) => void
  onOpenPage: (pageIndex: number) => void
}

/** Pages chosen by the source file, waiting for its password before they are inserted. */
interface PendingInsert {
  name: string
  bytes: Uint8Array
  at: number
  wrong: boolean
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

/**
 * Page grid for rotating, deleting, reordering, inserting, extracting and
 * splitting pages. Every change goes through the engine and can be undone.
 */
export function Organize({ doc, onEdit, onSaveFile, baseName, onError, onOpenPage }: Props) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [dragging, setDragging] = useState<number[] | null>(null)
  const [splitOpen, setSplitOpen] = useState(false)
  const [splitEvery, setSplitEvery] = useState(1)
  const [pending, setPending] = useState<PendingInsert | null>(null)
  const [working, setWorking] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  // Several files inserted in a row each need the handle the previous one produced.
  const latest = useRef(doc)
  latest.current = doc

  // An undo can put any page anywhere, so a selection by index no longer means the same pages.
  const depth = useRef(doc.undoDepth)
  useEffect(() => {
    if (doc.undoDepth < depth.current) setSelected(new Set())
    depth.current = doc.undoDepth
  }, [doc.undoDepth])

  // Drop selections that point past the end after pages are removed.
  useEffect(() => {
    setSelected((s) => {
      const kept = [...s].filter((i) => i < doc.pageCount)
      return kept.length === s.size ? s : new Set(kept)
    })
  }, [doc.pageCount])

  const sorted = [...selected].sort((a, b) => a - b)
  const hasSelection = sorted.length > 0
  const allSelected = sorted.length === doc.pageCount

  const run = async (edit: Edit, nextSelection?: number[]) => {
    if (working) return false
    setWorking(true)
    try {
      await onEdit(edit)
      if (nextSelection) setSelected(new Set(nextSelection))
      return true
    } catch (err) {
      onError(err)
      return false
    } finally {
      setWorking(false)
    }
  }

  const click = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor !== null) {
      setSelected(new Set(range(Math.min(anchor, i), Math.max(anchor, i))))
      return
    }
    setAnchor(i)
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      setSelected(next)
    } else setSelected(new Set([i]))
  }

  const rotate = (degrees: number) => void run({ kind: 'rotate', pages: sorted, degrees }, sorted)

  const remove = () => {
    if (allSelected) return
    void run({ kind: 'delete', pages: sorted }, [])
  }

  /** Moves `pages` so they sit before what is now page `target` (0..pageCount). */
  const moveTo = (pages: number[], target: number) => {
    const dest = target - pages.filter((p) => p < target).length
    const unchanged = pages.every((p, k) => p === dest + k)
    if (unchanged) return
    void run({ kind: 'move', pages, dest }, range(dest, dest + pages.length - 1))
  }

  const insertAt = () => (hasSelection ? sorted[sorted.length - 1] + 1 : doc.pageCount)

  const insertFiles = async (files: File[]) => {
    let at = insertAt()
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer())
      const added = await insertBytes(f.name, bytes, at, '')
      if (added === null) return
      at += added
    }
  }

  /** Inserts a file's pages; returns how many were added, or null if it stopped. */
  const insertBytes = async (name: string, bytes: Uint8Array, at: number, password: string): Promise<number | null> => {
    setWorking(true)
    try {
      const before = latest.current.pageCount
      const next = await onEdit({ kind: 'insert', bytes, password, at })
      latest.current = next
      setPending(null)
      const added = next.pageCount - before
      setSelected(new Set(range(at, at + added - 1)))
      return added
    } catch (err) {
      if (err instanceof PdfError && err.code === 'password') {
        setPending({ name, bytes, at, wrong: password !== '' })
        return null
      }
      onError(err)
      return null
    } finally {
      setWorking(false)
    }
  }

  const extract = async (pages: number[], name: string) => {
    setWorking(true)
    try {
      await onSaveFile(name, await doc.extract(pages))
    } catch (err) {
      onError(err)
    } finally {
      setWorking(false)
    }
  }

  const split = async () => {
    const n = Math.max(1, Math.floor(splitEvery))
    const parts = Math.ceil(doc.pageCount / n)
    for (let k = 0; k < parts; k++) {
      const pages = range(k * n, Math.min(doc.pageCount, (k + 1) * n) - 1)
      await extract(pages, `${baseName}-part${k + 1}.pdf`)
    }
    setSplitOpen(false)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key === 'a') {
        e.preventDefault()
        setSelected(new Set(range(0, doc.pageCount - 1)))
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && hasSelection) {
        e.preventDefault()
        remove()
      } else if (e.key === 'Escape') setSelected(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const pages = range(0, doc.pageCount - 1)
  const label = hasSelection ? `${sorted.length} of ${doc.pageCount} selected` : `${doc.pageCount} pages`

  return (
    <div className="organize">
      <div className="organize-bar" role="toolbar" aria-label="Organize pages">
        <span className="count">{label}</span>
        <button onClick={() => rotate(-90)} disabled={!hasSelection || working}>
          ⟲ Rotate left
        </button>
        <button onClick={() => rotate(90)} disabled={!hasSelection || working}>
          ⟳ Rotate right
        </button>
        <button
          onClick={remove}
          disabled={!hasSelection || allSelected || working}
          title={allSelected ? 'A PDF needs at least one page' : undefined}
        >
          Delete
        </button>
        <button
          onClick={() => void extract(sorted, `${baseName}-pages.pdf`)}
          disabled={!hasSelection || working}
        >
          Extract
        </button>
        <button onClick={() => fileInput.current?.click()} disabled={working}>
          {hasSelection ? 'Insert after selection' : 'Insert pages'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            if (files.length) void insertFiles(files)
          }}
        />
        <button className={splitOpen ? 'on' : ''} onClick={() => setSplitOpen(!splitOpen)} disabled={working}>
          Split
        </button>
        {splitOpen && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault()
              void split()
            }}
          >
            <label>
              Every{' '}
              <input
                type="number"
                min={1}
                max={doc.pageCount}
                value={splitEvery}
                onChange={(e) => setSplitEvery(Number(e.target.value))}
                aria-label="Pages per file"
              />{' '}
              pages
            </label>
            <button type="submit" disabled={working}>
              Save {Math.ceil(doc.pageCount / Math.max(1, Math.floor(splitEvery) || 1))} files
            </button>
          </form>
        )}
      </div>

      {pending && (
        <form
          className="unlock"
          onSubmit={(e) => {
            e.preventDefault()
            const pw = String(new FormData(e.currentTarget).get('password') ?? '')
            void insertBytes(pending.name, pending.bytes, pending.at, pw)
          }}
        >
          <label>
            {pending.wrong ? 'Wrong password. Try again' : `“${pending.name}” is password-protected`}:{' '}
            <input name="password" type="password" autoFocus autoComplete="off" aria-invalid={pending.wrong} />
          </label>
          <button type="submit">Insert</button>
          <button type="button" onClick={() => setPending(null)}>
            Cancel
          </button>
        </form>
      )}

      <div
        className="grid"
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(new Set())
        }}
        onDragOver={(e) => {
          if (dragging) e.preventDefault()
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          if (dragging && dropAt !== null) moveTo(dragging, dropAt)
          setDragging(null)
          setDropAt(null)
        }}
      >
        {pages.map((i) => (
          <div
            key={i}
            className={[
              'tile',
              selected.has(i) ? 'on' : '',
              dropAt === i ? 'drop-before' : '',
              dropAt === i + 1 && i === doc.pageCount - 1 ? 'drop-after' : '',
              dragging?.includes(i) ? 'lifted' : '',
            ].join(' ')}
            draggable
            role="option"
            aria-selected={selected.has(i)}
            aria-label={`Page ${i + 1}`}
            onClick={(e) => click(i, e)}
            onDoubleClick={() => onOpenPage(i)}
            onDragStart={(e) => {
              const pages = selected.has(i) ? sorted : [i]
              if (!selected.has(i)) setSelected(new Set([i]))
              setDragging(pages)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', pages.join(','))
            }}
            onDragOver={(e) => {
              if (!dragging) return
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              setDropAt(e.clientX < r.left + r.width / 2 ? i : i + 1)
            }}
            onDragEnd={() => {
              setDragging(null)
              setDropAt(null)
            }}
          >
            <div className="tile-frame">
              <PageCanvas
                doc={doc}
                pageIndex={i}
                zoom={THUMB_WIDTH / Math.max(doc.sizes[i].width, doc.sizes[i].height)}
                className="thumb-page"
                onError={onError}
              />
            </div>
            <span>{i + 1}</span>
          </div>
        ))}
      </div>
      <p className="hint organize-hint">
        Click to select, Shift or Ctrl to select more, drag to reorder, double-click to view. Ctrl+Z undoes.
      </p>
    </div>
  )
}

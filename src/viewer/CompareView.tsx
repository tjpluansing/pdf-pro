import { useEffect, useMemo, useRef, useState } from 'react'
import { lineBoxes, type Change, type Comparison, type Word } from '../engine/compare'
import type { Rect } from '../engine/pdfium'
import type { DocHandle } from './client'
import { PageCanvas } from './PageCanvas'

interface Props {
  /** The version open in the viewer. */
  doc: DocHandle
  /** The version it is compared with. */
  older: DocHandle
  names: { older: string; newer: string }
  onClose: () => void
  onError: (err: unknown) => void
}

type Side = 'before' | 'after'

interface Mark {
  change: number
  kind: Change['kind']
  rect: Rect
  /** Where words went missing or will appear, on the side that does not have them. */
  caret?: boolean
}

const GAP = 16
const SNIPPET = 12

const snippet = (words: Word[]) => {
  const text = words.slice(0, SNIPPET).map((w) => w.text).join(' ')
  return words.length > SNIPPET ? `${text} …` : text
}

/** Highlight boxes for one side, grouped by page. */
function marksFor(changes: Change[], side: Side): Map<number, Mark[]> {
  const pages = new Map<number, Mark[]>()
  changes.forEach((c, change) => {
    for (const { pageIndex, rect } of lineBoxes(c[side])) {
      const list = pages.get(pageIndex) ?? []
      list.push({ change, kind: c.kind, rect })
      pages.set(pageIndex, list)
    }
    const near = c.near[side]
    if (!c[side].length && near && near.rect.height > 0) {
      const list = pages.get(near.pageIndex) ?? []
      const r = near.rect
      list.push({ change, kind: c.kind, caret: true, rect: { x: r.x + r.width + 1, y: r.y, width: 0, height: r.height } })
      pages.set(near.pageIndex, list)
    }
  })
  return pages
}

/**
 * Two versions side by side, with what was removed marked on the older one,
 * what was added on the newer one, and what was reworded on both.
 */
export function CompareView({ doc, older, names, onClose, onError }: Props) {
  const [result, setResult] = useState<Comparison | null>(null)
  const [active, setActive] = useState<number | null>(null)
  const [zoom, setZoom] = useState(0.6)
  const panes = useRef<Record<Side, HTMLDivElement | null>>({ before: null, after: null })

  useEffect(() => {
    let live = true
    doc.compare(older).then(
      (r) => live && setResult(r),
      (err) => live && onError(err),
    )
    return () => {
      live = false
    }
  }, [doc, older, onError])

  // Fit the widest first page of either version into its pane.
  useEffect(() => {
    const el = panes.current.after
    if (!el) return
    const fit = () => {
      const widest = Math.max(doc.sizes[0]?.width ?? 612, older.sizes[0]?.width ?? 612)
      setZoom(Math.max(0.2, Math.min(2, (el.clientWidth - 2 * GAP) / widest)))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [doc, older])

  const changes = useMemo(() => (result && !result.tooDifferent ? result.changes : []), [result])
  const marks = useMemo(() => ({ before: marksFor(changes, 'before'), after: marksFor(changes, 'after') }), [changes])
  const counts = useMemo(() => {
    const c = { added: 0, removed: 0, changed: 0 }
    for (const ch of changes) c[ch.kind]++
    return c
  }, [changes])

  const show = (i: number) => {
    setActive(i)
    const c = changes[i]
    for (const side of ['before', 'after'] as const) {
      const pane = panes.current[side]
      const first = lineBoxes(c[side])[0]
      // An addition has nothing on the older side: keep it near the word before it.
      const near = c.near[side]
      const anchor = first ?? (near && { pageIndex: near.pageIndex, rect: near.rect })
      if (!pane || !anchor) continue
      const page = pane.querySelector<HTMLElement>(`[data-page="${anchor.pageIndex}"]`)
      if (!page) continue
      const top = page.offsetTop + anchor.rect.y * zoom - pane.clientHeight / 3
      pane.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    }
  }

  const step = (dir: 1 | -1) => {
    if (!changes.length) return
    const next = active === null ? (dir > 0 ? 0 : changes.length - 1) : (active + dir + changes.length) % changes.length
    show(next)
  }

  const column = (side: Side, handle: DocHandle) => (
    <div className="compare-pane" ref={(el) => void (panes.current[side] = el)} aria-label={side === 'before' ? 'Older version' : 'Newer version'}>
      {Array.from({ length: handle.pageCount }, (_, i) => (
        <PageCanvas key={`${handle.version}-${i}`} doc={handle} pageIndex={i} zoom={zoom} className="page" onError={onError}>
          {marks[side].get(i)?.map((m, j) => (
            <div
              key={j}
              className={`diff diff-${m.kind}${m.caret ? ' diff-caret' : ''}${m.change === active ? ' diff-active' : ''}`}
              style={{ left: m.rect.x * zoom - 1, top: m.rect.y * zoom - 1, width: m.rect.width * zoom + 2, height: m.rect.height * zoom + 2 }}
              onClick={() => show(m.change)}
            />
          ))}
        </PageCanvas>
      ))}
    </div>
  )

  return (
    <div className="compare">
      <div className="organize-bar" role="toolbar" aria-label="Compare">
        <strong>Compare</strong>
        {!result ? (
          <span className="count">Comparing the text of both versions…</span>
        ) : result.tooDifferent ? (
          <span className="count">These versions are too different to compare word by word.</span>
        ) : changes.length === 0 ? (
          <span className="count">No differences in the text.</span>
        ) : (
          <>
            <span className="count">
              {changes.length} {changes.length === 1 ? 'difference' : 'differences'}: {counts.changed} changed, {counts.added} added, {counts.removed} removed
            </span>
            <button onClick={() => step(-1)} aria-label="Previous difference">
              ‹ Previous
            </button>
            <button onClick={() => step(1)} aria-label="Next difference">
              Next ›
            </button>
          </>
        )}
        <span className="sel-actions">
          <button onClick={onClose}>Close compare</button>
        </span>
      </div>
      <div className="compare-body">
        <ol className="compare-list" aria-label="Differences">
          {result && !result.tooDifferent && changes.length === 0 && <li className="compare-none">The words are the same in both versions. Layout, images and formatting are not compared.</li>}
          {changes.map((c, i) => (
            <li key={i}>
              <button className={`compare-item${i === active ? ' active' : ''}`} onClick={() => show(i)}>
                <span className={`compare-kind diff-${c.kind}`}>{c.kind === 'changed' ? 'Changed' : c.kind === 'added' ? 'Added' : 'Removed'}</span>
                <span className="compare-where">Page {(c.after[0] ?? c.before[0]).pageIndex + 1}</span>
                {c.before.length > 0 && <del>{snippet(c.before)}</del>}
                {c.after.length > 0 && <ins>{snippet(c.after)}</ins>}
              </button>
            </li>
          ))}
        </ol>
        <div className="compare-side">
          <div className="compare-label" title={names.older}>
            Older: {names.older}
          </div>
          {column('before', older)}
        </div>
        <div className="compare-side">
          <div className="compare-label" title={names.newer}>
            Newer: {names.newer}
          </div>
          {column('after', doc)}
        </div>
      </div>
    </div>
  )
}

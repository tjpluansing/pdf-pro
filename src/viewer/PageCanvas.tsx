import { useEffect, useRef, useState } from 'react'
import type { Rect } from '../engine/pdfium'
import { CancelledError, type DocHandle } from './client'

interface Props {
  doc: DocHandle
  pageIndex: number
  /** CSS pixels per PDF point. */
  zoom: number
  /** Search matches on this page, in page points from the top-left. */
  highlights?: Rect[]
  /** The match the user is on, drawn stronger. */
  activeHighlight?: Rect[]
  className?: string
  onError?: (err: unknown) => void
}

/**
 * One page, rendered in the engine worker only while it is near the viewport.
 * A page that scrolls away before its turn is cancelled, so fast scrolling
 * through a long file only renders the pages you stop on.
 */
export function PageCanvas({ doc, pageIndex, zoom, highlights, activeHighlight, className, onError }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const [drawn, setDrawn] = useState(false)
  const size = doc.sizes[pageIndex]
  const width = Math.round(size.width * zoom)
  const height = Math.round(size.height * zoom)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    const abort = new AbortController()
    const dpr = window.devicePixelRatio || 1
    doc.render(pageIndex, zoom * dpr, abort.signal).then(
      (img) => {
        const c = canvas.current
        if (abort.signal.aborted || !c) return
        c.width = img.width
        c.height = img.height
        c.getContext('2d')?.putImageData(img, 0, 0)
        setDrawn(true)
      },
      (err) => {
        if (!(err instanceof CancelledError) && !abort.signal.aborted) onError?.(err)
      },
    )
    return () => abort.abort()
  }, [visible, doc, pageIndex, zoom, onError])

  const mark = (r: Rect, i: number, active: boolean) => (
    <div
      key={`${active ? 'a' : 'h'}${i}`}
      className={active ? 'hl hl-active' : 'hl'}
      style={{ left: r.x * zoom, top: r.y * zoom, width: r.width * zoom, height: r.height * zoom }}
    />
  )

  return (
    <div ref={box} className={drawn ? className : `${className} loading`} style={{ width, height }} data-page={pageIndex}>
      <canvas ref={canvas} style={{ width, height }} aria-label={`Page ${pageIndex + 1}`} />
      {highlights?.map((r, i) => mark(r, i, false))}
      {activeHighlight?.map((r, i) => mark(r, i, true))}
    </div>
  )
}

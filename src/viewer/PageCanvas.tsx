import { useEffect, useRef, useState } from 'react'
import type { PdfDocument, Rect } from '../engine/pdfium'

interface Props {
  doc: PdfDocument
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
 * One page, rendered only while it is near the viewport. The canvas is drawn at
 * devicePixelRatio for sharp text and re-rendered when the zoom changes.
 */
export function PageCanvas({ doc, pageIndex, zoom, highlights, activeHighlight, className, onError }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const size = doc.pageSize(pageIndex)
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
    if (!visible || !canvas.current) return
    // Defer so scrolling stays smooth when many pages become visible at once.
    const id = requestAnimationFrame(() => {
      const c = canvas.current
      if (!c) return
      try {
        const dpr = window.devicePixelRatio || 1
        const page = doc.renderPage(pageIndex, zoom * dpr)
        c.width = page.width
        c.height = page.height
        c.getContext('2d')?.putImageData(new ImageData(page.data, page.width, page.height), 0, 0)
      } catch (err) {
        onError?.(err)
      }
    })
    return () => cancelAnimationFrame(id)
  }, [visible, doc, pageIndex, zoom, onError])

  const mark = (r: Rect, i: number, active: boolean) => (
    <div
      key={`${active ? 'a' : 'h'}${i}`}
      className={active ? 'hl hl-active' : 'hl'}
      style={{ left: r.x * zoom, top: r.y * zoom, width: r.width * zoom, height: r.height * zoom }}
    />
  )

  return (
    <div ref={box} className={className} style={{ width, height }} data-page={pageIndex}>
      <canvas ref={canvas} style={{ width, height }} aria-label={`Page ${pageIndex + 1}`} />
      {highlights?.map((r, i) => mark(r, i, false))}
      {activeHighlight?.map((r, i) => mark(r, i, true))}
    </div>
  )
}

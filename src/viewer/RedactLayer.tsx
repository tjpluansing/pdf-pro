import { useRef, useState } from 'react'
import type { Point, Rect } from '../engine/pdfium'

export interface RedactMark {
  id: string
  pageIndex: number
  /** View points from the top-left of the page as displayed. */
  rect: Rect
}

interface Props {
  pageIndex: number
  zoom: number
  marks: RedactMark[]
  onAdd: (mark: Omit<RedactMark, 'id'>) => void
  onRemove: (id: string) => void
}

/** Smaller than this (points), a drag is taken for a stray click. */
const MIN = 3

/** Drag to mark an area for redaction. Marks show as outlined boxes until they are applied. */
export function RedactLayer({ pageIndex, zoom, marks, onAdd, onRemove }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null)

  const point = (e: React.PointerEvent): Point => {
    const r = el.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }
  }
  const box = (a: Point, b: Point): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
  const style = (r: Rect) => ({ left: r.x * zoom, top: r.y * zoom, width: r.width * zoom, height: r.height * zoom })

  return (
    <div
      ref={el}
      className="redact-layer"
      aria-label={`Mark areas to redact on page ${pageIndex + 1}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        el.current?.setPointerCapture(e.pointerId)
        const p = point(e)
        setDrag({ from: p, to: p })
      }}
      onPointerMove={(e) => drag && setDrag({ ...drag, to: point(e) })}
      onPointerUp={() => {
        if (!drag) return
        const r = box(drag.from, drag.to)
        setDrag(null)
        if (r.width >= MIN && r.height >= MIN) onAdd({ pageIndex, rect: r })
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {marks.map((m) => (
        <div key={m.id} className="redact-mark" style={style(m.rect)}>
          <button
            type="button"
            className="redact-remove"
            aria-label="Remove this mark"
            title="Remove this mark"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onRemove(m.id)}
          >
            ×
          </button>
        </div>
      ))}
      {drag && <div className="redact-mark drafting" style={style(box(drag.from, drag.to))} />}
    </div>
  )
}

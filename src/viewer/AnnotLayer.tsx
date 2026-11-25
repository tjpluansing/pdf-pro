import { useEffect, useRef, useState } from 'react'
import type { Annotation, NewAnnotation, Point, Rect, TextLayout } from '../engine/pdfium'
import { caretAt, overText, selectedText, selectionRects, wordAt } from './selection'

export type Tool =
  | 'select'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'note'
  | 'freetext'
  | 'ink'
  | 'square'
  | 'circle'
  | 'arrow'
  | 'line'
  // Fill & Sign: one click places each of these.
  | 'check'
  | 'cross'
  | 'date'
  | 'signature'
  | 'initials'

export const MARKUP_TOOLS = ['highlight', 'underline', 'strikeout'] as const
export type MarkupTool = (typeof MARKUP_TOOLS)[number]

export interface TextSelection {
  pageIndex: number
  text: string
  rects: Rect[]
}

interface Props {
  pageIndex: number
  zoom: number
  tool: Tool
  color: string
  annotations: Annotation[]
  selectedId: string | null
  /** Character boxes for this page, loaded on first use. */
  loadLayout: (pageIndex: number) => Promise<TextLayout>
  textSelection: TextSelection | null
  onTextSelection: (s: TextSelection | null) => void
  onSelect: (id: string | null) => void
  onCreate: (spec: NewAnnotation) => void
  onMove: (a: Annotation, to: Point) => void
  /** Signature or initials tool clicked at a point. */
  onPlaceSignature?: (pageIndex: number, at: Point, kind: 'signature' | 'initials') => void
}

const MARK = 10

/** Strokes for a check mark or cross centred on `p`, `MARK` points across. */
function markStrokes(kind: 'check' | 'cross', p: Point): Point[][] {
  const h = MARK / 2
  if (kind === 'check')
    return [
      [
        { x: p.x - h, y: p.y },
        { x: p.x - h * 0.3, y: p.y + h * 0.75 },
        { x: p.x + h, y: p.y - h * 0.9 },
      ],
    ]
  return [
    [
      { x: p.x - h, y: p.y - h },
      { x: p.x + h, y: p.y + h },
    ],
    [
      { x: p.x + h, y: p.y - h },
      { x: p.x - h, y: p.y + h },
    ],
  ]
}

type Drag =
  /** `markup` is a highlight (etc.) under the pointer: a click without dragging selects it. */
  | { type: 'text'; layout: TextLayout; anchor: number; caret: number; markup?: Annotation }
  | { type: 'shape'; from: Point; to: Point }
  | { type: 'ink'; points: Point[] }
  | { type: 'move'; annot: Annotation; from: Point; to: Point }

const STROKE = 2
const NOTE_SIZE = 22

const norm = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
})

const inside = (r: Rect, p: Point, slop = 2) =>
  p.x >= r.x - slop && p.x <= r.x + r.width + slop && p.y >= r.y - slop && p.y <= r.y + r.height + slop

/** The annotation under a point, topmost first. Markup is hit on its text lines, not its whole bounds. */
function hitTest(list: Annotation[], p: Point): Annotation | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i]
    if (a.quads?.length ? a.quads.some((q) => inside(q, p)) : inside(a.rect, p)) return a
  }
  return null
}

/**
 * Pointer layer over one page in Comment mode: selects text, draws new
 * markup and shapes, and selects or drags existing annotations. Coordinates
 * are page points from the top-left; the page itself renders the saved
 * annotations, so this layer only draws what is in progress.
 */
export function AnnotLayer(props: Props) {
  const { pageIndex, zoom, tool, color, annotations, selectedId, textSelection } = props
  const el = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [typing, setTyping] = useState<Rect | null>(null)
  const [layout, setLayout] = useState<TextLayout | null>(null)
  const [cursor, setCursor] = useState<'text' | 'default' | 'move'>('default')

  const textTool = tool === 'select' || (MARKUP_TOOLS as readonly string[]).includes(tool)

  // Text boxes are needed for hovering and selecting; fetch them once per page and document version.
  const { loadLayout } = props
  useEffect(() => {
    if (!textTool) return
    let live = true
    loadLayout(pageIndex).then(
      (l) => live && setLayout(l),
      () => {},
    )
    return () => {
      live = false
    }
  }, [textTool, loadLayout, pageIndex])

  const point = (e: React.PointerEvent | React.MouseEvent): Point => {
    const r = el.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }
  }

  const finishText = (l: TextLayout, a: number, b: number, markup: boolean) => {
    if (a === b) {
      props.onTextSelection(null)
      return
    }
    const rects = selectionRects(l, a, b)
    if (!rects.length) return props.onTextSelection(null)
    if (markup) {
      props.onTextSelection(null)
      props.onCreate({ kind: tool as MarkupTool, pageIndex, color, quads: rects })
    } else props.onTextSelection({ pageIndex, text: selectedText(l, a, b), rects })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || typing) return
    const p = point(e)
    el.current?.setPointerCapture(e.pointerId)

    // With the select tool, comments win over the text under them: click selects, drag moves.
    const hit = tool === 'select' ? hitTest(annotations, p) : null
    if (hit && !hit.quads?.length) {
      props.onTextSelection(null)
      props.onSelect(hit.id)
      setDrag({ type: 'move', annot: hit, from: p, to: p })
      return
    }
    if (textTool && layout) {
      const c = caretAt(layout, p)
      if (e.detail === 2) {
        const [a, b] = wordAt(layout, c)
        finishText(layout, a, b, tool !== 'select')
        return
      }
      props.onSelect(null)
      props.onTextSelection(null)
      setDrag({ type: 'text', layout, anchor: c, caret: c, markup: hit ?? undefined })
      return
    }
    if (tool === 'select') {
      props.onTextSelection(null)
      props.onSelect(hit?.id ?? null)
      return
    }
    if (tool === 'check' || tool === 'cross') {
      props.onCreate({ kind: 'ink', pageIndex, color, ink: markStrokes(tool, p), strokeWidth: 1.5 })
      return
    }
    if (tool === 'date') {
      const text = new Date().toLocaleDateString()
      props.onCreate({
        kind: 'freetext',
        pageIndex,
        color,
        contents: text,
        fontSize: 11,
        rect: { x: p.x, y: p.y - 8, width: text.length * 6.5 + 8, height: 16 },
      })
      return
    }
    if (tool === 'signature' || tool === 'initials') {
      props.onPlaceSignature?.(pageIndex, p, tool)
      return
    }
    if (tool === 'note') {
      props.onCreate({
        kind: 'note',
        pageIndex,
        color,
        rect: { x: p.x - NOTE_SIZE / 2, y: p.y - NOTE_SIZE / 2, width: NOTE_SIZE, height: NOTE_SIZE },
      })
      return
    }
    if (tool === 'ink') setDrag({ type: 'ink', points: [p] })
    else setDrag({ type: 'shape', from: p, to: p })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = point(e)
    if (!drag) {
      if (layout && textTool) {
        const onAnnot = tool === 'select' && hitTest(annotations, p)
        setCursor(onAnnot ? (onAnnot.quads?.length ? 'default' : 'move') : tool !== 'select' || overText(layout, p) ? 'text' : 'default')
      }
      return
    }
    if (drag.type === 'text') setDrag({ ...drag, caret: caretAt(drag.layout, p) })
    else if (drag.type === 'ink') {
      const last = drag.points[drag.points.length - 1]
      if (Math.hypot(p.x - last.x, p.y - last.y) * zoom >= 2) setDrag({ ...drag, points: [...drag.points, p] })
    } else setDrag({ ...drag, to: p })
  }

  const onPointerUp = () => {
    const d = drag
    setDrag(null)
    if (!d) return
    if (d.type === 'text') {
      if (d.markup && d.anchor === d.caret) return props.onSelect(d.markup.id)
      return finishText(d.layout, d.anchor, d.caret, tool !== 'select')
    }
    if (d.type === 'move') {
      const dx = d.to.x - d.from.x
      const dy = d.to.y - d.from.y
      if (Math.hypot(dx, dy) > 1) props.onMove(d.annot, { x: d.annot.rect.x + dx, y: d.annot.rect.y + dy })
      return
    }
    if (d.type === 'ink') {
      if (d.points.length > 1) props.onCreate({ kind: 'ink', pageIndex, color, ink: [d.points], strokeWidth: STROKE })
      return
    }
    const r = norm(d.from, d.to)
    const small = r.width < 4 && r.height < 4
    if (tool === 'freetext') {
      setTyping(small ? { x: d.from.x, y: d.from.y, width: 200, height: 24 } : r)
      return
    }
    if (small) return
    if (tool === 'square' || tool === 'circle') props.onCreate({ kind: tool, pageIndex, color, rect: r, strokeWidth: STROKE })
    else if (tool === 'arrow' || tool === 'line') props.onCreate({ kind: tool, pageIndex, color, line: [d.from, d.to], strokeWidth: STROKE })
  }

  const commitText = (value: string) => {
    const r = typing
    setTyping(null)
    if (!r || !value.trim()) return
    const lines = value.split('\n').length
    props.onCreate({
      kind: 'freetext',
      pageIndex,
      color,
      contents: value,
      fontSize: 14,
      rect: { ...r, height: Math.max(r.height, lines * 18 + 6) },
    })
  }

  const z = (n: number) => n * zoom
  const selected = annotations.find((a) => a.id === selectedId)
  const liveText =
    drag?.type === 'text' && drag.anchor !== drag.caret ? selectionRects(drag.layout, drag.anchor, drag.caret) : null
  const shownText = liveText ?? (textSelection?.pageIndex === pageIndex ? textSelection.rects : null)

  return (
    <div
      ref={el}
      className={`annot-layer tool-${tool}`}
      style={{ cursor: textTool ? cursor : ['note', 'check', 'cross', 'date', 'signature', 'initials'].includes(tool) ? 'copy' : 'crosshair' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      {shownText?.map((r, i) => (
        <div
          key={i}
          className={tool === 'select' ? 'text-sel' : `text-sel preview-${tool}`}
          style={{ left: z(r.x), top: z(r.y), width: z(r.width), height: z(r.height), ['--mark' as string]: color }}
        />
      ))}

      {selected && (
        <div
          className="annot-selected"
          style={{
            left: z(selected.rect.x) - 3,
            top: z(selected.rect.y) - 3,
            width: z(selected.rect.width) + 6,
            height: z(selected.rect.height) + 6,
          }}
        />
      )}

      {(drag?.type === 'shape' || drag?.type === 'ink' || drag?.type === 'move') && (
        <svg className="annot-draft" width="100%" height="100%">
          {drag.type === 'ink' && (
            <polyline
              points={drag.points.map((p) => `${z(p.x)},${z(p.y)}`).join(' ')}
              fill="none"
              stroke={color}
              strokeWidth={z(STROKE)}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {drag.type === 'shape' && <Draft tool={tool} from={drag.from} to={drag.to} color={color} zoom={zoom} />}
          {drag.type === 'move' && (
            <rect
              x={z(drag.annot.rect.x + drag.to.x - drag.from.x)}
              y={z(drag.annot.rect.y + drag.to.y - drag.from.y)}
              width={z(drag.annot.rect.width)}
              height={z(drag.annot.rect.height)}
              fill="none"
              stroke="var(--accent)"
              strokeDasharray="4 3"
            />
          )}
        </svg>
      )}

      {typing && (
        <textarea
          className="freetext-input"
          autoFocus
          placeholder="Type, then click away"
          style={{
            left: z(typing.x),
            top: z(typing.y),
            width: z(typing.width),
            minHeight: z(typing.height),
            fontSize: z(14),
            color,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => commitText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setTyping(null)
            else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commitText(e.currentTarget.value)
            }
          }}
        />
      )}
    </div>
  )
}

function Draft({ tool, from, to, color, zoom }: { tool: Tool; from: Point; to: Point; color: string; zoom: number }) {
  const z = (n: number) => n * zoom
  const r = norm(from, to)
  const common = { fill: 'none', stroke: color, strokeWidth: z(STROKE) }
  if (tool === 'square' || tool === 'freetext') return <rect x={z(r.x)} y={z(r.y)} width={z(r.width)} height={z(r.height)} {...common} strokeDasharray={tool === 'freetext' ? '4 3' : undefined} />
  if (tool === 'circle') return <ellipse cx={z(r.x + r.width / 2)} cy={z(r.y + r.height / 2)} rx={z(r.width / 2)} ry={z(r.height / 2)} {...common} />
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const head = 10
  const wing = (s: number) => `${z(to.x - head * Math.cos(angle + s))},${z(to.y - head * Math.sin(angle + s))}`
  return (
    <g {...common} strokeLinecap="round">
      <line x1={z(from.x)} y1={z(from.y)} x2={z(to.x)} y2={z(to.y)} />
      {tool === 'arrow' && <polyline points={`${wing(0.45)} ${z(to.x)},${z(to.y)} ${wing(-0.45)}`} />}
    </g>
  )
}

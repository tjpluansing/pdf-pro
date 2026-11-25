/**
 * Reading and writing PDF annotations (comments and markup) with PDFium.
 *
 * Everything outside this file talks in "view" coordinates: points from the
 * top-left corner of the page as it is displayed, after the page's own
 * rotation. PDF stores annotations in page space (origin bottom-left of the
 * crop box, unrotated), so every point goes through `toPage` / `toView`.
 */
import type { WrappedPdfiumModule } from '@embedpdf/pdfium'

export interface Point {
  x: number
  y: number
}

/** A rectangle in view coordinates (points from the top-left). */
export interface ViewRect {
  x: number
  y: number
  width: number
  height: number
}

export type AnnotKind =
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'squiggly'
  | 'note'
  | 'freetext'
  | 'ink'
  | 'square'
  | 'circle'
  | 'line'
  | 'arrow'
  /** Anything else PDF Pro shows in the list but cannot draw new copies of (stamps, attachments…). */
  | 'other'

export interface Annotation {
  /** The annotation's /NM name, or `#<index>` when the file gave it none. */
  id: string
  pageIndex: number
  kind: AnnotKind
  /** PDF subtype name, e.g. "Highlight". */
  subtype: string
  rect: ViewRect
  /** Stroke or markup colour as #rrggbb. */
  color: string | null
  /** Interior colour for shapes, as #rrggbb. */
  fill: string | null
  opacity: number
  contents: string
  author: string
  /** ISO date of the last change, when the file records one. */
  modified: string | null
  quads?: ViewRect[]
  ink?: Point[][]
  line?: [Point, Point]
  strokeWidth?: number
}

export interface NewAnnotation {
  kind: Exclude<AnnotKind, 'other'>
  pageIndex: number
  color: string
  fill?: string | null
  opacity?: number
  contents?: string
  author?: string
  /** Bounds for notes, text boxes and shapes. Computed for the others. */
  rect?: ViewRect
  /** Text lines covered by highlight, underline, strikeout and squiggly. */
  quads?: ViewRect[]
  ink?: Point[][]
  line?: [Point, Point]
  strokeWidth?: number
  fontSize?: number
}

/** What can be changed on an existing annotation. */
export interface AnnotationPatch {
  contents?: string
  color?: string
  /** Moves the annotation so its bounds start here (view coordinates). */
  moveTo?: Point
}

const SUBTYPES: Record<number, { name: string; kind: AnnotKind }> = {
  1: { name: 'Text', kind: 'note' },
  3: { name: 'FreeText', kind: 'freetext' },
  4: { name: 'Line', kind: 'line' },
  5: { name: 'Square', kind: 'square' },
  6: { name: 'Circle', kind: 'circle' },
  7: { name: 'Polygon', kind: 'other' },
  8: { name: 'PolyLine', kind: 'other' },
  9: { name: 'Highlight', kind: 'highlight' },
  10: { name: 'Underline', kind: 'underline' },
  11: { name: 'Squiggly', kind: 'squiggly' },
  12: { name: 'StrikeOut', kind: 'strikeout' },
  13: { name: 'Stamp', kind: 'other' },
  14: { name: 'Caret', kind: 'other' },
  15: { name: 'Ink', kind: 'ink' },
  17: { name: 'FileAttachment', kind: 'other' },
}
/** Link, Popup and Widget (form fields) are not comments, so the list skips them. */
const HIDDEN_SUBTYPES = new Set([2, 16, 20])

const SUBTYPE_OF: Record<NewAnnotation['kind'], number> = {
  note: 1,
  freetext: 3,
  line: 4,
  arrow: 4,
  square: 5,
  circle: 6,
  highlight: 9,
  underline: 10,
  squiggly: 11,
  strikeout: 12,
  ink: 15,
}

const COLOR = 0
const INTERIOR = 1
const BORDER_SOLID = 1
const LINE_END_NONE = 0
const LINE_END_OPEN_ARROW = 4
const FONT_HELVETICA = 4
const NAME_COMMENT = 0
const FLAG_PRINT = 4

/** Page geometry needed to convert between view and page space. */
export interface PageFrame {
  /** Displayed size, after rotation. */
  width: number
  height: number
  /** Quarter turns clockwise, 0 to 3. */
  rotation: number
  /** Bottom-left corner of the visible page box in page space. */
  originX: number
  originY: number
}

export function pageFrame(m: WrappedPdfiumModule, page: number): PageFrame {
  const p = m.pdfium.wasmExports.malloc(16)
  try {
    let originX = 0
    let originY = 0
    if (m.FPDF_GetPageBoundingBox(page, p)) {
      // FS_RECTF is { left, top, right, bottom }.
      originX = m.pdfium.getValue(p, 'float')
      originY = m.pdfium.getValue(p + 12, 'float')
    }
    return {
      width: m.FPDF_GetPageWidthF(page),
      height: m.FPDF_GetPageHeightF(page),
      rotation: m.FPDFPage_GetRotation(page) & 3,
      originX,
      originY,
    }
  } finally {
    m.pdfium.wasmExports.free(p)
  }
}

export function toPage(f: PageFrame, v: Point): Point {
  const { width: w, height: h } = f
  let x: number
  let y: number
  switch (f.rotation) {
    case 1:
      ;[x, y] = [v.y, v.x]
      break
    case 2:
      ;[x, y] = [w - v.x, v.y]
      break
    case 3:
      ;[x, y] = [h - v.y, w - v.x]
      break
    default:
      ;[x, y] = [v.x, h - v.y]
  }
  return { x: x + f.originX, y: y + f.originY }
}

export function toView(f: PageFrame, p: Point): Point {
  const { width: w, height: h } = f
  const x = p.x - f.originX
  const y = p.y - f.originY
  switch (f.rotation) {
    case 1:
      return { x: y, y: x }
    case 2:
      return { x: w - x, y }
    case 3:
      return { x: w - y, y: h - x }
    default:
      return { x, y: h - y }
  }
}

/** Page-space box (any two opposite corners) to a view rectangle. */
export function boxToView(f: PageFrame, left: number, top: number, right: number, bottom: number): ViewRect {
  const a = toView(f, { x: left, y: top })
  const b = toView(f, { x: right, y: bottom })
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

function viewToBox(f: PageFrame, r: ViewRect) {
  const a = toPage(f, { x: r.x, y: r.y })
  const b = toPage(f, { x: r.x + r.width, y: r.y + r.height })
  return { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), bottom: Math.min(a.y, b.y), top: Math.max(a.y, b.y) }
}

export function boundsOf(rects: ViewRect[], pad = 0): ViewRect {
  const x0 = Math.min(...rects.map((r) => r.x)) - pad
  const y0 = Math.min(...rects.map((r) => r.y)) - pad
  const x1 = Math.max(...rects.map((r) => r.x + r.width)) + pad
  const y1 = Math.max(...rects.map((r) => r.y + r.height)) + pad
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

const pointsBounds = (pts: Point[], pad: number) => boundsOf(pts.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })), pad)

function hex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((c) => (c & 255).toString(16).padStart(2, '0')).join('')
}

function rgb(color: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(color)
  if (!m) return [255, 212, 0]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** PDF date ("D:20261125113000+01'00'") to ISO, or null. */
export function parsePdfDate(raw: string): string | null {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(raw)
  if (!m) return null
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', tz] = m
  let zone = 'Z'
  if (tz && tz !== 'Z') zone = `${tz.slice(0, 3)}:${tz.replace(/'/g, '').slice(3, 5) || '00'}`
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function pdfDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
}

/** Thin helpers over one module, so the read/write code below stays readable. */
class Annots {
  private readonly m: WrappedPdfiumModule
  constructor(m: WrappedPdfiumModule) {
    this.m = m
  }

  private alloc<T>(bytes: number, fn: (ptr: number) => T): T {
    const ptr = this.m.pdfium.wasmExports.malloc(bytes)
    try {
      return fn(ptr)
    } finally {
      this.m.pdfium.wasmExports.free(ptr)
    }
  }

  getString(annot: number, key: string): string {
    const len = this.m.FPDFAnnot_GetStringValue(annot, key, 0, 0)
    if (len <= 2) return ''
    return this.alloc(len, (ptr) => {
      this.m.FPDFAnnot_GetStringValue(annot, key, ptr, len)
      return this.m.pdfium.UTF16ToString(ptr)
    })
  }

  setString(annot: number, key: string, value: string): boolean {
    const bytes = (value.length + 1) * 2
    return this.alloc(bytes, (ptr) => {
      this.m.pdfium.stringToUTF16(value, ptr, bytes)
      return !!this.m.FPDFAnnot_SetStringValue(annot, key, ptr)
    })
  }

  getColor(annot: number, type: number): string | null {
    return this.alloc(12, (p) =>
      this.m.EPDFAnnot_GetColor(annot, type, p, p + 4, p + 8)
        ? hex(...([0, 4, 8].map((o) => this.m.pdfium.getValue(p + o, 'i32')) as [number, number, number]))
        : null,
    )
  }

  setColor(annot: number, type: number, color: string): boolean {
    return !!this.m.EPDFAnnot_SetColor(annot, type, ...rgb(color))
  }

  getOpacity(annot: number): number {
    return this.alloc(4, (p) => (this.m.EPDFAnnot_GetOpacity(annot, p) ? (this.m.pdfium.getValue(p, 'i32') & 255) / 255 : 1))
  }

  getRect(annot: number, f: PageFrame): ViewRect | null {
    return this.alloc(16, (p) => {
      if (!this.m.FPDFAnnot_GetRect(annot, p)) return null
      const [left, top, right, bottom] = [0, 4, 8, 12].map((o) => this.m.pdfium.getValue(p + o, 'float'))
      return boxToView(f, left, top, right, bottom)
    })
  }

  setRect(annot: number, f: PageFrame, r: ViewRect): boolean {
    const b = viewToBox(f, r)
    return this.alloc(16, (p) => {
      ;[b.left, b.top, b.right, b.bottom].forEach((v, i) => this.m.pdfium.setValue(p + i * 4, v, 'float'))
      return !!this.m.FPDFAnnot_SetRect(annot, p)
    })
  }

  getQuads(annot: number, f: PageFrame): ViewRect[] {
    const n = this.m.FPDFAnnot_CountAttachmentPoints(annot)
    const quads: ViewRect[] = []
    this.alloc(32, (p) => {
      for (let i = 0; i < n; i++) {
        if (!this.m.FPDFAnnot_GetAttachmentPoints(annot, i, p)) continue
        const v = Array.from({ length: 8 }, (_, k) => this.m.pdfium.getValue(p + k * 4, 'float'))
        const xs = [v[0], v[2], v[4], v[6]]
        const ys = [v[1], v[3], v[5], v[7]]
        quads.push(boxToView(f, Math.min(...xs), Math.max(...ys), Math.max(...xs), Math.min(...ys)))
      }
    })
    return quads
  }

  appendQuad(annot: number, f: PageFrame, r: ViewRect): boolean {
    const b = viewToBox(f, r)
    // FS_QUADPOINTSF: x1,y1 (top-left), x2,y2 (top-right), x3,y3 (bottom-left), x4,y4 (bottom-right).
    const pts = [b.left, b.top, b.right, b.top, b.left, b.bottom, b.right, b.bottom]
    return this.alloc(32, (p) => {
      pts.forEach((v, i) => this.m.pdfium.setValue(p + i * 4, v, 'float'))
      return !!this.m.FPDFAnnot_AppendAttachmentPoints(annot, p)
    })
  }

  getInk(annot: number, f: PageFrame): Point[][] {
    const strokes: Point[][] = []
    const count = this.m.FPDFAnnot_GetInkListCount(annot)
    for (let i = 0; i < count; i++) {
      const n = this.m.FPDFAnnot_GetInkListPath(annot, i, 0, 0)
      if (n <= 0) continue
      strokes.push(
        this.alloc(n * 8, (p) => {
          this.m.FPDFAnnot_GetInkListPath(annot, i, p, n)
          return Array.from({ length: n }, (_, k) =>
            toView(f, { x: this.m.pdfium.getValue(p + k * 8, 'float'), y: this.m.pdfium.getValue(p + k * 8 + 4, 'float') }),
          )
        }),
      )
    }
    return strokes
  }

  addInkStroke(annot: number, f: PageFrame, stroke: Point[]): boolean {
    if (stroke.length === 0) return true
    return this.alloc(stroke.length * 8, (p) => {
      stroke.forEach((v, k) => {
        const pt = toPage(f, v)
        this.m.pdfium.setValue(p + k * 8, pt.x, 'float')
        this.m.pdfium.setValue(p + k * 8 + 4, pt.y, 'float')
      })
      return this.m.FPDFAnnot_AddInkStroke(annot, p, stroke.length) >= 0
    })
  }

  getLine(annot: number, f: PageFrame): [Point, Point] | undefined {
    return this.alloc(16, (p) => {
      if (!this.m.FPDFAnnot_GetLine(annot, p, p + 8)) return undefined
      const at = (o: number) => toView(f, { x: this.m.pdfium.getValue(p + o, 'float'), y: this.m.pdfium.getValue(p + o + 4, 'float') })
      return [at(0), at(8)] as [Point, Point]
    })
  }

  setLine(annot: number, f: PageFrame, [a, b]: [Point, Point]): boolean {
    return this.alloc(16, (p) => {
      ;[toPage(f, a), toPage(f, b)].forEach((pt, i) => {
        this.m.pdfium.setValue(p + i * 8, pt.x, 'float')
        this.m.pdfium.setValue(p + i * 8 + 4, pt.y, 'float')
      })
      return !!this.m.EPDFAnnot_SetLine(annot, p, p + 8)
    })
  }

  getBorderWidth(annot: number): number | undefined {
    return this.alloc(4, (p) => (this.m.EPDFAnnot_GetBorderStyle(annot, p) ? this.m.pdfium.getValue(p, 'float') : undefined))
  }
}

export function readAnnotations(m: WrappedPdfiumModule, page: number, pageIndex: number): Annotation[] {
  const a = new Annots(m)
  const f = pageFrame(m, page)
  const out: Annotation[] = []
  const count = m.FPDFPage_GetAnnotCount(page)
  for (let i = 0; i < count; i++) {
    const annot = m.FPDFPage_GetAnnot(page, i)
    if (!annot) continue
    try {
      const subtype = m.FPDFAnnot_GetSubtype(annot)
      if (HIDDEN_SUBTYPES.has(subtype)) continue
      const known = SUBTYPES[subtype] ?? { name: `Type ${subtype}`, kind: 'other' as const }
      const rect = a.getRect(annot, f)
      if (!rect) continue
      let kind = known.kind
      const item: Annotation = {
        id: a.getString(annot, 'NM') || `#${i}`,
        pageIndex,
        kind,
        subtype: known.name,
        rect,
        color: a.getColor(annot, COLOR),
        fill: a.getColor(annot, INTERIOR),
        opacity: a.getOpacity(annot),
        contents: a.getString(annot, 'Contents'),
        author: a.getString(annot, 'T'),
        modified: parsePdfDate(a.getString(annot, 'M')),
        strokeWidth: a.getBorderWidth(annot),
      }
      if (['highlight', 'underline', 'strikeout', 'squiggly'].includes(kind)) item.quads = a.getQuads(annot, f)
      if (kind === 'freetext') {
        // A text box keeps its text colour in /DA ("… r g b rg"), not in /C.
        const rgbOp = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(a.getString(annot, 'DA'))
        if (rgbOp) item.color = hex(...(rgbOp.slice(1, 4).map((v) => Math.round(Number(v) * 255)) as [number, number, number]))
      }
      if (kind === 'ink') item.ink = a.getInk(annot, f)
      if (kind === 'line') {
        item.line = a.getLine(annot, f)
        // An open-arrow line ending is how PDF Pro (and most editors) store arrows.
        if (lineEnd(m, annot) === LINE_END_OPEN_ARROW) kind = item.kind = 'arrow'
      }
      out.push(item)
    } finally {
      m.FPDFPage_CloseAnnot(annot)
    }
  }
  return out
}

function lineEnd(m: WrappedPdfiumModule, annot: number): number {
  const p = m.pdfium.wasmExports.malloc(8)
  try {
    return m.EPDFAnnot_GetLineEndings(annot, p, p + 4) ? m.pdfium.getValue(p + 4, 'i32') : LINE_END_NONE
  } finally {
    m.pdfium.wasmExports.free(p)
  }
}

/** Adds an annotation and returns its id. Throws if PDFium refuses any part, leaving nothing behind. */
export function addAnnotation(m: WrappedPdfiumModule, page: number, spec: NewAnnotation, id: string, now = new Date()): string {
  const a = new Annots(m)
  const f = pageFrame(m, page)
  const annot = m.EPDFPage_CreateAnnot(page, SUBTYPE_OF[spec.kind])
  if (!annot) throw new Error(`PDFium could not create a ${spec.kind} annotation`)
  let ok = true
  const step = (r: boolean) => {
    ok &&= r
  }
  try {
    const width = spec.strokeWidth ?? 2
    const pad = width / 2 + 1
    let rect = spec.rect
    if (spec.quads?.length) rect = boundsOf(spec.quads)
    if (spec.ink?.length) rect = pointsBounds(spec.ink.flat(), pad)
    if (spec.line) rect = pointsBounds(spec.line, pad + (spec.kind === 'arrow' ? width * 4 : 0))
    if (!rect) throw new Error(`A ${spec.kind} annotation needs a position`)

    step(a.setString(annot, 'NM', id))
    step(a.setRect(annot, f, rect))
    step(a.setString(annot, 'T', spec.author ?? ''))
    step(a.setString(annot, 'Contents', spec.contents ?? ''))
    step(a.setString(annot, 'M', pdfDate(now)))
    step(a.setString(annot, 'CreationDate', pdfDate(now)))
    step(!!m.FPDFAnnot_SetFlags(annot, FLAG_PRINT))
    step(!!m.EPDFAnnot_SetOpacity(annot, Math.round((spec.opacity ?? 1) * 255) & 255))

    switch (spec.kind) {
      case 'highlight':
      case 'underline':
      case 'strikeout':
      case 'squiggly':
        for (const q of spec.quads ?? []) step(a.appendQuad(annot, f, q))
        step(a.setColor(annot, COLOR, spec.color))
        break
      case 'note':
        step(!!m.EPDFAnnot_SetName(annot, NAME_COMMENT))
        step(a.setColor(annot, COLOR, spec.color))
        break
      case 'freetext':
        step(!!m.EPDFAnnot_SetBorderStyle(annot, BORDER_SOLID, 0))
        step(!!m.EPDFAnnot_SetDefaultAppearance(annot, FONT_HELVETICA, spec.fontSize ?? 12, ...rgb(spec.color)))
        if (spec.fill) step(a.setColor(annot, COLOR, spec.fill))
        break
      case 'ink':
        step(!!m.EPDFAnnot_SetBorderStyle(annot, BORDER_SOLID, width))
        for (const s of spec.ink ?? []) step(a.addInkStroke(annot, f, s))
        step(a.setColor(annot, COLOR, spec.color))
        break
      case 'square':
      case 'circle':
        step(!!m.EPDFAnnot_SetBorderStyle(annot, BORDER_SOLID, width))
        step(a.setColor(annot, COLOR, spec.color))
        if (spec.fill) step(a.setColor(annot, INTERIOR, spec.fill))
        else m.EPDFAnnot_ClearColor(annot, INTERIOR)
        break
      case 'line':
      case 'arrow':
        if (!spec.line) throw new Error('A line needs two points')
        step(a.setLine(annot, f, spec.line))
        step(!!m.EPDFAnnot_SetLineEndings(annot, LINE_END_NONE, spec.kind === 'arrow' ? LINE_END_OPEN_ARROW : LINE_END_NONE))
        step(!!m.EPDFAnnot_SetBorderStyle(annot, BORDER_SOLID, width))
        step(a.setColor(annot, COLOR, spec.color))
        break
    }
    if (ok) step(!!m.EPDFAnnot_GenerateAppearance(annot))
    if (!ok) throw new Error(`PDFium could not write the ${spec.kind} annotation`)
  } catch (err) {
    m.FPDFPage_CloseAnnot(annot)
    removeById(m, page, id)
    throw err
  }
  m.FPDFPage_CloseAnnot(annot)
  m.FPDFPage_GenerateContent(page)
  return id
}

/** Index of the annotation with this id on the page, or -1. */
function indexOf(m: WrappedPdfiumModule, page: number, id: string): number {
  if (id.startsWith('#')) {
    const i = Number(id.slice(1))
    return Number.isInteger(i) && i < m.FPDFPage_GetAnnotCount(page) ? i : -1
  }
  const a = new Annots(m)
  const count = m.FPDFPage_GetAnnotCount(page)
  for (let i = 0; i < count; i++) {
    const annot = m.FPDFPage_GetAnnot(page, i)
    if (!annot) continue
    const name = a.getString(annot, 'NM')
    m.FPDFPage_CloseAnnot(annot)
    if (name === id) return i
  }
  return -1
}

export function removeById(m: WrappedPdfiumModule, page: number, id: string): boolean {
  const i = indexOf(m, page, id)
  if (i < 0) return false
  const ok = !!m.FPDFPage_RemoveAnnot(page, i)
  if (ok) m.FPDFPage_GenerateContent(page)
  return ok
}

export function updateById(m: WrappedPdfiumModule, page: number, id: string, patch: AnnotationPatch, now = new Date()): boolean {
  const i = indexOf(m, page, id)
  if (i < 0) return false
  const a = new Annots(m)
  const f = pageFrame(m, page)
  const annot = m.FPDFPage_GetAnnot(page, i)
  if (!annot) return false
  try {
    const subtype = m.FPDFAnnot_GetSubtype(annot)
    const kind = SUBTYPES[subtype]?.kind ?? 'other'
    let redraw = false
    if (patch.contents !== undefined) {
      a.setString(annot, 'Contents', patch.contents)
      // A text box shows its contents on the page, so its appearance must be redrawn.
      if (kind === 'freetext') redraw = true
    }
    if (patch.color !== undefined && kind !== 'other') {
      if (kind === 'freetext') {
        const size = Number(/([\d.]+)\s+Tf/.exec(a.getString(annot, 'DA'))?.[1]) || 12
        m.EPDFAnnot_SetDefaultAppearance(annot, FONT_HELVETICA, size, ...rgb(patch.color))
      } else a.setColor(annot, COLOR, patch.color)
      redraw = true
    }
    if (patch.moveTo && kind !== 'other') {
      const r = a.getRect(annot, f)
      if (r) {
        const dx = patch.moveTo.x - r.x
        const dy = patch.moveTo.y - r.y
        const shift = (p: Point) => ({ x: p.x + dx, y: p.y + dy })
        a.setRect(annot, f, { ...r, x: patch.moveTo.x, y: patch.moveTo.y })
        if (kind === 'ink') {
          const strokes = a.getInk(annot, f)
          m.FPDFAnnot_RemoveInkList(annot)
          for (const s of strokes) a.addInkStroke(annot, f, s.map(shift))
        } else if (kind === 'line' || kind === 'arrow') {
          const line = a.getLine(annot, f)
          if (line) a.setLine(annot, f, [shift(line[0]), shift(line[1])])
        } else if (['highlight', 'underline', 'strikeout', 'squiggly'].includes(kind)) {
          // Markup belongs to the text under it; moving it would detach it.
        }
        redraw = true
      }
    }
    a.setString(annot, 'M', pdfDate(now))
    if (redraw) m.EPDFAnnot_GenerateAppearance(annot)
  } finally {
    m.FPDFPage_CloseAnnot(annot)
  }
  m.FPDFPage_GenerateContent(page)
  return true
}

/** Text on a page with one box per character, for selecting and copying text. */
export interface TextLayout {
  /** One UTF-16 unit per character; characters outside the BMP become U+FFFD. */
  text: string
  /** x, y, width, height per character, in view coordinates. Zero-size for generated spaces and line breaks. */
  boxes: Float32Array
}

export function readTextLayout(m: WrappedPdfiumModule, page: number, text: number): TextLayout {
  const f = pageFrame(m, page)
  const n = Math.max(0, m.FPDFText_CountChars(text))
  const boxes = new Float32Array(n * 4)
  const chars: string[] = new Array(n)
  const p = m.pdfium.wasmExports.malloc(16)
  try {
    for (let i = 0; i < n; i++) {
      const cp = m.FPDFText_GetUnicode(text, i)
      chars[i] = cp > 0xffff ? '�' : String.fromCharCode(cp)
      if (m.FPDFText_IsGenerated(text, i) === 1) continue
      if (!m.FPDFText_GetLooseCharBox(text, i, p)) continue
      const [left, top, right, bottom] = [0, 4, 8, 12].map((o) => m.pdfium.getValue(p + o, 'float'))
      const r = boxToView(f, left, top, right, bottom)
      boxes.set([r.x, r.y, r.width, r.height], i * 4)
    }
  } finally {
    m.pdfium.wasmExports.free(p)
  }
  return { text: chars.join(''), boxes }
}

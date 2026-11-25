/**
 * Watermarks, headers, footers and page numbers, drawn into the page content
 * as text objects, and password protection.
 *
 * Each added text object is tagged as a pagination artifact (PDF 32000-1,
 * 14.8.2.2) with a Subtype of Watermark, Header or Footer. Screen readers skip
 * artifacts, other editors recognise them, and it is how we find them again
 * to replace or remove them.
 */
import type { WrappedPdfiumModule } from '@embedpdf/pdfium'
import { pageFrame, toPage, type Point } from './annotations'

export type PageTextKind = 'watermark' | 'header' | 'footer'
export type StandardFont = 'Helvetica' | 'Helvetica-Bold' | 'Times-Roman' | 'Times-Bold' | 'Courier'

export interface PageText {
  kind: PageTextKind
  /** May contain {page}, {pages} and {date}. */
  text: string
  font?: StandardFont
  /** Font size in points. */
  size: number
  /** #rrggbb */
  color: string
  /** 0 to 1; default 1. */
  opacity?: number
  /** Degrees counter-clockwise, as seen on screen. Watermarks only. */
  rotation?: number
  /** Where a header or footer sits across the page. Watermarks are centred. */
  align?: 'left' | 'center' | 'right'
  /** Distance from the page edge for headers and footers, in points; default 36. */
  margin?: number
  /** Draw a watermark under the page content instead of over it. */
  behind?: boolean
}

export interface PageTextOptions {
  /** 0-based pages to stamp; all pages when omitted. */
  pages?: number[]
  /** The number {page} shows on the first page of the document; default 1. */
  startAt?: number
  /** What {date} becomes, already formatted for the user's locale. */
  date?: string
}

const SUBTYPE: Record<PageTextKind, string> = { watermark: 'Watermark', header: 'Header', footer: 'Footer' }

/** Replaces {page}, {pages} and {date}. */
export function fillPlaceholders(text: string, page: number, pages: number, date: string): string {
  return text.replace(/\{(page|pages|date)\}/g, (_, k: string) => (k === 'page' ? String(page) : k === 'pages' ? String(pages) : date))
}

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const n = m ? parseInt(m[1], 16) : 0
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Adds one text object to a page. Returns false when the text is empty. */
export function addPageText(m: WrappedPdfiumModule, doc: number, page: number, spec: PageText, text: string): boolean {
  if (!text.trim()) return false
  const font = m.FPDFText_LoadStandardFont(doc, spec.font ?? 'Helvetica')
  if (!font) throw new Error(`Could not load the ${spec.font} font`)
  const obj = m.FPDFPageObj_CreateTextObj(doc, font, spec.size)
  m.FPDFFont_Close(font)
  if (!obj) throw new Error('Could not create the text')
  let inserted = false
  try {
    const bytes = (text.length + 1) * 2
    const ptr = m.pdfium.wasmExports.malloc(bytes)
    try {
      m.pdfium.stringToUTF16(text, ptr, bytes)
      if (!m.FPDFText_SetText(obj, ptr)) throw new Error('Could not set the text')
    } finally {
      m.pdfium.wasmExports.free(ptr)
    }
    const [r, g, b] = rgb(spec.color)
    const alpha = Math.round(Math.min(1, Math.max(0, spec.opacity ?? 1)) * 255)
    m.FPDFPageObj_SetFillColor(obj, r, g, b, alpha)

    // The text's own box, at the origin, before it is placed.
    const box = bounds(m, obj)
    const f = pageFrame(m, page)
    const align = spec.kind === 'watermark' ? 'center' : (spec.align ?? 'center')
    const margin = spec.margin ?? 36
    const hx = align === 'left' ? 0 : align === 'right' ? 1 : 0.5
    // Which point of the text box goes on the anchor: top for headers, bottom for footers.
    const vy = spec.kind === 'header' ? 1 : spec.kind === 'footer' ? 0 : 0.5
    const local = { x: box.left + (box.right - box.left) * hx, y: box.bottom + (box.top - box.bottom) * vy }
    const anchor: Point = {
      x: align === 'left' ? margin : align === 'right' ? f.width - margin : f.width / 2,
      y: spec.kind === 'header' ? margin : spec.kind === 'footer' ? f.height - margin : f.height / 2,
    }
    // Text space (y up) to view space (y down), turned counter-clockwise on screen.
    const t = (((spec.kind === 'watermark' ? (spec.rotation ?? 0) : 0) % 360) * Math.PI) / 180
    const view = (p: Point): Point => {
      const dx = p.x - local.x
      const dy = p.y - local.y
      return { x: anchor.x + dx * Math.cos(t) - dy * Math.sin(t), y: anchor.y - dx * Math.sin(t) - dy * Math.cos(t) }
    }
    const p0 = toPage(f, view(local))
    const px = toPage(f, view({ x: local.x + 1, y: local.y }))
    const py = toPage(f, view({ x: local.x, y: local.y + 1 }))
    const a = px.x - p0.x
    const bb = px.y - p0.y
    const c = py.x - p0.x
    const d = py.y - p0.y
    m.FPDFPageObj_Transform(obj, a, bb, c, d, p0.x - (a * local.x + c * local.y), p0.y - (bb * local.x + d * local.y))

    const mark = m.FPDFPageObj_AddMark(obj, 'Artifact')
    if (mark) {
      m.FPDFPageObjMark_SetStringParam(doc, obj, mark, 'Type', 'Pagination')
      m.FPDFPageObjMark_SetStringParam(doc, obj, mark, 'Subtype', SUBTYPE[spec.kind])
    }

    if (spec.kind === 'watermark' && spec.behind) m.FPDFPage_InsertObjectAtIndex(page, obj, 0)
    else m.FPDFPage_InsertObject(page, obj)
    inserted = true
    return true
  } finally {
    if (!inserted) m.FPDFPageObj_Destroy(obj)
  }
}

function bounds(m: WrappedPdfiumModule, obj: number) {
  const p = m.pdfium.wasmExports.malloc(16)
  try {
    if (!m.FPDFPageObj_GetBounds(obj, p, p + 4, p + 8, p + 12)) throw new Error('Could not measure the text')
    return {
      left: m.pdfium.getValue(p, 'float'),
      bottom: m.pdfium.getValue(p + 4, 'float'),
      right: m.pdfium.getValue(p + 8, 'float'),
      top: m.pdfium.getValue(p + 12, 'float'),
    }
  } finally {
    m.pdfium.wasmExports.free(p)
  }
}

/** The artifact Subtype of a page object, if it is one of ours (or Acrobat's). */
function artifactKind(m: WrappedPdfiumModule, obj: number): PageTextKind | null {
  const n = m.FPDFPageObj_CountMarks(obj)
  for (let i = 0; i < n; i++) {
    const mark = m.FPDFPageObj_GetMark(obj, i)
    if (!mark || readMarkString(m, (buf, len, out) => m.FPDFPageObjMark_GetName(mark, buf, len, out)) !== 'Artifact') continue
    const sub = readMarkString(m, (buf, len, out) => m.FPDFPageObjMark_GetParamStringValue(mark, 'Subtype', buf, len, out))
    for (const k of Object.keys(SUBTYPE) as PageTextKind[]) if (SUBTYPE[k] === sub) return k
  }
  return null
}

function readMarkString(m: WrappedPdfiumModule, read: (buf: number, len: number, out: number) => boolean | number): string {
  const out = m.pdfium.wasmExports.malloc(4)
  const len = 256
  const buf = m.pdfium.wasmExports.malloc(len)
  try {
    if (!read(buf, len, out)) return ''
    return m.pdfium.UTF16ToString(buf)
  } finally {
    m.pdfium.wasmExports.free(buf)
    m.pdfium.wasmExports.free(out)
  }
}

/** Removes watermarks, headers or footers of the given kinds; returns how many objects went. */
export function removePageText(m: WrappedPdfiumModule, page: number, kinds: PageTextKind[]): number {
  let removed = 0
  for (let i = m.FPDFPage_CountObjects(page) - 1; i >= 0; i--) {
    const obj = m.FPDFPage_GetObject(page, i)
    if (!obj) continue
    const kind = artifactKind(m, obj)
    if (!kind || !kinds.includes(kind)) continue
    if (m.FPDFPage_RemoveObject(page, obj)) {
      m.FPDFPageObj_Destroy(obj)
      removed++
    }
  }
  return removed
}

/** Kinds of watermark, header or footer found on a page. */
export function pageTextKinds(m: WrappedPdfiumModule, page: number): Set<PageTextKind> {
  const found = new Set<PageTextKind>()
  for (let i = 0; i < m.FPDFPage_CountObjects(page); i++) {
    const obj = m.FPDFPage_GetObject(page, i)
    const k = obj ? artifactKind(m, obj) : null
    if (k) found.add(k)
  }
  return found
}

// ---- Passwords --------------------------------------------------------------

/** What someone who opens the file with the open password (not the permissions password) may do. */
export interface Permissions {
  print: boolean
  copy: boolean
  /** Change pages and content. */
  edit: boolean
  /** Add comments and fill in forms. */
  comment: boolean
}

export interface Security {
  /** The file needs a password, or has restrictions. */
  encrypted: boolean
  /** Opened with the permissions (owner) password, or there is none: security may be changed. */
  ownerUnlocked: boolean
  permissions: Permissions
}

// Permission bits (PDF 32000-1, table 22), 1-based bit positions.
const PRINT = 1 << 2
const MODIFY = 1 << 3
const COPY = 1 << 4
const ANNOTATE = 1 << 5
const FILL = 1 << 8
const ASSEMBLE = 1 << 10
const PRINT_HIGH = 1 << 11

/** The P value for a set of permissions. Unused bits are set, as the spec asks. */
export function permissionBits(p: Permissions): number {
  let denied = 0
  if (!p.print) denied |= PRINT | PRINT_HIGH
  if (!p.edit) denied |= MODIFY | ASSEMBLE
  if (!p.copy) denied |= COPY
  if (!p.comment) denied |= ANNOTATE | FILL
  return -4 & ~denied
}

export function permissionsFrom(bits: number): Permissions {
  return {
    print: (bits & PRINT) !== 0,
    edit: (bits & MODIFY) !== 0,
    copy: (bits & COPY) !== 0,
    comment: (bits & ANNOTATE) !== 0,
  }
}

/**
 * Redaction: removes what lies under marked areas for good, the way Acrobat's
 * "Apply redactions" does, then paints a black box there.
 *
 * - Text: every character touching an area is deleted from the page (and
 *   from form XObjects the page draws).
 * - Images: the pixels under an area are blacked out in the image itself.
 * - Drawings: shapes that sit wholly inside an area are deleted. Shapes that
 *   only overlap one are covered by the box.
 * - Comments and form fields touching an area are deleted, field values first.
 *
 * PDFium still saves objects that nothing uses any more, so after redacting,
 * the file must go through `dropUnreachable` (sweep.ts) before it is kept.
 */
import type { WrappedPdfiumModule } from '@embedpdf/pdfium'
import { pageFrame, viewToBox, type ViewRect } from './annotations'

export interface RedactResult {
  /** Areas applied. */
  areas: number
  /** Drawings deleted because they sat wholly inside an area. */
  shapes: number
  /** Comments and form fields deleted. */
  annotations: number
}

interface Box {
  left: number
  right: number
  bottom: number
  top: number
}

const PATH = 2
const WIDGET = 20
/** Normal, rollover and down appearances. */
const APPEARANCES = [0, 1, 2]
/** Allowance for rounding when deciding if a shape is inside an area. */
const SLACK = 0.5

/** `form` is the document's form handle while the page is loaded into it, or 0 when the file has no form. */
export function redactPage(m: WrappedPdfiumModule, page: number, form: number, areas: ViewRect[], result: RedactResult): void {
  const f = pageFrame(m, page)
  const boxes = areas.filter((r) => r.width > 0 && r.height > 0).map((r) => viewToBox(f, r))
  if (!boxes.length) return
  const mem = m.pdfium.wasmExports.malloc(16)
  try {
    removeAnnotations(m, page, form, boxes, mem, result)
    removeShapes(m, page, boxes, mem, result)
    for (const b of boxes) {
      // FS_RECTF is { left, top, right, bottom }.
      m.pdfium.setValue(mem, b.left, 'float')
      m.pdfium.setValue(mem + 4, b.top, 'float')
      m.pdfium.setValue(mem + 8, b.right, 'float')
      m.pdfium.setValue(mem + 12, b.bottom, 'float')
      if (!m.EPDFText_RedactInRect(page, mem, true, true)) throw new Error('PDFium could not redact the page')
      result.areas++
    }
  } finally {
    m.pdfium.wasmExports.free(mem)
  }
}

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top
const inside = (a: Box, b: Box) =>
  a.left >= b.left - SLACK && a.right <= b.right + SLACK && a.bottom >= b.bottom - SLACK && a.top <= b.top + SLACK

function readRect(m: WrappedPdfiumModule, mem: number): Box {
  const l = m.pdfium.getValue(mem, 'float')
  const t = m.pdfium.getValue(mem + 4, 'float')
  const r = m.pdfium.getValue(mem + 8, 'float')
  const b = m.pdfium.getValue(mem + 12, 'float')
  return { left: Math.min(l, r), right: Math.max(l, r), bottom: Math.min(t, b), top: Math.max(t, b) }
}

function removeAnnotations(m: WrappedPdfiumModule, page: number, form: number, boxes: Box[], mem: number, result: RedactResult) {
  for (let i = m.FPDFPage_GetAnnotCount(page) - 1; i >= 0; i--) {
    const annot = m.FPDFPage_GetAnnot(page, i)
    if (!annot) continue
    let hit = false
    try {
      hit = !!m.FPDFAnnot_GetRect(annot, mem) && boxes.some((b) => overlaps(readRect(m, mem), b))
      if (hit) scrub(m, form, annot)
    } finally {
      m.FPDFPage_CloseAnnot(annot)
    }
    if (hit && m.FPDFPage_RemoveAnnot(page, i)) result.annotations++
  }
}

/**
 * Empties an annotation before it is taken off the page. A form field still
 * points at its widget after removal, and keeps its value, so both the value
 * and the drawn appearance (which shows the value) must go too.
 */
function scrub(m: WrappedPdfiumModule, form: number, annot: number) {
  const p = m.pdfium.wasmExports.malloc(2)
  try {
    m.pdfium.setValue(p, 0, 'i16')
    if (form && m.FPDFAnnot_GetSubtype(annot) === WIDGET) m.EPDFAnnot_SetFormFieldValue(form, annot, p)
    m.FPDFAnnot_SetStringValue(annot, 'Contents', p)
    for (const mode of APPEARANCES) m.FPDFAnnot_SetAP(annot, mode, 0)
  } finally {
    m.pdfium.wasmExports.free(p)
  }
}

function removeShapes(m: WrappedPdfiumModule, page: number, boxes: Box[], mem: number, result: RedactResult) {
  for (let i = m.FPDFPage_CountObjects(page) - 1; i >= 0; i--) {
    const obj = m.FPDFPage_GetObject(page, i)
    if (!obj || m.FPDFPageObj_GetType(obj) !== PATH) continue
    if (!m.FPDFPageObj_GetBounds(obj, mem, mem + 4, mem + 8, mem + 12)) continue
    // GetBounds writes left, bottom, right, top.
    const l = m.pdfium.getValue(mem, 'float')
    const b = m.pdfium.getValue(mem + 4, 'float')
    const r = m.pdfium.getValue(mem + 8, 'float')
    const t = m.pdfium.getValue(mem + 12, 'float')
    const box = { left: l, bottom: b, right: r, top: t }
    if (boxes.some((x) => inside(box, x)) && m.FPDFPage_RemoveObject(page, obj)) {
      m.FPDFPageObj_Destroy(obj)
      result.shapes++
    }
  }
}

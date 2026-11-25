/**
 * Puts recognised text on scanned pages as an invisible layer, the way
 * Acrobat's "Recognize text" does: the page looks the same, but its words can
 * be searched, selected and copied. Each word is a text object in render mode
 * 3 (invisible), stretched over the box where the word sits in the scan.
 *
 * The recognising itself (Tesseract) runs outside the engine; this file only
 * writes the words it found into the PDF.
 */
import type { WrappedPdfiumModule } from '@embedpdf/pdfium'
import { pageFrame, toPage, type Point } from './annotations'

/** A recognised word, in view points from the top-left of the page as displayed. */
export interface OcrWord {
  text: string
  x: number
  y: number
  width: number
  height: number
}

const INVISIBLE = 3

/** Adds the words as invisible text; returns how many were added. */
export function addOcrWords(m: WrappedPdfiumModule, doc: number, page: number, words: OcrWord[]): number {
  const f = pageFrame(m, page)
  const font = m.FPDFText_LoadStandardFont(doc, 'Helvetica')
  if (!font) throw new Error('Could not load the Helvetica font')
  let added = 0
  try {
    for (const w of words) {
      const text = w.text.trim()
      if (!text || w.width <= 0 || w.height <= 0) continue
      const obj = m.FPDFPageObj_CreateTextObj(doc, font, w.height)
      if (!obj) continue
      let inserted = false
      try {
        if (!setText(m, obj, text)) continue
        m.FPDFTextObj_SetTextRenderMode(obj, INVISIBLE)
        const box = bounds(m, obj)
        if (!box || box.right <= box.left || box.top <= box.bottom) continue
        // Stretch the word's own box over the box it has in the scan.
        const sx = w.width / (box.right - box.left)
        const sy = w.height / (box.top - box.bottom)
        const view = (p: Point): Point => ({ x: w.x + (p.x - box.left) * sx, y: w.y + w.height - (p.y - box.bottom) * sy })
        const o = { x: box.left, y: box.bottom }
        const p0 = toPage(f, view(o))
        const px = toPage(f, view({ x: o.x + 1, y: o.y }))
        const py = toPage(f, view({ x: o.x, y: o.y + 1 }))
        const a = px.x - p0.x
        const b = px.y - p0.y
        const c = py.x - p0.x
        const d = py.y - p0.y
        m.FPDFPageObj_Transform(obj, a, b, c, d, p0.x - (a * o.x + c * o.y), p0.y - (b * o.x + d * o.y))
        m.FPDFPage_InsertObject(page, obj)
        inserted = true
        added++
      } finally {
        if (!inserted) m.FPDFPageObj_Destroy(obj)
      }
    }
  } finally {
    m.FPDFFont_Close(font)
  }
  return added
}

function setText(m: WrappedPdfiumModule, obj: number, text: string): boolean {
  const bytes = (text.length + 1) * 2
  const ptr = m.pdfium.wasmExports.malloc(bytes)
  try {
    m.pdfium.stringToUTF16(text, ptr, bytes)
    return !!m.FPDFText_SetText(obj, ptr)
  } finally {
    m.pdfium.wasmExports.free(ptr)
  }
}

function bounds(m: WrappedPdfiumModule, obj: number) {
  const p = m.pdfium.wasmExports.malloc(16)
  try {
    if (!m.FPDFPageObj_GetBounds(obj, p, p + 4, p + 8, p + 12)) return null
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

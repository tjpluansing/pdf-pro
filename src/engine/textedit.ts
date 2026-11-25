/**
 * Editing text already on a page, a line at a time, the way Acrobat's
 * "Edit text" lets you click into a line and retype it.
 *
 * A PDF has no lines or paragraphs, only text objects placed at positions;
 * one visual line is often several objects (a run per word, or per style).
 * `readLines` groups objects that share a baseline, size and colour into a
 * line. `replaceLine` swaps a line's objects for one new object at the same
 * spot, in the same font, size and colour.
 *
 * Embedded fonts usually hold only the letters the file already uses. New
 * text keeps the file's font when every letter in it already appears in that
 * font on the page, or when the font isn't embedded at all; otherwise it switches to the closest standard PDF font
 * (sans, serif or monospace, bold and italic matched), and says so.
 */
import type { WrappedPdfiumModule } from '@embedpdf/pdfium'
import { boxToView, pageFrame, type ViewRect } from './annotations'

export interface TextLine {
  pageIndex: number
  /** Indexes of the line's text objects on the page, in reading order. */
  objects: number[]
  text: string
  /** View points from the top-left of the page as displayed. */
  rect: ViewRect
  /** Size the text appears at, in points. */
  size: number
  /** The font's PostScript name, e.g. "Carlito-Bold". */
  font: string
  color: string
  bold: boolean
  italic: boolean
  serif: boolean
  mono: boolean
}

export interface ReplaceResult {
  /** Set when the file's font lacked a letter and a standard font was used instead. */
  substitute?: string
}

const TEXT = 1
const INVISIBLE = 3
// FPDFFont_GetFlags bits (PDF font descriptor flags).
const FIXED_PITCH = 1
const SERIF = 1 << 1
const ITALIC = 1 << 6
const FORCE_BOLD = 1 << 18

interface Run {
  index: number
  obj: number
  text: string
  font: number
  size: number
  /** a b c d e f */
  matrix: number[]
  left: number
  right: number
  bottom: number
  top: number
  rgba: [number, number, number, number]
  mode: number
}

export function readLines(m: WrappedPdfiumModule, page: number, textPage: number, pageIndex: number): TextLine[] {
  const runs = readRuns(m, page, textPage)
  const lines: Run[][] = []
  // Unrotated runs group into lines; anything turned stays on its own.
  const flat = runs.filter((r) => Math.abs(r.matrix[1]) < 1e-3 && Math.abs(r.matrix[2]) < 1e-3)
  const turned = runs.filter((r) => !flat.includes(r))
  flat.sort((a, b) => b.matrix[5] - a.matrix[5] || a.left - b.left)
  for (const r of flat) {
    const line = lines.find((l) => joins(l[l.length - 1], r))
    if (line) line.push(r)
    else lines.push([r])
  }
  for (const r of turned) lines.push([r])
  const f = pageFrame(m, page)
  return lines.map((l) => describe(m, f, pageIndex, l))
}

/** True when `next` continues the line that `prev` ends. */
function joins(prev: Run, next: Run): boolean {
  const size = effective(prev)
  return (
    Math.abs(effective(next) - size) < 0.5 &&
    Math.abs(next.matrix[5] - prev.matrix[5]) < size * 0.3 &&
    next.left - prev.right > -size * 0.3 &&
    next.left - prev.right < size * 1.2 &&
    prev.rgba.every((c, i) => c === next.rgba[i])
  )
}

const effective = (r: Run) => r.size * Math.hypot(r.matrix[2], r.matrix[3])

function describe(m: WrappedPdfiumModule, f: ReturnType<typeof pageFrame>, pageIndex: number, runs: Run[]): TextLine {
  let text = ''
  runs.forEach((r, i) => {
    const prev = runs[i - 1]
    const gap = prev ? r.left - prev.right : 0
    if (prev && gap > effective(r) * 0.15 && !text.endsWith(' ') && !r.text.startsWith(' ')) text += ' '
    text += r.text
  })
  const first = runs[0]
  const left = Math.min(...runs.map((r) => r.left))
  const right = Math.max(...runs.map((r) => r.right))
  const bottom = Math.min(...runs.map((r) => r.bottom))
  const top = Math.max(...runs.map((r) => r.top))
  const style = fontStyle(m, first.font)
  return {
    pageIndex,
    objects: runs.map((r) => r.index),
    text,
    rect: boxToView(f, left, top, right, bottom),
    size: effective(first),
    color: '#' + first.rgba.slice(0, 3).map((c) => c.toString(16).padStart(2, '0')).join(''),
    ...style,
  }
}

function readRuns(m: WrappedPdfiumModule, page: number, textPage: number): Run[] {
  const runs: Run[] = []
  const buf = m.pdfium.wasmExports.malloc(64)
  try {
    const n = m.FPDFPage_CountObjects(page)
    for (let index = 0; index < n; index++) {
      const obj = m.FPDFPage_GetObject(page, index)
      if (!obj || m.FPDFPageObj_GetType(obj) !== TEXT) continue
      const mode = m.FPDFTextObj_GetTextRenderMode(obj)
      if (mode === INVISIBLE) continue
      const text = objectText(m, obj, textPage)
      if (!text.trim()) continue
      if (!m.FPDFTextObj_GetFontSize(obj, buf)) continue
      const size = m.pdfium.getValue(buf, 'float')
      if (!m.FPDFPageObj_GetMatrix(obj, buf)) continue
      const matrix = [0, 1, 2, 3, 4, 5].map((k) => m.pdfium.getValue(buf + 4 * k, 'float'))
      if (!m.FPDFPageObj_GetBounds(obj, buf, buf + 4, buf + 8, buf + 12)) continue
      const [left, bottom, right, top] = [0, 1, 2, 3].map((k) => m.pdfium.getValue(buf + 4 * k, 'float'))
      const rgba: [number, number, number, number] = [0, 0, 0, 255]
      if (m.FPDFPageObj_GetFillColor(obj, buf, buf + 4, buf + 8, buf + 12)) {
        for (let k = 0; k < 4; k++) rgba[k] = m.pdfium.getValue(buf + 4 * k, 'i32') >>> 0
      }
      runs.push({ index, obj, text, font: m.FPDFTextObj_GetFont(obj), size, matrix, left, right, bottom, top, rgba, mode })
    }
  } finally {
    m.pdfium.wasmExports.free(buf)
  }
  return runs
}

function objectText(m: WrappedPdfiumModule, obj: number, textPage: number): string {
  const len = m.FPDFTextObj_GetText(obj, textPage, 0, 0)
  if (len <= 2) return ''
  const buf = m.pdfium.wasmExports.malloc(len)
  try {
    m.FPDFTextObj_GetText(obj, textPage, buf, len)
    // PDFium reports a soft hyphen at a line break as U+0002.
    return m.pdfium.UTF16ToString(buf).replaceAll(String.fromCharCode(2), '-')
  } finally {
    m.pdfium.wasmExports.free(buf)
  }
}

function fontName(m: WrappedPdfiumModule, font: number): string {
  const len = m.FPDFFont_GetBaseFontName(font, 0, 0)
  if (len <= 1) return ''
  const buf = m.pdfium.wasmExports.malloc(len)
  try {
    m.FPDFFont_GetBaseFontName(font, buf, len)
    // Subset fonts carry a six-letter tag: "ABCDEF+Carlito-Bold".
    return m.pdfium.UTF8ToString(buf).replace(/^[A-Z]{6}\+/, '')
  } finally {
    m.pdfium.wasmExports.free(buf)
  }
}

function fontStyle(m: WrappedPdfiumModule, font: number) {
  const name = fontName(m, font)
  const flags = m.FPDFFont_GetFlags(font)
  const weight = m.FPDFFont_GetWeight(font)
  return {
    font: name,
    bold: /bold|black|heavy|semibold|demi/i.test(name) || (flags & FORCE_BOLD) !== 0 || weight >= 600,
    italic: /italic|oblique/i.test(name) || (flags & ITALIC) !== 0,
    serif: !/sans/i.test(name) && (/times|roman|serif|georgia|garamond|cambria|caladea|book|minion|palatino|tinos/i.test(name) || (flags & SERIF) !== 0),
    mono: /courier|mono|consol|cousine/i.test(name) || (flags & FIXED_PITCH) !== 0,
  }
}

/** The standard PDF font closest to a line's own. */
export function standardFor(style: Pick<TextLine, 'bold' | 'italic' | 'serif' | 'mono'>): string {
  if (style.mono) return ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'][+style.bold + 2 * +style.italic]
  if (style.serif) return ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'][+style.bold + 2 * +style.italic]
  return ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'][+style.bold + 2 * +style.italic]
}

/** Characters the standard fonts can show (Windows-1252). */
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'
const standardCanShow = (ch: string) => {
  const c = ch.codePointAt(0)!
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch)
}

/**
 * Replaces a line's text objects with one object holding `text`, placed and
 * styled like the line's first object. Empty text deletes the line.
 * `expected` must match the line's current text, so a stale edit can't hit
 * the wrong objects.
 */
export function replaceLine(
  m: WrappedPdfiumModule,
  doc: number,
  page: number,
  textPage: number,
  pageIndex: number,
  objects: number[],
  expected: string,
  text: string,
): ReplaceResult {
  const line = readLines(m, page, textPage, pageIndex).find((l) => l.objects.join() === objects.join())
  if (!line || line.text !== expected) throw new Error('This text has changed since it was selected. Click it again to edit.')
  const runs = readRuns(m, page, textPage)
  const first = runs.find((r) => r.index === objects[0])!
  const result: ReplaceResult = {}

  let obj = 0
  const clean = text.replace(/[\r\n\t]+/g, ' ')
  if (clean.trim()) {
    // Letters this font already draws somewhere on the page are safe to reuse.
    const known = new Set(runs.filter((r) => r.font === first.font).flatMap((r) => [...r.text]))
    // A font that isn't embedded is drawn from the reader's own copy, which has every common letter.
    const embedded = !!m.FPDFFont_GetIsEmbedded(first.font)
    const reuse = [...clean].every((ch) => ch === ' ' || known.has(ch) || (!embedded && standardCanShow(ch)))
    let font = first.font
    let loaded = 0
    if (!reuse) {
      const name = standardFor(line)
      const missing = [...clean].filter((ch) => !standardCanShow(ch))
      if (missing.length) throw new Error(`The letters ${[...new Set(missing)].join(' ')} can't be added to this text yet`)
      loaded = font = m.FPDFText_LoadStandardFont(doc, name)
      if (!font) throw new Error(`Could not load the ${name} font`)
      result.substitute = name
    }
    try {
      obj = m.FPDFPageObj_CreateTextObj(doc, font, first.size)
      if (!obj) throw new Error('PDFium could not create the text')
      if (!setText(m, obj, clean)) throw new Error('PDFium could not set the text')
      m.FPDFPageObj_SetFillColor(obj, ...first.rgba)
      m.FPDFTextObj_SetTextRenderMode(obj, first.mode)
      const mat = m.pdfium.wasmExports.malloc(24)
      try {
        first.matrix.forEach((v, k) => m.pdfium.setValue(mat + 4 * k, v, 'float'))
        m.FPDFPageObj_SetMatrix(obj, mat)
      } finally {
        m.pdfium.wasmExports.free(mat)
      }
    } catch (err) {
      if (obj) m.FPDFPageObj_Destroy(obj)
      throw err
    } finally {
      if (loaded) m.FPDFFont_Close(loaded)
    }
  }

  // Take the old objects out from the end, so the earlier indexes stay valid.
  for (const index of [...objects].sort((a, b) => b - a)) {
    const old = m.FPDFPage_GetObject(page, index)
    if (old && m.FPDFPage_RemoveObject(page, old)) m.FPDFPageObj_Destroy(old)
  }
  if (obj && !m.FPDFPage_InsertObjectAtIndex(page, obj, Math.min(...objects))) m.FPDFPage_InsertObject(page, obj)
  return result
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

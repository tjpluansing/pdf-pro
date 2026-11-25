import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib'
import { PdfEngine, PdfError } from '../src/engine/pdfium'

const require = createRequire(import.meta.url)
let engine: PdfEngine

beforeAll(async () => {
  engine = await PdfEngine.create(readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm')))
})

/** Two pages with known text, plus a one-entry outline pointing at page 2. */
async function sample(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const p1 = doc.addPage([300, 400])
  p1.drawRectangle({ x: 0, y: 0, width: 150, height: 400, color: rgb(0, 0, 0) })
  p1.drawText('Invoice total due', { x: 160, y: 300, font, size: 12 })
  const p2 = doc.addPage([612, 792])
  p2.drawText('Second page mentions the invoice again', { x: 50, y: 700, font, size: 12 })

  const item = doc.context.obj({ Title: PDFString.of('Chapter two'), Dest: [p2.ref, PDFName.of('Fit')] })
  const itemRef = doc.context.register(item)
  const outlines = doc.context.obj({ Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1 })
  const outlinesRef = doc.context.register(outlines)
  item.set(PDFName.of('Parent'), outlinesRef)
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef)
  return doc.save()
}

describe('PdfEngine', () => {
  it('reads page count and sizes in points', async () => {
    const doc = engine.open(await sample())
    expect(doc.pageCount).toBe(2)
    expect(doc.pageSize(0)).toEqual({ width: 300, height: 400 })
    expect(doc.pageSize(1)).toEqual({ width: 612, height: 792 })
    doc.close()
  })

  it('renders RGBA pixels at the requested scale', async () => {
    const doc = engine.open(await sample())
    const page = doc.renderPage(0, 0.5)
    expect([page.width, page.height]).toEqual([150, 200])
    const px = (x: number, y: number) => Array.from(page.data.slice((y * page.width + x) * 4, (y * page.width + x) * 4 + 4))
    expect(px(10, 100)).toEqual([0, 0, 0, 255]) // black rectangle on the left half
    expect(px(140, 10)).toEqual([255, 255, 255, 255]) // white background
    doc.close()
  })

  it('extracts page text', async () => {
    const doc = engine.open(await sample())
    expect(doc.pageText(0)).toContain('Invoice total due')
    doc.close()
  })

  it('finds matches on every page, case-insensitively, with top-left rects', async () => {
    const doc = engine.open(await sample())
    const hits = doc.search('INVOICE')
    expect(hits.map((h) => h.pageIndex)).toEqual([0, 1])
    const [first] = hits
    expect(first.length).toBe(7)
    expect(first.rects).toHaveLength(1)
    const r = first.rects[0]
    // Text baseline is 300pt from the bottom of a 400pt page, so ~100pt from the top.
    expect(r.x).toBeGreaterThanOrEqual(159)
    expect(r.y).toBeGreaterThan(85)
    expect(r.y + r.height).toBeLessThan(102)
    doc.close()
  })

  it('reads the outline with resolved page targets', async () => {
    const doc = engine.open(await sample())
    expect(doc.outline()).toEqual([{ title: 'Chapter two', pageIndex: 1, children: [] }])
    doc.close()
  })

  it('throws a typed error for bytes that are not a PDF', () => {
    expect(() => engine.open(new TextEncoder().encode('not a pdf'))).toThrowError(PdfError)
    try {
      engine.open(new TextEncoder().encode('not a pdf'))
    } catch (e) {
      expect((e as PdfError).code).toBe('format')
    }
  })

  it('rejects out-of-range pages', async () => {
    const doc = engine.open(await sample())
    expect(() => doc.renderPage(2, 1)).toThrowError(/out of range/)
    doc.close()
  })
})

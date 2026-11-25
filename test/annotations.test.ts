import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees } from 'pdf-lib'
import { PdfEngine, type PdfDocument } from '../src/engine/pdfium'
import { parsePdfDate } from '../src/engine/annotations'

const require = createRequire(import.meta.url)
let engine: PdfEngine

beforeAll(async () => {
  engine = await PdfEngine.create(readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm')))
})

async function textPdf(rotate = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 300])
  page.drawText('Hello annotated world', { x: 40, y: 220, font, size: 20 })
  if (rotate) page.setRotation(degrees(rotate))
  return doc.save()
}

function reopen(doc: PdfDocument): PdfDocument {
  const bytes = doc.save()
  doc.close()
  return engine.open(bytes)
}

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.6)

describe('text layout', () => {
  it('gives each character a box where it is drawn', async () => {
    const doc = engine.open(await textPdf())
    const { text, boxes } = doc.textLayout(0)
    expect(text.startsWith('Hello annotated world')).toBe(true)
    // "H" sits at x=40, baseline 300-220 = 80 from the top.
    near(boxes[0], 40)
    expect(boxes[1]).toBeLessThan(80)
    expect(boxes[1] + boxes[3]).toBeGreaterThan(78)
    doc.close()
  })
})

describe('annotations', () => {
  it('adds every kind and reads them back after saving', async () => {
    let doc = engine.open(await textPdf())
    const { boxes } = doc.textLayout(0)
    const word = { x: boxes[0], y: boxes[1], width: boxes[4 * 4] + boxes[4 * 4 + 2] - boxes[0], height: boxes[3] }
    const ids = [
      doc.addAnnotation({ kind: 'highlight', pageIndex: 0, color: '#ffd400', quads: [word], contents: 'Look', author: 'Paolo' }),
      doc.addAnnotation({ kind: 'underline', pageIndex: 0, color: '#2a7ae2', quads: [word] }),
      doc.addAnnotation({ kind: 'strikeout', pageIndex: 0, color: '#d93025', quads: [word] }),
      doc.addAnnotation({ kind: 'note', pageIndex: 0, color: '#ffd400', rect: { x: 300, y: 20, width: 20, height: 20 }, contents: 'A note' }),
      doc.addAnnotation({ kind: 'freetext', pageIndex: 0, color: '#000000', rect: { x: 40, y: 150, width: 200, height: 30 }, contents: 'Typed text', fontSize: 14 }),
      doc.addAnnotation({ kind: 'ink', pageIndex: 0, color: '#d93025', ink: [[{ x: 50, y: 200 }, { x: 80, y: 230 }, { x: 120, y: 210 }]] }),
      doc.addAnnotation({ kind: 'square', pageIndex: 0, color: '#2a7ae2', rect: { x: 200, y: 200, width: 60, height: 40 } }),
      doc.addAnnotation({ kind: 'circle', pageIndex: 0, color: '#2a7ae2', fill: '#e8f0fe', rect: { x: 280, y: 200, width: 60, height: 40 } }),
      doc.addAnnotation({ kind: 'arrow', pageIndex: 0, color: '#000000', line: [{ x: 50, y: 280 }, { x: 150, y: 260 }] }),
    ]
    doc = reopen(doc)
    const list = doc.annotations(0)
    expect(list.map((a) => a.kind)).toEqual(['highlight', 'underline', 'strikeout', 'note', 'freetext', 'ink', 'square', 'circle', 'arrow'])
    expect(list.map((a) => a.id)).toEqual(ids)
    const [hl, , , note, , ink, square, circle, arrow] = list
    expect(hl).toMatchObject({ color: '#ffd400', contents: 'Look', author: 'Paolo', subtype: 'Highlight' })
    expect(hl.quads).toHaveLength(1)
    near(hl.quads![0].x, word.x)
    near(hl.quads![0].y, word.y)
    expect(hl.modified).not.toBeNull()
    expect(note.contents).toBe('A note')
    expect(list[4]).toMatchObject({ kind: 'freetext', contents: 'Typed text', color: '#000000' })
    expect(ink.ink![0]).toHaveLength(3)
    near(ink.ink![0][1].x, 80)
    near(ink.ink![0][1].y, 230)
    near(square.rect.x, 200)
    near(square.rect.y, 200)
    near(square.rect.width, 60)
    expect(circle.fill).toBe('#e8f0fe')
    near(arrow.line![1].x, 150)
    near(arrow.line![1].y, 260)
    doc.close()
  })

  it('draws markup into the rendered page', async () => {
    const doc = engine.open(await textPdf())
    const blank = doc.renderPage(0, 1).data
    doc.addAnnotation({ kind: 'square', pageIndex: 0, color: '#ff0000', fill: '#ff0000', rect: { x: 300, y: 200, width: 40, height: 40 } })
    const marked = doc.renderPage(0, 1)
    const at = (d: Uint8ClampedArray, x: number, y: number) => Array.from(d.slice((y * marked.width + x) * 4, (y * marked.width + x) * 4 + 3))
    expect(at(blank, 320, 220)).toEqual([255, 255, 255])
    const [r, g, b] = at(marked.data, 320, 220)
    expect(r).toBeGreaterThan(200)
    expect(g + b).toBeLessThan(80)
    doc.close()
  })

  it('changes and removes annotations', async () => {
    let doc = engine.open(await textPdf())
    const id = doc.addAnnotation({ kind: 'note', pageIndex: 0, color: '#ffd400', rect: { x: 10, y: 10, width: 20, height: 20 }, contents: 'first' })
    const keep = doc.addAnnotation({ kind: 'square', pageIndex: 0, color: '#000000', rect: { x: 100, y: 100, width: 20, height: 20 } })
    doc.updateAnnotation(0, id, { contents: 'second', color: '#2a7ae2', moveTo: { x: 50, y: 60 } })
    doc = reopen(doc)
    const [note] = doc.annotations(0)
    expect(note).toMatchObject({ contents: 'second', color: '#2a7ae2' })
    near(note.rect.x, 50)
    near(note.rect.y, 60)
    doc.removeAnnotation(0, id)
    doc = reopen(doc)
    expect(doc.annotations(0).map((a) => a.id)).toEqual([keep])
    expect(() => doc.removeAnnotation(0, id)).toThrow()
    doc.close()
  })

  it('places annotations where they were drawn on a rotated page', async () => {
    for (const rotate of [90, 180, 270]) {
      let doc = engine.open(await textPdf(rotate))
      expect(doc.pageSize(0).width).toBe(rotate === 180 ? 400 : 300)
      doc.addAnnotation({ kind: 'square', pageIndex: 0, color: '#000000', rect: { x: 30, y: 40, width: 50, height: 20 } })
      doc = reopen(doc)
      const [sq] = doc.annotations(0)
      near(sq.rect.x, 30)
      near(sq.rect.y, 40)
      near(sq.rect.width, 50)
      near(sq.rect.height, 20)
      // Search highlights must line up with the rotated text too.
      const [hit] = doc.search('H')
      const { boxes } = doc.textLayout(0)
      const r = hit.rects[0]
      const cx = boxes[0] + boxes[2] / 2
      const cy = boxes[1] + boxes[3] / 2
      expect(cx > r.x && cx < r.x + r.width && cy > r.y && cy < r.y + r.height).toBe(true)
      doc.close()
    }
  })

  it('reads comments that other apps wrote without an id', async () => {
    const src = await PDFDocument.create()
    const page = src.addPage([300, 300])
    const annot = src.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [10, 260, 30, 280],
      Contents: PDFString.of('From another app'),
      T: PDFString.of('Ana'),
      C: [1, 0, 0],
    })
    page.node.set(PDFName.of('Annots'), src.context.obj([src.context.register(annot)]))
    const doc = engine.open(await src.save())
    const [a] = doc.annotations(0)
    expect(a).toMatchObject({ id: '#0', kind: 'note', contents: 'From another app', author: 'Ana', color: '#ff0000' })
    near(a.rect.x, 10)
    near(a.rect.y, 20)
    doc.removeAnnotation(0, '#0')
    expect(doc.annotations(0)).toEqual([])
    doc.close()
  })
})

describe('PDF dates', () => {
  it('parses the common forms', () => {
    expect(parsePdfDate("D:20261125113000+01'00'")).toBe('2026-11-25T10:30:00.000Z')
    expect(parsePdfDate('D:20261125113000Z')).toBe('2026-11-25T11:30:00.000Z')
    expect(parsePdfDate('D:2026')).toBe('2026-01-01T00:00:00.000Z')
    expect(parsePdfDate('nonsense')).toBeNull()
  })
})

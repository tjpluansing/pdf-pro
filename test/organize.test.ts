import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { PdfEngine, type PdfDocument } from '../src/engine/pdfium'

const require = createRequire(import.meta.url)
let engine: PdfEngine

beforeAll(async () => {
  engine = await PdfEngine.create(readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm')))
})

/** A PDF whose pages say "A1", "A2", … so order can be checked from the text. */
async function labelled(prefix: string, count: number, size: [number, number] = [300, 400]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= count; i++) doc.addPage(size).drawText(`${prefix}${i}`, { x: 20, y: 200, font, size: 24 })
  return doc.save()
}

const labels = (doc: PdfDocument) => Array.from({ length: doc.pageCount }, (_, i) => doc.pageText(i).trim())

/** Save and reopen, so each check also proves the edit survives being written to a file. */
function roundTrip(doc: PdfDocument): PdfDocument {
  const bytes = doc.save()
  doc.close()
  return engine.open(bytes)
}

describe('organizing pages', () => {
  it('deletes pages', async () => {
    let doc = engine.open(await labelled('A', 5))
    doc.deletePages([1, 3])
    doc = roundTrip(doc)
    expect(labels(doc)).toEqual(['A1', 'A3', 'A5'])
    doc.close()
  })

  it('refuses to delete every page', async () => {
    const doc = engine.open(await labelled('A', 2))
    expect(() => doc.deletePages([0, 1])).toThrowError(/at least one page/)
    expect(doc.pageCount).toBe(2)
    doc.close()
  })

  it('rotates pages and swaps their reported size', async () => {
    let doc = engine.open(await labelled('A', 2))
    doc.rotatePages([0], 90)
    doc.rotatePages([1], -90)
    doc = roundTrip(doc)
    expect([doc.pageRotation(0), doc.pageRotation(1)]).toEqual([90, 270])
    expect(doc.pageSize(0)).toEqual({ width: 400, height: 300 })
    doc.rotatePages([0], 270)
    expect(doc.pageRotation(0)).toBe(0)
    doc.close()
  })

  it('moves pages to a new position, keeping their order', async () => {
    let doc = engine.open(await labelled('A', 5))
    doc.movePages([3, 4], 0)
    doc = roundTrip(doc)
    expect(labels(doc)).toEqual(['A4', 'A5', 'A1', 'A2', 'A3'])
    doc.movePages([0], 4)
    expect(labels(doc)).toEqual(['A5', 'A1', 'A2', 'A3', 'A4'])
    doc.close()
  })

  it('inserts pages from another file, merges at the end by default', async () => {
    let doc = engine.open(await labelled('A', 2))
    const other = engine.open(await labelled('B', 3, [612, 792]))
    doc.insertPagesFrom(other, [2, 0], 1)
    doc.insertPagesFrom(other)
    other.close()
    doc = roundTrip(doc)
    expect(labels(doc)).toEqual(['A1', 'B3', 'B1', 'A2', 'B1', 'B2', 'B3'])
    expect(doc.pageSize(1)).toEqual({ width: 612, height: 792 })
    doc.close()
  })

  it('extracts pages into a new file without changing the original', async () => {
    const doc = engine.open(await labelled('A', 4))
    const part = engine.open(doc.extractPages([3, 1]))
    expect(labels(part)).toEqual(['A4', 'A2'])
    expect(doc.pageCount).toBe(4)
    part.close()
    doc.close()
  })

  it('saves an unedited document that reopens with the same text', async () => {
    const doc = engine.open(await labelled('A', 3))
    const again = roundTrip(doc)
    expect(labels(again)).toEqual(['A1', 'A2', 'A3'])
    again.close()
  })

  it('edits a password-protected file and saves a copy that still needs the password', () => {
    // Undo in the viewer reopens a saved snapshot with the original password, so this must hold.
    const fixture = readFileSync(new URL('./fixtures/encrypted-aes256.pdf', import.meta.url))
    const doc = engine.open(new Uint8Array(fixture), 'secret')
    doc.rotatePages([0], 90)
    const bytes = doc.save()
    doc.close()
    expect(() => engine.open(bytes)).toThrow(expect.objectContaining({ code: 'password' }))
    const again = engine.open(bytes, 'secret')
    expect(again.pageRotation(0)).toBe(90)
    again.close()
  })
})

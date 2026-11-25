import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { inflateSync } from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'
import jpeg from 'jpeg-js'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { PdfEngine } from '../src/engine/pdfium'
import { dropUnreachable } from '../src/engine/sweep'

const require = createRequire(import.meta.url)
let engine: PdfEngine

beforeAll(async () => {
  engine = await PdfEngine.create(readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm')))
})

/** Every stream in the file, inflated where possible, as one string: what a snooper could read. */
function rawText(bytes: Uint8Array): string {
  const s = Buffer.from(bytes).toString('latin1')
  let out = s
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    try {
      out += inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1')
    } catch {
      /* not deflated */
    }
  }
  return out
}

/** Page 1: a secret line, a kept line, a grey photo, a small shape and a big shape, a comment and a filled field. */
async function sample(rotate = 0) {
  const d = await PDFDocument.create()
  const f = await d.embedFont(StandardFonts.Helvetica)
  const p = d.addPage([612, 792])
  p.setRotation(degrees(rotate))
  p.drawText('Account SECRET-7731 belongs to Jane', { x: 50, y: 700, size: 14, font: f })
  p.drawText('Keep this line', { x: 50, y: 660, size: 14, font: f })
  const px = Buffer.alloc(100 * 100 * 4, 0x80)
  for (let i = 3; i < px.length; i += 4) px[i] = 255
  p.drawImage(await d.embedJpg(new Uint8Array(jpeg.encode({ data: px, width: 100, height: 100 }, 90).data)), { x: 50, y: 400, width: 200, height: 200 })
  p.drawRectangle({ x: 320, y: 420, width: 40, height: 40, color: rgb(0, 0.5, 1) })
  p.drawRectangle({ x: 300, y: 300, width: 250, height: 50, color: rgb(1, 0.8, 0) })
  const tf = d.getForm().createTextField('ssn')
  tf.setText('987-65-4320')
  tf.addToPage(p, { x: 50, y: 200, width: 200, height: 24, font: f })
  return d.save()
}

describe('redact', () => {
  it('removes text, image pixels, enclosed shapes and fields under the marks for good', async () => {
    const doc = engine.open(await sample())
    doc.addAnnotation({ kind: 'freetext', pageIndex: 0, color: '#000000', contents: 'Comment PRIVATE-NOTE-55', rect: { x: 300, y: 450, width: 200, height: 30 } }, 'c1')
    const before = doc.pageText(0)
    expect(before).toContain('SECRET-7731')
    // View points from the top-left: page height 792, so y = 792 - top.
    const result = doc.redact([
      { pageIndex: 0, rect: { x: 100, y: 78, width: 130, height: 22 } }, // over "SECRET-7731"
      { pageIndex: 0, rect: { x: 100, y: 242, width: 300, height: 140 } }, // half the photo and the whole small shape
      { pageIndex: 0, rect: { x: 40, y: 560, width: 220, height: 40 } }, // the form field
      { pageIndex: 0, rect: { x: 310, y: 455, width: 50, height: 10 } }, // part of the comment
    ])
    expect(result.areas).toBe(4)
    expect(result.shapes).toBe(1)
    expect(result.annotations).toBe(2)
    const text = doc.pageText(0)
    expect(text).not.toContain('SECRET')
    expect(text).toContain('Keep this line')
    expect(text).toContain('Jane')

    // PDFium keeps orphaned objects, such as the comment's old appearance; the sweep drops them.
    expect(rawText(doc.save())).toContain('PRIVATE-NOTE')
    const { bytes: saved, dropped } = await dropUnreachable(doc.save())
    expect(dropped).toBeGreaterThan(0)
    const raw = rawText(saved)
    expect(raw).not.toContain('SECRET')
    expect(raw).not.toContain('987-65-4320')
    expect(raw).not.toContain('PRIVATE-NOTE')
    expect(raw.toLowerCase()).not.toContain(Buffer.from('PRIVATE', 'utf16le').swap16().toString('hex'))
    expect(raw.toLowerCase()).not.toContain(Buffer.from('987-65-4320').toString('hex'))
    doc.close()

    const again = engine.open(saved)
    const lib = await PDFDocument.load(saved)
    // PDFium can't delete a field outright: its value and look are emptied and it leaves the page.
    expect(lib.getForm().getTextField('ssn').getText() ?? '').toBe('')
    expect(lib.getPage(0).node.Annots()?.size() ?? 0).toBe(0)
    again.close()
  })

  it('places marks correctly on a rotated page', async () => {
    const doc = engine.open(await sample(90))
    // Rotated 90° clockwise, the page shows 792 wide by 612 high; the secret line runs down the right-hand side.
    const layout = doc.search('SECRET-7731')
    expect(layout).toHaveLength(1)
    const hit = layout[0]
    doc.redact(hit.rects.map((rect) => ({ pageIndex: 0, rect })))
    const text = doc.pageText(0)
    expect(text).not.toContain('SECRET')
    expect(text).toContain('Jane')
    doc.close()
  })

  it('does nothing for empty marks', async () => {
    const doc = engine.open(await sample())
    expect(doc.redact([{ pageIndex: 0, rect: { x: 10, y: 10, width: 0, height: 5 } }]).areas).toBe(0)
    expect(doc.pageText(0)).toContain('SECRET-7731')
    doc.close()
  })
})

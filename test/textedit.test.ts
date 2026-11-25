import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { PdfEngine } from '../src/engine/pdfium'
import { standardFor } from '../src/engine/textedit'

const require = createRequire(import.meta.url)
let engine: PdfEngine

beforeAll(async () => {
  engine = await PdfEngine.create(readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm')))
})

/** A heading, a line split into two runs (regular then bold), and a red line. */
async function sample(rotate = 0) {
  const d = await PDFDocument.create()
  const reg = await d.embedFont(StandardFonts.Helvetica)
  const bold = await d.embedFont(StandardFonts.HelveticaBold)
  const times = await d.embedFont(StandardFonts.TimesRoman)
  const p = d.addPage([612, 792])
  p.setRotation(degrees(rotate))
  p.drawText('Invoice 2041', { x: 50, y: 720, size: 24, font: times })
  p.drawText('Total due:', { x: 50, y: 680, size: 12, font: reg })
  p.drawText('$1,200', { x: 50 + reg.widthOfTextAtSize('Total due: ', 12), y: 680, size: 12, font: reg })
  p.drawText('Overdue', { x: 50, y: 650, size: 12, font: bold, color: rgb(0.8, 0, 0) })
  return d.save()
}

describe('edit text', () => {
  it('groups runs on a baseline into lines', async () => {
    const doc = engine.open(await sample())
    const lines = doc.textLines(0)
    expect(lines.map((l) => l.text)).toEqual(['Invoice 2041', 'Total due: $1,200', 'Overdue'])
    const total = lines[1]
    expect(total.objects).toHaveLength(2)
    expect(total.size).toBeCloseTo(12, 1)
    expect(total.rect.y).toBeGreaterThan(100)
    expect(lines[2].color).toBe('#cc0000')
    expect(lines[0].serif).toBe(true)
    expect(lines[2].bold).toBe(true)
    doc.close()
  })

  it('replaces a line in place, keeping its font when the letters are already there', async () => {
    const doc = engine.open(await sample())
    const total = doc.textLines(0)[1]
    // Standard fonts are not embedded, so any WinAnsi letter is fine and the font is kept.
    const r = doc.replaceText(0, total.objects, total.text, 'Total due: $1,350')
    expect(r.substitute).toBeUndefined()
    const after = doc.textLines(0)
    expect(after.map((l) => l.text)).toContain('Total due: $1,350')
    const edited = after.find((l) => l.text.startsWith('Total'))!
    expect(edited.rect.x).toBeCloseTo(total.rect.x, 0)
    expect(edited.rect.y).toBeCloseTo(total.rect.y, 0)
    expect(edited.font).toBe('Helvetica')
    expect(doc.pageText(0)).toContain('$1,350')
    expect(doc.pageText(0)).not.toContain('$1,200')
    // Survives a save and reopen.
    const again = engine.open(doc.save())
    expect(again.pageText(0)).toContain('Total due: $1,350')
    again.close()
    doc.close()
  })

  it('keeps colour and deletes a line given empty text', async () => {
    const doc = engine.open(await sample())
    const red = doc.textLines(0)[2]
    doc.replaceText(0, red.objects, red.text, 'Paid')
    expect(doc.textLines(0)[2]).toMatchObject({ text: 'Paid', color: '#cc0000', bold: true })
    const head = doc.textLines(0)[0]
    doc.replaceText(0, head.objects, head.text, '')
    expect(doc.textLines(0).map((l) => l.text)).toEqual(['Total due: $1,200', 'Paid'])
    doc.close()
  })

  it('refuses a stale edit', async () => {
    const doc = engine.open(await sample())
    const line = doc.textLines(0)[1]
    expect(() => doc.replaceText(0, line.objects, 'something else', 'x')).toThrow(/changed/)
    doc.close()
  })

  it('works on a rotated page', async () => {
    const doc = engine.open(await sample(90))
    const head = doc.textLines(0)[0]
    // Shown turned a quarter clockwise, the top of the page is on the right.
    expect(head.rect.x).toBeGreaterThan(600)
    doc.replaceText(0, head.objects, head.text, 'Invoice 2042')
    expect(doc.pageText(0)).toContain('Invoice 2042')
    doc.close()
  })

  it('switches to a matching standard font when an embedded subset lacks a letter', () => {
    const doc = engine.open(readFileSync(new URL('./fixtures/embedded-fonts.pdf', import.meta.url)))
    const title = doc.textLines(0)[0]
    expect(title.text).toBe('Quarterly report PX-4821')
    // Letters from the title itself: the embedded font is kept.
    expect(doc.replaceText(0, title.objects, title.text, 'Quarterly report PX-4822').substitute).toBeUndefined()
    const again = doc.textLines(0)[0]
    expect(again.text).toBe('Quarterly report PX-4822')
    // "Z" and "w" are not in the title's font on this page: falls back to sans.
    const r = doc.replaceText(0, again.objects, again.text, 'Zawadi report')
    expect(r.substitute).toBe('Helvetica')
    expect(doc.textLines(0)[0].text).toBe('Zawadi report')
    doc.close()
  })

  it('picks standard fonts by style', () => {
    expect(standardFor({ bold: true, italic: false, serif: true, mono: false })).toBe('Times-Bold')
    expect(standardFor({ bold: false, italic: true, serif: false, mono: false })).toBe('Helvetica-Oblique')
    expect(standardFor({ bold: true, italic: true, serif: false, mono: true })).toBe('Courier-BoldOblique')
  })
})

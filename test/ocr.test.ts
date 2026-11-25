import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import jpeg from 'jpeg-js'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { createWorker } from 'tesseract.js'
import { PdfEngine } from '../src/engine/pdfium'
import { wordsFromPage } from '../src/viewer/ocrWords'

const require = createRequire(import.meta.url)
let engine: PdfEngine

beforeAll(async () => {
  engine = await PdfEngine.create(readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm')))
})

const SCALE = 200 / 72

/** A "scan": a page of text rendered to a picture, with no text layer. */
async function scannedPdf(): Promise<Uint8Array> {
  const src = await PDFDocument.create()
  const font = await src.embedFont(StandardFonts.Helvetica)
  const page = src.addPage([612, 792])
  page.drawText('Invoice number 4821', { x: 72, y: 700, size: 24, font })
  page.drawText('Total due by December', { x: 72, y: 650, size: 18, font })
  const text = engine.open(await src.save())
  const r = text.renderPage(0, SCALE)
  text.close()
  const jpg = new Uint8Array(jpeg.encode({ data: r.data, width: r.width, height: r.height }, 90).data)
  const out = await PDFDocument.create()
  const img = await out.embedJpg(jpg)
  out.addPage([612, 792]).drawImage(img, { x: 0, y: 0, width: 612, height: 792 })
  return out.save()
}

describe('OCR', () => {
  it('makes a scanned page searchable without changing how it looks', async () => {
    const doc = engine.open(await scannedPdf())
    expect(doc.needsOcr(0)).toBe(true)
    const before = doc.renderPage(0, 1).data

    const r = doc.renderPage(0, SCALE)
    const langPath = join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int')
    const worker = await createWorker('eng', 1, { langPath, gzip: true, cachePath: join(process.cwd(), 'node_modules/.cache/tesseract') })
    const image = Buffer.from(jpeg.encode({ data: r.data, width: r.width, height: r.height }, 95).data)
    const { data } = await worker.recognize(image, {}, { blocks: true })
    await worker.terminate()
    const words = wordsFromPage(data, SCALE)
    expect(words.map((w) => w.text).join(' ')).toContain('Invoice number 4821')

    expect(doc.addOcrText(0, words)).toBe(words.length)
    expect(doc.needsOcr(0)).toBe(false)
    const hit = doc.searchPage(0, '4821')[0]
    expect(hit).toBeTruthy()
    // Where the number is in the scan: about 72 + width of "Invoice number " in, 92 pt down.
    expect(hit.rects[0].y).toBeGreaterThan(70)
    expect(hit.rects[0].y).toBeLessThan(100)
    expect(doc.pageText(0)).toContain('Total due by December')

    // Invisible: the page renders exactly as before.
    const after = doc.renderPage(0, 1).data
    let diff = 0
    for (let i = 0; i < after.length; i++) diff += Math.abs(after[i] - before[i])
    expect(diff).toBe(0)
    doc.close()
  }, 60_000)
})

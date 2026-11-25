import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import jpeg from 'jpeg-js'
import { PDFDocument } from 'pdf-lib'
import { COMPRESS_PRESETS, PdfEngine, type PdfDocument } from '../src/engine/pdfium'
import { downsample } from '../src/engine/compress'

const require = createRequire(import.meta.url)
let engine: PdfEngine

beforeAll(async () => {
  engine = await PdfEngine.create(readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm')))
})

/** A photo-like picture: smooth gradients plus a little noise, so it doesn't compress to nothing. */
function photo(width: number, height: number, alpha = false) {
  const data = Buffer.alloc(width * height * 4)
  let seed = 1
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 30
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = (x / width) * 200 + rand()
      data[i + 1] = (y / height) * 200 + rand()
      data[i + 2] = 120 + rand()
      data[i + 3] = alpha && x < width / 2 ? 100 : 255
    }
  }
  return { data, width, height }
}

/** Page 1: a 2400×1600 high-quality JPEG shown 6 inches wide (400 dpi). Page 2: a translucent PNG and a tiny image. */
async function heavyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const big = await doc.embedJpg(new Uint8Array(jpeg.encode(photo(2400, 1600), 95).data))
  doc.addPage([612, 792]).drawImage(big, { x: 90, y: 300, width: 432, height: 288 })
  const { PNG } = await import('pngjs').catch(() => ({ PNG: null }))
  const page2 = doc.addPage([612, 792])
  if (PNG) {
    const p = photo(600, 400, true)
    const png = new PNG({ width: 600, height: 400 })
    png.data = p.data
    page2.drawImage(await doc.embedPng(PNG.sync.write(png)), { x: 90, y: 300, width: 432, height: 288 })
  }
  const tiny = await doc.embedJpg(new Uint8Array(jpeg.encode(photo(40, 40), 90).data))
  page2.drawImage(tiny, { x: 20, y: 20, width: 40, height: 40 })
  return doc.save()
}

function mean(doc: PdfDocument, page: number) {
  const r = doc.renderPage(page, 0.5)
  const sum = [0, 0, 0]
  for (let i = 0; i < r.data.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += r.data[i + c]
  return sum.map((s) => s / (r.data.length / 4))
}

describe('compress', () => {
  it('shrinks large photos a lot and keeps them looking the same', async () => {
    const src = await heavyPdf()
    const doc = engine.open(src)
    const before = mean(doc, 0)
    const result = doc.compress(COMPRESS_PRESETS.balanced)
    expect(result.images).toBe(1)
    const out = doc.save()
    doc.close()
    expect(out.length).toBeLessThan(src.length / 4)

    const again = engine.open(out)
    const after = mean(again, 0)
    for (let c = 0; c < 3; c++) expect(Math.abs(after[c] - before[c])).toBeLessThan(3)
    // Nothing left worth doing.
    expect(again.compress(COMPRESS_PRESETS.balanced).images).toBe(0)
    again.close()
  })

  it('leaves translucent and tiny images alone', async () => {
    const doc = engine.open(await heavyPdf())
    const before = mean(doc, 1)
    doc.compress(COMPRESS_PRESETS.smallest)
    const after = mean(doc, 1)
    for (let c = 0; c < 3; c++) expect(Math.abs(after[c] - before[c])).toBeLessThan(1)
    doc.close()
  })

  it('downsamples by averaging', () => {
    const src = new Uint8Array([0, 0, 0, 255, 200, 100, 50, 255, 100, 100, 100, 255, 100, 0, 250, 255])
    expect([...downsample(src, 2, 2, 1, 1)]).toEqual([100, 50, 100, 255])
  })
})

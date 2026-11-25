// Runs Tesseract OCR in the browser on pages that have no text, entirely on
// this device: the engine, its model and the scans never leave it.
import { createWorker } from 'tesseract.js'
import workerPath from 'tesseract.js/dist/worker.min.js?url'
import corePath from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url'
import type { OcrWord } from '../engine/pdfium'
import type { DocHandle } from './client'
import { wordsFromPage } from './ocrWords'

/** Pixels per point to render at: 300 dpi, what Tesseract reads best. */
const SCALE = 300 / 72

export interface OcrPage {
  pageIndex: number
  words: OcrWord[]
}

export async function recognizePages(
  doc: DocHandle,
  pages: number[],
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<OcrPage[]> {
  const langPath = new URL('tessdata', new URL(import.meta.env.BASE_URL, location.href)).href
  const worker = await createWorker('eng', 1, { workerPath, corePath, langPath, gzip: true, workerBlobURL: false })
  const canvas = document.createElement('canvas')
  const out: OcrPage[] = []
  try {
    for (const [n, pageIndex] of pages.entries()) {
      if (signal?.aborted) break
      onProgress(n, pages.length)
      const img = await doc.render(pageIndex, SCALE, signal, false)
      canvas.width = img.width
      canvas.height = img.height
      canvas.getContext('2d')!.putImageData(img, 0, 0)
      const { data } = await worker.recognize(canvas, {}, { blocks: true })
      out.push({ pageIndex, words: wordsFromPage(data, SCALE) })
    }
    onProgress(pages.length, pages.length)
    return out
  } finally {
    await worker.terminate()
  }
}

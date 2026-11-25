import type { Page } from 'tesseract.js'
import type { OcrWord } from '../engine/pdfium'

/** Tesseract finds these with low confidence when it reads specks or lines as letters. */
const MIN_CONFIDENCE = 30

/**
 * Turns Tesseract's result for a page rendered at `scale` pixels per point
 * into words in view points. Each word takes its line's top and height, so
 * selecting across a line gives one even band.
 */
export function wordsFromPage(page: Pick<Page, 'blocks'>, scale: number): OcrWord[] {
  const out: OcrWord[] = []
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        for (const w of line.words) {
          if (w.confidence < MIN_CONFIDENCE || !w.text.trim()) continue
          out.push({
            text: w.text,
            x: w.bbox.x0 / scale,
            y: line.bbox.y0 / scale,
            width: (w.bbox.x1 - w.bbox.x0) / scale,
            height: (line.bbox.y1 - line.bbox.y0) / scale,
          })
        }
      }
    }
  }
  return out
}

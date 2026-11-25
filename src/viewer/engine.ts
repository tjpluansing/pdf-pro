import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'
import { PdfEngine } from '../engine/pdfium'

let wasm: Promise<ArrayBuffer> | null = null

/**
 * Creates a PDFium engine in the browser. The wasm bytes are fetched once and
 * reused, so recreating the engine after a crash is cheap.
 */
export function createEngine(): Promise<PdfEngine> {
  wasm ??= fetch(wasmUrl).then((res) => {
    if (!res.ok) throw new Error(`Could not load the PDF engine (HTTP ${res.status})`)
    return res.arrayBuffer()
  })
  return wasm.then((bytes) => PdfEngine.create(bytes))
}

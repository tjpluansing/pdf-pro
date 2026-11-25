/// <reference lib="webworker" />
// Runs PDFium off the main thread so opening, rendering and searching large
// files never blocks scrolling or typing. Requests are handled one at a time;
// a pending request can be cancelled (e.g. a page scrolled out of view).
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'
import { PdfEngine, PdfError, type PdfDocument } from '../engine/pdfium'
import type { Request, Response } from './protocol'

declare const self: DedicatedWorkerGlobalScope

let wasm: Promise<ArrayBuffer> | null = null
let engine: Promise<PdfEngine> | null = null
const docs = new Map<number, PdfDocument>()
let nextDocId = 1

const queue: Request[] = []
let busy = false

function getEngine(): Promise<PdfEngine> {
  wasm ??= fetch(wasmUrl).then((res) => {
    if (!res.ok) throw new Error(`Could not load the PDF engine (HTTP ${res.status})`)
    return res.arrayBuffer()
  })
  engine ??= wasm.then((bytes) => PdfEngine.create(bytes))
  return engine
}

function reply(msg: Response, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer)
}

function doc(docId: number): PdfDocument {
  const d = docs.get(docId)
  if (!d) throw new PdfError('unknown', 'This document is no longer open')
  return d
}

async function handle(req: Request) {
  const pdf = await getEngine()
  switch (req.type) {
    case 'open': {
      const d = pdf.open(req.bytes, req.password)
      const docId = nextDocId++
      docs.set(docId, d)
      let outline: ReturnType<PdfDocument['outline']> = []
      try {
        outline = d.outline()
      } catch (err) {
        if (err instanceof PdfError && err.code === 'crash') throw err
      }
      return reply({ id: req.id, ok: true, value: { docId, pageCount: d.pageCount, sizes: d.pageSizes(), outline } })
    }
    case 'render': {
      const page = doc(req.docId).renderPage(req.pageIndex, req.scale)
      const pixels = page.data.buffer as ArrayBuffer
      return reply({ id: req.id, ok: true, value: { width: page.width, height: page.height, pixels } }, [pixels])
    }
    case 'search':
      return reply({ id: req.id, ok: true, value: doc(req.docId).search(req.query) })
    case 'close':
      docs.get(req.docId)?.close()
      docs.delete(req.docId)
      return reply({ id: req.id, ok: true, value: null })
    case 'cancel':
      return
  }
}

async function drain() {
  if (busy) return
  busy = true
  while (queue.length) {
    const req = queue.shift()!
    try {
      await handle(req)
    } catch (err) {
      if (err instanceof PdfError && err.code === 'crash') {
        // PDFium's memory can't be trusted after a trap: drop every document and start over.
        docs.clear()
        engine = null
      }
      const code = err instanceof PdfError ? err.code : 'unknown'
      reply({ id: req.id, ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } })
    }
  }
  busy = false
}

self.onmessage = (e: MessageEvent<Request>) => {
  const req = e.data
  if (req.type === 'cancel') {
    const i = queue.findIndex((q) => q.id === req.target)
    if (i >= 0) {
      const [dropped] = queue.splice(i, 1)
      reply({ id: dropped.id, ok: false, error: { code: 'cancelled', message: 'Cancelled' } })
    }
    return
  }
  queue.push(req)
  void drain()
}

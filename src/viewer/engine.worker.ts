/// <reference lib="webworker" />
// Runs PDFium off the main thread so opening, rendering and searching large
// files never blocks scrolling or typing. Requests are handled one at a time;
// a pending request can be cancelled (e.g. a page scrolled out of view).
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'
import { PdfEngine, PdfError, type PdfDocument } from '../engine/pdfium'
import type { DocInfo, Edit, Request, Response } from './protocol'

declare const self: DedicatedWorkerGlobalScope

let wasm: Promise<ArrayBuffer> | null = null
let engine: Promise<PdfEngine> | null = null
interface OpenDoc {
  doc: PdfDocument
  password: string
  /** Saved copies from before each edit, newest last. */
  undo: Uint8Array[]
}
const docs = new Map<number, OpenDoc>()
let nextDocId = 1
/** Undo steps kept per document; each one is a full saved copy. */
const UNDO_LIMIT = 20

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

function entry(docId: number): OpenDoc {
  const d = docs.get(docId)
  if (!d) throw new PdfError('unknown', 'This document is no longer open')
  return d
}

function doc(docId: number): PdfDocument {
  return entry(docId).doc
}

function info(e: OpenDoc): DocInfo {
  let outline: DocInfo['outline'] = []
  try {
    outline = e.doc.outline()
  } catch (err) {
    if (err instanceof PdfError && err.code === 'crash') throw err
  }
  return { pageCount: e.doc.pageCount, sizes: e.doc.pageSizes(), outline, undoDepth: e.undo.length, hasForm: e.doc.hasForm }
}

function applyEdit(pdf: PdfEngine, d: PdfDocument, edit: Edit) {
  switch (edit.kind) {
    case 'rotate':
      return d.rotatePages(edit.pages, edit.degrees)
    case 'delete':
      return d.deletePages(edit.pages)
    case 'move':
      return d.movePages(edit.pages, edit.dest)
    case 'insert': {
      const src = pdf.open(edit.bytes, edit.password ?? '')
      try {
        d.insertPagesFrom(src, edit.pages, edit.at)
      } finally {
        src.close()
      }
      return
    }
    case 'annot-add':
      d.addAnnotation(edit.annot, edit.id)
      return
    case 'annot-update':
      return d.updateAnnotation(edit.pageIndex, edit.id, edit.patch)
    case 'annot-remove':
      return d.removeAnnotation(edit.pageIndex, edit.id)
    case 'field':
      return d.setFormField(edit.pageIndex, edit.index, edit.value)
    case 'stamp':
      d.addImageStamp(edit.pageIndex, edit.rect, edit.image, { id: edit.id, author: edit.author, label: edit.label })
      return
  }
}

async function handle(req: Request) {
  const pdf = await getEngine()
  switch (req.type) {
    case 'open': {
      const e: OpenDoc = { doc: pdf.open(req.bytes, req.password), password: req.password, undo: [] }
      const docId = nextDocId++
      docs.set(docId, e)
      return reply({ id: req.id, ok: true, value: { docId, ...info(e) } })
    }
    case 'edit': {
      const e = entry(req.docId)
      const before = e.doc.save()
      try {
        applyEdit(pdf, e.doc, req.edit)
      } catch (err) {
        // A failed edit may have half-applied; put the document back as it was.
        if (!(err instanceof PdfError && err.code === 'crash')) restore(pdf, e, before)
        throw err
      }
      e.undo.push(before)
      if (e.undo.length > UNDO_LIMIT) e.undo.shift()
      return reply({ id: req.id, ok: true, value: info(e) })
    }
    case 'undo': {
      const e = entry(req.docId)
      const before = e.undo.pop()
      if (before) restore(pdf, e, before)
      return reply({ id: req.id, ok: true, value: info(e) })
    }
    case 'save': {
      const bytes = doc(req.docId).save()
      return reply({ id: req.id, ok: true, value: { bytes } }, [bytes.buffer])
    }
    case 'formFields':
      return reply({ id: req.id, ok: true, value: doc(req.docId).allFormFields() })
    case 'annotations':
      return reply({ id: req.id, ok: true, value: doc(req.docId).allAnnotations() })
    case 'textLayout': {
      const { text, boxes } = doc(req.docId).textLayout(req.pageIndex)
      return reply({ id: req.id, ok: true, value: { text, boxes } }, [boxes.buffer])
    }
    case 'extract': {
      const bytes = doc(req.docId).extractPages(req.pages)
      return reply({ id: req.id, ok: true, value: { bytes } }, [bytes.buffer])
    }
    case 'render': {
      const page = doc(req.docId).renderPage(req.pageIndex, req.scale, { forms: req.forms ?? true })
      const pixels = page.data.buffer as ArrayBuffer
      return reply({ id: req.id, ok: true, value: { width: page.width, height: page.height, pixels } }, [pixels])
    }
    case 'search':
      return reply({ id: req.id, ok: true, value: doc(req.docId).search(req.query) })
    case 'close':
      docs.get(req.docId)?.doc.close()
      docs.delete(req.docId)
      return reply({ id: req.id, ok: true, value: null })
    case 'cancel':
      return
  }
}

function restore(pdf: PdfEngine, e: OpenDoc, bytes: Uint8Array) {
  const next = pdf.open(bytes, e.password)
  e.doc.close()
  e.doc = next
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

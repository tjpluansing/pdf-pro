// Main-thread handle on the PDF engine worker.
import { PdfError, type Annotation, type FormField, type OutlineItem, type PageSize, type PageTextKind, type PdfErrorCode, type SearchHit, type Security, type TextLayout } from '../engine/pdfium'
import type { BytesResult, DocInfo, Edit, OpenResult, RenderResult, Request, Response, TextLayoutResult } from './protocol'

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void }

/** Rejection for a request that was cancelled before the worker started it. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

export class EngineClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private nextId = 1

  constructor() {
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<Response>) => {
      const msg = e.data
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.value)
      else if (msg.error.code === 'cancelled') p.reject(new CancelledError())
      else p.reject(new PdfError(msg.error.code as PdfErrorCode, msg.error.message))
    }
  }

  private call<T>(req: Omit<Request, 'id'> & Record<string, unknown>, transfer: Transferable[] = [], signal?: AbortSignal): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.worker.postMessage({ ...req, id }, transfer)
      signal?.addEventListener('abort', () => this.worker.postMessage({ id: this.nextId++, type: 'cancel', target: id }), {
        once: true,
      })
    })
  }

  /** Opens a copy of `bytes` in the worker. Rejects with PdfError('password') when a password is needed or wrong. */
  async open(bytes: Uint8Array, password = ''): Promise<DocHandle> {
    const copy = bytes.slice()
    const r = await this.call<OpenResult>({ type: 'open', bytes: copy, password }, [copy.buffer])
    return new DocHandle(this, r)
  }

  /** @internal */
  request<T>(req: Omit<Request, 'id'> & Record<string, unknown>, signal?: AbortSignal, transfer: Transferable[] = []): Promise<T> {
    return this.call<T>(req, transfer, signal)
  }
}

/**
 * An open document. Edits return a new handle for the same document, so React
 * state that holds the handle re-renders every page after a change.
 */
export class DocHandle {
  readonly id: number
  readonly pageCount: number
  readonly sizes: PageSize[]
  readonly outline: OutlineItem[]
  /** Edits that can be undone. */
  readonly undoDepth: number
  readonly hasForm: boolean
  readonly security: Security
  /** Set on the handle a compress edit returns. */
  readonly compressed?: DocInfo['compressed']
  /** Bumped on every edit, so cached page images can tell they are stale. */
  readonly version: number
  private readonly client: EngineClient

  constructor(client: EngineClient, r: OpenResult, version = 0) {
    this.client = client
    this.id = r.docId
    this.pageCount = r.pageCount
    this.sizes = r.sizes
    this.outline = r.outline
    this.undoDepth = r.undoDepth
    this.hasForm = r.hasForm
    this.security = r.security
    this.compressed = r.compressed
    this.version = version
  }

  private next(r: DocInfo): DocHandle {
    return new DocHandle(this.client, { ...r, docId: this.id }, this.version + 1)
  }

  async edit(edit: Edit): Promise<DocHandle> {
    const transfer: Transferable[] = []
    if (edit.kind === 'insert') {
      edit = { ...edit, bytes: edit.bytes.slice() }
      transfer.push(edit.bytes.buffer)
    }
    if (edit.kind === 'stamp') {
      const rgba = edit.image.rgba.slice()
      edit = { ...edit, image: { ...edit.image, rgba } }
      transfer.push(rgba.buffer)
    }
    return this.next(await this.client.request<DocInfo>({ type: 'edit', docId: this.id, edit }, undefined, transfer))
  }

  async undo(): Promise<DocHandle> {
    return this.next(await this.client.request<DocInfo>({ type: 'undo', docId: this.id }))
  }

  /** The whole document as it is now, edits included. */
  async save(): Promise<Uint8Array> {
    return (await this.client.request<BytesResult>({ type: 'save', docId: this.id })).bytes
  }

  /** Enters the permissions password so security can be changed. Rejects with PdfError('password') when wrong. */
  async unlockOwner(password: string): Promise<DocHandle> {
    return this.next(await this.client.request<DocInfo>({ type: 'unlockOwner', docId: this.id, password }))
  }

  /** Which kinds of watermark, header or footer the document has. */
  pageTextKinds(): Promise<PageTextKind[]> {
    return this.client.request<PageTextKind[]>({ type: 'pageTextKinds', docId: this.id })
  }

  /** Fillable fields on every page, in page order. */
  formFields(): Promise<FormField[]> {
    return this.client.request<FormField[]>({ type: 'formFields', docId: this.id })
  }

  /** Comments and markup on every page, in page order. */
  annotations(): Promise<Annotation[]> {
    return this.client.request<Annotation[]>({ type: 'annotations', docId: this.id })
  }

  textLayout(pageIndex: number): Promise<TextLayout> {
    return this.client.request<TextLayoutResult>({ type: 'textLayout', docId: this.id, pageIndex })
  }

  /** A new PDF holding copies of the given pages. */
  async extract(pages: number[]): Promise<Uint8Array> {
    return (await this.client.request<BytesResult>({ type: 'extract', docId: this.id, pages })).bytes
  }

  async render(pageIndex: number, scale: number, signal?: AbortSignal, forms = true): Promise<ImageData> {
    const r = await this.client.request<RenderResult>({ type: 'render', docId: this.id, pageIndex, scale, forms }, signal)
    return new ImageData(new Uint8ClampedArray(r.pixels), r.width, r.height)
  }

  search(query: string): Promise<SearchHit[]> {
    return this.client.request<SearchHit[]>({ type: 'search', docId: this.id, query })
  }

  close(): void {
    this.client.request({ type: 'close', docId: this.id }).catch(() => {})
  }
}

// Main-thread handle on the PDF engine worker.
import { PdfError, type OutlineItem, type PageSize, type PdfErrorCode, type SearchHit } from '../engine/pdfium'
import type { OpenResult, RenderResult, Request, Response } from './protocol'

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
  request<T>(req: Omit<Request, 'id'> & Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.call<T>(req, [], signal)
  }
}

export class DocHandle {
  readonly id: number
  readonly pageCount: number
  readonly sizes: PageSize[]
  readonly outline: OutlineItem[]
  private readonly client: EngineClient

  constructor(client: EngineClient, r: OpenResult) {
    this.client = client
    this.id = r.docId
    this.pageCount = r.pageCount
    this.sizes = r.sizes
    this.outline = r.outline
  }

  async render(pageIndex: number, scale: number, signal?: AbortSignal): Promise<ImageData> {
    const r = await this.client.request<RenderResult>({ type: 'render', docId: this.id, pageIndex, scale }, signal)
    return new ImageData(new Uint8ClampedArray(r.pixels), r.width, r.height)
  }

  search(query: string): Promise<SearchHit[]> {
    return this.client.request<SearchHit[]>({ type: 'search', docId: this.id, query })
  }

  close(): void {
    this.client.request({ type: 'close', docId: this.id }).catch(() => {})
  }
}

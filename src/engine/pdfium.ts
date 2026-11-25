/**
 * Thin, typed wrapper around PDFium compiled to WebAssembly (@embedpdf/pdfium).
 *
 * The same code runs in the browser and in Node (tests, corpus check): callers
 * supply the wasm bytes, so this module never touches fetch or the filesystem.
 * Every PDFium handle is owned by a class here and released in close().
 */
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium'

/** FPDF_ANNOT: draw annotations. FPDF_REVERSE_BYTE_ORDER: emit RGBA instead of BGRA. */
const RENDER_FLAGS = 0x01 | 0x10
const FPDFBITMAP_BGRA = 4
const WHITE = 0xffffffff

/** `crash` means PDFium itself hit a fatal error (a WebAssembly trap); the engine must be recreated. */
export type PdfErrorCode = 'unknown' | 'file' | 'format' | 'password' | 'security' | 'page' | 'crash'

const ERROR_CODES: Record<number, PdfErrorCode> = {
  1: 'unknown',
  2: 'file',
  3: 'format',
  4: 'password',
  5: 'security',
  6: 'page',
}

export class PdfError extends Error {
  readonly code: PdfErrorCode
  constructor(code: PdfErrorCode, message: string) {
    super(message)
    this.name = 'PdfError'
    this.code = code
  }
}

export interface PageSize {
  /** Width in PDF points (1/72 inch). */
  width: number
  /** Height in PDF points (1/72 inch). */
  height: number
}

export interface RenderedPage {
  width: number
  height: number
  /** RGBA pixels, ready for `new ImageData(data, width, height)`. */
  data: Uint8ClampedArray
}

/** A rectangle in page space: points, origin at the top-left, y growing down. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface SearchHit {
  pageIndex: number
  /** Character index of the match in the page's text. */
  charIndex: number
  length: number
  rects: Rect[]
}

export interface OutlineItem {
  title: string
  /** Target page, or null when the bookmark points somewhere PDFium cannot resolve to a page. */
  pageIndex: number | null
  children: OutlineItem[]
}

/** The wasm heap. Typed here because the package's typings omit Emscripten's HEAP views. */
function heap(m: WrappedPdfiumModule): Uint8Array {
  return (m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8
}

interface EngineState {
  /** Set after a WebAssembly trap. PDFium's memory may be corrupt, so nothing else may run. */
  crashed: boolean
}

/**
 * Runs `fn`, turning a WebAssembly trap (a bug inside PDFium, such as an
 * `unreachable` instruction on a malformed image) into PdfError('crash') and
 * poisoning the engine so callers know to create a fresh one.
 */
function guard<T>(state: EngineState, fn: () => T): T {
  if (state.crashed) throw new PdfError('crash', 'The PDF engine crashed earlier and must be recreated')
  try {
    return fn()
  } catch (err) {
    if (err instanceof WebAssembly.RuntimeError) {
      state.crashed = true
      throw new PdfError('crash', `PDFium crashed: ${err.message}`)
    }
    throw err
  }
}

export class PdfEngine {
  private readonly state: EngineState = { crashed: false }

  private readonly m: WrappedPdfiumModule

  private constructor(m: WrappedPdfiumModule) {
    this.m = m
  }

  /** True after PDFium crashed; create a new engine to keep working. */
  get crashed(): boolean {
    return this.state.crashed
  }

  static async create(wasmBinary: ArrayBuffer | Uint8Array): Promise<PdfEngine> {
    const bytes = wasmBinary instanceof Uint8Array ? wasmBinary : new Uint8Array(wasmBinary)
    // Copy into a plain ArrayBuffer: init() rejects views over a larger or shared buffer.
    const module = await init({ wasmBinary: bytes.slice().buffer })
    module.PDFiumExt_Init()
    return new PdfEngine(module)
  }

  /**
   * Open a document from bytes. The bytes are copied into wasm memory and kept
   * there until the document is closed, as PDFium reads them lazily.
   */
  open(bytes: Uint8Array, password = ''): PdfDocument {
    return guard(this.state, () => this.openUnguarded(bytes, password))
  }

  private openUnguarded(bytes: Uint8Array, password: string): PdfDocument {
    const m = this.m
    const ptr = m.pdfium.wasmExports.malloc(bytes.length)
    heap(m).set(bytes, ptr)
    const handle = m.FPDF_LoadMemDocument(ptr, bytes.length, password)
    if (!handle) {
      const code = ERROR_CODES[m.FPDF_GetLastError()] ?? 'unknown'
      m.pdfium.wasmExports.free(ptr)
      throw new PdfError(code, `PDFium could not open the document (${code})`)
    }
    return new PdfDocument(m, this.state, handle, ptr)
  }
}

export class PdfDocument {
  readonly pageCount: number
  private closed = false
  private readonly sizes: PageSize[] = []

  private readonly m: WrappedPdfiumModule
  private readonly state: EngineState
  private readonly handle: number
  private readonly dataPtr: number

  constructor(m: WrappedPdfiumModule, state: EngineState, handle: number, dataPtr: number) {
    this.m = m
    this.state = state
    this.handle = handle
    this.dataPtr = dataPtr
    this.pageCount = m.FPDF_GetPageCount(handle)
  }

  pageSize(pageIndex: number): PageSize {
    this.checkPage(pageIndex)
    const cached = this.sizes[pageIndex]
    if (cached) return cached
    const size = this.withPage(pageIndex, (page) => ({
      width: this.m.FPDF_GetPageWidthF(page),
      height: this.m.FPDF_GetPageHeightF(page),
    }))
    this.sizes[pageIndex] = size
    return size
  }

  /** Render a page at `scale` pixels per point (1 = 72 dpi). */
  renderPage(pageIndex: number, scale: number): RenderedPage {
    const { width: pw, height: ph } = this.pageSize(pageIndex)
    const width = Math.max(1, Math.round(pw * scale))
    const height = Math.max(1, Math.round(ph * scale))
    const m = this.m
    return this.withPage(pageIndex, (page) => {
      const bitmap = m.FPDFBitmap_CreateEx(width, height, FPDFBITMAP_BGRA, 0, 0)
      if (!bitmap) throw new PdfError('unknown', `Could not allocate a ${width}x${height} bitmap`)
      try {
        m.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, WHITE)
        m.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, RENDER_FLAGS)
        const stride = m.FPDFBitmap_GetStride(bitmap)
        const buffer = m.FPDFBitmap_GetBuffer(bitmap)
        const data = new Uint8ClampedArray(width * height * 4)
        for (let row = 0; row < height; row++) {
          const start = buffer + row * stride
          data.set(heap(m).subarray(start, start + width * 4), row * width * 4)
        }
        return { width, height, data }
      } finally {
        m.FPDFBitmap_Destroy(bitmap)
      }
    })
  }

  /** Plain text of one page, in PDFium's reading order. */
  pageText(pageIndex: number): string {
    const m = this.m
    return this.withTextPage(pageIndex, (text) => {
      const count = m.FPDFText_CountChars(text)
      if (count <= 0) return ''
      const bytes = (count + 1) * 2
      const ptr = m.pdfium.wasmExports.malloc(bytes)
      try {
        m.FPDFText_GetText(text, 0, count, ptr)
        return m.pdfium.UTF16ToString(ptr)
      } finally {
        m.pdfium.wasmExports.free(ptr)
      }
    })
  }

  /** Case-insensitive search across all pages. Results are in page order. */
  search(query: string, { limit = 1000 }: { limit?: number } = {}): SearchHit[] {
    const hits: SearchHit[] = []
    if (!query) return hits
    for (let i = 0; i < this.pageCount && hits.length < limit; i++) {
      hits.push(...this.searchPage(i, query, limit - hits.length))
    }
    return hits
  }

  searchPage(pageIndex: number, query: string, limit = 1000): SearchHit[] {
    const m = this.m
    const { height: pageHeight } = this.pageSize(pageIndex)
    return this.withTextPage(pageIndex, (text) => {
      const hits: SearchHit[] = []
      const qBytes = (query.length + 1) * 2
      const qPtr = m.pdfium.wasmExports.malloc(qBytes)
      const rPtr = m.pdfium.wasmExports.malloc(32)
      m.pdfium.stringToUTF16(query, qPtr, qBytes)
      const find = m.FPDFText_FindStart(text, qPtr, 0, 0)
      try {
        while (hits.length < limit && m.FPDFText_FindNext(find)) {
          const charIndex = m.FPDFText_GetSchResultIndex(find)
          const length = m.FPDFText_GetSchCount(find)
          const rectCount = m.FPDFText_CountRects(text, charIndex, length)
          const rects: Rect[] = []
          for (let r = 0; r < rectCount; r++) {
            if (!m.FPDFText_GetRect(text, r, rPtr, rPtr + 8, rPtr + 16, rPtr + 24)) continue
            const [left, top, right, bottom] = [0, 8, 16, 24].map((o) => m.pdfium.getValue(rPtr + o, 'double'))
            rects.push({ x: left, y: pageHeight - top, width: right - left, height: top - bottom })
          }
          hits.push({ pageIndex, charIndex, length, rects })
        }
      } finally {
        m.FPDFText_FindClose(find)
        m.pdfium.wasmExports.free(qPtr)
        m.pdfium.wasmExports.free(rPtr)
      }
      return hits
    })
  }

  /** The bookmark tree. Depth and item count are capped to survive cyclic outlines. */
  outline(): OutlineItem[] {
    return guard(this.state, () => this.outlineUnguarded())
  }

  private outlineUnguarded(): OutlineItem[] {
    const m = this.m
    let budget = 10_000
    const seen = new Set<number>()
    const walk = (parent: number, depth: number): OutlineItem[] => {
      const items: OutlineItem[] = []
      if (depth > 32) return items
      let node = m.FPDFBookmark_GetFirstChild(this.handle, parent)
      while (node && budget-- > 0 && !seen.has(node)) {
        seen.add(node)
        const titleBytes = m.FPDFBookmark_GetTitle(node, 0, 0)
        let title = ''
        if (titleBytes > 0) {
          const ptr = m.pdfium.wasmExports.malloc(titleBytes)
          m.FPDFBookmark_GetTitle(node, ptr, titleBytes)
          title = m.pdfium.UTF16ToString(ptr)
          m.pdfium.wasmExports.free(ptr)
        }
        const dest = m.FPDFBookmark_GetDest(this.handle, node)
        const page = dest ? m.FPDFDest_GetDestPageIndex(this.handle, dest) : -1
        items.push({ title, pageIndex: page >= 0 ? page : null, children: walk(node, depth + 1) })
        node = m.FPDFBookmark_GetNextSibling(this.handle, node)
      }
      return items
    }
    return walk(0, 0)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.state.crashed) return // memory is not trustworthy; drop the engine instead
    this.m.FPDF_CloseDocument(this.handle)
    this.m.pdfium.wasmExports.free(this.dataPtr)
  }

  private checkPage(pageIndex: number) {
    if (this.closed) throw new PdfError('unknown', 'Document is closed')
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= this.pageCount) {
      throw new PdfError('page', `Page ${pageIndex} is out of range (0 to ${this.pageCount - 1})`)
    }
  }

  private withPage<T>(pageIndex: number, fn: (page: number) => T): T {
    this.checkPage(pageIndex)
    return guard(this.state, () => this.withPageUnguarded(pageIndex, fn))
  }

  private withPageUnguarded<T>(pageIndex: number, fn: (page: number) => T): T {
    const page = this.m.FPDF_LoadPage(this.handle, pageIndex)
    if (!page) throw new PdfError('page', `PDFium could not load page ${pageIndex}`)
    try {
      return fn(page)
    } finally {
      this.m.FPDF_ClosePage(page)
    }
  }

  private withTextPage<T>(pageIndex: number, fn: (text: number) => T): T {
    return this.withPage(pageIndex, (page) => {
      const text = this.m.FPDFText_LoadPage(page)
      if (!text) throw new PdfError('page', `PDFium could not read text on page ${pageIndex}`)
      try {
        return fn(text)
      } finally {
        this.m.FPDFText_ClosePage(text)
      }
    })
  }
}

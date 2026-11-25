/**
 * Thin, typed wrapper around PDFium compiled to WebAssembly (@embedpdf/pdfium).
 *
 * The same code runs in the browser and in Node (tests, corpus check): callers
 * supply the wasm bytes, so this module never touches fetch or the filesystem.
 * Every PDFium handle is owned by a class here and released in close().
 */
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium'
import {
  addAnnotation,
  boxToView,
  pageFrame,
  readAnnotations,
  readTextLayout,
  removeById,
  setCommonFields,
  updateById,
  type Annotation,
  type AnnotationPatch,
  type NewAnnotation,
  type TextLayout,
} from './annotations'

export type { Annotation, AnnotationPatch, AnnotKind, NewAnnotation, Point, TextLayout } from './annotations'
import { FormEnv, addImageStamp, readFields, setField, type FieldValue, type FormField, type StampImage } from './forms'
import {
  addPageText,
  fillPlaceholders,
  pageTextKinds,
  permissionBits,
  permissionsFrom,
  removePageText,
  type PageText,
  type PageTextKind,
  type PageTextOptions,
  type Permissions,
  type Security,
} from './stamp'
export type { FieldType, FieldValue, FormField, StampImage } from './forms'
export type { PageText, PageTextKind, PageTextOptions, Permissions, Security, StandardFont } from './stamp'

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

/** Serializes an open PDFium document to bytes through the embedpdf file-writer helpers. */
function saveHandle(m: WrappedPdfiumModule, doc: number): Uint8Array {
  const writer = m.PDFiumExt_OpenFileWriter()
  try {
    if (!m.PDFiumExt_SaveAsCopy(doc, writer)) throw new PdfError('unknown', 'PDFium could not save the document')
    const size = m.PDFiumExt_GetFileWriterSize(writer)
    const ptr = m.pdfium.wasmExports.malloc(size)
    try {
      m.PDFiumExt_GetFileWriterData(writer, ptr, size)
      return heap(m).slice(ptr, ptr + size)
    } finally {
      m.pdfium.wasmExports.free(ptr)
    }
  } finally {
    m.PDFiumExt_CloseFileWriter(writer)
  }
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
  private closed = false
  private sizes: PageSize[] = []

  private readonly m: WrappedPdfiumModule
  private readonly state: EngineState
  private readonly handle: number
  private readonly dataPtr: number

  constructor(m: WrappedPdfiumModule, state: EngineState, handle: number, dataPtr: number) {
    this.m = m
    this.state = state
    this.handle = handle
    this.dataPtr = dataPtr
  }

  /** Live page count; changes as pages are inserted or deleted. */
  get pageCount(): number {
    return this.m.FPDF_GetPageCount(this.handle)
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

  /** Sizes of every page, in points. Reads each page once, so call it once per document. */
  pageSizes(): PageSize[] {
    return Array.from({ length: this.pageCount }, (_, i) => this.pageSize(i))
  }

  /** Render a page at `scale` pixels per point (1 = 72 dpi). `forms: false` leaves form fields out. */
  renderPage(pageIndex: number, scale: number, { forms = true }: { forms?: boolean } = {}): RenderedPage {
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
        // Form fields are drawn separately, through the form-fill environment.
        if (forms && this.hasForm) {
          this.formEnv().withPage(page, (form) => m.FPDF_FFLDraw(form, bitmap, page, 0, 0, width, height, 0, RENDER_FLAGS))
        }
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
    return this.withTextPage(pageIndex, (text, page) => {
      const frame = pageFrame(m, page)
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
            rects.push(boxToView(frame, left, top, right, bottom))
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

  // ---- Page organizing ------------------------------------------------------

  /** Page rotation in degrees clockwise: 0, 90, 180 or 270. */
  pageRotation(pageIndex: number): number {
    return this.withPage(pageIndex, (page) => this.m.FPDFPage_GetRotation(page) * 90)
  }

  /** Rotates pages by a multiple of 90 degrees (positive = clockwise). */
  rotatePages(pageIndexes: number[], degrees: number): void {
    const quarter = (((Math.round(degrees / 90) % 4) + 4) % 4)
    for (const i of pageIndexes) {
      this.withPage(i, (page) => this.m.FPDFPage_SetRotation(page, (this.m.FPDFPage_GetRotation(page) + quarter) % 4))
    }
    this.sizes = []
  }

  /** Deletes pages. A document must keep at least one page. */
  deletePages(pageIndexes: number[]): void {
    const unique = [...new Set(pageIndexes)].sort((a, b) => b - a)
    unique.forEach((i) => this.checkPage(i))
    if (unique.length >= this.pageCount) throw new PdfError('page', 'A PDF needs at least one page')
    guard(this.state, () => unique.forEach((i) => this.m.FPDFPage_Delete(this.handle, i)))
    this.sizes = []
  }

  /**
   * Moves pages, keeping their relative order, so that the first of them ends
   * up at `destIndex` in the resulting document.
   */
  movePages(pageIndexes: number[], destIndex: number): void {
    const unique = [...new Set(pageIndexes)].sort((a, b) => a - b)
    unique.forEach((i) => this.checkPage(i))
    if (destIndex < 0 || destIndex > this.pageCount - unique.length) {
      throw new PdfError('page', `Cannot move ${unique.length} page(s) to position ${destIndex}`)
    }
    const ok = this.withInts(unique, (ptr) => this.m.FPDF_MovePages(this.handle, ptr, unique.length, destIndex))
    if (!ok) throw new PdfError('unknown', 'PDFium could not move the pages')
    this.sizes = []
  }

  /**
   * Copies pages from another open document into this one, inserted before
   * `insertAt` (default: at the end). All pages are copied when none are listed.
   */
  insertPagesFrom(source: PdfDocument, pageIndexes?: number[], insertAt = this.pageCount): void {
    const indexes = pageIndexes ?? Array.from({ length: source.pageCount }, (_, i) => i)
    indexes.forEach((i) => source.checkPage(i))
    if (insertAt < 0 || insertAt > this.pageCount) throw new PdfError('page', `Cannot insert at position ${insertAt}`)
    const ok = this.withInts(indexes, (ptr) =>
      this.m.FPDF_ImportPagesByIndex(this.handle, source.handle, ptr, indexes.length, insertAt),
    )
    if (!ok) throw new PdfError('unknown', 'PDFium could not copy the pages')
    this.sizes = []
  }

  /** A new PDF containing only the listed pages, in the order given. */
  extractPages(pageIndexes: number[]): Uint8Array {
    pageIndexes.forEach((i) => this.checkPage(i))
    if (pageIndexes.length === 0) throw new PdfError('page', 'Choose at least one page')
    return guard(this.state, () => {
      const out = this.m.FPDF_CreateNewDocument()
      if (!out) throw new PdfError('unknown', 'PDFium could not create a document')
      try {
        const ok = this.withInts(pageIndexes, (ptr) =>
          this.m.FPDF_ImportPagesByIndex(out, this.handle, ptr, pageIndexes.length, 0),
        )
        if (!ok) throw new PdfError('unknown', 'PDFium could not copy the pages')
        return saveHandle(this.m, out)
      } finally {
        this.m.FPDF_CloseDocument(out)
      }
    })
  }

  /** The document as it is now, including every edit, as PDF bytes. */
  save(): Uint8Array {
    if (this.closed) throw new PdfError('unknown', 'Document is closed')
    return guard(this.state, () => saveHandle(this.m, this.handle))
  }

  private withInts<T>(values: number[], fn: (ptr: number) => T): T {
    const ptr = this.m.pdfium.wasmExports.malloc(Math.max(4, values.length * 4))
    try {
      values.forEach((v, i) => this.m.pdfium.setValue(ptr + i * 4, v, 'i32'))
      return guard(this.state, () => fn(ptr))
    } finally {
      this.m.pdfium.wasmExports.free(ptr)
    }
  }

  // ---- Comments and markup ---------------------------------------------------

  /** Comments and markup on one page (links, pop-ups and form fields are left out). */
  annotations(pageIndex: number): Annotation[] {
    return this.withPage(pageIndex, (page) => readAnnotations(this.m, page, pageIndex))
  }

  /** Comments and markup on every page, in page order. */
  allAnnotations(): Annotation[] {
    const out: Annotation[] = []
    for (let i = 0; i < this.pageCount; i++) out.push(...this.annotations(i))
    return out
  }

  /** Adds an annotation and returns its id. */
  addAnnotation(spec: NewAnnotation, id: string = crypto.randomUUID()): string {
    return this.withPage(spec.pageIndex, (page) => addAnnotation(this.m, page, spec, id))
  }

  updateAnnotation(pageIndex: number, id: string, patch: AnnotationPatch): void {
    const ok = this.withPage(pageIndex, (page) => updateById(this.m, page, id, patch))
    if (!ok) throw new PdfError('unknown', 'That comment is no longer on the page')
  }

  removeAnnotation(pageIndex: number, id: string): void {
    const ok = this.withPage(pageIndex, (page) => removeById(this.m, page, id))
    if (!ok) throw new PdfError('unknown', 'That comment is no longer on the page')
  }

  // ---- Forms and signatures ---------------------------------------------------

  /** Fillable fields on one page. */
  formFields(pageIndex: number): FormField[] {
    return this.withPage(pageIndex, (page) => readFields(this.m, this.formEnv(), page, pageIndex))
  }

  /** Fillable fields on every page, in page order. */
  allFormFields(): FormField[] {
    const out: FormField[] = []
    for (let i = 0; i < this.pageCount; i++) out.push(...this.formFields(i))
    return out
  }

  /** Changes a field through the widget at `index` on the page. */
  setFormField(pageIndex: number, index: number, value: FieldValue): void {
    this.withPage(pageIndex, (page) => setField(this.m, this.formEnv(), page, index, value))
  }

  /** Places an image (a signature, initials) as a stamp; returns its id. */
  addImageStamp(
    pageIndex: number,
    rect: { x: number; y: number; width: number; height: number },
    image: StampImage,
    { author = '', label = '', id = crypto.randomUUID() }: { author?: string; label?: string; id?: string } = {},
  ): string {
    this.withPage(pageIndex, (page) =>
      addImageStamp(this.m, this.handle, page, rect, image, id, (annot) => setCommonFields(this.m, annot, author, label)),
    )
    return id
  }

  // ---- Watermarks, headers, footers and passwords -----------------------------

  /** Stamps text on pages: watermarks, headers, footers and page numbers. */
  addPageText(items: PageText[], { pages, startAt = 1, date = new Date().toLocaleDateString() }: PageTextOptions = {}): void {
    const indexes = pages ?? Array.from({ length: this.pageCount }, (_, i) => i)
    indexes.forEach((i) => this.checkPage(i))
    if (!items.some((t) => t.text.trim())) throw new PdfError('unknown', 'Type some text to add')
    for (const i of indexes) {
      this.withPage(i, (page) => {
        let changed = false
        for (const item of items) {
          const text = fillPlaceholders(item.text, i + startAt, this.pageCount + startAt - 1, date)
          changed = addPageText(this.m, this.handle, page, item, text) || changed
        }
        if (changed && !this.m.FPDFPage_GenerateContent(page)) throw new PdfError('unknown', 'PDFium could not update the page')
      })
    }
  }

  /** Removes watermarks, headers or footers; returns how many pages had any. */
  removePageText(kinds: PageTextKind[]): number {
    let pages = 0
    for (let i = 0; i < this.pageCount; i++) {
      this.withPage(i, (page) => {
        if (removePageText(this.m, page, kinds) > 0) {
          pages++
          this.m.FPDFPage_GenerateContent(page)
        }
      })
    }
    return pages
  }

  /** Which kinds of watermark, header or footer the document has. */
  pageTextKinds(): PageTextKind[] {
    const found = new Set<PageTextKind>()
    for (let i = 0; i < this.pageCount; i++) this.withPage(i, (page) => pageTextKinds(this.m, page).forEach((k) => found.add(k)))
    return [...found]
  }

  get security(): Security {
    if (this.closed) throw new PdfError('unknown', 'Document is closed')
    const encrypted = !!this.m.EPDF_IsEncrypted(this.handle)
    return {
      encrypted,
      ownerUnlocked: !encrypted || !!this.m.EPDF_IsOwnerUnlocked(this.handle),
      permissions: permissionsFrom(encrypted ? this.m.FPDF_GetDocPermissions(this.handle) : -1),
    }
  }

  /** Unlocks changing security on a file opened with its open password. */
  unlockOwner(ownerPassword: string): void {
    if (!this.m.EPDF_UnlockOwnerPermissions(this.handle, ownerPassword)) {
      throw new PdfError('password', 'That is not the permissions password')
    }
  }

  /**
   * Encrypts the file (AES-256) when it is next saved. An empty open password
   * lets anyone open it, with the permissions applied; the permissions
   * password lifts them.
   */
  protect(openPassword: string, ownerPassword: string, permissions: Permissions): void {
    this.requireOwner()
    const owner = ownerPassword || openPassword
    if (!owner) throw new PdfError('unknown', 'Set an open password or a permissions password')
    if (!this.m.EPDF_SetEncryption(this.handle, openPassword, owner, permissionBits(permissions))) {
      throw new PdfError('unknown', 'PDFium could not set the password')
    }
  }

  /** Removes the password and restrictions when the file is next saved. */
  unprotect(): void {
    this.requireOwner()
    if (!this.m.EPDF_RemoveEncryption(this.handle)) throw new PdfError('unknown', 'PDFium could not remove the password')
  }

  private requireOwner() {
    if (!this.security.ownerUnlocked) {
      throw new PdfError('security', 'Enter the permissions password to change this file\'s security')
    }
  }

  /** Characters and their boxes, for selecting text on a page. */
  textLayout(pageIndex: number): TextLayout {
    return this.withTextPage(pageIndex, (text, page) => readTextLayout(this.m, page, text))
  }

  private form: FormEnv | null = null

  private formEnv(): FormEnv {
    this.form ??= new FormEnv(this.m, this.handle)
    return this.form
  }

  /** True when the file has fillable fields (AcroForm or XFA). */
  get hasForm(): boolean {
    return this.m.FPDF_GetFormType(this.handle) !== 0
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.state.crashed) return // memory is not trustworthy; drop the engine instead
    this.form?.close()
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

  private withTextPage<T>(pageIndex: number, fn: (text: number, page: number) => T): T {
    return this.withPage(pageIndex, (page) => {
      const text = this.m.FPDFText_LoadPage(page)
      if (!text) throw new PdfError('page', `PDFium could not read text on page ${pageIndex}`)
      try {
        return fn(text, page)
      } finally {
        this.m.FPDFText_ClosePage(text)
      }
    })
  }
}

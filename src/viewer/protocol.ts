// Messages between the viewer (main thread) and the PDF engine worker.
import type {
  Annotation,
  AnnotationPatch,
  FieldValue,
  FormField,
  NewAnnotation,
  OutlineItem,
  PageSize,
  CompressOptions,
  OcrWord,
  PageText,
  PageTextKind,
  PageTextOptions,
  Permissions,
  Security,
  PdfErrorCode,
  SearchHit,
  StampImage,
  TextLayout,
} from '../engine/pdfium'
import type { Rect, ReplaceResult, TextLine } from '../engine/pdfium'
import type { Comparison } from '../engine/compare'
import type { SignatureCheck } from '../engine/sign'

export type { TextLayout }

export type Request =
  | { id: number; type: 'open'; bytes: Uint8Array; password: string }
  /** `forms: false` leaves form fields out, for when the viewer draws its own inputs over them. */
  | { id: number; type: 'render'; docId: number; pageIndex: number; scale: number; forms?: boolean }
  | { id: number; type: 'search'; docId: number; query: string }
  | { id: number; type: 'close'; docId: number }
  | { id: number; type: 'cancel'; target: number }
  | { id: number; type: 'edit'; docId: number; edit: Edit }
  | { id: number; type: 'undo'; docId: number }
  | { id: number; type: 'save'; docId: number }
  | { id: number; type: 'extract'; docId: number; pages: number[] }
  /** Comments and markup on every page. */
  | { id: number; type: 'annotations'; docId: number }
  | { id: number; type: 'textLayout'; docId: number; pageIndex: number }
  | { id: number; type: 'formFields'; docId: number }
  /** Which kinds of watermark, header or footer the document has. */
  | { id: number; type: 'pageTextKinds'; docId: number }
  /** Pages with no text, which probably need OCR. */
  | { id: number; type: 'ocrCandidates'; docId: number }
  | { id: number; type: 'textLines'; docId: number; pageIndex: number }
  /** Digital signatures, checked against the file as it was opened or last signed. */
  | { id: number; type: 'signatures'; docId: number }
  /** Word-level differences from `otherDocId` (the older version) to `docId`. */
  | { id: number; type: 'compare'; docId: number; otherDocId: number }
  /** Enter the permissions password, so security can be changed. */
  | { id: number; type: 'unlockOwner'; docId: number; password: string }

/** A change to the open document. Page numbers are 0-based indexes. */
export type Edit =
  | { kind: 'rotate'; pages: number[]; degrees: number }
  | { kind: 'delete'; pages: number[] }
  | { kind: 'move'; pages: number[]; dest: number }
  /** Pages from another PDF, inserted before `at` (all pages when `pages` is omitted). */
  | { kind: 'insert'; bytes: Uint8Array; password?: string; pages?: number[]; at: number }
  | { kind: 'annot-add'; id: string; annot: NewAnnotation }
  | { kind: 'annot-update'; pageIndex: number; id: string; patch: AnnotationPatch }
  | { kind: 'annot-remove'; pageIndex: number; id: string }
  | { kind: 'field'; pageIndex: number; index: number; value: FieldValue }
  | { kind: 'stamp'; pageIndex: number; id: string; rect: Rect; image: StampImage; author?: string; label?: string }
  | { kind: 'page-text'; items: PageText[]; options?: PageTextOptions }
  | { kind: 'page-text-remove'; kinds: PageTextKind[] }
  /** Applies on save; the document is saved and reopened at once so its state is current. */
  | { kind: 'protect'; openPassword: string; ownerPassword: string; permissions: Permissions }
  | { kind: 'unprotect' }
  | { kind: 'compress'; options: CompressOptions }
  /** Recognised words to add as invisible text, per page. */
  | { kind: 'ocr'; pages: { pageIndex: number; words: OcrWord[] }[] }
  /** Areas to redact, in view points. Permanent once the file is saved. */
  | { kind: 'redact'; marks: { pageIndex: number; rect: Rect }[] }
  /** Replaces one line of text; `expected` is its text when it was read. Empty text deletes it. */
  | { kind: 'text'; pageIndex: number; objects: number[]; expected: string; text: string }
  /** Signs with a certificate file. `rect` is in view points; omit it for an invisible signature. */
  | { kind: 'certify'; p12: Uint8Array; password: string; pageIndex: number; rect?: Rect; reason?: string; location?: string }

export interface DocInfo {
  pageCount: number
  sizes: PageSize[]
  outline: OutlineItem[]
  /** Number of edits that can be undone. */
  undoDepth: number
  /** The file has fillable form fields. */
  hasForm: boolean
  security: Security
  /** After a compress edit: what changed. Sizes are of the saved file, in bytes. */
  compressed?: { images: number; before: number; after: number }
  /** How many digital signatures the file has. */
  signatureCount: number
  /** After a text edit: set when a standard font stood in for the file's own. */
  replaced?: ReplaceResult
}

export interface SignaturesResult {
  checks: SignatureCheck[]
  /** The file has unsaved edits, which a signature cannot be checked against. */
  edited: boolean
}

export interface OpenResult extends DocInfo {
  docId: number
}

export interface BytesResult {
  bytes: Uint8Array
}

export interface TextLayoutResult {
  text: string
  /** x, y, width, height per character; see TextLayout. */
  boxes: Float32Array
}

export interface RenderResult {
  width: number
  height: number
  /** RGBA pixels; transferred, not copied. */
  pixels: ArrayBuffer
}

export type Response =
  | { id: number; ok: true; value: OpenResult | DocInfo | RenderResult | BytesResult | SearchHit[] | Annotation[] | FormField[] | TextLayoutResult | PageTextKind[] | TextLine[] | Comparison | SignaturesResult | number[] | null }
  | { id: number; ok: false; error: { code: PdfErrorCode | 'cancelled'; message: string } }

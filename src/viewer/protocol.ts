// Messages between the viewer (main thread) and the PDF engine worker.
import type {
  Annotation,
  AnnotationPatch,
  FieldValue,
  FormField,
  NewAnnotation,
  OutlineItem,
  PageSize,
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
import type { Rect } from '../engine/pdfium'

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

export interface DocInfo {
  pageCount: number
  sizes: PageSize[]
  outline: OutlineItem[]
  /** Number of edits that can be undone. */
  undoDepth: number
  /** The file has fillable form fields. */
  hasForm: boolean
  security: Security
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
  | { id: number; ok: true; value: OpenResult | DocInfo | RenderResult | BytesResult | SearchHit[] | Annotation[] | FormField[] | TextLayoutResult | PageTextKind[] | null }
  | { id: number; ok: false; error: { code: PdfErrorCode | 'cancelled'; message: string } }

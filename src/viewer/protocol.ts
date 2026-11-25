// Messages between the viewer (main thread) and the PDF engine worker.
import type { Annotation, AnnotationPatch, NewAnnotation, OutlineItem, PageSize, PdfErrorCode, SearchHit, TextLayout } from '../engine/pdfium'

export type { TextLayout }

export type Request =
  | { id: number; type: 'open'; bytes: Uint8Array; password: string }
  | { id: number; type: 'render'; docId: number; pageIndex: number; scale: number }
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

export interface DocInfo {
  pageCount: number
  sizes: PageSize[]
  outline: OutlineItem[]
  /** Number of edits that can be undone. */
  undoDepth: number
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
  | { id: number; ok: true; value: OpenResult | DocInfo | RenderResult | BytesResult | SearchHit[] | Annotation[] | TextLayoutResult | null }
  | { id: number; ok: false; error: { code: PdfErrorCode | 'cancelled'; message: string } }

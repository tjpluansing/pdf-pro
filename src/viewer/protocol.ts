// Messages between the viewer (main thread) and the PDF engine worker.
import type { OutlineItem, PageSize, PdfErrorCode, SearchHit } from '../engine/pdfium'

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

/** A change to the open document. Page numbers are 0-based indexes. */
export type Edit =
  | { kind: 'rotate'; pages: number[]; degrees: number }
  | { kind: 'delete'; pages: number[] }
  | { kind: 'move'; pages: number[]; dest: number }
  /** Pages from another PDF, inserted before `at` (all pages when `pages` is omitted). */
  | { kind: 'insert'; bytes: Uint8Array; password?: string; pages?: number[]; at: number }

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

export interface RenderResult {
  width: number
  height: number
  /** RGBA pixels; transferred, not copied. */
  pixels: ArrayBuffer
}

export type Response =
  | { id: number; ok: true; value: OpenResult | DocInfo | RenderResult | BytesResult | SearchHit[] | null }
  | { id: number; ok: false; error: { code: PdfErrorCode | 'cancelled'; message: string } }

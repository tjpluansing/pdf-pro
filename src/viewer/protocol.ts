// Messages between the viewer (main thread) and the PDF engine worker.
import type { OutlineItem, PageSize, PdfErrorCode, SearchHit } from '../engine/pdfium'

export type Request =
  | { id: number; type: 'open'; bytes: Uint8Array; password: string }
  | { id: number; type: 'render'; docId: number; pageIndex: number; scale: number }
  | { id: number; type: 'search'; docId: number; query: string }
  | { id: number; type: 'close'; docId: number }
  | { id: number; type: 'cancel'; target: number }

export interface OpenResult {
  docId: number
  pageCount: number
  sizes: PageSize[]
  outline: OutlineItem[]
}

export interface RenderResult {
  width: number
  height: number
  /** RGBA pixels; transferred, not copied. */
  pixels: ArrayBuffer
}

export type Response =
  | { id: number; ok: true; value: OpenResult | RenderResult | SearchHit[] | null }
  | { id: number; ok: false; error: { code: PdfErrorCode | 'cancelled'; message: string } }

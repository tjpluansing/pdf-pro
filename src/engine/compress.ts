/**
 * Makes files smaller by downsampling and re-encoding large images as JPEG,
 * the main thing that makes PDFs big. Everything else is left as it is.
 *
 * An image is only replaced when the new copy is clearly smaller, so running
 * this twice, or on a file of small images, changes nothing.
 */
import type { WrappedPdfiumModule } from '@embedpdf/pdfium'
import jpeg from 'jpeg-js'

export interface CompressOptions {
  /** Images sharper than this, at the size they are shown, are scaled down. */
  maxDpi: number
  /** JPEG quality, 1 to 100. */
  quality: number
}

export const COMPRESS_PRESETS = {
  smallest: { maxDpi: 96, quality: 50 },
  balanced: { maxDpi: 150, quality: 70 },
  high: { maxDpi: 220, quality: 85 },
} satisfies Record<string, CompressOptions>

export interface CompressResult {
  /** Images replaced with smaller copies. */
  images: number
  /** Images looked at. */
  seen: number
}

const IMAGE = 3
const FORM = 5
// FPDFBitmap formats.
const GRAY = 1
const BGR = 2
const BGRX = 3
const BGRA = 4
/** Smaller than this (encoded), an image isn't worth touching. */
const MIN_BYTES = 20_000
/** Filters for 1-bit scans, which are already far smaller than any JPEG. */
const KEEP_FILTERS = new Set(['JBIG2Decode', 'CCITTFaxDecode'])

export function compressPage(m: WrappedPdfiumModule, doc: number, page: number, opts: CompressOptions, result: CompressResult): boolean {
  let changed = false
  const visit = (count: number, get: (i: number) => number) => {
    for (let i = 0; i < count; i++) {
      const obj = get(i)
      if (!obj) continue
      const type = m.FPDFPageObj_GetType(obj)
      if (type === FORM) visit(m.FPDFFormObj_CountObjects(obj), (j) => m.FPDFFormObj_GetObject(obj, j))
      else if (type === IMAGE) {
        result.seen++
        if (compressImage(m, doc, page, obj, opts)) {
          result.images++
          changed = true
        }
      }
    }
  }
  visit(m.FPDFPage_CountObjects(page), (i) => m.FPDFPage_GetObject(page, i))
  return changed
}

function compressImage(m: WrappedPdfiumModule, doc: number, page: number, obj: number, opts: CompressOptions): boolean {
  const raw = m.FPDFImageObj_GetImageDataRaw(obj, 0, 0)
  if (raw < MIN_BYTES) return false
  if (filters(m, obj).some((f) => KEEP_FILTERS.has(f))) return false
  const meta = metadata(m, page, obj)
  // 1-bit images and image masks are line art; JPEG would make them blurry and bigger.
  if (!meta || meta.bpp <= 1 || meta.width < 16 || meta.height < 16) return false

  const bitmap = m.FPDFImageObj_GetBitmap(obj)
  if (!bitmap) return false
  let rgba: Uint8Array
  let width: number
  let height: number
  try {
    const format = m.FPDFBitmap_GetFormat(bitmap)
    // A bitmap with its own alpha would lose its transparency as a JPEG.
    if (format === BGRA || ![GRAY, BGR, BGRX].includes(format)) return false
    width = m.FPDFBitmap_GetWidth(bitmap)
    height = m.FPDFBitmap_GetHeight(bitmap)
    rgba = toRgba(m, bitmap, format, width, height)
  } finally {
    m.FPDFBitmap_Destroy(bitmap)
  }
  if (hasTransparency(m, doc, page, obj)) return false

  // Scale down to the target resolution at the size the image is shown.
  const dpi = Math.max(meta.dpiX, meta.dpiY)
  const scale = dpi > opts.maxDpi ? opts.maxDpi / dpi : 1
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const pixels = scale < 1 ? downsample(rgba, width, height, w, h) : rgba
  const encoded = encodeJpeg(pixels, w, h, opts.quality)
  if (encoded.length > raw * 0.9) return false

  const ptr = m.pdfium.wasmExports.malloc(encoded.length)
  const pages = m.pdfium.wasmExports.malloc(4)
  try {
    ;(m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8.set(encoded, ptr)
    m.pdfium.setValue(pages, page, 'i32')
    return !!m.EPDFImageObj_SetJpeg(pages, 1, obj, ptr, encoded.length)
  } finally {
    m.pdfium.wasmExports.free(ptr)
    m.pdfium.wasmExports.free(pages)
  }
}

/**
 * jpeg-js returns a Node Buffer when bundled as CommonJS, which browsers and
 * workers don't have; a Uint8Array is all it needs.
 */
function encodeJpeg(data: Uint8Array, width: number, height: number, quality: number): Uint8Array {
  const g = globalThis as { Buffer?: unknown }
  const shim = g.Buffer === undefined
  if (shim) g.Buffer = { from: (a: ArrayLike<number>) => Uint8Array.from(a) }
  try {
    return jpeg.encode({ data, width, height }, quality).data
  } finally {
    if (shim) delete g.Buffer
  }
}

function filters(m: WrappedPdfiumModule, obj: number): string[] {
  const out: string[] = []
  const n = m.FPDFImageObj_GetImageFilterCount(obj)
  for (let i = 0; i < n; i++) {
    const len = m.FPDFImageObj_GetImageFilter(obj, i, 0, 0)
    if (len <= 1) continue
    const buf = m.pdfium.wasmExports.malloc(len)
    try {
      m.FPDFImageObj_GetImageFilter(obj, i, buf, len)
      out.push(m.pdfium.UTF8ToString(buf))
    } finally {
      m.pdfium.wasmExports.free(buf)
    }
  }
  return out
}

function metadata(m: WrappedPdfiumModule, page: number, obj: number) {
  // FPDF_IMAGEOBJ_METADATA: width, height, horizontal_dpi, vertical_dpi, bits_per_pixel, colorspace, marked_content_id.
  const p = m.pdfium.wasmExports.malloc(28)
  try {
    if (!m.FPDFImageObj_GetImageMetadata(obj, page, p)) return null
    return {
      width: m.pdfium.getValue(p, 'i32') >>> 0,
      height: m.pdfium.getValue(p + 4, 'i32') >>> 0,
      dpiX: m.pdfium.getValue(p + 8, 'float'),
      dpiY: m.pdfium.getValue(p + 12, 'float'),
      bpp: m.pdfium.getValue(p + 16, 'i32') >>> 0,
    }
  } finally {
    m.pdfium.wasmExports.free(p)
  }
}

/** True when the image is drawn with a soft mask or colour-key transparency. */
function hasTransparency(m: WrappedPdfiumModule, doc: number, page: number, obj: number): boolean {
  const bmp = m.FPDFImageObj_GetRenderedBitmap(doc, page, obj)
  if (!bmp) return false
  try {
    if (m.FPDFBitmap_GetFormat(bmp) !== BGRA) return false
    const w = m.FPDFBitmap_GetWidth(bmp)
    const h = m.FPDFBitmap_GetHeight(bmp)
    const stride = m.FPDFBitmap_GetStride(bmp)
    const base = m.FPDFBitmap_GetBuffer(bmp)
    const heap = (m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8
    for (let y = 0; y < h; y++) {
      const row = base + y * stride
      for (let x = 3; x < w * 4; x += 4) if (heap[row + x] < 250) return true
    }
    return false
  } finally {
    m.FPDFBitmap_Destroy(bmp)
  }
}

function toRgba(m: WrappedPdfiumModule, bitmap: number, format: number, width: number, height: number): Uint8Array {
  const stride = m.FPDFBitmap_GetStride(bitmap)
  const base = m.FPDFBitmap_GetBuffer(bitmap)
  const heap = (m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8
  const out = new Uint8Array(width * height * 4)
  const bpp = format === GRAY ? 1 : format === BGR ? 3 : 4
  for (let y = 0; y < height; y++) {
    const row = base + y * stride
    for (let x = 0; x < width; x++) {
      const s = row + x * bpp
      const d = (y * width + x) * 4
      if (bpp === 1) out[d] = out[d + 1] = out[d + 2] = heap[s]
      else {
        out[d] = heap[s + 2]
        out[d + 1] = heap[s + 1]
        out[d + 2] = heap[s]
      }
      out[d + 3] = 255
    }
  }
  return out
}

/** Box-filter downscale: each output pixel averages the input pixels it covers. */
export function downsample(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4)
  const fx = sw / dw
  const fy = sh / dh
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * fy)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx))
      let r = 0
      let g = 0
      let b = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const s = (yy * sw + xx) * 4
          r += src[s]
          g += src[s + 1]
          b += src[s + 2]
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const d = (y * dw + x) * 4
      out[d] = r / n
      out[d + 1] = g / n
      out[d + 2] = b / n
      out[d + 3] = 255
    }
  }
  return out
}

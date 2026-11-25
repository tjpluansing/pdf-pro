// Saved signatures and the image helpers the signature dialog uses.
import type { StampImage } from '../engine/pdfium'

export type SignatureKind = 'signature' | 'initials'

const STORE_KEY: Record<SignatureKind, string> = { signature: 'pdfpro.signature', initials: 'pdfpro.initials' }
export const INK = '#14213d'
export const SCRIPT_FONTS = ['"Segoe Script"', '"Brush Script MT"', '"Snell Roundhand"', '"Apple Chancery"', 'cursive']

/** The saved signature or initials as a PNG data URL, if this browser has one. */
export function savedSignature(kind: SignatureKind): string | null {
  try {
    return localStorage.getItem(STORE_KEY[kind])
  } catch {
    return null
  }
}

export function storeSignature(kind: SignatureKind, dataUrl: string | null) {
  try {
    if (dataUrl) localStorage.setItem(STORE_KEY[kind], dataUrl)
    else localStorage.removeItem(STORE_KEY[kind])
  } catch {
    // Storage can be off (private windows); the signature still works for this session.
  }
}

/** Crops a canvas to its non-transparent pixels, with a small margin. */
export function trimmed(src: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = src.getContext('2d')!
  const { width, height } = src
  const data = ctx.getImageData(0, 0, width, height).data
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  if (x1 < 0) return null
  const pad = 4
  x0 = Math.max(0, x0 - pad)
  y0 = Math.max(0, y0 - pad)
  x1 = Math.min(width - 1, x1 + pad)
  y1 = Math.min(height - 1, y1 + pad)
  const out = document.createElement('canvas')
  out.width = x1 - x0 + 1
  out.height = y1 - y0 + 1
  out.getContext('2d')!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height)
  return out
}

/** Decodes a saved signature into pixels for the engine, at most `maxWidth` wide. */
export async function signaturePixels(dataUrl: string, maxWidth = 800): Promise<StampImage> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const scale = Math.min(1, maxWidth / img.naturalWidth)
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(img.naturalWidth * scale))
  c.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, 0, 0, c.width, c.height)
  const { data } = ctx.getImageData(0, 0, c.width, c.height)
  return { width: c.width, height: c.height, rgba: new Uint8Array(data.buffer) }
}

export function forgetSignature(kind: SignatureKind) {
  storeSignature(kind, null)
}

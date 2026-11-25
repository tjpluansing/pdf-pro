import type { DocHandle } from './client'

/** Print resolution. 150 dpi keeps text sharp on paper without huge memory use. */
const PRINT_DPI = 150

/**
 * Prints every page by rendering it to an image in a hidden iframe and opening
 * the system print dialog. Each page keeps its own size and orientation.
 */
export async function printDocument(doc: DocHandle, onProgress?: (done: number, total: number) => void): Promise<void> {
  const urls: string[] = []
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  document.body.appendChild(frame)
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    for (let i = 0; i < doc.pageCount; i++) {
      const img = await doc.render(i, PRINT_DPI / 72)
      canvas.width = img.width
      canvas.height = img.height
      ctx.putImageData(img, 0, 0)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error(`Could not prepare page ${i + 1} for printing`)
      urls.push(URL.createObjectURL(blob))
      onProgress?.(i + 1, doc.pageCount)
    }

    const fdoc = frame.contentDocument!
    const pageCss = doc.sizes
      .map((s, i) => `.p${i}{page:p${i};width:${s.width}pt;height:${s.height}pt}@page p${i}{size:${s.width}pt ${s.height}pt;margin:0}`)
      .join('')
    fdoc.open()
    fdoc.write(
      `<!doctype html><html><head><title>Print</title><style>` +
        `html,body{margin:0;padding:0}img{display:block;break-after:page}img:last-child{break-after:auto}${pageCss}` +
        `</style></head><body>${urls.map((u, i) => `<img class="p${i}" src="${u}">`).join('')}</body></html>`,
    )
    fdoc.close()
    await Promise.all(
      Array.from(fdoc.images, (img) => (img.complete ? Promise.resolve() : new Promise((r) => (img.onload = img.onerror = r)))),
    )
    frame.contentWindow!.focus()
    frame.contentWindow!.print()
  } finally {
    // print() blocks until the dialog closes in most browsers; give the rest a moment before cleanup.
    setTimeout(() => {
      frame.remove()
      urls.forEach((u) => URL.revokeObjectURL(u))
    }, 1000)
  }
}

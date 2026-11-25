/**
 * Drops objects that nothing in the file points to any more.
 *
 * PDFium saves every object a file ever had, even after a page stops using
 * it: a deleted comment's text, a removed field's old appearance. That is
 * harmless for most edits but not for redaction, where whatever was removed
 * must really be gone. This rewrites the file with only what can be reached
 * from its catalog and info dictionary.
 */
import { PDFArray, PDFDict, PDFDocument, PDFRef, PDFStream, type PDFObject } from 'pdf-lib'

export async function dropUnreachable(bytes: Uint8Array): Promise<{ bytes: Uint8Array; dropped: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const ctx = doc.context
  const seen = new Set<string>()
  const stack: PDFObject[] = []
  const { Root, Info } = ctx.trailerInfo
  for (const start of [Root, Info]) if (start) stack.push(start)

  while (stack.length) {
    const obj = stack.pop()!
    if (obj instanceof PDFRef) {
      if (seen.has(obj.tag)) continue
      seen.add(obj.tag)
      const target = ctx.lookup(obj)
      if (target) stack.push(target)
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) stack.push(v)
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) stack.push(obj.get(i))
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict)
    }
  }

  let dropped = 0
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) {
      ctx.delete(ref)
      dropped++
    }
  }
  return { bytes: await doc.save({ updateFieldAppearances: false }), dropped }
}

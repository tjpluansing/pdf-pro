// Text selection over a page's character boxes (see TextLayout). Pure, so it is unit-tested.
import type { Point, TextLayout } from '../engine/pdfium'
import type { Rect } from '../engine/pdfium'

function box(l: TextLayout, i: number): Rect {
  const b = l.boxes
  return { x: b[i * 4], y: b[i * 4 + 1], width: b[i * 4 + 2], height: b[i * 4 + 3] }
}

const empty = (r: Rect) => r.width <= 0 || r.height <= 0

/**
 * The caret position (0..length) nearest to `p`: before or after the closest
 * character. Vertical distance counts more, so a point in a line's margin
 * picks that line rather than the next one.
 */
export function caretAt(l: TextLayout, p: Point): number {
  const n = l.boxes.length / 4
  let best = -1
  let bestScore = Infinity
  for (let i = 0; i < n; i++) {
    const r = box(l, i)
    if (empty(r)) continue
    const dx = p.x < r.x ? r.x - p.x : p.x > r.x + r.width ? p.x - r.x - r.width : 0
    const dy = p.y < r.y ? r.y - p.y : p.y > r.y + r.height ? p.y - r.y - r.height : 0
    const score = dy * 4 + dx
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  }
  if (best < 0) return 0
  const r = box(l, best)
  return p.x > r.x + r.width / 2 ? best + 1 : best
}

/** True when `p` is on (or within `slop` points of) a character. */
export function overText(l: TextLayout, p: Point, slop = 2): boolean {
  const n = l.boxes.length / 4
  for (let i = 0; i < n; i++) {
    const r = box(l, i)
    if (empty(r)) continue
    if (p.x >= r.x - slop && p.x <= r.x + r.width + slop && p.y >= r.y - slop && p.y <= r.y + r.height + slop) return true
  }
  return false
}

/** One rectangle per line for the characters between two carets. */
export function selectionRects(l: TextLayout, a: number, b: number): Rect[] {
  const [from, to] = a < b ? [a, b] : [b, a]
  const lines: Rect[] = []
  let cur: Rect | null = null
  for (let i = from; i < to; i++) {
    const r = box(l, i)
    if (empty(r)) continue
    const mid = r.y + r.height / 2
    if (cur && mid >= cur.y && mid <= cur.y + cur.height && r.x >= cur.x - 1) {
      const x1 = Math.max(cur.x + cur.width, r.x + r.width)
      const y0 = Math.min(cur.y, r.y)
      const y1 = Math.max(cur.y + cur.height, r.y + r.height)
      cur = { x: cur.x, y: y0, width: x1 - cur.x, height: y1 - y0 }
      lines[lines.length - 1] = cur
    } else {
      cur = { ...r }
      lines.push(cur)
    }
  }
  return lines
}

/** The selected text, with PDFium's line breaks normalised to \n. */
export function selectedText(l: TextLayout, a: number, b: number): string {
  const [from, to] = a < b ? [a, b] : [b, a]
  return l.text.slice(from, to).replace(/\r\n?/g, '\n')
}

/** Word boundaries around a caret, for double-click. */
export function wordAt(l: TextLayout, caret: number): [number, number] {
  const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_'’-]/u.test(c)
  let from = Math.min(caret, l.text.length - 1)
  if (!isWord(l.text[from]) && isWord(l.text[from - 1])) from--
  if (!isWord(l.text[from])) return [from, from + 1]
  let to = from
  while (from > 0 && isWord(l.text[from - 1])) from--
  while (to < l.text.length && isWord(l.text[to])) to++
  return [from, to]
}

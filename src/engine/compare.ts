/**
 * Compares the text of two versions of a document, word by word, the way
 * Acrobat's "Compare files" does for text: what was added, removed or
 * changed, and where each change sits on the pages of both versions.
 *
 * Works on the text layouts PDFium gives per page (characters with boxes), so
 * it needs no PDFium itself and can be tested on its own.
 */
import type { TextLayout, ViewRect } from './annotations'

export interface Word {
  text: string
  pageIndex: number
  rect: ViewRect
}

export interface Change {
  kind: 'added' | 'removed' | 'changed'
  /** Words in the older version (empty when added). */
  before: Word[]
  /** Words in the newer version (empty when removed). */
  after: Word[]
  /** The word next to the change in each version, for finding where it goes when that side has none. */
  near: { before?: Word; after?: Word }
}

export interface Comparison {
  changes: Change[]
  /** Words compared in each version. */
  words: { before: number; after: number }
  /** True when the versions differ too much for a word-level diff; `changes` then holds one change for everything. */
  tooDifferent: boolean
}

/** Splits page layouts into words with the box around each. */
export function wordsOf(layouts: TextLayout[]): Word[] {
  const words: Word[] = []
  layouts.forEach((layout, pageIndex) => {
    let text = ''
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    const flush = () => {
      if (text) words.push({ text, pageIndex, rect: x0 <= x1 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: 0, y: 0, width: 0, height: 0 } })
      text = ''
      x0 = y0 = Infinity
      x1 = y1 = -Infinity
    }
    for (let i = 0; i < layout.text.length; i++) {
      const ch = layout.text[i]
      if (/\s/.test(ch) || ch === '\u0000') {
        flush()
        continue
      }
      text += ch
      const [x, y, w, h] = layout.boxes.subarray(i * 4, i * 4 + 4)
      if (w > 0 || h > 0) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x + w)
        y1 = Math.max(y1, y + h)
      }
    }
    flush()
  })
  return words
}

/**
 * Beyond this many differing words, a word-level diff is too slow and not
 * useful. The saved frontiers grow with its square: 3,000 is about 36 MB.
 */
const MAX_EDITS = 3000

export function compareWords(before: Word[], after: Word[]): Comparison {
  const a = before.map((w) => w.text)
  const b = after.map((w) => w.text)
  const ops = diff(a, b, MAX_EDITS)
  const words = { before: a.length, after: b.length }
  if (!ops) {
    return { changes: [{ kind: 'changed', before, after, near: {} }], words, tooDifferent: true }
  }
  const changes: Change[] = []
  let i = 0
  let j = 0
  let pending: Change | null = null
  const close = () => {
    if (!pending) return
    pending.kind = pending.before.length && pending.after.length ? 'changed' : pending.before.length ? 'removed' : 'added'
    changes.push(pending)
    pending = null
  }
  for (const op of ops) {
    if (op === '=') {
      close()
      i++
      j++
    } else {
      pending ??= { kind: 'changed', before: [], after: [], near: { before: before[i - 1] ?? before[i], after: after[j - 1] ?? after[j] } }
      if (op === '-') pending.before.push(before[i++])
      else pending.after.push(after[j++])
    }
  }
  close()
  return { changes, words, tooDifferent: false }
}

/**
 * Myers' O(ND) diff. Returns '=' (same), '-' (only in a) and '+' (only in b)
 * for each step, or null when more than `max` edits are needed.
 */
export function diff(a: string[], b: string[], max: number): ('=' | '-' | '+')[] | null {
  // Common ends cost nothing and are usually most of a document.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - start
  const m = endB - start
  const head = Array<'='>(start).fill('=')
  const tail = Array<'='>(a.length - endA).fill('=')
  if (n === 0 && m === 0) return [...head, ...tail]

  const limit = Math.min(n + m, max)
  const offset = limit + 1
  const v = new Int32Array(2 * limit + 3)
  // trace[d] is the frontier before step d, for diagonals -d..d only.
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice(offset - d, offset + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }
  if (found < 0) return null

  // Walk the saved frontiers back from the end to recover the path.
  const ops: ('=' | '-' | '+')[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const t = trace[d]
    const prev = (k: number) => t[k + d]
    const k = x - y
    const down = k === -d || (k !== d && prev(k - 1) < prev(k + 1))
    const pk = down ? k + 1 : k - 1
    const px = prev(pk)
    const py = px - pk
    while (x > px + (down ? 0 : 1) && y > py + (down ? 1 : 0)) {
      ops.push('=')
      x--
      y--
    }
    ops.push(down ? '+' : '-')
    if (down) y--
    else x--
  }
  while (x > 0 && y > 0) {
    ops.push('=')
    x--
    y--
  }
  return [...head, ...ops.reverse(), ...tail]
}

/** Joins the boxes of words that sit on the same line of the same page, for highlighting. */
export function lineBoxes(words: Word[]): { pageIndex: number; rect: ViewRect }[] {
  const out: { pageIndex: number; rect: ViewRect }[] = []
  for (const w of words) {
    if (w.rect.width <= 0 && w.rect.height <= 0) continue
    const last = out[out.length - 1]
    const r = w.rect
    if (last && last.pageIndex === w.pageIndex && Math.abs(last.rect.y - r.y) < r.height * 0.5 && r.x >= last.rect.x - 1) {
      const x1 = Math.max(last.rect.x + last.rect.width, r.x + r.width)
      const y1 = Math.max(last.rect.y + last.rect.height, r.y + r.height)
      last.rect.y = Math.min(last.rect.y, r.y)
      last.rect.width = x1 - last.rect.x
      last.rect.height = y1 - last.rect.y
    } else out.push({ pageIndex: w.pageIndex, rect: { ...r } })
  }
  return out
}

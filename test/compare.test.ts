import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { PdfEngine } from '../src/engine/pdfium'
import { compareWords, diff, lineBoxes, wordsOf, type Word } from '../src/engine/compare'

const require = createRequire(import.meta.url)
let engine: PdfEngine

beforeAll(async () => {
  engine = await PdfEngine.create(readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm')))
})

const words = (text: string, pageIndex = 0): Word[] =>
  text
    .split(' ')
    .filter(Boolean)
    .map((t, i) => ({ text: t, pageIndex, rect: { x: i * 40, y: 100, width: 30, height: 10 } }))

/** Applies ops to `a` and checks they produce `b`. */
function replay(a: string[], b: string[], ops: ('=' | '-' | '+')[]) {
  const out: string[] = []
  let i = 0
  let j = 0
  for (const op of ops) {
    if (op === '=') {
      expect(a[i]).toBe(b[j])
      out.push(a[i++])
      j++
    } else if (op === '-') i++
    else out.push(b[j++])
  }
  expect(i).toBe(a.length)
  expect(out).toEqual(b)
}

describe('diff', () => {
  it('finds the shortest edit script', () => {
    const cases: [string, string, number][] = [
      ['', '', 0],
      ['a b c', 'a b c', 0],
      ['a b c', 'a x c', 2],
      ['a b c', 'a b c d', 1],
      ['x a b c', 'a b c', 1],
      ['a b c a b b a', 'c b a b a c', 5],
      ['', 'a b', 2],
      ['a b', '', 2],
    ]
    for (const [x, y, d] of cases) {
      const a = x.split(' ').filter(Boolean)
      const b = y.split(' ').filter(Boolean)
      const ops = diff(a, b, 100)!
      replay(a, b, ops)
      expect(ops.filter((o) => o !== '=').length).toBe(d)
    }
  })

  it('stays correct on random edits', () => {
    let seed = 7
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n
    for (let t = 0; t < 200; t++) {
      const a = Array.from({ length: rand(40) }, () => 'w' + rand(6))
      const b = a.slice()
      for (let e = rand(8); e > 0; e--) {
        const at = rand(b.length + 1)
        if (rand(2) && b.length) b.splice(at, 1)
        else b.splice(at, 0, 'n' + rand(6))
      }
      replay(a, b, diff(a, b, 1000)!)
    }
  })

  it('gives up past the edit limit', () => {
    const a = Array.from({ length: 50 }, (_, i) => 'a' + i)
    const b = Array.from({ length: 50 }, (_, i) => 'b' + i)
    expect(diff(a, b, 20)).toBeNull()
    expect(diff(a, b, 100)).not.toBeNull()
  })
})

describe('compareWords', () => {
  it('groups edits into changes', () => {
    const r = compareWords(words('The fee is 100 dollars per month payable in advance'), words('The fee is 120 dollars per month payable in advance by card'))
    expect(r.tooDifferent).toBe(false)
    expect(r.changes.map((c) => [c.kind, c.before.map((w) => w.text).join(' '), c.after.map((w) => w.text).join(' ')])).toEqual([
      ['changed', '100', '120'],
      ['added', '', 'by card'],
    ])
    // An addition at the end sits after the last word of the older version.
    expect(r.changes[1].near.before?.text).toBe('advance')
  })

  it('reports removals', () => {
    const r = compareWords(words('one two three four'), words('one four'))
    expect(r.changes).toHaveLength(1)
    expect(r.changes[0].kind).toBe('removed')
    expect(r.changes[0].before.map((w) => w.text)).toEqual(['two', 'three'])
    expect(r.changes[0].near.after?.text).toBe('one')
  })

  it('says when versions are too different', () => {
    const a = Array.from({ length: 2000 }, (_, i) => 'a' + i).join(' ')
    const b = Array.from({ length: 2000 }, (_, i) => 'b' + i).join(' ')
    const r = compareWords(words(a), words(b))
    expect(r.tooDifferent).toBe(true)
    expect(r.changes).toHaveLength(1)
  })
})

describe('lineBoxes', () => {
  it('joins words on one line and splits across lines and pages', () => {
    const w: Word[] = [
      { text: 'a', pageIndex: 0, rect: { x: 10, y: 100, width: 20, height: 10 } },
      { text: 'b', pageIndex: 0, rect: { x: 40, y: 101, width: 20, height: 10 } },
      { text: 'c', pageIndex: 0, rect: { x: 10, y: 120, width: 20, height: 10 } },
      { text: 'd', pageIndex: 1, rect: { x: 10, y: 120, width: 20, height: 10 } },
    ]
    const boxes = lineBoxes(w)
    expect(boxes).toHaveLength(3)
    expect(boxes[0]).toEqual({ pageIndex: 0, rect: { x: 10, y: 100, width: 50, height: 11 } })
  })
})

describe('compare PDFs', () => {
  async function pdf(pages: string[][]) {
    const d = await PDFDocument.create()
    const font = await d.embedFont(StandardFonts.Helvetica)
    for (const lines of pages) {
      const p = d.addPage([612, 792])
      lines.forEach((l, i) => p.drawText(l, { x: 50, y: 720 - i * 20, size: 12, font }))
    }
    return d.save()
  }

  it('finds reworded, added and removed text with page positions', async () => {
    const older = engine.open(await pdf([['Rent is 1,200 per month.', 'Pets are allowed.'], ['Signed by the tenant.']]))
    const newer = engine.open(await pdf([['Rent is 1,350 per month.', 'Pets are allowed.', 'Parking costs extra.'], ['Signed by the tenant.']]))
    try {
      const layouts = (d: typeof older) => Array.from({ length: d.pageCount }, (_, i) => d.textLayout(i))
      const r = compareWords(wordsOf(layouts(older)), wordsOf(layouts(newer)))
      const summary = r.changes.map((c) => [c.kind, c.before.map((w) => w.text).join(' '), c.after.map((w) => w.text).join(' ')])
      expect(summary).toEqual([
        ['changed', '1,200', '1,350'],
        ['added', '', 'Parking costs extra.'],
      ])
      const changed = r.changes[0].after[0]
      expect(changed.pageIndex).toBe(0)
      // 720 from the bottom of a 792pt page is 72 from the top; the word sits on that baseline.
      expect(changed.rect.y).toBeGreaterThan(60)
      expect(changed.rect.y + changed.rect.height).toBeLessThan(76)
      expect(changed.rect.x).toBeGreaterThan(50)
      expect(r.changes[1].after[0].rect.y).toBeGreaterThan(100)
    } finally {
      older.close()
      newer.close()
    }
  })
})

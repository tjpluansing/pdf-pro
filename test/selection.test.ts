import { describe, expect, it } from 'vitest'
import { parsePageRange } from '../src/viewer/pageRange'
import { caretAt, overText, selectedText, selectionRects, wordAt } from '../src/viewer/selection'
import type { TextLayout } from '../src/engine/pdfium'

/** Two lines: "ab cd" at y=10 and "ef" at y=30, 10pt wide characters; index 5-6 is a generated line break. */
function layout(): TextLayout {
  const text = 'ab cd\r\nef'
  const boxes = new Float32Array(text.length * 4)
  const put = (i: number, x: number, y: number) => boxes.set([x, y, 10, 12], i * 4)
  ;[0, 1, 2, 3, 4].forEach((i) => put(i, 10 + i * 10, 10))
  put(7, 10, 30)
  put(8, 20, 30)
  return { text, boxes }
}

describe('text selection', () => {
  it('finds the caret before or after the nearest character', () => {
    const l = layout()
    expect(caretAt(l, { x: 12, y: 15 })).toBe(0)
    expect(caretAt(l, { x: 18, y: 15 })).toBe(1)
    expect(caretAt(l, { x: 200, y: 15 })).toBe(5)
    expect(caretAt(l, { x: 22, y: 34 })).toBe(8)
  })

  it('merges a selection into one rectangle per line', () => {
    const l = layout()
    const rects = selectionRects(l, 1, 9)
    expect(rects).toEqual([
      { x: 20, y: 10, width: 40, height: 12 },
      { x: 10, y: 30, width: 20, height: 12 },
    ])
    expect(selectedText(l, 9, 1)).toBe('b cd\nef')
  })

  it('selects a whole word and knows when the pointer is over text', () => {
    const l = layout()
    expect(wordAt(l, 4)).toEqual([3, 5])
    expect(wordAt(l, 0)).toEqual([0, 2])
    expect(overText(l, { x: 25, y: 15 })).toBe(true)
    expect(overText(l, { x: 25, y: 60 })).toBe(false)
  })
})

describe('parsePageRange', () => {
  it('reads pages, ranges and open ends', () => {
    expect(parsePageRange('', 3)).toEqual([0, 1, 2])
    expect(parsePageRange('1-3, 5', 6)).toEqual([0, 1, 2, 4])
    expect(parsePageRange('4-', 6)).toEqual([3, 4, 5])
    expect(parsePageRange('-2 2', 6)).toEqual([0, 1])
    expect(parsePageRange('7', 6)).toMatch(/1 to 6/)
    expect(parsePageRange('a', 6)).toMatch(/not a page/)
  })
})

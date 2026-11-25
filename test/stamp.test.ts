import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, degrees } from 'pdf-lib'
import { PdfEngine, PdfError, type PdfDocument } from '../src/engine/pdfium'

const require = createRequire(import.meta.url)
let engine: PdfEngine

beforeAll(async () => {
  engine = await PdfEngine.create(readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm')))
})

/** Three blank 400×600 pages; the second is turned 90° and the third 270°. */
async function threePages(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([400, 600])
  doc.addPage([400, 600]).setRotation(degrees(90))
  doc.addPage([400, 600]).setRotation(degrees(270))
  return doc.save()
}

function reopen(doc: PdfDocument, password = ''): PdfDocument {
  const bytes = doc.save()
  doc.close()
  return engine.open(bytes, password)
}

/** Where a word sits on the displayed page, in view points. */
function find(doc: PdfDocument, page: number, word: string) {
  const hit = doc.searchPage(page, word)[0]
  expect(hit, `"${word}" on page ${page + 1}`).toBeTruthy()
  return hit.rects[0]
}

describe('headers, footers and page numbers', () => {
  it('puts headers at the top and footers at the bottom of every page, as displayed', async () => {
    let doc = engine.open(await threePages())
    doc.addPageText(
      [
        { kind: 'header', text: 'Quarterly report', size: 10, color: '#333333', align: 'left' },
        { kind: 'footer', text: 'Page {page} of {pages}', size: 10, color: '#333333', align: 'right' },
      ],
      { date: '1/1/2026' },
    )
    doc = reopen(doc)
    for (let i = 0; i < 3; i++) {
      const { width, height } = doc.pageSize(i)
      const head = find(doc, i, 'Quarterly')
      expect(head.y).toBeGreaterThan(30)
      expect(head.y).toBeLessThan(40)
      expect(Math.abs(head.x - 36)).toBeLessThan(2)
      // Upright: wider than tall.
      expect(head.width).toBeGreaterThan(head.height)
      const foot = find(doc, i, `of 3`)
      expect(foot.y + foot.height).toBeGreaterThan(height - 40)
      expect(foot.y + foot.height).toBeLessThan(height - 30)
      expect(foot.x + foot.width).toBeGreaterThan(width - 40)
      expect(foot.x + foot.width).toBeLessThan(width - 30)
      expect(doc.pageText(i)).toContain(`Page ${i + 1} of 3`)
    }
    doc.close()
  })

  it('numbers from a chosen start on chosen pages, and fills in the date', async () => {
    let doc = engine.open(await threePages())
    doc.addPageText([{ kind: 'footer', text: '{page}/{pages} {date}', size: 9, color: '#000000' }], {
      pages: [1, 2],
      startAt: 5,
      date: '2026-11-25',
    })
    doc = reopen(doc)
    expect(doc.pageText(0)).not.toContain('2026-11-25')
    expect(doc.pageText(1)).toContain('6/7 2026-11-25')
    expect(doc.pageText(2)).toContain('7/7 2026-11-25')
    doc.close()
  })
})

describe('watermarks', () => {
  it('centres a watermark, turns it, and can put it behind the content', async () => {
    let doc = engine.open(await threePages())
    doc.addPageText([{ kind: 'header', text: 'TOP', size: 10, color: '#000000' }])
    doc.addPageText([{ kind: 'watermark', text: 'DRAFT', size: 72, color: '#ff0000', opacity: 0.3, rotation: 45, behind: true }])
    doc = reopen(doc)
    const { width, height } = doc.pageSize(0)
    const mark = find(doc, 0, 'DRAFT')
    expect(Math.abs(mark.x + mark.width / 2 - width / 2)).toBeLessThan(5)
    expect(Math.abs(mark.y + mark.height / 2 - height / 2)).toBeLessThan(5)
    // At 45° the box is about as tall as it is wide.
    expect(mark.height / mark.width).toBeGreaterThan(0.8)
    // Behind: drawn first, so its text comes before the header's.
    expect(doc.pageText(0).indexOf('DRAFT')).toBeLessThan(doc.pageText(0).indexOf('TOP'))
    expect(doc.pageTextKinds().sort()).toEqual(['header', 'watermark'])

    // The red shows through at 30 %: a pale pink, not solid red.
    const r = doc.renderPage(0, 1)
    let pink = 0
    let red = 0
    for (let p = 0; p < r.data.length; p += 4) {
      const [R, G, B] = [r.data[p], r.data[p + 1], r.data[p + 2]]
      if (R > 240 && G > 150 && G < 210 && B > 150 && B < 210) pink++
      if (R > 200 && G < 60) red++
    }
    expect(pink).toBeGreaterThan(200)
    expect(red).toBe(0)
    doc.close()
  })

  it('removes only the kinds asked for', async () => {
    let doc = engine.open(await threePages())
    doc.addPageText([
      { kind: 'watermark', text: 'CONFIDENTIAL', size: 48, color: '#888888' },
      { kind: 'footer', text: 'Footer text', size: 9, color: '#000000' },
    ])
    doc = reopen(doc)
    expect(doc.removePageText(['watermark'])).toBe(3)
    doc = reopen(doc)
    expect(doc.pageText(1)).not.toContain('CONFIDENTIAL')
    expect(doc.pageText(1)).toContain('Footer text')
    expect(doc.pageTextKinds()).toEqual(['footer'])
    expect(doc.removePageText(['watermark'])).toBe(0)
    doc.close()
  })

  it('refuses empty text', async () => {
    const doc = engine.open(await threePages())
    expect(() => doc.addPageText([{ kind: 'watermark', text: '  ', size: 48, color: '#000000' }])).toThrow(PdfError)
    doc.close()
  })
})

describe('passwords', () => {
  it('adds an open password with AES-256 and restrictions, then removes it', async () => {
    let doc = engine.open(await threePages())
    expect(doc.security).toMatchObject({ encrypted: false, ownerUnlocked: true })
    doc.protect('open-me', 'owner-pw', { print: true, copy: false, edit: false, comment: true })
    const bytes = doc.save()
    doc.close()

    expect(() => engine.open(bytes)).toThrow(expect.objectContaining({ code: 'password' }))
    const asUser = engine.open(bytes, 'open-me')
    expect(asUser.security).toEqual({
      encrypted: true,
      ownerUnlocked: false,
      permissions: { print: true, copy: false, edit: false, comment: true },
    })
    // Without the permissions password, security can't be changed.
    expect(() => asUser.unprotect()).toThrow(expect.objectContaining({ code: 'security' }))
    expect(() => asUser.unlockOwner('wrong')).toThrow(expect.objectContaining({ code: 'password' }))
    asUser.unlockOwner('owner-pw')
    asUser.unprotect()
    doc = reopen(asUser, '')
    expect(doc.security.encrypted).toBe(false)
    expect(doc.pageCount).toBe(3)
    doc.close()

    // The permissions password opens it with full rights.
    const asOwner = engine.open(bytes, 'owner-pw')
    expect(asOwner.security.ownerUnlocked).toBe(true)
    asOwner.close()
  })

  it('can restrict without an open password', async () => {
    let doc = engine.open(await threePages())
    doc.protect('', 'owner-pw', { print: false, copy: true, edit: true, comment: true })
    doc = reopen(doc)
    expect(doc.security).toMatchObject({ encrypted: true, ownerUnlocked: false, permissions: { print: false, copy: true } })
    doc.close()
  })

  it('needs at least one password', async () => {
    const doc = engine.open(await threePages())
    expect(() => doc.protect('', '', { print: true, copy: true, edit: true, comment: true })).toThrow(PdfError)
    doc.close()
  })
})

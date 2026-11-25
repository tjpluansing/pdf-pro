import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { PdfEngine, type PdfDocument } from '../src/engine/pdfium'

const require = createRequire(import.meta.url)
let engine: PdfEngine

beforeAll(async () => {
  engine = await PdfEngine.create(readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm')))
})

/** A one-page form with every common field type. */
async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([400, 400])
  const form = doc.getForm()
  const name = form.createTextField('name')
  name.addToPage(page, { x: 20, y: 340, width: 200, height: 24, font })
  name.setText('Ada')
  const notes = form.createTextField('notes')
  notes.enableMultiline()
  notes.addToPage(page, { x: 20, y: 260, width: 200, height: 60, font })
  form.createCheckBox('agree').addToPage(page, { x: 20, y: 220, width: 16, height: 16 })
  const size = form.createRadioGroup('size')
  size.addOptionToPage('S', page, { x: 20, y: 180, width: 16, height: 16 })
  size.addOptionToPage('L', page, { x: 60, y: 180, width: 16, height: 16 })
  const country = form.createDropdown('country')
  country.addOptions(['Italy', 'Japan', 'Peru'])
  country.addToPage(page, { x: 20, y: 130, width: 120, height: 22, font })
  const ro = form.createTextField('locked')
  ro.setText('fixed')
  ro.enableReadOnly()
  ro.addToPage(page, { x: 20, y: 90, width: 120, height: 22, font })
  return doc.save()
}

function reopen(doc: PdfDocument): PdfDocument {
  const bytes = doc.save()
  doc.close()
  return engine.open(bytes)
}

const byName = (doc: PdfDocument) => {
  const map = new Map<string, ReturnType<PdfDocument['formFields']>>()
  for (const f of doc.formFields(0)) map.set(f.name, [...(map.get(f.name) ?? []), f])
  return map
}

describe('form fields', () => {
  it('reads every field type with its value and position', async () => {
    const doc = engine.open(await formPdf())
    const f = byName(doc)
    expect([...f.keys()]).toEqual(['name', 'notes', 'agree', 'size', 'country', 'locked'])
    const [name] = f.get('name')!
    expect(name).toMatchObject({ type: 'text', value: 'Ada', multiline: false, readOnly: false })
    expect(Math.abs(name.rect.x - 20)).toBeLessThan(1)
    expect(Math.abs(name.rect.y - (400 - 340 - 24))).toBeLessThan(1)
    expect(f.get('notes')![0].multiline).toBe(true)
    expect(f.get('agree')![0]).toMatchObject({ type: 'checkbox', checked: false })
    expect(f.get('size')!.map((w) => w.exportValue)).toEqual(['S', 'L'])
    expect(f.get('country')![0].options!.map((o) => o.label)).toEqual(['Italy', 'Japan', 'Peru'])
    expect(f.get('locked')![0].readOnly).toBe(true)
    doc.close()
  })

  it('fills every field type and keeps the values after saving', async () => {
    let doc = engine.open(await formPdf())
    const f = byName(doc)
    doc.setFormField(0, f.get('name')![0].index, { text: 'Grace Hopper' })
    doc.setFormField(0, f.get('notes')![0].index, { text: 'Line one\nLine two' })
    doc.setFormField(0, f.get('agree')![0].index, { checked: true })
    doc.setFormField(0, f.get('size')![1].index, { checked: true })
    doc.setFormField(0, f.get('country')![0].index, { selected: [2] })
    expect(() => doc.setFormField(0, f.get('locked')![0].index, { text: 'changed' })).toThrow(/read-only/)
    doc = reopen(doc)
    const g = byName(doc)
    expect(g.get('name')![0].value).toBe('Grace Hopper')
    expect(g.get('notes')![0].value.replace(/\r\n?/g, '\n')).toBe('Line one\nLine two')
    expect(g.get('agree')![0].checked).toBe(true)
    expect(g.get('size')!.map((w) => w.checked)).toEqual([false, true])
    expect(g.get('country')![0].value).toBe('Peru')
    expect(g.get('locked')![0].value).toBe('fixed')
    // Unchecking works too.
    doc.setFormField(0, g.get('agree')![0].index, { checked: false })
    expect(byName(doc).get('agree')![0].checked).toBe(false)
    doc.close()
  })

  it('draws the filled value into the page', async () => {
    const doc = engine.open(await formPdf())
    const [name] = doc.formFields(0).filter((x) => x.name === 'name')
    const before = doc.renderPage(0, 1).data
    doc.setFormField(0, name.index, { text: 'WWWWWWWWWWWWWWWW' })
    const after = doc.renderPage(0, 1).data
    const dark = (d: Uint8ClampedArray) => {
      let n = 0
      for (let y = 40; y < 60; y++) for (let x = 25; x < 215; x++) if (d[(y * 400 + x) * 4] < 100) n++
      return n
    }
    expect(dark(after)).toBeGreaterThan(dark(before) + 100)
    doc.close()
  })
})

describe('signature stamps', () => {
  /** 20x10 image: red top half, blue bottom half. */
  const image = () => {
    const rgba = new Uint8Array(20 * 10 * 4)
    for (let i = 0; i < 200; i++) rgba.set(i < 100 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4)
    return { width: 20, height: 10, rgba }
  }

  it('places an upright image where asked, on plain and rotated pages', async () => {
    for (const rotate of [0, 90, 180, 270]) {
      const src = await PDFDocument.create()
      src.addPage([300, 200]).setRotation(degrees(rotate))
      let doc = engine.open(await src.save())
      const rect = { x: 40, y: 30, width: 80, height: 40 }
      const id = doc.addImageStamp(0, rect, image(), { author: 'Paolo', label: 'Signature' })
      doc = reopen(doc)
      const [stamp] = doc.annotations(0)
      expect(stamp).toMatchObject({ id, kind: 'stamp', author: 'Paolo', contents: 'Signature' })
      expect(stamp.rect.x).toBeCloseTo(40, 0)
      expect(stamp.rect.y).toBeCloseTo(30, 0)
      expect(stamp.rect.width).toBeCloseTo(80, 0)
      const page = doc.renderPage(0, 1)
      const px = (x: number, y: number) => Array.from(page.data.slice((y * page.width + x) * 4, (y * page.width + x) * 4 + 3))
      expect(px(80, 38), `top half red at ${rotate}°`).toEqual([255, 0, 0])
      expect(px(80, 62), `bottom half blue at ${rotate}°`).toEqual([0, 0, 255])
      expect(px(150, 50)).toEqual([255, 255, 255])
      doc.close()
    }
  })

  it('moves a stamp with its image', async () => {
    const src = await PDFDocument.create()
    src.addPage([300, 200])
    let doc = engine.open(await src.save())
    const id = doc.addImageStamp(0, { x: 10, y: 10, width: 40, height: 20 }, image())
    doc.updateAnnotation(0, id, { moveTo: { x: 200, y: 150 } })
    doc = reopen(doc)
    const page = doc.renderPage(0, 1)
    const px = (x: number, y: number) => Array.from(page.data.slice((y * page.width + x) * 4, (y * page.width + x) * 4 + 3))
    expect(px(220, 154)).toEqual([255, 0, 0])
    expect(px(20, 14)).toEqual([255, 255, 255])
    doc.close()
  })
})

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { PdfEngine } from '../src/engine/pdfium'
import { SignError, signPdf, signerFromP12, type Signer } from '../src/engine/sign'

const require = createRequire(import.meta.url)
const p12 = readFileSync(join(__dirname, 'fixtures/test-signer.p12'))
/** Set SIGN_OUT to a folder to keep the signed files, e.g. to check them with pdfsig. */
const keep = process.env.SIGN_OUT
let engine: PdfEngine
let signer: Signer

beforeAll(async () => {
  engine = await PdfEngine.create(readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm')))
  signer = signerFromP12(p12, 'test1234')
})

async function contract(objectStreams: boolean) {
  const d = await PDFDocument.create()
  const font = await d.embedFont(StandardFonts.Helvetica)
  d.addPage([612, 792]).drawText('Contract to sign', { x: 50, y: 700, size: 20, font })
  d.addPage([612, 792])
  return d.save({ useObjectStreams: objectStreams })
}

describe('certificate signatures', () => {
  it('reads the signer from a .p12 and rejects a wrong password', () => {
    expect(signer.name).toBe('Test Signer')
    expect(() => signerFromP12(p12, 'nope')).toThrow(SignError)
    expect(() => signerFromP12(new Uint8Array([1, 2, 3]), '')).toThrow(SignError)
  })

  for (const objectStreams of [true, false]) {
    it(`signs twice without breaking the first signature (${objectStreams ? 'xref stream' : 'xref table'})`, async () => {
      const original = await contract(objectStreams)
      const once = await signPdf(original, signer, { pageIndex: 0, rect: [350, 80, 560, 140], reason: 'I approve', location: 'Manila' })
      // An incremental update: the original file is untouched at the start.
      expect(Buffer.from(once.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true)
      const twice = await signPdf(once, signer, { pageIndex: 1, reason: 'Second signer' })
      expect(Buffer.from(twice.subarray(0, once.length)).equals(Buffer.from(once))).toBe(true)
      if (keep) writeFileSync(join(keep, `signed-${objectStreams ? 'xs' : 'tbl'}.pdf`), twice)

      const doc = engine.open(twice)
      try {
        const sigs = doc.signatures(twice)
        expect(sigs.map((s) => [s.status, s.signer, s.reason])).toEqual([
          ['changed-after', 'Test Signer', 'I approve'],
          ['valid', 'Test Signer', 'Second signer'],
        ])
        expect(sigs[0].selfSigned).toBe(true)
        // The visible signature's blue border is drawn on page 1 (box from x 350, 652pt from the top).
        // Also when the viewer draws form inputs itself (forms: false), since nothing else shows a signed field.
        const { width, data } = doc.renderPage(0, 1, { forms: false })
        const px = (x: number, y: number) => Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3))
        const [r, g, b] = px(350, 680)
        expect(b).toBeGreaterThan(150)
        expect(r).toBeLessThan(120)
        expect(g).toBeLessThan(160)
      } finally {
        doc.close()
      }
    })
  }

  it('checks a signature made by another program, and keeps it valid when adding one', async () => {
    // Signed by poppler's pdfsig (NSS) with the same test certificate.
    const theirs = new Uint8Array(readFileSync(join(__dirname, 'fixtures/poppler-signed.pdf')))
    const before = engine.open(theirs)
    try {
      expect(before.signatures(theirs).map((s) => [s.status, s.signer, s.reason])).toEqual([['valid', 'Test Signer', 'Poppler signed']])
    } finally {
      before.close()
    }
    const both = await signPdf(theirs, signer, { pageIndex: 0, rect: [350, 80, 560, 140] })
    if (keep) writeFileSync(join(keep, 'signed-over-poppler.pdf'), both)
    const after = engine.open(both)
    try {
      expect(after.signatures(both).map((s) => s.status)).toEqual(['changed-after', 'valid'])
    } finally {
      after.close()
    }
  })

  it('catches a change to the signed bytes', async () => {
    const signed = await signPdf(await contract(false), signer, { pageIndex: 0, rect: [350, 80, 560, 140] })
    const tampered = signed.slice()
    const at = Buffer.from(tampered).indexOf('Contract to sign')
    // pdf-lib writes the text as hex; flip a byte in the page content instead when it is not plain.
    const target = at >= 0 ? at : Buffer.from(tampered).indexOf('BT')
    tampered[target + 1] ^= 1
    const doc = engine.open(tampered)
    try {
      const [sig] = doc.signatures(tampered)
      expect(sig.status).toBe('invalid')
    } finally {
      doc.close()
    }
  })

  it('refuses a file with a password', async () => {
    // A minimal trailer with /Encrypt is enough for the check.
    const d = await PDFDocument.create()
    d.addPage()
    d.context.trailerInfo.Encrypt = d.context.obj({ Filter: 'Standard' })
    await expect(signPdf(await d.save({ useObjectStreams: false }), signer, { pageIndex: 0 })).rejects.toThrow(/password/)
  })
})

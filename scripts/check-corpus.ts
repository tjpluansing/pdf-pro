// Phase 1 gate: every file in ./corpus must open, render its first page and
// extract text without crashing. A file PDFium rejects with a typed error
// (broken or password-protected) counts as handled. A PDFium crash (a
// WebAssembly trap) fails the gate unless the file is listed in
// known-crashes.json with a reason; the engine is recreated after each crash.
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { PdfEngine, PdfError } from '../src/engine/pdfium'
import { dropUnreachable } from '../src/engine/sweep'
import { compareWords, wordsOf } from '../src/engine/compare'

const require = createRequire(import.meta.url)
const dir = join(process.cwd(), 'corpus')
const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort()
if (files.length === 0) {
  console.error('No PDFs in ./corpus. Run `npm run corpus:fetch` first.')
  process.exit(1)
}

const wasm = readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'))
const known: Record<string, string> = JSON.parse(readFileSync(new URL('./known-crashes.json', import.meta.url), 'utf8'))
let engine = await PdfEngine.create(wasm)
const counts = { opened: 0, rejected: 0, knownCrash: 0, crashed: 0 }
const redaction = { tried: 0, failed: [] as string[] }
const textEdits = { tried: 0, failed: [] as string[] }
const signatures: Record<string, number> = {}
const comparisons = { tried: 0, words: 0, ms: 0, failed: [] as string[] }
const crashes: string[] = []
const started = Date.now()

for (const name of files) {
  try {
    const doc = engine.open(readFileSync(join(dir, name)))
    try {
      if (doc.pageCount > 0) {
        const { width, height } = doc.pageSize(0)
        // Cap the render at ~1000 px on the long side so huge pages stay quick.
        doc.renderPage(0, Math.min(1, 1000 / Math.max(width, height, 1)))
        doc.pageText(0)
        doc.textLayout(0)
      }
      // Compare: a file against a second copy of itself must show no differences.
      if (doc.pageCount > 0) {
        comparisons.tried++
        const copy = engine.open(readFileSync(join(dir, name)))
        try {
          const t = Date.now()
          const words = (d: typeof doc) => wordsOf(Array.from({ length: d.pageCount }, (_, i) => d.textLayout(i)))
          const r = compareWords(words(doc), words(copy))
          comparisons.ms += Date.now() - t
          comparisons.words += r.words.after
          if (r.changes.length) comparisons.failed.push(`${name}: ${r.changes.length} differences against itself`)
        } finally {
          copy.close()
        }
      }
      // Signed files: every signature must be checked without crashing.
      if (doc.signatureCount) for (const c of doc.signatures(readFileSync(join(dir, name)))) signatures[c.status] = (signatures[c.status] ?? 0) + 1
      // Comment mode reads every annotation in the file, so real-world ones must not crash it.
      doc.allAnnotations()
      doc.allFormFields()
      doc.pageTextKinds()
      doc.compress({ maxDpi: 150, quality: 70 })
      doc.save()
      void doc.security
      // Edit text: read page 1's lines and retype the first one as itself.
      if (doc.pageCount > 0 && !doc.security.encrypted) {
        const lines = doc.textLines(0)
        const first = lines.find((l) => l.text.trim())
        if (first) {
          try {
            doc.replaceText(0, first.objects, first.text, first.text)
          } catch (err) {
            if (err instanceof PdfError && err.code === 'crash') throw err
            textEdits.failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
          }
          textEdits.tried++
        }
      }
      // Redact the middle of page 1, then sweep: the result must still open with every page.
      if (doc.pageCount > 0 && !doc.security.encrypted) {
        redaction.tried++
        const { width, height } = doc.pageSize(0)
        try {
          doc.redact([{ pageIndex: 0, rect: { x: width / 4, y: height / 3, width: width / 2, height: height / 6 } }])
          const swept = await dropUnreachable(doc.save())
          const back = engine.open(swept.bytes)
          try {
            if (back.pageCount !== doc.pageCount) throw new Error(`${back.pageCount} pages after the sweep, not ${doc.pageCount}`)
            back.renderPage(0, Math.min(1, 1000 / Math.max(width, height, 1)))
          } finally {
            back.close()
          }
        } catch (err) {
          if (err instanceof PdfError && err.code === 'crash') throw err
          redaction.failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      doc.outline()
      counts.opened++
    } finally {
      doc.close()
    }
  } catch (err) {
    if (err instanceof PdfError && err.code === 'crash') {
      engine = await PdfEngine.create(wasm)
      if (known[name]) {
        counts.knownCrash++
      } else {
        counts.crashed++
        crashes.push(`${name}: ${err.message}`)
      }
    } else if (err instanceof PdfError) {
      counts.rejected++
    } else {
      counts.crashed++
      crashes.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1)
console.log(`${files.length} files in ${secs}s: ${counts.opened} opened, ${counts.rejected} rejected cleanly, ${counts.knownCrash} known PDFium crashes, ${counts.crashed} new crashes`)
const missingKnown = Object.keys(known).filter((name) => !files.includes(name))
if (missingKnown.length) console.log(`  (not in corpus: ${missingKnown.join(', ')})`)
for (const line of crashes) console.log(`  crash: ${line}`)
console.log(`Redaction: ${redaction.tried - redaction.failed.length} of ${redaction.tried} files redacted, swept and reopened`)
for (const line of redaction.failed) console.log(`  redaction failed: ${line}`)
console.log(`Edit text: ${textEdits.tried - textEdits.failed.length} of ${textEdits.tried} files had a line retyped`)
for (const line of textEdits.failed) console.log(`  text edit failed: ${line}`)
console.log(`Compare: ${comparisons.tried - comparisons.failed.length} of ${comparisons.tried} files matched themselves (${comparisons.words.toLocaleString('en-US')} words in ${(comparisons.ms / 1000).toFixed(1)}s)`)
console.log(`Signatures checked: ${Object.entries(signatures).map(([k, v]) => `${v} ${k}`).join(', ') || 'none in the corpus'}`)
for (const line of comparisons.failed) console.log(`  compare failed: ${line}`)
process.exitCode = counts.crashed || redaction.failed.length || textEdits.failed.length || comparisons.failed.length ? 1 : 0

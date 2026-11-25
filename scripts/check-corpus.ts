// Phase 1 gate: every file in ./corpus must open, render its first page and
// extract text without crashing. A file PDFium rejects with a typed error
// (broken or password-protected) counts as handled. A PDFium crash (a
// WebAssembly trap) fails the gate unless the file is listed in
// known-crashes.json with a reason; the engine is recreated after each crash.
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { PdfEngine, PdfError } from '../src/engine/pdfium'

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
      // Comment mode reads every annotation in the file, so real-world ones must not crash it.
      doc.allAnnotations()
      doc.allFormFields()
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
process.exitCode = counts.crashed ? 1 : 0

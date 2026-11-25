// Downloads the sample PDF set listed in corpus-manifest.json into ./corpus.
// Files already present are skipped, so re-running only fetches what is missing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const manifest = JSON.parse(readFileSync(new URL('./corpus-manifest.json', import.meta.url), 'utf8'))
const dir = join(process.cwd(), 'corpus')
mkdirSync(dir, { recursive: true })

const CONCURRENCY = 8
const queue = manifest.files.filter((name) => !existsSync(join(dir, name)))
let failed = 0

async function worker() {
  for (let name = queue.shift(); name; name = queue.shift()) {
    try {
      const res = await fetch(manifest.rawBase + encodeURIComponent(name))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      writeFileSync(join(dir, name), new Uint8Array(await res.arrayBuffer()))
    } catch (err) {
      failed++
      console.error(`failed: ${name}: ${err.message}`)
    }
  }
}

const todo = queue.length
await Promise.all(Array.from({ length: CONCURRENCY }, worker))
console.log(`corpus: ${manifest.files.length} listed, ${todo - failed} downloaded, ${failed} failed, in ${dir}`)
process.exitCode = failed ? 1 : 0

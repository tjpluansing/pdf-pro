import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const require = createRequire(import.meta.url)

/**
 * Ships Tesseract's English model with the app at tessdata/eng.traineddata.gz,
 * so OCR works offline and scans are never sent anywhere.
 */
function tessdata(): Plugin {
  const file = join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int', 'eng.traineddata.gz')
  const name = 'tessdata/eng.traineddata.gz'
  return {
    name: 'tessdata',
    configureServer(server) {
      server.middlewares.use(`/${name}`, (_req, res) => {
        res.setHeader('Content-Type', 'application/octet-stream')
        res.end(readFileSync(file))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: name, source: readFileSync(file) })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tessdata()],
})

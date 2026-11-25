# PDF Pro

A fast, private PDF editor for desktop and web, built on [PDFium](https://pdfium.googlesource.com/pdfium/) (the engine inside Chrome) and qpdf.

**Status: phase 1, the viewer.** Open a PDF (including password-protected ones), scroll, zoom, jump with page thumbnails or bookmarks, search the text, print, and save a copy. It runs in the browser and as a desktop app for Windows and macOS. Files are never uploaded.

## Run it

```bash
npm install
npm run dev            # web app at http://localhost:5173
npm run desktop        # desktop app (needs Rust and the Tauri prerequisites for your OS)
npm run desktop:build  # installers in src-tauri/target/release/bundle
```

Every PR also builds unsigned Windows (`.msi`, `.exe`) and macOS (`.dmg`, universal) installers in the **Desktop app** workflow; download them from the run's Artifacts. Unsigned builds show a security warning on first launch (on macOS: right-click the app, then Open).

## Checks

```bash
npm test               # engine unit tests (Vitest)
npm run lint
npm run typecheck
npm run corpus:fetch   # download 200 sample PDFs into ./corpus (not committed)
npm run corpus:check   # phase 1 gate: every sample opens without crashing
```

The sample set is a fixed selection from [pdf.js's test files](https://github.com/mozilla/pdf.js/tree/master/test/pdfs), many of them deliberately broken. The list is in `scripts/corpus-manifest.json`. Known engine crashes are listed with a reason in `scripts/known-crashes.json`; any new crash fails CI.

## Layout

| Path | What it is |
| --- | --- |
| `src/engine/pdfium.ts` | Typed wrapper over PDFium WebAssembly: open, page sizes, render, text, search, outline. Runs in the browser and in Node. |
| `src/viewer/engine.worker.ts`, `client.ts` | PDFium runs in a Web Worker; the UI talks to it through a small message protocol, and off-screen page renders are cancelled |
| `src/viewer/` (other) | Page canvas, printing, and the desktop/browser differences (`platform.ts`) |
| `src-tauri/` | Desktop shell (Tauri 2): window, native Save dialog |
| `src/App.tsx` | The viewer UI |
| `scripts/` | Sample PDF download and the crash check |
| `test/` | Engine tests, using PDFs built with pdf-lib and an AES-256 fixture (password `secret`) |

## Roadmap

1. **Viewer** (now): render, zoom, search, thumbnails, bookmarks, desktop and web shell
2. **Annotate and organize**: comments, form fill, merge, split, reorder, watermarks, passwords
3. **Convert and OCR**: Office, images and web pages to PDF, compression, OCR
4. **Pro tier**: true redaction, text editing, compare, AI summary and Q&A

Licensing rule: only Apache, BSD, MIT and MPL code ships in the app. No AGPL (MuPDF, Ghostscript).

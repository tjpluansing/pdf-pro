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
| `src/engine/pdfium.ts` | Typed wrapper over PDFium WebAssembly: open, page sizes, render, text, search, outline, page edits (rotate, delete, move, insert, extract) and save. Runs in the browser and in Node. |
| `src/viewer/engine.worker.ts`, `client.ts` | PDFium runs in a Web Worker; the UI talks to it through a small message protocol, and off-screen page renders are cancelled. The worker keeps up to 20 undo steps per file as saved snapshots. |
| `src/engine/annotations.ts` | Comments and markup: read, add, change and delete highlights, notes, text boxes, drawings and shapes; per-character text boxes for selecting text |
| `src/engine/forms.ts` | Forms: read and fill text fields, checkboxes, radio buttons and dropdowns; place signature images as stamps |
| `src/engine/stamp.ts` | Watermarks, headers, footers and page numbers (tagged as PDF artifacts so they can be removed); AES-256 passwords and permissions |
| `src/engine/compress.ts` | Reduce file size: downsample and re-encode large photos as JPEG; scans, line art and transparent images are left alone |
| `src/engine/ocr.ts`, `src/viewer/recognize.ts` | Recognise text on scans with Tesseract (runs on the device, model bundled) and add it as an invisible, searchable text layer |
| `src/engine/redact.ts`, `src/engine/sweep.ts` | Redaction: deletes the text, image pixels, enclosed drawings, comments and form fields under marked areas, blacks them out, then rewrites the file without the unused objects PDFium would otherwise keep |
| `src-tauri/src/convert.rs` | Desktop only: open Word, Excel and PowerPoint files as PDF, and export a PDF to Word, by running the bundled LibreOffice (MPL-2.0) as a separate program. CI downloads LibreOffice and packs it into each installer |
| `src/viewer/AnnotLayer.tsx`, `CommentsPanel.tsx`, `selection.ts` | Comment mode: the drawing and text-selection layer over each page, and the comments list |
| `src/viewer/Organize.tsx` | Organize pages: select, rotate, delete, drag to reorder, insert or merge other PDFs, extract and split |
| `src/viewer/` (other) | Page canvas, printing, and the desktop/browser differences (`platform.ts`) |
| `src-tauri/` | Desktop shell (Tauri 2): window, native Save dialog |
| `src/App.tsx` | The viewer UI |
| `scripts/` | Sample PDF download and the crash check |
| `test/` | Engine, page-organizing, annotation and text-selection tests, using PDFs built with pdf-lib and an AES-256 fixture (password `secret`) |

## Roadmap

1. **Viewer** (done): render, zoom, search, thumbnails, bookmarks, desktop and web shell
2. **Annotate and organize** (done: organize pages, comments, fill & sign, stamp & protect): comments, form fill, merge, split, reorder, watermarks, passwords
3. **Convert and OCR**: Office, images and web pages to PDF, compression, OCR
4. **Pro tier**: true redaction, text editing, compare, AI summary and Q&A

Licensing rule: only Apache, BSD, MIT and MPL code ships in the app. No AGPL (MuPDF, Ghostscript).

# PDF Pro

A fast, private PDF editor for desktop and web, built on [PDFium](https://pdfium.googlesource.com/pdfium/) (the engine inside Chrome) and qpdf.

**Status: phase 1, the viewer.** Open a PDF, scroll, zoom, jump with page thumbnails or bookmarks, and search the text. Files are opened in the browser and are never uploaded.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

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
| `src/viewer/` | Browser glue: engine loading and the lazily rendered page canvas |
| `src/App.tsx` | The viewer UI |
| `scripts/` | Sample PDF download and the crash check |
| `test/` | Engine tests, using PDFs built with pdf-lib |

## Roadmap

1. **Viewer** (now): render, zoom, search, thumbnails, bookmarks, desktop and web shell
2. **Annotate and organize**: comments, form fill, merge, split, reorder, watermarks, passwords
3. **Convert and OCR**: Office, images and web pages to PDF, compression, OCR
4. **Pro tier**: true redaction, text editing, compare, AI summary and Q&A

Licensing rule: only Apache, BSD, MIT and MPL code ships in the app. No AGPL (MuPDF, Ghostscript).

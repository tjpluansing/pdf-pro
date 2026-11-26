# Changelog

What changed in each PDF Pro release. The release workflow copies a version's
section into the GitHub release and into the in-app "What's new" note, so write
for the people using the app. Add changes under **Unreleased** as they merge;
`node scripts/release.mjs bump <version>` turns that into the new version's
section (see [docs/RELEASING.md](docs/RELEASING.md)).

## Unreleased

## 0.1.0 - 2026-11-26

The first public release of PDF Pro for Windows and macOS (Apple silicon and Intel).

- **View:** open any PDF, including password-protected files; zoom, page thumbnails, bookmarks, text search and printing.
- **Organize pages:** rotate, delete, reorder, insert and merge other PDFs, extract and split, with undo.
- **Comment and mark up:** highlights, notes, text boxes, drawings and shapes, listed in a comments panel.
- **Fill and sign forms:** fill text fields, checkboxes, radio buttons and dropdowns, and place a drawn or typed signature.
- **Stamp and protect:** watermarks, headers, footers and page numbers; AES-256 passwords and permissions.
- **Convert:** open Word, Excel and PowerPoint files as PDF and export a PDF to Word, using the LibreOffice bundled with the app.
- **Reduce file size:** shrink large photos without touching text or line art.
- **Recognize text (OCR):** make scans searchable and selectable, on your device.
- **Redact:** remove text, images and drawings for good, not just cover them.
- **Edit text:** change a line of text in place, keeping its font, size and colour.
- **Compare:** see what changed between two versions of a document, side by side.
- **AI assistant:** summaries and answers about the open file from Claude, using your own Anthropic API key.
- **Certificate signatures:** sign with a .p12 or .pfx digital ID and check the signatures in a file.
- **Automatic updates:** PDF Pro tells you when a new version is out and installs it for you.

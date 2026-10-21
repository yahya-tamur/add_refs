# Add Refs

A static web app for marking definitions in a PDF and linking later uses of each term back to them.
Everything runs in the browser; nothing is uploaded.

## Hosting on GitHub Pages

Push to GitHub, then under **Settings → Pages** set **Source** to **GitHub Actions**. The workflow in
`.github/workflows/pages.yml` builds the site and deploys it on every push to `master`/`main`.

To build locally: `npm install && npm run build` writes the site to `dist/`;
`npm run serve` builds and serves it at http://127.0.0.1:8612.

## Opening papers

- **Open…** (Ctrl+O) or drop a PDF on the window. Opening a PDF exported by Add Refs restores its
  annotations for editing.
- `index.html?pdf=<url>` opens a hosted paper (same site, or a server that allows CORS). If this
  browser already has annotations for that PDF, they take precedence over ones embedded in it.
- The last PDF reopens automatically.
- Scanned PDFs without a text layer are read with OCR ([tesseract.js](https://github.com/naptha/tesseract.js),
  English, in the browser) the first time they are opened: pages are read in the background, about
  2–3 s each, the one you work on first, and the result is kept in this browser so reopening is instant.
  The OCR files (~14 MB) are only downloaded for such PDFs. Symbols are read by the image recognition
  below rather than by the OCR.

## Annotating

| Action | Result |
| --- | --- |
| **Shift+drag** over text | Highlights the definition passage in the colour it will get (repeat to add lines, even on other pages). A new highlight replaces any older highlight it covers |
| then **drag a box** | Outlines the defined symbol/phrase and asks for its term: `simple equivalence`, `\Sigma_{ij}`, `the $T$ group` |
| **Drag** over a later use | Underlines it and asks which term it refers to (an English phrase is pre-filled). A match becomes a link, underlined in the definition's colour; no match is kept as a grey dashed "unlinked" mark that links once the definition exists |
| Click an underline | Jumps to the definition; **← Back** / Alt+← returns |
| **Ctrl+F** | Searches the PDF's text (Enter / Shift+Enter step through matches, Esc closes). A symbol (`\Lambda`, `Λ`, `\Sigma_{\Lambda}`) finds the definitions and references whose term contains it, plus any occurrence in the text layer |
| Right-click a mark | Edit term / delete |
| Esc · Ctrl+Z · Ctrl+wheel | Cancel · undo · zoom |

English phrases match case-insensitively and tolerate plurals (`complexes` → `complex`); symbols match
exactly (`T` is not `t`), ignoring LaTeX spacing and braces (`\Sigma_{\Lambda}` = `\Sigma_\Lambda`,
`A^*` = `A*`). A reference links to the nearest *preceding* definition of its term. Each definition
gets the least-used colour, never that of another definition of the same term.

## Pre-filled terms

Boxes and underlines over an English phrase fill it in from the PDF's text. Over a symbol, the app
reads it from the page image: it splits the region into glyphs, places sub- and superscripts by their
baselines, and matches each glyph against Greek, Latin, fraktur, calligraphic, blackboard and common
operator glyphs drawn from KaTeX's fonts. Readings appear as suggestions, the best one filled in;
one that names an existing definition is preferred.

When a reading is wrong and you type the right LaTeX, the app learns the glyph's shape (if the number
of glyphs matches the symbols typed) and prefers it from then on, in this browser. Old typefaces
differ a lot from KaTeX's: on Whitehead's *Simple Homotopy Types* about 38% of symbols read correctly
out of the box and about 60% once corrections are learned along the way.

Search and English pre-fill rely on the PDF's text layer, which on some scans (e.g. JSTOR's) is
slightly offset from the image.

## Saving and exporting

- Annotations autosave in this browser (IndexedDB), keyed by the PDF's fingerprint, so renaming the
  file doesn't lose them. Clearing site data does.
- **Export PDF** (Ctrl+S / Ctrl+E) asks where to save `paper (refs).pdf` (Chrome/Edge; Firefox and
  Safari put it in the downloads folder unless set to ask): highlights, boxes and underlines
  painted into the pages, real link annotations, and the annotation data as an attached
  `add-refs.json`. It reads in any PDF viewer, and opening it here again strips the painted marks and
  links and continues editing. Unlinked references are kept in the data but not drawn.

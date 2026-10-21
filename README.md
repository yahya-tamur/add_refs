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

## Annotating

| Action | Result |
| --- | --- |
| **Shift+drag** over text | Highlights the definition passage (repeat to add lines, even on other pages) |
| then **drag a box** | Outlines the defined symbol/phrase and asks for its term: `simple equivalence`, `\Sigma_{ij}`, `the $T$ group` |
| **Drag** over a later use | Underlines it and asks which term it refers to (an English phrase is pre-filled). A match becomes a link, underlined in the definition's colour; no match is kept as a grey dashed "unlinked" mark that links once the definition exists |
| Click an underline | Jumps to the definition; **← Back** / Alt+← returns |
| Right-click a mark | Edit term / delete |
| Esc · Ctrl+Z · Ctrl+wheel | Cancel · undo · zoom |

Terms match case-insensitively and tolerate plurals (`complexes` → `complex`). A reference links to the
nearest *preceding* definition of its term; the same term always keeps the same colour.

## Saving and exporting

- Annotations autosave in this browser (IndexedDB), keyed by the PDF's fingerprint, so renaming the
  file doesn't lose them. Clearing site data does.
- **Export PDF** (Ctrl+S / Ctrl+E) downloads `paper (refs).pdf`: highlights, boxes and underlines
  painted into the pages, real link annotations, and the annotation data as an attached
  `add-refs.json`. It reads in any PDF viewer, and opening it here again strips the painted marks and
  links and continues editing. Unlinked references are kept in the data but not drawn.

# Add Refs

Electron app for marking definitions in a PDF and linking later uses of each term back to them.

```
npm install
npm start -- "path/to/paper.pdf"     # or use Open… (Ctrl+O); the last file reopens automatically
```

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

## Files

- `paper.refs.json` next to the PDF: the annotations, saved automatically. Coordinates are PDF points
  at scale 1, origin top left.
- **Export PDF…** (Ctrl+E) writes `paper (refs).pdf` with highlights, boxes and underlines painted in and
  real PDF link annotations, plus `paper (refs).json`, the sidecar format `math 610 papers/highlighted/viewer.html` reads.
  The original PDF is never modified.

// OCR for scanned pages without a text layer, with tesseract.js (loaded from vendor/ on first use).
// Each recognized letter becomes a PageText character, so selection, search and pre-fill work as
// on a PDF with text.

/* global Tesseract */
/* exported Ocr */
const Ocr = (() => {
  const SCALE = 300 / 72;  // pages are read at 300 dpi
  let worker = null;

  const loadScript = src => new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement("script"), { src, onload: resolve, onerror: () => reject(new Error("Could not load " + src)) });
    document.head.append(s);
  });

  function getWorker() {
    worker ||= (async () => {
      if (!window.Tesseract) await loadScript("vendor/tesseract/tesseract.min.js");
      const base = new URL("vendor/tesseract/", location.href).href;
      return Tesseract.createWorker("eng", 1 /* LSTM engine */, {
        workerPath: base + "worker.min.js", corePath: base + "core", langPath: base + "lang", gzip: true, workerBlobURL: false,
      });
    })();
    worker.catch(() => { worker = null; });
    return worker;
  }

  // Characters of one page in PageText's shape: page points at scale 1, origin top left, one text
  // item per word (so words get spaces between them) and eol on each line's last letter.
  async function readPage(page) {
    const vp = page.getViewport({ scale: SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const { data } = await (await getWorker()).recognize(canvas, {}, { blocks: true, text: false });
    const chars = [];
    let item = 0;
    for (const block of data.blocks || []) for (const para of block.paragraphs) for (const line of para.lines) {
      const top = line.bbox.y0 / SCALE, bottom = line.bbox.y1 / SCALE;
      const base = bottom - (line.rowAttributes?.descenders || 0) / SCALE, size = Math.max(1, (base - top) / 0.85);
      for (const word of line.words) {
        item++;
        for (const sym of word.symbols) {
          const text = sym.text || "", w = (sym.bbox.x1 - sym.bbox.x0) / SCALE / Math.max(1, text.length);
          [...text].forEach((c, k) => chars.push({ c, item, x0: sym.bbox.x0 / SCALE + k * w, x1: sym.bbox.x0 / SCALE + (k + 1) * w, top, bottom, base, size, eol: false }));
        }
      }
      if (chars.length) chars.at(-1).eol = true;
    }
    return chars;
  }

  // Compact form for caching: [c, item, x0, x1, top, bottom, base, size, eol].
  const r = v => Math.round(v * 10) / 10;
  const pack = chars => chars.map(c => [c.c, c.item, r(c.x0), r(c.x1), r(c.top), r(c.bottom), r(c.base), r(c.size), c.eol ? 1 : 0]);
  const unpack = rows => rows.map(([c, item, x0, x1, top, bottom, base, size, eol]) => ({ c, item, x0, x1, top, bottom, base, size, eol: !!eol }));

  return { readPage, pack, unpack };
})();

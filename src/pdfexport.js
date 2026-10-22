// Exported PDFs get the marks painted into the page content, real link annotations, invisible OCR
// text for scanned pages, and the annotation data as an attached file. Everything added carries
// /AddRefs so a later open can remove it (stripExport).

/* global PDFLib, underlineY, mergeRects */
/* exported ATTACHMENT, isRefs, buildExport, embeddedRefs, stripExport */

const ATTACHMENT = "add-refs.json";
const isRefs = r => Array.isArray(r?.definitions) && Array.isArray(r?.references);

// `bytes`: the clean PDF; `data`: the annotations; `docId`: the PDF's original fingerprint; `pages`:
// 1-based { vp1 (pdf.js viewport at scale 1), textData } per page; `resolve`: reference -> definition.
async function buildExport({ bytes, data, docId, pages, resolve }) {
  const { PDFDocument, PDFName, PDFNull, PDFBool, rgb, BlendMode } = PDFLib;
  const MARK = PDFName.of("AddRefs");
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const docPages = doc.getPages();
  // Read before any drawing: pdf-lib's first draw on a page also wraps its content in q/Q streams.
  const before = docPages.map(page => new Set(rawContents(doc, page).map(String)));
  const toPdf = (n, [x0, y0, x1, y1]) => {
    const [a, b] = pages[n].vp1.convertToPdfPoint(x0, y0), [c, d] = pages[n].vp1.convertToPdfPoint(x1, y1);
    return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  };
  const color = hex => rgb(...[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255));
  for (const d of data.definitions) {
    for (const part of d.highlight) {
      for (const r of mergeRects(part.rects)) {
        const [x0, y0, x1, y1] = toPdf(part.page, r);
        docPages[part.page - 1].drawRectangle({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, color: color(d.color), opacity: 0.32, blendMode: BlendMode.Multiply });
      }
    }
    const [x0, y0, x1, y1] = toPdf(d.box.page, d.box.rect);
    docPages[d.box.page - 1].drawRectangle({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, borderColor: color(d.color), borderWidth: 0.6 });
  }
  for (const ref of data.references) {
    const d = resolve(ref);
    if (!d) continue;
    const page = docPages[ref.page - 1];
    for (const r of ref.rects) {
      const [x0, , x1] = toPdf(ref.page, r), [, uy] = pages[ref.page].vp1.convertToPdfPoint(0, underlineY(r));
      page.drawLine({ start: { x: x0, y: uy }, end: { x: x1, y: uy }, thickness: 1.2, color: color(d.color) });
      const [, top] = pages[d.box.page].vp1.convertToPdfPoint(0, Math.max(d.box.rect[1] - 40, 0));
      const annot = doc.context.obj({
        Type: "Annot", Subtype: "Link", Rect: toPdf(ref.page, r), Border: [0, 0, 0],
        Dest: [docPages[d.box.page - 1].ref, PDFName.of("XYZ"), PDFNull, top, PDFNull], AddRefs: true,
      });
      page.node.addAnnot(doc.context.register(annot));
    }
  }
  await addOcrText(doc, docPages, MARK, pages);
  // Tag the content streams drawing added (the marks, OCR text and pdf-lib's q/Q wrappers).
  docPages.forEach((page, i) => {
    for (const ref of rawContents(doc, page)) {
      if (!before[i].has(String(ref))) doc.context.lookup(ref).dict.set(MARK, PDFBool.True);
    }
  });
  await doc.attach(new TextEncoder().encode(JSON.stringify({ ...data, source: docId })), ATTACHMENT, {
    mimeType: "application/json", description: "Add Refs annotations (open this PDF in Add Refs to edit them)",
  });
  return doc.save();
}

function rawContents(doc, page) {
  const ref = page.node.get(PDFLib.PDFName.of("Contents"));
  const obj = doc.context.lookup(ref);
  return obj instanceof PDFLib.PDFArray ? obj.asArray() : ref ? [ref] : [];
}

// Invisible text over OCR'd pages (render mode 3, each word stretched over its printed image), so
// other viewers can search and copy the scanned text. Helvetica's encoding covers Latin text; other
// characters (OCR's guesses at symbols, mostly) are left out.
async function addOcrText(doc, docPages, MARK, pages) {
  const ocrPages = pages.slice(1).filter(p => p.textData?.ocr && p.textData.chars.length);
  if (!ocrPages.length) return;
  const { StandardFonts, PDFBool, PDFDict, TextRenderingMode, beginText, endText, setFontAndSize, setTextRenderingMode,
    setCharacterSqueeze, setTextMatrix, showText } = PDFLib;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const encodable = new Map();
  const ok = ch => {
    if (!encodable.has(ch)) { try { font.encodeText(ch); encodable.set(ch, true); } catch { encodable.set(ch, false); } }
    return encodable.get(ch);
  };
  for (const p of ocrPages) {
    const page = docPages[p.n - 1], words = [];
    for (const ch of p.textData.chars) {
      const w = words.at(-1);
      if (w && w.item === ch.item) { w.text += ch.c; w.x1 = Math.max(w.x1, ch.x1); }
      else words.push({ item: ch.item, text: ch.c, x0: ch.x0, x1: ch.x1, base: ch.base, size: ch.size });
    }
    page.setFont(font);
    const ops = [beginText(), setFontAndSize(page.fontKey, 10), setTextRenderingMode(TextRenderingMode.Invisible)];
    for (const w of words) {
      const text = [...w.text].filter(ok).join("");
      if (!text.trim()) continue;
      const [x, y] = p.vp1.convertToPdfPoint(w.x0, w.base), [x2] = p.vp1.convertToPdfPoint(w.x1, w.base);
      const natural = font.widthOfTextAtSize(text, w.size);
      if (natural <= 0 || x2 <= x) continue;
      ops.push(setFontAndSize(page.fontKey, w.size), setCharacterSqueeze(100 * (x2 - x) / natural), setTextMatrix(1, 0, 0, 1, x, y), showText(font.encodeText(text)));
    }
    ops.push(endText());
    page.pushOperators(...ops);
  }
  // Embed the font now and tag it; encoding text marks it for re-embedding, so this comes last.
  await font.embed();
  doc.context.lookup(font.ref, PDFDict).set(MARK, PDFBool.True);
}

async function embeddedRefs(doc) {
  const att = Object.values(await doc.getAttachments() || {}).find(a => a.filename === ATTACHMENT);
  if (!att) return null;
  try {
    const refs = JSON.parse(new TextDecoder().decode(att.content));
    return isRefs(refs) ? refs : null;
  } catch { return null; }
}

// Undo an export: delete tagged content streams (marks, OCR text) and links, pdf-lib's opacity states,
// the OCR text's font, and the attachment.
// Pages are edited through their raw entries; pdf-lib's normalizing accessors would add new q/Q streams.
async function stripExport(bytes) {
  const { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef } = PDFLib;
  const MARK = PDFName.of("AddRefs");
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  // pdf-lib writes every object it holds, so unlinked objects are deleted at the end (the q/Q
  // streams are shared between pages).
  const dead = new Set();
  const del = ref => { if (ref instanceof PDFRef) dead.add(ref); };
  const tagged = ref => {
    const obj = doc.context.lookup(ref);
    return !!(obj?.dict ?? obj)?.get?.(MARK);
  };
  const prune = (arr, drop) => {
    for (let i = arr.size() - 1; i >= 0; i--) if (drop(arr.get(i))) { del(arr.get(i)); arr.remove(i); }
  };
  for (const page of doc.getPages()) {
    const contents = doc.context.lookup(page.node.get(PDFName.of("Contents")));
    if (contents instanceof PDFArray) prune(contents, tagged);
    const annots = page.node.Annots();
    if (annots) prune(annots, tagged);
    const gs = page.node.Resources()?.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
    for (const [key, val] of gs?.entries() || []) {
      const d = doc.context.lookup(val);
      if (/^GS-\d+$/.test(key.decodeText()) && d?.has?.(PDFName.of("BM"))) { del(val); gs.delete(key); }
    }
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);  // the OCR text's font
    for (const [key, val] of fonts?.entries() || []) if (tagged(val)) { del(val); fonts.delete(key); }
  }
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict)
    ?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict)?.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (names) {
    for (let i = names.size() - 2; i >= 0; i -= 2) {
      if (names.lookup(i).decodeText?.() !== ATTACHMENT) continue;
      const spec = names.get(i + 1);
      const af = doc.catalog.lookupMaybe(PDFName.of("AF"), PDFArray);
      const at = af ? af.asArray().indexOf(spec) : -1;
      if (at >= 0) af.remove(at);
      del(doc.context.lookup(spec, PDFDict).lookup(PDFName.of("EF"), PDFDict).get(PDFName.of("F")));
      del(spec);
      names.remove(i + 1); names.remove(i);
    }
  }
  for (const ref of dead) doc.context.delete(ref);
  return doc.save();
}

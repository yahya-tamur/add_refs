// Export and reopen, with the real pdf-lib (writing) and pdf.js (reading, as another viewer would).
const test = require("node:test");
const assert = require("node:assert/strict");
const PDFLib = require("pdf-lib");
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
const { loadHere, plain } = require("./load");

const m = loadHere(["terms.js", "pdfexport.js"], { PDFLib });
const H = 600;  // page height; page coordinates have their origin top left, PDF's bottom left

// A two-page source PDF with real text on page 1; page 2 stands in for a scan (no text).
async function sourcePdf() {
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.TimesRoman);
  doc.addPage([400, H]).drawText("A basic module is free.", { x: 50, y: H - 110, size: 12, font });
  doc.addPage([400, H]);
  return doc.save();
}

// OCR characters for page 2: two words, one item each.
function ocrChars() {
  const chars = [];
  let x = 60;
  ["basic", "modules"].forEach((word, w) => {
    for (const c of word) { chars.push({ c, item: w + 1, x0: x, x1: x + 6, top: 190, bottom: 203, base: 200, size: 12, eol: false }); x += 6; }
    x += 5;
  });
  chars.at(-1).eol = true;
  return chars;
}

const vp1 = { convertToPdfPoint: (x, y) => [x, H - y] };
const pages = [null, { n: 1, vp1, textData: { chars: [] } }, { n: 2, vp1, textData: { ocr: true, chars: ocrChars() } }];
const data = {
  version: 1,
  definitions: [{ id: "d1", term: "basic module", color: "#2a9df4", text: "A basic module is free.",
    highlight: [{ page: 1, rects: [[50, 98, 180, 112]] }], box: { page: 1, rect: [58, 98, 120, 112] } }],
  references: [{ id: "r1", page: 2, rects: [[60, 190, 130, 203]], text: "basic modules", term: "basic modules" }],
};
const exportOf = bytes => m.buildExport({ bytes, data, docId: "source-id", pages, resolve: r => m.resolveIn(data.definitions, r) });

async function read(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
  const pageInfo = async n => {
    const page = await doc.getPage(n);
    return { text: (await page.getTextContent()).items.map(i => i.str).join(" "), annots: await page.getAnnotations() };
  };
  return { doc, p1: await pageInfo(1), p2: await pageInfo(2), attachments: await doc.getAttachments() };
}

test("an export has links, the annotations as an attachment, and the OCR text", async () => {
  const exported = await exportOf(await sourcePdf());
  const { doc, p1, p2 } = await read(exported);

  const links = p2.annots.filter(a => a.subtype === "Link");
  assert.equal(links.length, 1);
  assert.equal(await doc.getPageIndex(links[0].dest[0]), 0);  // the reference links to the definition on page 1

  const embedded = plain(await m.embeddedRefs(doc));
  assert.equal(embedded.source, "source-id");
  assert.deepEqual(embedded.definitions, data.definitions);
  assert.deepEqual(embedded.references, data.references);

  assert.match(p1.text, /A basic module is free\./);
  assert.match(p2.text, /basic\s*modules/);  // invisible OCR text, readable by other viewers
  await doc.destroy();
});

test("reopening strips everything the export added", async () => {
  const source = await sourcePdf();
  const stripped = await m.stripExport(await exportOf(source));
  const { doc, p1, p2, attachments } = await read(stripped);
  assert.equal(p2.annots.length, 0);
  assert.equal(attachments, null);
  assert.equal(await m.embeddedRefs(doc), null);
  assert.equal(p2.text.trim(), "");                    // OCR text gone
  assert.match(p1.text, /A basic module is free\./);   // the PDF's own text stays
  await doc.destroy();

  // nothing of the attachment is left in the catalog (/AF and the embedded-files name tree)
  const catalog = (await PDFLib.PDFDocument.load(stripped)).catalog;
  assert.equal(catalog.lookupMaybe(PDFLib.PDFName.of("AF"), PDFLib.PDFArray)?.size() ?? 0, 0);
  const names = catalog.lookupMaybe(PDFLib.PDFName.of("Names"), PDFLib.PDFDict)
    ?.lookupMaybe(PDFLib.PDFName.of("EmbeddedFiles"), PDFLib.PDFDict)?.lookupMaybe(PDFLib.PDFName.of("Names"), PDFLib.PDFArray);
  assert.equal(names?.size() ?? 0, 0);

  const fonts = async bytes => (await PDFLib.PDFDocument.load(bytes)).getPages()
    .map(p => p.node.Resources()?.lookupMaybe(PDFLib.PDFName.of("Font"), PDFLib.PDFDict)?.keys().length || 0);
  assert.deepEqual(await fonts(stripped), await fonts(source));
});

test("repeated export and reopen doesn't grow the file", async () => {
  let clean = await m.stripExport(await exportOf(await sourcePdf()));
  const sizes = [];
  for (let i = 0; i < 3; i++) {
    const exported = await exportOf(clean);
    clean = await m.stripExport(exported);
    sizes.push([exported.length, clean.length]);
  }
  // only the modification date may change length by a byte or two
  for (const [e, c] of sizes.slice(1)) {
    assert.ok(Math.abs(e - sizes[0][0]) < 8, `export sizes ${sizes.map(s => s[0])}`);
    assert.ok(Math.abs(c - sizes[0][1]) < 8, `clean sizes ${sizes.map(s => s[1])}`);
  }
});

test("a PDF that wasn't exported by the app strips to itself and has no annotations", async () => {
  const source = await sourcePdf();
  const { doc } = await read(source);
  assert.equal(await m.embeddedRefs(doc), null);
  await doc.destroy();
  const { p1 } = await read(await m.stripExport(source));
  assert.match(p1.text, /A basic module is free\./);
});

test("isRefs", () => {
  assert.ok(m.isRefs({ definitions: [], references: [] }));
  assert.ok(!m.isRefs({ definitions: [] }));
  assert.ok(!m.isRefs(null));
});

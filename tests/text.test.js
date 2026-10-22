const test = require("node:test");
const assert = require("node:assert/strict");
const { load, plain, documentStub } = require("./load");

const { PageText, PageInk } = (() => { const m = load(["text.js"], { document: documentStub }); return { PageText: m.PageText, PageInk: m.PageInk }; })();

const CW = 5, SIZE = 10;  // character width and font size of the synthetic pages
const char = (c, x, base, item, eol = false) => ({ c, item, x0: x, x1: x + CW, top: base - SIZE * 0.85, bottom: base + SIZE * 0.22, base, size: SIZE, eol });

// A text-layer line: one item, space characters included.
function textLine(text, base, item, x = 50) {
  return [...text].map((c, i) => char(c, x + i * CW, base, item, i === text.length - 1));
}
// An OCR line: one item per word, no space characters, a 4pt gap between words.
function ocrLine(text, base, firstItem, x = 50) {
  const out = [];
  text.split(" ").forEach((word, w) => {
    [...word].forEach(c => { out.push(char(c, x, base, firstItem + w)); x += CW; });
    x += 4;
  });
  out.at(-1).eol = true;
  return out;
}
// Point in the middle of the character at `index` of a line's string.
const at = (line, index) => ({ x: (line[index].x0 + line[index].x1) / 2, y: line[index].base - 3 });

test("select returns whole words between the drag points, in reading order", () => {
  const l = textLine("alpha beta gamma delta", 100, 0);
  const page = new PageText(l);
  const s = page.select(at(l, 8), at(l, 13));  // inside "beta" to inside "gamma"
  assert.equal(s.text, "beta gamma");
  assert.deepEqual(plain(s.rects), [[l[6].x0, l[6].top, l[15].x1, l[6].bottom]]);
  const back = page.select(at(l, 13), at(l, 8));
  assert.equal(back.text, "beta gamma");
  assert.deepEqual(plain(back.from), plain(at(l, 8)));
});

test("select spans lines and joins words hyphenated at a line end", () => {
  const l1 = textLine("the homo-", 100, 0), l2 = textLine("topy type", 114, 1);
  const page = new PageText([...l1, ...l2]);
  const s = page.select(at(l1, 5), at(l2, 2));
  assert.equal(s.text, "homotopy");
  assert.equal(s.rects.length, 2);
});

test("a drag ending far past a short line's end stays on that line", () => {
  // the next line reaches far closer to the end point than the short line does
  const l1 = textLine("short end.", 100, 0), l2 = textLine("the next line is much, much longer than the first", 114, 1);
  const page = new PageText([...l1, ...l2]);
  const s = page.select(at(l1, 0), { x: 400, y: 98 });
  assert.equal(s.text, "short end.");
  assert.equal(s.rects.length, 1);
});

test("select returns null when both points are far from any text", () => {
  const page = new PageText(textLine("alpha", 100, 0));
  assert.equal(page.select({ x: 50, y: 400 }, { x: 60, y: 420 }), null);
});

test("on OCR text (no space characters) words still end at their gaps", () => {
  const l = ocrLine("group multiplicative group", 100, 0);
  const page = new PageText(l);
  const i = l.findIndex(c => c.item === 1);
  const s = page.select(at(l, i + 3), at(l, i + 9));
  assert.equal(s.text, "multiplicative");
  assert.equal(page.find("group multiplicative").length, 1);
});

test("find is case-insensitive, ignores hyphens and finds words broken across lines", () => {
  const l1 = textLine("a Simple homo-", 100, 0), l2 = textLine("topy type, simple", 114, 1);
  const page = new PageText([...l1, ...l2]);
  assert.equal(page.find("simple").length, 2);
  const hits = page.find("homotopy");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].length, 2);  // one rect per line
  assert.equal(page.find("homo-topy").length, 1);
  assert.equal(page.find("nothing").length, 0);
  assert.equal(page.find("  ").length, 0);
});

test("find with exact matching keeps case (symbols: Λ is not λ)", () => {
  const page = new PageText(textLine("Λ and λ", 100, 0));
  assert.equal(page.find("Λ").length, 2);
  assert.equal(page.find("Λ", true).length, 1);
  assert.equal(page.find("λ", true).length, 1);
});

// An ink bitmap at scale 1: each word a solid block of ink on a line band.
function ink(lines, w = 300, h = 200) {
  const px = new Uint8Array(w * h);
  for (const { top, bottom, words } of lines) {
    for (const [x0, x1] of words) for (let y = top; y < bottom; y++) for (let x = x0; x < x1; x++) px[y * w + x] = 1;
  }
  return new PageInk(px, w, h, 1);
}

test("snap: the ends of a selection snap to whole words in the ink", () => {
  const page = ink([{ top: 90, bottom: 100, words: [[50, 80], [86, 120], [126, 170]] }]);
  // a text-layer rect that has drifted: it starts inside word 1 and ends inside word 2
  const [r] = page.snap([[60, 90, 100, 100]], { x: 60, y: 95 }, { x: 100, y: 95 });
  assert.ok(Math.abs(r[0] - 50) < 1 && Math.abs(r[2] - 120) < 1.7, `got ${r}`);
});

test("snap: middle lines run to the ends of their text; a far end point finds the line's last word", () => {
  const page = ink([
    { top: 50, bottom: 60, words: [[40, 100], [106, 250]] },
    { top: 70, bottom: 80, words: [[40, 140], [146, 260]] },
    { top: 90, bottom: 100, words: [[40, 90]] },
  ]);
  const rects = page.snap([[70, 50, 200, 60], [40, 70, 230, 80], [40, 90, 80, 100]], { x: 70, y: 55 }, { x: 290, y: 95 });
  assert.ok(Math.abs(rects[0][0] - 40) < 1 && Math.abs(rects[0][2] - 250) < 1.7, `line 1: ${rects[0]}`);
  assert.ok(Math.abs(rects[1][0] - 40) < 1 && Math.abs(rects[1][2] - 260) < 1.7, `line 2: ${rects[1]}`);
  assert.ok(Math.abs(rects[2][2] - 90) < 1.7, `line 3: ${rects[2]}`);
});

test("snap leaves a rect alone when there is no ink on its line", () => {
  const page = ink([]);
  assert.deepEqual(plain(page.snap([[10, 10, 50, 20]], { x: 10, y: 15 }, { x: 50, y: 15 })), [[10, 10, 50, 20]]);
});

test("align stretches a drifting text line onto its ink", () => {
  const l = textLine("abcdefghij klmnopqrst", 100, 0, 50);  // text layer: x 50..155
  const page = new PageText(l);
  page.align(ink([{ top: 93, bottom: 101, words: [[60, 110], [116, 172]] }]));  // printed: x 60..172
  assert.ok(Math.abs(page.chars[0].x0 - 60) < 1, `first ${page.chars[0].x0}`);
  assert.ok(Math.abs(page.chars.at(-1).x1 - 172) < 1.5, `last ${page.chars.at(-1).x1}`);
  page.align(ink([]));  // only once per page
  assert.ok(Math.abs(page.chars[0].x0 - 60) < 1);
});

test("align leaves lines whose ink doesn't plausibly match", () => {
  const l = textLine("abcdefghij", 100, 0, 50);
  const page = new PageText(l);
  page.align(ink([{ top: 93, bottom: 101, words: [[50, 200]] }]));  // three times as wide
  assert.equal(page.chars[0].x0, 50);
});

test("align moves each word onto its own printed word when the drift is uneven", () => {
  // text layer: three words evenly spaced; print: the middle word sits 12pt further right
  const l = textLine("abcde fghij klmno", 100, 0, 50);  // words at 50-75, 80-105, 110-135
  const page = new PageText(l);
  page.align(ink([{ top: 93, bottom: 101, words: [[50, 75], [92, 117], [122, 147]] }]));
  const word = i => { const w = page.chars.filter(c => c.c.trim()).slice(i * 5, i * 5 + 5); return [w[0].x0, w.at(-1).x1]; };
  for (const [i, [a, b]] of [[50, 75], [92, 117], [122, 147]].entries()) {
    const [x0, x1] = word(i);
    assert.ok(Math.abs(x0 - a) < 0.6 && Math.abs(x1 - b) < 0.6, `word ${i}: ${x0}-${x1}, printed ${a}-${b}`);
  }
});

test("align falls back to stretching the whole line when the ink's words don't match the text's", () => {
  const l = textLine("abcde fghij klmno", 100, 0, 50);  // text 50..135
  const page = new PageText(l);
  page.align(ink([{ top: 93, bottom: 101, words: [[60, 150]] }]));  // one unbroken run of ink: 60..150
  assert.ok(Math.abs(page.chars[0].x0 - 60) < 0.6 && Math.abs(page.chars.at(-1).x1 - 150) < 0.6);
});

test("PageInk.words splits a line's ink at its widest gaps", () => {
  const col = new Uint8Array(40);
  for (const [a, b] of [[0, 4], [6, 9], [14, 19], [21, 25]]) for (let x = a; x <= b; x++) col[x] = 1;  // gaps 1, 4, 1 wide
  assert.deepEqual(plain(PageInk.words(col, 0, 25, 2)), [[0, 9], [14, 25]]);
  assert.deepEqual(plain(PageInk.words(col, 0, 25, 4)), [[0, 4], [6, 9], [14, 19], [21, 25]]);
  assert.equal(PageInk.words(col, 0, 25, 5), null);
  assert.deepEqual(plain(PageInk.words(col, 0, 25, 1)), [[0, 25]]);
});

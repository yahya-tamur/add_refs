// The symbol recognizer's pipeline on synthetic glyphs: splitting a region into glyphs, merging the
// parts of one glyph, placing scripts, building the LaTeX, the matching itself, and learning. The
// templates are drawn here from simple strokes instead of KaTeX's fonts, so these tests are about
// the logic, not about recognizing any particular symbol.
const test = require("node:test");
const assert = require("node:assert/strict");
const { load, plain } = require("./load");
const { norm } = load(["terms.js"]);

// ---- drawing ----

// Shapes as strokes inside a w×h box with stroke width t: each a list of [x0, y0, x1, y1] rects.
const SHAPES = {
  L: (w, h, t) => [[0, 0, t, h], [0, h - t, w, h]],
  T: (w, h, t) => [[0, 0, w, t], [(w - t) / 2, 0, (w + t) / 2, h]],
  O: (w, h, t) => [[0, 0, w, t], [0, h - t, w, h], [0, 0, t, h], [w - t, 0, w, h]],
  U: (w, h, t) => [[0, 0, t, h], [w - t, 0, w, h], [0, h - t, w, h]],
  H: (w, h, t) => [[0, 0, t, h], [w - t, 0, w, h], [0, (h - t) / 2, w, (h + t) / 2]],
  E: (w, h, t) => [[0, 0, t, h], [0, 0, w, t], [0, (h - t) / 2, w, (h + t) / 2], [0, h - t, w, h]],
  P: (w, h, t) => [[0, 0, t, h], [0, 0, w, t], [w - t, 0, w, h / 2], [0, h / 2 - t, w, h / 2]],
  F: (w, h, t) => [[0, 0, t, h], [0, 0, w, t], [0, (h - t) / 2, w * 0.7, (h + t) / 2]],
  bar: (w, h) => [[0, 0, w, h]],
  eq: (w, h, t) => [[0, 0, w, t], [0, h - t, w, h]],              // two stacked bars, like =
  plus: (w, h, t) => [[(w - t) / 2, 0, (w + t) / 2, h], [0, (h - t) / 2, w, (h + t) / 2]],
  theta: (w, h, t) => [...SHAPES.O(w, h, t), [2 * t, (h - t) / 2, w - 2 * t, (h + t) / 2]],  // ring with a bar inside, not touching
};

function bitmap(w, h) {
  const m = new Uint8Array(w * h);
  return {
    m, w, h,
    // draw a shape with its box's top left at (x, y)
    draw(shape, x, y, bw, bh, t = 4) {
      for (const [x0, y0, x1, y1] of SHAPES[shape](bw, bh, t)) {
        for (let yy = Math.round(y + y0); yy < Math.round(y + y1); yy++) {
          for (let xx = Math.round(x + x0); xx < Math.round(x + x1); xx++) if (xx >= 0 && yy >= 0 && xx < w && yy < h) m[yy * w + xx] = 1;
        }
      }
      return this;
    },
  };
}
const glyph = (shape, w = 40, h = 60, t = 4) => bitmap(w, h).draw(shape, 0, 0, w, h, t);

// A canvas-like object with the bitmap's ink in black on white, as recognize() reads it.
function canvasOf(bmp) {
  const data = new Uint8ClampedArray(bmp.w * bmp.h * 4).fill(255);
  bmp.m.forEach((v, i) => { if (v) data.set([0, 0, 0], i * 4); });
  return { width: bmp.w, height: bmp.h, getContext: () => ({ getImageData: () => ({ data }) }) };
}

// ---- setup ----

function recognizer(templateList, store = { get: async () => null, set: async () => {} }) {
  const { Symbols } = load(["symbols.js"], { store });
  const T = Symbols.forTests;
  T.setTemplates(templateList(T));
  return Symbols;
}
// Capital-like templates sit on the baseline (base 1) at 0.7 of the font size; "x" is x-height
// (0.45); "p" has a descender, so its baseline is above its bottom (base 0.65).
const basicTemplates = T => [
  T.template("L", glyph("L")), T.template("T", glyph("T")), T.template("O", glyph("O")),
  T.template("U", glyph("U")), T.template("H", glyph("H")), T.template("E", glyph("E")),
  T.template("x", glyph("H", 40, 40), { size: 0.45 }),
  T.template("p", glyph("P", 40, 60), { base: 0.65, size: 0.65 }),
  T.template("=", glyph("eq", 40, 24)), T.template("\\Theta", glyph("theta")),
  T.template(",", glyph("bar", 8, 8), { base: 0.6, size: 0.12 }),
  T.template("'", glyph("bar", 6, 20), { base: 3, size: 0.25 }),
  T.template("*", glyph("plus", 30, 30), { base: 2, size: 0.3 }),
];

const read = async (S, bmp, inner = [10, 10, bmp.w - 10, bmp.h - 10]) => plain(await S.recognize(canvasOf(bmp), inner));
const best = async (S, bmp, inner) => (await read(S, bmp, inner)).readings[0]?.latex;

// ---- matching ----

test("thinning reduces a stroke to a one-pixel skeleton", () => {
  const S = recognizer(basicTemplates);
  const bold = glyph("bar", 12, 60);
  const skeleton = S.forTests.thin(bold);
  for (let y = 10; y < 50; y++) {  // thinning also shortens the ends by about half the stroke width
    let on = 0;
    for (let x = 0; x < 12; x++) on += skeleton[y * 12 + x];
    assert.ok(on >= 1 && on <= 2, `row ${y} has ${on} skeleton pixels`);
  }
});

test("similarity: identical shapes score 1; bold, narrow or shifted versions still beat other shapes", () => {
  const S = recognizer(basicTemplates), F = S.forTests;
  const L = F.features(glyph("L")), sim = (a, b) => F.similarity(a, b);
  assert.equal(sim(L, L), 1);
  const boldNarrowL = F.features(glyph("L", 24, 50, 9));
  const shiftedL = F.features(bitmap(46, 60).draw("L", 0, 0, 40, 60).draw("bar", 44, 0, 2, 2));  // a stray dot widens the box
  for (const other of ["T", "O", "H", "E"]) {
    const o = F.features(glyph(other));
    assert.ok(sim(boldNarrowL, L) > sim(boldNarrowL, o), `bold narrow L closer to ${other}`);
    assert.ok(sim(shiftedL, L) > sim(shiftedL, o), `shifted L closer to ${other}`);
  }
});

test("classify ranks by shape, then by aspect ratio and alphabet preference", () => {
  const S = recognizer(T => [
    T.template("L", glyph("L", 40, 60)),
    T.template("\\mathfrak{L}", glyph("L", 40, 60), { prior: 0.1 }),  // same shape, a rarer alphabet
    T.template("L_wide", glyph("L", 90, 30)),                         // same shape, very different aspect
    T.template("T", glyph("T")),
  ]);
  const ranked = plain(S.forTests.classify(S.forTests.features(glyph("L", 30, 50, 7)))).map(c => c.latex);
  assert.deepEqual(ranked.slice(0, 3), ["L", "\\mathfrak{L}", "L_wide"]);
});

// ---- splitting into glyphs ----

test("a single glyph is read, specks are ignored", async () => {
  const S = recognizer(basicTemplates);
  const img = bitmap(120, 100).draw("L", 40, 20, 30, 50, 6).draw("bar", 90, 30, 2, 2);  // speck
  assert.equal(await best(S, img), "L");
});

test("glyphs whose centre is outside the marked region are left out; ones cut by its edge are seen whole", async () => {
  const S = recognizer(basicTemplates);
  const img = bitmap(220, 100).draw("T", 20, 20, 30, 50, 6).draw("L", 120, 20, 30, 50, 6);
  // the region covers most of the L (centre inside) and only the edge of the T (centre outside)
  assert.equal(await best(S, img, [45, 10, 140, 90]), "L");
});

test("an empty region or a whole phrase gives no readings", async () => {
  const S = recognizer(basicTemplates);
  assert.deepEqual((await read(S, bitmap(100, 80))).readings, []);
  const phrase = bitmap(560, 100);
  for (let i = 0; i < 9; i++) phrase.draw("L", 20 + i * 60, 20, 30, 50, 6);
  assert.deepEqual((await read(S, phrase)).readings, []);
});

// ---- merging the parts of one glyph ----

test("stacked parts (like =) and enclosed parts (like the bar of Θ) make one glyph", async () => {
  const S = recognizer(basicTemplates);
  assert.equal(await best(S, bitmap(100, 80).draw("eq", 30, 25, 40, 24, 5)), "=");
  assert.equal(await best(S, bitmap(100, 100).draw("theta", 30, 20, 40, 60, 5)), "\\Theta");
});

test("a subscript tucked under its base is not merged into it", async () => {
  const S = recognizer(basicTemplates);
  // a small O under the right arm of a T: inside the T's box horizontally and vertically, not touching it
  const img = bitmap(140, 120).draw("T", 20, 20, 40, 60, 6).draw("O", 48, 66, 14, 24, 4);
  assert.equal(await best(S, img), "T_{O}");
});

// ---- placing scripts ----

test("subscripts, superscripts and inline glyphs are told apart by baseline and size", async () => {
  const S = recognizer(basicTemplates);
  const base = () => bitmap(160, 140).draw("L", 20, 40, 40, 60, 6);             // baseline y = 100
  assert.equal(await best(S, base().draw("T", 70, 85, 20, 30, 4)), "L_{T}");    // smaller, lower baseline
  assert.equal(await best(S, base().draw("T", 70, 25, 20, 30, 4)), "L^{T}");    // smaller, raised
  assert.equal(await best(S, base().draw("H", 70, 73, 27, 27, 5)), "Lx");       // x-height on the same baseline
});

test("a descender is not mistaken for a baseline", async () => {
  const S = recognizer(basicTemplates);
  // "p" spans y 40..100 but its baseline is at 79; an x-height glyph ending at 92 is below it: a subscript
  const img = bitmap(160, 140).draw("P", 20, 40, 40, 60, 6).draw("H", 66, 72, 20, 20, 4);
  assert.equal(await best(S, img), "p_{x}");
});

test("punctuation after a glyph is dropped", async () => {
  const S = recognizer(basicTemplates);
  const img = bitmap(140, 120).draw("L", 20, 20, 40, 60, 6).draw("bar", 66, 76, 8, 8);
  assert.equal(await best(S, img), "L");
});

test("primes and stars are written f' and A^*", async () => {
  const S = recognizer(basicTemplates);
  assert.equal(await best(S, bitmap(140, 120).draw("L", 20, 30, 40, 60, 6).draw("bar", 66, 20, 5, 14)), "L'");
  // a raised star may read as a superscript or as the (raised) text asterisk: either is the term A*
  assert.equal(norm(await best(S, bitmap(140, 120).draw("L", 20, 30, 40, 60, 6).draw("plus", 64, 14, 22, 22, 4))), norm("L^*"));
});

test("in scripts, digits win over look-alike letters", async () => {
  const S = recognizer(T => [...basicTemplates(T), T.template("o", glyph("O", 30, 30), { size: 0.45 }), T.template("0", glyph("O", 30, 30), { size: 0.45 })]);
  const img = bitmap(160, 140).draw("L", 20, 40, 40, 60, 6).draw("O", 66, 88, 18, 22, 4);
  assert.equal(await best(S, img), "L_{0}");
});

// ---- building the LaTeX ----

test("consecutive scripts are grouped, and commands keep a space before letters", async () => {
  const S = recognizer(T => [...basicTemplates(T), T.template("\\alpha", glyph("F"))]);
  const two = bitmap(200, 140).draw("L", 20, 40, 40, 60, 6).draw("T", 66, 85, 20, 30, 4).draw("U", 92, 85, 20, 30, 4);
  assert.equal(await best(S, two), "L_{TU}");
  const cmd = bitmap(200, 140).draw("F", 20, 40, 40, 60, 6).draw("L", 80, 40, 40, 60, 6);
  assert.equal(await best(S, cmd), "\\alpha L");
});

test("alternative readings swap in runner-ups, best first, without duplicates", async () => {
  const S = recognizer(basicTemplates);
  const { readings } = await read(S, bitmap(200, 120).draw("L", 20, 20, 40, 60, 6).draw("O", 90, 20, 40, 60, 6));
  assert.equal(readings[0].latex, "LO");
  assert.ok(readings.length > 1);
  assert.equal(new Set(readings.map(r => r.latex)).size, readings.length);
  for (let i = 1; i < readings.length; i++) assert.ok(readings[i - 1].score >= readings[i].score);
  // each alternative changes exactly one of the two glyphs
  assert.ok(readings.slice(1).every(r => r.latex.startsWith("L") !== r.latex.endsWith("O")), readings.map(r => r.latex).join(" "));
});

// ---- learning from corrections ----

test("a correction teaches the misread glyph, which is then preferred", async () => {
  const saved = [];
  const S = recognizer(basicTemplates, { get: async () => null, set: async (k, v) => saved.push([k, v.length]) });
  // an E drawn with a gap that makes it read as something else
  const odd = () => bitmap(140, 120).draw("H", 20, 20, 40, 60, 6).draw("L", 80, 20, 40, 60, 6);
  const first = await read(S, odd());
  assert.equal(first.readings[0].latex, "HL");
  assert.equal(await S.learn(first.glyphs, "\\mho L"), 1);  // only the misread first glyph is learned
  assert.deepEqual(saved, [["learned-glyphs", 1]]);
  assert.equal(await best(S, odd()), "\\mho L");
});

test("nothing is learned when the typed symbols don't match the glyphs one to one", async () => {
  const S = recognizer(basicTemplates);
  const r = await read(S, bitmap(140, 120).draw("H", 20, 20, 40, 60, 6).draw("L", 80, 20, 40, 60, 6));
  assert.equal(await S.learn(r.glyphs, "\\mho"), 0);
  assert.equal(await S.learn(r.glyphs, "x_{ij}"), 0);
  assert.equal(await S.learn([], "x"), 0);
  assert.equal(await S.learn(r.glyphs, "HL"), 0);  // already right
});

test("at most 400 learned glyphs are kept, the newest", async () => {
  const S = recognizer(basicTemplates);
  const r = await read(S, bitmap(100, 100).draw("H", 30, 20, 40, 60, 6));
  // each correction relabels the glyph, so each is learned anew
  for (let i = 0; i < 405; i++) await S.learn(r.glyphs, `\\mathfrak{${String.fromCharCode(65 + (i % 26))}}`);
  const learned = plain(S.forTests.templates().filter(t => t.learned).map(t => t.latex));
  assert.ok(learned.length <= 400, `${learned.length} learned`);
  assert.equal(learned.at(-1), `\\mathfrak{${String.fromCharCode(65 + (404 % 26))}}`);
});

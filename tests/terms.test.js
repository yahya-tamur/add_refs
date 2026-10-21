const test = require("node:test");
const assert = require("node:assert/strict");
const { load, plain } = require("./load");

const t = load(["terms.js"]);
const def = (term, page, y, color = "#000") => ({ term, color, box: { page, rect: [0, y, 10, y + 10] }, highlight: [] });
const ref = (term, page, y) => ({ term, page, rects: [[0, y, 10, y + 10]] });

test("norm: English phrases ignore case, spacing and plurals", () => {
  assert.equal(t.norm("Simple  Equivalences"), t.norm("simple equivalence"));
  assert.equal(t.norm("complexes"), "complex");
  assert.equal(t.norm("classes"), "class");
  assert.equal(t.norm("homologies"), "homology");
  assert.equal(t.norm("basis"), "basi");  // trailing s is dropped consistently, so "basis" still matches itself
});

test("norm: symbols match exactly, ignoring LaTeX spelling", () => {
  assert.notEqual(t.norm("T"), t.norm("t"));
  assert.notEqual(t.norm("\\Sigma_\\Lambda"), t.norm("\\sigma_\\Lambda"));
  assert.equal(t.norm("\\Sigma_{\\Lambda}"), t.norm("\\Sigma_\\Lambda"));
  assert.equal(t.norm("x_{i j}"), t.norm("x_{ij}"));
  assert.equal(t.norm("\\alpha b"), t.norm("\\alpha  b"));
  assert.notEqual(t.norm("\\alpha b"), t.norm("\\alphab"));
  assert.equal(t.norm("A^{\\ast}"), t.norm("A*"));
  assert.equal(t.norm("A^*"), t.norm("A*"));
  assert.equal(t.norm("f^{\\prime}"), t.norm("f'"));
  assert.equal(t.norm("$\\tau$"), t.norm("\\tau"));
});

test("isEnglishPhrase needs a word of three letters or more", () => {
  assert.ok(t.isEnglishPhrase("torsion"));
  assert.ok(t.isEnglishPhrase("simple homotopy type"));
  assert.ok(t.isEnglishPhrase("two-sided"));
  assert.ok(!t.isEnglishPhrase("A b"));
  assert.ok(!t.isEnglishPhrase("mi"));
  assert.ok(!t.isEnglishPhrase("T(f)"));
  assert.ok(!t.isEnglishPhrase("x".repeat(81)));
});

test("isLatex", () => {
  assert.ok(t.isLatex("\\tau"));
  assert.ok(t.isLatex("x_1"));
  assert.ok(!t.isLatex("torsion"));
});

test("resolveIn links to the nearest preceding definition, else the first one after", () => {
  const defs = [def("torsion", 3, 100), def("torsion", 7, 50), def("other", 1, 0)];
  assert.equal(t.resolveIn(defs, ref("Torsion", 5, 0)), defs[0]);
  assert.equal(t.resolveIn(defs, ref("torsion", 7, 80)), defs[1]);
  assert.equal(t.resolveIn(defs, ref("torsion", 7, 20)), defs[0]);  // same page, above the second definition
  assert.equal(t.resolveIn(defs, ref("torsion", 1, 0)), defs[0]);   // before every definition
  assert.equal(t.resolveIn(defs, ref("missing", 9, 0)), null);
});

test("pickColorIn prefers unused colours and never repeats a term's colour", () => {
  const [c0, c1, c2] = t.PALETTE;
  assert.equal(t.pickColorIn([]), c0);
  assert.equal(t.pickColorIn([def("a", 1, 0, c0)]), c1);
  // every colour used once except c2 twice: the least used, first in palette order, is c0
  const defs = t.PALETTE.map((c, i) => def("w" + i, 1, i, c)).concat(def("x", 1, 99, c2));
  assert.equal(t.pickColorIn(defs), c0);
  // a second definition of "w0" must not get w0's colour
  assert.notEqual(t.pickColorIn(defs, "w0"), c0);
  // `except` leaves a definition out (when recolouring it)
  const d = def("a", 1, 0, c0);
  assert.equal(t.pickColorIn([d], "a", d), c0);
});

test("clashesIn", () => {
  const d = def("basis", 1, 0, "#111");
  assert.ok(t.clashesIn([d], "#111", "Basis"));
  assert.ok(!t.clashesIn([d], "#222", "basis"));
  assert.ok(!t.clashesIn([d], "#111", "other"));
  assert.ok(!t.clashesIn([d], "#111", "basis", d));
});

test("clipRects removes covered parts on the same line only", () => {
  const line = [0, 100, 100, 110];
  assert.deepEqual(plain(t.clipRects([line], [[30, 100, 60, 110]])), [[0, 100, 30, 110], [60, 100, 100, 110]]);
  assert.deepEqual(plain(t.clipRects([line], [[-10, 100, 40, 110]])), [[40, 100, 100, 110]]);
  assert.deepEqual(plain(t.clipRects([line], [[0, 100, 100, 110]])), []);
  assert.deepEqual(plain(t.clipRects([line], [[30, 120, 60, 130]])), [line]);       // another line
  assert.deepEqual(plain(t.clipRects([line], [[0.5, 100, 99, 110]])), []);          // slivers under 1.5pt are dropped
  assert.deepEqual(plain(t.clipRects([line], [[10, 100, 20, 110], [50, 100, 70, 110]])),
    [[0, 100, 10, 110], [20, 100, 50, 110], [70, 100, 100, 110]]);
});

test("symbolQuery recognizes LaTeX and Unicode symbols", () => {
  const unicode = { "\\Lambda": "Λ", "\\Sigma": "Σ" };
  assert.deepEqual(plain(t.symbolQuery("\\Lambda", unicode)), { latex: "\\Lambda", char: "Λ" });
  assert.deepEqual(plain(t.symbolQuery(" Λ ", unicode)), { latex: "\\Lambda", char: "Λ" });
  assert.deepEqual(plain(t.symbolQuery("\\Sigma_{\\Lambda}", unicode)), { latex: "\\Sigma_{\\Lambda}", char: null });
  assert.deepEqual(plain(t.symbolQuery("ΣΛ", unicode)), { latex: "\\Sigma \\Lambda", char: "ΣΛ" });
  assert.equal(t.symbolQuery("torsion", unicode), null);
});

test("termHas finds a symbol inside a term, respecting command boundaries", () => {
  assert.ok(t.termHas("\\Sigma_{\\Lambda}", "\\Lambda"));
  assert.ok(t.termHas("\\Sigma_\\Lambda", "\\Sigma_{\\Lambda}"));
  assert.ok(t.termHas("T_{\\Lambda}", "\\Lambda"));
  assert.ok(t.termHas("\\tau(f)", "\\tau"));
  assert.ok(!t.termHas("\\Lambdax", "\\Lambda"));
  assert.ok(!t.termHas("\\lambda", "\\Lambda"));
});

test("underlineY sits just above the bottom of the line rect", () => {
  assert.equal(t.underlineY([0, 100, 10, 110]), 110 - 0.6);
});

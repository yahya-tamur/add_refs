const test = require("node:test");
const assert = require("node:assert/strict");
const { load, plain } = require("./load");

const { Symbols } = load(["symbols.js"]);
const atoms = s => plain(Symbols.atoms(s)).map(a => `${a.kind}:${a.latex}`);

test("atoms splits a term into symbols with their positions", () => {
  assert.deepEqual(atoms("\\Sigma_{\\Lambda}"), ["base:\\Sigma", "sub:\\Lambda"]);
  assert.deepEqual(atoms("\\Sigma_\\Lambda"), ["base:\\Sigma", "sub:\\Lambda"]);
  assert.deepEqual(atoms("x_{ij}^2"), ["base:x", "sub:i", "sub:j", "sup:2"]);
  assert.deepEqual(atoms("\\mathfrak{A}_n"), ["base:\\mathfrak{A}", "sub:n"]);
  assert.deepEqual(atoms("K_0"), ["base:K", "sub:0"]);
  assert.deepEqual(atoms("T"), ["base:T"]);
});

test("atoms writes primes and stars as superscripts, however they are spelled", () => {
  assert.deepEqual(atoms("f'"), ["base:f", "sup:'"]);
  assert.deepEqual(atoms("C^*"), ["base:C", "sup:*"]);
  assert.deepEqual(atoms("A^{\\ast}"), ["base:A", "sup:*"]);
  assert.deepEqual(atoms("C*"), ["base:C", "sup:*"]);
});

test("atoms rejects an unclosed group", () => {
  assert.equal(Symbols.atoms("x_{ij"), null);
});

test("unicode maps LaTeX commands to characters", () => {
  assert.equal(Symbols.unicode["\\Lambda"], "Λ");
  assert.equal(Symbols.unicode["\\tau"], "τ");
  assert.equal(Symbols.unicode["\\partial"], "∂");
  assert.equal(Symbols.unicode["\\sum"], "∑");
  assert.equal(Symbols.unicode.Lambda, undefined);
});

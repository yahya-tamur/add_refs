// Loads browser scripts from src/ into a sandbox, in order, as <script> tags would, and gives access
// to their globals (top-level const and class declarations are not properties of the global object,
// so they are read by evaluating their names).
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const source = f => fs.readFileSync(path.join(__dirname, "../src", f), "utf8");

function load(files, globals = {}) {
  const ctx = vm.createContext({ console, URL, Blob, TextEncoder, TextDecoder, setTimeout, clearTimeout, ...globals });
  ctx.window = ctx;
  for (const f of files) vm.runInContext(source(f), ctx, { filename: f });
  return new Proxy({}, { get: (_, name) => vm.runInContext(String(name), ctx) });
}

// The same, but in the test's own realm, for code whose objects go to libraries that check
// `instanceof` (pdf-lib). Each test file runs in its own process, so the globals stay contained.
function loadHere(files, globals = {}) {
  Object.assign(globalThis, globals);
  for (const f of files) vm.runInThisContext(source(f), { filename: f });
  return new Proxy({}, { get: (_, name) => vm.runInThisContext(String(name)) });
}

// Values made in the sandbox have its own Array/Object prototypes; compare them as plain JSON.
const plain = x => JSON.parse(JSON.stringify(x));

// Enough of `document` for text.js, which measures characters on a canvas when loading pages.
const documentStub = { createElement: () => ({ getContext: () => ({ font: "", measureText: s => ({ width: s.length }) }) }) };

module.exports = { load, loadHere, plain, documentStub };

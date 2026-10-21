const test = require("node:test");
const assert = require("node:assert/strict");
const { load, plain } = require("./load");

const { Ocr } = load(["ocr.js"]);

test("pack/unpack round-trips OCR characters, rounding to 0.1pt", () => {
  const chars = [
    { c: "a", item: 1, x0: 10.04, x1: 15.06, top: 90.01, bottom: 102.49, base: 100, size: 11.76, eol: false },
    { c: "b", item: 2, x0: 20, x1: 25, top: 90, bottom: 102.5, base: 100, size: 11.8, eol: true },
  ];
  const rows = Ocr.pack(chars);
  assert.deepEqual(plain(rows[0]), ["a", 1, 10, 15.1, 90, 102.5, 100, 11.8, 0]);
  const back = plain(Ocr.unpack(JSON.parse(JSON.stringify(rows))));
  assert.deepEqual(back[1], chars[1]);
  assert.equal(back[0].x1, 15.1);
  assert.equal(back[0].eol, false);
});

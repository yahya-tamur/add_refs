const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load");

// storage.js with stand-ins for the browser: a save dialog (or none), localStorage, and downloads.
function setup({ picker, userAgent = "Mozilla/5.0 Chrome/150" } = {}) {
  const saved = new Map(), downloads = [];
  const globals = {
    navigator: { userAgent },
    console: { ...console, warn() {} },  // the fallback logs why it fell back
    localStorage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, String(v)) },
    document: { createElement: () => ({ click() { downloads.push(this.download); } }) },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    setTimeout: () => 0,  // downloads release their URL after 30s; not needed here
  };
  if (picker) globals.showSaveFilePicker = picker;
  return { s: load(["storage.js"], globals), downloads, saved };
}

const handle = (writes, { failWrite = false } = {}) => ({
  name: "chosen.pdf",
  createWritable: async () => {
    if (failWrite) throw Object.assign(new Error("not allowed"), { name: "NotAllowedError" });
    return { write: async b => writes.push(b), close: async () => writes.push("closed"), abort: async () => writes.push("aborted") };
  },
});

test("without a save dialog the file is downloaded", async () => {
  const { s, downloads } = setup();
  const target = await s.chooseSaveTarget("paper (refs).pdf", "application/pdf", ".pdf");
  await target.write(new Uint8Array([1, 2]));
  assert.deepEqual(downloads, ["paper (refs).pdf"]);
  assert.equal(target.done, "Downloaded paper (refs).pdf");
});

test("with a save dialog the chosen file is written and closed", async () => {
  const writes = [];
  const { s, downloads } = setup({ picker: async () => handle(writes) });
  const target = await s.chooseSaveTarget("paper (refs).pdf", "application/pdf", ".pdf");
  await target.write("bytes");
  assert.deepEqual(writes, ["bytes", "closed"]);
  assert.equal(target.done, "Saved chosen.pdf");
  assert.equal(downloads.length, 0);
});

test("cancelling the dialog cancels the export", async () => {
  const { s } = setup({ picker: async () => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); } });
  assert.equal(await s.chooseSaveTarget("p.pdf", "application/pdf", ".pdf"), null);
});

test("a dialog whose file can't be written falls back to a download, and is skipped from then on", async () => {
  let calls = 0;
  const { s, downloads, saved } = setup({ picker: async () => { calls++; return handle([], { failWrite: true }); } });
  const first = await s.chooseSaveTarget("p.pdf", "application/pdf", ".pdf");
  await first.write("x");
  assert.deepEqual(downloads, ["p.pdf"]);
  assert.equal(saved.get("add-refs:picker-refused"), "1");
  await s.chooseSaveTarget("p.pdf", "application/pdf", ".pdf");
  assert.equal(calls, 1);
});

test("the Claude desktop browser pane skips the dialog", async () => {
  let calls = 0;
  const { s } = setup({ picker: async () => { calls++; return handle([]); }, userAgent: "Mozilla/5.0 Claude/3.1623.0 Chrome/152" });
  const target = await s.chooseSaveTarget("p.pdf", "application/pdf", ".pdf");
  assert.equal(calls, 0);
  assert.match(target.done, /^Downloaded/);
});

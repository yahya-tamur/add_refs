// Browser-side persistence: a small IndexedDB key-value store (annotations per PDF, last opened PDF)
// and saving files.

/* exported store, chooseSaveTarget */
const store = (() => {
  let db = null;
  const open = () => db ||= new Promise((resolve, reject) => {
    const req = indexedDB.open("add-refs", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async (mode, fn) => {
    const t = (await open()).transaction("kv", mode);
    const req = fn(t.objectStore("kv"));
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
    });
  };
  return {
    get: key => run("readonly", s => s.get(key)),
    set: (key, value) => run("readwrite", s => s.put(value, key)),
  };
})();

function download(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Asks where to save before the caller builds the file: the save dialog only opens while the click
// that started the export still counts as a user action. Browsers without the dialog (Firefox,
// Safari) download instead, which asks for a location only if the browser is set to.
// Some embedded browsers show the dialog but refuse to write the chosen file (and ask where to save
// downloads instead), so the file is opened for writing right away; a refusal falls back to a
// download and is remembered, so later exports skip the useless dialog. The Claude desktop app's
// browser pane is known to refuse. Returns null if the user cancels.
const PICKER_REFUSED = "add-refs:picker-refused";
const pickerRefused = () => {
  if (/\bClaude\//.test(navigator.userAgent)) return true;
  try { return localStorage.getItem(PICKER_REFUSED) === "1"; } catch { return false; }
};

async function chooseSaveTarget(name, type, ext) {
  const fallback = () => ({ name, write: bytes => download(name, bytes, type), abort() {}, done: `Downloaded ${name}` });
  if (!window.showSaveFilePicker || pickerRefused()) return fallback();
  let handle, writable;
  try {
    handle = await showSaveFilePicker({ suggestedName: name, id: "export", types: [{ description: ext.slice(1).toUpperCase(), accept: { [type]: [ext] } }] });
  } catch (e) {
    return e.name === "AbortError" ? null : fallback();
  }
  try {
    writable = await handle.createWritable();
  } catch (e) {
    console.warn("Cannot write the chosen file:", e);
    try { localStorage.setItem(PICKER_REFUSED, "1"); } catch { /* not remembered */ }
    return fallback();
  }
  return {
    name: handle.name,
    write: async bytes => { await writable.write(bytes); await writable.close(); },
    abort: () => writable.abort().catch(() => {}),
    done: `Saved ${handle.name}`,
  };
}

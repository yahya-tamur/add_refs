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
// Returns null if the user cancels.
async function chooseSaveTarget(name, type, ext) {
  const fallback = { name, write: bytes => download(name, bytes, type), done: `Downloaded ${name} to your downloads folder` };
  if (!window.showSaveFilePicker) return fallback;
  let handle;
  try {
    handle = await showSaveFilePicker({ suggestedName: name, id: "export", types: [{ description: ext.slice(1).toUpperCase(), accept: { [type]: [ext] } }] });
  } catch (e) {
    return e.name === "AbortError" ? null : fallback;
  }
  return {
    name: handle.name,
    write: async bytes => { const w = await handle.createWritable(); await w.write(bytes); await w.close(); },
    done: `Saved ${handle.name}`,
  };
}

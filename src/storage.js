// Browser-side persistence: a small IndexedDB key-value store (annotations per PDF, last opened PDF)
// and file downloads.

/* exported store, download */
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

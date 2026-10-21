/* global pdfjsLib, katex, PDFLib, PageText, store, download */
// Annotation model (kept in IndexedDB per PDF, saved as "<name>.refs.json"). Coordinates are page points at
// scale 1 with the origin at the top left, the same as the sidecars viewer.html reads.
//   definitions: { id, term, color, text, highlight: [{ page, rects }], box: { page, rect } }
//   references:  { id, page, rects, text, term }   — linked to the nearest preceding definition of term

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";
const SVGNS = "http://www.w3.org/2000/svg";
const PALETTE = ["#f2b705", "#2a9df4", "#3cb371", "#e8559a", "#ff8c1a", "#8e5cd9", "#17b8b0", "#d64545", "#7a9a01", "#a0522d"];
const UNRESOLVED = "#8a8a8a";

const $ = id => document.getElementById(id);
const viewer = $("viewer"), pagesEl = $("pages");

let docName = null, docKey = null, pdfBytes = null, pdf = null;
let refsHandle = null; // .refs.json file chosen with "Save annotations" where the browser can write to it
let pages = [];        // 1-based: { n, page, vp1, el, canvas, overlay, hits, renderedScale, task, textData }
let data = emptyData();
let scale = 1.5;
let pending = null;    // definition in progress: { parts: [{ page, rects }], text }
const undoStack = [], backStack = [];

function emptyData() { return { version: 1, definitions: [], references: [] }; }

// ---------- terms ----------

const isLatex = t => /[\\^_{}$]/.test(t);
function norm(t) {
  let s = t.normalize("NFKC").toLowerCase().replace(/\$/g, "").replace(/\s+/g, " ").trim();
  if (/^[a-z][a-z' -]*$/.test(s)) s = s.replace(/(ss|x|ch|sh)es$/, "$1").replace(/ies$/, "y").replace(/([^s])s$/, "$1");
  return s;
}
const isEnglishPhrase = t => t.length >= 3 && t.length <= 80 && /^[A-Za-z][A-Za-z'’ -]*[A-Za-z]$/.test(t);

function renderTerm(el, term) {
  el.textContent = "";
  const math = (tex, display) => { const s = document.createElement("span"); katex.render(tex, s, { throwOnError: false, displayMode: display }); return s; };
  if (term.includes("$")) term.split("$").forEach((seg, i) => el.append(i % 2 ? math(seg) : seg));
  else if (isLatex(term)) el.append(math(term));
  else el.textContent = term;
}

const posOf = d => [d.box.page, d.box.rect[1]];
const before = ([p1, y1], [p2, y2]) => p1 < p2 || p1 === p2 && y1 <= y2;

// The definition a reference links to: same term, nearest preceding (else the first one after).
function resolve(ref) {
  const key = norm(ref.term);
  const cands = data.definitions.filter(d => norm(d.term) === key).sort((a, b) => before(posOf(a), posOf(b)) ? -1 : 1);
  if (!cands.length) return null;
  const at = [ref.page, ref.rects[0]?.[1] ?? 0];
  return cands.filter(d => before(posOf(d), at)).at(-1) || cands[0];
}

function colorFor(term) {
  const same = data.definitions.find(d => norm(d.term) === norm(term));
  if (same) return same.color;
  const used = new Set(data.definitions.map(d => d.color));
  return PALETTE.find(c => !used.has(c)) || PALETTE[data.definitions.length % PALETTE.length];
}

// ---------- persistence ----------

let saveTimer = null;
function mutate(fn) {
  undoStack.push(JSON.stringify(data));
  if (undoStack.length > 200) undoStack.shift();
  fn();
  changed();
}
function changed() {
  drawAll();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await store.set(docKey, data);
      if (refsHandle) await writeRefs();
      setStatus(refsHandle ? `Saved to ${refsHandle.name}` : "Saved in this browser");
    } catch (e) { setStatus("Save failed: " + e.message); }
  }, 300);
}
async function writeRefs() {
  const w = await refsHandle.createWritable();
  await w.write(JSON.stringify(data, null, 1));
  await w.close();
}
// Chromium browsers write to a chosen file (and keep autosaving there); others download a copy.
async function saveRefsFile() {
  if (!pdf) return;
  const name = docName + ".refs.json";
  if (window.showSaveFilePicker) {
    try {
      refsHandle ||= await showSaveFilePicker({ suggestedName: name, types: [{ description: "Annotations", accept: { "application/json": [".json"] } }] });
    } catch { return; }  // picker cancelled
    await writeRefs();
    setStatus(`Saved to ${refsHandle.name}; later changes are saved there too`);
  } else {
    download(name, JSON.stringify(data, null, 1), "application/json");
    setStatus("Downloaded " + name);
  }
}
function undo() {
  if (!undoStack.length) return;
  data = JSON.parse(undoStack.pop());
  changed();
  setStatus("Undone");
}

// ---------- loading & rendering ----------

// Annotations come from `refs` when the user chose a file; otherwise from this browser's copy for
// this PDF, falling back to `refs` (e.g. from a ?refs= URL) when there is none.
async function openPdf(name, bytes, refs = null, { preferStored = false } = {}) {
  pdfBytes = bytes.slice();
  pdf?.destroy();
  pdf = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
  docName = name.replace(/\.pdf$/i, ""); docKey = "refs:" + pdf.fingerprints[0]; refsHandle = null;
  const stored = await store.get(docKey).catch(() => null);
  data = (preferStored ? stored || refs : refs || stored) || emptyData();
  if (refs && data === refs) store.set(docKey, data).catch(() => {});
  store.set("last", { name, bytes: pdfBytes }).catch(() => {});
  undoStack.length = backStack.length = 0; pending = null; updateBack();
  $("file").textContent = name;
  document.title = name + " — Add Refs";
  $("export").disabled = $("save").disabled = false;
  pagesEl.innerHTML = ""; pages = [];
  observer.disconnect(); visible.clear();
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const el = document.createElement("div");
    el.className = "page"; el.dataset.n = n;
    const canvas = document.createElement("canvas");
    const overlay = svg("svg", { class: "overlay", viewBox: `0 0 ${vp1.width} ${vp1.height}` });
    const hits = svg("svg", { class: "hits", viewBox: `0 0 ${vp1.width} ${vp1.height}` });
    const label = document.createElement("div");
    label.className = "label"; label.textContent = "PDF page " + n;
    el.append(canvas, overlay, hits, label);
    pagesEl.append(el);
    pages[n] = { n, page, vp1, el, canvas, overlay, hits, renderedScale: 0 };
    sizePage(pages[n]);
    observer.observe(el);
  }
  viewer.scrollTop = 0;
  drawAll();
  setStatus(`${data.definitions.length} definitions, ${data.references.length} references`);
}

function sizePage(p) {
  p.el.style.width = p.vp1.width * scale + "px";
  p.el.style.height = p.vp1.height * scale + "px";
}

const visible = new Set();
const observer = new IntersectionObserver(entries => {
  for (const e of entries) {
    const p = pages[+e.target.dataset.n];
    if (e.isIntersecting) { visible.add(p); renderPage(p); } else visible.delete(p);
  }
}, { root: viewer, rootMargin: "600px 0px" });

async function renderPage(p) {
  if (p.renderedScale === scale) return;
  p.task?.cancel();
  const dpr = window.devicePixelRatio || 1;
  const vp = p.page.getViewport({ scale: scale * dpr });
  const off = document.createElement("canvas");
  off.width = Math.ceil(vp.width); off.height = Math.ceil(vp.height);
  p.renderedScale = scale;
  p.task = p.page.render({ canvasContext: off.getContext("2d"), viewport: vp });
  try { await p.task.promise; } catch { return; }  // cancelled by a newer render
  p.canvas.width = off.width; p.canvas.height = off.height;
  p.canvas.getContext("2d").drawImage(off, 0, 0);
}

function setScale(s) {
  s = Math.min(Math.max(s, 0.5), 4);
  if (s === scale || !pages.length) return;
  const frac = viewer.scrollTop / pagesEl.scrollHeight;
  scale = s;
  for (const p of pages.slice(1)) sizePage(p);
  viewer.scrollTop = frac * pagesEl.scrollHeight;
  for (const p of visible) renderPage(p);
}

const loadText = p => p.textPromise ||= PageText.load(p.page).then(t => (p.textData = t));

// ---------- drawing ----------

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
const rectAttrs = ([x0, y0, x1, y1]) => ({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
const underlineY = r => r[3] - (r[3] - r[1]) * 0.06;

function drawAll() {
  for (const p of pages.slice(1)) { p.overlay.replaceChildren(); p.hits.replaceChildren(); }
  for (const d of data.definitions) {
    for (const part of d.highlight) {
      for (const r of part.rects) {
        pages[part.page]?.overlay.append(svg("rect", { ...rectAttrs(r), fill: d.color, "fill-opacity": 0.32 }));
        pages[part.page]?.hits.append(svg("rect", { ...rectAttrs(r), class: "hit def", "data-def": d.id }));
      }
    }
    const b = pages[d.box.page];
    if (!b) continue;
    b.overlay.append(svg("rect", { ...rectAttrs(d.box.rect), fill: "none", stroke: d.color, "stroke-width": 1.3, id: "box-" + d.id }));
    b.hits.append(svg("rect", { ...rectAttrs(d.box.rect), class: "hit def", "data-def": d.id }));
  }
  for (const ref of data.references) {
    const p = pages[ref.page];
    if (!p) continue;
    const def = resolve(ref);
    for (const r of ref.rects) {
      const y = underlineY(r);
      p.overlay.append(svg("line", { x1: r[0], x2: r[2], y1: y, y2: y, stroke: def ? def.color : UNRESOLVED,
        "stroke-width": 1.4, ...(def ? {} : { "stroke-dasharray": "2 2" }) }));
      p.hits.append(svg("rect", { ...rectAttrs(r), class: "hit ref", "data-ref": ref.id }));
    }
  }
  if (pending) {
    for (const part of pending.parts) for (const r of part.rects) {
      pages[part.page]?.overlay.append(svg("rect", { ...rectAttrs(r), fill: "#2a6fdb", "fill-opacity": 0.18,
        stroke: "#2a6fdb", "stroke-dasharray": "3 2", "stroke-width": 0.8 }));
    }
  }
  drawSidebar();
}

function drawSidebar() {
  const counts = new Map(), unresolved = [];
  for (const ref of data.references) {
    const d = resolve(ref);
    if (d) counts.set(d.id, (counts.get(d.id) || 0) + 1); else unresolved.push(ref);
  }
  const defs = [...data.definitions].sort((a, b) => before(posOf(a), posOf(b)) ? -1 : 1);
  $("defs").replaceChildren(...defs.map(d => row(d.color, d.term, `p. ${d.box.page} · ${counts.get(d.id) || 0}`,
    () => jumpTo(d.box.page, d.box.rect[1], d.box.rect), e => defMenu(e, d))));
  if (!defs.length) $("defs").innerHTML = '<div class="def-row" style="cursor:default;color:var(--muted)">None yet</div>';
  $("unresolved").replaceChildren(...(unresolved.length ? [Object.assign(document.createElement("h2"), { textContent: `Unlinked (${unresolved.length})` })] : []),
    ...unresolved.map(r => row(UNRESOLVED, r.term, `p. ${r.page}`, () => jumpTo(r.page, r.rects[0][1], r.rects[0]), e => refMenu(e, r))));
}

function row(color, term, meta, onclick, oncontext) {
  const el = document.createElement("div");
  el.className = "def-row";
  el.innerHTML = '<span class="sw"></span><span class="term"></span><span class="meta"></span>';
  el.querySelector(".sw").style.background = color;
  renderTerm(el.querySelector(".term"), term);
  el.querySelector(".meta").textContent = meta;
  el.onclick = onclick; el.oncontextmenu = oncontext;
  return el;
}

// ---------- navigation ----------

function jumpTo(page, y, flashRect) {
  const p = pages[page];
  if (!p) return;
  viewer.scrollTop = p.el.offsetTop + y * scale - 120;
  if (flashRect) {
    const f = svg("rect", { ...rectAttrs(flashRect), fill: "none", stroke: "#2a6fdb", class: "flash" });
    p.overlay.append(f);
    setTimeout(() => f.remove(), 1500);
  }
}
function followRef(ref) {
  const d = resolve(ref);
  if (!d) { setStatus(`No definition of “${ref.term}” yet`); return; }
  backStack.push(viewer.scrollTop); updateBack();
  jumpTo(d.box.page, d.box.rect[1], d.box.rect);
}
function goBack() { if (backStack.length) { viewer.scrollTop = backStack.pop(); updateBack(); } }
function updateBack() { $("back").hidden = !backStack.length; }

// ---------- mouse: highlight / box / underline ----------

let drag = null;
function pagePoint(p, e) {
  const r = p.el.getBoundingClientRect();
  const x = Math.min(Math.max(e.clientX - r.left, 0), r.width), y = Math.min(Math.max(e.clientY - r.top, 0), r.height);
  return { x: x / scale, y: y / scale };
}

viewer.addEventListener("mousedown", e => {
  if (e.button !== 0) return;
  hideMenu();
  if (!$("prompt").hidden) { cancelPrompt(); return; }
  const el = e.target.closest(".page");
  if (!el) return;
  e.preventDefault();
  const p = pages[+el.dataset.n];
  loadText(p);
  const mode = e.shiftKey ? "highlight" : pending ? "box" : "underline";
  drag = { p, mode, start: pagePoint(p, e), end: null, moved: false, target: e.target, preview: svg("g") };
  p.overlay.append(drag.preview);
});

addEventListener("mousemove", e => {
  if (!drag) return;
  const pt = pagePoint(drag.p, e);
  if (!drag.moved && Math.hypot(pt.x - drag.start.x, pt.y - drag.start.y) * scale < 4) return;
  drag.moved = true; drag.end = pt;
  hideTip();
  const sel = dragResult(drag);
  drag.preview.replaceChildren(...(sel?.rects || []).map(r => drag.mode === "underline"
    ? svg("line", { x1: r[0], x2: r[2], y1: underlineY(r), y2: underlineY(r), stroke: "#2a6fdb", "stroke-width": 1.4 })
    : drag.mode === "box"
      ? svg("rect", { ...rectAttrs(r), fill: "none", stroke: "#2a6fdb", "stroke-width": 1.2, "stroke-dasharray": "3 2" })
      : svg("rect", { ...rectAttrs(r), fill: "#2a6fdb", "fill-opacity": 0.2 })));
});

addEventListener("mouseup", e => {
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.moved) {
    d.preview.remove();
    const refId = d.target.dataset?.ref;
    if (refId) followRef(data.references.find(r => r.id === refId));
    return;
  }
  const sel = dragResult(d);
  if (!sel || !sel.rects.length) { d.preview.remove(); return; }
  if (d.mode === "highlight") {
    d.preview.remove();
    pending ||= { parts: [], text: "" };
    const part = pending.parts.find(x => x.page === d.p.n);
    if (part) part.rects.push(...sel.rects); else pending.parts.push({ page: d.p.n, rects: sel.rects });
    pending.text = (pending.text + " " + sel.text).trim();
    drawAll();
    setStatus("Now drag a box around the term being defined · Shift-drag adds more text · Esc cancels", true);
  } else if (d.mode === "box") {
    const rect = sel.rects[0], inside = boxText(d.p, rect);
    openPrompt({
      x: e.clientX, y: e.clientY, kind: "def", label: "This passage defines:",
      value: isEnglishPhrase(inside) ? inside : "",
      onDone: term => {
        d.preview.remove();
        if (!term) return;
        mutate(() => {
          data.definitions.push({ id: crypto.randomUUID(), term, color: colorFor(term), text: pending.text,
            highlight: pending.parts, box: { page: d.p.n, rect } });
          pending = null;
        });
        setStatus(`Defined “${term}”`);
      },
    });
  } else {
    const at = [d.p.n, sel.rects[0][1]];
    openPrompt({
      x: e.clientX, y: e.clientY, kind: "ref", at, label: "Refers to:",
      value: isEnglishPhrase(sel.text) ? sel.text : "",
      onDone: term => {
        d.preview.remove();
        if (!term) return;
        const ref = { id: crypto.randomUUID(), page: d.p.n, rects: sel.rects, text: sel.text, term };
        mutate(() => data.references.push(ref));
        const def = resolve(ref);
        setStatus(def ? `Linked to “${def.term}” (p. ${def.box.page})` : `No definition of “${term}” yet — saved unlinked`);
      },
    });
  }
});

// Text selection for highlight/underline drags (falls back to the dragged rectangle where the
// page has no usable text layer); a plain rectangle for box drags.
function dragResult(d) {
  const a = d.start, b = d.end;
  const rect = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)].map(v => Math.round(v * 10) / 10);
  if (d.mode === "box") return { rects: [rect], text: "" };
  const sel = d.p.textData?.select(a, b);
  if (sel?.rects.length) return sel;
  return rect[3] - rect[1] > 2 ? { rects: [rect], text: "" } : null;
}

function boxText(p, [x0, y0, x1, y1]) {
  const chars = (p.textData?.chars || []).filter(c => {
    const cx = (c.x0 + c.x1) / 2, cy = (c.top + c.bottom) / 2;
    return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
  });
  return chars.map((c, i) => (i && c.item !== chars[i - 1].item && !/\s$/.test(chars[i - 1].c) ? " " : "") + c.c)
    .join("").replace(/-\s+/g, "").replace(/\s+/g, " ").trim();
}

// ---------- term prompt ----------

let promptState = null;
function openPrompt(opts) {
  promptState = { ...opts, active: -1, items: [] };
  const box = $("prompt"), input = $("prompt-input");
  $("prompt-label").textContent = opts.label;
  input.value = opts.value || "";
  box.hidden = false;
  const w = box.offsetWidth;
  box.style.left = Math.min(opts.x + 8, innerWidth - w - 8) + "px";
  box.style.top = Math.min(opts.y + 12, innerHeight - 330) + "px";
  input.focus(); input.select();
  updatePrompt();
}

function closePrompt(term) {
  if (!promptState) return;
  const { onDone } = promptState;
  promptState = null;
  $("prompt").hidden = true;
  onDone(term);
}
function cancelPrompt() { closePrompt(null); }

function updatePrompt() {
  const st = promptState, value = $("prompt-input").value.trim();
  renderTerm($("prompt-preview"), value);
  // Suggestions: one per distinct term, filtered by what has been typed.
  const terms = new Map();
  for (const d of data.definitions) if (!terms.has(norm(d.term))) terms.set(norm(d.term), d);
  const q = norm(value);
  st.items = [...terms.values()].filter(d => !q || norm(d.term).includes(q) || d.term.toLowerCase().includes(value.toLowerCase()))
    .sort((a, b) => (norm(a.term) === q ? -1 : 0) - (norm(b.term) === q ? -1 : 0) || norm(a.term).indexOf(q) - norm(b.term).indexOf(q))
    .slice(0, 30);
  st.active = Math.min(st.active, st.items.length - 1);
  $("prompt-suggest").replaceChildren(...st.items.map((d, i) => {
    const li = document.createElement("li");
    li.className = i === st.active ? "active" : "";
    li.innerHTML = '<span class="sw"></span><span class="t"></span><span class="meta"></span>';
    li.querySelector(".sw").style.background = d.color;
    renderTerm(li.querySelector(".t"), d.term);
    li.querySelector(".meta").textContent = "p. " + d.box.page;
    li.onmousedown = e => { e.preventDefault(); closePrompt(d.term); };
    return li;
  }));
  const chosen = st.active >= 0 ? st.items[st.active].term : value;
  const m = $("prompt-match");
  if (!chosen) { m.textContent = st.kind === "ref" ? "Type a term or pick a definition" : "Type the symbol or phrase (LaTeX ok)"; return; }
  if (st.kind === "ref") {
    const def = resolve({ term: chosen, page: st.at[0], rects: [[0, st.at[1]]] });
    m.innerHTML = def ? '→ links to <span class="sw"></span><span class="t"></span> (p. ' + def.box.page + ")" : "No matching definition yet — will be saved unlinked";
    if (def) { m.querySelector(".sw").style.background = def.color; renderTerm(m.querySelector(".t"), def.term); }
  } else {
    const same = data.definitions.find(d => norm(d.term) === norm(chosen));
    m.innerHTML = same ? '<span class="sw"></span>Another definition of an existing term (same colour)' : "New term";
    if (same) m.querySelector(".sw").style.background = same.color;
  }
}

$("prompt-input").addEventListener("input", () => { promptState.active = -1; updatePrompt(); });
$("prompt-input").addEventListener("keydown", e => {
  const st = promptState;
  if (!st) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = st.items.length;
    if (n) st.active = e.key === "ArrowDown" ? (st.active + 1) % n : (st.active <= 0 ? n - 1 : st.active - 1);
    updatePrompt();
    $("prompt-suggest").children[st.active]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Tab") {
    e.preventDefault();
    const d = st.items[Math.max(st.active, 0)];
    if (d) { $("prompt-input").value = d.term; st.active = -1; updatePrompt(); }
  } else if (e.key === "Enter") {
    e.preventDefault();
    closePrompt(st.active >= 0 ? st.items[st.active].term : $("prompt-input").value.trim() || null);
  } else if (e.key === "Escape") {
    e.preventDefault(); e.stopPropagation();
    cancelPrompt();
  }
});

// ---------- hover tips & context menu ----------

function hoveredItem(target) {
  if (target.dataset?.ref) return { ref: data.references.find(r => r.id === target.dataset.ref) };
  if (target.dataset?.def) return { def: data.definitions.find(d => d.id === target.dataset.def) };
  return null;
}

viewer.addEventListener("mouseover", e => {
  if (drag) return;
  const it = hoveredItem(e.target);
  if (!it) return;
  const tip = $("tip");
  tip.replaceChildren();
  const head = document.createElement("div"), ctx = document.createElement("div");
  ctx.className = "ctx";
  if (it.ref) {
    const d = resolve(it.ref);
    renderTerm(head, it.ref.term);
    ctx.textContent = d ? `Defined on p. ${d.box.page}: ${clip(d.text)} — click to jump` : "No definition yet";
  } else if (it.def) {
    renderTerm(head, it.def.term);
    ctx.textContent = "Definition: " + clip(it.def.text);
  }
  tip.append(head, ctx);
  tip.hidden = false;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = Math.min(e.clientY + 16, innerHeight - tip.offsetHeight - 8) + "px";
});
viewer.addEventListener("mouseout", e => { if (hoveredItem(e.target)) hideTip(); });
const hideTip = () => { $("tip").hidden = true; };
const clip = t => !t ? "" : t.length > 160 ? t.slice(0, 160) + "…" : t;

viewer.addEventListener("contextmenu", e => {
  const it = hoveredItem(e.target);
  if (it?.ref) refMenu(e, it.ref);
  else if (it?.def) defMenu(e, it.def);
});

function showMenu(e, items) {
  e.preventDefault();
  hideTip();
  const m = $("menu");
  m.replaceChildren(...items.map(([label, fn]) => {
    const d = document.createElement("div");
    d.textContent = label;
    d.onclick = () => { hideMenu(); fn(); };
    return d;
  }));
  m.hidden = false;
  m.style.left = Math.min(e.clientX, innerWidth - m.offsetWidth - 4) + "px";
  m.style.top = Math.min(e.clientY, innerHeight - m.offsetHeight - 4) + "px";
}
const hideMenu = () => { $("menu").hidden = true; };
addEventListener("mousedown", e => { if (!e.target.closest("#menu")) hideMenu(); });

function defMenu(e, d) {
  showMenu(e, [
    ["Edit term…", () => openPrompt({ x: e.clientX, y: e.clientY, kind: "def", label: "This passage defines:", value: d.term,
      onDone: term => term && term !== d.term && mutate(() => {
        const others = data.definitions.filter(x => x !== d && norm(x.term) === norm(term));
        d.term = term;
        d.color = others[0]?.color || (data.definitions.some(x => x !== d && x.color === d.color) ? colorFor(term) : d.color);
      }) })],
    ["Delete definition", () => mutate(() => { data.definitions = data.definitions.filter(x => x !== d); })],
  ]);
}
function refMenu(e, r) {
  showMenu(e, [
    ["Follow link", () => followRef(r)],
    ["Edit term…", () => openPrompt({ x: e.clientX, y: e.clientY, kind: "ref", at: [r.page, r.rects[0][1]], label: "Refers to:", value: r.term,
      onDone: term => term && mutate(() => { r.term = term; }) })],
    ["Delete reference", () => mutate(() => { data.references = data.references.filter(x => x !== r); })],
  ]);
}

// ---------- export ----------

async function exportPdf() {
  if (!pdf) return;
  setStatus("Exporting…");
  const { PDFDocument, PDFName, PDFNull, rgb, BlendMode } = PDFLib;
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const docPages = doc.getPages();
  const toPdf = (n, [x0, y0, x1, y1]) => {
    const [a, b] = pages[n].vp1.convertToPdfPoint(x0, y0), [c, d] = pages[n].vp1.convertToPdfPoint(x1, y1);
    return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  };
  const color = hex => rgb(...[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255));
  const sidecar = { sections: [] };
  for (const d of data.definitions) {
    for (const part of d.highlight) {
      for (const r of part.rects) {
        const [x0, y0, x1, y1] = toPdf(part.page, r);
        docPages[part.page - 1].drawRectangle({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, color: color(d.color), opacity: 0.32, blendMode: BlendMode.Multiply });
      }
      sidecar.sections.push({ page: part.page, rects: part.rects, note: `${d.term}: p. ${d.box.page}` });
    }
    const [x0, y0, x1, y1] = toPdf(d.box.page, d.box.rect);
    docPages[d.box.page - 1].drawRectangle({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, borderColor: color(d.color), borderWidth: 1.2, blendMode: BlendMode.Multiply });
  }
  for (const ref of data.references) {
    const d = resolve(ref);
    if (!d) continue;
    const page = docPages[ref.page - 1];
    for (const r of ref.rects) {
      const [x0, , x1] = toPdf(ref.page, r), [, uy] = pages[ref.page].vp1.convertToPdfPoint(0, underlineY(r));
      page.drawLine({ start: { x: x0, y: uy }, end: { x: x1, y: uy }, thickness: 1.2, color: color(d.color), blendMode: BlendMode.Multiply });
      const [, top] = pages[d.box.page].vp1.convertToPdfPoint(0, Math.max(d.box.rect[1] - 40, 0));
      const annot = doc.context.obj({
        Type: "Annot", Subtype: "Link", Rect: toPdf(ref.page, r), Border: [0, 0, 0],
        Dest: [docPages[d.box.page - 1].ref, PDFName.of("XYZ"), PDFNull, top, PDFNull],
      });
      page.node.addAnnot(doc.context.register(annot));
    }
  }
  // The sidecar is the format math 610 papers/highlighted/viewer.html reads next to "<name> (refs).pdf".
  download(docName + " (refs).pdf", await doc.save(), "application/pdf");
  download(docName + " (refs).json", JSON.stringify(sidecar, null, 1), "application/json");
  setStatus(`Downloaded ${docName} (refs).pdf and its .json sidecar`);
}

// ---------- toolbar & keys ----------

function setStatus(msg, mode = false) { $("status").textContent = msg; $("status").classList.toggle("mode", mode); }

const isRefs = r => Array.isArray(r?.definitions) && Array.isArray(r?.references);

// A PDF, optionally with its .refs.json; a .refs.json alone loads onto the open PDF.
async function openFiles(list) {
  const fileList = [...list];
  const pdfFile = fileList.find(f => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  const refsFile = fileList.find(f => /\.json$/i.test(f.name));
  let refs = null;
  if (refsFile) {
    try { refs = JSON.parse(await refsFile.text()); } catch { refs = null; }
    if (!isRefs(refs)) { setStatus(`${refsFile.name} is not an annotations file`); refs = null; }
  }
  try {
    if (pdfFile) await openPdf(pdfFile.name, new Uint8Array(await pdfFile.arrayBuffer()), refs);
    else if (refs && pdf) { mutate(() => { data = refs; }); setStatus("Loaded " + refsFile.name); }
  } catch (e) { setStatus("Could not open: " + e.message); }
}
const pickFile = () => $("picker").click();
$("picker").onchange = () => { openFiles($("picker").files); $("picker").value = ""; };
$("open").onclick = pickFile;
$("save").onclick = saveRefsFile;
addEventListener("dragover", e => e.preventDefault());
addEventListener("drop", e => { e.preventDefault(); openFiles(e.dataTransfer.files); });
$("export").onclick = exportPdf;
$("back").onclick = goBack;

addEventListener("keydown", e => {
  if (e.target.closest?.("#prompt")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "Escape") {
    hideMenu();
    if (drag) { drag.preview.remove(); drag = null; }
    else if (pending) { pending = null; drawAll(); setStatus("Definition cancelled"); }
  } else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
  else if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); pickFile(); }
  else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveRefsFile(); }
  else if (mod && e.key.toLowerCase() === "e") { e.preventDefault(); exportPdf(); }
  else if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); setScale(scale * 1.15); }
  else if (mod && e.key === "-") { e.preventDefault(); setScale(scale / 1.15); }
  else if (mod && e.key === "0") { e.preventDefault(); setScale(1.5); }
  else if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); goBack(); }
});
viewer.addEventListener("wheel", e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setScale(scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

(async () => {
  // ?pdf=<url>[&refs=<url>] opens a hosted paper; otherwise reopen the last PDF from this browser.
  const params = new URLSearchParams(location.search);
  try {
    const url = params.get("pdf");
    if (url) {
      setStatus("Loading…");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
      const refsUrl = params.get("refs");
      const refs = refsUrl ? await fetch(refsUrl).then(r => r.ok ? r.json() : null).catch(() => null) : null;
      await openPdf(decodeURIComponent(new URL(url, location.href).pathname.split("/").pop()),
        new Uint8Array(await res.arrayBuffer()), isRefs(refs) ? refs : null, { preferStored: true });
      return;
    }
    const last = await store.get("last").catch(() => null);
    if (last) await openPdf(last.name, last.bytes);
    else setStatus("Open a PDF (or drop one here) to start");
  } catch (e) { setStatus("Could not open: " + e.message); }
})();

/* global pdfjsLib, katex, PDFLib, PageText, Symbols, store, chooseSaveTarget */
// Annotation model (kept in IndexedDB per PDF, and embedded in exported PDFs). Coordinates are page points at
// scale 1 with the origin at the top left.
//   definitions: { id, term, color, text, highlight: [{ page, rects }], box: { page, rect } }
//   references:  { id, page, rects, text, term }   — linked to the nearest preceding definition of term

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";
const SVGNS = "http://www.w3.org/2000/svg";
const PALETTE = ["#f2b705", "#2a9df4", "#3cb371", "#e8559a", "#ff8c1a", "#8e5cd9", "#17b8b0", "#d64545", "#7a9a01", "#a0522d"];
const UNRESOLVED = "#8a8a8a";

const $ = id => document.getElementById(id);
const viewer = $("viewer"), pagesEl = $("pages");

let docName = null, docKey = null, pdfBytes = null, pdf = null;
let pages = [];        // 1-based: { n, page, vp1, el, canvas, overlay, hits, renderedScale, task, textData }
let data = emptyData();
let scale = 1.5;
let pending = null;    // definition in progress: { parts: [{ page, rects }], text }
const undoStack = [], backStack = [];

function emptyData() { return { version: 1, definitions: [], references: [] }; }

// ---------- terms ----------

const isLatex = t => /[\\^_{}$]/.test(t);
// English phrases match case-insensitively and ignore plurals; symbols and LaTeX match exactly
// (T is not t, \Sigma is not \sigma), ignoring spacing, braces around a single script, and how a
// star or prime is written.
function norm(t) {
  const s = t.normalize("NFKC").replace(/\$/g, "").trim();
  if (/^[A-Za-z][A-Za-z' -]{2,}$/.test(s)) {
    return s.toLowerCase().replace(/\s+/g, " ").replace(/(ss|x|ch|sh)es$/, "$1").replace(/ies$/, "y").replace(/([^s])s$/, "$1");
  }
  return s.replace(/\s+/g, (m, at) => /\\[A-Za-z]+$/.test(s.slice(0, at)) && /^[A-Za-z]/.test(s.slice(at + m.length)) ? " " : "")
    .replace(/\\ast(?![A-Za-z])/g, "*").replace(/\\prime(?![A-Za-z])/g, "'")
    .replace(/([_^])\{(\\[A-Za-z]+|[^{}\\\s])\}/g, "$1$2")
    .replace(/\^(\*|'+)/g, "$1");  // A^* is A*, f^' is f'
}
// Words only, at least one of three letters or more ("A b" is two symbols, not a phrase).
const isEnglishPhrase = t => t.length <= 80 && /^[A-Za-z][A-Za-z'’ -]*[A-Za-z]$/.test(t) && /[A-Za-z]{3}/.test(t);

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
    try { await store.set(docKey, data); setStatus("Saved in this browser"); }
    catch (e) { setStatus("Save failed: " + e.message); }
  }, 300);
}
function undo() {
  if (!undoStack.length) return;
  data = JSON.parse(undoStack.pop());
  changed();
  setStatus("Undone");
}

// ---------- loading & rendering ----------

// A PDF exported by this app carries its annotations; opening it strips the painted marks so editing
// continues on the clean pages. Embedded annotations win over this browser's copy, except for
// hosted papers (?pdf=), where the reader's own edits are kept.
async function openPdf(name, bytes, { preferStored = false } = {}) {
  pdf?.destroy();
  pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const embedded = await embeddedRefs(pdf);
  if (embedded) {
    bytes = await stripExport(bytes);
    name = name.replace(/ \(refs\)(\.pdf)$/i, "$1");
    pdf.destroy();
    pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  }
  pdfBytes = bytes;
  docName = name.replace(/\.pdf$/i, ""); docKey = "refs:" + pdf.fingerprints[0];
  const stored = await store.get(docKey).catch(() => null);
  data = (preferStored ? stored || embedded : embedded || stored) || emptyData();
  if (embedded && data === embedded) store.set(docKey, data).catch(() => {});
  store.set("last", { name, bytes: pdfBytes }).catch(() => {});
  undoStack.length = backStack.length = 0; pending = null; updateBack();
  $("file").textContent = name;
  document.title = name + " — Add Refs";
  $("export").disabled = false;
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
  search.hits.forEach((h, i) => {
    for (const r of h.rects) {
      pages[h.page]?.overlay.append(svg("rect", { ...rectAttrs(r), fill: i === search.index ? "#ff8a00" : "#ffe14d", "fill-opacity": i === search.index ? 0.55 : 0.45 }));
    }
  });
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
    const rect = sel.rects[0], inside = boxText(d.p, rect), english = isEnglishPhrase(inside);
    let seen = null;
    openPrompt({
      x: e.clientX, y: e.clientY, kind: "def", label: "This passage defines:",
      value: english ? inside : "",
      recognize: () => recognizeRegion(d.p, rect).then(r => (seen = r).readings),
      onDone: term => {
        d.preview.remove();
        if (!term) return;
        if (seen) Symbols.learn(seen.glyphs, term);
        mutate(() => {
          data.definitions.push({ id: crypto.randomUUID(), term, color: colorFor(term), text: pending.text,
            highlight: pending.parts, box: { page: d.p.n, rect } });
          pending = null;
        });
        setStatus(`Defined “${term}”`);
      },
    });
  } else {
    const at = [d.p.n, sel.rects[0][1]], english = isEnglishPhrase(sel.text), region = symbolRegion(d, sel);
    let seen = null;
    openPrompt({
      x: e.clientX, y: e.clientY, kind: "ref", at, label: "Refers to:",
      value: english ? sel.text : "",
      recognize: region ? () => recognizeRegion(d.p, region).then(r => (seen = r).readings) : null,
      onDone: term => {
        d.preview.remove();
        if (!term) return;
        if (seen) Symbols.learn(seen.glyphs, term);
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

// Text of the characters mostly inside a box.
function boxText(p, [x0, y0, x1, y1]) {
  const chars = (p.textData?.chars || []).filter(c => {
    const overlap = Math.min(c.x1, x1) - Math.max(c.x0, x0), cy = (c.top + c.bottom) / 2, slack = (c.bottom - c.top) * 0.2;
    return overlap >= 0.5 * (c.x1 - c.x0) && cy >= y0 - slack && cy <= y1 + slack;
  });
  return chars.map((c, i) => (i && c.item !== chars[i - 1].item && !/\s$/.test(chars[i - 1].c) ? " " : "") + c.c)
    .join("").replace(/-\s+/g, "").replace(/\s+/g, " ").trim();
}

// ---------- symbol recognition ----------

// Where to look for a symbol under an underline drag: the swept x-range on the selected line.
function symbolRegion(d, sel) {
  if (sel.rects.length !== 1) return null;
  let [, y0, , y1] = sel.rects[0];
  if (y1 - y0 < 6) { const cy = (y0 + y1) / 2; y0 = cy - 7; y1 = cy + 7; }
  const padX = (y1 - y0) * 0.3, padY = (y1 - y0) * 0.15;
  return [Math.min(d.start.x, d.end.x) - padX, y0 - padY, Math.max(d.start.x, d.end.x) + padX, y1 + padY];
}

// Renders part of a page at high resolution, with a margin so glyphs cut by the marked rectangle are
// seen whole, and recognizes what is inside: { readings, glyphs }.
async function recognizeRegion(p, [x0, y0, x1, y1]) {
  const s = Math.min(10, Math.max(3, 120 / Math.max(y1 - y0, 1))), m = (y1 - y0) * 0.6;
  const ex0 = Math.max(0, x0 - m), ey0 = Math.max(0, y0 - m), ex1 = Math.min(p.vp1.width, x1 + m), ey1 = Math.min(p.vp1.height, y1 + m);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil((ex1 - ex0) * s); canvas.height = Math.ceil((ey1 - ey0) * s);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await p.page.render({ canvasContext: ctx, viewport: p.page.getViewport({ scale: s, offsetX: -ex0 * s, offsetY: -ey0 * s }) }).promise;
  return Symbols.recognize(canvas, [(x0 - ex0) * s, (y0 - ey0) * s, (x1 - ex0) * s, (y1 - ey0) * s]);
}

// ---------- term prompt ----------

let promptState = null;
function openPrompt(opts) {
  const st = promptState = { ...opts, active: -1, items: [], recognized: [], recognizing: !!opts.recognize, edited: false };
  const box = $("prompt"), input = $("prompt-input");
  $("prompt-label").textContent = opts.label;
  input.value = opts.value || "";
  box.hidden = false;
  const w = box.offsetWidth;
  box.style.left = Math.min(opts.x + 8, innerWidth - w - 8) + "px";
  box.style.top = Math.min(opts.y + 12, innerHeight - 330) + "px";
  input.focus(); input.select();
  updatePrompt();
  // Fill in a reading of the symbol unless the user has started typing: an existing definition that a
  // reading names (or, for terms of two or more symbols, begins with: the drag may catch a comma),
  // else the best reading. It is selected, so typing replaces it.
  opts.recognize?.().then(cands => {
    if (promptState !== st) return;
    st.recognized = cands.slice(0, 4);
    st.recognizing = false;
    const known = data.definitions.map(d => ({ term: d.term, key: norm(d.term), long: (Symbols.atoms(d.term)?.length || 0) > 1 }))
      .sort((a, b) => b.key.length - a.key.length);
    const named = c => {
      const r = norm(c.latex);
      return known.find(k => r === k.key || k.long && r.startsWith(k.key) && !/^[A-Za-z]/.test(r.slice(k.key.length)))?.term;
    };
    const pick = cands.map(named).find(Boolean) || cands[0]?.latex;
    if (pick && !st.edited && !input.value) { input.value = pick; input.select(); }
    updatePrompt();
  }).catch(err => { console.warn("Symbol recognition failed:", err); if (promptState === st) { st.recognizing = false; updatePrompt(); } });
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
  // Suggestions: readings of the symbol from the image, then one per distinct defined term, filtered
  // by what has been typed.
  const terms = new Map();
  for (const d of data.definitions) if (!terms.has(norm(d.term))) terms.set(norm(d.term), d);
  const q = norm(value), lower = value.toLowerCase();
  const matches = t => !q || norm(t).includes(q) || t.toLowerCase().includes(lower);
  const recognized = st.recognized.filter(c => matches(c.latex)).map(c => {
    const d = terms.get(norm(c.latex));
    return { term: c.latex, color: d?.color, meta: d ? `from image · p. ${d.box.page}` : "from image" };
  });
  const defined = [...terms.values()].filter(d => matches(d.term) && !recognized.some(r => norm(r.term) === norm(d.term)))
    .sort((a, b) => (norm(a.term) === q ? -1 : 0) - (norm(b.term) === q ? -1 : 0) || norm(a.term).indexOf(q) - norm(b.term).indexOf(q))
    .map(d => ({ term: d.term, color: d.color, meta: "p. " + d.box.page }));
  st.items = [...recognized, ...defined].slice(0, 30);
  st.active = Math.min(st.active, st.items.length - 1);
  $("prompt-suggest").replaceChildren(...st.items.map((it, i) => {
    const li = document.createElement("li");
    li.className = i === st.active ? "active" : "";
    li.innerHTML = '<span class="sw"></span><span class="t"></span><span class="meta"></span>';
    if (it.color) li.querySelector(".sw").style.background = it.color;
    else li.querySelector(".sw").classList.add("none");
    renderTerm(li.querySelector(".t"), it.term);
    li.querySelector(".meta").textContent = it.meta;
    li.onmousedown = e => { e.preventDefault(); closePrompt(it.term); };
    return li;
  }));
  const chosen = st.active >= 0 ? st.items[st.active].term : value;
  const m = $("prompt-match");
  if (!chosen) {
    m.textContent = st.recognizing ? "Reading the symbol…" : st.kind === "ref" ? "Type a term or pick a definition" : "Type the symbol or phrase (LaTeX ok)";
    return;
  }
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

$("prompt-input").addEventListener("input", () => { promptState.active = -1; promptState.edited = true; updatePrompt(); });
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
// Exported PDFs get the marks painted into the page content, real link annotations, and the
// annotation data as an attached file. Everything added carries /AddRefs so a later open can remove it.

const ATTACHMENT = "add-refs.json";
const isRefs = r => Array.isArray(r?.definitions) && Array.isArray(r?.references);

async function exportPdf() {
  if (!pdf) return;
  const target = await chooseSaveTarget(docName + " (refs).pdf", "application/pdf", ".pdf");
  if (!target) return;
  setStatus("Exporting…");
  let bytes;
  try { bytes = await exportBytes(); }
  catch (e) { target.abort(); setStatus("Export failed: " + e.message); return; }
  try { await target.write(bytes); setStatus(target.done); }
  catch (e) { target.abort(); setStatus("Export failed: " + e.message); }
}

async function exportBytes() {
  const { PDFDocument, PDFName, PDFNull, PDFBool, rgb, BlendMode } = PDFLib;
  const MARK = PDFName.of("AddRefs");
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const docPages = doc.getPages();
  // Read before any drawing: pdf-lib's first draw on a page also wraps its content in q/Q streams.
  const before = docPages.map(page => new Set(rawContents(doc, page).map(String)));
  const toPdf = (n, [x0, y0, x1, y1]) => {
    const [a, b] = pages[n].vp1.convertToPdfPoint(x0, y0), [c, d] = pages[n].vp1.convertToPdfPoint(x1, y1);
    return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  };
  const color = hex => rgb(...[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255));
  for (const d of data.definitions) {
    for (const part of d.highlight) {
      for (const r of part.rects) {
        const [x0, y0, x1, y1] = toPdf(part.page, r);
        docPages[part.page - 1].drawRectangle({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, color: color(d.color), opacity: 0.32, blendMode: BlendMode.Multiply });
      }
    }
    const [x0, y0, x1, y1] = toPdf(d.box.page, d.box.rect);
    docPages[d.box.page - 1].drawRectangle({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, borderColor: color(d.color), borderWidth: 1.2 });
  }
  for (const ref of data.references) {
    const d = resolve(ref);
    if (!d) continue;
    const page = docPages[ref.page - 1];
    for (const r of ref.rects) {
      const [x0, , x1] = toPdf(ref.page, r), [, uy] = pages[ref.page].vp1.convertToPdfPoint(0, underlineY(r));
      page.drawLine({ start: { x: x0, y: uy }, end: { x: x1, y: uy }, thickness: 1.2, color: color(d.color) });
      const [, top] = pages[d.box.page].vp1.convertToPdfPoint(0, Math.max(d.box.rect[1] - 40, 0));
      const annot = doc.context.obj({
        Type: "Annot", Subtype: "Link", Rect: toPdf(ref.page, r), Border: [0, 0, 0],
        Dest: [docPages[d.box.page - 1].ref, PDFName.of("XYZ"), PDFNull, top, PDFNull], AddRefs: true,
      });
      page.node.addAnnot(doc.context.register(annot));
    }
  }
  // Tag the content streams drawing added (the marks plus pdf-lib's q/Q wrappers).
  docPages.forEach((page, i) => {
    for (const ref of rawContents(doc, page)) {
      if (!before[i].has(String(ref))) doc.context.lookup(ref).dict.set(MARK, PDFBool.True);
    }
  });
  await doc.attach(new TextEncoder().encode(JSON.stringify(data)), ATTACHMENT, {
    mimeType: "application/json", description: "Add Refs annotations (open this PDF in Add Refs to edit them)",
  });
  return doc.save();
}

function rawContents(doc, page) {
  const ref = page.node.get(PDFLib.PDFName.of("Contents"));
  const obj = doc.context.lookup(ref);
  return obj instanceof PDFLib.PDFArray ? obj.asArray() : ref ? [ref] : [];
}

async function embeddedRefs(doc) {
  const att = Object.values(await doc.getAttachments() || {}).find(a => a.filename === ATTACHMENT);
  if (!att) return null;
  try {
    const refs = JSON.parse(new TextDecoder().decode(att.content));
    return isRefs(refs) ? refs : null;
  } catch { return null; }
}

// Undo an export: delete tagged content streams and links, pdf-lib's opacity states, and the attachment.
// Pages are edited through their raw entries; pdf-lib's normalizing accessors would add new q/Q streams.
async function stripExport(bytes) {
  const { PDFDocument, PDFName, PDFArray, PDFDict, PDFRef } = PDFLib;
  const MARK = PDFName.of("AddRefs");
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  // pdf-lib writes every object it holds, so unlinked objects are deleted at the end (the q/Q
  // streams are shared between pages).
  const dead = new Set();
  const del = ref => { if (ref instanceof PDFRef) dead.add(ref); };
  const tagged = ref => {
    const obj = doc.context.lookup(ref);
    return !!(obj?.dict ?? obj)?.get?.(MARK);
  };
  const prune = (arr, drop) => {
    for (let i = arr.size() - 1; i >= 0; i--) if (drop(arr.get(i))) { del(arr.get(i)); arr.remove(i); }
  };
  for (const page of doc.getPages()) {
    const contents = doc.context.lookup(page.node.get(PDFName.of("Contents")));
    if (contents instanceof PDFArray) prune(contents, tagged);
    const annots = page.node.Annots();
    if (annots) prune(annots, tagged);
    const gs = page.node.Resources()?.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
    for (const [key, val] of gs?.entries() || []) {
      const d = doc.context.lookup(val);
      if (/^GS-\d+$/.test(key.decodeText()) && d?.has?.(PDFName.of("BM"))) { del(val); gs.delete(key); }
    }
  }
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict)
    ?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict)?.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (names) {
    for (let i = names.size() - 2; i >= 0; i -= 2) {
      if (names.lookup(i).decodeText?.() !== ATTACHMENT) continue;
      const spec = names.get(i + 1);
      const af = doc.catalog.lookupMaybe(PDFName.of("AF"), PDFArray);
      const at = af ? af.asArray().indexOf(spec) : -1;
      if (at >= 0) af.remove(at);
      del(doc.context.lookup(spec, PDFDict).lookup(PDFName.of("EF"), PDFDict).get(PDFName.of("F")));
      del(spec);
      names.remove(i + 1); names.remove(i);
    }
  }
  for (const ref of dead) doc.context.delete(ref);
  return doc.save();
}

// ---------- search ----------

let search = { query: "", hits: [], index: -1 };  // hits: [{ page, rects }] in reading order

function firstVisiblePage() {
  return pages.slice(1).find(p => p.el.offsetTop + p.el.offsetHeight > viewer.scrollTop)?.n || 1;
}

async function runSearch(query) {
  search = { query, hits: [], index: -1 };
  if (query.trim()) {
    $("search-count").textContent = "…";
    for (const p of pages.slice(1)) {
      const t = await loadText(p);
      if (search.query !== query) return;  // a newer search started
      for (const rects of t.find(query)) search.hits.push({ page: p.n, rects });
    }
    const from = firstVisiblePage();
    search.index = search.hits.length ? Math.max(0, search.hits.findIndex(h => h.page >= from)) : -1;
  }
  drawAll();
  showHit();
}

function showHit() {
  const { hits, index, query } = search;
  $("search-count").textContent = !query.trim() ? "" : hits.length ? `${index + 1} / ${hits.length}` : "No matches";
  const h = hits[index];
  if (h) viewer.scrollTop = pages[h.page].el.offsetTop + h.rects[0][1] * scale - viewer.clientHeight / 3;
}

function stepHit(dir) {
  if (!search.hits.length) return;
  search.index = (search.index + dir + search.hits.length) % search.hits.length;
  drawAll();
  showHit();
}

function openSearch() {
  if (!pdf) return;
  $("search").hidden = false;
  $("search-input").focus();
  $("search-input").select();
}
function closeSearch() {
  $("search").hidden = true;
  search = { query: "", hits: [], index: -1 };
  drawAll();
}

let searchTimer = null;
$("search-input").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch($("search-input").value), 200);
});
$("search-input").addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (search.query !== $("search-input").value) { clearTimeout(searchTimer); runSearch($("search-input").value); }
    else stepHit(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSearch(); }
});
$("search-next").onclick = () => stepHit(1);
$("search-prev").onclick = () => stepHit(-1);
$("search-close").onclick = closeSearch;

// ---------- toolbar & keys ----------

function setStatus(msg, mode = false) { $("status").textContent = msg; $("status").classList.toggle("mode", mode); }

async function openFiles(list) {
  const pdfFile = [...list].find(f => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  if (!pdfFile) { setStatus("Not a PDF"); return; }
  try { await openPdf(pdfFile.name, new Uint8Array(await pdfFile.arrayBuffer())); }
  catch (e) { setStatus("Could not open: " + e.message); }
}
const pickFile = () => $("picker").click();
$("picker").onchange = () => { openFiles($("picker").files); $("picker").value = ""; };
$("open").onclick = pickFile;
addEventListener("dragover", e => e.preventDefault());
addEventListener("drop", e => { e.preventDefault(); openFiles(e.dataTransfer.files); });
$("export").onclick = exportPdf;
$("back").onclick = goBack;

addEventListener("keydown", e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "f" && !e.target.closest?.("#prompt")) { e.preventDefault(); openSearch(); return; }
  if (e.target.closest?.("#prompt, #search")) return;
  if (e.key === "Escape") {
    hideMenu();
    if (drag) { drag.preview.remove(); drag = null; }
    else if (pending) { pending = null; drawAll(); setStatus("Definition cancelled"); }
  } else if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
  else if (mod && e.key.toLowerCase() === "o") { e.preventDefault(); pickFile(); }
  else if (mod && "se".includes(e.key.toLowerCase())) { e.preventDefault(); exportPdf(); }
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
  // ?pdf=<url> opens a hosted paper; otherwise reopen the last PDF from this browser.
  const params = new URLSearchParams(location.search);
  try {
    const url = params.get("pdf");
    if (url) {
      setStatus("Loading…");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
      await openPdf(decodeURIComponent(new URL(url, location.href).pathname.split("/").pop()),
        new Uint8Array(await res.arrayBuffer()), { preferStored: true });
      return;
    }
    const last = await store.get("last").catch(() => null);
    if (last) await openPdf(last.name, last.bytes);
    else setStatus("Open a PDF (or drop one here) to start");
  } catch (e) { setStatus("Could not open: " + e.message); }
})();

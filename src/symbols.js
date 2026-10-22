// Recognizes simple math notation in an image: symbols with sub- and superscripts, each glyph matched
// against glyphs drawn from KaTeX's fonts and glyphs learned from the user's corrections. Enough to
// suggest \Sigma_{\Lambda} or \tau for a symbol in a scanned paper; not a general formula OCR.

/* global store */
/* exported Symbols */
const Symbols = (() => {
  const N = 32;  // glyphs are compared as skeletons on an N×N grid

  const GREEK_LOWER = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η",
    theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
    varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ",
    varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  };
  const GREEK_UPPER = { Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω" };
  const OPERATORS = {
    partial: "∂", nabla: "∇", infty: "∞", in: "∈", ni: "∋", subset: "⊂", supset: "⊃", subseteq: "⊆",
    supseteq: "⊇", cup: "∪", cap: "∩", times: "×", otimes: "⊗", oplus: "⊕", to: "→", leftarrow: "←",
    leftrightarrow: "↔", Rightarrow: "⇒", simeq: "≃", cong: "≅", equiv: "≡", approx: "≈", sim: "∼",
    leq: "≤", geq: "≥", pm: "±", circ: "∘", emptyset: "∅", setminus: "∖", ast: "∗", wedge: "∧", vee: "∨",
  };
  const BIG = { sum: "∑", prod: "∏", int: "∫", coprod: "∐" };
  const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", LOWER = "abcdefghijklmnopqrstuvwxyz";

  // { latex, font, ch, prior }: prior is subtracted from the score, favouring common alphabets.
  // Built templates also get `base` (baseline position as a fraction of the glyph's height, from its
  // top) and `size` (glyph height as a fraction of the font size), to place glyphs on a baseline.
  function templateSpecs() {
    const t = [];
    const add = (latex, font, ch, prior = 0) => t.push({ latex, font, ch, prior });
    for (const [k, ch] of Object.entries(GREEK_LOWER)) add("\\" + k, "italic 96px KaTeX_Math", ch);
    for (const [k, ch] of Object.entries(GREEK_UPPER)) { add("\\" + k, "96px KaTeX_Main", ch); add("\\" + k, "italic 96px KaTeX_Math", ch); }
    for (const [k, ch] of Object.entries(OPERATORS)) add("\\" + k, "96px KaTeX_Main", ch, 0.02);
    for (const [k, ch] of Object.entries(BIG)) add("\\" + k, "96px KaTeX_Size1", ch, 0.03);
    for (const ch of "0123456789+=<>()[]|/") add(ch, "96px KaTeX_Main", ch, 0.02);
    add("'", "96px KaTeX_Main", "′", 0.02);
    add(",", "96px KaTeX_Main", ",", 0.02);
    add("*", "96px KaTeX_Main", "*", 0.02);
    add(".", "96px KaTeX_Main", ".", 0.02);
    for (const ch of UPPER + LOWER) {
      add(ch, "italic 96px KaTeX_Math", ch);
      add(ch, "96px KaTeX_Main", ch);
      add(`\\mathfrak{${ch}}`, "96px KaTeX_Fraktur", ch, UPPER.includes(ch) ? 0.04 : 0.1);
    }
    for (const ch of UPPER) {
      add(`\\mathcal{${ch}}`, "96px KaTeX_Caligraphic", ch, 0.05);
      add(`\\mathscr{${ch}}`, "96px KaTeX_Script", ch, 0.06);
      add(`\\mathbb{${ch}}`, "96px KaTeX_AMS", ch, 0.05);
    }
    return t;
  }

  let templates = null;
  async function ready() {
    if (templates) return templates;
    const specs = templateSpecs();
    const fonts = [...new Set(specs.map(s => s.font))];
    await Promise.all(fonts.map(f => document.fonts.load(f, specs.filter(s => s.font === f).map(s => s.ch).join("")).catch(() => {})));
    const c = document.createElement("canvas");
    c.width = c.height = 200;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    templates = [];
    for (const s of specs) {
      ctx.clearRect(0, 0, 200, 200);
      ctx.font = s.font;
      ctx.fillText(s.ch, 50, 140);
      const a = ctx.getImageData(0, 0, 200, 200).data;
      const ink = new Uint8Array(200 * 200);
      for (let i = 0; i < ink.length; i++) ink[i] = a[i * 4 + 3] > 110 ? 1 : 0;
      const mask = cropMask(ink, 200, 200);
      if (!mask) continue;
      let top = 0;
      while (!ink.subarray(top * 200, top * 200 + 200).some(Boolean)) top++;
      templates.push({ ...s, ...features(mask), base: (140 - top) / mask.h, size: mask.h / 96 });
    }
    const learned = await store.get(LEARNED).catch(() => null);
    if (Array.isArray(learned)) templates.push(...learned);
    return templates;
  }

  // ---- learning from corrections ----
  // Glyphs the user labelled (by typing the term for a region that was misread) become templates,
  // kept in this browser and preferred over the font glyphs.

  const LEARNED = "learned-glyphs", MAX_LEARNED = 400;

  // "\Sigma_{\Lambda}'" -> [{ kind: "base", latex: "\Sigma" }, { kind: "sub", latex: "\Lambda" }, { kind: "sup", latex: "'" }]
  function atoms(latex) {
    const out = [], re = /\\math[a-z]+\{[A-Za-z]\}|\\[A-Za-z]+|[^\s{}_^]/g;
    let i = 0;
    const take = (str, kind) => { for (const m of str.matchAll(re)) out.push({ kind, latex: m[0] === "\\ast" ? "*" : m[0] }); };
    while (i < latex.length) {
      const ch = latex[i];
      if (ch === "_" || ch === "^") {
        const kind = ch === "_" ? "sub" : "sup";
        if (latex[i + 1] === "{") {
          const end = latex.indexOf("}", i + 2);
          if (end < 0) return null;
          take(latex.slice(i + 2, end), kind); i = end + 1;
        } else {
          const m = latex.slice(i + 1).match(/^\s*(\\[A-Za-z]+|\S)/);
          if (!m) return null;
          take(m[1], kind); i += 1 + m[0].length;
        }
      } else if (ch === "'" || ch === "*" && out.length) { out.push({ kind: "sup", latex: ch }); i++; }
      else if (/\s|[{}]/.test(ch)) i++;
      else {
        const m = latex.slice(i).match(/^(\\math[a-z]+\{[A-Za-z]\}|\\[A-Za-z]+|.)/);
        out.push({ kind: "base", latex: m[0] === "\\ast" ? "*" : m[0] }); i += m[0].length;
      }
    }
    return out;
  }

  // `glyphs` from recognize(); `latex` what the user settled on. Learns each glyph whose best match
  // was wrong, when the glyphs and the typed symbols correspond one to one.
  async function learn(glyphs, latex) {
    const parts = atoms(latex);
    if (!glyphs?.length || !parts || parts.length !== glyphs.length) return 0;
    await ready();
    const fresh = [];
    glyphs.forEach((g, i) => {
      const want = parts[i].latex;
      if (g.top === want) return;
      const font = templates.find(t => t.latex === want && !t.learned) || g.t;  // for baseline and size
      fresh.push({ latex: want, pts: g.f.pts, dt: g.f.dt, aspect: g.f.aspect, base: font.base, size: font.size, prior: -0.03, learned: true });
    });
    if (!fresh.length) return 0;
    templates.push(...fresh);
    const learned = templates.filter(t => t.learned).slice(-MAX_LEARNED);
    templates = templates.filter(t => !t.learned).concat(learned);
    await store.set(LEARNED, learned).catch(() => {});
    return fresh.length;
  }

  function cropMask(ink, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (ink[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1, m = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) m[y * cw + x] = ink[(y + y0) * w + x + x0];
    return { m, w: cw, h: ch };
  }

  // The glyph's skeleton (so bold and light type compare alike) stretched onto an N×N grid (so faces
  // of different widths line up; aspect is scored separately): its cells, and each cell's distance
  // to the nearest skeleton cell. Very thin glyphs (| - 1) keep their aspect instead of being
  // stretched into a block.
  function features(mask) {
    if (!mask) return null;
    const { w, h } = mask, m = thin(mask);
    const sx = w * 3 < h ? h : w, sy = h * 3 < w ? w : h, ox = (sx - w) / 2, oy = (sy - h) / 2;
    const on = new Uint8Array(N * N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (m[y * w + x]) on[Math.min(N - 1, ((y + oy) / sy * N) | 0) * N + Math.min(N - 1, ((x + ox) / sx * N) | 0)] = 1;
    }
    const pts = [];
    on.forEach((v, i) => v && pts.push(i));
    return pts.length ? { pts, dt: distances(on), aspect: h / w } : null;
  }

  // Chamfer (3-4) distance transform, in cells.
  function distances(on) {
    const d = new Float32Array(N * N).map((_, i) => on[i] ? 0 : 1e6);
    const relax = (i, j, c) => { if (d[j] + c < d[i]) d[i] = d[j] + c; };
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (x > 0) relax(i, i - 1, 3);
      if (y > 0) { relax(i, i - N, 3); if (x > 0) relax(i, i - N - 1, 4); if (x < N - 1) relax(i, i - N + 1, 4); }
    }
    for (let y = N - 1; y >= 0; y--) for (let x = N - 1; x >= 0; x--) {
      const i = y * N + x;
      if (x < N - 1) relax(i, i + 1, 3);
      if (y < N - 1) { relax(i, i + N, 3); if (x < N - 1) relax(i, i + N + 1, 4); if (x > 0) relax(i, i + N - 1, 4); }
    }
    return d.map(v => v / 3);
  }

  // 1 for identical skeletons, falling as the mean distance between them (both ways) grows.
  function similarity(a, b) {
    let ab = 0, ba = 0;
    for (const p of a.pts) ab += b.dt[p];
    for (const p of b.pts) ba += a.dt[p];
    return 1 - (ab / a.pts.length + ba / b.pts.length) / 2 / (N / 8);
  }

  // Zhang–Suen thinning to a one-pixel skeleton.
  function thin({ m, w, h }) {
    const W = w + 2, H = h + 2, a = new Uint8Array(W * H);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[(y + 1) * W + x + 1] = m[y * w + x];
    const del = [];
    for (let changed = true; changed;) {
      changed = false;
      for (let pass = 0; pass < 2; pass++) {
        del.length = 0;
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
          const i = y * W + x;
          if (!a[i]) continue;
          const p = [a[i - W], a[i - W + 1], a[i + 1], a[i + W + 1], a[i + W], a[i + W - 1], a[i - 1], a[i - W - 1]];
          const b = p.reduce((s, v) => s + v, 0);
          if (b < 2 || b > 6) continue;
          let t = 0;
          for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) t++;
          if (t !== 1) continue;
          if (pass === 0 ? p[0] * p[2] * p[4] || p[2] * p[4] * p[6] : p[0] * p[2] * p[6] || p[0] * p[4] * p[6]) continue;
          del.push(i);
        }
        for (const i of del) a[i] = 0;
        if (del.length) changed = true;
      }
    }
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = a[(y + 1) * W + x + 1];
    return out;
  }

  // Best distinct LaTeX strings for one glyph, with scores.
  function classify(f, k = 5) {
    const scored = templates.map(t => ({
      latex: t.latex, s: similarity(f, t) - 0.25 * Math.abs(Math.log(f.aspect / t.aspect)) - t.prior, t,
    })).sort((a, b) => b.s - a.s);
    const out = [];
    for (const c of scored) if (!out.some(o => o.latex === c.latex) && out.push(c) >= k) break;
    return out;
  }

  // Connected components of dark pixels (8-connected), with the threshold from Otsu's method.
  function components(canvas) {
    const { width: w, height: h } = canvas;
    const px = canvas.getContext("2d").getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h), hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) { gray[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000; hist[gray[i]]++; }
    let sum = 0, sumB = 0, wB = 0, best = 0, thr = 128;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    for (let i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB || wB === gray.length) continue;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / (gray.length - wB), between = wB * (gray.length - wB) * (mB - mF) ** 2;
      if (between > best) { best = between; thr = i; }
    }
    thr = Math.min(thr, 200);
    const label = new Int32Array(w * h).fill(-1), comps = [];
    for (let start = 0; start < gray.length; start++) {
      if (gray[start] > thr || label[start] >= 0) continue;
      const c = { pix: [], x0: w, y0: h, x1: 0, y1: 0 }, stack = [start];
      label[start] = comps.length;
      while (stack.length) {
        const i = stack.pop(), x = i % w, y = (i / w) | 0;
        c.pix.push(i);
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, j = ny * w + nx;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && label[j] < 0 && gray[j] <= thr) { label[j] = comps.length; stack.push(j); }
        }
      }
      comps.push(c);
    }
    return { comps, w };
  }

  const height = c => c.y1 - c.y0 + 1, width = c => c.x1 - c.x0 + 1;
  function merge(a, b) {
    return { pix: a.pix.concat(b.pix), x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
  }

  function glyphFeatures(c, w) {
    const cw = width(c), ch = height(c), m = new Uint8Array(cw * ch);
    for (const i of c.pix) m[(((i / w) | 0) - c.y0) * cw + (i % w) - c.x0] = 1;
    return features({ m, w: cw, h: ch });
  }

  // Letters are read one by one, so a word can come out as "grOup"; words keep only lowercase,
  // Capitalized or ALL-CAPS forms, other mixes becoming lowercase.
  const caseFold = latex => /^[A-Za-z]{2,}$/.test(latex) && !/^([a-z]+|[A-Z][a-z]+|[A-Z]+)$/.test(latex) ? latex.toLowerCase() : latex;

  function join(a, b) { return /\\[A-Za-z]+$/.test(a) && /^[A-Za-z]/.test(b) ? a + " " + b : a + b; }

  // `inner` is the region the user marked, in canvas pixels; the canvas may extend past it so glyphs
  // cut by the edge are seen whole. Returns readings [{ latex, score }], best first, and the glyphs
  // found (for learn()).
  async function recognize(canvas, inner) {
    await ready();
    const none = { readings: [], glyphs: [] };
    const { comps: all, w } = components(canvas);
    const [ix0, iy0, ix1, iy1] = inner, unit = iy1 - iy0;  // the marked height sets the scale
    let comps = all.filter(c => {
      const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
      return cx >= ix0 && cx <= ix1 && cy >= iy0 && cy <= iy1;
    });
    if (!comps.length) return none;
    comps = comps.filter(c => Math.max(width(c), height(c)) >= 0.06 * unit);
    if (!comps.length) return none;
    // Parts of one glyph: stacked ones (=, ≡, i, j, ≤ …) overlap horizontally, and enclosed ones (the
    // bar of Θ) lie inside another's box.
    comps.sort((a, b) => a.x0 - b.x0);
    for (let i = 0; i < comps.length; i++) {
      for (let j = i + 1; j < comps.length; j++) {
        const a = comps[i], b = comps[j], overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        // vertical gap between them; negative when they overlap vertically (a subscript tucked under
        // its base does, the parts of = or i don't)
        const gap = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
        const inside = (p, q) => p.x0 >= q.x0 - 1 && p.x1 <= q.x1 + 1 && p.y0 >= q.y0 - 1 && p.y1 <= q.y1 + 1;
        const flat = height(a) * 2 < width(a) && height(b) * 2 < width(b);  // bars of = and ≡
        const stacked = overlap >= 0.6 * Math.min(width(a), width(b)) && gap > -0.1 * Math.min(height(a), height(b))
          && gap < (flat ? Math.max(0.3 * unit, 0.8 * Math.min(width(a), width(b))) : 0.3 * unit);
        if (stacked || inside(a, b) || inside(b, a)) {
          comps[i] = merge(a, b); comps.splice(j, 1); j = i;
        }
      }
    }
    if (comps.length > 8) return none;  // a phrase, not a symbol

    // Each glyph's best match tells where its baseline is and how large its font is; relative to the
    // preceding full-size glyph, smaller ones on a lower baseline are subscripts and smaller ones
    // raised well above it superscripts. Commas and periods after the first glyph are dropped.
    const tokens = [];
    let base = null;
    for (const c of comps) {
      const f = glyphFeatures(c, w);
      if (!f) continue;
      const cands = classify(f), t = cands[0].t, h = height(c);
      const g = { size: h / t.size, line: c.y0 + t.base * h };
      let kind = "base";
      if (base) {
        if (cands[0].latex === "," || cands[0].latex === ".") continue;
        const smaller = g.size < 0.85 * base.size, drop = (g.line - base.line) / base.size;
        if (smaller && drop > 0.08 || drop > 0.2) kind = "sub";
        else if (smaller && drop < -0.2 || drop < -0.4) kind = "sup";
      }
      if (kind === "base") base = g;
      // Scripts are more often digits than look-alike letters (K_0, not K_o).
      if (kind !== "base") for (const x of cands) if (/^\d$/.test(x.latex)) x.s += 0.04;
      cands.sort((a, b) => b.s - a.s);
      tokens.push({ kind, cands: cands.slice(0, 3), f });
    }
    if (!tokens.length) return none;

    const assemble = pick => {
      let out = "";
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.kind === "base") { out = join(out, t.cands[pick[i]].latex); continue; }
        let run = "";
        for (; i < tokens.length && tokens[i].kind === t.kind; i++) run = join(run, tokens[i].cands[pick[i]].latex);
        i--;
        if (t.kind === "sup" && /^'+$/.test(run)) out += run;  // f'
        else if (t.kind === "sup" && run === "\\ast") out += "^*";
        else out += (t.kind === "sub" ? "_{" : "^{") + run + "}";
      }
      return out;
    };
    const score = pick => tokens.reduce((s, t, i) => s + t.cands[pick[i]].s, 0) / tokens.length;
    // Best reading, plus variants swapping in runner-ups for the least certain glyphs.
    const first = tokens.map(() => 0), picks = [first];
    const order = tokens.map((t, i) => i).filter(i => tokens[i].cands.length > 1)
      .sort((a, b) => (tokens[a].cands[0].s - tokens[a].cands[1].s) - (tokens[b].cands[0].s - tokens[b].cands[1].s));
    for (const i of order.slice(0, 4)) {
      for (let k = 1; k < tokens[i].cands.length; k++) { const p = first.slice(); p[i] = k; picks.push(p); }
    }
    const seen = new Set();
    const readings = picks.map(p => ({ latex: caseFold(assemble(p)), score: score(p) }))
      .sort((a, b) => b.score - a.score)
      .filter(c => !seen.has(c.latex) && seen.add(c.latex));
    return { readings, glyphs: tokens.map(t => ({ f: t.f, top: t.cands[0].latex, t: t.cands[0].t })) };
  }

  // LaTeX command -> Unicode character, for the symbols above ("\\Lambda" -> "Λ").
  const unicode = Object.fromEntries([GREEK_LOWER, GREEK_UPPER, OPERATORS, BIG].flatMap(m => Object.entries(m).map(([k, ch]) => ["\\" + k, ch])));

  // For unit tests, which have no fonts to render: make a template from a bitmap ({ m, w, h }, 1 =
  // ink; `base` and `size` as described at templateSpecs), use a given set of templates, and reach
  // the matching steps.
  const forTests = {
    template: (latex, mask, { base = 1, size = 0.7, prior = 0 } = {}) => ({ latex, ...features(cropMask(mask.m, mask.w, mask.h)), base, size, prior }),
    setTemplates: list => { templates = list; },
    templates: () => templates,
    features: mask => features(cropMask(mask.m, mask.w, mask.h)),
    thin, similarity, classify,
  };

  return { recognize, learn, ready, atoms, unicode, forTests };
})();

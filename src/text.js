// Character geometry for a PDF page, in page coordinates at scale 1 (points, origin top-left).
// pdf.js gives text items with a width but no per-character positions; estimating them from serif
// font metrics is close enough for picking a phrase or a symbol by dragging across it.

const measure = document.createElement("canvas").getContext("2d");
measure.font = "100px serif";

/* exported PageText, PageInk */
class PageText {
  static async load(page) {
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const chars = [];
    content.items.forEach((item, k) => {
      if (!item.str || !item.str.trim() && !item.hasEOL) return;
      const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
      const size = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]);
      if (!size) return;
      const x = tx[4], base = tx[5], w = item.width * vp.scale;
      // Spread the item's width over its characters in proportion to their widths in a serif font.
      const widths = [...item.str].map(c => measure.measureText(c).width || 1);
      const total = widths.reduce((a, b) => a + b, 0);
      let at = x;
      [...item.str].forEach((c, i) => {
        const cw = w * widths[i] / total;
        chars.push({
          c, item: k, x0: at, x1: at + cw,
          top: base - size * 0.85, bottom: base + size * 0.22, base, size, eol: item.hasEOL && i === widths.length - 1,
        });
        at += cw;
      });
    });
    return new PageText(chars);
  }

  constructor(chars) { this.chars = chars; }

  // Index of the character nearest to (x, y): on the line containing y if any, then the nearest x.
  nearest(x, y) {
    let best = -1, bestScore = Infinity;
    this.chars.forEach((ch, i) => {
      if (!ch.c.trim()) return;
      const dy = y < ch.top ? ch.top - y : y > ch.bottom ? y - ch.bottom : 0;
      const dx = x < ch.x0 ? ch.x0 - x : x > ch.x1 ? x - ch.x1 : 0;
      const score = dy * 100 + dx;  // the line under the point wins, even far past its end
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return { index: best, dist: bestScore };
  }

  // Characters between two points in content order (inclusive), as line rects and plain text.
  select(a, b) {
    const s = this.nearest(a.x, a.y), e = this.nearest(b.x, b.y);
    if (s.index < 0 || s.dist > 500 && e.dist > 500) return null;  // both points well off any line
    const forward = s.index <= e.index;
    let i0 = forward ? s.index : e.index, i1 = forward ? e.index : s.index;
    // whole words at both ends, like the ink-snapped marks
    const word = (i, j) => {
      const a = this.chars[i], b = this.chars[j];
      return b && /[\p{L}\p{N}]/u.test(a.c) && /[\p{L}\p{N}]/u.test(b.c) && Math.abs(a.base - b.base) < a.size * 0.6
        && Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1) < a.size * 0.15;  // no word space between (OCR text has no space characters)
    };
    while (word(i0, i0 - 1)) i0--;
    while (word(i1, i1 + 1)) i1++;
    const run = this.chars.slice(i0, i1 + 1);
    // from/to: the drag points at the start and end of the selection in reading order
    return { rects: lineRects(run), text: runText(run), from: forward ? a : b, to: forward ? b : a };
  }

  // Moves each text line's characters onto the ink of that printed line, correcting text layers that
  // drift from the page image. Word by word where the line's ink splits into as many words as the
  // text (its widest gaps taken as the spaces), else the whole line stretched linearly; lines whose
  // ink doesn't plausibly match are left alone.
  align(ink) {
    if (this.aligned) return;
    this.aligned = true;
    const lines = [];
    let cur = null, space = false;
    for (const ch of this.chars) {
      if (!ch.c.trim()) { space = true; continue; }
      if (!cur || Math.abs(ch.base - cur.base) > ch.size * 0.6 || ch.x0 < cur.x1 - ch.size) {
        lines.push(cur = { base: ch.base, chars: [], words: [], x0: ch.x0, x1: ch.x1, top: ch.top, bottom: ch.bottom });
        space = true;
      }
      const prev = cur.chars.at(-1);
      if (space || ch.x0 - prev.x1 > ch.size * 0.15) cur.words.push([]);  // OCR text has gaps, not spaces
      cur.words.at(-1).push(ch);
      cur.chars.push(ch);
      space = false;
      cur.x1 = Math.max(cur.x1, ch.x1); cur.x0 = Math.min(cur.x0, ch.x0);
      cur.top = Math.min(cur.top, ch.top); cur.bottom = Math.max(cur.bottom, ch.bottom);
    }
    const S = ink.scale, X = v => Math.max(0, Math.min(ink.w - 1, Math.round(v * S)));
    const stretch = (chars, t0, t1, i0, i1) => {
      const k = (i1 - i0) / (t1 - t0 || 1);
      for (const ch of chars) { ch.x0 = i0 + (ch.x0 - t0) * k; ch.x1 = i0 + (ch.x1 - t0) * k; }
    };
    for (const ln of lines) {
      const { col, lineGap } = ink.profile([ln.x0, ln.top, ln.x1, ln.bottom]);
      const a = PageInk.seek(col, X(ln.x0), 1, lineGap * 2), b = PageInk.seek(col, X(ln.x1), -1, lineGap * 2);
      if (a < 0 || b < 0 || b <= a) continue;
      const ia = PageInk.extent(col, a, -1, lineGap), ib = PageInk.extent(col, b, 1, lineGap);
      const x0 = ia / S, x1 = (ib + 1) / S, k = (x1 - x0) / (ln.x1 - ln.x0);
      if (k < 0.8 || k > 1.25 || Math.abs(x0 - ln.x0) > 30) continue;
      const inkWords = PageInk.words(col, ia, ib, ln.words.length);
      const plausible = inkWords && ln.words.every((w, i) => {
        const tw = w.at(-1).x1 - w[0].x0, iw = (inkWords[i][1] + 1 - inkWords[i][0]) / S;
        return iw > tw * 0.5 && iw < tw * 2 + 2;
      });
      if (plausible) ln.words.forEach((w, i) => stretch(w, w[0].x0, w.at(-1).x1, inkWords[i][0] / S, (inkWords[i][1] + 1) / S));
      else stretch(ln.chars, ln.x0, ln.x1, x0, x1);
    }
    // spaces sit between the characters around them
    this.chars.forEach((ch, i) => {
      if (ch.c.trim()) return;
      const p = this.chars[i - 1], n = this.chars[i + 1];
      if (p && n && p.c.trim() && n.c.trim() && Math.abs(p.base - n.base) < p.size * 0.6) { ch.x0 = p.x1; ch.x1 = Math.max(p.x1, n.x0); }
    });
  }

  // Text of the words inside the rects (a definition's highlight), in reading order; separate stretches
  // are joined with a space. A word counts when at least half its letters are inside, since the
  // highlight snaps to printed words and the text layer can sit a letter off them.
  textIn(rects) {
    const inside = ch => rects.some(([x0, y0, x1, y1]) => {
      const cx = (ch.x0 + ch.x1) / 2, cy = (ch.top + ch.bottom) / 2;
      return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
    });
    const keep = new Set();
    let word = [];
    const close = () => { if (word.length && word.filter(i => inside(this.chars[i])).length * 2 >= word.length) word.forEach(i => keep.add(i)); word = []; };
    this.chars.forEach((ch, i) => {
      const prev = this.chars[i - 1];
      if (!ch.c.trim()) { close(); return; }
      if (prev && prev.c.trim() && (Math.abs(ch.base - prev.base) > ch.size * 0.6 || ch.x0 - prev.x1 > ch.size * 0.15)) close();
      word.push(i);
    });
    close();
    const runs = [];
    this.chars.forEach((ch, i) => {
      const kept = keep.has(i) || !ch.c.trim() && keep.has(i - 1) && keep.has(i + 1);  // spaces between kept words
      if (!kept) return;
      if (runs.at(-1)?.last === i - 1) runs.at(-1).chars.push(ch); else runs.push({ chars: [ch] });
      runs.at(-1).last = i;
    });
    return runs.map(r => runText(r.chars)).filter(Boolean).join(" ");
  }

  // Line rects of each case-insensitive match of `query`. Hyphens are ignored on both sides, so
  // words broken across lines ("homo- topy") and hyphenated words both match.
  // With `exact`, case matters (for symbols: Λ is not λ).
  find(query, exact = false) {
    const q = (exact ? query.normalize("NFKC") : fold(query)).replace(/-/g, "").replace(/\s+/g, " ").trim();
    if (!q) return [];
    const { text, map } = this.searchIndex(exact);
    const hits = [];
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) {
      const run = [...new Set(map.slice(i, i + q.length).filter(k => k >= 0))].map(k => this.chars[k]);
      if (run.length) hits.push(lineRects(run));
    }
    return hits;
  }

  // The page as one folded string with single spaces between words (none after a line-end hyphen);
  // map[k] is the index of the character behind text[k], -1 for spaces.
  searchIndex(exact = false) {
    this.index ||= {};
    if (this.index[exact]) return this.index[exact];
    let text = "", prev = null, gap = false, hyphen = false;
    const map = [];
    this.chars.forEach((ch, i) => {
      if (/\s/.test(ch.c)) { gap = true; return; }
      if (prev) {
        const newLine = Math.abs(ch.base - prev.base) > prev.size * 0.6;
        const apart = gap || prev.item !== ch.item && ch.x0 - prev.x1 > prev.size * 0.15;
        if (newLine ? !hyphen : apart) { text += " "; map.push(-1); }
      }
      prev = ch; gap = false; hyphen = ch.c === "-";
      for (const c of exact ? ch.c.normalize("NFKC") : fold(ch.c)) if (c !== "-") { text += c; map.push(i); }
    });
    return (this.index[exact] = { text, map });
  }
}

const fold = s => s.normalize("NFKC").toLowerCase();

function lineRects(run) {
  const rects = [];
  let cur = null, prev = null;
  for (const ch of run) {
    if (!ch.c.trim()) { prev = ch; continue; }
    const sameLine = cur && prev && Math.abs(ch.base - prev.base) < ch.size * 0.6 && ch.x0 >= cur[0] - 1;
    if (!sameLine) { cur = [ch.x0, ch.top, ch.x1, ch.bottom]; rects.push(cur); }
    else { cur[2] = Math.max(cur[2], ch.x1); cur[1] = Math.min(cur[1], ch.top); cur[3] = Math.max(cur[3], ch.bottom); }
    prev = ch;
  }
  return rects.map(r => r.map(v => Math.round(v * 10) / 10));
}

function runText(run) {
  let out = "";
  run.forEach((ch, i) => {
    const p = run[i - 1];
    if (p && p.item !== ch.item) {
      if (p.eol || Math.abs(ch.base - p.base) > p.size * 0.6) out += "\n";
      else if (ch.x0 - p.x1 > p.size * 0.15 && !/\s$/.test(out)) out += " ";
    }
    out += ch.c;
  });
  // Join words hyphenated across lines, then flatten the rest.
  return out.replace(/-\s*\n\s*/g, "").replace(/\s+/g, " ").trim();
}

// Where the ink is on a rendered page. The text layer gives a selection its lines, but its character
// positions can drift from the printed text (JSTOR scans especially), cutting off line ends; the
// horizontal extent of each selected line is taken from the ink instead.
class PageInk {
  static async load(page, scale = 3) {
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data, ink = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < ink.length; i++) ink[i] = px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11 < 150 ? 1 : 0;
    return new PageInk(ink, canvas.width, canvas.height, scale);
  }

  constructor(ink, w, h, scale) { Object.assign(this, { ink, w, h, scale }); }

  // Ink per pixel column across the middle of a line rect, plus the gap widths (in pixels) that end
  // a word and that end the line's text (a margin or column gutter).
  profile([, y0, , y1]) {
    const S = this.scale, lh = (y1 - y0) * S;
    const top = Math.max(0, Math.round((y0 + (y1 - y0) * 0.15) * S)), bottom = Math.min(this.h - 1, Math.round((y1 - (y1 - y0) * 0.1) * S));
    const col = new Uint8Array(this.w);
    for (let y = top; y <= bottom; y++) for (let x = 0, i = y * this.w; x < this.w; x++, i++) if (this.ink[i]) col[x] = 1;
    return { col, letterGap: Math.max(2, lh * 0.17), lineGap: lh * 1.2 };
  }

  // From pixel column x, the nearest ink in direction dir (searching up to `limit` pixels), or -1.
  static seek(col, x, dir, limit) {
    for (let k = 0; k <= limit; k++) { const i = x + dir * k; if (i < 0 || i >= col.length) break; if (col[i]) return i; }
    return -1;
  }
  // From an ink column, the last ink before a gap wider than `gap` in direction dir.
  static extent(col, x, dir, gap) {
    let last = x, run = 0;
    for (let i = x + dir; i >= 0 && i < col.length; i += dir) {
      if (col[i]) { last = i; run = 0; } else if (++run > gap) break;
    }
    return last;
  }

  // The ink between pixel columns a and b split into n words at its n - 1 widest gaps, as
  // [[first, last], ...] columns, or null if it has fewer gaps than that.
  static words(col, a, b, n) {
    const gaps = [];
    for (let x = a; x <= b;) {
      if (col[x]) { x++; continue; }
      const start = x;
      while (x <= b && !col[x]) x++;
      gaps.push([start, x - 1]);
    }
    if (gaps.length < n - 1) return null;
    const cuts = gaps.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0])).slice(0, n - 1).sort((p, q) => p[0] - q[0]);
    const words = [];
    let from = a;
    for (const [g0, g1] of cuts) { words.push([from, g0 - 1]); from = g1 + 1; }
    words.push([from, b]);
    return words;
  }

  // Snaps selection line rects to the ink: the first line starts at the word under `from`, the last
  // ends at the word under `to`, and lines in between run to the ends of their text.
  snap(rects, from, to) {
    const S = this.scale, X = v => Math.max(0, Math.min(this.w - 1, Math.round(v * S)));
    return rects.map((r, i) => {
      const { col, letterGap, lineGap } = this.profile(r);
      const near = (pt, rr) => pt && pt.y >= rr[1] - (rr[3] - rr[1]) && pt.y <= rr[3] + (rr[3] - rr[1]);
      let x0, x1;
      if (i === 0 && near(from, r)) {
        // the word under the start point, or the next word if it is in a space
        const at = PageInk.seek(col, X(from.x), 1, this.w);
        x0 = at < 0 ? -1 : PageInk.extent(col, at, -1, letterGap);
      } else {
        const at = PageInk.seek(col, X(r[0]), -1, lineGap), at2 = at < 0 ? PageInk.seek(col, X(r[0]), 1, lineGap) : at;
        x0 = at2 < 0 ? -1 : PageInk.extent(col, at2, -1, lineGap);
      }
      if (i === rects.length - 1 && near(to, r)) {
        const at = PageInk.seek(col, X(to.x), -1, this.w);
        x1 = at < 0 ? -1 : PageInk.extent(col, at, 1, letterGap);
      } else {
        const at = PageInk.seek(col, X(r[2]), 1, lineGap), at2 = at < 0 ? PageInk.seek(col, X(r[2]), -1, lineGap) : at;
        x1 = at2 < 0 ? -1 : PageInk.extent(col, at2, 1, lineGap);
      }
      if (x0 < 0 || x1 < 0 || x1 <= x0) return r;
      return [Math.round((x0 / S - 0.6) * 10) / 10, r[1], Math.round(((x1 + 1) / S + 0.6) * 10) / 10, r[3]];
    });
  }
}

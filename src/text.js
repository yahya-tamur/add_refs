// Character geometry for a PDF page, in page coordinates at scale 1 (points, origin top-left).
// pdf.js gives text items with a width but no per-character positions; estimating them from serif
// font metrics is close enough for picking a phrase or a symbol by dragging across it.

const measure = document.createElement("canvas").getContext("2d");
measure.font = "100px serif";

/* exported PageText */
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

  // Index of the character nearest to (x, y): prefer the line containing y, then the nearest x.
  nearest(x, y) {
    let best = -1, bestScore = Infinity;
    this.chars.forEach((ch, i) => {
      if (!ch.c.trim()) return;
      const dy = y < ch.top ? ch.top - y : y > ch.bottom ? y - ch.bottom : 0;
      const dx = x < ch.x0 ? ch.x0 - x : x > ch.x1 ? x - ch.x1 : 0;
      const score = dy * 10 + dx;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return { index: best, dist: bestScore };
  }

  // Characters between two points in content order (inclusive), as line rects and plain text.
  select(a, b) {
    const s = this.nearest(a.x, a.y), e = this.nearest(b.x, b.y);
    if (s.index < 0 || s.dist > 40 && e.dist > 40) return null;
    let i0 = Math.min(s.index, e.index), i1 = Math.max(s.index, e.index);
    const run = this.chars.slice(i0, i1 + 1);
    return { rects: lineRects(run), text: runText(run) };
  }
}

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

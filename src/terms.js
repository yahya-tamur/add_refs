// Terms and marks: how terms match, which definition a reference links to, definition colours,
// highlight clipping and symbol search queries. Pure functions; the app passes in its definitions.

/* exported PALETTE, isLatex, norm, isEnglishPhrase, posOf, before, resolveIn, pickColorIn, clashesIn, clipRects, symbolQuery,
   termHas, underlineY */

const PALETTE = ["#f2b705", "#2a9df4", "#3cb371", "#e8559a", "#ff8c1a", "#8e5cd9", "#17b8b0", "#d64545", "#7a9a01", "#a0522d"];

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

const posOf = d => [d.box.page, d.box.rect[1]];
const before = ([p1, y1], [p2, y2]) => p1 < p2 || p1 === p2 && y1 <= y2;

// The definition a reference links to: same term, nearest preceding (else the first one after).
function resolveIn(definitions, ref) {
  const key = norm(ref.term);
  const cands = definitions.filter(d => norm(d.term) === key).sort((a, b) => before(posOf(a), posOf(b)) ? -1 : 1);
  if (!cands.length) return null;
  const at = [ref.page, ref.rects[0]?.[1] ?? 0];
  return cands.filter(d => before(posOf(d), at)).at(-1) || cands[0];
}

// A colour for a definition: the least used one (unused if possible), never that of another
// definition of the same term, so repeated definitions of a word stay apart.
function pickColorIn(definitions, term = null, except = null) {
  const others = definitions.filter(d => d !== except);
  const taken = new Set(term ? others.filter(d => norm(d.term) === norm(term)).map(d => d.color) : []);
  const uses = c => others.filter(d => d.color === c).length;
  return PALETTE.filter(c => !taken.has(c)).sort((a, b) => uses(a) - uses(b))[0] || PALETTE[others.length % PALETTE.length];
}
const clashesIn = (definitions, color, term, except = null) =>
  definitions.some(d => d !== except && d.color === color && norm(d.term) === norm(term));

// Where a reference's underline is drawn under a text line rect [x0, y0, x1, y1].
const underlineY = r => r[3] - (r[3] - r[1]) * 0.06;

// Highlights never stack: a new one replaces the parts of older ones it covers. Returns the parts of
// `rects` outside `cutters` (on the same line).
function clipRects(rects, cutters) {
  const minus = (r, t) => {
    const sameLine = Math.min(r[3], t[3]) - Math.max(r[1], t[1]) > 0.5 * Math.min(r[3] - r[1], t[3] - t[1]);
    if (!sameLine || t[2] <= r[0] || t[0] >= r[2]) return [r];
    return [...t[0] > r[0] ? [[r[0], r[1], t[0], r[3]]] : [], ...t[2] < r[2] ? [[t[2], r[1], r[2], r[3]]] : []];
  };
  return cutters.reduce((out, t) => out.flatMap(r => minus(r, t)), rects).filter(r => r[2] - r[0] > 1.5);
}

// A query naming a symbol, as LaTeX ("\Lambda", "\Sigma_{\Lambda}") or a Unicode character ("Λ"):
// { latex, char } with the forms to look for in annotation terms and in the text, or null.
// `unicode` maps LaTeX commands to characters.
function symbolQuery(q, unicode) {
  q = q.trim();
  const toLatex = Object.fromEntries(Object.entries(unicode).map(([k, ch]) => [ch, k]));
  if (/[\\_^]/.test(q)) return { latex: q, char: unicode[q] || null };
  if ([...q].some(ch => toLatex[ch])) return { latex: [...q].map(ch => toLatex[ch] ? toLatex[ch] + " " : ch).join("").trim(), char: q };
  return null;
}

// Whether an annotation term contains the symbol (\Lambda is in \Sigma_{\Lambda}, not in \Lambdax).
function termHas(term, latex) {
  const t = norm(term), q = norm(latex);
  for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + 1)) {
    if (!(/[A-Za-z]$/.test(q) && /^[A-Za-z]/.test(t.slice(i + q.length)))) return true;
  }
  return false;
}

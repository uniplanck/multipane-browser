// Grokバーのページ送り: which of the bar's items (everything after the pins) go on which page. Pure; the window UI measures the widths and
// draws one page (renderer.js), the test requires it. Loaded by index.html as a plain script before renderer.js (no require there).
//   ws: each item's width (px). avail: the width for one page's elements and the 次へ button. btn: the button's width.
//   o.gap: the space between two elements; o.sec: each item's section (its index; null = none, e.g. the favorites); o.head: each section's
//   heading width (0 = no heading); o.sep: the separator's width (0 = none); o.lead: something (the pins) stands before the page. A collapsed
//   section supplies its heading as one item in ws, with its section index in o.sec and 0 in o.head, so it occupies one slot without duplication.
// An item needs in front of it the separator (the first section item after the pins / an item without a section) and its section's heading
// (the first item of its section, or of a page: every page says which section it shows). Everything fits: one page, no button. Else every page
// leaves room for the button and holds at least one item (one too wide for the bar is cut by it).
const GbarPages = (() => {
  const EPS = 1e-6;                                          // sums of fractional widths
  const px = x => (x > 0 ? x : 0);                           // NaN / negative / missing: 0
  const secOf = (o, j) => (o.sec && o.sec[j] != null ? o.sec[j] : null);
  // what stands in front of item j on a page that starts with item `from`: { sep: the separator, head: the section whose heading (-1 = none) }
  function before(j, from, o = {}) {
    const s = secOf(o, j);
    if (s === null) return { sep: false, head: -1 };
    const first = j === from, p = first ? null : secOf(o, j - 1);
    return { sep: px(o.sep) > 0 && (first ? !!o.lead : p === null), head: o.head && px(o.head[s]) > 0 && (first || p !== s) ? s : -1 };
  }
  // the end (exclusive) of a page that starts with item `from` and has `room` px: as many items as fit, with what each needs in front of it
  function fill(ws, from, room, o) {
    const gap = px(o.gap); let used = 0, k = 0, j = from;
    for (; j < ws.length; j++) {
      const b = before(j, from, o), add = [];
      if (b.sep) add.push(px(o.sep));
      if (b.head >= 0) add.push(px(o.head[b.head]));
      add.push(px(ws[j]));
      const u = add.reduce((a, w, i) => a + (k + i ? gap : 0) + w, used);
      if (u > room + EPS) break;
      used = u; k += add.length;
    }
    return j;
  }
  // the pages: [[from, to), ...] in order (none for no items)
  function pages(ws, avail, btn, o = {}) {
    const n = ws.length;
    if (!n) return [];
    if (fill(ws, 0, px(avail), o) === n) return [[0, n]];
    const room = px(avail) - px(btn) - px(o.gap), out = [];
    for (let i = 0; i < n;) { const e = Math.max(i + 1, fill(ws, i, room, o)); out.push([i, e]); i = e; }
    return out;
  }
  // the page that holds item i (-1: none)
  const pageOf = (pg, i) => pg.findIndex(([a, b]) => i >= a && i < b);
  return { pages, before, pageOf };
})();
if (typeof module === 'object' && module.exports) module.exports = GbarPages;

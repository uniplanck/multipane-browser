// node test/gbar-pages.test.js — Grokバーのページ送り (src/gbar-pages.js): which items (after the pins) go on which page from their widths, the
// width for a page and the 次へ button's width; the separator and section headings in front of an item (every page starts with its section's
// heading); fixed cases, edge cases and random cases against an independent width count. Then renderer.js' paging (gMeasure / gLayout / gShow /
// 次へ) run in a vm on a tiny fake DOM: the pins stay, a page fits, 次へ cycles, a resize keeps the page, a changed list falls back to the first
// page; and the wiring (index.html / style.css). Not covered here: the real bar on screen (fonts, icons, Chromium's widths) - manual check.
const fs = require('fs'), path = require('path'), vm = require('vm');
const GB = require('../src/gbar-pages');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const SRC = path.join(__dirname, '..', 'src'), read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const rep = (n, w) => Array.from({ length: n }, () => w);
// the width a page takes (its elements + the gaps between them), counted here on its own
function used(ws, [a, b], o = {}) {
  const g = o.gap || 0; let u = 0, k = 0;
  for (let j = a; j < b; j++) {
    const x = GB.before(j, a, o), add = [];
    if (x.sep) add.push(o.sep); if (x.head >= 0) add.push(o.head[x.head]); add.push(ws[j]);
    for (const w of add) u += (k++ ? g : 0) + w;
  }
  return u;
}

// ---- plain widths ----
t('no items: no pages', J(GB.pages([], 500, 40)) === '[]');
t('all fit (exactly): one page, no button', J(GB.pages([50, 50, 50], 158, 40, { gap: 4 })) === J([[0, 3]]));
t('1px short: pages that leave room for the button (gap + button)', J(GB.pages([50, 50, 50], 157, 40, { gap: 4 })) === J([[0, 2], [2, 3]]));
t('24 × 100px in 1000px, button 50, gap 4: 9 / 9 / 6', J(GB.pages(rep(24, 100), 1000, 50, { gap: 4 })) === J([[0, 9], [9, 18], [18, 24]]));
t('no gap given: widths only', J(GB.pages(rep(6, 100), 400, 100)) === J([[0, 3], [3, 6]]));
t('an item wider than the room gets a page of its own (never an empty page, never stuck)', J(GB.pages([50, 900, 50], 500, 40, { gap: 4 })) === J([[0, 1], [1, 2], [2, 3]]));
t('no room at all (0 / negative / NaN): one item per page', [0, -20, NaN].every(a => J(GB.pages([10, 20, 30], a, 40)) === J([[0, 1], [1, 2], [2, 3]])));
t('NaN / negative widths count as 0', J(GB.pages([NaN, -5, 50], 50, 40)) === J([[0, 3]]));
t('pageOf: the page holding an item; -1 for none / out of range', (() => { const pg = [[0, 9], [9, 18], [18, 24]];
  return GB.pageOf(pg, 0) === 0 && GB.pageOf(pg, 9) === 1 && GB.pageOf(pg, 17) === 1 && GB.pageOf(pg, 23) === 2 && GB.pageOf(pg, -1) === -1 && GB.pageOf(pg, 24) === -1 && GB.pageOf([], 0) === -1; })());

// ---- separator / headings in front of an item ----
{ const o = { gap: 4, sec: [null, null, 0, 0, 1, 1, 2], head: [40, 50, 0], sep: 9, lead: true }, b = (j, from) => J(GB.before(j, from, o));
  t('favorite: nothing in front (also first on a page after the pins)', b(0, 0) === J({ sep: false, head: -1 }) && b(1, 0) === J({ sep: false, head: -1 }));
  t('first section item after a favorite: separator + heading', b(2, 0) === J({ sep: true, head: 0 }));
  t('the same section goes on: nothing', b(3, 0) === J({ sep: false, head: -1 }));
  t('the next section: its heading, no separator', b(4, 0) === J({ sep: false, head: 1 }));
  t('a page starting mid-section: that section\'s heading again (+ separator after the pins)', b(5, 5) === J({ sep: true, head: 1 }) && b(3, 3) === J({ sep: true, head: 0 }));
  t('no pins: a page starting with a section item has its heading but no separator', J(GB.before(5, 5, { ...o, lead: false })) === J({ sep: false, head: 1 }));
  t('a section without a name (heading width 0): no heading, first on a page / after another section', b(6, 6) === J({ sep: true, head: -1 }) && b(6, 0) === J({ sep: false, head: -1 }));
  t('no options: plain items', J(GB.before(0, 0)) === J({ sep: false, head: -1 })); }
t('headings take room: an item that fits alone does not with its heading', (() => {
  const o = { gap: 4, sec: [0, 0, 1], head: [40, 40], sep: 0 };
  return J(GB.pages([100, 100, 100], 308, 50, { gap: 4 })) === J([[0, 3]]) && J(GB.pages([100, 100, 100], 308, 50, o)) === J([[0, 2], [2, 3]])
    && used([100, 100, 100], [0, 2], o) === 248 && used([100, 100, 100], [2, 3], o) === 144; })());
t('every page says its section: a page starting mid-section repeats the heading (and pays for it)', (() => {
  const ws = rep(10, 100), o = { gap: 4, sec: rep(10, 0), head: [60], sep: 9, lead: true }, pg = GB.pages(ws, 600, 50, o);
  return pg.length > 1 && pg.every(([a]) => J(GB.before(a, a, o)) === J({ sep: true, head: 0 })) && pg.every(p => used(ws, p, o) + 4 + 50 <= 600); })());

// ---- the bar in the report: 1 pin + 24 Bots in two sections did not fit 2400px ----
{ const ws = [...rep(12, 118), ...rep(12, 104)], o = { gap: 4, sec: [...rep(12, 0), ...rep(12, 1)], head: [52, 64], sep: 9, lead: true };
  const avail = 2290 - (122 + 4), pg = GB.pages(ws, avail, 52, o);
  t('1 pin + 24 Bots (2 sections) that overflow: 2 pages, each with its button inside the bar', used(ws, [0, 24], o) > avail && pg.length === 2 && pg.every(p => used(ws, p, o) + 4 + 52 <= avail));
  t('… the second page starts with its section\'s heading', GB.before(pg[1][0], pg[1][0], o).head === o.sec[pg[1][0]]); }

// ---- random cases against the width count above ----
{ let s = 7; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }, int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const fails = [];
  for (let c = 0; c < 3000; c++) {
    const n = int(0, 40), ns = int(0, 4), gap = int(0, 6), btn = int(30, 60), avail = int(-10, 2600) + rnd();
    const ws = Array.from({ length: n }, () => int(20, 140) + rnd()), head = Array.from({ length: ns }, () => (rnd() < 0.2 ? 0 : int(30, 80) + rnd()));
    const nf = ns ? int(0, n) : n; let cur = 0;                // favorites first, then the sections in order
    const sec = ws.map((_, j) => (j < nf ? null : j > nf && cur < ns - 1 && rnd() < 0.25 ? ++cur : cur));
    const o = { gap, sec, head, sep: rnd() < 0.5 ? 9 : 0, lead: rnd() < 0.5 }, pg = GB.pages(ws, avail, btn, o), A = Math.max(0, avail);
    const cover = pg.length ? pg[0][0] === 0 && pg[pg.length - 1][1] === n && pg.every(([a, b], i) => b > a && (!i || pg[i - 1][1] === a)) : n === 0;
    const one = n > 0 && used(ws, [0, n], o) <= A + 1e-6;
    const fit = one ? pg.length === 1 : pg.every(p => p[1] - p[0] === 1 || used(ws, p, o) + gap + btn <= A + 1e-6);
    const full = one || pg.slice(0, -1).every(([a, b]) => used(ws, [a, b + 1], o) + gap + btn > A - 1e-6);
    const heads = pg.every(([a]) => o.sec[a] === null || !(head[o.sec[a]] > 0) || GB.before(a, a, o).head === o.sec[a]);
    if (!(cover && fit && full && heads)) fails.push(c);
  }
  t(`random cases (3000): pages cover all items in order, one page iff all fit, each page + button fits (or is a single item), each page is as full as it can be, each starts with its heading${fails.length ? ' — failed: ' + fails.slice(0, 5) : ''}`, !fails.length); }

// ---- renderer.js: the paging code in a vm on a tiny fake DOM ----
const ren = read('renderer.js');
const a = ren.indexOf('let GP = null, gAnchor = null;'), z = ren.indexOf('function renderFavs(list) {');
t('renderer: the paging block is there (GP / gNext / gMeasure / gLayout / gShow / ResizeObserver) before renderFavs', a > 0 && z > a);
{ const box = { roCb: null };
  function El(w, cls = '', ml = 0, mr = 0) {
    return { w, className: cls, ml, mr, parent: null, id: '', dataset: {}, textContent: '', onclick: null, setAttribute() {},
      getBoundingClientRect() { return { width: this.parent && this.parent.shown !== false ? this.w : 0 }; },
      remove() { if (this.parent) { const c = this.parent.children; c.splice(c.indexOf(this), 1); this.parent = null; } } };
  }
  const favs = { w: 1400, shown: true, children: [], parent: null,
    append(...xs) { xs.forEach(x => { x.remove(); x.parent = this; this.children.push(x); }); },
    get lastElementChild() { return this.children[this.children.length - 1]; },
    getBoundingClientRect() { return { width: this.shown ? this.w : 0 }; } };
  const ctx = vm.createContext({ favs, GbarPages: GB, document: { createElement: () => El(52) },
    getComputedStyle: e => (e === favs ? { columnGap: '4px' } : { marginLeft: e.ml + 'px', marginRight: e.mr + 'px' }),
    ResizeObserver: class { constructor(cb) { box.roCb = cb; } observe(x) { box.observed = x; } } });
  vm.runInContext(ren.slice(ren.indexOf('function setTip('), ren.indexOf('function tipAttrs(')) + ren.slice(a, z), ctx);
  const run = s => vm.runInContext(s, ctx);
  const gNext = run('gNext'), pin = El(120, 'gpin');
  // like renderFavs: the pins in the bar, then the paged items (2 favorites, 3 sections; the last has no name)
  function build(nItems, keyOf = j => 'b' + j) {
    favs.children.forEach(c => { c.parent = null; }); favs.children = []; favs.append(pin);
    const sec = Array.from({ length: nItems }, (_, j) => (j < 2 ? null : j < 12 ? 0 : j < 22 ? 1 : 2));
    ctx.B = { els: sec.map((s, j) => El(s === null ? 90 : 110, 'item' + j)), keys: sec.map((_, j) => keyOf(j)), sec, heads: [El(50, 'h0'), El(60, 'h1'), null], sep: El(1, 'sep', 4, 4) };
    run('GP = { pinN: 1, els: B.els, keys: B.keys, sec: B.sec, heads: B.heads, sep: B.sep, w: -1, ok: false, pages: [], page: 0 }; gLayout();');
  }
  const shown = () => favs.children.map(e => (e === gNext ? 'NEXT' : e.className));
  const width = () => favs.children.reduce((s, e, i) => s + e.w + e.ml + e.mr + (i ? 4 : 0), 0);
  const page = () => run('GP.page'), npages = () => run('GP.pages.length');
  build(26);
  t('vm: the bar is watched for resizes', box.observed === favs && typeof box.roCb === 'function');
  t('vm: overflowing list -> pages; the pin stays first, 次へ last; the page fits the bar', npages() === 3 && shown()[0] === 'gpin' && shown().at(-1) === 'NEXT' && width() <= favs.w && gNext.dataset.tipDetail === 'ページ 1/3' && gNext.dataset.tipDesc === '次のBot一覧を表示します。');
  t('vm: page 1 = favorites, separator, heading, Bots', J(shown().slice(1, 6)) === J(['item0', 'item1', 'sep', 'h0', 'item2']));
  const firsts = [];
  for (let i = 0; i < 3; i++) { firsts.push(shown()[1]); gNext.onclick(); }
  t('vm: 次へ goes 1 -> 2 -> 3 -> back to 1; every page fits and starts (after the pin) with its section (separator + heading)', page() === 0 && J(firsts.slice(1)) === J(['sep', 'sep']) && (() => {
    const hs = []; for (let i = 0; i < 3; i++) { if (width() > favs.w) return false; hs.push(shown()[2]); gNext.onclick(); } return hs[0] === 'item1' && /^h\d$/.test(hs[1]) && /^h\d$/.test(hs[2]); })());
  gNext.onclick(); gNext.onclick();
  t('vm: the tooltip shows the page (3/3 on the last: back to the first)', page() === 2 && gNext.dataset.tipDetail === 'ページ 3/3' && gNext.dataset.tipDesc === 'Bot一覧の先頭に戻ります。');
  const anchor = run('gAnchor'), anchorEl = ctx.B.els[ctx.B.keys.indexOf(anchor)];
  favs.w = 1300; box.roCb();
  t('vm: a resize redoes the pages and stays on the page holding the item 次へ went to', run('GP.w') === 1300 && favs.children.includes(anchorEl) && width() <= favs.w);
  favs.w = 1000; box.roCb();
  t('vm: narrower (5 pages): still the page holding that item', npages() === 5 && page() === 3 && favs.children.includes(anchorEl) && width() <= favs.w);
  favs.w = 1400; box.roCb();
  t('vm: … and back again: the same page as before (the item 次へ went to is kept, not each page\'s first)', page() === 2 && favs.children.includes(anchorEl) && run('gAnchor') === anchor);
  const before = favs.children.slice(); box.roCb();
  t('vm: the same width again: nothing redone (same elements)', favs.children.length === before.length && favs.children.every((e, i) => e === before[i]));
  favs.w = 4000; box.roCb();
  t('vm: everything fits: one page, no 次へ', npages() === 1 && !favs.children.includes(gNext) && favs.children.length === 1 + 26 + 1 + 2);
  favs.w = 1400; box.roCb();
  t('vm: narrow again: pages and 次へ come back, on that item\'s page', npages() === 3 && page() === 2 && favs.children.includes(gNext));
  build(26);
  t('vm: the list rebuilt with the same items: still on that page', page() === 2 && favs.children.includes(ctx.B.els[ctx.B.keys.indexOf(run('gAnchor'))]));
  build(26, j => 'n' + j);
  t('vm: the item is gone from the list: the first page', page() === 0 && run('gAnchor') === null && shown()[1] === 'item0');
  favs.shown = false; build(26);
  t('vm: the bar has no size yet: nothing measured or shown but the pin', J(shown()) === J(['gpin']) && run('GP.ok') === false);
  favs.shown = true; box.roCb();
  t('vm: … once it has a size: measured and the page shown', run('GP.ok') === true && npages() === 3 && width() <= favs.w);
  build(0);
  t('vm: no items: just the pin', J(shown()) === J(['gpin']) && npages() === 0); }

// ---- wiring ----
t('index.html: gbar-pages.js before renderer.js', /<script src="gbar-pages\.js"><\/script><script src="renderer\.js"><\/script>/.test(read('index.html')));
t('renderer: no sideways scrolling of the bar any more', !/scrollLeft/.test(ren) && !/favs\.addEventListener\('wheel'/.test(ren));
t('style: the bar cuts (overflow hidden, no scroll), 次へ at the right end', /#favs\{[^}]*overflow:hidden[^}]*\}/.test(read('style.css')) && !/#favs\{[^}]*overflow-x:auto/.test(read('style.css')) && /#gbar-next\{margin-left:auto/.test(read('style.css')));
t('renderFavs: favorites and the sections\' Bots are paged, the pins are not', /els\.push\(b\); keys\.push\('f' \+ f\.id\); sec\.push\(null\);/.test(ren) && /els\.push\(gbotBtn\(b, false\)\); keys\.push\('b' \+ b\.id\); sec\.push\(k\);/.test(ren)
  && /pins\.forEach\(b => favs\.appendChild\(gbotBtn\(b, true\)\)\);/.test(ren) && /GP = \{ pinN: pins\.length,/.test(ren));

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);

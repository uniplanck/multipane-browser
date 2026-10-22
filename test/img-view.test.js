// node test/img-view.test.js — 画像ビューアの拡大. The built pane preload in a vm: the CSS goes in once per page, on grok.com only (another site /
// a subdomain never). The CSS itself: three rules, each one a picture <img> as its subject, every declaration !important, only the img's own size
// caps lifted (width / height 100%, max none, object-fit contain), nothing that moves another box. Which elements the rules pick, on synthetic
// copies of the viewer DOM through a small matcher of the selector subset they use (anything else throws): the viewer's picture today and with
// one of the three Tailwind signs changed; never the chat's images, thumbnails, avatars, a link's image, a box of several images, another dialog.
// Not covered here: Chromium's real layout (the fit while resizing, the arrows / close staying on top, a click beside the picture), grok.com's
// real DOM after it changes - that needs the manual check.
const fs = require('fs'), path = require('path'), vm = require('vm');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const SRC = path.join(__dirname, '..', 'src'), read = f => fs.readFileSync(path.join(SRC, f), 'utf8');

// ---- the built preload in a vm: what it inserts, when, where ----
function load(host, early = false) {
  const css = [], listeners = {};
  const ctx = vm.createContext({
    require: m => { if (m !== 'electron') throw new Error(m); return { ipcRenderer: { send: () => {}, on: () => {} }, webFrame: { insertCSS: s => { css.push(s); return 'k' + css.length; }, removeInsertedCSS: () => {}, setZoomFactor: () => {} } }; },
    window: { addEventListener: (k, f) => { (listeners[k] = listeners[k] || []).push(f); } }, document: { documentElement: early ? {} : null, querySelector: () => null, querySelectorAll: () => [] },
    location: { hostname: host, pathname: '/bot/x' }, MutationObserver: class { observe() {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  });
  vm.runInContext(read('pane-preload.js'), ctx);
  const before = css.length;
  (listeners.DOMContentLoaded || []).forEach(f => f());
  return { css, before };
}
const G = load('grok.com'), CSS = G.css[0] || '';
t('preload: grok.com -> the CSS once, when the document is there (DOMContentLoaded)', G.before === 0 && G.css.length === 1 && CSS.length > 200);
{ const E = load('grok.com', true);
  t('preload: the document already there -> at once, not a second time', E.before === 1 && E.css.length === 1 && E.css[0] === CSS); }
t('preload: another site / a subdomain / a look-alike host -> nothing', ['example.com', 'x.grok.com', 'grok.com.example', 'accounts.x.ai'].every(h => load(h).css.length === 0 && load(h, true).css.length === 0));
{ const tp = read('pane-preload.template.js'), i = tp.indexOf('---- 画像ビューアの拡大'), sec = tp.slice(i, tp.indexOf('---- per-pane zoom'));
  t('template: the source of it (the built preload is generated from it); CSS only - no size computed in JS, no resize / observer', i > 0 && /const IMG_VIEW_CSS = /.test(sec)
    && /webFrame\.insertCSS\(IMG_VIEW_CSS\)/.test(sec) && !/getBoundingClientRect|ResizeObserver|MutationObserver|addEventListener\('resize'|\.style\./.test(sec));
  t('template: never taken out again by the cloud PC code (pcStop removes its own key only)', /webFrame\.removeInsertedCSS\(pcCss\)/.test(tp) && (tp.match(/removeInsertedCSS/g) || []).length === 1); }

// ---- the CSS text ----
const RULES = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), decl: m[2] }));
t('css: three rules, nothing else (no @-rule, url, comment)', RULES.length === 3 && RULES.map(r => `${r.sel}{${r.decl}}`).join('\n') === CSS && !/@|url\(|\/\*|expression/i.test(CSS));
const WANT = { width: '100%', height: '100%', 'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0', 'object-fit': 'contain', 'box-shadow': 'none' };
t('css: each rule = the same declarations, all !important: fill the box, aspect kept (contain), caps lifted; nothing that moves other boxes', RULES.every(r => {
  const d = r.decl.split(';').filter(Boolean).map(x => /^([a-z-]+):(.+) !important$/.exec(x));
  return d.every(Boolean) && J(Object.fromEntries(d.map(m => [m[1], m[2]]))) === J(WANT);
}));

// ---- a matcher for the selector subset the rules use: type / *, [a] [a="v"] [a~="v"] [a*="v"] [a^="v"], :is() :not() :has(), ' ' > ~ + ----
function closeAt(s, j) { let d = 1, q = false; for (; j < s.length; j++) { const c = s[j]; if (q) { if (c === '"') q = false; } else if (c === '"') q = true; else if (c === '(') d++; else if (c === ')' && --d === 0) return j + 1; } throw new Error('unclosed ( in ' + s); }
function splitList(s) {
  const out = []; let d = 0, q = false, cur = '';
  for (const c of s) { if (q) { cur += c; if (c === '"') q = false; continue; } if (c === '"') q = true; else if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') d--; if (c === ',' && d === 0) { out.push(cur); cur = ''; } else cur += c; }
  return [...out, cur].map(x => x.trim());
}
function compound(s, i) {
  const c = { tag: null, attrs: [], pseudo: [] }, m = /^(\*|[a-z][a-z0-9-]*)/i.exec(s.slice(i));
  if (m) { c.tag = m[1].toLowerCase(); i += m[0].length; }
  for (;;) {
    if (s[i] === '[') { const a = /^\[([a-z-]+)(?:([~*^]?=)"([^"]*)")?\]/i.exec(s.slice(i)); if (!a) throw new Error('unsupported attribute ' + s.slice(i, i + 20)); c.attrs.push({ name: a[1], op: a[2] || null, val: a[3] }); i += a[0].length; }
    else if (s[i] === ':') { const p = /^:(is|not|has)\(/.exec(s.slice(i)); if (!p) throw new Error('unsupported pseudo ' + s.slice(i, i + 20)); const st = i + p[0].length, j = closeAt(s, st); c.pseudo.push({ name: p[1], list: splitList(s.slice(st, j - 1)).map(parse) }); i = j; }
    else break;
  }
  if (!c.tag && !c.attrs.length && !c.pseudo.length) throw new Error('unsupported selector at ' + JSON.stringify(s.slice(i, i + 20)));
  return [c, i];
}
function parse(src) {           // -> { cs: compounds, ks: combinators between them, lead: the leading combinator of a relative selector (:has) }
  const s = src.trim(), cs = [], ks = []; let i = 0;
  const comb = () => { const st = i; while (/\s/.test(s[i] || '')) i++; if (s[i] && '>~+'.includes(s[i])) { const k = s[i++]; while (/\s/.test(s[i] || '')) i++; return k; } return i > st ? ' ' : null; };
  const lead = comb();
  while (i < s.length) { const [c, j] = compound(s, i); cs.push(c); i = j; if (i >= s.length) break; const k = comb(); if (!k) throw new Error('unsupported selector at ' + JSON.stringify(s.slice(i, i + 20))); ks.push(k); }
  return { cs, ks, lead };
}
const prev = e => { const sib = e.parent ? e.parent.children : [], k = sib.indexOf(e); return k > 0 ? sib[k - 1] : null; };
const all = e => [e, ...e.children.flatMap(all)];
const top = e => { while (e.parent) e = e.parent; return e; };
function attrOk(e, a) {
  const v = e.attrs[a.name]; if (v == null) return false;
  return !a.op ? true : a.op === '=' ? v === a.val : a.op === '~=' ? v.split(/\s+/).includes(a.val) : a.op === '*=' ? a.val !== '' && v.includes(a.val) : a.val !== '' && v.startsWith(a.val);
}
const cmpOk = (e, c) => (!c.tag || c.tag === '*' || e.tag === c.tag) && c.attrs.every(a => attrOk(e, a))
  && c.pseudo.every(p => (p.name === 'is' ? p.list.some(x => matches(e, x)) : p.name === 'not' ? !p.list.some(x => matches(e, x)) : p.list.some(x => has(e, x))));
function step(e, k, f) {
  if (k === '>') return !!e.parent && f(e.parent);
  if (k === ' ') { for (let a = e.parent; a; a = a.parent) if (f(a)) return true; return false; }
  if (k === '+') { const p = prev(e); return !!p && f(p); }
  for (let p = prev(e); p; p = prev(p)) if (f(p)) return true; return false;     // '~'
}
function at(e, sel, i, anchor) {
  if (!e || !cmpOk(e, sel.cs[i])) return false;
  if (i > 0) return step(e, sel.ks[i - 1], x => at(x, sel, i - 1, anchor));
  return anchor ? step(e, sel.lead || ' ', x => x === anchor) : true;
}
function matches(e, sel) { if (sel.lead) throw new Error('a relative selector outside :has()'); return at(e, sel, sel.cs.length - 1, null); }
const has = (e, sel) => all(top(e)).some(x => x !== e && at(x, sel, sel.cs.length - 1, e));
// the matcher itself, on known cases
{ const d = h('div', { class: 'a b' }, h('img', { id: '1' }), h('img', { id: '2' })), [i1, i2] = d.children;
  t('matcher: ~= is a whole class, :has(> a ~ b), :not(complex), :is(list), sibling / child combinators', matches(d, parse('[class~="b"]')) && !matches(d, parse('[class~="a b"]')) && !matches(d, parse('[class~="c"]'))
    && matches(d, parse('div:has(> img ~ img)')) && !matches(h('div', {}, h('img')), parse('div:has(> img ~ img)')) && matches(i2, parse('img ~ img')) && !matches(i1, parse('img ~ img'))
    && matches(i1, parse('div > img:not(span img)')) && !matches(i1, parse('img:not(div img)')) && matches(i1, parse(':is([x],[class~="a"]) > img')) && matches(i2, parse('img + img')));
  let threw = 0; for (const s of ['img::before', 'img:first-child', '[class|="a"]', 'img[a=b]']) { try { parse(s); } catch { threw++; } }
  t('matcher: syntax outside the subset throws (so the CSS cannot slip past it)', threw === 4); }

// ---- which elements the rules pick ----
function h(tag, attrs = {}, ...kids) { const e = { tag, attrs, children: kids.filter(k => typeof k === 'object'), parent: null }; e.children.forEach(k => { k.parent = e; }); return e; }
const SEL = RULES.map(r => splitList(r.sel).map(parse));
const pick = (doc, sel = SEL) => all(doc).filter(e => sel.some(list => list.some(s => matches(e, s))));
const C = {                     // the viewer as grok.com draws it today (the inspector's DOM): dialog > zoom-out wrapper > [caption, area > picture, thumbnails]
  dlg: 'fixed left-[50%] top-[50%] z-50 grid translate-x-[-50%] translate-y-[-50%]',
  wrap: 'flex h-full w-full cursor-zoom-out flex-col items-center gap-3 p-8',
  area: 'relative flex min-h-0 w-full flex-1 items-center justify-center',
  pic: 'block max-h-full select-none rounded-xl object-contain shadow-2xl max-w-[min(95vw,1400px)]',
};
const thumb = (cls = 'h-12 w-12 rounded-md object-cover') => h('button', { type: 'button', class: 'shrink-0' }, h('img', { class: cls, alt: '' }));
function page(o = {}) {
  const pic = h('img', { class: o.pic ?? C.pic, alt: '' });
  const area = o.areaKids ? h('div', { class: o.area ?? C.area }, ...o.areaKids(pic)) : h('div', { class: o.area ?? C.area }, h('button', { 'aria-label': '前へ' }, h('svg')), pic, h('button', { 'aria-label': '次へ' }, h('svg')));
  const doc = h('html', {}, h('body', {},
    h('main', {}, h('div', { class: 'flex min-h-0 flex-1 flex-col' },           // the chat: an avatar, a picture with the very same classes, one in a link, a gallery
      h('img', { class: 'h-8 w-8 rounded-full' }),
      h('div', { class: C.area }, h('img', { class: C.pic })),
      h('a', { href: 'https://example.com/' }, h('img', { class: 'object-contain' })),
      h('div', { class: 'cursor-zoom-out flex-1' }, h('div', { class: 'flex-1' }, h('img', { class: C.pic }))))),
    h('div', { ...(o.root || { role: 'dialog' }), class: C.dlg, 'data-state': 'open' },
      h('div', { class: o.wrap ?? C.wrap },
        h('p', { class: 'text-sm' }, 'caption - 2/2'),
        area,
        h('div', { class: 'flex gap-2 overflow-x-auto' }, ...(o.thumbs || [thumb(), thumb()]))),
      h('button', { 'aria-label': '閉じる', class: 'absolute right-4 top-4' }, h('svg')))));
  return { doc, pic };
}
const only = (o, sel) => { const p = page(o), got = pick(p.doc, sel); return got.length === 1 && got[0] === p.pic; };
const none = (o, sel) => pick(page(o).doc, sel).length === 0;
t('today: exactly the viewer\'s picture (not the chat\'s look-alike, thumbnails, avatar, arrows, close)', only({}));
t('today: each rule alone picks the picture and nothing else', SEL.every(s => only({}, [s])));
t('aria-modal="true" instead of role="dialog": still the picture', only({ root: { 'aria-modal': 'true' } }));
t('one sign changed (wrapper / area / picture classes): still the picture', only({ wrap: 'flex h-full w-full flex-col items-center gap-3 p-8' })
  && only({ area: 'relative flex grow basis-0 items-center justify-center' }) && only({ pic: 'block h-auto select-none rounded-2xl' }));
t('two signs changed: nothing (grok.com\'s own look stays)', none({ wrap: 'flex flex-col p-8', area: 'relative flex grow' }) && none({ wrap: 'flex flex-col p-8', pic: 'block rounded-2xl' })
  && none({ area: 'relative flex grow', pic: 'block rounded-2xl' }));
t('the area\'s position among its siblings does not matter (picture first / last / alone)', only({ areaKids: p => [p, h('button', {}, h('svg'))] }) && only({ areaKids: p => [h('button', {}, h('svg')), p] }) && only({ areaKids: p => [p] }));
t('thumbnails: in buttons (even with object-contain / flex-1, or a flex-1 div inside), [role=button], or bare imgs in a flex-1 strip -> never', only({ thumbs: [thumb('h-12 w-12 object-contain'), thumb('object-contain flex-1')] })
  && only({ thumbs: [h('button', {}, h('div', { class: 'flex-1' }, h('img', { class: 'object-contain' }))), h('div', { role: 'button' }, h('div', { class: 'flex-1' }, h('img', { class: 'object-contain' })))] })
  && only({ thumbs: [h('div', { role: 'button', class: 'flex-1' }, h('img', { class: 'object-contain' }))] })
  && only({ thumbs: [h('div', { class: 'flex flex-1 gap-2' }, h('img', { class: 'object-contain' }), h('img', { class: 'object-contain' }))] }));
t('a box holding several images (a grid in the area) -> none of them', none({ areaKids: p => [p, h('img', { class: C.pic })] }));
t('round (avatar) / cropped (object-cover) / in a link, inside the area -> never', none({ pic: C.pic + ' rounded-full' }) && none({ pic: C.pic.replace('object-contain', 'object-cover') })
  && none({ areaKids: () => [h('a', { href: '#' }, h('img', { class: C.pic }))] }));
{ const other = h('html', {}, h('body', {}, h('div', { role: 'dialog' }, h('div', { class: 'flex flex-col gap-4' }, h('div', { class: 'flex items-center' }, h('img', { class: 'h-16 w-16 object-contain' })), h('img', { class: 'h-10 w-10 rounded-full object-cover' })))));
  t('another dialog (a form with an icon / an avatar, no zoom-out wrapper, no flex-1 area) -> never', pick(other).length === 0); }

console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);

// node test/gbar-collapse.test.js — section defaults, persistence, IPC, paging and the real renderer block, without Electron or network.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { pathToFileURL } = require('url');
const GS = require('../src/gbar-sections'), Pages = require('../src/gbar-pages'), Schema = require('../src/state-schema');
const Policy = require('../src/ipc-policy'), Mode = require('../src/gbar-mode'), Presence = require('../src/gbar-presence');
const root = path.join(__dirname, '..'), read = f => fs.readFileSync(path.join(root, 'src', f), 'utf8');
let bad = 0;
function t(name, f) { try { if (!f()) throw Error('assertion failed'); console.log('ok  ', name); } catch (e) { bad++; console.error('FAIL', name, e.message); } }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

t('only trimmed 待機 is collapsed by default; explicit choices win', () =>
  !GS.open(undefined, '待機') && !GS.open({}, '  待機  ') && GS.open({}, '仕事') && GS.open({}, '待機中')
  && GS.open({ '待機': true }, ' 待機 ') && !GS.open({ '仕事': false }, '仕事') && GS.open({ '仕事': true }, '仕事'));
t('toggle stores one explicit choice and flips the effective state', () => {
  let c = GS.toggle(undefined, '待機');
  if (!same(c, { '待機': true })) return false;
  c = GS.toggle(c, '待機'); c = GS.toggle(c, '仕事');
  return same(c, { '待機': false, '仕事': false }) && !GS.open(c, '仕事') && !GS.open(c, '待機');
});
t('clean removes invalid values and keys, trims names and accepts only plain objects', () => {
  const dirty = { ' 待機 ': true, '仕事': false, 'bad': 1, '': true, ' ': false, ['x'.repeat(101)]: true };
  return same(GS.clean(dirty), { '待機': true, '仕事': false }) && GS.valid(GS.clean(dirty))
    && [null, [], new Date(), Object.create({ inherited: true })].every(v => same(GS.clean(v), {}) && !GS.valid(v))
    && !GS.valid(dirty) && !GS.valid({ ' 待機 ': true });
});
t('prototype-like names are safe own choices, including after a toggle', () => {
  let c = GS.clean(JSON.parse('{"__proto__":false,"constructor":true,"toString":false}'));
  c = GS.toggle(c, '__proto__');
  return Object.getPrototypeOf(c) === Object.prototype && Object.hasOwn(c, '__proto__') && c.__proto__ === true
    && c.constructor === true && c.toString === false && GS.valid(c) && ({}).polluted === undefined;
});
t('at most 50 choices survive; a new toggle evicts the oldest and remains saved', () => {
  const many = Object.fromEntries(Array.from({ length: 55 }, (_, i) => ['group' + i, true]));
  const clean = GS.clean(many), toggled = GS.toggle(clean, 'new');
  return Object.keys(clean).length === 50 && !GS.valid(many) && GS.valid(toggled)
    && Object.keys(toggled).length === 50 && !Object.hasOwn(toggled, 'group0') && toggled.new === false;
});
t('schema repairs malformed choices, rejects them on write and preserves a round trip', () => {
  const loaded = Schema.migrate({ settings: { theme: 'dark', gbarSecOpen: { ' 待機 ': true, broken: 'yes' } } });
  const round = Schema.parse(Schema.serialize(loaded.doc));
  return loaded.ok && loaded.fixes.includes('settings.gbarSecOpen: repaired') && same(loaded.doc.settings.gbarSecOpen, { '待機': true })
    && round.ok && !round.fixes.length && same(round.doc.settings, loaded.doc.settings)
    && Schema.validate({ ...loaded.doc, settings: { gbarSecOpen: [] } }).includes('settings.gbarSecOpen: not a clean section list')
    && !Schema.migrate({}).doc.settings.gbarSecOpen;
});

const sender = role => ({ role, frame: { top: true, detached: false, url: pathToFileURL(path.join(root, 'src', role === 'chrome' ? 'index.html' : 'overlay.html')).href, origin: 'file://' } });
const check = (ch, role, args) => Policy.check(ch, sender(role), args, { owned: true });
t('both IPC tables admit bounded section names only from chrome', () => {
  const badNames = ['', '   ', 'x'.repeat(101), null, 1, {}, []];
  return check('gbar-sec-toggle', 'chrome', ['待機']) === null && check('gbar-sec-toggle', 'overlay', ['待機']) === 'E_ROLE'
    && badNames.every(name => check('gbar-sec-toggle', 'chrome', [name]) === 'E_PAYLOAD')
    && check('gbar-sec-toggle', 'chrome', ['待機', true]) === 'E_PAYLOAD'
    && check('overlay-run', 'chrome', [{ type: 'gbar-sec-toggle', name: '待機' }]) === null
    && check('overlay-run', 'overlay', [{ type: 'gbar-sec-toggle', name: '待機' }]) === 'E_ROLE'
    && badNames.every(name => check('overlay-run', 'chrome', [{ type: 'gbar-sec-toggle', name }]) === 'E_PAYLOAD')
    && check('overlay-run', 'chrome', [{ type: 'gbar-sec-toggle', name: '待機', extra: 1 }]) === 'E_PAYLOAD';
});

t('a collapsed heading is a measured section item, present on exactly one page at various widths', () => {
  const ws = [45, 45, 64, 45, 45, 45], o = { gap: 4, sec: [0, 0, 1, 2, 2, 2], head: [28, 0, 35], sep: 9, lead: true };
  return [90, 140, 220, 600].every(width => {
    const pages = Pages.pages(ws, width, 30, o), containing = pages.filter(([a, b]) => a <= 2 && b > 2);
    return containing.length === 1 && Pages.pageOf(pages, 2) === pages.indexOf(containing[0])
      && Pages.before(2, containing[0][0], o).head === -1
      && pages.every(([a]) => o.sec[a] === 1 || Pages.before(a, a, o).head === o.sec[a]);
  });
});

const main = read('main.js'), ren = read('renderer.js');
t('source: renderer only creates expanded chips, calls toggle and updates heading indicators', () =>
  /if \(!s\.name \|\| !s\.collapsed\) s\.items\.forEach/.test(ren) && /mpb\.gbarSecToggle\(s\.name\)/.test(ren)
  && /gSections\.forEach/.test(ren) && /classList\.toggle\('gopen', open\)/.test(ren)
  && /classList\.toggle\('gactive', active\)/.test(ren) && /classList\.toggle\('gunread', unread\)/.test(ren)
  && /on\('gbar-sec-toggle', name => gbSecToggle\(name\)\)/.test(main));

// Exercise the actual main functions and renderer with a small in-memory DOM. The button's native keyboard click is represented by detail: 0.
{
  let favs, doc;
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.className = ''; this.dataset = {}; this.attrs = {}; this.style = {}; this._t = ''; this.on = {}; }
    get classList() { const el = this; return { contains(c) { return el.className.split(/\s+/).includes(c); }, toggle(c, value) {
      const set = new Set(el.className.split(/\s+/).filter(Boolean)), on = value === undefined ? !set.has(c) : !!value;
      if (on) set.add(c); else set.delete(c); el.className = [...set].join(' '); return on;
    }, add(c) { this.toggle(c, true); }, remove(c) { this.toggle(c, false); } }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    get textContent() { return this._t + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.children.forEach(c => { c.parent = null; }); this.children = []; this._t = String(v); }
    set innerHTML(v) { this.textContent = ''; this.insertAdjacentHTML('beforeend', v); }
    insertAdjacentHTML(_, html) { for (const m of String(html).matchAll(/<span class="([^"]*)">([^<]*)<\/span>/g)) { const el = new El('span'); el.className = m[1]; el.textContent = m[2]; this.appendChild(el); } }
    appendChild(c) { c.remove(); c.parent = this; this.children.push(c); return c; }
    append(...cs) { cs.forEach(c => this.appendChild(c)); }
    remove() { if (this.parent) { const a = this.parent.children; a.splice(a.indexOf(this), 1); this.parent = null; } }
    get lastElementChild() { return this.children[this.children.length - 1]; }
    addEventListener(name, fn) { (this.on[name] ||= []).push(fn); }
    contains(el) { return this.children.includes(el); }
    focus() { doc.activeElement = this; }
    getBoundingClientRect() {
      if (this === favs) return { width: favs.w };
      let p = this; while (p && p !== favs) p = p.parent;
      if (!p) return { width: 0 };
      if (this.id === 'gbar-next') return { width: 35 };
      if (this.classList.contains('gsep')) return { width: 1 };
      if (this.classList.contains('gsec')) return { width: this.textContent.length * 6 + (this.classList.contains('gcollapsed') ? 26 : 8) };
      return { width: 48 };
    }
  }
  favs = new El('div'); favs.w = 150;
  const elements = { '#favs': favs, '#fav-star': new El('button'), '#gbar-note': new El('span'), '#fav-hint': new El('span') };
  const bot = id => ({ id, name: id, orig: id, url: 'https://grok.com/bot/' + id, icon: '', group: false, pinned: false });
  const sections = [{ name: '待機', items: [bot('w1'), bot('w2'), bot('w3')] },
    { name: 'Dev tools', items: Array.from({ length: 5 }, (_, i) => bot('d' + i)) }, { name: '', items: [bot('misc')] }];
  const box = { calls: [], saves: 0, pushes: 0, gbar: null };
  const model = vm.createContext({ GS, GM: Mode, GB: { view: () => ({ sections, pins: [], count: 9, at: 0 }) },
    grok: {}, settings: {}, gbRun: false, gbNote: '', save: () => box.saves++, gbPush: () => { box.pushes++; if (box.gbar) box.gbar(model.gbView()); } });
  vm.runInContext(main.match(/const gbView = \(\) => [^\n]*;/)[0].replace('const gbView', 'var gbView') + '\n' + main.match(/function gbSecToggle\(name\) \{[^\n]*\}/)[0], model);
  const mpb = new Proxy({}, { get: (_, key) => key === 'onGbar' ? cb => { box.gbar = cb; } : (...args) => {
    box.calls.push([key, ...args]); if (key === 'gbarSecToggle') model.gbSecToggle(args[0]);
  } });
  doc = { createElement: tag => new El(tag), activeElement: null };
  const ctx = vm.createContext({ $: s => elements[s], mpb, S: { favorites: [], focusedId: 11, panes: [
    { id: 11, url: sections[0].items[0].url }, { id: 12, url: sections[0].items[1].url, needsReply: true },
    { id: 13, url: sections[1].items[0].url }] }, MOD: '⌘', renderSummaryTips() {}, URL,
    GbarPresence: Presence, GbarMode: Mode, GbarPages: Pages, GbarLongPress: require('../src/gbar-long-press'),
    document: doc,
    getComputedStyle: e => e === favs ? { columnGap: '4px' } : { marginLeft: e.classList.contains('gsep') ? '4px' : '0', marginRight: e.classList.contains('gsep') ? '4px' : '0' },
    ResizeObserver: class { constructor(cb) { box.resize = cb; } observe() {} } });
  vm.runInContext(ren.slice(ren.indexOf('function setTip('), ren.indexOf('function tipAttrs('))
    + ren.slice(ren.indexOf('// ---- short labels:'), ren.indexOf('function mk(id) {'))
    + ren.slice(ren.indexOf('// ---- お気に入りバー:'), ren.indexOf('// drop a link / URL text onto the favorites bar')), ctx);
  const run = code => vm.runInContext(code, ctx), gp = () => run('GP'), next = run('gNext');
  const collapsed = () => gp().els.find(e => e.classList.contains('gcollapsed'));
  const event = (o = {}) => ({ button: 0, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; }, ...o });
  const show = el => { for (let i = 0; i < gp().pages.length && !favs.contains(el); i++) next.onclick(); return favs.contains(el); };
  box.gbar(model.gbView());

  t('main view carries effective defaults and no choices are created at startup', () => {
    const view = model.gbView();
    return view.sections[0].collapsed && !view.sections[1].collapsed && !view.sections[2].collapsed && !model.settings.gbarSecOpen;
  });
  t('renderer: collapsed heading is a button with count, tooltip and indicators, while chips are absent', () => {
    const h = collapsed();
    return h && h.tagName === 'BUTTON' && h.type === 'button' && h.textContent === '待機 3▸' && h.attrs['aria-expanded'] === 'false'
      && h.dataset.tip === '待機' && h.dataset.tipDesc === 'クリックでこのグループのBotを表示します。'
      && h.dataset.tipDetail === '3件のBot・ペインで開いています・未読あり'
      && h.classList.contains('gopen') && h.classList.contains('gactive') && h.classList.contains('gunread')
      && gp().heads[0] === null && !gp().keys.some(k => /^bw[123]$/.test(k));
  });
  t('renderer: collapsed heading is visible once across pages; expanded headings repeat when needed', () => {
    const h = collapsed(), n = gp().pages.length; let seen = 0, repeated = 0, good = n > 1;
    for (let i = 0; i < n; i++) {
      const [a, b] = gp().pages[gp().page], containsOther = gp().sec.slice(a, b).includes(1);
      if (favs.children.includes(h)) seen++;
      if (containsOther) { repeated++; good &&= favs.children.includes(gp().heads[1]); }
      next.onclick();
    }
    return good && seen === 1 && repeated > 1 && gp().page === 0;
  });
  t('renderer: focus, unread and unopened update even on a detached page, without rebuild or remeasure', () => {
    const h = collapsed(), old = gp(), ws = old.ws, pageCount = old.pages.length;
    for (let i = 0; i < pageCount && favs.children.includes(h); i++) next.onclick();
    if (favs.children.includes(h)) return false;
    ctx.S.panes[1].needsReply = false; run('renderFavs(S.favorites)');
    const first = h.classList.contains('gopen') && h.classList.contains('gactive') && !h.classList.contains('gunread');
    ctx.S.panes[0].unread = 1; run('renderFavs(S.favorites)');
    const countUnread = h.classList.contains('gunread');
    ctx.S.panes[0].unread = 0; ctx.S.focusedId = 13; ctx.S.panes[1].unopened = true; run('renderFavs(S.favorites)');
    const second = h.classList.contains('gopen') && !h.classList.contains('gactive') && h.classList.contains('gunread') && /未読あり/.test(h.dataset.tipDetail);
    ctx.S.panes[0].url = 'https://example.com/'; ctx.S.panes[1].url = 'https://example.com/'; run('renderFavs(S.favorites)');
    return first && countUnread && second && !h.classList.contains('gopen') && !h.classList.contains('gunread') && h.dataset.tipDetail === '3件のBot'
      && gp() === old && gp().ws === ws;
  });
  t('renderer: right click, control-click and drag cause no action', () => {
    const h = collapsed(), before = box.calls.length, menu = event(), drag = event();
    h.onclick(event({ button: 2 })); h.onclick(event({ ctrlKey: true })); h.oncontextmenu(menu); h.ondragstart(drag);
    return box.calls.length === before && !h.draggable && menu.prevented && menu.stopped && drag.prevented && drag.stopped;
  });
  t('heading click saves and pushes to all bars, and expansion exposes its chips', () => {
    const h = collapsed(), e = event(); if (!show(h)) return false; h.focus(); h.onclick(e);
    const head = gp().heads[0];
    return e.stopped && box.saves === 1 && box.pushes === 1 && same(model.settings.gbarSecOpen, { '待機': true })
      && model.gbView().sections[0].collapsed === false && head.tagName === 'BUTTON' && head.attrs['aria-expanded'] === 'true'
      && head.dataset.tipDesc === 'クリックでこのグループのBotを折りたたみます。' && head.dataset.tipDetail === '3件のBot'
      && favs.contains(head) && doc.activeElement === head && ['bw1', 'bw2', 'bw3'].every(k => gp().keys.includes(k));
  });
  t('restart round trip retains expansion; a native keyboard click collapses again', () => {
    const saved = Schema.migrate({ settings: model.settings });
    const restarted = Schema.parse(Schema.serialize(saved.doc));
    if (!restarted.ok || !GS.open(restarted.doc.settings.gbarSecOpen, '待機')) return false;
    const e = event({ detail: 0 }); gp().heads[0].onclick(e);
    return e.stopped && model.settings.gbarSecOpen['待機'] === false && !!collapsed() && favs.contains(collapsed())
      && doc.activeElement === collapsed() && box.saves === 2 && box.pushes === 2;
  });
  t('compact headings retain the truncated name, count, chevron and accessible full title', () => {
    model.settings.gbarMode = 'compact'; box.gbar(model.gbView()); const h = collapsed();
    return h.textContent === '待 3▸' && h.dataset.tip === '待機' && h.attrs['aria-expanded'] === 'false';
  });
  t('other named sections are also buttons and save explicit collapsed choices', () => {
    const h = gp().heads[1]; if (!show(h)) return false; h.onclick(event());
    return h.tagName === 'BUTTON' && model.settings.gbarSecOpen['Dev tools'] === false
      && gp().els.some(e => e.dataset.tip === 'Dev tools' && e.attrs['aria-expanded'] === 'false' && favs.contains(e))
      && !gp().keys.some(k => /^bd[0-4]$/.test(k));
  });
}
console.log(bad ? `${bad} failed` : 'all passed'); process.exit(bad ? 1 : 0);

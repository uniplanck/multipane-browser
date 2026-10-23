// node test/new-pane.test.js — 新規ペインはGrok (src/new-pane.js): which new pane is an empty one (grok.com), the one-time sidebar opening, the
// page-side scripts on a fake grok.com page (vm) and main.js's real sbOpen / newPane run in a vm with a fake clock. Synthetic pages only: no
// Electron, no real grok.com DOM, no user profile.
const fs = require('fs'), path = require('path'), vm = require('vm');
const NEWP = require('../src/new-pane');
const GB = require('../src/grok-bots'), CB = require('../src/copy-policy'), UW = require('../src/usage-web'), NAV = require('../src/navigation-policy');
const DG = require('../src/diagnostics');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
let bad = 0; const t = (n, ok) => { if (!ok) bad++; console.log(ok ? 'ok  ' : 'FAIL', n); };
const J = JSON.stringify;
const fnSrc = (name, prefix = 'function ') => { const a = main.indexOf(prefix + name + '('); if (a < 0) throw Error('missing ' + name); return main.slice(a, main.indexOf('\n}\n', a) + 2); };
const HOME = 'https://grok.com/';

// ---- which pane is an empty new one ----
t('home = https://grok.com/, a page main may load', NEWP.HOME === HOME && !NAV.appLoad(HOME));
t('empty + new / fill -> grok.com, sidebar once', ['new', 'fill'].every(f => J(NEWP.start('', f)) === J({ url: HOME, sidebar: true }) && NEWP.start('   ', f).sidebar && NEWP.start(undefined, f).url === HOME));
t('empty without a fresh origin (restore / workspace / ⌘⇧T / 複製 / unknown) -> as before', ['', 'restore', 'dup', 'reopen', 'x'].every(f => J(NEWP.start('', f)) === J({ url: '', sidebar: false })));
t('a URL is never changed and gets no sidebar opening (Grok bar / favorites / palette "Grok を新しいペインで開く")',
  ['https://grok.com/bot/abc', HOME, 'https://example.com', 'mpb:newtab'].every(u => J(NEWP.start(u, 'new')) === J({ url: u, sidebar: false })));

// ---- the one opening: armed -> its first page -> loaded ----
{ const s = NEWP.arm(1000, 0, 1000), n = NEWP.nav(s, HOME, 2000);
  t('armed: not due before its page has come', s.stage === 'armed' && !NEWP.due(s));
  t('first page on grok.com in time -> waits for its load (due)', n && n.stage === 'nav' && NEWP.due(n) && NEWP.due(NEWP.nav(s, 'https://grok.com/?x=1', 2000)));
  t('first page elsewhere (sign-in / other site / http / look-alike host) -> never', ['https://accounts.x.ai/sign-in', 'http://grok.com/', 'https://grok.com.evil.example/', 'https://grok.com:8443/', 'about:blank', ''].every(u => NEWP.nav(s, u, 2000) === null));
  t('first page too late (load queue > ARM_MS) -> never', NEWP.nav(s, HOME, 1000 + NEWP.ARM_MS + 1) === null && !!NEWP.nav(s, HOME, 1000 + NEWP.ARM_MS));
  t('after the click / once ended -> never again (a reload / later page does nothing)', NEWP.nav({ ...n, clicked: true }, HOME, 3000) === null && NEWP.nav(null, HOME, 3000) === null && !NEWP.due(null));
  t('a grok.com page replaced before the click (redirect / challenge / reload) -> starts over on the new page', (r => r && r.stage === 'nav' && r.tok === null)(NEWP.nav({ ...n, stage: 'run', tok: {} }, HOME, 4000)));
  t('used: typed or clicked into the pane since it was made', !NEWP.used(s, { inputRev: 0, lastInteract: 1000 }) && NEWP.used(s, { inputRev: 1, lastInteract: 1000 }) && NEWP.used(s, { inputRev: 0, lastInteract: 1001 })); }

// ---- decide: observations over time ----
function first(obs) {                                          // obs(now) -> observation, every 300 ms from 300; -> the first act that is not 'wait'
  let rs = NEWP.begin(0);
  for (let now = 300; now < 60000; now += 300) { const d = NEWP.decide(rs, obs(now), now); rs = d.rs; if (d.act !== 'wait') return d.act + (d.code ? ':' + d.code : '') + '@' + now; }
  return 'none';
}
const ob = x => ({ ready: true, trig: true, sb: 'closed', grok: true, user: false, busy: false, ...x });
const GIVE = Math.floor(NEWP.GIVEUP_MS / 300) * 300 + 300;
t('closed with a toggle -> a click only after SETTLE_MS once ready', first(() => ob()) === 'click@' + (300 + NEWP.SETTLE_MS));
t('open -> ALREADY (nothing clicked)', first(() => ob({ sb: 'open' })) === 'end:ALREADY@' + (300 + NEWP.SETTLE_MS));
t('not ready yet -> waits; the settle counts from ready', first(now => ob({ ready: now >= 1500 })) === 'click@' + (1500 + NEWP.SETTLE_MS));
t('server-rendered open, then closed by the page itself -> not ALREADY; clicked once the closed state held', first(now => ob({ sb: now < 900 ? 'open' : 'closed' })) === 'click@' + (900 + NEWP.SETTLE_MS));
t('no toggle and no sidebar -> nothing clicked, NOTOGGLE after GIVEUP_MS', first(() => ob({ trig: false, sb: 'none' })) === 'end:NOTOGGLE@' + GIVE);
t('closed drawer (no sidebar element) with a toggle -> clicked', first(() => ob({ sb: 'none' })) === 'click@' + (300 + NEWP.SETTLE_MS));
t('shared state busy (Grok bar read / another pane) -> waits; BUSY at GIVEUP_MS', first(() => ob({ busy: true })) === 'end:BUSY@' + GIVE);
t('busy for a while -> clicked once it is free', first(now => ob({ busy: now < 3000 })) === 'click@3000');
t('left grok.com / the user used the pane -> MOVED / USER, nothing clicked', first(() => ob({ grok: false })) === 'end:MOVED@300' && first(now => ob({ user: now >= 600 })) === 'end:USER@600');
{ let rs = NEWP.begin(0); for (let now = 300; !rs.clickAt; now += 300) rs = NEWP.decide(rs, ob(), now).rs;
  const c = rs.clickAt, step = (o, now) => NEWP.decide(rs, o, now);
  t('after the click: seen open -> restore OPENED; busy / user / moved no longer matter', J([step(ob({ sb: 'open', busy: true, user: true, grok: false }), c + 300)].map(d => d.act + ':' + d.code)) === J(['restore:OPENED']));
  t('after the click: not open by CONFIRM_MS -> restore UNSURE; never a second click', step(ob(), c + 300).act === 'wait' && step(ob(), c + NEWP.CONFIRM_MS).code === 'UNSURE'
    && [300, 900, 1500, 2100].every(k => step(ob(), c + k).act !== 'click')); }

// ---- the page side on a fake grok.com page ----
// desktop: shadcn's wrapper (data-state) > fixed panel > [data-sidebar=sidebar] sliding off screen when collapsed; mobile: a sheet that exists only
// while open. The toggle flips it and (desktop) stores sidebarOpen (+ the shadcn cookie with o.cookie), as grok.com does; one session = one storage
function session(ls, cookie) { const S = { store: new Map(), jar: new Map() }; if (ls != null) S.store.set('sidebarOpen', ls); if (cookie != null) S.jar.set('sidebar_state', cookie); return S; }
function page(clock, o = {}) {
  const S = o.session || session(o.ls), pg = { url: HOME, clicks: 0, log: o.log || [], name: o.name || 'A', mode: o.mode || 'desktop', hydrated: !o.hydrateAt };
  const readyAt = clock.t + (o.readyIn || 0);
  pg.open = o.hydrateAt ? !!o.ssrOpen : pg.mode === 'desktop' && S.store.get('sidebarOpen') === 'true';
  const sync = () => { if (!pg.hydrated && clock.t >= o.hydrateAt) { pg.hydrated = true; pg.open = pg.mode === 'desktop' && S.store.get('sidebarOpen') === 'true'; } };
  const mk = (attrs, rect, parent, click) => ({ attrs, parentElement: parent || null, getAttribute: k => Object.hasOwn(attrs, k) ? attrs[k] : null,
    hasAttribute: k => Object.hasOwn(attrs, k), getBoundingClientRect: () => rect, click: click || (() => {}) });
  const toggle = () => { pg.clicks++; pg.log.push(pg.name + ':click'); pg.open = !pg.open;
    if (pg.mode === 'desktop') { S.store.set('sidebarOpen', String(pg.open)); if (o.cookie) S.jar.set('sidebar_state', String(pg.open)); } };
  const els = () => {
    sync(); const out = [];
    if (!o.noToggle) { const tg = mk(o.ariaToggle ? { 'aria-label': o.ariaToggle } : { 'data-sidebar': 'trigger' }, { left: 270, right: 290, width: 20, height: 20 }, null, toggle); if (o.ariaToggle) tg.tag = 'BUTTON'; out.push(tg); }
    if (pg.mode === 'desktop') {
      const wrap = mk({ 'data-state': pg.open ? 'expanded' : 'collapsed', 'data-side': 'left' }, { left: 0, right: 0, width: 0, height: 900 });
      out.push(mk({ 'data-sidebar': 'sidebar' }, pg.open ? { left: 0, right: 256, width: 256, height: 900 } : { left: -256, right: 0, width: 256, height: 900 }, mk({}, {}, wrap)));
    } else if (pg.open) out.push(mk({ 'data-sidebar': 'sidebar', 'data-state': 'open', 'data-mobile': 'true' }, { left: 0, right: 288, width: 288, height: 900 }));
    return out;
  };
  const document = { get readyState() { return clock.t >= readyAt ? 'complete' : 'loading'; },
    querySelectorAll: sel => els().filter(e => sel.split(',').some(one => { const m = one.match(/^\[data-sidebar="(\w+)"\]$/); const b = one.match(/^button\[aria-label="([^"]+)"\]$/); return m ? e.attrs['data-sidebar'] === m[1] : b ? e.tag === 'BUTTON' && e.attrs['aria-label'] === b[1] : false; })),
    get cookie() { return [...S.jar].map(([k, v]) => k + '=' + v).join('; '); },
    set cookie(s) { const [kv, ...at] = String(s).split(';').map(x => x.trim()), i = kv.indexOf('='); pg.log.push(pg.name + ':cookie');
      if (at.some(a => /^max-age=0$/i.test(a))) S.jar.delete(kv.slice(0, i)); else S.jar.set(kv.slice(0, i), kv.slice(i + 1)); } };
  const window = { innerWidth: 1000, localStorage: { getItem: k => S.store.has(k) ? S.store.get(k) : null, setItem: (k, v) => S.store.set(k, String(v)), removeItem: k => S.store.delete(k) } };
  const ctx = vm.createContext({ document, window });
  pg.exec = code => {
    if (/mpb:np-restore/.test(code)) pg.log.push(pg.name + ':restore');
    const v = vm.runInContext(code, ctx);
    if (o.throwOnClick && /mpb:np-open/.test(code)) throw Error('lost');
    return o.loseClick && /mpb:np-open/.test(code) ? null : v === undefined ? undefined : JSON.parse(J(v));   // as over IPC
  };
  pg.S = S; pg.document = document; pg.window = window;
  return pg;
}
{ const clock = { t: 0 }, st = pg => JSON.parse(J(NEWP.sidebarState(pg.document, pg.window)));
  t('state: desktop collapsed (off screen, wrapper collapsed) -> closed, toggle there', J(st(page(clock, { ls: 'false' }))) === J({ ready: true, trig: true, sb: 'closed' }));
  t('state: the header toggle without data-sidebar (aria-label サイドバーを切り替え / Toggle Sidebar) counts; a button with another label does not', J(st(page(clock, { ls: 'false', ariaToggle: 'サイドバーを切り替え' }))) === J({ ready: true, trig: true, sb: 'closed' }) && st(page(clock, { ls: 'false', ariaToggle: 'Toggle Sidebar' })).trig === true && st(page(clock, { ls: 'false', ariaToggle: 'その他' })).trig === false);
  t('state: desktop expanded -> open', st(page(clock, { ls: 'true' })).sb === 'open');
  t('state: narrow page, drawer closed -> none; its sheet open -> open', st(page(clock, { mode: 'mobile' })).sb === 'none' && (pg => { pg.document.querySelectorAll('[data-sidebar="trigger"]')[0].click(); return st(pg).sb === 'open'; })(page(clock, { mode: 'mobile' })));
  const el = (attrs, rect, parent) => ({ attrs, parentElement: parent || null, getAttribute: k => Object.hasOwn(attrs, k) ? attrs[k] : null, hasAttribute: k => Object.hasOwn(attrs, k), getBoundingClientRect: () => rect });
  const doc = els => ({ readyState: 'complete', querySelectorAll: sel => els.filter(e => sel.split(',').includes(`[data-sidebar="${e.attrs['data-sidebar']}"]`)) });
  const W = { innerWidth: 1000, localStorage: { getItem: () => null } }, R = { left: 0, right: 256, width: 256, height: 900 };
  t('state: as narrow as its icons (48 px, no data-state) -> closed', NEWP.sidebarState(doc([el({ 'data-sidebar': 'sidebar' }, { left: 0, right: 48, width: 48, height: 900 })]), W).sb === 'closed');
  t('state: a right-hand sidebar only -> not the one (none)', NEWP.sidebarState(doc([el({ 'data-sidebar': 'sidebar' }, R, el({ 'data-side': 'right' }, R))]), W).sb === 'none');
  let far = el({ 'data-state': 'closed' }, R); for (let i = 0; i < 4; i++) far = el({}, R, far);
  t('state: an unrelated data-state 5 levels up is ignored; one on the wrapper counts', NEWP.sidebarState(doc([el({ 'data-sidebar': 'sidebar' }, R, far)]), W).sb === 'open'
    && NEWP.sidebarState(doc([el({ 'data-sidebar': 'sidebar' }, R, el({}, R, el({ 'data-state': 'collapsed' }, R)))]), W).sb === 'closed');
  t('state: a toggle counts even when hidden (the visible one is preferred when clicking)', NEWP.sidebarState(doc([el({ 'data-sidebar': 'trigger' }, { left: 0, right: 0, width: 0, height: 0 })]), W).trig === true); }
{ const clock = { t: 0 }, pg = page(clock, { ls: 'false', cookie: true, session: session('false', 'false') });
  const s = pg.exec(NEWP.STATE_JS), c = pg.exec(NEWP.CLICK_JS);
  t('scripts: STATE_JS = state + what is stored', s.sb === 'closed' && J(s.keep) === J({ ls: 'false', ck: { sidebar_state: 'false', 'sidebar:state': null } }));
  t('scripts: CLICK_JS clicks once and reads what was stored right before', c.clicked === true && pg.clicks === 1 && pg.open && J(c.keep) === J(s.keep) && pg.S.store.get('sidebarOpen') === 'true' && pg.S.jar.get('sidebar_state') === 'true');
  const r = pg.exec(NEWP.RESTORE_JS(c.keep));
  t('scripts: RESTORE_JS puts sidebarOpen and the cookie back; the page stays open', r.ok && r.fixed && pg.S.store.get('sidebarOpen') === 'false' && pg.S.jar.get('sidebar_state') === 'false' && pg.open && pg.clicks === 1);
  t('scripts: nothing changed -> nothing written', (x => x.ok && !x.fixed)(pg.exec(NEWP.RESTORE_JS(NEWP.keepOf(pg.document, pg.window)))));
  const q = page(clock, { session: session(null, null), cookie: true }); const k = q.exec(NEWP.CLICK_JS).keep; q.exec(NEWP.RESTORE_JS(k));
  t('scripts: never set before -> removed again (sidebarOpen and the cookie)', q.open && !q.S.store.has('sidebarOpen') && !q.S.jar.has('sidebar_state'));
  t('scripts: no toggle -> clicked false, nothing touched', J(page(clock, { noToggle: true, ls: 'false' }).exec(NEWP.CLICK_JS)) === J({ clicked: false })); }
{ const evil = '"),alert(1),("', w = page({ t: 0 }, { ls: 'false' });
  const b = NEWP.clean({ ls: evil, ck: { sidebar_state: 'a;b=c', 'sidebar:state': 'true' } });
  t('clean: odd cookie values dropped, the rest kept; not a reading -> null', J(b) === J({ ck: { 'sidebar:state': 'true' }, ls: evil }) && NEWP.clean(null) === null && NEWP.clean({ ls: 'x' }) === null
    && !('ls' in NEWP.clean({ ls: 'x'.repeat(65), ck: {} })));
  w.exec(NEWP.RESTORE_JS({ ls: evil, ck: {} }));
  t('restore: a value goes in as JSON only (it cannot end the script)', w.S.store.get('sidebarOpen') === evil && NEWP.RESTORE_JS({ ls: evil, ck: {} }).includes(J(evil))); }

// ---- main.js's real sbOpen in a vm: fake clock, fake pages, the shared lock ----
const SB_SRC = fnSrc('sbOpen', 'async function ');
function harness(clock, hook) {
  const recs = [];
  const ctx = vm.createContext({ NEWP, gbRun: false, sbLock: null, quitting: false, diag: { rec: (...a) => recs.push(a) }, dlog: () => {},
    Date: { now: () => clock.t }, sleep: ms => { clock.t += ms; if (hook) hook(clock.t); return new Promise(r => setImmediate(r)); },
    sbJs: (wc, code) => Promise.resolve().then(() => wc.exec(code)) });
  vm.runInContext(SB_SRC, ctx);
  return { ctx, recs, codes: () => recs.map(r => r[1]) };
}
function pane(clock, pg, id = 1) {
  const p = { id, view: { webContents: { isDestroyed: () => false, getURL: () => pg.url, exec: pg.exec } }, inputRev: 0, lastInteract: clock.t, disposed: false };
  p.sb = NEWP.nav(NEWP.arm(clock.t, 0, clock.t), pg.url, clock.t);   // its first grok.com page (did-navigate); sbOpen = its did-finish-load
  return p;
}
async function flows() {
  { const clock = { t: 1000 }, pg = page(clock, { ls: 'false' }), p = pane(clock, pg), h = harness(clock);
    await h.ctx.sbOpen(p);
    t(`sbOpen: closed -> one click, open, sidebarOpen back to "false", lock free, never again (${h.codes()})`, pg.clicks === 1 && pg.open && pg.S.store.get('sidebarOpen') === 'false'
      && h.ctx.sbLock === null && p.sb === null && J(h.codes()) === J(['OPENED']) && h.recs[0][0] === 'newpane' && J(Object.keys(h.recs[0][2])) === J(['p', 'ms'])); }
  { const clock = { t: 1000 }, pg = page(clock, { ls: 'true' }), p = pane(clock, pg), h = harness(clock); await h.ctx.sbOpen(p);
    t('sbOpen: already open -> ALREADY, nothing clicked or written', pg.clicks === 0 && pg.S.store.get('sidebarOpen') === 'true' && !pg.log.length && J(h.codes()) === J(['ALREADY']) && p.sb === null); }
  { const clock = { t: 1000 }, pg = page(clock, { ls: 'false', ssrOpen: true, hydrateAt: 1900, readyIn: 0 }), h = harness(clock); await h.ctx.sbOpen(pane(clock, pg));
    t('sbOpen: rendered open, closed by the page right after -> still opened (OPENED), stored state as before', pg.clicks === 1 && pg.open && pg.S.store.get('sidebarOpen') === 'false' && J(h.codes()) === J(['OPENED'])); }
  { const clock = { t: 1000 }, pg = page(clock, { session: session(null, 'false'), cookie: true }), h = harness(clock); await h.ctx.sbOpen(pane(clock, pg));
    t('sbOpen: sidebarOpen never set -> removed again; the shadcn cookie back to "false"', pg.open && !pg.S.store.has('sidebarOpen') && pg.S.jar.get('sidebar_state') === 'false' && J(h.codes()) === J(['OPENED'])); }
  { const clock = { t: 1000 }, pg = page(clock, { ls: 'false', loseClick: true }), h = harness(clock); await h.ctx.sbOpen(pane(clock, pg));
    t('sbOpen: the click\'s own reading lost -> the last observation is put back', pg.clicks === 1 && pg.S.store.get('sidebarOpen') === 'false' && J(h.codes()) === J(['OPENED'])); }
  { const clock = { t: 1000 }, pg = page(clock, { ls: 'false', throwOnClick: true }), h = harness(clock); await h.ctx.sbOpen(pane(clock, pg));
    t(`sbOpen: an error after the click -> stored state still put back, lock free (${h.codes()})`, pg.S.store.get('sidebarOpen') === 'false' && h.ctx.sbLock === null && J(h.codes()) === J(['ERROR'])); }
  { const clock = { t: 1000 }, pg = page(clock, { mode: 'mobile', ls: 'false' }), h = harness(clock); await h.ctx.sbOpen(pane(clock, pg));
    t('sbOpen: narrow page -> its drawer opened, nothing stored or written back', pg.clicks === 1 && pg.open && pg.S.store.get('sidebarOpen') === 'false' && !pg.log.includes('A:cookie') && J(h.codes()) === J(['OPENED'])); }
  { const clock = { t: 1000 }, pg = page(clock, { ls: 'false' }), p = pane(clock, pg), h = harness(clock); p.inputRev = 1; await h.ctx.sbOpen(p);
    t('sbOpen: the user typed into the pane first -> USER, nothing clicked', pg.clicks === 0 && J(h.codes()) === J(['USER']) && p.sb === null); }
  { const clock = { t: 1000 }, pg = page(clock, { ls: 'false' }), p = pane(clock, pg), h = harness(clock, now => { if (now >= 1900) p.lastInteract = now; }); await h.ctx.sbOpen(p);
    t('sbOpen: the user clicked into the page while it settled -> USER, nothing clicked', pg.clicks === 0 && J(h.codes()) === J(['USER'])); }
  { const clock = { t: 1000 }, pg = page(clock, { ls: 'false' }), h = harness(clock); h.ctx.gbRun = true; await h.ctx.sbOpen(pane(clock, pg));
    t('sbOpen: the Grok bar read the whole time -> BUSY, nothing clicked', pg.clicks === 0 && J(h.codes()) === J(['BUSY']) && pg.S.store.get('sidebarOpen') === 'false'); }
  { const clock = { t: 1000 }, pg = page(clock, { ls: 'false' }); let h = null; h = harness(clock, now => { h.ctx.gbRun = now < 5000; }); await h.ctx.sbOpen(pane(clock, pg));
    t('sbOpen: the Grok bar read ends -> opened after it', pg.clicks === 1 && J(h.codes()) === J(['OPENED']) && pg.S.store.get('sidebarOpen') === 'false'); }
  { const clock = { t: 1000 }, pg = page(clock, { ls: 'false', noToggle: true }), h = harness(clock); await h.ctx.sbOpen(pane(clock, pg));
    t('sbOpen: no toggle (e.g. signed out) -> NOTOGGLE, nothing touched', pg.clicks === 0 && J(h.codes()) === J(['NOTOGGLE']) && !pg.log.length); }
  { const clock = { t: 1000 }, pg = page(clock, { ls: 'false' }), h = harness(clock, now => { if (now >= 1600) pg.url = 'https://accounts.x.ai/sign-in'; }); await h.ctx.sbOpen(pane(clock, pg));
    t('sbOpen: the page left grok.com -> MOVED, nothing clicked', pg.clicks === 0 && J(h.codes()) === J(['MOVED'])); }
  { const clock = { t: 1000 }, pg = page(clock, { ls: 'false' }), p = pane(clock, pg), h = harness(clock, now => { if (now >= 1600 && p.sb && p.sb.stage === 'run') p.sb = NEWP.nav(p.sb, HOME, now); });
    await h.ctx.sbOpen(p);
    t('sbOpen: a new grok.com page before the click -> this run ends silently (the new page gets its own run)', pg.clicks === 0 && !h.recs.length && NEWP.due(p.sb) && h.ctx.sbLock === null); }
  { const clock = { t: 1000 }, pg = page(clock, { ls: 'false' }), p = pane(clock, pg), h = harness(clock, now => { if (now >= 1600) p.disposed = true; });
    await h.ctx.sbOpen(p); t('sbOpen: the pane closed before the click -> ends, nothing clicked', pg.clicks === 0 && J(h.codes()) === J(['MOVED']) && h.ctx.sbLock === null); }
  { const clock = { t: 1000 }, S = session('false'), log = [], a = page(clock, { session: S, log, name: 'A' }), b = page(clock, { session: S, log, name: 'B' }), h = harness(clock);
    await Promise.all([h.ctx.sbOpen(pane(clock, a, 1)), h.ctx.sbOpen(pane(clock, b, 2))]);
    t(`sbOpen: two new panes at once -> one at a time, each put back before the next click (${log.join(' ')})`, a.open && b.open && S.store.get('sidebarOpen') === 'false'
      && J(log.filter(x => /click|restore/.test(x))) === J(['A:click', 'A:restore', 'B:click', 'B:restore']) && J(h.codes()) === J(['OPENED', 'OPENED']) && h.ctx.sbLock === null); }
}

// ---- main.js wiring ----
function wiring() {
  const add = fnSrc('addPane');
  t('main: addPane decides with NEWP.start(spec.url, from) before the URL is taken; the pane is armed only then', /const st = NEWP\.start\(spec\.url, from\);\s*\n\s*if \(st\.sidebar\) spec = \{ \.\.\.spec, url: st\.url \};/.test(add)
    && /url: paneStart\(normalize\(spec\.url\)\)/.test(add) && /p\.sb = st\.sidebar \? NEWP\.arm\(Date\.now\(\), p\.inputRev, p\.lastInteract\) : null;/.test(add) && /from = '' \} = \{\}\) \{/.test(add));
  t('main: its first page -> NEWP.nav (did-navigate); loaded -> sbOpen when due', /wc\.on\('did-navigate', \(e, u\) => \{ if \(p\.sb\) p\.sb = NEWP\.nav\(p\.sb, u, Date\.now\(\)\); \}\);/.test(add) && /onGrokLoad\(p\);\s*\n\s*if \(NEWP\.due\(p\.sb\)\) sbOpen\(p\);/.test(add));
  const empties = [...main.matchAll(/addPane\(\{ url: '' \}(?:, (\{[^}]*\}))?\)/g)];
  t(`main: every empty addPane (${empties.length}: preset / last pane closed / empty workspace / empty window) is 'fill'`, empties.length === 4 && empties.every(m => /from: 'fill'/.test(m[1] || '')));
  t('main: ＋ / ⌘T / palette go through newPane -> addPane from \'new\'; at 10 panes the focused pane as before (no new pane)', /addPane\(\{ url \}, \{ from: 'new' \}\)/.test(fnSrc('newPane'))
    && /if \(panes\.length >= MAX\) \{ const p = panes\[focused\]; if \(p\) openIn\(p, url\); return; \}/.test(fnSrc('newPane')) && /on\('add', \(\) => newPane\(''\)\)/.test(main)
    && /acc\('CmdOrCtrl\+T', \(\) => cur\(\)\?\.newPane\(''\)/.test(main) && /if \(k === 't'\) \{ closeOverlay\(\); newPane\(''\); return true; \}/.test(main) && /case 'open-new': closeOverlay\(\); newPane\(/.test(main));
  t('main: ⌘N / palette 新しいウィンドウ without a URL -> a window with no pane -> its empty pane', /accelerator: 'CmdOrCtrl\+N', click: \(\) => makeWindow\(\{ layout: '2x2', panes: \[\] \}\)/.test(main)
    && /case 'new-window': closeOverlay\(\); makeWindow\(\{ layout: '2x2', panes: a\.url \? \[\{ url: String\(a\.url\) \}\] : \[\] \}\);/.test(main)
    && /specs\.slice\(0, MAX\)\.forEach\(s => addPane\(s, \{ focus: false, defer: true, asleep: restore \? restorePlan\(s\) : null \}\)\);[^\n]*\n\s*if \(!panes\.length\) addPane\(\{ url: '' \}, \{ focus: false, defer: true, from: 'fill' \}\);/.test(main));
  const other = [...main.matchAll(/addPane\((?!\{ url: '' \})[^\n]*/g)].map(m => m[0]).filter(s => !/^addPane\(\{ url \}, \{ from: 'new' \}\)/.test(s) && !/^addPane\(spec = \{\}/.test(s));
  t(`main: restore / workspace / ⌘⇧T / 複製 / links (${other.length}) carry no from -> as before`, other.length >= 5 && other.every(s => !/from:/.test(s)));
  const gr = fnSrc('grokRefresh', 'async function ');
  t('main: the Grok bar read reads / clicks nothing while an opening holds sidebarOpen (bounded by its own timeout)', /if \(sbLock && Date\.now\(\) - t0 < GB\.TIMEOUT_MS\) continue;[^\n]*\n\s*const o = await gbJs\(wc, GB\.STATE_JS\);/.test(gr));
  const sb = SB_SRC;
  t('main: sbOpen clicks only with the lock, puts the stored state back before letting it go, then never again', /sbLock = tok; p\.sb = \{ \.\.\.p\.sb, clicked: true \};/.test(sb)
    && /if \(sbLock === tok\) \{\s*\n\s*if \(keep && !wc\.isDestroyed\(\) && NEWP\.onGrok\(wc\.getURL\(\)\)\) back = await sbJs\(wc, NEWP\.RESTORE_JS\(keep\)\);\s*\n\s*sbLock = null;/.test(sb)
    && /if \(p\.sb && p\.sb\.tok === tok\) p\.sb = null;/.test(sb) && /busy: gbRun \|\| !!sbLock \|\| quitting/.test(sb));
  t('main: the scripts run in their own world with a time limit', /const sbJs = \(wc, code\) => Promise\.race\(\[Promise\.resolve\(\)\.then\(\(\) => wc\.executeJavaScriptInIsolatedWorld\(NEWP\.WORLD, \[\{ code \}\]\)\), sleep\(3000\)\.then\(\(\) => null\)\]\)\.catch\(\(\) => null\);/.test(main));
  const win = main.indexOf('// ======================= one app window');
  t('main: NEWP / sbLock are top-level (all windows); sbOpen is in the window code', main.indexOf("const NEWP = require('./new-pane');") > 0 && main.indexOf("const NEWP = require('./new-pane');") < win
    && main.indexOf('let sbLock = null;') < win && main.indexOf('async function sbOpen(') > win);
  t('main: diagnostics get fixed codes only', /diag\.rec\('newpane', code, \{ p: p\.id, ms: Date\.now\(\) - t0 \}\);/.test(sb) && /diag\.rec\('newpane', 'RESTORE_FAIL', \{ p: p\.id \}\);/.test(sb));
}
// newPane itself (vm, side effects stubbed): what reaches addPane
function newPaneRun() {
  const calls = [], opens = [];
  const ctx = vm.createContext({ MAX: 10, panes: [], focused: 0, maximizedId: 1, relayout: () => {}, setTimeout: fn => fn(), openIn: (...a) => opens.push(a),
    addPane: (spec, opt) => { calls.push([spec, opt]); const p = { id: calls.length, view: { webContents: { isDestroyed: () => false, focus: () => {} } } }; ctx.panes.push(p); return p; } });
  vm.runInContext(fnSrc('newPane'), ctx);
  ctx.newPane(''); ctx.newPane('https://grok.com/bot/abc');
  t('newPane: \'\' and a URL both reach addPane as from \'new\' (start() keeps the URL)', J(calls) === J([[{ url: '' }, { from: 'new' }], [{ url: 'https://grok.com/bot/abc' }, { from: 'new' }]])
    && J(calls.map(([s, o]) => NEWP.start(s.url, o.from))) === J([{ url: HOME, sidebar: true }, { url: 'https://grok.com/bot/abc', sidebar: false }]));
  while (ctx.panes.length < 10) ctx.panes.push({ id: 100 + ctx.panes.length }); ctx.focused = 3; ctx.newPane('');
  t('newPane at 10 panes: no new pane (the focused one, as before)', calls.length === 2 && opens.length === 1 && opens[0][1] === '');
}

// ---- codes / worlds ----
t('diagnostics: newpane codes = new-pane.js CODES, all accepted by the event', J([...DG.NEWPANE_CODES].sort()) === J([...NEWP.CODES].sort()) && NEWP.CODES.every(c => DG.EVENTS.newpane.r.includes(c)));
t('its isolated world is its own (1001-1006 are taken)', NEWP.WORLD === 1007 && ![GB.WORLD, CB.WORLD, UW.WORLD, 1001, 1002, 1003].includes(NEWP.WORLD) && !new RegExp('IsolatedWorld\\(1007').test(main));

wiring(); newPaneRun();
flows().then(() => { console.log(bad ? bad + ' failed' : 'all passed'); process.exit(bad ? 1 : 0); }, e => { console.log('FAIL threw', e && e.stack); process.exit(1); });

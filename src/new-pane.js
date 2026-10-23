// 新規ペインはGrok: an empty new pane (＋ / ⌘T / the palette's 新しい空のペイン / ⌘N and the palette's 新しいウィンドウ / the panes a layout preset
// adds / the pane that replaces the last one closed / an empty workspace or window) opens https://grok.com/ instead of the local new-tab page, and
// on that pane's first grok.com page its sidebar is opened once: only when the page shows it closed, by a click on grok.com's own toggle
// ([data-sidebar="trigger"] or, on a narrow page, the header button "サイドバーを切り替え" / "Toggle Sidebar", as the user would) - never again for that pane (later pages, reloads, wakes, the user closing it). Pure rules and
// the fixed page-side code, no electron (test/new-pane.test.js); main.js runs them (addPane / sbOpen).
// The toggle makes grok.com store its state for the next load (`sidebarOpen` in localStorage - shared by every pane of the default session - and
// the shadcn sidebar cookie if it ever uses one): what was there right before the click is put back right after it, so every other pane loads its
// sidebar as before. One opening at a time in all windows, never while the Grok bar's read runs (it undoes its own clicks the same way and waits
// for this one). A pane with a URL (Grok bar / favorites / links / ⌘⇧T / 複製 / restore / workspaces) is not touched. Nothing here is logged.
const { HOME, navOk: onGrok } = require('./grok-bots');       // grok.com's home page / an https://grok.com page (no port / user info)

const WORLD = 1007;            // main.js: the isolated world of the scripts below (1001-1006 are taken)
const FRESH = ['new', 'fill']; // where an empty new pane comes from: the user asked for one (＋ / ⌘T / palette / a new window) / the app adds one
                               // so there is one (a layout preset, the last pane closed, an empty workspace / window). Anything else keeps its URL
const ARM_MS = 120000;         // the pane's first grok.com page must come this soon after the pane was made (it may wait in the load queue)
const POLL_MS = 300;           // main looks at the page this often
const SETTLE_MS = 1200;        // the page must show the same (open / closed with a toggle) this long, once ready, before anything is done
const GIVEUP_MS = 20000;       // from the page's load: nothing decided by then -> nothing is clicked
const CONFIRM_MS = 2500;       // after the click: seen open within this long (else UNSURE); the stored state is put back either way
const COOKIES = ['sidebar_state', 'sidebar:state'];          // shadcn's sidebar cookie (current / older name)
// outcome codes (= diagnostics.js NEWPANE_CODES, checked by the test): opened by the click / found open / no toggle or no decision in time /
// clicked but open not seen / the page went elsewhere / the user used the pane first / the shared state busy the whole time / the stored state
// not confirmed back / an error. Nothing was clicked unless OPENED / UNSURE
const CODES = ['OPENED', 'ALREADY', 'NOTOGGLE', 'UNSURE', 'MOVED', 'USER', 'BUSY', 'RESTORE_FAIL', 'ERROR'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const blank = u => typeof u !== 'string' || !u.trim();

// (a new pane's spec URL, where it comes from) -> { url, sidebar }: only an empty new pane changes (grok.com, its sidebar opened once)
const start = (url, from) => blank(url) && FRESH.includes(from) ? { url: HOME, sidebar: true } : { url, sidebar: false };

// ---- the pane's one opening (p.sb in main, memory only): armed when the pane is made, gone (null) once done / never possible ----
// at: when it was made; rev / ia: the pane's input revision / last interaction then (anything typed / clicked since = the user is using the pane)
const arm = (now, rev = 0, ia = now) => ({ stage: 'armed', at: now, rev, ia, clicked: false, tok: null });
// a new page in the pane (did-navigate, main frame) -> a grok.com page in time waits for its load ('nav'; a grok.com page replaced before the
// click - a redirect / challenge / reload - starts over on the new one); anything else, or after the click: null (never again)
function nav(s, url, now) {
  if (!isObj(s) || s.clicked || !(now - s.at <= ARM_MS) || !onGrok(url)) return null;
  return { ...s, stage: 'nav', tok: null };
}
const due = s => isObj(s) && s.stage === 'nav' && !s.clicked;   // its page has loaded (did-finish-load): the opening may run
const used = (s, p) => isObj(s) && isObj(p) && (p.inputRev !== s.rev || p.lastInteract > s.ia);   // typed / clicked into the pane since it was made

// ---- one run on the loaded page (main: sbOpen), driven by plain observations like the Grok bar's read ----
const begin = now => ({ t0: now, readyAt: 0, v: '', vAt: 0, clickAt: 0 });
// rs + one observation (STATE_JS + main: grok = the pane is still on grok.com, user = used(), busy = the Grok bar's read / another opening /
// quitting) -> { act, code, rs }. act: 'wait' / 'click' (once) / 'restore' (after the click: put the stored state back, then end with code) /
// 'end' (code; nothing was clicked). The verdict is 'open' (seen open), 'closed' (not seen open, a toggle there) or '' (not known yet); it must
// hold SETTLE_MS after the page is ready (a server-rendered default that the page's own script changes right after must not be acted on)
function decide(rs, o, now) {
  const r = { ...rs }, out = (act, code = '') => ({ act, code, rs: r });
  o = isObj(o) ? o : {};
  if (r.clickAt) return o.sb === 'open' ? out('restore', 'OPENED') : now - r.clickAt >= CONFIRM_MS ? out('restore', 'UNSURE') : out('wait');
  if (o.grok === false) return out('end', 'MOVED');
  if (o.user === true) return out('end', 'USER');
  if (now - r.t0 > GIVEUP_MS) return out('end', o.busy === true && r.v === 'closed' ? 'BUSY' : 'NOTOGGLE');
  if (o.ready !== true) { r.v = ''; r.vAt = now; return out('wait'); }
  if (!r.readyAt) r.readyAt = now;
  const v = o.sb === 'open' ? 'open' : o.trig === true ? 'closed' : '';
  if (v !== r.v) { r.v = v; r.vAt = now; }
  if (!v || now - Math.max(r.readyAt, r.vAt) < SETTLE_MS) return out('wait');
  if (v === 'open') return out('end', 'ALREADY');
  if (o.busy === true) return out('wait');                     // the stored state is someone else's right now: after it (or BUSY)
  r.clickAt = now;
  return out('click');
}

// ---- the page side (fixed code; main puts in only the JSON value clean() returns). Run in the pane's own world (WORLD) ----
// The sidebar as the page shows it -> { ready, trig, sb }. Self-contained (also run in Node on a tiny fake DOM). trig: a toggle in the page.
// sb: 'open' = a left sidebar ([data-sidebar="sidebar"]) at least 160 px wide on screen and not marked collapsed / closed by its own wrapper
// (data-state on it or up to 3 levels up: shadcn's desktop wrapper / the narrow page's sheet); 'closed' = there but not so (off screen, as narrow
// as its icons, collapsed); 'none' = not in the page (a narrow page's closed drawer, or not rendered yet)
function sidebarState(doc, win) {
  const all = s => Array.from(doc.querySelectorAll(s));
  const near = (e, k) => { for (let x = e, d = 0; x && d < 4; x = x.parentElement, d++) if (x.hasAttribute && x.hasAttribute(k)) return x.getAttribute(k) || ''; return ''; };
  const W = Number(win.innerWidth) || 0;
  const shown = e => {
    const st = near(e, 'data-state'); if (st === 'collapsed' || st === 'closed') return false;
    let r = null; try { r = e.getBoundingClientRect(); } catch (x) {}
    return !!r && r.width >= 160 && r.height > 0 && r.right > 40 && r.left < W - 40;
  };
  const side = all('[data-sidebar="sidebar"]').filter(e => near(e, 'data-side') !== 'right');
  return { ready: doc.readyState === 'complete', trig: all('[data-sidebar="trigger"],button[aria-label="サイドバーを切り替え"],button[aria-label="Toggle Sidebar"],button[aria-label="Toggle sidebar"]').length > 0, sb: side.some(shown) ? 'open' : side.length ? 'closed' : 'none' };
}
// what grok.com stores of the sidebar -> { ls: sidebarOpen or null, ck: { name: value or null } }. Self-contained
function keepOf(doc, win) {
  let ls = null; try { ls = win.localStorage.getItem('sidebarOpen'); } catch (e) {}
  let all = ''; try { all = String(doc.cookie || ''); } catch (e) {}
  const ck = {};
  for (const k of ['sidebar_state', 'sidebar:state']) { const m = all.split(';').map(s => s.trim()).find(s => s.indexOf(k + '=') === 0); ck[k] = m === undefined ? null : m.slice(k.length + 1); }
  return { ls, ck };
}
// put back what was stored before the click (b = clean()); only what differs now is written (a cookie the way shadcn writes it: path=/, 7 days)
// -> { ok: all as before, fixed: something had to be written }. Self-contained (keep = keepOf)
function putBack(doc, win, b, keep) {
  if (!b) return { ok: false, fixed: false };
  const now = keep(doc, win), has = k => Object.prototype.hasOwnProperty.call(b, k);
  let fixed = false;
  if (has('ls') && now.ls !== b.ls) { fixed = true; try { if (b.ls === null) win.localStorage.removeItem('sidebarOpen'); else win.localStorage.setItem('sidebarOpen', b.ls); } catch (e) {} }
  for (const k of Object.keys(b.ck)) if (now.ck[k] !== b.ck[k]) { fixed = true; try { doc.cookie = b.ck[k] === null ? k + '=; path=/; max-age=0' : k + '=' + b.ck[k] + '; path=/; max-age=604800'; } catch (e) {} }
  const a = keep(doc, win);
  return { ok: (!has('ls') || a.ls === b.ls) && Object.keys(b.ck).every(k => a.ck[k] === b.ck[k]), fixed };
}
// a value read from the page -> what RESTORE_JS may put back: sidebarOpen up to 64 characters (else left as it is), cookies with a plain value
// only (anything else is left alone); null = not a reading at all
function clean(b) {
  if (!isObj(b) || !isObj(b.ck)) return null;
  const c = { ck: {} };
  if (b.ls === null || (typeof b.ls === 'string' && b.ls.length <= 64)) c.ls = b.ls;
  for (const k of COOKIES) { const v = b.ck[k]; if (v === null || (typeof v === 'string' && /^[A-Za-z0-9_.-]{0,32}$/.test(v))) c.ck[k] = v; }
  return c;
}
// STATE_JS -> sidebarState + keep (what is stored now: the fallback "before" if the click's own reading is lost)
const STATE_JS = `(()=>{/*mpb:np-state*/return Object.assign((${sidebarState})(document,window),{keep:(${keepOf})(document,window)});})()`;
// CLICK_JS: the toggle on screen (else the first one) clicked once -> { clicked, keep: what was stored right before the click }
const CLICK_JS = `(()=>{/*mpb:np-open*/const W=Number(window.innerWidth)||0;const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.right>0&&r.left<W;};
const ts=Array.from(document.querySelectorAll('[data-sidebar="trigger"],button[aria-label="サイドバーを切り替え"],button[aria-label="Toggle Sidebar"],button[aria-label="Toggle sidebar"]'));const t=ts.find(vis)||ts[0];if(!t)return{clicked:false};
const keep=(${keepOf})(document,window);t.click();return{clicked:true,keep};})()`;
const RESTORE_JS = b => `(()=>{/*mpb:np-restore*/return (${putBack})(document,window,${JSON.stringify(clean(b))},${keepOf});})()`;

module.exports = { HOME, WORLD, FRESH, ARM_MS, POLL_MS, SETTLE_MS, GIVEUP_MS, CONFIRM_MS, COOKIES, CODES,
  start, arm, nav, due, used, begin, decide, onGrok, sidebarState, keepOf, putBack, clean, STATE_JS, CLICK_JS, RESTORE_JS };

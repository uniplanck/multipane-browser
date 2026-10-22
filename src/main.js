const { app, BrowserWindow, WebContentsView, ipcMain, Menu, Notification, nativeTheme, screen, clipboard, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// dev/test hook: MPB_SWITCHES="name=value;name2" appends Chromium switches before the app is ready
for (const sw of String(process.env.MPB_SWITCHES || '').split(';').filter(Boolean)) { const i = sw.indexOf('='); i < 0 ? app.commandLine.appendSwitch(sw) : app.commandLine.appendSwitch(sw.slice(0, i), sw.slice(i + 1)); }
// dev/test hook: MPB_USER_DATA=/absolute/dir runs on its own profile (userData + sessionData: panes.json, cookies, storage), never the real one
if (process.env.MPB_USER_DATA && path.isAbsolute(process.env.MPB_USER_DATA)) { app.setPath('userData', process.env.MPB_USER_DATA); app.setPath('sessionData', process.env.MPB_USER_DATA); }
// Memory saver (measured, 8 grok.com panes): std = small V8 young generation + optimize-for-size  (-~730MB / -20%, no behaviour change)
// max = std + process-per-site (all same-site panes share one renderer: -~1.7GB, but panes then share one JS thread and one crash) .
// Must be decided before app ready, so settings.memSaver is read synchronously from panes.json here. Values: 'off' | 'std' (default) | 'max'.
let MEM_MODE = 'std';
try { const m = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'panes.json'), 'utf8'))?.settings?.memSaver; if (['off', 'std', 'max'].includes(m)) MEM_MODE = m; } catch {}
if (process.env.MPB_MEMSAVER && ['off', 'std', 'max'].includes(process.env.MPB_MEMSAVER)) MEM_MODE = process.env.MPB_MEMSAVER;
if (MEM_MODE !== 'off') {
  app.commandLine.appendSwitch('js-flags', '--max-semi-space-size=1 --min-semi-space-size=1 --optimize-for-size');
  if (MEM_MODE === 'max') app.commandLine.appendSwitch('process-per-site');
}
const isMac = process.platform === 'darwin';
const MAX = 10;
const TOPBAR = 76;        // top bar (traffic lights + layout + pane strip) + favorites bar
const PHEAD = 30;         // per-pane header
const GAP = 6;            // gutter between pane cards
const BOTTOM_GAP = 5;     // margin below the bottom row only (~20% under GAP; 4.8 rounds to whole px)
const RADIUS = 8;
const DEFAULT_URL = 'https://www.google.com';
const NEWTAB = 'mpb:newtab';                        // internal marker, persisted as ''
const NEWTAB_FILE = path.join(__dirname, 'newtab.html');
const RELOAD_CHOICES = [0, 1, 5, 15, 30];
const TYPING_GRACE_MS = 2 * 60 * 1000;
const PRESETS = { '2x1': [2, 1], '3x1': [3, 1], '4x1': [4, 1], '2x2': [2, 2], '3x2': [3, 2], '4x2': [4, 2], '3x3': [3, 3], '5x2': [5, 2] };
const PRESET_KEYS = Object.keys(PRESETS);
const COLORS = { none: null, red: '#ff5f57', orange: '#ff9f0a', yellow: '#ffd60a', green: '#30d158', teal: '#40c8e0', blue: '#0a84ff', purple: '#bf5af2', pink: '#ff375f' };
const COLOR_JA = { none: 'なし', red: '赤', orange: 'オレンジ', yellow: '黄', green: '緑', teal: '水色', blue: '青', purple: '紫', pink: 'ピンク' };

let settings = { notifications: false, ecoMode: true, debugLog: false, grokFix: true, theme: 'system' };   // ecoMode: unused (no CPU throttling, see 'load reduction'); kept so panes.json reads / writes as before
let workspaces = {};        // name -> { layout, panes: [spec] }
let favorites = [];         // [{ id, url, label }]
let nextFavId = 1, nextPaneId = 1;
const ctxs = [];           // one per app window
let saveTimer;

// ---- debug log (MPB_DEBUG=1 or 設定メニュー) -> userData/pane-debug.log ----
const debugOn = () => settings.debugLog || !!process.env.MPB_DEBUG;
function dlog(...a) {
  if (!debugOn()) return;
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'pane-debug.log'), line); } catch {}
  if (process.env.MPB_DEBUG) process.stdout.write(line);
}
// ---- diagnostics (#73, diagnostics.js): fixed event / result codes, ms, attempts and per-launch pane numbers only; never page content, names,
// URLs, paths or error text. Always a memory ring; files only with 設定 > 診断ログをファイルにも保存 or MPB_DEBUG, in userData/diagnostics
// (pane-debug.log above is separate and unchanged). diag.rec never throws and a failing disk never stops anything.
const DIAG = require('./diagnostics');
const diag = DIAG.createDiag();
function diagSync() { const forced = !!process.env.MPB_DEBUG; diag.setDisk(settings.diagPersist === true || forced ? path.join(app.getPath('userData'), 'diagnostics') : null, forced && settings.diagPersist !== true); }

// Clean Chrome UA (no "Electron/x" or app name) so sites don't treat us as an unknown embedder.
function chromeUA() {
  const os = isMac ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  const major = process.versions.chrome.split('.')[0];
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// ---- persistence (backward compatible: layout/focused/urls are always written and read) ----
// state-store.js is the only writer of panes.json (temp file + fsync + rename, numbered requests, 3 good generations) and state-schema.js
// migrates / validates it. When the file cannot be used (broken / newer version) nothing is read from it or written over it until the user decides.
const { rotateBackup } = require('./state-backup');
const { createStore } = require('./state-store');
const { emptyDoc } = require('./state-schema');
const stateFile = () => path.join(app.getPath('userData'), 'panes.json');
const QUIT_FLUSH_MS = 3000;                                // a normal quit waits at most this long for the last save
let store = null;                                          // created in startup()
let saveFails = 0;                                         // failed save attempts in a row (diagnostics)
const paneSpec = p => ({ url: paneUrl(p), reloadMinutes: p.reloadMinutes, name: p.name || '', color: p.color || 'none', muted: !!p.muted, zoom: p.zoom || 1, zoomIndiv: !!p.zoomIndiv, sleep: p.sleepOn !== false });
// ---- 前回のスリープ状態を復元 (#22, session-snapshot.js; settings.restoreSleep, default off): a window's own save adds the snap of a sleeping pane
// (workspaces / ↩ / 複製 use paneSpec alone); at startup (store ready only) such a pane starts asleep without loading (makeWindow: restoreAsleep).
// p.restored: what it was restored with, until it wakes / a background check finds something new (memory only). Off: no snap written or read
const SS = require('./session-snapshot');
function paneSave(p, now = Date.now()) {
  const s = paneSpec(p);
  if (settings.restoreSleep !== true || !p.sleeping) return s;
  const r = p.restored, id = p.sleepSnap || {};
  const snap = SS.make({ sleeping: true, mk: r ? r.mk : SS.markOf(p), ob: r ? r.ob : p.markAt || p.sleepAt, nm: id.name, gp: id.group, q: r ? r.q : p.reqQuote },
    now, { quote: settings.saveQuote === true });   // the quote only with 設定 > スリープ中の引用も保存; turned off: gone with the next save
  return snap ? { ...s, snap } : s;
}
const restorePlan = s => SS.plan(s, Date.now(), { enabled: settings.restoreSleep === true, ready: !!store && store.writable(), quote: settings.saveQuote === true });
function stateDoc() {
  const wins = ctxs.map(c => c.snapshot());
  const first = wins[0] || lastClosedSnapshot || { layout: '2x2', focused: 0, panes: [] };
  return { windows: wins.length ? wins : [first], favorites: favorites.map(({ url, label }) => ({ url, label })), grok, settings, workspaces };
}
function saveNow() { if (store?.writable()) store.save(stateDoc()); }
const storeState = () => store ? { status: store.info().status, saveError: store.info().saveError } : null;
let lastClosedSnapshot = null;
let quitting = false;
function save() { if (quitting) return; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 200); }
// A pane that is still waiting in the startup queue, mid-redirect or on an error page reports about:blank / '' / chrome-error:.
// That must never be saved, reopened or reloaded: fall back to the pane's own intended URL (p.url follows the last real page).
const BOT_URL_RE = /^https:\/\/grok\.com\/bot\/[A-Za-z0-9_-]+\/?(?:[?#].*)?$/;
const isBlankUrl = u => !u || u === 'about:blank' || /^chrome-error:/.test(u);
function paneUrl(p) {
  const keep = p.url === NEWTAB ? '' : (isBlankUrl(p.url) ? '' : p.url);
  if (!p.view || p.view.webContents.isDestroyed()) return keep;
  const u = p.view.webContents.getURL();
  if (isBlankUrl(u)) return p.botTarget && keep && !BOT_URL_RE.test(keep) ? p.botTarget : keep;
  if (p.botTarget && (p.grokToken || p.grokPending) && /^https:\/\/grok\.com\/?$/.test(u)) return p.botTarget;   // mid-fix hop through the home page
  return u.startsWith('file:') && u.includes('newtab.html') || u === NEWTAB ? '' : u;
}

function normalize(u) {
  u = (u || '').trim();
  if (!u) return NEWTAB;
  if (/^[a-z]+:\/\//i.test(u) || u.startsWith('about:')) return u;
  if (/^[^\s]+\.[^\s]+$/.test(u) && !/\s/.test(u)) return 'https://' + u;
  return 'https://www.google.com/search?q=' + encodeURIComponent(u);
}
function loadInto(wc, url) {
  const u = url === NEWTAB ? NEWTAB : normalize(url);
  if (u === NEWTAB) wc.loadFile(NEWTAB_FILE).catch(() => {}); else appLoad(wc, u);   // (#72) a web page / about:blank only
}
// (#72) a URL a new / restored pane may start with; anything else (javascript: / file: / chrome: / a user name ...) opens the new-tab page
const paneStart = u => u === NEWTAB || !NAV.appLoad(u) ? u : NEWTAB;


// ======================= global (all windows) =======================
function broadcast() { ctxs.forEach(c => c.sendState()); }
function updateDockBadge() {
  const n = ctxs.reduce((a, c) => a + c.panes.filter(p => !p.muted).reduce((b, p) => b + (p.msgMode && p.needsReply ? (p.unread || 0) : 0), 0), 0);
  if (isMac) app.dock?.setBadge(n ? String(n) : '');
  else app.setBadgeCount?.(n);
}
// ---- notifications (#61, notification-policy.js): only the delivery of an alert a window already decided (canAlert + pane-state alert).
// One delivery per event (pane id + generation + kind + report key), candidates within NP.WINDOW_MS go out as one (one pane: its own
// notification; more: 「Bots：確認待ち n件」 without names), app notifications off / a muted pane / quiet hours consume the candidate (nothing
// comes out afterwards). Glow / unread / Dock badge / unopened are never changed here; a click never marks anything read.
// Dev: MPB_NOTIFY_DRYRUN=1 shows no OS notification (debug log + diagnostics only).
const NP = require('./notification-policy');
const NOTIFY_DRYRUN = !!process.env.MPB_NOTIFY_DRYRUN;
let notices = NP.createState(), noticeTimer = null;
const noticeGate = () => ({ muted: !settings.notifications, quiet: settings.quietHours });
const ctxOf = p => ctxs.find(c => !c.win.isDestroyed() && c.panes.includes(p));
function frontWin(w) { if (!w || w.isDestroyed()) return; if (w.isMinimized()) w.restore(); w.show(); app.focus({ steal: true }); w.focus(); }
function noticeArm(ms) { clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { noticeTimer = null; noticeTake(); }, Math.max(0, ms)); }
function noticeOffer(p, kind, key, body, title) {           // a window's pane alerts now (lightUp / background check)
  noticeTake();                                            // a due window goes out first: this candidate starts the next one
  const g = noticeGate(); if (p.muted) g.muted = true;
  const r = NP.offer(notices, { pane: p.id, gen: p.obs.gen, kind, key, p, body, title }, Date.now(), g);
  notices = r.st;
  if (r.code === 'OPEN') noticeArm(NP.WINDOW_MS);
  else if (r.code === 'DUP' || r.code === 'MUTED' || r.code === 'QUIET') diag.rec('notify', r.code, { p: p.id }, 60000);
  dlog(`pane${p.id}`, 'notify', kind, r.code);
}
function noticeTake() {
  const r = NP.take(notices, Date.now(), noticeGate());
  if (r.code === 'WAIT') { if (!noticeTimer) noticeArm(r.due - Date.now()); return; }
  if (!r.code) return;
  notices = r.st;
  if (r.code !== 'DUE') { diag.rec('notify', r.code, { n: r.items.length }); return; }   // turned off / quiet hours began meanwhile: consumed
  const live = r.items.filter(it => {                      // the pane closed, muted or in front of the user meanwhile: not delivered
    const c = ctxOf(it.p), drop = !c || it.p.obs.closed ? 'GONE' : it.p.muted ? 'MUTED' : c.inView(it.p) ? 'SEEN' : '';
    if (drop) diag.rec('notify', drop, { p: it.pane });
    return !drop;
  });
  const m = NP.compose(live); if (!m) return;
  diag.rec('notify', m.n === 1 ? 'SENT' : 'MERGED', { p: m.n === 1 ? m.item.pane : 0, n: m.n });
  dlog('notify', m.n === 1 ? `pane${m.item.pane}` : 'merged', m.n, NOTIFY_DRYRUN ? '(dry run)' : '');
  if (NOTIFY_DRYRUN || !Notification.isSupported()) return;
  const n = new Notification(m.n === 1 ? { title: m.item.title, body: m.item.body, silent: false } : { title: m.title, body: m.body, silent: false });
  n.on('click', () => noticeClick(m));
  n.show();
}
// one pane: the same pane (id), still open, in the generation it was sent for -> its window in front + focus (a sleeping pane wakes; not marked
// read). Otherwise (merged / closed / changed) only the app comes to the front; never another pane in its place.
function noticeClick(m) {
  const it = m.n === 1 ? m.item : null, list = it ? [it] : m.items;
  const c = list.map(x => ctxOf(x.p)).find(Boolean) || ctxs.find(k => !k.win.isDestroyed());
  if (!c) return;
  const ok = !!it && NP.clickOk(it, it.p) && ctxOf(it.p) === c;
  diag.rec('notify', !it ? 'FRONT' : ok ? 'OPEN' : 'STALE', { p: it ? it.pane : 0 });
  frontWin(c.win);
  if (ok) c.openPane(it.p);
}
function quietMenu() {                                     // (#61) quiet hours: off or a preset, local time (a saved other range is listed as is)
  const q = NP.quietOf(settings.quietHours), set = v => { settings.quietHours = v; save(); buildMenu(); };
  const list = NP.QUIET_PRESETS.map(([from, to]) => ({ from, to }));
  if (q.on && !list.some(x => x.from === q.from && x.to === q.to)) list.push({ from: q.from, to: q.to });
  return { label: `静音時間（${q.on ? `${q.from}〜${q.to}` : 'オフ'}・この間の通知は出さず、明けてもまとめて出さない）`, submenu: [
    { label: 'オフ', type: 'radio', checked: !q.on, click: () => set({ ...q, on: false }) },
    ...list.map(x => ({ label: `${x.from}〜${x.to}`, type: 'radio', checked: q.on && q.from === x.from && q.to === x.to, click: () => set({ on: true, ...x }) }))] };
}
// ---- IPC boundary (#71): ipc-policy.js decides. Every page main creates is registered here with its role and owner (window / pane), and
// ipcOn / ipcHandle are the only listeners: a message counts only from a registered, live sender in its top frame showing the expected page,
// with a valid payload for an existing target of its own window. Anything else is dropped without side effects (debug log: code + channel + role).
const IPC = require('./ipc-policy');
const wcReg = new Map();                                   // webContents id -> { wc, role, ctx, pane?, onCount? }
function regWc(wc, role, extra) {
  const id = wc.id, r = { wc, role, ...extra }; wcReg.set(id, r);
  wc.once('destroyed', () => { if (wcReg.get(id) === r) wcReg.delete(id); });
  return r;
}
function unregWc(pred) { for (const [id, r] of wcReg) if (pred(r)) wcReg.delete(id); }
function ipcSender(e) {                                    // who sent it, from main's own registry (the payload never names the sender)
  let reg = null, frame = null;
  try { const r = wcReg.get(e.sender.id); if (r && r.wc === e.sender && !e.sender.isDestroyed()) reg = r; } catch {}
  try { const f = e.senderFrame; if (f && !f.isDestroyed()) frame = { top: f.parent === null, detached: f.detached, url: f.url, origin: f.origin }; } catch {}
  return { reg, sender: { role: reg ? reg.role : null, frame } };
}
const ipcWorld = r => ({
  owned: !!r && ctxs.includes(r.ctx) && !r.ctx.win.isDestroyed() && (!r.pane || r.ctx.panes.includes(r.pane)),
  pane: id => !!r && r.ctx.panes.some(p => p.id === id),
  fav: id => favorites.some(f => f.id === id),
  gbot: id => grok.bots.some(b => b.id === id),
  ws: name => Object.hasOwn(workspaces, name),
  winPane: (wid, pid) => ctxs.some(c => !c.win.isDestroyed() && c.win.id === wid && c.panes.some(p => p.id === pid)),
});
const ipcLogAt = new Map();
function ipcGate(ch, e, args) {                            // -> the sender's registry entry, or null (rejected)
  const { reg, sender } = ipcSender(e);
  const code = IPC.check(ch, sender, args, ipcWorld(reg));
  if (!code) return reg;
  diag.rec('ipc.reject', code, { p: reg?.pane?.id }, 60000);
  const k = `${code} ${ch} ${sender.role}`;
  if (debugOn() && Date.now() - (ipcLogAt.get(k) || 0) > 60000) { ipcLogAt.set(k, Date.now()); dlog('ipc reject', code, IPC.REJECT[code], ch, sender.role || '-'); }
  return null;
}
const ipcOn = (ch, fn) => ipcMain.on(ch, (e, ...a) => { const r = ipcGate(ch, e, a); if (r) fn(r, ...a); });
const ipcHandle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => { const r = ipcGate(ch, e, a); return r ? fn(r, ...a) : null; });
const regUi = new Set(), regPane = new Set();
function registerUi(ch) { if (regUi.has(ch)) return; regUi.add(ch); ipcOn(ch, (r, ...a) => r.ctx.ui[ch]?.(...a)); }
function registerPane(ch) {                                // pane handlers get the registered pane; a probe only reports its message count
  if (regPane.has(ch)) return; regPane.add(ch);
  ipcOn(ch, (r, ...a) => { if (r.role === 'probe') { if (ch === 'pane:msgcount') r.onCount(IPC.msgCount(a[0])); return; } r.ctx.paneIpc[ch]?.(r.pane, ...a); });
}
const cur = () => { const w = BrowserWindow.getFocusedWindow(); return ctxs.find(c => c.win === w) || ctxs[ctxs.length - 1]; };

function favChanged() { save(); broadcast(); }
function addFavorite(url, label) {
  url = String(url || '').trim(); if (!url) return;
  if (!/^[a-z]+:\/\//i.test(url)) url = normalize(url);
  if (url === NEWTAB) return;
  { const r = GB.addUrl(grok, url); if (r.pinned) { grok = r.grok; gbChanged(); return; } }   // (Grok bar) a listed Bot / group: pinned next to the Grok button
  const ex = favorites.find(f => f.url === url);
  if (ex) { if (label) ex.label = label.slice(0, 60); }
  else favorites.push({ id: nextFavId++, url, label: String(label || '').slice(0, 60) || defaultFavLabel(url) });
  favChanged();
}
function defaultFavLabel(url) { try { const u = new URL(url); return u.hostname.replace(/^www\./, ''); } catch { return url; } }
function moveFavorite(a, b) {
  const i = favorites.findIndex(f => f.id === a), j = favorites.findIndex(f => f.id === b);
  if (i < 0 || j < 0 || i === j) return;
  const [f] = favorites.splice(i, 1); favorites.splice(j, 0, f); favChanged();
}
// ---- Grok ボタン＋Bot一覧 (grok-bots.js): the favorites bar shows every Grok Bot / group of the account in grok.com's own sections, read only when
// the Grok button is pressed (one read at a time, all windows) from the sidebar of https://grok.com/ in a hidden window of the shared session;
// kept in panes.json `grok` with the user's names and pins (pins also sit right of the Grok button). Ordinary favorites (other URLs) stay as
// before, after the pins. The bar gets the list on its own channel ('gbar': icons are data URLs, too big for every state message)
const GB = require('./grok-bots');
let grok = GB.empty();
let gbRun = false, gbNote = '', gbNoteTimer = null;          // a read running / its last outcome, shown a moment in the bar
const gbView = () => ({ ...GB.view(grok), busy: gbRun, note: gbNote });
function gbPush(c) { const v = gbView(); (c ? [c] : ctxs).forEach(k => { try { if (!k.win.isDestroyed()) k.win.webContents.send('gbar', v); } catch {} }); }
function gbChanged() { save(); gbPush(); }
function gbSay(text, ms) { gbNote = text; clearTimeout(gbNoteTimer); if (text) gbNoteTimer = setTimeout(() => { gbNote = ''; gbPush(); }, ms); gbPush(); }
const gbJs = (wc, code, ms = 5000) => Promise.race([Promise.resolve().then(() => wc.executeJavaScriptInIsolatedWorld(GB.WORLD, [{ code }])), sleep(ms).then(() => null)]).catch(() => null);
// The hidden window: grok.com only (a move anywhere else is stopped and ends the read: a sign-in page = AUTH), no window.open, muted, the
// background-check role (storage only, no other permission / download, no preload so no IPC). Whatever it clicked is undone before it closes
// (GB.RESTORE_JS: さらに表示 / the sidebar toggle / sidebarOpen exactly as found). A failure keeps the list as it was and says why in the bar.
async function grokRefresh() {
  if (gbRun) { diag.rec('gbar', 'BUSY'); return; }
  if (quitting) return;
  gbRun = true; gbSay('', 0);
  const t0 = Date.now(), bw = new BrowserWindow({ show: false, width: 1400, height: 900, skipTaskbar: true, focusable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false } });
  const wc = bw.webContents;
  let rs = GB.start(t0), code = 'ERROR', bots = [], left = '', back = null, undone = false, m = null;
  regWc(wc, 'probe', { ctx: null });
  const stay = (e, url) => { if (GB.navOk(url)) return; e.preventDefault(); if (!left) left = String(url || '') || 'about:blank'; };
  const undo = async () => { if (undone || !GB.touched(rs) || wc.isDestroyed()) return; undone = true; back = await gbJs(wc, GB.RESTORE_JS(rs), 4000); };
  try {
    wc.setAudioMuted(true); wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e, u) => { if (e.isMainFrame !== false) stay(e, typeof u === 'string' ? u : e.url); });
    wc.on('will-redirect', (e, u, inPlace, isMain) => { if ((typeof e.isMainFrame === 'boolean' ? e.isMainFrame : isMain) === true) stay(e, typeof u === 'string' ? u : e.url); });
    appLoad(wc, GB.HOME);
    for (;;) {
      await sleep(400);
      if (wc.isDestroyed() || quitting || !ctxs.some(c => !c.win.isDestroyed())) { code = 'ABORT'; break; }   // quitting / the last window closed
      const o = await gbJs(wc, GB.STATE_JS);
      const d = GB.decide(rs, { ...(o && typeof o === 'object' ? o : { ready: false }), left }, Date.now()); rs = d.rs;
      if (d.act === 'open') await gbJs(wc, GB.CLICK_JS('trigger'));
      else if (d.act === 'more') await gbJs(wc, GB.CLICK_JS('more'));
      else if (d.act === 'collect') { bots = GB.parse(o); code = bots.length ? 'OK' : 'EMPTY'; break; }
      else if (d.act !== 'wait') { code = d.act; break; }
    }
    await undo();                                            // the shared sidebar state back first, then the icons
    if (code === 'OK') bots = GB.withIcons(bots, await gbJs(wc, GB.ICONS_JS(bots.map(b => b.icon)), 6000));   // none in time: the image URLs as they are
  } catch (e) { code = 'ERROR'; dlog('grok bar', 'read error', e && e.name); }
  finally {
    await undo().catch(() => {});
    unregWc(r => r.wc === wc);
    try { if (!bw.isDestroyed()) bw.destroy(); } catch {}
    gbRun = false;
  }
  const restoreOk = !GB.touched(rs) || !!(back && back.ok);
  if (!restoreOk) diag.rec('gbar', 'RESTORE_FAIL');
  if (code === 'OK') {
    m = GB.merge(grok, bots, Date.now());
    const a = GB.absorbFavs(m.grok, favorites);              // a favorite that is a listed Bot's URL: now its pin
    grok = a.grok; favorites = a.keep;
    save(); broadcast();
  }
  diag.rec('gbar', code, { n: bots.length, ms: Date.now() - t0 });
  dlog('grok bar', code, bots.length, Date.now() - t0 + 'ms', m ? `+${m.added} -${m.removed} ~${m.changed}` : '', restoreOk ? '' : 'sidebar state not confirmed back');
  gbSay(GB.note(code, m) + (restoreOk ? '' : '・grok.com のサイドバーの開閉を戻せませんでした'), code === 'OK' && restoreOk ? 6000 : 12000);
}
// once: the favorites from before the Grok bar are kept in userData/favorites.backup-<日時>.json, then the bar starts empty (the Grok button
// fills it). Only from a panes.json read as ready, and only once that file is written (a failed write: the favorites stay, tried at the next start)
function gbMigrate() {
  const b = GB.migration(favorites, new Date());
  if (b.file) {
    try { fs.writeFileSync(path.join(app.getPath('userData'), b.file), b.text, { flag: 'wx' }); }
    catch (e) { dlog('grok bar', 'favorites backup failed', e.code || ''); return; }
  }
  favorites = []; settings.favGrokV1 = true; save();
  diag.rec('gbar', 'MIGRATED', { n: b.n });
}

// ---- auto reload (through the input guard, #11: never while the page holds input; tried again on the next tick) ----
setInterval(() => {
  const now = Date.now();
  for (const c of ctxs) for (const p of c.panes) {
    if (!p.reloadMinutes) continue;
    const wc = p.view.webContents;
    if (now - p.lastReload < p.reloadMinutes * 60000) continue;
    if (now - p.lastTyping < TYPING_GRACE_MS || p.editing || wc.isLoading()) continue;
    if (p.disposed || RP.view(p.rcv).gone) continue;       // (#32) a closed view / a page whose renderer is gone (reloaded by the user only)
    c.autoReload(p);
  }
}, 15000);

const ZP = require('./zoom-policy');                         // (#53) pane zoom: range, targets, restore, native / legacy backend (makeWindow: initZoom / applyZoom)
const NO_NATIVE_ZOOM = !!process.env.MPB_NO_NATIVE_ZOOM;     // dev/test hook: every pane on the preload zoom (legacy), as on an Electron without setZoomMode
const clampZ = ZP.clamp;
const gZoom = () => clampZ(settings.globalZoom || 1);
function setGlobalZoom(z) { settings.globalZoom = clampZ(z); ctxs.forEach(c => c.applyGlobalZoom()); save(); }
// Column-width sync between grid rows. ON: every row shares settings.splits[k].c. OFF: each row has its own (sp.rc[row]).
// OFF -> ON aligns every row to the TOP row; ON -> OFF seeds each row with the current shared widths (nothing jumps).
function syncColsApply(on) {
  if (on === (settings.syncCols !== false)) return;
  settings.syncCols = on;
  for (const key of Object.keys(settings.splits || {})) {
    const sp = settings.splits[key], rows = Number(key.split('x')[1]) || 1;
    if (on) { const top = sp.rc && sp.rc[0]; if (top) sp.c = top; delete sp.rc; }
    else if (sp.c) sp.rc = Array.from({ length: rows }, () => [...sp.c]);
    if (!Object.keys(sp).length) delete settings.splits[key];
  }
  save(); ctxs.forEach(c => c.relayout(true)); broadcast();
}

setInterval(() => ctxs.forEach(c => { try { c.sleepTick(); } catch {} }), 10000);
setInterval(async () => {                                    // one background check at a time, never while the Mac sleeps / is locked
  if (probeBusy || sysBlocked || Date.now() - resumeAt < 20000) { if (debugOn() && Date.now() - probeDbgAt > 60000) { probeDbgAt = Date.now(); dlog('probe tick skipped:', probeBusy ? 'busy' : sysBlocked ? 'system asleep/locked' : 'just resumed'); } return; }
  probeBusy = true; if (debugOn()) dlog('probe tick');
  try { for (const c of ctxs) if (await c.probeNext()) break; } catch (e) { dlog('probe tick error', String(e)); }
  probeBusy = false;
}, 15000);
// (#33) 確認を再開 after a sign-in page stopped the checks: manual only, once (pressing again does nothing). The pane that saw the sign-in page is
// due again; every check still goes through the tick above (one at a time, the same holds and budget)
function probeResume() {
  if (!probeAuthHold) return;
  probeAuthHold = false;
  const now = Date.now();
  ctxs.forEach(c => c.panes.forEach(p => { if (p.sleeping && p.pb) p.pb = PB.resume(p.pb, now); }));
  diag.rec('probe', 'RESUME'); dlog('probe: checks resumed');
  buildMenu(); broadcast();
}
// ---- app memory meter (top-left) ----
// Sum of every Electron process. On macOS privateBytes ~ the process "footprint", which is what Activity Monitor's Memory column shows.
// Sent every 2.5 s to visible windows, and only while the app is focused (zero work in the background).
function appMemBytes() {
  let b = 0;
  for (const m of app.getAppMetrics()) b += (m.memory.privateBytes || m.memory.workingSetSize || 0) * 1024;
  return b;
}
function sendMem() {
  if (!BrowserWindow.getFocusedWindow()) return;
  const b = appMemBytes();
  if (debugOn()) { const t0 = process.hrtime.bigint(); let ws = 0, pb = 0; for (const m of app.getAppMetrics()) { ws += m.memory.workingSetSize * 1024; pb += (m.memory.privateBytes || 0) * 1024; } dlog('mem', 'private', Math.round(pb / 1048576), 'workingSet', Math.round(ws / 1048576), 'MB; metrics call us', Number((process.hrtime.bigint() - t0) / 1000n)); }
  ctxs.forEach(c => { try { if (c.win.isVisible() && !c.win.isMinimized()) c.win.webContents.send('mem', b); } catch {} });
}
setInterval(sendMem, 2500);
app.on('browser-window-focus', () => setTimeout(sendMem, 50));
// ---- notification chips for panes in OTHER windows ----
let othersTimer = null;
function scheduleOthers() {
  if (othersTimer) return;
  othersTimer = setTimeout(() => {
    othersTimer = null;
    ctxs.forEach((c, i) => {
      try {
        const list = ctxs.length < 2 ? [] : ctxs.map((o, j) => j === i ? null : o.othersInfo(j + 1)).filter(x => x && x.panes.length);
        const js = JSON.stringify(list);
        if (c._othersJson === js) return;
        c._othersJson = js; c.win.webContents.send('others', list);
      } catch {}
    });
  }, 200);
}
ipcOn('focus-other', (r, wid, pid) => {
  const c = ctxs.find(k => !k.win.isDestroyed() && k.win.id === wid); if (!c) return;
  if (c.win.isMinimized()) c.win.restore();
  c.win.show(); c.win.focus(); c.focusPaneById(Number(pid));
});
const APPROVE_URL = 'https://grok.com/bot/5674ea26-494f-49a0-acc1-f55ce2dd9c94';   // 承認Bot popup
const APPROVE_KEEP_MS = 5 * 60000;                                                   // keep the hidden popup page this long for a fast reopen, then free its memory

// ---- links opened from page content (bot output, citations, attachments, popups) ----
// Like the native Grok Bot app: ordinary web links open in the default browser; grok.com links stay in the pane; sign-in / OAuth popups get a
// real child window (window.opener keeps working); blob:/data: previews open in a child window; mailto/tel go to the system handler.
// (#72) navigation-policy.js decides from the parsed URL (scheme + exact host / sub-domain, never a prefix of the text; no user name / password;
// javascript: / file: / chrome: ... refused) and main acts on it - the same policy for window.open (linkOpen), same-frame moves and redirects
// (guardNavigation; the UI never moves: guardUi), every loadURL main starts (appLoad) and shell.openExternal (openExt: http(s), or mailto / tel /
// sms / facetime right after the user's click / key in that page or from main's own menu). A refused one does nothing (diagnostics: nav.block).
const NAV = require('./navigation-policy');
const PERM = require('./permission-policy');                 // site permissions / downloads (app.whenReady)
const gestureAt = new Map();                                 // webContents id -> the user's last click / key in it ('input-event': from the browser, not the page)
const recentGesture = wc => !!wc && NAV.gestureOk(gestureAt.get(wc.id), Date.now());
function trackGesture(wc) {
  const id = wc.id;
  wc.on('input-event', (e, i) => { if (NAV.isGesture(i && i.type)) gestureAt.set(id, Date.now()); });
  wc.once('destroyed', () => gestureAt.delete(id));
}
function navBlocked(code, why, wc) {                         // fixed code + the pane's number; the debug log gets why, never the URL
  const p = wc && !wc.isDestroyed() ? wcReg.get(wc.id)?.pane : null;
  diag.rec('nav.block', code, { p: p && p.id }, 60000);
  dlog('link', 'blocked', code, why);
}
function openExt(url, why, gesture = false) {
  const r = NAV.external(url, { gesture });
  if (r.code) { navBlocked(r.code, why); return; }
  dlog('link', why, r.href.slice(0, 160));
  if (process.env.MPB_LINK_DRYRUN) return;
  shell.openExternal(r.href).catch(() => {});
}
function appLoad(wc, url) {                                  // every loadURL main starts (#72): web pages and about:blank only
  const code = NAV.appLoad(url);
  if (code) { navBlocked(code, 'app load', wc); return; }
  wc.loadURL(url).catch(() => {});
}
function linkOpen(wc, d) {
  const r = NAV.windowOpen(d.url, { popup: NAV.popupFeatures(d.features) });
  const childWin = () => {
    const owner = ctxs.find(c => c.panes.some(p => p.view.webContents === wc))?.win || BrowserWindow.getFocusedWindow() || undefined;
    return { action: 'allow', overrideBrowserWindowOptions: { width: 560, height: 760, parent: owner, autoHideMenuBar: true, title: 'MultiPane Browser',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } } };
  };
  if (r.action === 'system') { openExt(d.url, 'system-handler', recentGesture(wc)); return { action: 'deny' }; }
  if (r.action === 'child') { dlog('link', 'popup / auth window'); return childWin(); }
  if (r.action === 'pane') {
    dlog('link', 'same-site, stays in pane', d.url.slice(0, 120));
    const c = ctxs.find(k => k.panes.some(p => p.view.webContents === wc));   // a pane: through its input guard (#11); the 承認Bot popup: as before
    if (c) c.openLink(wc, d.url); else appLoad(wc, d.url);
    return { action: 'deny' };
  }
  if (r.action === 'browser') openExt(d.url, 'external-browser');
  else navBlocked(r.code, 'window.open', wc);
  return { action: 'deny' };
}
app.on('web-contents-created', (e, c) => {            // child windows (auth popups / previews): their own links go to the default browser
  c.on('did-create-window', child => {
    const cw = child.webContents;
    cw.setWindowOpenHandler(d => { const r = NAV.windowOpen(d.url, { child: true }); if (r.action === 'browser') openExt(d.url, 'child-window link'); else navBlocked(r.code, 'child window.open'); return { action: 'deny' }; });
    guardNavigation(cw, 'popup');
  });
});
// (#72) where a page may take itself: will-navigate (a link without target / a script, main frame) and will-redirect (a server redirect of the
// main frame); child frames and resources are not limited (CDNs, sign-in frames). kind: pane / approve / probe (the hidden check: no browser,
// no system app) / popup (a window a page opened). A plain link inside a bot page that leaves grok.com must not replace the bot: the browser
function guardNavigation(wc, kind = 'pane') {
  const own = kind === 'pane' || kind === 'approve';
  if (own) trackGesture(wc);
  wc.on('will-navigate', (e, url0) => {
    if (e.isMainFrame === false) return;
    const url = typeof url0 === 'string' ? url0 : e.url;
    const r = NAV.navigate(url, { bot: own && /^https:\/\/grok\.com\/bot\//.test(wc.getURL()) });
    if (r.action === 'allow') return;
    e.preventDefault();
    if (r.action === 'system') openExt(url, 'system-handler', recentGesture(wc));
    else if (r.action === 'browser') openExt(url, 'external-browser (same-frame link)');
    else navBlocked(r.code, 'navigate', wc);
  });
  wc.on('will-redirect', (e, url0, inPlace, isMain0) => {
    if ((typeof e.isMainFrame === 'boolean' ? e.isMainFrame : isMain0) !== true) return;
    const code = NAV.redirect(typeof url0 === 'string' ? url0 : e.url);
    if (code) { e.preventDefault(); navBlocked(code, 'redirect', wc); }
  });
}
function guardUi(wc) {                                       // the window's own UI / overlay: a dropped link / file must not replace the app's screen
  wc.on('will-navigate', e => { e.preventDefault(); navBlocked(NAV.navigate(e.url, { ui: true }).code, 'ui navigate'); });
  wc.setWindowOpenHandler(() => { navBlocked('E_UI', 'ui window.open'); return { action: 'deny' }; });
}

// ---- background check of sleeping panes (new bot message while asleep => "unopened") ----
const SLEEP_CHECK_MS = Number(process.env.MPB_CHECK_SEC) > 0 ? Number(process.env.MPB_CHECK_SEC) * 1000 : 5 * 60 * 1000;   // per sleeping pane
const PROBE_MAX_MS = 30000;                                  // give up on one check after this long
let probeBusy = false, sysBlocked = false, resumeAt = 0, probeDbgAt = 0;     // one check at a time, none while the Mac sleeps / is locked
// (#33, probe-policy.js) per sleeping pane p.pb: last attempt / success, failures in a row, the next check (backoff 5/10/20/40/60 min). Memory only.
// probeAuthHold: a check clearly saw a sign-in page -> no check of the shared session in any window until 確認を再開 (probeResume)
const PB = require('./probe-policy');
let probeAuthHold = false;
// ---- generations (#02, pane-state.js): one per-launch counter (all windows) numbers every pane entity, world generation and background-check
// run, so a number is never reused. Kept in memory only (never in panes.json): after a restart everything starts with new numbers.
const PS = require('./pane-state');
let worldNo = 0;
const nextNo = () => ++worldNo;
// ---- input guard (#11, draft-guard.js): before a page is thrown away (sleep / reload / close / another URL / layout / workspace) main reads
// the composer live and the guard decides: automatic operations only when the page clearly holds nothing, manual ones ask (makeWindow: guardRun)
const GUARD = require('./draft-guard');
const { COMPOSER_JS } = require('./pane-rules');             // composerState() from the shared rules: the same code the pane preload has built in
// ---- 閉じたペインを開き直す (#23, closed-panes.js): what a closed pane leaves in its window's history, when an entry is taken, the focus after
// (makeWindow: closePane / reopenClosed). Memory only: never in panes.json, gone after a restart; a draft / attachment never comes back.
const CP = require('./closed-panes');
// ---- 対応キュー (#01, attention-queue.js): per window, built from the pane state on every sendState (要返信 → 未確認の新着 → 観測異常 → 待機);
// the list is shown in the overlay and counted in the bar (対応 n). Looking at it changes nothing; only a choice from the open list focuses / wakes
// that pane (makeWindow: queueOpen / queuePick). Memory: the list and p.qSince only (never in panes.json)
const AQ = require('./attention-queue');
// ---- キーボードでのペイン移動 (#51, pane-navigation.js): ⌘⌥←→↑↓ by position, ⌘⇧J to the next item of the 対応キュー; the same focus / wake as a
// click (makeWindow: navKey / moveFocus / queueNext / navGo). Memory only (a pending move: navWait)
const PN = require('./pane-navigation');
// ---- 選択部分だけコピー (copy-policy.js): ⌘C / the pane menu's コピー with a selection in the page (the preload reports one: p.sel) -> main
// copies it itself and checks the clipboard (makeWindow: copySel). copySeq: a newer copy drops an older one's check (one clipboard for all windows)
const CB = require('./copy-policy');
let copySeq = 0;
// ---- ドッキング型の並べ替え (dock-layout.js): a pane dragged by its header onto another one's top / bottom (stacked in its cell) / left / right
// (a cell of its own) or onto the band at the top / bottom edge of the rows (a row of its own); the rows with stacked cells (window / workspace
// `stacks`, optional). makeWindow: dock* (the drag, its views hidden behind stills, the preview), grid / applyGrid (the rows as pane ids)
const DL = require('./dock-layout');
// ---- 一斉送信 (#12, broadcast-state.js): a preview of every chosen pane (read live), then one confirmed batch: per target the same pane /
// generation / conversation / keys typed as previewed and an empty composer right before it, input, a check, the send, then page evidence
// (makeWindow: bc*). Memory only (never in panes.json, never resumed after a restart); the text is never logged.
// Dev: MPB_BROADCAST_DRYRUN=1 never types into or sends from a page (previews, wakes and the live checks run as usual; every send ends 結果不明).
const BS = require('./broadcast-state');
const BC_DRY = !!process.env.MPB_BROADCAST_DRYRUN;
// the page side (main world, the same DOM input / send as before, now two steps). The composer is the last visible textarea / contenteditable.
// BC_INPUT_JS: types only into an empty composer (no text, no attachment) -> { r: 'typed', h: a short hash of what it holds then } | notempty |
// nocomposer | failed. BC_SEND_JS: only while the composer still holds exactly that -> clicks the form's send button -> clicked | enter (no button,
// the composer has the focus: main sends Enter) | mismatch | nocomposer | nobutton. The hash is not the text and is never logged.
const BC_PICK = `const vis=e=>e.offsetParent!==null&&!e.closest('[aria-hidden="true"]')&&!(e.tagName==='TEXTAREA'&&e.tabIndex<0);
  const c=[...document.querySelectorAll('form textarea, textarea, .ProseMirror[contenteditable="true"], [contenteditable="true"]')].filter(vis);const el=c[c.length-1];
  const val=e=>String((e.tagName==='TEXTAREA'?e.value:(e.innerText||e.textContent||''))||'');
  const hash=s=>{s=s.replace(/\\s+/g,'');let h=5381;for(let i=0;i<s.length;i++)h=((h*33)^s.charCodeAt(i))>>>0;return h.toString(36)+'.'+s.length;};`;
const BC_INPUT_JS = body => `(()=>{/*mpb:bc-input*/${BC_PICK}
  if(!el)return{r:'nocomposer'};const box=el.closest('form')||(el.parentElement&&el.parentElement.parentElement);
  if(val(el).trim()||(box&&box.querySelector('img[src^="blob:"], [data-testid*="attachment-preview" i], [data-testid*="file-preview" i]')))return{r:'notempty'};
  const T=${JSON.stringify(String(body))};el.focus();
  if(el.tagName==='TEXTAREA'){Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,T);el.dispatchEvent(new Event('input',{bubbles:true}));}
  else{getSelection().selectAllChildren(el);document.execCommand('insertText',false,T);}
  const now=val(el);return now.trim()?{r:'typed',h:hash(now)}:{r:'failed'};})()`;
const BC_SEND_JS = h => `(()=>{/*mpb:bc-send*/${BC_PICK}
  if(!el)return{r:'nocomposer'};if(hash(val(el))!==${JSON.stringify(String(h))})return{r:'mismatch'};
  const root=el.closest('form')||document;
  const b=[...root.querySelectorAll('button[type="submit"], button[aria-label]')].filter(b=>!b.disabled&&b.offsetParent!==null&&(b.type==='submit'||/送信|submit|send/i.test(b.getAttribute('aria-label')||'')));
  if(b.length){b[b.length-1].click();return{r:'clicked'};}
  el.focus();return{r:document.activeElement===el?'enter':'nobutton'};})()`;
// ---- shared load queue (#31, load-queue.js): every load main starts - startup / workspace, a new pane, reload / reload-all / automatic reloads,
// wake, another URL / back / forward / a grok link in the pane, the bot-page fixes and the background check - waits for one of LQ.LIMIT slots in
// all windows (a background check takes at most one). The user's own wake / reload / URL first, then startup / reload-all / automatic reloads,
// background checks last; the focused pane first within a class. A task keeps its slot until its load has settled, or - cancelled (pane closed,
// window closed, 取消, the new-tab page) - until the load has really stopped / its view or check window is gone (lqPoll / probePane).
// Not loads of a pane, never waiting: the local new-tab page, a sleep's about:blank (an unload; canSleep refuses while the pane has a task) and
// the 承認Bot popup. Memory only.
const LQ = require('./load-queue');
const lqRuns = new Map();                                    // running / stopping view load: task id -> { t, p, wc, t0, began, resolve }
let lqUiTimer = null, lqPollTimer = null;
const lq = LQ.createLoadQueue({ nextId: nextNo, limit: Number(process.env.MPB_LOAD_CONC) > 0 ? Number(process.env.MPB_LOAD_CONC) : LQ.LIMIT,   // dev override: MPB_LOAD_CONC
  rank: t => t.data && t.data.rank ? t.data.rank() : 1, onChange: lqChanged });
function lqChanged(e) {                                      // fixed codes, the pane's per-launch number and ms only
  const no = e.t.data && e.t.data.no;
  if (e.type === 'wait') diag.rec('load.queue', 'WAIT', { p: no, n: lq.stats().wait }, 60000);
  else if (e.type === 'merge') diag.rec('load.queue', 'MERGED', { p: no }, 60000);
  else if (e.type === 'stop' && e.code === 'PREEMPT') diag.rec('load.queue', 'PREEMPT', { p: no });
  else if (e.type === 'end') diag.rec('load.queue', e.code, { p: no, ms: Date.now() - e.t.at });
  if (debugOn() && e.type !== 'start') dlog(`pane${no || '-'}`, 'load', e.t.purpose, e.t.cls, e.type, e.code || '', `run=${lq.stats().used}`);
  if (lqUiTimer) return;                                     // the windows show wait / start / end (placeholder, header) a moment later, once per burst
  lqUiTimer = setTimeout(() => { lqUiTimer = null; ctxs.forEach(c => { try { c.showViews(); } catch {} }); }, 30);
}
// running view loads: settled -> the slot goes back; cancelled -> once the load has stopped / the view is gone. Polled while there are any
function lqPoll() {
  for (const run of [...lqRuns.values()]) {
    const { t, p, wc } = run;
    if (t.state === 'end') { lqRuns.delete(t.id); continue; }
    const gone = wc.isDestroyed();
    if (t.state === 'stop') { if (gone || !wc.isLoading()) lqEnd(run, 'STOPPED'); continue; }
    if (!run.began) continue;                                // still reading the input right before it starts
    if (gone) { lqEnd(run, 'GONE'); continue; }
    const code = LQ.settle({ now: Date.now(), t0: run.t0, quiet: p.loadedAt, loading: wc.isLoading(), fixing: !!(p.grokToken || p.grokPending) });
    if (code === 'STOP') { if (!run.hard) { run.hard = true; dlog(`pane${p.id}`, 'load still going after', LQ.HARD_MS, 'ms: stopped'); } try { wc.stop(); } catch {} }   // given back once it has stopped
    else if (code) lqEnd(run, code);
  }
  if (!lqRuns.size) { clearInterval(lqPollTimer); lqPollTimer = null; }
}
const lqPollOn = () => { if (!lqPollTimer) lqPollTimer = setInterval(lqPoll, 300); };
function lqEnd(run, code) { lqRuns.delete(run.t.id); run.resolve(code); }   // -> the task's promise: the queue gives the slot back
// ---- limited recovery (#32, recovery-policy.js): a transient main-frame load failure of the pane's current generation is reloaded by itself at
// most RP.MAX_AUTO times in RP.WINDOW_MS (15 s, then 60 s later), through the input guard (#11) and the shared queue (#31); anything else (a
// permanent failure, the limit, a renderer gone) waits for the user. No timer per pane: this one tick starts at most one due reload in all windows,
// none while the Mac sleeps / is locked, right after it woke (the overdue ones then go one per tick) or while quitting. makeWindow: recover*.
// Dev: MPB_RECOVERY_DEBUG=1 adds synthetic failures to the pane's context menu (the same handlers; no renderer is crashed).
const RP = require('./recovery-policy');
const RECOVERY_DEBUG = !!process.env.MPB_RECOVERY_DEBUG;
setInterval(() => {
  if (quitting || sysBlocked || Date.now() - resumeAt < RP.RESUME_MS) return;
  for (const c of ctxs) { try { if (c.recoverNext()) break; } catch (e) { dlog('recover tick error', String(e)); } }
}, RP.TICK_MS);

// ======================= one app window =======================
function makeWindow(spec = {}, { restore = false } = {}) {
let win, overlay, overlayOpen = false, overlayMode = '';
let queueNote = '';                        // (#01) why the last choice from the 対応キュー was not carried out (shown in the open list until the next one)
let queueNow = [];                         // (#01) the list the last sendState built
let navWait = null, navSeq = 0;            // (#51) a keyboard move to a pane not on screen yet (pane-navigation.js mayFocus / holds)
let activeWs = null;                     // name of the saved layout currently loaded / last saved in this window
let approve = null, approveOpen = false, approveTimer = null, approvePane = null;
let panes = [], focused = 0, layout = PRESETS[spec.layout] ? spec.layout : '2x2', maximizedId = null;
let lastBounds = spec.window?.bounds || null;
// ---- layout ----
function grid(n) {
  if (n === 1) return { cols: 1, rows: 1 };
  const pr = PRESETS[layout];
  if (pr && n === pr[0] * pr[1]) return { cols: pr[0], rows: pr[1] };
  if (pr && n < pr[0] * pr[1]) {   // auto-fit: fewer panes than the preset holds -> even grid, last row stretches
    const rows = Math.min(pr[1], Math.max(1, Math.ceil(n / Math.max(4, pr[0]))));
    return { rows, cols: Math.ceil(n / rows) };
  }
  const cols = Math.ceil(Math.sqrt(n));
  return { rows: Math.ceil(n / cols), cols };
}
// ---- row structure: every pane belongs to a row (rowLens[r] = number of panes in row r, panes[] is kept in row-major order) ----
// Closing a pane only shrinks ITS row (the row re-divides evenly); panes never move between rows. An empty row disappears.
// (dock) A row's cells may stack panes: stackLens[r][c] = the panes of cell c of row r, top to bottom (null = one pane per cell); rowLens still
// counts every pane of the row and the columns are the row's cells. A stacked pane closed: only its cell shrinks (one left: an ordinary cell)
const closedStack = [];                                      // last CP.LIMIT closed panes (newest last), for 閉じたペインを開き直す (#23: this window, memory only)
let rowLens = Array.isArray(spec.rows) ? spec.rows.map(Number) : null;
let stackLens = DL.read(spec.stacks);
const sumArr = a => a.reduce((x, y) => x + y, 0);
function defRows(n) {                                  // rows as the preset / auto-fit would lay n panes out
  if (n <= 0) return [];
  const g = grid(n), out = []; let left = n;
  for (let r = 0; r < g.rows && left > 0; r++) { const k = r === g.rows - 1 ? left : Math.min(g.cols, left); out.push(k); left -= k; }
  return out;
}
function getRows() {                                   // validated; falls back to the default grid (one pane per cell)
  if (!rowLens || !rowLens.every(k => Number.isInteger(k) && k > 0) || sumArr(rowLens) !== panes.length) { rowLens = defRows(panes.length); stackLens = null; }
  return rowLens;
}
function getStacks() {                                 // (dock) the rows' cells, validated against the rows and the limits; else one pane per cell
  const l = getRows();
  if (stackLens && !DL.stacksOk(stackLens, l)) stackLens = null;
  return stackLens || DL.flat(l);
}
// (dock) the rows as a grid of pane ids (dock-layout.js) and back: applyGrid puts panes[] / rows / stacks in its order (extra: a pane not in
// panes[] yet), the focused pane stays focused. It never loses or duplicates a pane: anything else is refused (false) and nothing changes
const paneGrid = () => DL.toGrid(getRows(), getStacks(), panes.map(p => p.id));
function applyGrid(g, extra = []) {
  if (!g) return false;
  const r = DL.fromGrid(g), all = [...panes, ...extra], fid = panes[focused]?.id;
  const next = r.order.map(id => all.find(p => p.id === id));
  if (next.length !== all.length || next.some(p => !p) || new Set(next).size !== next.length) return false;
  panes.splice(0, panes.length, ...next); rowLens = r.rows; stackLens = r.stacks;
  focused = Math.max(0, panes.findIndex(p => p.id === fid));
  return true;
}
const rowsSave = () => { const st = getStacks(); return { rows: [...getRows()], ...(DL.isFlat(st) ? {} : { stacks: st.map(s => [...s]) }) }; };   // stacks only when a cell stacks
const sameArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const splitKey = () => { const l = getStacks(); return `${Math.max(1, ...l.map(s => s.length))}x${Math.max(1, l.length)}`; };
const areaNow = () => { const [w, h] = win.getContentSize(); return { x: GAP, y: TOPBAR + GAP, w: w - 2 * GAP, h: h - TOPBAR - GAP - BOTTOM_GAP }; };
function cells(grid = false) {                         // grid: the rows' layout even while a pane is maximized (#51 keyboard moves)
  const n = panes.length; if (!n) return [];
  const area = areaNow();
  if (!grid && maximizedId != null && byId(maximizedId))
    return panes.map(p => p.id === maximizedId ? { x: area.x, y: area.y, w: area.w, h: area.h } : null);
  const r = geom(getStacks(), area);
  lastGeom = r.g;
  return r.out;
}
// the panes' rectangles (panes[] order) for rows whose cells hold stacks[r][c] panes: the cells side by side, a stacked cell's panes share
// its row's height evenly (no splitter of their own); lastGeom from it for the splitters
function geom(stacks, area) {
  const lens = stacks.map(s => s.length), rows = lens.length, cols = Math.max(...lens);
  const sp = settings.splits?.[`${cols}x${rows}`] || {};
  const wts = (arr, k) => Array.isArray(arr) && arr.length === k && arr.every(v => v > 0.05) ? arr : Array(k).fill(1);
  const edges = (start, len, k, w) => { const tot = w.reduce((a, b) => a + b, 0); let acc = 0; const e = [start]; for (let j = 0; j < k; j++) { acc += w[j]; e.push(start + (len + GAP) * acc / tot); } return e; };
  // column edges per row: with "sync" (default) every row shares sp.c; without it each row has its own weights in sp.rc[row] (null = shared / even)
  const sync = settings.syncCols !== false;
  const rowW = r => wts((!sync && sp.rc && sp.rc[r]) || sp.c, cols);
  const evenEdges = () => { const tot = area.w - GAP * (cols - 1), base = Math.floor(tot / cols), rem = tot - base * cols; const e = []; for (let j = 0; j <= cols; j++) e.push(area.x + j * (base + GAP) + Math.min(j, rem)); return e; };   // integer-exact equal columns
  const cEs = Array.from({ length: rows }, (_, r) => { const w = rowW(r); return w.every(v => v === w[0]) ? evenEdges() : edges(area.x, area.w, cols, w); });
  const fr = Math.max(0, lens.findIndex(k => k === cols)), cE = cEs[fr], rE = edges(area.y, area.h, rows, wts(sp.r, rows));
  const g = { area, cols, rows, cE, cEs, rE, n: sumArr(stacks.map(sumArr)), sync, lens };
  const out = [];
  lens.forEach((inRow, r) => {
    for (let c = 0; c < inRow; c++) {
      let x0, x1;
      if (inRow === cols) { x0 = cEs[r][c]; x1 = cEs[r][c + 1]; } else { const cw = (area.w + GAP) / inRow; x0 = area.x + c * cw; x1 = area.x + (c + 1) * cw; }   // shorter row: its cells share the width evenly
      const x = Math.round(x0), k = stacks[r][c], rh = rE[r + 1] - rE[r];
      for (let j = 0; j < k; j++) {                       // one pane per cell: the row's own top / bottom, exactly as before
        const y = Math.round(rE[r] + rh * j / k), y1 = j + 1 === k ? rE[r + 1] : rE[r] + rh * (j + 1) / k;
        out.push({ x, y, w: Math.round(x1 - GAP) - x, h: Math.round(y1 - GAP) - y });
      }
    }
  });
  return { out, g };
}
let lastGeom = null, splitDrag = null;
function splitters() {
  const g = lastGeom; if (!g || maximizedId != null || g.n < 2) return [];
  const out = [], full = g.lens.map(k => k === g.cols);   // only rows that use the shared / per-row column weights get column splitters
  if (g.sync) {
    for (let r = 0; r < g.rows; r++) {                      // one bar per run of consecutive full rows
      if (!full[r]) continue; let e = r; while (e + 1 < g.rows && full[e + 1]) e++;
      for (let i = 1; i < g.cols; i++) out.push({ axis: 'c', i, x: Math.round(g.cEs[r][i] - GAP), y: Math.round(g.rE[r]), w: GAP, h: Math.round(g.rE[e + 1] - GAP) - Math.round(g.rE[r]) });   // same rounding as cells()
      r = e;
    }
  } else for (let r = 0; r < g.rows; r++) if (full[r]) for (let i = 1; i < g.cols; i++) out.push({ axis: 'c', i, row: r, x: Math.round(g.cEs[r][i] - GAP), y: Math.round(g.rE[r]), w: GAP, h: Math.round(g.rE[r + 1] - GAP) - Math.round(g.rE[r]) });
  for (let i = 1; i < g.rows; i++) out.push({ axis: 'r', i, x: g.area.x, y: Math.round(g.rE[i] - GAP), w: g.area.w, h: GAP });
  return out;
}
function splitMove(pt) {
  const d = splitDrag, g = lastGeom; if (!d || !g) return;
  const k = d.axis === 'c' ? g.cols : g.rows, E = d.axis === 'c' ? (g.sync ? g.cE : g.cEs[d.row || 0]) : g.rE;
  const start = d.axis === 'c' ? g.area.x : g.area.y, len = (d.axis === 'c' ? g.area.w : g.area.h) + GAP;
  const pos = (d.axis === 'c' ? pt.x : pt.y) + GAP / 2;
  const lo = E[d.i - 1] + 140, hi = E[d.i + 1] - 140; if (hi <= lo) return;
  const np = Math.min(hi, Math.max(lo, pos));
  const w = []; for (let j = 0; j < k; j++) w.push((E[j + 1] - E[j]) / len * k);
  const pair = w[d.i - 1] + w[d.i];
  w[d.i - 1] = (np - E[d.i - 1]) / len * k; w[d.i] = pair - w[d.i - 1];
  const key = `${g.cols}x${g.rows}`;
  const sp = settings.splits[key] = { ...(settings.splits[key] || {}) };
  const rw = w.map(v => Math.round(v * 1000) / 1000);
  if (d.axis === 'c' && !g.sync) { const rc = Array.isArray(sp.rc) ? [...sp.rc] : []; while (rc.length < g.rows) rc.push(null); rc[d.row || 0] = rw; sp.rc = rc; }
  else sp[d.axis] = rw;
  relayout();
}
function splitStart(axis, i, row) {
  if (!['c', 'r'].includes(axis) || !Number.isInteger(i)) return;
  splitDrag = { axis, i, row: Number.isInteger(row) ? row : 0, t0: Date.now() };
  clearInterval(splitDrag.timer);
  splitDrag.timer = setInterval(() => {
    if (!splitDrag || win.isDestroyed() || Date.now() - splitDrag.t0 > 60000) return splitEnd();
    const sp = screen.getCursorScreenPoint(), cb = win.getContentBounds();
    splitMove({ x: sp.x - cb.x, y: sp.y - cb.y });
  }, 16);
}
function splitEnd() { if (!splitDrag) return; clearInterval(splitDrag.timer); splitDrag = null; save(); }
function splitReset(axis, row) {
  const g = lastGeom; if (!g) return; const key = `${g.cols}x${g.rows}`;
  if (axis === 'c' && !g.sync && Number.isInteger(row) && settings.splits[key]?.rc) {          // unsynced: double-click resets just that row
    const rc = [...settings.splits[key].rc]; rc[row] = rc[row] ? Array(g.cols).fill(1) : null; settings.splits[key].rc = rc; relayout(true); save(); return;
  }
  if (settings.splits[key]) { delete settings.splits[key][axis]; if (!Object.keys(settings.splits[key]).length) delete settings.splits[key]; }
  relayout(true); save();
}
// long-press on the sync button: perfectly even columns in every row of the current grid (sync state unchanged)
function syncReset() {
  const g = lastGeom; if (!g) return; const key = `${g.cols}x${g.rows}`;
  if (settings.splits[key]) { delete settings.splits[key].c; delete settings.splits[key].rc; if (!Object.keys(settings.splits[key]).length) delete settings.splits[key]; }
  relayout(true); save();
}
const viewRect = c => ({ x: c.x, y: c.y + PHEAD, width: Math.max(0, c.w), height: Math.max(0, c.h - PHEAD) });
let animTimer = null;
function relayout(animate = false) {
  if (!win || win.isDestroyed()) return;
  const cs = cells();
  clearInterval(animTimer);
  const targets = cs.map(c => c && viewRect(c));
  panes.forEach((p, i) => {
    const t = targets[i];
    p.view.setVisible(!!t && !p.sleeping && !viewHeld(p) && !dockHide());
    if (!t) return;
    if (!animate || !p.bounds) { p.view.setBounds(t); p.bounds = t; }
  });
  if (animate) {
    const from = panes.map(p => p.bounds || targets[panes.indexOf(p)]);
    let step = 0; const N = 7;
    animTimer = setInterval(() => {
      step++;
      const k = 1 - Math.pow(1 - step / N, 3);          // ease-out cubic
      panes.forEach((p, i) => {
        const t = targets[i], f = from[i]; if (!t || !f) return;
        const b = { x: Math.round(f.x + (t.x - f.x) * k), y: Math.round(f.y + (t.y - f.y) * k),
          width: Math.round(f.width + (t.width - f.width) * k), height: Math.round(f.height + (t.height - f.height) * k) };
        p.view.setBounds(b); p.bounds = b;
      });
      if (step >= N) clearInterval(animTimer);
    }, 18);
  }
  if (overlayOpen) overlay.setBounds({ x: 0, y: 0, width: win.getContentSize()[0], height: win.getContentSize()[1] });
  if (approveOpen && approve) { const r = approveRect(); approve.setBounds(r); overlay.webContents.send('approve-rect', r); }
  sendState(cs);
  navSettle();                                               // (#51) a keyboard move waiting for its pane to be shown (woken)
}
function applyPreset(key) {
  if (!PRESETS[key]) return;
  const want = PRESETS[key][0] * PRESETS[key][1];
  guardRun('LAYOUT', () => panes.slice(want), () => {          // the panes past the preset are closed: asked first when one holds input (#11)
    layout = key; maximizedId = null;
    while (panes.length > want) closePane(panes[panes.length - 1].id, true);
    while (panes.length < want) addPane({ url: '' }, { focus: false });
    rowLens = null; stackLens = null;                     // a preset re-initialises the rows (no stacked cells)
    setFocused(Math.min(focused, panes.length - 1));
    relayout(true); save();
  });
}
function toggleMaximize(id) {
  const p = byId(id ?? panes[focused]?.id); if (!p) return;
  maximizedId = maximizedId === p.id ? null : p.id;
  setFocused(panes.indexOf(p));
  relayout(true);
  p.view.webContents.focus();
}
// "クラウドPCを最大化": the bot's computer view is a modal that scales with the pane's viewport (and caps at 1080 px).
// Maximise the pane to the window and have the page's own "コンピュータを表示" dialog fill it (see pane-preload).
function setPcMax(p, on) {
  dlog(`pane${p?.id}`, 'pcmax', on);
  if (!p || p.view.webContents.isDestroyed() || on === !!p.pcMax) return;
  p.pcMax = on;
  if (on) { if (maximizedId !== p.id) { toggleMaximize(p.id); p.pcMaxedPane = true; } else p.pcMaxedPane = false; }
  else if (p.pcMaxedPane) { p.pcMaxedPane = false; if (maximizedId === p.id) toggleMaximize(p.id); }
  p.view.webContents.send('mpb:pc', on);
}
// 画像クリックで最大化 (pane-preload img-opened / img-closed): maximized like the cloud PC (no size-cap CSS); p.imgMaxedPane = this maximized it (a pane
// already maximized stays as it is). The viewer closed: given back only then; no viewer found: the flags go, the pane stays maximized
function setImgMax(p, on, back = true) {
  if (!p || p.view.webContents.isDestroyed() || on === !!p.imgMax) return;
  dlog(`pane${p.id}`, 'imgmax', on, back);
  p.imgMax = on;
  if (on) { if (maximizedId !== p.id) { toggleMaximize(p.id); p.imgMaxedPane = true; } else p.imgMaxedPane = false; }
  else { const mine = p.imgMaxedPane; p.imgMaxedPane = false; if (back && mine && maximizedId === p.id) toggleMaximize(p.id); }
}
function togglePc(id) { const p = byId(id ?? panes[focused]?.id); if (p && isBotUrl(p.view.webContents.getURL())) setPcMax(p, !p.pcMax); }
const pcItem = p => ({ label: p.pcMax ? 'クラウドPCを元のサイズに戻す' : 'クラウドPCを最大化', accelerator: 'CmdOrCtrl+Shift+P', enabled: isBotUrl(p.view.webContents.getURL()), click: () => setPcMax(p, !p.pcMax) });
function swapPanes(a, b) {
  const i = panes.findIndex(p => p.id === a), j = panes.findIndex(p => p.id === b);
  if (i < 0 || j < 0 || i === j) return;
  const fid = panes[focused]?.id;
  [panes[i], panes[j]] = [panes[j], panes[i]];
  focused = Math.max(0, panes.findIndex(p => p.id === fid));
  relayout(true); save();
}
// ---- ドッキング型の並べ替え (dock-layout.js): a pane's header dragged (renderer: dockBegin -> dockHover ... -> dockDrop / dockEnd; a tab of the
// strip still swaps). The views are native and lie above the window's page, which gets no drag events over them: while the drag lasts every
// view is hidden behind a still of its page (capturePage, sent to the window first; hidden once the window shows them, at most DL.READY_MS
// later) and shown again by the drag's end in every case - the drop, dragend / Esc, the window losing focus, an overlay, the window's page gone,
// the window closing, DL.DRAG_MS at most. Only the visibility changes (showViews gives every view back by its usual rule: asleep / waiting for
// a load / stopped stay hidden); pages, loads, sleep and checks are not touched. The zone / preview / drop is decided here from the rows as they
// are at that moment; a drop onto itself, over a limit or that changes nothing does nothing.
let dock = null, dockNo = 0;                                // { seq, id: the dragged pane, hide: views hidden, at: the zone shown, end / ready: timers }
const dockHide = () => !!dock && dock.hide;
const dockSend = m => { try { if (win && !win.isDestroyed()) win.webContents.send('dock', m); } catch {} };
function dockBegin(id) {
  dockEnd('NEW');
  if (!byId(id) || panes.length < 2 || maximizedId != null || overlayOpen) return;   // nothing to dock onto: the drag does nothing
  const d = dock = { seq: ++dockNo, id, hide: false, at: '', end: setTimeout(() => dockEnd('TIME'), DL.DRAG_MS), ready: null };
  dockSend({ seq: d.seq, on: true });
  const cs = cells(), shown = panes.filter((q, i) => cs[i] && !q.sleeping && !viewHeld(q) && !q.view.webContents.isDestroyed());
  const still = q => Promise.race([Promise.resolve().then(() => q.view.webContents.capturePage()), new Promise(r => setTimeout(() => r(null), 250))]).then(img => {
    if (!img || img.isEmpty()) return '';
    const w = Math.round(q.bounds?.width || 0), im = w && img.getSize().width > w ? img.resize({ width: w }) : img;   // the view's own size (not Retina pixels)
    return 'data:image/jpeg;base64,' + im.toJPEG(80).toString('base64');
  }).catch(() => '');
  Promise.all(shown.map(q => still(q).then(url => ({ id: q.id, url })))).then(list => {
    if (dock !== d) return;                                    // already over: nothing was hidden
    dockSend({ seq: d.seq, on: true, shots: list.filter(s => s.url) });
    d.ready = setTimeout(() => dockReady(d.seq), DL.READY_MS);
  });
}
function dockReady(seq) {                                    // the window shows the stills (or did not answer in time): the views go
  const d = dock; if (!d || d.seq !== seq || d.hide) return;
  clearTimeout(d.ready); d.hide = true; showViews();
}
function dockZone(x, y) {                                    // the drop under the cursor now -> { to, side, grid: the rows after it, rect: the preview (the zone on the target pane / the edge band) }
  const d = dock, g = paneGrid(); if (!d || !g || !byId(d.id) || maximizedId != null) return null;
  const area = areaNow(), cs = cells(), z = DL.zoneAt(g, panes.map(p => p.id), cs, area, d.id, { x, y });
  const ng = z && DL.drop(g, d.id, z.to, z.side);
  const rect = ng ? DL.previewRect(cs[panes.findIndex(p => p.id === z.to)], z.side, area) : null;
  return rect ? { ...z, grid: ng, rect } : null;
}
function dockHover(x, y) {
  const d = dock; if (!d) return;
  const z = dockZone(x, y), key = z ? `${z.to}:${z.side}` : '';
  if (key === d.at) return;
  d.at = key; dockSend({ seq: d.seq, hover: z ? z.rect : null });
}
function dockDrop(x, y) {
  if (!dock) return;
  const z = dockZone(x, y);
  dockEnd('DROP');                                           // the views back first (where they were), then moved to the new rows
  if (!z || !applyGrid(z.grid)) return;
  relayout(true); save();
}
function dockEnd(code) {
  const d = dock; if (!d) return;
  dock = null; clearTimeout(d.end); clearTimeout(d.ready);
  if (d.hide) showViews();
  dockSend({ seq: d.seq, on: false });
  dlog('dock end', code);
}

function displayTitle(p) {
  const wc = p.view.webContents;
  let t = (p.sleeping && p.sleepSnap ? p.sleepSnap.title : wc.getTitle()) || '';
  const u = paneUrl(p);
  if (!u) return '新しいペイン';
  t = t.replace(/\s*[-|–—]\s*Grok\s*$/i, '').trim();
  if (!t || t === u) { try { t = new URL(u).hostname.replace(/^www\./, ''); } catch { t = u; } }
  return t;
}
function sendState(cs = cells()) {
  if (!win || win.isDestroyed()) return;
  const state = {
    layout, effLayout: (() => { if (!panes.length) return layout; return splitKey(); })(), max: MAX, focusedId: panes[focused]?.id, maximizedId, reloadChoices: RELOAD_CHOICES,
    platform: process.platform, dark: nativeTheme.shouldUseDarkColors, colors: COLORS,
    canReopen: CP.canReopen(closedStack, panes.length, MAX), globalZoom: gZoom(), syncCols: settings.syncCols !== false, canSync: getRows().length >= 2, splitters: splitters(), sleepGlobal: settings.sleepWaiting !== false, workspaces: Object.keys(workspaces), activeWs: workspaces[activeWs] ? activeWs : null, favorites, windowCount: ctxs.length, store: storeState(), chkHold: probeAuthHold,
    panes: panes.map((p, i) => {
      const wc = p.view.webContents, lt = lqView(p), rv = RP.view(p.rcv);   // its load in the queue (#31): waiting (with its place) / running; (#32) recovery
      return { id: p.id, index: i, url: paneUrl(p), title: displayTitle(p), name: p.name || '', color: p.color || 'none',
        lq: lt ? lt.state : '', lqPos: lt && lt.state === 'wait' ? lq.position(lt.id) : 0, held: viewHeld(p), idle: !!p.loadIdle && !lt,
        favicon: p.favicon || '', loading: wc.isLoading(), muted: !!p.muted, zoom: p.zoom || 1, zoomIndiv: !!p.zoomIndiv, isGrok: !!p.msgMode,
        canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward(),
        sleeping: !!p.sleeping, unopened: !!p.obs.unopened, obs: PS.shown(p.obs), sleepOn: p.sleepOn !== false, unread: p.unread, glow: !!p.glow, waiting: !!p.waiting, working: !!p.working, done: !!p.done, sname: p.sleeping && p.sleepSnap ? p.sleepSnap.name || '' : '', sgroup: p.sleeping && p.sleepSnap ? p.sleepSnap.group || '' : '', quote: p.sleeping && p.waiting && !p.done ? (p.reqQuote || '') : p.sleeping && p.restored ? p.restored.q || '' : '',
        rs: p.sleeping && p.restored ? SS.label(p.restored, Date.now()) : '', needsReply: !!p.needsReply, reloadMinutes: p.reloadMinutes, rect: cs[i],
        gone: rv.gone, fail: rv.fail, hang: rv.hang,             // (#32) renderer gone ('stopped' placeholder) / a failed load (retry planned / manual) / unresponsive
        chk: p.sleeping ? PB.label(p.pb, { hold: probeAuthHold, off: settings.sleepCheck === false }) : '' };   // (#33) last success / next check / failures / stopped
    }),
  };
  state.queue = queueBuild(state.panes);                      // (#01) 対応キュー: the bar's count and the open list
  queueNow = state.queue;                                    // (#51) ⌘⇧J reads it right after
  state.qNote = overlayOpen && overlayMode === 'queue' ? queueNote : '';
  win.webContents.send('state', state);
  scheduleOthers();
  if (overlayOpen) overlay.webContents.send('state', state);
}
// ---- 対応キュー (#01, attention-queue.js): each pane's facts as this state shows them -> the list; p.qSince follows the kind (gone with the item).
// A stale / unknown / sign-in state is never listed as 要返信 / 待機 (pane-state.js shown: only 'live' or the pane's own sleep state counts)
function queueBuild(rows, now = Date.now()) {
  const chk = settings.sleepCheck !== false;
  const items = AQ.build(panes.map((p, i) => {
    const s = rows[i] || {}, pb = p.sleeping && p.pb ? p.pb : null;
    return { id: p.id, url: s.url, name: s.name || s.sname || s.title, since: p.qSince, sleeping: !!p.sleeping, needsReply: !!p.needsReply, waiting: !!p.waiting,
      unopened: !!p.obs.unopened, shown: s.obs, issue: p.obs.issue, gone: s.gone, fail: s.fail, hang: s.hang,
      hold: !!p.sleeping && chk && probeAuthHold, fails: pb && chk ? pb.failureCount : 0,                   // (#33) checks stopped / failing
      checkedAt: p.sleeping ? Math.max(pb ? pb.lastSuccessAt || 0 : 0, p.restored ? 0 : p.markAt || 0) : 0 };   // asleep: last check / its own sleep (#22 restored: not)
  }), now);
  for (const p of panes) { const it = items.find(x => x.id === p.id); if (it) p.qSince = { kind: it.kind, at: it.at }; else delete p.qSince; }
  return items;
}

// ---- focus / activity ----
function setFocused(i) {
  if (i < 0 || i >= panes.length) return;
  if (navWait && navWait.id !== panes[i].id) navEnd('DROP');        // (#51) the user went elsewhere: the waiting keyboard move is dropped
  focused = i;
  if (panes[i].sleeping) reloadPane(panes[i]);                      // focusing a sleeping pane wakes it
  sendState(); save();
}
function focusPane(i, { clear = true } = {}) {
  const p = panes[i]; if (!p) return;
  if (maximizedId != null && maximizedId !== p.id) { maximizedId = p.id; relayout(true); }
  setFocused(i);
  if (clear) clearUnread(p);
  if (!p.view.webContents.isFocused()) p.view.webContents.focus();   // it has the keyboard already (clicked into): not focused again (a focus can drop its selection)
}
// p.glow – orange highlight; cleared by real interaction with the pane.
// p.unread – badge. Generic sites: content changes since cleared. grok.com chats (p.msgMode): bot messages since user's last send.
function clearUnread(p) {
  if (!p) return;
  const had = p.glow || (!p.msgMode && p.unread);
  p.glow = false;
  if (!p.msgMode) p.unread = 0;
  if (had) { updateBadge(); sendState(); }
}
function windowActive() { return win && !win.isDestroyed() && win.isFocused() && !win.isMinimized() && win.isVisible(); }
const inView = p => panes[focused] === p && windowActive() && (maximizedId == null || maximizedId === p.id);   // the user is looking at it
function canAlert(p) {
  if (!win) return false;
  if (inView(p)) return false;
  if (p.grokToken || p.grokPending) return false;
  if (Date.now() - p.loadedAt < 4000) return false;
  return true;
}
function lightUp(p, reason, always = false, key = '') {
  dlog(`pane${p.id}`, 'activity', reason);
  const first = !p.glow || always;
  p.glow = true;
  updateBadge(); sendState();
  if (first) notifyPane(p, p.msgMode ? 'ask' : 'update', key || `u${p.unread || 0}`, p.msgMode ? (p.waiting ? `待機中（未返信 ${p.unread}件）` : `新しいメッセージ ${p.unread}件`) : '新しい更新があります');
}
// (#61) the alert goes to the app-wide delivery (noticeOffer): duplicate / merge / mute / quiet hours are decided there; title = the pane's name
function notifyPane(p, kind, key, body) { noticeOffer(p, kind, key, body, p.name || displayTitle(p)); }
const isBotUrl = u => /^https:\/\/grok\.com\/bot\//.test(String(u || ''));
function resetCounts(p) { if (p.sleeping) return; const had = p.unread || p.glow || p.waiting || p.working || p.done || p.needsReply; p.snap = null; p.needsReply = false; p.msgMode = false; p.lastUserCount = null; p.lastMsg = null; p.unread = 0; p.glow = false; p.waiting = false; p.working = false; p.done = false; if (had) { updateBadge(); sendState(); } }
function markActivity(p, reason) {
  return;   // counts come ONLY from bot replies on grok.com/bot/* (onMsgCount); generic page changes never count

  if (p.msgMode || !canAlert(p)) return;
  p.unread = (p.unread || 0) + 1;
  lightUp(p, reason);
}
// The scan's snapshot (#03, pane-rules SNAP): every item valid or unknown with a fixed reason. Unknown is never read as 'empty' or 'nothing new'
// and never grounds an automatic action; name / quote / draft are judged on their own and do not affect the other items.
const { snapOk, snapUsable, snapIssue } = require('./pane-rules');
const botIdOf = u => (String(u || '').match(/^https:\/\/grok\.com\/bot\/([A-Za-z0-9_-]+)/) || [])[1] || '';   // = the preload's snap.cid for the same path
const sameTarget = (a, b) => { const x = botIdOf(a), y = botIdOf(b); return x || y ? x === y : String(a).split('#')[0] === String(b).split('#')[0]; };   // the same bot / page (#31)
// ---- generations (#02, pane-state.js): main owns the pane entity (p.obs.ent), its world generation and the background-check run ----
// A load / reload / URL change / SPA move / sleep / wake / renderer gone starts a new generation and the page gets its number (mpb:gen, again on
// dom-ready); a report counts only within the generation it was stamped with. p.obs is never saved.
function obsDo(p, a) { const r = PS.reduce(p.obs, a); p.obs = r.o; return r; }
function sendGen(p) { const wc = p.view.webContents; try { if (p.obs && !wc.isDestroyed()) wc.send('mpb:gen', p.obs.gen); } catch {} }   // no page right now (renderer gone): dom-ready sends it again
function newGen(p, why) { if (!p.obs) return; obsDo(p, { type: 'bump', gen: nextNo(), why }); sendGen(p); }
function onMsgCount(p, c) {
  if (p.sleeping) { diag.rec('count.drop', 'SLEEPING', { p: p.id }, 600000); return; }   // a sleeping pane keeps its remembered state
  const drop = PS.admit(p.obs, p.obs.ent, c.gen, c.seq);     // an older page / URL / reload, no number yet, a duplicate or out-of-order scan: nothing changes
  if (drop) { diag.rec('count.drop', drop, { p: p.id }, 600000); return; }
  const wc = p.view.webContents;
  if (!isBotUrl(wc.getURL())) { diag.rec('count.drop', 'NOT_BOT', { p: p.id }, 600000); resetCounts(p); return; }
  const s = c.snap;
  if (s && s.cid && s.cid !== botIdOf(wc.getURL())) { diag.rec('dom', 'OTHER_CONV', { p: p.id }, 600000); return; }   // scanned before the pane moved to another bot
  obsDo(p, { type: 'scan', ent: p.obs.ent, gen: c.gen, seq: c.seq, c });   // this generation's health / latest turn / confirmed marker / last stable fingerprint
  p.snap = s;                                                // what auto-sleep may rely on now (canSleep)
  const issue = snapIssue(s);
  if (!snapOk(s, 'conv') || !snapOk(s, 'roles')) {          // no confirmed conversation on the page (loading / login / sidebar only / generic guesses): keep what was known, act on none of it
    const code = issue === 'DOM_UNKNOWN' && (wc.isLoading() || p.grokToken || p.grokPending) ? 'LOADING' : issue;
    diag.rec('dom', code, { p: p.id }, 600000);
    sendState();                                             // the marker on screen is now only the last confirmed one
    return;
  }
  p.userSeen = { gen: c.gen, n: c.user };                    // (#12) user turns of this generation's confirmed conversation, a reply being written too (a broadcast's evidence)
  if (issue) diag.rec('dom', issue, { p: p.id }, 600000);
  if (!snapOk(s, 'stable')) { sendState(); return; }        // the page moved after its last stable report (a reply being written): no counts from it, no sleep on the old marker
  if (!snapOk(s, 'name')) diag.rec('dom', 'NAME_UNSURE', { p: p.id }, 600000);
  const prev = p.msgMode ? p.unread : null;
  p.msgMode = true;
  const same = p.lastMsg && p.lastMsg.user === c.user && p.lastMsg.bot === c.bot && p.lastMsg.botSince === c.botSince;
  p.lastMsg = c;
  if (!same) dlog(`pane${p.id}`, `msgcount user=${c.user} bot=${c.bot} bot_since=${c.botSince} method=${c.method}`);
  const userSent = p.lastUserCount != null && c.user > p.lastUserCount;
  p.lastUserCount = c.user;
  p.unread = c.botSince;
  const wasW = p.waiting; p.waiting = !!c.waiting;
  if (!wasW && p.waiting) p.waitSince = Date.now();
  if (wasW !== p.waiting) dlog(`pane${p.id}`, 'waiting', p.waiting);
  if (c.hn && snapOk(s, 'name')) { p.pageH1 = c.hn; p.pageHdr = c.hh || ''; }   // heading / header captured from the page (name + group for the sleeping placeholder); only an unambiguous one is kept
  p.reqQuote = p.waiting ? (snapOk(s, 'quote') ? c.q || '' : p.reqQuote || '') : '';   // the request quoted above the 🟢 marker (shown in the sleeping placeholder); unknown keeps the last one
  const wasD = p.done; p.done = !!c.done && !p.waiting && !c.working && c.botSince > 0;   // purple: latest marker says '終了' (no glow / notification / badge)
  if (!wasD && p.done) p.waitSince = Date.now();
  if (wasD !== p.done) dlog(`pane${p.id}`, 'done', p.done);
  const wasK = p.working; p.working = !!c.working && !p.waiting && !userSent && c.botSince > 0;   // red: latest marker says '作業中' (UI only; no notification / badge)
  if (wasK !== p.working) dlog(`pane${p.id}`, 'working', p.working);
  const wasAsk = p.needsReply; p.needsReply = !!(c.asks || c.waiting) && !c.working && !c.done && c.botSince > 0;
  if (wasAsk !== p.needsReply) dlog(`pane${p.id}`, 'needsReply', p.needsReply);
  if (userSent || c.botSince === 0) { if (p.glow) dlog(`pane${p.id}`, 'msgcount reset (user sent)'); p.glow = false; p.needsReply = false; }
  else if (!p.needsReply) { p.glow = false; }                      // plain progress report: grey number only
  else if (prev != null && (!wasAsk || c.botSince > prev) && canAlert(p) && !obsDo(p, { type: 'alert', key: PS.alertKey(c) }).code) { lightUp(p, `bot asks (${c.botSince})`, true, PS.alertKey(c)); return; }   // glow + notification only when waiting for the user, once per report
  updateBadge(); sendState();
}
function updateBadge() { updateDockBadge(); }
function nextUnread() {
  const n = panes.length;
  for (let k = 1; k <= n; k++) {
    const i = (focused + k) % n;
    if (panes[i].glow || panes[i].needsReply) { focusPane(i, { clear: false }); return; }
  }
}
// ---- keyboard moves (#51, pane-navigation.js) ----
// the ペイン menu and handleKey: nothing while a prompt / the palette / another overlay is open (the 対応キュー overlay is closed by the move)
function navKey(id) {
  if (overlayOpen && overlayMode !== 'queue') return;
  if (id === 'next') queueNext(); else moveFocus(id);
}
// the pane next to the focused one by position (the grid's rows / rectangles, also while one pane is maximized); none that way: nothing
function moveFocus(dir) {
  const i = PN.pick(cells(true), getRows(), focused, dir, getStacks());   // (dock) a stacked cell: up / down within it first
  if (i < 0) { diag.rec('nav', 'EDGE', { p: panes[focused]?.id }, 60000); return; }
  navGo(i, 'MOVE');
}
// the next item of the 対応キュー as it is now; none / only this pane listed: nothing. Marked read only when the user sees it (inView), as a choice
// from the list (queuePick)
function queueNext() {
  sendState();                                               // builds queueNow from the panes as they are now
  const cur = panes[focused], p = byId(PN.nextInQueue(queueNow, cur && cur.id));
  if (!p) { diag.rec('nav', 'NONE', { p: cur?.id }, 60000); return; }
  navGo(panes.indexOf(p), 'QUEUE');
  if (inView(p)) clearUnread(p);
}
// like a click on it: focusPane (maximized: the maximize follows; asleep: woken through the load queue). A pane not on screen yet gets the
// keyboard once it is shown (navSettle); meanwhile a key typed into the pane that kept the keyboard is not passed to its page (navHolds)
function navGo(i, code) {
  const p = panes[i]; if (!p) return;
  navEnd();                                                  // a newer move: the older one is dropped
  if (overlayOpen) closeOverlay();                           // only the 対応キュー overlay gets here (navKey)
  const from = panes[focused];
  focusPane(i, { clear: false });
  diag.rec('nav', code, { p: p.id });
  if (navShown(p) || !(p.sleeping || lqView(p))) return;     // on screen (the keyboard is there) / no load coming: nothing to wait for
  const fw = wcId(require('electron').webContents.getFocusedWebContents());
  const held = from && from !== p && fw && fw === wcId(from.view.webContents) ? from : null;   // the hidden view did not take the keyboard
  const w = navWait = { seq: ++navSeq, id: p.id, tw: wcId(p.view.webContents), fw, from: held ? held.id : 0, until: Date.now() + PN.WAIT_MS };
  if (held) {                                                // a click into that pane: the user stays there (its view had the keyboard all along)
    const wc = held.view.webContents;
    const onMouse = (e, m) => { if (m.type !== 'mouseDown' || navWait?.seq !== w.seq) return; navEnd('DROP'); const j = panes.indexOf(held); if (j >= 0) setFocused(j); };
    wc.on('before-mouse-event', onMouse); w.off = () => { try { wc.off('before-mouse-event', onMouse); } catch {} };
  }
  diag.rec('nav', 'WAIT', { p: p.id });
}
const navShown = p => panes.includes(p) && !p.sleeping && !viewHeld(p) && !!cells()[panes.indexOf(p)];
function navEnd(code) {
  const w = navWait; if (!w) return;
  navWait = null; if (w.off) w.off();
  if (code) diag.rec('nav', code, { p: w.id });
}
// relayout / showViews: the waiting move's pane is shown now (woken / its load started): the keyboard goes there only if nothing moved meanwhile
function navSettle() {
  const w = navWait; if (!w) return;
  const p = byId(w.id), now = Date.now();
  if (p && !navShown(p) && now <= w.until) return;           // not yet
  const ok = !!p && PN.mayFocus(w, { focusedId: panes[focused]?.id, overlay: overlayOpen, active: windowActive(), fw: wcId(require('electron').webContents.getFocusedWebContents()), t: now });
  navEnd(ok ? 'FOCUS' : 'DROP');
  if (ok) p.view.webContents.focus();
}
// a key reaching pane p: held back while a move waits and p kept the keyboard (the header already shows the other pane)
function navHolds(p, input) {
  if (!navWait || input.type !== 'keyDown') return false;
  const now = { pane: p.id, focusedId: panes[focused]?.id, t: Date.now() };
  if (PN.holds(navWait, now)) return true;
  if (now.focusedId !== navWait.id || now.t > navWait.until) navEnd('DROP');   // it no longer applies anywhere
  return false;
}

// ---- load reduction ----
// No CPU throttling of panes through the DevTools protocol (the old 省電力 / settings.ecoMode: Emulation.setCPUThrottlingRate 2 on every unfocused
// settled pane via wc.debugger). Its throttler kept stopping and resuming each such renderer's main thread and cost ~40% CPU per pane, sleeping
// about:blank ones included. Hidden panes are slowed by Chromium's own backgroundThrottling (pane webPreferences) and a sleeping pane has dropped
// its page. test/cpu-throttle.test.js keeps it that way.

// ---- grok.com/bot/<id> workaround ----
// grok.com renders the bot chat only after client-side navigation. After a direct load we
// click the sidebar link for the same bot (in an isolated JS world), and if none exists,
// load grok.com/ and click it from there. Bounded retries, one cycle per user-initiated load.
const GROK_BOT_RE = /^https:\/\/grok\.com\/bot\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/;
const probeCode = id => `(() => {
  const id = ${JSON.stringify(id)};
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const box = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')].some(vis);
  if (box && location.pathname.includes(id)) return 'rendered';
  const txt = (document.body && document.body.innerText) || '';
  if (/Page not found/i.test(txt)) return 'notfound';
  
  const a = [...document.querySelectorAll('a[href]')].find(a => (a.getAttribute('href') || '').includes('/bot/' + id));
  if (a) { a.click(); return 'clicked'; }
  return 'nolink';
})()`;
async function grokProbe(wc, id) {
  try { return await wc.executeJavaScriptInIsolatedWorld(1001, [{ code: probeCode(id) }]); }
  catch (e) { return 'error:' + e.message; }
}
const PUSH_GAP = Number(process.env.MPB_PUSH_GAP) || 3000, PUSH_FIRST = Number(process.env.MPB_PUSH_FIRST) || 1000;
async function grokFix(p, target, id, viaHome) {
  const wc = p.view.webContents, token = p.grokToken = Symbol();
  const alive = () => !wc.isDestroyed() && p.grokToken === token;
  p.botTarget = target;
  dlog(`pane${p.id}`, 'grokfix start', viaHome ? '(via home)' : '(direct)', target);
  // Fast path: poll for the rendered chat; whenever Next's router is up and the page is still not rendered, do the known-good '/' -> target hop
  // (re-tried every ~6 s while it keeps failing, so a push that landed before hydration is not lost).
  let lastPush = 0, pushes = 0; const t0 = Date.now();
  for (let k = 0; k < 70 && alive(); k++) {
    await sleep(k === 0 ? 120 : 350);
    const pr = await grokProbe(wc, id);
    if (pr === 'rendered' || pr === 'notfound') { dlog(`pane${p.id}`, 'grokfix fast', pr, pushes ? `after ${pushes} push(es)` : ''); diag.rec('grokfix', pr === 'rendered' ? 'FAST_RENDERED' : 'FAST_NOTFOUND', { p: p.id, ms: Date.now() - t0, n: pushes }); p.loadedAt = Date.now(); p.grokToken = null; p.hardTries = 0; p.wdTries = 0; return; }
    if (pushes >= 2 && Date.now() - lastPush > PUSH_GAP && (p.hardTries || 0) < 3) {
      // the router hop keeps missing: start over with a fresh load of the bot URL (bounded) instead of pushing forever
      p.hardTries = (p.hardTries || 0) + 1; p.grokToken = null;
      dlog(`pane${p.id}`, 'grokfix: hop failed twice -> hard reload', p.hardTries); diag.rec('grokfix', 'HARD_RELOAD', { p: p.id, ms: Date.now() - t0, n: p.hardTries });
      fixLoad(p, target); return;
    }
    if (pushes < 6 && Date.now() - lastPush > PUSH_GAP && Date.now() - t0 > PUSH_FIRST) {
      const rr = await wc.executeJavaScript(`(() => { const r = window.next && window.next.router;
        if (r && typeof r.push === 'function') { r.push('/'); setTimeout(() => r.push(${JSON.stringify('/bot/' + id)}), 350); return 'ok'; } return 'no'; })()`).catch(() => 'no');
      if (rr === 'ok') { lastPush = Date.now(); pushes++; dlog(`pane${p.id}`, 'grokfix push', pushes); }
    }
  }
  for (let i = 0; i < 8 && alive(); i++) {
    await sleep(i === 0 ? 300 : 1200);
    if (!alive()) return;
    const r = await grokProbe(wc, id);
    dlog(`pane${p.id}`, 'grokfix try', i + 1, r);
    if (r === 'rendered' || r === 'notfound') { diag.rec('grokfix', r === 'rendered' ? 'RENDERED' : 'NOTFOUND', { p: p.id, ms: Date.now() - t0, n: i + 1 }); p.loadedAt = Date.now(); p.grokToken = null; return; }   // logged out or bad id: leave as is
    if (r === 'nolink' && (i === 2 || i === 5)) {
      // No sidebar link (e.g. collapsed icon sidebar): ask Next.js' client router to navigate.
      const path = '/bot/' + id;
      const rr = await wc.executeJavaScript(`(() => { try { const r = window.next && window.next.router;
        if (r && typeof r.push === 'function') {
          const t = ${JSON.stringify('/bot/' + id)};
          if (${i === 5}) { r.push('/'); setTimeout(() => r.push(t), 1200); return 'router.push (via /)'; }
          r.push(t); return 'router.push'; } return 'no-router'; }
        catch (e) { return 'router-error'; } })()`).catch(e => 'error:' + e.message);
      dlog(`pane${p.id}`, 'grokfix router', path, rr);
      if (String(rr).startsWith('router.push')) {
        for (let j = 0; j < 5 && alive(); j++) {
          await sleep(1000);
          if (await grokProbe(wc, id) === 'rendered') { dlog(`pane${p.id}`, 'grokfix ok (router)'); diag.rec('grokfix', 'OK_ROUTER', { p: p.id, ms: Date.now() - t0, n: i + 1 }); p.loadedAt = Date.now(); p.grokToken = null; return; }
        }
      }
    }
    if (r === 'clicked') {
      for (let j = 0; j < 5 && alive(); j++) {
        await sleep(1000);
        const r2 = await grokProbe(wc, id);
        if (r2 === 'rendered') { dlog(`pane${p.id}`, 'grokfix ok'); diag.rec('grokfix', 'OK_CLICK', { p: p.id, ms: Date.now() - t0, n: i + 1 }); p.loadedAt = Date.now(); p.grokToken = null; return; }
        if (r2 === 'clicked') continue;           // clicked again, keep waiting
      }
    }
  }
  if (!alive()) return;
  p.grokToken = null; p.loadedAt = Date.now();
  if (!viaHome) {                                  // fallback: go home, then click the bot link
    dlog(`pane${p.id}`, 'grokfix fallback: load grok.com/ then navigate'); diag.rec('grokfix', 'FALLBACK_HOME', { p: p.id, ms: Date.now() - t0 });
    fixLoad(p, 'https://grok.com/', { target, id });
  } else {
    dlog(`pane${p.id}`, 'grokfix gave up; leaving page as is', target); diag.rec('grokfix', 'GAVE_UP', { p: p.id, ms: Date.now() - t0 });
  }
}
// Watchdog: a bot pane that is on screen, finished its fix routine, and still shows no chat box (blank / landing page) is reloaded
// through the fast path. Bounded (3 tries per pane, spaced out) so it can never loop.
// (#32) A pane whose renderer is gone or whose load failed is the recovery policy's (recover*): left alone here. Its reloads count there too.
const GROK_RENDERED = id => `(() => { const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return location.pathname.includes(${JSON.stringify(id)}) && [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')].some(vis) || /Page not found/i.test((document.body && document.body.innerText) || ''); })()`;
setInterval(async () => {
  if (process.env.MPB_NO_WATCHDOG) return;
  for (const c of ctxs) for (const p of c.panes) {
    try {
      const wc = p.view.webContents;
      if (wc.isDestroyed() || p.sleeping || p.grokToken || p.grokPending || wc.isLoading() || !settings.grokFix) continue;
      if (wc.isCrashed() || RP.view(p.rcv).gone || RP.owns(p.rcv)) continue;   // (#32) renderer gone: manual only; a failed load: retried there (bounded) or manual
      if (lqView(p, false) || p.loadIdle) continue;                     // waiting / loading in the queue, or its wait was cancelled (取消): about:blank is expected
      const cu = wc.getURL(), m = cu.match(GROK_BOT_RE);
      const own = p.botTarget || (GROK_BOT_RE.test(p.url || '') ? p.url : null);   // the pane's own bot link
      const id = m ? m[1] : (own && (isBlankUrl(cu) || cu.startsWith('https://grok.com')) ? (own.match(GROK_BOT_RE) || [])[1] : null);
      if (!id) continue;
      const b = p.view.getBounds(); if (!b.width || !b.height || Date.now() - (p.loadedAt || 0) < 20000 || Date.now() - (p.lastReload || 0) < 20000) continue;
      if (await wc.executeJavaScript(GROK_RENDERED(id)).catch(() => true)) { p.wdTries = 0; continue; }
      if ((p.wdTries || 0) >= 3 || Date.now() - (p.wdAt || 0) < 30000) continue;
      if (!autoGate(p, await liveInput(p), 'watchdog')) continue;   // #11: a page that holds input is never reloaded by itself (tried again later)
      p.wdTries = (p.wdTries || 0) + 1; p.wdAt = Date.now(); p.rcv = RP.took(p.rcv, p.wdAt);   // (#32) one of the pane's automatic reloads (10 min / 2 there)
      dlog(`pane${p.id}`, 'watchdog: blank bot pane -> reload', p.wdTries); diag.rec('watchdog', 'RELOAD', { p: p.id, n: p.wdTries });
      reloadPane(p, 'BULK');
    } catch {}
  }
}, 10000);
function onGrokLoad(p) {
  if (!settings.grokFix) { p.grokPending = null; return; }
  const url = p.view.webContents.getURL();
  if (p.grokPending) {
    const { target, id } = p.grokPending; p.grokPending = null;
    if (/^https:\/\/grok\.com\/?(?:[?#].*)?$/.test(url)) grokFix(p, target, id, true);
    return;
  }
  if (p.grokSkipOnce) { p.grokSkipOnce = false; return; }
  const m = url.match(GROK_BOT_RE);
  if (m) grokFix(p, url, m[1], false);
}


// Reload that works for grok.com/bot/<id>: cancel any pending retry / 'gave up' state, hop via the in-site router at once
// (hard-load the URL if the router isn't ready within ~1 s), then let grokFix verify / retry. Other pages: plain reload.
// (#31) A pane's reload / wake is a task of the shared load queue (cls USER: the user's own, BULK: reload-all / automatic reloads); the body below
// runs once that task has its slot (task). A sleeping pane stays asleep - its placeholder says it waits - until then. The 承認Bot popup: at once.
async function reloadPane(p, cls = 'USER', task = null) {
  const wc = p.view.webContents; if (wc.isDestroyed()) return;
  if (p.obs && !task) {
    if (p.sleeping) { if (debugOn()) dlog(`pane${p.id}`, 'wake from', new Error().stack.split('\n').slice(2, 5).map(l => l.trim().replace(/\(.*[\/]/, '(')).join(' < ')); abortProbe(p); }   // waking ends the sleep's check now
    viewLoad(p, p.sleeping ? 'WAKE' : 'RELOAD', cls, paneUrl(p), t => reloadPane(p, cls, t));
    return;
  }
  if (p.sleeping) { diag.rec('sleep', 'WAKE', { p: p.id, ms: Date.now() - (p.sleepAt || Date.now()) }); abortProbe(p); p.sleeping = false; p.sleepSnap = null; p.restored = null; if (p.obs) obsDo(p, { type: 'wake', gen: nextNo() }); p.lastInteract = Date.now(); relayout(); sendState(); }   // wake from sleep: a new generation, ends the sleep's check / baseline, clears 'unopened'
  else newGen(p, 'RELOAD');                                  // reports scanned before this reload no longer count
  p.lastReload = Date.now();
  p.grokPending = null; p.grokSkipOnce = false; p.hardTries = 0; p.wdTries = 0; p.wdAt = 0;       // forget every 'gave up' / retry counter
  const cu = wc.getURL(), m = cu.match(GROK_BOT_RE);
  const remembered = p.botTarget || (GROK_BOT_RE.test(p.url || '') ? p.url : null);
  const target = m ? cu : (remembered && (!cu || /^(?:about:blank|chrome-error:|https:\/\/grok\.com\/)/.test(cu)) ? remembered : null);   // a pane that gave up sits on grok.com home: use its remembered bot link
  const id = target && target.match(GROK_BOT_RE)?.[1];
  if (!id || !settings.grokFix) {
    p.grokToken = null; diag.rec('reload', 'PLAIN', { p: p.id });
    if (isBlankUrl(cu) && !isBlankUrl(p.url) && p.url !== NEWTAB) appLoad(wc, p.url); else wc.reload();   // blank pane: reload its own URL, not about:blank
    return;
  }
  if (isBlankUrl(cu)) { p.grokToken = null; p.loadedAt = Date.now(); dlog(`pane${p.id}`, 'reload from blank: hard load', target); diag.rec('reload', 'BLANK_LOAD', { p: p.id }); appLoad(wc, target); return; }   // nothing to hop from (woken / blank pane)
  if (wc.isCrashed() || RP.view(p.rcv).gone) { p.grokToken = null; p.loadedAt = Date.now(); dlog(`pane${p.id}`, 'reload after renderer gone: hard load'); diag.rec('reload', 'GONE_LOAD', { p: p.id }); appLoad(wc, target); return; }   // (#32) no page to hop in: a new renderer
  const token = p.grokToken = Symbol();      // cancels a running grokFix
  p.loadedAt = Date.now();
  if (wc.isLoading()) { try { wc.stop(); } catch {} }      // restart a load that is stuck half way
  dlog(`pane${p.id}`, 'reload fast path', target);
  const t0 = Date.now();
  while (!wc.isDestroyed() && p.grokToken === token && Date.now() - t0 < 1000) {
    const rr = await wc.executeJavaScript(`(() => { const r = window.next && window.next.router;
      if (r && typeof r.push === 'function') { r.push('/'); setTimeout(() => r.push(${JSON.stringify('/bot/' + id)}), 250); return 'ok'; } return 'no'; })()`).catch(() => 'no');
    if (rr === 'ok') {
      dlog(`pane${p.id}`, 'reload router push at', Date.now() - t0, 'ms');
      for (let j = 0; j < 20 && !wc.isDestroyed() && p.grokToken === token; j++) {
        await sleep(200);
        if (await grokProbe(wc, id) === 'rendered') { dlog(`pane${p.id}`, 'reload ok (router)'); diag.rec('reload', 'ROUTER_OK', { p: p.id, ms: Date.now() - t0 }); p.grokToken = null; p.loadedAt = Date.now(); return; }
      }
      if (wc.isDestroyed() || p.grokToken !== token) return;
      diag.rec('reload', 'ROUTER_MISS', { p: p.id, ms: Date.now() - t0 });
      p.grokToken = null; grokFix(p, target, id, false); return;     // router hop did not land: normal verified retries
    }
    await sleep(100);
  }
  if (wc.isDestroyed() || p.grokToken !== token) return;
  p.grokToken = null;
  dlog(`pane${p.id}`, 'reload: router not ready, hard load', target); diag.rec('reload', 'HARD_LOAD', { p: p.id, ms: Date.now() - t0 });
  appLoad(wc, target);                       // did-finish-load -> onGrokLoad -> grokFix
}

// ---- sleep for 🟢 waiting / 🟣 done panes (frees the page's memory; header / tab / green status / counts stay) ----
// A pane sleeps when its last marker is 🟣 終了 (after SLEEP_DONE_MS = 1 min) or 🟢 待機中 (after SLEEP_WAIT_MS = 30 min) and nobody touched it. It never sleeps while 🔴 working, unmarked, focused,
// maximized, in the cloud-PC view, being edited or loading. Waking (click / focus / reload) goes through reloadPane with the stored bot URL.
const { sleepDelayFor, sleepIdentity } = require('./sleep-rules');
const { placeReopened } = require('./reopen-rules');
const sleepDelay = p => Number(process.env.MPB_SLEEP_SEC) > 0 ? ((p.waiting || p.done) && !p.working ? Number(process.env.MPB_SLEEP_SEC) * 1000 : null)   // dev override: same delay for both
  : sleepDelayFor(p, settings.sleepMinutes > 0 ? settings.sleepMinutes * 60000 : undefined);
function canSleep(p, i, force) {
  const wc = p.view.webContents; if (wc.isDestroyed() || p.sleeping) return false;
  if (!force && (settings.sleepWaiting === false || p.sleepOn === false)) return false;
  if (!(p.waiting || p.done) || p.working || !isBotUrl(wc.getURL()) || i === focused || maximizedId === p.id || p.pcMax || p.editing) return false;
  if (wc.isLoading() || p.grokToken || p.grokPending) return false;
  if (lqView(p, false)) return false;                        // a load of it waits / runs in the queue (#31)
  if (!force && p.hasDraft) return false;                   // typed text / pending attachment in the composer
  if (!force && !(snapUsable(p.snap) && p.snap.cid === botIdOf(wc.getURL()))) return false;   // the latest scan of this very conversation must be sure: unknown / stale never puts a pane to sleep
  if (!force && !PS.sleepOk(p.obs)) return false;            // ...and of this very generation (#02): after a reload / URL or SPA move, a new turn, a reply being written or loading, an old 🟢 / 🟣 does not count
  if (!force) { const d = sleepDelay(p); if (d == null || Date.now() - Math.max(p.lastInteract || 0, p.waitSince || 0, p.lastTyping || 0, p.loadedAt || 0) < d) return false; }   // waitSince = when 待機中 / 終了 was first detected
  return true;
}
function sleepPane(p) {
  const wc = p.view.webContents; if (wc.isDestroyed() || p.sleeping) return;
  p.sleepSnap = { title: displayTitle(p), favicon: p.favicon || '' };
  Object.assign(p.sleepSnap, sleepIdentity({ h1: p.pageH1, hdr: p.pageHdr, userName: p.name, title: p.sleepSnap.title }));   // bot name + group name shown in the placeholder (falls back to the tab title)
  p.sleeping = true; p.sleepAt = p.markAt = Date.now(); p.grokToken = null; p.grokPending = null; p.pb = PB.init(p.sleepAt, SLEEP_CHECK_MS);   // (#33) a new sleep: its first check one interval later; (#22) markAt: its marker last seen
  recoverCancel(p, true);                                    // (#32) a sleeping pane is never reloaded by itself; what it showed about its page goes
  obsDo(p, { type: 'sleep', gen: nextNo() });                // a sleep generation: the background check compares against the stable fingerprint confirmed in the generation that fell asleep (none -> its first result is only a baseline)
  dlog(`pane${p.id}`, 'sleep', paneUrl(p)); diag.rec('sleep', 'SLEPT', { p: p.id });
  p.view.setVisible(false);
  appLoad(wc, 'about:blank');                                // drops the page (its URL stays in p.url / p.botTarget); an unload: no queue slot (#31)
  sendState(); save();
}
// (#22) a pane saved asleep (設定 > 前回のスリープ状態を復元): starts asleep with no page and no load in the queue; opening it is the usual wake
// (reloadPane: the queue, the user's own first). Its placeholder shows the saved name / group / marker as 前回・未再確認 (r = restorePlan());
// none of it sets waiting / unread / glow / needsReply, so no colour, Dock badge or notification. A sleep generation without a baseline: its
// first background check (one interval later, #33) is only a baseline
function restoreAsleep(p, r) {
  p.sleepSnap = { title: r.nm || p.name, favicon: '', name: r.nm || p.name, group: r.gp };
  p.sleeping = true; p.sleepAt = Date.now(); p.restored = r; p.pb = PB.init(p.sleepAt, SLEEP_CHECK_MS);
  obsDo(p, { type: 'sleep', gen: nextNo() });
  p.view.setVisible(false);
  dlog(`pane${p.id}`, 'restored asleep', r.age);
}
// ---- input guard (#11, draft-guard.js) ----
// The live reading right before a page is thrown away: the shared composerState() run in the page (timeout CHECK_MS), framed by main's stamps
// of the pane (entity / generation #02 / keys typed / asleep), so an answer about an older page, or one overtaken by typing, is unknown.
const inStamp = p => ({ ent: p.obs.ent, gen: p.obs.gen, rev: p.inputRev || 0, closed: !!p.obs.closed, sleeping: !!p.sleeping });
// main's own state: does the pane hold a page whose input could be lost? Not when asleep, blank / queued at startup, an error page, the new-tab
// page or a gone renderer - those are never read or asked about, so a new empty view, a first load and a wake are never held up.
function hasPage(p) {
  const wc = p.view.webContents; if (p.sleeping || wc.isDestroyed() || wc.isCrashed()) return false;
  const u = wc.getURL(); return !isBlankUrl(u) && !(u.startsWith('file:') && u.includes('newtab.html'));
}
async function liveInput(p) {
  const before = inStamp(p), page = hasPage(p), expect = page && isBotUrl(p.view.webContents.getURL()) && PS.current(p.obs);   // a confirmed conversation has a composer
  let raw = null;
  if (page) { try { raw = await Promise.race([p.view.webContents.executeJavaScriptInIsolatedWorld(1003, [{ code: COMPOSER_JS }]), sleep(GUARD.CHECK_MS).then(() => null)]); } catch { raw = null; } }   // own world: page scripts cannot change what it uses
  const r = GUARD.read(raw, { page, before, after: inStamp(p), at: Date.now(), expect, ime: !!p.ime, busy: !!p.broadcasting, hold: !!p.guardHold });
  if (page) diag.rec('draft', r.st, { p: p.id }, 600000);
  return r;
}
// automatic operations (auto-sleep / auto-reload / watchdog): go only when the reading says the page clearly holds nothing to lose
function autoGate(p, r, what) {
  const code = GUARD.autoRefusal(r, Date.now());
  if (code) { diag.rec('guard.auto', code, { p: p.id }, 600000); if (debugOn()) dlog(`pane${p.id}`, 'auto', what, 'held:', code); }
  return !code;
}
async function trySleep(p) {
  if (p.sleepChecking) return; p.sleepChecking = true;
  try {
    const r = await liveInput(p);
    if (r.st === 'PRESENT') p.hasDraft = true; else if (r.st === 'EMPTY') p.hasDraft = false;   // an unknown reading changes nothing: tried again on the next tick
    if (autoGate(p, r, 'sleep') && canSleep(p, panes.indexOf(p))) sleepPane(p);
  } finally { p.sleepChecking = false; }
}
async function autoReload(p) {                                 // the per-pane 自動リロード (top-level timer)
  if (p.autoChecking) return; p.autoChecking = true;
  try {
    const r = await liveInput(p);
    if (!autoGate(p, r, 'reload') || !panes.includes(p) || p.editing || p.view.webContents.isLoading() || lqView(p, false)) return;   // a load of it already queued / running: next tick
    p.lastReload = Date.now(); reloadPane(p, 'BULK');
  } finally { p.autoChecking = false; }
}
// ---- limited recovery (#32, recovery-policy.js; the tick at the top level). p.rcv: automatic reloads in the window, the one planned reload
// (entity / generation / URL it is for), the failure note, the renderer gone, unresponsive. Memory only, never saved, gone with the pane.
// did-fail-load (also the dev hook): only a failed main-frame load of a web page counts. The error page that replaced the document is a new
// generation (#02); a transient failure gets a planned reload, anything else waits for the user
function recoverFail(p, code, url, isMain) {
  if (p.disposed || p.sleeping || !p.rcv) return;
  const web = /^https?:/i.test(String(url || '')), k = RP.classify({ type: 'fail', code, main: isMain === true, web }).kind;
  if (k !== 'TRANSIENT' && k !== 'PERMANENT') return;        // ERR_ABORTED (an intended cancel) / a child frame / not a web page: no failure of the page
  recoverLive(p);                                            // an error page has a renderer: not 'stopped' any more
  newGen(p, 'FAIL');
  const r = RP.onFail(p.rcv, { code, main: true, web, ent: p.obs.ent, gen: p.obs.gen, url }, Date.now()); p.rcv = r.rec;
  if (r.code) diag.rec('recover', r.code, { p: p.id, n: r.n });
  dlog(`pane${p.id}`, 'load failed', k, r.code, r.rec.due ? `reload in ${r.rec.due.wait / 1000}s` : 'manual only');
  sendState();
}
// render-process-gone: the 'stopped' placeholder instead of the view, manual reload only (clean-exit: nothing). Asleep: nothing to show
function recoverGone(p, reason) {
  if (p.disposed || p.sleeping || !p.rcv) return;
  const r = RP.onGone(p.rcv, reason); p.rcv = r.rec;
  if (!r.code) return;
  p.grokToken = null; p.grokPending = null;                  // a running bot-page fix has no page any more
  diag.rec('recover', r.code, { p: p.id });
  dlog(`pane${p.id}`, 'renderer gone: manual reload only');
  showViews();
}
function recoverHang(p, on) { if (p.disposed || !p.rcv) return; p.rcv = RP.onHang(p.rcv, on); sendState(); }   // shown only; never a reason to reload
// a live renderer again (a new page / an error page): the 'stopped' placeholder goes and the view comes back
function recoverLive(p) {
  const wc = p.view.webContents; if (!p.rcv || !p.rcv.gone || wc.isDestroyed() || wc.isCrashed()) return;
  const r = RP.revived(p.rcv); p.rcv = r.rec;
  if (r.code) diag.rec('recover', r.code, { p: p.id });
  showViews();
}
// did-navigate: a new page - nothing planned / noted is about it any more
function recoverPage(p) {
  if (!p.rcv) return;
  const r = RP.committed(p.rcv); p.rcv = r.rec;
  if (r.code) diag.rec('recover', r.code, { p: p.id });
  recoverLive(p);
}
// the user's own load (viewLoad USER) / sleep / close (clear: what the pane showed about its page goes too)
function recoverCancel(p, clear = false) {
  if (!p.rcv) return;
  const r = RP.cancel(p.rcv, { clear }); p.rcv = r.rec;
  if (r.code) diag.rec('recover', r.code, { p: p.id });
}
const recoverSeen = p => { const wc = p.view.webContents, gone = wc.isDestroyed();
  return { ent: p.obs.ent, gen: p.obs.gen, url: paneUrl(p), closed: !!p.disposed || !!p.obs.closed || !panes.includes(p), sleeping: !!p.sleeping, crashed: gone || wc.isCrashed(),
    idle: !!p.loadIdle, busy: !!p.broadcasting, ime: !!p.ime, hold: !!p.guardHold, loading: !gone && wc.isLoading(), queued: !!lqView(p, false), fixing: !!(p.grokToken || p.grokPending) }; };
function recoverStep(p) {                                      // the planned reload against the pane now -> true: go
  const r = RP.check(p.rcv, recoverSeen(p), Date.now()); p.rcv = r.rec;
  if (r.code) { diag.rec('recover', r.code, { p: p.id, n: RP.count(p.rcv, Date.now()) }); sendState(); }
  return r.act === 'go';
}
// the tick: the due panes of this window, the one due first first; at most one reload starts (-> true)
function recoverNext() {
  if (!win || win.isDestroyed()) return false;
  for (const i of RP.dueList(panes.map(q => q.rcv), Date.now())) {
    const p = panes[i];
    if (p.recChecking || !recoverStep(p)) continue;
    recoverGo(p); return true;
  }
  return false;
}
// read right before (#11: draft / attachment / upload / IME / unknown / a broadcast stop it, manual only then), checked again, then the queue (#31)
async function recoverGo(p) {
  p.recChecking = true;
  try {
    const g = await liveInput(p);
    if (!RP.isDue(p.rcv, Date.now())) return;                // dropped meanwhile (closed / asleep / the user's own load / a new page)
    if (!autoGate(p, g, 'recover')) { const r = RP.skip(p.rcv, GUARD.autoRefusal(g, Date.now())); p.rcv = r.rec; diag.rec('recover', r.code, { p: p.id }); sendState(); return; }
    if (!recoverStep(p)) return;                             // moved on / started loading while it was read
    p.rcv = RP.took(p.rcv, Date.now()); diag.rec('recover', 'RETRY', { p: p.id, n: RP.count(p.rcv, Date.now()) });
    dlog(`pane${p.id}`, 'recover: automatic reload', RP.count(p.rcv, Date.now()));
    p.lastReload = Date.now(); reloadPane(p, 'BULK');
  } finally { p.recChecking = false; }
}
// dev (MPB_RECOVERY_DEBUG=1, the pane's context menu): synthetic events into the same handlers as the real ones - no renderer is crashed and
// no load really fails (a synthetic 'stopped' page keeps its live page under the placeholder: its reload goes through the guard as usual)
const recoverDebugItems = p => [
  { label: '（開発）一時的な読込失敗', click: () => recoverFail(p, -106, paneUrl(p), true) },
  { label: '（開発）恒久的な読込失敗', click: () => recoverFail(p, -20, paneUrl(p), true) },
  { label: '（開発）取消（ERR_ABORTED）', click: () => recoverFail(p, RP.ABORTED, paneUrl(p), true) },
  { label: '（開発）子フレームの読込失敗', click: () => recoverFail(p, -106, paneUrl(p), false) },
  { label: '（開発）ページ停止（crashed）', click: () => recoverGone(p, 'crashed') },
  { label: RP.view(p.rcv).hang ? '（開発）応答再開' : '（開発）応答なし', click: () => recoverHang(p, !RP.view(p.rcv).hang) }];
// Manual operations that throw pages away. targets() = the panes it would drop right now (asked again right before acting), run(list) does it.
// Nothing that could hold input -> at once, as before. Otherwise every target is read; the panes at risk are listed in one dialog (default / Esc =
// やめる; skip: 'all but those' for reload-all); after a confirmation all are read again and any change cancels. Cancelled / expired: nothing
// happens and the focus goes back where it was. One at a time per window: a second ⌘W waits for the first.
let guardQ = null, guardN = 0;
const paneLabel = p => p ? p.name || displayTitle(p) : '';
function guardRun(op, targets, run, opt = {}) {
  if (!guardN && !targets().some(hasPage)) { run(targets()); return; }
  if (guardN >= 5) { diag.rec('guard.ask', 'BUSY'); return; }
  guardN++;
  guardQ = (guardQ || Promise.resolve()).then(() => guardOnce(op, targets, run, opt)).catch(e => dlog('guard error', op, String(e))).finally(() => { guardN--; });
}
async function guardOnce(op, targets, run, { skip = false } = {}) {
  const ts = targets(), fw = require('electron').webContents.getFocusedWebContents();
  const back = () => { try { if (fw && !fw.isDestroyed()) fw.focus(); } catch {} };
  const readAll = async list => (await Promise.all(list.map(p => liveInput(p)))).map((r, i) => ({ id: list[i].id, r }));
  ts.forEach(p => { p.guardHold = true; });                  // no automatic operation on them meanwhile
  try {
    let last = await readAll(ts), only = null;
    const pl = GUARD.plan(last);
    if (pl.ask.length) {
      diag.rec('guard.ask', 'ASKED', { n: pl.ask.length });
      const d = GUARD.dialogText(op, pl.ask.map(a => ({ label: paneLabel(byId(a.id)), codes: a.codes })), { skip: skip && pl.pass.length > 0 });
      const { response } = await dialog.showMessageBox(win, { type: 'warning', message: d.message, detail: d.detail, buttons: d.buttons, defaultId: d.defaultId, cancelId: d.cancelId, noLink: true });
      const act = d.actions[response] || 'cancel';
      if (act === 'cancel') { diag.rec('guard.ask', 'CANCEL', { n: pl.ask.length }); back(); return; }
      if (act === 'skip') { only = pl.pass; last = last.filter(x => only.includes(x.id)); }
      const again = await readAll(ts.filter(p => last.some(x => x.id === p.id)));
      const why = GUARD.expired(last, again, Date.now());    // the confirmation was for what was shown: anything else now cancels it
      if (why) { diag.rec('guard.ask', why, { n: pl.ask.length }); dlog('guard', op, 'confirmation no longer holds:', why); back(); return; }
      last = again;
    }
    const cur = targets().filter(p => !only || only.includes(p.id));
    const why = GUARD.unmoved(last, cur.map(p => ({ id: p.id, stamp: inStamp(p) })));   // right before acting: the same panes, nothing moved since read
    if (why) { diag.rec('guard.ask', why, { n: cur.length }); dlog('guard', op, 'changed before acting:', why); back(); return; }
    if (pl.ask.length) diag.rec('guard.ask', 'GO', { n: pl.ask.length });
    cur.forEach(p => { const x = pl.ask.some(a => a.id === p.id) && last.find(y => y.id === p.id); p.guardOk = x ? x.r : null; });   // what the user confirmed: a load that has to wait for its slot is read again against it (#31)
    run(cur);
  } finally { ts.forEach(p => { p.guardHold = false; p.guardOk = null; }); }
}
const onlyPane = p => () => p && panes.includes(p) ? [p] : [];   // targets(): this pane while it is open
function askClose(id) {                                        // ✕ / ⌘W / menus (no id: the pane focused when it runs)
  guardRun('CLOSE', () => { const p = id == null ? panes[focused] : byId(id); return p ? [p] : []; }, l => l.forEach(p => closePane(p.id)));
}
function askReload(id) {                                       // ↻ / ⌘R / menus (no id: the focused pane); a sleeping pane has no page: woken at once
  guardRun('RELOAD', () => { const p = id == null ? panes[focused] : byId(id); return p ? [p] : []; }, l => l.forEach(p => reloadPane(p)));
}
function openIn(p, url, op = 'NAVIGATE', then) {               // another URL in this pane (address bar, palette, favorite, ⌘T at the pane limit)
  const u = url === NEWTAB ? NEWTAB : normalize(url);
  if (paneStart(u) !== u) { navBlocked(NAV.appLoad(u), 'address', p && p.view.webContents); return; }   // (#72) refused (javascript: / file: ...): the page stays, nothing asked
  guardRun(op, onlyPane(p), l => l.forEach(q => { navTo(q, url); then?.(q); }));
}
function navTo(p, url) {                                       // (#31) a user's own load through the queue; the local new-tab page at once (its waiting / running load ends)
  const u = url === NEWTAB ? NEWTAB : normalize(url);
  if (u === NEWTAB) { lqDrop(p, 'URL'); loadInto(p.view.webContents, u); return; }
  viewLoad(p, 'NAV', 'USER', u, () => loadInto(p.view.webContents, u));
}
function goHist(p, dir) {                                      // back / forward
  const h = p && p.view.webContents.navigationHistory; if (!h || !(dir < 0 ? h.canGoBack() : h.canGoForward())) return;
  guardRun(dir < 0 ? 'BACK' : 'FORWARD', onlyPane(p), l => l.forEach(q => viewLoad(q, 'NAV', 'USER', '', () => { const n = q.view.webContents.navigationHistory; if (dir < 0 ? n.canGoBack() : n.canGoForward()) dir < 0 ? n.goBack() : n.goForward(); })));
}
function openLink(wc, url) {                                   // a grok.com link opened from the page into its own pane (linkOpen)
  const p = panes.find(q => q.view.webContents === wc); if (!p) return;
  guardRun('LINK', onlyPane(p), l => l.forEach(q => viewLoad(q, 'NAV', 'USER', url, () => appLoad(q.view.webContents, url))));
}
function sleepNowAsk(p) {                                      // manual 今すぐスリープ: asks when the page holds input (or cannot tell)
  if (!canSleep(p, panes.indexOf(p), true)) return;
  guardRun('SLEEP', onlyPane(p), l => l.forEach(q => { if (canSleep(q, panes.indexOf(q), true)) sleepPane(q); }));
}
function sleepTick() { panes.forEach((p, i) => { if (canSleep(p, i)) trySleep(p); }); }

// ---- this window's loads through the shared queue (#31; lq / lqPoll at the top) ----
// The pane's view load in the queue: live = waiting / running (what the screen shows), else also one still stopping after a cancel
const lqView = (p, live = true) => p.obs ? lq.find(t => t.ent === p.obs.ent && !t.probe && (!live || t.state !== 'stop')) : null;
// nothing to show yet / any more and waiting for a load (startup / new pane / 取消): its view stays hidden behind the placeholder (no blank page);
// (#32) a renderer gone: hidden behind the 'stopped' placeholder until a new page has a renderer
const viewHeld = p => !p.sleeping && (!hasPage(p) && (!!p.loadIdle || lqView(p)?.state === 'wait') || RP.view(p.rcv).gone);
const lqDrop = (p, code) => p.obs && lq.cancel(t => t.ent === p.obs.ent && !t.probe, code);   // its waiting / running view load ends (a running one once it has stopped)
// purpose: START / OPEN / WAKE / RELOAD / NAV / FIX; cls: USER / BULK; url: the page it is expected to load ('' = unknown); go(t): the load itself
function viewLoad(p, purpose, cls, url, go) {
  if (!p.obs) { go(null); return null; }                     // the 承認Bot popup: not a pane, loads at once as before
  if (cls === 'USER') recoverCancel(p);                      // (#32) the user's own load: no automatic reload of the pane is planned any more
  const { task, merged } = lq.request({ ent: p.obs.ent, gen: p.obs.gen, purpose, cls, win: ctx, url,
    data: { no: p.id, ok: p.guardOk || null, rank: () => panes[focused] === p ? 0 : 1 },
    onStart: t => startView(t, p, go), onStop: t => stopView(t, p), onEnd: (t, code) => endView(t, p, code) });
  if (merged && p.guardOk) task.data.ok = p.guardOk;          // merged into a waiting load: the user's confirmation counts for it
  return task;
}
// the task has its slot -> a promise that settles when its slot may go back (lqPoll: settled / stopped / view gone)
function startView(t, p, go) {
  return new Promise(resolve => {
    const wc = p.view.webContents;
    if (wc.isDestroyed() || !panes.includes(p)) { resolve('GONE'); return; }
    const run = { t, p, wc, t0: Date.now(), began: false, resolve };
    lqRuns.set(t.id, run); lqPollOn();
    const begin = () => {
      if (t.state !== 'run') { lqEnd(run, 'STOPPED'); return; }   // cancelled while its input was read: nothing was loaded
      run.began = true; run.t0 = Date.now(); p.loadIdle = false; p.loadCls = t.cls;
      try { Promise.resolve(go(t)).catch(e => dlog(`pane${p.id}`, 'load error', String(e))); } catch (e) { dlog(`pane${p.id}`, 'load error', String(e)); lqEnd(run, 'ERROR'); return; }
      showViews();
    };
    if (!t.waited || !hasPage(p)) { begin(); return; }       // right after its request (its caller / the guard just decided), or no page to lose (new view, asleep, blank)
    lqRecheck(t, p).then(ok => { if (ok) begin(); else lqEnd(run, 'GUARD'); });
  });
}
// it waited: the input guard's answer (#11) was for then. Read again right before the page is replaced: what the user confirmed must be unchanged,
// anything else must clearly hold nothing (as for an automatic operation). Otherwise the load is dropped and the page stays as it is
async function lqRecheck(t, p) {
  try {
    const r = await liveInput(p), ok = t.data && t.data.ok;
    if (t.state !== 'run') return false;
    const code = ok ? GUARD.expired([{ id: p.id, r: ok }], [{ id: p.id, r }], Date.now()) : GUARD.autoRefusal(r, Date.now());
    if (code && ok) diag.rec('guard.ask', code, { p: p.id }); else if (code) diag.rec('guard.auto', code, { p: p.id }, 600000);
    if (code && debugOn()) dlog(`pane${p.id}`, 'queued load dropped before it started:', code);
    return !code;
  } catch { return false; }                                  // could not read: nothing is replaced
}
function stopView(t, p) {                                     // cancelled while running: stop the real load (and its bot-page fix); lqPoll gives the slot back once stopped
  const run = lqRuns.get(t.id); if (!run) return;
  if (!run.began) { lqEnd(run, 'STOPPED'); return; }         // still reading the input: nothing of it was loaded
  p.grokToken = null; p.grokPending = null;
  try { if (!run.wc.isDestroyed() && run.wc.isLoading()) run.wc.stop(); } catch {}
  lqPollOn();
}
function endView(t, p, code) {
  lqRuns.delete(t.id);                                       // (a load taken over by a newer one ends here; nothing of it is waited for any more)
  if (code === 'USER' && panes.includes(p) && !p.sleeping && !hasPage(p)) p.loadIdle = true;   // 取消 before anything was shown: stays empty until clicked
}
// a bot-page fix's own load: part of the pane's running load when it has one, else a load of its own in the queue (the class of the pane's last
// load). pending: the hop through the home page (grokPending) is set only when that load really starts
function fixLoad(p, url, pending = null) {
  const go = () => { if (pending) p.grokPending = pending; appLoad(p.view.webContents, url); };
  if (!p.obs || lqView(p)?.state === 'run') { go(); return; }
  viewLoad(p, 'FIX', p.loadCls || 'BULK', pending ? pending.target : url, go);
}
function showViews() {                                        // the queue moved: views on / off behind their placeholder, the screen updated
  if (!win || win.isDestroyed()) return;
  const cs = cells(); panes.forEach((p, i) => p.view.setVisible(!!cs[i] && !p.sleeping && !viewHeld(p) && !dockHide())); sendState(cs);
  navSettle();                                               // (#51) its load started: the view is shown now
}

// Background check: a temporary hidden window (same session / preload) opens the stored bot URL, the preload reports the same stable
// message scan it gives a live pane, then the view is destroyed again (the pane stays asleep). Changed fingerprint => 'unopened'.
// (#31) A check is a task of the shared load queue (BG: after every other load, at most one at a time); its slot goes back when its window is gone.
let probe = null, lastReloadAll = 0;
function abortProbe(p) {                                     // waiting -> dropped; running -> told to stop (the loop below ends, the window is destroyed)
  lq.cancel(t => t.probe && t.win === ctx && (!p || t.ent === p.obs.ent), 'ABORT');
  if (probe && (!p || probe.p === p)) probe.abort = true;
}
function probeSelect() {
  const now = Date.now();
  if (settings.sleepCheck === false || !win || win.isDestroyed() || quitting) return null;
  const dbg = r => { if (debugOn() && panes.some(q => q.sleeping) && now - (probeSelect.at2 || 0) > 60000) { probeSelect.at2 = now; dlog('probe: no check now -', r); } };
  const hold = r => { if (debugOn() && panes.some(q => q.sleeping) && now - (probeSelect.at || 0) > 60000) { probeSelect.at = now; dlog('probe held:', r); } return null; };
  if (probeAuthHold) return hold('sign-in page seen: stopped until 確認を再開');   // (#33) the shared session: no window checks
  if (lq.some(t => !t.probe) || now - lastReloadAll < 30000) return hold('loads queued / running (startup, reload-all ...)');   // any other load in the queue first (#31)
  { const busy = panes.find(q => !q.sleeping && (q.grokToken || q.grokPending || now - (q.loadedAt || 0) < 15000)); if (busy) return hold(`pane${busy.id} still loading`); }
  // (#33) the one due longest (its own backoff); the clock set back never pushes a check further than its wait
  const cands = panes.filter((q, i) => q.sleeping && !q.view.webContents.isDestroyed() && i !== focused && maximizedId !== q.id);
  cands.forEach(q => { q.pb = PB.settle(q.pb, now, SLEEP_CHECK_MS); });
  const best = PB.pick(cands, now);
  if (!best) dbg('none due (' + panes.filter(q => q.sleeping).map(q => `pane${q.id}:${Math.round(((q.pb && q.pb.nextEligibleAt) - now) / 1000)}s/f${q.pb ? q.pb.failureCount : 0}`).join(' ') + `, focused=${panes[focused]?.id})`);
  return best;
}
async function probeNext() {                                 // one check through the queue; resolves when it is over (the top-level tick runs one at a time)
  const q = probeSelect(); if (!q) return false;
  await new Promise(done => {
    const { merged } = lq.request({ ent: q.obs.ent, gen: q.obs.gen, purpose: 'PROBE', cls: 'BG', probe: true, win: ctx, url: q.botTarget || q.url || '', data: { no: q.id },
      onStart: t => probePane(q, t), onStop: () => { if (probe && probe.p === q) probe.abort = true; }, onEnd: () => done() });
    if (merged) done();
  });
  return true;
}
async function probePane(p) {
  const target = p.botTarget || (GROK_BOT_RE.test(p.url || '') ? p.url : null);
  const id = target && target.match(GROK_BOT_RE)?.[1];
  p.pb = PB.start(p.pb, Date.now(), SLEEP_CHECK_MS);         // (#33) an attempt now; the result below sets the next one (none: the same wait again)
  if (!id) return;
  const run = nextNo();                                      // this check's run (#02): bound to the sleep generation it starts in
  if (obsDo(p, { type: 'probe-start', run }).code) return;
  const sid = p.obs.sleep.id;
  const t0 = Date.now(), m0 = debugOn() ? appMemBytes() : 0; let peak = m0;
  const bw = new BrowserWindow({ show: false, width: 1000, height: 720, skipTaskbar: true, focusable: false, webPreferences: {      // hidden window: same session, same preload, own 1000x720 viewport
    preload: path.join(__dirname, 'pane-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false } });
  const wc = bw.webContents, pr = probe = { p, abort: false };
  let last = null, lastAt = 0, pushes = 0, hard = 0, lastPush = 0, why = 'timeout', failed = false, unsure = '', atAuth = false;
  // the check's page is numbered like a live pane's: a new number per page / SPA move of this window, sent again on dom-ready
  const runTok = () => p.obs.sleep && p.obs.sleep.run && p.obs.sleep.run.id === run ? p.obs.sleep.run.tok : 0;
  const sendTok = () => { try { if (runTok() && !wc.isDestroyed()) wc.send('mpb:gen', runTok()); } catch {} };
  const docGen = () => { if (!obsDo(p, { type: 'probe-doc', run, tok: nextNo() }).code) sendTok(); };
  wc.on('did-navigate', docGen); wc.on('did-navigate-in-page', (e, u, isMain) => { if (isMain) docGen(); });
  wc.on('dom-ready', sendTok);
  regWc(wc, 'probe', { ctx, pane: p, onCount: c => {   // its preload's count comes here (never to the live pane)
    const drop = obsDo(p, { type: 'probe-scan', run, gen: c.gen, seq: c.seq }).code;   // an earlier page of this check, an older check, a duplicate / out-of-order scan
    if (drop) { diag.rec('count.drop', drop, { p: p.id }, 600000); return; }
    if (snapOk(c.snap, 'conv') && snapOk(c.snap, 'roles') && !snapOk(c.snap, 'stable')) { last = null; unsure = 'CHANGING'; return; }   // the page moved after its stable report: wait for the next one
    if (snapOk(c.snap, 'conv') && snapOk(c.snap, 'roles')) { last = c; lastAt = Date.now(); } else { last = null; unsure = snapIssue(c.snap); }   // a page without a confirmed conversation is no count: keep waiting
  } });
  try {
    wc.setAudioMuted(true); wc.setWindowOpenHandler(() => ({ action: 'deny' })); guardNavigation(wc, 'probe');
    appLoad(wc, target);
    while (Date.now() - t0 < PROBE_MAX_MS) {
      await sleep(400);
      if (pr.abort || wc.isDestroyed() || !p.sleeping || quitting) { why = 'abort'; last = null; break; }
      if (debugOn()) peak = Math.max(peak, appMemBytes());
      if (last && Date.now() - lastAt > 2500) { why = 'ok'; break; }                  // stable count, no change for 2.5 s
      if (last) continue;
      if (!/^https:\/\/grok\.com\//.test(wc.getURL()) && !wc.isLoading()) { why = 'offsite'; break; }   // login redirect etc.
      const r = await grokProbe(wc, id);
      if (r === 'notfound') { why = 'notfound'; break; }
      if (r === 'rendered') continue;                                                  // chat is up: wait for the preload's stable scan
      if (r === 'clicked') { lastPush = Date.now(); continue; }                          // clicked the sidebar link: give it a moment
      // recovery like a live pane (direct loads of /bot/<id> often stay black): in-site router hops (patient: one every 4 s), one hard reload late
      if (pushes >= 3 && hard < 1 && Date.now() - lastPush > 4000 && Date.now() - t0 > 14000) { hard++; pushes = 0; lastPush = Date.now(); appLoad(wc, target); continue; }
      if (pushes < 3 && Date.now() - lastPush > 4000 && Date.now() - t0 > 1500) {
        const rr = await wc.executeJavaScript(`(() => { const r = window.next && window.next.router;
          if (r && typeof r.push === 'function') { r.push('/'); setTimeout(() => r.push(${JSON.stringify('/bot/' + id)}), 350); return 'ok'; } return 'no'; })()`).catch(() => 'no');
        if (rr === 'ok') { lastPush = Date.now(); pushes++; }
      }
    }
  } catch (e) { failed = true; dlog(`pane${p.id}`, 'probe error', String(e)); }
  finally {
    try { if (!last && !wc.isDestroyed()) atAuth = PB.authPage(wc.getURL()); } catch {}   // (#33) no count: did it end on a sign-in page? (the URL is not kept)
    unregWc(r => r.wc === wc); probe = null;
    obsDo(p, { type: 'probe-stop', run });                   // the run is over: nothing of it is taken any more
    try { if (!bw.isDestroyed()) bw.destroy(); } catch {}
  }
  const ms = Date.now() - t0;
  if (!last || !p.sleeping) { diag.rec('probe', failed ? 'ERROR' : !p.sleeping ? 'WOKE' : why.toUpperCase(), { p: p.id, ms, n: pushes + hard }); if (unsure && !last) diag.rec('dom', unsure, { p: p.id }, 600000); dlog(`pane${p.id}`, 'probe', why, ms + 'ms', 'no count');
    probeEnd(p, sid, PB.kindOf({ error: failed, woke: !p.sleeping, why, issue: unsure, auth: atAuth })); return; }   // (#33) a failure (backoff) / cut short / a sign-in page
  if (!snapUsable(last.snap) || last.snap.cid !== id) {     // not sure what the page shows (partial latest turn / another bot): neither 'new' nor 'nothing new'; the remembered state stays
    const issue = snapIssue(last.snap) || 'OTHER_CONV';
    diag.rec('probe', 'UNSURE', { p: p.id, ms, n: pushes + hard }); diag.rec('dom', issue, { p: p.id }, 600000);
    dlog(`pane${p.id}`, 'probe', why, ms + 'ms', 'unsure', issue); probeEnd(p, sid, 'unsure'); return;   // (#33) a failure: never 'nothing new', the last success stays
  }
  const base0 = p.obs.sleep && p.obs.sleep.base;            // (debug log only) the baseline it is compared with, before the result replaces it
  const res = obsDo(p, { type: 'probe-result', sleep: sid, c: last });   // compared with the baseline of the sleep it was started in; becomes the new baseline
  if (res.code) { diag.rec('probe', 'STALE', { p: p.id, ms, n: pushes + hard }); dlog(`pane${p.id}`, 'probe', why, ms + 'ms', 'stale run'); probeEnd(p, sid, 'aborted'); return; }   // woke / slept again / closed meanwhile: not this sleep's result
  const nf = { user: last.user, bot: last.bot, botSince: last.botSince, fp: last.fp || '', waiting: last.waiting, working: last.working, done: last.done, asks: last.asks };
  diag.rec('probe', res.verdict, { p: p.id, ms, n: pushes + hard });
  dlog(`pane${p.id}`, 'probe', why, ms + 'ms', res.verdict, `bot_since=${nf.botSince} waiting=${nf.waiting} working=${nf.working}`, debugOn() ? `mem ${Math.round(m0 / 1048576)}->peak ${Math.round(peak / 1048576)}MB` : '');
  if (res.verdict === 'CHANGED' && debugOn()) dlog(`pane${p.id}`, 'probe changed:', PS.fpDiff(base0, last));   // which field differed: names and numbers only
  if (last.hn && snapOk(last.snap, 'name')) { p.pageH1 = last.hn; p.pageHdr = last.hh || ''; if (p.sleepSnap) Object.assign(p.sleepSnap, sleepIdentity({ h1: p.pageH1, hdr: p.pageHdr, userName: p.name, title: p.sleepSnap.title })); }
  if (nf.waiting && last.q && snapOk(last.snap, 'quote')) p.reqQuote = last.q;              // refresh the quote shown while asleep
  if (p.restored && !res.fresh) p.restored = SS.rechecked(p.restored, SS.markOf(nf), nf.waiting ? p.reqQuote : '', Date.now());   // (#22) read now: no longer 前回・未再確認 (still no colour / count / alert from it)
  probeEnd(p, sid, 'ok');                                                                 // (#33) the only success: a usable, stable scan of this bot became this sleep's result
  if (!res.fresh) return;                                                                 // nothing new (or only a baseline), or the user spoke last
  p.restored = null; p.markAt = Date.now();                                               // (#22) from now on the pane's own (new) state
  p.msgMode = true; p.glow = false;                                                       // 'unopened' is set by the result (p.obs)
  p.unread = nf.botSince; p.waiting = nf.waiting; p.working = nf.working && !nf.waiting; p.done = !!nf.done && !nf.waiting && !nf.working; if (!nf.waiting) p.reqQuote = '';
  p.needsReply = !!(nf.asks || nf.waiting) && !nf.working && !nf.done;
  updateBadge(); sendState();
  if (p.needsReply && canAlert(p) && !obsDo(p, { type: 'alert', key: PS.alertKey(nf) }).code) notifyPane(p, 'probe', PS.alertKey(nf), `未開封の新着（待機中 ${p.unread}件）`);   // off / muted / quiet: consumed in noticeOffer (#61)
}
// (#33) a check's outcome -> the pane's freshness / backoff, only for the sleep it was started in. A clear sign-in page stops every check of the
// shared session (all windows) until 確認を再開; nothing else stops them. Never touches unopened / counts / notifications
function probeEnd(p, sid, kind) {
  if (!p.sleeping || !p.obs.sleep || p.obs.sleep.id !== sid) return;   // woke / slept again meanwhile: that sleep has its own state
  p.pb = PB.record(p.pb, kind, Date.now(), SLEEP_CHECK_MS);
  if (PB.failed(kind)) { diag.rec('probe', 'BACKOFF', { p: p.id, n: p.pb.failureCount }); dlog(`pane${p.id}`, 'probe backoff', kind, p.pb.failureCount, Math.round((p.pb.nextEligibleAt - Date.now()) / 1000) + 's'); }
  if (kind === 'auth' && !probeAuthHold) { probeAuthHold = true; diag.rec('probe', 'AUTH_HOLD', { p: p.id }); dlog(`pane${p.id}`, 'probe: sign-in page - every check stopped until 確認を再開'); buildMenu(); broadcast(); return; }
  sendState();
}

// ---- panes ----
// Startup / workspace loads are staggered through the shared load queue (#31): focused pane first, then the rest with at most LQ.LIMIT loading
// at a time in all windows (8 heavy grok.com pages at once starve each other, the router hop is missed and panes stay blank).

// New pane: while the rows are still the default grid it behaves as before (appended, grid re-fits); once the user has closed panes
// (rows differ from the default) the new pane goes to the first row that has room (typically the row it was closed from), or opens a new row.
// (dock) Room is counted in cells; a new row that breaks the stacking limits undoes the stacks (dock-layout.js add / fit)
function insertPane(p) {
  const n = panes.length, lens = getRows(), pr = PRESETS[layout] || [2, 2];
  if (n === 0 || (sameArr(lens, defRows(n)) && DL.isFlat(getStacks()))) { panes.push(p); rowLens = null; stackLens = null; return; }
  if (!applyGrid(DL.add(paneGrid(), p.id, pr[0], pr[1]), [p])) { panes.push(p); rowLens = null; stackLens = null; }   // no room: the default grid
}
function addPane(spec = {}, { focus = true, defer = false, asleep = null } = {}) {   // asleep: (#22) restorePlan() of a saved spec at startup
  if (panes.length >= MAX) return null;
  const view = new WebContentsView({ webPreferences: {
    preload: process.env.MPB_NO_PRELOAD ? undefined : path.join(__dirname, 'pane-preload.js'),
    contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true, spellcheck: false } });
  view.setBorderRadius?.(RADIUS);
  view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff');
  const p = { id: nextPaneId++, view, url: paneStart(normalize(spec.url)), unread: 0, glow: false, msgMode: false, loadedAt: Date.now(),
    reloadMinutes: RELOAD_CHOICES.includes(spec.reloadMinutes) ? spec.reloadMinutes : 0,
    name: typeof spec.name === 'string' ? spec.name.slice(0, 60) : '', color: COLORS[spec.color] !== undefined ? spec.color : 'none',
    muted: !!spec.muted, ...ZP.restore(spec, gZoom()),      // zoom / zoomIndiv (older saves had per-pane zoom only: those panes stay individual)
    lastReload: Date.now(), lastTyping: 0, lastInteract: Date.now(), waitSince: 0, sleepOn: spec.sleep !== false, sleeping: false, editing: false,
    inputRev: 0, ime: false, sel: false };                   // #11: keys typed into the pane (main's input revision) / an IME composition reported by the page; a selection (copySel)
  p.obs = PS.createObs(nextNo(), nextNo());                  // this pane entity + its first world generation (#02; memory only)
  p.rcv = RP.createRec();                                    // (#32) its failures / planned reload (memory only)
  win.contentView.addChildView(view);
  if (overlayOpen) bringOverlayToFront();
  const wc = view.webContents;
  regWc(wc, 'pane', { ctx, pane: p });
  initZoom(p);                                               // (#53) native / legacy zoom for this view, before its first page
  // a new generation for every new page (load / reload / wake / sleep's blank page), SPA move of the main frame and renderer loss
  wc.on('did-navigate', () => newGen(p, 'NAV'));
  wc.on('did-navigate-in-page', (e, u, isMain) => { if (isMain) newGen(p, 'SPA'); });
  wc.on('render-process-gone', () => newGen(p, 'GONE'));
  wc.setWindowOpenHandler(d => linkOpen(wc, d));
  guardNavigation(wc);
  const upd = () => { sendState(); save(); };
  ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading'].forEach(e => wc.on(e, upd));
  wc.on('did-start-loading', () => { p.loadedAt = p.loadT0 = Date.now(); });
  const rememberUrl = () => { const u = wc.getURL(); if (/^https?:/.test(u)) { p.url = u; if (GROK_BOT_RE.test(u)) p.botTarget = u; } };
  wc.on('did-navigate', rememberUrl); wc.on('did-navigate-in-page', rememberUrl);
  // the pane moved to another page by itself / by the user while a load of it waits (#31): that load was for the old page -> cancelled
  const urlMoved = () => { const t = lqView(p), u = wc.getURL(); if (t && t.state === 'wait' && t.url && !isBlankUrl(u) && !sameTarget(t.url, u)) lq.cancel(t.id, 'URL'); };
  wc.on('did-navigate', urlMoved); wc.on('did-navigate-in-page', (e, u, isMain) => { if (isMain) urlMoved(); });
  wc.on('did-navigate', () => { if (p.sleeping) return; p.snap = null; p.msgMode = false; p.lastUserCount = null; p.unread = 0; p.glow = false; p.working = false; p.waiting = false; p.done = false; p.hasDraft = false; p.ime = false; p.sel = false; p.reqQuote = ''; p.pageH1 = ''; p.pageHdr = ''; p.favicon = ''; if (p.pcMax) setPcMax(p, false); if (p.imgMax) setImgMax(p, false); });
  wc.on('did-navigate-in-page', () => { if (p.sleeping) return; p.lastUserCount = null; if (!isBotUrl(wc.getURL())) resetCounts(p); });
  wc.on('did-stop-loading', () => { p.loadedAt = Date.now(); });
  wc.on('page-title-updated', () => { if (p.sleeping) return; sendState(); markActivity(p, 'title'); });
  wc.on('page-favicon-updated', (e, icons) => { p.favicon = (icons || []).find(u => /^https?:|^data:/.test(u)) || ''; sendState(); });
  wc.on('dom-ready', () => { if (p.zoomBackend !== 'native') normalizeHostZoom(wc); applyZoom(p, p.zoom); sendGen(p); });   // the page's preload is listening by now; native: mode / factor checked on the new page
  wc.on('console-message', e => {
    if (!debugOn()) return;
    if (e.level === 'error' || e.level === 'warning') dlog(`pane${p.id}`, 'console', e.level, e.message, '@', e.sourceId + ':' + e.lineNumber);
  });
  const loadMs = () => p.loadT0 ? Date.now() - p.loadT0 : undefined;
  // (#32) failures told apart (recovery-policy.js): a failed main-frame load (transient: reloaded by itself, bounded; else manual), the renderer
  // gone (manual: the 'stopped' placeholder), unresponsive (noted only). ERR_ABORTED, a child frame and a load that is only slow are no failure
  wc.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && !p.sleeping) diag.rec('pane.load', DIAG.netCode(code), { p: p.id, ms: loadMs() }); dlog(`pane${p.id}`, 'did-fail-load', code, desc, url, isMain ? 'main' : 'sub'); recoverFail(p, code, url, isMain); });
  wc.on('render-process-gone', (e, d) => { p.ime = false; p.sel = false; diag.rec('pane.gone', DIAG.goneCode(d && d.reason), { p: p.id }); dlog(`pane${p.id}`, 'render-process-gone', JSON.stringify(d)); recoverGone(p, d && d.reason); });
  wc.on('unresponsive', () => { diag.rec('pane.hang', 'HANG', { p: p.id }); dlog(`pane${p.id}`, 'unresponsive'); recoverHang(p, true); });
  wc.on('responsive', () => { diag.rec('pane.hang', 'RESPONSIVE', { p: p.id }); dlog(`pane${p.id}`, 'responsive'); recoverHang(p, false); });
  wc.on('did-navigate', () => recoverPage(p));
  wc.on('did-finish-load', () => {
    if (!p.sleeping) diag.rec('pane.load', 'OK', { p: p.id, ms: loadMs() });   // a sleeping pane loading about:blank is not a page load
    recoverLive(p);
    onGrokLoad(p);
    dlog(`pane${p.id}`, 'loaded', wc.getURL());
  });
  wc.on('focus', () => { if (!p.sleeping) setFocused(panes.indexOf(p)); });   // a hidden sleeping view can fire a stray focus event right after it is hidden: that must not wake it
  wc.on('before-input-event', (e, input) => {
    if (navHolds(p, input)) { if (!handleKey(input, p)) diag.rec('nav', 'HELD', { p: p.id }, 60000); e.preventDefault(); return; }   // (#51) meant for the pane being woken: not typed here
    if (input.type === 'keyDown' && !input.meta && !input.control) { clearUnread(p); p.inputRev++; } if (handleKey(input, p)) e.preventDefault();   // a key typed: the input revision moves (#11)
    if (CB.copyKey(input, { mac: isMac, sel: p.sel, ime: p.ime })) { e.preventDefault(); copySel(p); }   // ⌘C with a selection in the page: main copies it (the page / menu never get the key)
  });
  wc.on('context-menu', (e, params) => {
    const items = [];
    if (params.linkURL) items.push({ label: 'リンクを新しいペインで開く', enabled: panes.length < MAX && !NAV.appLoad(params.linkURL), click: () => addPane({ url: params.linkURL }) },   // (#72) web links only
      { label: 'リンクをコピー', click: () => clipboard.writeText(params.linkURL) },
      { label: 'ブラウザで開く', enabled: !NAV.external(params.linkURL, { gesture: true }).code, click: () => openExt(params.linkURL, 'link menu', true) }, { type: 'separator' });   // http(s) / mailto ... (the user's own choice)
    if (params.selectionText) items.push({ label: 'コピー', accelerator: 'CmdOrCtrl+C', registerAccelerator: false, click: () => params.isEditable ? wc.copy() : copySel(p) });   // this pane, as ⌘C (a field: the browser's copy)
    if (params.isEditable) items.push({ role: 'cut', label: '切り取り' }, { role: 'paste', label: '貼り付け' });
    if (isBotUrl(wc.getURL())) items.push({ type: 'separator' }, pcItem(p));
    items.push({ type: 'separator' }, { label: '戻る', enabled: wc.navigationHistory.canGoBack(), click: () => goHist(p, -1) },
      { label: '再読み込み', click: () => askReload(p.id) }, { label: '検証', click: () => wc.inspectElement(params.x, params.y) });
    if (RECOVERY_DEBUG) items.push({ type: 'separator' }, ...recoverDebugItems(p));   // (#32) dev only
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  insertPane(p);
  if (asleep && GROK_BOT_RE.test(p.url)) restoreAsleep(p, asleep);   // (#22) saved asleep: stays asleep, nothing loaded / queued until it is opened
  else if (p.url === NEWTAB) loadInto(wc, p.url);            // the local new-tab page: at once (not a load of the queue)
  else viewLoad(p, defer ? 'START' : 'OPEN', defer ? 'BULK' : 'USER', p.url, () => loadInto(wc, p.url));   // (#31) startup / workspace: BULK; a pane the user opens: USER
  if (focus) setFocused(panes.indexOf(p));
  relayout();
  return p;
}
// (#23) a new pane (new id / generation, its load through the queue) from the newest entry; the entry is taken only once the pane exists, so a
// full window, a second ⌘⇧T while one runs or a pane that could not be made leave the history as it was. The keyboard follows a moment later
// only if nothing moved meanwhile (another pane clicked / typed into, the address bar, the palette).
let reopening = false;
const wcId = wc => wc && !wc.isDestroyed() ? wc.id : 0;
const focusNow = () => ({ focusedId: panes[focused]?.id, overlay: overlayOpen, fw: wcId(require('electron').webContents.getFocusedWebContents()), revs: panes.map(q => [q.id, q.inputRev]) });
function reopenClosed() {
  const pre = CP.plan(closedStack, panes.length, MAX, reopening);
  if (pre.code) { diag.rec('reopen', pre.code, { n: closedStack.length }); return; }
  reopening = true;
  try {
    const e = pre.e, before = paneGrid(), had = new Set(panes), prev = panes[focused];
    let p = null;
    try { p = addPane({ ...e.spec }, { focus: false }); } catch { p = panes.find(q => !had.has(q)) || null; dlog('reopen', 'addPane threw'); }   // made after all: it counts
    if (!p) { diag.rec('reopen', 'FAIL', { n: closedStack.length }); sendState(); return; }
    CP.take(closedStack, e);
    const pl = DL.reopen(before, p.id, e);                      // back into the row it was closed from (if there is room; its stacked cell if it still fits)
    panes.splice(panes.indexOf(p), 1);
    if (!applyGrid(pl, [p])) { panes.push(p); rowLens = null; stackLens = null; }   // (not expected) the default grid rather than a pane left out
    maximizedId = null; setFocused(panes.indexOf(p)); relayout(true); save(); sendState();
    diag.rec('reopen', 'OK', { p: p.id, n: closedStack.length });
    const at = { ...focusNow(), id: p.id };                     // the keyboard may still be where ⌘⇧T / ↩ / the palette left it: that pane, the bar, the new one
    at.fws = [at.fw, wcId(prev && prev.view.webContents), wcId(p.view.webContents)];
    setTimeout(() => { if (panes.includes(p) && !p.view.webContents.isDestroyed() && CP.mayFocus(at, focusNow())) p.view.webContents.focus(); }, 50);
  } finally { reopening = false; }
}
function closePane(id, keepEmpty) {
  const i = panes.findIndex(p => p.id === id); if (i < 0) return;
  if (dock && dock.id === id) dockEnd('CLOSED');               // (dock) the dragged pane goes: its drag ends, the views come back
  { const g = paneGrid(), w = DL.where(g, id);
    if (!keepEmpty) CP.push(closedStack, CP.entry(paneSpec(panes[i]), w, NEWTAB));   // for ⌘⇧T (a blank / new-tab pane: nothing to reopen; closing many at once: not kept)
    const r = DL.fromGrid(DL.without(g, id)); rowLens = r.rows; stackLens = r.stacks; }   // only this pane's cell / row shrinks; an empty row disappears
  const [p] = panes.splice(i, 1);
  disposePane(p, 'CLOSED');
  if (maximizedId === id) maximizedId = null;
  focused = Math.max(0, Math.min(focused, panes.length - 1));
  if (!panes.length && !keepEmpty) addPane({ url: '' });
  else { updateBadge(); relayout(true); save(); }
}
// (#32) the end of one pane view, once per view addPane made (closePane; every pane when its window is closed): nothing from its page counts, its
// background check / loads / planned reload end, then the view leaves the window and its WebContents is closed - detaching or hiding a view
// does not end it. A second call does nothing; a window already gone is skipped.
function disposePane(p, code) {
  if (!p || p.disposed) return false;
  p.disposed = true; p.grokToken = null; p.grokPending = null;
  recoverCancel(p, true);
  const wc = p.view.webContents;
  unregWc(r => r.wc === wc);                                 // nothing from this page counts any more
  obsDo(p, { type: 'close' }); abortProbe(p);                // ...nor from its background check (#02)
  lqDrop(p, code);                                           // its waiting / running load (#31): a running one gives its slot back once the view is gone
  try { if (!win.isDestroyed()) win.contentView.removeChildView(p.view); } catch {}
  try { if (!wc.isDestroyed()) wc.close(); } catch {}
  return true;
}
function newPane(url = '') {
  if (panes.length >= MAX) { const p = panes[focused]; if (p) openIn(p, url); return; }
  maximizedId = null;
  const p = addPane({ url });
  relayout(true);
  if (p) setTimeout(() => !p.view.webContents.isDestroyed() && p.view.webContents.focus(), 50);
}
const byId = id => panes.find(p => p.id === id);
// Zoom: every pane either follows the GLOBAL zoom (settings.globalZoom) or is "individual" (own p.zoom, ignores global changes).
// Chromium keeps ONE zoom level per site (host zoom map), so wc.setZoomFactor in the default zoom mode on one grok.com pane zoomed every grok.com pane.
// (#53, zoom-policy.js) Each view gets one backend before its first page (initZoom): native = setZoomMode('isolated') + wc.setZoomFactor (its own
// zoom, kept across reloads / navigations / sleep's about:blank and the wake: the same WebContents); legacy = as before, the page's preload applies
// it (webFrame.setZoomFactor via 'mpb:zoom') and the shared site level is kept at 100% (normalizeHostZoom). A page never gets both. Applied when
// the zoom changes and on each new page (dom-ready: an isolated page that lost its mode gets it back before its factor) - not on focus, never polled.
// The 承認Bot popup and the background check's hidden window stay in the default mode at the site's 100%, as before.
const zoomModeOf = wc => typeof wc.getZoomMode === 'function' ? wc.getZoomMode() : undefined;
function initZoom(p) {
  const wc = p.view.webContents, api = ZP.hasNative(wc);
  let threw = false, mode;
  if (api && !NO_NATIVE_ZOOM) { try { wc.setZoomMode('isolated'); mode = zoomModeOf(wc); } catch { threw = true; } }
  const b = ZP.backend({ api, forced: NO_NATIVE_ZOOM, threw, mode });
  p.zoomBackend = b.backend; diag.rec('zoom', b.code, { p: p.id }, 600000);
  if (b.backend === 'native') applyZoom(p, p.zoom);
}
function applyZoom(p, z) {
  p.zoom = clampZ(z); const wc = p.view.webContents; if (wc.isDestroyed()) return;
  if (p.zoomBackend === 'native') {
    try {
      const { ops } = ZP.plan({ backend: 'native', mode: zoomModeOf(wc), factor: wc.getZoomFactor(), zoom: p.zoom });
      if (ops.includes('mode')) { wc.setZoomMode('isolated'); if (zoomModeOf(wc) !== 'isolated') throw new Error('zoom mode'); diag.rec('zoom', 'MODE_RESET', { p: p.id }, 600000); }
      if (ops.includes('factor')) wc.setZoomFactor(p.zoom);
      return;
    } catch { p.zoomBackend = 'legacy'; diag.rec('zoom', 'FALLBACK', { p: p.id }); dlog(`pane${p.id}`, 'zoom: native failed, preload zoom from now on'); }
  }
  try { wc.send('mpb:zoom', p.zoom); } catch {}               // no page yet: its dom-ready sends it
}
// legacy pages / the 承認Bot popup: the shared site level back to 100%, then the legacy panes again (an isolated page's level is its own zoom)
function normalizeHostZoom(wc) { try { if (wc.getZoomLevel() !== 0) { wc.setZoomLevel(0); setTimeout(() => panes.forEach(q => { if (q.zoomBackend !== 'native') applyZoom(q, q.zoom); }), 150); } } catch {} }
function applyGlobalZoom() { ZP.followers(panes).forEach(p => applyZoom(p, gZoom())); sendState(); }
function setZoom(p, z) {            // pane zoom: changing it makes the pane individual
  if (!p) return;
  p.zoomIndiv = true; applyZoom(p, z);
  sendState(); save();
}
function resetPaneZoom(p) { if (p && p.zoomIndiv) setZoom(p, 1); }
function setZoomIndiv(p, on) { if (!p) return; p.zoomIndiv = !!on; if (!on) applyZoom(p, gZoom()); sendState(); save(); }

function focusUrlBar() { win.webContents.focus(); win.webContents.send('focus-url', panes[focused]?.id); }
// 選択部分だけコピー (copy-policy.js): the selection is read in an own world first (page scripts cannot change what it uses), then this pane's
// normal copy (wc.copy: the page's copy event as usual); a clipboard that is clearly not that selection afterwards gets the selection as plain
// text. Never focuses the pane (a focus drops the selection on grok.com); the text is never logged
async function copySel(p) {
  const wc = p.view.webContents, seq = ++copySeq;
  if (wc.isDestroyed()) return;
  let sel = '';
  try { sel = await Promise.race([wc.executeJavaScriptInIsolatedWorld(CB.WORLD, [{ code: CB.SEL_JS }]), sleep(CB.READ_MS).then(() => '')]); } catch {}
  if (seq !== copySeq || wc.isDestroyed()) return;           // a newer copy runs
  sel = typeof sel === 'string' ? sel : '';
  const before = clipboard.readText();
  wc.copy();
  if (!CB.norm(sel)) return;                                 // nothing read (none / a field / the page busy): the page's copy alone, as before
  let clip = before, changed = false;
  for (let t = 0; t < CB.WAIT_MS && !changed; t += CB.STEP_MS) { await sleep(CB.STEP_MS); if (seq !== copySeq) return; clip = clipboard.readText(); changed = clip !== before; }
  const text = CB.fix({ sel, clip, changed });
  if (text == null) return;
  clipboard.writeText(text);
  dlog(`pane${p.id}`, 'copy: selection written as plain text', changed ? 'differed' : 'no copy');
}
function handleKey(input, pane) {
  if (input.type !== 'keyDown') return false;
  // (#51) ⌘⌥←→↑↓ / ⌘⇧J first (⌘⇧J before ⌘J). An IME composition / a modal overlay: left to the page or field as it is; a held key: one move only
  const nk = PN.match(input, { mac: isMac, modal: overlayOpen && overlayMode !== 'queue', ime: !!pane?.ime });
  if (nk.id) { if (nk.act === 'go') navKey(nk.id); return nk.act !== 'pass'; }
  const k = input.key.toLowerCase();
  const mod = isMac ? input.meta : input.control;
  if (k === 'escape' && !mod && !input.alt && !input.shift) {
    if (dock) { dockEnd('ESC'); return true; }                // (dock) a header drag: cancelled, nothing changes
    if (overlayOpen) { closeOverlay(); return true; }
    if (pane?.pcMax) return false;                         // Esc closes the page's computer view first (the pane then returns to normal)
    if (pane?.imgMax) return false;                        // the same for an image viewer opened by a click (img-closed gives the pane back)
    if (maximizedId != null) { toggleMaximize(maximizedId); return true; }
    return false;
  }
  if (!mod) return false;
  if (input.alt && !input.shift && ['Equal', 'Minus', 'Digit0'].includes(input.code)) { setGlobalZoom(input.code === 'Digit0' ? 1 : gZoom() + (input.code === 'Equal' ? 0.1 : -0.1)); return true; }   // ⌘⌥= / ⌘⌥- / ⌘⌥0: global zoom
  if (input.alt) return false;
  const fp = panes[focused];
  if (k === 'b' && input.shift) { openOverlay('broadcast', { bc: bcView() }); return true; }   // (#12) a batch running / finished: its progress
  if (k === 'p' && input.shift) { togglePc(); return true; }
  if (k === 'k') { overlayOpen ? closeOverlay() : openOverlay('palette'); return true; }
  if (k === 't' && input.shift) { closeOverlay(); reopenClosed(); return true; }
  if (k === 't') { closeOverlay(); newPane(''); return true; }
  if (k === 'w' && !input.shift) { if (fp) askClose(); return true; }
  if (k === 'l') { closeOverlay(); focusUrlBar(); return true; }
  if (k === 'j') { nextUnread(); return true; }
  if (!input.shift && (k === '\\' || k === '¥' || input.code === 'Backslash' || input.code === 'IntlYen')) { toggleMaximize(); return true; }
  if (k === 'r' && input.shift) { reloadAll(); return true; }
  if (k === 'r' && !input.shift) { if (fp) askReload(); return true; }
  if (k === '[' ) { goHist(fp, -1); return true; }
  if (k === ']' ) { goHist(fp, 1); return true; }
  if (k === '=' || k === '+' || (k === ';' && input.shift)) { setZoom(fp, (fp?.zoom || 1) + 0.1); return true; }
  if (k === '-') { setZoom(fp, (fp?.zoom || 1) - 0.1); return true; }
  if (k === '0') { resetPaneZoom(fp); return true; }
  const d = parseInt(k, 10);
  if (d >= 1 && d <= PRESET_KEYS.length && !input.shift) { applyPreset(PRESET_KEYS[d - 1]); return true; }
  return false;
}

// ---- overlay (command palette / prompts) ----
function bringOverlayToFront() {
  win.contentView.removeChildView(overlay); win.contentView.addChildView(overlay);
  if (approveOpen && approve) { win.contentView.removeChildView(approve); win.contentView.addChildView(approve); }
}
// ---- 承認Bot popup: a dedicated view (default session = same login as the panes), centred, ~60% of the window, over a dim backdrop (the overlay) ----
function approveRect() {
  const [w, h] = win.getContentSize();
  const W = Math.max(420, Math.min(w - 24, Math.round(w * 0.6))), H = Math.max(320, Math.min(h - 24, Math.round(h * 0.6)));
  return { x: Math.round((w - W) / 2), y: Math.round((h - H) / 2), width: W, height: H };
}
function ensureApprove() {
  if (approve && !approve.webContents.isDestroyed()) return approve;
  approve = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
  approve.setBorderRadius?.(14);
  approve.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff');
  const wc = approve.webContents;
  regWc(wc, 'approve', { ctx });                             // no preload: registered so that nothing from it is ever accepted
  approvePane = { id: 'approve', view: approve, url: APPROVE_URL, botTarget: APPROVE_URL, loadedAt: Date.now(), lastReload: Date.now() };   // a pane-like record so the bot-page fixes (router hop, retries) work here too
  wc.setWindowOpenHandler(d => linkOpen(wc, d));
  guardNavigation(wc, 'approve');
  wc.on('did-finish-load', () => { if (approvePane) { approvePane.loadedAt = Date.now(); onGrokLoad(approvePane); } });
  wc.on('dom-ready', () => normalizeHostZoom(wc));
  wc.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'Escape' && !input.meta && !input.control && !input.alt && !input.shift) { e.preventDefault(); closeOverlay(); } });
  loadInto(wc, APPROVE_URL);
  win.contentView.addChildView(approve); approve.setVisible(false);
  return approve;
}
function destroyApprove() {
  clearTimeout(approveTimer); approveTimer = null;
  if (!approve || approveOpen) return;
  try { win.contentView.removeChildView(approve); } catch {}
  unregWc(r => r.wc === approve.webContents);
  try { if (!approve.webContents.isDestroyed()) approve.webContents.close(); } catch {}
  approve = null; approvePane = null;
}
function openApprove() {
  dlog('approve', 'open requested', approveOpen);
  if (approveOpen) { closeOverlay(); return; }
  if (overlayOpen) closeOverlay();
  clearTimeout(approveTimer); approveTimer = null;
  if (approve && !approve.webContents.isDestroyed() && approve.webContents.isCrashed()) destroyApprove();   // (#32) the hidden copy's renderer is gone: a new one
  const had = !!(approve && !approve.webContents.isDestroyed());
  ensureApprove();
  approveOpen = true;
  const r = approveRect(); dlog('approve', 'rect', JSON.stringify(r), 'reused', had);
  openOverlay('approve', { rect: r });                       // dim backdrop (click = close) + shadow
  win.contentView.removeChildView(approve); win.contentView.addChildView(approve);
  approve.setBounds(r); approve.setVisible(true); approve.webContents.focus();
  if (had) {                                                 // reopened from the hidden copy: make sure the chat is actually showing
    const wc = approve.webContents, id = APPROVE_URL.match(GROK_BOT_RE)[1];
    wc.executeJavaScript(GROK_RENDERED(id)).then(ok => { if (!ok && approveOpen && !wc.isLoading() && !approvePane?.grokToken) reloadPane(approvePane); }).catch(() => {});
  }
}
function hideApprove() {
  approveOpen = false;
  try { approve?.setVisible(false); } catch {}
  clearTimeout(approveTimer); approveTimer = setTimeout(destroyApprove, APPROVE_KEEP_MS);
}
function openOverlay(mode, extra = {}) {
  if (!overlay) return;
  dockEnd('OVERLAY');                                          // (dock) a header drag ends (the views come back) before anything is shown over them
  popOpen = false; clearTimeout(popTimer);
  overlayOpen = true; overlayMode = mode;
  const [w, h] = win.getContentSize();
  overlay.setBounds({ x: 0, y: 0, width: w, height: h });
  bringOverlayToFront();
  overlay.setVisible(true);
  sendState();
  overlay.webContents.focus();
  Promise.resolve().then(() => clipboard.readText()).catch(() => '').then(t => {   // sync or async depending on Electron version
    const clip = String(t || '').trim();
    overlay.webContents.send('overlay-open', { mode, ...extra,
      clipboardUrl: /^https?:\/\/\S+$/.test(clip) && clip.length < 500 ? clip : '' });
  });
}
function closeOverlay() {
  if (!overlayOpen) return;
  overlayOpen = false; overlayMode = '';
  bcPv = null; bcPvNo = 0;                                  // (#12) a preview holds only while it is on screen (a batch goes on)
  if (approveOpen) hideApprove();
  overlay.setVisible(false);
  panes[focused]?.view.webContents.focus();
}
function paneMenu(id) {
  const p = byId(id); if (!p) return;
  const tpl = [
    { label: '名前を変更…', click: () => openOverlay('rename', { id, value: p.name || '' }) },
    { label: '色', submenu: Object.keys(COLORS).map(c => ({ label: COLOR_JA[c], type: 'radio', checked: (p.color || 'none') === c, click: () => { p.color = c; sendState(); save(); } })) },
    { label: 'このペインの通知をミュート', type: 'checkbox', checked: !!p.muted, click: m => { p.muted = m.checked; updateBadge(); sendState(); save(); } },
    { label: '待機中・終了にスリープ（メモリ節約）', type: 'checkbox', checked: p.sleepOn !== false, click: m => { p.sleepOn = m.checked; if (!m.checked && p.sleeping) reloadPane(p); sendState(); save(); } },
    { label: '自動リロード', submenu: RELOAD_CHOICES.map(m => ({ label: m ? `${m}分ごと` : 'オフ', type: 'radio', checked: p.reloadMinutes === m,
      click: () => { p.reloadMinutes = m; p.lastReload = Date.now(); sendState(); save(); } })) },
    { label: `ズーム（${Math.round((p.zoom || 1) * 100)}%${p.zoomIndiv ? '・個別' : ''}）`, submenu: [
      { label: 'ペインズーム 拡大', click: () => setZoom(p, p.zoom + 0.1) }, { label: 'ペインズーム 縮小', click: () => setZoom(p, p.zoom - 0.1) }, { label: 'ペインズーム リセット', enabled: !!p.zoomIndiv, click: () => setZoom(p, 1) },
      { label: 'ズームを個別設定（全体に反映しない）', type: 'checkbox', checked: !!p.zoomIndiv, click: m => setZoomIndiv(p, m.checked) },
      { type: 'separator' },
      { label: `全体ズーム（${Math.round(gZoom() * 100)}%） 拡大`, click: () => setGlobalZoom(gZoom() + 0.1) }, { label: '全体ズーム 縮小', click: () => setGlobalZoom(gZoom() - 0.1) }, { label: '全体ズーム リセット', click: () => setGlobalZoom(1) }] },
    { label: 'お気に入りに追加', enabled: !!paneUrl(p), click: () => addFavorite(paneUrl(p), p.name || displayTitle(p)) },
    { type: 'separator' },
    { label: maximizedId === id ? '元のサイズに戻す' : '最大化', click: () => toggleMaximize(id) },
    pcItem(p),
    { label: '複製', enabled: panes.length < MAX, click: () => { const q = addPane({ ...paneSpec(p), name: p.name ? p.name + ' (2)' : '' }); relayout(true); } },
    { label: 'URLをコピー', click: () => clipboard.writeText(paneUrl(p)) },
    { label: 'ブラウザで開く', enabled: !!paneUrl(p) && !NAV.external(paneUrl(p)).code, click: () => openExt(paneUrl(p), 'pane menu') },   // (#72) http(s) only
    { label: '開発者ツール', click: () => p.view.webContents.openDevTools({ mode: 'detach' }) },
    { type: 'separator' },
    { label: 'ペインを閉じる', click: () => askClose(id) },
  ];
  Menu.buildFromTemplate(tpl).popup({ window: win });
}
function saveWorkspace(name) {
  name = String(name || '').trim().slice(0, 60); if (!name) return;
  const key = splitKey(), sp = settings.splits?.[key];
  workspaces[name] = { layout, panes: panes.map(paneSpec), ...rowsSave(), savedAt: new Date().toISOString(),
    ...(sp ? { splitsKey: key, splits: JSON.parse(JSON.stringify(sp)) } : {}) };
  activeWs = name;
  save(); buildMenu(); broadcast();
  try { win.webContents.send('ws-saved', name); } catch {}
}
// 上書き保存: replace a saved layout with the current state (pane URLs, preset, split sizes, zoom, names, colours ...)
async function overwriteWorkspace(name, confirm) {
  if (!workspaces[name]) return;
  if (confirm) {
    const { response } = await dialog.showMessageBox(win, { type: 'question', message: `「${name}」を現在の構成で上書き保存しますか？`,
      detail: '保存済みの内容（ペインのURL・レイアウト・分割サイズ・ズームなど）が現在の状態に置き換わります。', buttons: ['上書き保存', 'キャンセル'], defaultId: 1, cancelId: 1, noLink: true });
    if (response !== 0 || !workspaces[name]) return;
  }
  saveWorkspace(name);
}
function loadWorkspace(name) {
  if (!workspaces[name]) return;
  guardRun('WORKSPACE', () => panes.slice(), () => {           // every pane is replaced: asked first when one holds input (#11)
    const ws = workspaces[name]; if (!ws) return;
    maximizedId = null;
    lq.batch(() => {                                         // (#31) every new pane requested before any starts: the focused one first
      [...panes].forEach(p => closePane(p.id, true));
      if (PRESETS[ws.layout]) layout = ws.layout;
      if (ws.splitsKey && ws.splits && typeof ws.splits === 'object') { settings.splits = settings.splits || {}; settings.splits[ws.splitsKey] = JSON.parse(JSON.stringify(ws.splits)); }
      (ws.panes || []).slice(0, MAX).forEach(s => addPane(s, { focus: false, defer: true }));
      if (!panes.length) addPane({ url: '' });
      rowLens = Array.isArray(ws.rows) ? ws.rows.map(Number) : null;       // the saved row structure (validated on first use)
      stackLens = DL.read(ws.stacks);                                       // (dock) its stacked cells (none / unusable: one pane per cell)
      activeWs = name;
      setFocused(0);
    });
    relayout(); save();
  });
}
// (#01) 対応キュー: opening it marks nothing read, wakes nothing and moves no focus (the list comes with the state)
function queueOpen() {
  queueNote = '';
  openOverlay('queue');                                      // its sendState builds the list (p.qSince: exactly the listed panes)
  diag.rec('queue', 'OPEN', { n: panes.filter(p => p.qSince).length });
}
// a choice from the open list: the pane by its id, only if it still shows the conversation it was listed for (closed / moved: nothing is done, the
// list says why). Then like a click on it: focus (asleep: woken through the load queue), the layout as focusPane leaves it; marked read only when
// the user really sees it (inView), as everywhere else
function queuePick(a) {
  if (!overlayOpen || overlayMode !== 'queue') return;       // only from the list on screen (a second Enter after it closed: nothing)
  const code = AQ.stale({ id: a.id, ref: a.ref }, panes.map(p => ({ id: p.id, url: paneUrl(p) })));
  if (code) { queueNote = AQ.STALE_JA[code]; diag.rec('queue', code, { p: a.id }); dlog('queue', 'choice not carried out', code); sendState(); return; }
  const p = byId(a.id);
  queueNote = ''; diag.rec('queue', 'PICK', { p: p.id });
  closeOverlay();
  focusPane(panes.indexOf(p), { clear: false });
  if (inView(p)) clearUnread(p);
}
function runAction(a) {
  if (!a || typeof a !== 'object') return;
  switch (a.type) {
    case 'focus': { const i = panes.findIndex(p => p.id === a.id); closeOverlay(); focusPane(i); break; }
    case 'queue-open': queueOpen(); break;                   // (#01) the bar's 対応 n / the palette
    case 'queue-pick': queuePick(a); break;
    case 'layout': closeOverlay(); applyPreset(a.layout); break;
    case 'open-new': closeOverlay(); newPane(String(a.url || '')); break;
    case 'open-here': { closeOverlay(); const p = panes[focused]; if (p) openIn(p, String(a.url || '')); break; }
    case 'next-unread': closeOverlay(); nextUnread(); break;
    case 'maximize': closeOverlay(); toggleMaximize(); break;
    case 'clear-unread': closeOverlay(); clearAll(); break;
    case 'reload-all': closeOverlay(); reloadAll(); break;
    case 'reopen-closed': closeOverlay(); reopenClosed(); break;   // (#23) the palette's 閉じたペインを開き直す (= ⌘⇧T / ↩)
    case 'rename': { const p = byId(a.id); if (p) { p.name = String(a.value || '').slice(0, 60); sendState(); save(); } closeOverlay(); break; }
    case 'rename-prompt': openOverlay('rename', { id: panes[focused]?.id, value: panes[focused]?.name || '' }); break;
    case 'ws-save-prompt': openOverlay('ws-save'); break;
    case 'ws-save': saveWorkspace(a.value); closeOverlay(); break;
    case 'approve-open': closeOverlay(); openApprove(); break;
    case 'ws-overwrite': closeOverlay(); overwriteWorkspace(String(a.name || ''), !!a.confirm); break;
    case 'ws-load': closeOverlay(); loadWorkspace(a.name); break;
    case 'ws-delete': delete workspaces[a.name]; save(); buildMenu(); broadcast(); break;
    case 'ws-rename': { const nn = String(a.value || '').trim().slice(0, 60); if (nn && workspaces[a.name] && nn !== a.name) { workspaces[nn] = workspaces[a.name]; delete workspaces[a.name]; ctxs.forEach(c => c.wsRenamed(a.name, nn)); save(); buildMenu(); broadcast(); } closeOverlay(); break; }
    case 'ws-rename-prompt': openOverlay('ws-rename', { name: a.name, value: a.name }); break;
    case 'broadcast-prompt': openOverlay('broadcast', { bc: bcView() }); break;
    case 'bc-preview': bcPreview(String(a.text), a.ids.map(Number)).catch(() => { dlog('broadcast', 'preview failed'); bcPush(); }); break;   // (#12) nothing is sent from here
    case 'bc-send': bcStart(a.pid); break;
    case 'bc-cancel': bcCancel(a.bid); break;
    case 'bc-reset': bcReset(); break;
    case 'toggle-notifications': settings.notifications = !settings.notifications; save(); buildMenu(); closeOverlay(); break;
    case 'close': closeOverlay(); break;
    case 'fav-open': closeOverlay(); openFavorite(a.id, a.where); break;
    case 'fav-add': closeOverlay(); addFavorite(String(a.url || ''), String(a.label || '')); break;
    case 'fav-add-current': { closeOverlay(); const p = panes[focused]; if (p && paneUrl(p)) addFavorite(paneUrl(p), p.name || displayTitle(p)); break; }
    case 'fav-rename': { const f = favorites.find(x => x.id === a.id); if (f) { f.label = String(a.value || '').slice(0, 60); favChanged(); } closeOverlay(); break; }
    case 'gbot-rename': grok = GB.rename(grok, a.id, String(a.value || '')); gbChanged(); closeOverlay(); break;   // (Grok bar) '' = the page's own name
    case 'new-window': closeOverlay(); makeWindow({ layout: '2x2', panes: [{ url: String(a.url || '') }] }); break;
    case 'recovery-restore': closeOverlay(); recoveryRestore(win, String(a.id || '')); break;
    case 'recovery-fresh': closeOverlay(); recoveryFresh(win); break;
    case 'diag-open': openOverlay('diag', { diag: diagView() }); break;
    case 'diag-copy': closeOverlay(); diagCopy(win).catch(() => {}); break;
    case 'diag-persist': settings.diagPersist = a.on === true; diagSync(); save(); buildMenu(); openOverlay('diag', { diag: diagView() }); break;
  }
}
function clearAll() { panes.forEach(p => { p.glow = false; if (!p.msgMode) p.unread = 0; }); updateBadge(); sendState(); }

// ---- 一斉送信 (#12, broadcast-state.js): this window's preview and batch (memory only; the text is never logged) ----
// preview: every chosen pane read now (asleep: not read, woken at the send). 「このN件に送信」: the preview on screen becomes one batch, once.
// Targets in pane order, asleep ones as soon as they woke into their conversation; each through broadcastSend. A target is busy
// (p.broadcasting: #11 holds auto sleep / reload / a queued replacing load and asks before a manual one) from the start until its result
// (an asleep one from its turn, so the bot-page fix loads of its wake are not held).
let bcPv = null, bcB = null, bcPvNo = 0;                     // the preview on screen, the batch (running / last finished), the preview being read
const bcNow = p => { const wc = p.view.webContents, gone = !panes.includes(p) || wc.isDestroyed();
  return { open: !gone, closed: !!p.obs.closed, ent: p.obs.ent, gen: p.obs.gen, rev: p.inputRev || 0, sleeping: !!p.sleeping, crashed: !gone && wc.isCrashed(),
    cid: gone ? '' : botIdOf(p.sleeping ? paneUrl(p) : wc.getURL()) }; };
const bcCur = p => PS.current(p.obs) && !!p.snap && p.snap.cid === botIdOf(p.view.webContents.getURL());   // this generation confirmed this very conversation
const bcLoading = p => p.view.webContents.isLoading() || !!p.grokToken || !!p.grokPending || !!lqView(p);
const bcUsers = p => p.userSeen && p.userSeen.gen === p.obs.gen ? p.userSeen.n : null;
const bcView = () => BS.view({ preview: bcPv, batch: bcB, dry: BC_DRY });
function bcPush() { try { if (overlay && !overlay.webContents.isDestroyed()) overlay.webContents.send('bc-state', bcView()); } catch {} }
function bcDo(a) { const r = BS.step(bcB, a); bcB = r.b; if (!r.code) bcPush(); return r; }
function bcSkip(id, why) {
  if (bcDo({ type: 'skip', id, why }).code) return null;
  diag.rec('bcast', why === 'CHANGED' || why === 'NO_WAKE' ? why : 'SKIP', { p: id });
  if (debugOn()) dlog(`pane${id}`, 'broadcast skipped', why);
  return null;
}
// the page adapter: input and send are two steps; with MPB_BROADCAST_DRYRUN neither runs in the page (the answer is 'dry')
const bcJs = (p, code) => Promise.race([p.view.webContents.executeJavaScript(code), sleep(BS.TIMING.STEP_MS).then(() => { throw new Error('timeout'); })]);
const bcPage = {
  async input(p, body) {
    if (BC_DRY) return { r: 'dry', h: '' };
    const x = await bcJs(p, BC_INPUT_JS(body));
    return x && typeof x === 'object' && typeof x.r === 'string' ? { r: x.r, h: typeof x.h === 'string' ? x.h.slice(0, 40) : '' } : { r: 'failed', h: '' };
  },
  async send(p, h) {
    if (BC_DRY) return 'dry';
    const x = await bcJs(p, BC_SEND_JS(h)), r = x && typeof x === 'object' && typeof x.r === 'string' ? x.r : 'error';
    if (r !== 'enter') return r;
    const wc = p.view.webContents; wc.focus();                // no send button: Enter into the composer (it has the page's focus), as before
    for (const ev of [{ type: 'keyDown', keyCode: 'Enter' }, { type: 'char', keyCode: '\r' }, { type: 'keyUp', keyCode: 'Enter' }]) wc.sendInputEvent(ev);
    if (overlayOpen) overlay.webContents.focus();
    return r;
  } };
async function bcPreview(body, ids) {
  const no = bcPvNo = nextNo();
  if (bcB && !BS.done(bcB)) { bcPush(); return; }            // one batch at a time per window: its progress stays on screen
  const err = BS.textError(body), list = err ? [] : panes.filter(p => ids.includes(p.id));
  const items = await Promise.all(list.map(async p => {
    const r = p.sleeping ? null : await liveInput(p), n = bcNow(p);
    const same = !r || !r.stamp || (r.stamp.gen === n.gen && r.stamp.rev === n.rev && !!r.stamp.sleeping === n.sleeping);   // read of the page it shows now
    const c = BS.classify({ open: n.open, bot: n.cid, sleeping: n.sleeping, r: same ? r : null, cur: n.open && !n.sleeping && bcCur(p), loading: n.open && !n.sleeping && bcLoading(p) });
    return { id: p.id, ent: n.ent, gen: n.gen, rev: n.rev, cid: n.cid, sleeping: n.sleeping, label: (n.open ? paneLabel(p) : p.name || '').slice(0, 40), conv: BS.shortConv(n.cid), st: c.st, why: c.why };
  }));
  if (bcPvNo !== no || (bcB && !BS.done(bcB))) return;      // a newer preview / the overlay closed meanwhile
  bcB = null;                                                // a finished batch's result gives way to the new preview
  bcPv = BS.preview(no, body, items, err);
  diag.rec('bcast', 'PREVIEW', { n: items.length });
  bcPush();
}
function bcStart(pid) {                                      // 「このN件に送信」: the preview on screen, once (a second press / key repeat: DUP)
  const code = BS.admit({ preview: bcPv, batch: bcB }, pid);
  if (code) { diag.rec('bcast', code); if (debugOn()) dlog('broadcast', 'send refused', code); bcPush(); return; }
  bcB = BS.batch(bcPv, nextNo(), Date.now()); bcPv = null; bcPvNo = 0;
  for (const it of bcB.items) {                              // the set as confirmed: a target that moved since the preview is skipped, never replaced
    if (it.st !== 'WAIT') continue;
    const p = byId(it.id), why = p ? BS.moved(it, bcNow(p)) : 'GONE';
    if (why) bcSkip(it.id, why);
  }
  const n = BS.counts(bcB).wait;
  diag.rec('bcast', 'START', { n });
  if (BC_DRY) diag.rec('bcast', 'DRYRUN', { n });
  dlog('broadcast', 'batch', bcB.bid, 'targets', n, BC_DRY ? '(dry run)' : '');
  bcPush();
  bcRun(bcB.bid, bcB.text).catch(() => dlog('broadcast', 'runner failed'));
}
async function bcRun(bid, body) {
  const mine = () => !!bcB && bcB.bid === bid, its = () => mine() ? bcB.items : [], watch = [], t0 = Date.now();
  for (const it of its()) {                                  // awake targets: busy until their result; asleep ones: woken now through the queue (#31)
    const p = it.st === 'WAIT' && byId(it.id); if (!p) continue;
    if (!it.sleeping) p.broadcasting = true; else if (p.sleeping) reloadPane(p);
  }
  try {
    for (;;) {
      if (!mine()) return;
      const wait = its().filter(x => x.st === 'WAIT'); if (!wait.length) break;
      if (win.isDestroyed()) { wait.forEach(x => bcSkip(x.id, 'GONE')); break; }
      let it = wait.find(x => !x.sleeping), wake = null;
      if (!it) for (const x of wait) {                         // asleep at the preview: the first one that woke into its conversation
        const w = bcWoken(x, t0);
        if (w === 'WAIT') continue;
        if (w.why) { bcSkip(x.id, w.why); continue; }
        it = x; wake = w; break;
      }
      if (!it) { await sleep(BS.TIMING.POLL_MS); continue; }
      const w = await broadcastSend(it.id, body, wake);
      if (w) watch.push(w);
    }
  } finally { for (const it of its()) { const p = byId(it.id); if (p && it.st !== 'SENT') p.broadcasting = false; } }   // only a target waiting for its evidence stays busy
  await Promise.all(watch);
  if (!mine()) return;
  const c = BS.counts(bcB);
  diag.rec('bcast', 'DONE', { n: c.ok });
  dlog('broadcast', 'batch', bid, 'done: ok', c.ok, 'unsure', c.unsure, 'skipped', c.skip);
  bcPush();
}
// a target asleep at the preview: 'WAIT' (not yet) | { why } (skipped) | { gen, rev } (woke into its conversation, confirmed in that generation)
function bcWoken(it, t0) {
  const p = byId(it.id);
  if (!p || p.obs.closed || p.obs.ent !== it.ent || p.view.webContents.isDestroyed()) return { why: 'GONE' };
  if (!p.sleeping) {
    const cid = botIdOf(p.view.webContents.getURL());
    if (cid && cid !== it.cid) return { why: 'CHANGED' };     // woke into another conversation: never sent there
    if (cid && hasPage(p) && bcCur(p) && !bcLoading(p)) return { gen: p.obs.gen, rev: p.inputRev || 0 };
  } else if (!lqView(p, false) && Date.now() - t0 > 2000) return { why: 'NO_WAKE' };   // its wake was cancelled (取消) / it went asleep again
  return Date.now() - t0 > BS.TIMING.WAKE_MS ? { why: 'NO_WAKE' } : 'WAIT';
}
// one target: begin -> live read (still the confirmed pane / conversation / keys typed, the composer empty) -> input -> settle, re-checked ->
// send -> its page evidence (a promise; null when it ended here). Typed but not sent (moved / the page did not click): left in the composer.
async function broadcastSend(id, body, wake) {
  if (bcDo({ type: 'begin', id, ...(wake ? { wake } : {}) }).code) return null;   // cancelled meanwhile
  const p = byId(id); if (!p) return bcSkip(id, 'GONE');
  let watching = null;
  const moved = () => BS.moved(BS.item(bcB, id), bcNow(p));
  p.broadcasting = true;                                     // #11: no automatic operation throws the page away while text goes in / is sent
  try {
    let why = moved(); if (why) return bcSkip(id, why);
    const r = await liveInput(p);
    why = moved(); if (why) return bcSkip(id, why);
    const c = BS.classify({ open: true, bot: BS.item(bcB, id).cid, sleeping: false, r, cur: bcCur(p), loading: bcLoading(p), own: true });
    if (c.st !== 'READY') return bcSkip(id, c.why);
    if (bcDo({ type: 'input', id }).code) return null;       // cancelled while it was read: nothing typed
    let x = null; try { x = await bcPage.input(p, body); } catch {}
    const got = x && x.r;
    if (got === 'notempty') return bcSkip(id, 'PRESENT');
    if (got === 'nocomposer') return bcSkip(id, 'UNAVAILABLE');
    if (got !== 'typed' && got !== 'dry') return bcSkip(id, 'FAILED');
    await sleep(BS.TIMING.SETTLE_MS);
    why = moved(); if (why) return bcSkip(id, why);          // typed, then the pane / its input moved: not sent
    const base = { ent: p.obs.ent, gen: p.obs.gen, cid: BS.item(bcB, id).cid, user: bcUsers(p) };   // user turns before the send
    bcDo({ type: 'send', id });
    let s = 'error'; try { s = await bcPage.send(p, x.h); } catch {}
    if (s === 'mismatch' || s === 'nocomposer' || s === 'nobutton') { bcDo({ type: 'notsent', id }); diag.rec('bcast', 'SKIP', { p: id }); return null; }   // the page did not click
    if (s === 'dry') { bcDo({ type: 'unsure', id, why: 'DRYRUN' }); diag.rec('bcast', 'UNSURE', { p: id }); return null; }
    diag.rec('bcast', 'SENT', { p: id });
    watching = bcWatch(p, id, { ...base, rev: p.inputRev || 0 }, s === 'clicked' || s === 'enter' ? 'TIMEOUT' : 'ERROR');
    return watching;
  } finally { if (!watching) p.broadcasting = false; }
}
// after the send: 確認済み only on the page's evidence in the same generation (a new user turn / the composer emptied, no key typed since);
// otherwise 結果不明 once it cannot come any more or CONFIRM_MS passed. Never sent again.
async function bcWatch(p, id, base, fail) {
  const t0 = Date.now(); let readAt = t0;
  try {
    for (;;) {
      await sleep(BS.TIMING.POLL_MS);
      let v = BS.evidence(base, { ...bcNow(p), user: bcUsers(p), composer: '' });
      if (!v && Date.now() - readAt >= BS.TIMING.READ_MS) {
        readAt = Date.now();
        const r = await liveInput(p);
        v = BS.evidence(base, { ...bcNow(p), user: bcUsers(p), composer: r.moved ? '' : r.st });
      }
      if (v === 'OK') { bcDo({ type: 'confirm', id }); diag.rec('bcast', 'OK', { p: id }); return; }
      if (!v && Date.now() - t0 < BS.TIMING.CONFIRM_MS) continue;
      bcDo({ type: 'unsure', id, why: v || fail }); diag.rec('bcast', 'UNSURE', { p: id }); return;
    }
  } catch { if (!bcDo({ type: 'unsure', id, why: 'ERROR' }).code) diag.rec('bcast', 'UNSURE', { p: id }); } finally { p.broadcasting = false; }
}
function bcCancel(bid) {                                     // 取消: only what has not been typed yet; a started send cannot be stopped
  if (!bcB || bcB.bid !== bid || BS.done(bcB)) { bcPush(); return; }
  const r = bcDo({ type: 'cancel' });
  for (const it of bcB.items) if (it.st === 'SKIP' && it.why === 'CANCEL') { const p = byId(it.id); if (p) p.broadcasting = false; }
  diag.rec('bcast', 'CANCEL', { n: r.n || 0 });
  dlog('broadcast', 'cancel', r.n || 0);
}
function bcReset() { if (!bcB || BS.done(bcB)) { bcB = null; bcPv = null; bcPvNo = 0; } bcPush(); }   // 戻る / 新しい一斉送信 (a running batch stays)

// ---- IPC from app UI (renderer + overlay; both local files) ----
function wsMenu() {
  const names = Object.keys(workspaces), act = workspaces[activeWs] ? activeWs : null;
  Menu.buildFromTemplate([
    ...(act ? [{ label: `「${act}」を上書き保存`, click: () => overwriteWorkspace(act, false) }] : []),
    { label: '新規として保存…', click: () => openOverlay('ws-save') },
    { label: '別のレイアウトを上書き保存', enabled: names.length > 0, submenu: names.length ? names.map(n => ({ label: n, click: () => overwriteWorkspace(n, true) })) : [{ label: '-', enabled: false }] },
    { type: 'separator' },
    ...(names.length ? names.map(n => ({ label: n, type: 'checkbox', checked: n === act, click: () => loadWorkspace(n) })) : [{ label: '（保存したレイアウトはまだありません）', enabled: false }]),
    { type: 'separator' },
    { label: '名前を変更', enabled: names.length > 0, submenu: names.length ? names.map(n => ({ label: n, click: () => openOverlay('ws-rename', { name: n, value: n }) })) : [{ label: '-', enabled: false }] },
    { label: '削除', enabled: names.length > 0, submenu: names.length ? names.map(n => ({ label: n, click: () => { delete workspaces[n]; save(); buildMenu(); broadcast(); } })) : [{ label: '-', enabled: false }] },
  ]).popup({ window: win });
}
// Reload-all: every pane through the shared load queue (#31; BULK: LQ.LIMIT at a time in all windows, the focused pane first, after the user's own
// loads; a pane already waiting is merged, not loaded twice). reloadPane clears all retry state.
// #11: asked first when a pane holds input ('all but those' is offered when some do not); a pane that waited is read again right before.
function reloadAll() {
  guardRun('RELOAD_ALL', () => panes.filter(p => !p.view.webContents.isDestroyed()), list => {
    lastReloadAll = Date.now(); abortProbe();
    lq.batch(() => { for (const p of list) { recoverCancel(p); reloadPane(p, 'BULK').catch(e => dlog(`pane${p.id}`, 'reload-all err', String(e))); } });   // (#32) the user's own: no planned reload left
    dlog('reload-all queued', list.length);
    fetchUsage();
  }, { skip: true });
}
// ---- usage hover popover (lives in the overlay view, sized to the popover so it never blocks the panes) ----
let popOpen = false, popTimer = null, popRect = null;
function popBounds(h) { const [w] = win.getContentSize(); const W = 320; const x = Math.max(4, Math.min(w - W - 4, Math.round((popRect?.right || w) - W))); return { x, y: Math.round((popRect?.bottom || 40) + 4), width: W, height: Math.max(60, Math.min(520, Math.round(h || 360))) }; }
let popKind = 'grok', popSel = '';
function usageWinMenu(kind, sel) {
  if (!['codex', 'claude'].includes(kind)) return;
  const c = AIU.peek(kind), bs = (c && c.buckets) || [];
  const pc = v => { const n = Math.round(v); return n >= 100 ? 'MAX' : String(n).padStart(2, '0') + '%'; };
  const tpl = bs.length ? bs.map(b => ({ label: `${b.label}　残り ${pc(Math.max(0, 100 - Math.round(b.used)))} ／ 使用 ${pc(b.used)}`, type: 'radio', checked: b.id === sel, click: () => win.webContents.send('usage-win-chosen', kind, b.id) }))
    : [{ label: c && c.err ? `取得できません: ${c.err}` : 'まだ取得していません', enabled: false }];
  tpl.unshift({ label: `${kind === 'codex' ? 'Codex' : 'Claude'}: 表示する枠を選択`, enabled: false }, { type: 'separator' });
  Menu.buildFromTemplate(tpl).popup({ window: win });
}
function popShow(rect) {
  if (!overlay || overlayOpen) return;
  if (rect && typeof rect === 'object') { popKind = ['codex', 'claude'].includes(rect.kind) ? rect.kind : 'grok'; popSel = String(rect.sel || '').slice(0, 120); }
  clearTimeout(popTimer); popRect = rect && typeof rect === 'object' ? { right: Number(rect.right) || 0, bottom: Number(rect.bottom) || 0 } : popRect;
  if (!popOpen) { popOpen = true; overlay.setBounds(popBounds(360)); bringOverlayToFront(); overlay.setVisible(true); }
  overlay.webContents.send('usage-pop', popKind === 'grok' ? { kind: 'grok', ...usageDetail() } : { kind: popKind, sel: popSel, ...(AIU.peek(popKind) || { ok: false, err: 'まだ取得していません', buckets: [] }) });
}
function popHide() { clearTimeout(popTimer); if (!popOpen) return; popOpen = false; if (!overlayOpen) overlay.setVisible(false); }
function popLater(ms = 350) { clearTimeout(popTimer); popTimer = setTimeout(popHide, ms); }
function chipMenu(id) {
  const p = byId(id); if (!p) return;
  Menu.buildFromTemplate([
    { label: '名前を変更…', click: () => openOverlay('rename', { id, value: p.name || chipDefault(p) }) },
    { label: '再読み込み', click: () => askReload(id) },
    { label: '待機中・終了にスリープ', type: 'checkbox', checked: p.sleepOn !== false, click: m => { p.sleepOn = m.checked; if (!m.checked && p.sleeping) reloadPane(p); sendState(); save(); } },
    { label: '今すぐスリープ（待機中・終了のみ）', enabled: canSleep(p, panes.indexOf(p), true), click: () => sleepNowAsk(p) },
    { label: '新しいペインに複製', enabled: panes.length < MAX, click: () => { addPane({ ...paneSpec(p), name: p.name ? p.name + '2' : '' }); relayout(true); } },
    { label: 'お気に入りに追加', enabled: !!paneUrl(p), click: () => addFavorite(paneUrl(p), p.name || displayTitle(p)) },
    { label: maximizedId === id ? '元のサイズに戻す' : '最大化', click: () => toggleMaximize(id) },
    pcItem(p),
    { type: 'separator' },
    { label: '閉じる（新しいタブに戻す）', click: () => openIn(p, '', 'NEWTAB', q => { q.name = ''; sendState(); save(); }) },
    { label: 'ペインごと閉じる', click: () => askClose(id) },
    { label: '他のペインをすべて閉じる', enabled: panes.length > 1, click: () => guardRun('CLOSE_OTHERS', () => panes.filter(q => q.id !== id), l => { l.forEach(q => closePane(q.id, true)); setFocused(0); relayout(true); save(); }) },
  ]).popup({ window: win });
}
const ui = {}, paneIpc = {};
const on = (ch, fn) => { ui[ch] = fn; registerUi(ch); };
const paneOn = (ch, fn) => { paneIpc[ch] = fn; registerPane(ch); };
on('navigate', (id, url) => { const p = byId(id); if (p) openIn(p, url); });
on('back', id => goHist(byId(id), -1));
on('forward', id => goHist(byId(id), 1));
on('copy-pane-url', id => { const p = byId(id); if (p) { const u = paneUrl(p) || p.url; if (u) clipboard.writeText(String(u)); } });
on('reload', id => { if (byId(id)) askReload(id); });
on('close', id => askClose(id));
on('add', () => newPane(''));
on('reopen-closed', () => reopenClosed());
on('layout', l => applyPreset(l));
on('focus-pane', id => { const i = panes.findIndex(p => p.id === id); setFocused(i); clearUnread(panes[i]); });
on('activate-pane', id => focusPane(panes.findIndex(p => p.id === id)));
on('set-reload', (id, m) => { const p = byId(id); if (p && RELOAD_CHOICES.includes(m)) { p.reloadMinutes = m; p.lastReload = Date.now(); sendState(); save(); } });
on('swap', (a, b) => swapPanes(a, b));
on('dock-begin', id => dockBegin(id));                        // (dock) a header drag: its start, the window showing the stills, the cursor, the drop, its end
on('dock-ready', seq => dockReady(seq));
on('dock-hover', (x, y) => dockHover(x, y));
on('dock-drop', (x, y) => dockDrop(x, y));
on('dock-end', () => dockEnd('END'));
on('maximize', id => toggleMaximize(id));
on('sleep-toggle', id => { const p = byId(id); if (!p) return; p.sleepOn = p.sleepOn === false; if (p.sleepOn === false && p.sleeping) reloadPane(p); sendState(); save(); });
on('wake-pane', id => { const p = byId(id); if (p?.sleeping || p?.loadIdle) { reloadPane(p); setFocused(panes.indexOf(p)); } });   // asleep, or its wait was cancelled (取消): load it now
on('load-cancel', id => { const p = byId(id); if (p) lq.cancel(t => t.win === ctx && t.ent === p.obs.ent && !t.probe && t.state === 'wait', 'USER'); });
on('sleep-now', id => { const p = byId(id); if (p) sleepNowAsk(p); });
on('probe-resume', () => probeResume());                     // (#33) 確認を再開 in a sleeping pane's placeholder (after a sign-in page)
on('pane-menu', id => paneMenu(id));
on('chip-menu', id => chipMenu(id));
on('reload-all', () => reloadAll());
on('usage-pop-show', r => popShow(r));
on('usage-win-menu', (kind, sel) => usageWinMenu(String(kind), String(sel || '')));
on('usage-pop-keep', () => clearTimeout(popTimer));
on('usage-pop-leave', () => popLater());
on('usage-pop-size', h => { if (popOpen && !overlayOpen) overlay.setBounds(popBounds(Number(h))); });
on('ws-menu', () => wsMenu());
on('approve-open', () => openApprove());
on('split-start', (axis, i, row) => splitStart(String(axis), Number(i), row == null ? undefined : Number(row)));
on('sync-cols', v => syncColsApply(!!v));
on('sync-reset', () => syncReset());
on('split-end', () => splitEnd());
on('split-reset', (axis, row) => splitReset(String(axis), row == null ? undefined : Number(row)));
on('palette', () => openOverlay('palette'));
on('overlay-run', a => runAction(a));
on('overlay-close', () => closeOverlay());
on('ready', () => { sendState(); sendMem(); gbPush(ctx); });
on('save-retry', () => saveNow());
on('recovery-open', () => { if (store && store.info().status !== 'ready' && !store.info().frozen) openOverlay('recovery', { recovery: recoveryInfo() }); });
on('fav-open', (id, where) => openFavorite(id, where));
on('fav-menu', id => favMenu(id));
on('fav-move', (a, b) => moveFavorite(a, b));
on('fav-add', (url, label) => addFavorite(String(url || ''), String(label || '')));
on('gbar-refresh', () => grokRefresh());                     // (Grok bar) the Grok button; a read already running: nothing new
on('gbot-open', (id, where) => openGrokBot(id, where));
on('gbot-menu', id => gbotMenu(id));
on('gbot-move', (a, b) => { const g = GB.movePin(grok, a, b); if (g !== grok) { grok = g; gbChanged(); } });
on('rename-pane', id => { const p = byId(id); if (p) openOverlay('rename', { id, value: p.name || chipDefault(p) }); });
// from web content (pane-preload): p = the pane main registered for the sending page (checked by ipcGate: own window, top frame, payload)
paneOn('pane:msgcount', (p, c) => onMsgCount(p, IPC.msgCount(c)));
paneOn('pane:pc-opened', p => {                              // the page's computer view appeared (user clicked 'コンピュータを表示')
  if (p.pcMax || p.sleeping || !isBotUrl(p.view.webContents.getURL())) return;
  if (maximizedId === p.id || settings.autoPc !== false) setPcMax(p, true);   // already maximised: just relax the size caps (no maximize / restore dance)
});
paneOn('pane:pc-closed', p => { if (p.pcMax) setPcMax(p, false); });
paneOn('pane:img-opened', p => {                             // the user clicked an image of a grok.com page (settings.autoImg)
  if (p.imgMax || p.pcMax || p.sleeping || settings.autoImg === false || !/^https:\/\/grok\.com\//.test(p.view.webContents.getURL())) return;
  setImgMax(p, true);
});
paneOn('pane:img-closed', (p, viewer) => { if (p.imgMax) setImgMax(p, false, viewer === true); });
paneOn('pane:msgmode-off', p => resetCounts(p));
paneOn('pane:mutation', p => markActivity(p, 'dom'));
paneOn('pane:interact', p => { p.lastInteract = Date.now(); clearUnread(p); const i = panes.indexOf(p); if (i !== focused) setFocused(i); });
paneOn('pane:mouseup', () => splitEnd());
paneOn('pane:typing', p => { p.lastTyping = Date.now(); p.lastInteract = Date.now(); });
paneOn('pane:draft', (p, v) => { p.hasDraft = v === true; });
paneOn('pane:editing', (p, v) => { p.editing = !!v; });
paneOn('pane:ime', (p, v) => { p.ime = v === true; });       // #11: no page is thrown away during an IME composition
paneOn('pane:sel', (p, v) => { p.sel = v === true; });       // 選択部分だけコピー: ⌘C goes to copySel while true
// ---- favorites (global list, opened in this window) ----
function openFavorite(id, where = 'here', f = favorites.find(x => x.id === id)) {   // f: (Grok bar) a listed Bot as a favorite
  if (!f) return;
  if (where === 'window') { makeWindow({ layout: '2x2', panes: [{ url: f.url, name: f.label }] }); return; }
  if (where === 'new' || !panes[focused]) { newPane(f.url); const p = panes[panes.length - 1]; if (p && !p.name && f.label) { p.name = f.label; sendState(); } return; }
  openIn(panes[focused], f.url, 'NAVIGATE', p => {
    if (f.label && (!p.name || p.favId)) p.name = f.label;
    p.favId = f.id;
    focusPane(panes.indexOf(p), { clear: false });
  });
}
// (Grok bar) a listed Bot / group: the same as a favorite, named as the bar shows it
function openGrokBot(id, where = 'here') { const b = grok.bots.find(x => x.id === id); if (b) openFavorite(null, where, { id: 'g:' + b.id, url: b.url, label: GB.nameOf(grok, b) }); }
function favMenu(id) {
  const f = favorites.find(x => x.id === id); if (!f) return;
  Menu.buildFromTemplate([
    { label: '選択中のペインで開く', click: () => openFavorite(id, 'here') },
    { label: '新しいペインで開く', accelerator: isMac ? 'Cmd+Click' : 'Ctrl+Click', registerAccelerator: false, enabled: panes.length < MAX, click: () => openFavorite(id, 'new') },
    { label: '別ウィンドウで開く', accelerator: 'Shift+Click', registerAccelerator: false, click: () => openFavorite(id, 'window') },
    { type: 'separator' },
    { label: '名前を変更…', click: () => openOverlay('fav-rename', { id, value: f.label }) },
    { label: 'URLをコピー', click: () => clipboard.writeText(f.url) },
    { label: 'お気に入りから削除', click: () => { favorites = favorites.filter(x => x.id !== id); favChanged(); } },
  ]).popup({ window: win });
}
function gbotMenu(id) {                                       // (Grok bar) a Bot / group of the list or the pins
  const b = grok.bots.find(x => x.id === id); if (!b) return;
  const pinned = grok.pins.includes(id);
  Menu.buildFromTemplate([
    { label: '選択中のペインで開く', click: () => openGrokBot(id, 'here') },
    { label: '新しいペインで開く', accelerator: isMac ? 'Cmd+Click' : 'Ctrl+Click', registerAccelerator: false, enabled: panes.length < MAX, click: () => openGrokBot(id, 'new') },
    { label: '別ウィンドウで開く', accelerator: 'Shift+Click', registerAccelerator: false, click: () => openGrokBot(id, 'window') },
    { type: 'separator' },
    { label: '名前を変更…', click: () => openOverlay('gbot-rename', { id, value: GB.nameOf(grok, b), orig: b.name }) },
    { label: 'お気に入り（Grokボタンの右にも表示）', type: 'checkbox', checked: pinned, click: () => { grok = GB.pin(grok, id, !pinned); gbChanged(); } },
    { label: 'URLをコピー', click: () => clipboard.writeText(b.url) },
  ]).popup({ window: win });
}
function chipDefault(p) { return displayTitle(p); }

// ---- per-window snapshot / lifecycle ----
let snapCache = null;
function snapshot() {
  if (!win || win.isDestroyed()) return snapCache || { layout, focused, panes: [], window: { bounds: lastBounds } };
  let bounds = lastBounds;
  try { if (!win.isDestroyed() && !win.isMaximized() && !win.isFullScreen()) bounds = win.getNormalBounds(); } catch {}
  lastBounds = bounds;
  const now = Date.now();
  return (snapCache = { layout, focused, panes: panes.map(p => paneSave(p, now)), ...rowsSave(), window: { bounds, maximized: win.isMaximized() } });   // (#22) + a sleeping pane's snap; (dock) + stacks
}


const ctx = { snapshot, ui, paneIpc, get win() { return win; }, get overlay() { return overlay; }, get panes() { return panes; },
  reloadAll, sendState, newPane, closePane, toggleMaximize, togglePc, relayout, reopenClosed, setZoom, resetPaneZoom, setZoomIndiv, applyGlobalZoom, nextUnread, navKey, focusUrlBar, openOverlay, paneMenu, applyPreset,
  sleepTick, probeNext, recoverNext, loadWorkspace, overwriteWorkspace, clearAll, showViews, get layout() { return layout; }, get focusedPane() { return panes[focused]; },
  askClose, askReload, autoReload, openLink,                 // through the input guard (#11)
  get activeWs() { return workspaces[activeWs] ? activeWs : null; }, wsRenamed(o, n) { if (activeWs === o) activeWs = n; },
  focusPaneById(id) { const i = panes.findIndex(p => p.id === id); if (i >= 0) focusPane(i); },
  inView, openPane(p) { const i = panes.indexOf(p); if (i >= 0) focusPane(i, { clear: false }); },   // (#61) notification click: this very pane, not marked read
  othersInfo(n) {
    return { wid: win.id, n, panes: panes.filter(p => p.waiting || p.working || p.done || p.glow || p.unread || p.obs.unopened).map(p => ({ id: p.id, name: (p.name || displayTitle(p) || '').slice(0, 40),
      waiting: !!p.waiting, working: !!p.working, done: !!p.done, glow: !!p.glow, unopened: !!p.obs.unopened, unread: p.unread || 0, color: COLORS[p.color] || '' })) };
  } };

const bounds = process.env.MPB_SCREENSHOT ? { x: 0, y: 0, width: 1600, height: 1000 }
  : restore ? restoreBounds(spec.window) : { width: 1400, height: 900 };
win = new BrowserWindow({ ...bounds, minWidth: 600, minHeight: 400, title: 'MultiPane Browser', show: false,
  backgroundColor: isMac ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ececec'),
  ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 }, vibrancy: 'under-window', visualEffectState: 'followWindow' } : {}),
  webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
regWc(win.webContents, 'chrome', { ctx });
guardUi(win.webContents);                                    // (#72) never moves / opens windows
ctxs.push(ctx);
if (restore && spec.window?.maximized && !process.env.MPB_SCREENSHOT) win.maximize();
win.loadFile(path.join(__dirname, 'index.html'));
win.once('ready-to-show', () => win.show());
win.webContents.on('before-input-event', (e, input) => { if (handleKey(input)) e.preventDefault(); });
win.on('resize', () => relayout());
win.on('moved', save); win.on('resized', save);
win.on('focus', () => { setFocused(focused); buildMenu(); });
win.on('blur', () => dockEnd('BLUR'));                       // (dock) another app / window in front: a header drag ends, the views come back
win.webContents.on('render-process-gone', () => dockEnd('GONE'));   // (dock) the window's own page is gone: no dragend will come
win.on('close', () => {
  dockEnd('WINDOW');
  snapshot();
  lq.cancel(t => t.win === ctx, 'WINDOW');                   // (#31) this window's loads / check: the slots go back once its views / check window are gone
  try { approveOpen = false; destroyApprove(); } catch {}
  if (quitting) return;
  if (ctxs.length === 1) { if (!quitting) saveNow(); return; }            // last window: remember it
  const i = ctxs.indexOf(ctx); if (i >= 0) ctxs.splice(i, 1);  // other windows are forgotten when closed
  panes.forEach(p => { p.grokToken = null; });
  saveNow(); updateDockBadge(); broadcast();
});
win.on('closed', () => {
  unregWc(r => r.ctx === ctx);                               // this window's UI, overlay, panes, popup and probe
  if (!quitting) panes.forEach(p => disposePane(p, 'WINDOW'));   // (#32) the panes' WebContents are not closed with the window: closed here (quitting: the app ends)
});

overlay = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
regWc(overlay.webContents, 'overlay', { ctx });
guardUi(overlay.webContents);
overlay.setBackgroundColor('#00000000');
overlay.setVisible(false);
win.contentView.addChildView(overlay);
overlay.webContents.loadFile(path.join(__dirname, 'overlay.html'));
overlay.webContents.on('before-input-event', (e, input) => { if (handleKey(input)) e.preventDefault(); });

const specs = Array.isArray(spec.panes) && spec.panes.length ? spec.panes : [{ url: '' }];
// (#31) every pane requested before any starts: the focused one first, then the rest LQ.LIMIT at a time (shown as waiting meanwhile)
lq.batch(() => {
  specs.slice(0, MAX).forEach(s => addPane(s, { focus: false, defer: true, asleep: restore ? restorePlan(s) : null }));   // (#22) saved asleep: not loaded
  rowLens = Array.isArray(spec.rows) ? spec.rows.map(Number) : null;      // saved rows (validated; default grid when absent)
  stackLens = DL.read(spec.stacks);                                       // (dock) saved stacked cells (validated against those rows)
  setFocused(Math.min(spec.focused || 0, panes.length - 1));
});
relayout();
broadcast();
return ctx;
}


function buildMenu() {
  const acc = (a, click, label, extra = {}) => ({ label, accelerator: a, registerAccelerator: false, click, ...extra });
  const c = cur();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'ファイル', submenu: [
      acc('CmdOrCtrl+T', () => cur()?.newPane(''), '新しいペイン'),
      acc('CmdOrCtrl+Shift+T', () => cur()?.reopenClosed(), '閉じたペインを開き直す'),
      { label: '新しいウィンドウ', accelerator: 'CmdOrCtrl+N', click: () => makeWindow({ layout: '2x2', panes: [{ url: '' }] }) },
      acc('CmdOrCtrl+W', () => { const k = cur(); k?.focusedPane && k.askClose(); }, 'ペインを閉じる'),
      acc('CmdOrCtrl+L', () => cur()?.focusUrlBar(), 'アドレスを編集'),
      acc('CmdOrCtrl+K', () => cur()?.openOverlay('palette'), 'コマンドパレット…'),
      { type: 'separator' },
      { label: 'ワークスペースを上書き保存', enabled: !!cur()?.activeWs, click: () => cur()?.overwriteWorkspace(cur().activeWs, false) },
      { label: 'ワークスペースを新規保存…', click: () => cur()?.openOverlay('ws-save') },
      { label: 'ワークスペースを開く', enabled: Object.keys(workspaces).length > 0,
        submenu: Object.keys(workspaces).length ? Object.keys(workspaces).map(n => ({ label: n, click: () => cur()?.loadWorkspace(n) })) : [{ label: '（なし）', enabled: false }] },
      { type: 'separator' },
      isMac ? { role: 'close', label: 'ウィンドウを閉じる', accelerator: 'CmdOrCtrl+Shift+W' } : { role: 'quit', label: '終了' } ] },
    { role: 'editMenu', label: '編集' },
    { label: '表示', submenu: [
      acc('CmdOrCtrl+R', () => { const k = cur(); k?.focusedPane && k.askReload(); }, 'ペインを再読み込み'),
      acc('CmdOrCtrl+Shift+R', () => cur()?.reloadAll(), '全ペインを再読み込み（一括更新）'),
      acc('CmdOrCtrl+\\', () => cur()?.toggleMaximize(), 'ペインを最大化 / 元に戻す'),
      acc('CmdOrCtrl+Shift+P', () => cur()?.togglePc(), 'クラウドPC（Botのコンピュータ画面）を最大化 / 元に戻す'),
      { label: 'クラウドPCを開いたら自動で最大化', type: 'checkbox', checked: settings.autoPc !== false, click: m => { settings.autoPc = m.checked; save(); } },
      acc('CmdOrCtrl+=', () => { const k = cur(); k?.setZoom(k.focusedPane, (k.focusedPane?.zoom || 1) + 0.1); }, 'ペインズーム 拡大（このペインだけ・個別になります）'),
      acc('CmdOrCtrl+-', () => { const k = cur(); k?.setZoom(k.focusedPane, (k.focusedPane?.zoom || 1) - 0.1); }, 'ペインズーム 縮小'),
      acc('CmdOrCtrl+0', () => { const k = cur(); k?.resetPaneZoom(k.focusedPane); }, 'ペインズーム リセット（個別のペインのみ）'),
      { label: 'ズームの個別設定を切替（個別＝全体に反映しない）', click: () => { const k = cur(), fp = k?.focusedPane; if (fp) k.setZoomIndiv(fp, !fp.zoomIndiv); } },
      acc('CmdOrCtrl+Alt+=', () => setGlobalZoom(gZoom() + 0.1), '全体ズーム 拡大'),
      acc('CmdOrCtrl+Alt+-', () => setGlobalZoom(gZoom() - 0.1), '全体ズーム 縮小'),
      acc('CmdOrCtrl+Alt+0', () => setGlobalZoom(1), '全体ズーム リセット'),
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'フルスクリーン' },
      { label: 'アプリUIの開発者ツール', click: () => cur()?.win.webContents.openDevTools({ mode: 'detach' }) } ] },
    { label: 'ペイン', submenu: [
      acc('CmdOrCtrl+J', () => cur()?.nextUnread(), '次の未読ペインへ'),
      ...PN.KEYS.map(k => acc(k.accel, () => cur()?.navKey(k.id), k.ja)),   // (#51) ←→↑↓ by position, 次の要対応へ (handleKey does the keys)
      { type: 'separator' },
      { label: '名前を変更…', click: () => { const k = cur(); k?.openOverlay('rename', { id: k.focusedPane?.id, value: k.focusedPane?.name || '' }); } },
      { label: 'お気に入りに追加', click: () => { const k = cur(), p = k?.focusedPane; if (p && paneUrl(p)) addFavorite(paneUrl(p), p.name || p.view.webContents.getTitle()); } },
      { label: 'ペインのメニュー…', click: () => { const k = cur(); k?.paneMenu(k.focusedPane?.id); } },
      { label: 'すべての未読をクリア', click: () => cur()?.clearAll() } ] },
    { label: 'レイアウト', submenu: PRESET_KEYS.map((k, i) => acc(`CmdOrCtrl+${i + 1}`, () => cur()?.applyPreset(k),
      `${k}（横${PRESETS[k][0]}×縦${PRESETS[k][1]}）`, { type: 'radio', checked: c?.layout === k })) },
    { label: '設定', submenu: [
      { label: 'テーマ', submenu: [['system', 'システムに合わせる'], ['dark', 'ダーク'], ['light', 'ライト']].map(([v, l]) => ({ label: l, type: 'radio', checked: settings.theme === v,
        click: () => { settings.theme = v; nativeTheme.themeSource = v; save(); } })) },
      { type: 'separator' },
      { label: '更新時にmacOS通知を出す', type: 'checkbox', checked: settings.notifications, click: m => { settings.notifications = m.checked; save(); } },
      quietMenu(),
      { label: 'メモリ節約モード（再起動で反映）', submenu: [
        ['std', '標準（推奨）— V8を省メモリ設定 ≈-20%・動作は変わらない'], ['max', '最大 — 同一サイトのペインでプロセス共有 ≈-45%（1ペインの重い処理で他ペインも一時的に固まる）'], ['off', 'オフ — Chromium既定']]
        .map(([v, l]) => ({ label: l, type: 'radio', checked: MEM_MODE === v, click: () => {
          settings.memSaver = v; save();
          if (v === MEM_MODE) return;
          dialog.showMessageBox({ type: 'question', buttons: ['今すぐ再起動', 'あとで'], defaultId: 0, message: 'メモリ節約モードを変更しました', detail: '再起動すると反映されます。ペインの構成と状態は保存されています。' })
            .then(r => { if (r.response === 0) { saveNow(); app.relaunch(); app.quit(); } });
        } })) },
      { label: '終了（🟣）は1分後・待機中（🟢）は30分後に自動スリープ（入力欄に下書きがあれば眠らない）', type: 'checkbox', checked: settings.sleepWaiting !== false, click: m => { settings.sleepWaiting = m.checked; save(); buildMenu(); } },
      { label: 'スリープ中も新着を確認（5分ごとに裏で確認し、あれば水色で表示。失敗が続くと最長60分ごと）', type: 'checkbox', checked: settings.sleepCheck !== false, click: m => { settings.sleepCheck = m.checked; save(); broadcast(); } },
      { label: '新着確認を再開（ログイン要確認で停止中）', enabled: probeAuthHold, click: () => probeResume() },   // (#33) the same as the placeholder's 確認を再開
      // (#22) both off by default. Off: no snap / quote written (the next save removes them), every pane loads at startup as before
      { label: '前回のスリープ状態を復元（再起動後。スリープ中だったペインは読み込まずにスリープのまま開く）', type: 'checkbox', checked: settings.restoreSleep === true, click: m => { settings.restoreSleep = m.checked; save(); buildMenu(); } },
      { label: 'スリープ中の引用も保存（最大300文字）', type: 'checkbox', enabled: settings.restoreSleep === true, checked: settings.saveQuote === true, click: m => { settings.saveQuote = m.checked; save(); } },
      { label: 'デバッグログ（userData/pane-debug.log）', type: 'checkbox', checked: settings.debugLog, click: m => { settings.debugLog = m.checked; save(); } },
      { label: '診断（バージョン・設定・件数・保存状態）…', click: () => cur()?.openOverlay('diag', { diag: diagView() }) },
      { label: '診断ログをファイルにも保存（userData/diagnostics・2MiB×3・7日。会話・名前・URLは記録しない）', type: 'checkbox', checked: settings.diagPersist === true, click: m => { settings.diagPersist = m.checked; diagSync(); save(); } },
      { label: 'grok.com/bot を開き直す補正（直接読み込みで真っ黒になる対策）', type: 'checkbox', checked: settings.grokFix, click: m => { settings.grokFix = m.checked; save(); } },
      { label: 'Grokの会話の画像をクリックしたらペインを最大化（画像を閉じると元に戻す）', type: 'checkbox', checked: settings.autoImg !== false, click: m => { settings.autoImg = m.checked; save(); } },
      { label: 'すべての未読をクリア', click: () => ctxs.forEach(k => k.clearAll()) } ] },
    { role: 'windowMenu', label: 'ウィンドウ' } ]));
}

function restoreBounds(ws) {
  const b = ws?.bounds;
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return { width: 1600, height: 1000 };
  const visible = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return b.x < a.x + a.width - 100 && b.x + b.width > a.x + 100 && b.y < a.y + a.height - 50 && b.y + 30 > a.y;
  });
  return visible ? { x: b.x, y: b.y, width: Math.max(600, b.width), height: Math.max(400, b.height) } : { width: b.width, height: b.height };
}

// ---- recovery: panes.json is broken / from a newer version. Restore a readable generation or start fresh; the original is always kept ----
const RECOVERY_WHY = { read: 'ファイルを読み取れません', json: '内容が壊れています（途中で切れている・JSONとして読めない）', invalid: '内容の形式が正しくありません', newer: '新しいバージョンのアプリで保存された構成です' };
const keptName = () => `panes.json.${store.info().status === 'unsupportedVersion' ? 'newer' : 'broken'}-日時`;
const fileTime = t => new Date(t).toLocaleString('ja-JP', { hour12: false });   // generations can be seconds apart
function recoveryInfo() {
  return { why: RECOVERY_WHY[store.info().reason] || '読み込めません', candidates: store.candidates().slice(0, 8).map(c => ({ id: c.id, kind: c.kind, atText: fileTime(c.at), windows: c.windows, panes: c.panes, favorites: c.favorites, workspaces: c.workspaces })) };
}
async function recoveryRestore(win, id) {
  const c = store.candidates().find(x => x.id === id); if (!c) return;
  const { response } = await dialog.showMessageBox(win, { type: 'question', message: `${fileTime(c.at)} の構成を復元しますか？`,
    detail: `ウィンドウ${c.windows}・ペイン${c.panes}・お気に入り${c.favorites}・ワークスペース${c.workspaces}\n読み込めなかった panes.json は別名（${keptName()}）で同じフォルダに残します。復元するとアプリを再起動します。`,
    buttons: ['復元して再起動', 'キャンセル'], defaultId: 1, cancelId: 1, noLink: true });
  if (response !== 0) return;
  const r = store.restore(id);
  if (!r.ok) { dialog.showMessageBox(win, { type: 'warning', message: '復元できませんでした', detail: `panes.json は変更していません（${r.error}）。`, buttons: ['閉じる'] }); return; }
  app.relaunch(); app.quit();                              // the store stays frozen: nothing is saved over the restored file before the restart
}
async function recoveryFresh(win) {
  const { response } = await dialog.showMessageBox(win, { type: 'question', message: '新しい構成で始めますか？',
    detail: `読み込めなかった panes.json は別名（${keptName()}）で同じフォルダに残し、いま表示中のペイン構成から保存を再開します。お気に入り・ワークスペース・設定は初期状態です。`,
    buttons: ['新しく始める', 'キャンセル'], defaultId: 1, cancelId: 1, noLink: true });
  if (response !== 0) return;
  const r = store.startFresh();
  if (!r.ok) { dialog.showMessageBox(win, { type: 'warning', message: '新しく始められませんでした', detail: `panes.json は変更していません（${r.error}）。`, buttons: ['閉じる'] }); return; }
  saveNow(); broadcast();
}

// ---- 診断 screen / summary: main hands over versions, effective settings, counts and the save state; diagnostics.js keeps only the
// fields and values it knows (safeEnv) and adds its own counts. The summary goes to the clipboard only, after the user saw it in the dialog.
function diagEnv() {
  const all = ctxs.flatMap(c => c.panes), si = store ? store.info() : null;
  return { versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, os: process.getSystemVersion?.() },
    platform: process.platform, arch: process.arch, packaged: app.isPackaged,
    settings: { notifications: !!settings.notifications, sleepWaiting: settings.sleepWaiting !== false, sleepCheck: settings.sleepCheck !== false, grokFix: !!settings.grokFix,
      autoPc: settings.autoPc !== false, autoImg: settings.autoImg !== false, syncCols: settings.syncCols !== false, debugLog: !!settings.debugLog, diagPersist: settings.diagPersist === true, theme: settings.theme, memSaver: MEM_MODE,
      globalZoom: gZoom(), sleepMinutes: settings.sleepMinutes, usageMargin: settings.usageMargin, quietHours: NP.quietOf(settings.quietHours).on,
      restoreSleep: settings.restoreSleep === true, saveQuote: settings.saveQuote === true },
    counts: { windows: ctxs.length, panes: all.length, bots: all.filter(p => p.msgMode).length, sleeping: all.filter(p => p.sleeping).length },
    store: si && { status: si.status, saveError: si.saveError, frozen: si.frozen } };
}
const diagView = () => diag.view(diagEnv());
async function diagCopy(w) {
  const text = diag.summary(diagEnv());
  const { response } = await dialog.showMessageBox(w, { type: 'info', message: '診断summaryをクリップボードにコピーしますか？',
    detail: `次の内容をコピーします（外部には送りません。会話・Bot名・URL・パスは含みません）。\n\n${text}`, buttons: ['コピー', 'キャンセル'], defaultId: 0, cancelId: 1, noLink: true });
  if (response === 0) clipboard.writeText(text);
}

function startup() {
  diag.rec('app', 'START');
  store = createStore({ file: stateFile(), onChange: i => {
    if (i.saveError) { dlog('state', 'save failed', i.saveError); diag.rec('state.save', DIAG.errCode(i.saveError), { n: ++saveFails }, 60000); }
    else if (saveFails) { diag.rec('state.save', 'RECOVERED', { n: saveFails }); saveFails = 0; }
    broadcast(); } });
  const ld = store.load();
  // keep the last few distinct panes.json versions (undo for a bad overwrite); only readable ones, so a broken file never pushes a good backup out
  if (ld.status === 'ready' && ld.exists) { try { rotateBackup(stateFile()); } catch (e) { console.error('backup failed', e.code || ''); } }
  const st = ld.status === 'ready' ? ld.doc : emptyDoc();   // recoveryRequired / unsupportedVersion: nothing is taken from the file
  settings = { ...settings, ...st.settings };
  if (!settings.notifV2) { settings.notifications = true; settings.notifV2 = true; }
  if (!settings.splits || typeof settings.splits !== 'object') settings.splits = {};
  if (ld.status !== 'ready') dlog('state', ld.status, ld.reason, ld.errors.slice(0, 5).join('; '));
  else if (ld.fixes.length) dlog('state', 'repaired on load:', ld.fixes.join('; '));
  const loaded = ld.status === 'ready' ? (ld.fixes.length ? 'REPAIRED' : 'READY') : ld.status === 'unsupportedVersion' ? 'NEWER' : `RECOVERY_${String(ld.reason).toUpperCase()}`;   // reason: read / json / invalid
  diag.rec('state.load', loaded, { n: ld.status === 'ready' ? ld.fixes.length : ld.errors.length });
  diagSync();                                              // files only when asked (settings.diagPersist / MPB_DEBUG)
  workspaces = st.workspaces;
  favorites = st.favorites.slice(0, 100).map(f => ({ id: nextFavId++, url: f.url, label: String(f.label || '').slice(0, 60) || defaultFavLabel(f.url) }));
  grok = st.grok || GB.empty();                            // (Grok bar) the list as last read (never read at startup: the Grok button does)
  if (ld.status === 'ready' && !settings.favGrokV1) gbMigrate();   // once: the old favorites to their backup file, the bar starts empty
  let wins = st.windows;                                  // migrate() has already turned the old single-window format into windows[]
  if (process.env.MPB_DEMO) {
    wins = [{ layout: '5x2', focused: 0, panes: ['https://example.com', 'https://www.wikipedia.org', 'https://news.ycombinator.com', 'https://github.com',
      'https://www.electronjs.org', 'https://developer.mozilla.org', 'https://www.python.org', 'https://nodejs.org',
      'https://time.is', 'https://go.dev'].map((url, i) => ({ url, reloadMinutes: i % 2 ? 5 : 0, name: ['', 'ウィキ', '', '', 'Electron', '', '', '', '時計', ''][i], color: ['none', 'blue', 'orange', 'none', 'purple', 'none', 'green', 'none', 'pink', 'teal'][i] })) }];
  }
  if (process.env.MPB_URLS) wins = [{ layout: process.env.MPB_LAYOUT || '2x2', panes: process.env.MPB_URLS.split(',').map(url => ({ url })) }];
  if (process.env.MPB_FAVS) favorites = process.env.MPB_FAVS.split(',').map(s => { const [label, url] = s.split('='); return { id: nextFavId++, url, label }; });
  if (process.env.MPB_THEME) settings.theme = process.env.MPB_THEME;
  nativeTheme.themeSource = ['dark', 'light'].includes(settings.theme) ? settings.theme : 'system';
  nativeTheme.on('updated', broadcast);
  wins.forEach(w => makeWindow(w, { restore: true }));
  { const saved = wins.reduce((a, w) => a + (Array.isArray(w.panes) ? w.panes.slice(0, MAX).filter(s => s && s.snap).length : 0), 0);   // (#22) counts only
    const rs = ctxs.flatMap(c => c.panes).filter(p => p.restored), old = rs.filter(p => p.restored.age !== 'fresh').length;
    if (rs.length) diag.rec('restore', 'ASLEEP', { n: rs.length });
    if (old) diag.rec('restore', 'OLD', { n: old });
    if (saved > rs.length) diag.rec('restore', 'IGNORED', { n: saved - rs.length }); }
  buildMenu();
  if (!store.writable()) { const c = ctxs[0]; c.overlay.webContents.once('did-finish-load', () => c.openOverlay('recovery', { recovery: recoveryInfo() })); }

  if (process.env.MPB_AUTO_PC) setTimeout(() => { const c = ctxs[0], p = c.panes[Number(process.env.MPB_AUTO_PC)]; dlog('auto-pc', p ? p.id : 'none', p ? p.view.webContents.getURL() : ''); if (p) c.togglePc(p.id); }, Number(process.env.MPB_AUTO_PC_DELAY || 40000));   // dev only: exercise the cloud-PC maximise
  if (process.env.MPB_SCREENSHOT) setTimeout(async () => {
    const c = ctxs[0];
    if (process.env.MPB_PALETTE) { c.openOverlay('palette'); await sleep(1200); }
    if (process.env.MPB_SHOT_GLOW) { const p = c.panes[Number(process.env.MPB_SHOT_GLOW)]; if (p) { p.unread = 3; p.glow = true; c.sendState(); await sleep(400); } }
    if (process.env.MPB_SHOT_STATE) { for (const it of process.env.MPB_SHOT_STATE.split(',')) { const [i, st] = it.split(':'); const p = c.panes[Number(i)]; if (!p) continue; p.msgMode = true; p.unread = 2; p.waiting = st === 'wait'; p.working = st === 'work'; p.done = st === 'done'; } c.sendState(); await sleep(500); }   // dev only: preview the green / red states
    const { execFileSync } = require('child_process');
    try { execFileSync('sh', ['-c', `ffmpeg -y -loglevel error -f x11grab -video_size 1600x1000 -i "$DISPLAY" -frames:v 1 "${process.env.MPB_SCREENSHOT}"`]); }
    catch { const img = await c.win.webContents.capturePage(); fs.writeFileSync(process.env.MPB_SCREENSHOT, img.toPNG()); }
    app.quit();
  }, Number(process.env.MPB_SCREENSHOT_DELAY || 20000));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
app.userAgentFallback = chromeUA();
app.whenReady().then(() => {
  const { session, powerMonitor } = require('electron');
  powerMonitor.on('suspend', () => { sysBlocked = true; }); powerMonitor.on('lock-screen', () => { sysBlocked = true; });
  powerMonitor.on('resume', () => { sysBlocked = false; resumeAt = Date.now(); }); powerMonitor.on('unlock-screen', () => { sysBlocked = false; resumeAt = Date.now(); });
  session.defaultSession.setUserAgent(chromeUA());
  // (#72) site permissions: permission-policy.js decides from the permission, the asking page's role (main's registry; not registered = a window
  // a page opened, no page = a worker), the asking frame's origin and the page's top-level URL. Only the permissions allowed before, for any
  // site the panes show, from a sound origin (https / loopback http) asking for its own page (top frame = top-level origin; a child frame of
  // that origin, or grok.com in grok.com; no cross-origin child frame), never for the hidden background check (storage aside) or the app's
  // own UI. The check and the request ask the same.
  const permRole = wc => { if (!wc) return 'worker'; try { const r = wcReg.get(wc.id); return r && r.wc === wc ? r.role : 'popup'; } catch { return 'popup'; } };
  const topUrl = wc => { try { return wc && !wc.isDestroyed() ? wc.getURL() : ''; } catch { return ''; } };
  const permDenied = (perm, code, wc) => {
    if (!code) return false;
    const p = wc && !wc.isDestroyed() ? wcReg.get(wc.id)?.pane : null;
    diag.rec('perm.deny', code, { p: p && p.id }, 600000);
    if (debugOn()) dlog('permission', perm, 'deny', code, permRole(wc));
    return true;
  };
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, d = {}) => {
    const code = PERM.decide(perm, { role: permRole(wc), origin: d.requestingUrl, origin2: d.securityOrigin, main: d.isMainFrame, top: topUrl(wc), media: d.mediaTypes });
    if (!permDenied(perm, code, wc)) dlog('permission', perm, 'allow');
    cb(!code);
  });
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin, d = {}) =>
    !permDenied(perm, PERM.decide(perm, { role: permRole(wc), origin, main: d.isMainFrame, top: wc ? topUrl(wc) : '', embedding: d.embeddingOrigin, media: d.mediaType }), wc));
  // downloads (attachments, blob links, generated files): straight into ~/Downloads under a unique name, with a completion notification
  // (#72) from a page the user sees only (not the background check / the app's UI); the page's name made plain (no folder part, no hidden or
  // disguised name); never opened by itself (the notification only shows it in Finder)
  session.defaultSession.on('will-download', (e, item, wc) => {
    if (permDenied('download', PERM.download(permRole(wc)), wc)) { e.preventDefault(); return; }
    const dir = app.getPath('downloads'); const name = PERM.downloadName(item.getFilename());
    const ext = path.extname(name), base = path.basename(name, ext); let dest = path.join(dir, name), n = 1;
    while (fs.existsSync(dest)) dest = path.join(dir, `${base} (${n++})${ext}`);
    item.setSavePath(dest);
    dlog('download', 'start', name, item.getMimeType());
    item.once('done', (ev, state) => {
      dlog('download', state, dest);
      if (state === 'completed' && Notification.isSupported()) { const nt = new Notification({ title: 'ダウンロード完了', body: path.basename(dest) }); nt.on('click', () => shell.showItemInFolder(dest)); nt.show(); }
    });
  });
  startup();
});
// a normal quit first waits (QUIT_FLUSH_MS at most) for the last snapshot to be on disk, then quits for real. Blocked (recovery): nothing to write.
let quitFlush = 0;                                         // 0 = not started, 1 = flushing, 2 = done
app.on('before-quit', e => {
  clearTimeout(saveTimer);
  if (quitFlush === 2 || !store?.writable()) { quitting = true; return; }
  e.preventDefault();
  if (quitFlush === 1) return;
  quitFlush = 1; const doc = stateDoc(); quitting = true;
  store.flush(doc, QUIT_FLUSH_MS).then(ok => { if (!ok) console.error('state: last save not confirmed before quit'); })
    .finally(() => { quitFlush = 2; app.quit(); });
});
app.on('window-all-closed', () => { clearTimeout(saveTimer); quitting = true; app.quit(); });


// ======================= subscription usage (read-only) =======================
// Source: grok.com gRPC-web  POST /grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig (empty request; the same call grok.com's own UI makes).
// Response config(field 1).creditUsagePercent = float field 1. Read-only, no purchases.
function pbFields(buf) {
  const out = []; let i = 0;
  const vint = () => { let r = 0, sh = 0, b; do { b = buf[i++]; r += (b & 0x7f) * 2 ** sh; sh += 7; } while (b & 0x80); return r; };
  while (i < buf.length) {
    const tag = vint(), f = Math.floor(tag / 8), wt = tag & 7;
    if (wt === 0) out.push([f, vint()]);
    else if (wt === 5) { out.push([f, Buffer.from(buf.slice(i, i + 4)).readFloatLE(0)]); i += 4; }
    else if (wt === 1) { out.push([f, Buffer.from(buf.slice(i, i + 8)).readDoubleLE(0)]); i += 8; }
    else if (wt === 2) { const l = vint(); out.push([f, buf.slice(i, i + l)]); i += l; }
    else throw new Error('wt' + wt);
  }
  return out;
}
let usageCache = null, usageBusy = false;
async function fetchUsage() {
  if (usageBusy) return usageCache;
  usageBusy = true;
  try {
    const wc = require('electron').webContents.getAllWebContents().find(w => !w.isDestroyed() && /^https:\/\/grok\.com\//.test(w.getURL()));
    if (!wc) throw new Error('no grok pane');
    const bytes = await wc.executeJavaScriptInIsolatedWorld(1002, [{ code: `(async()=>{const q=await fetch('https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig',{method:'POST',credentials:'include',headers:{'content-type':'application/grpc-web+proto','x-grpc-web':'1'},body:new Uint8Array(5)});if(!q.ok)return 'HTTP '+q.status;return Array.from(new Uint8Array(await q.arrayBuffer()));})()` }]);
    if (!Array.isArray(bytes)) throw new Error(String(bytes));
    const len = bytes[1] * 2 ** 24 + bytes[2] * 65536 + bytes[3] * 256 + bytes[4];
    if (bytes[0] !== 0 || len + 5 > bytes.length) throw new Error('bad frame');
    const cfg = pbFields(bytes.slice(5, 5 + len)).find(([f]) => f === 1);
    if (!cfg) throw new Error('no config');
    const fields = pbFields(cfg[1]);
    const usedF = fields.find(([f, v]) => f === 1 && typeof v === 'number');
    const used = usedF ? usedF[1] : 0;   // proto3 omits 0
    if (!(used >= 0 && used <= 1000)) throw new Error('odd value ' + used);
    let periodEnd = null;
    const per = fields.find(([f, v]) => f === 8 && typeof v !== 'number');
    if (per) { const e = pbFields(per[1]).find(([f]) => f === 3); if (e) { const sec = pbFields(e[1]).find(([f]) => f === 1); if (sec) periodEnd = sec[1] * 1000; } }
    usageCache = { ok: true, used, periodEnd, at: Date.now() };
    const dk = UD.dayKey(nowT());
    const ub = settings.usageBase, newPeriod = !!(ub && ub.periodEnd && periodEnd && Math.abs(ub.periodEnd - periodEnd) > 3600000);
    if (newPeriod || (ub && used < ub.used)) settings.usageBase = { day: dk, used: 0, at: nowT(), periodEnd };   // new weekly period: starts at 0% used
    else if (!ub || ub.day !== dk) settings.usageBase = { day: dk, used, at: nowT(), periodEnd };        // new 09:00 day: baseline = usage at first fetch
    else if (!ub.periodEnd && periodEnd) settings.usageBase.periodEnd = periodEnd;
    save();
    dlog('usage', JSON.stringify(usageCache));
  } catch (e) { dlog('usage err', String(e)); usageCache = { ...(usageCache || {}), ok: !!usageCache?.ok, err: String(e.message || e), at: Date.now() }; }
  finally { usageBusy = false; }
  ctxs.forEach(c => { try { c.win.webContents.send('usage-updated'); c.overlay?.webContents.send('usage-updated'); } catch {} });
  return usageCache;
}
const TOKYO = { timeZone: 'Asia/Tokyo' };
const tokyoDay = t => new Intl.DateTimeFormat('sv-SE', { ...TOKYO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
function fmtTokyo(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('ja-JP', { ...TOKYO, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(t).map(x => [x.type, x.value]));
  return `${p.month}/${p.day}(${p.weekday}) ${p.hour}:${p.minute}`;
}
const UD = require('./usage-days');
const nowT = () => Date.now();
function usageDetail() {
  const u = usageCache, margin = Number.isFinite(settings.usageMargin) ? settings.usageMargin : 5;
  const d = { ok: !!u?.ok, err: u?.err || '', margin, at: u?.at || 0, atText: u?.at ? new Intl.DateTimeFormat('ja-JP', { ...TOKYO, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(u.at) : '' };
  if (!u?.ok) return d;
  const now = nowT();
  d.used = u.used; d.left = Math.max(0, 100 - u.used);
  if (u.periodEnd && u.periodEnd > now) {
    const ms = u.periodEnd - now;
    d.endText = fmtTokyo(u.periodEnd);
    d.remD = Math.floor(ms / 86400000); d.remH = Math.floor(ms % 86400000 / 3600000); d.remM = Math.floor(ms % 3600000 / 60000);
    const ad = UD.allowanceDays(now, u.periodEnd);
    d.days = ad.days; d.daysWhole = ad.whole; d.daysWeight = ad.weight; d.daysFrom = ad.from; d.daysTo = ad.to;
    let b = settings.usageBase;
    // the day rolled over (09:00 JST) but the baseline fetch has not happened yet (poll pending / no grok pane): assume nothing used yet today
    if (b && b.day !== UD.dayKey(now) && u.used >= b.used) b = { ...b, day: UD.dayKey(now), used: u.used, at: now };
    if (b && b.day === UD.dayKey(now)) {
      d.baseLeft = Math.max(0, 100 - b.used);
      d.usedToday = Math.max(0, u.used - b.used); d.baseAt = b.at;
      d.allowance = UD.allowance(d.baseLeft, margin, ad.days);   // from remaining at the START of the day: constant during the day
      d.allowLeft = d.allowance == null ? null : Math.max(0, UD.floor1(d.allowance - d.usedToday));
    }
  }
  return d;
}
const AIU = require('./ai-usage');
AIU.setOnChange(() => { ctxs.forEach(c => { try { c.win.webContents.send('usage-updated'); c.overlay?.webContents.send('usage-updated'); } catch {} }); });
ipcHandle('aiusage:get', async (_, kind, force) => {
  if (!['codex', 'claude'].includes(kind)) return null;
  const r = await AIU.get(kind, !!force);
  dlog('aiusage', kind, (r.ok ? 'ok ' : 'err ') + (r.stale ? 'STALE ' : '') + (r.buckets || []).map(b => `${b.label}=${Math.round(b.used * 10) / 10}%`).join(' ') + (r.err ? ' | ' + r.err : ''));
  return r;
});
ipcHandle('claude:auth-dialog', async r => {
  const w = r.ctx.win;
  const repoll = () => AIU.get('claude', true).catch(() => {});
  const { response } = await dialog.showMessageBox(w, { type: 'warning', message: 'Claudeの認証が切れています', detail: 'Claudeの使用量を表示するには、Claude Codeの再ログインが必要です。', buttons: ['自動で再認証を試す', 'ターミナルでログイン', '閉じる'], defaultId: 0, cancelId: 2, noLink: true });
  if (response === 0) {
    const ok = await AIU.claudeReauth(); const r = await repoll();
    if (!r || r.needLogin || !r.ok) await dialog.showMessageBox(w, { type: 'info', message: ok ? '再認証は実行しましたが、まだ取得できません' : '自動での再認証に失敗しました', detail: '「ターミナルでログイン」から、Claude Codeにログインしてください。', buttons: ['閉じる'] });
  } else if (response === 1) {
    AIU.openClaudeLoginInTerminal();
    [30000, 90000, 180000].forEach(ms => setTimeout(repoll, ms));      // pick up the new login shortly after
  }
  return response;
});
ipcHandle('usage:detail', () => usageDetail());
ipcHandle('usage:margin', (_, v) => { const n = Number(v); if (Number.isFinite(n) && n >= 0 && n <= 50) { settings.usageMargin = n; save(); } return usageDetail(); });
// Day rollover (09:00 JST): checked every 15 s in the main process (timers in a hidden renderer are throttled) and on app focus.
// On a change the baseline is re-fetched at once and every window redraws, instead of waiting for the next 5-minute poll.
let lastDayKey = UD.dayKey(nowT());
async function checkDayRollover() {
  const dk = UD.dayKey(nowT());
  if (dk === lastDayKey) return;
  lastDayKey = dk; dlog('usage', 'day rollover ->', dk);
  await fetchUsage().catch(() => {});
  ctxs.forEach(c => { try { c.win.webContents.send('usage-updated'); c.overlay?.webContents.send('usage-updated'); } catch {} });
}
setInterval(() => { checkDayRollover().catch(() => {}); }, 15000);
app.on('browser-window-focus', () => { checkDayRollover().catch(() => {}); });
ipcHandle('usage:get', async (_, force) => (!force && usageCache?.ok && Date.now() - usageCache.at < 60000) ? usageCache : fetchUsage());

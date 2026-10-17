const { app, BrowserWindow, WebContentsView, ipcMain, Menu, Notification, nativeTheme, screen, clipboard, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const isMac = process.platform === 'darwin';
const MAX = 10;
const TOPBAR = 76;        // top bar (traffic lights + layout + pane strip) + favorites bar
const PHEAD = 30;         // per-pane header
const GAP = 6;            // gutter between pane cards
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

let settings = { notifications: false, ecoMode: true, debugLog: false, grokFix: true, theme: 'system' };
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

// Clean Chrome UA (no "Electron/x" or app name) so sites don't treat us as an unknown embedder.
function chromeUA() {
  const os = isMac ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  const major = process.versions.chrome.split('.')[0];
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// ---- persistence (backward compatible: layout/focused/urls are always written and read) ----
const stateFile = () => path.join(app.getPath('userData'), 'panes.json');
const paneSpec = p => ({ url: paneUrl(p), reloadMinutes: p.reloadMinutes, name: p.name || '', color: p.color || 'none', muted: !!p.muted, zoom: p.zoom || 1, zoomIndiv: !!p.zoomIndiv, sleep: p.sleepOn !== false });
function saveNow() {
  try {
    const wins = ctxs.map(c => c.snapshot());
    const first = wins[0] || lastClosedSnapshot || { layout: '2x2', focused: 0, panes: [] };
    fs.writeFileSync(stateFile(), JSON.stringify({
      // legacy single-window fields (= first window)
      layout: first.layout, focused: first.focused, urls: first.panes.map(s => s.url), panes: first.panes, window: first.window,
      windows: wins.length ? wins : [first],
      favorites: favorites.map(({ url, label }) => ({ url, label })),
      settings, workspaces,
    }, null, 2));
  } catch (e) { console.error('save failed', e); }
}
let lastClosedSnapshot = null;
let quitting = false;
function save() { if (quitting) return; clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 500); }
function load() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; } }
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
  (u === NEWTAB ? wc.loadFile(NEWTAB_FILE) : wc.loadURL(u)).catch(() => {});
}


// ======================= global (all windows) =======================
function broadcast() { ctxs.forEach(c => c.sendState()); }
function updateDockBadge() {
  const n = ctxs.reduce((a, c) => a + c.panes.filter(p => !p.muted).reduce((b, p) => b + (p.msgMode && p.needsReply ? (p.unread || 0) : 0), 0), 0);
  if (isMac) app.dock?.setBadge(n ? String(n) : '');
  else app.setBadgeCount?.(n);
}
const uiCtx = sender => ctxs.find(c => c.win.webContents === sender || c.overlay?.webContents === sender);
const paneCtx = sender => ctxs.find(c => c.panes.some(p => p.view.webContents === sender));
const regUi = new Set(), regPane = new Set();
function registerUi(ch) { if (regUi.has(ch)) return; regUi.add(ch); ipcMain.on(ch, (e, ...a) => { const c = uiCtx(e.sender); c?.ui[ch]?.(...a); }); }
function registerPane(ch) { if (regPane.has(ch)) return; regPane.add(ch); ipcMain.on(ch, (e, ...a) => { const c = paneCtx(e.sender); c?.paneIpc[ch]?.(e, ...a); }); }
const cur = () => { const w = BrowserWindow.getFocusedWindow(); return ctxs.find(c => c.win === w) || ctxs[ctxs.length - 1]; };

function favChanged() { save(); broadcast(); }
function addFavorite(url, label) {
  url = String(url || '').trim(); if (!url) return;
  if (!/^[a-z]+:\/\//i.test(url)) url = normalize(url);
  if (url === NEWTAB) return;
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

// ---- auto reload ----
setInterval(() => {
  const now = Date.now();
  for (const p of ctxs.flatMap(c => c.panes)) {
    if (!p.reloadMinutes) continue;
    const wc = p.view.webContents;
    if (now - p.lastReload < p.reloadMinutes * 60000) continue;
    if (now - p.lastTyping < TYPING_GRACE_MS || p.editing || wc.isLoading()) continue;
    p.lastReload = now;
    reloadPane(p);
  }
}, 15000);

const clampZ = z => Math.round(Math.min(3, Math.max(0.3, Number(z) || 1)) * 100) / 100;
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

setInterval(() => ctxs.forEach(c => { try { c.sleepTick(); } catch {} }), 30000);
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
ipcMain.on('focus-other', (e, wid, pid) => {
  const c = ctxs.find(k => !k.win.isDestroyed() && k.win.id === wid); if (!c) return;
  if (c.win.isMinimized()) c.win.restore();
  c.win.show(); c.win.focus(); c.focusPaneById(Number(pid));
});
const APPROVE_URL = 'https://grok.com/bot/5674ea26-494f-49a0-acc1-f55ce2dd9c94';   // 承認Bot popup
const APPROVE_KEEP_MS = 5 * 60000;                                                   // keep the hidden popup page this long for a fast reopen, then free its memory

// ======================= one app window =======================
function makeWindow(spec = {}, { restore = false } = {}) {
let win, overlay, overlayOpen = false;
let activeWs = null;                       // name of the saved layout currently loaded / last saved in this window
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
let rowLens = Array.isArray(spec.rows) ? spec.rows.map(Number) : null;
const sumArr = a => a.reduce((x, y) => x + y, 0);
function defRows(n) {                                  // rows as the preset / auto-fit would lay n panes out
  if (n <= 0) return [];
  const g = grid(n), out = []; let left = n;
  for (let r = 0; r < g.rows && left > 0; r++) { const k = r === g.rows - 1 ? left : Math.min(g.cols, left); out.push(k); left -= k; }
  return out;
}
function getRows() {                                   // validated; falls back to the default grid
  if (!rowLens || !rowLens.every(k => Number.isInteger(k) && k > 0) || sumArr(rowLens) !== panes.length) rowLens = defRows(panes.length);
  return rowLens;
}
const sameArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const splitKey = () => { const l = getRows(); return `${Math.max(1, ...l)}x${Math.max(1, l.length)}`; };
function cells() {
  const [w, h] = win.getContentSize();
  const n = panes.length; if (!n) return [];
  const area = { x: GAP, y: TOPBAR + GAP, w: w - 2 * GAP, h: h - TOPBAR - 2 * GAP };
  if (maximizedId != null && byId(maximizedId))
    return panes.map(p => p.id === maximizedId ? { x: area.x, y: area.y, w: area.w, h: area.h } : null);
  const lens = getRows(), rows = lens.length, cols = Math.max(...lens);
  const sp = settings.splits?.[`${cols}x${rows}`] || {};
  const wts = (arr, k) => Array.isArray(arr) && arr.length === k && arr.every(v => v > 0.05) ? arr : Array(k).fill(1);
  const edges = (start, len, k, w) => { const tot = w.reduce((a, b) => a + b, 0); let acc = 0; const e = [start]; for (let j = 0; j < k; j++) { acc += w[j]; e.push(start + (len + GAP) * acc / tot); } return e; };
  // column edges per row: with "sync" (default) every row shares sp.c; without it each row has its own weights in sp.rc[row] (null = shared / even)
  const sync = settings.syncCols !== false;
  const rowW = r => wts((!sync && sp.rc && sp.rc[r]) || sp.c, cols);
  const evenEdges = () => { const tot = area.w - GAP * (cols - 1), base = Math.floor(tot / cols), rem = tot - base * cols; const e = []; for (let j = 0; j <= cols; j++) e.push(area.x + j * (base + GAP) + Math.min(j, rem)); return e; };   // integer-exact equal columns
  const cEs = Array.from({ length: rows }, (_, r) => { const w = rowW(r); return w.every(v => v === w[0]) ? evenEdges() : edges(area.x, area.w, cols, w); });
  const fr = Math.max(0, lens.findIndex(k => k === cols)), cE = cEs[fr], rE = edges(area.y, area.h, rows, wts(sp.r, rows));
  lastGeom = { area, cols, rows, cE, cEs, rE, n, sync, lens };
  const out = []; let idx = 0;
  lens.forEach((inRow, r) => {
    for (let c = 0; c < inRow; c++, idx++) {
      let x0, x1;
      if (inRow === cols) { x0 = cEs[r][c]; x1 = cEs[r][c + 1]; } else { const cw = (area.w + GAP) / inRow; x0 = area.x + c * cw; x1 = area.x + (c + 1) * cw; }   // shorter row: its panes share the width evenly
      const x = Math.round(x0), y = Math.round(rE[r]);
      out.push({ x, y, w: Math.round(x1 - GAP) - x, h: Math.round(rE[r + 1] - GAP) - y });
    }
  });
  return out;
}
let lastGeom = null, splitDrag = null;
function splitters() {
  const g = lastGeom; if (!g || maximizedId != null || g.n < 2) return [];
  const out = [], full = g.lens.map(k => k === g.cols);   // only rows that use the shared / per-row column weights get column splitters
  if (g.sync) {
    for (let r = 0; r < g.rows; r++) {                      // one bar per run of consecutive full rows
      if (!full[r]) continue; let e = r; while (e + 1 < g.rows && full[e + 1]) e++;
      for (let i = 1; i < g.cols; i++) out.push({ axis: 'c', i, x: Math.round(g.cEs[r][i] - GAP), y: Math.round(g.rE[r]), w: GAP, h: Math.round(g.rE[e + 1] - GAP - g.rE[r]) });
      r = e;
    }
  } else for (let r = 0; r < g.rows; r++) if (full[r]) for (let i = 1; i < g.cols; i++) out.push({ axis: 'c', i, row: r, x: Math.round(g.cEs[r][i] - GAP), y: Math.round(g.rE[r]), w: GAP, h: Math.round(g.rE[r + 1] - GAP - g.rE[r]) });
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
    p.view.setVisible(!!t && !p.sleeping);
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
}
function applyPreset(key) {
  if (!PRESETS[key]) return;
  layout = key; maximizedId = null;
  const want = PRESETS[key][0] * PRESETS[key][1];
  while (panes.length > want) closePane(panes[panes.length - 1].id, true);
  while (panes.length < want) addPane({ url: '' }, { focus: false });
  rowLens = null;                                       // a preset re-initialises the rows
  setFocused(Math.min(focused, panes.length - 1));
  relayout(true); save();
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
    globalZoom: gZoom(), syncCols: settings.syncCols !== false, canSync: getRows().length >= 2, splitters: splitters(), sleepGlobal: settings.sleepWaiting !== false, workspaces: Object.keys(workspaces), activeWs: workspaces[activeWs] ? activeWs : null, favorites, windowCount: ctxs.length,
    panes: panes.map((p, i) => {
      const wc = p.view.webContents;
      return { id: p.id, index: i, url: paneUrl(p), title: displayTitle(p), name: p.name || '', color: p.color || 'none',
        favicon: p.favicon || '', loading: wc.isLoading(), muted: !!p.muted, zoom: p.zoom || 1, zoomIndiv: !!p.zoomIndiv, isGrok: !!p.msgMode,
        canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward(),
        sleeping: !!p.sleeping, sleepOn: p.sleepOn !== false, unread: p.unread, glow: !!p.glow, waiting: !!p.waiting, working: !!p.working, needsReply: !!p.needsReply, reloadMinutes: p.reloadMinutes, rect: cs[i] };
    }),
  };
  win.webContents.send('state', state);
  scheduleOthers();
  if (overlayOpen) overlay.webContents.send('state', state);
}

// ---- focus / activity ----
function setFocused(i) {
  if (i < 0 || i >= panes.length) return;
  focused = i;
  if (panes[i].sleeping) reloadPane(panes[i]);                      // focusing a sleeping pane wakes it
  applyThrottling();
  sendState(); save();
}
function focusPane(i, { clear = true } = {}) {
  const p = panes[i]; if (!p) return;
  if (maximizedId != null && maximizedId !== p.id) { maximizedId = p.id; relayout(true); }
  setFocused(i);
  if (clear) clearUnread(p);
  p.view.webContents.focus();
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
function canAlert(p) {
  if (!win) return false;
  if (panes[focused] === p && windowActive() && (maximizedId == null || maximizedId === p.id)) return false;
  if (p.grokToken || p.grokPending) return false;
  if (Date.now() - p.loadedAt < 4000) return false;
  return true;
}
function lightUp(p, reason, always = false) {
  dlog(`pane${p.id}`, 'activity', reason);
  const first = !p.glow || always;
  p.glow = true;
  updateBadge(); sendState();
  if (first && settings.notifications && !p.muted && Notification.isSupported()) {
    const n = new Notification({ title: p.name || displayTitle(p), body: p.msgMode ? (p.waiting ? `入力待ち（未返信 ${p.unread}件）` : `新しいメッセージ ${p.unread}件`) : '新しい更新があります', silent: false });
    n.on('click', () => { if (win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.show(); app.focus({ steal: true }); win.focus(); const i = panes.indexOf(p); if (i >= 0) focusPane(i, { clear: false }); });
    dlog(`pane${p.id}`, 'notify', p.unread);
    n.show();
  }
}
const isBotUrl = u => /^https:\/\/grok\.com\/bot\//.test(String(u || ''));
function resetCounts(p) { if (p.sleeping) return; const had = p.unread || p.glow || p.waiting || p.working || p.needsReply; p.needsReply = false; p.msgMode = false; p.lastUserCount = null; p.lastMsg = null; p.unread = 0; p.glow = false; p.waiting = false; p.working = false; if (had) { updateBadge(); sendState(); } }
function markActivity(p, reason) {
  return;   // counts come ONLY from bot replies on grok.com/bot/* (onMsgCount); generic page changes never count

  if (p.msgMode || !canAlert(p)) return;
  p.unread = (p.unread || 0) + 1;
  lightUp(p, reason);
}
function onMsgCount(p, c) {
  if (p.sleeping) return;                                   // a sleeping pane keeps its remembered state
  if (!isBotUrl(p.view.webContents.getURL())) { resetCounts(p); return; }
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
  const wasK = p.working; p.working = !!c.working && !p.waiting && !userSent && c.botSince > 0;   // red: latest marker says '作業中' (UI only; no notification / badge)
  if (wasK !== p.working) dlog(`pane${p.id}`, 'working', p.working);
  const wasAsk = p.needsReply; p.needsReply = !!(c.asks || c.waiting) && !c.working && c.botSince > 0;
  if (wasAsk !== p.needsReply) dlog(`pane${p.id}`, 'needsReply', p.needsReply);
  if (userSent || c.botSince === 0) { if (p.glow) dlog(`pane${p.id}`, 'msgcount reset (user sent)'); p.glow = false; p.needsReply = false; }
  else if (!p.needsReply) { p.glow = false; }                      // plain progress report: grey number only
  else if (prev != null && (!wasAsk || c.botSince > prev) && canAlert(p)) { lightUp(p, `bot asks (${c.botSince})`, true); return; }   // glow + notification only when waiting for the user
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
function moveFocus(dir) {
  const lens = getRows(), n = panes.length;
  let i = focused, r = 0, st = 0; while (r < lens.length - 1 && focused >= st + lens[r]) { st += lens[r]; r++; }
  const c = focused - st, startOf = k => sumArr(lens.slice(0, k));
  if (dir === 'left') i = i - 1; else if (dir === 'right') i = i + 1;
  else if (dir === 'up') { if (r === 0) return; i = startOf(r - 1) + Math.min(c, lens[r - 1] - 1); }
  else if (dir === 'down') { if (r >= lens.length - 1) return; i = startOf(r + 1) + Math.min(c, lens[r + 1] - 1); }
  if (i < 0 || i >= n) return;
  focusPane(i, { clear: false });
}

// ---- load reduction ----
function applyThrottling() {
  panes.forEach((p, i) => {
    const wc = p.view.webContents; if (wc.isDestroyed()) return;
    // never slow a pane that is still loading / being fixed (that made background panes load twice as slowly)
    const settled = !wc.isLoading() && !p.grokToken && !p.grokPending && Date.now() - (p.loadedAt || 0) > 3000;
    const rate = settings.ecoMode && !process.env.MPB_NO_ECO && i !== focused && settled ? 2 : 1;
    if (p.cpuRate === rate) return;
    const dbg = wc.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
      dbg.sendCommand('Emulation.setCPUThrottlingRate', { rate }).then(() => { p.cpuRate = rate; }).catch(() => {});
    } catch { /* devtools open or attach failed: just skip */ }
  });
}
setInterval(() => { if (!win || win.isDestroyed()) return; try { applyThrottling(); } catch {} }, 5000);   // picks up panes that finished loading

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
    if (pr === 'rendered' || pr === 'notfound') { dlog(`pane${p.id}`, 'grokfix fast', pr, pushes ? `after ${pushes} push(es)` : ''); p.loadedAt = Date.now(); p.grokToken = null; p.hardTries = 0; p.wdTries = 0; applyThrottling(); return; }
    if (pushes >= 2 && Date.now() - lastPush > PUSH_GAP && (p.hardTries || 0) < 3) {
      // the router hop keeps missing: start over with a fresh load of the bot URL (bounded) instead of pushing forever
      p.hardTries = (p.hardTries || 0) + 1; p.grokToken = null;
      dlog(`pane${p.id}`, 'grokfix: hop failed twice -> hard reload', p.hardTries);
      wc.loadURL(target).catch(() => {}); return;
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
    if (r === 'rendered' || r === 'notfound') { p.loadedAt = Date.now(); p.grokToken = null; return; }   // logged out or bad id: leave as is
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
          if (await grokProbe(wc, id) === 'rendered') { dlog(`pane${p.id}`, 'grokfix ok (router)'); p.loadedAt = Date.now(); p.grokToken = null; return; }
        }
      }
    }
    if (r === 'clicked') {
      for (let j = 0; j < 5 && alive(); j++) {
        await sleep(1000);
        const r2 = await grokProbe(wc, id);
        if (r2 === 'rendered') { dlog(`pane${p.id}`, 'grokfix ok'); p.loadedAt = Date.now(); p.grokToken = null; return; }
        if (r2 === 'clicked') continue;           // clicked again, keep waiting
      }
    }
  }
  if (!alive()) return;
  p.grokToken = null; p.loadedAt = Date.now(); applyThrottling();
  if (!viaHome) {                                  // fallback: go home, then click the bot link
    dlog(`pane${p.id}`, 'grokfix fallback: load grok.com/ then navigate');
    p.grokPending = { target, id };
    wc.loadURL('https://grok.com/').catch(() => {});
  } else {
    dlog(`pane${p.id}`, 'grokfix gave up; leaving page as is', target);
  }
}
// Watchdog: a bot pane that is on screen, finished its fix routine, and still shows no chat box (blank / landing page) is reloaded
// through the fast path. Bounded (3 tries per pane, spaced out) so it can never loop.
const GROK_RENDERED = id => `(() => { const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return location.pathname.includes(${JSON.stringify(id)}) && [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')].some(vis) || /Page not found/i.test((document.body && document.body.innerText) || ''); })()`;
setInterval(async () => {
  if (process.env.MPB_NO_WATCHDOG) return;
  for (const c of ctxs) for (const p of c.panes) {
    try {
      const wc = p.view.webContents;
      if (wc.isDestroyed() || p.sleeping || p.grokToken || p.grokPending || wc.isLoading() || (p.loadStartedAt && !p.loadDone) || !settings.grokFix) continue;
      if (loadQ.includes(p)) continue;                                  // still queued at startup: about:blank is expected
      const cu = wc.getURL(), m = cu.match(GROK_BOT_RE);
      const own = p.botTarget || (GROK_BOT_RE.test(p.url || '') ? p.url : null);   // the pane's own bot link
      const id = m ? m[1] : (own && (isBlankUrl(cu) || cu.startsWith('https://grok.com')) ? (own.match(GROK_BOT_RE) || [])[1] : null);
      if (!id) continue;
      const b = p.view.getBounds(); if (!b.width || !b.height || Date.now() - (p.loadedAt || 0) < 20000 || Date.now() - (p.lastReload || 0) < 20000) continue;
      if (await wc.executeJavaScript(GROK_RENDERED(id)).catch(() => true)) { p.wdTries = 0; continue; }
      if ((p.wdTries || 0) >= 3 || Date.now() - (p.wdAt || 0) < 30000) continue;
      p.wdTries = (p.wdTries || 0) + 1; p.wdAt = Date.now();
      dlog(`pane${p.id}`, 'watchdog: blank bot pane -> reload', p.wdTries);
      reloadPane(p);
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
async function reloadPane(p) {
  const wc = p.view.webContents; if (wc.isDestroyed()) return;
  if (p.sleeping) { p.sleeping = false; p.sleepSnap = null; p.lastInteract = Date.now(); relayout(); sendState(); }   // wake from sleep
  p.lastReload = Date.now();
  p.grokPending = null; p.grokSkipOnce = false; p.hardTries = 0; p.wdTries = 0; p.wdAt = 0;       // forget every 'gave up' / retry counter
  const qi = loadQ.indexOf(p); if (qi >= 0) loadQ.splice(qi, 1);                                // not waiting in the startup queue any more
  p.loadStartedAt = 0; p.loadDone = true;
  const cu = wc.getURL(), m = cu.match(GROK_BOT_RE);
  const remembered = p.botTarget || (GROK_BOT_RE.test(p.url || '') ? p.url : null);
  const target = m ? cu : (remembered && (!cu || /^(?:about:blank|chrome-error:|https:\/\/grok\.com\/)/.test(cu)) ? remembered : null);   // a pane that gave up sits on grok.com home: use its remembered bot link
  const id = target && target.match(GROK_BOT_RE)?.[1];
  if (!id || !settings.grokFix) {
    p.grokToken = null;
    if (isBlankUrl(cu) && !isBlankUrl(p.url) && p.url !== NEWTAB) wc.loadURL(p.url).catch(() => {}); else wc.reload();   // blank pane: reload its own URL, not about:blank
    return;
  }
  if (isBlankUrl(cu)) { p.grokToken = null; p.loadedAt = Date.now(); dlog(`pane${p.id}`, 'reload from blank: hard load', target); wc.loadURL(target).catch(() => {}); return; }   // nothing to hop from (woken / blank pane)
  const token = p.grokToken = Symbol();      // cancels a running grokFix
  p.loadedAt = Date.now();
  if (wc.isLoading()) { try { wc.stop(); } catch {} }      // restart a load that is stuck half way
  try { applyThrottling(); } catch {}                      // grokToken is set -> CPU throttle off while we reload
  dlog(`pane${p.id}`, 'reload fast path', target);
  const t0 = Date.now();
  while (!wc.isDestroyed() && p.grokToken === token && Date.now() - t0 < 1000) {
    const rr = await wc.executeJavaScript(`(() => { const r = window.next && window.next.router;
      if (r && typeof r.push === 'function') { r.push('/'); setTimeout(() => r.push(${JSON.stringify('/bot/' + id)}), 250); return 'ok'; } return 'no'; })()`).catch(() => 'no');
    if (rr === 'ok') {
      dlog(`pane${p.id}`, 'reload router push at', Date.now() - t0, 'ms');
      for (let j = 0; j < 20 && !wc.isDestroyed() && p.grokToken === token; j++) {
        await sleep(200);
        if (await grokProbe(wc, id) === 'rendered') { dlog(`pane${p.id}`, 'reload ok (router)'); p.grokToken = null; p.loadedAt = Date.now(); return; }
      }
      if (wc.isDestroyed() || p.grokToken !== token) return;
      p.grokToken = null; grokFix(p, target, id, false); return;     // router hop did not land: normal verified retries
    }
    await sleep(100);
  }
  if (wc.isDestroyed() || p.grokToken !== token) return;
  p.grokToken = null;
  dlog(`pane${p.id}`, 'reload: router not ready, hard load', target);
  wc.loadURL(target).catch(() => {});        // did-finish-load -> onGrokLoad -> grokFix
}

// ---- sleep for 🟢 waiting panes (frees the page's memory; header / tab / green status / counts stay) ----
// A pane sleeps when its last output is the 🟢 marker and nobody touched it for N minutes. It never sleeps while 🔴 working, unmarked, focused,
// maximized, in the cloud-PC view, being edited or loading. Waking (click / focus / reload) goes through reloadPane with the stored bot URL.
const sleepMs = () => (Number(process.env.MPB_SLEEP_SEC) > 0 ? Number(process.env.MPB_SLEEP_SEC) * 1000 : (settings.sleepMinutes > 0 ? settings.sleepMinutes : 10) * 60000);
function canSleep(p, i, force) {
  const wc = p.view.webContents; if (wc.isDestroyed() || p.sleeping) return false;
  if (!force && (settings.sleepWaiting === false || p.sleepOn === false)) return false;
  if (!p.waiting || p.working || !isBotUrl(wc.getURL()) || i === focused || maximizedId === p.id || p.pcMax || p.editing) return false;
  if (wc.isLoading() || p.grokToken || p.grokPending) return false;
  if (!force && Date.now() - Math.max(p.lastInteract || 0, p.waitSince || 0, p.lastTyping || 0, p.loadedAt || 0) < sleepMs()) return false;
  return true;
}
function sleepPane(p) {
  const wc = p.view.webContents; if (wc.isDestroyed() || p.sleeping) return;
  p.sleepSnap = { title: displayTitle(p), favicon: p.favicon || '' };
  p.sleeping = true; p.sleepAt = Date.now(); p.grokToken = null; p.grokPending = null;
  dlog(`pane${p.id}`, 'sleep', paneUrl(p));
  p.view.setVisible(false);
  wc.loadURL('about:blank').catch(() => {});                 // drops the page (its URL stays in p.url / p.botTarget)
  applyThrottling(); sendState(); save();
}
function sleepTick() { panes.forEach((p, i) => { if (canSleep(p, i)) sleepPane(p); }); }

// ---- panes ----
// Startup / workspace loads are staggered: focused pane first, then the rest with at most LOAD_CONC loading at a time
// (8 heavy grok.com pages at once starve each other, the router hop is missed and panes stay blank).
const loadQ = []; let loadTimer = null;
const LOAD_CONC = Number(process.env.MPB_LOAD_CONC) || 3;
function pumpLoads() {
  const step = () => {
    const now = Date.now();
    for (const p of panes) if (p.loadStartedAt && !p.loadDone) {
      const wc = p.view.webContents;
      if (wc.isDestroyed() || (!wc.isLoading() && !p.grokToken && !p.grokPending && now - p.loadStartedAt > 1500) || now - p.loadStartedAt > 25000) p.loadDone = true;
    }
    let act = panes.filter(p => p.loadStartedAt && !p.loadDone).length;
    while (act < LOAD_CONC && loadQ.length) {
      loadQ.sort((a, b) => (panes[focused] === b ? 1 : 0) - (panes[focused] === a ? 1 : 0));
      const p = loadQ.shift();
      if (!panes.includes(p) || p.view.webContents.isDestroyed()) continue;
      p.loadStartedAt = now; dlog(`pane${p.id}`, 'start load', act + 1); loadInto(p.view.webContents, p.url); act++;
    }
    if (!loadQ.length && !panes.some(p => p.loadStartedAt && !p.loadDone)) { clearInterval(loadTimer); loadTimer = null; }
  };
  if (!loadTimer) loadTimer = setInterval(step, 300);
  step();
}
// New pane: while the rows are still the default grid it behaves as before (appended, grid re-fits); once the user has closed panes
// (rows differ from the default) the new pane goes to the first row that has room (typically the row it was closed from), or opens a new row.
function insertPane(p) {
  const n = panes.length, lens = getRows(), pr = PRESETS[layout] || [2, 2];
  if (n === 0 || sameArr(lens, defRows(n))) { panes.push(p); rowLens = null; return; }
  let r = lens.findIndex(k => k < pr[0]);
  if (r < 0 && lens.length < pr[1]) { lens.push(0); r = lens.length - 1; }
  if (r < 0) { panes.push(p); rowLens = null; return; }
  const idx = sumArr(lens.slice(0, r + 1));
  panes.splice(idx, 0, p); lens[r]++;
  if (idx <= focused) focused++;
}
function addPane(spec = {}, { focus = true, defer = false } = {}) {
  if (panes.length >= MAX) return null;
  const view = new WebContentsView({ webPreferences: {
    preload: process.env.MPB_NO_PRELOAD ? undefined : path.join(__dirname, 'pane-preload.js'),
    contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true, spellcheck: false } });
  view.setBorderRadius?.(RADIUS);
  view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff');
  const p = { id: nextPaneId++, view, url: normalize(spec.url), unread: 0, glow: false, msgMode: false, loadedAt: Date.now(),
    reloadMinutes: RELOAD_CHOICES.includes(spec.reloadMinutes) ? spec.reloadMinutes : 0,
    name: typeof spec.name === 'string' ? spec.name.slice(0, 60) : '', color: COLORS[spec.color] !== undefined ? spec.color : 'none',
    muted: !!spec.muted, zoomIndiv: spec.zoomIndiv === undefined ? clampZ(spec.zoom) !== 1 : !!spec.zoomIndiv,   // older saves had per-pane zoom only: keep those panes individual
    zoom: 1,
    lastReload: Date.now(), lastTyping: 0, lastInteract: Date.now(), waitSince: 0, sleepOn: spec.sleep !== false, sleeping: false, editing: false, cpuRate: 1 };
  p.zoom = p.zoomIndiv ? clampZ(spec.zoom) : gZoom();
  win.contentView.addChildView(view);
  if (overlayOpen) bringOverlayToFront();
  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => { wc.loadURL(url); return { action: 'deny' }; });
  const upd = () => { sendState(); save(); };
  ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading'].forEach(e => wc.on(e, upd));
  wc.on('did-start-loading', () => { p.loadedAt = Date.now(); });
  const rememberUrl = () => { const u = wc.getURL(); if (/^https?:/.test(u)) { p.url = u; if (GROK_BOT_RE.test(u)) p.botTarget = u; } };
  wc.on('did-navigate', rememberUrl); wc.on('did-navigate-in-page', rememberUrl);
  wc.on('did-navigate', () => { if (p.sleeping) return; p.msgMode = false; p.lastUserCount = null; p.unread = 0; p.glow = false; p.working = false; p.waiting = false; p.favicon = ''; if (p.pcMax) setPcMax(p, false); });
  wc.on('did-navigate-in-page', () => { if (p.sleeping) return; p.lastUserCount = null; if (!isBotUrl(wc.getURL())) resetCounts(p); });
  wc.on('did-stop-loading', () => { p.loadedAt = Date.now(); });
  wc.on('page-title-updated', () => { if (p.sleeping) return; sendState(); markActivity(p, 'title'); });
  wc.on('page-favicon-updated', (e, icons) => { p.favicon = (icons || []).find(u => /^https?:|^data:/.test(u)) || ''; sendState(); });
  wc.on('dom-ready', () => { normalizeHostZoom(wc); applyZoom(p, p.zoom); });
  wc.on('console-message', e => {
    if (!debugOn()) return;
    if (e.level === 'error' || e.level === 'warning') dlog(`pane${p.id}`, 'console', e.level, e.message, '@', e.sourceId + ':' + e.lineNumber);
  });
  wc.on('did-fail-load', (e, code, desc, url, isMain) => dlog(`pane${p.id}`, 'did-fail-load', code, desc, url, isMain ? 'main' : 'sub'));
  wc.on('render-process-gone', (e, d) => dlog(`pane${p.id}`, 'render-process-gone', JSON.stringify(d)));
  wc.on('unresponsive', () => dlog(`pane${p.id}`, 'unresponsive'));
  wc.on('did-finish-load', () => {
    onGrokLoad(p);
    dlog(`pane${p.id}`, 'loaded', wc.getURL());
  });
  wc.on('focus', () => setFocused(panes.indexOf(p)));
  wc.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && !input.meta && !input.control) clearUnread(p); if (handleKey(input, p)) e.preventDefault(); });
  wc.on('context-menu', (e, params) => {
    const items = [];
    if (params.linkURL) items.push({ label: 'リンクを新しいペインで開く', enabled: panes.length < MAX, click: () => addPane({ url: params.linkURL }) },
      { label: 'リンクをコピー', click: () => clipboard.writeText(params.linkURL) }, { label: 'ブラウザで開く', click: () => shell.openExternal(params.linkURL) }, { type: 'separator' });
    if (params.selectionText) items.push({ role: 'copy', label: 'コピー' });
    if (params.isEditable) items.push({ role: 'cut', label: '切り取り' }, { role: 'paste', label: '貼り付け' });
    if (isBotUrl(wc.getURL())) items.push({ type: 'separator' }, pcItem(p));
    items.push({ type: 'separator' }, { label: '戻る', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: '再読み込み', click: () => reloadPane(p) }, { label: '検証', click: () => wc.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  insertPane(p);
  if (defer && p.url && p.url !== NEWTAB) loadQ.push(p); else loadInto(wc, p.url);
  if (focus) setFocused(panes.indexOf(p));
  relayout();
  return p;
}
function closePane(id, keepEmpty) {
  const i = panes.findIndex(p => p.id === id); if (i < 0) return;
  { const lens = getRows(); let r = 0, st = 0; while (r < lens.length - 1 && i >= st + lens[r]) { st += lens[r]; r++; }
    lens[r]--; if (lens[r] <= 0) lens.splice(r, 1); }          // only this pane's row shrinks; an empty row disappears
  const [p] = panes.splice(i, 1);
  p.grokToken = null;
  win.contentView.removeChildView(p.view);
  p.view.webContents.close();
  if (maximizedId === id) maximizedId = null;
  focused = Math.max(0, Math.min(focused, panes.length - 1));
  if (!panes.length && !keepEmpty) addPane({ url: '' });
  else { updateBadge(); applyThrottling(); relayout(true); save(); }
}
function newPane(url = '') {
  if (panes.length >= MAX) { const p = panes[focused]; if (p) loadInto(p.view.webContents, url); return; }
  maximizedId = null;
  const p = addPane({ url });
  relayout(true);
  if (p) setTimeout(() => !p.view.webContents.isDestroyed() && p.view.webContents.focus(), 50);
}
const byId = id => panes.find(p => p.id === id);
const byWc = wc => panes.find(p => p.view.webContents === wc);
// Zoom: every pane either follows the GLOBAL zoom (settings.globalZoom) or is "individual" (own p.zoom, ignores global changes).
// Chromium keeps ONE zoom level per site (host zoom map), so wc.setZoomFactor on one grok.com pane zoomed every grok.com pane.
// Zoom is therefore applied per page from the pane preload (webFrame.setZoomFactor); the shared site level is kept at 100%.
function applyZoom(p, z) { p.zoom = clampZ(z); const wc = p.view.webContents; if (!wc.isDestroyed()) wc.send('mpb:zoom', p.zoom); }
function normalizeHostZoom(wc) { try { if (wc.getZoomLevel() !== 0) { wc.setZoomLevel(0); setTimeout(() => panes.forEach(q => applyZoom(q, q.zoom)), 150); } } catch {} }
function applyGlobalZoom() { panes.forEach(p => { if (!p.zoomIndiv) applyZoom(p, gZoom()); }); sendState(); }
function setZoom(p, z) {            // pane zoom: changing it makes the pane individual
  if (!p) return;
  p.zoomIndiv = true; applyZoom(p, z);
  sendState(); save();
}
function resetPaneZoom(p) { if (p && p.zoomIndiv) setZoom(p, 1); }
function setZoomIndiv(p, on) { if (!p) return; p.zoomIndiv = !!on; if (!on) applyZoom(p, gZoom()); sendState(); save(); }

function focusUrlBar() { win.webContents.focus(); win.webContents.send('focus-url', panes[focused]?.id); }
function handleKey(input, pane) {
  if (input.type !== 'keyDown') return false;
  const k = input.key.toLowerCase();
  const mod = isMac ? input.meta : input.control;
  if (k === 'escape' && !mod && !input.alt && !input.shift) {
    if (overlayOpen) { closeOverlay(); return true; }
    if (pane?.pcMax) return false;                         // Esc closes the page's computer view first (the pane then returns to normal)
    if (maximizedId != null) { toggleMaximize(maximizedId); return true; }
    return false;
  }
  if (!mod) return false;
  if (input.alt && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) { moveFocus(k.slice(5)); return true; }
  if (input.alt && !input.shift && ['Equal', 'Minus', 'Digit0'].includes(input.code)) { setGlobalZoom(input.code === 'Digit0' ? 1 : gZoom() + (input.code === 'Equal' ? 0.1 : -0.1)); return true; }   // ⌘⌥= / ⌘⌥- / ⌘⌥0: global zoom
  if (input.alt) return false;
  const fp = panes[focused];
  if (k === 'b' && input.shift) { openOverlay('broadcast'); return true; }
  if (k === 'p' && input.shift) { togglePc(); return true; }
  if (k === 'k') { overlayOpen ? closeOverlay() : openOverlay('palette'); return true; }
  if (k === 't') { closeOverlay(); newPane(''); return true; }
  if (k === 'w' && !input.shift) { if (fp) closePane(fp.id); return true; }
  if (k === 'l') { closeOverlay(); focusUrlBar(); return true; }
  if (k === 'j') { nextUnread(); return true; }
  if (!input.shift && (k === '\\' || k === '¥' || input.code === 'Backslash' || input.code === 'IntlYen')) { toggleMaximize(); return true; }
  if (k === 'r' && input.shift) { reloadAll(); return true; }
  if (k === 'r' && !input.shift) { if (fp) reloadPane(fp); return true; }
  if (k === '[' ) { fp?.view.webContents.navigationHistory.goBack(); return true; }
  if (k === ']' ) { fp?.view.webContents.navigationHistory.goForward(); return true; }
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
  approvePane = { id: 'approve', view: approve, url: APPROVE_URL, botTarget: APPROVE_URL, loadedAt: Date.now(), lastReload: Date.now(), cpuRate: 1 };   // a pane-like record so the bot-page fixes (router hop, retries) work here too
  wc.setWindowOpenHandler(({ url }) => { if (/^https:\/\/grok\.com\//.test(url)) wc.loadURL(url).catch(() => {}); else if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
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
  try { if (!approve.webContents.isDestroyed()) approve.webContents.close(); } catch {}
  approve = null; approvePane = null;
}
function openApprove() {
  dlog('approve', 'open requested', approveOpen);
  if (approveOpen) { closeOverlay(); return; }
  if (overlayOpen) closeOverlay();
  clearTimeout(approveTimer); approveTimer = null;
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
  popOpen = false; clearTimeout(popTimer);
  overlayOpen = true;
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
  overlayOpen = false;
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
    { label: '入力待機中にスリープ（メモリ節約）', type: 'checkbox', checked: p.sleepOn !== false, click: m => { p.sleepOn = m.checked; if (!m.checked && p.sleeping) reloadPane(p); sendState(); save(); } },
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
    { label: 'ブラウザで開く', enabled: !!paneUrl(p), click: () => shell.openExternal(paneUrl(p)) },
    { label: '開発者ツール', click: () => p.view.webContents.openDevTools({ mode: 'detach' }) },
    { type: 'separator' },
    { label: 'ペインを閉じる', click: () => closePane(id) },
  ];
  Menu.buildFromTemplate(tpl).popup({ window: win });
}
function saveWorkspace(name) {
  name = String(name || '').trim().slice(0, 60); if (!name) return;
  const key = splitKey(), sp = settings.splits?.[key];
  workspaces[name] = { layout, panes: panes.map(paneSpec), rows: [...getRows()], savedAt: new Date().toISOString(),
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
  const ws = workspaces[name]; if (!ws) return;
  maximizedId = null;
  [...panes].forEach(p => closePane(p.id, true));
  if (PRESETS[ws.layout]) layout = ws.layout;
  if (ws.splitsKey && ws.splits && typeof ws.splits === 'object') { settings.splits = settings.splits || {}; settings.splits[ws.splitsKey] = JSON.parse(JSON.stringify(ws.splits)); }
  (ws.panes || []).slice(0, MAX).forEach(s => addPane(s, { focus: false, defer: true }));
  if (!panes.length) addPane({ url: '' });
  rowLens = Array.isArray(ws.rows) ? ws.rows.map(Number) : null;       // the saved row structure (validated on first use)
  activeWs = name;
  setFocused(0); pumpLoads(); relayout(); save();
}
function runAction(a) {
  if (!a || typeof a !== 'object') return;
  switch (a.type) {
    case 'focus': { const i = panes.findIndex(p => p.id === a.id); closeOverlay(); focusPane(i); break; }
    case 'layout': closeOverlay(); applyPreset(a.layout); break;
    case 'open-new': closeOverlay(); newPane(String(a.url || '')); break;
    case 'open-here': { closeOverlay(); const p = panes[focused]; if (p) loadInto(p.view.webContents, String(a.url || '')); break; }
    case 'next-unread': closeOverlay(); nextUnread(); break;
    case 'maximize': closeOverlay(); toggleMaximize(); break;
    case 'clear-unread': closeOverlay(); clearAll(); break;
    case 'reload-all': closeOverlay(); reloadAll(); break;
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
    case 'broadcast-prompt': openOverlay('broadcast'); break;
    case 'broadcast': { closeOverlay(); const text = String(a.text || '').slice(0, 20000); const ids = Array.isArray(a.ids) ? a.ids.map(Number) : []; if (text.trim() && ids.length) broadcastSend(text, ids); break; }
    case 'toggle-notifications': settings.notifications = !settings.notifications; save(); buildMenu(); closeOverlay(); break;
    case 'close': closeOverlay(); break;
    case 'fav-open': closeOverlay(); openFavorite(a.id, a.where); break;
    case 'fav-add': closeOverlay(); addFavorite(String(a.url || ''), String(a.label || '')); break;
    case 'fav-add-current': { closeOverlay(); const p = panes[focused]; if (p && paneUrl(p)) addFavorite(paneUrl(p), p.name || displayTitle(p)); break; }
    case 'fav-rename': { const f = favorites.find(x => x.id === a.id); if (f) { f.label = String(a.value || '').slice(0, 60); favChanged(); } closeOverlay(); break; }
    case 'new-window': closeOverlay(); makeWindow({ layout: '2x2', panes: [{ url: String(a.url || '') }] }); break;
  }
}
function clearAll() { panes.forEach(p => { p.glow = false; if (!p.msgMode) p.unread = 0; }); updateBadge(); sendState(); }

// ---- IPC from app UI (renderer + overlay; both local files) ----
async function injectSend(p, text) {
  const wc = p.view.webContents;
  const T = JSON.stringify(text);
  const r1 = await wc.executeJavaScript(`(()=>{const c=[...document.querySelectorAll('form textarea, textarea, .ProseMirror[contenteditable="true"], [contenteditable="true"]')].filter(e=>e.offsetParent!==null&&!e.closest('[aria-hidden="true"]'));const el=c[c.length-1];if(!el)return 'nocomposer';el.focus();
    if(el.tagName==='TEXTAREA'){const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(el,${T});el.dispatchEvent(new Event('input',{bubbles:true}));}
    else{const sel=getSelection();sel.selectAllChildren(el);document.execCommand('insertText',false,${T});}
    return el.tagName;})()`);
  if (r1 === 'nocomposer') return r1;
  await sleep(400);
  const r2 = await wc.executeJavaScript(`(()=>{const c=[...document.querySelectorAll('form textarea, textarea, [contenteditable="true"]')].filter(e=>e.offsetParent!==null);const el=c[c.length-1];const root=(el&&el.closest('form'))||document;
    const b=[...root.querySelectorAll('button[type="submit"], button[aria-label]')].filter(b=>!b.disabled&&b.offsetParent!==null&&(b.type==='submit'||/送信|submit|send/i.test(b.getAttribute('aria-label')||'')));
    if(b.length){b[b.length-1].click();return 'clicked';}return 'nobutton';})()`);
  if (r2 === 'nobutton') { wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); wc.sendInputEvent({ type: 'char', keyCode: '\r' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' }); return 'enter'; }
  return r2;
}
async function broadcastSend(text, ids) {
  for (const id of ids) {
    const p = byId(id); if (!p) continue;
    try { const r = await injectSend(p, text); dlog(`pane${p.id}`, 'broadcast', r); } catch (e) { dlog(`pane${p.id}`, 'broadcast err', String(e)); }
  }
}
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
// Reload-all: every pane starts at the same moment (no queue, no stagger, no debounce, no focus requirement).
// Panes are already warm (cookies / cache), so 8 in parallel is fine; reloadPane clears all retry state and the CPU throttle
// stays off while reloading (applyThrottling re-enables it once a pane has been settled for 3 s).
function reloadAll() {
  loadQ.length = 0;
  for (const p of [...panes]) {
    if (p.view.webContents.isDestroyed()) continue;
    reloadPane(p).catch(e => dlog(`pane${p.id}`, 'reload-all err', String(e)));
  }
  dlog('reload-all started', panes.length);
  setTimeout(() => { try { applyThrottling(); } catch {} }, 3200);
  fetchUsage();
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
    { label: '再読み込み', click: () => reloadPane(p) },
    { label: '入力待機中にスリープ', type: 'checkbox', checked: p.sleepOn !== false, click: m => { p.sleepOn = m.checked; if (!m.checked && p.sleeping) reloadPane(p); sendState(); save(); } },
    { label: '今すぐスリープ（入力待機中のみ）', enabled: canSleep(p, panes.indexOf(p), true), click: () => sleepPane(p) },
    { label: '新しいペインに複製', enabled: panes.length < MAX, click: () => { addPane({ ...paneSpec(p), name: p.name ? p.name + '2' : '' }); relayout(true); } },
    { label: 'お気に入りに追加', enabled: !!paneUrl(p), click: () => addFavorite(paneUrl(p), p.name || displayTitle(p)) },
    { label: maximizedId === id ? '元のサイズに戻す' : '最大化', click: () => toggleMaximize(id) },
    pcItem(p),
    { type: 'separator' },
    { label: '閉じる（新しいタブに戻す）', click: () => { p.name = ''; loadInto(p.view.webContents, ''); sendState(); save(); } },
    { label: 'ペインごと閉じる', click: () => closePane(id) },
    { label: '他のペインをすべて閉じる', enabled: panes.length > 1, click: () => { panes.filter(q => q.id !== id).map(q => q.id).forEach(x => closePane(x, true)); setFocused(0); relayout(true); save(); } },
  ]).popup({ window: win });
}
const ui = {}, paneIpc = {};
const on = (ch, fn) => { ui[ch] = fn; registerUi(ch); };
const paneOn = (ch, fn) => { paneIpc[ch] = fn; registerPane(ch); };
on('navigate', (id, url) => { const p = byId(id); if (p) loadInto(p.view.webContents, url); });
on('back', id => byId(id)?.view.webContents.navigationHistory.goBack());
on('forward', id => byId(id)?.view.webContents.navigationHistory.goForward());
on('copy-pane-url', id => { const p = byId(id); if (p) { const u = paneUrl(p) || p.url; if (u) clipboard.writeText(String(u)); } });
on('reload', id => { const p = byId(id); if (p) reloadPane(p); });
on('close', id => closePane(id));
on('add', () => newPane(''));
on('layout', l => applyPreset(l));
on('focus-pane', id => { const i = panes.findIndex(p => p.id === id); setFocused(i); clearUnread(panes[i]); });
on('activate-pane', id => focusPane(panes.findIndex(p => p.id === id)));
on('set-reload', (id, m) => { const p = byId(id); if (p && RELOAD_CHOICES.includes(m)) { p.reloadMinutes = m; p.lastReload = Date.now(); sendState(); save(); } });
on('swap', (a, b) => swapPanes(a, b));
on('maximize', id => toggleMaximize(id));
on('sleep-toggle', id => { const p = byId(id); if (!p) return; p.sleepOn = p.sleepOn === false; if (p.sleepOn === false && p.sleeping) reloadPane(p); sendState(); save(); });
on('wake-pane', id => { const p = byId(id); if (p?.sleeping) { reloadPane(p); setFocused(panes.indexOf(p)); } });
on('sleep-now', id => { const p = byId(id); if (p && canSleep(p, panes.indexOf(p), true)) sleepPane(p); });
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
on('ready', () => { sendState(); sendMem(); });
on('fav-open', (id, where) => openFavorite(id, where));
on('fav-menu', id => favMenu(id));
on('fav-move', (a, b) => moveFavorite(a, b));
on('fav-add', (url, label) => addFavorite(String(url || ''), String(label || '')));
on('rename-pane', id => { const p = byId(id); if (p) openOverlay('rename', { id, value: p.name || chipDefault(p) }); });
// from web content (pane-preload): only trusted when the sender is one of our panes
paneOn('pane:msgcount', (e, c) => {
  const p = byWc(e.sender);
  if (p && c && [c.user, c.bot, c.botSince].every(n => Number.isInteger(n) && n >= 0 && n < 100000)) onMsgCount(p, { user: c.user, bot: c.bot, botSince: c.botSince, waiting: c.waiting === true, working: c.working === true, asks: c.asks === true, method: String(c.method).slice(0, 40) });
});
paneOn('pane:pc-closed', e => { const p = byWc(e.sender); if (p?.pcMax) setPcMax(p, false); });
paneOn('pane:msgmode-off', e => { const p = byWc(e.sender); if (p) resetCounts(p); });
paneOn('pane:mutation', e => { const p = byWc(e.sender); if (p) markActivity(p, 'dom'); });
paneOn('pane:interact', e => { const p = byWc(e.sender); if (p) { p.lastInteract = Date.now(); clearUnread(p); const i = panes.indexOf(p); if (i !== focused) setFocused(i); } });
paneOn('pane:mouseup', e => { if (byWc(e.sender)) splitEnd(); });
paneOn('pane:typing', e => { const p = byWc(e.sender); if (p) { p.lastTyping = Date.now(); p.lastInteract = Date.now(); } });
paneOn('pane:editing', (e, v) => { const p = byWc(e.sender); if (p) p.editing = !!v; });
// ---- favorites (global list, opened in this window) ----
function openFavorite(id, where = 'here') {
  const f = favorites.find(x => x.id === id); if (!f) return;
  if (where === 'window') { makeWindow({ layout: '2x2', panes: [{ url: f.url, name: f.label }] }); return; }
  if (where === 'new' || !panes[focused]) { newPane(f.url); const p = panes[panes.length - 1]; if (p && !p.name && f.label) { p.name = f.label; sendState(); } return; }
  const p = panes[focused];
  if (f.label && (!p.name || p.favId)) p.name = f.label;
  p.favId = f.id;
  loadInto(p.view.webContents, f.url);
  focusPane(focused, { clear: false });
}
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
function chipDefault(p) { return displayTitle(p); }

// ---- per-window snapshot / lifecycle ----
let snapCache = null;
function snapshot() {
  if (!win || win.isDestroyed()) return snapCache || { layout, focused, panes: [], window: { bounds: lastBounds } };
  let bounds = lastBounds;
  try { if (!win.isDestroyed() && !win.isMaximized() && !win.isFullScreen()) bounds = win.getNormalBounds(); } catch {}
  lastBounds = bounds;
  return (snapCache = { layout, focused, panes: panes.map(paneSpec), rows: [...getRows()], window: { bounds, maximized: win.isMaximized() } });
}


const ctx = { snapshot, ui, paneIpc, get win() { return win; }, get overlay() { return overlay; }, get panes() { return panes; },
  reloadAll, sendState, newPane, closePane, toggleMaximize, togglePc, relayout, setZoom, resetPaneZoom, setZoomIndiv, applyGlobalZoom, nextUnread, moveFocus, focusUrlBar, openOverlay, paneMenu, applyPreset,
  sleepTick, loadWorkspace, overwriteWorkspace, clearAll, applyThrottling, get layout() { return layout; }, get focusedPane() { return panes[focused]; },
  get activeWs() { return workspaces[activeWs] ? activeWs : null; }, wsRenamed(o, n) { if (activeWs === o) activeWs = n; },
  focusPaneById(id) { const i = panes.findIndex(p => p.id === id); if (i >= 0) focusPane(i); },
  othersInfo(n) {
    return { wid: win.id, n, panes: panes.filter(p => p.waiting || p.working || p.glow || p.unread).map(p => ({ id: p.id, name: (p.name || displayTitle(p) || '').slice(0, 40),
      waiting: !!p.waiting, working: !!p.working, glow: !!p.glow, unread: p.unread || 0, color: COLORS[p.color] || '' })) };
  } };

const bounds = process.env.MPB_SCREENSHOT ? { x: 0, y: 0, width: 1600, height: 1000 }
  : restore ? restoreBounds(spec.window) : { width: 1400, height: 900 };
win = new BrowserWindow({ ...bounds, minWidth: 600, minHeight: 400, title: 'MultiPane Browser', show: false,
  backgroundColor: isMac ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ececec'),
  ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 }, vibrancy: 'under-window', visualEffectState: 'followWindow' } : {}),
  webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
ctxs.push(ctx);
if (restore && spec.window?.maximized && !process.env.MPB_SCREENSHOT) win.maximize();
win.loadFile(path.join(__dirname, 'index.html'));
win.once('ready-to-show', () => win.show());
win.webContents.on('before-input-event', (e, input) => { if (handleKey(input)) e.preventDefault(); });
win.on('resize', () => relayout());
win.on('moved', save); win.on('resized', save);
win.on('focus', () => { setFocused(focused); buildMenu(); });
win.on('close', () => {
  snapshot();
  try { approveOpen = false; destroyApprove(); } catch {}
  if (quitting) return;
  if (ctxs.length === 1) { if (!quitting) saveNow(); return; }            // last window: remember it
  const i = ctxs.indexOf(ctx); if (i >= 0) ctxs.splice(i, 1);  // other windows are forgotten when closed
  panes.forEach(p => { p.grokToken = null; });
  saveNow(); updateDockBadge(); broadcast();
});

overlay = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
overlay.setBackgroundColor('#00000000');
overlay.setVisible(false);
win.contentView.addChildView(overlay);
overlay.webContents.loadFile(path.join(__dirname, 'overlay.html'));
overlay.webContents.on('before-input-event', (e, input) => { if (handleKey(input)) e.preventDefault(); });

const specs = Array.isArray(spec.panes) && spec.panes.length ? spec.panes : [{ url: '' }];
specs.slice(0, MAX).forEach(s => addPane(s, { focus: false, defer: true }));
rowLens = Array.isArray(spec.rows) ? spec.rows.map(Number) : null;      // saved rows (validated; default grid when absent)
setFocused(Math.min(spec.focused || 0, panes.length - 1));
pumpLoads();
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
      { label: '新しいウィンドウ', accelerator: 'CmdOrCtrl+N', click: () => makeWindow({ layout: '2x2', panes: [{ url: '' }] }) },
      acc('CmdOrCtrl+W', () => { const k = cur(); k?.focusedPane && k.closePane(k.focusedPane.id); }, 'ペインを閉じる'),
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
      acc('CmdOrCtrl+R', () => { const fp = cur()?.focusedPane; if (fp) reloadPane(fp); }, 'ペインを再読み込み'),
      acc('CmdOrCtrl+Shift+R', () => cur()?.reloadAll(), '全ペインを再読み込み（一括更新）'),
      acc('CmdOrCtrl+\\', () => cur()?.toggleMaximize(), 'ペインを最大化 / 元に戻す'),
      acc('CmdOrCtrl+Shift+P', () => cur()?.togglePc(), 'クラウドPC（Botのコンピュータ画面）を最大化 / 元に戻す'),
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
      acc('CmdOrCtrl+Alt+Left', () => cur()?.moveFocus('left'), '左のペインへ'),
      acc('CmdOrCtrl+Alt+Right', () => cur()?.moveFocus('right'), '右のペインへ'),
      acc('CmdOrCtrl+Alt+Up', () => cur()?.moveFocus('up'), '上のペインへ'),
      acc('CmdOrCtrl+Alt+Down', () => cur()?.moveFocus('down'), '下のペインへ'),
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
      { label: '入力待機中（🟢）のペインを自動スリープ（メモリ節約）', type: 'checkbox', checked: settings.sleepWaiting !== false, click: m => { settings.sleepWaiting = m.checked; save(); buildMenu(); } },
      { label: '省電力（非フォーカスペインのCPUを制限）', type: 'checkbox', checked: settings.ecoMode, click: m => { settings.ecoMode = m.checked; ctxs.forEach(k => k.applyThrottling()); save(); } },
      { label: 'デバッグログ（userData/pane-debug.log）', type: 'checkbox', checked: settings.debugLog, click: m => { settings.debugLog = m.checked; save(); } },
      { label: 'grok.com/bot を開き直す補正（直接読み込みで真っ黒になる対策）', type: 'checkbox', checked: settings.grokFix, click: m => { settings.grokFix = m.checked; save(); } },
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

function startup() {
  const st = load();
  if (st?.settings) settings = { ...settings, ...st.settings };
  if (!settings.notifV2) { settings.notifications = true; settings.notifV2 = true; }
  if (!settings.splits || typeof settings.splits !== 'object') settings.splits = {};
  if (st?.workspaces && typeof st.workspaces === 'object') workspaces = st.workspaces;
  if (Array.isArray(st?.favorites)) favorites = st.favorites.filter(f => f && typeof f.url === 'string').slice(0, 100)
    .map(f => ({ id: nextFavId++, url: f.url, label: String(f.label || '').slice(0, 60) || defaultFavLabel(f.url) }));
  let wins;
  if (Array.isArray(st?.windows) && st.windows.length) wins = st.windows;
  else {                                                   // old single-window format
    let specs;
    if (Array.isArray(st?.panes) && st.panes.length) specs = st.panes;
    else if (Array.isArray(st?.urls) && st.urls.length) specs = st.urls.map(url => ({ url }));
    else specs = Array(4).fill(0).map(() => ({ url: '' }));
    wins = [{ layout: st?.layout, focused: st?.focused, panes: specs, window: st?.window }];
  }
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
  buildMenu();

  if (process.env.MPB_AUTO_PC) setTimeout(() => { const c = ctxs[0], p = c.panes[Number(process.env.MPB_AUTO_PC)]; dlog('auto-pc', p ? p.id : 'none', p ? p.view.webContents.getURL() : ''); if (p) c.togglePc(p.id); }, Number(process.env.MPB_AUTO_PC_DELAY || 40000));   // dev only: exercise the cloud-PC maximise
  if (process.env.MPB_SCREENSHOT) setTimeout(async () => {
    const c = ctxs[0];
    if (process.env.MPB_PALETTE) { c.openOverlay('palette'); await sleep(1200); }
    if (process.env.MPB_SHOT_GLOW) { const p = c.panes[Number(process.env.MPB_SHOT_GLOW)]; if (p) { p.unread = 3; p.glow = true; c.sendState(); await sleep(400); } }
    if (process.env.MPB_SHOT_STATE) { for (const it of process.env.MPB_SHOT_STATE.split(',')) { const [i, st] = it.split(':'); const p = c.panes[Number(i)]; if (!p) continue; p.msgMode = true; p.unread = 2; p.waiting = st === 'wait'; p.working = st === 'work'; } c.sendState(); await sleep(500); }   // dev only: preview the green / red states
    const { execFileSync } = require('child_process');
    try { execFileSync('sh', ['-c', `ffmpeg -y -loglevel error -f x11grab -video_size 1600x1000 -i "$DISPLAY" -frames:v 1 "${process.env.MPB_SCREENSHOT}"`]); }
    catch { const img = await c.win.webContents.capturePage(); fs.writeFileSync(process.env.MPB_SCREENSHOT, img.toPNG()); }
    app.quit();
  }, Number(process.env.MPB_SCREENSHOT_DELAY || 20000));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
app.userAgentFallback = chromeUA();
app.whenReady().then(() => {
  const { session } = require('electron');
  session.defaultSession.setUserAgent(chromeUA());
  const allowed = new Set(['notifications', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'media', 'storage-access', 'top-level-storage-access', 'persistent-storage']);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => { dlog('permission', perm, allowed.has(perm) ? 'allow' : 'deny'); cb(allowed.has(perm)); });
  session.defaultSession.setPermissionCheckHandler((wc, perm) => allowed.has(perm));
  startup();
});
app.on('before-quit', () => { clearTimeout(saveTimer); if (!quitting) saveNow(); quitting = true; });
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
ipcMain.handle('aiusage:get', async (_, kind, force) => {
  if (!['codex', 'claude'].includes(kind)) return null;
  const r = await AIU.get(kind, !!force);
  dlog('aiusage', kind, (r.ok ? 'ok ' : 'err ') + (r.stale ? 'STALE ' : '') + (r.buckets || []).map(b => `${b.label}=${Math.round(b.used * 10) / 10}%`).join(' ') + (r.err ? ' | ' + r.err : ''));
  return r;
});
ipcMain.handle('claude:auth-dialog', async e => {
  const w = BrowserWindow.fromWebContents(e.sender) || undefined;
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
ipcMain.handle('usage:detail', () => usageDetail());
ipcMain.handle('usage:margin', (_, v) => { const n = Number(v); if (Number.isFinite(n) && n >= 0 && n <= 50) { settings.usageMargin = n; save(); } return usageDetail(); });
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
ipcMain.handle('usage:get', async (_, force) => (!force && usageCache?.ok && Date.now() - usageCache.at < 60000) ? usageCache : fetchUsage());

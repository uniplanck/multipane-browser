// IPC boundary (#71): every channel main.js listens on, which roles may send it and the payload it accepts.
// Pure (no electron) so plain Node tests cover it. main.js builds the sender ({ role, frame }) from its own registry of the pages it created
// (never from the payload) and the world (what exists right now in the sender's window); check() -> null (allowed) or a fixed reject code.
// Roles: chrome  = the window's own UI (index.html, preload.js)
//        overlay = palette / prompts / usage popover over the panes (overlay.html, preload.js)
//        pane    = a web pane (pane-preload: coarse page signals only; the local newtab page is a pane too)
//        probe   = the hidden background check of a sleeping pane (pane-preload; only its message count is used)
//        approve = the 承認Bot popup (no preload: may not send anything)
//        sidebar = the 進捗サイドバー page (sidebar-preload.js: focusBot / jump / state / settings), on the origin main created it for (sender.origin, from main's registry)
const path = require('path');
const { fileURLToPath } = require('url');
const { SNAP, DRAFT } = require('./pane-rules');
const AS = require('./approve-setting');
const TL = require('./tooltip-list');
const GS = require('./gbar-sections');
const SR = require('./sidebar-rules');

const ROLES = ['chrome', 'overlay', 'pane', 'probe', 'approve', 'sidebar'];
const MAX_PANES = 10;                     // = MAX in main.js
const URL_MAX = 65536;                    // address bar / palette input (main normalises it)
const TEXT_MAX = 10000;                   // names / labels / ids from the UI (main cuts names to 60)
const BROADCAST_MAX = 200000;             // broadcast text (main previews up to 20000 and refuses longer: broadcast-state.js TEXT_MAX)
const COUNT_MAX = 100000;                 // message counts from a scan (exclusive)
const GROK = 'https://grok.com';
const PRESETS = ['2x1', '3x1', '4x1', '2x2', '3x2', '4x2', '3x3', '5x2'];   // = PRESETS in main.js
const RELOAD_CHOICES = [0, 1, 5, 15, 30];                                  // = RELOAD_CHOICES in main.js
const DOCS = { chrome: path.join(__dirname, 'index.html'), overlay: path.join(__dirname, 'overlay.html') };   // the bundled page each UI role must show

// reject codes: fixed, short Japanese reason; never the payload, a URL or a name
const REJECT = {
  E_CHANNEL: '未定義のチャンネル',
  E_SENDER: '未登録の送信元',
  E_ROLE: 'この画面には許可していない操作',
  E_FRAME: '子フレーム・消えたフレームからの送信',
  E_PAGE: '同梱画面・許可したサイト以外からの送信',
  E_OWNER: '送信元のペイン・ウィンドウは閉じている',
  E_PAYLOAD: '引数の形式が不正',
  E_TARGET: '対象が無いか、別ウィンドウのもの',
};

const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const id = v => int(v, 1, Number.MAX_SAFE_INTEGER);                      // pane / favorite / window ids (main counts from 1)
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const str = (v, max) => typeof v === 'string' && v.length <= max;
const bool = v => typeof v === 'boolean';
const opt = (v, f) => v === undefined || v === null || f(v);
const obj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const text = v => str(v, TEXT_MAX);
const newName = v => text(v) && v.trim().slice(0, 60) !== '__proto__';  // a workspace name main stores as a key
const axis = v => v === 'c' || v === 'r';
const approveRect = r => obj(r) && Object.keys(r).length === 4 && ['x', 'y'].every(k => num(r[k], -1e5, 1e5))
  && ['width', 'height'].every(k => num(r[k], 0, 1e5));
const row = v => opt(v, x => int(x, 0, MAX_PANES));
const kind = v => v === 'codex' || v === 'claude' || v === 'kimi';           // a gauge whose numbers ai-usage.js reads (= usage-config WEB)
const gauge = v => kind(v) || v === 'grok' || v === 'antigravity';           // any gauge of the bar (= usage-config PROVIDERS)
const where = v => v === 'here' || v === 'new' || v === 'window';
const gid = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) && v !== '__proto__';   // a Bot / group of the Grok bar (its grok.com id)

// pane:msgcount (pane-preload scanMessages -> readConversation): three counts; flags / quote / heading / fingerprint / method when the scan has them;
// snap = the scan's snapshot (pane-rules SNAP): every item exactly one of its fixed codes + the bot id of the scanned path;
// gen / seq (#02) = the generation number main gave the page (0 = none yet) and the scan's sequence number (main's pane-state.js compares them)
const SNAP_KEYS = Object.keys(SNAP);
const snapShape = s => obj(s) && Object.keys(s).length === SNAP_KEYS.length + 1 && text(s.cid) && /^[A-Za-z0-9_-]*$/.test(s.cid)
  && SNAP_KEYS.every(k => typeof s[k] === 'string' && Object.hasOwn(SNAP[k], s[k]));
function countOk(c) {
  return obj(c) && ['user', 'bot', 'botSince'].every(k => int(c[k], 0, COUNT_MAX - 1))
    && ['waiting', 'working', 'done', 'asks'].every(k => opt(c[k], bool))
    && ['q', 'hn', 'hh', 'fp', 'method'].every(k => opt(c[k], text))
    && ['gen', 'seq'].every(k => opt(c[k], v => int(v, 0, Number.MAX_SAFE_INTEGER)))
    && opt(c.snap, snapShape);
}
// -> exactly the fields main uses, strings cut as before (quote 320, heading / header 80, fingerprint 24, method 40); no snapshot -> snap null (all unknown);
// no generation / sequence number -> 0 (main drops the report)
const cut = (s, n) => typeof s === 'string' ? s.slice(0, n) : '';
const msgCount = c => ({ user: c.user, bot: c.bot, botSince: c.botSince, waiting: c.waiting === true, working: c.working === true, done: c.done === true, asks: c.asks === true,
  q: cut(c.q, 320), hn: cut(c.hn, 80), hh: cut(c.hh, 80), fp: cut(c.fp, 24), method: cut(c.method, 40),
  gen: id(c.gen) ? c.gen : 0, seq: id(c.seq) ? c.seq : 0,
  snap: obj(c.snap) ? Object.fromEntries([['cid', c.snap.cid], ...SNAP_KEYS.map(k => [k, c.snap[k]])]) : null });

// overlay-run actions (overlay.js; the chrome bar only sends next-unread / queue-open). roles default: overlay only
const OVERLAY = ['overlay'], CHROME = ['chrome'], UI = ['chrome', 'overlay'], PANE = ['pane'];
const inPane = (x, w) => w.pane(x.id), inFav = (x, w) => w.fav(x.id), inWs = (x, w) => w.ws(x.name);
const ACTIONS = {
  'next-unread': { roles: UI },
  'gbar-sec-toggle': { roles: CHROME, shape: x => Object.keys(x).length === 2 && GS.nameOk(x.name) },
  // 対応キュー (#01): open the list (bar / palette); a choice = the pane id + the conversation it was listed for. No target check here on purpose:
  // a pane closed / moved meanwhile is refused by main itself (attention-queue.js stale), which then says why in the list
  'queue-open': { roles: UI },
  'queue-pick': { shape: x => id(x.id) && str(x.ref, URL_MAX) },
  focus: { shape: x => id(x.id), target: inPane },
  layout: { shape: x => PRESETS.includes(x.layout) },
  'open-new': { shape: x => str(x.url, URL_MAX) },
  'open-here': { shape: x => str(x.url, URL_MAX) },
  'new-window': { shape: x => str(x.url, URL_MAX) },
  maximize: {}, 'clear-unread': {}, 'reload-all': {}, 'reopen-closed': {}, 'rename-prompt': {}, 'ws-save-prompt': {}, 'approve-open': {},
  'broadcast-prompt': {}, 'toggle-notifications': {}, close: {}, 'fav-add-current': {}, 'recovery-fresh': {},
  'diag-open': {}, 'diag-copy': {},                         // 診断 screen; main builds the summary itself (nothing of it comes from the page)
  'diag-persist': { shape: x => bool(x.on) },
  'update-check': {}, 'update-start': {}, 'update-restart': {}, 'update-later': {},
  'update-choice': { shape: x => bool(x.on) }, 'update-toggle': { shape: x => bool(x.on) },
  'approve-save': { shape: x => Object.keys(x).length === 3 && AS.validUrl(x.url) && AS.validLabel(x.label) },
  'approve-pick': { shape: x => Object.keys(x).length === 2 && typeof x.id === 'string' && /^[A-Za-z0-9_-]+$/.test(x.id)
    && x.id !== '__proto__' && !!AS.normalizeUrl('https://grok.com/bot/' + x.id) },
  'approve-reset': { shape: x => Object.keys(x).length === 1 },
  'sidebar-save': { shape: x => Object.keys(x).every(k => k === 'type' || k === 'url' || k === 'confirm') && SR.validUrl(x.url) && (x.confirm === undefined || bool(x.confirm)) },   // 進捗サイドバーのURL ('' = none; main normalises it again) + 開く前に確認する
  rename: { shape: x => id(x.id) && text(x.value), target: inPane },
  'ws-save': { shape: x => newName(x.value) },
  'ws-overwrite': { shape: x => text(x.name) && opt(x.confirm, bool), target: inWs },
  'ws-load': { shape: x => text(x.name), target: inWs },
  'ws-delete': { shape: x => text(x.name), target: inWs },
  'ws-rename': { shape: x => text(x.name) && newName(x.value), target: inWs },
  'ws-rename-prompt': { shape: x => text(x.name), target: inWs },
  // 一斉送信 (#12): a preview of the chosen panes (main reads them; nothing is sent), then the preview / batch numbers main gave it
  'bc-preview': { shape: x => str(x.text, BROADCAST_MAX) && Array.isArray(x.ids) && x.ids.length >= 1 && x.ids.length <= MAX_PANES && x.ids.every(id) && new Set(x.ids).size === x.ids.length,
    target: (x, w) => x.ids.every(i => w.pane(i)) },
  'bc-send': { shape: x => id(x.pid) }, 'bc-cancel': { shape: x => id(x.bid) }, 'bc-reset': {},
  'fav-open': { shape: x => id(x.id) && where(x.where), target: inFav },
  'fav-add': { shape: x => str(x.url, URL_MAX) && opt(x.label, text) },
  'fav-rename': { shape: x => id(x.id) && text(x.value), target: inFav },
  'gbot-rename': { shape: x => gid(x.id) && text(x.value), target: (x, w) => w.gbot(x.id) },   // (Grok bar) '' = the page's own name again
  'recovery-restore': { shape: x => text(x.id) },
};
const action = a => obj(a[0]) && typeof a[0].type === 'string' && Object.hasOwn(ACTIONS, a[0].type) ? ACTIONS[a[0].type] : null;

// channel -> { roles, origin?: required page origin, shape?(args), target?(args, world), roleOf?(args): roles for this payload }
const P1 = { shape: a => id(a[0]), target: (a, w) => w.pane(a[0]) };   // first argument: a pane of the sender's window
const CHANNELS = {
  // ---- app UI (preload.js mpb.*; ipcRenderer.send) ----
  navigate: { roles: CHROME, shape: a => id(a[0]) && str(a[1], URL_MAX), target: P1.target },
  back: { roles: CHROME, ...P1 }, forward: { roles: CHROME, ...P1 }, 'copy-pane-url': { roles: CHROME, ...P1 },
  reload: { roles: CHROME, ...P1 }, close: { roles: CHROME, ...P1 }, 'focus-pane': { roles: CHROME, ...P1 }, 'activate-pane': { roles: CHROME, ...P1 },
  maximize: { roles: CHROME, ...P1 }, 'sleep-toggle': { roles: CHROME, ...P1 }, 'wake-pane': { roles: CHROME, ...P1 }, 'sleep-now': { roles: CHROME, ...P1 },
  'maximize-half': { roles: CHROME, shape: a => a.length === 2 && id(a[0]) && (a[1] === 'left' || a[1] === 'right'), target: P1.target },
  'load-cancel': { roles: CHROME, ...P1 },                    // 取消 on a pane waiting for a load slot (#31)
  'probe-resume': { roles: CHROME },                          // (#33) 確認を再開 after a sign-in page stopped the background checks (no payload)
  'pane-menu': { roles: CHROME, ...P1 }, 'chip-menu': { roles: CHROME, ...P1 }, 'rename-pane': { roles: CHROME, ...P1 },
  'set-reload': { roles: CHROME, shape: a => id(a[0]) && RELOAD_CHOICES.includes(a[1]), target: P1.target },
  swap: { roles: CHROME, shape: a => id(a[0]) && id(a[1]), target: (a, w) => w.pane(a[0]) && w.pane(a[1]) },
  // ドッキング (dock-layout.js): a header drag of a pane of this window, the number main gave it, the cursor in window coordinates (main decides
  // the zone and the drop from its own rows), its end. Nothing else: no ids / rows / rectangles from the page
  'dock-begin': { roles: CHROME, ...P1 },
  'dock-ready': { roles: CHROME, shape: a => id(a[0]) },
  'dock-hover': { roles: CHROME, shape: a => num(a[0], -1e5, 1e5) && num(a[1], -1e5, 1e5) },
  'dock-drop': { roles: CHROME, shape: a => num(a[0], -1e5, 1e5) && num(a[1], -1e5, 1e5) },
  'dock-end': { roles: CHROME },
  add: { roles: CHROME }, 'reopen-closed': { roles: CHROME }, 'reload-all': { roles: CHROME }, 'ws-menu': { roles: CHROME },
  'approve-open': { roles: CHROME, shape: a => a.length <= 1 && opt(a[0], approveRect) },
  'approve-keep-awake-toggle': { roles: CHROME, shape: a => a.length === 0 },
  'approve-inline-open': { roles: CHROME, shape: a => a.length === 1 && approveRect(a[0]) },
  'approve-inline-anchor': { roles: CHROME, shape: a => a.length === 1 && approveRect(a[0]) },
  palette: { roles: CHROME }, ready: { roles: CHROME }, 'save-retry': { roles: CHROME }, 'recovery-open': { roles: CHROME },
  'sync-reset': { roles: CHROME }, 'split-end': { roles: CHROME },
  layout: { roles: CHROME, shape: a => PRESETS.includes(a[0]) },
  'split-start': { roles: CHROME, shape: a => axis(a[0]) && int(a[1], 1, MAX_PANES) && row(a[2]) },
  'split-reset': { roles: CHROME, shape: a => axis(a[0]) && row(a[1]) },
  'sync-cols': { roles: CHROME, shape: a => bool(a[0]) },
  'fav-open': { roles: CHROME, shape: a => id(a[0]) && where(a[1]), target: (a, w) => w.fav(a[0]) },
  'fav-menu': { roles: CHROME, shape: a => id(a[0]), target: (a, w) => w.fav(a[0]) },
  'fav-move': { roles: CHROME, shape: a => id(a[0]) && id(a[1]), target: (a, w) => w.fav(a[0]) && w.fav(a[1]) },
  'fav-add': { roles: CHROME, shape: a => str(a[0], URL_MAX) && text(a[1]) },
  // Grok bar (grok-bots.js): read the list again (main runs one read at a time), the next 表示モード (gbar-mode.js: main cycles its own setting,
  // nothing comes from the page), open / menu of a listed Bot, a pin dragged onto another pin
  'gbar-refresh': { roles: CHROME },
  'gbar-mode': { roles: CHROME },
  'gbar-sec-toggle': { roles: CHROME, shape: a => a.length === 1 && GS.nameOk(a[0]) },
  'gbot-open': { roles: CHROME, shape: a => gid(a[0]) && where(a[1]), target: (a, w) => w.gbot(a[0]) },
  'gbot-menu': { roles: CHROME, shape: a => gid(a[0]), target: (a, w) => w.gbot(a[0]) },
  'gbot-move': { roles: CHROME, shape: a => gid(a[0]) && gid(a[1]), target: (a, w) => w.gbot(a[0]) && w.gbot(a[1]) },
  'focus-other': { roles: CHROME, shape: a => id(a[0]) && id(a[1]), target: (a, w) => w.winPane(a[0], a[1]) },   // a chip of a pane in another window
  // 進捗サイドバー: the bar's button (no URL yet: main opens the setting instead) / a right-click on it (the setting), a drag of its edge (the cursor
  // is read by main; the end is split-end like the splitters) and a double-click on it (back to the default width). Nothing but the press comes from the page
  'sidebar-toggle': { roles: CHROME, shape: a => a.length === 0 },
  'sidebar-settings': { roles: CHROME, shape: a => a.length === 0 },
  'sidebar-resize-start': { roles: CHROME, shape: a => a.length === 0 },
  'sidebar-resize-reset': { roles: CHROME, shape: a => a.length === 0 },
  // Chrome-only, bounded display data. The tooltip window itself has no IPC send API.
  'tip-show': { roles: CHROME, shape: ([p, ...extra]) => !extra.length && obj(p) && Object.keys(p).length === 4 && obj(p.tip)
    && Object.keys(p.tip).every(k => ['name', 'description', 'key', 'detail', 'dark', 'list'].includes(k))
    && str(p.tip.name, 500) && str(p.tip.description, 500)
    && str(p.tip.key, 40) && str(p.tip.detail, 2048) && bool(p.tip.dark) && opt(p.tip.list, TL.validList) && bool(p.preferSide)
    && obj(p.rect) && Object.keys(p.rect).length === 4 && ['x', 'y'].every(k => num(p.rect[k], -1e5, 1e5)) && ['width', 'height'].every(k => num(p.rect[k], 0, 1e5))
    && obj(p.size) && Object.keys(p.size).length === 2 && ['width', 'height'].every(k => num(p.size[k], 1, 1e4)) },
  'tip-prepare': { roles: CHROME }, 'tip-hide': { roles: CHROME },
  'usage-pop-show': { roles: CHROME, shape: ([r]) => obj(r) && num(r.right, -1e5, 1e5) && num(r.bottom, -1e5, 1e5) && gauge(r.kind) && opt(r.sel, text) },
  'usage-win-menu': { roles: CHROME, shape: a => kind(a[0]) && opt(a[1], text) },
  // 使用量表示: a gauge's click opens that provider's login window (main: only while the gauge is shown); the popover's link opens the
  // provider's fixed usage / help page in the default browser (main has the URL; nothing but the kind comes from the page)
  'usage-connect': { roles: UI, shape: a => kind(a[0]) },
  'usage-open': { roles: UI, shape: a => kind(a[0]) || a[0] === 'antigravity' },
  'usage-pop-leave': { roles: UI },
  'usage-pop-keep': { roles: OVERLAY },
  'usage-pop-size': { roles: OVERLAY, shape: a => num(a[0], 0, 1e5) },
  'overlay-close': { roles: OVERLAY },
  'overlay-run': { roles: UI, roleOf: a => action(a)?.roles || (action(a) ? OVERLAY : null),
    shape: a => !action(a).shape || action(a).shape(a[0]), target: (a, w) => !action(a).target || action(a).target(a[0], w) },
  // ---- app UI (preload.js mpb.*; ipcRenderer.invoke -> a reply) ----
  'usage:get': { roles: UI, shape: a => bool(a[0]) },
  'usage:detail': { roles: CHROME },
  'usage:margin': { roles: OVERLAY, shape: a => typeof a[0] === 'number' },   // NaN = only read (the popover refreshes its numbers that way)
  'aiusage:get': { roles: CHROME, shape: a => kind(a[0]) && bool(a[1]) },
  'claude:auth-dialog': { roles: CHROME },
  // ---- web panes (pane-preload; no contextBridge) ----
  'pane:msgcount': { roles: ['pane', 'probe'], origin: GROK, shape: a => countOk(a[0]) },
  'pane:pc-opened': { roles: PANE, origin: GROK },
  'pane:pc-closed': { roles: PANE }, 'pane:msgmode-off': { roles: PANE }, 'pane:mutation': { roles: PANE },
  // 画像クリックで最大化: the user clicked an image of a grok.com page; its viewer closed (true) / none was found (false)
  'pane:img-opened': { roles: PANE, origin: GROK },
  'pane:img-closed': { roles: PANE, shape: a => bool(a[0]) },
  'pane:interact': { roles: PANE }, 'pane:mouseup': { roles: PANE }, 'pane:typing': { roles: PANE },
  'pane:draft': { roles: PANE, shape: a => bool(a[0]) },
  'pane:draft-load': { roles: PANE, origin: GROK, shape: ([d]) => obj(d) && id(d.gen) && int(d.rev, 0, Number.MAX_SAFE_INTEGER) && str(d.url, URL_MAX) && !!DRAFT.url(d.url) },
  'pane:draft-save': { roles: PANE, origin: GROK, shape: ([d]) => obj(d) && id(d.gen) && int(d.rev, 0, Number.MAX_SAFE_INTEGER) && str(d.url, URL_MAX) && !!DRAFT.url(d.url) && str(d.text, DRAFT.MAX) },
  'pane:editing': { roles: PANE, shape: a => bool(a[0]) },
  'pane:ime': { roles: PANE, shape: a => bool(a[0]) },        // an IME composition started / ended (#11 input guard)
  'pane:sel': { roles: PANE, shape: a => bool(a[0]) },        // a selection in the page outside any field (選択部分だけコピー)
  // ---- the 進捗サイドバー page (sidebar-preload.js; contextBridge window.xgBotsSidebar): a Bot's name (focusBot), a jump ({ name, agentId?: a UUID,
  // open?: boolean } - never a URL; ipcHandle: main answers with the result), the state of the panes (ipcHandle, no argument), its settings screen ----
  'sidebar:focus-bot': { roles: ['sidebar'], shape: a => a.length === 1 && SR.nameOk(a[0]) },
  'sidebar:jump': { roles: ['sidebar'], shape: a => a.length === 1 && SR.jumpOk(a[0]) },
  'sidebar:get-state': { roles: ['sidebar'], shape: a => a.length === 0 },
  'sidebar:open-settings': { roles: ['sidebar'], shape: a => a.length === 0 },
};

// a file: URL shows this bundled file? Compared as paths (Chromium and Node escape a few characters differently); query / hash ignored
function docMatches(u, file) {
  let x; try { x = new URL(u); } catch { return false; }
  if (x.protocol !== 'file:' || (x.host !== '' && x.host !== 'localhost')) return false;
  let p;
  try { p = fileURLToPath(x); } catch (e) {
    if (!(e instanceof URIError)) return false;              // a stray '%' in the path: decode only the valid escapes
    p = x.pathname.replace(/(?:%[0-9A-Fa-f]{2})+/g, m => { try { return decodeURIComponent(m); } catch { return m; } });
  }
  return p === file;
}
// the sidebar: exactly the origin main created its view for (a sound web origin; the page may move inside it, never out of it)
const pageOk = (role, frame, origin, own) => Object.hasOwn(DOCS, role) ? docMatches(frame.url, DOCS[role])
  : role === 'sidebar' ? typeof own === 'string' && !!own && SR.originOf(own) === own && frame.origin === own : !origin || frame.origin === origin;

// sender: { role: one of ROLES | null (not registered / destroyed), frame: { top, detached, url, origin } | null (gone), origin?: the sidebar's }
// world:  { owned: sender's window (and pane) still open, pane(id), fav(id), gbot(id): a Bot of the Grok bar, ws(name), winPane(windowId, paneId) }
function check(ch, sender, args, world) {
  const c = typeof ch === 'string' && Object.hasOwn(CHANNELS, ch) ? CHANNELS[ch] : null;
  if (!c) return 'E_CHANNEL';
  if (!sender || !ROLES.includes(sender.role)) return 'E_SENDER';
  if (!c.roles.includes(sender.role)) return 'E_ROLE';
  const f = sender.frame;
  if (!f || f.top !== true || f.detached === true) return 'E_FRAME';
  if (!pageOk(sender.role, f, c.origin, sender.origin)) return 'E_PAGE';
  if (!world || world.owned !== true) return 'E_OWNER';
  const a = Array.isArray(args) ? args : [];
  try {
    if (c.roleOf) { const r = c.roleOf(a); if (!r) return 'E_PAYLOAD'; if (!r.includes(sender.role)) return 'E_ROLE'; }
    if (c.shape && !c.shape(a)) return 'E_PAYLOAD';
    if (c.target && !c.target(a, world)) return 'E_TARGET';
  } catch { return 'E_PAYLOAD'; }
  return null;
}

module.exports = { ROLES, CHANNELS, ACTIONS, REJECT, DOCS, PRESETS, RELOAD_CHOICES, MAX_PANES, URL_MAX, TEXT_MAX, BROADCAST_MAX, COUNT_MAX, GROK, check, msgCount, docMatches };

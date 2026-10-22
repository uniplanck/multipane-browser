// Preload for the app's own UI pages (index.html, overlay.html). Exposes a narrow API only: every function sends one fixed channel,
// listeners get the payload without the IPC event, and nothing returns ipcRenderer (ipcRenderer.on() returns it, so listen() drops it).
// main checks the sender page and every payload again (ipc-policy.js).
const { contextBridge, ipcRenderer } = require('electron');
const send = (ch, ...a) => { ipcRenderer.send(ch, ...a); };
const listen = (ch, f) => { ipcRenderer.on(ch, f); };
contextBridge.exposeInMainWorld('mpb', {
  platform: process.platform,
  navigate: (id, url) => send('navigate', id, String(url)),
  back: id => send('back', id), forward: id => send('forward', id),
  copyPaneUrl: id => send('copy-pane-url', id), reload: id => send('reload', id), close: id => send('close', id),
  add: () => send('add'), layout: l => send('layout', l),
  focusPane: id => send('focus-pane', id), activatePane: id => send('activate-pane', id),
  setReload: (id, m) => send('set-reload', id, m),
  swap: (a, b) => send('swap', a, b), maximize: id => send('maximize', id),
  dockBegin: id => send('dock-begin', id), dockReady: seq => send('dock-ready', seq), dockHover: (x, y) => send('dock-hover', x, y),
  dockDrop: (x, y) => send('dock-drop', x, y), dockEnd: () => send('dock-end'), onDock: cb => listen('dock', (_, m) => cb(m)),
  paneMenu: id => send('pane-menu', id), palette: () => send('palette'),
  run: action => send('overlay-run', action), closeOverlay: () => send('overlay-close'),
  ready: () => send('ready'),
  favOpen: (id, where) => send('fav-open', id, where), favMenu: id => send('fav-menu', id),
  favMove: (a, b) => send('fav-move', a, b), favAdd: (url, label) => send('fav-add', String(url), String(label || '')),
  gbarRefresh: () => send('gbar-refresh'), gbotOpen: (id, where) => send('gbot-open', id, where), gbotMenu: id => send('gbot-menu', id),   // Grok bar
  gbotMove: (a, b) => send('gbot-move', a, b), onGbar: cb => listen('gbar', (_, v) => cb(v)),
  renamePane: id => send('rename-pane', id),
  chipMenu: id => send('chip-menu', id), wsMenu: () => send('ws-menu'),
  splitStart: (a, i, row) => send('split-start', a, i, row), syncCols: v => send('sync-cols', v), syncReset: () => send('sync-reset'), splitEnd: () => send('split-end'), splitReset: (a, row) => send('split-reset', a, row),
  reloadAll: () => send('reload-all'), reopenClosed: () => send('reopen-closed'),
  sleepToggle: id => send('sleep-toggle', id), wakePane: id => send('wake-pane', id), sleepNow: id => send('sleep-now', id), loadCancel: id => send('load-cancel', id),
  probeResume: () => send('probe-resume'),
  approveOpen: () => send('approve-open'), focusOther: (wid, pid) => send('focus-other', wid, pid),
  saveRetry: () => send('save-retry'), recoveryOpen: () => send('recovery-open'),
  onMem: cb => listen('mem', (_, b) => cb(b)), onOthers: cb => listen('others', (_, l) => cb(l)),
  onWsSaved: cb => listen('ws-saved', (_, n) => cb(n)), onApproveRect: cb => listen('approve-rect', (_, r) => cb(r)),
  usagePopShow: r => send('usage-pop-show', r), usagePopKeep: () => send('usage-pop-keep'), usagePopLeave: () => send('usage-pop-leave'), usagePopSize: h => send('usage-pop-size', h),
  usageMargin: v => ipcRenderer.invoke('usage:margin', v),
  onUsagePop: cb => listen('usage-pop', (_, d) => cb(d)), onUsageUpdated: cb => listen('usage-updated', () => cb()),
  usageWinMenu: (kind, sel) => send('usage-win-menu', kind, sel), onUsageWin: cb => listen('usage-win-chosen', (_, k, id) => cb(k, id)),
  usageDetail: () => ipcRenderer.invoke('usage:detail'),
  claudeAuthDialog: () => ipcRenderer.invoke('claude:auth-dialog'),
  usageConnect: kind => send('usage-connect', kind), usageOpen: kind => send('usage-open', kind),
  aiUsage: (kind, force) => ipcRenderer.invoke('aiusage:get', kind, !!force),
  usage: force => ipcRenderer.invoke('usage:get', !!force),
  onState: cb => listen('state', (_, s) => cb(s)),
  onFocusUrl: cb => listen('focus-url', (_, id) => cb(id)),
  onOverlayOpen: cb => listen('overlay-open', (_, o) => cb(o)),
  onBroadcast: cb => listen('bc-state', (_, v) => cb(v)),      // (#12) main's view of the broadcast preview / batch
});

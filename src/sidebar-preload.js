// Preload of the 進捗サイドバー page only (sandboxed, contextIsolation): window.xgBotsSidebar on fixed channels, nothing else of the app. Main checks
// the sender (the sidebar view it created, top frame, the configured URL's origin) and every argument again; this file only shapes what it sends.
//   focusBot(name): show the pane of that Bot (no reply; does nothing when no pane matches)
//   jump({ name, agentId, open }): show that Bot's pane with the keyboard in its composer, or (open: true) open one -> Promise<{ result }>
//     ('focused' | 'opened' | 'none' | 'blocked' | 'nomatch'; anything main refused = 'blocked'). agentId: a UUID or it is left out
//   onState(cb) / getState(): the panes as main tells this page only ({ panes: [{ agentId|null, names, active }], confirmOpen }); onState -> unsubscribe
//   openSettings(): the 進捗サイドバー settings screen
//   instruct({ tid, task, bot, state, memo }): the NaoAIへの指示 box for that row (call it from the row's contextmenu handler, preventDefault there)
//     -> Promise<{ result }> ('open' | 'blocked' | 'bad': not strings / no tid / too long; anything main refused = 'blocked'). Strings only; main
//     strips control characters and cuts each field (tid 60, task 500, bot 40, state 20, memo 500). The text and the webhook stay in the app
// focusBot / jump / openSettings / instruct count only right after the user's click / key in the sidebar (main: within 5 s, never from a page
// timer; a right-click's mouse-down counts).
const { contextBridge, ipcRenderer } = require('electron');
const AGENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;   // = SidebarRules.agentOk (a sandboxed preload cannot require it)
const RESULTS = ['focused', 'opened', 'none', 'blocked', 'nomatch'];                // = SidebarRules.RESULTS
const FIELDS = ['tid', 'task', 'bot', 'state', 'memo'], RAW_MAX = 10000;             // = InstructRules.FIELDS / RAW_MAX
const INSTRUCT = ['open', 'blocked', 'bad'];                                          // = InstructRules.RESULTS
const EMPTY = () => ({ panes: [], confirmOpen: true });                               // main refused / gone: nothing known, ask before opening
const listeners = new Set();
ipcRenderer.on('sidebar:state', (e, s) => { for (const cb of [...listeners]) { try { cb(s); } catch {} } });   // the state only, never the event
contextBridge.exposeInMainWorld('xgBotsSidebar', Object.freeze({
  focusBot: name => { if (typeof name === 'string' && name.length <= 80) ipcRenderer.send('sidebar:focus-bot', name); },
  jump: req => {
    const o = req && typeof req === 'object' ? req : {}, name = o.name, id = typeof o.agentId === 'string' ? o.agentId.toLowerCase() : '';
    if (typeof name !== 'string' || name.length > 80) return Promise.resolve({ result: 'blocked' });
    const msg = { name };
    if (AGENT.test(id)) msg.agentId = id;
    if (o.open === true) msg.open = true;
    return ipcRenderer.invoke('sidebar:jump', msg).then(r => ({ result: r && RESULTS.includes(r.result) ? r.result : 'blocked' }), () => ({ result: 'blocked' }));
  },
  onState: cb => { if (typeof cb !== 'function') return () => {}; listeners.add(cb); return () => { listeners.delete(cb); }; },
  getState: () => ipcRenderer.invoke('sidebar:get-state').then(s => s && typeof s === 'object' && Array.isArray(s.panes) ? s : EMPTY(), EMPTY),
  openSettings: () => { ipcRenderer.send('sidebar:open-settings'); },
  instruct: req => {
    const o = req && typeof req === 'object' ? req : {}, msg = {};
    for (const k of FIELDS) {
      const v = o[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string' || v.length > RAW_MAX) return Promise.resolve({ result: 'bad' });
      msg[k] = v;
    }
    if (!msg.tid || !msg.tid.trim()) return Promise.resolve({ result: 'bad' });
    if (o.mode === 'answer') msg.mode = 'answer';
    if (typeof o.ask === 'string' && o.ask.length <= RAW_MAX) msg.ask = o.ask;
    if (Array.isArray(o.options) && o.options.length <= 8 && o.options.every(x => typeof x === 'string' && x.length <= RAW_MAX)) msg.options = o.options;
    return ipcRenderer.invoke('sidebar:instruct', msg).then(r => ({ result: r && INSTRUCT.includes(r.result) ? r.result : 'blocked' }), () => ({ result: 'blocked' }));
  },
}));

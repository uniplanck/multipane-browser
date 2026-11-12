// Preload of the 進捗サイドバー page only (sandboxed, contextIsolation): window.xgBotsSidebar on fixed channels, nothing else of the app. Main checks
// the sender (the sidebar view it created, top frame, the configured URL's origin) and every argument again; this file only shapes what it sends.
//   focusBot(name): show the pane of that Bot (no reply; does nothing when no pane matches)
//   jump({ name, agentId, open }): show that Bot's pane with the keyboard in its composer, or (open: true) open one -> Promise<{ result }>
//     ('focused' | 'opened' | 'none' | 'blocked' | 'nomatch'; anything main refused = 'blocked'). agentId: a UUID or it is left out
//   onState(cb) / getState(): the panes as main tells this page only ({ panes: [{ agentId|null, names, active }], confirmOpen: false }); onState -> unsubscribe
//   openSettings(): the 進捗サイドバー settings screen
//   instruct({ tid, task, bot, state, memo }): the NaoAIへの指示 box for that row (call it from the row's contextmenu handler, preventDefault there)
//     -> Promise<{ result }> ('open' | 'blocked' | 'bad': not strings / no tid / too long; anything main refused = 'blocked'). Strings only; main
//     strips control characters and cuts each field (tid 60, task 500, bot 40, state 20, memo 500). The text and the webhook stay in the app
//   instruct({ tasks: [{ tid, task, bot, state, memo }, ...] }): one box for the rows the user selected (1..20, one Bot: two bot names -> 'bad'),
//     sent as one batch in this order; the same results
//   onClearSelection(cb): the user pressed the mouse outside the sidebar in its window (a pane / the bar) or a batch went out -> cb() (no
//     argument): the page drops its row selection. -> unsubscribe
// focusBot / jump / openSettings / instruct count only right after the user's click / key in the sidebar (main: within 5 s, never from a page
// timer; a right-click's mouse-down counts).
const { contextBridge, ipcRenderer } = require('electron');
const AGENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;   // = SidebarRules.agentOk (a sandboxed preload cannot require it)
const RESULTS = ['focused', 'opened', 'none', 'blocked', 'nomatch'];                // = SidebarRules.RESULTS
const FIELDS = ['tid', 'task', 'bot', 'state', 'memo'], RAW_MAX = 10000;             // = InstructRules.FIELDS / RAW_MAX
const INSTRUCT = ['open', 'blocked', 'bad'];                                          // = InstructRules.RESULTS
const BATCH_MAX = 20;                                                                 // = InstructRules.BATCH_MAX
const EMPTY = () => ({ panes: [], confirmOpen: false });                              // main refused / gone: nothing known (confirmOpen is always false)
const listeners = new Set(), clears = new Set();
ipcRenderer.on('sidebar:state', (e, s) => { for (const cb of [...listeners]) { try { cb(s); } catch {} } });   // the state only, never the event
ipcRenderer.on('sidebar:clear-selection', () => { for (const cb of [...clears]) { try { cb(); } catch {} } });   // nothing passed on
// a row's five fields as main takes them (strings up to RAW_MAX; null / absent left out), or null (not usable: not a string / too long / no tid)
function fields(o) {
  const msg = {};
  for (const k of FIELDS) {
    const v = o && typeof o === 'object' ? o[k] : undefined;
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v.length > RAW_MAX) return null;
    msg[k] = v;
  }
  return msg.tid && msg.tid.trim() ? msg : null;
}
const insReply = msg => ipcRenderer.invoke('sidebar:instruct', msg).then(r => ({ result: r && INSTRUCT.includes(r.result) ? r.result : 'blocked' }), () => ({ result: 'blocked' }));
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
    const o = req && typeof req === 'object' ? req : {};
    if (Array.isArray(o.tasks)) {                                                     // the selected rows: their five fields each, one Bot
      const tasks = o.tasks.length >= 1 && o.tasks.length <= BATCH_MAX ? o.tasks.map(fields) : [null];
      if (tasks.some(x => !x) || tasks.some(x => (x.bot || '') !== (tasks[0].bot || ''))) return Promise.resolve({ result: 'bad' });
      return insReply({ tasks });
    }
    const msg = fields(o);
    if (!msg) return Promise.resolve({ result: 'bad' });
    if (o.mode === 'answer') msg.mode = 'answer';
    if (typeof o.ask === 'string' && o.ask.length <= RAW_MAX) msg.ask = o.ask;
    if (Array.isArray(o.options) && o.options.length <= 8 && o.options.every(x => typeof x === 'string' && x.length <= RAW_MAX)) msg.options = o.options;
    return insReply(msg);
  },
  onClearSelection: cb => { if (typeof cb !== 'function') return () => {}; clears.add(cb); return () => { clears.delete(cb); }; },
}));

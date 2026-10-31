// Preload of the 進捗サイドバー page only (sandboxed, contextIsolation): window.xgBotsSidebar on fixed channels, nothing else of the app. Main checks
// the sender (the sidebar view it created, top frame, the configured URL's origin) and every argument again; this file only shapes what it sends.
//   focusBot(name): show the pane of that Bot (no reply; does nothing when no pane matches)
//   jump({ name, agentId, open }): show that Bot's pane with the keyboard in its composer, or (open: true) open one -> Promise<{ result }>
//     ('focused' | 'opened' | 'none' | 'blocked' | 'nomatch'; anything main refused = 'blocked'). agentId: a UUID or it is left out
//   onState(cb) / getState(): the panes as main tells this page only ({ panes: [{ agentId|null, names, active }], confirmOpen }); onState -> unsubscribe
//   openSettings(): the 進捗サイドバー settings screen
// focusBot / jump / openSettings count only right after the user's click / key in the sidebar (main: within 5 s, never from a page timer).
const { contextBridge, ipcRenderer } = require('electron');
const AGENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;   // = SidebarRules.agentOk (a sandboxed preload cannot require it)
const RESULTS = ['focused', 'opened', 'none', 'blocked', 'nomatch'];                // = SidebarRules.RESULTS
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
}));

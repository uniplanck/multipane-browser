// Preload of the 進捗サイドバー page only (sandboxed, contextIsolation): one function on one fixed channel, nothing else of the app.
// window.xgBotsSidebar.focusBot(name) asks main to show the pane of that Bot; main checks the sender (the sidebar view it created, top frame,
// the configured URL's origin) and the name (string, up to 80 characters) again, and does nothing when no pane matches. No reply.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('xgBotsSidebar', Object.freeze({
  focusBot: name => { if (typeof name === 'string' && name.length <= 80) ipcRenderer.send('sidebar:focus-bot', name); },
}));

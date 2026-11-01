// Display-only (NaoAIへの指示 result toast): this page can receive a message but has no API for sending IPC.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('toastWindow', { onToast: cb => { ipcRenderer.on('toast-display', (_, m) => cb(m)); } });

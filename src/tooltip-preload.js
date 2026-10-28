// Display-only: this page can receive a tip but has no API for sending IPC.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tipWindow', { onTip: cb => { ipcRenderer.on('tip-display', (_, tip) => cb(tip)); } });

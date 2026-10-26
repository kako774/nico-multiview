'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gift', {
  onState: cb => ipcRenderer.on('gift:state', (_e, list, cur) => cb(list, cur)),
  pick: id => ipcRenderer.send('gift:pick', id),
  ready: () => ipcRenderer.send('gift:ready'),
  reopen: () => ipcRenderer.send('gift:reopen'),
});

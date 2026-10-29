'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('emo', {
  onState: cb => ipcRenderer.on('emo:state', (_e, list, cur) => cb(list, cur)),
  pick: id => ipcRenderer.send('emo:pick', id),
  ready: () => ipcRenderer.send('emo:ready'),
  reopen: () => ipcRenderer.send('emo:reopen'),
});

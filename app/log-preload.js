'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lg', {
  init: () => ipcRenderer.invoke('lg:init'),
  onLine: cb => ipcRenderer.on('lg:line', (_e, l) => cb(l)),
  clear: () => ipcRenderer.send('lg:clear'),
  copy: t => ipcRenderer.send('lg:copy', String(t || '')),
});

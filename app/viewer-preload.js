'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vw', {
  init: () => ipcRenderer.invoke('vw:init'),
  onComments: cb => ipcRenderer.on('vw:comments', (_e, list) => cb(list)),
  onMode: cb => ipcRenderer.on('vw:mode', (_e, m) => cb(m)),
  onSources: cb => ipcRenderer.on('vw:sources', (_e, s) => cb(s)),
  copy: t => ipcRenderer.send('vw:copy', String(t || '')),
  clear: () => ipcRenderer.send('vw:clear'),
  onTop: v => ipcRenderer.send('vw:ontop', !!v),
});

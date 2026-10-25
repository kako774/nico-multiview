'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vw', {
  init: () => ipcRenderer.invoke('vw:init'),
  onComments: cb => ipcRenderer.on('vw:comments', (_e, list) => cb(list)),
  onSources: cb => ipcRenderer.on('vw:sources', (_e, s) => cb(s)),
  clear: () => ipcRenderer.send('vw:clear'),
  onTop: v => ipcRenderer.send('vw:ontop', !!v),
});

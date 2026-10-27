'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('menu', {
  onShow: cb => ipcRenderer.on('menu:show', (_e, type, data) => cb(type, data)),
  onData: cb => ipcRenderer.on('menu:data', (_e, data) => cb(data)),
  act: (action, payload, keep) => ipcRenderer.send('menu:act', action, payload, !!keep),
  size: h => ipcRenderer.send('menu:size', Math.ceil(h)),
  close: () => ipcRenderer.send('menu:close'),
  followList: () => ipcRenderer.invoke('mv:follow-list'),
  evList: keys => ipcRenderer.invoke('mv:ev-list', keys),
});

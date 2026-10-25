'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('exitFs', () => ipcRenderer.send('mv:fullscreen', false));

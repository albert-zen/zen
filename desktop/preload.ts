import { contextBridge, ipcRenderer } from 'electron';

import { createDesktopBridge } from './ipc.js';

contextBridge.exposeInMainWorld(
  'zenDesktop',
  createDesktopBridge({
    invoke: async (channel, ...args) => await ipcRenderer.invoke(channel, ...args),
    platform: process.platform,
    version: process.versions.electron,
  })
);

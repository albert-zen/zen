// Disposable CI fixture only. No generic IPC, filesystem, or navigation bridge.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("__nativeFullscreenBridge", {
  mount: (request) => ipcRenderer.invoke("fixture:fullscreen-mount", request),
});

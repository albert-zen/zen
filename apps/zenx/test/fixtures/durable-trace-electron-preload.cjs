const { contextBridge, ipcRenderer } = require("electron");

// Synthetic windows intentionally expose only this channel in every frame so
// a real subframe invocation reaches the production main-process gate.
contextBridge.exposeInMainWorld("traceGateFixture", {
  invoke: (command) => ipcRenderer.invoke("zenx:model-request-debug", command),
});

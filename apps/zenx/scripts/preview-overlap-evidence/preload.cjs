const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("zenx", {
  workspaceBrowser: {
    mount: (request) => ipcRenderer.invoke("evidence:mount", request),
    onFocusAddress: () => () => {},
    command: () => Promise.reject(new Error("No fixture navigation commands")),
  },
});
contextBridge.exposeInMainWorld(
  "__evidenceTab",
  ipcRenderer.sendSync("evidence:tab"),
);

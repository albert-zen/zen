import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("zenx", {
  platform: process.platform,
});

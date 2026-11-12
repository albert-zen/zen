import { BrowserWindow, ipcMain } from "electron";
import type {
  ModelRequestDebugCommand,
  ModelRequestDebugResult,
} from "../../../cli/src/model-request-debug-types.js";
import { ipcChannels } from "../preload/ipc.js";
import { createModelRequestDebugHandler } from "./model-request-debug-ipc.js";

/** Native registration shared by the app and the owned synthetic Electron gate. */
export function installModelRequestDebugIpc(options: {
  rendererUrl: string;
  ownedWindowIds: ReadonlySet<number>;
  read(command: ModelRequestDebugCommand): Promise<ModelRequestDebugResult>;
}): void {
  ipcMain.handle(
    ipcChannels.modelRequestDebug,
    createModelRequestDebugHandler<Electron.IpcMainInvokeEvent>({
      rendererUrl: options.rendererUrl,
      sender(event) {
        const window = BrowserWindow.fromWebContents(event.sender);
        return {
          ownedWindow: window !== null && options.ownedWindowIds.has(window.id),
          mainFrame: event.senderFrame === event.sender.mainFrame,
          url: event.senderFrame?.url ?? "",
        };
      },
      read: options.read,
    }),
  );
}

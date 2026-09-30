import { ipcMain } from "electron";
import type { AppServerManager } from "./app-server-manager.js";
import { ipcChannels } from "../preload/ipc.js";
import { isClientRequestMethod } from "../protocol-client/index.js";
import type { Thread } from "../protocol-client/index.js";

/** One production main-process request boundary, also exercised in isolated Electron QA. */
export function registerProtocolRequestIpc(
  manager: Pick<AppServerManager, "request">,
  observeThread: (thread: Thread) => void,
): void {
  ipcMain.handle(
    ipcChannels.request,
    async (_event, method: unknown, params: unknown) => {
      if (!isClientRequestMethod(method)) {
        throw new Error(`Unsupported ZenX protocol method: ${String(method)}`);
      }
      const result = await manager.request(method, params as never);
      if (method === "thread/resume" || method === "thread/read") {
        const snapshot =
          result as import("../protocol-client/index.js").ClientRequestResults["thread/read"];
        observeThread(snapshot.thread);
      }
      return result;
    },
  );
}

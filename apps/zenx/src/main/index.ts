import { app, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "node:path";

import { isClientRequestMethod } from "../protocol-client/index.js";
import { ipcChannels } from "../preload/ipc.js";
import { AppServerManager } from "./app-server-manager.js";
import type { ApprovalDecision } from "./app-server-manager.js";
import { resolveZenXHostConfig } from "./host-config.js";

let appServerManager: AppServerManager | undefined;
let quitting = false;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0b0d10",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}

app.whenReady().then(async () => {
  try {
    appServerManager = new AppServerManager({
      entryPath: join(__dirname, "app-server-host.js"),
      tokenFile: join(app.getPath("userData"), "runtime", "app-server.token"),
      hostConfig: resolveZenXHostConfig(),
      execPath: process.execPath,
    });
    installProtocolIpc(appServerManager);
    await appServerManager.start();
  } catch (error) {
    console.error("Could not start Zen App Server", error);
    if (appServerManager === undefined) {
      installFailedProtocolIpc(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", (event) => {
  if (quitting || appServerManager === undefined) return;
  event.preventDefault();
  quitting = true;
  void appServerManager.stop().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function installProtocolIpc(manager: AppServerManager): void {
  ipcMain.handle(ipcChannels.getStatus, () => manager.status);
  ipcMain.handle(
    ipcChannels.getPendingApprovals,
    () => manager.pendingApprovalRequests,
  );
  ipcMain.handle(
    ipcChannels.request,
    async (_event, method: unknown, params: unknown) => {
      if (!isClientRequestMethod(method)) {
        throw new Error(`Unsupported ZenX protocol method: ${String(method)}`);
      }
      return await manager.request(method, params as never);
    },
  );
  ipcMain.handle(
    ipcChannels.respondApproval,
    (_event, requestId: unknown, decision: unknown) => {
      if (typeof requestId !== "string" || !isApprovalDecision(decision)) {
        throw new Error("Invalid ZenX approval response");
      }
      manager.respondToApproval(requestId, decision);
    },
  );
  manager.onStatus((status) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.status, status);
    }
  });
  manager.onNotification((method, params) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.notification, method, params);
    }
  });
  manager.onApprovalRequest((approval) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.approvalRequest, approval);
    }
  });
  manager.onApprovalResolved((approval) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.approvalResolved, approval);
    }
  });
}

function installFailedProtocolIpc(message: string): void {
  ipcMain.handle(ipcChannels.getStatus, () => ({ type: "error", message }));
  ipcMain.handle(ipcChannels.getPendingApprovals, () => []);
  ipcMain.handle(ipcChannels.request, () => {
    throw new Error(`Zen App Server is not ready: ${message}`);
  });
  ipcMain.handle(ipcChannels.respondApproval, () => {
    throw new Error(`Zen App Server is not ready: ${message}`);
  });
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return (
    value === "accept" ||
    value === "acceptForSession" ||
    value === "decline" ||
    value === "cancel"
  );
}

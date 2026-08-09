import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { join, resolve } from "node:path";

import { isAllowedZenXExternalUrl } from "../external-link-policy.js";
import { isClientRequestMethod } from "../protocol-client/index.js";
import { ipcChannels } from "../preload/ipc.js";
import { AppServerManager } from "./app-server-manager.js";
import type { ApprovalDecision } from "./app-server-manager.js";
import { ZenXCredentialVault } from "./credential-vault.js";
import type { ZenXHostProfile } from "./host-profile.js";
import { ZenXSettingsService } from "./settings-service.js";
import { ZenXTriggerService } from "./trigger-service.js";
import { ZenXTriggerStore } from "./trigger-store.js";
import type {
  CreateRoomInput,
  CreateTriggerInput,
  RoomMember,
} from "./trigger-types.js";

let appServerManager: AppServerManager | undefined;
let settingsService: ZenXSettingsService | undefined;
let triggerService: ZenXTriggerService | undefined;
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
    if (isAllowedZenXExternalUrl(url)) void shell.openExternal(url);
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
  const userDataDirectory = app.getPath("userData");
  const entryPath = join(__dirname, "app-server-host.js");
  const tokenFile = join(userDataDirectory, "runtime", "app-server.token");
  const zenDataDirectory = resolve(
    process.env["ZENX_DATA_DIR"] ?? join(app.getPath("home"), ".zen"),
  );
  settingsService = new ZenXSettingsService({
    userDataDirectory,
    zenDataDirectory,
    vault: new ZenXCredentialVault(
      join(userDataDirectory, "credentials.vault"),
      safeStorage,
    ),
  });
  try {
    await settingsService.initialize(process.env);
    let startupError: unknown;
    let hostConfig;
    try {
      hostConfig = await settingsService.hostConfig();
    } catch (error) {
      startupError = error;
      hostConfig = {
        cwd: process.cwd(),
        dataDirectory: zenDataDirectory,
        model: "fake",
        models: ["fake"],
        approvalPolicy: "never" as const,
        provider: { type: "fake" as const },
      };
    }
    appServerManager = new AppServerManager({
      entryPath,
      tokenFile,
      hostConfig,
      execPath: process.execPath,
    });
    installProtocolIpc(appServerManager);
    triggerService = new ZenXTriggerService(
      appServerManager,
      new ZenXTriggerStore(join(userDataDirectory, "trigger-registry.json")),
    );
    await triggerService.start();
    installTriggerIpc(triggerService);
    if (startupError === undefined) await appServerManager.start();
    else appServerManager.reportStartupError(startupError);
  } catch (error) {
    console.error("Could not start Zen App Server", error);
    if (appServerManager === undefined) {
      installFailedProtocolIpc(
        error instanceof Error ? error.message : String(error),
      );
    } else if (appServerManager.status.type !== "error") {
      appServerManager.reportStartupError(error);
    }
  }
  installSettingsIpc(settingsService, async () => {
    const hostConfig = await settingsService!.hostConfig();
    if (appServerManager === undefined) {
      appServerManager = new AppServerManager({
        entryPath,
        tokenFile,
        hostConfig,
        execPath: process.execPath,
      });
      await appServerManager.start();
    } else {
      await appServerManager.restart(hostConfig);
    }
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", (event) => {
  if (quitting || appServerManager === undefined) return;
  event.preventDefault();
  quitting = true;
  triggerService?.stop();
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

function installSettingsIpc(
  settings: ZenXSettingsService,
  restartHost: () => Promise<void>,
): void {
  ipcMain.handle(
    ipcChannels.settingsGet,
    async () => await settings.publicSettings(),
  );
  ipcMain.handle(
    ipcChannels.settingsSave,
    async (_event, profile: ZenXHostProfile, apiKey?: unknown) => {
      if (apiKey !== undefined && typeof apiKey !== "string") {
        throw new Error("Invalid API key");
      }
      await settings.save(profile, apiKey);
      await restartHost();
      return await settings.publicSettings();
    },
  );
  ipcMain.handle(ipcChannels.subscriptionLogin, async () => {
    await settings.login(
      (url) => {
        if (!isAllowedZenXExternalUrl(url))
          throw new Error("OpenAI login returned an unsafe authorization URL");
        void shell.openExternal(url);
      },
      () => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(ipcChannels.subscriptionManualRequested);
        }
      },
    );
    return await settings.publicSettings();
  });
  ipcMain.handle(
    ipcChannels.subscriptionManualCode,
    (_event, code: unknown) => {
      if (typeof code !== "string")
        throw new Error("Invalid authorization code");
      settings.submitManualCode(code);
    },
  );
  ipcMain.handle(ipcChannels.subscriptionLogout, async () => {
    await settings.logout();
    return await settings.publicSettings();
  });
}

function installTriggerIpc(triggers: ZenXTriggerService): void {
  ipcMain.handle(ipcChannels.triggersGet, () => triggers.snapshot());
  ipcMain.handle(
    ipcChannels.triggersCreate,
    async (_event, input: CreateTriggerInput) => {
      await triggers.create(input);
      return triggers.snapshot();
    },
  );
  ipcMain.handle(
    ipcChannels.triggersCancel,
    async (_event, triggerId: unknown) => {
      if (typeof triggerId !== "string") throw new Error("Invalid trigger ID");
      await triggers.cancel(triggerId);
      return triggers.snapshot();
    },
  );
  ipcMain.handle(
    ipcChannels.triggersSignal,
    async (_event, name: unknown, detail: unknown) => {
      if (typeof name !== "string" || typeof detail !== "string")
        throw new Error("Invalid signal");
      await triggers.signal(name, detail);
      return triggers.snapshot();
    },
  );
  ipcMain.handle(
    ipcChannels.roomsCreate,
    async (_event, input: CreateRoomInput) => {
      await triggers.createRoom(input);
      return triggers.snapshot();
    },
  );
  ipcMain.handle(
    ipcChannels.roomsAddMember,
    async (_event, roomId: unknown, member: unknown) => {
      if (typeof roomId !== "string" || !isRoomMember(member))
        throw new Error("Invalid Room member");
      await triggers.addRoomMember(roomId, member);
      return triggers.snapshot();
    },
  );
  ipcMain.handle(
    ipcChannels.roomsRemoveMember,
    async (_event, roomId: unknown, threadId: unknown) => {
      if (typeof roomId !== "string" || typeof threadId !== "string")
        throw new Error("Invalid Room member removal");
      await triggers.removeRoomMember(roomId, threadId);
      return triggers.snapshot();
    },
  );
  ipcMain.handle(
    ipcChannels.roomsPost,
    async (_event, roomId: unknown, author: unknown, text: unknown) => {
      if (
        typeof roomId !== "string" ||
        typeof author !== "string" ||
        typeof text !== "string"
      )
        throw new Error("Invalid Room message");
      await triggers.postRoomMessage(roomId, author, text);
      return triggers.snapshot();
    },
  );
  triggers.onChange((snapshot) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send(ipcChannels.triggersChanged, snapshot);
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

function isRoomMember(value: unknown): value is RoomMember {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<RoomMember>).name === "string" &&
    typeof (value as Partial<RoomMember>).threadId === "string"
  );
}

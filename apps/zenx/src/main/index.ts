import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  session,
  shell,
} from "electron";
import { join, resolve } from "node:path";
import { FileAttachmentStore } from "../../../../src/attachment.js";

import { isAllowedZenXExternalUrl } from "../external-link-policy.js";
import {
  isClientRequestMethod,
  type ServerNotificationParams,
} from "../protocol-client/index.js";
import { ipcChannels } from "../preload/ipc.js";
import { AppServerManager } from "./app-server-manager.js";
import type { ApprovalDecision } from "./app-server-manager.js";
import { ZenXCredentialVault } from "./credential-vault.js";
import type {
  ZenXProviderDeleteReplacements,
  ZenXProviderEditOptions,
  ZenXProviderProfile,
  ZenXSettingsUpdate,
  ZenXSidebarOrder,
} from "./host-profile.js";
import { ZenXSettingsService } from "./settings-service.js";
import {
  withZenXProviderTransports,
  zenXProviderDiscoveryTransport,
} from "./system-proxy.js";
import {
  ZenXTriggersCapabilityPackage,
  ZENX_ROOMS_CAPABILITY_ID,
  type ZenXAutomationControlPort,
} from "./capabilities/automation-control-package.js";
import { createBundledAutomationPluginService } from "./automation-plugin-service.js";
import { ZenXThreadTitleCoordinator } from "./thread-title-coordinator.js";
import { normalizeTitleOwnershipFailure } from "./thread-title-failure.js";
import { ZenXThreadTitleStore } from "./thread-title-store.js";
import { observeCompletedUserMessageTitle } from "./thread-title-notification.js";
import { ZenXConfiguredTitleInference } from "./title-inference.js";
import { ZenXCapabilityService } from "./capability-service.js";
import { PACKAGED_PROVIDER_MANIFEST_SHA256 } from "./capabilities/packaged-provider-integrity.js";
import {
  MutableAppServerRequestPort,
  ZenXSelfControlCapabilityPackage,
} from "./capabilities/self-control-package.js";
import { installApplicationMenu } from "./application-menu.js";
import { ZenXDirectoryBrowser } from "./directory-browser.js";
import { ZenXProjectProjection } from "./project-projection.js";
import {
  projectWorkspaceAcceptanceConfigPath,
  runProjectWorkspaceAcceptance,
} from "./project-workspace-smoke.js";
import {
  importImageDrafts,
  importLocalImageDrafts,
  readAttachmentPayload,
  type ZenXImageImport,
} from "./image-attachments.js";
import {
  ZenXHostLifecycle,
  type ZenXDesktopPlatform,
} from "./host-lifecycle.js";
import {
  externalZasAcceptanceConfigPath,
  runExternalZasAcceptance,
} from "./external-zas-smoke.js";
import { secondInstanceDisposition } from "./desktop-lifecycle.js";
import { validatePluginHostSdkRequest } from "./plugin-host-sdk.js";
import type { ZenXPluginPackageSource } from "./capabilities/types.js";
import {
  createZenXRoomsProfileLoader,
  ZENX_ROOMS_PACKAGE_NAME,
  ZENX_ROOMS_TARBALL,
} from "./rooms-profile-loader.js";
import {
  JsonFileMarketplaceCatalogTransport,
  MarketplaceCatalogService,
} from "./marketplace-catalog.js";

let appServerManager: AppServerManager | undefined;
let settingsService: ZenXSettingsService | undefined;
let capabilityService: ZenXCapabilityService | undefined;
const projectProjection = new ZenXProjectProjection();
const selfControlPort = new MutableAppServerRequestPort(projectProjection);
let titleCoordinator: ZenXThreadTitleCoordinator | undefined;
const ownsSingleInstance =
  secondInstanceDisposition(app.requestSingleInstanceLock()) ===
  "own-authority";
const hostLifecycle = new ZenXHostLifecycle({
  platform: desktopPlatform(process.platform),
  windowCount: () => BrowserWindow.getAllWindows().length,
  createWindow,
  stopHost: stopZenXHost,
  finishQuit: () => app.quit(),
  reportStopFailure: (error) =>
    console.error("Could not fully stop ZenX before quit", error),
});
if (!ownsSingleInstance) app.quit();
const projectWorkspaceAcceptanceEnvironment =
  process.env["ZENX_PROJECT_ACCEPTANCE_CONFIG"];
delete process.env["ZENX_PROJECT_ACCEPTANCE_CONFIG"];
const externalZasAcceptanceEnvironment =
  process.env["ZENX_EXTERNAL_ZAS_ACCEPTANCE_CONFIG"];
delete process.env["ZENX_EXTERNAL_ZAS_ACCEPTANCE_CONFIG"];
const projectWorkspaceAcceptancePath = projectWorkspaceAcceptanceConfigPath(
  process.argv,
  projectWorkspaceAcceptanceEnvironment,
);
const externalZasAcceptancePath = externalZasAcceptanceConfigPath(
  process.argv,
  externalZasAcceptanceEnvironment,
);

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 360,
    minHeight: 560,
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
  if (!ownsSingleInstance) return;
  const userDataDirectory = app.getPath("userData");
  const entryPath = join(__dirname, "app-server-host.js");
  const tokenFile = join(userDataDirectory, "runtime", "app-server.token");
  const connectionDescriptorFile = join(
    userDataDirectory,
    "runtime",
    "app-server.json",
  );
  const zenDataDirectory = resolve(
    process.env["ZENX_DATA_DIR"] ?? join(app.getPath("home"), ".zen"),
  );
  const imageAttachments = new FileAttachmentStore(
    join(zenDataDirectory, "attachments"),
  );
  const directoryBrowser = new ZenXDirectoryBrowser({
    home: app.getPath("home"),
    documents: app.getPath("documents"),
  });
  installApplicationMenu();
  let automationService: ZenXAutomationControlPort | undefined;
  const resourcesDirectory = app.isPackaged
    ? process.resourcesPath
    : join(__dirname, "../../resources");
  const roomsService = (): ZenXAutomationControlPort => {
    if (automationService === undefined) {
      throw new Error("Rooms automation service is not attached");
    }
    return automationService;
  };
  settingsService = new ZenXSettingsService({
    userDataDirectory,
    zenDataDirectory,
    vault: new ZenXCredentialVault(
      join(userDataDirectory, "credentials.vault"),
      safeStorage,
    ),
  });
  try {
    capabilityService = new ZenXCapabilityService({
      userDataDirectory,
      bundledProvidersOnly: app.isPackaged,
      resourcesDirectory,
      pnpmCliPath: app.isPackaged
        ? undefined
        : join(__dirname, "../../../../node_modules/pnpm/bin/pnpm.cjs"),
      trustedProfileLoaders: {
        [ZENX_ROOMS_CAPABILITY_ID]: createZenXRoomsProfileLoader(roomsService),
      },
      bundledManifestSha256: app.isPackaged
        ? PACKAGED_PROVIDER_MANIFEST_SHA256
        : undefined,
    });
    await settingsService.initialize(process.env);
    await syncProjectProjection(settingsService);
    let startupError: unknown;
    let hostConfig;
    try {
      hostConfig = await withZenXProviderTransports(
        await settingsService.hostConfig(),
        async (url) => await session.defaultSession.resolveProxy(url),
      );
    } catch (error) {
      startupError = error;
      hostConfig = {
        cwd: zenDataDirectory,
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
      descriptorFile: connectionDescriptorFile,
      reclaimStaleConnectionDescriptor: true,
      hostConfig,
      execPath: process.execPath,
      capabilityHost: capabilityService,
    });
    await selfControlPort.attach(appServerManager);
    titleCoordinator = new ZenXThreadTitleCoordinator({
      store: new ZenXThreadTitleStore(
        join(userDataDirectory, "thread-title-projections.json"),
      ),
      inference: new ZenXConfiguredTitleInference(settingsService),
      titleModel: () => settingsService!.configuredTitleModel(),
      setNativeName: async (threadId, name) => {
        await appServerManager!.request("thread/name/set", { threadId, name });
      },
    });
    await titleCoordinator.initialize();
    installProtocolIpc(
      appServerManager,
      titleCoordinator,
      projectProjection,
      imageAttachments,
    );
    const marketplace = new MarketplaceCatalogService(
      new JsonFileMarketplaceCatalogTransport(
        join(resourcesDirectory, "marketplace", "catalog.json"),
      ),
    );
    installTitleIpc(titleCoordinator);
    automationService = await createBundledAutomationPluginService({
      userDataDirectory,
      appServer: appServerManager,
      titles: titleCoordinator,
    });
    await capabilityService.initialize();
    const installedRooms = capabilityService
      .pluginSnapshot()
      .plugins.find((plugin) => plugin.id === ZENX_ROOMS_CAPABILITY_ID);
    if (installedRooms?.profileSource === undefined) {
      await capabilityService.installBundledPluginPackage(
        join(resourcesDirectory, "plugins", ZENX_ROOMS_TARBALL),
        {
          pluginId: ZENX_ROOMS_CAPABILITY_ID,
          packageName: ZENX_ROOMS_PACKAGE_NAME,
        },
      );
    }
    capabilityService.register(
      new ZenXSelfControlCapabilityPackage({ appServer: selfControlPort }),
    );
    await capabilityService.install(
      new ZenXTriggersCapabilityPackage(automationService),
      "bundled",
    );
    installCapabilityIpc(capabilityService, appServerManager, marketplace);
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
  installSettingsIpc(
    settingsService,
    directoryBrowser,
    async () => {
      const hostConfig = await withZenXProviderTransports(
        await settingsService!.hostConfig(),
        async (url) => await session.defaultSession.resolveProxy(url),
      );
      if (appServerManager === undefined) {
        appServerManager = new AppServerManager({
          entryPath,
          tokenFile,
          descriptorFile: connectionDescriptorFile,
          reclaimStaleConnectionDescriptor: true,
          hostConfig,
          execPath: process.execPath,
          capabilityHost: capabilityService,
        });
        await selfControlPort.attach(appServerManager);
        await appServerManager.start();
      } else {
        await selfControlPort.attach(appServerManager);
        const restartErrors: Error[] = [];
        let hostStopped = false;
        try {
          await appServerManager.stop({ preserveConnectionAuthority: true });
          hostStopped = true;
        } catch (error) {
          restartErrors.push(normalizeTitleOwnershipFailure(error));
        }
        try {
          await titleCoordinator?.stop();
        } catch (error) {
          restartErrors.push(normalizeTitleOwnershipFailure(error));
        }
        let capabilitiesReset = false;
        let hostRestarted = false;
        if (hostStopped) {
          try {
            await capabilityService?.resetTransient();
            capabilitiesReset = true;
          } catch (error) {
            restartErrors.push(normalizeTitleOwnershipFailure(error));
          }
        }
        if (hostStopped && capabilitiesReset) {
          try {
            await appServerManager.restart(hostConfig);
            hostRestarted = true;
          } catch (error) {
            restartErrors.push(normalizeTitleOwnershipFailure(error));
          }
        }
        try {
          await titleCoordinator?.restart();
        } catch (error) {
          restartErrors.push(normalizeTitleOwnershipFailure(error));
        }
        if (hostStopped && !hostRestarted) {
          try {
            await appServerManager.stop();
          } catch (error) {
            restartErrors.push(normalizeTitleOwnershipFailure(error));
          }
        }
        if (restartErrors.length > 0)
          throw new AggregateError(
            restartErrors,
            "Could not fully restart ZenX",
          );
      }
    },
    async () => await syncProjectProjection(settingsService!),
  );
  const mainWindow = createWindow();
  if (
    projectWorkspaceAcceptancePath !== null &&
    externalZasAcceptancePath !== null
  ) {
    console.error("Only one packaged ZenX acceptance hook may run at a time");
    process.exitCode = 1;
    app.quit();
    return;
  }
  if (projectWorkspaceAcceptancePath !== null) {
    void runProjectWorkspaceAcceptance({
      window: mainWindow,
      configPath: projectWorkspaceAcceptancePath,
      applicationMenuAbsent: Menu.getApplicationMenu() === null,
    })
      .then(() => app.quit())
      .catch((error: unknown) => {
        console.error("Packaged Project workspace acceptance failed", error);
        process.exitCode = 1;
        app.quit();
      });
  }
  if (externalZasAcceptancePath !== null && appServerManager !== undefined) {
    void runExternalZasAcceptance({
      configPath: externalZasAcceptancePath,
      manager: appServerManager,
      window: mainWindow,
      createWindow,
    })
      .then(() => app.quit())
      .catch((error: unknown) => {
        console.error("Packaged external ZAS acceptance failed", error);
        process.exitCode = 1;
        app.quit();
      });
  }

  app.on("activate", () => {
    hostLifecycle.activate();
  });
});

app.on("before-quit", (event) => {
  if (!ownsSingleInstance) return;
  hostLifecycle.beforeQuit(() => event.preventDefault());
});

app.on("window-all-closed", () => {
  if (ownsSingleInstance) hostLifecycle.windowAllClosed();
});

app.on("second-instance", () => {
  if (!ownsSingleInstance) return;
  hostLifecycle.activate();
  const window = BrowserWindow.getAllWindows()[0];
  if (window?.isMinimized()) window.restore();
  window?.focus();
});

async function stopZenXHost(): Promise<void> {
  const errors: Error[] = [];
  try {
  } catch (error) {
    errors.push(normalizeTitleOwnershipFailure(error));
  }
  try {
    await titleCoordinator?.close();
  } catch (error) {
    errors.push(normalizeTitleOwnershipFailure(error));
  }
  try {
    await appServerManager?.stop();
  } catch (error) {
    errors.push(normalizeTitleOwnershipFailure(error));
  }
  try {
    selfControlPort.detach();
    await capabilityService?.close();
  } catch (error) {
    errors.push(normalizeTitleOwnershipFailure(error));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Could not fully stop ZenX before quit");
  }
}

function desktopPlatform(platform: NodeJS.Platform): ZenXDesktopPlatform {
  if (platform === "darwin" || platform === "win32" || platform === "linux") {
    return platform;
  }
  throw new Error(`ZenX does not support desktop platform ${platform}`);
}

function installProtocolIpc(
  manager: AppServerManager,
  titles: ZenXThreadTitleCoordinator,
  projects: ZenXProjectProjection,
  attachments: FileAttachmentStore,
): void {
  ipcMain.handle(ipcChannels.getStatus, () => manager.status);
  ipcMain.handle(
    ipcChannels.getPendingApprovals,
    () => manager.pendingApprovalRequests,
  );
  ipcMain.handle(
    ipcChannels.threadSummariesList,
    async (_event, options: unknown) =>
      await manager.listThreadSummaries(readThreadSummaryListOptions(options)),
  );
  ipcMain.handle(ipcChannels.imageAttachmentsPick, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: "Choose images",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
      ],
    } satisfies Electron.OpenDialogOptions;
    const result =
      owner === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(owner, options);
    if (result.canceled) return [];
    return await importLocalImageDrafts(attachments, result.filePaths);
  });
  ipcMain.handle(
    ipcChannels.imageAttachmentsImport,
    async (_event, value: unknown) => {
      const images = readImageImports(value);
      return await importImageDrafts(attachments, images);
    },
  );
  ipcMain.handle(ipcChannels.imageAttachmentsRead, async (_event, value) =>
    Uint8Array.from(await readAttachmentPayload(attachments, value)),
  );
  ipcMain.handle(
    ipcChannels.threadAttachmentsRead,
    async (_event, threadId: unknown) => {
      if (typeof threadId !== "string" || threadId.length === 0)
        throw new Error("Invalid Thread attachment query");
      return await manager.readThreadAttachments(threadId);
    },
  );
  ipcMain.handle(ipcChannels.projectsGet, async (_event, options: unknown) => {
    const threads = await manager.listThreadSummaries(
      readThreadSummaryListOptions(options),
    );
    return await projects.project(
      threads.map((thread) => ({
        id: thread.threadId,
        cwd:
          thread.status === "systemError" ? null : thread.currentMetadata.cwd,
      })),
    );
  });
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
    void observeCompletedUserMessageTitle(titles, method, params);
    if (method === "thread/name/updated") {
      const event = params as ServerNotificationParams["thread/name/updated"];
      void titles
        .synchronizeNativeName(event.threadId, event.threadName)
        .catch((error: unknown) => {
          console.warn(
            `Could not synchronize native Thread name: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }
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

function readImageImports(value: unknown): ZenXImageImport[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error("Choose at least one image");
  return value.map((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { name?: unknown }).name !== "string" ||
      typeof (entry as { mediaType?: unknown }).mediaType !== "string" ||
      !((entry as { bytes?: unknown }).bytes instanceof Uint8Array)
    ) {
      throw new Error("Invalid image import payload");
    }
    return entry as ZenXImageImport;
  });
}

function installTitleIpc(titles: ZenXThreadTitleCoordinator): void {
  ipcMain.handle(ipcChannels.titlesGet, () => titles.snapshot());
  ipcMain.handle(
    ipcChannels.titlesObserve,
    async (_event, threadId: unknown, input: unknown) => {
      if (typeof threadId !== "string" || typeof input !== "string")
        throw new Error("Invalid thread title input");
      return await titles.observe(threadId, input);
    },
  );
  ipcMain.handle(
    ipcChannels.titlesRename,
    async (_event, threadId: unknown, title: unknown) => {
      if (typeof threadId !== "string" || typeof title !== "string")
        throw new Error("Invalid thread rename");
      return await titles.rename(threadId, title);
    },
  );
  ipcMain.handle(ipcChannels.titlesRetry, async (_event, threadId: unknown) => {
    if (typeof threadId !== "string") throw new Error("Invalid thread ID");
    return await titles.retry(threadId);
  });
  titles.onChange((snapshot) => {
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send(ipcChannels.titlesChanged, snapshot);
  });
}

function installFailedProtocolIpc(message: string): void {
  ipcMain.handle(ipcChannels.getStatus, () => ({ type: "error", message }));
  ipcMain.handle(ipcChannels.getPendingApprovals, () => []);
  ipcMain.handle(ipcChannels.threadSummariesList, () => {
    throw new Error(`Zen App Server is not ready: ${message}`);
  });
  for (const channel of [
    ipcChannels.imageAttachmentsPick,
    ipcChannels.imageAttachmentsImport,
    ipcChannels.imageAttachmentsRead,
    ipcChannels.threadAttachmentsRead,
  ]) {
    ipcMain.handle(channel, () => {
      throw new Error(`Zen App Server is not ready: ${message}`);
    });
  }
  ipcMain.handle(ipcChannels.request, () => {
    throw new Error(`Zen App Server is not ready: ${message}`);
  });
  ipcMain.handle(ipcChannels.respondApproval, () => {
    throw new Error(`Zen App Server is not ready: ${message}`);
  });
}

function readThreadSummaryListOptions(value: unknown): { archived?: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid native Thread summary query");
  }
  const entries = Object.entries(value);
  if (
    entries.some(
      ([key, entry]) => key !== "archived" || typeof entry !== "boolean",
    )
  ) {
    throw new Error("Invalid native Thread summary query");
  }
  return "archived" in value
    ? { archived: (value as { archived: boolean }).archived }
    : {};
}

function installSettingsIpc(
  settings: ZenXSettingsService,
  directoryBrowser: ZenXDirectoryBrowser,
  restartHost: () => Promise<void>,
  refreshProjects: () => Promise<void>,
): void {
  ipcMain.handle(
    ipcChannels.settingsGet,
    async () => await settings.publicSettings(),
  );
  ipcMain.handle(
    ipcChannels.workspaceAdd,
    async (_event, workspace: unknown) => {
      if (typeof workspace !== "string") throw new Error("Invalid workspace");
      const requiresRestart = await settings.addWorkspace(workspace);
      await refreshProjects();
      if (requiresRestart) await restartHost();
      return await settings.publicSettings();
    },
  );
  ipcMain.handle(
    ipcChannels.workspaceRemove,
    async (_event, workspace: unknown) => {
      if (typeof workspace !== "string") throw new Error("Invalid workspace");
      const requiresRestart = await settings.removeWorkspace(workspace);
      await refreshProjects();
      if (requiresRestart) await restartHost();
      return await settings.publicSettings();
    },
  );
  ipcMain.handle(
    ipcChannels.workspaceDefault,
    async (_event, workspace: unknown) => {
      if (typeof workspace !== "string") throw new Error("Invalid workspace");
      const requiresRestart = await settings.setDefaultWorkspace(workspace);
      await refreshProjects();
      if (requiresRestart) await restartHost();
      return await settings.publicSettings();
    },
  );
  ipcMain.handle(
    ipcChannels.workspaceUse,
    async (_event, workspace: unknown) => {
      if (typeof workspace !== "string") throw new Error("Invalid workspace");
      await settings.markWorkspaceUsed(workspace);
      await refreshProjects();
      return await settings.publicSettings();
    },
  );
  ipcMain.handle(
    ipcChannels.pinnedThreadsSet,
    async (_event, threadIds: unknown) => {
      if (!Array.isArray(threadIds))
        throw new Error("Invalid pinned Thread list");
      await settings.setPinnedThreadIds(threadIds);
      return await settings.publicSettings();
    },
  );
  ipcMain.handle(
    ipcChannels.sidebarOrderSet,
    async (_event, order: unknown) => {
      await settings.setSidebarOrder(order as ZenXSidebarOrder);
      return await settings.publicSettings();
    },
  );
  ipcMain.handle(
    ipcChannels.directorySnapshot,
    async () => await directoryBrowser.snapshot(),
  );
  ipcMain.handle(
    ipcChannels.directoryList,
    async (_event, directory: unknown) => {
      if (typeof directory !== "string")
        throw new Error("Invalid directory path");
      return await directoryBrowser.list(directory);
    },
  );
  ipcMain.handle(
    ipcChannels.settingsSave,
    async (_event, update: ZenXSettingsUpdate, apiKey?: unknown) => {
      if (apiKey !== undefined && typeof apiKey !== "string") {
        throw new Error("Invalid API key");
      }
      await settings.save(update, apiKey);
      await refreshProjects();
      await restartHost();
      return await settings.publicSettings();
    },
  );
  ipcMain.handle(
    ipcChannels.providerAdd,
    async (_event, provider: ZenXProviderProfile, apiKey?: unknown) => {
      if (apiKey !== undefined && typeof apiKey !== "string") {
        throw new Error("Invalid API key");
      }
      await settings.addProviderProfile(provider, apiKey);
      await restartHost();
      return await settings.publicSettings();
    },
  );
  ipcMain.handle(
    ipcChannels.providerEdit,
    async (
      _event,
      providerProfileId: unknown,
      provider: ZenXProviderProfile,
      options?: ZenXProviderEditOptions,
    ) => {
      if (typeof providerProfileId !== "string") {
        throw new Error("Invalid Provider profile id");
      }
      if (options?.apiKey !== undefined && typeof options.apiKey !== "string") {
        throw new Error("Invalid API key");
      }
      await settings.editProviderProfile(providerProfileId, provider, options);
      await restartHost();
      return await settings.publicSettings();
    },
  );
  ipcMain.handle(
    ipcChannels.providerDelete,
    async (
      _event,
      providerProfileId: unknown,
      replacements?: ZenXProviderDeleteReplacements,
    ) => {
      if (typeof providerProfileId !== "string") {
        throw new Error("Invalid Provider profile id");
      }
      await settings.deleteProviderProfile(providerProfileId, replacements);
      await restartHost();
      return await settings.publicSettings();
    },
  );
  ipcMain.handle(
    ipcChannels.providerDiscover,
    async (_event, providerProfileId: unknown) => {
      if (typeof providerProfileId !== "string") {
        throw new Error("Invalid Provider profile id");
      }
      const profile = (
        await settings.publicSettings()
      ).profile.providerProfiles.find(
        (candidate) => candidate.providerProfileId === providerProfileId,
      );
      if (profile === undefined) {
        throw new Error(
          `Provider profile ${providerProfileId} is not configured`,
        );
      }
      const transport = await zenXProviderDiscoveryTransport(
        profile,
        async (url) => await session.defaultSession.resolveProxy(url),
      );
      return await settings.discoverProviderModels(providerProfileId, {
        ...(transport === undefined ? {} : { transport }),
      });
    },
  );
  ipcMain.handle(
    ipcChannels.providerImageProbe,
    async (_event, providerProfileId: unknown, modelId: unknown) => {
      if (
        typeof providerProfileId !== "string" ||
        typeof modelId !== "string"
      ) {
        throw new Error("Invalid image capability probe target");
      }
      const profile = (
        await settings.publicSettings()
      ).profile.providerProfiles.find(
        (candidate) => candidate.providerProfileId === providerProfileId,
      );
      if (profile === undefined) {
        throw new Error(
          `Provider profile ${providerProfileId} is not configured`,
        );
      }
      const transport = await zenXProviderDiscoveryTransport(
        profile,
        async (url) => await session.defaultSession.resolveProxy(url),
      );
      return await settings.probeProviderModelImage(
        providerProfileId,
        modelId,
        {
          ...(transport === undefined ? {} : { transport }),
        },
      );
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

async function syncProjectProjection(
  settings: ZenXSettingsService,
): Promise<void> {
  const profile = (await settings.publicSettings()).profile;
  await projectProjection.updateConfiguration(
    profile.workspaces,
    profile.workspace,
    profile.lastUsedWorkspace,
  );
}

function installCapabilityIpc(
  capabilities: ZenXCapabilityService,
  manager: AppServerManager,
  marketplace: MarketplaceCatalogService,
): void {
  ipcMain.handle(ipcChannels.capabilitiesGet, () => capabilities.snapshot());
  ipcMain.handle(ipcChannels.marketplaceGet, () => marketplace.load());
  ipcMain.handle(ipcChannels.pluginsGet, () => capabilities.pluginSnapshot());
  ipcMain.handle(
    ipcChannels.capabilitiesGrant,
    async (_event, capabilityId: unknown, permissionIds: unknown) => {
      const parsed = capabilityPermissionRequest(capabilityId, permissionIds);
      await capabilities.grant(parsed.capabilityId, parsed.permissionIds);
      await manager.restartCapabilities();
      return capabilities.snapshot();
    },
  );
  ipcMain.handle(
    ipcChannels.capabilitiesRevoke,
    async (_event, capabilityId: unknown, permissionIds: unknown) => {
      const parsed = capabilityPermissionRequest(capabilityId, permissionIds);
      await capabilities.revoke(parsed.capabilityId, parsed.permissionIds);
      await manager.restartCapabilities();
      return capabilities.snapshot();
    },
  );
  ipcMain.handle(
    ipcChannels.pluginsSetEnabled,
    async (_event, pluginId: unknown, enabled: unknown) => {
      if (typeof pluginId !== "string" || typeof enabled !== "boolean") {
        throw new Error("Invalid plugin enablement request");
      }
      const snapshot = await capabilities.setEnabled(pluginId, enabled);
      const capabilityRefresh = await manager.refreshCapabilitiesAfterCommit();
      return { snapshot, capabilityRefresh };
    },
  );
  ipcMain.handle(
    ipcChannels.pluginsSelectPackage,
    async (event, expectedPluginId: unknown) => {
      if (
        expectedPluginId !== undefined &&
        (typeof expectedPluginId !== "string" || expectedPluginId.length === 0)
      ) {
        throw new Error("Invalid expected plugin ID");
      }
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options = {
        title:
          expectedPluginId === undefined
            ? "Install local plugin package"
            : `Update ${expectedPluginId}`,
        properties: ["openFile"],
        filters: [{ name: "ZenX plugin manifest", extensions: ["json"] }],
      } satisfies Electron.OpenDialogOptions;
      const result =
        owner === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(owner, options);
      if (result.canceled || result.filePaths[0] === undefined)
        return { canceled: true } as const;
      const snapshot = await capabilities.installLocalPackage(
        result.filePaths[0],
        expectedPluginId as string | undefined,
      );
      await manager.restartCapabilities();
      return { canceled: false, snapshot } as const;
    },
  );
  ipcMain.handle(ipcChannels.pluginsSelectTarball, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: "Install ZenX plugin tarball",
      properties: ["openFile"],
      filters: [{ name: "npm package tarball", extensions: ["tgz"] }],
    } satisfies Electron.OpenDialogOptions;
    const result =
      owner === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(owner, options);
    if (result.canceled || result.filePaths[0] === undefined)
      return { canceled: true } as const;
    const snapshot = await capabilities.installPluginTarball(
      result.filePaths[0],
    );
    const capabilityRefresh = await manager.refreshCapabilitiesAfterCommit();
    return { canceled: false, snapshot, capabilityRefresh } as const;
  });
  ipcMain.handle(
    ipcChannels.pluginsInstallSource,
    async (_event, value: unknown) => {
      const source = pluginPackageSource(value);
      const snapshot = await capabilities.installPluginPackage(source);
      const capabilityRefresh = await manager.refreshCapabilitiesAfterCommit();
      return { snapshot, capabilityRefresh };
    },
  );
  ipcMain.handle(
    ipcChannels.pluginsUpdate,
    async (_event, pluginId: unknown, value: unknown) => {
      if (typeof pluginId !== "string" || pluginId.length === 0) {
        throw new Error("Invalid plugin update request");
      }
      const source =
        value === undefined ? undefined : pluginPackageSource(value);
      const snapshot = await capabilities.updatePluginPackage(pluginId, source);
      const capabilityRefresh = await manager.refreshCapabilitiesAfterCommit();
      return { snapshot, capabilityRefresh };
    },
  );
  ipcMain.handle(
    ipcChannels.pluginsUninstall,
    async (_event, pluginId: unknown) => {
      if (typeof pluginId !== "string" || pluginId.length === 0)
        throw new Error("Invalid plugin uninstall request");
      const snapshot = await capabilities.uninstall(pluginId);
      const capabilityRefresh = await manager.refreshCapabilitiesAfterCommit();
      return { snapshot, capabilityRefresh };
    },
  );
  ipcMain.handle(
    ipcChannels.pluginsReinstall,
    async (_event, pluginId: unknown) => {
      if (typeof pluginId !== "string" || pluginId.length === 0)
        throw new Error("Invalid plugin reinstall request");
      const snapshot = await capabilities.reinstall(pluginId);
      const capabilityRefresh = await manager.refreshCapabilitiesAfterCommit();
      return { snapshot, capabilityRefresh };
    },
  );
  ipcMain.handle(
    ipcChannels.pluginsDeleteData,
    async (_event, pluginId: unknown) => {
      if (typeof pluginId !== "string" || pluginId.length === 0)
        throw new Error("Invalid plugin delete-data request");
      await capabilities.deletePluginData(pluginId);
    },
  );
  ipcMain.handle(
    ipcChannels.pluginsExecuteCommand,
    async (_event, pluginId: unknown, commandId: unknown, input: unknown) => {
      if (typeof pluginId !== "string" || typeof commandId !== "string") {
        throw new Error("Invalid plugin command request");
      }
      const request = validatePluginHostSdkRequest({
        operation: "ui.commands.execute",
        commandId,
        input,
      });
      if (request.operation !== "ui.commands.execute")
        throw new Error("Invalid plugin command request");
      return await capabilities.executePluginCommand(
        pluginId,
        request.commandId,
        request.input,
      );
    },
  );
  ipcMain.handle(
    ipcChannels.pluginsReadHandle,
    async (_event, pluginId: unknown, handleId: unknown) => {
      if (typeof pluginId !== "string" || typeof handleId !== "string") {
        throw new Error("Invalid plugin handle request");
      }
      const request = validatePluginHostSdkRequest({
        operation: "ui.handles.read",
        handleId,
      });
      if (request.operation !== "ui.handles.read")
        throw new Error("Invalid plugin handle request");
      return await capabilities.readPluginUiHandle(pluginId, request.handleId);
    },
  );
  capabilities.onChange((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(ipcChannels.capabilitiesChanged, snapshot);
      window.webContents.send(
        ipcChannels.pluginsChanged,
        capabilities.pluginSnapshot(),
      );
    }
  });
}

function pluginPackageSource(value: unknown): ZenXPluginPackageSource {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("mode" in value) ||
    !("packageSpec" in value) ||
    !["npm", "git", "tarball", "local-copy", "dev-link"].includes(
      String(value.mode),
    ) ||
    typeof value.packageSpec !== "string" ||
    value.packageSpec.trim().length === 0
  ) {
    throw new Error("Invalid plugin package source");
  }
  return {
    mode: value.mode as ZenXPluginPackageSource["mode"],
    packageSpec: value.packageSpec,
  };
}

function capabilityPermissionRequest(
  capabilityId: unknown,
  permissionIds: unknown,
): { capabilityId: string; permissionIds?: string[] } {
  if (typeof capabilityId !== "string" || capabilityId.length === 0) {
    throw new Error("Invalid capability ID");
  }
  if (permissionIds === undefined) return { capabilityId };
  if (
    !Array.isArray(permissionIds) ||
    permissionIds.some(
      (permissionId) =>
        typeof permissionId !== "string" || permissionId.length === 0,
    )
  ) {
    throw new Error("Invalid capability permission list");
  }
  return { capabilityId, permissionIds };
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return (
    value === "accept" ||
    value === "acceptForSession" ||
    value === "decline" ||
    value === "cancel"
  );
}

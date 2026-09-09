import { contextBridge, ipcRenderer } from "electron";

import type { AppServerHostStatus } from "../main/app-server-manager.js";
import type {
  ApprovalDecision,
  ApprovalRequestEvent,
  ApprovalResolvedEvent,
} from "../main/app-server-manager.js";
import type {
  ClientRequestMethod,
  ClientRequestParams,
  ClientRequestResults,
  ServerNotificationMethod,
  ServerNotificationParams,
} from "../protocol-client/index.js";
import { ipcChannels } from "./ipc.js";
import type {
  PublicHostSettings,
  ZenXProviderDeleteReplacements,
  ZenXProviderEditOptions,
  ZenXProviderProfile,
  ZenXSidebarOrder,
  ZenXSettingsUpdate,
} from "../main/host-profile.js";
import type {
  ZenXImageCapabilityProbeResult,
  ZenXProviderCatalogSnapshot,
} from "../main/settings-service.js";
import type {
  ZenXPluginSnapshot,
  ZenXPluginTarballSelectionResult,
  ZenXPluginMutationResult,
  ZenXPluginPackageSource,
} from "../main/capabilities/types.js";
import type {
  ThreadTitleProjection,
  ThreadTitleSnapshot,
} from "../main/thread-title-types.js";
import type {
  NativeThreadSummary,
  ThreadSummaryListOptions,
} from "../../../../src/thread-summary.js";
import type {
  DirectoryBrowserSnapshot,
  DirectoryListing,
} from "../main/directory-browser.js";
import type { ZenXProjectProjectionSnapshot } from "../main/project-projection.js";
import type {
  ZenXImageDraft,
  ZenXImageImport,
  ZenXThreadAttachmentProjection,
} from "../main/image-attachments.js";
import type { ModelUsageProjection } from "../../../../src/model-usage.js";
import type { AttachmentRef } from "../../../../src/attachment.js";
import type { MarketplaceCatalogLoadSnapshot } from "../marketplace.js";
import type {
  BrowserThreadRequest,
  BrowserThreadEvent,
} from "../main/capabilities/browser-thread-observation.js";
import type { BrowserObservationEnvelope } from "../main/browser-live-observation-ipc.js";

contextBridge.exposeInMainWorld("zenx", {
  platform: process.platform,
  protocol: {
    getStatus: async (): Promise<AppServerHostStatus> =>
      await ipcRenderer.invoke(ipcChannels.getStatus),
    getPendingApprovals: async (): Promise<ApprovalRequestEvent[]> =>
      await ipcRenderer.invoke(ipcChannels.getPendingApprovals),
    request: async <M extends ClientRequestMethod>(
      method: M,
      params: ClientRequestParams[M],
    ): Promise<ClientRequestResults[M]> =>
      await ipcRenderer.invoke(ipcChannels.request, method, params),
    respondToApproval: async (
      requestId: string,
      decision: ApprovalDecision,
    ): Promise<void> =>
      await ipcRenderer.invoke(
        ipcChannels.respondApproval,
        requestId,
        decision,
      ),
    onApprovalRequest: (
      listener: (event: ApprovalRequestEvent) => void,
    ): (() => void) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        approval: ApprovalRequestEvent,
      ) => listener(approval);
      ipcRenderer.on(ipcChannels.approvalRequest, wrapped);
      return () => ipcRenderer.off(ipcChannels.approvalRequest, wrapped);
    },
    onApprovalResolved: (
      listener: (event: ApprovalResolvedEvent) => void,
    ): (() => void) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        approval: ApprovalResolvedEvent,
      ) => listener(approval);
      ipcRenderer.on(ipcChannels.approvalResolved, wrapped);
      return () => ipcRenderer.off(ipcChannels.approvalResolved, wrapped);
    },
    onStatus: (
      listener: (status: AppServerHostStatus) => void,
    ): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, status: unknown) => {
        listener(status as AppServerHostStatus);
      };
      ipcRenderer.on(ipcChannels.status, wrapped);
      return () => ipcRenderer.off(ipcChannels.status, wrapped);
    },
    onNotification: (
      listener: <M extends ServerNotificationMethod>(
        method: M,
        params: ServerNotificationParams[M],
      ) => void,
    ): (() => void) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        method: ServerNotificationMethod,
        params: ServerNotificationParams[ServerNotificationMethod],
      ) => listener(method, params);
      ipcRenderer.on(ipcChannels.notification, wrapped);
      return () => ipcRenderer.off(ipcChannels.notification, wrapped);
    },
  },
  threads: {
    list: async (
      options: ThreadSummaryListOptions = {},
    ): Promise<NativeThreadSummary[]> =>
      await ipcRenderer.invoke(ipcChannels.threadSummariesList, options),
  },
  imageAttachments: {
    readLocal: async (
      source: string,
      cwd?: string,
    ): Promise<{ bytes: Uint8Array; mediaType: string }> =>
      await ipcRenderer.invoke(ipcChannels.imageLocalRead, source, cwd),
    pick: async (): Promise<ZenXImageDraft[]> =>
      await ipcRenderer.invoke(ipcChannels.imageAttachmentsPick),
    import: async (
      images: readonly ZenXImageImport[],
    ): Promise<ZenXImageDraft[]> =>
      await ipcRenderer.invoke(ipcChannels.imageAttachmentsImport, images),
    read: async (attachment: AttachmentRef): Promise<Uint8Array> =>
      await ipcRenderer.invoke(ipcChannels.imageAttachmentsRead, attachment),
    forThread: async (
      threadId: string,
    ): Promise<ZenXThreadAttachmentProjection> =>
      await ipcRenderer.invoke(ipcChannels.threadAttachmentsRead, threadId),
  },
  modelUsage: {
    forThread: async (threadId: string): Promise<ModelUsageProjection> =>
      await ipcRenderer.invoke(ipcChannels.threadUsageRead, threadId),
  },
  projects: {
    get: async (
      options: ThreadSummaryListOptions = {},
    ): Promise<ZenXProjectProjectionSnapshot> =>
      await ipcRenderer.invoke(ipcChannels.projectsGet, options),
    startThread: async (
      workspace: string,
      selection?: import("../main/project-projection.js").ProjectThreadStartOptions,
    ): Promise<ClientRequestResults["thread/start"]> =>
      await ipcRenderer.invoke(
        ipcChannels.projectThreadStart,
        workspace,
        selection,
      ),
  },
  settings: {
    safeRestart: async (): Promise<PublicHostSettings> =>
      ipcRenderer.invoke(ipcChannels.settingsSafeRestart),
    reconcile: async (retry: boolean): Promise<PublicHostSettings> =>
      ipcRenderer.invoke(ipcChannels.settingsReconcile, retry),
    get: async (): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(ipcChannels.settingsGet),
    save: async (
      settings: ZenXSettingsUpdate,
      apiKey?: string,
    ): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(ipcChannels.settingsSave, settings, apiKey),
    addProvider: async (
      provider: ZenXProviderProfile,
      apiKey?: string,
      baseRevision?: number,
    ): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(
        ipcChannels.providerAdd,
        provider,
        apiKey,
        baseRevision,
      ),
    editProvider: async (
      providerProfileId: string,
      provider: ZenXProviderProfile,
      options?: ZenXProviderEditOptions,
    ): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(
        ipcChannels.providerEdit,
        providerProfileId,
        provider,
        options,
      ),
    deleteProvider: async (
      providerProfileId: string,
      replacements?: ZenXProviderDeleteReplacements,
    ): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(
        ipcChannels.providerDelete,
        providerProfileId,
        replacements,
      ),
    discoverProvider: async (
      providerProfileId: string,
    ): Promise<ZenXProviderCatalogSnapshot> =>
      await ipcRenderer.invoke(ipcChannels.providerDiscover, providerProfileId),
    probeProviderImage: async (
      providerProfileId: string,
      modelId: string,
    ): Promise<ZenXImageCapabilityProbeResult> =>
      await ipcRenderer.invoke(
        ipcChannels.providerImageProbe,
        providerProfileId,
        modelId,
      ),
    editWorkspace: async (
      workspace: string,
      name: string,
      nextWorkspace: string,
    ): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(
        ipcChannels.workspaceEdit,
        workspace,
        name,
        nextWorkspace,
      ),
    addWorkspace: async (workspace: string): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(ipcChannels.workspaceAdd, workspace),
    removeWorkspace: async (workspace: string): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(ipcChannels.workspaceRemove, workspace),
    setDefaultWorkspace: async (
      workspace: string,
    ): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(ipcChannels.workspaceDefault, workspace),
    markWorkspaceUsed: async (workspace: string): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(ipcChannels.workspaceUse, workspace),
    setPinnedThreadIds: async (
      threadIds: readonly string[],
    ): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(ipcChannels.pinnedThreadsSet, threadIds),
    setSidebarOrder: async (
      order: ZenXSidebarOrder,
    ): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(ipcChannels.sidebarOrderSet, order),
    getDirectoryBrowser: async (): Promise<DirectoryBrowserSnapshot> =>
      await ipcRenderer.invoke(ipcChannels.directorySnapshot),
    listDirectory: async (directory: string): Promise<DirectoryListing> =>
      await ipcRenderer.invoke(ipcChannels.directoryList, directory),
    loginSubscription: async (): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(ipcChannels.subscriptionLogin),
    submitManualCode: async (code: string): Promise<void> =>
      await ipcRenderer.invoke(ipcChannels.subscriptionManualCode, code),
    logoutSubscription: async (): Promise<PublicHostSettings> =>
      await ipcRenderer.invoke(ipcChannels.subscriptionLogout),
    onManualCodeRequested: (listener: () => void): (() => void) => {
      const wrapped = () => listener();
      ipcRenderer.on(ipcChannels.subscriptionManualRequested, wrapped);
      return () =>
        ipcRenderer.off(ipcChannels.subscriptionManualRequested, wrapped);
    },
  },
  titles: {
    get: async (): Promise<ThreadTitleSnapshot> =>
      await ipcRenderer.invoke(ipcChannels.titlesGet),
    observe: async (
      threadId: string,
      input: string,
    ): Promise<ThreadTitleProjection | undefined> =>
      await ipcRenderer.invoke(ipcChannels.titlesObserve, threadId, input),
    rename: async (
      threadId: string,
      title: string,
    ): Promise<ThreadTitleProjection> =>
      await ipcRenderer.invoke(ipcChannels.titlesRename, threadId, title),
    retry: async (threadId: string): Promise<ThreadTitleProjection> =>
      await ipcRenderer.invoke(ipcChannels.titlesRetry, threadId),
    onChange: (
      listener: (snapshot: ThreadTitleSnapshot) => void,
    ): (() => void) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        snapshot: ThreadTitleSnapshot,
      ) => listener(snapshot);
      ipcRenderer.on(ipcChannels.titlesChanged, wrapped);
      return () => ipcRenderer.off(ipcChannels.titlesChanged, wrapped);
    },
  },
  marketplace: {
    get: async (): Promise<MarketplaceCatalogLoadSnapshot> =>
      await ipcRenderer.invoke(ipcChannels.marketplaceGet),
  },
  browserObservation: {
    subscribe: (
      request: BrowserThreadRequest,
      listener: (event: BrowserThreadEvent) => void,
    ): (() => void) => {
      let active = true;
      const subscriptionId = crypto.randomUUID();
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        value: BrowserObservationEnvelope,
      ) => {
        if (active && value.subscriptionId === subscriptionId)
          listener(value.event);
      };
      ipcRenderer.on(ipcChannels.browserLiveEvent, wrapped);
      void ipcRenderer
        .invoke(ipcChannels.browserLiveSubscribe, subscriptionId, request)
        .catch(() => {
          if (active) {
            listener({
              type: "status",
              status: "failed",
              message: "The live browser view could not be connected.",
            });
          }
        });
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.off(ipcChannels.browserLiveEvent, wrapped);
        void ipcRenderer.invoke(
          ipcChannels.browserLiveUnsubscribe,
          subscriptionId,
        );
      };
    },
  },
  plugins: {
    get: async (): Promise<ZenXPluginSnapshot> =>
      await ipcRenderer.invoke(ipcChannels.pluginsGet),
    setEnabled: async (
      pluginId: string,
      enabled: boolean,
    ): Promise<ZenXPluginMutationResult> =>
      await ipcRenderer.invoke(
        ipcChannels.pluginsSetEnabled,
        pluginId,
        enabled,
      ),
    selectTarball: async (): Promise<ZenXPluginTarballSelectionResult> =>
      await ipcRenderer.invoke(ipcChannels.pluginsSelectTarball),
    installBuiltIn: async (
      pluginId: string,
    ): Promise<ZenXPluginMutationResult> =>
      await ipcRenderer.invoke(ipcChannels.pluginsInstallBuiltIn, pluginId),
    installSource: async (
      source: ZenXPluginPackageSource,
    ): Promise<ZenXPluginMutationResult> =>
      await ipcRenderer.invoke(ipcChannels.pluginsInstallSource, source),
    update: async (
      pluginId: string,
      source?: ZenXPluginPackageSource,
    ): Promise<ZenXPluginMutationResult> =>
      await ipcRenderer.invoke(ipcChannels.pluginsUpdate, pluginId, source),
    uninstall: async (pluginId: string): Promise<ZenXPluginMutationResult> =>
      await ipcRenderer.invoke(ipcChannels.pluginsUninstall, pluginId),
    reinstall: async (pluginId: string): Promise<ZenXPluginMutationResult> =>
      await ipcRenderer.invoke(ipcChannels.pluginsReinstall, pluginId),
    deleteData: async (pluginId: string): Promise<void> =>
      await ipcRenderer.invoke(ipcChannels.pluginsDeleteData, pluginId),
    executeCommand: async (
      pluginId: string,
      commandId: string,
      input?: unknown,
    ): Promise<unknown> =>
      await ipcRenderer.invoke(
        ipcChannels.pluginsExecuteCommand,
        pluginId,
        commandId,
        input,
      ),
    readHandle: async (pluginId: string, handleId: string): Promise<unknown> =>
      await ipcRenderer.invoke(
        ipcChannels.pluginsReadHandle,
        pluginId,
        handleId,
      ),
    onChange: (
      listener: (snapshot: ZenXPluginSnapshot) => void,
    ): (() => void) => {
      const wrapped = (
        _event: Electron.IpcRendererEvent,
        snapshot: ZenXPluginSnapshot,
      ) => listener(snapshot);
      ipcRenderer.on(ipcChannels.pluginsChanged, wrapped);
      return () => ipcRenderer.off(ipcChannels.pluginsChanged, wrapped);
    },
  },
});

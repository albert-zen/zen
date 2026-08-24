import type { AppServerHostStatus } from "../../main/app-server-manager.js";
import type {
  ApprovalDecision,
  ApprovalRequestEvent,
  ApprovalResolvedEvent,
} from "../../main/app-server-manager.js";
import type {
  ClientRequestMethod,
  ClientRequestParams,
  ClientRequestResults,
  ServerNotificationMethod,
  ServerNotificationParams,
} from "../../protocol-client/index.js";
import type {
  PublicHostSettings,
  ZenXHostProfile,
  ZenXProviderDeleteReplacements,
  ZenXProviderEditOptions,
  ZenXProviderProfile,
  ZenXSidebarOrder,
  ZenXSettingsUpdate,
} from "../../main/host-profile.js";
import type {
  ZenXCapabilitySnapshot,
  ZenXPluginSnapshot,
  ZenXPluginPackageSelectionResult,
  ZenXPluginTarballSelectionResult,
  ZenXPluginMutationResult,
  ZenXPluginPackageSource,
} from "../../main/capabilities/types.js";
import type {
  ThreadTitleProjection,
  ThreadTitleSnapshot,
} from "../../main/thread-title-types.js";
import type {
  NativeThreadSummary,
  ThreadSummaryListOptions,
} from "../../../../../src/thread-summary.js";
import type {
  DirectoryBrowserSnapshot,
  DirectoryListing,
} from "../../main/directory-browser.js";
import type { ZenXProjectProjectionSnapshot } from "../../main/project-projection.js";
import type {
  ZenXImageCapabilityProbeResult,
  ZenXProviderCatalogSnapshot,
} from "../../main/settings-service.js";
import type {
  ZenXImageDraft,
  ZenXImageImport,
  ZenXThreadAttachmentProjection,
} from "../../main/image-attachments.js";
import type { AttachmentRef } from "../../../../../src/attachment.js";
import type { MarketplaceCatalogSnapshot } from "../../marketplace.js";

declare global {
  interface Window {
    zenx: {
      platform: NodeJS.Platform;
      protocol: {
        getStatus(): Promise<AppServerHostStatus>;
        getPendingApprovals(): Promise<ApprovalRequestEvent[]>;
        request<M extends ClientRequestMethod>(
          method: M,
          params: ClientRequestParams[M],
        ): Promise<ClientRequestResults[M]>;
        respondToApproval(
          requestId: string,
          decision: ApprovalDecision,
        ): Promise<void>;
        onApprovalRequest(
          listener: (event: ApprovalRequestEvent) => void,
        ): () => void;
        onApprovalResolved(
          listener: (event: ApprovalResolvedEvent) => void,
        ): () => void;
        onStatus(listener: (status: AppServerHostStatus) => void): () => void;
        onNotification(
          listener: <M extends ServerNotificationMethod>(
            method: M,
            params: ServerNotificationParams[M],
          ) => void,
        ): () => void;
      };
      threads: {
        list(
          options?: ThreadSummaryListOptions,
        ): Promise<NativeThreadSummary[]>;
      };
      imageAttachments: {
        pick(): Promise<ZenXImageDraft[]>;
        import(images: readonly ZenXImageImport[]): Promise<ZenXImageDraft[]>;
        read(attachment: AttachmentRef): Promise<Uint8Array>;
        forThread(threadId: string): Promise<ZenXThreadAttachmentProjection>;
      };
      projects: {
        get(
          options?: ThreadSummaryListOptions,
        ): Promise<ZenXProjectProjectionSnapshot>;
      };
      settings: {
        get(): Promise<PublicHostSettings>;
        save(
          settings: ZenXSettingsUpdate,
          apiKey?: string,
        ): Promise<PublicHostSettings>;
        addProvider(
          provider: ZenXProviderProfile,
          apiKey?: string,
        ): Promise<PublicHostSettings>;
        editProvider(
          providerProfileId: string,
          provider: ZenXProviderProfile,
          options?: ZenXProviderEditOptions,
        ): Promise<PublicHostSettings>;
        deleteProvider(
          providerProfileId: string,
          replacements?: ZenXProviderDeleteReplacements,
        ): Promise<PublicHostSettings>;
        discoverProvider(
          providerProfileId: string,
        ): Promise<ZenXProviderCatalogSnapshot>;
        probeProviderImage(
          providerProfileId: string,
          modelId: string,
        ): Promise<ZenXImageCapabilityProbeResult>;
        addWorkspace(workspace: string): Promise<PublicHostSettings>;
        removeWorkspace(workspace: string): Promise<PublicHostSettings>;
        setDefaultWorkspace(workspace: string): Promise<PublicHostSettings>;
        markWorkspaceUsed(workspace: string): Promise<PublicHostSettings>;
        setPinnedThreadIds(
          threadIds: readonly string[],
        ): Promise<PublicHostSettings>;
        setSidebarOrder(order: ZenXSidebarOrder): Promise<PublicHostSettings>;
        getDirectoryBrowser(): Promise<DirectoryBrowserSnapshot>;
        listDirectory(directory: string): Promise<DirectoryListing>;
        loginSubscription(): Promise<PublicHostSettings>;
        submitManualCode(code: string): Promise<void>;
        logoutSubscription(): Promise<PublicHostSettings>;
        onManualCodeRequested(listener: () => void): () => void;
      };
      titles: {
        get(): Promise<ThreadTitleSnapshot>;
        observe(
          threadId: string,
          input: string,
        ): Promise<ThreadTitleProjection | undefined>;
        rename(threadId: string, title: string): Promise<ThreadTitleProjection>;
        retry(threadId: string): Promise<ThreadTitleProjection>;
        onChange(listener: (snapshot: ThreadTitleSnapshot) => void): () => void;
      };
      capabilities: {
        get(): Promise<ZenXCapabilitySnapshot>;
        grant(
          capabilityId: string,
          permissionIds?: string[],
        ): Promise<ZenXCapabilitySnapshot>;
        revoke(
          capabilityId: string,
          permissionIds?: string[],
        ): Promise<ZenXCapabilitySnapshot>;
        onChange(
          listener: (snapshot: ZenXCapabilitySnapshot) => void,
        ): () => void;
      };
      marketplace: {
        get(): Promise<MarketplaceCatalogSnapshot>;
      };
      plugins: {
        get(): Promise<ZenXPluginSnapshot>;
        setEnabled(
          pluginId: string,
          enabled: boolean,
        ): Promise<ZenXPluginMutationResult>;
        selectPackage(
          expectedPluginId?: string,
        ): Promise<ZenXPluginPackageSelectionResult>;
        selectTarball(): Promise<ZenXPluginTarballSelectionResult>;
        installSource(
          source: ZenXPluginPackageSource,
        ): Promise<ZenXPluginMutationResult>;
        update(
          pluginId: string,
          source?: ZenXPluginPackageSource,
        ): Promise<ZenXPluginMutationResult>;
        uninstall(pluginId: string): Promise<ZenXPluginMutationResult>;
        reinstall(pluginId: string): Promise<ZenXPluginMutationResult>;
        deleteData(pluginId: string): Promise<void>;
        executeCommand(
          pluginId: string,
          commandId: string,
          input?: unknown,
        ): Promise<unknown>;
        readHandle(pluginId: string, handleId: string): Promise<unknown>;
        onChange(listener: (snapshot: ZenXPluginSnapshot) => void): () => void;
      };
    };
  }
}

export {};

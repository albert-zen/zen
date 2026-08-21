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
  CreateRoomInput,
  CreateTriggerInput,
  RoomMember,
  TriggerSnapshot,
} from "../../main/trigger-types.js";
import type {
  ZenXCapabilitySnapshot,
  ZenXPluginSnapshot,
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
import type { ZenXProviderCatalogSnapshot } from "../../main/settings-service.js";

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
      triggers: {
        get(): Promise<TriggerSnapshot>;
        create(input: CreateTriggerInput): Promise<TriggerSnapshot>;
        cancel(triggerId: string): Promise<TriggerSnapshot>;
        signal(name: string, detail: string): Promise<TriggerSnapshot>;
        createRoom(input: CreateRoomInput): Promise<TriggerSnapshot>;
        addRoomMember(
          roomId: string,
          member: RoomMember,
        ): Promise<TriggerSnapshot>;
        removeRoomMember(
          roomId: string,
          threadId: string,
        ): Promise<TriggerSnapshot>;
        postRoomMessage(
          roomId: string,
          author: string,
          text: string,
        ): Promise<TriggerSnapshot>;
        onChange(listener: (snapshot: TriggerSnapshot) => void): () => void;
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
      plugins: {
        get(): Promise<ZenXPluginSnapshot>;
        setEnabled(
          pluginId: string,
          enabled: boolean,
        ): Promise<ZenXPluginSnapshot>;
        onChange(listener: (snapshot: ZenXPluginSnapshot) => void): () => void;
      };
    };
  }
}

export {};

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
} from "../../main/host-profile.js";
import type {
  CreateRoomInput,
  CreateTriggerInput,
  RoomMember,
  TriggerSnapshot,
} from "../../main/trigger-types.js";
import type { ZenXCapabilitySnapshot } from "../../main/capabilities/types.js";
import type {
  ThreadTitleProjection,
  ThreadTitleSnapshot,
} from "../../main/thread-title-types.js";
import type {
  NativeThreadSummary,
  ThreadSummaryListOptions,
} from "../../../../../src/thread-summary.js";

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
      settings: {
        get(): Promise<PublicHostSettings>;
        save(
          profile: ZenXHostProfile,
          apiKey?: string,
        ): Promise<PublicHostSettings>;
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
        setContributionEnabled(
          capabilityId: string,
          contributionId: string,
          enabled: boolean,
        ): Promise<ZenXCapabilitySnapshot>;
        onChange(
          listener: (snapshot: ZenXCapabilitySnapshot) => void,
        ): () => void;
      };
    };
  }
}

export {};

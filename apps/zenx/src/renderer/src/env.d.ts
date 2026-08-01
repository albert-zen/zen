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
    };
  }
}

export {};
